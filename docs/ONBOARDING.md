# Contributor Onboarding Guide

This guide walks a new contributor from zero to a merged first pull request. It
was validated by actually following it end-to-end on a clean checkout (see
[Known Current Blockers](#known-current-blockers) for what that run found and
fixed, and what's still open).

If you're looking for something to work on rather than how to set up, skip to
[`GOOD_FIRST_ISSUES.md`](GOOD_FIRST_ISSUES.md).

---

## 1. Local Setup

### Prerequisites

- [Rust](https://www.rust-lang.org/tools/install) — installed via `rustup`,
  **not** your OS package manager. The repo pins an exact toolchain in
  [`rust-toolchain.toml`](../rust-toolchain.toml); `rustup` will install and
  switch to it automatically the first time you run `cargo` in this directory.
- [stellar CLI](https://developers.stellar.org/docs/tools/stellar-cli) — only
  needed for `make build-optimized` / `make deploy-testnet`. Skip it if you're
  just building and testing.
- Docker + VS Code with the Dev Containers extension — optional, but the
  fastest path if you don't want to manage Rust versions yourself. See
  [`CONTRIBUTING.md` § Development Setup](../CONTRIBUTING.md#development-setup).

### Get the code building

```bash
git clone https://github.com/<your-fork>/Kora-Contract.git
cd Kora-Contract

# rustup reads rust-toolchain.toml and installs the pinned version automatically
rustup target add wasm32-unknown-unknown

make check      # cargo check --all — fastest way to confirm your toolchain works
make build      # cargo build --target wasm32-unknown-unknown --release
make test       # cargo test --all
make lint       # cargo clippy --all --all-targets -- -D warnings
make fmt        # cargo fmt --all
```

Run these **in this order** the first time: `check` fails fast if your
toolchain is wrong, before you pay for a full `build`.

### Orient yourself in the codebase

Read, in order:

1. [`README.md`](../README.md) § Project Structure — one paragraph per
   contract, what it owns.
2. [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) — how the contracts call each
   other (invoice_nft → marketplace → financing_pool → treasury).
3. Pick **one** contract under `contracts/<name>/src/lib.rs` relevant to the
   issue you're picking up and read it top to bottom before editing. Each
   contract crate is self-contained: storage keys (`DataKey` enum), errors
   (`<Contract>Error` enum), and entrypoints (`impl <Contract>Contract`) all
   live in that one file.
4. [`contracts/shared/src`](../contracts/shared/src) — types, errors, events,
   and validation helpers every contract crate depends on. `errors.rs`'s
   `KoraError` enum is the master error registry; `kora-xtask
   check-error-variants` (see below) keeps it honest.

### Governance and escrow contract inventory

These contracts are workspace members and participate in workspace formatting,
linting, and tests. CI also runs their unit tests separately with at most two
matrix jobs in parallel (issues #912 and #911).

| Directory | Cargo package | Typed Rust client |
| --- | --- | --- |
| `contracts/governance` | `kora-governance` | `GovernanceContractClient` |
| `contracts/governance_voting` | `kora-governance-voting` | `GovernanceVotingContractClient` |
| `contracts/parameter_registry` | `kora-parameter-registry` | `ParameterRegistryContractClient` |
| `contracts/dispute_escrow` | `kora-dispute-escrow` | `DisputeEscrowContractClient` |

The governance crates depend on shared types and (for voting and registry)
access control; they do not depend on each other. Parameter registry is an
on-chain contract even when its values are queried by off-chain services.
All four release WASM artifacts are covered by the size-budget gate. See each
contract README for address configuration and use `cargo +stable test -p
<package>` to isolate its unit tests. No compile or test results are claimed
by the #912/#911 onboarding change; verification was restricted to static review.

### Before you touch code

- [`CONTRIBUTING.md`](../CONTRIBUTING.md) covers commit conventions, branching
  (`feat/<name>` off `develop`), the PR template, and the changelog process —
  read it once, it's not optional.
- If you're adding a `KoraError` variant reference from a contract crate, add
  the matching variant to `contracts/shared/src/errors.rs` in the same
  change, then run:

  ```bash
  cargo run -p kora-xtask --bin check-error-variants
  ```

  CI fails the build otherwise (see [`CONTRIBUTING.md` § Style
  Guide](../CONTRIBUTING.md#style-guide)).

- If you're adding or changing a public contract entrypoint (`pub fn` in a
  `#[contractimpl]` block), add the matching row to
  [`docs/ACCESS_MATRIX.md`](ACCESS_MATRIX.md) in the same change, then run:

  ```bash
  cargo run -p kora-xtask --bin check_access_matrix
  ```

  The checker parses the matrix tables from that file (no hardcoded copy —
  the markdown is the single source of truth), supports
  `--contract <name>` and `--verbose`, and CI fails the build on any drift
  or undocumented entrypoint. See the "New Entrypoint Checklist" in
  [`docs/ACCESS_MATRIX.md`](ACCESS_MATRIX.md).

---

## 2. Making Your First Contribution

1. Find an issue via [`GOOD_FIRST_ISSUES.md`](GOOD_FIRST_ISSUES.md) or the
   [`good first issue`](https://github.com/OpenLedger-Foundation/Kora-Contract/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
   label. Comment on it before starting so it doesn't get picked up twice.
2. Branch off `develop`: `git checkout -b fix/<short-description> develop`.
3. Make the change. Keep it scoped to the issue — a bug fix doesn't need
   surrounding refactors.
4. Add or update tests. Every public contract function needs at least one
   happy-path and one failure-path test (see [`CONTRIBUTING.md` § Testing
   Requirements](../CONTRIBUTING.md#testing-requirements)).
5. Run the full verification suite locally before opening the PR:
   ```bash
   make fmt && make lint && cargo test --all
   ```
6. Open the PR against `develop`, fill in the template completely, and link
   the issue it closes.
7. Add yourself to [`CONTRIBUTORS.md`](../CONTRIBUTORS.md) in the same PR.

---

## 3. Mutation Testing (cargo-mutants)

Line coverage tells you whether code *ran* during tests. Mutation testing
tells you whether the tests would actually *catch a bug*: `cargo-mutants`
rewrites one expression at a time and checks that the test suite fails.

### Setup

```bash
cargo install cargo-mutants --locked
```

### Running it

The repo ships two Makefile targets:

```bash
# Whole workspace (slow, broad). Use it to spot regressions.
make mutants

# Focused on the marketplace listing-fee paths (issue #998). This is the one
# you want when you touch fee maths.
make mutants-focus-marketplace-fees
```

The focused run is the important one. Fee arithmetic in `marketplace` decides
how much of an investor's contribution is protocol revenue and how much is
proceeds, so a surviving mutant there means lost revenue or an overcharged
investor. The focus set lives in [`mutants.toml`](../mutants.toml) at the
repository root and lists:

- the package the run may mutate (`kora-marketplace` - never the whole
  workspace),
- the source files under mutation,
- the fee-calculation symbols (`base_fee_bps`, `referrer_split_bps`, the
  `apply_set_*` setters, ...),
- the fee state paths (`FeeContribution`, `FeeBps`, `ReferrerSplitBps`,
  `TierFeeBps`),
- the treasury routing branches (`fund_invoice`, `claim_refund`,
  `collect_fee`, `refund_fee`),
- the allow-list of *documented equivalent* mutants, and
- the `must_be_killed` list - a survivor in that set is a release blocker.

The configuration is asserted by
[`contracts/tests/issue_681_mutation_testing_harness.rs`](../contracts/tests/issue_681_mutation_testing_harness.rs),
so a change that silently drops a fee path from the focus set fails the
test suite.

### CI

The `mutants-marketplace-fees` job in
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs the same
Makefile target. It is deliberately optional:

- it runs on a weekly schedule and on manual dispatch,
- on pull requests it only runs when a maintainer applies the
  `mutation-testing` label, and it is allowed to fail there,
- the job has a 60-minute timeout, and a failing run still uploads the
  partial `mutants.out/` report so surviving mutants can be triaged.

### Complementing it with fuzzing

Mutation testing and fuzzing cover different failure modes and are meant to
be used together. The fuzz harness for the same fee maths is
[`contracts/fuzz/src/targets/marketplace_fee.rs`](../contracts/fuzz/src/targets/marketplace_fee.rs),
which asserts the fee invariants (`fee + net == amount`, `fee >= 0`,
`fee <= amount`, tier-fee bounds, zero-amount rejection, `MAX_AMOUNT`
safety) on every input the fuzzer produces:

```bash
make fuzz FUZZ_ITERS=50000
```

Run the focused mutation pass and the fuzz harness together when you change
fee maths; the mutation run proves the *tests* would catch a bad
calculation, the fuzz run proves the *inputs* are explored widely enough to
find one.

---

## 4. Contributing to Coverage Floors

Extended workspace contracts (`vesting`, `debtor_attestation`,
`parameter_registry`, `secondary_market`) each carry an explicit minimum
line-coverage floor. The floors live in
[`config/coverage-floor.toml`](../config/coverage-floor.toml) and are
enforced by the `coverage-extended` Makefile target, which the CI
`extended-coverage-floors` job runs. The fuzz and xtask binaries are
excluded from the per-crate denominators - they are test tooling, not
shipped contract code.

To check the floors locally:

```bash
make coverage-extended
```

The gate is validated by
[`contracts/tests/coverage_reporting_gate.rs`](../contracts/tests/coverage_reporting_gate.rs),
which fails if a floor is missing from the config, if a floor is out of
range, or if a crate's coverage drops below its floor.

---

## Known Current Blockers

This guide was validated by running the setup steps above end-to-end rather
than assumed. That run surfaced real, current problems on `main` — some were
small enough to fix as part of building this guide (see the PR that
introduced this file for the exact commits), others are separate, larger
issues now tracked for follow-up. Listing them here so the next contributor
doesn't waste an afternoon thinking they broke something:

- **Toolchain / lockfile mismatch.** `rust-toolchain.toml` pins Rust
  **1.75.0** (for byte-reproducible WASM output — see
  [`docs/REPRODUCIBLE_BUILD.md`](REPRODUCIBLE_BUILD.md)), but `Cargo.lock` is
  in lockfile format v4, which requires Cargo **≥1.78**. Cargo 1.75 cannot
  even parse the committed lockfile — `cargo check` fails before touching any
  source. Until a maintainer decides how to reconcile the pin with the
  lockfile (bump the pin, or re-pin the lockfile against 1.75-compatible
  dependency versions), **use a newer stable toolchain locally** to get a
  working build:
  ```bash
  rustup install stable
  cargo +stable check --all
  ```
  Understand that WASM built this way won't byte-for-byte match the
  officially pinned reproducible-build target — fine for iterating on logic
  and tests, not for anything release-related.
- **`contracts/financing_pool` (and its dependents `marketplace`,
  `fractionalizer`) currently fail to compile** — a large, pre-existing set of
  errors unrelated to this guide (malformed doc comments in a formal
  verification model, among others). Out of scope here; needs its own
  triage issue rather than a rushed fix. `contracts/tests` (the integration
  suite) and `contracts/fuzz` depend on these crates and won't build until
  it's resolved either.
- **`contracts/referral_rewards` expects `invoice_nft` to expose a referral
  feature that doesn't exist yet** (`mint_invoice_with_referrer`,
  `get_sme_referrer`, `get_first_mint`, an `InvalidReferrer` error variant).
  This is a real missing feature, not a bug in the existing code — it needs
  design (anti-self-referral, cycle detection) before implementation, not a
  mechanical fix.

- **Several `#[cfg(test)] mod tests` blocks carry the same kind of merge
  duplication independently of the production-code issues above** — spot
  checks found duplicate test functions and tests referencing entrypoints
  that were never implemented (a two-step admin-transfer flow, an audit-log
  getter) in `invoice_nft`, `risk_registry`, and `treasury` at least.
  `cargo check` / `make build` (production code) is clean for all three;
  `cargo test` for each currently is not. This looks scattered across more
  than these three crates and needs its own audit pass — a good candidate
  for the kind of split described in `GOOD_FIRST_ISSUES.md`'s worked example,
  crate by crate.

Everything else — `kora-shared`, `access_control`, `risk_registry`,
`price_oracle`, `treasury`, `invoice_nft`, `dispute_resolution`, `tranche`,
`verifier_nomination`, and `xtask` — **builds cleanly** (`make check` /
`make build`, i.e. `cargo check --all` / `cargo build`) as of this guide's
validation pass, using a newer-than-pinned toolchain per the note above.
Given the test-module issue just above, don't assume a full `cargo test
--all` is green right now — run tests scoped to the crate you're actually
touching (`cargo test -p <crate>`) and treat unrelated failures elsewhere as
pre-existing, not something your change broke.
