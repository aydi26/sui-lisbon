// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.4, T3.1, T3.2
// @phase      0
// @status     STUB
// @spec       docs/APP.md §1 (L29: the app binds the SAME adapter the keeper defines)
// @spec       docs/KEEPER.md#hashi-adapter (T0.5) · docs/APP.md §5 (DEMO_MODE)
// @rules      G5 G6 G7
// @depends    ../config.ts (T0.4) · ../fixtures (T0.4)
//             keeper/src/hashi/adapter.ts (T0.5) · keeper/src/hashi/mock.ts (T0.5)
//             keeper/src/hashi/limiter.ts (T0.5)
// @facts      ⚠ @mysten/hashi 0.6.0 is NOT installed in app/ yet — it is a keeper
// @facts        dependency (peer: @mysten/sui ^2.22.1). Add it here only when the
// @facts        `real` binding is actually implemented; `mock` needs no SDK.
// @facts      Adapter surface (T0.5, keeper-defined — mirror it, do not re-invent):
// @facts        generateDepositAddress · deposit · requestWithdrawal ·
// @facts        cancelWithdrawal · view.{balance,depositStatus,withdrawalStatus,all} ·
// @facts        waitForDeposit · waitForWithdrawal ·
// @facts        guardian.{limiterStatus,canWithdraw} · subscribeEvents
// @facts      projectCapacity(tokens, refillRate, cap, elapsedMs) — CANONICAL arg
// @facts        order (docs/KEEPER.md §2.4). ONE implementation shared by mock and
// @facts        verify/. Never fork it into the app. (G5)
// @facts      client.$extend(hashi()) auto-resolves network ids for the real path.
// @implements export type AppHashiAdapter
//             export function getHashiAdapter(): AppHashiAdapter
// @forbidden  importing '@mysten/hashi' outside the `real` binding — G7
// @forbidden  re-implementing projectCapacity in app/ — import the keeper's — G5
// @forbidden  a canonical id literal here — G7
// @invariant  1. DEMO_MODE=mock resolves to the deterministic mock: zero network.
// @invariant  2. The app and the keeper agree field-for-field on every shape.
// @ac         docs/APP.md §7 A11
// @verify     cd app && npx tsc --noEmit
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { config } from '../config';

/**
 * The subset of the keeper's Hashi adapter the app actually calls. Kept as a
 * named type so the eventual import from the keeper package is a one-line swap.
 */
export interface AppHashiAdapter {
  /** CLIENT-SIDE P2TR derivation — no server round-trip (docs/APP.md §7 A1). */
  generateDepositAddress(args: { suiAddress: string }): Promise<string>;
  view: {
    balance(args: { suiAddress: string }): Promise<bigint>;
    depositStatus(args: { requestId: string }): Promise<{ stage: number; confs: number }>;
    withdrawalStatus(args: { requestId: string }): Promise<{ stage: number; signetTxid?: string }>;
  };
  waitForDeposit(args: { requestId: string }): Promise<{ mintDigest: string }>;
  waitForWithdrawal(args: { requestId: string }): Promise<{ signetTxid: string }>;
  guardian: {
    /** ADVISORY read. NOT the source of truth — the replay is (G5). */
    limiterStatus(): Promise<{ capacitySats: bigint; queueDepth: number }>;
    canWithdraw(args: { amountSats: bigint }): Promise<boolean>;
  };
}

/**
 * Binds the app to the keeper's adapter. `mock` must resolve entirely from
 * src/fixtures so all three screens walk with zero signet and zero RPC (A11).
 */
export function getHashiAdapter(): AppHashiAdapter {
  // TODO(T3.1): mock binding — resolve every method from src/fixtures.
  // TODO(T3.2): real binding — client.$extend(hashi()) over lib/suiClient.ts.
  throw new Error(
    `TODO(T3.1): Hashi adapter binding not implemented (DEMO_MODE=${config.demoMode})`,
  );
}
