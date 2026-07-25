// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T4.3
// @phase      4  (post-cut-line)
// @status     DONE
// @spec       docs/KEEPER.md §9 (the replay engine), §1.2 (`verify --vault <ID> --from-epoch <N> [--limiter]`)
// @spec       docs/BUILD-PLAN.md#phase-4 (T4.3)
// @rules      G5 G7 G8
// @depends    ./limiter.ts (T4.3) · ./replay.ts (T4.3) · ../storage/walrus.ts (T2.9) ·
//             ../hashi/adapter.ts (T0.5) · ../journal/schema.ts (T4.2)
// @facts      This is the CLI-facing orchestrator: fetch the on-chain `DecisionRecorded` pointers →
// @facts        pull the Walrus segments → decode → replay → (optionally) re-derive the limiter and
// @facts        compare it against the journal's recorded readings.
// @facts      ★ Event source for the limiter replay is the adapter's event stream — the SAME
// @facts        interface the MOCK implements, so `verify` runs fully offline in CI (G7) and the A2
// @facts        cross-test compares the replay against the mock's own bucket.
// @facts        ⚠ ERRATUM vs this file's original note ("`adapter.signedEventsSince(cursor)`"):
// @facts        E-K3 makes that INSUFFICIENT. `WithdrawalSigned` carries no amount, so the replay
// @facts        also needs `WithdrawalRequested` (and `PickedForProcessing` as the fee-net fallback)
// @facts        to build the requestId→sats index, plus `WithdrawalCancelled` for the queue depth.
// @facts        We therefore page `adapter.eventsSince` filtered to {@link LIMITER_EVENT_KINDS}.
// @facts      ★ The SDK's `guardian.limiterStatus()` is NEVER an input (G5). It may be printed
// @facts        alongside the derivation as a sanity note, clearly labelled as an unverified hint.
// @facts      Exit code 0 iff zero mismatches (docs/KEEPER.md §13 A10).
// @facts      ⚠ TRANSPORT (RECON R1 / E-K5): historical event queries need `queryEvents`, which
// @facts        exists ONLY on `SuiJsonRpcClient` in @mysten/sui@2.22.1 — the gRPC v2 client exposes
// @facts        no historical event RPC. `defaultVerifySources.listSegments` therefore requires
// @facts        `SUI_TRANSPORT=jsonRpc` (a verified mirror) and says so in one explicit error rather
// @facts        than silently returning an empty pointer list (invariant 2).
// @implements export interface VerifyOptions / VerifyResult / VerifyDeps / VerifySources / SegmentPointer
// @implements export const LIMITER_EVENT_KINDS / defaultVerifySources
// @implements export async function deriveLimiterFromAdapter(hashi, cfg): Promise<LimiterTrajectory>
// @implements export async function verifyVault(deps: VerifyDeps, opts: VerifyOptions): Promise<VerifyResult>
// @implements export * from './limiter.js' | './replay.js'
// @forbidden  feeding LIVE inputs into the replay instead of the recorded ones
// @forbidden  a second copy of the limiter arithmetic — ./limiter.ts re-exports the ONE source (G5)
// @forbidden  constructing a Sui client here — ../sui/client.ts is the single site (gates.ps1 transport)
// @invariant  1. `verifyVault` performs I/O; all judgement lives in the PURE functions it calls.
// @invariant  2. A failed fetch is reported as such, never silently counted as "reproduced".
// @ac         docs/KEEPER.md §13 A10 — `verify --vault <ID> --from-epoch 0 --limiter` exits 0
// @verify     npm run test -- verify
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { Config } from '../config.js';
import type { HashiAdapter } from '../hashi/index.js';
import { EVENT_CURSOR_GENESIS, type HashiEvent, type HashiEventKind } from '../hashi/types.js';
import { decodeSegment, type DecisionSegment } from '../journal/schema.js';
import { get as walrusGet } from '../storage/walrus.js';
import type { StrategyParams } from '../strategy/params.js';
import { isGrpc, type AnySuiClient } from '../sui/client.js';
import type { ObjectId } from '../types.js';
import { AphoticError } from '../util/errors.js';

