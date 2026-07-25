// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T3.4
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/APP.md §1 (all async reads go through React Query), §2.2
// @spec       docs/RECON.md R1 (gRPC v2 is the only transport on the testnet fullnode)
// @rules      G1 G7 G10
// @depends    ./useSession.ts (T3.3) · ../lib/suiClient.ts (T0.4) · ../config.ts (T0.4)
// @facts      hBTC is a fungible Coin<hashi::btc::BTC>, 8 decimals, amounts in SATS.
// @facts        A balance read is therefore an ordinary coin-balance read — there is
// @facts        no position object and no Bitcoin latency on this path (G1).
// @facts      Read via the gRPC core client:
// @facts        client.core.getBalance({ owner, coinType }) → { balance: { balance } }
// @facts        `balance` is a DECIMAL STRING; it becomes a bigint here and stays one.
// @facts      An address that has never held the coin is not an error: the node
// @facts        answers 0, and a thrown read renders as `error`, never as 0.
// @implements export interface BalanceRead
//             export function useCoinBalance(coinType, owner): BalanceRead
//             export function useHbtcBalance(owner?): BalanceRead
//             export function useSuiBalance(owner?): BalanceRead
// @forbidden  `number` for a balance — every sats value is bigint
// @forbidden  constructing a Sui client here — lib/suiClient.ts is the ONE factory
// @forbidden  reporting an unavailable balance as zero — zero and unknown differ
// @invariant  1. sats is null whenever the read has not succeeded.
// @invariant  2. No request is issued while owner is null (G6: nothing on page load
//                before the user has connected).
// @ac         the wallet bar shows the connected address's real hBTC balance.
// @verify     cd app && npx tsc --noEmit
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { useQuery } from '@tanstack/react-query';

import { config } from '../config';
import { getSuiClient } from '../lib/suiClient';
import { useAphoticSession } from './useSession';

export interface BalanceRead {
  /** Balance in the coin's base unit (sats for hBTC, MIST for SUI). Null = unknown. */
  readonly sats: bigint | null;
  readonly isLoading: boolean;
  /** Human reason the read failed, or null. */
  readonly error: string | null;
  readonly refetch: () => void;
}

const SUI_TYPE = '0x2::sui::SUI';

/** One coin balance for one owner. Null owner ⇒ the query never runs. */
export function useCoinBalance(coinType: string, owner: string | null): BalanceRead {
  const query = useQuery({
    queryKey: ['aphotic', 'balance', coinType, owner],
    enabled: owner !== null && coinType.length > 0,
    // The Sui leg settles in one checkpoint, so a short poll keeps the bar honest
    // without hammering the node.
    refetchInterval: 15_000,
    queryFn: async (): Promise<bigint> => {
      if (owner === null) return 0n;
      const response = await getSuiClient().core.getBalance({ owner, coinType });
      return BigInt(response.balance.balance);
    },
  });

  return {
    sats: query.data ?? null,
    isLoading: query.isPending && owner !== null,
    error: query.error instanceof Error ? query.error.message : null,
    refetch: () => {
      void query.refetch();
    },
  };
}

/** hBTC balance in sats. Defaults to the connected session address. */
export function useHbtcBalance(owner?: string | null): BalanceRead {
  const session = useAphoticSession();
  const who = owner === undefined ? session.address : owner;
  return useCoinBalance(config.hashi.hbtcType, who);
}

/** SUI balance in MIST. Defaults to the connected session address. */
export function useSuiBalance(owner?: string | null): BalanceRead {
  const session = useAphoticSession();
  const who = owner === undefined ? session.address : owner;
  return useCoinBalance(SUI_TYPE, who);
}
