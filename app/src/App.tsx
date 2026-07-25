// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.4
// @phase      0
// @status     DONE
// @spec       docs/APP.md §1 (route table), §7 A8 (disclosure reachable everywhere)
// @spec       docs/GOLDEN-RULES.md G8
// @rules      G8
// @depends    ./components (T0.4) · ./config.ts (T0.4) · ./theme.css (T0.4)
// @facts      Route table (adapted — "/" is the landing page, not a redirect):
// @facts        /              landing (React.lazy, owned by the landing unit)
// @facts        /deposit       Screen 1   (T3.1, T3.3)
// @facts        /exit          Screen 2   (T3.2)
// @facts        /transparency  Screen 3   (T5.2)
// @facts      The landing route renders WITHOUT the app nav (it is a full-bleed
// @facts        hero) but STILL carries <TrustModelDisclosure/> — A8 requires the
// @facts        G8 line on every route, including "/".
// @implements export function App(): JSX.Element
// @forbidden  omitting <TrustModelDisclosure/> on any route — G8, A8
// @forbidden  a canonical id literal here — G7
// @invariant  1. <TrustModelDisclosure/> renders on every route.
// @invariant  2. The demo-mode indicator states plainly when data is pre-staged (G6).
// @ac         docs/APP.md §7 A8 A11
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { NavLink, Outlet, useLocation } from 'react-router-dom';

import { TrustModelDisclosure } from './components';
import { config } from './config';

const NAV = [
  { to: '/deposit', label: 'Deposit' },
  { to: '/exit', label: 'Exit' },
  { to: '/transparency', label: 'Transparency' },
] as const;

export function App() {
  const { pathname } = useLocation();
  const isLanding = pathname === '/';

  return (
    <div className="aphotic-shell">
      {isLanding ? null : (
        <nav className="aphotic-nav">
          <NavLink to="/" className="aphotic-wordmark">
            Aphotic
          </NavLink>
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} className="aphotic-navlink">
              {item.label}
            </NavLink>
          ))}
          <span
            style={{
              marginLeft: 'auto',
              color: config.demoMode === 'mock' ? 'var(--amber)' : 'var(--green)',
              fontSize: 'var(--text-xs)',
              letterSpacing: 'var(--tracking-wide)',
              textTransform: 'uppercase',
            }}
            title={
              config.demoMode === 'mock'
                ? 'Deterministic fixtures. Zero signet, zero RPC.'
                : 'Live adapters. The Bitcoin leg is still pre-staged — it is never live-demoable.'
            }
          >
            {config.demoMode === 'mock' ? 'mock data' : 'live · BTC leg pre-staged'}
          </span>
        </nav>
      )}

      <main className="aphotic-main">
        <Outlet />
      </main>

      <TrustModelDisclosure variant="line" />
    </div>
  );
}

export default App;
