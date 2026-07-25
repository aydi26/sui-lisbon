// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.4, T3.1, T3.2
// @phase      3
// @status     DONE
// @spec       docs/APP.md §5 (DEMO_MODE) · §7 A11 (all three screens walk with
//             zero signet/RPC)
// @rules      G3 G5 G6 G7 G8
// @depends    ../src/hashi/index.ts (T0.4) · ../src/fixtures (T0.4)
// @facts      DEMO_MODE=mock must resolve ENTIRELY from src/fixtures: zero network.
// @facts      DEMO_MODE=live must NEVER return fixture data for something the
// @facts        browser cannot do — it throws LiveModeUnsupportedError naming the
// @facts        keeper command instead (G6).
// @facts      guardian.limiterStatus is ADVISORY in both modes; the authoritative
// @facts        limiter is the keeper's replay of WithdrawalSigned (G5).
// @implements the A11 safety net.
// @forbidden  a network call — `fetch` is stubbed to throw and getSuiClient is
//             mocked to throw, so ANY I/O in mock mode fails the suite
// @invariant  1. mock mode performs zero I/O.
//             2. live mode never leaks a fixture value.
// @ac         docs/APP.md §7 A11
// @verify     cd app && npm test
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ demoMode: 'mock' as 'mock' | 'live' }));

vi.mock('../src/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config')>();
  const cfg: Record<string, unknown> = { ...actual.config };
  Object.defineProperty(cfg, 'demoMode', { get: () => state.demoMode, enumerable: true });
  return { ...actual, config: cfg, isMock: () => state.demoMode === 'mock' };
});

// Mock mode must never construct a Sui client. Live mode only uses it for the
// two calls a browser can honestly make, neither of which is exercised here.
vi.mock('../src/lib/suiClient', () => ({
  getSuiClient: () => {
    throw new Error('getSuiClient() must not be reached in this suite');
  },
  getJsonRpcClient: () => {
    throw new Error('getJsonRpcClient() must not be reached in this suite');
  },
  resetSuiClients: () => {},
}));

import {
  demoFixtures,
  depositFixtures,
  exitFixtures,
  prestagedConfirmedExit,
  warmDeposit,
} from '../src/fixtures';
import { LiveModeUnsupportedError, getHashiAdapter, resetHashiAdapter } from '../src/hashi';

function useMode(mode: 'mock' | 'live') {
  state.demoMode = mode;
  resetHashiAdapter();
  return getHashiAdapter();
}

beforeEach(() => {
  resetHashiAdapter();
  vi.stubGlobal('fetch', () => {
    throw new Error('no network is allowed in this suite');
  });
  vi.stubGlobal('XMLHttpRequest', function XHR() {
    throw new Error('no network is allowed in this suite');
  });
});

afterEach(() => {
  state.demoMode = 'mock';
  resetHashiAdapter();
  vi.unstubAllGlobals();
});

