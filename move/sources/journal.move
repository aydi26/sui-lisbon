// Stub-phase lint suppression. The event struct below is part of the CONTRACT
// (docs/MOVE-PACKAGE.md §9.1) and is declared for real, but nothing constructs it until the
// TODO(T4.2) body lands. DELETE when the module status becomes DONE.
#[allow(unused_field)]
module aphotic::journal;

// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T4.2
// @phase      4
// @status     PARTIAL
// @spec       docs/MOVE-PACKAGE.md#module-journal (L667-L694)
// @spec       docs/BUILD-PLAN.md#T4.2 (L151)
// @rules      G5 G10
// @depends    aphotic::vault (T1.1) — for the KeeperCap gate
// @facts      A Walrus blob id is CONTENT-DERIVED and therefore SELF-CERTIFYING. This module
// @facts        emits it verbatim as opaque bytes and never interprets or trusts its contents.
// @facts      WALRUS_EPOCHS must be set EXPLICITLY at write time (it defaults to a SINGLE
// @facts        epoch if omitted) — that is a keeper/storage concern, not an on-chain one.
// @facts      Blobs are PUBLIC and discoverable ⇒ encrypt before upload, always.
// @facts      Decision records carry the bridge fields (limiter reading, pending-mint total)
// @facts        plus oracle/book/strategy_blob/ruleset/decision/result — see docs/KEEPER.md.
// @facts        Only the blob id is anchored here; the heavy record lives off-chain.
// @external   (none — Walrus put/get is off-chain, keeper/src/storage/.)
// @implements public fun record<B, Q>(vault: &Vault<B, Q>, keeper_cap: &KeeperCap,
//                 blob_id: vector<u8>, seq: u64, ctx: &mut TxContext)
//             public fun assert_monotonic_seq(last_seq: u64, seq: u64)          [DONE]
// @events     DecisionRecorded { vault_id: ID, seq: u64, blob_id: vector<u8> }
// @errors     EStaleSeq  (plus the shared keeper-gate aborts surfaced by vault::assert_keeper)
// @forbidden  interpreting, parsing or validating blob_id contents — it is opaque and
//             self-certifying by construction
// @forbidden  a bridge module path in this file — G7, gates.ps1 g7
// @invariant  1. record is keeper-gated: a valid KeeperCap at the CURRENT version_epoch.
// @invariant  2. blob_id is emitted verbatim as opaque bytes.
// @invariant  3. seq is strictly increasing per vault — it is the replay ordering the keeper
//                verify engine depends on (G5).
// @ac         docs/MOVE-PACKAGE.md §8 journal_tests checklist (L661-L663)
// @verify     sui move build
// @verify     sui move test journal
// └── END CONTRACT ───────────────────────────────────────────────────────────

// ── error constants (docs/MOVE-PACKAGE.md §9.1) ─────────────────────────────
const EStaleSeq: u64 = 1;

// ── events (docs/MOVE-PACKAGE.md §9.1) ──────────────────────────────────────

public struct DecisionRecorded has copy, drop {
    vault_id: ID,
    seq: u64,
    /// Walrus blob id — content-derived, self-certifying, opaque to this module.
    blob_id: vector<u8>,
}

// ── pure guards (implemented now) ───────────────────────────────────────────

/// Replay ordering gate (G5): decision-log segments must be strictly increasing.
public fun assert_monotonic_seq(last_seq: u64, seq: u64) {
    assert!(seq > last_seq, EStaleSeq);
}

// ── still to implement ──────────────────────────────────────────────────────
// TODO(T4.2): record — vault::assert_keeper(vault, keeper_cap);
//             assert_monotonic_seq against the vault's last recorded seq;
//             emit DecisionRecorded { vault_id, seq, blob_id } verbatim.
