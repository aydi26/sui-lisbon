// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F1
// @phase      0
// @status     DONE
// @spec       aphotic.md §6.3 (the redemption address is published so anyone can
//             check it on Bitcoin), §7.7 (NAV mitigations)
// @rules      G7
// @depends    ../config.ts (F1)
// @facts      BITCOIN_EXPLORER default = https://mempool.space/signet
// @facts      SUI_EXPLORER     default = https://suiscan.xyz/testnet
// @facts      The Bitcoin links exist so a redemption can be audited by a third
// @facts        party without asking us — that is mitigation #1 for the one NAV leg
// @facts        Move cannot read.
// @implements export function bitcoinTxUrl(txid: string): string
//             export function bitcoinAddressUrl(address: string): string
//             export function suiTxUrl(digest: string): string
//             export function suiObjectUrl(id: string): string
// @forbidden  hardcoding an explorer base URL — it comes from config (G7)
// @invariant  1. Every returned URL is built from config.explorers.*.
// @verify     cd app && npx tsc --noEmit
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { config } from '../config';

const trimSlash = (base: string): string => base.replace(/\/+$/, '');

/** Bitcoin transaction (signet while the Sui side is testnet). */
export function bitcoinTxUrl(txid: string): string {
  return `${trimSlash(config.explorers.bitcoin)}/tx/${txid}`;
}

/** Bitcoin address page — the redemption address is published for exactly this. */
export function bitcoinAddressUrl(address: string): string {
  return `${trimSlash(config.explorers.bitcoin)}/address/${address}`;
}

/** Sui transaction digest (base58). */
export function suiTxUrl(digest: string): string {
  return `${trimSlash(config.explorers.sui)}/tx/${digest}`;
}

/** Sui object id. */
export function suiObjectUrl(id: string): string {
  return `${trimSlash(config.explorers.sui)}/object/${id}`;
}