import { deriveLimiter, type DeriveConfig, type LimiterTrajectory } from './limiter.js';
import { replaySegment, type Mismatch, type ReplayOptions, type VerifyTier } from './replay.js';

export * from './limiter.js';
export * from './replay.js';

export interface VerifyDeps {
  readonly cfg: Config;
  readonly client: AnySuiClient;
  /** `mock` in CI, `real` against testnet — same interface either way (G7). */
  readonly hashi: HashiAdapter;
  /** Where segments come from. Defaults to {@link defaultVerifySources}. */
  readonly sources?: VerifySources;
}

/** An on-chain `DecisionRecorded` pointer: the anchored, content-derived Walrus blob id. */
export interface SegmentPointer {
  readonly seq: bigint;
  readonly blobId: string;
}

/**
 * The two I/O seams of `verifyVault`. Split out so the whole verification pass runs offline in CI
 * against the deterministic mock (G7) with the SAME judgement code that runs against testnet.
 */
export interface VerifySources {
  listSegments(deps: VerifyDeps, vaultId: ObjectId, fromSeq: bigint): Promise<readonly SegmentPointer[]>;
  fetchSegment(deps: VerifyDeps, pointer: SegmentPointer): Promise<DecisionSegment>;
}

export interface VerifyOptions {
  readonly vaultId: ObjectId;
  /** Replay from this journal segment sequence onward. */
  readonly fromSeq: bigint;
  /** `--limiter`: also re-derive the Guardian trajectory and diff it against the journal (G5). */
  readonly withLimiter?: boolean;
  /** Present ⇒ tier 2 (trigger correctness). Absent ⇒ tier 1 (routing only), no keys needed. */
  readonly params?: StrategyParams;
  /** Ruleset/venue contexts the pure replay needs. Both are config-derived, never literals (G7). */
  readonly replay: Pick<ReplayOptions, 'ruleset' | 'route' | 'fns' | 'unrecordedInputs'>;
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
  /** Segments that could not be fetched/decoded. NEVER counted as reproduced (invariant 2). */
  readonly failures: readonly SegmentFailure[];
}

export interface SegmentFailure {
  readonly seq: bigint;
  readonly blobId: string;
  readonly reason: string;
}

/**
 * Everything the trustless limiter replay needs (E-K3): `Signed` advances the bucket, `Requested`
 * supplies the amount, `PickedForProcessing` is the fee-net fallback, `Cancelled` clears the queue.
 */
export const LIMITER_EVENT_KINDS: readonly HashiEventKind[] = Object.freeze([
  'WithdrawalRequested',
  'WithdrawalPickedForProcessing',
  'WithdrawalSigned',
  'WithdrawalCancelled',
]);

/**
 * Page the adapter's event stream from genesis and re-derive the Guardian trajectory (G5).
 * `guardian.limiterStatus()` is deliberately NOT consulted — it is an unverified hint.
 */
export async function deriveLimiterFromAdapter(
  hashi: HashiAdapter,
  cfg: DeriveConfig,
): Promise<LimiterTrajectory> {
  const all: HashiEvent[] = [];
  let cursor = EVENT_CURSOR_GENESIS;

  for (;;) {
    const page = await hashi.eventsSince(cursor, { kinds: LIMITER_EVENT_KINDS, limit: 1_000 });
    if (page.events.length === 0) break;
    all.push(...page.events);
    if (page.next.seq <= cursor.seq) break; // cursor did not advance — stop rather than spin.
    cursor = page.next;
  }

  return deriveLimiter(all, cfg);
}

/**
 * Production I/O: on-chain `DecisionRecorded` pointers + Walrus blob fetch + canonical decode.
 *
 * ⚠ See the TRANSPORT @facts note: `queryEvents` is JSON-RPC-only in @mysten/sui@2.22.1.
 */
