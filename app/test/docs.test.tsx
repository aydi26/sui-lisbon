// @vitest-environment jsdom
// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F5
// @phase      5
// @status     DONE
// @spec       aphotic.md §1 (the two products), §13 (limitations are published),
//             §22 (naming rule)
// @spec       docs/DESIGN-V2.md §4 (cadence is derived), §5ter (the parity
//             blocker), §9 (D9 Seal committee), §10 D10 (validator floor)
// @rules      G3 G5 G6 G7 G8
// @depends    ../src/screens/docs/DocsScreen.tsx (F5) · ../src/screens/docs/sections.tsx
// @facts      vitest.config.ts PINS every id-bearing VITE_* to '', so this suite
// @facts        renders /docs in its WORST configuration: no published package, no
// @facts        Seal committee, no wallet, no network. Every id row must therefore
// @facts        say "not configured", never render a link to nowhere.
// @facts      This file exists for the same reason limitations.test.tsx does: so the
// @facts        honesty copy cannot be quietly softened by a later edit. Each
// @facts        assertion below is a claim we committed to publishing.
// @implements the /docs anti-softening safety net + the layout contract
// @forbidden  deleting a case to make a copy edit pass — edit the copy to keep the
//             claim, or the claim was never honest
// @forbidden  a network call — a fetch spy failure fails the suite
// @invariant  1. The limitations render unconditionally, on every section, with no
//                interaction and behind no toggle.
// @invariant  2. Both validator numbers appear together and labelled.
// @invariant  3. No `0x…` id literal is rendered while nothing is configured.
// @ac         cd app && npm test -- docs
// @verify     cd app && npm test -- docs
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DocsScreen from '../src/screens/docs/DocsScreen';
import { DOCS_CATEGORIES, DOCS_SECTIONS } from '../src/screens/docs/sections';

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn(() => Promise.reject(new Error('the network is down')));
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderDocs() {
  return render(
    <MemoryRouter>
      <DocsScreen />
    </MemoryRouter>,
  );
}

const textOf = (container: HTMLElement) => container.textContent ?? '';

// ── the shape the page has to have ───────────────────────────────────────────

