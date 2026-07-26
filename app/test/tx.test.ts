// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F1
// @phase      0
// @status     DONE
// @spec       aphotic.md §9 (fail-soft) · docs/RECON.md R7 (Hashi #[error] strings)
// @rules      G7 G8
// @depends    ../src/lib/tx.ts (F1)
// @facts      APHOTIC_ABORTS is now populated FROM THE v2 MODULES — every row was
// @facts        transcribed from a `const E…: u64 = n;` block, never inferred from a
// @facts        name. These cases pin both halves of the rule: a code the module
// @facts        really declares gets its constant and its sentence, and a code it
// @facts        does NOT declare (including the real gap at `clearing` code 1)
// @facts        degrades to the raw abort text rather than to an invented meaning.
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

  it('maps an Aphotic code to the constant that module actually declares', () => {
    // Transcribed from move/sources/vault.move's `const E…: u64 = n;` block.
    const abort = parseMoveAbort(vaultAbort(15));
    expect(abort?.constantName).toBe('ENotYetPriced');
    expect(abort?.explanation).toMatch(/has not been priced yet/i);
  });

  it('keys the table by MODULE, because code 2 means different things per module', () => {
    expect(parseMoveAbort(vaultAbort(2))?.constantName).toBe('EPaused');
    const batch = parseMoveAbort(
      'MoveAbort(MoveLocation { module: 0x148a11::batch, function: 7, instruction: 3 }, 2) in command 0',
    );
    expect(batch?.constantName).toBe('ETooEarly');
  });

  it('leaves clearing code 1 UNMAPPED, because clearing.move has no code 1', () => {
    // The gap in that module's constants is real. Filling it would be a guess.
    const abort = parseMoveAbort(
      'MoveAbort(MoveLocation { module: 0x148a11::clearing, function: 2, instruction: 1 }, 1) in command 0',
    );
    expect(abort?.constantName).toBeNull();
    expect(abort?.explanation).toBeNull();
  });

  it('degrades an unknown code to raw text rather than inventing a meaning', () => {
    const abort = parseMoveAbort(vaultAbort(9_999));
    expect(abort?.constantName).toBeNull();
    expect(abort?.explanation).toBeNull();
    expect(describeTxError(new Error(vaultAbort(9_999))).message).toMatch(/abort code 9999/);
  });

  it('declares no code a module does not', () => {
    // Every mapped code must be a positive integer, and every module we key must
    // be one of the ten v2 modules. A typo'd module name would silently never match.
    const modules = new Set([
      'vault',
      'batch',
      'clearing',
      'notes',
      'balance',
      'caps',
      'allocate',
      'carry',
      'oracle',
      'events',
    ]);
    for (const [moduleName, table] of Object.entries(APHOTIC_ABORTS)) {
      expect(modules.has(moduleName), `unknown module key "${moduleName}"`).toBe(true);
      for (const [code, entry] of Object.entries(table)) {
        expect(Number(code)).toBeGreaterThan(0);
        expect(entry.name.startsWith('E')).toBe(true);
        expect(entry.text.length).toBeGreaterThan(10);
      }
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
    // The discriminant is the ABORT CODE, not the address — so the module address
    // here is a placeholder on purpose. Pinning the real Hashi package id in a test
    // fixture would put a canonical id outside config.ts, which is what the `ids`
    // gate exists to prevent, and would buy nothing: the parser never reads it.
    const raw =
      'MoveAbort(MoveLocation { module: 0xHASHI::withdraw, function: 3 }, 9223372105742876675): the amount is below the minimum';
    expect(parseMoveAbort(raw)?.explanation).toMatch(/30,000 sat minimum/i);
  });

  it('returns null for a non-abort string', () => {
    expect(parseMoveAbort('Failed to fetch')).toBeNull();
  });
});

describe('describeTxError', () => {
  it('classifies a Move abort and explains a MAPPED code in words', () => {
    const failure = describeTxError(new Error(vaultAbort(3)));
    expect(failure.kind).toBe('move-abort');
    expect(failure.abort?.code).toBe(3n);
    expect(failure.abort?.constantName).toBe('EZeroAmount');
    expect(failure.message).toMatch(/amount is zero/i);
  });

  it('names where an UNMAPPED abort came from, since it cannot explain it', () => {
    const failure = describeTxError(new Error(vaultAbort(9_998)));
    expect(failure.kind).toBe('move-abort');
    expect(failure.message).toMatch(/vault::claim_deposit/);
    expect(failure.message).toMatch(/Raw:/);
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
