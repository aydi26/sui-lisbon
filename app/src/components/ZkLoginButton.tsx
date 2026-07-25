// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T3.3
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/APP.md §2.1 (<ZkLoginButton/>), §2.4, §7 A1
// @spec       docs/BUILD-PLAN.md Phase 3 T3.3
// @spec       docs/APP.md ERRATA E-A3 (sponsorship changes who PAYS, not who SENDS)
// @rules      G2 G6 G7 G8
// @depends    ../session/useSession.ts (T3.3) · ../session/enoki.ts (T3.3)
// @depends    ./ZkLoginButton.css (co-located style scope) · ../lib/format.ts
// @facts      Sign-in = CONNECTING to the Enoki Google wallet-standard wallet.
// @facts        Enoki opens a popup ⇒ signIn() MUST run from a real user gesture
// @facts        (a click handler), never from an effect or on mount.
// @facts      SessionStatus ∈ 'unconfigured' | 'disconnected' | 'connecting' | 'connected'
// @facts      'unconfigured' is the CURRENT STATE of this deployment: the Enoki
// @facts        api key is valid but the Enoki app has no auth provider and no
// @facts        allow-listed origin registered yet. The button must therefore
// @facts        render the concrete setup steps, never a dead control.
// @facts      Gas sponsorship is server-side (the Enoki app's gas pool). It changes
// @facts        who PAYS; the SENDER is always the user's own zkLogin address.
// @facts        That is exactly why a sponsored reclaim still satisfies Hashi's
// @facts        `request.sender == ctx.sender()` assert. (ERRATA E-A3)
// @facts      A disabled CTA ALWAYS carries `zkLoginDisabledReason` beside it, and
// @facts        when the wallet is on the wrong network the connected block states
// @facts        that instead of letting a later transaction fail confusingly.
// @implements export function ZkLoginButton(props: ZkLoginButtonProps): JSX.Element
//             export function EnokiSetupPanel(props: EnokiSetupPanelProps): JSX.Element
//             export function SponsorshipNote(): JSX.Element
// @forbidden  calling signIn() outside a click handler — the popup gets blocked
// @forbidden  a disabled button with no explanation — the problems list renders
//             instead, so a misconfiguration is visible rather than silent
// @forbidden  implying a session grants any capability over vault funds — G2
// @forbidden  a canonical id literal here — G7 / A10
// @invariant  1. When status === 'unconfigured' the component renders the problems
//                list and NO sign-in affordance that could throw on click.
//             2. A thrown signIn() surfaces its message inline; it never crashes
//                the screen and never leaves the button stuck in 'connecting'.
//             3. No network request is issued until the user clicks (G6).
// @ac         docs/APP.md §7 A1 — sign-in yields a Sui address, derived client-side.
// @verify     cd app && npx tsc --noEmit
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { useCallback, useState } from 'react';

import { truncateMiddle } from '../lib/format';
import { useAphoticSession } from '../session/useSession';

import './ZkLoginButton.css';

export interface ZkLoginButtonProps {
  /** Button label for the signed-out state. */
  label?: string;
  /** Rendered under the button when signed out. */
  hint?: string;
}

/**
 * The whole sign-in affordance: Google zkLogin via Enoki, plus the honest
 * degraded states. Drives itself from `useAphoticSession()` so a screen only has
 * to drop it in.
 */
