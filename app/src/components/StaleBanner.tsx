// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.4, T5.2
// @phase      0
// @status     DONE
// @spec       docs/APP.md §4.1 (<StaleBanner/>), §0 (GR9 row), §7 A9
// @spec       docs/GOLDEN-RULES.md G9
// @rules      G9
// @depends    ../theme.css (T0.4) · keeper/src/oracle/ (T2.8)
// @facts      NAV/collateral is valued at the DeepBook MID, never at raw Pyth —
// @facts        hBTC can depeg under exit throttling (G9).
// @facts      Breaker = Pyth BETA BTC/USD vs DeepBook TWAP divergence, plus a
// @facts        staleness guard on the Pyth publish time.
// @facts      Pyth BETA feed id 0xf9c0172b…8ea31b, hermes-beta.pyth.network.
// @facts        (id lives in config only — G7)                    (RECON R11)
// @facts      ⚠ Pyth DAO auto-upgrades Sui addresses 2026-08-18 — pin before then.
// @implements export function StaleBanner(props: StaleBannerProps): JSX.Element | null
// @forbidden  implying NAV is priced off the oracle — it is priced off book mid
// @invariant  1. Returns null when the breaker is not tripped (no chrome cost).
// @ac         docs/APP.md §7 A9 — force the breaker fixture, assert the banner
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

export type BreakerReason = 'divergence' | 'staleness' | 'no-book';

export interface StaleBannerProps {
  tripped: boolean;
  reason?: BreakerReason;
  /** Observed divergence in basis points, when reason === 'divergence'. */
  divergenceBps?: number;
  /** Age of the Pyth publish time in ms, when reason === 'staleness'. */
  ageMs?: number;
}

const REASON_COPY: Record<BreakerReason, string> = {
  divergence:
    'Pyth BTC/USD and the DeepBook TWAP have diverged past the threshold. Strategy evaluation is refused until they reconverge.',
  staleness:
    'The Pyth BETA feed is stale past its guard. Strategy evaluation is refused; NAV shown is the last DeepBook mid.',
  'no-book':
    'No DeepBook mid is readable for hBTC/DBUSDC. NAV is valued at the book mid, so it cannot be updated right now.',
};

export function StaleBanner({ tripped, reason = 'divergence', divergenceBps, ageMs }: StaleBannerProps) {
  if (!tripped) return null;

  const detail =
    reason === 'divergence' && divergenceBps !== undefined
      ? ` (${divergenceBps} bps)`
      : reason === 'staleness' && ageMs !== undefined
        ? ` (${Math.round(ageMs / 1000)} s old)`
        : '';

  return (
    <div
      role="status"
      style={{
        border: '1px solid var(--amber)',
        background: 'rgba(251, 191, 36, 0.08)',
        borderRadius: 'var(--radius-md)',
        padding: 'var(--space-3) var(--space-4)',
        display: 'grid',
        gap: 'var(--space-1)',
      }}
    >
      <strong style={{ color: 'var(--amber)', fontSize: 'var(--text-sm)' }}>
        Oracle breaker tripped{detail}
      </strong>
      <span className="aphotic-muted">{REASON_COPY[reason]}</span>
      <span className="aphotic-muted">
        NAV is always valued at the DeepBook mid, never at the raw oracle price.
      </span>
    </div>
  );
}

export default StaleBanner;
