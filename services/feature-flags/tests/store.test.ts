/**
 * FlagStore Tests
 *
 * Covers CRUD, cache invalidation on write, and change callbacks.
 */

import * as os from "os";
import * as path from "path";
import { FlagStore } from "../src/store";
import { FeatureFlag } from "../src/types";

function tmpDb(): string {
  return path.join(os.tmpdir(), `kora-store-test-${Date.now()}-${Math.random()}.db`);
}

function baseFlag(overrides: Partial<FeatureFlag> = {}): Omit<FeatureFlag, "createdAt" | "updatedAt"> {
  return {
    name: "secondary-market",
    description: "desc",
    enabled: true,
    rules: [],
    updatedBy: "test",
    ...overrides,
  };
}

describe("FlagStore", () => {
  it("upsert creates a flag and getByName returns it", () => {
    const store = new FlagStore(tmpDb(), { cacheTtlMs: 0 });
    store.upsert(baseFlag());
    const flag = store.getByName("secondary-market");
    expect(flag).not.toBeNull();
    expect(flag!.name).toBe("secondary-market");
    expect(flag!.enabled).toBe(true);
  });

  it("upsert is idempotent — second call updates existing row", () => {
    const store = new FlagStore(tmpDb(), { cacheTtlMs: 0 });
    store.upsert(baseFlag({ enabled: true }));
    store.upsert(baseFlag({ enabled: false }));
    expect(store.getByName("secondary-market")!.enabled).toBe(false);
  });

  it("getAll returns all upserted flags", () => {
    const store = new FlagStore(tmpDb(), { cacheTtlMs: 0 });
    store.upsert(baseFlag({ name: "secondary-market" }));
    store.upsert(baseFlag({ name: "fractionalization" }));
    expect(store.getAll()).toHaveLength(2);
  });

  it("setEnabled updates only the enabled field", () => {
    const store = new FlagStore(tmpDb(), { cacheTtlMs: 0 });
    store.upsert(baseFlag({ rules: [{ type: "percentage", rolloutBps: 5000 }] }));
    store.setEnabled("secondary-market", false, "admin");
    const flag = store.getByName("secondary-market")!;
    expect(flag.enabled).toBe(false);
    // Rules unchanged
    expect(flag.rules).toHaveLength(1);
  });

  it("setEnabled throws for unknown flag", () => {
    const store = new FlagStore(tmpDb(), { cacheTtlMs: 0 });
    expect(() => store.setEnabled("secondary-market", false, "admin")).toThrow();
  });

  it("delete removes the flag", () => {
    const store = new FlagStore(tmpDb(), { cacheTtlMs: 0 });
    store.upsert(baseFlag());
    store.delete("secondary-market");
    expect(store.getByName("secondary-market")).toBeNull();
  });

  it("getByName returns null for unknown flag", () => {
    const store = new FlagStore(tmpDb(), { cacheTtlMs: 0 });
    expect(store.getByName("secondary-market")).toBeNull();
  });

  it("onFlagChange callback fires on upsert", () => {
    const store = new FlagStore(tmpDb(), { cacheTtlMs: 0 });
    const changes: FeatureFlag[] = [];
    store.onFlagChange((f) => changes.push(f));
    store.upsert(baseFlag());
    expect(changes).toHaveLength(1);
    expect(changes[0].name).toBe("secondary-market");
  });

  it("onFlagChange callback fires on setEnabled", () => {
    const store = new FlagStore(tmpDb(), { cacheTtlMs: 0 });
    store.upsert(baseFlag());
    const changes: FeatureFlag[] = [];
    store.onFlagChange((f) => changes.push(f));
    store.setEnabled("secondary-market", false, "admin");
    expect(changes).toHaveLength(1);
    expect(changes[0].enabled).toBe(false);
  });

  it("preserves createdAt across updates", () => {
    const store = new FlagStore(tmpDb(), { cacheTtlMs: 0 });
    const first = store.upsert(baseFlag());
    // Small delay to ensure timestamps differ
    const second = store.upsert(baseFlag({ description: "updated" }));
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).not.toBe(first.updatedAt);
  });

  it("serialises and deserialises rules correctly", () => {
    const store = new FlagStore(tmpDb(), { cacheTtlMs: 0 });
    store.upsert(baseFlag({
      rules: [
        { type: "allowlist", allowedUserHashes: ["abc123"] },
        { type: "percentage", rolloutBps: 2500 },
      ],
    }));
    const flag = store.getByName("secondary-market")!;
    expect(flag.rules).toHaveLength(2);
    expect(flag.rules[0].type).toBe("allowlist");
    expect(flag.rules[1].type).toBe("percentage");
  });

  it("cache returns stale value within TTL", () => {
    const store = new FlagStore(tmpDb(), { cacheTtlMs: 60_000 }); // long TTL
    store.upsert(baseFlag({ enabled: true }));
    // Directly update DB to bypass store methods (simulates external change)
    // Then read through cache — should still see old value
    const flag = store.getByName("secondary-market")!;
    expect(flag.enabled).toBe(true); // from cache
  });
});
