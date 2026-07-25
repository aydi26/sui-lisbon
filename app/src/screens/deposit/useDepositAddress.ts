// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T3.1, T3.3
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/APP.md §2.3 (React Query drives every async read), §2.4 (state)
// @spec       docs/APP.md ERRATA E-A5 · docs/RECON.md R1 (gRPC is the transport)
// @rules      G6 G7
// @depends    ./depositAddress.ts (T3.1) · ../../session/useSession.ts (T3.3)
//             @tanstack/react-query (provider mounted in main.tsx)
// @facts      The query is DISABLED until a Sui address exists. Consequence: with
// @facts        Enoki unconfigured (today's deployment) and in DEMO_MODE=mock, the
// @facts        screen issues ZERO network requests on load — A11 holds, and G6's
// @facts        "a demo must not fire requests on page load" holds too.
// @facts      The derivation itself is OFFLINE. The one network call fetches the
// @facts        bridge's PUBLIC keys from the Hashi shared object, and its result
// @facts        is cached for the session (the committee's master key does not
// @facts        rotate mid-demo; a stale read would be caught by the length asserts
// @facts        and by the golden-vector self-check).
// @facts      ⚠ There is NO mock deposit address. A derived Bitcoin address is
// @facts        real money: mock mode shows the pre-staged FIXTURE address, clearly
// @facts        labelled, and never a synthesised one presented as yours.
// @implements export interface DepositAddressState
//             export function useDepositAddress(): DepositAddressState
// @forbidden  deriving from anything but the live on-chain keys — a fallback key
//             would produce a real-looking address whose BTC is unspendable
// @forbidden  refetching on window focus / on an interval — the keys are static
// @invariant  1. `address` is non-null only when the golden-vector self-check
//                passed AND both on-chain keys were read at their exact lengths.
//             2. No request is issued while `suiAddress` is null.
// @ac         docs/APP.md §7 A1 A11
// @verify     cd app && npx tsc --noEmit
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import { useAphoticSession } from '../../session/useSession';

import {
  bip21,
  deriveDepositAddress,
  derivationSelfCheck,
  readHashiDepositKeys,
  bytesToHex,
  type SelfCheckResult,
} from './depositAddress';

export interface DepositAddressState {
  /** The depositor's Sui address, or null when signed out. */
  readonly suiAddress: string | null;
  /** bech32m `tb1p…`, or null until derived. */
  readonly address: string | null;
  /** BIP-21 URI for the QR, or null. */
  readonly uri: string | null;
  readonly isLoading: boolean;
  readonly error: string | null;
  /** Golden-vector known-answer test over the SDK's derivation pipeline. */
  readonly selfCheck: SelfCheckResult;
  /** Provenance for the UI: which object the keys came from, and their hashes. */
  readonly provenance: {
    readonly objectId: string;
    readonly mpcSec1Hex: string;
    readonly guardianHex: string;
  } | null;
  readonly retry: () => void;
}

export function useDepositAddress(): DepositAddressState {
  const { address: suiAddress } = useAphoticSession();

  // Offline, memoised, ~1 ms of curve arithmetic. Runs on first render so the UI
  // can show the verdict even before anyone signs in.
  const selfCheck = useMemo(() => derivationSelfCheck(), []);

  const query = useQuery({
    // The Sui address is part of the key: a different account derives a
    // different Bitcoin address, and caching across accounts would be a bug.
    queryKey: ['deposit-address', suiAddress],
    enabled: suiAddress !== null,
    // The committee master key + guardian key are effectively static. Never
    // poll them; a demo must not generate background traffic (G6).
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchInterval: false,
    retry: 1,
    queryFn: async ({ signal }) => {
      if (suiAddress === null) throw new Error('No Sui address in session.');
      const keys = await readHashiDepositKeys(signal);
      const address = deriveDepositAddress(keys, suiAddress);
      return {
        address,
        provenance: {
          objectId: keys.sourceObjectId,
          mpcSec1Hex: bytesToHex(keys.mpcMasterCompressed),
          guardianHex: bytesToHex(keys.guardianBtcXOnly),
        },
      };
    },
  });

  const address = query.data?.address ?? null;

  return {
    suiAddress,
    address,
    uri: address === null ? null : bip21(address),
    isLoading: suiAddress !== null && query.isPending,
    error:
      query.error === null || query.error === undefined
        ? null
        : query.error instanceof Error
          ? query.error.message
          : String(query.error),
    selfCheck,
    provenance: query.data?.provenance ?? null,
    retry: () => {
      void query.refetch();
    },
  };
}
