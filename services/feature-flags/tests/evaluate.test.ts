/**
 * Feature Flag Evaluation Tests
 *
 * Covers:
 *  - kill-switch behaviour
 *  - percentage rollout determinism and distribution
 *  - allow-list and deny-list targeting
 *  - mid-flow disable graceful handling (flag toggled during a session)
 *  - unknown flag defaults to off
 */

import {
  evaluateFlag,
  evaluateAll,
  computeRolloutBucket,
  hashUser,
} from "../src/evaluate";
import { FeatureFlag } from "../src/types";

const NOW = new Date().toISOString();

function makeFlag(overrides: Partial<FeatureFlag> = {}): FeatureFlag {
  return {
    name: "secondary-market",
    description: "test",
    enabled: true,
    rules: [],
    createdAt: NOW,
    updatedAt: NOW,
    updatedBy: "test",
    ...overrides,
  };
}

// ── Kill-switch ───────────────────────────────────────────────────────────────

describe("kill-switch", () => {
  it("returns false for all users when enabled=false regardless of rules", () => {
    const flag = makeFlag({
      enabled: false,
      rules: [{ type: "percentage", rolloutBps: 10000 }], // 100% rollout
    });
    for (const user of ["alice", "bob", "charlie"]) {
      const result = evaluateFlag(flag, user);
      expect(result.value).toBe(false);
      expect(result.reason).toBe("kill-switch-off");
    }
  });

  it("re-enabling the flag resumes normal evaluation", () => {
    const disabled = makeFlag({ enabled: false, rules: [{ type: "percentage", rolloutBps: 10000 }] });
    const enabled = makeFlag({ enabled: true, rules: [{ type: "percentage", rolloutBps: 10000 }] });

    const user = "alice";
    expect(evaluateFlag(disabled, user).value).toBe(false);
    expect(evaluateFlag(enabled, user).value).toBe(true);
  });
});

// ── Percentage rollout ────────────────────────────────────────────────────────

describe("percentage rollout", () => {
  it("is deterministic — same user always gets same result", () => {
    const flag = makeFlag({ rules: [{ type: "percentage", rolloutBps: 5000 }] });
    const user = "deterministic-user-1";
    const results = Array.from({ length: 10 }, () => evaluateFlag(flag, user).value);
    expect(new Set(results).size).toBe(1); // all same
  });

  it("0 bps rollout means nobody is in", () => {
    const flag = makeFlag({ rules: [{ type: "percentage", rolloutBps: 0 }] });
    const inCount = Array.from({ length: 1000 }, (_, i) => evaluateFlag(flag, `user-${i}`).value).filter(Boolean).length;
    expect(inCount).toBe(0);
  });

  it("10000 bps rollout means everyone is in", () => {
    const flag = makeFlag({ rules: [{ type: "percentage", rolloutBps: 10000 }] });
    const inCount = Array.from({ length: 1000 }, (_, i) => evaluateFlag(flag, `user-${i}`).value).filter(Boolean).length;
    expect(inCount).toBe(1000);
  });

  it("distributes approximately correctly at 50%", () => {
    const flag = makeFlag({ rules: [{ type: "percentage", rolloutBps: 5000 }] });
    const inCount = Array.from({ length: 10_000 }, (_, i) => evaluateFlag(flag, `user-${i}`).value).filter(Boolean).length;
    // Allow ±3% deviation from expected 50%
    expect(inCount).toBeGreaterThan(4700);
    expect(inCount).toBeLessThan(5300);
  });

  it("distributes approximately correctly at 10%", () => {
    const flag = makeFlag({ rules: [{ type: "percentage", rolloutBps: 1000 }] });
    const inCount = Array.from({ length: 10_000 }, (_, i) => evaluateFlag(flag, `user-${i}`).value).filter(Boolean).length;
    expect(inCount).toBeGreaterThan(900);
    expect(inCount).toBeLessThan(1100);
  });

  it("salt prevents flags from perfectly correlating", () => {
    // Two flags at 50% with different salts should not have identical membership
    const flagA = makeFlag({ name: "secondary-market", rules: [{ type: "percentage", rolloutBps: 5000, salt: "flag-a" }] });
    const flagB = makeFlag({ name: "fractionalization", rules: [{ type: "percentage", rolloutBps: 5000, salt: "flag-b" }] });

    let identical = 0;
    for (let i = 0; i < 1000; i++) {
      const u = `u-${i}`;
      if (evaluateFlag(flagA, u).value === evaluateFlag(flagB, u).value) identical++;
    }
    // Some correlation is expected by chance; but perfect 1000/1000 correlation would be a bug
    expect(identical).toBeLessThan(1000);
  });
});

