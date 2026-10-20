#!/usr/bin/env bash
# =============================================================================
# Per-crate coverage floor enforcement for the extended workspace contracts
# (issue #997).
#
# The workspace-wide `make coverage` gate measures the whole workspace as one
# number, so a single well-tested contract can mask a poorly-tested one. This
# script enforces an explicit floor per extended contract, read from
# `config/coverage-floor.toml`.
#
# Behaviour:
#   * every crate under `[crates]` is measured on its own;
#   * a crate below its floor fails the run;
#   * a crate under `[waived]` is skipped (the reason is reviewed as part of
#     the config change);
#   * the bins under `[excluded_bins]` (fuzz and xtask) never enter the
#     denominators - they are host-side tooling, not shipped contract code;
#   * the PR delta gate fails when a crate drops more than
#     `[defaults].max_drop_percent` below the recorded baseline.
#
# Usage:
#   scripts/check_coverage_floors.sh [--config <file>] [--baseline <file>]
#
# Baseline format (JSON, one entry per crate):
#   { "vesting": 61.4, "secondary_market": 70.1 }
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

CONFIG_FILE="$ROOT_DIR/config/coverage-floor.toml"
BASELINE_FILE=""
TIMEOUT=300

while [ $# -gt 0 ]; do
  case "$1" in
    --config) CONFIG_FILE="$2"; shift 2 ;;
    --baseline) BASELINE_FILE="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    *) echo "ERROR: unknown argument '$1'" >&2; exit 1 ;;
  esac
done

if [ ! -f "$CONFIG_FILE" ]; then
  echo "ERROR: coverage floor config not found: $CONFIG_FILE" >&2
  exit 1
fi

# ── Config parsing ────────────────────────────────────────────────────────────
#
# The config is TOML, but the subset used here (flat `key = value` tables)
# is simple enough to read with awk, which keeps the script dependency-free.

