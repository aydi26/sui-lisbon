// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.4, T5.2
// @phase      5
// @status     DONE
// @spec       docs/APP.md §4.1 (<StaleBanner/>), §0 (GR9 row), §7 A9
// @spec       docs/GOLDEN-RULES.md G9 · docs/ULTRACODE-BRIEF.md E-A7 (empty book)
// @rules      G6 G9
// @depends    ../theme.css (T0.4) · keeper/src/oracle/ (T2.8)
// @facts      NAV/collateral is valued at the DeepBook MID, never at raw Pyth —
// @facts        hBTC can depeg under exit throttling (G9).
// @facts      Breaker = Pyth BETA BTC/USD vs DeepBook TWAP divergence, plus a
// @facts        staleness guard on the Pyth publish time.
// @facts      Pyth BETA feed id 0xf9c0172b…8ea31b, hermes-beta.pyth.network.
// @facts        (id lives in config only — G7)                    (RECON R11)
// @facts      ⚠ Pyth DAO auto-upgrades Sui addresses 2026-08-18 — pin before then.
// @facts      ⚠ pool::mid_price ABORTS EEmptyOrderbook on an empty book, and the
// @facts        hBTC/DBUSDC book IS empty right now — 'no-book' is a first-class
// @facts        state, not an error. (E-A7, E-M7)
// @facts      'data-age' covers the OTHER staleness a demo can lie about: figures
// @facts        rendered from pre-staged fixtures or a keeper that stopped
// @facts        ticking. Say the age out loud rather than showing them as fresh.
// @implements export function StaleBanner(props: StaleBannerProps): JSX.Element | null
// @forbidden  implying NAV is priced off the oracle — it is priced off book mid
// @forbidden  rendering an age-suppressing "live" affordance next to stale data
// @invariant  1. Returns null when the breaker is not tripped (no chrome cost).
// @invariant  2. Every reason has copy; the union and REASON_COPY stay in step.
// @invariant  3. Inline styles only — usable on any screen without a stylesheet.
// @ac         docs/APP.md §7 A9 — force the breaker fixture, assert the banner
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

export type BreakerReason = 'divergence' | 'staleness' | 'no-book' | 'data-age';

export interface StaleBannerProps {
  tripped: boolean;
  reason?: BreakerReason;
  /** Observed divergence in basis points, when reason === 'divergence'. */
  divergenceBps?: number;
  /** Age of the data / of the Pyth publish time, in ms. */
  ageMs?: number;
  /** What is stale, for reason === 'data-age'. Defaults to "the data on screen". */
  subject?: string;
  /** The freshness threshold that was crossed, in ms. */
  thresholdMs?: number;
}

const REASON_TITLE: Record<BreakerReason, string> = {
  divergence: 'Oracle breaker tripped',
  staleness: 'Oracle breaker tripped',
  'no-book': 'No DeepBook mid to read',
  'data-age': 'You are looking at stale data',
};

const REASON_COPY: Record<BreakerReason, string> = {
  divergence:
    'Pyth BTC/USD and the DeepBook TWAP have diverged past the threshold. Strategy evaluation is refused until they reconverge.',
  staleness:
    'The Pyth BETA feed is stale past its guard. Strategy evaluation is refused; NAV shown is the last DeepBook mid.',
  'no-book':
    'No DeepBook mid is readable for hBTC/DBUSDC — the book is empty on both sides. NAV is valued at the book mid, so it cannot be updated right now.',
  'data-age':
    'Nothing on this screen is being refreshed. The figures below are exactly as old as stated, and we would rather say so than render them as if they were live.',
};

/** Coarse human age, matching screens/transparency/display.ts. */
function humanAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 90) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

export function StaleBanner({
  tripped,
  reason = 'divergence',
  divergenceBps,
  ageMs,
  subject,
  thresholdMs,
}: StaleBannerProps) {
  if (!tripped) return null;

  const detail =
    reason === 'divergence' && divergenceBps !== undefined
      ? ` (${divergenceBps} bps)`
      : ageMs !== undefined
        ? ` (${humanAge(ageMs)} old)`
        : '';

  const scope =
    reason === 'data-age'
      ? `${subject ?? 'The data on this screen'} is older than the ${
          thresholdMs !== undefined ? humanAge(thresholdMs) : 'freshness'
        } threshold.`
      : null;

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
        {REASON_TITLE[reason]}
        {detail}
      </strong>
      {scope !== null ? <span className="aphotic-muted">{scope}</span> : null}
      <span className="aphotic-muted">{REASON_COPY[reason]}</span>
      {reason === 'data-age' ? null : (
        <span className="aphotic-muted">
          NAV is always valued at the DeepBook mid, never at the raw oracle price.
        </span>
      )}
    </div>
  );
}

export default StaleBanner;
