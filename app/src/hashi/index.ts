// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.4, T3.1, T3.2
// @phase      0
// @status     DONE
// @spec       docs/APP.md §1 (L29: the app binds the SAME adapter the keeper defines)
// @spec       docs/KEEPER.md#hashi-adapter (T0.5) · docs/APP.md §5 (DEMO_MODE)
// @rules      G5 G6 G7
// @depends    ../config.ts (T0.4) · ../fixtures (T0.4) · ./depositAddress.ts (T3.1)
//             ../lib/suiClient.ts (T0.4)
// @facts      Adapter surface (T0.5, keeper-defined — mirror it, do not re-invent):
// @facts        generateDepositAddress · view.{balance,depositStatus,withdrawalStatus} ·
// @facts        waitForDeposit · waitForWithdrawal · guardian.{limiterStatus,canWithdraw}
// @facts      DEPOSIT ADDRESS DERIVATION IS PURELY CLIENT-SIDE in BOTH modes.
// @facts        ./depositAddress.ts reads the MPC master key + guardian x-only key
// @facts        from the on-chain Hashi object and derives the P2TR locally, so
// @facts        `real` needs no server and no extra SDK surface (D6 resolved U4).
// @facts      ⚠ guardian.limiterStatus is an ADVISORY read in BOTH modes. The
// @facts        authoritative limiter is the keeper's replay of the on-chain
// @facts        WithdrawalSigned stream (G5). The Transparency screen must label
// @facts        every value from here as `source: 'sdk'`, never as truth.
// @facts      ⚠ The bridge's live bucket is ~100 BTC/day (refill 115_740 sats/s,
// @facts        cap 10_000_000_000 sats — DAY-ONE D4). Never render congestion copy.
// @implements export type AppHashiAdapter
//             export class LiveModeUnsupportedError
//             export function getHashiAdapter(): AppHashiAdapter
// @forbidden  importing '@mysten/hashi' outside ./depositAddress.ts — G7
// @forbidden  re-implementing projectCapacity in app/ — the keeper owns it — G5
// @forbidden  a canonical id literal here — G7
// @forbidden  silently faking a live read with fixture data — throw instead
// @invariant  1. DEMO_MODE=mock resolves entirely from fixtures: zero network.
//             2. The app and the keeper agree field-for-field on every shape.
//             3. `real` never returns invented data. What the browser cannot do
//                alone throws LiveModeUnsupportedError naming the keeper command.
// @ac         docs/APP.md §7 A11 — all three screens walk with zero signet/RPC.
// @verify     cd app && npx tsc --noEmit
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { config } from '../config';
import { getSuiClient } from '../lib/suiClient';
import {
  demoFixtures,
  depositFixtures,
  exitFixtures,
  warmDeposit,
  prestagedConfirmedExit,
} from '../fixtures';
import { deriveDepositAddress, readHashiDepositKeys } from './depositAddress';

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
 * Thrown by the `live` binding for anything a browser cannot honestly do on its
 * own — watching a ~70 min deposit or a ~2 h withdrawal to completion needs the
 * keeper's event watcher (G6). Better a named error the UI can render than
 * fixture data pretending to be live.
 */
export class LiveModeUnsupportedError extends Error {
  readonly keeperCommand: string;
  constructor(what: string, keeperCommand: string) {
    super(
      `${what} is not available from the browser in live mode. ` +
        `Run the keeper instead: \`${keeperCommand}\`.`,
    );
    this.name = 'LiveModeUnsupportedError';
    this.keeperCommand = keeperCommand;
  }
}

// ── mock binding ────────────────────────────────────────────────────────────
// Resolves entirely from src/fixtures. No network, no clock, no randomness, so
// a demo renders identically every time (docs/APP.md §7 A11, G6).

