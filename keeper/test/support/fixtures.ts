// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.5
// @phase      0
// @status     DONE
// @spec       docs/KEEPER.md §2.4 (deterministic mock), §13 (acceptance)
// @rules      G5 G7
// @depends    ../../src/config.ts · ../../src/hashi/mock.ts
// @facts      Test signers are Ed25519 keypairs from FIXED 32-byte secrets ⇒ deterministic
// @facts        addresses. NEVER `Ed25519Keypair.generate()` in a test (entropy breaks replay).
// @facts      Compressed lifecycle delays are TEST-ONLY; the mock's DEFAULTS are the real
// @facts        latencies (deposit ~70 min, withdrawal ~1.5–2 h, G6).
// @implements export function testConfig(env?: Record<string,string>): Config
// @implements export function testSigner(n: number): Ed25519Keypair
// @implements export const FAST: Partial<MockOptions>
// @implements export function p2wpkhAddress(fill: number): Uint8Array   // 20 bytes
// @implements export function p2trAddress(fill: number): Uint8Array     // 32 bytes
// @forbidden  a canonical on-chain ID literal in this file (G7) — always go through loadConfig
// @verify     npm test
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

import { loadConfig, type Config } from '../../src/config.js';
import type { MockOptions } from '../../src/hashi/mock.js';

/** A Config built from an explicit env record — never from `process.env` (purity). */
export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({ HASHI_ADAPTER: 'mock', ...env });
}

/** Deterministic signer #n. Same n ⇒ same Sui address, every run, on every machine. */
export function testSigner(n: number): Ed25519Keypair {
  return Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(n & 0xff));
}

/** Compressed lifecycle timings so a whole deposit/withdrawal fits in a unit test. */
export const FAST: Partial<MockOptions> = {
  depositApprovalDelayMs: 60_000,
  depositConfirmDelayMs: 30_000,
  withdrawalApprovalDelayMs: 20_000,
  withdrawalBatchDelayMs: 20_000,
  withdrawalSignDelayMs: 20_000,
  withdrawalConfirmDelayMs: 60_000,
  signRetryIntervalMs: 20_000,
  stepMs: 5_000,
};

/** 20-byte P2WPKH witness program. */
export function p2wpkhAddress(fill = 0xab): Uint8Array {
  return new Uint8Array(20).fill(fill);
}

/** 32-byte P2TR witness program. */
export function p2trAddress(fill = 0xcd): Uint8Array {
  return new Uint8Array(32).fill(fill);
}
