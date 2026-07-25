// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T3.4
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/APP.md §1 (persistent chrome), §2.1 (<ZkLoginButton/>), §7 A1 A8
// @spec       docs/APP.md ERRATA E-A3 (sponsorship changes who PAYS, not who SENDS)
// @rules      G1 G2 G6 G7 G8
// @depends    ../session (T3.3/T3.4) · ../lib/format.ts (T0.4) · ../config.ts (T0.4)
// @depends    ./WalletBar.css (co-located style scope)
// @facts      TWO sign-in paths, ONE session: a browser-extension wallet and the
// @facts        Enoki Google zkLogin wallet are both wallet-standard wallets, so the
// @facts        connected state below is identical for either — only the LABEL
// @facts        differs. The choice is presented explicitly because a user who has
// @facts        no extension must still be able to get in, and a user who has one
// @facts        must not be forced through Google.
// @facts      The hBTC balance shown is the CONNECTED ADDRESS's own coin balance,
// @facts        not the vault's. It settles in one checkpoint — no Bitcoin latency
// @facts        touches this read (G1).
// @facts      NETWORK GUARD: an account advertising chains that do not include
// @facts        `sui:<configured network>` gets a stated reason and a disabled
// @facts        state, never a transaction that fails confusingly later.
// @facts      An unconfigured Enoki app renders its `problems` list; the Google
// @facts        button is disabled WITH the reason beside it (never dead-clickable).
// @implements export function WalletBar(props?: WalletBarProps): JSX.Element
// @forbidden  alert() / a handler that does nothing / a disabled control with no
//             stated reason — the entire point of this component
// @forbidden  calling signIn() outside a click handler (the Enoki popup is blocked)
// @forbidden  implying the session grants any capability over vault funds — G2
// @forbidden  a canonical on-chain id literal here — G7 / A10
// @invariant  1. Every control is either enabled and functional, or disabled with a
//                one-line reason rendered next to it.
//             2. No network request fires before the user connects (G6).
//             3. The full address is always in the DOM/clipboard even when the
//                visible text is truncated.
// @ac         docs/APP.md §7 A1 — sign-in yields a Sui address, derived client-side.
// @verify     cd app && npx tsc --noEmit
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react';

import { config } from '../config';
import { formatBtc, formatSats, truncateMiddle } from '../lib/format';
import { useAphoticSession, useHbtcBalance, type WalletLike } from '../session';

import './WalletBar.css';

export interface WalletBarProps {
  /** Hide the hBTC balance where the surrounding screen already shows it. */
  showBalance?: boolean;
}

/**
 * Explorer account page. The BASE comes from config (G7); only the path segment
 * is literal here, because `lib/explorer.ts` is owned by another unit and adding
 * a second `suiAddressUrl` there would collide.
 */
function accountUrl(address: string): string {
  return `${config.explorers.sui.replace(/\/+$/, '')}/account/${address}`;
}

