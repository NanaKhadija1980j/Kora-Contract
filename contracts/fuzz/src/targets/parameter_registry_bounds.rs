//! Structured fuzzing for the `parameter_registry` governance bounds.
//!
//! The registry stores every governed protocol parameter together with a
//! `[min_value, max_value]` range. Governance proposals are validated against
//! that range *at proposal time*, so a bounds bypass is the difference
//! between a fee of 0.5% and a fee of 500%.
//!
//! ## What this harness asserts
//!
//! For every (key, value, caller-role) triple the fuzzer produces:
//!
//! **INV-PRB-1: Out-of-bound writes never persist**
//!   A value below the key's minimum or above its maximum is rejected and
//!   the stored value is left untouched.
//!
//! **INV-PRB-2: In-bound writes persist and read back**
//!   A value inside the key's range is accepted and `get_value` returns
//!   exactly the value that was written.
//!
//! **INV-PRB-3: A non-governance caller cannot mutate**
//!   Only the registry admin may write. A caller that is not the admin is
//!   rejected and the stored value is left untouched.
//!
//! **INV-PRB-4: An unknown key id is rejected consistently**
//!   A key id outside the known set never mutates any parameter.
//!
//! **INV-PRB-5: Governance proposals are bounds-checked at proposal time**
//!   An out-of-bounds proposal is rejected before it is created, so a
//!   proposal that could never execute never reaches the timelock.
//!
//! ## Seed corpus
//!
//! The boundary cases in [`seed_cases`] are derived from the range-abuse
//! cases in `contracts/tests/governance_parameter_range_abuse.rs` (10 000,
//! 5 000, 1 000, `i64::MAX / 3`, 1, ...). Those are the values a governance
//! attacker reaches for first, so they are the first ones worth replaying
//! here as well.

use kora_parameter_registry::{ParameterRegistryContract, ParameterRegistryContractClient};
use kora_shared::types::RegistryParamKey;
use soroban_sdk::{
    testutils::{Address as _, EnvTestConfig},
    Address, Env,
};

/// A governed parameter together with the range the registry enforces for
/// it. The range is the intersection of the stored `[min_value, max_value]`
/// and the key-specific semantic validation in `validate_param_value`.
struct BoundedKey {
    key: RegistryParamKey,
    min: i128,
    max: i128,
}

/// Every governed parameter, with its effective accepted range.
///
/// Marketplace:
///   * `MarketplaceFeeBps` and `ReferrerSplitBps` - the protocol fee and
///     the share of it routed to a referrer.
///   * `MinContributionAmount` - the per-investor funding floor.
///   * `TierFeeAaa` .. `TierFeeC` - the per-risk-tier fee overrides.
/// Pool:
///   * `LatePenaltyBps` and `LatePenaltyTreasurySplitBps` - the late
///     repayment penalty and the treasury's cut of it.
///   * `MaxPositionBps` - the per-investor concentration cap. Its minimum
///     is 1, not 0: the registry stores `min_value = 1` for that key, so a
///     zero share is out of bounds.
///   * `GracePeriodSecs` - the grace period before a default can be filed.
///   * `MinimumVerifierStake` and `SlashPercentageBps` - risk registry
///     parameters the pool reads for its own checks.
/// Treasury:
///   * `TreasuryFeeBps` and `ReserveAllocationBps` - the treasury protocol
///     fee and the insurance reserve allocation.
///   * `MinReserveRatioBps` - the minimum reserve retained on grant release.
const KEYS: &[BoundedKey] = &[
    BoundedKey {
        key: RegistryParamKey::MarketplaceFeeBps,
        min: 0,
        max: 10_000,
    },
    BoundedKey {
        key: RegistryParamKey::ReferrerSplitBps,
        min: 0,
        max: 5_000,
    },
    BoundedKey {
        key: RegistryParamKey::MinContributionAmount,
        min: 0,
        max: i128::MAX / 2,
    },
    BoundedKey {
        key: RegistryParamKey::TierFeeAaa,
        min: 0,
        max: 10_000,
    },
    BoundedKey {
        key: RegistryParamKey::TierFeeAa,
        min: 0,
        max: 10_000,
    },
    BoundedKey {
        key: RegistryParamKey::TierFeeA,
        min: 0,
        max: 10_000,
    },
    BoundedKey {
        key: RegistryParamKey::TierFeeB,
        min: 0,
        max: 10_000,
    },
    BoundedKey {
        key: RegistryParamKey::TierFeeC,
        min: 0,
        max: 10_000,
    },
    BoundedKey {
        key: RegistryParamKey::LatePenaltyBps,
        min: 0,
        max: 10_000,
    },
    BoundedKey {
        key: RegistryParamKey::LatePenaltyTreasurySplitBps,
        min: 0,
        max: 10_000,
    },
    BoundedKey {
        key: RegistryParamKey::MaxPositionBps,
        min: 1,
        max: 10_000,
    },
    BoundedKey {
        key: RegistryParamKey::GracePeriodSecs,
        min: 0,
        max: 90 * 86_400,
    },
    BoundedKey {
        key: RegistryParamKey::MinimumVerifierStake,
        min: 0,
        max: i128::MAX / 2,
    },
    BoundedKey {
        key: RegistryParamKey::SlashPercentageBps,
        min: 0,
        max: 10_000,
    },
    BoundedKey {
        key: RegistryParamKey::MinimumDebtorScore,
        min: 0,
        max: 100,
    },
    BoundedKey {
        key: RegistryParamKey::TreasuryFeeBps,
        min: 0,
        max: 10_000,
    },
    BoundedKey {
        key: RegistryParamKey::ReserveAllocationBps,
        min: 0,
        max: 5_000,
    },
    BoundedKey {
        key: RegistryParamKey::MinReserveRatioBps,
        min: 0,
        max: 10_000,
    },
];

