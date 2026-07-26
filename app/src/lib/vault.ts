// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F2
// @phase      1
// @status     DONE
// @spec       aphotic.md §6.2 (NAV: two parties), §7.7 (NAV legs and the honest gap)
// @spec       docs/DESIGN-V2.md §6 (approve_nav, the O(1) form), F3/D7 (escrow is
//             a SEPARATE balance sheet and is not in NAV)
// @spec       move/sources/vault.move — every signature below was read there, none
//             inferred.
// @rules      G7 G8 G10
// @depends    ./moveRead.ts (F2) · ../config.ts (F1)
// @facts      ENTRY SIGNATURES, verbatim from move/sources/vault.move:
// @facts        request_deposit<B,Q,S>(&mut Vault, Coin<B>, &mut TxContext)
// @facts                                                        -> DepositReceipt
// @facts        claim_deposit<B,Q,S>(&mut Vault, DepositReceipt, &mut TxContext)
// @facts                                                        -> Coin<S>
// @facts        request_redeem<B,Q,S>(&mut Vault, Coin<S>, &mut TxContext)
// @facts                                                        -> RedeemReceipt
// @facts        claim_redeem<B,Q,S>(&mut Vault, RedeemReceipt, &mut TxContext)
// @facts                                                        -> Coin<B>
// @facts      ⚠ All four RETURN a value. A PTB that drops it does not compile on
// @facts        chain, so every builder here transfers the result to the sender.
// @facts      ⚠ `request_deposit` asserts `assets >= min_deposit_sats` AND is
// @facts        pause-gated. `request_redeem` and `claim_redeem` are NOT — a
// @facts        paused vault still lets holders leave.
// @facts      ⚠ `claim_*` asserts `receipt.epoch < vault.epoch` (ENotYetPriced):
// @facts        a receipt is claimable only once its epoch has been PRICED by
// @facts        approve_nav, which is why the screen shows "prices at epoch N".
// @facts      NAV = idle + deployed + in_flight + native_btc. Escrow (note custody,
// @facts        the two BalanceBooks) is deliberately NOT in it (F3).
// @facts      THE UNVERIFIABLE LEG: `native_btc_sats` is not readable by Move. The
// @facts        contract caps it at `hashi_claims_sats` (ENavLegUncapped) — that
// @facts        cap is the honest bound, and the screen states it as one.
// @implements export interface VaultSnapshot · VaultProposal · DepositReceiptRow
//             · RedeemReceiptRow · VaultTypeArgs
// @implements export async function readVaultTypeArgs(opts?)
// @implements export async function readVaultSnapshot(typeArgs, opts?)
// @implements export async function readProposal(typeArgs, opts?)
// @implements export async function readEpochPrice(typeArgs, epoch, opts?)
// @implements export async function readEscrowOf(typeArgs, who, opts?)
// @implements export async function listReceipts(owner, opts?)
// @implements export function sharesForAssets / assetsForShares
// @implements export function buildRequestDeposit / buildClaimDeposit
//             · buildRequestRedeem · buildClaimRedeem
// @forbidden  guessing the share type `S` — it is read off the live object's type
// @forbidden  a read on mount — every function here is called from a click
// @invariant  1. Money is bigint everywhere; no u64 is narrowed to number.
// @invariant  2. The per-receipt conversion is the SAME round-down mul_div the
//                contract runs, so the screen's preview cannot overstate a claim.
// @ac         app/test/vault.test.tsx — the snapshot decodes from injected BCS; the
//             rounding twin matches Move's mul_div on the dust cases; the digest
//             twin is sensitive to all ten signed fields; every reader and builder
//             throws NotWiredError before touching the wire.
// @verify     cd app && npm run build
// @verify     cd app && npm test -- vault
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { bcs } from '@mysten/sui/bcs';
import type { Transaction, TransactionObjectArgument } from '@mysten/sui/transactions';

import { BcsWriter } from '@aphotic/sdk/bcs';
import { blake2b256 } from '@aphotic/sdk/hash';

