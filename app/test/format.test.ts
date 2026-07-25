// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.4, T3.2
// @phase      3
// @status     DONE
// @spec       docs/APP.md §3.1 · §7 A6
// @rules      G1 G3 G10
// @depends    ../src/lib/format.ts (T0.4) · ../src/lib/bech32.ts (T3.2)
// @facts      HASHI_WITHDRAWAL_MIN_SATS = 30_000 · BITCOIN_DUST_FLOOR_SATS = 546
// @facts      Money is bigint sats. `4.35 * 1e8` evaluates to 434_999_999.99999994
// @facts        in IEEE-754 — the canonical proof that parseBtcToSats must not use
// @facts        floating point. It is pinned below.
// @implements the A6 safety net for sats formatting/parsing and pinned-address
//             rendering.
// @forbidden  a `number` anywhere a sats amount is asserted
// @invariant  1. classifyExitAmount NEVER returns anything but dust|pooled|
//                submittable — there is no priority class to buy (G3).
// @verify     cd app && npm test
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import { encodeWitnessAddress, SIGNET_HRP } from '../src/lib/bech32';
import {
  classifyExitAmount,
  formatBtc,
  formatSats,
  parseBtcToSats,
  renderPinnedAddress,
  truncateMiddle,
} from '../src/lib/format';

const MIN_SATS = 30_000n;
const DUST_SATS = 546n;

function bytes(pattern: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = (pattern + i * 7) & 0xff;
  return out;
}

describe('renderPinnedAddress', () => {
  it('renders a 20-byte program as P2WPKH (witness v0, bech32)', () => {
    const program = bytes(0x2c, 20);
    const rendered = renderPinnedAddress(program);
    expect(rendered.kind).toBe('P2WPKH');
    expect(rendered.bech32).toBe(encodeWitnessAddress(SIGNET_HRP, 0, program));
    expect(rendered.bech32.startsWith('tb1q')).toBe(true);
    expect(rendered.hex).toHaveLength(40);
  });

  it('renders a 32-byte program as P2TR (witness v1, bech32m)', () => {
    const program = bytes(0x7b, 32);
    const rendered = renderPinnedAddress(program);
    expect(rendered.kind).toBe('P2TR');
    expect(rendered.bech32).toBe(encodeWitnessAddress(SIGNET_HRP, 1, program));
    expect(rendered.bech32.startsWith('tb1p')).toBe(true);
    expect(rendered.hex).toHaveLength(64);
  });

  it('reports any other length as INVALID and never guesses an address', () => {
    for (const length of [0, 19, 21, 31, 33, 64]) {
      const rendered = renderPinnedAddress(bytes(0x11, length));
      expect(rendered.kind).toBe('INVALID');
      // The critical part: no bech32 string is produced for a program Hashi
      // would reject with EInvalidBitcoinAddress.
      expect(rendered.bech32).toBe('');
      expect(rendered.hex).toHaveLength(length * 2);
    }
  });
});

describe('classifyExitAmount (G3 — three classes, none of them buyable)', () => {
  it('is dust strictly below the Bitcoin dust floor', () => {
    expect(classifyExitAmount(0n, MIN_SATS, DUST_SATS)).toBe('dust');
    expect(classifyExitAmount(545n, MIN_SATS, DUST_SATS)).toBe('dust');
  });

  it('is pooled at the dust floor exactly and just under the Hashi minimum', () => {
    expect(classifyExitAmount(546n, MIN_SATS, DUST_SATS)).toBe('pooled');
    expect(classifyExitAmount(29_999n, MIN_SATS, DUST_SATS)).toBe('pooled');
  });

  it('is submittable at 30_000 sats exactly and above', () => {
    expect(classifyExitAmount(30_000n, MIN_SATS, DUST_SATS)).toBe('submittable');
    expect(classifyExitAmount(30_001n, MIN_SATS, DUST_SATS)).toBe('submittable');
    expect(classifyExitAmount(10_000_000_000n, MIN_SATS, DUST_SATS)).toBe('submittable');
  });

  it('only ever returns one of the three honest classes', () => {
    const seen = new Set<string>();
    for (const sats of [0n, 545n, 546n, 29_999n, 30_000n, 1_000_000n]) {
      seen.add(classifyExitAmount(sats, MIN_SATS, DUST_SATS));
    }
    expect([...seen].sort()).toEqual(['dust', 'pooled', 'submittable']);
  });
});

