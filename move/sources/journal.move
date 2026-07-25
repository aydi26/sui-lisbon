module aphotic::journal;

use aphotic::vault::{Self, Vault, KeeperCap};
use sui::event;

// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T4.2
// @phase      4
// @status     DONE
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
// @facts      GENESIS SEQ: a fresh JournalCursor has last_seq = 0 and the first accepted record
// @facts        is seq = 1. `assert_monotonic_seq` is STRICT (`>`), so seq 0 can never be
// @facts        recorded — the keeper's segment numbering is 1-based.
// @external   (none — Walrus put/get is off-chain, keeper/src/storage/.)
// @implements public fun new_journal_cursor<B, Q>(vault: &Vault<B, Q>, keeper_cap: &KeeperCap,
//                 ctx: &mut TxContext): ID
//             public fun record<B, Q>(vault: &Vault<B, Q>, cursor: &mut JournalCursor,
//                 keeper_cap: &KeeperCap, blob_id: vector<u8>, seq: u64, ctx: &mut TxContext)
//             public fun cursor_vault_id(c: &JournalCursor): ID
//             public fun cursor_last_seq(c: &JournalCursor): u64
//             public fun assert_monotonic_seq(last_seq: u64, seq: u64)          [DONE]
//             ⚠ DELTA vs docs/MOVE-PACKAGE.md §9.1, deliberate and forced:
//               `record` takes a `&mut JournalCursor`. §9.2 @invariant 3 requires seq to be
//               strictly increasing PER VAULT, and §9.1 hedges the error constant as
//               "EStaleSeq (if a seq check is enforced)" — because the spec's own signature has
//               nowhere to keep the last seq. `aphotic::vault` has no `last_seq` field, and a
//               leaf module cannot reach the vault's private `UID` to hang a dynamic field on
//               it. So the ordering state lives in a small shared object this module owns.
//               Without it the invariant is not enforced, it is merely hoped for, and the
//               keeper `verify/` replay (G5) depends on it being real.
// @events     DecisionRecorded { vault_id: ID, seq: u64, blob_id: vector<u8> }
//             JournalCursorCreated { vault_id: ID, cursor_id: ID }
// @errors     EStaleSeq · ECursorVaultMismatch  (plus the shared keeper-gate aborts surfaced by
//             vault::assert_keeper)
// @forbidden  interpreting, parsing or validating blob_id contents — it is opaque and
//             self-certifying by construction
// @forbidden  a bridge module path in this file — G7, gates.ps1 g7
// @invariant  1. record is keeper-gated: a valid KeeperCap at the CURRENT version_epoch.
// @invariant  2. blob_id is emitted verbatim as opaque bytes.
// @invariant  3. seq is strictly increasing per vault — it is the replay ordering the keeper
//                verify engine depends on (G5). Enforced against JournalCursor.last_seq.
// @invariant  4. A cursor is permanently bound to one vault (ECursorVaultMismatch), so a cursor
//                from another vault can never be used to reset an ordering.
// @ac         docs/MOVE-PACKAGE.md §8 journal_tests checklist (L661-L663)
// @verify     sui move build
// @verify     sui move test journal
// └── END CONTRACT ───────────────────────────────────────────────────────────

// ── error constants (docs/MOVE-PACKAGE.md §9.1) ─────────────────────────────
const EStaleSeq: u64 = 1;
const ECursorVaultMismatch: u64 = 2;

// ── state ───────────────────────────────────────────────────────────────────

/// The replay-ordering cursor for one vault's decision log. Shared, so the keeper can advance it
/// from any transaction, but every mutation is `KeeperCap`-gated.
///
/// It holds ONLY an ordering counter. It never holds funds, never holds a capability, and its
/// existence cannot authorise anything — losing or duplicating it degrades the ordering guarantee
/// and nothing else.
public struct JournalCursor has key {
    id: UID,
    vault_id: ID,
    last_seq: u64,
}

