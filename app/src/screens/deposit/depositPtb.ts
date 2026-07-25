// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T3.1
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/APP.md §2 (Screen 1 — Deposit)
// @spec       docs/MOVE-PACKAGE.md#module-vault · move/sources/vault.move (T1.1, DONE)
// @spec       docs/DEPLOYED.md v3 (the ids this targets)
// @rules      G1 G7 G9 G10
// @depends    ../../config.ts (T0.4) · @mysten/sui/transactions
// @facts      Move signature this file targets (verbatim, move/sources/vault.move):
// @facts        public fun deposit_btc<B, Q>(vault: &mut Vault<B, Q>, coin_in: Coin<B>,
// @facts                                     book_mid: u128, ctx: &mut TxContext): u64
// @facts        → returns shares_minted, and emits vault::Deposited.
// @facts      The u64 return value has `drop`, so a PTB may ignore it. We do; the
// @facts        share count is read back out of the Deposited event instead, which
// @facts        is what an auditor would read too.
// @facts      ⚠ book_mid semantics (vault::nav_sats, v3 — docs/DEPLOYED.md):
// @facts        `if (quote == 0) return free;` comes BEFORE `assert!(book_mid != 0)`.
// @facts        A base-only vault therefore values exactly, with no price at all, and
// @facts        book_mid is provably unused. The moment the vault holds DBUSDC the
// @facts        assert is live and a real DeepBook mid is mandatory.
// @facts      DEEPBOOK_PRICE_SCALING = 1e9: `quote = base * price / 1e9`, so book_mid
// @facts        is a DeepBook price at FLOAT_SCALING, never a raw oracle number (G9).
// @facts      hBTC is a fungible Coin<BTC> (G1): merging n coins and splitting an
// @facts        exact amount settles in ONE checkpoint. No bridge latency here at all.
// @external   Transaction#mergeCoins(destination, sources)
//             Transaction#splitCoins(coin, [amount]) → [Coin]
// @implements export interface DepositTargets · export function depositTargets()
//             export function missingDepositTargets(): string[]
//             export function buildDepositBtcTx(a: DepositCallArgs): Transaction
//             export function describeDepositCall(a: DepositCallArgs): CallDescription
//             export const DEPOSITED_EVENT: BCS schema for vault::Deposited
//             export function depositedEventType(): string
// @forbidden  a canonical on-chain id literal here — every id comes from config (G7)
// @forbidden  `number` for sats — bigint only (G10)
// @forbidden  emitting a PTB against an empty package/vault id — throw instead
// @invariant  1. The PTB spends EXACTLY `amountSats`: the whole (merged) coin when it
//                equals the balance, otherwise a split of that exact size.
//             2. buildDepositBtcTx throws rather than build against a blank id.
//             3. describeDepositCall lists exactly the arguments the builder encodes.
// @ac         docs/APP.md §7 A6 A10
// @verify     cd app && npx tsc --noEmit
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { bcs } from '@mysten/sui/bcs';
import { Transaction } from '@mysten/sui/transactions';

import { config } from '../../config';

export interface DepositTargets {
  /** Published `aphotic` package. Empty until the package is published. */
  readonly packageId: string;
  /** The shared `Vault<hBTC, DBUSDC>`. */
  readonly vaultId: string;
  /** The shared DeepBook `Pool<hBTC, DBUSDC>` — read-only, for the mid. */
  readonly poolId: string;
  /** Type argument `B` — the hBTC coin type. */
  readonly baseType: string;
  /** Type argument `Q` — the DeepBook quote coin type. */
  readonly quoteType: string;
}

export function depositTargets(): DepositTargets {
  return {
    packageId: config.aphotic.packageId,
    vaultId: config.aphotic.vaultId,
    poolId: config.deepbook.poolId,
    baseType: config.hashi.hbtcType,
    quoteType: config.deepbook.dbusdcType,
  };
}

/** Env keys that must be filled before the deposit PTB can be built at all. */
export function missingDepositTargets(): string[] {
  const t = depositTargets();
  const missing: string[] = [];
  if (t.packageId.length === 0) missing.push('VITE_APHOTIC_PACKAGE_ID');
  if (t.vaultId.length === 0) missing.push('VITE_VAULT_ID');
  return missing;
}

function requireTargets(): DepositTargets {
  const missing = missingDepositTargets();
  if (missing.length > 0) {
    throw new Error(
      `Cannot build the deposit: ${missing.join(' and ')} ${
        missing.length === 1 ? 'is' : 'are'
      } empty, so there is no published vault to deposit into.`,
    );
  }
  return depositTargets();
}

// ── the call ────────────────────────────────────────────────────────────────