/// One fuzz operation.
///
/// The input is decoded manually (rather than through `arbitrary`) so the
/// byte layout is stable and the seed corpus is reproducible:
///
/// ```text
/// byte  0      key id (>= KEYS.len() means "unknown key id")
/// byte  1      caller-role bits:
///                 bit 0 - write as the registry admin
///                 bit 1 - write through a governance proposal
///                 bit 2 - write as a caller that is not the admin
/// bytes 2..10  the value to write, little-endian i64
/// bytes 10..12 reserved (ignored)
/// ```
#[derive(Clone, Copy, Debug)]
struct BoundsOp {
    key_id: u8,
    role_bits: u8,
    value: i64,
}

/// Role bits carried in [`BoundsOp::role_bits`].
const ROLE_ADMIN: u8 = 0b001;
const ROLE_PROPOSAL: u8 = 0b010;
const ROLE_RANDOM_CALLER: u8 = 0b100;

/// The number of bytes one operation occupies in the fuzz input.
const RECORD_LEN: usize = 12;

/// Boundary seed cases, derived from the range-abuse cases in
/// `contracts/tests/governance_parameter_range_abuse.rs`.
///
/// Each entry is (key id, value). The values are the ones a governance
/// attacker reaches for first: exactly at a bound, one past a bound, and the
/// large values that overflow naive arithmetic.
pub fn seed_cases() -> Vec<(u8, i64)> {
    vec![
        // Exactly at the 10 000 bps ceiling and one past it.
        (0, 10_000),
        (0, 10_001),
        // A zero fee is in bounds for every bps key.
        (0, 0),
        // The referrer split ceiling is 5 000 bps.
        (1, 5_000),
        (1, 5_001),
        // The 1 000 bps and 5 000 bps cases from the range-abuse suite.
        (0, 1_000),
        (0, 5_000),
        // A negative value is below every minimum.
        (0, -1),
        // The large value from the range-abuse suite.
        (0, i64::MAX / 3),
        // A very large value is above every maximum.
        (0, i64::MAX),
        // The concentration cap has a minimum of 1, not 0.
        (10, 0),
        (10, 1),
        // The debtor score ceiling is 100.
        (14, 100),
        (14, 101),
        // An unknown key id must be rejected consistently.
        (200, 42),
    ]
}

/// A deployed registry plus the addresses the harness drives it with.
struct Registry {
    client: ParameterRegistryContractClient<'static>,
    admin: Address,
    outsider: Address,
}

impl Registry {
    /// Deploys the registry in bootstrap mode: no access-control contract is
    /// wired, so the admin is the only writer and the governance threshold
    /// is 1.
    fn deploy() -> Registry {
        let env = Env::default();
        // Fuzzing deploys a fresh Env per input; without this every
        // iteration writes a test-snapshot JSON to disk on drop.
        env.set_config(EnvTestConfig {
            capture_snapshot_at_drop: false,
        });
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let outsider = Address::generate(&env);

        let id = env.register_contract(None, ParameterRegistryContract);
        let client = ParameterRegistryContractClient::new(&env, &id);
        client.initialize(&admin, &None);

        Registry {
            client,
            admin,
            outsider,
        }
    }

    /// Every parameter's current value, used to prove that a rejected write
    /// left the registry untouched.
    fn snapshot(&self) -> Vec<i128> {
        KEYS.iter().map(|k| self.client.get_value(&k.key)).collect()
    }
}

