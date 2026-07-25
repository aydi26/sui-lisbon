// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.4, T5.2
// @phase      5
// @status     DONE
// @spec       docs/APP.md §4.2 (bridge column + trustless replay, L173-L189)
// @spec       docs/APP.md ERRATA E-A6 (real limiter numbers + the honesty adjustment)
// @spec       docs/RECON.md R8 (event names + the missing-amount gotcha), R9 (limiter)
// @spec       docs/KEEPER.md#verify (§9.2 deriveLimiter)
// @rules      G3 G5 G8
// @depends    ../fixtures (T0.4) · ../config.ts (T0.4) · keeper/src/verify/ (T4.3)
// @facts      projectCapacity(tokens, refillRate, cap, elapsedMs) — CANONICAL arg
// @facts        order, docs/KEEPER.md §2.4. ONE implementation, shared by the mock
// @facts        and by verify/ (keeper/src/hashi/limiter.ts). (G5)
// @facts      project_capacity = min(cap, tokens + elapsed_secs * refill_rate),
// @facts        SATURATING. Time base is UNIX SECONDS; Sui Clock is ms → /1000.
// @facts      consume(): capacity < amount ⇒ RateLimitExceeded. The batch is
// @facts        REJECTED, not queued. There is no priority to buy. (G3)
// @facts      queue depth = Σ WithdrawalRequested − Σ (WithdrawalSigned |
// @facts        WithdrawalCancelled), by request id. (docs/KEEPER.md §9.2)
// @facts      ⚠ WithdrawalSigned carries NO amount and NO timestamp: sats = Σ over
// @facts        request_ids of WithdrawalRequested.btc_amount (fallback:
// @facts        WithdrawalPickedForProcessing.withdrawal_outputs[i].amount); the
// @facts        timestamp is the Sui event ENVELOPE timestampMs. (RECON R8, E-K3)
// @facts      ⚠ All hashi::withdrawal_queue getters are public(package) ⇒ NO
// @facts        on-chain Move read of queue depth exists. U3 = NO. (RECON R7)
// @facts      LIVE guardian scalars (E-K2 / E-A6, GET {guardian_url}/info over
// @facts        HTTP/2 — HTTP/1.1 is rejected with 464, so a browser cannot read
// @facts        them; they arrive through the keeper adapter):
// @facts        refill_rate = 115_740 sats/s · max_bucket_capacity = 10^10 sats
// @facts        (100 BTC, ≈ one full bucket per day). The older 1_000 /
// @facts        100_000_000 prior in docs/RECON.md R9 is wrong by ~100×.
// @facts      ⚠ CONSEQUENCE (E-A6, G8): an Aphotic-sized exit will NEVER be
// @facts        rate-limited on testnet. Write NO congestion/scarcity copy. The
// @facts        true, checkable claim is VERIFIABILITY, not scarcity.
// @facts      VERIFY_URL comes from config.keeper.verifyUrl. The equivalent CLI is
// @facts        `npx ts-node src/index.ts verify --vault <ID> --from-epoch <N> --bridge-replay`.
// @facts      KEEPER_TIMEOUT_MS = 4_000 — fail fast and say so; never hang the demo.
// @implements export function BridgeColumn(props: BridgeColumnProps): JSX.Element
//             export async function rederiveCongestion(bridge, signal?): Promise<ReplayOutcome>
//             export async function postKeeperVerify<T>(path, body, signal?): Promise<T>
//             export class KeeperVerifyError
// @forbidden  framing guardian.limiterStatus as the source of truth — it is an
//             ADVISORY read and must be labelled as such (G5)
// @forbidden  any control offering faster/priority egress — G3
// @forbidden  congestion / scarcity copy — the live bucket is ~100 BTC/day (E-A6)
// @forbidden  re-implementing projectCapacity here — the replay is the keeper's
//             single implementation; the app displays it, it does not fork it (G5)
// @invariant  1. The SDK read and the re-derived value render SIDE BY SIDE.
// @invariant  2. A mismatch is surfaced LOUDLY, never silently reconciled.
// @invariant  3. The copy names the two genesis scalars as the only trust anchors.
// @invariant  4. An unreachable keeper is reported verbatim, never faked.
// @invariant  5. Inline styles only — this component must render correctly on a
//                screen that does not import screens/transparency/transparency.css.
// @ac         docs/APP.md §7 A7
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { CSSProperties } from 'react';

import { config, isMock } from '../config';
import type {
  BridgeFixture,
  HashiEvent,
  LimiterReading,
  LimiterTrajectoryPoint,
} from '../fixtures';
import { formatSats } from '../lib/format';

