// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T3.1
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/APP.md §2 (Screen 1 — Deposit), §2.3 (React Query drives reads)
// @spec       docs/RECON.md R1 (gRPC v2 is the transport), R5 (hBTC coin type)
// @rules      G1 G7 G10
// @depends    ../../config.ts (T0.4) · ../../lib/suiClient.ts (T0.4)
//             @tanstack/react-query (provider mounted in main.tsx)
// @facts      hBTC is a plain fungible Coin<hashi::btc::BTC>, 8 decimals, sats (G1).
// @facts        An address can hold MANY coin objects of it; the deposit PTB merges
// @facts        them. Nothing here is a "position" object.
// @facts      client.core.listCoins({ owner, coinType }) → { objects: Coin[],
// @facts        hasNextPage, cursor }, where Coin.balance is a DECIMAL STRING. It is
// @facts        widened to bigint at the boundary and never touches `number`.
// @facts      Pagination is followed to the end: a wallet with many small coins
// @facts        would otherwise silently under-report its balance.
// @implements export interface HbtcCoin · export interface HbtcCoinsState
//             export function useHbtcCoins(owner: string | null): HbtcCoinsState
// @forbidden  constructing a Sui client here — ../../lib/suiClient.ts is the ONE factory
// @forbidden  a coin-type literal — it comes from config (G7)
// @forbidden  `number` for a balance — bigint only (G10)
// @invariant  1. No request is issued while `owner` is null (a demo must not fire
//                network on page load — G6).
//             2. `totalSats` is the exact sum of the returned coin balances.
// @ac         docs/APP.md §7 A10 A11
// @verify     cd app && npx tsc --noEmit
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { useQuery } from '@tanstack/react-query';

import { config } from '../../config';
import { getSuiClient } from '../../lib/suiClient';

export interface HbtcCoin {
  readonly objectId: string;
  readonly balanceSats: bigint;
}

export interface HbtcCoinsState {
  readonly coins: readonly HbtcCoin[];
  readonly totalSats: bigint;
  readonly isLoading: boolean;
  readonly isFetching: boolean;
  readonly error: string | null;
  /** ms since epoch of the last successful read, or null. */
  readonly updatedAt: number | null;
  readonly refetch: () => void;
}

/** Follows the cursor to the end — a partial page would under-report the balance. */
async function listAllHbtc(owner: string, signal?: AbortSignal): Promise<HbtcCoin[]> {
  const client = getSuiClient();
  const coinType = config.hashi.hbtcType;
  const out: HbtcCoin[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < 20; page += 1) {
    const response: Awaited<ReturnType<typeof client.core.listCoins>> = await client.core.listCoins({
      owner,
      coinType,
      cursor,
      signal,
    });
    for (const coin of response.objects) {
      out.push({ objectId: coin.objectId, balanceSats: BigInt(coin.balance) });
    }
    if (!response.hasNextPage || response.cursor === null) break;
    cursor = response.cursor;
  }

  // Largest first: the merge destination should be the coin that already holds the
  // most, which keeps the split (when there is one) on the smallest possible object.
  return out.sort((a, b) => (a.balanceSats === b.balanceSats ? 0 : a.balanceSats > b.balanceSats ? -1 : 1));
}

export function useHbtcCoins(owner: string | null): HbtcCoinsState {
  const query = useQuery({
    queryKey: ['hbtc-coins', owner, config.hashi.hbtcType],
    enabled: owner !== null,
    // Balances change the moment a deposit lands, so this one IS refetched — but
    // only on demand and on mount, never on a timer (G6: no background traffic).
    staleTime: 5_000,
    refetchInterval: false,
    retry: 1,
    queryFn: async ({ signal }) => {
      if (owner === null) throw new Error('No connected account.');
      return listAllHbtc(owner, signal);
    },
  });

  const coins = query.data ?? [];
  const totalSats = coins.reduce((sum, coin) => sum + coin.balanceSats, 0n);

  return {
    coins,
    totalSats,
    isLoading: owner !== null && query.isPending,
    isFetching: query.isFetching,
    error:
      query.error === null || query.error === undefined
        ? null
        : query.error instanceof Error
          ? query.error.message
          : String(query.error),
    updatedAt: query.dataUpdatedAt === 0 ? null : query.dataUpdatedAt,
    refetch: () => {
      void query.refetch();
    },
  };
}
