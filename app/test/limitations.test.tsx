// @vitest-environment jsdom
// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F1
// @phase      0
// @status     DONE
// @spec       aphotic.md §13 · docs/DESIGN-V2.md D3 D8 D10 · §7.4 §7.7 §6.3
// @rules      G8
// @depends    ../src/components/LimitationsPanel.tsx (F1)
// @facts      This file exists so the honesty copy cannot be quietly softened. Each
// @facts        assertion below corresponds to a claim we committed to publishing:
// @facts        D8  v1 note spends are LINKABLE — uniformity, not unlinkability
// @facts        D3  we deployed the lending counterparty ourselves
// @facts        D10 protocol floor 7 AND live testnet 32, both labelled
// @facts        G8  hBTC is custodial-threshold wrapped BTC
// @implements the anti-softening safety net
// @forbidden  deleting a case here to make a copy edit pass — edit the copy to
//             keep the claim, or the claim was never honest
// @invariant  1. The linkability row is present and is not hedged.
// @invariant  2. Both validator numbers appear together.
// @ac         the four mandated rows render verbatim.
// @verify     cd app && npm test -- limitations
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { LIMITATIONS, LimitationsPanel } from '../src/components/LimitationsPanel';

afterEach(cleanup);

const textOf = (only?: readonly string[]) =>
  render(<LimitationsPanel only={only} />).container.textContent ?? '';

describe('LIMITATIONS carries every row we committed to publishing', () => {
  it('includes the four named rows', () => {
    const ids = LIMITATIONS.map((l) => l.id);
    expect(ids).toContain('custodial');
    expect(ids).toContain('linkable');
    expect(ids).toContain('lending');
    expect(ids).toContain('validators');
  });

  it('states the limitation in the title and the mitigation separately', () => {
    for (const row of LIMITATIONS) {
      expect(row.title.length).toBeGreaterThan(10);
      expect(row.body.length).toBeGreaterThan(60);
    }
  });
});

describe('the linkability disclosure is not softened', () => {
  it('says LINKABLE, and says uniformity rather than unlinkability', () => {
    const text = textOf(['linkable']);
    expect(text).toMatch(/LINKABLE/);
    expect(text).toMatch(/uniformity, not unlinkability/i);
    expect(text).toMatch(/Merkle path is supplied in the clear/i);
    // The soft version we are refusing to ship.
    expect(text).not.toMatch(/fully private/i);
    expect(text).not.toMatch(/anonymous by default/i);
  });
});

describe('the custodial disclosure is not softened', () => {
  it('calls hBTC custodial-threshold wrapped BTC and never the opposite', () => {
    const text = textOf(['custodial']);
    expect(text).toMatch(/custodial-threshold wrapped BTC/i);
    expect(text).toMatch(/not trustless/i);
    expect(text).not.toMatch(/hBTC is trustless/i);
    expect(text).not.toMatch(/hBTC is non-custodial/i);
  });
});

describe('the lending counterparty is disclosed as ours', () => {
  it('says we deployed it because no hBTC market exists on testnet', () => {
    const text = textOf(['lending']);
    expect(text).toMatch(/deployed the lending counterparty ourselves/i);
    expect(text).toMatch(/No hBTC lending market exists on Sui testnet/i);
  });
});

describe('the validator collusion floor quotes BOTH numbers', () => {
  it('never renders a bare 7 or a bare 32', () => {
    const text = textOf(['validators']);
    expect(text).toMatch(/protocol floor 7/i);
    expect(text).toMatch(/live testnet today 32/i);
    // Both numbers appear in the same row, so neither can be quoted alone.
    expect(text).toMatch(/7/);
    expect(text).toMatch(/32/);
    expect(text).toMatch(/overstates the risk/i);
    expect(text).toMatch(/understates the guarantee/i);
  });
});

describe('<LimitationsPanel/>', () => {
  it('renders every row by default', () => {
    const { container } = render(<LimitationsPanel />);
    expect(container.querySelectorAll('li')).toHaveLength(LIMITATIONS.length);
  });

  it('renders a subset, in the order asked for', () => {
    const { container } = render(<LimitationsPanel only={['validators', 'linkable']} />);
    const items = Array.from(container.querySelectorAll('li'));
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toMatch(/protocol floor 7/);
    expect(items[1].textContent).toMatch(/LINKABLE/);
  });

  it('ignores an unknown id rather than rendering an empty row', () => {
    const { container } = render(<LimitationsPanel only={['nope']} />);
    expect(container.querySelectorAll('li')).toHaveLength(0);
  });
});
