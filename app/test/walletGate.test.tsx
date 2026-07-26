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
//             4. The "installed" pill is claimed for DETECTED wallets only. With
//                no extension present no badge may read it — that pill is the one
//                thing on the card a user acts on.
//             5. The help note opens on a click and never on mount: Enoki's popup
//                is blocked unless the gesture is the user's.
// @ac         with no wallet and no Enoki, the gate renders and explains both.
// @verify     cd app && npm test -- walletGate
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

  it('carries the connect-card head: help, a centred title, a way out', () => {
    const { container, getByRole } = renderGate();
    expect(getByRole('heading', { name: /connect wallet/i })).not.toBeNull();
    // The dismiss affordance is a LINK, not a button: this is a gate, and the
    // only honest "close" is going somewhere that does not need an address.
    const leave = getByRole('link', { name: /leave this screen/i });
    expect(leave.getAttribute('href')).toBe('/');
    expect(container.querySelector('.ap-gate-head')).not.toBeNull();
  });

  it('never labels a wallet "installed" when none is detected', () => {
    const { container } = renderGate();
    // The suite runs with no extension, so the success pill must appear nowhere
    // and no pill may READ "installed" — the prose may explain the word, a badge
    // may not claim it.
    expect(container.querySelector('.ap-badge--live')).toBeNull();
    const pills = Array.from(container.querySelectorAll('.ap-badge')).map(
      (p) => (p.textContent ?? '').trim().toLowerCase(),
    );
    expect(pills).not.toContain('installed');
    expect(pills).toContain('not detected');
  });

  it('offers the undetected wallets as install links, in the row shape', () => {
    const { getByRole } = renderGate();
    for (const name of ['Slush', 'Phantom']) {
      const row = getByRole('link', { name: new RegExp(name, 'i') });
      expect(row.classList.contains('ap-rowline')).toBe(true);
      expect((row.getAttribute('href') ?? '').startsWith('http')).toBe(true);
      // An install link must never be mistakable for a connect action.
      expect(row.getAttribute('title') ?? '').toMatch(/not detected/i);
    }
  });

  it('keeps zkLogin visually apart from the wallet list', () => {
    const { container, getByRole } = renderGate();
    const google = getByRole('button', { name: /sign in with google/i });
    expect(google.textContent ?? '').toMatch(/zkLogin/);
    // The "or" rule between the two trust stories is structural, not decorative.
    expect(container.querySelector('.ap-gate-rule')).not.toBeNull();
  });

  it('opens the help note only on a click, never on mount', () => {
    const { container, getByTitle } = renderGate();
    expect(container.querySelector('.ap-gate-help')).toBeNull();
    fireEvent.click(getByTitle(/what connecting does/i));
    expect(container.querySelector('.ap-gate-help')?.textContent ?? '').toMatch(/not a permission/i);
  });

  it('says connecting grants no capability over funds', () => {
    const text = renderGate().container.textContent ?? '';
    expect(text).toMatch(/grants nothing/i);
    expect(text).toMatch(/signed by you/i);
    // Never the overclaim.
    expect(text).not.toMatch(/non-custodial wallet/i);
  });
});