describe('the two-pane layout', () => {
  it('renders a sidebar, a content pane and a mobile toggle', () => {
    const { container } = renderDocs();
    expect(container.querySelector('.docs-page')).not.toBeNull();
    expect(container.querySelector('.docs-mobile-toggle')).not.toBeNull();
    expect(container.querySelector('.docs-sidebar')).not.toBeNull();
    expect(container.querySelector('.docs-sidebar-header')?.textContent).toBe('Documentation');
    expect(container.querySelector('.docs-main')).not.toBeNull();
    expect(container.querySelector('.docs-content')).not.toBeNull();
    expect(container.querySelector('.docs-content-title')).not.toBeNull();
    expect(container.querySelector('.docs-content-body')).not.toBeNull();
    expect(container.querySelector('.docs-subsection-title')).not.toBeNull();
    expect(container.querySelector('.docs-subsection-list')).not.toBeNull();
  });

  it('groups every section under a category label, none orphaned', () => {
    const { container } = renderDocs();
    const labels = Array.from(container.querySelectorAll('.docs-sidebar-category-label')).map(
      (el) => el.textContent,
    );
    expect(labels).toEqual([...DOCS_CATEGORIES]);
    expect(labels).toContain('Protocol');
    expect(labels).toContain('Technical');
    expect(labels).toContain('Reference');

    const links = container.querySelectorAll('.docs-sidebar-link');
    expect(links).toHaveLength(DOCS_SECTIONS.length);
    for (const section of DOCS_SECTIONS) {
      expect(DOCS_CATEGORIES).toContain(section.category);
    }
  });

  it('carries exactly one active link, and swapping it swaps the pane', () => {
    const { container } = renderDocs();
    expect(container.querySelectorAll('.docs-sidebar-link.active')).toHaveLength(1);
    expect(container.querySelector('.docs-content-title')?.textContent).toBe(
      DOCS_SECTIONS[0].title,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Why an auction' }));

    expect(container.querySelectorAll('.docs-sidebar-link.active')).toHaveLength(1);
    expect(container.querySelector('.docs-sidebar-link.active')?.textContent).toBe(
      'Why an auction',
    );
    expect(container.querySelector('.docs-content-title')?.textContent).toBe('Why an auction');
  });

  it('offers a single primary link out of the sidebar', () => {
    const { container } = renderDocs();
    const ctas = container.querySelectorAll('.docs-sidebar-cta');
    expect(ctas).toHaveLength(1);
    expect(ctas[0].getAttribute('href')).toBe('/verify');
  });

  it('never fetches: /docs is prose plus config reads', () => {
    renderDocs();
    fireEvent.click(screen.getByRole('button', { name: 'Network configuration' }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── the content each section owes ────────────────────────────────────────────

function paneFor(label: string): string {
  // Each call is a fresh mount, so a loop over the sections cannot accumulate
  // several sidebars in the same document and make getByRole ambiguous.
  cleanup();
  const { container } = renderDocs();
  fireEvent.click(screen.getByRole('button', { name: label }));
  return textOf(container.querySelector('.docs-main') as HTMLElement);
}

describe('Protocol → Getting started', () => {
  it('states what Aphotic is and what a reader needs', () => {
    const text = paneFor('Getting started');
    expect(text).toMatch(/redemption-carry vault/i);
    expect(text).toMatch(/sealed-order batch auction/i);
    expect(text).toMatch(/signet/i);
    expect(text).toMatch(/Slush/);
    expect(text).toMatch(/Phantom/);
    expect(text).toMatch(/zkLogin/);
    expect(text).toMatch(/Hashi/);
    expect(text).toMatch(/SUI for gas/i);
  });
});

describe('Protocol → How it works', () => {
  it('gives the carry and the auction their own explanations', () => {
    const text = paneFor('How it works');
    expect(text).toMatch(/below par/i);
    expect(text).toMatch(/rate.limit/i);
    expect(text).toMatch(/one-for-one/i);
    expect(text).toMatch(/uniform price/i);
    expect(text).toMatch(/06:00 and 18:00 UTC/);
    expect(text).toMatch(/never fall back to plaintext/i);
  });
});

describe('Protocol → Why an auction — the differentiator', () => {
  it('names the public queue and the four fields it exposes', () => {
    const text = paneFor('Why an auction');
    expect(text).toMatch(/WithdrawalRequestQueue/);
    expect(text).toMatch(/public Move object/i);
    expect(text).toMatch(/sender/);
    expect(text).toMatch(/btc_amount/);
    expect(text).toMatch(/bitcoin_address/);
    expect(text).toMatch(/created_timestamp_ms/);
    expect(text).toMatch(/watched forming in real time/i);
    expect(text).toMatch(/before it reaches the queue/i);
  });

  it('says front-running is made meaningless, not merely hard', () => {
    const text = paneFor('Why an auction');
    expect(text).toMatch(/meaningless/i);
    expect(text).toMatch(/same price at the same instant/i);
    // The weaker claim we are refusing to make.
    expect(text).not.toMatch(/front-running impossible/i);
  });

  it('states the three mechanics that keep the moment out of anyone hands', () => {
    const text = paneFor('Why an auction');
    expect(text).toMatch(/close_ms/);
    expect(text).toMatch(/derived/i);
    expect(text).toMatch(/open_batch/);
    expect(text).toMatch(/takes no timestamp/i);
    expect(text).toMatch(/full batch does not close early/i);
  });
});

describe('Technical → Architecture', () => {
  it('names the four pieces without overclaiming the keeper', () => {
    const text = paneFor('Architecture');
    expect(text).toMatch(/Ten Move modules/i);
    expect(text).toMatch(/holds no discretion/i);
    expect(text).toMatch(/sdk\//);
    expect(text).toMatch(/Rust/);
  });
});

describe('Technical → Smart contracts', () => {
  it('lists the package and the shared objects', () => {
    const text = paneFor('Smart contracts');
    expect(text).toMatch(/Aphotic package/);
    expect(text).toMatch(/Vault/);
    expect(text).toMatch(/BatchRegistry/);
    expect(text).toMatch(/AdapterRegistry/);
    expect(text).toMatch(/aphotic_lending/);
  });

  it('says "not configured" rather than linking to nowhere when unwired', () => {
    const { container } = renderDocs();
    fireEvent.click(screen.getByRole('button', { name: 'Smart contracts' }));
    const main = container.querySelector('.docs-main') as HTMLElement;
    expect(textOf(main)).toMatch(/not configured in this build/i);
    expect(main.querySelectorAll('.docs-id-link')).toHaveLength(0);
    expect(textOf(main)).toMatch(/VITE_APHOTIC_PACKAGE_ID/);
  });
});

describe('Reference → Network configuration', () => {
  it('reports the network, the bridge, the venue, Seal and Walrus', () => {
    const text = paneFor('Network configuration');
    expect(text).toMatch(/testnet/);
    expect(text).toMatch(/signet/);
    expect(text).toMatch(/Hashi package/);
    expect(text).toMatch(/DeepBook/);
    expect(text).toMatch(/distinct operators|VITE_SEAL_KEY_SERVER_IDS/);
    expect(text).toMatch(/threshold t/i);
    expect(text).toMatch(/Walrus/);
    expect(text).toMatch(/walrus/i);
  });

  it('derives the cadence rather than hardcoding a clock', () => {
    expect(paneFor('Network configuration')).toMatch(/06:00 and 18:00 UTC/);
  });
});

// ── the honesty contract ─────────────────────────────────────────────────────

describe('the limitations render unconditionally', () => {
  it('are on screen with zero interaction, on the very first section', () => {
    const { container } = renderDocs();
    const text = textOf(container);
    expect(text).toMatch(/custodial-threshold wrapped BTC/i);
    expect(text).toMatch(/LINKABLE/);
    expect(text).toMatch(/parity/i);
  });

  it('appear on every single section, never behind a toggle', () => {
    for (const section of DOCS_SECTIONS) {
      const text = paneFor(section.label);
      expect(
        /custodial-threshold wrapped BTC/i.test(text),
        `the custodial disclosure is missing from "${section.label}"`,
      ).toBe(true);
      expect(
        /Move differs on 15 % of 4 000 seeded books/i.test(text),
        `the parity blocker is missing from "${section.label}"`,
      ).toBe(true);
      cleanup();
    }
  });

  it('uses no <details>, <summary> or aria-expanded to hide any of it', () => {
    const { container } = renderDocs();
    const main = container.querySelector('.docs-main') as HTMLElement;
    expect(main.querySelectorAll('details')).toHaveLength(0);
    expect(main.querySelectorAll('summary')).toHaveLength(0);
    expect(main.querySelectorAll('[aria-expanded]')).toHaveLength(0);
    expect(main.querySelectorAll('[hidden]')).toHaveLength(0);
  });
});

describe('the honesty copy is not softened', () => {
  it('calls hBTC custodial-threshold and never the opposite', () => {
    const text = paneFor('Honest limitations');
    expect(text).toMatch(/custodial-threshold wrapped BTC/i);
    expect(text).toMatch(/threshold Schnorr/i);
    expect(text).toMatch(/Guardian enclave/i);
    expect(text).toMatch(/60-day recovery leaf/i);
    expect(text).toMatch(/not trustless/i);
    expect(text).toMatch(/never the token/i);
    expect(text).not.toMatch(/hBTC is trustless/i);
    expect(text).not.toMatch(/hBTC is non-custodial/i);
  });

  it('says note spends are LINKABLE — uniformity, not unlinkability', () => {
    const text = paneFor('Honest limitations');
    expect(text).toMatch(/v1 note spends are LINKABLE/);
    expect(text).toMatch(/Merkle path is supplied in the clear/i);
    expect(text).toMatch(/uniformity, not unlinkability/i);
    expect(text).toMatch(/privacy comes from the crowd/i);
    expect(text).not.toMatch(/fully private/i);
    expect(text).not.toMatch(/anonymous by default/i);
  });

  it('discloses that we deployed the lending counterparty ourselves', () => {
    const text = paneFor('Honest limitations');
    expect(text).toMatch(/deployed the hBTC lending counterparty ourselves/i);
    expect(text).toMatch(/none exists on Sui testnet/i);
    expect(text).toMatch(/ours, not a market rate/i);
  });

  it('quotes BOTH validator numbers, labelled', () => {
    const text = paneFor('Honest limitations');
    expect(text).toMatch(/protocol floor 7/i);
    expect(text).toMatch(/live testnet today 32/i);
    expect(text).toMatch(/overstates the risk/i);
    expect(text).toMatch(/understates/i);
  });

  it('states that the carry is not executed in this version', () => {
    const text = paneFor('Honest limitations');
    expect(text).toMatch(/carry is not executed in this version/i);
    expect(text).toMatch(/empty on both sides/i);
    expect(text).toMatch(/mint neither leg/i);
  });

  it('publishes the clearing-parity failure as an OPEN release blocker', () => {
    const text = paneFor('Honest limitations');
    expect(text).toMatch(/Move.TypeScript clearing parity FAILS/i);
    expect(text).toMatch(/third\s+implementation, in Rust/i);
    expect(text).toMatch(/46 golden fixtures/);
    expect(text).toMatch(/Move differs on 15 % of 4 000 seeded books/);
    expect(text).toMatch(/five named divergences/i);
    expect(text).toMatch(/73 versus 81 bytes/);
    expect(text).toMatch(/Merkle roots can\s+never match/i);
    expect(text).toMatch(/release blocker, and it is open/i);
    expect(text).toMatch(/DESIGN-V2\.md/);
    expect(text).toMatch(/5ter/);
  });

  it('states the BTC-leg latency and the honest ceiling on the venue', () => {
    const text = paneFor('Honest limitations');
    expect(text).toMatch(/70 minutes/);
    expect(text).toMatch(/1\.5–2 hours/);
    expect(text).toMatch(/never instant/i);
    expect(text).toMatch(/if the spread vanishes/i);
    expect(text).toMatch(/congestion insurance/i);
  });
});

describe('the naming rule (aphotic.md §22) holds across every section', () => {
  const BANNED = [/σ-Labs/i, /Sigma Labs/i, /Ellen Capital/i, /Lagoon/i, /rcETH/i];

  it('never renders a banned name', () => {
    for (const section of DOCS_SECTIONS) {
      const text = paneFor(section.label);
      for (const banned of BANNED) {
        expect(banned.test(text), `"${banned}" appears on "${section.label}"`).toBe(false);
      }
      cleanup();
    }
  });
});
