// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.4, T3.2
// @phase      0
// @status     DONE
// @spec       docs/APP.md §1 (lib/: explorer links), §3.1 (<SignetTxLink/>)
// @rules      G6 G7
// @depends    ../config.ts (T0.4)
// @facts      SIGNET_EXPLORER default = https://mempool.space/signet
// @facts      SUI_EXPLORER    default = https://suiscan.xyz/testnet
// @facts      ⚠ G6: the signet link shown during the demo points at an EARLIER,
// @facts        ALREADY-CONFIRMED withdrawal. The BTC leg is never live.
// @implements export function signetTxUrl(txid: string): string
//             export function suiTxUrl(digest: string): string
//             export function suiObjectUrl(id: string): string
// @forbidden  hardcoding an explorer base URL — it comes from config (G7)
// @invariant  1. Every returned URL is built from config.explorers.*.
// @ac         docs/APP.md §7 A5
// @verify     cd app && npx tsc --noEmit
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { config } from '../config';

const trimSlash = (base: string): string => base.replace(/\/+$/, '');

/** Bitcoin signet transaction. Pre-staged during the demo (G6). */
export function signetTxUrl(txid: string): string {
  return `${trimSlash(config.explorers.signet)}/tx/${txid}`;
}

/** Sui transaction digest (base58). */
export function suiTxUrl(digest: string): string {
  return `${trimSlash(config.explorers.sui)}/tx/${digest}`;
}

/** Sui object id. */
export function suiObjectUrl(id: string): string {
  return `${trimSlash(config.explorers.sui)}/object/${id}`;
}
