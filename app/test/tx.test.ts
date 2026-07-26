// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F1
// @phase      0
// @status     DONE
// @spec       aphotic.md §9 (fail-soft) · docs/RECON.md R7 (Hashi #[error] strings)
// @rules      G7 G8
// @depends    ../src/lib/tx.ts (F1)
// @facts      APHOTIC_ABORTS IS EMPTY ON PURPOSE while the v2 Move package is being
// @facts        written. Every entry in the v1 table is now a WRONG ANSWER, and a
// @facts        confidently wrong explanation of a failed transaction is worse than
// @facts        a raw string. These cases pin that behaviour so the table cannot be
// @facts        "helpfully" repopulated with guesses: an unmapped code degrades to
// @facts        the raw text, never to an invented meaning.
// @facts      Hashi's own constants are `#[error]` BYTE-STRINGS, so its abort codes
// @facts        are CLEVER (high bit set) and encode a constant index plus a line
// @facts        number — NOT a value we may interpret. We recognise them only by
// @facts        the byte-string when the node echoes it.
// @implements the abort-parser safety net
// @forbidden  asserting a constant name that no shipped Move source defines
// @invariant  1. A clever code never receives a guessed meaning.
// @invariant  2. An unclassified error keeps its raw text.
// @ac         parses both renderings; classifies rejection/gas/network.
// @verify     cd app && npm test -- tx
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import { APHOTIC_ABORTS, describeTxError, parseMoveAbort } from '../src/lib/tx';

const vaultAbort = (code: number): string =>
  `MoveAbort(MoveLocation { module: ModuleId { address: 148a11915b86ebb79d0a98f81da666ba92edfc03ff0a3ef937a3441df66dee54, name: Identifier("vault") }, function: 4, instruction: 27, function_name: Some("claim_deposit") }, ${code}) in command 2`;

describe('parseMoveAbort', () => {
  it('pulls module, function and code out of the full rendering', () => {
    const abort = parseMoveAbort(vaultAbort(4));
    expect(abort).not.toBeNull();
    expect(abort?.module).toBe('vault');
    expect(abort?.functionName).toBe('claim_deposit');
    expect(abort?.code).toBe(4n);
    expect(abort?.clever).toBe(false);
  });

  it('reads the short `module: 0x…::batch` rendering', () => {
    const abort = parseMoveAbort(
      'MoveAbort(MoveLocation { module: 0x148a11::batch, function: 7, instruction: 3 }, 10) in command 0',
    );
    expect(abort?.module).toBe('batch');
    expect(abort?.code).toBe(10n);
  });

  it('reads the terse `abort code: n` rendering and assigns it no meaning', () => {
    const abort = parseMoveAbort('Transaction failed: ... abort code: 6');
    expect(abort?.code).toBe(6n);
    expect(abort?.module).toBeNull();
    // No module ⇒ no meaning may be assigned: code 6 differs per module.
    expect(abort?.explanation).toBeNull();
  });

  it('assigns NO meaning to an Aphotic code while the table is empty', () => {
    // The v2 package is a rewrite. Until its error constants exist, a mapped
    // explanation would be a fabrication, so there are none.
    expect(Object.keys(APHOTIC_ABORTS)).toHaveLength(0);
    for (const code of [1, 2, 4, 10]) {
      const abort = parseMoveAbort(vaultAbort(code));
      expect(abort?.constantName).toBeNull();
      expect(abort?.explanation).toBeNull();
    }
  });

  it('flags a clever (#[error] byte-string) code instead of guessing', () => {
    const raw =
      'MoveAbort(MoveLocation { module: ModuleId { address: fcea10ca, name: Identifier("withdraw") }, function: 5, function_name: Some("cancel_withdrawal") }, 9223372105742876675) in command 2';
    const abort = parseMoveAbort(raw);
    expect(abort?.clever).toBe(true);
    expect(abort?.constantName).toBeNull();
    expect(abort?.explanation).toBeNull();
  });

  it('recognises an upstream Hashi error by its byte-string', () => {
    const raw =
      'MoveAbort(MoveLocation { module: ModuleId { address: fcea10ca, name: Identifier("withdraw") }, function: 5 }, 9223372105742876675): Only the original requester can cancel';
    const abort = parseMoveAbort(raw);
    expect(abort?.clever).toBe(true);
    expect(abort?.explanation).toMatch(/only the address that requested/i);
  });

  it('recognises the Hashi withdrawal minimum by its byte-string', () => {
    const raw =
      'MoveAbort(MoveLocation { module: 0xfcea10ca::withdraw, function: 3 }, 9223372105742876675): the amount is below the minimum';
    expect(parseMoveAbort(raw)?.explanation).toMatch(/30,000 sat minimum/i);
  });

  it('returns null for a non-abort string', () => {
    expect(parseMoveAbort('Failed to fetch')).toBeNull();
  });
});

describe('describeTxError', () => {
  it('classifies a Move abort and names where it came from', () => {
    const failure = describeTxError(new Error(vaultAbort(3)));
    expect(failure.kind).toBe('move-abort');
    expect(failure.message).toMatch(/vault::claim_deposit/);
    expect(failure.abort?.code).toBe(3n);
  });

  it('classifies a user rejection', () => {
    const failure = describeTxError(new Error('User rejected the request.'));
    expect(failure.kind).toBe('user-rejected');
    expect(failure.message).toMatch(/nothing was sent/i);
  });

  it('classifies a transport failure', () => {
    expect(describeTxError(new Error('Failed to fetch')).kind).toBe('network');
  });

  it('classifies a gas failure', () => {
    const failure = describeTxError(new Error('Insufficient gas: no valid gas coins found'));
    expect(failure.kind).toBe('insufficient-gas');
  });

  it('keeps the raw string for anything it cannot classify', () => {
    const failure = describeTxError(new Error('something entirely new'));
    expect(failure.kind).toBe('unknown');
    expect(failure.message).toBe('something entirely new');
    expect(failure.raw).toBe('something entirely new');
  });

  it('walks an error cause chain', () => {
    const inner = new Error(vaultAbort(1));
    const outer = new Error('Wallet execution failed', { cause: inner });
    const failure = describeTxError(outer);
    expect(failure.kind).toBe('move-abort');
    expect(failure.abort?.code).toBe(1n);
  });
});