describe('mock binding — resolves from fixtures with zero network', () => {
  it('returns the fixture deposit address for a known Sui address', async () => {
    const hashi = useMode('mock');
    const fixture = depositFixtures[0]!;
    await expect(hashi.generateDepositAddress({ suiAddress: fixture.suiAddress })).resolves.toBe(
      fixture.depositAddress,
    );
  });

  it('falls back to the warm deposit for an unknown Sui address', async () => {
    const hashi = useMode('mock');
    await expect(hashi.generateDepositAddress({ suiAddress: '0xdeadbeef' })).resolves.toBe(
      warmDeposit.depositAddress,
    );
  });

  it('counts only MINTED deposits in the balance, and returns bigint sats', async () => {
    const hashi = useMode('mock');
    const owner = depositFixtures[0]!.suiAddress;
    const expected = depositFixtures
      .filter((d) => d.suiAddress === owner && d.mintDigest !== undefined)
      .reduce((sum, d) => sum + d.amountSats, 0n);

    const balance = await hashi.view.balance({ suiAddress: owner });
    expect(typeof balance).toBe('bigint');
    expect(balance).toBe(expected);

    // A deposit still mid-flight must NOT be counted as minted hBTC (G1/G6).
    const inFlight = depositFixtures.filter(
      (d) => d.suiAddress === owner && d.mintDigest === undefined,
    );
    expect(inFlight.length).toBeGreaterThan(0);
    expect(balance).toBeLessThan(
      expected + inFlight.reduce((sum, d) => sum + d.amountSats, 0n) + 1n,
    );
  });

  it('reports the deposit stage and confirmation count from the fixture', async () => {
    const hashi = useMode('mock');
    await expect(hashi.view.depositStatus({ requestId: warmDeposit.requestId })).resolves.toEqual({
      stage: warmDeposit.stage,
      confs: warmDeposit.confs,
    });
  });

  it('maps exit phases A/B/done onto stages 1/2/3', async () => {
    const hashi = useMode('mock');
    const done = exitFixtures.find((e) => e.phase === 'done')!;
    const phaseA = exitFixtures.find((e) => e.phase === 'A')!;

    await expect(hashi.view.withdrawalStatus({ requestId: done.requestId })).resolves.toEqual({
      stage: 3,
      signetTxid: done.signetTxid,
    });
    await expect(hashi.view.withdrawalStatus({ requestId: phaseA.requestId })).resolves.toEqual({
      stage: 1,
      signetTxid: undefined,
    });
  });

  it('returns the mint digest for a minted deposit and REFUSES to invent one otherwise', async () => {
    const hashi = useMode('mock');
    const minted = depositFixtures.find((d) => d.mintDigest !== undefined)!;
    const pending = depositFixtures.find((d) => d.mintDigest === undefined)!;

    await expect(hashi.waitForDeposit({ requestId: minted.requestId })).resolves.toEqual({
      mintDigest: minted.mintDigest,
    });
    await expect(hashi.waitForDeposit({ requestId: pending.requestId })).rejects.toThrow(
      /has not minted yet/,
    );
  });

  it('returns the pre-staged signet txid and REFUSES to invent one otherwise', async () => {
    const hashi = useMode('mock');
    const pending = exitFixtures.find((e) => e.signetTxid === undefined)!;

    await expect(
      hashi.waitForWithdrawal({ requestId: prestagedConfirmedExit.requestId }),
    ).resolves.toEqual({ signetTxid: prestagedConfirmedExit.signetTxid });
    await expect(hashi.waitForWithdrawal({ requestId: pending.requestId })).rejects.toThrow(
      /has not been broadcast yet/,
    );
  });

  it('serves the ADVISORY limiter read from the bridge fixture (G5)', async () => {
    const hashi = useMode('mock');
    const status = await hashi.guardian.limiterStatus();
    expect(status).toEqual({
      capacitySats: demoFixtures.bridge.sdkLimiter.capacitySats,
      queueDepth: demoFixtures.bridge.sdkLimiter.queueDepth,
    });
    expect(typeof status.capacitySats).toBe('bigint');
  });

  it('canWithdraw is a capacity check, never a queue position (G3)', async () => {
    const hashi = useMode('mock');
    const cap = demoFixtures.bridge.sdkLimiter.capacitySats;
    await expect(hashi.guardian.canWithdraw({ amountSats: cap })).resolves.toBe(true);
    await expect(hashi.guardian.canWithdraw({ amountSats: cap + 1n })).resolves.toBe(false);
    await expect(hashi.guardian.canWithdraw({ amountSats: 30_000n })).resolves.toBe(true);
  });

  it('memoises the binding and hands the same instance back', () => {
    const a = useMode('mock');
    const b = getHashiAdapter();
    expect(b).toBe(a);
  });
});

describe('live binding — throws LiveModeUnsupportedError, never fixture data', () => {
  const fixtureValues = new Set<unknown>([
    warmDeposit.depositAddress,
    prestagedConfirmedExit.signetTxid,
    demoFixtures.bridge.sdkLimiter.capacitySats,
  ]);

  const cases: readonly [string, (h: ReturnType<typeof getHashiAdapter>) => Promise<unknown>][] = [
    ['view.depositStatus', (h) => h.view.depositStatus({ requestId: 'r' })],
    ['view.withdrawalStatus', (h) => h.view.withdrawalStatus({ requestId: 'r' })],
    ['waitForDeposit', (h) => h.waitForDeposit({ requestId: 'r' })],
    ['waitForWithdrawal', (h) => h.waitForWithdrawal({ requestId: 'r' })],
    ['guardian.limiterStatus', (h) => h.guardian.limiterStatus()],
    ['guardian.canWithdraw', (h) => h.guardian.canWithdraw({ amountSats: 30_000n })],
  ];

  for (const [name, call] of cases) {
    it(`${name}() throws LiveModeUnsupportedError naming a keeper command`, async () => {
      const hashi = useMode('live');
      let thrown: unknown;
      let resolved: unknown;
      try {
        resolved = await call(hashi);
      } catch (err) {
        thrown = err;
      }

      expect(resolved).toBeUndefined();
      expect(thrown).toBeInstanceOf(LiveModeUnsupportedError);
      const error = thrown as LiveModeUnsupportedError;
      expect(error.name).toBe('LiveModeUnsupportedError');
      expect(error.keeperCommand.length).toBeGreaterThan(0);
      expect(error.message).toMatch(/keeper/);
      // The point of the rule: no fixture value ever escapes in live mode.
      expect(fixtureValues.has(resolved)).toBe(false);
    });
  }

  it('binds a DIFFERENT adapter than mock mode once the cache is dropped', async () => {
    const mock = useMode('mock');
    const live = useMode('live');
    expect(live).not.toBe(mock);
    await expect(mock.view.depositStatus({ requestId: warmDeposit.requestId })).resolves.toEqual({
      stage: warmDeposit.stage,
      confs: warmDeposit.confs,
    });
  });
});