import { config } from '../config';
import {
  aphoticTarget,
  decode,
  first,
  nth,
  objectTypeArgs,
  readMove,
  readObjectType,
  requireWired,
  type ObjectTypeFn,
  type ReadOptions,
} from './moveRead';
import { getSuiClient } from './suiClient';

/** `[B, Q, S]` — base, quote, share. Read off the live `Vault` object's own type. */
export type VaultTypeArgs = readonly [string, string, string];

/**
 * The vault's three generic parameters, from the object itself.
 *
 * `S` (the LP share coin) exists in no env var: it is whatever coin the
 * `TreasuryCap` handed to `vault::create` mints. Reading it off the object is the
 * only way that cannot drift from the object we are about to call.
 */
export async function readVaultTypeArgs(opts?: { readonly objectType?: ObjectTypeFn }): Promise<VaultTypeArgs> {
  requireWired([['VITE_VAULT_ID', config.aphotic.vaultId]]);
  const type = await readObjectType(config.aphotic.vaultId, opts?.objectType);
  const args = objectTypeArgs(type);
  if (args.length !== 3) {
    throw new Error(
      `VITE_VAULT_ID does not point at a Vault<B, Q, S>: its type is "${type}" ` +
        `(${args.length} generic parameter(s), expected 3).`,
    );
  }
  return [args[0]!, args[1]!, args[2]!];
}

// ── the snapshot ────────────────────────────────────────────────────────────

/** One `public fun` accessor, its Move name and how its single return decodes. */
interface Accessor {
  readonly fn: string;
  readonly kind: 'u64' | 'bool' | 'bytes';
}

const SNAPSHOT: readonly Accessor[] = [
  { fn: 'vault_epoch', kind: 'u64' },
  { fn: 'committed_supply', kind: 'u64' },
  { fn: 'unminted_shares', kind: 'u64' },
  { fn: 'minted_supply', kind: 'u64' },
  { fn: 'idle_sats', kind: 'u64' },
  { fn: 'claimable_sats', kind: 'u64' },
  { fn: 'pending_deposit_assets', kind: 'u64' },
  { fn: 'pending_redeem_shares', kind: 'u64' },
  { fn: 'deployed_sats', kind: 'u64' },
  { fn: 'in_flight_sats', kind: 'u64' },
  { fn: 'native_btc_sats', kind: 'u64' },
  { fn: 'hashi_claims_sats', kind: 'u64' },
  { fn: 'nav_assets', kind: 'u64' },
  { fn: 'last_nav_assets', kind: 'u64' },
  { fn: 'last_nav_supply', kind: 'u64' },
  { fn: 'last_nav_at_ms', kind: 'u64' },
  { fn: 'is_paused', kind: 'bool' },
  { fn: 'has_proposal', kind: 'bool' },
  { fn: 'min_deposit_sats', kind: 'u64' },
  { fn: 'fee_matched_bps', kind: 'u64' },
  { fn: 'max_nav_jump_bps', kind: 'u64' },
  { fn: 'max_price_dev_bps', kind: 'u64' },
  { fn: 'max_proposal_age_ms', kind: 'u64' },
  { fn: 'note_outstanding_sats', kind: 'u64' },
  { fn: 'note_custody_sats', kind: 'u64' },
  { fn: 'note_root', kind: 'bytes' },
  { fn: 'escrow_base_custody', kind: 'u64' },
  { fn: 'escrow_quote_custody', kind: 'u64' },
  { fn: 'active_clearings', kind: 'u64' },
];

