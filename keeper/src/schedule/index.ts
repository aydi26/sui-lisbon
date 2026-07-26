// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       P3.schedule
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       aphotic.md §7.3 ("06:00 and 18:00 UTC. Settle every pass, with or without pending
//             orders." · fixed cadence removes discretionary timing)
// @spec       aphotic.md §2.7 ("Timing is mechanical. An operator must never be able to choose
//             when a batch closes.")
// @spec       aphotic.md §9 ("Liveness is not privileged. If the keeper is down, anyone must be
//             able to trigger close_batch and settle_batch at or after the scheduled time.")
// @spec       move/sources/batch.move — `next_boundary`, `open_batch`, `close_batch`, the state ids
// @rules      G5 G10
// @depends    ../util/errors.ts  (nothing else — this module is a pure LEAF)
// @facts      CADENCE_MS = 43_200_000 (12 h) · OFFSET_MS = 21_600_000 (6 h)
// @facts        ⇒ boundaries land on 06:00 and 18:00 UTC daily (unix epoch day 0 begins 00:00 UTC).
// @facts      ★★ THE TWIN IS `batch.move::next_boundary`, NOT `sdk/src/cadence.ts`. They DIVERGE,
// @facts        deliberately, on exactly one input class and it must not be "fixed" silently:
// @facts          for now_ms < offset_ms (the first six hours of the unix epoch) batch.move
// @facts          returns `offset_ms` (06:00), while sdk/src/cadence.ts saturates `since` to 0 and
// @facts          returns `offset + cadence` (18:00), pinned as `epoch-zero-skips-the-first-boundary`.
// @facts        The keeper must predict what the CHAIN will do, so it follows batch.move.
// @facts        Unreachable after 1970-01-01 06:00 UTC; pinned by test/schedule.test.ts anyway,
// @facts        because a twin that agrees only on reachable inputs is not a twin.
// @facts      ★ A FULL BATCH DOES NOT CLOSE EARLY. Closing on fullness would hand a spammer the
// @facts        exact timing lever uniform-price clearing exists to remove. `isDue` therefore
// @facts        depends on the clock and on nothing else.
// @facts      ★ NOTHING IN THIS MODULE IS KEEPER-GATED. `dueActions` returns what ANYONE may send;
// @facts        the keeper is an optimisation, never a gatekeeper (aphotic.md §9). Every action it
// @facts        names is a permissionless Move entry point.
// @facts      Batch states (batch.move): 0 OPEN · 1 SEALED · 2 CLEARING · 3 SETTLED. Monotonic.
// @facts      SUBMIT_CUTOFF_MS = 60_000 · REVEAL_GRACE_MS = 600_000 (skew tolerance, DESIGN-V2 §3).
// @implements export const CADENCE_MS / OFFSET_MS / MS_PER_DAY
// @implements export const STATE_OPEN / STATE_SEALED / STATE_CLEARING / STATE_SETTLED
// @implements export const SUBMIT_CUTOFF_MS / REVEAL_GRACE_MS
// @implements export type BatchState / ScheduledAction
// @implements export interface CadenceParams / BatchSnapshot / DueAction
// @implements export function nextBoundary(nowMs, params?): bigint
// @implements export function previousBoundary(nowMs, params?): bigint
// @implements export function isBoundary(ms, params?): boolean
// @implements export function boundariesBetween(fromMs, toMs, params?): bigint[]
// @implements export function msUntilNextBoundary(nowMs, params?): bigint
// @implements export function submitWindowOpen(batch, nowMs): boolean
// @implements export function revealWindowOpen(batch, nowMs): boolean
// @implements export function dueActions(batch, nowMs, params?): DueAction[]
// @forbidden  an operator-supplied close timestamp — close_ms is DERIVED, always
// @forbidden  closing a batch early because it is full
// @forbidden  Date.now() — `nowMs` is ALWAYS an argument, so a schedule is replayable
// @forbidden  gating any returned action on holding a KeeperCap
// @invariant  1. nextBoundary(t) > t for every t >= offsetMs (STRICTLY next: standing exactly on
//                a boundary returns the FOLLOWING one).
// @invariant  2. With the defaults every result is 06:00:00.000 or 18:00:00.000 UTC.
// @invariant  3. Saturating: nextBoundary never throws and never wraps for any u64 input.
// @invariant  4. dueActions is monotone in the batch state — it never proposes a transition back
//                toward OPEN, because batch.move's `set_state` would abort.
// @invariant  5. `close` is never due before `close_ms`, and IS due at exactly `close_ms` (`>=`).
// @ac         test/schedule.test.ts, incl. the sdk/fixtures/cadence.golden.json cross-check
// @verify     npm run test -- schedule
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { AphoticError } from '../util/errors.js';

/** 12 hours. */
export const CADENCE_MS = 43_200_000n;
/** 6 hours — shifts the boundaries onto 06:00 / 18:00 UTC. */
export const OFFSET_MS = 21_600_000n;
export const MS_PER_DAY = 86_400_000n;

/** No submit lands within a minute of close, so a submit cannot race an early key release. */
export const SUBMIT_CUTOFF_MS = 60_000n;
/** 10 minutes of reveal window — orders of magnitude more than observed key-server skew. */
export const REVEAL_GRACE_MS = 600_000n;

export const STATE_OPEN = 0 as const;
export const STATE_SEALED = 1 as const;
export const STATE_CLEARING = 2 as const;
export const STATE_SETTLED = 3 as const;

export type BatchState =
  | typeof STATE_OPEN
  | typeof STATE_SEALED
  | typeof STATE_CLEARING
  | typeof STATE_SETTLED;

const U64_MAX = (1n << 64n) - 1n;

export interface CadenceParams {
  readonly cadenceMs: bigint;
  readonly offsetMs: bigint;
}

export const DEFAULT_CADENCE: CadenceParams = Object.freeze({
  cadenceMs: CADENCE_MS,
  offsetMs: OFFSET_MS,
});

/** Saturating u64 helpers — the twins of `oracle::saturating_*` that batch.move calls. */
function satSub(a: bigint, b: bigint): bigint {
  return a > b ? a - b : 0n;
}
function satAdd(a: bigint, b: bigint): bigint {
  const s = a + b;
  return s > U64_MAX ? U64_MAX : s;
}
function satMul(a: bigint, b: bigint): bigint {
  const p = a * b;
  return p > U64_MAX ? U64_MAX : p;
}

function assertParams(p: CadenceParams): CadenceParams {
  if (p.cadenceMs <= 0n) throw new AphoticError('EBadParam', 'cadenceMs must be > 0');
  if (p.cadenceMs > U64_MAX || p.offsetMs > U64_MAX || p.offsetMs < 0n) {
    throw new AphoticError('EBadParam', 'cadence parameters outside u64');
  }
  return p;
}

/**
 * The exact twin of `batch::next_boundary`: the next `offset + k·cadence` STRICTLY after `nowMs`.
 *
 * ⚠ Below `offsetMs` this returns `offsetMs`, which is what batch.move does and what
 * `sdk/src/cadence.ts` deliberately does NOT. See the @facts block — the divergence is pinned on
 * purpose, and the keeper follows the chain.
 */
export function nextBoundary(nowMs: bigint, params: CadenceParams = DEFAULT_CADENCE): bigint {
  const { cadenceMs, offsetMs } = assertParams(params);
  if (nowMs < 0n || nowMs > U64_MAX) throw new AphoticError('EBadParam', `nowMs outside u64: ${nowMs}`);
  if (nowMs < offsetMs) return offsetMs;
  const since = satSub(nowMs, offsetMs);
  const periods = since / cadenceMs;
  return satAdd(offsetMs, satMul(periods + 1n, cadenceMs));
}

/** The most recent boundary at or before `nowMs`. `0n` when `nowMs` precedes the first one. */
export function previousBoundary(nowMs: bigint, params: CadenceParams = DEFAULT_CADENCE): bigint {
  const { cadenceMs, offsetMs } = assertParams(params);
  if (nowMs < offsetMs) return 0n;
  const periods = (nowMs - offsetMs) / cadenceMs;
  return offsetMs + periods * cadenceMs;
}

/** True when `ms` sits exactly on a scheduled boundary. */
export function isBoundary(ms: bigint, params: CadenceParams = DEFAULT_CADENCE): boolean {
  const { cadenceMs, offsetMs } = assertParams(params);
  if (ms < offsetMs) return false;
  return (ms - offsetMs) % cadenceMs === 0n;
}

/** Every boundary in `(fromMs, toMs]` — used to backfill a schedule the keeper slept through. */
export function boundariesBetween(
  fromMs: bigint,
  toMs: bigint,
  params: CadenceParams = DEFAULT_CADENCE,
): bigint[] {
  const out: bigint[] = [];
  if (toMs <= fromMs) return out;
  let b = nextBoundary(fromMs, params);
  while (b <= toMs) {
    out.push(b);
    const next = nextBoundary(b, params);
    if (next <= b) break; // saturation guard
    b = next;
  }
  return out;
}

export function msUntilNextBoundary(
  nowMs: bigint,
  params: CadenceParams = DEFAULT_CADENCE,
): bigint {
  return satSub(nextBoundary(nowMs, params), nowMs);
}

/** What the keeper reads off a live `Batch` object. Every field is publicly readable. */
export interface BatchSnapshot {
  readonly batchId: bigint;
  readonly state: BatchState;
  /** DERIVED on chain by `open_batch`. Never supplied by a caller. */
  readonly closeMs: bigint;
  /** 0 until `close_batch` lands. */
  readonly closedAtMs: bigint;
  readonly submitCutoffMs: bigint;
  readonly revealGraceMs: bigint;
  readonly orderCount: number;
  readonly revealedCount: number;
  readonly maxOrders: number;
}

/** The permissionless Move entry points a schedule can call for. */
export type ScheduledAction = 'open' | 'close' | 'reveal' | 'begin' | 'step' | 'none';

export interface DueAction {
  readonly action: ScheduledAction;
  /** Why it is due — printed by the CLI, so a human can check the schedule's reasoning. */
  readonly reason: string;
  /** ms epoch at which it became (or becomes) callable. */
  readonly atMs: bigint;
}

/** `submit_order` asserts `now + submit_cutoff_ms <= close_ms`. Mirrored exactly. */
export function submitWindowOpen(batch: BatchSnapshot, nowMs: bigint): boolean {
  if (batch.state !== STATE_OPEN) return false;
  if (batch.orderCount >= batch.maxOrders) return false; // full REJECTS, but does not close early
  return nowMs + batch.submitCutoffMs <= batch.closeMs;
}

/** `reveal_order` asserts `now <= closed_at_ms + reveal_grace_ms`. */
export function revealWindowOpen(batch: BatchSnapshot, nowMs: bigint): boolean {
  if (batch.state !== STATE_SEALED) return false;
  return nowMs <= batch.closedAtMs + batch.revealGraceMs;
}

/**
 * What is callable right now, in the order it should be sent.
 *
 * Everything returned is PERMISSIONLESS. If the keeper is down, the same list is what any third
 * party should send — that is the whole point of publishing the cadence (aphotic.md §9).
 */
export function dueActions(
  batch: BatchSnapshot | undefined,
  nowMs: bigint,
  params: CadenceParams = DEFAULT_CADENCE,
): DueAction[] {
  if (batch === undefined) {
    // No live batch: opening one is always safe and derives its own close time.
    return [
      {
        action: 'open',
        reason: `no live batch; open_batch will derive close_ms = ${nextBoundary(nowMs, params)}`,
        atMs: nowMs,
      },
    ];
  }

  switch (batch.state) {
    case STATE_OPEN:
      // Invariant 5: `>=`, so a transaction landing in the exact millisecond succeeds.
      if (nowMs >= batch.closeMs) {
        return [
          { action: 'close', reason: `close_ms ${batch.closeMs} reached`, atMs: batch.closeMs },
        ];
      }
      return [
        {
          action: 'none',
          reason:
            `batch ${batch.batchId} is OPEN until ${batch.closeMs} ` +
            `(${msUntilNextBoundary(nowMs, params)} ms); a full batch does NOT close early`,
          atMs: batch.closeMs,
        },
      ];

    case STATE_SEALED: {
      const graceEnds = batch.closedAtMs + batch.revealGraceMs;
      const allRevealed = batch.revealedCount >= batch.orderCount;
      if (!allRevealed && nowMs <= graceEnds) {
        return [
          {
            action: 'reveal',
            reason: `${batch.orderCount - batch.revealedCount} order(s) unrevealed, grace ends ${graceEnds}`,
            atMs: batch.closedAtMs,
          },
        ];
      }
      // `clearing::begin` calls `batch::to_clearing`, which requires all revealed OR grace expired.
      return [
        {
          action: 'begin',
          reason: allRevealed
            ? `all ${batch.orderCount} order(s) revealed`
            : `reveal grace expired at ${graceEnds}`,
          atMs: allRevealed ? batch.closedAtMs : graceEnds + 1n,
        },
      ];
    }

    case STATE_CLEARING:
      return [
        {
          action: 'step',
          reason: `clearing in progress; step() is permissionless and budget-driven`,
          atMs: nowMs,
        },
      ];

    case STATE_SETTLED:
      return [
        {
          action: 'open',
          reason: `batch ${batch.batchId} SETTLED; the next window may be opened`,
          atMs: nowMs,
        },
      ];

    default:
      // Invariant 4: an unknown state is never nudged toward OPEN.
      return [{ action: 'none', reason: `unknown batch state ${String(batch.state)}`, atMs: nowMs }];
  }
}
