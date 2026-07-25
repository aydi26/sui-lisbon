// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.4
// @phase      0
// @status     DONE
// @spec       docs/APP.md §5 (fixture shapes, L233-L238)
// @spec       docs/APP.md §2.4, §3.4, §4.4 (per-screen state shapes)
// @spec       docs/RECON.md R8 (real Hashi event names), R9 (limiter algorithm)
// @rules      G1 G3 G5 G6 G8
// @depends    ../config.ts (T0.4)
// @facts      Fixture shapes MUST mirror the keeper's deterministic mock adapter
// @facts        (keeper/src/hashi/mock.ts, T0.5) so `mock` mode in the app and
// @facts        `HASHI_ADAPTER=mock` in the keeper agree field-for-field (G7).
// @facts      ⚠ REAL event names (RECON R8 — docs/FACTS.md#events is abbreviated):
// @facts        treasury:         Minted, Burned
// @facts        deposit:          DepositRequested, DepositApproved,
// @facts                          DepositConfirmed, ExpiredDepositDeleted
// @facts        withdrawal_queue: WithdrawalRequested, WithdrawalApproved,
// @facts                          WithdrawalPickedForProcessing,
// @facts                          WithdrawalInputsSigned, WithdrawalSigned,
// @facts                          WithdrawalPresigsReassigned,
// @facts                          WithdrawalConfirmed, WithdrawalCancelled
// @facts      ⚠ WithdrawalSigned carries NO amount and NO timestamp. For the G5
// @facts        replay: sats = Σ WithdrawalRequested.btc_amount over request_ids;
// @facts        timestamp = the Sui event envelope timestampMs. (RECON R8)
// @facts      ⚠ Limiter time base is UNIX SECONDS (refill_rate = sats/second).
// @facts        Sui Clock is ms → divide by 1000 at the boundary. (RECON R9)
// @implements export type DepositStage / DepositFixture
//             export type ExitPhase / ExitFixture
//             export type HashiEventName / HashiEvent
//             export type LimiterReading / LimiterTrajectoryPoint / BridgeFixture
//             export type DecisionRecord / StrategyBlobFixture
// @forbidden  `number` for any sats-valued field — bigint only
// @forbidden  a real canonical on-chain id in fixture DATA — G7. Fixture ids are
//             produced by ./synthetic.ts and are obviously non-real.
// @invariant  1. Every sats field is bigint.
// @invariant  2. No fixture ever implies a purchasable queue position (G3).
// @ac         docs/APP.md §7 A2 A5 A7
// @verify     cd app && npx tsc --noEmit
// └── END CONTRACT ───────────────────────────────────────────────────────────

/** Six-stage deposit lifecycle — docs/APP.md §2.2. Stages 1-4 are Bitcoin-slow. */
export type DepositStage = 1 | 2 | 3 | 4 | 5 | 6;

/** Which leg a lifecycle stage belongs to. Drives the colour token (G1/G6). */
export type TimeClass = 'bitcoin' | 'delay' | 'sui';

export interface LifecycleStage {
  readonly index: number;
  readonly label: string;
  /** The on-chain / mempool signal that advances this stage. */
  readonly signal: string;
  readonly timeClass: TimeClass;
  /** Human wall-clock expectation. NEVER present the total as fast (G6). */
  readonly expected: string;
}

export interface DepositFixture {
  readonly suiAddress: string;
  /** bech32m P2TR, derived CLIENT-SIDE by @mysten/hashi (no server). */
  readonly depositAddress: string;
  readonly stage: DepositStage;
  readonly confs: number;
  readonly requestId: string;
  readonly amountSats: bigint;
  /** Present once treasury::Minted has fired (stage 5). */
  readonly mintDigest?: string;
  /** Present once the sponsored sweep landed (stage 6). */
  readonly sweepDigest?: string;
}

/** Phase A = instant on Sui. Phase B = Bitcoin, ~1.5-2 h, NEVER live (G6). */
export type ExitPhase = 'A' | 'B' | 'done';

export interface ExitFixture {
  readonly requestId: string;
  readonly amountSats: bigint;
  /** Sui digest of the burn + composed request_withdrawal PTB (phase A). */
  readonly burnDigest: string;
  /** The address PINNED on-chain at deposit. Never user-supplied (G2). */
  readonly pinnedAddressHex: string;
  readonly pinnedAddressBech32: string;
  readonly pinnedAddressKind: 'P2WPKH' | 'P2TR';
  readonly phase: ExitPhase;
  /** Bitcoin txid (64 hex, no 0x). Pre-staged and already confirmed (G6). */
  readonly signetTxid?: string;
}

