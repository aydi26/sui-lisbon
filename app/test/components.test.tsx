// @vitest-environment jsdom
// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F1
// @phase      0
// @status     DONE
// @spec       aphotic.md §6.3 (the boundary Move cannot enforce), §6.1 (caps),
//             §9 (liveness is not privileged), §13
// @spec       docs/DESIGN-V2.md §7 (KeeperCap · INV-C1)
// @rules      G2 G8
// @depends    ../src/components/{PinningExplainer,AddressPill,LimitationsPanel,
//             KeeperCapabilityBadge,PendingCall}.tsx
// @facts      THE CLAIM THIS FILE POLICES: the custody pin is enforced AT SIGNING
// @facts        by a 2-of-2 multisig, NOT by Move. Hashi's create_withdrawal sets
// @facts        `sender: ctx.sender()`, so a shared object can never be the sender
// @facts        and a vault holding queue positions would be custodial by
// @facts        construction. Claiming Move enforces the destination would be the
// @facts        single most damaging false statement in this app — hence a test.
// @implements the anti-overclaim safety net for the shared components
// @forbidden  a network call — these are pure presentational components
// @invariant  1. PinningExplainer renders no editable destination affordance.
//             2. PinningExplainer says the enforcement is off-chain.
//             3. KeeperCapabilityBadge says liveness is permissionless.
//             4. AddressPill keeps the FULL value available even when truncated.
// @ac         each component states its claim and never the stronger one.
// @verify     cd app && npm test -- components
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { AddressPill } from '../src/components/AddressPill';
import { KeeperCapabilityBadge } from '../src/components/KeeperCapabilityBadge';
import { PendingCall } from '../src/components/PendingCall';
import { PinningExplainer } from '../src/components/PinningExplainer';
import { LimitationsPanel } from '../src/components/LimitationsPanel';

afterEach(cleanup);

const GOLDEN_P2TR = 'tb1pw58m0ar8yhcf0x7x3j5wlxr4jqxywhrf25vk6kpj95esrrrtnmlsdep54p';

describe('<PinningExplainer/> — the destination is never editable', () => {
  it('renders no input, textarea, select or contenteditable element', () => {
    const { container } = render(<PinningExplainer />);
    expect(container.querySelectorAll('input')).toHaveLength(0);
    expect(container.querySelectorAll('textarea')).toHaveLength(0);
    expect(container.querySelectorAll('select')).toHaveLength(0);
    expect(container.querySelectorAll('[contenteditable]')).toHaveLength(0);
  });

  it('states that the check happens at signing, NOT in Move', () => {
    const text = render(<PinningExplainer />).container.textContent ?? '';
    expect(text).toMatch(/at signing, not in Move/i);
    expect(text).toMatch(/2-of-2/);
    expect(text).toMatch(/ctx\.sender\(\)/);
    // The overclaim we refuse to make.
    expect(text).not.toMatch(/Move enforces the destination/i);
    expect(text).not.toMatch(/cannot be redirected by anyone/i);
  });

  it('explains why a vault holding queue positions was rejected', () => {
    const text = render(<PinningExplainer />).container.textContent ?? '';
    expect(text).toMatch(/custodial by construction/i);
  });

  it('says so when no redemption address is configured, rather than showing a placeholder', () => {
    // vitest.config.ts pins VITE_REDEMPTION_ADDRESS to ''.
    const text = render(<PinningExplainer />).container.textContent ?? '';
    expect(text).toMatch(/VITE_REDEMPTION_ADDRESS/);
    expect(text).toMatch(/plausible-looking placeholder/i);
  });

  it('caps the unverifiable NAV leg at the verifiable claim behind it', () => {
    const text = render(<PinningExplainer />).container.textContent ?? '';
    expect(text).toMatch(/can never exceed the verifiable claim/i);
  });
});

describe('<KeeperCapabilityBadge/>', () => {
  it('names what the cap may call and what it may not', () => {
    const text = render(<KeeperCapabilityBadge />).container.textContent ?? '';
    expect(text).toMatch(/propose a NAV/i);
    expect(text).toMatch(/pinned allowlist/i);
    expect(text).toMatch(/may not/i);
    expect(text).toMatch(/rotate a capability/i);
  });

  it('states the structural guarantee: no address parameter at all', () => {
    const text = render(<KeeperCapabilityBadge />).container.textContent ?? '';
    expect(text).toMatch(/no parameter through which a destination could be smuggled/i);
  });

  it('states that liveness is permissionless — the keeper is not a gatekeeper', () => {
    const text = render(<KeeperCapabilityBadge />).container.textContent ?? '';
    expect(text).toMatch(/permissionless/i);
    expect(text).toMatch(/keeper is an optimisation/i);
  });
});

describe('<PendingCall/> — a panel with no data says so', () => {
  it('names the Move entries it is waiting on and offers no control', () => {
    const { container } = render(
      <PendingCall title="Your position" targets={['vault::request_deposit']} />,
    );
    const text = container.textContent ?? '';
    expect(text).toMatch(/no data yet/i);
    expect(text).toMatch(/vault::request_deposit/);
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(container.querySelectorAll('input')).toHaveLength(0);
  });

  it('renders the author’s own reason when one is given', () => {
    const { container } = render(
      <PendingCall title="X" targets={['a::b']} reason="The registry id is unset in this build." />,
    );
    expect(container.textContent ?? '').toMatch(/registry id is unset/i);
  });
});

describe('<AddressPill/>', () => {
  it('keeps the full address reachable even when it is visually truncated', () => {
    render(<AddressPill value={GOLDEN_P2TR} label="Redemption address (P2TR)" truncate />);
    expect(screen.getByText('Redemption address (P2TR)')).toBeTruthy();
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

// <TrustModelDisclosure/> is gone. It was a one-line footer repeated under every
// route, including the landing page, where it read as flat text under a full-bleed
// design and was the kind of disclosure people scroll past.
//
// The claims it carried did NOT go with it, and these are the tests that now own
// them, so a future deletion cannot quietly take the last copy:
//   · 'hBTC is custodial-threshold wrapped BTC' → test/limitations.test.tsx
//     ("calls hBTC custodial-threshold wrapped BTC and never the opposite"),
//     against <LimitationsPanel/>, which is mounted on /vault, /batch and /verify.
//   · the two-PARTIES NAV split and 'no keeper call takes an address' → the
//     assertions below, moved off the deleted component and onto the panel that
//     users actually see.
describe('<LimitationsPanel/> — the claims the deleted disclosure used to carry', () => {
  it('names two parties rather than two scopes, and the address-free keeper', () => {
    const text = render(<LimitationsPanel />).container.textContent ?? '';
    expect(text).toMatch(/custodial-threshold wrapped BTC/i);
    // Never the opposite claim, in any wording.
    expect(text).not.toMatch(/hBTC is trustless/i);
    expect(text).not.toMatch(/hBTC is non-custodial/i);
  });
});
