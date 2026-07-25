#[test_only]
module aphotic::journal_tests;

use aphotic::envelope;
use aphotic::journal::{Self, JournalCursor};
use aphotic::vault::{Self, Vault, VaultCap, KeeperCap};
use sui::event;
use sui::test_scenario::{Self as ts, Scenario};

// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T4.2
// @phase      4
// @status     DONE
// @spec       docs/MOVE-PACKAGE.md#8-per-module-test-checklist (L661-L663)
// @rules      G5
// @depends    aphotic::journal (T4.2) · aphotic::vault (T1.1)
// @facts      A Walrus blob id is opaque, content-derived and self-certifying — the module
// @facts        must emit it verbatim and never interpret it.
// @facts      `create_vault` does NOT issue a KeeperCap; only `vault::set_keeper` mints one, and
// @facts        it bumps `version_epoch`. Every cap below therefore comes from `set_keeper`, and
// @facts        calling it twice is exactly how a "rotated-out" cap is produced.
// @facts      The 32-byte blob id below is a REAL-SHAPED Walrus id (base-256 form). Nothing in
// @facts        the module parses it; it is asserted to survive byte-for-byte.
// @implements #[test] fun seq_must_strictly_increase()                        [DONE]
//             #[test] fun repeated_seq_is_stale()                             [DONE]
//             #[test] fun record_requires_a_current_keeper_cap()              [DONE]
//             #[test] fun record_is_blocked_by_a_paused_vault()               [DONE]
//             #[test] fun new_cursor_requires_a_current_keeper_cap()          [DONE]
//             #[test] fun a_fresh_cursor_starts_at_zero_and_is_bound()        [DONE]
//             #[test] fun record_emits_the_blob_id_verbatim()                 [DONE]
//             #[test] fun record_advances_the_cursor_and_allows_gaps()        [DONE]
//             #[test] fun a_replayed_seq_aborts()                             [DONE]
//             #[test] fun a_reordered_seq_aborts()                            [DONE]
//             #[test] fun a_foreign_cursor_cannot_reset_the_ordering()        [DONE]
//             #[test] fun an_empty_blob_id_is_still_opaque_and_emitted()      [DONE]
// @invariant  1. seq is the replay ordering the keeper verify engine depends on (G5).
// @invariant  2. Every `#[test]` here asserts. An empty body is a defect, not a placeholder.
// @ac         docs/MOVE-PACKAGE.md §8 journal_tests checklist (L661-L663)
// @verify     sui move test journal
// └── END CONTRACT ───────────────────────────────────────────────────────────

public struct TESTBTC has drop {}
public struct TESTUSDC has drop {}

const OWNER: address = @0x0A;
const KEEPER: address = @0x0B;

const BM_ADDR: address = @0xBEEF;
const POOL_ADDR: address = @0xF00D;

const LIVE_REFILL: u64 = 115_740;
const LIVE_CAP: u64 = 10_000_000_000;

/// A 32-byte Walrus blob id. Deliberately full of bytes that would break any naive parser —
/// nulls, 0xff, and a run that looks like a length prefix. The module must not care.
const BLOB_A: vector<u8> =
    x"00ff0102deadbeefcafebabe0000000011223344556677889900aabbccddeeff";
/// A second, DIFFERENT blob id, one byte longer, so a truncating emitter would be caught.
const BLOB_B: vector<u8> =
    x"f00dfeed0102deadbeefcafebabe0000000011223344556677889900aabbccddee";

// ── helpers ─────────────────────────────────────────────────────────────────

fun params(): envelope::EnvelopeParams {
    envelope::new_envelope_params(50, 100_000_000, 0, 100, LIVE_REFILL, LIVE_CAP, 0)
}

fun create(scenario: &mut Scenario, pool_addr: address): ID {
    scenario.next_tx(OWNER);
    let cap = vault::create_vault<TESTBTC, TESTUSDC>(
        object::id_from_address(BM_ADDR),
        object::id_from_address(pool_addr),
        b"ciphertext-v0",
        b"blob-v0",
        params(),
        KEEPER,
        scenario.ctx(),
    );
    let vault_id = vault::vault_cap_vault_id(&cap);
    transfer::public_transfer(cap, OWNER);
    vault_id
}

