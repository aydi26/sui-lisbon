// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F1
// @phase      0
// @status     DONE
// @spec       docs/DESIGN-V2.md §4 (timing is mechanical, not operator-chosen)
// @spec       aphotic.md §7.3 (cadence), §2 constraint 7
// @rules      G7 G10
// @depends    ../config.ts (F1)
// @facts      CADENCE_MS = 43_200_000 (12 h) · OFFSET_MS = 21_600_000 (06:00 UTC)
// @facts        ⇒ boundaries at 06:00 and 18:00 UTC daily. Unix epoch day 0 begins
// @facts        00:00 UTC, so offset 6 h lands the first boundary at 06:00.
// @facts      ⚠ This is the TS twin of Move's `next_boundary`:
// @facts          since   = saturating_sub(now_ms, offset_ms)
// @facts          periods = since / cadence_ms
// @facts          result  = offset_ms + (periods + 1) * cadence_ms
// @facts        The `+ 1` means the boundary is STRICTLY IN THE FUTURE: exactly ON
// @facts        a boundary returns the NEXT one, never `now`. That asymmetry is the
// @facts        whole reason the boundary vectors are tested three ways.
// @facts      ⚠ ARTIFACT, reproduced deliberately: at now_ms < offset_ms the
// @facts        subtraction saturates to 0, so `periods` is 0 and the formula
// @facts        still adds a full period — nextBoundaryMs(0) is 18:00, not 06:00.
// @facts        That is what the Move twin does, and matching it matters more than
// @facts        the value being pretty. Unreachable in practice: every real
// @facts        timestamp is decades past the offset.
// @facts      ⚠ Move's `close_batch` checks the ON-CHAIN Clock, not this. This
// @facts        module drives the UI countdown only — never a decision.
// @facts      ⚠ When sdk/src/cadence.ts lands it becomes the single source and this
// @facts        file re-exports it. Until then the golden vectors in
// @facts        app/test/cadence.test.ts pin the same numbers on both sides.
// @implements export function nextBoundaryMs(nowMs, cadenceMs?, offsetMs?): number
//             export function previousBoundaryMs(nowMs, cadenceMs?, offsetMs?): number
//             export function msUntilNextBoundary(nowMs, ...): number
//             export function isOnBoundary(nowMs, ...): boolean
//             export function formatCountdown(ms): string
//             export function formatBoundaryUtc(ms): string
//             export function submitWindowClosed(nowMs, ...): boolean
// @forbidden  reading a wall clock in this module — every function takes `nowMs`.
//             The `purity` discipline is what makes the boundary vectors testable.
// @forbidden  a locale-dependent rendering of a boundary — batches are UTC
// @invariant  1. nextBoundaryMs(t) > t for every t (strictly future).
// @invariant  2. nextBoundaryMs(t) - previousBoundaryMs(t) == cadenceMs when t is
//                not itself a boundary.
// @invariant  3. Every returned instant is congruent to offsetMs modulo cadenceMs.
// @invariant  4. No function throws for any finite input.
// @ac         06:00/18:00 UTC boundaries; exactly-on / just-before / just-after.
// @verify     cd app && npm test -- cadence
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { config } from '../config';

/** 12 hours. The clearing cadence. */
export const CADENCE_MS = config.constants.cadenceMs;

/** 06:00 UTC. Shifts the 12 h grid off midnight. */
export const CADENCE_OFFSET_MS = config.constants.cadenceOffsetMs;

function saturatingSub(a: number, b: number): number {
  return a > b ? a - b : 0;
}

/**
 * The next clearing boundary at or after `nowMs`, exclusive of `nowMs` itself.
 *
 * Mirrors Move's `next_boundary` exactly, including the `periods + 1`: standing
 * precisely on 18:00:00.000 returns tomorrow's 06:00, not the instant you are
 * standing on. An operator can therefore never "re-close" the batch that just
 * closed by replaying the same timestamp.
 */
export function nextBoundaryMs(
  nowMs: number,
  cadenceMs: number = CADENCE_MS,
  offsetMs: number = CADENCE_OFFSET_MS,
): number {
  const since = saturatingSub(nowMs, offsetMs);
  const periods = Math.floor(since / cadenceMs);
  return offsetMs + (periods + 1) * cadenceMs;
}

/**
 * The most recent boundary at or before `nowMs`. Standing exactly on a boundary
 * returns that boundary — the mirror image of `nextBoundaryMs`, so together they
 * partition the timeline with no instant belonging to two windows.
 */
export function previousBoundaryMs(
  nowMs: number,
  cadenceMs: number = CADENCE_MS,
  offsetMs: number = CADENCE_OFFSET_MS,
): number {
  const since = saturatingSub(nowMs, offsetMs);
  const periods = Math.floor(since / cadenceMs);
  return offsetMs + periods * cadenceMs;
}

/** Milliseconds from `nowMs` to the next boundary. Always > 0. */
export function msUntilNextBoundary(
  nowMs: number,
  cadenceMs: number = CADENCE_MS,
  offsetMs: number = CADENCE_OFFSET_MS,
): number {
  return nextBoundaryMs(nowMs, cadenceMs, offsetMs) - nowMs;
}

/** True when `nowMs` lands exactly on a boundary instant. */
export function isOnBoundary(
  nowMs: number,
  cadenceMs: number = CADENCE_MS,
  offsetMs: number = CADENCE_OFFSET_MS,
): boolean {
  return saturatingSub(nowMs, offsetMs) % cadenceMs === 0 && nowMs >= offsetMs;
}

/**
 * True inside the submit cutoff — the last `submitCutoffMs` before close, during
 * which no new order is accepted. It exists so a submit can never race an early
 * Seal key release caused by key-server clock skew (DESIGN-V2 §3).
 */
export function submitWindowClosed(
  nowMs: number,
  cutoffMs: number = config.constants.submitCutoffMs,
  cadenceMs: number = CADENCE_MS,
  offsetMs: number = CADENCE_OFFSET_MS,
): boolean {
  return msUntilNextBoundary(nowMs, cadenceMs, offsetMs) <= cutoffMs;
}

/** `HH:MM:SS`, zero-padded, clamped at zero. Never negative, never NaN. */
export function formatCountdown(ms: number): string {
  const total = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/** `2026-07-26 18:00 UTC`. Always UTC — a batch has no local time. */
export function formatBoundaryUtc(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
  );
}
