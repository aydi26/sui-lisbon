// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F1
// @phase      0
// @status     DONE
// @spec       aphotic.md §1 (the two products), §7 (mechanisms)
// @rules      G7 G8
// @depends    ./App.tsx (F1) · ./screens/vault (F2) · ./screens/batch (F3)
//             ./screens/verify (F4) · ./landing/LandingPage.jsx (landing unit)
// @facts      FOUR routes, landed together so three parallel units can fill their
// @facts        own screen directory without any of them editing this file:
// @facts          /        landing — kept verbatim from the ported hero
// @facts          /vault   redemption-carry vault (F2)
// @facts          /batch   sealed-order batch auction (F3)
// @facts          /verify  recompute-it-yourself surface (F4)
// @facts      ⚠ src/landing/** is EXCLUDED from typechecking (tsconfig "exclude")
// @facts        and is ported as .jsx on purpose. It is ALWAYS React.lazy'd:
// @facts        vite.config.ts splits three + globe.gl into a 'globe' chunk, so
// @facts        /vault never downloads the hero.
// @implements export function AppRoutes(): JSX.Element
// @forbidden  a STATIC import of anything under ./landing — it must stay lazy
// @forbidden  a canonical id literal here — G7
// @forbidden  a fifth route added without the nav in App.tsx — they must agree
// @invariant  1. All four routes are children of <App/>, so the trust disclosure
//                and the config banner render on every one of them.
// @invariant  2. Unknown paths redirect to "/" rather than 404-ing mid-demo.
// @ac         every route renders without a wallet and without a published package.
// @verify     cd app && npm test -- routes
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import App from './App';
import { WalletGate } from './components';
import BatchScreen from './screens/batch/BatchScreen';
import DocsScreen from './screens/docs/DocsScreen';
import VaultScreen from './screens/vault/VaultScreen';
import VerifyScreen from './screens/verify/VerifyScreen';

const LandingPage = lazy(
  // @ts-ignore — owned by the landing unit; src/landing is excluded from
  // typechecking (allowJs + checkJs:false + exclude). Resolves at build time.
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
        {/* /vault and /batch build transactions, so they sit behind the connect
            gate. /verify deliberately does NOT: it recomputes published state and
            proves fills against a public root, and demanding a wallet to check
            someone else's arithmetic would defeat the point of shipping it. */}
        <Route
          path="vault"
          element={
            <WalletGate purpose="Depositing and redeeming are requests you sign yourself. Connect the address they should settle to.">
              <VaultScreen />
            </WalletGate>
          }
        />
        <Route
          path="batch"
          element={
            <WalletGate purpose="Orders are encrypted in your browser and drawn against your own internal balance. Connect the address that holds it.">
              <BatchScreen />
            </WalletGate>
          }
        />
        <Route path="verify" element={<VerifyScreen />} />
        <Route path="docs" element={<DocsScreen />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export default AppRoutes;