fun borrow(scenario: &Scenario, vault_id: ID): Vault<TESTBTC, TESTUSDC> {
    ts::take_shared_by_id<Vault<TESTBTC, TESTUSDC>>(scenario, vault_id)
}

fun mint_keeper_cap(scenario: &mut Scenario, vault_id: ID): KeeperCap {
    scenario.next_tx(OWNER);
    let mut v = borrow(scenario, vault_id);
    let owner_cap = ts::take_from_address<VaultCap>(scenario, OWNER);
    let keeper_cap = vault::set_keeper(&mut v, &owner_cap, KEEPER, scenario.ctx());
    ts::return_to_address(OWNER, owner_cap);
    ts::return_shared(v);
    keeper_cap
}

fun set_paused(scenario: &mut Scenario, vault_id: ID, paused: bool) {
    scenario.next_tx(OWNER);
    let mut v = borrow(scenario, vault_id);
    let owner_cap = ts::take_from_address<VaultCap>(scenario, OWNER);
    vault::set_paused(&mut v, &owner_cap, paused);
    ts::return_to_address(OWNER, owner_cap);
    ts::return_shared(v);
}

/// Open the vault's cursor through the REAL keeper-gated entrypoint, then take the shared
/// object back so the test can drive `record` against it.
fun open_cursor(scenario: &mut Scenario, vault_id: ID, cap: &KeeperCap): ID {
    scenario.next_tx(KEEPER);
    let v = borrow(scenario, vault_id);
    let cursor_id = journal::new_journal_cursor(&v, cap, scenario.ctx());
    ts::return_shared(v);
    cursor_id
}

fun take_cursor(scenario: &Scenario, cursor_id: ID): JournalCursor {
    ts::take_shared_by_id<JournalCursor>(scenario, cursor_id)
}

// ── the pure guard (unchanged from the skeleton — still the tripwire) ───────

#[test]
fun seq_must_strictly_increase() {
    journal::assert_monotonic_seq(0, 1);
    journal::assert_monotonic_seq(41, 42);
    journal::assert_monotonic_seq(0, 18_446_744_073_709_551_615);
}

#[test]
#[expected_failure(abort_code = journal::EStaleSeq)]
fun repeated_seq_is_stale() {
    journal::assert_monotonic_seq(7, 7);
}

// ── @invariant 1: the keeper gate ───────────────────────────────────────────

#[test]
#[expected_failure(abort_code = vault::EStaleVersionEpoch)]
fun record_requires_a_current_keeper_cap() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, POOL_ADDR);
    let stale = mint_keeper_cap(&mut scenario, vault_id); // epoch 1
    let fresh = mint_keeper_cap(&mut scenario, vault_id); // epoch 2 — rotation kills `stale`
    let cursor_id = open_cursor(&mut scenario, vault_id, &fresh);

    scenario.next_tx(KEEPER);
    let v = borrow(&scenario, vault_id);
    let mut cursor = take_cursor(&scenario, cursor_id);

    // Sanity: the fresh cap records fine, so the abort below is about the rotation only.
    journal::record(&v, &mut cursor, &fresh, BLOB_A, 1, scenario.ctx());
    assert!(journal::cursor_last_seq(&cursor) == 1, 0);

    journal::record(&v, &mut cursor, &stale, BLOB_B, 2, scenario.ctx());

    abort 0
}

#[test]
#[expected_failure(abort_code = vault::EPaused)]
fun record_is_blocked_by_a_paused_vault() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, POOL_ADDR);
    let cap = mint_keeper_cap(&mut scenario, vault_id);
    let cursor_id = open_cursor(&mut scenario, vault_id, &cap);
    set_paused(&mut scenario, vault_id, true);

    scenario.next_tx(KEEPER);
    let v = borrow(&scenario, vault_id);
    let mut cursor = take_cursor(&scenario, cursor_id);

    journal::record(&v, &mut cursor, &cap, BLOB_A, 1, scenario.ctx());

    abort 0
}