# Values under the [crates] table: crate = floor
read_floor() {
  awk -v want="$1" '
    /^\[/ { section = $0; gsub(/[][]/, "", section); next }
    section == "crates" {
      split($0, kv, "=")
      key = kv[1]; val = kv[2]
      gsub(/^[ \t]+|[ \t]+$/, "", key)
      gsub(/^[ \t]+|[ \t]+$/, "", val)
      gsub(/#.*$/, "", val)
      gsub(/^[ \t]+|[ \t]+$/, "", val)
      if (key == want) { print val; exit }
    }
  ' "$CONFIG_FILE"
}

# Crates listed under [waived].
is_waived() {
  awk -v want="$1" '
    /^\[/ { section = $0; gsub(/[][]/, "", section); next }
    section == "waived" {
      split($0, kv, "=")
      key = kv[1]
      gsub(/^[ \t]+|[ \t]+$/, "", key)
      gsub(/#.*$/, "", key)
      gsub(/^[ \t]+|[ \t]+$/, "", key)
      if (key == want) { found = 1; exit }
    }
    END { exit found ? 0 : 1 }
  ' "$CONFIG_FILE"
}

default_floor() {
  awk '
    /^\[/ { section = $0; gsub(/[][]/, "", section); next }
    section == "defaults" {
      split($0, kv, "=")
      key = kv[1]; val = kv[2]
      gsub(/^[ \t]+|[ \t]+$/, "", key)
      gsub(/^[ \t]+|[ \t]+$/, "", val)
      gsub(/#.*$/, "", val)
      gsub(/^[ \t]+|[ \t]+$/, "", val)
      if (key == "min_line_coverage") { print val; exit }
    }
  ' "$CONFIG_FILE"
}

max_drop_percent() {
  awk '
    /^\[/ { section = $0; gsub(/[][]/, "", section); next }
    section == "defaults" {
      split($0, kv, "=")
      key = kv[1]; val = kv[2]
      gsub(/^[ \t]+|[ \t]+$/, "", key)
      gsub(/^[ \t]+|[ \t]+$/, "", val)
      gsub(/#.*$/, "", val)
      gsub(/^[ \t]+|[ \t]+$/, "", val)
      if (key == "max_drop_percent") { print val; exit }
    }
  ' "$CONFIG_FILE"
}

# Every crate under [crates].
floor_crates() {
  awk '
    /^\[/ { section = $0; gsub(/[][]/, "", section); next }
    section == "crates" {
      split($0, kv, "=")
      key = kv[1]
      gsub(/^[ \t]+|[ \t]+$/, "", key)
      gsub(/#.*$/, "", key)
      gsub(/^[ \t]+|[ \t]+$/, "", key)
      if (key != "") print key
    }
  ' "$CONFIG_FILE"
}

# Baseline coverage for a crate, if a baseline file was supplied.
baseline_for() {
  if [ -z "$BASELINE_FILE" ]; then
    return 0
  fi
  if [ ! -f "$BASELINE_FILE" ]; then
    echo "ERROR: baseline file not found: $BASELINE_FILE" >&2
    exit 1
  fi
  grep -o "\"$1\"[[:space:]]*:[[:space:]]*[0-9.]*" "$BASELINE_FILE" \
    | head -1 \
    | grep -o '[0-9.]*$' \
    | head -1
}

# ── Gate ──────────────────────────────────────────────────────────────────────

DEF_FLOOR="$(default_floor)"
[ -n "$DEF_FLOOR" ] || DEF_FLOOR=50
MAX_DROP="$(max_drop_percent)"
[ -n "$MAX_DROP" ] || MAX_DROP=1.0

echo "=== Per-crate coverage floors (issue #997) ==="
echo "  config    : $CONFIG_FILE"
[ -n "$BASELINE_FILE" ] && echo "  baseline  : $BASELINE_FILE"
echo "  max drop  : $MAX_DROP percentage points"
echo ""

failed=0
measured=0

for crate in $(floor_crates); do
  if is_waived "$crate"; then
    echo "  $crate: WAIVED (see [waived] in $CONFIG_FILE)"
    continue
  fi

  floor="$(read_floor "$crate")"
  [ -n "$floor" ] || floor="$DEF_FLOOR"

  # The crate directory name maps onto its Cargo package name. `debtor_attestation`
  # is the exception: its package is named `debtor_attestation`, not
  # `kora-debtor-attestation`.
  pkg="kora-$(echo "$crate" | tr '_' '-')"
  if [ "$crate" = "debtor_attestation" ]; then
    pkg="debtor_attestation"
  fi

  out="/tmp/coverage_floor_$crate.txt"
  cargo tarpaulin -p "$pkg" --timeout "$TIMEOUT" --out Stdout > "$out" 2>&1 || true

  cov="$(grep -oP 'Coverage: \K[0-9.]+' "$out" | head -1)"
  if [ -z "$cov" ]; then
    echo "  $crate: ERROR - could not parse coverage"
    failed=1
    continue
  fi

  measured=$((measured + 1))
  status="OK"

  if (( $(echo "$cov < $floor" | bc -l) )); then
    status="FAIL"
    failed=1
  fi

  # PR delta gate: a crate must not drop more than the allowed amount below
  # its recorded baseline.
  if [ -n "$BASELINE_FILE" ]; then
    base="$(baseline_for "$crate")"
    if [ -n "$base" ]; then
      drop="$(echo "$base - $cov" | bc -l)"
      if (( $(echo "$drop > $MAX_DROP" | bc -l) )); then
        status="$status (DROP $drop% > $MAX_DROP%)"
        failed=1
      fi
    fi
  fi

  echo "  $crate: $cov% vs floor $floor%  $status"
done

echo ""
if [ "$measured" -eq 0 ]; then
  echo "ERROR: no crate was measured; the floor config may be malformed"
  exit 1
fi

if [ "$failed" -ne 0 ]; then
  echo "Per-crate coverage floor gate failed (issue #997)"
  exit 1
fi

echo "All extended contracts meet their coverage floors ($measured crates measured)"
