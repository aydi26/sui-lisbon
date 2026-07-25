// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T3.1
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/APP.md §2 · docs/GOLDEN-RULES.md G9 (value at the DeepBook mid)
// @spec       move/sources/router.move try_book_mid (T1.5, DONE)
// @spec       docs/RECON.md R10 (the hosted indexer does not list this pool)
// @spec       docs/RECON.md R11 (Pyth BETA feed on testnet)
// @rules      G4 G7 G9
// @depends    ../../config.ts (T0.4) · ../../lib/suiClient.ts (T0.4) · ./depositPtb.ts
// @facts      Move signature simulated here (verbatim, move/sources/router.move):
// @facts        public fun try_book_mid<B, Q>(pool: &Pool<B, Q>, clock: &Clock): Option<u128>
// @facts        On an EMPTY side get_level2_range succeeds and returns ([], []), so
// @facts        try_book_mid returns `none` — an empty book is a DEFINED state here,
// @facts        never an error, and never pool::mid_price (which aborts EEmptyOrderbook).
// @facts      ⚠ The hBTC/DBUSDC book is empty on BOTH sides today (blocker B2), so the
// @facts        honest answer right now is `none`. We render that, we do not fake it.
// @facts      Pyth is a REFERENCE ONLY. book_mid is a DeepBook price at FLOAT_SCALING
// @facts        1e9; a Pyth BTC/USD quote is not that number and must never be used to
// @facts        VALUE the vault (G9). It is offered as a deposit-call argument only in
// @facts        the one case where Move provably ignores it — a vault holding zero
// @facts        DBUSDC, where nav_sats returns before the assert (v3).
// @facts      Pyth → DeepBook-scaled conversion, all integer:
// @facts        book_mid = pyth_price * 10^(expo + quote_decimals - base_decimals + 9)
// @facts        Decimals are READ FROM CHAIN (getCoinMetadata), never assumed.
// @external   client.core.simulateTransaction · client.core.getCoinMetadata
//             GET {hermes}/v2/updates/price/latest?ids[]=<feed>
// @implements export interface BookMidState
//             export function useBookMid(enabled: boolean): BookMidState
//             export function pythToBookMid(price, expo, baseDecimals, quoteDecimals): bigint
// @forbidden  pool::mid_price — it aborts on an empty book (E-M7)
// @forbidden  the hosted DeepBook indexer — it does not list this pool (R10)
// @forbidden  presenting a Pyth quote as the vault's valuation price — G9
// @forbidden  a canonical id literal — everything comes from config (G7)
// @invariant  1. `deepbookMid` is non-zero ONLY when the on-chain book really has a
//                mid on both sides.
//             2. A Pyth failure degrades to `pythMid = 0n`; it never blocks the read.
// @ac         docs/APP.md §7 A9
// @verify     cd app && npx tsc --noEmit
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { bcs } from '@mysten/sui/bcs';
import { Transaction } from '@mysten/sui/transactions';
import { SUI_CLOCK_OBJECT_ID } from '@mysten/sui/utils';
import { useQuery } from '@tanstack/react-query';

import { config } from '../../config';
import { getSuiClient } from '../../lib/suiClient';
import { depositTargets, missingDepositTargets } from './depositPtb';

export interface BookMidState {
  /** DeepBook mid at 1e9 scaling, or 0n when the book has no mid (today: 0n). */
  readonly deepbookMid: bigint;
  /** Pyth BETA BTC/USD converted to the same scaling. Reference only (G9). */
  readonly pythMid: bigint;
  /** Human BTC/USD from the same Pyth read, for display. null when unavailable. */
  readonly pythUsd: number | null;
  /** Pyth publish time (ms), so the UI can state the age instead of implying live. */
  readonly pythPublishedAtMs: number | null;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly updatedAt: number | null;
  readonly refetch: () => void;
}