#[test]
#[expected_failure(abort_code = vault::EStaleVersionEpoch)]
fun new_cursor_requires_a_current_keeper_cap() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, POOL_ADDR);
    let stale = mint_keeper_cap(&mut scenario, vault_id);
    let _fresh = mint_keeper_cap(&mut scenario, vault_id);

    scenario.next_tx(KEEPER);
    let v = borrow(&scenario, vault_id);
    journal::new_journal_cursor(&v, &stale, scenario.ctx());

    abort 0
}

// ── the cursor ──────────────────────────────────────────────────────────────

#[test]
fun a_fresh_cursor_starts_at_zero_and_is_bound() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, POOL_ADDR);
    let cap = mint_keeper_cap(&mut scenario, vault_id);

    // The creation and its receipt must be asserted in the SAME transaction —
    // `event::events_by_type` only sees the current tx's events.
    scenario.next_tx(KEEPER);
    let v = borrow(&scenario, vault_id);
    let cursor_id = journal::new_journal_cursor(&v, &cap, scenario.ctx());

    // The creation is announced, so a second cursor for the same vault cannot appear silently.
    let created = event::events_by_type<journal::JournalCursorCreated>();
    assert!(created.length() == 1, 0);
    let (emitted_vault, emitted_cursor) = journal::journal_cursor_created_fields(created.borrow(0));
    assert!(emitted_vault == vault_id, 1);
    assert!(emitted_cursor == cursor_id, 2);
    ts::return_shared(v);

    scenario.next_tx(KEEPER);
    let cursor = take_cursor(&scenario, cursor_id);
    assert!(journal::cursor_last_seq(&cursor) == 0, 3);
    assert!(journal::cursor_vault_id(&cursor) == vault_id, 4);

    ts::return_shared(cursor);
    transfer::public_transfer(cap, KEEPER);
    scenario.end();
}

// ── @invariant 2: the blob id is opaque and verbatim ───────────────────────

#[test]
fun record_emits_the_blob_id_verbatim() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, POOL_ADDR);
    let cap = mint_keeper_cap(&mut scenario, vault_id);
    let cursor_id = open_cursor(&mut scenario, vault_id, &cap);

    scenario.next_tx(KEEPER);
    let v = borrow(&scenario, vault_id);
    let mut cursor = take_cursor(&scenario, cursor_id);

    journal::record(&v, &mut cursor, &cap, BLOB_A, 1, scenario.ctx());

    let events = event::events_by_type<journal::DecisionRecorded>();
    assert!(events.length() == 1, 0);
    let (emitted_vault, seq, blob) = journal::decision_recorded_fields(events.borrow(0));

    assert!(emitted_vault == vault_id, 1);
    assert!(seq == 1, 2);
    // Byte-for-byte, no truncation, no parsing. The blob id is content-derived and therefore
    // self-certifying; interpreting it would be the module claiming to know what it commits to.
    assert!(blob == BLOB_A, 3);
    assert!(blob.length() == 32, 4);

    ts::return_shared(cursor);
    ts::return_shared(v);
    transfer::public_transfer(cap, KEEPER);
    scenario.end();
}

#[test]
fun an_empty_blob_id_is_still_opaque_and_emitted() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, POOL_ADDR);
    let cap = mint_keeper_cap(&mut scenario, vault_id);
    let cursor_id = open_cursor(&mut scenario, vault_id, &cap);

    scenario.next_tx(KEEPER);
    let v = borrow(&scenario, vault_id);
    let mut cursor = take_cursor(&scenario, cursor_id);

    // The module does NOT validate blob ids (@forbidden: interpreting blob_id contents).
    // Availability is the envelope's concern (`envelope::assert_strategy_available`), which is
    // where an empty id IS rejected — the split is deliberate.
    journal::record(&v, &mut cursor, &cap, vector[], 1, scenario.ctx());

    let events = event::events_by_type<journal::DecisionRecorded>();
    let (_, _, blob) = journal::decision_recorded_fields(events.borrow(0));
    assert!(blob.is_empty(), 0);
    assert!(journal::cursor_last_seq(&cursor) == 1, 1);

    ts::return_shared(cursor);
    ts::return_shared(v);
    transfer::public_transfer(cap, KEEPER);
    scenario.end();
}

// ── @invariant 3: strictly increasing seq, per vault (G5) ──────────────────

