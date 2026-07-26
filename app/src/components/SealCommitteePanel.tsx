// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F4
// @phase      4
// @status     DONE
// @spec       aphotic.md §7.5 (committee composition; not Enoki)
// @spec       docs/DESIGN-V2.md D9 (n = 5 across 5 DISTINCT OPERATORS, t = 3;
//             probe /v1/service; refuse below t live; NEVER fall back to plaintext)
// @rules      G7 G8
// @depends    ../lib/seal.ts · @aphotic/sdk/seal/committee
// @facts      ⚠⚠ THE PROBE NEEDS BOTH A `Client-Sdk-Version` HEADER AND A
// @facts        `?service_id=` QUERY PARAM, or the server answers 400 — not 404,
// @facts        not 200. Omit either and every server looks dead. Both are
// @facts        supplied by the sdk's `probeService`, which is why this panel
// @facts        calls it instead of building its own request.
// @facts      COUNT OPERATORS, NOT SERVERS. Two servers run by one party are one
// @facts        failure domain. The configured list is index-aligned ids and URLs,
// @facts        so this panel reports what ANSWERED and at what version, and does
// @facts        not claim an operator count the config cannot prove.
// @facts      3 of the 10 advertised testnet servers were down at D9 time and
// @facts        versions skew 0.4.4 / 0.6.7 / 0.6.11. Liveness is probed, never
// @facts        assumed — a committee that quietly shrinks is a confidentiality
// @facts        downgrade nobody would notice.
// @facts      ⚠ Enoki is NOT in the committee and must never be: it is our zkLogin
// @facts        salt provider, and one party holding identity linkage AND a
// @facts        decryption share defeats the arrangement.
// @implements export function SealCommitteePanel(): JSX.Element
// @forbidden  a plaintext fallback, or presenting an unprobed server as live
// @forbidden  a request on mount — the probe is a click
// @invariant  1. A server is "live" only if its own probe returned ok.
// @invariant  2. Below the threshold the panel says a batch must not open.
// @ac         renders without probing and states that nothing is claimed yet.
// @verify     cd app && npm test -- verifyScreen
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { CLIENT_SDK_VERSION, CLIENT_SDK_VERSION_HEADER } from '@aphotic/sdk/seal/committee';

import { config } from '../config';
import { truncateMiddle } from '../lib/format';
import { probeCommittee, sealCommittee, type CommitteeHealth } from '../lib/seal';
import { useAsyncAction } from '../lib/useAsyncAction';

/** Pull a version out of whatever `/v1/service` answered, without inventing one. */
function versionOf(body: string | undefined): string {
  if (body === undefined || body.length === 0) return 'no body';
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null) {
      const v = (parsed as { version?: unknown; service_id?: unknown }).version;
      if (typeof v === 'string') return v;
    }
  } catch {
    // Not JSON. Show a slice rather than a guess.
  }
  return body.slice(0, 40);
}

export function SealCommitteePanel() {
  const health = useAsyncAction<CommitteeHealth>();
  const members = sealCommittee();
  const withUrls = members.filter((m) => m.baseUrl.length > 0);
  const data = health.state.data;

  return (
    <section className="ap-panel">
      <div className="ap-panel-head">
        <h3 className="ap-panel-title">Seal committee health</h3>
        <div className="ap-row">
          {data === null ? null : (
            <span className={data.quorum ? 'ap-badge ap-badge--live' : 'ap-badge ap-badge--warn'}>
              {data.live} of {members.length} answered · t = {data.threshold}
            </span>
          )}
          <button
            type="button"
            className="ap-btn"
            disabled={withUrls.length === 0 || health.state.status === 'loading'}
            title={
              withUrls.length === 0
                ? 'No key-server URLs are configured in this build, so there is nothing to probe.'
                : 'GET /v1/service on every configured server'
            }
            onClick={() => void health.run(() => probeCommittee())}
          >
            {health.state.status === 'loading' ? 'Probing…' : 'Probe the committee'}
          </button>
        </div>
      </div>

      <div className="ap-panel-body" style={{ display: 'grid', gap: 'var(--space-4)' }}>
        {members.length === 0 ? (
          <p className="ap-reason ap-reason--warn">
            No key servers are configured (<code>VITE_SEAL_KEY_SERVER_IDS</code> is empty), so
            nothing can be encrypted in this build. That is a refusal, not a degraded mode: we never
            fall back to plaintext, and a batch does not open below the threshold of live servers.
          </p>
        ) : null}

        {health.state.error !== null ? (
          <p className="ap-reason ap-reason--error">{health.state.error}</p>
        ) : null}

        {data === null ? (
          <ul className="ap-rows ap-gate-rows">
            {members.map((m) => (
              <li key={m.objectId}>
                <div className="ap-rowline">
                  <span className="ap-badge">not probed</span>
                  <span className="ap-wallet-name aphotic-mono" style={{ fontSize: 'var(--text-xs)' }}>
                    {truncateMiddle(m.objectId, 8)}
                  </span>
                  <span className="aphotic-muted" style={{ fontSize: 'var(--text-xs)' }}>
                    {m.baseUrl.length === 0 ? 'no URL configured' : m.baseUrl}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <ul className="ap-rows ap-gate-rows">
            {data.results.map((r) => (
              <li key={r.objectId}>
                <div className="ap-rowline">
                  <span className={r.ok ? 'ap-badge ap-badge--live' : 'ap-badge ap-badge--warn'}>
                    {r.ok ? `HTTP ${r.status}` : r.status === 0 ? 'unreachable' : `HTTP ${r.status}`}
                  </span>
                  <span className="ap-wallet-name aphotic-mono" style={{ fontSize: 'var(--text-xs)' }}>
                    {truncateMiddle(r.objectId, 8)}
                  </span>
                  <span className="aphotic-muted" style={{ fontSize: 'var(--text-xs)' }}>
                    {r.ok ? versionOf(r.body) : (r.error ?? 'no response')}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}

        {data === null ? null : data.quorum ? (
          <p className="ap-reason ap-reason--ok">
            {data.live} servers answered, which meets the threshold of {data.threshold}. A batch may
            open. Confidentiality before close is a threshold assumption, not a proof — and the
            threshold is counted in <strong>distinct operators</strong>, never in servers.
          </p>
        ) : (
          <p className="ap-reason ap-reason--error">
            Only {data.live} server(s) answered against a threshold of {data.threshold}.{' '}
            <strong>A batch must not be opened in this state</strong>, and no order should be
            submitted: an order that cannot be sealed is an order that is not submitted. There is no
            plaintext path.
          </p>
        )}

        <p className="ap-reason">
          The probe sends <code>{CLIENT_SDK_VERSION_HEADER}: {CLIENT_SDK_VERSION}</code> and a{' '}
          <code>?service_id=</code> query parameter. Both are required — omit either and the server
          answers 400 rather than 404 or 200, which would make every server look dead. Policy
          version {config.seal.policyVersion}: the identity a batch is encrypted under carries the
          close timestamp, the policy version and the batch id, so bumping the version invalidates
          every outstanding identity at once.
        </p>

        <p className="ap-reason">
          The committee deliberately excludes our zkLogin salt provider. Using one party for both
          identity and decryption would hand it linkage <em>and</em> plaintext, which is precisely
          the combination the design refuses.
        </p>
      </div>
    </section>
  );
}

export default SealCommitteePanel;