function mockAdapter(): AppHashiAdapter {
  const depositFor = (requestId: string) =>
    depositFixtures.find((d) => d.requestId === requestId) ?? warmDeposit;
  const exitFor = (requestId: string) =>
    exitFixtures.find((e) => e.requestId === requestId) ?? prestagedConfirmedExit;

  // Exit fixtures carry a phase, not a stage index. 'A' is the instant Sui leg,
  // 'B' the Bitcoin leg, 'done' once the signet tx confirmed (G1/G6).
  const phaseToStage = (phase: 'A' | 'B' | 'done'): number =>
    phase === 'A' ? 1 : phase === 'B' ? 2 : 3;

  return {
    async generateDepositAddress({ suiAddress }) {
      const match = depositFixtures.find((d) => d.suiAddress === suiAddress);
      return (match ?? warmDeposit).depositAddress;
    },
    view: {
      async balance({ suiAddress }) {
        return depositFixtures
          .filter((d) => d.suiAddress === suiAddress && d.mintDigest !== undefined)
          .reduce((sum, d) => sum + d.amountSats, 0n);
      },
      async depositStatus({ requestId }) {
        const d = depositFor(requestId);
        return { stage: d.stage, confs: d.confs };
      },
      async withdrawalStatus({ requestId }) {
        const e = exitFor(requestId);
        return { stage: phaseToStage(e.phase), signetTxid: e.signetTxid };
      },
    },
    async waitForDeposit({ requestId }) {
      const d = depositFor(requestId);
      if (d.mintDigest === undefined) {
        // Honest: the fixture models a deposit still mid-flight. Do not invent
        // a digest — the caller must render the lifecycle, not a fake success.
        throw new Error(
          `deposit ${requestId} has not minted yet (stage ${d.stage}/6). ` +
            'The Bitcoin leg takes ~70 min end to end and is never live-demoable.',
        );
      }
      return { mintDigest: d.mintDigest };
    },
    async waitForWithdrawal({ requestId }) {
      const e = exitFor(requestId);
      if (e.signetTxid === undefined) {
        throw new Error(
          `withdrawal ${requestId} has not been broadcast yet (phase ${e.phase}). ` +
            'The Bitcoin leg takes ~1.5-2 h and is never live-demoable.',
        );
      }
      return { signetTxid: e.signetTxid };
    },
    guardian: {
      async limiterStatus() {
        const { capacitySats, queueDepth } = demoFixtures.bridge.sdkLimiter;
        return { capacitySats, queueDepth };
      },
      async canWithdraw({ amountSats }) {
        return amountSats <= demoFixtures.bridge.sdkLimiter.capacitySats;
      },
    },
  };
}

// ── live binding ────────────────────────────────────────────────────────────
// Only what the browser can genuinely do alone. Everything else throws a named
// error naming the keeper command that CAN do it (invariant 3).

function liveAdapter(): AppHashiAdapter {
  return {
    async generateDepositAddress({ suiAddress }) {
      // Fully client-side: reads the MPC + guardian keys off the Hashi shared
      // object, then derives the taproot address locally. No server (A1).
      const keys = await readHashiDepositKeys();
      return deriveDepositAddress(keys, suiAddress);
    },
    view: {
      async balance({ suiAddress }) {
        const client = getSuiClient();
        const { balance } = await client.core.getBalance({
          owner: suiAddress,
          coinType: config.hashi.hbtcType,
        });
        return BigInt(balance.balance);
      },
      async depositStatus() {
        throw new LiveModeUnsupportedError(
          'Deposit lifecycle tracking',
          'npm --prefix keeper run dev -- crank',
        );
      },
      async withdrawalStatus() {
        throw new LiveModeUnsupportedError(
          'Withdrawal lifecycle tracking',
          'npm --prefix keeper run dev -- exit --track',
        );
      },
    },
    async waitForDeposit() {
      throw new LiveModeUnsupportedError(
        'Waiting for a deposit to mint (~70 min)',
        'npm --prefix keeper run dev -- crank',
      );
    },
    async waitForWithdrawal() {
      throw new LiveModeUnsupportedError(
        'Waiting for a withdrawal to broadcast (~1.5-2 h)',
        'npm --prefix keeper run dev -- exit --track',
      );
    },
    guardian: {
      async limiterStatus() {
        // The guardian endpoint is gRPC/HTTP-2 only and not reachable from a
        // browser (DAY-ONE D4). This is advisory data anyway (G5) — the
        // authoritative value comes from the keeper's event replay.
        throw new LiveModeUnsupportedError(
          'Guardian limiter status',
          'npm --prefix keeper run dev -- verify --vault <ID>',
        );
      },
      async canWithdraw() {
        throw new LiveModeUnsupportedError(
          'Guardian pre-flight check',
          'npm --prefix keeper run dev -- verify --vault <ID>',
        );
      },
    },
  };
}

let cached: AppHashiAdapter | null = null;

/**
 * Binds the app to the keeper's adapter shape. `mock` resolves entirely from
 * src/fixtures so all three screens walk with zero signet and zero RPC (A11).
 */
export function getHashiAdapter(): AppHashiAdapter {
  if (cached === null) {
    cached = config.demoMode === 'live' ? liveAdapter() : mockAdapter();
  }
  return cached;
}

/** Test hook — drops the memoised binding so DEMO_MODE can be flipped. */
export function resetHashiAdapter(): void {
  cached = null;
}
