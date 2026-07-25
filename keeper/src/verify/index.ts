// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T4.3
// @phase      4  (post-cut-line)
// @status     STUB
// @spec       docs/KEEPER.md §9 (the replay engine), §1.2 (`verify --vault <ID> --from-epoch <N> [--limiter]`)
// @spec       docs/BUILD-PLAN.md#phase-4 (T4.3)
// @rules      G5 G7 G8
// @depends    ./limiter.ts (T4.3) · ./replay.ts (T4.3) · ../storage/walrus.ts (T2.9) ·
//             ../hashi/adapter.ts (T0.5) · ../journal/schema.ts (T4.2)
// @facts      This is the CLI-facing orchestrator: fetch the on-chain `DecisionRecorded` pointers →
// @facts        pull the Walrus segments → decode → replay → (optionally) re-derive the limiter and
// @facts        compare it against the journal's recorded readings.
// @facts      ★ Event source for the limiter replay is `adapter.signedEventsSince(cursor)` — the SAME
// @facts        interface the MOCK implements, so `verify` runs fully offline in CI (G7) and the A2
// @facts        cross-test compares the replay against the mock's own bucket.
// @facts      ★ The SDK's `guardian.limiterStatus()` is NEVER an input (G5). It may be printed
// @facts        alongside the derivation as a sanity note, clearly labelled as an unverified hint.
// @facts      Exit code 0 iff zero mismatches (docs/KEEPER.md §13 A10).
// @implements export interface VerifyOptions / VerifyResult
// @implements export async function verifyVault(deps: VerifyDeps, opts: VerifyOptions): Promise<VerifyResult>
// @implements export * from './limiter.js' | './replay.js'
// @forbidden  feeding LIVE inputs into the replay instead of the recorded ones
// @forbidden  a second copy of the limiter arithmetic — ./limiter.ts re-exports the ONE source (G5)
// @invariant  1. `verifyVault` performs I/O; all judgement lives in the PURE functions it calls.
// @invariant  2. A failed fetch is reported as such, never silently counted as "reproduced".
// @ac         docs/KEEPER.md §13 A10 — `verify --vault <ID> --from-epoch 0 --limiter` exits 0
// @verify     npm run test -- verify
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { Config } from '../config.js';
import type { HashiAdapter } from '../hashi/index.js';
import type { StrategyParams } from '../strategy/params.js';
import type { AnySuiClient } from '../sui/client.js';
import type { ObjectId } from '../types.js';

import type { LimiterTrajectory } from './limiter.js';
import type { Mismatch, VerifyTier } from './replay.js';

export * from './limiter.js';
export * from './replay.js';

export interface VerifyDeps {
  readonly cfg: Config;
  readonly client: AnySuiClient;
  /** `mock` in CI, `real` against testnet — same interface either way (G7). */
  readonly hashi: HashiAdapter;
}

export interface VerifyOptions {
  readonly vaultId: ObjectId;
  /** Replay from this journal segment sequence onward. */
  readonly fromSeq: bigint;
  /** `--limiter`: also re-derive the Guardian trajectory and diff it against the journal (G5). */
  readonly withLimiter?: boolean;
  /** Present ⇒ tier 2 (trigger correctness). Absent ⇒ tier 1 (routing only), no keys needed. */
  readonly params?: StrategyParams;
}

export interface VerifyResult {
  readonly tier: VerifyTier;
  readonly segments: number;
  readonly ticks: number;
  readonly mismatches: readonly Mismatch[];
  /** Present when `--limiter` ran. */
  readonly trajectory?: LimiterTrajectory;
  /** True iff there are zero mismatches — the CLI exit code follows this. */
  readonly reproduced: boolean;
}

/**
 * Full verification pass: on-chain pointers → Walrus segments → replay → optional limiter
 * re-derivation. Exits 0 only when every decision reproduces (A3/A10).
 */
// TODO(T4.3): query DecisionRecorded events for vaultId from fromSeq; storage.get each blob id;
//             schema.decodeSegment; replaySegment; when withLimiter, deriveLimiter over
//             hashi.signedEventsSince(genesis) and compareLimiter against the recorded readings.
export async function verifyVault(
  _deps: VerifyDeps,
  _opts: VerifyOptions,
): Promise<VerifyResult> {
  throw new Error('TODO(T4.3): verifyVault not implemented');
}