/** All-integer conversion. Negative net exponents floor-divide; nothing is a float. */
export function pythToBookMid(
  price: bigint,
  expo: number,
  baseDecimals: number,
  quoteDecimals: number,
): bigint {
  const net = expo + quoteDecimals - baseDecimals + 9;
  if (price <= 0n) return 0n;
  if (net >= 0) return price * 10n ** BigInt(net);
  return price / 10n ** BigInt(-net);
}

interface PythLatest {
  readonly price: bigint;
  readonly expo: number;
  readonly publishTimeMs: number;
}

async function readPyth(signal?: AbortSignal): Promise<PythLatest | null> {
  const feed = config.pyth.feedId.replace(/^0x/, '');
  if (feed.length === 0 || config.pyth.hermesUrl.length === 0) return null;
  const url = `${config.pyth.hermesUrl.replace(/\/+$/, '')}/v2/updates/price/latest?ids[]=${feed}&encoding=hex`;
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Hermes returned HTTP ${response.status}`);
  const body = (await response.json()) as {
    parsed?: { price?: { price?: string; expo?: number; publish_time?: number } }[];
  };
  const entry = body.parsed?.[0]?.price;
  if (entry?.price === undefined || entry.expo === undefined) return null;
  return {
    price: BigInt(entry.price),
    expo: entry.expo,
    publishTimeMs: (entry.publish_time ?? 0) * 1000,
  };
}

async function readDeepbookMid(signal?: AbortSignal): Promise<bigint> {
  const t = depositTargets();
  const tx = new Transaction();
  tx.moveCall({
    target: `${t.packageId}::router::try_book_mid`,
    typeArguments: [t.baseType, t.quoteType],
    arguments: [tx.object(t.poolId), tx.object(SUI_CLOCK_OBJECT_ID)],
  });

  const result = await getSuiClient().core.simulateTransaction({
    transaction: tx,
    include: { commandResults: true },
    checksEnabled: false,
    signal,
  });
  if (result.$kind !== 'Transaction') throw new Error('try_book_mid aborted');
  const first = result.commandResults?.[0]?.returnValues[0];
  if (first === undefined) throw new Error('try_book_mid returned nothing');

  const parsed = bcs.option(bcs.u128()).parse(first.bcs);
  return parsed === null || parsed === undefined ? 0n : BigInt(parsed);
}

async function readDecimals(coinType: string, signal?: AbortSignal): Promise<number | null> {
  try {
    const { coinMetadata } = await getSuiClient().core.getCoinMetadata({ coinType, signal });
    return coinMetadata?.decimals ?? null;
  } catch {
    return null;
  }
}

export function useBookMid(enabled: boolean): BookMidState {
  const missing = missingDepositTargets();

  const query = useQuery({
    queryKey: ['book-mid', config.deepbook.poolId, config.pyth.feedId],
    enabled: enabled && missing.length === 0,
    staleTime: 30_000,
    refetchInterval: false,
    retry: 1,
    queryFn: async ({ signal }) => {
      // The book read must not be taken down by a Pyth outage, and vice versa.
      const [book, pyth, baseDecimals, quoteDecimals] = await Promise.all([
        readDeepbookMid(signal).catch(() => 0n),
        readPyth(signal).catch(() => null),
        readDecimals(config.hashi.hbtcType, signal),
        readDecimals(config.deepbook.dbusdcType, signal),
      ]);

      const canConvert = pyth !== null && baseDecimals !== null && quoteDecimals !== null;
      return {
        deepbookMid: book,
        pythMid: canConvert
          ? pythToBookMid(pyth.price, pyth.expo, baseDecimals, quoteDecimals)
          : 0n,
        pythUsd: pyth === null ? null : Number(pyth.price) * 10 ** pyth.expo,
        pythPublishedAtMs: pyth?.publishTimeMs ?? null,
      };
    },
  });

  return {
    deepbookMid: query.data?.deepbookMid ?? 0n,
    pythMid: query.data?.pythMid ?? 0n,
    pythUsd: query.data?.pythUsd ?? null,
    pythPublishedAtMs: query.data?.pythPublishedAtMs ?? null,
    isLoading: enabled && missing.length === 0 && query.isPending,
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
