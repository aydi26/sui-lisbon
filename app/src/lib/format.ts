// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       X.app
// @phase      0
// @status     DONE
// @spec       docs/FACTS.md#hbtc (8 decimals, symbol hBTC, unit satoshis)
// @spec       docs/FACTS.md#hashi-onchain-config (bitcoin_withdrawal_minimum, dust floor)
// @rules      G1 G10
// @depends    ../config.ts (X.app)
// @facts      hBTC has 8 decimals; ALL amounts are satoshis.        (RECON R5)
// @facts      TypeScript money type is `bigint`, NEVER `number` — a 1 BTC bucket
// @facts        times a large elapsed exceeds Number.MAX_SAFE_INTEGER (RECON R9).
// @facts      HASHI_WITHDRAWAL_MIN_SATS = 30_000 · BITCOIN_DUST_FLOOR_SATS = 546
// @facts      Pinned exit address is 20 bytes (P2WPKH) or 32 bytes (P2TR).
// @implements export function formatSats(sats: bigint): string
//             export function formatBtc(sats: bigint, opts?): string
//             export function parseBtcToSats(input: string): bigint | null
//             export function classifyExitAmount(sats, minSats, dustSats): ExitAmountClass
//             export function renderPinnedAddress(bytes: Uint8Array): PinnedAddress
//             export function truncateMiddle(value: string, keep?: number): string
// @forbidden  `number` for any sats-valued quantity
// @forbidden  floating-point arithmetic on sats
// @invariant  1. parseBtcToSats never loses precision (string math, no Number).
// @invariant  2. classifyExitAmount returns 'pooled' below the Hashi minimum —
//                the UI must NEVER offer a priority/fast path (G1: over-capacity is
//                REJECTED, never queued, so priority cannot be bought).
// @ac         app/test/format.test.ts — the sats formatting/parsing safety net
// @verify     cd app && npx tsc --noEmit
// └── END CONTRACT ───────────────────────────────────────────────────────────

// The bech32/bech32m codec lives in ./bech32 so there is exactly ONE
// implementation in the app. A second copy could drift, and a drifted address
// encoder silently sends Bitcoin somewhere unrecoverable.
import { SIGNET_HRP, encodeWitnessAddress, hexFromProgram } from './bech32';

const SATS_PER_BTC = 100_000_000n;

/** Grouped satoshi count, e.g. `30,000 sats`. */
export function formatSats(sats: bigint): string {
  const sign = sats < 0n ? '-' : '';
  const abs = sats < 0n ? -sats : sats;
  return `${sign}${abs.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')} sats`;
}

/** Exact BTC rendering from sats. No floating point anywhere. */
export function formatBtc(sats: bigint, opts?: { suffix?: boolean }): string {
  const sign = sats < 0n ? '-' : '';
  const abs = sats < 0n ? -sats : sats;
  const whole = abs / SATS_PER_BTC;
  const frac = (abs % SATS_PER_BTC).toString().padStart(8, '0');
  const suffix = opts?.suffix === false ? '' : ' BTC';
  return `${sign}${whole.toString()}.${frac}${suffix}`;
}

/**
 * Exact BTC rendering with trailing fractional zeros stripped — `0.01`, `10`.
 * For the denomination ladder, where `0.01000000` is noise. Still exact: it
 * removes zeros, never significant digits.
 */
export function formatBtcCompact(sats: bigint): string {
  const full = formatBtc(sats, { suffix: false });
  const trimmed = full.replace(/\.?0+$/, '');
  return trimmed === '' || trimmed === '-' ? '0' : trimmed;
}

/**
 * Parse a human BTC string ("0.0003") into sats. Returns null on anything that
 * is not a finite, non-negative decimal with <= 8 fractional digits.
 */
export function parseBtcToSats(input: string): bigint | null {
  const trimmed = input.trim();
  if (!/^\d*(\.\d*)?$/.test(trimmed) || trimmed === '' || trimmed === '.') return null;
  const [wholeRaw, fracRaw = ''] = trimmed.split('.');
  if (fracRaw.length > 8) return null;
  const whole = wholeRaw === '' ? '0' : wholeRaw;
  return BigInt(whole) * SATS_PER_BTC + BigInt(fracRaw.padEnd(8, '0') || '0');
}

export type ExitAmountClass = 'dust' | 'pooled' | 'submittable';

/**
 * Where an exit amount lands relative to Hashi's floor.
 *  - `dust`        below the Bitcoin dust floor — refuse.
 *  - `pooled`      >= dust but < Hashi minimum — accumulates in the per-user
 *                  pending pool until it clears 30,000 sats. NEVER a queue
 *                  position, never a priority lever (G3).
 *  - `submittable` >= Hashi minimum — may be composed into request_withdrawal.
 */
export function classifyExitAmount(
  sats: bigint,
  minSats: bigint,
  dustSats: bigint,
): ExitAmountClass {
  if (sats < dustSats) return 'dust';
  if (sats < minSats) return 'pooled';
  return 'submittable';
}

export interface PinnedAddress {
  /** 20 bytes = P2WPKH, 32 bytes = P2TR. Anything else is invalid on Hashi. */
  readonly kind: 'P2WPKH' | 'P2TR' | 'INVALID';
  /** bech32/bech32m rendering for humans. */
  readonly bech32: string;
  /** Lowercase hex of the raw witness program. */
  readonly hex: string;
}

/**
 * Render the on-chain-pinned `Vault.btc_exit_address` witness program.
 * The bytes are the SOURCE OF TRUTH; bech32 is a display convenience (G2).
 */
export function renderPinnedAddress(bytes: Uint8Array): PinnedAddress {
  const hex = hexFromProgram(bytes);

  // Hashi accepts exactly two witness-program lengths (docs/RECON.md R7):
  // 20 bytes = P2WPKH at witness version 0 (bech32), 32 bytes = P2TR at
  // witness version 1 (bech32m, BIP-350). Anything else it rejects with
  // EInvalidBitcoinAddress, so we surface it as INVALID rather than guessing.
  if (bytes.length === 20) {
    return { kind: 'P2WPKH', bech32: encodeWitnessAddress(SIGNET_HRP, 0, bytes), hex };
  }
  if (bytes.length === 32) {
    return { kind: 'P2TR', bech32: encodeWitnessAddress(SIGNET_HRP, 1, bytes), hex };
  }
  return { kind: 'INVALID', bech32: '', hex };
}

/** `0xabcd…ef12` — for ids and digests in tight UI. */
export function truncateMiddle(value: string, keep = 6): string {
  if (value.length <= keep * 2 + 1) return value;
  return `${value.slice(0, keep)}…${value.slice(-keep)}`;
}
