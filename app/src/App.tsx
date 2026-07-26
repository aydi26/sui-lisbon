// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F1
// @phase      0
// @status     DONE
// @spec       aphotic.md §1 (the two products), §13 (limitations are published)
// @spec       docs/DESIGN-V2.md §4 (cadence in the header)
// @rules      G6 G7 G8
// @depends    ./components (F1) · ./config.ts (F1) · ./session (kept) · ./theme.css
// @facts      Route table — the landing page renders WITHOUT the app chrome (it is
// @facts        a full-bleed hero with its own nav) but STILL carries the trust
// @facts        disclosure. Every other route gets the frame:
// @facts          /        landing
// @facts          /vault   redemption-carry vault
// @facts          /batch   sealed-order batch auction
// @facts          /verify  recompute it yourself
// @facts      <WalletBar/> lives in the SHELL, not per screen: one session, one
// @facts        connect affordance, visible from every app route. Both sign-in
// @facts        paths (browser extension and Enoki zkLogin) are wallet-standard
// @facts        wallets, so there is exactly one session object behind it.
// @facts      ⚠⚠ VITE_* IS INLINED AT BUILD TIME. A var missing from the build
// @facts        environment yields "" in the bundle with no runtime error, so the
// @facts        shell renders configProblems() at the top of every app route. It is
// @facts        deliberately NOT rendered over the landing hero, which has no
// @facts        controls that could mislead; main.tsx logs it to the console on
// @facts        every load regardless.
// @facts      NETWORK GUARD: an account that positively advertises a chain other
// @facts        than sui:<configured network> gets a banner and every write is
// @facts        disabled with a stated reason, rather than failing confusingly
// @facts        inside the wallet. An EMPTY chains list means the wallet declined
// @facts        to say — we do not guess.
// @implements export function App(): JSX.Element
// @forbidden  omitting <TrustModelDisclosure/> on any route — G8
// @forbidden  a canonical id literal here — G7
// @forbidden  app chrome over the landing route — it is full-bleed by design
// @invariant  1. <TrustModelDisclosure/> renders on every route.
// @invariant  2. A blocking config problem is stated on screen before any screen
//                offers a control that depends on it.
// @invariant  3. A screen that throws never blanks the app — the nav survives.
// @ac         all four routes render with no wallet and no published package.
// @verify     cd app && npm test -- routes
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';

import { EpochClock, TrustModelDisclosure, WalletBar } from './components';
import { config, configProblems } from './config';
import { useAphoticSession } from './session';

const NAV = [
  { to: '/vault', label: 'Vault' },
  { to: '/batch', label: 'Batch' },
  { to: '/verify', label: 'Verify' },
] as const;

/**
 * What this build is actually wired to. Rendered rather than logged, because a
 * missing `VITE_*` produces an empty string in the bundle and no error at all —
 * the failure mode is a screen full of controls that quietly cannot work.
 */
function ConfigBanner() {
  const problems = configProblems();
  if (problems.length === 0) return null;

  const blocking = problems.filter((p) => p.severity === 'blocking');
  const degraded = problems.filter((p) => p.severity === 'degraded');

  return (
    <div
      className={blocking.length > 0 ? 'ap-state ap-state--error' : 'ap-state'}
      role="status"
      style={{ marginBottom: 'var(--space-5)' }}
    >
      <span className="ap-state-title">
        {blocking.length > 0
          ? `This build is not wired to a deployed package (${blocking.length} required ${
              blocking.length === 1 ? 'value' : 'values'
            } missing)`
          : `${degraded.length} optional ${degraded.length === 1 ? 'value is' : 'values are'} unset`}
      </span>
      <p className="ap-reason" style={{ margin: 0 }}>
        Vite inlines <code>VITE_*</code> at build time, so a value missing from the build
        environment becomes an empty string in the bundle — there is no runtime error to catch.
        Nothing below is faked to cover for it: panels that need one of these say so.
      </p>
      <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
        {problems.map((p) => (
          <li key={p.key} className="aphotic-muted" style={{ fontSize: 'var(--text-xs)' }}>
            <code>{p.key}</code> — {p.effect}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The network guard, stated once at the shell rather than per screen. */
function NetworkGuard() {
  const session = useAphoticSession();
  if (session.networkProblem === null) return null;
  return (
    <div className="ap-state ap-state--error" role="alert" style={{ marginBottom: 'var(--space-5)' }}>
      <span className="ap-state-title">Wrong network</span>
      <p style={{ margin: 0 }}>{session.networkProblem}</p>
      <p className="ap-reason" style={{ margin: 0 }}>
        Every write is disabled while this is showing. Switch the wallet to {config.sui.network} and
        reconnect.
      </p>
    </div>
  );
}

/**
 * A screen that throws must not blank the app. React unmounts the whole tree on
 * an unhandled render error, which during a demo looks exactly like a dead
 * product — so the shell catches it, states what broke, and keeps the nav alive.
 */
class ScreenBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // Console, not a toast: the operator needs the stack, the user needs the line.
    console.error('Aphotic screen crashed', error, info.componentStack);
  }

  override render() {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return (
      <div className="ap-page">
        <div className="ap-state ap-state--error" role="alert">
          <span className="ap-state-title">This screen failed to render</span>
          <p style={{ margin: 0 }}>{error.message}</p>
          <p className="ap-reason">
            Nothing on chain is affected by a rendering failure — no transaction was built or sent.
            The other routes above still work.
          </p>
          <div className="ap-row">
            <button type="button" className="ap-btn" onClick={() => this.setState({ error: null })}>
              Try rendering it again
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export function App() {
  const { pathname } = useLocation();
  const isLanding = pathname === '/';

  return (
    <div className="aphotic-shell">
      {isLanding ? null : (
        <header className="aphotic-nav">
          <NavLink to="/" className="aphotic-wordmark" title="Back to the landing page">
            <img className="aphotic-mark" src="/logos/aphotic-mark.svg" alt="" aria-hidden="true" />
            <span>Aphotic</span>
          </NavLink>

          <nav className="aphotic-navlinks" aria-label="Application">
            {NAV.map((item) => (
              <NavLink key={item.to} to={item.to} className="aphotic-navlink">
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="aphotic-nav-right">
            <EpochClock variant="inline" />
            <span className="ap-chip" title={`Reads and writes target Sui ${config.sui.network}.`}>
              <span className="ap-chip-dot" aria-hidden="true" />
              {config.sui.network}
            </span>
            <WalletBar showBalance={false} />
          </div>
        </header>
      )}

      <main className="aphotic-main">
        {isLanding ? null : (
          <div className="aphotic-container" style={{ paddingTop: 'var(--space-5)' }}>
            <ConfigBanner />
            <NetworkGuard />
          </div>
        )}
        <ScreenBoundary key={pathname}>
          <Outlet />
        </ScreenBoundary>
      </main>

      <TrustModelDisclosure variant="line" />
    </div>
  );
}

export default App;
