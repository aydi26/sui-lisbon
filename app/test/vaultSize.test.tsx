// @vitest-environment jsdom
// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F2
// @phase      1
// @status     DONE
// @spec       move/sources/vault.move — `request_deposit` asserts
//             `assets_sats >= v.params.min_deposit_sats` (EBelowMinDeposit)
// @rules      G2 G9 G10
// @depends    ../src/components/VaultSizeLadder.tsx
// @facts      THE BUG THIS FILE EXISTS TO KEEP FIXED.
// @facts        /vault drove its deposit size off the NOTE ladder (DENOMINATIONS),
// @facts        whose smallest tier is 1_000_000 sats = 0.01 hBTC. The live vault's
// @facts        `min_deposit_sats` is 1_000. A testnet faucet pays out far less than
// @facts        0.01 hBTC — the wallet in question held 663_717 sats — so EVERY tier
// @facts        was unaffordable, EVERY control was disabled, and the screen looked
// @facts        broken while the contract would happily have taken 1_000 sats.
// @facts        The failure was silent in the worst way: nothing errored, the button
// @facts        was just never pressable.
// @facts      THE TWO LADDERS ARE FOR TWO DIFFERENT OBJECTS. G9 fixes note
// @facts        denominations because ESCROW MUST NOT LEAK ORDER SIZE. A vault
// @facts        request is public — the receipt carries its amount and
// @facts        `pending_deposit_assets` is a readable running sum — so there is no
// @facts        size to hide, and borrowing the note floor bought no privacy at all.
// @facts        These cases therefore also assert DENOMINATIONS is UNCHANGED: the
// @facts        fix must never have been "lower the note ladder" (that would revalue
// @facts        live notes, which G9 forbids outright).
// @implements the anti-regression net for the vault's size control
// @forbidden  re-pointing /vault at DenominationLadder
// @forbidden  a floor constant in app/ — it is read from the vault
// @invariant  1. Every tier >= the on-chain minimum.
// @invariant  2. No number renders before the floor was read.
// @invariant  3. An unaffordable tier is disabled and says so on the button.
// @ac         all cases below
// @verify     cd app && npm test -- vaultSize
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DENOMINATIONS } from '../src/components/DenominationLadder';
import { VaultSizeLadder, vaultSizes } from '../src/components/VaultSizeLadder';

afterEach(cleanup);

/** Read off chain 2026-07-26 from the live vault and the deployer wallet. */
const LIVE_MIN_SATS = 1_000n;
const LIVE_WALLET_SATS = 663_717n;

describe('vaultSizes is anchored on the chain, not on a constant', () => {
  it('starts exactly at the vault minimum, so no tier can abort EBelowMinDeposit', () => {
    const sizes = vaultSizes(LIVE_MIN_SATS);
    expect(sizes[0]?.sats).toBe(LIVE_MIN_SATS);
    for (const s of sizes) expect(s.sats).toBeGreaterThanOrEqual(LIVE_MIN_SATS);
  });

  it('steps by decades', () => {
    expect(vaultSizes(LIVE_MIN_SATS).map((s) => s.sats)).toEqual([
      1_000n,
      10_000n,
      100_000n,
      1_000_000n,
    ]);
  });

  it('follows set_min_deposit — an admin raising the floor moves the whole ladder', () => {
    // The point of reading the floor rather than hardcoding it: these cannot drift.
    expect(vaultSizes(50_000n).map((s) => s.sats)).toEqual([
      50_000n,
      500_000n,
      5_000_000n,
      50_000_000n,
    ]);
  });
});

describe('the regression: a faucet-sized wallet can actually deposit', () => {
  it('THE OLD BEHAVIOUR WAS UNUSABLE — the note ladder floor exceeds a faucet payout', () => {
    // Not nostalgia: this is why the vault stopped sharing the note ladder. If
    // someone re-points /vault at DENOMINATIONS, this is the arithmetic they are
    // re-introducing.
    expect(DENOMINATIONS[0]?.sats).toBeGreaterThan(LIVE_WALLET_SATS);
  });

  it('keeps the NOTE ladder untouched — G9 is append-only, tiers are never repriced', () => {
    // The fix was a second ladder, never a cheaper first one: repricing a live tier
    // would revalue notes already committed under it.
    expect(DENOMINATIONS.map((d) => d.sats)).toEqual([
      1_000_000n,
      10_000_000n,
      100_000_000n,
      1_000_000_000n,
    ]);
  });

  it('offers at least one affordable size at the live floor and the live balance', () => {
    const affordable = vaultSizes(LIVE_MIN_SATS).filter((s) => s.sats <= LIVE_WALLET_SATS);
    expect(affordable.length).toBeGreaterThan(0);
    expect(affordable.map((s) => s.sats)).toEqual([1_000n, 10_000n, 100_000n]);
  });
});

describe('<VaultSizeLadder/>', () => {
  const noop = () => undefined;

  it('renders no number before the floor was read', () => {
    const { container } = render(
      <VaultSizeLadder selected={null} onSelect={noop} minSats={null} heldUnits={null} unit="sats" />,
    );
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(container.textContent ?? '').toMatch(/min_deposit_sats/);
    // Invariant 2 — a floor it has not read must not be drawn as if it had.
    expect(container.textContent ?? '').not.toMatch(/\d{3},\d{3}/);
  });

  it('enables what the holder can afford and disables what they cannot, with the reason', () => {
    const { container } = render(
      <VaultSizeLadder
        selected={null}
        onSelect={noop}
        minSats={LIVE_MIN_SATS}
        heldUnits={LIVE_WALLET_SATS}
        unit="sats"
      />,
    );
    const buttons = [...container.querySelectorAll('button')];
    expect(buttons).toHaveLength(4);
    expect(buttons.filter((b) => !b.hasAttribute('disabled'))).toHaveLength(3);

    const tooBig = buttons[3]!;
    expect(tooBig.hasAttribute('disabled')).toBe(true);
    // Invariant 3: the reason is ON the control, not merely beside it.
    expect(tooBig.getAttribute('title') ?? '').toMatch(/more than you hold/i);
    expect(tooBig.textContent ?? '').toMatch(/more than you hold/i);
  });

  it('reports the selected size to its caller', () => {
    const onSelect = vi.fn();
    render(
      <VaultSizeLadder
        selected={null}
        onSelect={onSelect}
        minSats={LIVE_MIN_SATS}
        heldUnits={LIVE_WALLET_SATS}
        unit="sats"
      />,
    );
    screen.getAllByRole('button')[0]!.click();
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ index: 0, sats: 1_000n }));
  });

  it('never claims uniformity for a vault request — that argument is the auction’s', () => {
    const { container } = render(
      <VaultSizeLadder
        selected={null}
        onSelect={noop}
        minSats={LIVE_MIN_SATS}
        heldUnits={LIVE_WALLET_SATS}
        unit="sats"
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toMatch(/public by construction/i);
    expect(text).not.toMatch(/uniformity, not privacy/i);
  });
});
