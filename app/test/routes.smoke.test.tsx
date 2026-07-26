// @vitest-environment jsdom
// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F1
// @phase      0
// @status     DONE
// @spec       aphotic.md §13 (limitations are published), §2 (hard constraints)
// @rules      G6 G7 G8
// @depends    ../src/App.tsx · ../src/routes.tsx · ../src/screens/** · ../vitest.config.ts
// @facts      vitest.config.ts PINS every id-bearing VITE_* to ''. This file
// @facts        therefore renders the app in its WORST configuration: no published
// @facts        package, no vault, no batch registry, no Seal committee, no zkLogin
// @facts        credentials, no wallet connected, and the network down. That is the
// @facts        state a fresh clone starts in and the state a mis-set CI project
// @facts        ends in — it must render honestly rather than crash or invent.
// @facts      The landing route is deliberately NOT rendered here: it mounts
// @facts        globe.gl/three against a real WebGL context, which jsdom does not
// @facts        provide. Its data path (readAggregateStats) IS covered below,
// @facts        because that is the part that can lie or throw.
// @implements the "every route renders, unconfigured and offline" safety net
// @forbidden  a network call from any test — a fetch spy fails the suite
// @invariant  1. No screen throws while unconfigured and signed out.
//             2. No screen fetches on mount: every read is click- or session-gated.
//             3. Every route states its unconfigured condition in words rather than
//                offering an enabled control that cannot work.
//             4. readAggregateStats resolves rather than rejecting when offline.
// @ac         /vault /batch /verify all render; the shell names all three.
// @verify     cd app && npm test -- routes
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SuiClientProvider, WalletProvider, createNetworkConfig } from '@mysten/dapp-kit';
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import App from '../src/App';
import { config } from '../src/config';
import BatchScreen from '../src/screens/batch/BatchScreen';
import VaultScreen from '../src/screens/vault/VaultScreen';
import VerifyScreen from '../src/screens/verify/VerifyScreen';

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
  ['Vault', '/vault', <VaultScreen key="v" />],
  ['Batch', '/batch', <BatchScreen key="b" />],
  ['Verify', '/verify', <VerifyScreen key="y" />],
];

describe('every route renders unconfigured, signed out and offline', () => {
  for (const [name, path, element] of SCREENS) {
    it(`${name} renders without throwing and fires no request on mount`, () => {
      const { container } = renderRoute(path, element);
      const text = container.textContent ?? '';
      expect(text.length).toBeGreaterThan(500);
      // Nothing may hit the wire before the user asks for it.
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it(`${name} carries the shell: nav, all three routes and the honesty line`, () => {
      const { container } = renderRoute(path, element);
      const text = container.textContent ?? '';
      expect(container.querySelector('.aphotic-nav')).not.toBeNull();
      expect(text).toMatch(/Vault/);
      expect(text).toMatch(/Batch/);
      expect(text).toMatch(/Verify/);
      // The G8 line rides on every route.
      expect(text).toMatch(/custodial/i);
    });

    it(`${name} states the missing configuration instead of hiding it`, () => {
      const { container } = renderRoute(path, element);
      const text = container.textContent ?? '';
      expect(text).toMatch(/VITE_APHOTIC_PACKAGE_ID/);
      expect(text).toMatch(/inlines/i);
    });

    it(`${name} has no enabled control that cannot complete`, () => {
      const { container } = renderRoute(path, element);
      // Nothing is wired, so the only enabled buttons may be local UI state
      // (the side toggle, the ladders). Anything that would touch chain must be
      // disabled — and every disabled control sits next to a stated reason.
      const enabled = Array.from(container.querySelectorAll('button:not([disabled])'));
      for (const button of enabled) {
        const label = (button.textContent ?? '').toLowerCase();
        expect(
          /submit|deposit|redeem|withdraw|approve|settle|claim/.test(label),
          `enabled button "${button.textContent}" on ${path} looks like it writes to chain`,
        ).toBe(false);
      }
    });

    it(`${name} shows the countdown to the next clearing in the header`, () => {
      const { container } = renderRoute(path, element);
      expect(container.textContent ?? '').toMatch(/to clearing/i);
    });
  }
});

describe('each screen carries its own subject matter', () => {
  it('the vault screen explains the carry and refuses to claim it is running', () => {
    const text = renderRoute('/vault', <VaultScreen />).container.textContent ?? '';
    expect(text).toMatch(/Redemption-carry vault/i);
    expect(text).toMatch(/We are not demonstrating the carry/i);
    expect(text).toMatch(/propose_nav/);
    expect(text).toMatch(/approve_nav/);
  });

  it('the batch screen names the public queue as the leak it routes around', () => {
    const text = renderRoute('/batch', <BatchScreen />).container.textContent ?? '';
    expect(text).toMatch(/public Move object/i);
    expect(text).toMatch(/meaningless/i);
    expect(text).toMatch(/never fall back to plaintext|fall back to plaintext/i);
    expect(text).toMatch(/LINKABLE/);
  });

  it('the verify screen publishes the full clearing rule and the wiring census', () => {
    const text = renderRoute('/verify', <VerifyScreen />).container.textContent ?? '';
    expect(text).toMatch(/Canonical order/i);
    expect(text).toMatch(/largest fractional remainder/i);
    expect(text).toMatch(/What this build points at/i);
    expect(text).toMatch(/not configured/i);
    // The one boundary Move cannot enforce is stated, not dressed up.
    expect(text).toMatch(/at signing, not in Move/i);
  });

  it('the batch screen offers no free-form amount field anywhere', () => {
    const { container } = renderRoute('/batch', <BatchScreen />);
    expect(container.querySelectorAll('input')).toHaveLength(0);
    expect(container.querySelectorAll('textarea')).toHaveLength(0);
  });
});

describe('the landing counters never throw and never invent a number', () => {
  it('resolves with ok:false and a zero supply when the network is down', async () => {
    const { readAggregateStats } = (await import('../src/landing/stats.js')) as {
      readAggregateStats: (nowMs?: number) => Promise<{
        circulating: number;
        circulatingSats: bigint;
        minutesToClearing: number;
        nextCloseMs: number;
        ok: boolean;
      }>;
    };
    const stats = await readAggregateStats(Date.UTC(2026, 6, 26, 12, 0, 0, 0));
    expect(stats.circulating).toBe(0);
    expect(stats.circulatingSats).toBe(0n);
    expect(stats.ok).toBe(false);
    // The countdown needs no network at all, so it stays correct regardless.
    expect(stats.nextCloseMs).toBe(Date.UTC(2026, 6, 26, 18, 0, 0, 0));
    expect(stats.minutesToClearing).toBe(360);
  });
});
