// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.4
// @phase      2  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/KEEPER.md §5.3 (sponsored deposit sweep), §1.2 (`sweep --deposit <req>`)
// @spec       docs/BUILD-PLAN.md#phase-2 (T2.4) · CUT LINE item 1
// @spec       docs/MOVE-PACKAGE.md §3.3 (`vault::deposit_btc`) · docs/FACTS.md#zklogin
// @rules      G1 G2 G6 G7 G9
// @depends    ./crank.ts (T2.3) · ../config.ts · ../sui/client.ts · aphotic::vault (T1.1)
// @facts      ★ public fun aphotic::vault::deposit_btc<B, Q>(vault: &mut Vault<B, Q>, coin_in: Coin<B>,
// @facts        book_mid: u128, ctx: &mut TxContext): u64      // returns shares minted (sats-denominated)
// @facts        VERIFIED against move/sources/vault.move: the Vault is GENERIC over the pair, so the
// @facts        moveCall carries typeArguments [cfg.hashi.hbtcCoinType, cfg.deepbook.dbusdcCoinType].
// @facts        Receipt: vault::Deposited { vault_id: ID, who: address, deposit_sats: u64,
// @facts        shares_minted: u64, nav_after_sats: u64 } — decoded from event BCS, never from
// @facts        `event.json` (that shape differs between gRPC and JSON-RPC).
// @facts      `book_mid` is the DeepBook mid (G9 depeg defence) — NEVER the raw Pyth price.
// @facts        It comes from routing/book.ts (get_level2_range), never `pool::mid_price` (it ABORTS
// @facts        `EEmptyOrderbook` on the empty testnet book — docs/FACTS.md#deepbook-venue).
// @facts      SPONSORED TX shape (docs/FACTS.md#zklogin): sender = the DEPOSITOR (zkLogin address),
// @facts        gas owner/payer = the sponsor (OWNER_KEY). Two signatures; the user needs ZERO SUI.
// @facts        Custody never leaves the depositor: the coin being swept is already theirs.
// @facts        Wire shape: `core.signAndExecuteTransaction({ transaction: bytes, signer: depositor,
// @facts        additionalSignatures: [sponsorSignature] })` — @mysten/sui 2.22.1 core API.
// @facts      hBTC is a fungible Coin<BTC>, 8 dec, sats. Movement on Sui is INSTANT — one checkpoint
// @facts        (G1). Nothing here waits on Bitcoin; the ~70 min leg finished at the crank (T2.3).
// @facts      The minted coin's object id is discovered from the crank's `Minted` transition +
// @facts        an owned-object read for the recipient; `Minted<T>` itself carries only `amount`.
// @implements export interface SweepDeps / SweepRequest / SweepResult
// @implements export function buildSweepTx(cfg: Config, req: SweepRequest): Transaction
// @implements export async function sweep(deps: SweepDeps, req: SweepRequest): Promise<SweepResult>
// @implements export async function findMintedCoins(deps: SweepDeps, owner: SuiAddress): Promise<readonly CoinRef[]>
// @implements ⚠ DELTAS vs the skeleton banner, all additive and deliberate:
// @implements   (a) SweepRequest gains `sponsor?: SuiAddress` — `buildSweepTx(cfg, req)` has no other
// @implements       way to learn who pays, and a sponsored PTB is not complete without a gas owner.
// @implements       `sweep()` fills it from `deps.sponsor.toSuiAddress()`.
// @implements   (b) SweepDeps gains `buildBytes?` — the transaction-bytes builder, injected so the
// @implements       sponsored two-signature flow is exercised OFFLINE. Default `tx.build({client})`.
// @implements   (c) export const DepositedEvent / export function decodeSharesMinted(events, who).
// @forbidden  importing '@mysten/hashi' here — only hashi/real.ts may (gates.ps1 sdk)
// @forbidden  constructing a Sui client here — use ../sui/client.ts (gates.ps1 transport)
// @forbidden  the sponsor ever becoming the SENDER — that would make the sponsor the depositor
// @forbidden  `number` for sats — all money is bigint
// @invariant  1. The sweep PTB moves coins the DEPOSITOR owns into shares credited to the DEPOSITOR.
// @invariant  2. The keeper/sponsor is never a beneficiary of any command in the PTB (G2).
// @invariant  3. Share issuance is sats-denominated (1 share = 1 sat on the bootstrap deposit).
// @invariant  4. `book_mid` is passed in, never fetched inside — the caller owns valuation (G9).
// @invariant  5. `tx.getSender() === req.recipient` always; the sponsor only ever reaches `setGasOwner`.
// @ac         docs/BUILD-PLAN.md T2.4 — user needs no SUI; freshly minted hBTC becomes vault shares
// @verify     npm run test -- sweep
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { bcs } from '@mysten/sui/bcs';
import type { Signer } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';

