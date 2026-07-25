// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.1
// @phase      2  [CUT-LINE CRITICAL]
// @status     STUB
// @spec       docs/KEEPER.md §2.3 (REAL implementation)
// @spec       docs/BUILD-PLAN.md#phase-2 (T2.1)
// @spec       docs/RECON.md#r12 (@mysten/hashi 0.6.0), #r5 (ids), #r6 (live config), #r8 (events)
// @rules      G2 G3 G5 G6 G7
// @depends    ./adapter.ts (T0.5) · ./normalize.ts (T0.5) · ./eventTypes.ts (T0.5) ·
//             ../sui/client.ts (T0.3) · ../config.ts (T0.6)
// @facts      ★ THIS IS THE ONLY FILE IN THE REPO ALLOWED TO IMPORT '@mysten/hashi' (G7).
// @facts      SDK v0.6.0, ESM-only, peer @mysten/sui ^2.22.1. Wiring: `client.$extend(hashi())`.
// @facts      Verified SDK surface (node_modules/@mysten/hashi 0.6.0):
// @facts        HashiClient · hashi() · generateDepositAddress · fetchGuardianInfo ·
// @facts        projectCapacity(config, state, timestampSecs) · estimateWaitSecs ·
// @facts        bitcoinAddressToWitnessProgram · witnessProgramToAddress · deriveChildPubkey
// @facts      ⚠ Do NOT use the SDK's `projectCapacity` — the canonical one is ./limiter.ts, which
// @facts        adds u64 SATURATION so it matches the Rust enclave at the extremes (G5).
// @facts      ⚠ guardian.* is an UNVERIFIED HINT. The authoritative bucket is the event replay.
// @facts      ⚠ `guardian_url` (https://guardian.testnet.hashi.sui.io) is gRPC-only; plain HTTP
// @facts        returns 464 (docs/RECON.md R6).
// @facts      HASHI_PACKAGE_ID / HASHI_OBJECT_ID come from Config — never hardcode (G7).
// @facts      Event reads: filter by MoveEventType using ./eventTypes.ts, normalize via
// @facts        ./normalize.ts (which performs the request_ids -> sats join for WithdrawalSigned).
// @facts      Latencies (G6): deposit ~70 min, withdraw ~1.5–2 h ⇒ generous waitFor* timeouts.
// @implements export function createRealHashiAdapter(cfg: Config, deps?: RealHashiDeps): HashiAdapter
// @forbidden  giving the keeper any capability beyond DeepBook TradeCap (G2)
// @forbidden  wiring requestWithdrawal/cancelWithdrawal into the vault exit path — the production
//             exit is Move `gateway::exit_to_bitcoin` to the PINNED address (G2)
// @forbidden  sourcing limiter state from guardian.* for anything but a sanity hint (G5)
// @invariant  1. Every method either works against live testnet or throws NotImplementedError.
// @invariant  2. Behavioural parity with hashi/mock.ts is contract-tested (T2.1 VERIFY).
// @ac         docs/BUILD-PLAN.md T2.1 — same interface, swappable for the mock
// @verify     npm run test -- hashi.real
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { Signer } from '@mysten/sui/cryptography';

import type { Config } from '../config.js';
import type { SuiAddress } from '../types.js';
import { NotImplementedError } from '../util/errors.js';

import type {
  BridgeConfig,
  DepositArgs,
  EventsSinceOptions,
  HashiAdapter,
  HashiGuardianViews,
  HashiViews,
  RequestWithdrawalArgs,
  WaitOptions,
} from './adapter.js';
import type {
  DepositAddress,
  DepositView,
  EventCursor,
  HashiEvent,
  HashiEventOf,
  LimiterStatus,
  Sats,
  WithdrawalView,
} from './types.js';

/** Injected so T2.1 can unit-test without a live node. */
export interface RealHashiDeps {
  /** Result of `createSuiClient(cfg)` — never construct a client in here (G7). */
  readonly client?: unknown;
}

const TASK = 'T2.1';

function todo(what: string): never {
  throw new NotImplementedError(`hashi/real.ts ${what}`, TASK);
}

/**
 * REAL adapter over `@mysten/hashi` 0.6.0 + on-chain event reads.
 *
 * Selected by `HASHI_ADAPTER=real`. Every method is a stub in this pass — the entire system
 * runs on hashi/mock.ts until T2.1 (G7: the demo never blocks on a fresh endpoint).
 */
