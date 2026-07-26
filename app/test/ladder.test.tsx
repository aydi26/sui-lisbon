// @vitest-environment jsdom
// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F1
// @phase      0
// @status     DONE
// @spec       docs/DESIGN-V2.md §11 · aphotic.md §7.1, §2 constraint 4
// @rules      G8
// @depends    ../src/components/DenominationLadder.tsx (F1)
// @facts      THE RULE THIS FILE DEFENDS: there is no free-form amount field
// @facts        anywhere in this app. A ladder fine enough to express an exact
// @facts        amount fragments participants into singleton anonymity sets and is
// @facts        worth LESS than no ladder at all — so a regression that adds an
// @facts        <input> here is a privacy regression, not a UX change.
// @implements the "no free-form amount" safety net
// @forbidden  relaxing the no-input assertion to accommodate a design tweak
// @invariant  1. Exactly four buttons, one per governed tier.
// @invariant  2. No input/textarea/contenteditable in the rendered tree.
// @invariant  3. The uniformity argument is on screen, not just in a doc.
// @ac         four tiers; selection reports a bigint sats value.
// @verify     cd app && npm test -- ladder
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DENOMINATIONS,
  DenominationLadder,
} from '../src/components/DenominationLadder';

afterEach(cleanup);

describe('DENOMINATIONS', () => {
  it('is the four governed tiers, labelled in hBTC and valued in sats', () => {
    expect(DENOMINATIONS.map((d) => d.label)).toEqual([
      '0.01 hBTC',
      '0.1 hBTC',
      '1 hBTC',
      '10 hBTC',
    ]);
    expect(DENOMINATIONS.map((d) => d.sats)).toEqual([
      1_000_000n,
      10_000_000n,
      100_000_000n,
      1_000_000_000n,
    ]);
    expect(DENOMINATIONS.map((d) => d.index)).toEqual([0, 1, 2, 3]);
  });
});

describe('<DenominationLadder/>', () => {
  it('renders exactly four buttons and NO free-form amount field', () => {
    const { container } = render(<DenominationLadder selected={null} onSelect={() => {}} />);
    expect(container.querySelectorAll('button')).toHaveLength(4);
    expect(container.querySelectorAll('input')).toHaveLength(0);
    expect(container.querySelectorAll('textarea')).toHaveLength(0);
    expect(container.querySelectorAll('[contenteditable]')).toHaveLength(0);
  });

  it('reports the selected tier as a bigint number of sats', () => {
    const onSelect = vi.fn();
    render(<DenominationLadder selected={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByText('0.1 hBTC'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    const arg = onSelect.mock.calls[0][0];
    expect(arg.sats).toBe(10_000_000n);
    expect(arg.index).toBe(1);
  });

  it('marks the selected tier with aria-pressed rather than colour alone', () => {
    render(<DenominationLadder selected={2} onSelect={() => {}} />);
    const pressed = screen
      .getAllByRole('button')
      .filter((b) => b.getAttribute('aria-pressed') === 'true');
    expect(pressed).toHaveLength(1);
    expect(pressed[0].textContent).toMatch(/^1 hBTC/);
  });

  it('explains that denominations create uniformity, not privacy', () => {
    const { container } = render(<DenominationLadder selected={null} onSelect={() => {}} />);
    const text = container.textContent ?? '';
    expect(text).toMatch(/uniformity, not privacy/i);
    expect(text).toMatch(/crowd/i);
    expect(text).toMatch(/singleton anonymity sets/i);
  });

  it('shows held counts when the caller has them, and sats otherwise', () => {
    const { container } = render(
      <DenominationLadder selected={null} onSelect={() => {}} held={{ 0: 3, 1: 0, 2: 0, 3: 0 }} />,
    );
    expect(container.textContent ?? '').toMatch(/3 held/);
  });

  it('renders the reason when it is disabled instead of a dead control', () => {
    const { container } = render(
      <DenominationLadder
        selected={null}
        onSelect={() => {}}
        disabled
        disabledReason="No internal balance is configured in this build."
      />,
    );
    expect(container.querySelectorAll('button[disabled]')).toHaveLength(4);
    expect(container.textContent ?? '').toMatch(/No internal balance is configured/);
  });
});
