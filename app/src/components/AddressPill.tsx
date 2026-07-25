// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.4, T3.1, T3.2
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/APP.md §2.1 (<DepositAddressCard/> renders <AddressPill/>)
// @spec       docs/APP.md §3.1 (<PinnedAddressPanel/>)
// @rules      G2 G7
// @depends    ../lib/format.ts (T0.4) · ../theme.css (T0.4)
// @facts      Two uses: the DEPOSIT address (derived client-side, copyable) and
// @facts        the PINNED EXIT address (read from the Vault, IMMUTABLE — G2).
// @facts      `readOnly` is not a styling hint: the pinned variant must have no
// @facts        editable affordance at all (docs/APP.md §7 A4).
// @implements export function AddressPill(props: AddressPillProps): JSX.Element
// @forbidden  an <input>/contentEditable for a pinned address — G2, A4
// @forbidden  hardcoding an id here — values arrive as props from config/fixtures
// @invariant  1. The full address is always in the DOM (copy must be exact) even
//                when the visible text is truncated.
// @ac         docs/APP.md §7 A4
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { useState } from 'react';

import { truncateMiddle } from '../lib/format';

export interface AddressPillProps {
  value: string;
  /** Short caption, e.g. "Your deposit address (P2TR)". */
  label?: string;
  /** Visually truncate; the full value stays in title + clipboard. */
  truncate?: boolean;
  /** Marks the value as pinned/immutable — renders the lock affordance (G2). */
  immutable?: boolean;
}

export function AddressPill({ value, label, truncate = true, immutable = false }: AddressPillProps) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard?.writeText(value).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      },
      () => setCopied(false),
    );
  };

  return (
    <div style={{ display: 'grid', gap: 'var(--space-1)' }}>
      {label ? <span className="aphotic-muted">{label}</span> : null}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-3)',
          border: `1px solid ${immutable ? 'var(--accent-dim)' : 'var(--border-soft)'}`,
          borderRadius: 'var(--radius-pill)',
          padding: 'var(--space-2) var(--space-4)',
          background: 'var(--bg-secondary)',
        }}
      >
        {immutable ? (
          <span title="Pinned on-chain at deposit — immutable" style={{ color: 'var(--accent)' }}>
            ⛓
          </span>
        ) : null}
        <span className="aphotic-mono" title={value} style={{ userSelect: 'all' }}>
          {truncate ? truncateMiddle(value, 12) : value}
        </span>
        <button
          type="button"
          onClick={copy}
          style={{
            marginLeft: 'auto',
            background: 'transparent',
            border: '1px solid var(--border-soft)',
            borderRadius: 'var(--radius-pill)',
            color: 'var(--text-secondary)',
            fontSize: 'var(--text-xs)',
            padding: 'var(--space-1) var(--space-3)',
          }}
        >
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
    </div>
  );
}

export default AddressPill;
