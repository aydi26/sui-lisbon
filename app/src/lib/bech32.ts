// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T3.2
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/APP.md §3.1 (<PinnedAddressPanel/> renders the 20-byte P2WPKH /
//             32-byte P2TR witness program), §7 A4
// @spec       docs/RECON.md R7 (request_withdrawal asserts addr_len == 20 || 32)
// @rules      G2 G7
// @depends    (none — pure, offline, zero network)
// @facts      BIP-173 bech32 checksum constant  = 1          (witness version 0)
// @facts      BIP-350 bech32m checksum constant = 0x2bc830a3 (witness versions 1..16)
// @facts      bech32 charset = qpzry9x8gf2tvdw0s3jn54khce6mua7l (no 1/b/i/o)
// @facts      SIGNET_HRP = 'tb'. Signet and testnet3 share the 'tb' prefix; mainnet
// @facts        is 'bc' and regtest is 'bcrt'. The Bitcoin side of this vault is
// @facts        SIGNET (RECON R6: bitcoin_chain_id = the signet genesis hash).
// @facts      ⚠ Hashi asserts on the WITNESS PROGRAM LENGTH only — 20 (P2WPKH) or
// @facts        32 (P2TR). A 32-byte witness *v0* program is P2WSH and would pass
// @facts        the upstream length assert while being an address the guardians
// @facts        cannot pay to the way the user expects, so we reject it HERE, at
// @facts        pin time, where the mistake is still recoverable. After
// @facts        gateway::register_exit_address it is write-once forever (G2).
// @external   public fun hashi::withdraw::request_withdrawal(..., bitcoin_address: vector<u8>, ...)
//             // asserts addr_len == 20 || addr_len == 32   EInvalidBitcoinAddress
// @implements export function encodeWitnessAddress(hrp, version, program): string
//             export function parseExitAddressInput(raw, hrp?): ExitAddressParse
//             export function programFromHex(hex: string): Uint8Array | null
//             export function hexFromProgram(program: Uint8Array): string
// @forbidden  a network call — pinning must work fully offline
// @forbidden  a canonical on-chain id literal here — G7
// @invariant  1. parseExitAddressInput NEVER returns ok for a program that is not
//                exactly 20 or 32 bytes — the upstream assert would abort.
// @invariant  2. Witness version 0 is validated against bech32, versions 1..16
//                against bech32m. A spec mismatch is rejected, never coerced.
// @invariant  3. An address for another Bitcoin network is REJECTED, not warned
//                about: the pin is write-once and unrecoverable (G2).
// @ac         docs/APP.md §7 A4
// @verify     cd app && npx tsc --noEmit
// └── END CONTRACT ───────────────────────────────────────────────────────────

/** BIP-173 charset. Deliberately excludes 1, b, i and o. */
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

/** Checksum constant for witness version 0 (BIP-173). */
const BECH32_CONST = 1;
/** Checksum constant for witness versions 1..16 (BIP-350). */
const BECH32M_CONST = 0x2bc830a3;

/** Human-readable part for Bitcoin signet. */
export const SIGNET_HRP = 'tb';

/** Friendly network names, for error copy only. */
const HRP_NETWORK: Record<string, string> = {
  bc: 'mainnet',
  tb: 'signet / testnet',
  bcrt: 'regtest',
};

type Spec = typeof BECH32_CONST | typeof BECH32M_CONST;

function polymod(values: readonly number[]): number {
  let chk = 1;
  for (const value of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i += 1) {
      if (((top >>> i) & 1) === 1) chk ^= GENERATOR[i];
    }
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i += 1) out.push(hrp.charCodeAt(i) >>> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i += 1) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

function createChecksum(hrp: string, data: readonly number[], spec: Spec): number[] {
  const values = [...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const mod = polymod(values) ^ spec;
  const out: number[] = [];
  for (let p = 0; p < 6; p += 1) out.push((mod >>> (5 * (5 - p))) & 31);
  return out;
}

function bech32Encode(hrp: string, data: readonly number[], spec: Spec): string {
  const combined = [...data, ...createChecksum(hrp, data, spec)];
  let out = `${hrp}1`;
  for (const d of combined) out += CHARSET.charAt(d);
  return out;
}

type Bech32Decoded = { hrp: string; data: number[]; spec: Spec };

type DecodeFailure =
  | 'mixed-case'
  | 'too-long'
  | 'no-separator'
  | 'bad-charset'
  | 'bad-checksum';

function bech32Decode(input: string): Bech32Decoded | DecodeFailure {
  const hasLower = /[a-z]/.test(input);
  const hasUpper = /[A-Z]/.test(input);
  if (hasLower && hasUpper) return 'mixed-case';

  const s = input.toLowerCase();
  if (s.length > 90) return 'too-long';

  const pos = s.lastIndexOf('1');
  if (pos < 1 || pos + 7 > s.length) return 'no-separator';

  const hrp = s.slice(0, pos);
  const data: number[] = [];
  for (let i = pos + 1; i < s.length; i += 1) {
    const v = CHARSET.indexOf(s.charAt(i));
    if (v === -1) return 'bad-charset';
    data.push(v);
  }

  const check = polymod([...hrpExpand(hrp), ...data]);
  const spec: Spec | null =
    check === BECH32_CONST ? BECH32_CONST : check === BECH32M_CONST ? BECH32M_CONST : null;
  if (spec === null) return 'bad-checksum';

  return { hrp, data: data.slice(0, data.length - 6), spec };
}

/** 8-bit ⇄ 5-bit regrouping (BIP-173 `convertbits`). */
function convertBits(
  data: readonly number[],
  from: number,
  to: number,
  pad: boolean,
): number[] | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  const maxAcc = (1 << (from + to - 1)) - 1;

  for (const value of data) {
    if (value < 0 || value >> from !== 0) return null;
    acc = ((acc << from) | value) & maxAcc;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) {
    return null;
  }
  return out;
}

/**
 * Render a witness program as a segwit address. Version 0 uses bech32, every
 * later version uses bech32m (BIP-350).
 *
 * This is a DISPLAY convenience only: the bytes pinned on-chain are the source
 * of truth (G2).
 */
export function encodeWitnessAddress(
  hrp: string,
  version: number,
  program: Uint8Array,
): string {
  const squashed = convertBits([...program], 8, 5, true);
  if (squashed === null) return '';
  const spec: Spec = version === 0 ? BECH32_CONST : BECH32M_CONST;
  return bech32Encode(hrp, [version, ...squashed], spec);
}

/** Lowercase hex of a witness program, no `0x`. */
export function hexFromProgram(program: Uint8Array): string {
  let out = '';
  for (const b of program) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Parse lowercase/uppercase hex (optionally `0x`-prefixed) into bytes. */
export function programFromHex(hex: string): Uint8Array | null {
  const clean = hex.trim().replace(/^0x/i, '');
  if (clean.length === 0 || clean.length % 2 !== 0) return null;
  if (!/^[0-9a-f]+$/i.test(clean)) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export type ExitAddressKind = 'P2WPKH' | 'P2TR';

export interface ParsedExitAddress {
  readonly kind: ExitAddressKind;
  readonly witnessVersion: 0 | 1;
  /** The bytes that `gateway::register_exit_address` writes into the Vault. */
  readonly program: Uint8Array;
  readonly hex: string;
  readonly bech32: string;
  readonly hrp: string;
}

export type ExitAddressParse =
  | { readonly ok: true; readonly value: ParsedExitAddress }
  | { readonly ok: false; readonly error: string };

function describe(program: Uint8Array, hrp: string): ExitAddressParse {
  const kind: ExitAddressKind = program.length === 20 ? 'P2WPKH' : 'P2TR';
  const witnessVersion = program.length === 20 ? 0 : 1;
  return {
    ok: true,
    value: {
      kind,
      witnessVersion,
      program,
      hex: hexFromProgram(program),
      bech32: encodeWitnessAddress(hrp, witnessVersion, program),
      hrp,
    },
  };
}

const LEGACY_BASE58 = /^[123mn][1-9A-HJ-NP-Za-km-z]{25,39}$/;

/**
 * Accepts either a segwit address (`tb1q…` / `tb1p…`) or a raw witness program
 * in hex, and returns the exact bytes that will be pinned on-chain.
 *
 * Every rejection carries the precise reason — this is the ONLY moment a user
 * ever chooses the destination, and `gateway::register_exit_address` is
 * write-once (G2). A wrong pin cannot be undone.
 */
export function parseExitAddressInput(raw: string, hrp: string = SIGNET_HRP): ExitAddressParse {
  const input = raw.trim();
  if (input.length === 0) {
    return { ok: false, error: 'Enter a signet Bitcoin address (tb1q… or tb1p…) or a raw witness program in hex.' };
  }

  // ── raw witness program in hex ─────────────────────────────────────────────
  const looksHex = /^0x/i.test(input) || (/^[0-9a-f]+$/i.test(input) && !input.toLowerCase().includes('1'));
  const hexOnly = /^(0x)?[0-9a-f]+$/i.test(input);
  if (looksHex || (hexOnly && (input.replace(/^0x/i, '').length === 40 || input.replace(/^0x/i, '').length === 64))) {
    const program = programFromHex(input);
    if (program === null) {
      return { ok: false, error: 'That is not valid hex. A witness program is an even number of hex characters, optionally 0x-prefixed.' };
    }
    if (program.length !== 20 && program.length !== 32) {
      return {
        ok: false,
        error: `A witness program must be 20 bytes (P2WPKH) or 32 bytes (P2TR) — Hashi asserts exactly that and aborts EInvalidBitcoinAddress otherwise. You pasted ${program.length} bytes.`,
      };
    }
    return describe(program, hrp);
  }

  // ── legacy / P2SH ──────────────────────────────────────────────────────────
  if (LEGACY_BASE58.test(input)) {
    return {
      ok: false,
      error: 'That is a legacy or P2SH address. Hashi pays to a native SegWit witness program only — 20-byte P2WPKH (tb1q…) or 32-byte P2TR (tb1p…).',
    };
  }

  // ── bech32 / bech32m ───────────────────────────────────────────────────────
  const decoded = bech32Decode(input);
  if (decoded === 'mixed-case') {
    return { ok: false, error: 'Mixed upper- and lower-case is not a valid bech32 address. Paste it exactly as your wallet shows it.' };
  }
  if (decoded === 'too-long') {
    return { ok: false, error: 'A bech32 address is at most 90 characters. That string is longer.' };
  }
  if (decoded === 'no-separator') {
    return { ok: false, error: "That is not a bech32 address — it has no '1' separator between the network prefix and the data (expected tb1q… or tb1p…)." };
  }
  if (decoded === 'bad-charset') {
    return { ok: false, error: "Invalid bech32 character. The charset is qpzry9x8gf2tvdw0s3jn54khce6mua7l — '1', 'b', 'i' and 'o' never appear in the data part." };
  }
  if (decoded === 'bad-checksum') {
    return { ok: false, error: 'Bech32 checksum failed — the address is mistyped or truncated. Copy it again from your wallet.' };
  }

  if (decoded.hrp !== hrp) {
    const network = HRP_NETWORK[decoded.hrp] ?? `prefix “${decoded.hrp}”`;
    return {
      ok: false,
      error: `That is a Bitcoin ${network} address. This vault settles on signet, so the pinned address must start with “${hrp}1”. The pin is write-once — we will not let you set the wrong network.`,
    };
  }

  if (decoded.data.length === 0) {
    return { ok: false, error: 'The address carries no data part — it is truncated.' };
  }
  const version = decoded.data[0];
  const payload = decoded.data.slice(1);
  if (version > 16) {
    return { ok: false, error: `Witness version ${version} does not exist — valid versions are 0..16.` };
  }

  const expectedSpec: Spec = version === 0 ? BECH32_CONST : BECH32M_CONST;
  if (decoded.spec !== expectedSpec) {
    return {
      ok: false,
      error:
        version === 0
          ? 'Witness version 0 must use the bech32 checksum (BIP-173); this string carries a bech32m checksum.'
          : 'Witness version 1+ must use the bech32m checksum (BIP-350); this string carries the older bech32 checksum.',
    };
  }

  const program8 = convertBits(payload, 5, 8, false);
  if (program8 === null) {
    return { ok: false, error: 'The data part is not a whole number of bytes — the address is malformed.' };
  }
  const program = Uint8Array.from(program8);

  if (version === 0 && program.length === 32) {
    return {
      ok: false,
      error: 'That is a P2WSH address (32-byte witness version 0). Hashi supports 20-byte P2WPKH (version 0) and 32-byte P2TR (version 1) only.',
    };
  }
  if (version === 0 && program.length !== 20) {
    return {
      ok: false,
      error: `A witness version 0 program must be 20 bytes (P2WPKH). This one is ${program.length}.`,
    };
  }
  if (version === 1 && program.length !== 32) {
    return {
      ok: false,
      error: `A Taproot (witness version 1) program must be 32 bytes. This one is ${program.length}.`,
    };
  }
  if (version > 1) {
    return {
      ok: false,
      error: `Witness version ${version} is not supported. Hashi asserts a 20-byte P2WPKH or 32-byte P2TR program and aborts EInvalidBitcoinAddress otherwise.`,
    };
  }

  return describe(program, hrp);
}
