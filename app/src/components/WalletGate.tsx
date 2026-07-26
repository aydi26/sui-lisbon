// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F1
// @phase      0
// @status     DONE
// @spec       aphotic.md §6.1 (caps — what a connected session does NOT grant)
// @spec       docs/DESIGN-V2.md §7 (KeeperCap · INV-C1)
// @rules      G7 G8
// @depends    ../session (F1) · ../theme.css (F1)
// @facts      TWO sign-in paths, ONE session. A browser-extension wallet and the
// @facts        Enoki zkLogin wallet are BOTH wallet-standard wallets, so dapp-kit
// @facts        drives both and this component only chooses which affordance to
// @facts        show. Nothing here forks on provider except the label.
// @facts      Enoki opens a POPUP, so signIn() must be called from a user gesture —
// @facts        never from an effect, or the browser blocks it silently.
// @facts      A wallet-standard account advertises `chains`. An account whose list
// @facts        is non-empty and lacks sui:<configured network> is on the wrong
// @facts        network; we say so instead of letting the abort surface in-wallet.
// @facts        An EMPTY list means the wallet declined to say — we do not guess.
// @facts      SHAPE: a sticky-headed card (help · "Connect Wallet" · dismiss) over
// @facts        hairline-separated rows, each `[icon] [name] [pill] [chevron]` —
// @facts        the .ap-panel / .ap-panel-head / .ap-rows / .ap-rowline grammar
// @facts        already in theme.css. Borrowed shape, our own tokens: no Tailwind,
// @facts        no @reown/appkit, no new dependency.
// @facts      ⚠ THE "installed" PILL IS A CLAIM, and it is the one thing on this
// @facts        card a user acts on. It renders ONLY for wallets wallet-standard
// @facts        actually reported to this page. Nothing else may ever wear it.
// @facts      The Google row deliberately sits BELOW a rule and outside the wallet
// @facts        list: zkLogin is a different trust story (a salt provider and an
// @facts        OAuth issuer are involved) and must not read as one more wallet.
// @implements export function WalletGate(props: WalletGateProps): JSX.Element
// @forbidden  '@mysten/enoki/react' — every hook there is deprecated
// @forbidden  rendering a screen's write controls before a wallet is connected
// @forbidden  a hardcoded wallet name — the list comes from wallet-standard, so a
//             wallet the user actually has installed is the wallet they are offered
// @invariant  1. Children never render while disconnected. This is a GATE, not a
//                banner: a screen behind it can assume `address` is non-null.
//             2. Every disabled affordance states its reason on the control itself,
//                not only in prose beside it.
//             3. Connecting grants NO capability over vault funds. The footer says
//                so, because a connect dialog is exactly where a user forms their
//                mental model of what they just authorised.
// @ac         with no wallet installed and Enoki unconfigured, the gate still
//             renders and explains both, rather than showing two dead buttons.
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────
import { useState, type ReactNode } from 'react';

import { useAphoticSession } from '../session';
import type { WalletLike } from '../session/enoki';

export interface WalletGateProps {
  /** Rendered only once a wallet is connected (invariant 1). */
  readonly children: ReactNode;
  /** What the user is about to do — shown under the title. */
  readonly purpose?: string;
}

