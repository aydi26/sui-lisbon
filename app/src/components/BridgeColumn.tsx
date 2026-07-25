// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.4, T5.2
// @phase      5
// @status     STUB
// @spec       docs/APP.md §4.2 (bridge column + trustless replay, L173-L189)
// @spec       docs/RECON.md R8 (event names + the missing-amount gotcha), R9 (limiter)
// @spec       docs/KEEPER.md#verify
// @rules      G3 G5
// @depends    ../fixtures (T0.4) · ../config.ts (T0.4) · keeper/src/verify/ (T4.3)
// @facts      projectCapacity(tokens, refillRate, cap, elapsedMs) — CANONICAL arg
// @facts        order, docs/KEEPER.md §2.4. ONE implementation, shared by the mock
// @facts        and by verify/ (keeper/src/hashi/limiter.ts). (G5)
// @facts      project_capacity = min(cap, tokens + elapsed_secs * refill_rate),
// @facts        SATURATING. Time base is UNIX SECONDS; Sui Clock is ms → /1000.
// @facts      consume(): capacity < amount ⇒ RateLimitExceeded. The batch is
// @facts        REJECTED, not queued. There is no priority to buy. (G3)
// @facts      ⚠ WithdrawalSigned carries NO amount and NO timestamp: sats = Σ over
// @facts        request_ids of WithdrawalRequested.btc_amount (fallback:
// @facts        WithdrawalPickedForProcessing.withdrawal_outputs[i].amount); the
// @facts        timestamp is the Sui event ENVELOPE timestampMs. (RECON R8)
// @facts      ⚠ All hashi::withdrawal_queue getters are public(package) ⇒ NO
// @facts        on-chain Move read of queue depth exists. U3 = NO. (RECON R7)
// @facts      ⚠ U1: the live genesis scalars are NOT on-chain and the guardian is
// @facts        gRPC-only. Present any figure as a BOUND, not a fact.
// @facts      VERIFY_URL comes from config.keeper.verifyUrl. The equivalent CLI is
// @facts        `npx ts-node src/index.ts verify --vault <ID> --from-epoch <N> --bridge-replay`.
// @implements export function BridgeColumn(props: BridgeColumnProps): JSX.Element
// @forbidden  framing guardian.limiterStatus as the source of truth — it is an
//             ADVISORY read and must be labelled as such (G5)
// @forbidden  any control offering faster/priority egress — G3
// @invariant  1. The SDK read and the re-derived value render SIDE BY SIDE.
// @invariant  2. A mismatch is surfaced LOUDLY, never silently reconciled.
// @invariant  3. The copy names the two genesis scalars as the only trust anchors.
// @ac         docs/APP.md §7 A7
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { BridgeFixture, LimiterReading } from '../fixtures';
import { formatSats } from '../lib/format';

export interface BridgeColumnProps {
  bridge: BridgeFixture;
  /** Re-derived reading once the replay has run; null before the first click. */
  replay?: LimiterReading | null;
  onReplay?: () => void;
  replaying?: boolean;
}

/**
 * Calls the keeper `verify/` replay engine and returns the re-derived limiter
 * reading. MUST NOT read guardian.limiterStatus — the whole point is that the
 * bucket trajectory is re-derived from Hashi's own on-chain events (G5).
 */
export async function rederiveCongestion(): Promise<LimiterReading> {
  // TODO(T5.2): POST config.keeper.verifyUrl + '/bridge-replay' and map the
  // response onto LimiterReading. Under DEMO_MODE=mock, resolve from
  // bridgeFixture.expectedReplay instead so the button works with zero network.
  throw new Error('TODO(T5.2): rederiveCongestion not implemented');
}

export function BridgeColumn({ bridge, replay = null, onReplay, replaying = false }: BridgeColumnProps) {
  const mismatch = replay !== null && replay.capacitySats !== bridge.sdkLimiter.capacitySats;

  return (
    <section className="aphotic-card" style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <h3 style={{ fontSize: 'var(--text-md)', margin: 0 }}>Bridge congestion</h3>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-4)' }}>
        <div style={{ display: 'grid', gap: 'var(--space-1)' }}>
          <span className="aphotic-muted">SDK read (advisory)</span>
          <strong className="aphotic-mono">{formatSats(bridge.sdkLimiter.capacitySats)}</strong>
          <span className="aphotic-muted">
            guardian.limiterStatus · queue depth {bridge.sdkLimiter.queueDepth}
          </span>
        </div>

        <div style={{ display: 'grid', gap: 'var(--space-1)' }}>
          <span className="aphotic-muted">Re-derived from Hashi events</span>
          <strong className="aphotic-mono" style={{ color: 'var(--accent)' }}>
            {replay ? formatSats(replay.capacitySats) : '—'}
          </strong>
          <span className="aphotic-muted">
            {replay ? `queue depth ${replay.queueDepth}` : 'not yet replayed'}
          </span>
        </div>
      </div>

      <button
        type="button"
        onClick={onReplay}
        disabled={replaying}
        style={{
          justifySelf: 'start',
          background: 'transparent',
          border: '1px solid var(--accent)',
          color: 'var(--accent)',
          borderRadius: 'var(--radius-pill)',
          padding: 'var(--space-2) var(--space-5)',
          fontSize: 'var(--text-sm)',
        }}
      >
        {replaying ? 'Re-deriving…' : 'Re-derive congestion from Hashi events'}
      </button>

      {mismatch ? (
        <div
          role="alert"
          style={{
            border: '1px solid var(--red)',
            borderRadius: 'var(--radius-md)',
            padding: 'var(--space-3)',
            color: 'var(--red)',
            fontSize: 'var(--text-sm)',
          }}
        >
          Replay disagrees with the SDK read. Trust the replay, not the read — and investigate.
        </div>
      ) : null}

      <p className="aphotic-muted" style={{ margin: 0 }}>
        This is not a trusted SDK read. The whole bucket trajectory is re-derived from Hashi’s own
        on-chain events. Only two genesis scalars — <code>refill_rate</code> and{' '}
        <code>max_bucket_capacity</code> — are trust anchors, and both are observationally
        boundable.
      </p>
      <p className="aphotic-muted" style={{ margin: 0 }}>
        Over-capacity batches are <strong>rejected</strong> (<code>RateLimitExceeded</code>), not
        queued. There is no priority to buy — we ration only our own egress rate.
      </p>
      <p className="aphotic-muted" style={{ margin: 0 }}>
        Genesis scalars in use: {bridge.genesisScalars.provenance}
      </p>
    </section>
  );
}

export default BridgeColumn;
