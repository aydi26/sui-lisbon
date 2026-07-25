// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T3.2
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/APP.md §3.2 (two-phase lifecycle), §3.4 (Exit state), §5 (pre-staged)
// @spec       docs/RECON.md R6 (live Hashi config) · R7 (the three cancel asserts)
// @rules      G1 G2 G3 G6 G10
// @depends    ../../config.ts (T0.4) · ../../fixtures (T0.4) · ../../lib/format.ts (T0.4)
// @facts      HASHI_WITHDRAWAL_MIN_SATS = 30_000 · DUST_FLOOR_SATS = 546
// @facts      withdrawal_cancellation_cooldown_ms = 3_600_000   (RECON R6, live)
// @facts      cancel_withdrawal aborts on exactly three conditions (RECON R7):
// @facts        EUnauthorizedCancellation        request.sender != ctx.sender()
// @facts        ECannotCancelProcessingWithdrawal  the batch was already picked
// @facts        ECooldownNotElapsed              now < created_ms + 3_600_000
// @facts      Move share math: btc_sats = floor(shares * nav_sats / total_shares)
// @facts        (vault::burn_shares_for_btc → mul_div). The inverse used here rounds
// @facts        UP so the depositor never receives less than they asked for.
// @facts      vault::nav_sats excludes the pooled earmark: free = idle - pooled.
// @facts      navSatsMirror() is a LINE-FOR-LINE mirror of vault::nav_sats v3:
// @facts        if quote == 0            → free                    (no price needed)
// @facts        else if book_mid == 0    → the Move call would abort EZeroNav
// @facts        else free + quote * 1e9 / book_mid
// @facts        Reporting "unpriced" is the honest answer; reporting 0 would be a lie
// @facts        about someone's money, and pretending a price would be worse (G9).
// @facts      ⚠ There is NO mock vault state in this module and there must not be:
// @facts        every number on this screen is read from chain (vaultRead.ts) or
// @facts        joined from the on-chain event stream (history.ts).
// @implements export interface ExitRecord · export interface VaultView
//             export type NavReading · export function navSatsMirror(...)
//             export function reclaimState(rec, nowMs, cooldownMs): ReclaimState
//             export function sharesForSats(...) · export function satsForShares(...)
//             export function formatDuration(ms: number): string
// @forbidden  `number` for any sats/shares quantity — bigint only (G10)
// @forbidden  a field expressing queue POSITION or purchasable priority — G3
// @forbidden  fabricating a Sui digest or a signet txid — a dead explorer link is
//             worse than an honest "nothing is on chain" (G6)
// @forbidden  a fixture/mock vault view here — this screen is live-only
// @invariant  1. Every sats/shares value is bigint.
// @invariant  2. reclaimState mirrors the three upstream asserts and adds none,
//                plus one LOCAL state ('unresolved') for a record whose bridge
//                request_id we could not read — we refuse to build a PTB we cannot
//                address correctly.
// @invariant  3. navSatsMirror never invents a price.
// @ac         docs/APP.md §7 A5 A6
// @verify     cd app && npx tsc --noEmit
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { config } from '../../config';
import type { ExitPhase } from '../../fixtures';

/** One exit as this screen tracks it. Mirrors docs/APP.md §3.4. */
export interface ExitRecord {
  /** Stable list key. The bridge request_id when we have it, else the Sui digest. */
  readonly requestId: string;
  /**
   * The bridge's `WithdrawalRequest` id — the ONLY value `reclaim_stalled_exit`
   * may be given. Null when the bridge event could not be read, in which case no
   * reclaim PTB is offered at all (a Sui digest is not an address).
   */
  readonly bridgeRequestId: string | null;
  readonly amountSats: bigint;
  readonly phase: ExitPhase;
  /** Sui digest of the burn + composed request_withdrawal PTB. Null when simulated. */
  readonly burnDigest: string | null;
  /** Present only for an exit the bridge has already broadcast and confirmed (G6). */
  readonly signetTxid: string | null;
  /** Sui event-envelope timestampMs of withdrawal_queue::WithdrawalRequested. */
  readonly requestedAtMs: number;
  /** True once WithdrawalPickedForProcessing fired — past the point a cancel can work. */
  readonly picked: boolean;
  /** Always false on this screen — kept so a rendered record can never claim to be live. */
  readonly simulated: boolean;
}

