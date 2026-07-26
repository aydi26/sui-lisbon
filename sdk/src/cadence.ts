// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T6.8
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/DESIGN-V2.md#4 (next_boundary, verbatim Move source; open_batch takes NO
//             timestamp parameter — close_ms is DERIVED)
// @spec       aphotic.md §2.7 (timing is mechanical; an operator must never choose the close)
// @spec       aphotic.md §7.3 (06:00 and 18:00 UTC; settle every pass, orders or not)
// @rules      G10
// @depends    ./math.ts (saturating u64 — the Move twin calls oracle::saturating_sub/mul)
// @facts      CADENCE_MS = 43_200_000 (12 h) · OFFSET_MS = 21_600_000 (6 h)
// @facts      ⇒ boundaries land on 06:00 and 18:00 UTC daily (unix epoch day 0 begins 00:00 UTC).
// @facts      Move twin, verbatim (docs/DESIGN-V2.md §4):
// @facts        let since   = oracle::saturating_sub(now_ms, offset_ms);
// @facts        let periods = since / cadence_ms;
// @facts        offset_ms + oracle::saturating_mul(periods + 1, cadence_ms)
// @facts      ★ FINDING — the formula has one genuine quirk, replicated here on purpose because
// @facts        this file must be the EXACT twin: for now_ms < offset_ms (i.e. the first six
// @facts        hours of the unix epoch, 1970-01-01 00:00–06:00 UTC) `since` saturates to 0, so
// @facts        the result is offset + cadence = 18:00 and the 06:00 boundary is SKIPPED.
// @facts        Unreachable in production; pinned by fixtures/cadence.golden.json case
// @facts        `epoch-zero-skips-the-first-boundary` so nobody "fixes" one side only.
// @facts      A FULL BATCH DOES NOT CLOSE EARLY. Closing on fullness would hand a spammer
// @facts        exactly the timing lever uniform-price clearing exists to remove.
// @implements export const CADENCE_MS: bigint
// @implements export const OFFSET_MS: bigint
// @implements export const MS_PER_DAY: bigint
// @implements export function nextBoundary(nowMs: bigint, cadenceMs?: bigint, offsetMs?: bigint): bigint
// @implements export function isBoundary(ms: bigint, cadenceMs?: bigint, offsetMs?: bigint): boolean
// @implements export function boundariesBetween(fromMs, toMs, cadenceMs?, offsetMs?): bigint[]
// @forbidden  an operator-supplied close timestamp — close_ms is DERIVED, always
// @forbidden  closing a batch early because it is full — aphotic.md §2.7
// @invariant  1. nextBoundary(t) > t for every t >= offsetMs. (STRICTLY next: at exactly a
//                boundary it returns the FOLLOWING one.)
// @invariant  2. With the defaults, every result is 06:00 or 18:00 UTC.
// @invariant  3. Saturating: nextBoundary never throws for any u64 input.
// @invariant  4. cadenceMs = 0 throws — Move would abort on the division.
// @ac         fixtures/cadence.golden.json — exact-boundary, just-before, just-after, epoch zero
// @verify     npx vitest run cadence
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { assertU64, satAdd, satMul, satSub } from './math.js';

/** 12 hours. */
export const CADENCE_MS = 43_200_000n;
/** 6 hours — shifts the boundaries onto 06:00 / 18:00 UTC. */
export const OFFSET_MS = 21_600_000n;
export const MS_PER_DAY = 86_400_000n;

/**
 * The exact twin of `batch::next_boundary` (docs/DESIGN-V2.md §4).
 *
 * `open_batch` takes no timestamp; it calls this with the on-chain `Clock`, so the operator has
 * no lever at all. Saturating arithmetic mirrors `oracle::saturating_sub` / `saturating_mul`.
 */
export function nextBoundary(
  nowMs: bigint,
  cadenceMs: bigint = CADENCE_MS,
  offsetMs: bigint = OFFSET_MS,
): bigint {
  assertU64(nowMs, 'nowMs');
  assertU64(cadenceMs, 'cadenceMs');
  assertU64(offsetMs, 'offsetMs');
  if (cadenceMs === 0n) throw new RangeError('EZeroCadence: cadence_ms must be > 0');
  const since = satSub(nowMs, offsetMs);
  const periods = since / cadenceMs;
  return satAdd(offsetMs, satMul(periods + 1n, cadenceMs));
}

/** True when `ms` sits exactly on a scheduled boundary. */
export function isBoundary(
  ms: bigint,
  cadenceMs: bigint = CADENCE_MS,
  offsetMs: bigint = OFFSET_MS,
): boolean {
  if (cadenceMs === 0n) throw new RangeError('EZeroCadence: cadence_ms must be > 0');
  if (ms < offsetMs) return false;
  return (ms - offsetMs) % cadenceMs === 0n;
}

/** Every boundary in `(fromMs, toMs]`. Useful for backfilling a missed schedule. */
export function boundariesBetween(
  fromMs: bigint,
  toMs: bigint,
  cadenceMs: bigint = CADENCE_MS,
  offsetMs: bigint = OFFSET_MS,
): bigint[] {
  const out: bigint[] = [];
  if (toMs <= fromMs) return out;
  let b = nextBoundary(fromMs, cadenceMs, offsetMs);
  while (b <= toMs) {
    out.push(b);
    const next = nextBoundary(b, cadenceMs, offsetMs);
    if (next <= b) break; // saturation guard
    b = next;
  }
  return out;
}
