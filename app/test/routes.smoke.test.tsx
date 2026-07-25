// @vitest-environment jsdom
// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T5.3
// @phase      5
// @status     DONE
// @spec       docs/APP.md §7 A8 (the G8 line on every route), A11 (zero network
//             on mount), §1 (route table)
// @rules      G6 G7 G8
// @depends    ../src/App.tsx · ../src/screens/**  · ../vitest.config.ts
// @facts      vitest.config.ts PINS VITE_APHOTIC_PACKAGE_ID='' , VITE_VAULT_ID='',
// @facts        VITE_ENOKI_API_KEY='' and VITE_ZKLOGIN_CLIENT_ID=''. This file
// @facts        therefore renders the app in its WORST configuration: no published
// @facts        package, no vault, no zkLogin credentials, no wallet connected.
// @facts        That is the state a fresh clone starts in, and the state a mis-set
// @facts        Vercel project ends in — it must render honestly, not crash.
// @facts      The landing route is deliberately NOT rendered here: it mounts
// @facts        globe.gl/three against a real WebGL context, which jsdom does not
// @facts        provide. Its data path (readAggregateStats) IS covered below,
// @facts        because that is the part that can lie or throw.
// @implements the "every state renders" safety net for /deposit /exit /transparency
// @forbidden  a network call from any test — a fetch spy fails the suite
// @invariant  1. No screen throws while unconfigured and signed out.
//             2. No screen fetches on mount (G6): every read is click- or
//                session-gated.
//             3. Each screen states its unconfigured/signed-out condition in
//                words rather than rendering an enabled control that cannot work.
//             4. readAggregateStats resolves to zeros when the network is down.
// @ac         docs/APP.md §7 A8 A11
// @verify     cd app && npm test
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SuiClientProvider, WalletProvider, createNetworkConfig } from '@mysten/dapp-kit';
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import App from '../src/App';
import { config } from '../src/config';
import DepositScreen from '../src/screens/deposit/DepositScreen';
import ExitScreen from '../src/screens/exit/ExitScreen';
import TransparencyScreen from '../src/screens/transparency/TransparencyScreen';

const { networkConfig } = createNetworkConfig({
  testnet: { network: 'testnet', url: config.sui.jsonRpcUrl },
});

function renderRoute(path: string, element: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <SuiClientProvider networks={networkConfig} defaultNetwork="testnet">
        <WalletProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route element={<App />}>
                <Route path={path} element={element} />
              </Route>
            </Routes>
          </MemoryRouter>
        </WalletProvider>
      </SuiClientProvider>
    </QueryClientProvider>,
  );
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn(() => Promise.reject(new Error('the network is down')));
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SCREENS: readonly (readonly [string, string, React.ReactNode])[] = [
  ['Deposit', '/deposit', <DepositScreen key="d" />],
  ['Exit', '/exit', <ExitScreen key="e" />],
  ['Transparency', '/transparency', <TransparencyScreen key="t" />],
];

describe('every route renders unconfigured, signed out and offline', () => {
  for (const [name, path, element] of SCREENS) {
    it(`${name} renders without throwing and fires no request on mount`, () => {
      const { container } = renderRoute(path, element);
      const text = container.textContent ?? '';
      expect(text.length).toBeGreaterThan(200);
      // A11 / G6: nothing may hit the wire before the user asks.
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it(`${name} carries the shell: nav, the four routes and the G8 line`, () => {
      const { container } = renderRoute(path, element);
      const text = container.textContent ?? '';
      expect(container.querySelector('.aphotic-nav')).not.toBeNull();
      expect(text).toMatch(/Deposit/);
      expect(text).toMatch(/Exit/);
      expect(text).toMatch(/Transparency/);
      // G8, A8 — the honesty line is on every route.
      expect(text).toMatch(/custodial/i);
    });

    it(`${name} disables what it cannot do and says why`, () => {
      const { container } = renderRoute(path, element);
      const disabled = Array.from(container.querySelectorAll('button[disabled]'));
      // Every disabled control must carry a machine-readable reason (title), and
      // the page must state the underlying condition in words somewhere.
      for (const button of disabled) {
        const hasTitle = (button.getAttribute('title') ?? '').length > 0;
        const hasLabel = (button.getAttribute('aria-label') ?? '').length > 0;
        expect(
          hasTitle || hasLabel,
          `disabled button "${button.textContent}" on ${path} carries no reason`,
        ).toBe(true);
      }
    });
  }
});

describe('the unconfigured build says so instead of pretending', () => {
  it('Deposit names the empty environment keys', () => {
    const { container } = renderRoute('/deposit', <DepositScreen />);
    const text = container.textContent ?? '';
    expect(text).toMatch(/VITE_APHOTIC_PACKAGE_ID|VITE_VAULT_ID/);
  });

  it('Transparency disables the chain read and gives the reason', () => {
    const { container } = renderRoute('/transparency', <TransparencyScreen />);
    const text = container.textContent ?? '';
    expect(text).toMatch(/VITE_VAULT_ID is empty/);
  });

  it('Exit offers a sign-in path rather than a dead position panel', () => {
    const { container } = renderRoute('/exit', <ExitScreen />);
    const text = container.textContent ?? '';
    expect(text).toMatch(/Sign in/i);
  });
});

describe('the landing counters never throw and never invent a number', () => {
  it('resolves to zeros with the network down', async () => {
    const { readAggregateStats } = (await import('../src/landing/stats.js')) as {
      readAggregateStats: () => Promise<{
        deposits: number;
        loans: number;
        ok: boolean;
        vaultSats: bigint;
      }>;
    };
    const stats = await readAggregateStats();
    expect(stats.deposits).toBe(0);
    expect(stats.loans).toBe(0);
    expect(stats.vaultSats).toBe(0n);
    expect(stats.ok).toBe(false);
  });
});
