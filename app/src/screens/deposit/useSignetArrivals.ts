// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T3.1
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/APP.md §2.2 (the six stages) · docs/RECON.md R14 (no relayer)
// @rules      G1 G6 G7
// @depends    ./hashiDeposit.ts (T3.1) · @tanstack/react-query
// @facts      Stages 1 and 2 of the six are observable from the browser against a
// @facts        public chain, so they are READ, not staged. Stage 3 onward lives
// @facts        inside Hashi and is only observable once the UTXO is registered.
// @facts      ⚠ NOT polled on a timer. A 70-minute wait polled every few seconds is
// @facts        background traffic during a demo (G6) and it teaches the user nothing
// @facts        a "check now" button does not. The last-checked time is returned so
// @facts        the screen can state the age instead of implying live.
// @facts      A deposit is registerable only at >= bitcoin_confirmation_threshold (6)
// @facts        confirmations — an unconfirmed txid can be RBF-replaced out of
// @facts        existence, and registering against it fails SILENTLY (R14.3).
// @implements export interface ArrivalsState
//             export function useSignetArrivals(address: string | null): ArrivalsState
// @forbidden  a poll interval — refresh is user-initiated (G6)
// @forbidden  treating "no transactions yet" as an error state
// @invariant  1. No request is issued while `address` is null.
//             2. `registerable` contains exactly the UTXOs at or above the threshold.
// @ac         docs/APP.md §7 A5 A11
// @verify     cd app && npx tsc --noEmit
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { useQuery } from '@tanstack/react-query';

import { config } from '../../config';
import { fetchSignetArrivals, type SignetUtxo } from './hashiDeposit';

export interface ArrivalsState {
  readonly utxos: readonly SignetUtxo[];
  /** At or above the confirmation threshold — safe to register (R14.3). */
  readonly registerable: readonly SignetUtxo[];
  /** The deepest arrival, whatever its state. Drives the lifecycle stage. */
  readonly best: SignetUtxo | null;
  readonly tipHeight: number | null;
  readonly isLoading: boolean;
  readonly isFetching: boolean;
  readonly error: string | null;
  readonly updatedAt: number | null;
  readonly refetch: () => void;
}

export function useSignetArrivals(address: string | null): ArrivalsState {
  const query = useQuery({
    queryKey: ['signet-arrivals', address],
    enabled: address !== null,
    staleTime: 30_000,
    refetchInterval: false,
    retry: 1,
    queryFn: async ({ signal }) => {
      if (address === null) throw new Error('No deposit address derived yet.');
      return fetchSignetArrivals(address, signal);
    },
  });

  const utxos = query.data?.utxos ?? [];
  const threshold = config.hashi.confirmations;
  const registerable = utxos.filter((utxo) => utxo.confirmations >= threshold);

  const best =
    utxos.length === 0
      ? null
      : utxos.reduce((deepest, utxo) => (utxo.confirmations > deepest.confirmations ? utxo : deepest));

  return {
    utxos,
    registerable,
    best,
    tipHeight: query.data?.tipHeight ?? null,
    isLoading: address !== null && query.isPending,
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