export function ZkLoginButton({
  label = 'Continue with Google',
  hint,
}: ZkLoginButtonProps) {
  const {
    status,
    address,
    problems,
    providerLabel,
    networkProblem,
    zkLoginDisabledReason,
    extensionWallets,
    signIn,
    signOut,
  } = useAphoticSession();
  const [error, setError] = useState<string | null>(null);

  // MUST stay a click handler — Enoki opens a popup and browsers block popups
  // that are not tied to a user gesture.
  const onSignIn = useCallback(() => {
    setError(null);
    signIn().catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [signIn]);

  if (status === 'unconfigured') {
    return <EnokiSetupPanel problems={problems} />;
  }

  if (status === 'connected' && address !== null) {
    return (
      <div className="zk-signin">
        <div className="zk-signedin">
          <div className="zk-signedin-id">
            <span className="zk-eyebrow">Signed in · {providerLabel}</span>
            <span className="aphotic-mono" title={address}>
              {truncateMiddle(address, 10)}
            </span>
          </div>
          <button type="button" className="zk-ghost" onClick={signOut}>
            Sign out
          </button>
        </div>
        {networkProblem !== null ? (
          <p className="zk-error" role="alert">
            {networkProblem}
          </p>
        ) : null}
      </div>
    );
  }

  const connecting = status === 'connecting';
  // A disabled CTA always carries its reason — never a silent grey button.
  const blocked = connecting ? null : zkLoginDisabledReason;

  return (
    <div className="zk-signin">
      <button
        type="button"
        className="zk-cta"
        onClick={onSignIn}
        disabled={connecting || blocked !== null}
        aria-busy={connecting}
        title={blocked ?? undefined}
      >
        {connecting ? 'Opening Google…' : label}
      </button>
      {blocked !== null ? (
        <p className="zk-error">
          {blocked}
          {extensionWallets.length > 0
            ? ' Use “Connect wallet” in the header to sign in with your browser wallet instead.'
            : ''}
        </p>
      ) : null}
      {hint ? <p className="zk-hint">{hint}</p> : null}
      {error !== null ? (
        <p className="zk-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export interface EnokiSetupPanelProps {
  problems: readonly string[];
}

/**
 * What renders when Enoki cannot start. The point is that a operator can fix it
 * from this panel alone — a greyed-out button teaches nobody anything.
 */
export function EnokiSetupPanel({ problems }: EnokiSetupPanelProps) {
  return (
    <section className="zk-setup" role="note">
      <span className="zk-eyebrow zk-eyebrow-warn">zkLogin unavailable — setup incomplete</span>
      <p className="zk-setup-lede">
        Sign-in is disabled because the Enoki app backing zkLogin is not finished being
        registered. Nothing is broken on-chain; the browser simply has no OAuth provider to
        talk to.
      </p>

      {problems.length > 0 ? (
        <ul className="zk-problems">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : null}

      <ol className="zk-steps">
        <li>
          Open <span className="aphotic-mono">portal.enoki.mystenlabs.com</span> and select this
          app.
        </li>
        <li>
          Under <strong>Auth Providers</strong>, add <strong>Google</strong> and paste the Google
          OAuth 2.0 <em>Web</em> client id. The client SECRET stays server-side and never reaches
          this app.
        </li>
        <li>
          Under <strong>Allowed Origins</strong>, add the exact origin this page is served from
          (scheme + host + port). A mismatch returns <code>redirect_uri_mismatch</code>.
        </li>
        <li>
          Mirror the same origin in the Google Cloud console as an authorised JavaScript origin
          and redirect URI.
        </li>
        <li>
          Set <code>VITE_ENOKI_API_KEY</code> (the PUBLIC key) and{' '}
          <code>VITE_ZKLOGIN_CLIENT_ID</code> in <code>app/.env.local</code>, then restart Vite.
        </li>
      </ol>

      <p className="zk-setup-foot">
        Everything else on this page keeps working. The deposit address is derived from the
        on-chain Hashi keys and your Sui address — sign-in only supplies that address.
      </p>
    </section>
  );
}

/** G2/E-A3 copy. Sponsorship changes who PAYS, never who the SENDER is. */
export function SponsorshipNote() {
  return (
    <p className="zk-sponsor">
      <strong>You need zero SUI.</strong> Enoki sponsors the gas for the transactions this app
      builds. Sponsorship changes who <em>pays</em>, never who the <em>sender</em> is — every
      transaction is still sent, and signed, by your own zkLogin address. Custody of your shares
      and the right to cancel your own exit stay with you.
    </p>
  );
}

export default ZkLoginButton;