import type { Config } from '../config.js';
import type { AnySuiClient } from '../sui/client.js';
import type { Digest, ObjectId, Sats, SuiAddress } from '../types.js';
import { AphoticError, ConfigError } from '../util/errors.js';

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
  /**
   * Transaction-bytes builder (delta (b)). Default `tx.build({ client })`. Injected so the
   * two-signature sponsored flow can be asserted without a live fullnode.
   */
  readonly buildBytes?: (tx: Transaction) => Promise<Uint8Array>;
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
  /** Gas owner — the SPONSOR (delta (a)). Sponsorship changes who PAYS, never who the sender is. */
  readonly sponsor?: SuiAddress;
}

export interface SweepResult {
  readonly digest: Digest;
  readonly sweptSats: Sats;
  readonly sharesMinted: Sats;
  readonly recipient: SuiAddress;
}

/** `aphotic::vault::Deposited` — the share-issuance receipt (G10). */
export const DepositedEvent = bcs.struct('Deposited', {
  vault_id: bcs.Address,
  who: bcs.Address,
  deposit_sats: bcs.u64(),
  shares_minted: bcs.u64(),
  nav_after_sats: bcs.u64(),
});

/** Minimal event shape both transports return (`SuiClientTypes.Event`). */
export interface SweepEvent {
  readonly eventType: string;
  readonly bcs: Uint8Array;
}

/** Pages of owned coins. Declared structurally so no client is constructed here. */
interface CoinListing {
  listCoins(options: {
    owner: string;
    coinType: string;
    limit?: number;
    cursor?: string | null;
  }): Promise<{
    readonly objects: readonly { readonly objectId: string; readonly balance: string }[];
    readonly hasNextPage: boolean;
    readonly cursor: string | null;
  }>;
}

interface ExecutedShape {
  readonly digest: string;
  readonly events?: readonly SweepEvent[] | undefined;
}

/** The sponsored execution surface both transports expose on `.core`. */
interface SponsoredExecutionCore {
  signAndExecuteTransaction(input: {
    transaction: Uint8Array;
    signer: Signer;
    additionalSignatures: string[];
    include: { events: true };
  }): Promise<{
    readonly $kind: 'Transaction' | 'FailedTransaction';
    readonly Transaction?: ExecutedShape;
    readonly FailedTransaction?: ExecutedShape;
  }>;
}

/** Safety bound on the owned-coin pager. */
const MAX_COIN_PAGES = 100;
const COIN_PAGE_LIMIT = 50;

/**
 * Every `Coin<BTC>` (`cfg.hashi.hbtcCoinType`) owned by `owner`, in the transport's listing order.
 *
 * G1: hBTC is a plain fungible coin, so this is an ordinary owned-object read — there is no
 * Bitcoin-side wait left at this point, the ~70 min leg ended at the crank (T2.3).
 */
export async function findMintedCoins(deps: SweepDeps, owner: SuiAddress): Promise<readonly CoinRef[]> {
  const core = deps.client.core as unknown as CoinListing;
  const out: CoinRef[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < MAX_COIN_PAGES; page++) {
    const res = await core.listCoins({
      owner,
      coinType: deps.cfg.hashi.hbtcCoinType,
      limit: COIN_PAGE_LIMIT,
      cursor,
    });
    for (const coin of res.objects) {
      const sats = BigInt(coin.balance);
      if (sats > 0n) out.push({ objectId: coin.objectId, sats });
    }
    if (!res.hasNextPage || res.cursor === null) return out;
    cursor = res.cursor;
  }

  throw new AphoticError(
    'CoinPagingUnbounded',
    `listCoins for ${owner} exceeded ${MAX_COIN_PAGES} pages — the cursor is not converging`,
  );
}

/**
 * Build the SPONSORED sweep PTB: merge the depositor's freshly minted `Coin<BTC>` and call
 * `aphotic::vault::deposit_btc`. Sender = depositor, gas owner = sponsor.
 *
 * The sponsor appears in exactly one place — `setGasOwner`. Every command operates on coins the
 * depositor already owns and credits shares to the depositor; nothing in this PTB can move value
 * to the keeper or the sponsor (invariants 1, 2, 5).
 */
export function buildSweepTx(cfg: Config, req: SweepRequest): Transaction {
  assertPublished(cfg);

  const coins = req.coins ?? [];
  const primary = coins[0];
  if (primary === undefined) {
    throw new AphoticError(
      'NothingToSweep',
      `no Coin<BTC> to sweep for ${req.recipient} (deposit ${req.depositRequestId})`,
    );
  }
  if (req.sponsor === req.recipient && req.sponsor !== undefined) {
    // Not fatal on-chain, but it means nobody sponsored anything — surface it rather than
    // silently shipping a "sponsored" PTB the user pays for.
    throw new AphoticError(
      'SponsorIsSender',
      `sponsor ${req.sponsor} equals the depositor — a sponsored sweep needs a distinct gas owner`,
    );
  }

  const tx = new Transaction();
  // The DEPOSITOR is the sender. Sponsorship changes who PAYS, never who the sender is (G2).
  tx.setSender(req.recipient);
  if (req.sponsor !== undefined) tx.setGasOwner(req.sponsor);

  const primaryArg = tx.object(primary.objectId);
  const rest = coins.slice(1);
  if (rest.length > 0) {
    tx.mergeCoins(
      primaryArg,
      rest.map((coin) => tx.object(coin.objectId)),
    );
  }

  tx.moveCall({
    target: `${cfg.aphotic.packageId}::vault::deposit_btc`,
    typeArguments: [cfg.hashi.hbtcCoinType, cfg.deepbook.dbusdcCoinType],
    arguments: [tx.object(req.vaultId), primaryArg, tx.pure.u128(req.bookMid)],
  });

  return tx;
}

