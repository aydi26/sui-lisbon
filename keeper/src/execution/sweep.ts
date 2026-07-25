// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.4
// @phase      2  [CUT-LINE CRITICAL]
// @status     STUB
// @spec       docs/KEEPER.md §5.3 (sponsored deposit sweep), §1.2 (`sweep --deposit <req>`)
// @spec       docs/BUILD-PLAN.md#phase-2 (T2.4) · CUT LINE item 1
// @spec       docs/MOVE-PACKAGE.md §3.3 (`vault::deposit_btc`) · docs/FACTS.md#zklogin
// @rules      G1 G2 G6 G7 G9
// @depends    ./crank.ts (T2.3) · ../config.ts · ../sui/client.ts · aphotic::vault (T1.1)
// @facts      ★ public fun aphotic::vault::deposit_btc(vault: &mut Vault, coin_in: Coin<BTC>,
// @facts        book_mid: u128, ctx: &mut TxContext): u64      // returns shares minted (sats-denominated)
// @facts      `book_mid` is the DeepBook mid (G9 depeg defence) — NEVER the raw Pyth price.
// @facts        It comes from routing/book.ts (get_level2_range), never `pool::mid_price` (it ABORTS
// @facts        `EEmptyOrderbook` on the empty testnet book — docs/FACTS.md#deepbook-venue).
// @facts      SPONSORED TX shape (docs/FACTS.md#zklogin): sender = the DEPOSITOR (zkLogin address),
// @facts        gas owner/payer = the sponsor (OWNER_KEY). Two signatures; the user needs ZERO SUI.
// @facts        Custody never leaves the depositor: the coin being swept is already theirs.
// @facts      hBTC is a fungible Coin<BTC>, 8 dec, sats. Movement on Sui is INSTANT — one checkpoint
// @facts        (G1). Nothing here waits on Bitcoin; the ~70 min leg finished at the crank (T2.3).
// @facts      The minted coin's object id is discovered from the crank's `Minted` transition +
// @facts        an owned-object read for the recipient; `Minted<T>` itself carries only `amount`.
// @implements export interface SweepDeps / SweepRequest / SweepResult
// @implements export function buildSweepTx(cfg: Config, req: SweepRequest): Transaction
// @implements export async function sweep(deps: SweepDeps, req: SweepRequest): Promise<SweepResult>
// @implements export async function findMintedCoins(deps: SweepDeps, owner: SuiAddress): Promise<readonly CoinRef[]>
// @forbidden  importing '@mysten/hashi' here — only hashi/real.ts may (gates.ps1 sdk)
// @forbidden  constructing a Sui client here — use ../sui/client.ts (gates.ps1 transport)
// @forbidden  the sponsor ever becoming the SENDER — that would make the sponsor the depositor
// @forbidden  `number` for sats — all money is bigint
// @invariant  1. The sweep PTB moves coins the DEPOSITOR owns into shares credited to the DEPOSITOR.
// @invariant  2. The keeper/sponsor is never a beneficiary of any command in the PTB (G2).
// @invariant  3. Share issuance is sats-denominated (1 share = 1 sat on the bootstrap deposit).
// @invariant  4. `book_mid` is passed in, never fetched inside — the caller owns valuation (G9).
// @ac         docs/BUILD-PLAN.md T2.4 — user needs no SUI; freshly minted hBTC becomes vault shares
// @verify     npm run test -- sweep
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { Signer } from '@mysten/sui/cryptography';
import type { Transaction } from '@mysten/sui/transactions';

import type { Config } from '../config.js';
import type { AnySuiClient } from '../sui/client.js';
import type { Digest, ObjectId, Sats, SuiAddress } from '../types.js';

/** A `Coin<BTC>` the depositor owns, ready to be swept into shares. */
export interface CoinRef {
  readonly objectId: ObjectId;
  readonly sats: Sats;
}

export interface SweepDeps {
  readonly cfg: Config;
  readonly client: AnySuiClient;
  /** Pays gas for the sponsored PTB (OWNER_KEY). NEVER the sender. */
  readonly sponsor: Signer;
  /**
   * The depositor's signer. In production this is a zkLogin session held by the app;
   * the keeper only ever builds the bytes for it to sign.
   */
  readonly depositor?: Signer;
}

export interface SweepRequest {
  readonly vaultId: ObjectId;
  /** The Hashi deposit request whose mint we are sweeping (audit link, not a PTB argument). */
  readonly depositRequestId: string;
  /** Owner of the minted coin AND the share recipient. Fixed by the UTXO derivation path (G2). */
  readonly recipient: SuiAddress;
  /** Coins to merge + deposit. Empty ⇒ resolve via {@link findMintedCoins}. */
  readonly coins?: readonly CoinRef[];
  /** DeepBook mid used for NAV/share math (G9). */
  readonly bookMid: bigint;
}

export interface SweepResult {
  readonly digest: Digest;
  readonly sweptSats: Sats;
  readonly sharesMinted: Sats;
  readonly recipient: SuiAddress;
}

/** Every `Coin<BTC>` (cfg.hashi.hbtcCoinType) owned by `owner`, newest first. */
// TODO(T2.4): paginated owned-coin read via deps.client, filtered by cfg.hashi.hbtcCoinType.
export async function findMintedCoins(_deps: SweepDeps, _owner: SuiAddress): Promise<readonly CoinRef[]> {
  throw new Error('TODO(T2.4): findMintedCoins not implemented');
}

/**
 * Build the SPONSORED sweep PTB: merge the depositor's freshly minted `Coin<BTC>` and call
 * `aphotic::vault::deposit_btc`. Sender = depositor, gas owner = sponsor.
 */
// TODO(T2.4): tx.setSender(recipient); tx.setGasOwner(sponsor); mergeCoins; one moveCall
//             `${cfg.aphotic.packageId}::vault::deposit_btc` with [vault, coin, bookMid].
export function buildSweepTx(_cfg: Config, _req: SweepRequest): Transaction {
  throw new Error('TODO(T2.4): buildSweepTx not implemented');
}

/**
 * Execute the sponsored sweep. Instant on Sui (G1) — there is no Bitcoin wait left at this point.
 */
// TODO(T2.4): build, collect BOTH signatures (depositor + sponsor), execute, parse shares minted.
export async function sweep(_deps: SweepDeps, _req: SweepRequest): Promise<SweepResult> {
  throw new Error('TODO(T2.4): sweep not implemented');
}
