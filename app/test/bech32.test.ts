// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T3.2
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/APP.md §3.1 · §7 A4
// @spec       docs/RECON.md R7 (request_withdrawal asserts addr_len == 20 || 32)
// @rules      G2 G7
// @depends    ../src/lib/bech32.ts (T3.2)
// @facts      BIP-173 known-answer vectors used here (mainnet + testnet):
// @facts        BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4
// @facts          -> v0, 751e76e8199196d454941c45d1b3a323f1433bd6   (20 B, P2WPKH)
// @facts        tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7
// @facts          -> v0, 1863143c…04903262                          (32 B, P2WSH)
// @facts      BIP-350 known-answer vector: the deposit golden address
// @facts        tb1pw58m0ar8yhcf0x7x3j5wlxr4jqxywhrf25vk6kpj95esrrrtnmlsdep54p
// @facts        was produced by @mysten/hashi's INDEPENDENT bech32m encoder, so
// @facts        decoding + re-encoding it cross-checks our codec against theirs.
// @implements the A4 safety net: a drifted address encoder sends BTC nowhere
//             recoverable, so every branch is pinned.
// @forbidden  a network call
// @invariant  1. Only 20-byte (v0) and 32-byte (v1) programs are ever accepted.
// @verify     cd app && npm test
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import {
  SIGNET_HRP,
  encodeWitnessAddress,
  hexFromProgram,
  parseExitAddressInput,
  programFromHex,
} from '../src/lib/bech32';

/** The signet P2TR the Hashi SDK derives for the deployer (golden vector). */
const GOLDEN_P2TR = 'tb1pw58m0ar8yhcf0x7x3j5wlxr4jqxywhrf25vk6kpj95esrrrtnmlsdep54p';

/** BIP-173 valid vector, witness version 0, 20-byte program. */
const BIP173_P2WPKH = 'BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4';
const BIP173_P2WPKH_PROGRAM = '751e76e8199196d454941c45d1b3a323f1433bd6';

/** BIP-173 valid vector, witness version 0, 32-byte program (P2WSH). */
const BIP173_P2WSH = 'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7';

function bytes(pattern: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = (pattern + i * 7) & 0xff;
  return out;
}

function ok(parse: ReturnType<typeof parseExitAddressInput>) {
  if (!parse.ok) throw new Error(`expected a successful parse, got: ${parse.error}`);
  return parse.value;
}

