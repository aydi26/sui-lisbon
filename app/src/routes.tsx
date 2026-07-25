// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.4
// @phase      0
// @status     DONE
// @spec       docs/APP.md §1 (route table, L45-L52) — adapted: "/" is the landing
// @spec       docs/RECON.md R13 (landing page source + its heavy deps)
// @rules      G7 G8
// @depends    ./App.tsx (T0.4) · ./screens/** (T3.1 T3.2 T5.2)
//             ./landing/LandingPage.jsx — OWNED BY THE LANDING-PAGE UNIT
// @facts      ⚠ src/landing/** is NOT owned by this unit and is EXCLUDED from
// @facts        typechecking (tsconfig "exclude"). It is ported verbatim as .jsx.
// @facts        Until that unit lands the file, `npm run build` fails with
// @facts        "Could not resolve ./landing/LandingPage.jsx" — EXPECTED, and the
// @facts        only acceptable build failure here.
// @facts      ⚠ The landing page pulls three (~0.18.x) + globe.gl (~2.45.x). It is
// @facts        ALWAYS React.lazy'd, and vite.config.ts splits those packages into
// @facts        a separate 'globe' chunk, so /deposit never downloads the hero.
// @implements export function AppRoutes(): JSX.Element
// @forbidden  a STATIC import of anything under ./landing — it must stay lazy
// @forbidden  a canonical id literal here — G7
// @invariant  1. All four routes are children of <App/>, so <TrustModelDisclosure/>
//                renders on every one of them (A8).
// @invariant  2. Unknown paths redirect to "/" rather than 404-ing mid-demo.
// @ac         docs/APP.md §7 A8 A11
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import App from './App';
import DepositScreen from './screens/deposit/DepositScreen';
import ExitScreen from './screens/exit/ExitScreen';
import TransparencyScreen from './screens/transparency/TransparencyScreen';

const LandingPage = lazy(
  // @ts-ignore — created by the landing-page unit; src/landing is excluded from
  // typechecking (tsconfig allowJs/checkJs:false + exclude). Resolves at build time.
  () => import('./landing/LandingPage.jsx'),
);

function LandingFallback() {
  return (
    <div className="aphotic-container" style={{ color: 'var(--text-muted)' }}>
      Loading…
    </div>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<App />}>
        <Route
          index
          element={
            <Suspense fallback={<LandingFallback />}>
              <LandingPage />
            </Suspense>
          }
        />
        <Route path="deposit" element={<DepositScreen />} />
        <Route path="exit" element={<ExitScreen />} />
        <Route path="transparency" element={<TransparencyScreen />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export default AppRoutes;
