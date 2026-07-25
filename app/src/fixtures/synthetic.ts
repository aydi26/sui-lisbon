// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.4
// @phase      0
// @status     DONE
// @spec       docs/APP.md §5 (fixtures are deterministic, mirror the mock adapter)
// @rules      G6 G7
// @depends    (none)
// @facts      Canonical on-chain ids may appear ONLY in app/src/config.ts,
// @facts        keeper/src/config.ts, **/.env.example and move/Move.toml (G7).
// @facts        Fixture ids must therefore be OBVIOUSLY SYNTHETIC — generated,
// @facts        never copied from chain, and never mistakable for a real object.
// @facts      Sui object id / address = 32 bytes, 0x + 64 lowercase hex.
// @facts      Sui tx digest = base58 of 32 bytes (~43-44 chars), no 0x prefix.
// @facts      Bitcoin txid = 64 lowercase hex, NO 0x prefix.
// @facts      bech32 charset = qpzry9x8gf2tvdw0s3jn54khce6mua7l (no 1/b/i/o).
// @facts        Signet HRP = 'tb'. Witness v0 (P2WPKH, 20 B) renders 'tb1q…';
// @facts        witness v1 (P2TR, 32 B) renders 'tb1p…'.
// @implements export function synthId(byte: number): string
//             export function synthDigest(label: string): string
//             export function synthTxid(byte: number): string
//             export function synthHex(byte: number, bytes: number): string
//             export function synthBech32(witness: 'q' | 'p', dataLen: number): string
// @forbidden  pasting any real id/digest/txid into a fixture
// @invariant  1. Every value here is a pure function of its argument (determinism).
// @invariant  2. synthId output is a byte repeated 32× — no real object looks like that.
// @ac         docs/APP.md §7 A10
// @verify     cd app && npx tsc --noEmit
// └── END CONTRACT ───────────────────────────────────────────────────────────

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** `0x` + one byte repeated 32 times. Deterministic and self-evidently fake. */
export function synthId(byte: number): string {
  return `0x${synthHex(byte, 32)}`;
}

/** One byte repeated `bytes` times, lowercase hex, no prefix. */
export function synthHex(byte: number, bytes: number): string {
  return (byte & 0xff).toString(16).padStart(2, '0').repeat(bytes);
}

/** Bitcoin txid shape: 64 lowercase hex, no prefix. Pre-staged demo only (G6). */
export function synthTxid(byte: number): string {
  return synthHex(byte, 32);
}

const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

/**
 * bech32-SHAPED signet address. Charset-valid so it renders and copies like the
 * real thing, but the checksum is MEANINGLESS — this is fixture data only.
 * `witness` is 'q' for v0/P2WPKH and 'p' for v1/P2TR.
 */
export function synthBech32(witness: 'q' | 'p', dataLen: number): string {
  let out = `tb1${witness}`;
  for (let i = 0; i < dataLen; i += 1) out += BECH32[(i * 7 + witness.charCodeAt(0)) % BECH32.length];
  return out;
}

/**
 * Base58-shaped Sui digest seeded from a label. Deterministic; not a real digest.
 */
export function synthDigest(label: string): string {
  let acc = 0;
  for (let i = 0; i < label.length; i += 1) acc = (acc * 31 + label.charCodeAt(i)) >>> 0;
  let out = '';
  for (let i = 0; i < 44; i += 1) {
    acc = (acc * 1103515245 + 12345) >>> 0;
    out += BASE58[acc % BASE58.length];
  }
  return out;
}
