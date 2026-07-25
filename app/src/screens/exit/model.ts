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
// @facts      ⚠ MOCK VAULT NUMBERS. src/fixtures has no vault fixture (its shapes are
// @facts        frozen by T0.4 and owned elsewhere), so the demo vault state lives
// @facts        here, chosen to be arithmetically consistent with fixtures/exit.ts:
// @facts        idle 2_762_500 - pooled 12_500 = nav 2_750_000 sats over 2_500_000
// @facts        shares ⇒ 1.1 sats/share. Replace with a shared fixture when one exists.
// @facts      ⚠ MOCK book_mid = 1_180_000_000 (DeepBook FLOAT_SCALING 1e9 ≈ 118k
// @facts        DBUSDC per hBTC). LIVE has NO mid: the hBTC/DBUSDC book is empty on
// @facts        both sides (E-A7/E-M7, blocker B2), which is a defined empty state
// @facts        here, never an error.
// @implements export interface ExitRecord · export interface VaultView
//             export function seedMockExits(nowMs): ExitRecord[]
//             export const MOCK_POOLED_SATS · export function mockVaultView(): VaultView
//             export function reclaimState(rec, nowMs, cooldownMs): ReclaimState
//             export function sharesForSats(...) · export function satsForShares(...)
//             export function formatDuration(ms: number): string
// @forbidden  `number` for any sats/shares quantity — bigint only (G10)
// @forbidden  a field expressing queue POSITION or purchasable priority — G3
// @forbidden  fabricating a Sui digest or a signet txid for a simulated action — a
//             dead explorer link is worse than an honest "nothing was signed" (G6)
// @invariant  1. Every sats/shares value is bigint.
// @invariant  2. reclaimState mirrors the three upstream asserts and adds none.
// @invariant  3. A simulated (mock) exit record carries no digest and no txid.
// @ac         docs/APP.md §7 A5 A6
// @verify     cd app && npx tsc --noEmit
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { config } from '../../config';
import { exitFixtures } from '../../fixtures';
import type { ExitPhase } from '../../fixtures';
import { classifyExitAmount } from '../../lib/format';

const MINUTE_MS = 60_000;

/** One exit as this screen tracks it. Mirrors docs/APP.md §3.4. */
export interface ExitRecord {
  readonly requestId: string;
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
  /** True ⇒ produced locally in mock mode; nothing was signed and nothing is on-chain. */
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

// ── mock staging (docs/APP.md §5) ───────────────────────────────────────────

function isPooled(amountSats: bigint): boolean {
  return (
    classifyExitAmount(amountSats, config.hashi.withdrawalMinSats, config.constants.dustFloorSats) ===
    'pooled'
  );
}

/** Σ of every fixture exit that lands below the bridge minimum. */
export const MOCK_POOLED_SATS: bigint = exitFixtures
  .filter((f) => isPooled(f.amountSats))
  .reduce((acc, f) => acc + f.amountSats, 0n);

/**
 * The demo's exit history, derived from `fixtures/exit.ts`.
 *
 * Ages are chosen so the jury sees BOTH reclaim states without any fake toggle:
 *   • the confirmed exit is 6 h old and already broadcast — nothing to reclaim;
 *   • the in-flight exit is 67 min old and still pre-commit — the 1 h cooldown has
 *     elapsed, so the depositor-signed reclaim path is live on screen.
 * A NEW exit requested during the demo starts its own countdown from zero.
 */
export function seedMockExits(nowMs: number): ExitRecord[] {
  const ages = [6 * 60 * MINUTE_MS, 67 * MINUTE_MS];
  return exitFixtures
    .filter((f) => !isPooled(f.amountSats))
    .map((f, i) => ({
      requestId: f.requestId,
      amountSats: f.amountSats,
      phase: f.phase,
      burnDigest: f.burnDigest,
      signetTxid: f.signetTxid ?? null,
      requestedAtMs: nowMs - (ages[i] ?? (30 + i) * MINUTE_MS),
      picked: f.phase !== 'A',
      simulated: false,
    }));
}

/** Deterministic vault state for `DEMO_MODE=mock`. See the @facts note above. */
export function mockVaultView(): VaultView {
  return {
    totalShares: 2_500_000n,
    navSats: 2_750_000n,
    myShares: 600_000n,
    pendingExitSats: MOCK_POOLED_SATS,
    bookMid: 1_180_000_000n,
    paused: false,
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
  | { readonly kind: 'simulated' };

/**
 * Mirrors `hashi::withdraw::cancel_withdrawal`'s asserts (RECON R7). The sender
 * assert is not modelled here because it is structural: the button is wired to
 * the depositor's own session and to nothing else (E-A3).
 */
export function reclaimState(
  record: ExitRecord,
  nowMs: number,
  cooldownMs: number = config.hashi.cancelCooldownMs,
): ReclaimState {
  if (record.simulated) return { kind: 'simulated' };
  if (record.phase === 'done' || record.signetTxid !== null) return { kind: 'settled' };
  if (record.picked) return { kind: 'processing' };
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