export function createRealHashiAdapter(cfg: Config, _deps: RealHashiDeps = {}): HashiAdapter {
  /** Every stub reports the exact bridge deployment it is pinned to (all ids come from Config, G7). */
  const at = (what: string): string => `${what} [Hashi ${cfg.hashi.packageId} @ ${cfg.hashi.objectId}]`;

  const view: HashiViews = {
    // TODO(T2.1): SDK `view.balance` / coin balance of cfg.hashi.hbtcCoinType.
    async balance(_suiAddress: SuiAddress): Promise<Sats> {
      return todo('view.balance');
    },
    // TODO(T2.1): SDK `view.depositStatus`.
    async depositStatus(_requestId: string): Promise<DepositView> {
      return todo('view.depositStatus');
    },
    // TODO(T2.1): SDK `view.withdrawalStatus`.
    async withdrawalStatus(_requestId: string): Promise<WithdrawalView> {
      return todo('view.withdrawalStatus');
    },
    // TODO(T2.1): SDK `view.all`.
    async all(
      _suiAddress: SuiAddress,
    ): Promise<{ deposits: readonly DepositView[]; withdrawals: readonly WithdrawalView[] }> {
      return todo('view.all');
    },
  };

  const guardian: HashiGuardianViews = {
    // TODO(T2.1): fetchGuardianInfo(cfg.hashi.guardianUrl) -> LimiterStatus with source:'sdk-hint'.
    //             ⚠ HINT ONLY — the authority is verify.deriveLimiter over WithdrawalSigned (G5).
    async limiterStatus(): Promise<LimiterStatus> {
      return todo('guardian.limiterStatus');
    },
    // TODO(T2.1): sats >= cfg.hashi.withdrawalMinimumSats && replayed capacity >= sats.
    //             `false` never means "you have a slot" — you cannot buy queue priority (G3).
    async canWithdraw(_sats: Sats): Promise<boolean> {
      return todo('guardian.canWithdraw');
    },
  };

  return {
    kind: 'real',
    view,
    guardian,

    // TODO(T2.1): read the live `Hashi` shared object (cfg.hashi.objectId) and return its config.
    async bridgeConfig(): Promise<BridgeConfig> {
      return todo(at('bridgeConfig'));
    },

    // TODO(T2.1): SDK `generateDepositAddress({ suiAddress })` — CLIENT-SIDE P2TR, no server.
    async generateDepositAddress(_suiAddress: SuiAddress): Promise<DepositAddress> {
      return todo('generateDepositAddress');
    },

    // TODO(T2.1): SDK `deposit({ signer, txid, utxos, recipient })`.
    async deposit(_args: DepositArgs): Promise<{ requestId: string }> {
      return todo('deposit');
    },

    // TODO(T2.1): build + sign the PERMISSIONLESS `confirm_deposit` entry PTB.
    //             Mints to the recipient in the UTXO derivation path — unredirectable (G2).
    async confirmDeposit(_requestId: string, _signer: Signer): Promise<{ digest: string }> {
      return todo('confirmDeposit');
    },

    // TODO(T2.1): SDK requestWithdrawal. ⚠ UX/mock surface ONLY — the vault exit is Move
    //             gateway::exit_to_bitcoin to the PINNED address (G2). Do not wire into `run`.
    async requestWithdrawal(_args: RequestWithdrawalArgs): Promise<{ requestId: string }> {
      return todo('requestWithdrawal');
    },

    // TODO(T2.1): SDK cancelWithdrawal. ⚠ sender-bound (RECON R7.3) — the KEEPER CAN NEVER CALL IT.
    async cancelWithdrawal(_requestId: string, _signer: Signer): Promise<{ sats: Sats }> {
      return todo('cancelWithdrawal');
    },

    // TODO(T2.1): poll depositStatus to terminal. Deposit ~70 min ⇒ NEVER on the demo path (G6).
    async waitForDeposit(_requestId: string, _opts?: WaitOptions): Promise<DepositView> {
      return todo('waitForDeposit');
    },

    // TODO(T2.1): poll withdrawalStatus to terminal. ~1.5–2 h ⇒ NEVER on the demo path (G6).
    async waitForWithdrawal(_requestId: string, _opts?: WaitOptions): Promise<WithdrawalView> {
      return todo('waitForWithdrawal');
    },

    // TODO(T2.1): queryEvents filtered by hashiEventTypeFilters(cfg), paginated, then
    //             normalizeEvents(cfg, raws, seq, ctx). This path is the G5 trust anchor —
    //             it must NOT use the SDK's convenience readers for limiter data.
    async eventsSince(
      _cursor: EventCursor,
      _opts?: EventsSinceOptions,
    ): Promise<{ events: readonly HashiEvent[]; next: EventCursor }> {
      return todo('eventsSince');
    },

    // TODO(T2.1): eventsSince filtered to WithdrawalSigned. Feeds verify.deriveLimiter (G5).
    async signedEventsSince(
      _cursor: EventCursor,
    ): Promise<{ events: readonly HashiEventOf<'WithdrawalSigned'>[]; next: EventCursor }> {
      return todo(at('signedEventsSince'));
    },
  } satisfies HashiAdapter & { kind: 'real' };
}

/** Re-exported for T2.1 so the implementer sees which config the adapter is pinned to. */
export type RealHashiConfig = Config['hashi'];