/** Wallet-standard exposes an icon as a data: URI. Render it, or fall back to a monogram. */
function WalletIcon({ wallet }: { readonly wallet: WalletLike }) {
  const icon = (wallet as { icon?: string }).icon;
  if (typeof icon === 'string' && icon.length > 0) {
    return <img className="ap-wallet-icon" src={icon} alt="" aria-hidden />;
  }
  return (
    <span className="ap-wallet-icon ap-wallet-icon--mono" aria-hidden>
      {wallet.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** The chevron every row ends in. Inline so the card needs no icon dependency. */
function Chevron() {
  return (
    <svg className="ap-row-cue" viewBox="0 0 16 16" width="14" height="14" aria-hidden focusable="false">
      <path
        d="M6 3.5 10.5 8 6 12.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The Google mark, drawn in one colour: this is a row cue, not a brand lockup. */
function GoogleMark() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden focusable="false">
      <path
        d="M14.5 8.15c0-.46-.04-.9-.12-1.32H8v2.5h3.65a3.12 3.12 0 0 1-1.35 2.05v1.7h2.18c1.28-1.18 2.02-2.92 2.02-4.93Z"
        fill="currentColor"
        opacity="0.9"
      />
      <path
        d="M8 15c1.83 0 3.36-.6 4.48-1.64l-2.18-1.69c-.6.41-1.38.65-2.3.65-1.77 0-3.27-1.19-3.8-2.8H1.95v1.76A6.99 6.99 0 0 0 8 15Z"
        fill="currentColor"
        opacity="0.65"
      />
      <path
        d="M4.2 9.52a4.2 4.2 0 0 1 0-2.68V5.08H1.95a7 7 0 0 0 0 6.2L4.2 9.52Z"
        fill="currentColor"
        opacity="0.45"
      />
      <path
        d="M8 3.98c1 0 1.89.34 2.6 1.02l1.93-1.93A6.9 6.9 0 0 0 8 1.36 6.99 6.99 0 0 0 1.95 5.08L4.2 6.84c.53-1.6 2.03-2.86 3.8-2.86Z"
        fill="currentColor"
        opacity="0.8"
      />
    </svg>
  );
}

/** The help glyph. Inline so the card needs no icon dependency. */
function HelpMark() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden focusable="false">
      <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.25" />
      <path
        d="M6.4 6.2a1.6 1.6 0 1 1 1.9 1.7v1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
      <circle cx="8.3" cy="11.2" r="0.7" fill="currentColor" />
    </svg>
  );
}

export function WalletGate({ children, purpose }: WalletGateProps) {
  const session = useAphoticSession();
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  if (session.status === 'connected') return <>{children}</>;

  const connecting = session.status === 'connecting' || busy !== null;

  const run = async (key: string, fn: () => Promise<void>) => {
    setFailure(null);
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      // A user closing the popup is a cancellation, not a fault. Say the real
      // reason either way rather than a generic "connection failed".
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  // ONE list, three rows. The card was two labelled sections, an "or" rule, a help
  // popover and two paragraphs of prose — and a connect dialog nobody reads is worse
  // than a short one they do. What survived the cut is what a user acts on: which
  // wallets are actually here, and the one line saying what connecting does not grant.
  const rows: readonly {
    key: string;
    name: string;
    icon: ReactNode;
    installed: boolean;
    disabled: boolean;
    title: string;
    onClick: () => void;
  }[] = [
    ...session.extensionWallets.map((wallet) => ({
      key: wallet.name,
      name: wallet.name,
      icon: <WalletIcon wallet={wallet} />,
      installed: true,
      disabled: connecting,
      title: connecting ? 'A connection is already in progress' : `Connect ${wallet.name}`,
      onClick: () => void run(wallet.name, () => session.connectWallet(wallet)),
    })),
    {
      key: 'google',
      name: 'Sign in with Google',
      icon: (
        <span className="ap-wallet-icon ap-wallet-icon--mono" aria-hidden>
          <GoogleMark />
        </span>
      ),
      installed: false,
      disabled: connecting || !session.googleAvailable,
      // Invariant 2: a disabled control states its reason ON the control.
      title:
        session.zkLoginDisabledReason ??
        (connecting
          ? 'A connection is already in progress'
          : 'Opens a Google popup; your Sui address is derived from the login, client-side'),
      onClick: () => void run('google', session.signIn),
    },
  ];

  return (
    <div className="ap-gate">
      <section className="ap-panel ap-gate-card" role="dialog" aria-labelledby="ap-gate-title">
        <header className="ap-panel-head ap-gate-head">
          <h1 className="ap-panel-title ap-gate-title" id="ap-gate-title">
            Connect Wallet
          </h1>
          <a
            className="ap-gate-icon"
            href="/"
            aria-label="Leave this screen"
            title="Leave. /vault and /batch build transactions you sign; /verify needs no address."
          >
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden focusable="false">
              <path d="m4.5 4.5 7 7m0-7-7 7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </a>
        </header>

        <ul className="ap-rows ap-gate-rows">
          {rows.map((row) => (
            <li key={row.key}>
              <button
                type="button"
                className="ap-rowline"
                disabled={row.disabled}
                title={row.title}
                onClick={row.onClick}
              >
                {row.icon}
                <span className="ap-wallet-name">{row.name}</span>
                {/* The pill is a CLAIM, and the only one on this card a user acts on.
                    It renders solely for wallets wallet-standard actually reported. */}
                {row.installed ? <span className="ap-badge ap-badge--live">installed</span> : null}
                {busy === row.key ? <span className="ap-row-cue">…</span> : <Chevron />}
              </button>
            </li>
          ))}
        </ul>

        {session.extensionWallets.length === 0 ? (
          <p className="ap-gate-note">
            No wallet extension detected.{' '}
            <a href="https://slush.app" target="_blank" rel="noreferrer">
              Slush
            </a>{' '}
            or{' '}
            <a href="https://phantom.com/download" target="_blank" rel="noreferrer">
              Phantom
            </a>
            , then reload — the list above is whatever your browser actually exposes, which is why
            nothing in it is claiming to be here right now.
          </p>
        ) : null}

        {failure === null ? null : <p className="ap-msg ap-msg--bad">{failure}</p>}
        {session.networkProblem === null ? null : (
          <p className="ap-msg ap-msg--warn">{session.networkProblem}</p>
        )}

        <footer className="ap-gate-foot">
          Connecting identifies you; it grants nothing. Every transaction is signed by you, for you.
        </footer>
      </section>
    </div>
  );
}

export default WalletGate;