// ── events (docs/MOVE-PACKAGE.md §9.1) ──────────────────────────────────────

public struct DecisionRecorded has copy, drop {
    vault_id: ID,
    seq: u64,
    /// Walrus blob id — content-derived, self-certifying, opaque to this module.
    blob_id: vector<u8>,
}

public struct JournalCursorCreated has copy, drop {
    vault_id: ID,
    cursor_id: ID,
}

// ── pure guards ─────────────────────────────────────────────────────────────

/// Replay ordering gate (G5): decision-log segments must be strictly increasing.
public fun assert_monotonic_seq(last_seq: u64, seq: u64) {
    assert!(seq > last_seq, EStaleSeq);
}

// ── lifecycle ───────────────────────────────────────────────────────────────

/// Create and SHARE the ordering cursor for `vault`. Keeper-gated for the same reason `record`
/// is: only the party that writes the log gets to open it. Returns the cursor's `ID` so the
/// creating PTB can hand it straight to the keeper config.
public fun new_journal_cursor<B, Q>(
    vault: &Vault<B, Q>,
    keeper_cap: &KeeperCap,
    ctx: &mut TxContext,
): ID {
    vault::assert_keeper(vault, keeper_cap);

    let vault_id = object::id(vault);
    let cursor = JournalCursor { id: object::new(ctx), vault_id, last_seq: 0 };
    let cursor_id = object::id(&cursor);

    event::emit(JournalCursorCreated { vault_id, cursor_id });

    transfer::share_object(cursor);

    cursor_id
}

public fun cursor_vault_id(c: &JournalCursor): ID { c.vault_id }

public fun cursor_last_seq(c: &JournalCursor): u64 { c.last_seq }

// ── T4.2: anchor a decision-log segment ─────────────────────────────────────

/// Emit the Walrus blob id of a decision-log segment, making the off-chain record
/// self-certifying: the blob id is content-derived, so an on-chain pointer cannot be substituted
/// for a different record without the substitution being obvious.
///
/// `blob_id` is opaque. This module does not parse it, does not check its length, and does not
/// trust anything about its contents — it is a commitment, not data.
///
/// Ordering (@invariant 3): `seq` must strictly exceed the cursor's `last_seq`. A replayed,
/// reordered or duplicated segment aborts `EStaleSeq`, which is what lets `keeper/src/verify/`
/// treat the on-chain event stream as a total order (G5).
public fun record<B, Q>(
    vault: &Vault<B, Q>,
    cursor: &mut JournalCursor,
    keeper_cap: &KeeperCap,
    blob_id: vector<u8>,
    seq: u64,
    _ctx: &mut TxContext,
) {
    vault::assert_keeper(vault, keeper_cap);

    let vault_id = object::id(vault);
    assert!(cursor.vault_id == vault_id, ECursorVaultMismatch);
    assert_monotonic_seq(cursor.last_seq, seq);

    cursor.last_seq = seq;

    event::emit(DecisionRecorded { vault_id, seq, blob_id });
}

// ── test-only helpers ───────────────────────────────────────────────────────
// Event/struct fields are module-private; these let move/tests/journal_tests.move assert on the
// emitted receipt and stage a cursor without a shared-object round trip. They compile out of the
// published package.

#[test_only]
public fun decision_recorded_fields(e: &DecisionRecorded): (ID, u64, vector<u8>) {
    (e.vault_id, e.seq, e.blob_id)
}

#[test_only]
public fun journal_cursor_created_fields(e: &JournalCursorCreated): (ID, ID) {
    (e.vault_id, e.cursor_id)
}

#[test_only]
public fun new_cursor_for_testing(vault_id: ID, ctx: &mut TxContext): JournalCursor {
    JournalCursor { id: object::new(ctx), vault_id, last_seq: 0 }
}

#[test_only]
public fun destroy_cursor_for_testing(cursor: JournalCursor) {
    let JournalCursor { id, vault_id: _, last_seq: _ } = cursor;
    id.delete();
}