const DEFAULT_VERIFY_SOURCES: VerifySources = {
  async listSegments(deps, vaultId, fromSeq) {
    const client = deps.client;
    if (isGrpc(client)) {
      throw new AphoticError(
        'VerifyTransportUnsupported',
        'verify: historical `DecisionRecorded` queries need JSON-RPC — @mysten/sui@2.22.1 exposes ' +
          'no historical event RPC on SuiGrpcClient. Set SUI_TRANSPORT=jsonRpc (a verified mirror, ' +
          'RECON R1) or pass a custom VerifySources.',
      );
    }

    const type = `${deps.cfg.aphotic.packageId}::journal::DecisionRecorded`;
    const pointers: SegmentPointer[] = [];
    let cursor: { txDigest: string; eventSeq: string } | null | undefined;

    for (;;) {
      const page = await client.queryEvents({
        query: { MoveEventType: type },
        ...(cursor === undefined || cursor === null ? {} : { cursor }),
        order: 'ascending',
      });
      for (const event of page.data) {
        const fields = event.parsedJson as Record<string, unknown> | undefined;
        if (fields === undefined) continue;
        if (String(fields['vault_id'] ?? '') !== vaultId) continue;
        // u64 arrives as a decimal STRING over JSON-RPC — BigInt, never parseInt (E-K3).
        const seq = BigInt(String(fields['seq'] ?? '0'));
        if (seq < fromSeq) continue;
        pointers.push({ seq, blobId: decodeBlobId(fields['blob_id']) });
      }
      if (!page.hasNextPage || page.nextCursor === null || page.nextCursor === undefined) break;
      cursor = page.nextCursor;
    }

    return pointers.sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
  },

  async fetchSegment(deps, pointer) {
    return decodeSegment(await walrusGet(deps.cfg, pointer.blobId));
  },
};

export const defaultVerifySources: VerifySources = Object.freeze(DEFAULT_VERIFY_SOURCES);

/** `blob_id: vector<u8>` decodes as a number array over JSON-RPC; a string passes through. */
function decodeBlobId(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return new TextDecoder().decode(Uint8Array.from(raw as number[]));
  throw new AphoticError('VerifyBadBlobId', `verify: unreadable DecisionRecorded.blob_id (${typeof raw})`);
}

/**
 * Full verification pass: on-chain pointers → Walrus segments → replay → optional limiter
 * re-derivation. Exits 0 only when every decision reproduces (A3/A10).
 */
export async function verifyVault(deps: VerifyDeps, opts: VerifyOptions): Promise<VerifyResult> {
  const sources = deps.sources ?? defaultVerifySources;
  const tier: VerifyTier = opts.params === undefined ? 'routing' : 'trigger';

  const trajectory =
    opts.withLimiter === true
      ? await deriveLimiterFromAdapter(deps.hashi, { limiter: deps.cfg.limiter })
      : undefined;

  const pointers = await sources.listSegments(deps, opts.vaultId, opts.fromSeq);

  const mismatches: Mismatch[] = [];
  const failures: SegmentFailure[] = [];
  let ticks = 0;
  let segments = 0;

  for (const pointer of pointers) {
    let segment: DecisionSegment;
    try {
      segment = await sources.fetchSegment(deps, pointer);
    } catch (error) {
      // invariant 2: an unfetchable segment is a FAILURE, never a silent pass.
      failures.push({
        seq: pointer.seq,
        blobId: pointer.blobId,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    segments++;
    const report = replaySegment(segment, {
      ...opts.replay,
      ...(opts.params === undefined ? {} : { params: opts.params }),
      ...(trajectory === undefined ? {} : { limiterTrajectory: trajectory }),
    });
    ticks += report.ticks;
    mismatches.push(...report.mismatches);
  }

  return {
    tier,
    segments,
    ticks,
    mismatches,
    ...(trajectory === undefined ? {} : { trajectory }),
    reproduced: mismatches.length === 0 && failures.length === 0,
    failures,
  };
}
