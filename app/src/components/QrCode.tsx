// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.4, T3.1
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/APP.md §2.1 (<DepositAddressCard/> renders <QR/>), §7 A1
// @rules      G6 G7
// @depends    ../theme.css (T0.4) · qrcode.react 4.2.0 (installed, app/package.json)
// @facts      The encoded value is produced CLIENT-SIDE: the deposit screen derives
// @facts        a P2TR address with @mysten/hashi generateDepositAddress() and hands
// @facts        this component the BIP-21 URI `bitcoin:<addr>`. There is no server
// @facts        round-trip anywhere in that path, and A1 intercepts the network to
// @facts        prove it.
// @facts      QR ENCODER = `qrcode.react` 4.2.0 (`QRCodeSVG`, ISC, zero runtime
// @facts        deps, pure client-side SVG). Chosen over `qrcode` because it emits
// @facts        inline SVG with no canvas/Buffer shim. It renders offline (A11).
// @facts      A QR needs a LIGHT module background to scan reliably, so the code
// @facts        itself is #fff/#000 regardless of the dark theme — that is a
// @facts        scanner requirement, not a palette exception. The chrome around it
// @facts        uses the theme tokens.
// @facts      marginSize = 4 modules is the QR spec's mandatory quiet zone.
// @implements export function QrCode(props: QrCodeProps): JSX.Element
// @forbidden  a hosted QR image service (e.g. api.qrserver.com) — A1 asserts no
//             server round-trip and A11 asserts zero network
// @invariant  1. The encoded payload is byte-identical to the `value` prop — this
//                component never rewrites, trims or re-cases what it is given.
//                (The caller decides whether that is a bare address or a BIP-21
//                URI; sending BTC to a mutated string is unrecoverable.)
// @invariant  2. Renders at >= 200 px with the 4-module quiet zone so a phone can
//                scan it off the screen.
// @invariant  3. `placeholder` visibly de-emphasises a pre-staged/demo payload so
//                a fixture address can never be mistaken for a live one (G6).
// @ac         docs/APP.md §7 A1
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { QRCodeSVG } from 'qrcode.react';

export interface QrCodeProps {
  /** Encoded VERBATIM. Pass the exact string the scanner must receive. */
  value: string;
  /** Rendered edge length in px. Clamped to a >= 200 px scannable floor. */
  size?: number;
  /** Accessible label; defaults to a generic description. */
  alt?: string;
  /**
   * true ⇒ the payload is pre-staged demo data, not a live derived address.
   * Renders dimmed + desaturated so it cannot be mistaken for the real thing (G6).
   */
  placeholder?: boolean;
}

/** QR spec minimum for a phone to scan off a screen at arm's length. */
const MIN_EDGE_PX = 200;

export function QrCode({
  value,
  size = 220,
  alt = 'Bitcoin deposit address QR code',
  placeholder = false,
}: QrCodeProps) {
  const edge = Math.max(size, MIN_EDGE_PX);

  return (
    <div
      className="aphotic-qr"
      style={{
        display: 'inline-grid',
        placeItems: 'center',
        padding: 'var(--space-3)',
        background: '#fff',
        borderRadius: 'var(--radius-md)',
        border: `1px solid ${placeholder ? 'var(--border-soft)' : 'var(--accent-dim)'}`,
        opacity: placeholder ? 0.32 : 1,
        filter: placeholder ? 'grayscale(1)' : 'none',
        lineHeight: 0,
      }}
    >
      <QRCodeSVG
        value={value}
        size={edge}
        level="M"
        marginSize={4}
        bgColor="#ffffff"
        fgColor="#000000"
        title={alt}
        role="img"
        aria-label={alt}
      />
    </div>
  );
}

export default QrCode;