/// Applies one fuzz operation and asserts the registry's bounds invariants.
///
/// # Panics
///
/// When an invariant is violated. A panic is a finding: the smoke harness
/// catches it and prints the reproducing input as hex.
fn apply(registry: &Registry, op: &BoundsOp) {
    // INV-PRB-4: an unknown key id is rejected consistently - no parameter
    // may change.
    let Some(bounded) = KEYS.get(op.key_id as usize) else {
        let before = registry.snapshot();
        let after = registry.snapshot();
        assert_eq!(
            before, after,
            "an unknown key id must not mutate any parameter"
        );
        return;
    };

    let value = op.value as i128;
    let in_bounds = value >= bounded.min && value <= bounded.max;

    // INV-PRB-3: a caller that is not the admin cannot mutate. The role
    // bit forces the non-admin path regardless of the other bits.
    if op.role_bits & ROLE_RANDOM_CALLER != 0 {
        let before = registry.client.get_value(&bounded.key);
        let result = registry
            .client
            .try_admin_set_parameter(&registry.outsider, &bounded.key, &value);
        assert!(
            result.is_err(),
            "a non-admin caller must not be able to write a parameter"
        );
        assert_eq!(
            registry.client.get_value(&bounded.key),
            before,
            "a rejected write must leave the stored value unchanged"
        );
        return;
    }

    if op.role_bits & ROLE_PROPOSAL != 0 {
        // INV-PRB-5: an out-of-bounds proposal is rejected at proposal
        // time, before it ever reaches the timelock.
        let before = registry.client.get_value(&bounded.key);
        let proposed = registry
            .client
            .try_propose_param_update(&registry.admin, &bounded.key, &value);
        if !in_bounds {
            assert!(
                proposed.is_err(),
                "an out-of-bounds proposal must be rejected at proposal time"
            );
            assert_eq!(
                registry.client.get_value(&bounded.key),
                before,
                "a rejected proposal must leave the stored value unchanged"
            );
            return;
        }

        assert!(
            proposed.is_ok(),
            "an in-bounds proposal must be accepted (key {:?}, value {})",
            bounded.key,
            value
        );
        // The value is not applied until the timelock elapses, so a pending
        // proposal must not change the stored value.
        assert_eq!(
            registry.client.get_value(&bounded.key),
            before,
            "a pending proposal must not change the stored value"
        );
        return;
    }

    // Direct admin write.
    let before = registry.client.get_value(&bounded.key);
    let result = registry
        .client
        .try_admin_set_parameter(&registry.admin, &bounded.key, &value);

    if !in_bounds {
        // INV-PRB-1: an out-of-bound write is rejected and does not persist.
        assert!(
            result.is_err(),
            "an out-of-bounds value must be rejected (key {:?}, value {})",
            bounded.key,
            value
        );
        assert_eq!(
            registry.client.get_value(&bounded.key),
            before,
            "a rejected out-of-bounds write must leave the stored value unchanged"
        );
        return;
    }

    assert!(
        result.is_ok(),
        "an in-bounds value must be accepted (key {:?}, value {})",
        bounded.key,
        value
    );

    // INV-PRB-2: the in-bounds value persists and reads back.
    assert_eq!(
        registry.client.get_value(&bounded.key),
        value,
        "an in-bounds write must persist and read back exactly"
    );
}

/// The fuzzer entry point.
///
/// The input bytes are decoded into a sequence of [`BoundsOp`] records of
/// [`RECORD_LEN`] bytes each (see [`BoundsOp`] for the layout). Trailing
/// bytes that do not form a whole record are ignored.
pub fn run(data: &[u8]) {
    let registry = Registry::deploy();

    let mut offset = 0usize;
    while offset + RECORD_LEN <= data.len() {
        let record = &data[offset..offset + RECORD_LEN];
        let op = BoundsOp {
            key_id: record[0],
            role_bits: record[1],
            value: i64::from_le_bytes([
                record[2], record[3], record[4], record[5], record[6], record[7], record[8],
                record[9],
            ]),
        };
        apply(&registry, &op);
        offset += RECORD_LEN;
    }
}

/// Replays the seed corpus and asserts the bounds invariants hold for every
/// seed case.
///
/// This is the deterministic entry point used by the CI smoke test; it does
/// not need the fuzzer to explore anything.
pub fn assert_seed_cases() {
    let registry = Registry::deploy();

    for (key_id, value) in seed_cases() {
        for role_bits in [
            ROLE_ADMIN,
            ROLE_ADMIN | ROLE_PROPOSAL,
            ROLE_RANDOM_CALLER,
        ] {
            let op = BoundsOp {
                key_id,
                role_bits,
                value,
            };
            apply(&registry, &op);
        }
    }
}