/** The slice of vault state this screen needs. All money is sats. */
export interface VaultView {
  readonly totalShares: bigint;
  /** vault::nav_sats — free idle base (idle minus the pooled earmark) plus quote. */
  readonly navSats: bigint;
  readonly myShares: bigint;
  /** Depositor.pending_exit_sats — an EARMARK against idle, not a second balance. */
  readonly pendingExitSats: bigint;
  /** DeepBook mid at FLOAT_SCALING 1e9, or null when the book is empty (E-A7). */
  readonly bookMid: bigint | null;
  readonly paused: boolean;
}

// ── NAV — a line-for-line mirror of vault::nav_sats (v3) ────────────────────

/** DeepBook v3 FLOAT_SCALING, as `vault::DEEPBOOK_PRICE_SCALING`. */
export const DEEPBOOK_PRICE_SCALING = 1_000_000_000n;

export type NavReading =
  | { readonly status: 'ok'; readonly sats: bigint }
  | { readonly status: 'unpriced'; readonly reason: string };

/**
 * What `vault::nav_sats(vault, book_mid)` would return, computed from the two
 * balances the package exposes as public getters.
 *
 * A base-only vault has an EXACT sats NAV and needs no price at all — that is the
 * v3 change, and it is why this screen works while the hBTC/DBUSDC book is empty
 * on both sides. The moment the vault holds a quote leg the price becomes
 * load-bearing, and if there is none we say so rather than render a zero NAV that
 * would misstate what a share is worth (G9).
 */
export function navSatsMirror(
  freeBtcSats: bigint,
  quoteValue: bigint,
  bookMid: bigint | null,
): NavReading {
  if (quoteValue === 0n) return { status: 'ok', sats: freeBtcSats };
  if (bookMid === null || bookMid === 0n) {
    return {
      status: 'unpriced',
      reason:
        'The vault now holds DBUSDC as well as hBTC, and there is no mid to value it at — vault::nav_sats would abort EZeroNav. Your funds are untouched; this is a pricing gap, not a loss.',
    };
  }
  return {
    status: 'ok',
    sats: freeBtcSats + (quoteValue * DEEPBOOK_PRICE_SCALING) / bookMid,
  };
}

// ── share ⇄ sats (the exact inverse of vault::burn_shares_for_btc) ──────────

/** floor(shares × nav / totalShares) — what Move actually pays out. */
export function satsForShares(shares: bigint, view: VaultView): bigint {
  if (view.totalShares === 0n || view.navSats === 0n) return 0n;
  return (shares * view.navSats) / view.totalShares;
}

/** ceil(sats × totalShares / nav) — never under-deliver on the requested amount. */
export function sharesForSats(sats: bigint, view: VaultView): bigint {
  if (view.navSats === 0n) return 0n;
  const numerator = sats * view.totalShares;
  return (numerator + view.navSats - 1n) / view.navSats;
}

/** Everything this depositor could withdraw right now, in sats. */
export function myRedeemableSats(view: VaultView): bigint {
  return satsForShares(view.myShares, view);
}

// ── reclaim eligibility — the three upstream asserts, and nothing else ──────

export type ReclaimState =
  | { readonly kind: 'eligible' }
  | { readonly kind: 'cooldown'; readonly remainingMs: number }
  | { readonly kind: 'processing' }
  | { readonly kind: 'settled' }
  | { readonly kind: 'unresolved' }
  | { readonly kind: 'simulated' };

/**
 * Mirrors `hashi::withdraw::cancel_withdrawal`'s asserts (RECON R7). The sender
 * assert is not modelled here because it is structural: the button is wired to
 * the depositor's own session and to nothing else (E-A3).
 *
 * `unresolved` is ours, not Hashi's: without the bridge request_id there is no
 * correct PTB to build, and we will not build an incorrect one.
 */
export function reclaimState(
  record: ExitRecord,
  nowMs: number,
  cooldownMs: number = config.hashi.cancelCooldownMs,
): ReclaimState {
  if (record.simulated) return { kind: 'simulated' };
  if (record.phase === 'done' || record.signetTxid !== null) return { kind: 'settled' };
  if (record.picked) return { kind: 'processing' };
  if (record.bridgeRequestId === null) return { kind: 'unresolved' };
  const elapsed = nowMs - record.requestedAtMs;
  if (elapsed < cooldownMs) return { kind: 'cooldown', remainingMs: cooldownMs - elapsed };
  return { kind: 'eligible' };
}

/** `1 h 04 m` / `04 m 12 s`. Never a spinner — a stated number (G6). */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} h ${String(m).padStart(2, '0')} m`;
  if (m > 0) return `${m} m ${String(s).padStart(2, '0')} s`;
  return `${s} s`;
}

/** `~1 h ago`, for an event-envelope timestamp. */
export function formatAge(ms: number): string {
  return `${formatDuration(ms)} ago`;
}