describe('parseBtcToSats (no floating point, ever)', () => {
  it('parses whole and fractional BTC exactly', () => {
    expect(parseBtcToSats('1')).toBe(100_000_000n);
    expect(parseBtcToSats('0.1')).toBe(10_000_000n);
    expect(parseBtcToSats('0.0003')).toBe(30_000n);
    expect(parseBtcToSats('0.00000001')).toBe(1n);
    expect(parseBtcToSats('0')).toBe(0n);
    expect(parseBtcToSats('  0.0003  ')).toBe(30_000n);
    expect(parseBtcToSats('.5')).toBe(50_000_000n);
    expect(parseBtcToSats('1.')).toBe(100_000_000n);
  });

  it('does NOT lose the last sat where IEEE-754 would', () => {
    // 4.35 * 1e8 === 434999999.99999994 in double arithmetic.
    expect(4.35 * 1e8).not.toBe(435_000_000);
    expect(parseBtcToSats('4.35')).toBe(435_000_000n);

    // 1.005 * 1e8 === 100499999.99999999
    expect(parseBtcToSats('1.005')).toBe(100_500_000n);
    expect(parseBtcToSats('0.10000001')).toBe(10_000_001n);
  });

  it('stays exact far beyond Number.MAX_SAFE_INTEGER', () => {
    const parsed = parseBtcToSats('184467440.73709551');
    expect(parsed).toBe(18_446_744_073_709_551n);
    expect(typeof parsed).toBe('bigint');
    expect(Number(parsed) > Number.MAX_SAFE_INTEGER).toBe(true);
  });

  it('rejects anything that is not a non-negative decimal with <= 8 fraction digits', () => {
    for (const bad of ['', '.', '-1', '-0.5', 'abc', '1e8', '0.123456789', '1,5', '0x10', ' ']) {
      expect(parseBtcToSats(bad)).toBeNull();
    }
  });

  it('round-trips against formatBtc', () => {
    for (const sats of [0n, 1n, 30_000n, 144_137n, 100_000_000n, 2_100_000_000_000_000n]) {
      expect(parseBtcToSats(formatBtc(sats, { suffix: false }))).toBe(sats);
    }
  });
});

describe('formatSats / formatBtc / truncateMiddle', () => {
  it('groups sats and keeps large values exact', () => {
    expect(formatSats(0n)).toBe('0 sats');
    expect(formatSats(144_137n)).toBe('144,137 sats');
    expect(formatSats(2_100_000_000_000_000n)).toBe('2,100,000,000,000,000 sats');
    expect(formatSats(-30_000n)).toBe('-30,000 sats');
  });

  it('renders BTC with exactly 8 decimals', () => {
    expect(formatBtc(1n)).toBe('0.00000001 BTC');
    expect(formatBtc(144_137n)).toBe('0.00144137 BTC');
    expect(formatBtc(100_000_000n)).toBe('1.00000000 BTC');
    expect(formatBtc(100_000_000n, { suffix: false })).toBe('1.00000000');
    expect(formatBtc(-1n)).toBe('-0.00000001 BTC');
  });

  it('truncates in the middle only when the value is long enough to need it', () => {
    expect(truncateMiddle('0xabcdef')).toBe('0xabcdef');
    expect(truncateMiddle('0x0123456789abcdef0123', 6)).toBe('0x0123…ef0123');
  });
});