export interface VaultSnapshot {
  readonly epoch: bigint;
  readonly committedSupply: bigint;
  readonly unmintedShares: bigint;
  readonly mintedSupply: bigint;
  readonly idleSats: bigint;
  readonly claimableSats: bigint;
  readonly pendingDepositAssets: bigint;
  readonly pendingRedeemShares: bigint;
  readonly deployedSats: bigint;
  readonly inFlightSats: bigint;
  readonly nativeBtcSats: bigint;
  readonly hashiClaimsSats: bigint;
  readonly navAssets: bigint;
  readonly lastNavAssets: bigint;
  readonly lastNavSupply: bigint;
  readonly lastNavAtMs: bigint;
  readonly paused: boolean;
  readonly hasProposal: boolean;
  readonly minDepositSats: bigint;
  readonly feeMatchedBps: bigint;
  readonly maxNavJumpBps: bigint;
  readonly maxPriceDevBps: bigint;
  readonly maxProposalAgeMs: bigint;
  readonly noteOutstandingSats: bigint;
  readonly noteCustodySats: bigint;
  readonly noteRoot: Uint8Array;
  readonly escrowBaseCustody: bigint;
  readonly escrowQuoteCustody: bigint;
  readonly activeClearings: bigint;
  /** When this browser took the reading. Rendered so a stale panel is visibly stale. */
  readonly readAtMs: number;
}

/** Every scalar the vault exposes, in ONE simulated transaction. */
export async function readVaultSnapshot(
  typeArgs: VaultTypeArgs,
  opts?: ReadOptions & { readonly nowMs?: number },
): Promise<VaultSnapshot> {
  requireWired([['VITE_VAULT_ID', config.aphotic.vaultId]]);
  const values = await readMove((tx) => {
    for (const accessor of SNAPSHOT) {
      tx.moveCall({
        target: aphoticTarget('vault', accessor.fn),
        typeArguments: [...typeArgs],
        arguments: [tx.object(config.aphotic.vaultId)],
      });
    }
  }, opts);

  const out: Record<string, unknown> = {};
  SNAPSHOT.forEach((accessor, i) => {
    const raw = first(values, i);
    out[camel(accessor.fn)] =
      accessor.kind === 'u64'
        ? decode.u64(raw)
        : accessor.kind === 'bool'
          ? decode.bool(raw)
          : decode.bytes(raw);
  });

  const s = out as unknown as Record<string, bigint | boolean | Uint8Array>;
  return {
    epoch: s.vaultEpoch as bigint,
    committedSupply: s.committedSupply as bigint,
    unmintedShares: s.unmintedShares as bigint,
    mintedSupply: s.mintedSupply as bigint,
    idleSats: s.idleSats as bigint,
    claimableSats: s.claimableSats as bigint,
    pendingDepositAssets: s.pendingDepositAssets as bigint,
    pendingRedeemShares: s.pendingRedeemShares as bigint,
    deployedSats: s.deployedSats as bigint,
    inFlightSats: s.inFlightSats as bigint,
    nativeBtcSats: s.nativeBtcSats as bigint,
    hashiClaimsSats: s.hashiClaimsSats as bigint,
    navAssets: s.navAssets as bigint,
    lastNavAssets: s.lastNavAssets as bigint,
    lastNavSupply: s.lastNavSupply as bigint,
    lastNavAtMs: s.lastNavAtMs as bigint,
    paused: s.isPaused as boolean,
    hasProposal: s.hasProposal as boolean,
    minDepositSats: s.minDepositSats as bigint,
    feeMatchedBps: s.feeMatchedBps as bigint,
    maxNavJumpBps: s.maxNavJumpBps as bigint,
    maxPriceDevBps: s.maxPriceDevBps as bigint,
    maxProposalAgeMs: s.maxProposalAgeMs as bigint,
    noteOutstandingSats: s.noteOutstandingSats as bigint,
    noteCustodySats: s.noteCustodySats as bigint,
    noteRoot: s.noteRoot as Uint8Array,
    escrowBaseCustody: s.escrowBaseCustody as bigint,
    escrowQuoteCustody: s.escrowQuoteCustody as bigint,
    activeClearings: s.activeClearings as bigint,
    readAtMs: opts?.nowMs ?? Date.now(),
  };
}

