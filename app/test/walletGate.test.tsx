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
// @facts        null-handling would become dead code nobody notices is missing.
// @facts      The suite runs with no wallet extension and no Enoki credentials
// @facts        (vitest.config.ts pins every VITE_*), which is exactly the state
// @facts        a first-time visitor arrives in — so this is the real path.
// @facts      ⚠ THE CARD WAS DELIBERATELY SHORTENED to one list of rows. Two
// @facts        labelled sections, an "or" rule, a help popover and two
// @facts        paragraphs of prose were cut: a connect dialog nobody reads is
// @facts        worse than a short one they do. These tests were REWRITTEN to
// @facts        pin what survived, not relaxed to accommodate the cut — every
// @facts        invariant below still holds, and the "installed" claim is
// @facts        asserted harder than it was before.
// @implements the gate's invariants 1–4
// @forbidden  a network call — the gate must render offline
// @invariant  1. Children never render while disconnected.
//             2. A path that cannot work says why ON the control, not beside it.
//             3. The footer states that connecting grants no capability.
//             4. "installed" appears only for a wallet actually detected.
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
    expect((container.textContent ?? '').length).toBeGreaterThan(60);
  });

  it('is short: one list, and no sections to scroll past', () => {
    const { container } = renderGate();
    // The cut IS the feature. Re-adding the two labelled sections or the "or"
    // rule fails here, so it has to be argued for rather than drift back in.
    expect(container.querySelectorAll('.ap-rows')).toHaveLength(1);
    expect(container.querySelector('.ap-gate-rule')).toBeNull();
    expect(container.querySelector('.ap-gate-help')).toBeNull();
  });

  it('offers the Google row even with no extension wallet present', () => {
    const google = renderGate().getByRole('button', { name: /sign in with google/i });
    expect(google.classList.contains('ap-rowline')).toBe(true);
  });

  it('states on the control itself why Google sign-in is unavailable', () => {
    // vitest.config.ts pins VITE_ENOKI_API_KEY to '', so the row must be
    // disabled AND carry its reason — a disabled control with no title is a
    // dead end for whoever is looking at it.
    const button = renderGate().getByRole('button', { name: /sign in with google/i });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.getAttribute('title') ?? '').toMatch(/\S/);
  });

  it('never labels a wallet "installed" when none is detected', () => {
    const { container } = renderGate();
    // The pill is the one claim on this card a user acts on. With no extension
    // present it must appear nowhere at all.
    expect(container.querySelector('.ap-badge--live')).toBeNull();
    expect(container.textContent ?? '').not.toMatch(/installed/i);
  });

  it('names a real wallet to install when none is detected', () => {
    const text = renderGate().container.textContent ?? '';
    expect(text).toMatch(/no wallet extension detected/i);
    expect(text).toMatch(/Slush/);
    expect(text).toMatch(/Phantom/);
  });

  it('offers a way out that needs no address', () => {
    const leave = renderGate().getByRole('link', { name: /leave this screen/i });
    expect(leave.getAttribute('href')).toBe('/');
  });

  it('says connecting grants no capability over funds', () => {
    const text = renderGate().container.textContent ?? '';
    expect(text).toMatch(/grants nothing/i);
    expect(text).toMatch(/signed by you/i);
    // Never the overclaim.
    expect(text).not.toMatch(/non-custodial wallet/i);
  });
});