export interface DepositCallArgs {
  /**
   * hBTC coin object ids owned by the sender, most-valuable-first is not required.
   * The first is the merge destination; the rest are merged into it.
   */
  readonly coinIds: readonly string[];
  /** Exactly how many sats to deposit. */
  readonly amountSats: bigint;
  /** Total sats across `coinIds`. When equal to `amountSats` nothing is split. */
  readonly totalSats: bigint;
  /**
   * DeepBook mid at FLOAT_SCALING 1e9, or 0n when the book has no mid.
   * 0n is SAFE and EXACT while the vault holds no DBUSDC (v3 nav_sats), and it is
   * a guaranteed abort (EZeroNav) the moment it does — which is the correct
   * failure, not a guessed price (G9).
   */
  readonly bookMid: bigint;
}

export interface DepositCallArg {
  readonly name: string;
  readonly type: string;
  readonly value: string;
  readonly note?: string;
}

export interface CallDescription {
  readonly target: string;
  readonly typeArguments: readonly string[];
  readonly args: readonly DepositCallArg[];
  readonly returns?: string;
  readonly absence?: string;
}

const PKG_PLACEHOLDER = '<aphotic>';
const VAULT_PLACEHOLDER = '<vault>';

export function describeDepositCall(a: DepositCallArgs): CallDescription {
  const t = depositTargets();
  const split = a.amountSats !== a.totalSats;
  return {
    target: `${t.packageId.length > 0 ? t.packageId : PKG_PLACEHOLDER}::vault::deposit_btc`,
    typeArguments: [t.baseType, t.quoteType],
    args: [
      {
        name: 'vault',
        type: '&mut Vault<B, Q>',
        value: t.vaultId.length > 0 ? t.vaultId : VAULT_PLACEHOLDER,
      },
      {
        name: 'coin_in',
        type: 'Coin<B>',
        value: `${a.amountSats.toString()} sats`,
        note: split
          ? `split out of ${a.coinIds.length} merged coin object${a.coinIds.length === 1 ? '' : 's'}; the remainder stays in your wallet`
          : `your whole hBTC balance across ${a.coinIds.length} coin object${a.coinIds.length === 1 ? '' : 's'}`,
      },
      {
        name: 'book_mid',
        type: 'u128',
        value: a.bookMid.toString(),
        note:
          a.bookMid === 0n
            ? 'no DeepBook mid exists — exact and unused while the vault holds no DBUSDC (nav_sats returns early)'
            : 'DeepBook mid at 1e9 scaling — NAV is valued at the book, never at a raw oracle price',
      },
    ],
    returns: 'u64 shares_minted (also emitted as vault::Deposited)',
    absence:
      'There is no recipient argument. Shares are credited to ctx.sender(), so a sponsor can pay for this transaction without ever becoming its sender.',
  };
}

/**
 * ONE PTB: merge the sender's hBTC coin objects, split the exact amount when it is
 * less than the whole, and hand it to `vault::deposit_btc`. Settles in one
 * checkpoint — no bridge is involved (G1).
 */
export function buildDepositBtcTx(a: DepositCallArgs): Transaction {
  const t = requireTargets();

  if (a.coinIds.length === 0) throw new Error('No hBTC coin objects to deposit.');
  if (a.amountSats <= 0n) throw new Error('Deposit amount must be greater than zero.');
  if (a.amountSats > a.totalSats) {
    throw new Error(
      `Deposit amount ${a.amountSats} sats exceeds your balance of ${a.totalSats} sats.`,
    );
  }

  const tx = new Transaction();

  const [primaryId, ...restIds] = a.coinIds;
  // `primaryId` is defined: coinIds.length > 0 was checked above.
  const primary = tx.object(primaryId as string);

  if (restIds.length > 0) {
    tx.mergeCoins(
      primary,
      restIds.map((id) => tx.object(id)),
    );
  }

  const coinIn =
    a.amountSats === a.totalSats
      ? primary
      : tx.splitCoins(primary, [tx.pure.u64(a.amountSats)])[0];

  tx.moveCall({
    target: `${t.packageId}::vault::deposit_btc`,
    typeArguments: [t.baseType, t.quoteType],
    arguments: [tx.object(t.vaultId), coinIn, tx.pure.u128(a.bookMid)],
  });

  return tx;
}

// ── vault::Deposited ────────────────────────────────────────────────────────

/**
 * `vault::Deposited` exactly as declared in move/sources/vault.move. Decoding the
 * event (rather than trusting a returned value we never see) is how the share count
 * is obtained after execution.
 */
export const DEPOSITED_EVENT = bcs.struct('Deposited', {
  vault_id: bcs.Address,
  who: bcs.Address,
  deposit_sats: bcs.u64(),
  shares_minted: bcs.u64(),
  nav_after_sats: bcs.u64(),
});

/** Fully-qualified event type string, for filtering a transaction's events. */
export function depositedEventType(): string {
  return `${depositTargets().packageId}::vault::Deposited`;
}