// ── keeper verify transport ──────────────────────────────────────────────────
// Lives here (rather than in lib/) because BridgeColumn owns the "re-derive"
// affordance; screens/transparency/verifyClient.ts imports it by direct path for
// the per-decision replay. One transport, one error grammar.

const KEEPER_TIMEOUT_MS = 4_000;

export type KeeperVerifyErrorKind = 'unreachable' | 'bad-response';

export class KeeperVerifyError extends Error {
  readonly kind: KeeperVerifyErrorKind;
  readonly endpoint: string;

  constructor(kind: KeeperVerifyErrorKind, endpoint: string, detail?: string) {
    const head =
      kind === 'unreachable'
        ? 'keeper verify endpoint unreachable'
        : 'keeper verify endpoint returned an unusable response';
    super(`${head} — ${endpoint}${detail !== undefined ? ` (${detail})` : ''}`);
    this.name = 'KeeperVerifyError';
    this.kind = kind;
    this.endpoint = endpoint;
  }
}

export function keeperVerifyEndpoint(path: string): string {
  return `${config.keeper.verifyUrl.replace(/\/+$/, '')}${path}`;
}

/** POST JSON to the keeper `verify/` service. Fails fast and honestly. */
export async function postKeeperVerify<T>(
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const endpoint = keeperVerifyEndpoint(path);
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), KEEPER_TIMEOUT_MS);
  if (signal !== undefined) {
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new KeeperVerifyError('bad-response', endpoint, `HTTP ${res.status}`);
    try {
      return (await res.json()) as T;
    } catch {
      throw new KeeperVerifyError('bad-response', endpoint, 'response was not JSON');
    }
  } catch (err) {
    if (err instanceof KeeperVerifyError) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw new KeeperVerifyError('unreachable', endpoint, detail);
  } finally {
    window.clearTimeout(timer);
  }
}

// ── replay ───────────────────────────────────────────────────────────────────

export interface ReplayOutcome {
  readonly reading: LimiterReading;
  readonly trajectory: readonly LimiterTrajectoryPoint[];
  /** 'fixture' = the pre-fetched deterministic event stream (mock, zero network).
   *  'keeper'  = keeper verify/ replayed the live on-chain stream. */
  readonly source: 'fixture' | 'keeper';
  readonly endpoint: string;
  readonly derivedAtMs: number;
}

interface RawTrajectoryPoint {
  tsSec?: number;
  tokensBeforeSats?: string | number;
  consumedSats?: string | number;
  tokensAfterSats?: string | number;
  rejected?: boolean;
}

interface RawBridgeReplay {
  capacitySats?: string | number;
  refillRatePerSec?: string | number;
  maxBucketSats?: string | number;
  queueDepth?: number;
  trajectory?: RawTrajectoryPoint[];
}

function toSats(value: string | number | undefined, fallback: bigint): bigint {
  if (value === undefined) return fallback;
  try {
    return BigInt(value);
  } catch {
    return fallback;
  }
}

/**
 * Calls the keeper `verify/` replay engine and returns the re-derived limiter
 * reading. MUST NOT read guardian.limiterStatus — the whole point is that the
 * bucket trajectory is re-derived from Hashi's own on-chain events (G5).
 *
 * In DEMO_MODE=mock this resolves from the fixture's pre-fetched event stream
 * so the button works with zero network (docs/APP.md §5, A11).
 */
export async function rederiveCongestion(
  bridge: BridgeFixture,
  signal?: AbortSignal,
): Promise<ReplayOutcome> {
  if (isMock()) {
    return {
      reading: bridge.expectedReplay,
      trajectory: bridge.trajectory,
      source: 'fixture',
      endpoint: '',
      derivedAtMs: Date.now(),
    };
  }

  const raw = await postKeeperVerify<RawBridgeReplay>(
    '/bridge-replay',
    { vaultId: config.aphotic.vaultId, fromEpoch: 0 },
    signal,
  );

  const refillRatePerSec = toSats(raw.refillRatePerSec, bridge.genesisScalars.refillRatePerSec);
  const maxBucketSats = toSats(raw.maxBucketSats, bridge.genesisScalars.maxBucketSats);

  return {
    reading: {
      capacitySats: toSats(raw.capacitySats, 0n),
      refillRatePerSec,
      maxBucketSats,
      queueDepth: raw.queueDepth ?? 0,
      source: 'replay',
    },
    trajectory: (raw.trajectory ?? []).map((p) => ({
      tsSec: p.tsSec ?? 0,
      tokensBeforeSats: toSats(p.tokensBeforeSats, 0n),
      consumedSats: toSats(p.consumedSats, 0n),
      tokensAfterSats: toSats(p.tokensAfterSats, 0n),
      rejected: p.rejected ?? false,
    })),
    source: 'keeper',
    endpoint: keeperVerifyEndpoint('/bridge-replay'),
    derivedAtMs: Date.now(),
  };
}