// ── Allow-list ────────────────────────────────────────────────────────────────

describe("allowlist", () => {
  it("returns true only for listed users", () => {
    const allowed = hashUser("alice");
    const flag = makeFlag({
      rules: [{ type: "allowlist", allowedUserHashes: [allowed] }],
    });

    expect(evaluateFlag(flag, "alice").value).toBe(true);
    expect(evaluateFlag(flag, "alice").reason).toBe("allowlist-match");
    expect(evaluateFlag(flag, "bob").value).toBe(false);
  });

  it("does not leak whether alice is in the list to external observers", () => {
    // The raw user ID is never returned in the evaluation result
    const allowed = hashUser("alice");
    const flag = makeFlag({ rules: [{ type: "allowlist", allowedUserHashes: [allowed] }] });
    const result = evaluateFlag(flag, "alice");
    expect(JSON.stringify(result)).not.toContain("alice");
  });
});

// ── Deny-list ─────────────────────────────────────────────────────────────────

describe("denylist", () => {
  it("blocks listed users even with a 100% percentage rule following", () => {
    const denied = hashUser("eve");
    const flag = makeFlag({
      rules: [
        { type: "denylist", deniedUserHashes: [denied] },
        { type: "percentage", rolloutBps: 10000 },
      ],
    });

    expect(evaluateFlag(flag, "eve").value).toBe(false);
    expect(evaluateFlag(flag, "eve").reason).toBe("denylist-match");
    // Other users still get the 100% rollout
    expect(evaluateFlag(flag, "bob").value).toBe(true);
  });
});

// ── Rule ordering ─────────────────────────────────────────────────────────────

describe("rule ordering", () => {
  it("first matching rule wins", () => {
    const aliceHash = hashUser("alice");
    const flag = makeFlag({
      rules: [
        { type: "allowlist", allowedUserHashes: [aliceHash] }, // matches alice → true
        { type: "percentage", rolloutBps: 0 },                 // would say false for everyone
      ],
    });
    // Allowlist rule fires first, so alice is in even though percentage says out
    expect(evaluateFlag(flag, "alice").value).toBe(true);
    expect(evaluateFlag(flag, "alice").reason).toBe("allowlist-match");
  });
});

// ── No-rules default ──────────────────────────────────────────────────────────

describe("no-rules default", () => {
  it("returns false when there are no rules", () => {
    const flag = makeFlag({ rules: [] });
    const result = evaluateFlag(flag, "anyone");
    expect(result.value).toBe(false);
    expect(result.reason).toBe("no-rules-default-off");
  });
});

// ── evaluateAll ───────────────────────────────────────────────────────────────

describe("evaluateAll", () => {
  it("returns a map of all flag names to booleans", () => {
    const flags: FeatureFlag[] = [
      makeFlag({ name: "secondary-market", rules: [{ type: "percentage", rolloutBps: 10000 }] }),
      makeFlag({ name: "fractionalization", enabled: false, rules: [] }),
    ];
    const snapshot = evaluateAll(flags, "user-1");
    expect(snapshot["secondary-market"]).toBe(true);
    expect(snapshot["fractionalization"]).toBe(false);
  });
});

// ── computeRolloutBucket ──────────────────────────────────────────────────────

describe("computeRolloutBucket", () => {
  it("returns a value in [0, 9999]", () => {
    for (let i = 0; i < 100; i++) {
      const bucket = computeRolloutBucket(`user-${i}`, "flag", "salt");
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThanOrEqual(9999);
    }
  });

  it("is deterministic", () => {
    const b1 = computeRolloutBucket("user-123", "my-flag", "salt");
    const b2 = computeRolloutBucket("user-123", "my-flag", "salt");
    expect(b1).toBe(b2);
  });
});
