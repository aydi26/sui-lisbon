// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T3.1
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/APP.md §2 (Screen 1 — Deposit), §2.3 (React Query drives reads)
// @spec       move/sources/vault.move public getters (T1.1, DONE)
// @spec       docs/RECON.md R1 (gRPC v2 is the ONLY transport on the testnet fullnode)
// @rules      G1 G7 G9 G10
// @depends    ../../lib/suiClient.ts (T0.4) · ./depositPtb.ts (T3.1)
// @facts      Depositor records live in `Vault.depositors: Table<address, Depositor>`,
// @facts        so there is no object to fetch: every number below is read by
// @facts        SIMULATING the package's own public getters. The read path is exactly
// @facts        the code path the deposit PTB will take.
// @facts      Getters used (verbatim, move/sources/vault.move):
// @facts        total_shares<B,Q>(&Vault): u64        free_btc_sats<B,Q>(&Vault): u64
// @facts        quote_value<B,Q>(&Vault): u64         is_paused<B,Q>(&Vault): bool
// @facts        shares_of<B,Q>(&Vault, address): u64  pending_exit_sats<B,Q>(…): u64
// @facts      ⚠ In v3 shares_of / pending_exit_sats RETURN 0 for an address with no
// @facts        Table record (`if (!contains) return 0`) — they no longer abort, so all
// @facts        six getters fit in ONE simulation. Only btc_exit_address still aborts,
// @facts        and this screen never calls it.
// @facts      ⚠ NAV mirrors vault::nav_sats EXACTLY, including the v3 early return:
// @facts          quote == 0            → nav = free_btc_sats     (exact, no price)
// @facts          quote != 0, mid != 0  → nav = free + quote*1e9/mid
// @facts          quote != 0, mid == 0  → UNVALUABLE (Move would abort EZeroNav)
// @facts        The third case is reported, never guessed and never taken from Pyth (G9).
// @external   client.core.simulateTransaction({ transaction, include: { commandResults: true } })
// @implements export interface VaultPosition · export type VaultPositionState
//             export function useVaultPosition(who: string | null): VaultPositionQuery
// @forbidden  constructing a Sui client here — lib/suiClient.ts is the ONE factory
// @forbidden  a canonical on-chain id literal — everything comes from config (G7)
// @forbidden  presenting a stale figure as fresh — updatedAt is returned so the UI
//             can mark it (docs/APP.md §7 A9)
// @invariant  1. Reads only. No transaction is ever executed here.
//             2. Any RPC/decode failure resolves to an error string, never a throw
//                that unmounts the screen.
//             3. navSats is null exactly when Move could not value the vault either.
// @ac         docs/APP.md §7 A4 A9 A11
// @verify     cd app && npx tsc --noEmit
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { bcs } from '@mysten/sui/bcs';
import { Transaction } from '@mysten/sui/transactions';
import { useQuery } from '@tanstack/react-query';

import { getSuiClient } from '../../lib/suiClient';
import { depositTargets, missingDepositTargets } from './depositPtb';

/** DeepBook v3 FLOAT_SCALING — `quote = base * price / 1e9` (vault.move). */
const DEEPBOOK_PRICE_SCALING = 1_000_000_000n;

export interface VaultPosition {
  readonly totalShares: bigint;
  readonly freeBtcSats: bigint;
  readonly quoteValue: bigint;
  readonly paused: boolean;
  readonly myShares: bigint;
  readonly myPendingExitSats: bigint;
  /** null when Move itself could not value the vault (quote != 0 with no mid). */
  readonly navSats: bigint | null;
}

export interface VaultPositionQuery {
  readonly position: VaultPosition | null;
  readonly isLoading: boolean;
  readonly isFetching: boolean;
  readonly error: string | null;
  /** Empty env keys blocking the read entirely. */
  readonly missing: readonly string[];
  readonly updatedAt: number | null;
  readonly refetch: () => void;
}

const readU64 = (bytes: Uint8Array): bigint => BigInt(bcs.u64().parse(bytes));
const readBool = (bytes: Uint8Array): boolean => bcs.bool().parse(bytes);

async function simulateReads(tx: Transaction, signal?: AbortSignal): Promise<Uint8Array[]> {
  const result = await getSuiClient().core.simulateTransaction({
    transaction: tx,
    include: { commandResults: true },
    checksEnabled: false,
    signal,
  });
  if (result.$kind !== 'Transaction') throw new Error('the simulation aborted');
  const commands = result.commandResults ?? [];
  return commands.map((command) => {
    const first = command.returnValues[0];
    if (first === undefined) throw new Error('a getter returned nothing');
    return first.bcs;
  });
}

/**
 * Mirrors `vault::nav_sats` exactly, including the v3 early return that makes a
 * base-only vault valuable with no price at all.
 */
export function navFrom(freeBtcSats: bigint, quoteValue: bigint, bookMid: bigint): bigint | null {
  if (quoteValue === 0n) return freeBtcSats;
  if (bookMid === 0n) return null;
  return freeBtcSats + (quoteValue * DEEPBOOK_PRICE_SCALING) / bookMid;
}

/**
 * Price of one share, in sats, scaled by 1e8 so it survives as an integer.
 * Returns null for an empty vault — there is no price before the first deposit.
 */
export function sharePriceScaled(navSats: bigint | null, totalShares: bigint): bigint | null {
  if (navSats === null || totalShares === 0n) return null;
  return (navSats * 100_000_000n) / totalShares;
}

export function useVaultPosition(who: string | null, bookMid: bigint): VaultPositionQuery {
  const missing = missingDepositTargets();

  const query = useQuery({
    queryKey: ['vault-position', who, bookMid.toString()],
    enabled: who !== null && missing.length === 0,
    staleTime: 5_000,
    refetchInterval: false,
    retry: 1,
    queryFn: async ({ signal }): Promise<VaultPosition> => {
      if (who === null) throw new Error('No connected account.');
      const t = depositTargets();
      const typeArguments = [t.baseType, t.quoteType];

      const tx = new Transaction();
      tx.setSender(who);
      for (const fn of ['total_shares', 'free_btc_sats', 'quote_value', 'is_paused'] as const) {
        tx.moveCall({
          target: `${t.packageId}::vault::${fn}`,
          typeArguments,
          arguments: [tx.object(t.vaultId)],
        });
      }
      for (const fn of ['shares_of', 'pending_exit_sats'] as const) {
        tx.moveCall({
          target: `${t.packageId}::vault::${fn}`,
          typeArguments,
          arguments: [tx.object(t.vaultId), tx.pure.address(who)],
        });
      }

      const out = await simulateReads(tx, signal);
      const totalShares = readU64(out[0] as Uint8Array);
      const freeBtcSats = readU64(out[1] as Uint8Array);
      const quoteValue = readU64(out[2] as Uint8Array);
      const paused = readBool(out[3] as Uint8Array);
      const myShares = readU64(out[4] as Uint8Array);
      const myPendingExitSats = readU64(out[5] as Uint8Array);

      return {
        totalShares,
        freeBtcSats,
        quoteValue,
        paused,
        myShares,
        myPendingExitSats,
        navSats: navFrom(freeBtcSats, quoteValue, bookMid),
      };
    },
  });

  return {
    position: query.data ?? null,
    isLoading: who !== null && missing.length === 0 && query.isPending,
    isFetching: query.isFetching,
    error:
      query.error === null || query.error === undefined
        ? null
        : query.error instanceof Error
          ? query.error.message
          : String(query.error),
    missing,
    updatedAt: query.dataUpdatedAt === 0 ? null : query.dataUpdatedAt,
    refetch: () => {
      void query.refetch();
    },
  };
}