/**
 * Execute the sponsored sweep. Instant on Sui (G1) — there is no Bitcoin wait left at this point.
 *
 * TWO signatures over the SAME bytes: the depositor's (they own the coins and the shares) and the
 * sponsor's (they own the gas). The depositor needs ZERO SUI, which is the whole zkLogin
 * onboarding claim.
 */
export async function sweep(deps: SweepDeps, req: SweepRequest): Promise<SweepResult> {
  const depositor = deps.depositor;
  if (depositor === undefined) {
    throw new AphoticError(
      'SweepNeedsDepositorSignature',
      'the sweep PTB must be signed by the DEPOSITOR — the sponsor only pays gas (G2). ' +
        'Pass SweepDeps.depositor, or hand buildSweepTx() to the app\'s zkLogin session.',
    );
  }

  const coins = req.coins !== undefined && req.coins.length > 0 ? req.coins : await findMintedCoins(deps, req.recipient);
  const sweptSats = coins.reduce<Sats>((sum, coin) => sum + coin.sats, 0n);

  const sponsorAddress = deps.sponsor.toSuiAddress();
  const tx = buildSweepTx(deps.cfg, { ...req, coins, sponsor: sponsorAddress });

  const bytes = await (deps.buildBytes ?? defaultBuildBytes(deps))(tx);
  const sponsorSignature = (await deps.sponsor.signTransaction(bytes)).signature;

  const core = deps.client.core as unknown as SponsoredExecutionCore;
  const result = await core.signAndExecuteTransaction({
    transaction: bytes,
    signer: depositor,
    additionalSignatures: [sponsorSignature],
    include: { events: true },
  });

  const executed = result.Transaction ?? result.FailedTransaction;
  if (executed === undefined) {
    throw new AphoticError('SweepExecutionFailed', 'signAndExecuteTransaction returned no transaction');
  }
  if (result.$kind === 'FailedTransaction') {
    throw new AphoticError('SweepExecutionFailed', `sweep PTB failed on chain (digest ${executed.digest})`);
  }

  const sharesMinted = decodeSharesMinted(executed.events ?? [], req.recipient);
  if (sharesMinted === undefined) {
    throw new AphoticError(
      'SweepReceiptMissing',
      `sweep ${executed.digest} emitted no aphotic::vault::Deposited for ${req.recipient}`,
    );
  }

  return { digest: executed.digest, sweptSats, sharesMinted, recipient: req.recipient };
}

/**
 * Pull the shares issued to `who` out of the `vault::Deposited` receipt.
 *
 * Matched on the `::vault::Deposited` suffix rather than the full type: the `packageId` an event
 * carries is the ORIGINAL package id, which diverges from `cfg.aphotic.packageId` the first time
 * the package is upgraded. The module path is the stable part.
 */
export function decodeSharesMinted(events: readonly SweepEvent[], who: SuiAddress): Sats | undefined {
  for (const event of events) {
    if (!event.eventType.endsWith('::vault::Deposited')) continue;
    const parsed = DepositedEvent.parse(event.bcs);
    if (normalizeAddress(parsed.who) !== normalizeAddress(who)) continue;
    return BigInt(parsed.shares_minted);
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────

/** The `client` slot of `Transaction.build`, named so the cast below stays one line. */
type TxBuildClient = NonNullable<Parameters<Transaction['build']>[0]>['client'];

function defaultBuildBytes(deps: SweepDeps): (tx: Transaction) => Promise<Uint8Array> {
  // The client is INJECTED (gates.ps1 transport: it is never constructed here).
  return (tx) => tx.build({ client: deps.client as unknown as TxBuildClient });
}

/** Compare Sui addresses without tripping over zero-padding differences between transports. */
function normalizeAddress(address: string): string {
  const hex = address.startsWith('0x') ? address.slice(2) : address;
  return `0x${hex.toLowerCase().padStart(64, '0')}`;
}

/** `vault::deposit_btc` lives in the published `aphotic` package; without its id there is no target. */
function assertPublished(cfg: Config): void {
  if (cfg.aphotic.packageId === '') {
    throw new ConfigError('cannot build a sweep PTB without APHOTIC_PACKAGE_ID', ['APHOTIC_PACKAGE_ID']);
  }
}