export function WalletBar({ showBalance = true }: WalletBarProps) {
  const session = useAphoticSession();
  const balance = useHbtcBalance();
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close the chooser on an outside click or Escape. A menu you cannot dismiss
  // is its own kind of dead control.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (event: MouseEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const onGoogle = useCallback(() => {
    setError(null);
    // MUST stay inside the click handler: Enoki opens a popup.
    session.signIn().catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [session]);

  const onPickWallet = useCallback(
    (wallet: WalletLike) => {
      setError(null);
      setMenuOpen(false);
      session.connectWallet(wallet).catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      });
    },
    [session],
  );

  const onCopy = useCallback(() => {
    const address = session.address;
    if (address === null) return;
    void navigator.clipboard?.writeText(address).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      },
      () => setCopied(false),
    );
  }, [session.address]);

  // ── connected ──────────────────────────────────────────────────────────────
  if (session.status === 'connected' && session.address !== null) {
    const address = session.address;
    return (
      <div className="wb" ref={rootRef}>
        <div className="wb-row">
          <div className="wb-id">
            <span
              className={session.onCorrectNetwork ? 'wb-dot' : 'wb-dot wb-dot-warn'}
              aria-hidden="true"
            />
            <span className="wb-provider">{session.providerLabel}</span>
            <button
              type="button"
              className="wb-addr"
              onClick={onCopy}
              title={`${address} — click to copy`}
            >
              {copied ? 'copied' : truncateMiddle(address, 6)}
            </button>
            {showBalance ? <HbtcBalance {...balance} /> : null}
            <a
              className="wb-link"
              href={accountUrl(address)}
              target="_blank"
              rel="noreferrer"
              title="Open this address in the Sui explorer"
            >
              ↗
            </a>
          </div>
          <button type="button" className="wb-btn" onClick={session.signOut}>
            Disconnect
          </button>
        </div>

        {session.networkProblem !== null ? (
          <p className="wb-reason wb-reason-error" role="alert">
            {session.networkProblem}
          </p>
        ) : null}
      </div>
    );
  }

  // ── connecting ─────────────────────────────────────────────────────────────
  if (session.status === 'connecting') {
    return (
      <div className="wb" ref={rootRef}>
        <div className="wb-row">
          <button type="button" className="wb-btn" disabled aria-busy="true">
            Connecting…
          </button>
        </div>
        <p className="wb-reason">Approve the request in the popup your wallet opened.</p>
      </div>
    );
  }

  // ── disconnected / unconfigured ────────────────────────────────────────────
  const googleReason = session.zkLoginDisabledReason;
  const noExtensions = session.extensionWallets.length === 0;

  return (
    <div className="wb" ref={rootRef}>
      <div className="wb-row">
        <button
          type="button"
          className="wb-btn wb-btn-primary"
          onClick={onGoogle}
          disabled={googleReason !== null}
          title={googleReason ?? 'Creates a Sui address from your Google account, in this browser'}
        >
          Sign in with Google
        </button>

        <button
          type="button"
          className="wb-btn"
          onClick={() => setMenuOpen((open) => !open)}
          disabled={noExtensions}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          title={
            noExtensions
              ? 'No Sui wallet extension is installed in this browser'
              : 'Connect an installed Sui wallet'
          }
        >
          Connect wallet
        </button>

        {menuOpen && !noExtensions ? (
          <div className="wb-menu" role="menu">
            {session.extensionWallets.map((wallet) => (
              <button
                key={wallet.name}
                type="button"
                role="menuitem"
                className="wb-menu-item"
                onClick={() => onPickWallet(wallet)}
              >
                {wallet.icon !== undefined ? (
                  <img className="wb-menu-icon" src={wallet.icon} alt="" />
                ) : (
                  <span className="wb-menu-icon" aria-hidden="true" />
                )}
                {wallet.name}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {googleReason !== null ? (
        <p className="wb-reason wb-reason-warn">{googleReason}</p>
      ) : null}

      {noExtensions ? (
        <p className="wb-reason">
          No wallet extension detected — Google sign-in needs none.
        </p>
      ) : null}

      {session.problems.length > 0 ? (
        <details className="wb-details">
          <summary>Why is Google sign-in unavailable?</summary>
          <ul className="wb-problems">
            {session.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </details>
      ) : null}

      {error !== null ? (
        <p className="wb-reason wb-reason-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** hBTC balance of the CONNECTED address. Zero and unknown are different states. */
function HbtcBalance({
  sats,
  isLoading,
  error,
}: {
  sats: bigint | null;
  isLoading: boolean;
  error: string | null;
}) {
  if (error !== null) {
    return (
      <span className="wb-balance wb-balance-muted" title={error}>
        hBTC —
      </span>
    );
  }
  if (isLoading || sats === null) {
    return (
      <span className="wb-balance wb-balance-muted" title="Reading the coin balance">
        hBTC …
      </span>
    );
  }
  return (
    <span
      className="wb-balance"
      title={`${formatBtc(sats)} — hBTC is a fungible Coin<BTC>; this balance settles in one checkpoint`}
    >
      {formatSats(sats)}
    </span>
  );
}

export default WalletBar;
