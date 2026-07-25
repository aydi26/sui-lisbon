// @vitest-environment jsdom
// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T3.2
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/APP.md §3.1 (<PinningExplainer/>) · §7 A4
// @rules      G2 G8
// @depends    ../src/components/PinningExplainer.tsx · ../src/components/AddressPill.tsx
//             ../src/components/TrustModelDisclosure.tsx
// @facts      A4 asserts there is NO editable field for the exit destination
// @facts        anywhere in the exit UI: gateway::exit_to_bitcoin has no
// @facts        bitcoin_address parameter, and the pin is write-once.
// @facts      G8 honesty line: hBTC IS custodial-threshold wrapped BTC. The
// @facts        disclosure component must say so, and must never claim otherwise.
// @implements the A4 rendered-DOM safety net (the Move-side twin is gates.ps1 g2).
// @forbidden  a network call — these are pure presentational components
// @invariant  1. PinningExplainer renders no input/textarea/contenteditable.
//             2. AddressPill keeps the FULL value available even when truncated.
// @ac         docs/APP.md §7 A4
// @verify     cd app && npm test
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { AddressPill } from '../src/components/AddressPill';
import { PinningExplainer } from '../src/components/PinningExplainer';
import { TRUST_MODEL_LINE, TrustModelDisclosure } from '../src/components/TrustModelDisclosure';

afterEach(cleanup);

const GOLDEN_P2TR = 'tb1pw58m0ar8yhcf0x7x3j5wlxr4jqxywhrf25vk6kpj95esrrrtnmlsdep54p';

describe('<PinningExplainer/> — A4: the destination is never editable (G2)', () => {
  it('renders no input, textarea, select or contenteditable element', () => {
    const { container } = render(<PinningExplainer />);
    expect(container.querySelectorAll('input')).toHaveLength(0);
    expect(container.querySelectorAll('textarea')).toHaveLength(0);
    expect(container.querySelectorAll('select')).toHaveLength(0);
    expect(container.querySelectorAll('[contenteditable]')).toHaveLength(0);
  });

  it('states that the address is write-once and that exit_to_bitcoin takes no address argument', () => {
    const { container } = render(<PinningExplainer />);
    const text = container.textContent ?? '';
    expect(text).toMatch(/write-once/i);
    expect(text).toMatch(/gateway::register_exit_address/);
    expect(text).toMatch(/gateway::exit_to_bitcoin/);
    expect(text).toMatch(/no Bitcoin-address argument/i);
    expect(text).toMatch(/TradeCap/);
  });
});

describe('<AddressPill/>', () => {
  it('keeps the full address reachable even when it is visually truncated', () => {
    render(<AddressPill value={GOLDEN_P2TR} label="Your deposit address (P2TR)" truncate />);
    expect(screen.getByText('Your deposit address (P2TR)')).toBeTruthy();
    // Truncated on screen, complete in the title attribute and the clipboard.
    expect(screen.getByTitle(GOLDEN_P2TR)).toBeTruthy();
    expect(screen.queryByText(GOLDEN_P2TR)).toBeNull();
  });

  it('renders the value in full when truncation is off', () => {
    render(<AddressPill value={GOLDEN_P2TR} truncate={false} />);
    expect(screen.getByText(GOLDEN_P2TR)).toBeTruthy();
  });

  it('shows the immutability affordance for a pinned address', () => {
    const { container } = render(<AddressPill value={GOLDEN_P2TR} immutable />);
    expect(container.textContent).toMatch(/⛓/);
    expect(screen.getByTitle(/immutable/i)).toBeTruthy();
  });
});

describe('<TrustModelDisclosure/> — G8 honesty', () => {
  it('states plainly that hBTC is custodial-threshold wrapped BTC', () => {
    const { container } = render(<TrustModelDisclosure />);
    const text = container.textContent ?? '';
    expect(TRUST_MODEL_LINE.toLowerCase()).toMatch(/custodial/);
    expect(text.toLowerCase()).toMatch(/custodial/);
    // Never the opposite claim.
    expect(text).not.toMatch(/hBTC is trustless/i);
    expect(text).not.toMatch(/hBTC is non-custodial/i);
  });
});
