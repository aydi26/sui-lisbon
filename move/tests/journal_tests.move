#[test_only]
module aphotic::journal_tests;

use aphotic::journal;

// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T4.2
// @phase      4
// @status     STUB
// @spec       docs/MOVE-PACKAGE.md#8-per-module-test-checklist (L661-L663)
// @rules      G5
// @depends    aphotic::journal (T4.2) · aphotic::vault (T1.1)
// @facts      A Walrus blob id is opaque, content-derived and self-certifying — the module
// @facts        must emit it verbatim and never interpret it.
// @implements #[test] fun seq_must_strictly_increase()                        [DONE]
//             #[test] fun repeated_seq_is_stale()                             [DONE]
//             #[test] fun record_requires_a_current_keeper_cap()              [TODO(T4.2)]
//             #[test] fun record_emits_the_blob_id_verbatim()                 [TODO(T4.2)]
// @invariant  1. seq is the replay ordering the keeper verify engine depends on (G5).
// @ac         docs/MOVE-PACKAGE.md §8 journal_tests checklist (L661-L663)
// @verify     sui move test journal
// └── END CONTRACT ───────────────────────────────────────────────────────────

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

// TODO(T4.2): record aborts without a KeeperCap at the vault's CURRENT version_epoch
//             (a rotated-out cap must fail).
// TODO(T4.2): DecisionRecorded carries the blob id bytes VERBATIM — no truncation, no parsing.
// TODO(T4.2): a decision record's bridge fields (limiter reading, pending-mint total) plus
//             oracle/book/strategy_blob/ruleset/decision/result live off-chain in Walrus;
//             only the blob id is anchored here.