export type HashiEventName =
  | 'treasury::Minted'
  | 'treasury::Burned'
  | 'deposit::DepositRequested'
  | 'deposit::DepositApproved'
  | 'deposit::DepositConfirmed'
  | 'deposit::ExpiredDepositDeleted'
  | 'withdrawal_queue::WithdrawalRequested'
  | 'withdrawal_queue::WithdrawalApproved'
  | 'withdrawal_queue::WithdrawalPickedForProcessing'
  | 'withdrawal_queue::WithdrawalInputsSigned'
  | 'withdrawal_queue::WithdrawalSigned'
  | 'withdrawal_queue::WithdrawalPresigsReassigned'
  | 'withdrawal_queue::WithdrawalConfirmed'
  | 'withdrawal_queue::WithdrawalCancelled';

export interface HashiEvent {
  readonly name: HashiEventName;
  /** Sui event ENVELOPE timestamp. WithdrawalSigned has no timestamp field. */
  readonly timestampMs: number;
  readonly requestIds: readonly string[];
  /** Σ of the referenced WithdrawalRequested.btc_amount, when derivable. */
  readonly satsAmount?: bigint;
}

/** A token-bucket observation. `source` says whether it is trusted or derived. */
export interface LimiterReading {
  readonly capacitySats: bigint;
  readonly refillRatePerSec: bigint;
  readonly maxBucketSats: bigint;
  readonly queueDepth: number;
  /** 'sdk' = advisory read. 'replay' = re-derived from on-chain events (G5). */
  readonly source: 'sdk' | 'replay';
}

export interface LimiterTrajectoryPoint {
  /** UNIX SECONDS — the limiter's native time base (RECON R9). */
  readonly tsSec: number;
  readonly tokensBeforeSats: bigint;
  readonly consumedSats: bigint;
  readonly tokensAfterSats: bigint;
  /** true ⇒ the batch was REJECTED (RateLimitExceeded), never queued (G3). */
  readonly rejected: boolean;
}

export interface BridgeFixture {
  readonly events: readonly HashiEvent[];
  /** Advisory SDK read — explicitly labelled as such in the UI (G5). */
  readonly sdkLimiter: LimiterReading;
  /** What keeper verify/ must reproduce from `events` alone. */
  readonly expectedReplay: LimiterReading;
  readonly trajectory: readonly LimiterTrajectoryPoint[];
  /** Genesis scalars — the ONLY two trust anchors (G5). U1 is a BOUND, not a fact. */
  readonly genesisScalars: {
    readonly refillRatePerSec: bigint;
    readonly maxBucketSats: bigint;
    readonly provenance: string;
  };
}

/** A keeper decision record as published to Walrus — docs/KEEPER.md#journal. */
export interface DecisionRecord {
  readonly seq: number;
  readonly timestampMs: number;
  /** Pyth BETA BTC/USD, 8-dec fixed point. Advisory only — NAV uses book mid. */
  readonly oracleUsd8: bigint;
  /** DeepBook mid, 8-dec fixed point. THIS is what NAV is valued at (G9). */
  readonly bookMidUsd8: bigint;
  readonly l2SnapshotRef: string;
  readonly strategyBlobId: string;
  readonly rulesetHash: string;
  readonly decision: string;
  readonly resultDigest: string;
  /** Bridge-aware inputs — the differentiator (G5). */
  readonly hashi: {
    readonly limiterCapacitySats: bigint;
    readonly queueDepth: number;
    readonly pendingMintSats: bigint;
    readonly redemptionBufferSats: bigint;
  };
}

export interface StrategyBlobFixture {
  readonly blobId: string;
  /** Seal identity is namespaced to vault object + version epoch. */
  readonly versionEpoch: number;
  /** Hex preview of the CIPHERTEXT — unreadable by construction. */
  readonly ciphertextPreview: string;
  readonly sizeBytes: number;
}

/** What the whole app renders from in DEMO_MODE=mock. */
export interface DemoFixtures {
  readonly deposits: readonly DepositFixture[];
  readonly exits: readonly ExitFixture[];
  readonly bridge: BridgeFixture;
  readonly decisions: readonly DecisionRecord[];
  readonly strategy: StrategyBlobFixture;
  /** true ⇒ <StaleBanner/> renders (Pyth staleness / divergence breaker, G9). */
  readonly breakerTripped: boolean;
}