// ── event-stream helpers (display cross-checks, not limiter math) ────────────

const REQUESTED = 'withdrawal_queue::WithdrawalRequested';
const SIGNED = 'withdrawal_queue::WithdrawalSigned';
const CANCELLED = 'withdrawal_queue::WithdrawalCancelled';

/** Outstanding request ids: Σ Requested − Σ (Signed | Cancelled). */
export function countOutstanding(events: readonly HashiEvent[]): number {
  const requested = new Set<string>();
  const settled = new Set<string>();
  for (const e of events) {
    if (e.name === REQUESTED) for (const id of e.requestIds) requested.add(id);
    if (e.name === SIGNED || e.name === CANCELLED) for (const id of e.requestIds) settled.add(id);
  }
  let outstanding = 0;
  for (const id of requested) if (!settled.has(id)) outstanding += 1;
  return outstanding;
}

const shortEvent = (name: string): string => name.replace('withdrawal_queue::Withdrawal', '');
const relSec = (ms: number): string => `t+${Math.floor(ms / 1000)}s`;

// ── styles (inline: this component must survive without a screen stylesheet) ──

const S = {
  card: {
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-soft)',
    borderRadius: 'var(--radius-lg)',
    padding: 'var(--space-5)',
    display: 'grid',
    gap: 'var(--space-4)',
    minWidth: 0,
  },
  eyebrow: {
    fontSize: 'var(--text-xs)',
    letterSpacing: 'var(--tracking-wide)',
    textTransform: 'uppercase',
    color: 'var(--accent)',
  },
  title: {
    fontFamily: 'var(--font-display)',
    fontSize: 'var(--text-lg)',
    lineHeight: 'var(--leading-tight)',
    margin: 0,
  },
  split: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)',
    gap: 'var(--space-4)',
    borderTop: '1px solid var(--border-soft)',
    borderBottom: '1px solid var(--border-soft)',
    padding: 'var(--space-4) 0',
  },
  cell: { display: 'grid', gap: 'var(--space-1)', minWidth: 0 },
  cellK: {
    fontSize: 'var(--text-xs)',
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: 'var(--text-muted)',
  },
  big: {
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-lg)',
    letterSpacing: '-0.01em',
    color: 'var(--text-primary)',
    wordBreak: 'break-all',
  },
  bigAccent: {
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-lg)',
    letterSpacing: '-0.01em',
    color: 'var(--accent)',
    wordBreak: 'break-all',
  },
  sub: { fontSize: 'var(--text-xs)', color: 'var(--text-muted)', lineHeight: 1.6 },
  formula: {
    border: '1px solid var(--border-soft)',
    borderRadius: 'var(--radius-md)',
    background: 'var(--bg-primary)',
    padding: 'var(--space-3) var(--space-4)',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-xs)',
    color: 'var(--text-secondary)',
    overflowX: 'auto',
    whiteSpace: 'nowrap',
  },
  button: {
    justifySelf: 'start',
    background: 'var(--accent-dim)',
    border: '1px solid var(--accent)',
    color: 'var(--accent)',
    borderRadius: 'var(--radius-md)',
    padding: 'var(--space-2) var(--space-5)',
    fontSize: 'var(--text-sm)',
  },
  note: { margin: 0, fontSize: 'var(--text-xs)', lineHeight: 1.65, color: 'var(--text-muted)' },
  alert: {
    border: '1px solid var(--red)',
    borderRadius: 'var(--radius-md)',
    padding: 'var(--space-3) var(--space-4)',
    color: 'var(--text-primary)',
    fontSize: 'var(--text-sm)',
    display: 'grid',
    gap: 'var(--space-1)',
  },
  warn: {
    border: '1px solid var(--border-soft)',
    borderLeft: '2px solid var(--amber)',
    borderRadius: '0 var(--radius-md) var(--radius-md) 0',
    padding: 'var(--space-3) var(--space-4)',
    color: 'var(--text-secondary)',
    fontSize: 'var(--text-sm)',
  },
  scroll: { overflowX: 'auto', maxWidth: '100%' },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-xs)',
    whiteSpace: 'nowrap',
  },
  th: {
    textAlign: 'left',
    fontWeight: 400,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    padding: 'var(--space-2) var(--space-3) var(--space-2) 0',
    borderBottom: '1px solid var(--border-soft)',
  },
  td: {
    padding: 'var(--space-2) var(--space-3) var(--space-2) 0',
    borderBottom: '1px solid var(--border-soft)',
    color: 'var(--text-secondary)',
  },
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.4em',
    fontSize: 'var(--text-xs)',
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-pill)',
    padding: '2px 10px',
    color: 'var(--text-secondary)',
    whiteSpace: 'nowrap',
    justifySelf: 'start',
  },
} satisfies Record<string, CSSProperties>;

