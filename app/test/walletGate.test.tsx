// @vitest-environment jsdom
// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F1
// @phase      0
// @status     DONE
// @spec       aphotic.md §6.1 (what a connected session does NOT grant)
// @rules      G7 G8
// @depends    ../src/components/WalletGate.tsx (F1)
// @facts      THE CLAIM THIS FILE POLICES: WalletGate is a GATE, not a banner.
// @facts        A screen behind it may assume `address` is non-null, so if the
// @facts        gate ever leaked its children while disconnected, every screen's
// @facts        null-handling would be dead code nobody notices is missing.
// @facts      The suite runs with no wallet extension and no Enoki credentials
// @facts        (vitest.config.ts pins every VITE_*), which is exactly the state
// @facts        a first-time visitor arrives in — so this is the real path, not
// @facts        a contrived one.
// @implements the gate's invariants 1 and 3
// @forbidden  a network call — the gate must render offline
// @invariant  1. Children never render while disconnected.
//             2. Both sign-in paths are offered, and a path that cannot work says
//                why on the control rather than only in prose beside it.
//             3. The footer states that connecting grants no capability.
// @ac         with no wallet and no Enoki, the gate renders and explains both.
// @verify     cd app && npm test -- walletGate
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SuiClientProvider, WalletProvider } from '@mysten/dapp-kit';
import { afterEach, describe, expect, it } from 'vitest';

import { WalletGate } from '../src/components/WalletGate';

afterEach(cleanup);

const SECRET = 'SCREEN-BEHIND-THE-GATE';

function renderGate() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <SuiClientProvider networks={{ testnet: { url: 'http://localhost:1' } }} defaultNetwork="testnet">
        <WalletProvider>
          <WalletGate>
            <div>{SECRET}</div>
          </WalletGate>
        </WalletProvider>
      </SuiClientProvider>
    </QueryClientProvider>,
  );
}

describe('<WalletGate/>', () => {
  it('does not render its children while disconnected', () => {
    const { container } = renderGate();
    expect(screen.queryByText(SECRET)).toBeNull();
    // And it rendered SOMETHING — a gate that renders nothing is also a bug,
    // just a quieter one.
    expect((container.textContent ?? '').length).toBeGreaterThan(200);
  });

  it('offers both sign-in paths', () => {
    const text = renderGate().container.textContent ?? '';
    expect(text).toMatch(/browser wallet/i);
    expect(text).toMatch(/sign in with google/i);
  });

  it('names a real wallet to install when none is detected, instead of an empty list', () => {
    const text = renderGate().container.textContent ?? '';
    expect(text).toMatch(/Slush/);
    expect(text).toMatch(/Phantom/);
  });

  it('states on the control itself why Google sign-in is unavailable', () => {
    // The suite pins VITE_ENOKI_API_KEY to '', so the button must be disabled
    // AND carry its reason — a disabled control with no title is a dead end.
    const button = screen.queryByRole('button', { name: /sign in with google/i }) ?? renderGate().getByRole('button', { name: /sign in with google/i });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.getAttribute('title') ?? '').toMatch(/\S/);
  });

  it('says connecting grants no capability over funds', () => {
    const text = renderGate().container.textContent ?? '';
    expect(text).toMatch(/grants nothing/i);
    expect(text).toMatch(/signed by you/i);
    // Never the overclaim.
    expect(text).not.toMatch(/non-custodial wallet/i);
  });
});
