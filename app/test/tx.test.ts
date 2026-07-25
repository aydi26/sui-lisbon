// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T3.4
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/APP.md §7 A4 (a Move abort renders as human text)
// @rules      G2 G7 G8
// @depends    ../src/lib/tx.ts (T3.4)
// @facts      The abort tables mirror the `const E…: u64 = n;` blocks in
// @facts        move/sources/{vault,gateway,envelope,router,journal}.move. If a Move
// @facts        error constant is renumbered, one of these assertions fails — which
// @facts        is the entire point of pinning the numbers here.
// @facts      vault code 1 is VACANT (removed owner emergency withdraw) and must
// @facts        never acquire a meaning.
// @implements the A4 safety net for the shared send path
// @forbidden  a network call — this file is pure parsing
// @invariant  1. An unknown abort keeps the raw string; it is never explained away.
// @ac         cd app && npm test
// @verify     cd app && npm test
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import { APHOTIC_ABORTS, describeTxError, parseMoveAbort } from '../src/lib/tx';

const gatewayAbort = (code: number): string =>
  `MoveAbort(MoveLocation { module: ModuleId { address: 148a11915b86ebb79d0a98f81da666ba92edfc03ff0a3ef937a3441df66dee54, name: Identifier("gateway") }, function: 4, instruction: 27, function_name: Some("exit_to_bitcoin") }, ${code}) in command 2`;

describe('parseMoveAbort', () => {
  it('pulls module, function and code out of the full rendering', () => {
    const abort = parseMoveAbort(gatewayAbort(4));
    expect(abort).not.toBeNull();
    expect(abort?.module).toBe('gateway');
    expect(abort?.functionName).toBe('exit_to_bitcoin');
    expect(abort?.code).toBe(4n);
    expect(abort?.clever).toBe(false);
    expect(abort?.constantName).toBe('EBelowHashiMinimum');
  });

  it('maps the write-once pinning abort to G2 copy', () => {
    const abort = parseMoveAbort(gatewayAbort(2));
    expect(abort?.constantName).toBe('EExitAddressAlreadySet');
    expect(abort?.explanation).toMatch(/immutable/i);
  });

  it('reads the short `module: 0x…::vault` rendering', () => {
    const abort = parseMoveAbort(
      'MoveAbort(MoveLocation { module: 0x148a11::vault, function: 7, instruction: 3 }, 10) in command 0',
    );
    expect(abort?.module).toBe('vault');
    expect(abort?.constantName).toBe('EUnregisteredDepositor');
  });

  it('reads the terse `abort code: n` rendering', () => {
    const abort = parseMoveAbort('Transaction failed: ... abort code: 6');
    expect(abort?.code).toBe(6n);
    expect(abort?.module).toBeNull();
    // No module ⇒ no meaning may be assigned: code 6 differs per module.
    expect(abort?.explanation).toBeNull();
  });

  it('never gives vault abort 1 a meaning (the slot is vacant)', () => {
    const abort = parseMoveAbort(
      'MoveAbort(MoveLocation { module: 0x148a11::vault, function: 1, instruction: 1 }, 1)',
    );
    expect(abort?.code).toBe(1n);
    expect(abort?.constantName).toBeNull();
    expect(APHOTIC_ABORTS.vault[1]).toBeUndefined();
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

  it('returns null for a non-abort string', () => {
    expect(parseMoveAbort('Failed to fetch')).toBeNull();
  });
});

describe('describeTxError', () => {
  it('classifies a Move abort and renders human text', () => {
    const failure = describeTxError(new Error(gatewayAbort(3)));
    expect(failure.kind).toBe('move-abort');
    expect(failure.message).toMatch(/register one before exiting/i);
    expect(failure.abort?.constantName).toBe('EExitAddressUnset');
  });

  it('classifies a user rejection', () => {
    const failure = describeTxError(new Error('User rejected the request.'));
    expect(failure.kind).toBe('user-rejected');
    expect(failure.message).toMatch(/nothing was sent/i);
  });

  it('classifies a transport failure', () => {
    const failure = describeTxError(new Error('Failed to fetch'));
    expect(failure.kind).toBe('network');
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
    const inner = new Error(gatewayAbort(1));
    const outer = new Error('Wallet execution failed', { cause: inner });
    const failure = describeTxError(outer);
    expect(failure.kind).toBe('move-abort');
    expect(failure.abort?.constantName).toBe('EBadAddressLength');
  });
});
