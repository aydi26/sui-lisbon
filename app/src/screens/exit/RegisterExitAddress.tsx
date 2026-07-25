// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T3.2
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/APP.md §3.1 (<PinnedAddressPanel/> — the register flow), §7 A4
// @spec       move/sources/gateway.move register_exit_address (T1.3, DONE)
// @spec       docs/RECON.md R7 (addr_len == 20 || 32, EInvalidBitcoinAddress)
// @rules      G2 G7 G8
// @depends    ./bech32.ts (T3.2) · ./ptb.ts (T3.2) · ./CallPreview.tsx (T3.2)
//             ../../components/AddressPill.tsx (T0.4)
// @facts      register_exit_address is WRITE-ONCE. A second call aborts
// @facts        EExitAddressAlreadySet — there is no update path, by design (G2).
// @facts      Valid witness programs: 20 bytes P2WPKH (tb1q…) or 32 bytes P2TR (tb1p…).
// @facts      The Bitcoin side of this vault is SIGNET, so the HRP must be 'tb'.
// @facts      This is the ONE moment a destination is ever chosen. Every later
// @facts        exit reads it back out of the Vault, so the validation here is the
// @facts        last recoverable point in the whole flow.
// @implements export function RegisterExitAddress(props: RegisterExitAddressProps): JSX.Element
// @forbidden  submitting an unparsed string — only the parsed 20/32-byte program
// @forbidden  a "change my address later" affordance — none exists on-chain (G2)
// @forbidden  wording that implies hBTC is trustless — it is custodial-threshold (G8)
// @invariant  1. The confirm button is disabled until parsing succeeds AND the user
//                has acknowledged that the pin is permanent.
// @invariant  2. Every rejection states the precise reason and the accepted shapes.
// @ac         docs/APP.md §7 A4
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { useMemo, useState } from 'react';

import { AddressPill } from '../../components/AddressPill';
import CallPreview from './CallPreview';
import { parseExitAddressInput } from '../../lib/bech32';
import { describeRegisterCall } from './ptb';

export interface RegisterExitAddressProps {
  /** Called with the parsed witness program — never with the raw string. */
  readonly onRegister: (program: Uint8Array) => void;
  readonly busy: boolean;
  /** Non-null ⇒ the action is unavailable and this is the honest reason. */
  readonly blockedReason: string | null;
  /** Rendered under the button after a submit attempt. */
  readonly result: string | null;
}

export function RegisterExitAddress({
  onRegister,
  busy,
  blockedReason,
  result,
}: RegisterExitAddressProps) {
  const [raw, setRaw] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);

  const parsed = useMemo(() => (raw.trim().length === 0 ? null : parseExitAddressInput(raw)), [raw]);
  const value = parsed !== null && parsed.ok ? parsed.value : null;
  const error = parsed !== null && !parsed.ok ? parsed.error : null;

  return (
    <section className="xt-panel xt-panel--accent">
      <div className="xt-panel-head">
        <h2 className="xt-panel-title">Pin your Bitcoin exit address</h2>
        <span className="xt-badge xt-badge--warn">not set yet</span>
      </div>

      <p className="xt-copy">
        This is the <strong>only</strong> moment anyone chooses where your BTC leaves to.{' '}
        <code>gateway::register_exit_address</code> writes it into the Vault once; there is no
        update function, no admin override and no runtime parameter that can replace it later.
        Check it twice.
      </p>

      <div className="xt-field">
        <label className="xt-label" htmlFor="xt-addr">
          Signet address (tb1q… / tb1p…) or raw witness program in hex
        </label>
        <input
          id="xt-addr"
          className={`xt-input${error === null ? '' : ' xt-input--bad'}`}
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder="tb1p…"
          spellCheck={false}
          autoComplete="off"
        />
      </div>

      {error === null ? null : <p className="xt-msg xt-msg--bad">{error}</p>}

      {value === null ? (
        <p className="xt-hint">
          Accepted: a 20-byte P2WPKH program (witness v0, bech32) or a 32-byte P2TR program
          (witness v1, bech32m). Hashi asserts exactly those two lengths and aborts{' '}
          <code>EInvalidBitcoinAddress</code> otherwise.
        </p>
      ) : (
        <>
          <AddressPill
            label={`Parsed as ${value.kind} — witness v${value.witnessVersion}, ${value.program.length} bytes`}
            value={value.bech32}
            truncate={false}
          />
          <dl className="xt-kv">
            <div className="xt-kv-row">
              <dt className="xt-kv-key">Witness program (what Move stores)</dt>
              <dd className="xt-kv-val">{value.hex}</dd>
            </div>
          </dl>
          <CallPreview
            call={describeRegisterCall(value.program)}
            caption="The transaction this button builds"
          />
          <label className="xt-copy" style={{ display: 'flex', gap: 'var(--space-3)' }}>
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
            <span>
              I understand this address is written <strong>once</strong> and can never be changed,
              and that the BTC behind it is custodial-threshold wrapped BTC held by Hashi&rsquo;s
              committee.
            </span>
          </label>
        </>
      )}

      {blockedReason === null ? null : <p className="xt-msg xt-msg--warn">{blockedReason}</p>}

      <div className="xt-actions">
        <button
          type="button"
          className="xt-btn xt-btn--primary"
          disabled={value === null || !acknowledged || busy || blockedReason !== null}
          onClick={() => {
            if (value !== null) onRegister(value.program);
          }}
        >
          {busy ? 'Pinning…' : 'Pin this address permanently'}
        </button>
      </div>

      {result === null ? null : <p className="xt-msg xt-msg--ok">{result}</p>}
    </section>
  );
}

export default RegisterExitAddress;
