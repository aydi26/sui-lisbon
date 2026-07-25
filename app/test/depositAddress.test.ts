// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T3.1
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/APP.md §2.3 (client-side derivation, no server round-trip), §7 A1
// @spec       docs/APP.md ERRATA E-A5 · docs/RECON.md R5 R6
// @rules      G6 G7 G8
// @depends    ../src/hashi/depositAddress.ts (T3.1)
// @facts      THE GOLDEN VECTOR (verified live on the Hashi shared object
// @facts        2026-07-25 and against @mysten/hashi 0.6.0):
// @facts        mpc raw (arkworks) 391d3d8e999367dd9befa4b391fadf5d67025fb30ca7b09b05b9b02ead558f3680
// @facts        mpc SEC1           02368f55ad2eb0b9059bb0a70cb35f02675ddffa91b3a4ef9bdd6793998e3d1d39
// @facts        guardian x-only    41c404498b384691bda6804fb491142b1d6d0867fc617c498d58337b02498995
// @facts        sui address        0xd41b0cd83fc1a497a5899eb686e2c7561e75e6d62db2270860d72542f63f333d
// @facts        network            signet
// @facts        ⇒ tb1pw58m0ar8yhcf0x7x3j5wlxr4jqxywhrf25vk6kpj95esrrrtnmlsdep54p
// @facts      Stored WITHOUT the 0x prefix: this is key material for a
// @facts        known-answer test, not a canonical object id (G7 / A10).
// @facts      Live gRPC JSON shapes (observed 2026-07-25 on this exact endpoint):
// @facts        mpc_public_key          -> base64, 33 B, ARKWORKS compression
// @facts        guardian_btc_public_key -> { '@variant': 'Bytes', pos0: base64 }
// @facts                                   inside the config VecMap, NOT a field
// @implements the A1 safety net. A wrong deposit address sends Bitcoin somewhere
//             unrecoverable, so the whole pipeline (arkworks -> SEC1 -> child key
//             -> 2-of-2 taproot -> bech32m) is pinned to the golden vector.
// @forbidden  a real network call — the chain read is mocked, the derivation is not
// @forbidden  importing '@mysten/hashi' here — the SDK is reached ONLY through
//             src/hashi/depositAddress.ts (G7)
// @invariant  1. The derivation is pure: same keys + same address ⇒ same string,
//                with zero I/O.
//             2. A wrong-length key is REJECTED, never truncated or padded.
// @ac         docs/APP.md §7 A1
// @verify     cd app && npm test
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The ONLY network touchpoint in this module is getSuiClient().core.getObjects.
// Replacing it proves the derivation itself is offline: any real fetch would
// throw, because `fetch` is stubbed to explode in beforeEach.
const rpc = vi.hoisted(() => ({ getObjects: vi.fn() }));

vi.mock('../src/lib/suiClient', () => ({
  getSuiClient: () => ({ core: { getObjects: rpc.getObjects } }),
  getJsonRpcClient: () => {
    throw new Error('the deposit path must never use JSON-RPC');
  },
  resetSuiClients: () => {},
}));

import {
  bip21,
  bytesToHex,
  deriveDepositAddress,
  derivationSelfCheck,
  readHashiDepositKeys,
  suiAddressToBytes,
  type HashiDepositKeys,
} from '../src/hashi/depositAddress';

const VECTOR = {
  mpcArkworksHex: '391d3d8e999367dd9befa4b391fadf5d67025fb30ca7b09b05b9b02ead558f3680',
  mpcSec1Hex: '02368f55ad2eb0b9059bb0a70cb35f02675ddffa91b3a4ef9bdd6793998e3d1d39',
  guardianHex: '41c404498b384691bda6804fb491142b1d6d0867fc617c498d58337b02498995',
  suiAddress: '0xd41b0cd83fc1a497a5899eb686e2c7561e75e6d62db2270860d72542f63f333d',
  expectedAddress: 'tb1pw58m0ar8yhcf0x7x3j5wlxr4jqxywhrf25vk6kpj95esrrrtnmlsdep54p',
} as const;

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toBase64(hex: string): string {
  return Buffer.from(fromHex(hex)).toString('base64');
}

