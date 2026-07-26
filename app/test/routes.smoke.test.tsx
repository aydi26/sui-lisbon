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
// @facts      The landing route is deliberately NOT rendered WHOLE here: <LandingPage/>
// @facts        mounts globe.gl/three against a real WebGL context, which jsdom does
// @facts        not provide. Its three testable parts ARE covered — readAggregateStats
// @facts        (the bit that can lie or throw), <HorizontalScroll/> and <FAQ/> (the
// @facts        copy, which is where the honesty lives). None of the three needs WebGL.
// @facts      THE WEIGHTING IS ASSERTED, not left to intent. "Lead with the vault"
// @facts        is a presentation decision, and presentation decisions are exactly
// @facts        what a later tidy-up reverses by accident — an alphabetised nav, or
// @facts        three landing cards flattened back into equal peers. The cases below
// @facts        pin the order, the weight classes, the card titles and the relative
// @facts        copy length. They ALSO pin that nothing was deleted to get there:
// @facts        /batch is still a full, enabled, routed nav entry, and the queue-leak
// @facts        story and every FAQ honesty answer are still on the page.
// @implements the "every route renders, unconfigured and offline" safety net
// @implements the "the vault leads, and nothing was deleted to make it lead" net
// @forbidden  a network call from any test — a fetch spy fails the suite
// @forbidden  satisfying the weighting cases by removing /batch — they assert its
//             presence on purpose
// @invariant  1. No screen throws while unconfigured and signed out.
//             2. No screen fetches on mount: every read is click- or session-gated.
//             3. Every route states its unconfigured condition in words rather than
//                offering an enabled control that cannot work.
//             4. readAggregateStats resolves rather than rejecting when offline.
//             5. NAV[0] is Vault; Batch is quieter but fully reachable.
//             6. The landing has EXACTLY three cards, led by the vault.
// @ac         /vault /batch /verify all render; the shell names all three.
// @ac         the nav is vault-first and weighted; the landing cards are 3, in the
//             order VAULT / SEALED / VERIFY, with the vault carrying the most copy.
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

// ── The vault leads ─────────────────────────────────────────────────────────
//
// A presentation decision, and the kind that gets undone by accident: someone
// alphabetises the nav, or "tidies" the landing cards back to three equal peers.
// These assert the WEIGHTING, and equally assert that nothing was deleted to
// achieve it — /batch is still a full nav entry, still enabled, still routed.
describe('the shell puts the vault first and the batch auction second', () => {
  const navLinks = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('.aphotic-navlink')) as HTMLAnchorElement[];

  it('orders the nav vault-first', () => {
    const { container } = renderRoute('/vault', <VaultScreen />);
    const labels = navLinks(container).map((a) => a.textContent);
    expect(labels[0]).toBe('Vault');
    expect(labels.indexOf('Vault')).toBeLessThan(labels.indexOf('Batch'));
  });

  it('marks the vault primary and the batch auction quiet', () => {
    const { container } = renderRoute('/verify', <VerifyScreen />);
    const byLabel = new Map(navLinks(container).map((a) => [a.textContent, a]));
    expect(byLabel.get('Vault')?.className).toMatch(/aphotic-navlink--primary/);
    expect(byLabel.get('Batch')?.className).toMatch(/aphotic-navlink--quiet/);
    // Verify and Docs are utility routes: neither weighted class belongs to them.
    expect(byLabel.get('Verify')?.className).not.toMatch(/--primary|--quiet/);
  });

  it('quiets the batch auction without hiding, disabling or unrouting it', () => {
    const { container } = renderRoute('/vault', <VaultScreen />);
    const batch = navLinks(container).find((a) => a.textContent === 'Batch');
    expect(batch).toBeDefined();
    expect(batch?.getAttribute('href')).toBe('/batch');
    expect(batch?.hasAttribute('hidden')).toBe(false);
    expect(batch?.getAttribute('aria-disabled')).toBeNull();
    // It says WHY it is quiet rather than leaving a reader to guess.
    expect(batch?.getAttribute('title') ?? '').toMatch(/two-sided market/i);
  });
});

describe('the landing re-weights toward the vault without dropping the leak', () => {
  it('leads the three cards with the vault, and there are still exactly three', async () => {
    const { default: HorizontalScroll } = await import('../src/landing/HorizontalScroll.jsx');
    const { container } = render(<HorizontalScroll />);
    const panels = container.querySelectorAll('.hscroll-panel');
    // 3 is baked into LandingPage.css as 300vh/300vw. A 4th desynchronises the
    // scroll silently; removing one does too.
    expect(panels).toHaveLength(3);

    const titles = Array.from(container.querySelectorAll('.hscroll-bigtitle')).map(
      (h) => h.textContent,
    );
    expect(titles).toEqual(['VAULT', 'SEALED', 'VERIFY']);

    const ledes = Array.from(container.querySelectorAll('.hscroll-lede')).map((d) => d.textContent);
    expect(ledes[0]).toMatch(/one side of the market/i);
    expect(ledes[1]).toMatch(/second/i);

    // The vault card carries the most copy of the three — that IS the weighting.
    const bodies = Array.from(container.querySelectorAll('.hscroll-content-text p')).map(
      (p) => (p.textContent ?? '').length,
    );
    expect(bodies[0]).toBeGreaterThan(bodies[1]);
    expect(bodies[0]).toBeGreaterThan(bodies[2]);
  });

  it('keeps the queue leak as the lead story, on the card that explains the discount', () => {
    // Asserted against the card copy rather than the rendered tree so a future
    // re-order cannot quietly move the leak off screen.
    return import('../src/landing/HorizontalScroll.jsx').then(({ default: HorizontalScroll }) => {
      const text = render(<HorizontalScroll />).container.textContent ?? '';
      // Card 1: the leak, its four public fields, and why it makes a discount.
      expect(text).toMatch(/public Move object/i);
      expect(text).toMatch(/to which Bitcoin address/i);
      expect(text).toMatch(/below par/i);
      // Card 1 keeps the NAV split honest.
      expect(text).toMatch(/keeper proposes a NAV/i);
      expect(text).toMatch(/admin multisig approves/i);
      // Card 2 keeps the claim it is meaningless, not merely hard.
      expect(text).toMatch(/made meaningless/i);
      // Card 3 keeps G5: re-derived, never a trusted SDK read.
      expect(text).toMatch(/re-derived from Hashi's own events/i);
      expect(text).toMatch(/never read from a trusted SDK call/i);
    });
  });

  it('keeps the FAQ honesty answers while leading answer 1 with the vault', async () => {
    const { default: FAQ } = await import('../src/landing/FAQ.jsx');
    const { container } = render(<FAQ />);
    const questions = Array.from(container.querySelectorAll('.faq-question'));
    expect(questions).toHaveLength(6);

    const text = container.textContent ?? '';
    // Answer 1 opens on the vault and concedes what the auction needs.
    expect(text).toMatch(/A redemption-carry vault, first and mostly/);
    expect(text).toMatch(/needs a two-sided market to be worth anything/i);
    // The honesty answers are untouched.
    expect(text).toMatch(/hBTC is custodial-threshold wrapped BTC/);
    expect(text).toMatch(/note spends in v1 are linkable/i);
    expect(text).toMatch(/the venue is worth little/i);
    expect(text).toMatch(/who sent it, how much, to which Bitcoin address/i);
    // Never the softened version.
    expect(text).not.toMatch(/hBTC is trustless/i);
    expect(text).not.toMatch(/hBTC is non-custodial/i);
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