function camel(snake: string): string {
  return snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

// ── the keeper's proposal, itemised ─────────────────────────────────────────

/** The NAV proposal as `propose_nav` recorded it, plus the digest the multisig signs. */
export interface VaultProposal {
  readonly epoch: bigint;
  readonly idleSats: bigint;
  readonly deployedSats: bigint;
  readonly inFlightSats: bigint;
  readonly nativeBtcSats: bigint;
  readonly hashiClaimsSats: bigint;
  readonly clearingPrice: bigint;
  readonly bookMid: bigint;
  readonly proposedAtMs: bigint;
  readonly proposer: string;
  readonly navAssets: bigint;
  /** `blake2b256(bcs(NavProposal))` — the EXACT bytes the admin multisig signs. */
  readonly digest: Uint8Array;
}

const PROPOSAL_FIELDS: readonly (readonly [keyof VaultProposal, string, 'u64' | 'address'])[] = [
  ['epoch', 'proposal_epoch', 'u64'],
  ['idleSats', 'proposal_idle_sats', 'u64'],
  ['deployedSats', 'proposal_deployed_sats', 'u64'],
  ['inFlightSats', 'proposal_in_flight_sats', 'u64'],
  ['nativeBtcSats', 'proposal_native_btc_sats', 'u64'],
  ['hashiClaimsSats', 'proposal_hashi_claims_sats', 'u64'],
  ['clearingPrice', 'proposal_clearing_price', 'u64'],
  ['bookMid', 'proposal_book_mid', 'u64'],
  ['proposedAtMs', 'proposal_proposed_at_ms', 'u64'],
  ['proposer', 'proposal_proposer', 'address'],
  ['navAssets', 'proposal_nav_assets', 'u64'],
];

/**
 * Read the outstanding proposal. Call ONLY when `snapshot.hasProposal` is true —
 * `vault::current_proposal` aborts with ENoProposal otherwise, and an abort is
 * the contract answering correctly, not an error worth rendering.
 */
export async function readProposal(
  typeArgs: VaultTypeArgs,
  opts?: ReadOptions,
): Promise<VaultProposal> {
  requireWired([['VITE_VAULT_ID', config.aphotic.vaultId]]);
  const values = await readMove((tx) => {
    const vault = tx.object(config.aphotic.vaultId);
    const proposal = tx.moveCall({
      target: aphoticTarget('vault', 'current_proposal'),
      typeArguments: [...typeArgs],
      arguments: [vault],
    });
    for (const [, fn] of PROPOSAL_FIELDS) {
      tx.moveCall({ target: aphoticTarget('vault', fn), arguments: [proposal] });
    }
    tx.moveCall({
      target: aphoticTarget('vault', 'current_proposal_digest'),
      typeArguments: [...typeArgs],
      arguments: [vault],
    });
  }, opts);

  const out: Record<string, unknown> = {};
  PROPOSAL_FIELDS.forEach(([key, , kind], i) => {
    const raw = first(values, i + 1); // command 0 produced the proposal itself
    out[key] = kind === 'u64' ? decode.u64(raw) : decode.address(raw);
  });
  out.digest = decode.bytes(first(values, PROPOSAL_FIELDS.length + 1));
  return out as unknown as VaultProposal;
}

/** `(nav_assets, nav_supply)` for a settled epoch — the price a receipt claims at. */
export async function readEpochPrice(
  typeArgs: VaultTypeArgs,
  epoch: bigint,
  opts?: ReadOptions,
): Promise<{ readonly navAssets: bigint; readonly navSupply: bigint }> {
  requireWired([['VITE_VAULT_ID', config.aphotic.vaultId]]);
  const values = await readMove((tx) => {
    tx.moveCall({
      target: aphoticTarget('vault', 'epoch_price_at'),
      typeArguments: [...typeArgs],
      arguments: [tx.object(config.aphotic.vaultId), tx.pure.u64(epoch)],
    });
  }, opts);
  return { navAssets: decode.u64(nth(values, 0, 0)), navSupply: decode.u64(nth(values, 0, 1)) };
}

/** One participant's internal (escrow) balances — the balance an order draws on. */
export async function readEscrowOf(
  typeArgs: VaultTypeArgs,
  who: string,
  opts?: ReadOptions,
): Promise<{ readonly base: bigint; readonly quote: bigint }> {
  requireWired([['VITE_VAULT_ID', config.aphotic.vaultId]]);
  const values = await readMove((tx) => {
    for (const fn of ['escrow_base_of', 'escrow_quote_of']) {
      tx.moveCall({
        target: aphoticTarget('vault', fn),
        typeArguments: [...typeArgs],
        arguments: [tx.object(config.aphotic.vaultId), tx.pure.address(who)],
      });
    }
  }, opts);
  return { base: decode.u64(first(values, 0)), quote: decode.u64(first(values, 1)) };
}

// ── receipts ────────────────────────────────────────────────────────────────

const DepositReceiptBcs = bcs.struct('DepositReceipt', {
  id: bcs.Address,
  vaultId: bcs.Address,
  epoch: bcs.u64(),
  requester: bcs.Address,
  assetsSats: bcs.u64(),
});

const RedeemReceiptBcs = bcs.struct('RedeemReceipt', {
  id: bcs.Address,
  vaultId: bcs.Address,
  epoch: bcs.u64(),
  requester: bcs.Address,
  shares: bcs.u64(),
});

export interface DepositReceiptRow {
  readonly kind: 'deposit';
  readonly objectId: string;
  readonly epoch: bigint;
  /** Sats deposited. */
  readonly amount: bigint;
}

export interface RedeemReceiptRow {
  readonly kind: 'redeem';
  readonly objectId: string;
  readonly epoch: bigint;
  /** Shares surrendered. */
  readonly amount: bigint;
}

export type ReceiptRow = DepositReceiptRow | RedeemReceiptRow;

/** The BCS content of an owned object, injectable so tests stay offline. */
export type OwnedObjectsFn = (
  owner: string,
  type: string,
) => Promise<readonly { readonly objectId: string; readonly content: Uint8Array }[]>;

function liveOwnedObjects(): OwnedObjectsFn {
  return async (owner, type) => {
    const page = await getSuiClient().core.listOwnedObjects({
      owner,
      type,
      include: { content: true },
    });
    return page.objects.map((o) => ({ objectId: o.objectId, content: o.content }));
  };
}

/**
 * Every unclaimed receipt the address holds, both legs. Receipts are BEARER
 * objects — whoever holds one claims it — which is what keeps them composable,
 * and is why this lists what the address OWNS rather than what it once requested.
 */
export async function listReceipts(
  owner: string,
  opts?: { readonly ownedObjects?: OwnedObjectsFn },
): Promise<readonly ReceiptRow[]> {
  requireWired([
    ['VITE_APHOTIC_PACKAGE_ID', config.aphotic.packageId],
    ['VITE_APHOTIC_ORIGINAL_PACKAGE_ID', config.aphotic.originalPackageId],
  ]);
  const fetchOwned = opts?.ownedObjects ?? liveOwnedObjects();
  // A struct TYPE resolves against the ORIGINAL package id forever; only the
  // moveCall TARGET follows an upgrade.
  const origin = config.aphotic.originalPackageId;
  const [deposits, redeems] = await Promise.all([
    fetchOwned(owner, `${origin}::vault::DepositReceipt`),
    fetchOwned(owner, `${origin}::vault::RedeemReceipt`),
  ]);

  const rows: ReceiptRow[] = [];
  for (const o of deposits) {
    const parsed = DepositReceiptBcs.parse(o.content);
    rows.push({
      kind: 'deposit',
      objectId: o.objectId,
      epoch: BigInt(parsed.epoch),
      amount: BigInt(parsed.assetsSats),
    });
  }
  for (const o of redeems) {
    const parsed = RedeemReceiptBcs.parse(o.content);
    rows.push({
      kind: 'redeem',
      objectId: o.objectId,
      epoch: BigInt(parsed.epoch),
      amount: BigInt(parsed.shares),
    });
  }
  return rows.sort((a, b) => (a.epoch === b.epoch ? 0 : a.epoch < b.epoch ? -1 : 1));
}

// ── the digest, recomputed in the browser ───────────────────────────────────

/**
 * `blake2b256(bcs(NavProposal))` — the exact expression `vault::proposal_digest`
 * evaluates, rebuilt from the itemised legs.
 *
 * This is the point of the NAV panel: the admin multisig signs a digest over
 * these ten fields, and anyone can take the fields the contract exposes, hash
 * them here, and check that the number being approved is the number that was
 * proposed. Field order is the struct's declaration order — BCS has no names.
 */
export function proposalDigest(p: {
  readonly epoch: bigint;
  readonly idleSats: bigint;
  readonly deployedSats: bigint;
  readonly inFlightSats: bigint;
  readonly nativeBtcSats: bigint;
  readonly hashiClaimsSats: bigint;
  readonly clearingPrice: bigint;
  readonly bookMid: bigint;
  readonly proposedAtMs: bigint;
  readonly proposer: string;
}): Uint8Array {
  return blake2b256(
    new BcsWriter()
      .u64(p.epoch)
      .u64(p.idleSats)
      .u64(p.deployedSats)
      .u64(p.inFlightSats)
      .u64(p.nativeBtcSats)
      .u64(p.hashiClaimsSats)
      .u64(p.clearingPrice)
      .u64(p.bookMid)
      .u64(p.proposedAtMs)
      .address(p.proposer)
      .toBytes(),
  );
}

/** `nav_assets_of` — the four legs, summed. The browser's own total. */
export function proposalNavAssets(p: {
  readonly idleSats: bigint;
  readonly deployedSats: bigint;
  readonly inFlightSats: bigint;
  readonly nativeBtcSats: bigint;
}): bigint {
  return p.idleSats + p.deployedSats + p.inFlightSats + p.nativeBtcSats;
}

// ── coins ───────────────────────────────────────────────────────────────────

export interface CoinRow {
  readonly objectId: string;
  readonly balance: bigint;
}

/** Injected in tests; live it is one `listCoins` page. */
export type ListCoinsFn = (owner: string, coinType: string) => Promise<readonly CoinRow[]>;

export async function listCoinsOf(
  owner: string,
  coinType: string,
  opts?: { readonly listCoins?: ListCoinsFn },
): Promise<readonly CoinRow[]> {
  if (opts?.listCoins !== undefined) return opts.listCoins(owner, coinType);
  const page = await getSuiClient().core.listCoins({ owner, coinType });
  return page.objects.map((c) => ({ objectId: c.objectId, balance: BigInt(c.balance) }));
}

export function totalBalance(coins: readonly CoinRow[]): bigint {
  return coins.reduce((sum, c) => sum + c.balance, 0n);
}

// ── the rounding twin ───────────────────────────────────────────────────────
// `claim_deposit` and `claim_redeem` recompute these EXACT expressions. Round
// DOWN on both legs: round-down is subadditive, so Σ per-receipt ≤ the epoch
// total and the dust stays with the vault, never with a claimant.

/** `mul_div(assets, nav_supply, nav_assets)`, rounding down. */
export function sharesForAssets(assets: bigint, navAssets: bigint, navSupply: bigint): bigint {
  if (navAssets <= 0n) return 0n;
  return (assets * navSupply) / navAssets;
}

/** `mul_div(shares, nav_assets, nav_supply)`, rounding down. */
export function assetsForShares(shares: bigint, navAssets: bigint, navSupply: bigint): bigint {
  if (navSupply <= 0n) return 0n;
  return (shares * navAssets) / navSupply;
}

// ── PTB builders ────────────────────────────────────────────────────────────
// Each returns a value, so each MUST place it somewhere. `transferObjects` to the
// sender is the only honest destination: the app never routes a user's coin or
// receipt anywhere the user did not choose.

function vaultObject(tx: Transaction): TransactionObjectArgument {
  return tx.object(config.aphotic.vaultId);
}

/**
 * Split `sats` off a held hBTC coin and request a deposit.
 *
 * `coinIds` are the caller's own `Coin<B>` objects. They are merged and split
 * exactly, so no dust coin is created and no balance is left where the user did
 * not put it.
 */
export function buildRequestDeposit(
  tx: Transaction,
  args: {
    readonly typeArgs: VaultTypeArgs;
    readonly sender: string;
    readonly sats: bigint;
    readonly coinIds: readonly string[];
  },
): Transaction {
  requireWired([['VITE_VAULT_ID', config.aphotic.vaultId]]);
  if (args.coinIds.length === 0) throw new Error('no hBTC coin to deposit from');
  const [primary, ...rest] = args.coinIds;
  const coin = tx.object(primary!);
  if (rest.length > 0) tx.mergeCoins(coin, rest.map((id) => tx.object(id)));
  const [payment] = tx.splitCoins(coin, [tx.pure.u64(args.sats)]);
  const receipt = tx.moveCall({
    target: aphoticTarget('vault', 'request_deposit'),
    typeArguments: [...args.typeArgs],
    arguments: [vaultObject(tx), payment!],
  });
  tx.transferObjects([receipt], tx.pure.address(args.sender));
  return tx;
}

/** Surrender share coins and take a redeem receipt. Works while paused, by design. */
export function buildRequestRedeem(
  tx: Transaction,
  args: {
    readonly typeArgs: VaultTypeArgs;
    readonly sender: string;
    readonly shares: bigint;
    readonly coinIds: readonly string[];
  },
): Transaction {
  requireWired([['VITE_VAULT_ID', config.aphotic.vaultId]]);
  if (args.coinIds.length === 0) throw new Error('no share coin to redeem from');
  const [primary, ...rest] = args.coinIds;
  const coin = tx.object(primary!);
  if (rest.length > 0) tx.mergeCoins(coin, rest.map((id) => tx.object(id)));
  const [surrendered] = tx.splitCoins(coin, [tx.pure.u64(args.shares)]);
  const receipt = tx.moveCall({
    target: aphoticTarget('vault', 'request_redeem'),
    typeArguments: [...args.typeArgs],
    arguments: [vaultObject(tx), surrendered!],
  });
  tx.transferObjects([receipt], tx.pure.address(args.sender));
  return tx;
}

/** Settle a deposit receipt at its epoch's price and take the share coin. */
export function buildClaimDeposit(
  tx: Transaction,
  args: {
    readonly typeArgs: VaultTypeArgs;
    readonly sender: string;
    readonly receiptId: string;
  },
): Transaction {
  requireWired([['VITE_VAULT_ID', config.aphotic.vaultId]]);
  const shares = tx.moveCall({
    target: aphoticTarget('vault', 'claim_deposit'),
    typeArguments: [...args.typeArgs],
    arguments: [vaultObject(tx), tx.object(args.receiptId)],
  });
  tx.transferObjects([shares], tx.pure.address(args.sender));
  return tx;
}

/** Settle a redeem receipt and take the hBTC. Not pause-gated, deliberately. */
export function buildClaimRedeem(
  tx: Transaction,
  args: {
    readonly typeArgs: VaultTypeArgs;
    readonly sender: string;
    readonly receiptId: string;
  },
): Transaction {
  requireWired([['VITE_VAULT_ID', config.aphotic.vaultId]]);
  const coin = tx.moveCall({
    target: aphoticTarget('vault', 'claim_redeem'),
    typeArguments: [...args.typeArgs],
    arguments: [vaultObject(tx), tx.object(args.receiptId)],
  });
  tx.transferObjects([coin], tx.pure.address(args.sender));
  return tx;
}