// ── component ────────────────────────────────────────────────────────────────

export interface BridgeColumnProps {
  bridge: BridgeFixture;
  /** Re-derived outcome once the replay has run; null before the first click. */
  replay?: ReplayOutcome | null;
  onReplay?: () => void;
  replaying?: boolean;
  /** Verbatim failure text when the replay could not run. Never swallowed. */
  error?: string | null;
}

export function BridgeColumn({
  bridge,
  replay = null,
  onReplay,
  replaying = false,
  error = null,
}: BridgeColumnProps) {
  const sdk = bridge.sdkLimiter;
  const reading = replay?.reading ?? null;
  const mismatch =
    reading !== null &&
    (reading.capacitySats !== sdk.capacitySats || reading.queueDepth !== sdk.queueDepth);
  const outstanding = countOutstanding(bridge.events);

  return (
    <section style={S.card} aria-label="Hashi bridge rate limiter">
      <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
        <span style={S.eyebrow}>Hashi bridge · Guardian rate limiter</span>
        <h2 style={S.title}>Capacity, re-derived</h2>
        <p style={{ ...S.sub, margin: 0, fontSize: 'var(--text-sm)' }}>
          The bridge&rsquo;s own rate limiter, replayed from the bridge&rsquo;s own on-chain
          events. This is a statement about what we can verify — not a claim that the bridge is
          busy.
        </p>
      </div>

      <div style={S.split}>
        <div style={S.cell}>
          <span style={S.cellK}>Guardian read · advisory</span>
          <strong style={S.big}>{formatSats(sdk.capacitySats)}</strong>
          <span style={S.sub}>
            queue depth {sdk.queueDepth} · a convenience read, not the source of truth
          </span>
        </div>

        <div style={S.cell}>
          <span style={S.cellK}>Re-derived from events</span>
          <strong style={S.bigAccent}>
            {reading !== null ? formatSats(reading.capacitySats) : '—'}
          </strong>
          <span style={S.sub}>
            {reading !== null
              ? `queue depth ${reading.queueDepth} · ${
                  replay?.source === 'keeper'
                    ? 'keeper verify/ replayed the live stream'
                    : 'replayed from the pre-fetched event stream'
                }`
              : 'not yet replayed'}
          </span>
        </div>
      </div>

      <div style={S.formula}>project_capacity() = min(cap, tokens + elapsed × refill_rate)</div>

      <p style={S.note}>
        Replayed over Hashi&rsquo;s <code>WithdrawalRequested</code> /{' '}
        <code>PickedForProcessing</code> / <code>Signed</code> stream, in UNIX seconds, with
        saturating arithmetic. Only two genesis scalars — <code>refill_rate</code> and{' '}
        <code>max_bucket_capacity</code> — are trust anchors, and both are observationally
        boundable. Everything else is derived from events anyone can read.
      </p>

      <button type="button" onClick={onReplay} disabled={replaying} style={S.button}>
        {replaying ? 'Re-deriving…' : 'Re-derive congestion from Hashi events'}
      </button>

      {error !== null ? (
        <div role="alert" style={S.warn}>
          <strong style={{ color: 'var(--amber)' }}>Replay could not run.</strong>
          <br />
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>
            {error}
          </span>
          <br />
          Nothing is substituted for it. The re-derived column stays empty until the verifier
          actually runs.
        </div>
      ) : null}

      {mismatch ? (
        <div role="alert" style={S.alert}>
          <strong style={{ color: 'var(--red)' }}>Replay disagrees with the Guardian read.</strong>
          <span style={{ color: 'var(--text-secondary)' }}>
            Trust the replay, not the read — and investigate. The replay is derived from the
            bridge&rsquo;s own events; the read is a convenience API.
          </span>
        </div>
      ) : null}

      <div>
        <span style={{ ...S.cellK, display: 'block', marginBottom: 'var(--space-2)' }}>
          Event stream replayed
        </span>
        <div style={S.scroll}>
          <table style={S.table}>
            <thead>
              <tr>
                <th style={S.th}>event</th>
                <th style={S.th}>envelope ts</th>
                <th style={S.th}>request ids</th>
                <th style={S.th}>sats</th>
              </tr>
            </thead>
            <tbody>
              {bridge.events.map((e, i) => (
                <tr key={`${e.name}-${e.timestampMs}-${i}`}>
                  <td style={{ ...S.td, color: 'var(--text-primary)' }}>
                    {shortEvent(e.name)}
                    {e.name === SIGNED ? '†' : ''}
                  </td>
                  <td style={S.td}>{relSec(e.timestampMs)}</td>
                  <td style={S.td}>{e.requestIds.length}</td>
                  <td style={S.td}>
                    {e.satsAmount !== undefined ? formatSats(e.satsAmount) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ ...S.note, marginTop: 'var(--space-2)' }}>
          † <code>WithdrawalSigned</code> carries no amount and no timestamp. The sats shown are
          the sum of the <code>WithdrawalRequested.btc_amount</code> joined back through{' '}
          <code>request_ids</code>, and the time is the Sui event-envelope{' '}
          <code>timestampMs</code>. Queue depth counted straight off this list: {outstanding}{' '}
          request id{outstanding === 1 ? '' : 's'} requested and not yet settled by a{' '}
          <code>Signed</code> or <code>Cancelled</code>.
        </p>
      </div>

      {replay !== null && replay.trajectory.length > 0 ? (
        <div>
          <span style={{ ...S.cellK, display: 'block', marginBottom: 'var(--space-2)' }}>
            Bucket trajectory
          </span>
          <div style={S.scroll}>
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>t (s)</th>
                  <th style={S.th}>tokens before</th>
                  <th style={S.th}>consumed</th>
                  <th style={S.th}>tokens after</th>
                  <th style={S.th}>outcome</th>
                </tr>
              </thead>
              <tbody>
                {replay.trajectory.map((p) => (
                  <tr key={p.tsSec}>
                    <td style={S.td}>{p.tsSec}</td>
                    <td style={S.td}>{p.tokensBeforeSats.toString()}</td>
                    <td style={S.td}>{p.consumedSats.toString()}</td>
                    <td style={{ ...S.td, color: 'var(--text-primary)' }}>
                      {p.tokensAfterSats.toString()}
                    </td>
                    <td style={{ ...S.td, color: p.rejected ? 'var(--red)' : 'var(--green)' }}>
                      {p.rejected ? 'RateLimitExceeded' : 'accepted'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p style={{ ...S.note, marginTop: 'var(--space-2)' }}>
            Tokens are clamped to the cap before the debit, then refill continuously between
            points — which is why the headline capacity, projected forward to now, sits above the
            last row.
          </p>
        </div>
      ) : null}

      <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
        <span style={S.cellK}>Genesis scalars — the only trust anchors</span>
        <div style={{ display: 'grid', gap: 'var(--space-1)' }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>
            refill_rate = {bridge.genesisScalars.refillRatePerSec.toString()} sats/s ·
            max_bucket_capacity = {bridge.genesisScalars.maxBucketSats.toString()} sats
          </span>
          <span style={S.sub}>
            Replay fixture scalars (golden vector, <code>docs/RECON.md</code> R9) — the same
            vector the Move envelope and the keeper limiter are both tested against.
          </span>
        </div>
        <p style={S.note}>
          On the live testnet bridge those two scalars read{' '}
          <strong style={{ color: 'var(--text-secondary)' }}>115,740 sats/s</strong> and{' '}
          <strong style={{ color: 'var(--text-secondary)' }}>100 BTC</strong> — roughly one full
          bucket of capacity per day. At that size an Aphotic-sized exit is never rate-limited, so
          we make no scarcity claim. We read them once from the Guardian&rsquo;s{' '}
          <code>/info</code> over HTTP/2 (it rejects HTTP/1.1), and every number derived from them
          is reproducible from public events.
        </p>
      </div>

      <p style={S.note}>
        Over-capacity batches are <strong style={{ color: 'var(--text-secondary)' }}>rejected</strong>{' '}
        (<code>RateLimitExceeded</code>), not queued. There is no priority to buy and no queue
        position to hold — we ration only our own egress rate, and we treat the limiter as a risk
        input, never as a promise about delivery time.
      </p>

      <span style={S.chip}>
        {isMock() ? 'mock · pre-fetched event stream' : 'live · keeper verify/'}
      </span>
    </section>
  );
}

export default BridgeColumn;
