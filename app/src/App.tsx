// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.4, T5.3
// @phase      0 / 5
// @status     DONE
// @spec       docs/APP.md §1 (route table), §7 A8 (disclosure reachable everywhere)
// @spec       docs/GOLDEN-RULES.md G6 G8
// @rules      G6 G8
// @depends    ./components (T0.4) · ./config.ts (T0.4) · ./theme.css (T0.4)
// @facts      Route table (adapted — "/" is the landing page, not a redirect):
// @facts        /              landing (React.lazy, owned by the landing unit)
// @facts        /deposit       Screen 1   (T3.1, T3.3)
// @facts        /exit          Screen 2   (T3.2)
// @facts        /transparency  Screen 3   (T5.2)
// @facts      The landing route renders WITHOUT the app chrome (it is a full-bleed
// @facts        hero with its own nav) but STILL carries <TrustModelDisclosure/> —
// @facts        A8 requires the G8 line on every route, including "/".
// @facts      <WalletBar/> lives in the SHELL, not per screen: one session, one
// @facts        connect affordance, visible from every app route. The screens keep
// @facts        their own in-flow sign-in panels because a signed-out user should
// @facts        not have to hunt in the header for the thing the page is asking for.
// @facts      The mode chip states what the data actually is. VITE_DEMO_MODE=mock
// @facts        means fixtures; `live` means the screens read chain. Neither claims
// @facts        the Bitcoin leg is live — it never is (G6).
// @implements export function App(): JSX.Element
// @forbidden  omitting <TrustModelDisclosure/> on any route — G8, A8
// @forbidden  a canonical id literal here — G7
// @forbidden  app chrome over the landing route — it is full-bleed by design
// @invariant  1. <TrustModelDisclosure/> renders on every route.
// @invariant  2. The demo-mode indicator states plainly when data is pre-staged (G6).
// @invariant  3. Every header control is functional or disabled with a stated
//                reason — <WalletBar/> owns that contract for the session controls.
// @ac         docs/APP.md §7 A8 A11
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';

import { TrustModelDisclosure, WalletBar } from './components';
import { config, isMock } from './config';

const NAV = [
  { to: '/deposit', label: 'Deposit' },
  { to: '/exit', label: 'Exit' },
  { to: '/transparency', label: 'Transparency' },
] as const;

/** What the numbers on screen actually are. Never dressed up (G6). */
function ModeChip() {
  const mock = isMock();
  return (
    <span
      className={mock ? 'ap-chip ap-chip--warn' : 'ap-chip ap-chip--live'}
      title={
        mock
          ? 'Balances, the vault, the book and the journal are read live from Sui testnet on every screen. VITE_DEMO_MODE=mock, so the decision log and the bridge event stream are the pre-staged samples — each says so where it is rendered. The Bitcoin leg is never live: ~70 min in, ~1.5–2 h out.'
          : 'VITE_DEMO_MODE=live — every panel reads Sui testnet directly. The Bitcoin leg is still pre-staged: ~70 min in, ~1.5–2 h out, never live in a demo.'
      }
    >
      <span className="ap-chip-dot" aria-hidden="true" />
      {config.sui.network} · {mock ? 'live reads · staged log' : 'live reads'}
    </span>
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
            <button
              type="button"
              className="ap-btn"
              onClick={() => this.setState({ error: null })}
            >
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
            <ModeChip />
            <WalletBar />
          </div>
        </header>
      )}

      <main className="aphotic-main">
        <ScreenBoundary key={pathname}>
          <Outlet />
        </ScreenBoundary>
      </main>

      <TrustModelDisclosure variant="line" />
    </div>
  );
}

export default App;
