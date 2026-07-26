// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       B8
// @phase      2
// @status     DONE
// @spec       aphotic.md §7.6 (latency is a distribution, not a point estimate)
// @spec       docs/DESIGN-V2.md §2 (the limiter twin is the surviving high-value code)
// @rules      G5 G7
// @depends    ./limiter.ts · ../hashi/index.ts · ../hashi/types.ts
// @facts      ★ THE G5 CLAIM, AND ALL THAT IS LEFT OF IT HERE: the Guardian's rate
// @facts        limiter is re-derived from Hashi's OWN event stream, never read from an
// @facts        SDK call. `guardian.limiterStatus()` is deliberately not consulted — it
// @facts        is an unverified hint, and the whole point is that a third party can
// @facts        reproduce the number without trusting us or the bridge operator.
// @facts      ⚠ WHAT WAS REMOVED, AND WHY. v1 also replayed the keeper's own DECISION
// @facts        journal: on-chain `journal::DecisionRecorded` pointers → Walrus blobs →
// @facts        decode → re-run the strategy → diff. Every input to that is gone: no
// @facts        strategy to re-run, no journal module, no `DecisionRecorded` event in the
// @facts        v2 package. Keeping the code would have left a verifier that compiles,
// @facts        runs, and verifies NOTHING — worse than no verifier, because it reports
// @facts        success.
// @facts      v2's equivalent claim lives elsewhere and is stronger: clearing is
// @facts        deterministic, so anyone recomputes the price and the fills root from the
// @facts        revealed order set and compares byte-for-byte. That needs no journal.
// @facts      E-K3: `WithdrawalSigned` carries NO amount. The sats come from joining its
// @facts        `request_ids` back to `WithdrawalRequested.btc_amount`, with the timestamp
// @facts        taken off the event ENVELOPE. `Signed` advances the bucket, `Requested`
// @facts        supplies the amount, `PickedForProcessing` is the fee-net fallback, and
// @facts        `Cancelled` clears the queue — all four kinds are required.
// @implements export * from './limiter.js'
// @implements export const LIMITER_EVENT_KINDS: readonly HashiEventKind[]
// @implements export async function deriveLimiterFromAdapter(hashi, cfg): Promise<LimiterTrajectory>
// @forbidden  reading the limiter from an SDK/guardian call and calling it verified (G5)
// @forbidden  a hardcoded id here — every id arrives via config (G7)
// @invariant  1. Paging stops when the cursor fails to advance rather than spinning: an
//                infinite loop in a verifier is indistinguishable from a slow one, and
//                only one of them ever answers.
//             2. The derivation is a pure function of the fetched events, so the same
//                stream always yields the same trajectory.
// @ac         the TS trajectory equals the Move twin on the R9 golden vectors.
// @verify     npm run test -- limiter
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { HashiAdapter } from '../hashi/index.js';
import { EVENT_CURSOR_GENESIS, type HashiEvent, type HashiEventKind } from '../hashi/types.js';

import { deriveLimiter, type DeriveConfig, type LimiterTrajectory } from './limiter.js';

export * from './limiter.js';

/**
 * Everything the trustless limiter replay needs (E-K3). All four kinds, not three:
 * drop `Requested` and `Signed` has no amount to attribute, so the derivation would
 * quietly UNDER-count the bucket rather than fail — the worst possible outcome for a
 * number whose only job is to be checkable.
 */
export const LIMITER_EVENT_KINDS: readonly HashiEventKind[] = Object.freeze([
  'WithdrawalRequested',
  'WithdrawalPickedForProcessing',
  'WithdrawalSigned',
  'WithdrawalCancelled',
]);

/** Events per page. Bounded so a long history cannot exhaust memory in a single call. */
const PAGE_LIMIT = 1_000;

/**
 * Page the adapter's event stream from genesis and re-derive the Guardian trajectory (G5).
 *
 * Works identically against the deterministic mock and the live bridge, which is what
 * makes the claim testable offline: the adapter interface is the only seam.
 */
export async function deriveLimiterFromAdapter(
  hashi: HashiAdapter,
  cfg: DeriveConfig,
): Promise<LimiterTrajectory> {
  const all: HashiEvent[] = [];
  let cursor = EVENT_CURSOR_GENESIS;

  for (;;) {
    const page = await hashi.eventsSince(cursor, { kinds: LIMITER_EVENT_KINDS, limit: PAGE_LIMIT });
    if (page.events.length === 0) break;
    all.push(...page.events);
    // Invariant 1: a cursor that did not advance means the stream is stuck. Return what
    // we have instead of spinning.
    if (page.next.seq <= cursor.seq) break;
    cursor = page.next;
  }

  return deriveLimiter(all, cfg);
}