/** The keys as `readHashiDepositKeys` would return them (SEC1, already converted). */
const GOLDEN_KEYS: HashiDepositKeys = {
  mpcMasterCompressed: fromHex(VECTOR.mpcSec1Hex),
  guardianBtcXOnly: fromHex(VECTOR.guardianHex),
  sourceObjectId: '0xhashi',
};

/**
 * The live gRPC shape: `mpc_public_key` is a plain field carrying ARKWORKS bytes,
 * `guardian_btc_public_key` lives inside the config VecMap wrapped in a variant
 * envelope. Both are reproduced faithfully so a shape regression is caught here.
 */
function grpcHashiObject() {
  return {
    objects: [
      {
        json: {
          committee_set: {
            epoch: '7',
            mpc_public_key: toBase64(VECTOR.mpcArkworksHex),
          },
          config: {
            config: {
              contents: [
                { key: 'bitcoin_deposit_minimum', value: '30000' },
                {
                  key: 'guardian_btc_public_key',
                  value: { '@variant': 'Bytes', pos0: toBase64(VECTOR.guardianHex) },
                },
              ],
            },
          },
        },
      },
    ],
  };
}

describe('deposit-address derivation (T3.1 — the highest-stakes code in the app)', () => {
  beforeEach(() => {
    rpc.getObjects.mockReset();
    // Any accidental network access is a hard failure, not a slow test.
    vi.stubGlobal('fetch', () => {
      throw new Error('no network is allowed in this suite');
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('the golden vector', () => {
    it('reproduces tb1pw58m0…dep54p exactly', () => {
      expect(deriveDepositAddress(GOLDEN_KEYS, VECTOR.suiAddress)).toBe(VECTOR.expectedAddress);
    });

    it('passes the built-in self-check (arkworks → SEC1 → child key → taproot → bech32m)', () => {
      const check = derivationSelfCheck();
      expect(check.ok).toBe(true);
      expect(check.got).toBe(VECTOR.expectedAddress);
      expect(check.expected).toBe(VECTOR.expectedAddress);
    });

    it('derives from the on-chain read with zero network, matching the golden vector', async () => {
      rpc.getObjects.mockResolvedValue(grpcHashiObject());

      const keys = await readHashiDepositKeys();

      // The arkworks → SEC1 conversion is mandatory; the raw bytes make the SDK
      // throw `bad point`.
      expect(bytesToHex(keys.mpcMasterCompressed)).toBe(VECTOR.mpcSec1Hex);
      expect(bytesToHex(keys.mpcMasterCompressed)).not.toBe(VECTOR.mpcArkworksHex);
      expect(bytesToHex(keys.guardianBtcXOnly)).toBe(VECTOR.guardianHex);

      expect(deriveDepositAddress(keys, VECTOR.suiAddress)).toBe(VECTOR.expectedAddress);
      expect(rpc.getObjects).toHaveBeenCalledTimes(1);
    });

    it('is a real signet P2TR: tb1p prefix, 62 characters, bech32 charset only', () => {
      const address = deriveDepositAddress(GOLDEN_KEYS, VECTOR.suiAddress);
      expect(address.startsWith('tb1p')).toBe(true);
      expect(address).toHaveLength(62);
      expect(/^tb1p[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$/.test(address)).toBe(true);
    });
  });

  describe('purity and determinism', () => {
    it('is deterministic and does no I/O', () => {
      const a = deriveDepositAddress(GOLDEN_KEYS, VECTOR.suiAddress);
      const b = deriveDepositAddress(GOLDEN_KEYS, VECTOR.suiAddress);
      expect(a).toBe(b);
      expect(rpc.getObjects).not.toHaveBeenCalled();
    });

    it('binds the address to the Sui address — a different depositor gets a different address', () => {
      const other = '0x0000000000000000000000000000000000000000000000000000000000000001';
      const derived = deriveDepositAddress(GOLDEN_KEYS, other);
      expect(derived).not.toBe(VECTOR.expectedAddress);
      expect(derived.startsWith('tb1p')).toBe(true);
    });

    it('binds the address to the guardian key — a different bridge key gives a different address', () => {
      const tweaked = Uint8Array.from(GOLDEN_KEYS.guardianBtcXOnly);
      tweaked[31] ^= 0x01;
      const derived = deriveDepositAddress(
        { ...GOLDEN_KEYS, guardianBtcXOnly: tweaked },
        VECTOR.suiAddress,
      );
      expect(derived).not.toBe(VECTOR.expectedAddress);
    });

    it('accepts the Sui address with or without the 0x prefix', () => {
      expect(deriveDepositAddress(GOLDEN_KEYS, VECTOR.suiAddress.slice(2))).toBe(
        VECTOR.expectedAddress,
      );
    });
  });

  describe('suiAddressToBytes', () => {
    it('returns exactly 32 bytes and left-pads a short address', () => {
      const full = suiAddressToBytes(VECTOR.suiAddress);
      expect(full).toHaveLength(32);
      expect(bytesToHex(full)).toBe(VECTOR.suiAddress.slice(2));

      const short = suiAddressToBytes('0x1');
      expect(short).toHaveLength(32);
      expect(bytesToHex(short)).toBe('0'.repeat(63) + '1');
      expect(short[0]).toBe(0);
    });

    it('rejects a non-hex or over-long address', () => {
      expect(() => suiAddressToBytes('not-an-address')).toThrow(/Not a Sui address/);
      expect(() => suiAddressToBytes(`0x${'a'.repeat(66)}`)).toThrow(/Not a Sui address/);
      expect(() => suiAddressToBytes('0x')).toThrow(/Not a Sui address/);
    });
  });

  describe('key-length guards (a wrong key must never produce an address)', () => {
    it('rejects a short MPC key', () => {
      expect(() =>
        deriveDepositAddress(
          { ...GOLDEN_KEYS, mpcMasterCompressed: GOLDEN_KEYS.mpcMasterCompressed.slice(0, 32) },
          VECTOR.suiAddress,
        ),
      ).toThrow(/MPC key is 32 bytes, expected 33/);
    });

    it('rejects a wrong-length guardian key', () => {
      expect(() =>
        deriveDepositAddress(
          { ...GOLDEN_KEYS, guardianBtcXOnly: GOLDEN_KEYS.guardianBtcXOnly.slice(0, 31) },
          VECTOR.suiAddress,
        ),
      ).toThrow(/Guardian key is 31 bytes, expected 32/);
    });
  });

  describe('readHashiDepositKeys failure modes (never a fallback constant)', () => {
    it('throws when the Hashi object is missing', async () => {
      rpc.getObjects.mockResolvedValue({ objects: [undefined] });
      await expect(readHashiDepositKeys()).rejects.toThrow(/not found/);
    });

    it('throws when the object carries no readable content', async () => {
      rpc.getObjects.mockResolvedValue({ objects: [{ json: null }] });
      await expect(readHashiDepositKeys()).rejects.toThrow(/no readable content/);
    });

    it('throws when mpc_public_key is absent', async () => {
      const payload = grpcHashiObject();
      delete (payload.objects[0]!.json.committee_set as Record<string, unknown>).mpc_public_key;
      rpc.getObjects.mockResolvedValue(payload);
      await expect(readHashiDepositKeys()).rejects.toThrow(/mpc_public_key not found/);
    });

    it('throws when guardian_btc_public_key is absent from the config VecMap', async () => {
      const payload = grpcHashiObject();
      payload.objects[0]!.json.config.config.contents = [
        { key: 'bitcoin_deposit_minimum', value: '30000' },
      ];
      rpc.getObjects.mockResolvedValue(payload);
      await expect(readHashiDepositKeys()).rejects.toThrow(/guardian_btc_public_key not found/);
    });

    it('rejects a truncated key rather than silently padding it', async () => {
      const payload = grpcHashiObject();
      payload.objects[0]!.json.committee_set.mpc_public_key = toBase64(
        VECTOR.mpcArkworksHex.slice(0, 60),
      );
      rpc.getObjects.mockResolvedValue(payload);
      await expect(readHashiDepositKeys()).rejects.toThrow(/expected 33 bytes/);
    });

    it('propagates an RPC error instead of returning a guessed address', async () => {
      rpc.getObjects.mockRejectedValue(new Error('grpc unavailable'));
      await expect(readHashiDepositKeys()).rejects.toThrow(/grpc unavailable/);
    });
  });

  describe('bip21', () => {
    it('wraps the address in a bitcoin: URI without altering it', () => {
      expect(bip21(VECTOR.expectedAddress)).toBe(`bitcoin:${VECTOR.expectedAddress}`);
    });
  });
});