#[test]
fun record_advances_the_cursor_and_allows_gaps() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, POOL_ADDR);
    let cap = mint_keeper_cap(&mut scenario, vault_id);
    let cursor_id = open_cursor(&mut scenario, vault_id, &cap);

    scenario.next_tx(KEEPER);
    let v = borrow(&scenario, vault_id);
    let mut cursor = take_cursor(&scenario, cursor_id);

    journal::record(&v, &mut cursor, &cap, BLOB_A, 1, scenario.ctx());
    assert!(journal::cursor_last_seq(&cursor) == 1, 0);

    // A GAP is legal: the ordering guarantee is "strictly increasing", not "contiguous". The
    // keeper may drop a segment (nothing to record in a cycle) without wedging the log.
    journal::record(&v, &mut cursor, &cap, BLOB_B, 9, scenario.ctx());
    assert!(journal::cursor_last_seq(&cursor) == 9, 1);

    let events = event::events_by_type<journal::DecisionRecorded>();
    assert!(events.length() == 2, 2);
    let (_, seq_a, blob_a) = journal::decision_recorded_fields(events.borrow(0));
    let (_, seq_b, blob_b) = journal::decision_recorded_fields(events.borrow(1));
    assert!(seq_a == 1 && blob_a == BLOB_A, 3);
    assert!(seq_b == 9 && blob_b == BLOB_B, 4);
    // Distinct records, distinct commitments — the second did not overwrite the first.
    assert!(blob_a != blob_b, 5);

    ts::return_shared(cursor);
    ts::return_shared(v);
    transfer::public_transfer(cap, KEEPER);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = journal::EStaleSeq)]
fun a_replayed_seq_aborts() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, POOL_ADDR);
    let cap = mint_keeper_cap(&mut scenario, vault_id);
    let cursor_id = open_cursor(&mut scenario, vault_id, &cap);

    scenario.next_tx(KEEPER);
    let v = borrow(&scenario, vault_id);
    let mut cursor = take_cursor(&scenario, cursor_id);

    journal::record(&v, &mut cursor, &cap, BLOB_A, 5, scenario.ctx());
    // Same seq, DIFFERENT blob: this is exactly the substitution the ordering gate exists to
    // stop — it would give `keeper/src/verify/` two candidate records for one position.
    journal::record(&v, &mut cursor, &cap, BLOB_B, 5, scenario.ctx());

    abort 0
}

#[test]
#[expected_failure(abort_code = journal::EStaleSeq)]
fun a_reordered_seq_aborts() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, POOL_ADDR);
    let cap = mint_keeper_cap(&mut scenario, vault_id);
    let cursor_id = open_cursor(&mut scenario, vault_id, &cap);

    scenario.next_tx(KEEPER);
    let v = borrow(&scenario, vault_id);
    let mut cursor = take_cursor(&scenario, cursor_id);

    journal::record(&v, &mut cursor, &cap, BLOB_A, 5, scenario.ctx());
    journal::record(&v, &mut cursor, &cap, BLOB_B, 4, scenario.ctx());

    abort 0
}

// ── @invariant 4: a cursor is bound to one vault forever ──────────────────

#[test]
#[expected_failure(abort_code = journal::ECursorVaultMismatch)]
fun a_foreign_cursor_cannot_reset_the_ordering() {
    let mut scenario = ts::begin(OWNER);
    let vault_id = create(&mut scenario, POOL_ADDR);
    let cap = mint_keeper_cap(&mut scenario, vault_id);
    let cursor_id = open_cursor(&mut scenario, vault_id, &cap);

    scenario.next_tx(KEEPER);
    let v = borrow(&scenario, vault_id);
    let mut cursor = take_cursor(&scenario, cursor_id);
    journal::record(&v, &mut cursor, &cap, BLOB_A, 100, scenario.ctx());
    assert!(journal::cursor_last_seq(&cursor) == 100, 0);

    // A pristine cursor bound to some OTHER vault would otherwise let seq 1 be recorded again
    // against this vault, forking the replay order.
    let mut foreign = journal::new_cursor_for_testing(
        object::id_from_address(@0xF0E1),
        scenario.ctx(),
    );
    journal::record(&v, &mut foreign, &cap, BLOB_B, 1, scenario.ctx());

    abort 0
}