describe('bech32 / bech32m codec (lib/bech32.ts)', () => {
  describe('known-answer vectors', () => {
    it('decodes the BIP-173 v0 P2WPKH vector to the documented 20-byte program', () => {
      const value = ok(parseExitAddressInput(BIP173_P2WPKH, 'bc'));
      expect(value.kind).toBe('P2WPKH');
      expect(value.witnessVersion).toBe(0);
      expect(value.program).toHaveLength(20);
      expect(value.hex).toBe(BIP173_P2WPKH_PROGRAM);
      // Re-encoding must reproduce the canonical lowercase form.
      expect(value.bech32).toBe(BIP173_P2WPKH.toLowerCase());
    });

    it('decodes and re-encodes the Hashi-derived golden P2TR address byte-for-byte', () => {
      const value = ok(parseExitAddressInput(GOLDEN_P2TR));
      expect(value.kind).toBe('P2TR');
      expect(value.witnessVersion).toBe(1);
      expect(value.program).toHaveLength(32);
      expect(value.hrp).toBe(SIGNET_HRP);
      // Our bech32m encoder must agree with @mysten/hashi's, exactly.
      expect(value.bech32).toBe(GOLDEN_P2TR);
      expect(encodeWitnessAddress(SIGNET_HRP, 1, value.program)).toBe(GOLDEN_P2TR);
    });
  });

  describe('round-trips', () => {
    it('round-trips every 20-byte P2WPKH program through bech32 (v0)', () => {
      for (const seed of [0x00, 0x2c, 0x7b, 0xff]) {
        const program = bytes(seed, 20);
        const address = encodeWitnessAddress(SIGNET_HRP, 0, program);
        expect(address.startsWith('tb1q')).toBe(true);

        const value = ok(parseExitAddressInput(address));
        expect(value.kind).toBe('P2WPKH');
        expect(value.witnessVersion).toBe(0);
        expect([...value.program]).toEqual([...program]);
        expect(value.hex).toBe(hexFromProgram(program));
      }
    });

    it('round-trips every 32-byte P2TR program through bech32m (v1)', () => {
      for (const seed of [0x00, 0x2c, 0x7b, 0xff]) {
        const program = bytes(seed, 32);
        const address = encodeWitnessAddress(SIGNET_HRP, 1, program);
        expect(address.startsWith('tb1p')).toBe(true);

        const value = ok(parseExitAddressInput(address));
        expect(value.kind).toBe('P2TR');
        expect(value.witnessVersion).toBe(1);
        expect([...value.program]).toEqual([...program]);
        expect(value.hex).toBe(hexFromProgram(program));
      }
    });

    it('accepts the raw witness program in hex and yields the same bytes', () => {
      const program = bytes(0x7b, 32);
      const viaHex = ok(parseExitAddressInput(`0x${hexFromProgram(program)}`));
      const viaAddress = ok(parseExitAddressInput(encodeWitnessAddress(SIGNET_HRP, 1, program)));
      expect(viaHex.hex).toBe(viaAddress.hex);
      expect(viaHex.bech32).toBe(viaAddress.bech32);
    });
  });

  describe('rejections (the pin is write-once — G2)', () => {
    it('rejects a 19-byte witness program', () => {
      const parse = parseExitAddressInput(`0x${hexFromProgram(bytes(0x11, 19))}`);
      expect(parse.ok).toBe(false);
      if (parse.ok) return;
      expect(parse.error).toMatch(/20 bytes/);
      expect(parse.error).toMatch(/32 bytes/);
      expect(parse.error).toMatch(/19 bytes/);
    });

    it('rejects a 33-byte witness program', () => {
      const parse = parseExitAddressInput(`0x${hexFromProgram(bytes(0x11, 33))}`);
      expect(parse.ok).toBe(false);
      if (parse.ok) return;
      expect(parse.error).toMatch(/33 bytes/);
      expect(parse.error).toMatch(/EInvalidBitcoinAddress/);
    });

    it('rejects a bad checksum (one mutated character)', () => {
      // Flip the last data character; every other byte stays valid.
      const last = GOLDEN_P2TR.slice(-1);
      const mutated = `${GOLDEN_P2TR.slice(0, -1)}${last === 'p' ? 'q' : 'p'}`;
      expect(mutated).not.toBe(GOLDEN_P2TR);

      const parse = parseExitAddressInput(mutated);
      expect(parse.ok).toBe(false);
      if (parse.ok) return;
      expect(parse.error).toMatch(/checksum/i);
    });

    it('rejects a truncated address (bad checksum, not a silent short program)', () => {
      const parse = parseExitAddressInput(GOLDEN_P2TR.slice(0, GOLDEN_P2TR.length - 4));
      expect(parse.ok).toBe(false);
    });

    it('rejects a 32-byte witness version 0 program (P2WSH) even though Hashi would accept the length', () => {
      const parse = parseExitAddressInput(BIP173_P2WSH);
      expect(parse.ok).toBe(false);
      if (parse.ok) return;
      expect(parse.error).toMatch(/P2WSH/);
    });

    it('rejects an address for another Bitcoin network', () => {
      const parse = parseExitAddressInput(BIP173_P2WPKH.toLowerCase());
      expect(parse.ok).toBe(false);
      if (parse.ok) return;
      expect(parse.error).toMatch(/mainnet/);
      expect(parse.error).toMatch(/write-once/);
    });

    it('rejects mixed case, legacy base58 and empty input', () => {
      const mixed = parseExitAddressInput(`Tb1P${GOLDEN_P2TR.slice(4)}`);
      expect(mixed.ok).toBe(false);
      if (!mixed.ok) expect(mixed.error).toMatch(/[Mm]ixed/);

      const legacy = parseExitAddressInput('mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn');
      expect(legacy.ok).toBe(false);
      if (!legacy.ok) expect(legacy.error).toMatch(/legacy or P2SH/);

      expect(parseExitAddressInput('   ').ok).toBe(false);
    });
  });

  describe('programFromHex', () => {
    it('accepts 0x-prefixed and bare hex, rejects odd length and non-hex', () => {
      expect(programFromHex('0xdead')).toEqual(Uint8Array.from([0xde, 0xad]));
      expect(programFromHex('DEAD')).toEqual(Uint8Array.from([0xde, 0xad]));
      expect(programFromHex('dea')).toBeNull();
      expect(programFromHex('0xzz')).toBeNull();
      expect(programFromHex('')).toBeNull();
    });
  });
});
