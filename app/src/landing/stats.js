// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.4
// @phase      0
// @status     DONE
// @spec       docs/RECON.md R13 (the ONE EVM coupling in the ported landing page
//             was its aggregate-stats reader; this module replaces it with Sui)
// @spec       docs/RECON.md R1 (gRPC v2 is the default read transport)
// @spec       docs/RECON.md R5 (hBTC coin type, 8 dec, sats)
// @rules      G1 G7 G8
// @depends    ../config.ts (T0.4) · ../lib/suiClient.ts (T0.4)
// @facts      HBTC_TYPE comes from config.hashi.hbtcType — NEVER a literal here (G7).
// @facts      hBTC has 8 decimals; every amount below is SATOSHIS as a bigint.
// @facts      Verified live 2026-07-25 over SuiGrpcClient.stateService.getCoinInfo:
// @facts        { treasury: { totalSupply: 19_385_887_201n } }  ≈ 193.86 BTC
// @facts      ⚠ hBTC total supply is the BRIDGE's supply, NOT Aphotic's AUM.
// @facts        It is returned for context/liveness ONLY and must never be
// @facts        rendered under a "sats under management" label (G8).
// @facts      Vault TVL is 0n until the Vault object exists (VITE_VAULT_ID,
// @facts        docs/DAY-ONE.md). Decisions-logged is 0 until the journal lands.
// @external   client.stateService.getCoinInfo({ coinType })
//               -> { response: { metadata, treasury?: { totalSupply?: bigint } } }
// @implements export async function readAggregateStats(): Promise<AggregateStats>
// @facts      T5.2 (2026-07-26): the two counters are now REAL reads —
// @facts        sats under management = the Vault's own nav_sats mirror (its free
// @facts        sats exactly, while the vault holds no quote leg), decisions
// @facts        logged = the length of the on-chain journal blob-id stream. Both
// @facts        are 0 today because nothing has been deposited and the keeper has
// @facts        not traded; 0 read from chain is a fact, not a placeholder.
// @forbidden  throwing — the hero must render at the venue with the network down
// @forbidden  `number` for sats — sats are bigint until the last Number() cast
// @forbidden  a canonical id literal here — G7
// @invariant  1. NEVER throws. Any failure returns { deposits: 0, loans: 0, ok: false }.
// @invariant  2. The read is abortable and time-boxed (READ_TIMEOUT_MS).
// @invariant  3. `deposits` is Aphotic's own sats under management, never the
//                bridge's total hBTC supply.
// @ac         landing renders with zero network (offline venue) and shows 0 / 0.
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { config } from '../config';
import { getSuiClient } from '../lib/suiClient';
import { readJournal, readVaultOnChain } from '../screens/transparency/chainRead';

/** Hard ceiling on the landing-page read. The hero never waits on the network. */
const READ_TIMEOUT_MS = 4000;

/**
 * @typedef {Object} AggregateStats
 * @property {number} deposits  Sats under management (left counter). 0 until the Vault exists.
 * @property {number} loans     Decisions logged (right counter). 0 until the journal exists.
 * @property {boolean} ok       True only when the Sui read succeeded.
 * @property {bigint} vaultSats Sats under management, unrounded.
 * @property {bigint} hbtcSupplySats Bridge-wide hBTC supply. Context only — NOT AUM (G8).
 */

/** The shape returned on every failure path. Identical to the upstream contract. */
const EMPTY = Object.freeze({
  deposits: 0,
  loans: 0,
  ok: false,
  vaultSats: 0n,
  hbtcSupplySats: 0n,
});

/**
 * Reads the two landing-page counters. Wallet-free and read-only, so the hero
 * shows live numbers before anyone connects.
 *
 * NEVER throws: any RPC/network/parse failure resolves to `EMPTY`.
 *
 * @returns {Promise<AggregateStats>}
 */
export async function readAggregateStats() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);

  try {
    // Liveness + context: the bridge-wide hBTC supply. This is Hashi's number,
    // not ours — see @facts (G8).
    const { response } = await getSuiClient().stateService.getCoinInfo(
      { coinType: config.hashi.hbtcType },
      { abort: controller.signal },
    );

    const hbtcSupplySats = BigInt(response?.treasury?.totalSupply ?? 0);

    // The two counters, for real (T5.2). Sats under management = the vault's own
    // NAV, which for a base-only vault is exactly its free sats and needs no
    // price at all; decisions logged = the length of the on-chain journal stream.
    // Both are OURS, never the bridge's supply (G8). Either may fail on its own
    // without taking the hero down — settled, never awaited-and-thrown.
    const [vaultSettled, journalSettled] = await Promise.allSettled([
      readVaultOnChain(controller.signal),
      readJournal(controller.signal),
    ]);

    const vaultSats =
      vaultSettled.status === 'fulfilled'
        ? (vaultSettled.value.navSats ?? vaultSettled.value.freeBtcSats)
        : 0n;
    const decisionsLogged =
      journalSettled.status === 'fulfilled' ? journalSettled.value.length : 0;

    return {
      deposits: Number(vaultSats),
      loans: decisionsLogged,
      ok: true,
      vaultSats,
      hbtcSupplySats,
    };
  } catch {
    return { ...EMPTY };
  } finally {
    clearTimeout(timer);
  }
}

export default readAggregateStats;
