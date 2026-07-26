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

  return (
    <div className="ap-gate">
      <section className="ap-card ap-gate-card">
        <header className="ap-gate-head">
          <h1 className="ap-gate-title">Connect a wallet</h1>
          <p className="ap-gate-sub">
            {purpose ?? 'Aphotic needs an address before it can build a transaction for you.'}
          </p>
        </header>

        <div className="ap-gate-body">
          <div className="ap-gate-section">
            <span className="ap-label">Browser wallet</span>
            {session.extensionWallets.length === 0 ? (
              <p className="ap-gate-empty">
                No wallet extension detected in this browser. Install{' '}
                <a href="https://slush.app" target="_blank" rel="noreferrer">
                  Slush
                </a>{' '}
                or{' '}
                <a href="https://phantom.com/download" target="_blank" rel="noreferrer">
                  Phantom
                </a>
                , then reload — this list is whatever your browser actually exposes, so a wallet
                only appears once it is installed.
              </p>
            ) : (
              <ul className="ap-wallet-list">
                {session.extensionWallets.map((wallet) => (
                  <li key={wallet.name}>
                    <button
                      type="button"
                      className="ap-wallet-row"
                      disabled={connecting}
                      title={connecting ? 'A connection is already in progress' : `Connect ${wallet.name}`}
                      onClick={() => void run(wallet.name, () => session.connectWallet(wallet))}
                    >
                      <WalletIcon wallet={wallet} />
                      <span className="ap-wallet-name">{wallet.name}</span>
                      <span className="ap-wallet-cue" aria-hidden>
                        {busy === wallet.name ? '…' : '→'}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="ap-gate-rule">
            <span>or</span>
          </div>

          <div className="ap-gate-section">
            <span className="ap-label">No wallet</span>
            <button
              type="button"
              className="ap-btn ap-btn--primary ap-btn--block"
              disabled={connecting || !session.googleAvailable}
              title={
                session.zkLoginDisabledReason ??
                (connecting
                  ? 'A connection is already in progress'
                  : 'Opens a Google popup; your Sui address is derived from the login, client-side')
              }
              onClick={() => void run('google', session.signIn)}
            >
              {busy === 'google' ? 'Opening Google…' : 'Sign in with Google'}
            </button>
            <p className="ap-gate-note">
              zkLogin derives a Sui address from your Google login in the browser. Google never sees
              a key and never learns your address, and Aphotic never holds one either.
            </p>
            {session.problems.length === 0 ? null : (
              <ul className="ap-gate-problems">
                {session.problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {failure === null ? null : <p className="ap-msg ap-msg--bad">{failure}</p>}
        {session.networkProblem === null ? null : (
          <p className="ap-msg ap-msg--warn">{session.networkProblem}</p>
        )}

        <footer className="ap-gate-foot">
          Connecting identifies you; it grants nothing. Every Aphotic transaction is signed by you,
          for you, and no key held here can move another depositor&rsquo;s funds.
        </footer>
      </section>
    </div>
  );
}

export default WalletGate;
