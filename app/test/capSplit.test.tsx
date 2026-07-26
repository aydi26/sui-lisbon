// @vitest-environment jsdom
// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F2
// @phase      1
// @status     DONE
// @spec       aphotic.md §6.2 (NAV: two PARTIES, not two scopes) · CLAUDE.md G2 G3
// @spec       move/sources/caps.move — `CapRegistry { admin, keeper, .. }`
// @rules      G2 G3
// @depends    ../src/lib/vault.ts (parseCapRegistry) · ../src/screens/vault/NavPanel.tsx
// @facts      THIS FILE EXISTS BECAUSE THE CLAIM AND THE CHAIN CAN DISAGREE.
// @facts        G3 says NAV is two PARTIES: `propose_nav` (keeper) records, and
// @facts        `approve_nav` (admin multisig) commits. The Move enforces two
// @facts        CAPABILITIES — the bytecode is identical whether one key holds both
// @facts        or two parties do. So the guarantee lives in the DEPLOYMENT, and the
// @facts        only place to read it is `Vault.caps` (`admin`, `keeper`).
// @facts      OBSERVED ON TESTNET 2026-07-26: both fields are 0xd41b0cd8…f333d —
// @facts        the SAME address. The split is not live, and
// @facts        `scripts/verify-onchain.mjs` fails on it (`admin != keeper`).
// @facts      A screen asserting a separation that does not exist is exactly the
// @facts        dishonest case G2 forbids, so these cases pin the copy: the
// @facts        guarantee may only appear when the two addresses DIFFER.
// @facts      No network and no config: `vitest.config.ts` pins every VITE_* empty,
// @facts        which is why the parsing half and the copy half are both exported.
// @implements the anti-overclaiming safety net for the two-party NAV split
// @forbidden  deleting a case here to let unconditional copy back in — if the split
//             is not live the screen says so, or the claim was never honest
// @invariant  1. splitLive is true only for two DIFFERENT addresses.
// @invariant  2. admin == keeper never renders the guarantee.
// @invariant  3. Before any read, the screen promises neither.
// @ac         all cases below
// @verify     cd app && npm test -- capSplit
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { parseCapRegistry, type CapRegistryRead } from '../src/lib/vault';
import { TwoPartyNote } from '../src/screens/vault/NavPanel';

const ADMIN = '0xd41b0cd83fc1a497a5899eb686e2c7561e75e6d62db2270860d72542f63f333d';
const OTHER = '0x48ae587dfa4c0011e764ed5dfb8fd79aec082d79cd2a3969fe277ed6c887b725';

/** The shape sui_getObject returns for the vault, trimmed to what we read. */
function vaultFields(admin: string, keeper: string, extra?: Record<string, unknown>) {
  return {
    caps: {
      type: 'pkg::caps::CapRegistry',
      fields: {
        admin,
        keeper,
        admin_epoch: '0',
        keeper_epoch: '0',
        pending_admin: null,
        paused: false,
        ...extra,
      },
    },
  };
}

describe('parseCapRegistry reads the split off the chain rather than asserting it', () => {
  it('one address in both roles is NOT a live split', () => {
    const caps = parseCapRegistry(vaultFields(ADMIN, ADMIN));
    expect(caps.admin).toBe(ADMIN);
    expect(caps.keeper).toBe(ADMIN);
    expect(caps.splitLive).toBe(false);
  });

  it('two distinct addresses ARE a live split', () => {
    expect(parseCapRegistry(vaultFields(ADMIN, OTHER)).splitLive).toBe(true);
  });

  it('compares case-insensitively — a mixed-case hex twin is still one key', () => {
    const twin = `0x${ADMIN.slice(2).toUpperCase()}`;
    expect(parseCapRegistry(vaultFields(ADMIN, twin)).splitLive).toBe(false);
  });

  it('carries the rotation epochs and a pending handover', () => {
    const caps = parseCapRegistry(
      vaultFields(ADMIN, OTHER, { admin_epoch: '3', keeper_epoch: '7', pending_admin: OTHER }),
    );
    expect(caps.adminEpoch).toBe(3n);
    expect(caps.keeperEpoch).toBe(7n);
    expect(caps.pendingAdmin).toBe(OTHER);
  });

  it('reports no pending handover as null, never as a zero address', () => {
    expect(parseCapRegistry(vaultFields(ADMIN, OTHER)).pendingAdmin).toBeNull();
  });

  it('keeps every u64 a bigint — an epoch is never narrowed', () => {
    const caps = parseCapRegistry(vaultFields(ADMIN, OTHER, { admin_epoch: '18446744073709551615' }));
    expect(caps.adminEpoch).toBe(18_446_744_073_709_551_615n);
  });

  it('throws rather than guessing when the vault exposes no caps field', () => {
    expect(() => parseCapRegistry({})).toThrow(/no .caps. field/);
  });

  it('throws rather than guessing when a role is not an address', () => {
    expect(() => parseCapRegistry(vaultFields(ADMIN, 'not-an-address'))).toThrow(/keeper/);
  });
});

// ── the copy must not overclaim ─────────────────────────────────────────────

const SAME: CapRegistryRead = {
  admin: ADMIN,
  keeper: ADMIN,
  adminEpoch: 0n,
  keeperEpoch: 0n,
  pendingAdmin: null,
  splitLive: false,
};
const SPLIT: CapRegistryRead = { ...SAME, keeper: OTHER, splitLive: true };

const GUARANTEE = /and this deployment holds it/i;
const WARNING = /two-party NAV split is not live/i;

const textOf = (caps: CapRegistryRead | null) =>
  render(<TwoPartyNote caps={caps} />).container.textContent ?? '';

describe('TwoPartyNote never asserts a split the deployment does not have', () => {
  afterEach(cleanup);

  it('promises neither before anything has been read', () => {
    const text = textOf(null);
    expect(text).not.toMatch(GUARANTEE);
    expect(text).not.toMatch(WARNING);
    expect(text).toMatch(/property of this deployment, not of the code/i);
  });

  it('warns, and withholds the guarantee, when one key holds both roles', () => {
    const text = textOf(SAME);
    expect(text).toMatch(WARNING);
    expect(text).not.toMatch(GUARANTEE);
    // the address is named, so a reader can check it without asking us
    expect(text).toContain('0xd41b…');
  });

  it('does not dress the gap up as an on-chain guarantee', () => {
    const text = textOf(SAME);
    expect(text).toMatch(/one key holds both roles/i);
    expect(text).toMatch(/a comment right now, not a control/i);
  });

  it('states the guarantee, with BOTH addresses, once the roles differ', () => {
    const text = textOf(SPLIT);
    expect(text).toMatch(GUARANTEE);
    expect(text).not.toMatch(WARNING);
    expect(text).toContain('0xd41b…');
    expect(text).toContain('0x48ae…');
  });
});
