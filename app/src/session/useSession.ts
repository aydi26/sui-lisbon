// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T3.3
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/APP.md §2.1 (<ZkLoginButton/>), §2.4, §7 A1
// @spec       docs/BUILD-PLAN.md Phase 3 T3.3
// @rules      G2 G6 G7
// @depends    ./enoki.ts (T3.3) · ../config.ts (T0.4)
// @facts      Enoki wallets are WALLET-STANDARD wallets, so the whole session is
// @facts        driven by dapp-kit's own hooks — there is no Enoki-specific React
// @facts        state to keep. This hook is a thin, typed facade over them plus
// @facts        the zkLogin session read from the wallet's `enoki:getSession`.
// @facts      Signing in = connecting to the Enoki Google wallet. Enoki opens a
// @facts        popup, so `signIn()` MUST be called from a user gesture or the
// @facts        browser blocks it.
// @facts      Sponsorship is server-side (Enoki gas pool). Nothing here pays gas,
// @facts        and the SENDER is always the user's own zkLogin address (G2).
// @implements export type SessionStatus = 'unconfigured' | 'disconnected' | 'connecting' | 'connected'
//             export interface AphoticSession
//             export function useAphoticSession(): AphoticSession
// @forbidden  '@mysten/enoki/react' — deprecated
// @forbidden  persisting a JWT / ephemeral key / salt ourselves
// @invariant  1. status === 'unconfigured' whenever Enoki lacks its two public keys,
//                and signIn() then throws a descriptive error instead of a popup.
//             2. A connected session grants NO capability over vault funds — exits
//                go through the Move-pinned gateway, reclaims are depositor-signed (G2).
//             3. No network call happens until signIn() is invoked (G6: a demo must
//                not fire requests on page load).
// @ac         docs/APP.md §7 A1 — sign-in yields a Sui address, derived client-side.
// @verify     cd app && npx tsc --noEmit
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  useConnectWallet,
  useCurrentAccount,
  useCurrentWallet,
  useDisconnectWallet,
  useWallets,
} from '@mysten/dapp-kit';

import {
  enokiConfigProblems,
  findGoogleWallet,
  isEnokiConfigured,
  readZkLoginSession,
  walletProvider,
  type EnokiZkLoginSession,
  type WalletLike,
} from './enoki';

export type SessionStatus = 'unconfigured' | 'disconnected' | 'connecting' | 'connected';

export interface AphoticSession {
  readonly status: SessionStatus;
  /** The user's Sui address, derived client-side from the JWT by Enoki. */
  readonly address: string | null;
  /** 'google' for the zkLogin wallet, null for a browser-extension wallet. */
  readonly provider: string | null;
  /** True when the connected wallet is an Enoki zkLogin wallet (not an extension). */
  readonly isZkLogin: boolean;
  /** maxEpoch / randomness / expiry, read from the wallet. Null until connected. */
  readonly zkSession: EnokiZkLoginSession | null;
  /** Non-empty when Enoki is misconfigured — render these instead of a dead button. */
  readonly problems: readonly string[];
  /** Opens the Google popup. MUST be called from a user gesture. */
  readonly signIn: () => Promise<void>;
  readonly signOut: () => void;
}

export function useAphoticSession(): AphoticSession {
  const wallets = useWallets();
  const account = useCurrentAccount();
  const currentWallet = useCurrentWallet();
  const { mutateAsync: connect, isPending: connecting } = useConnectWallet();
  const { mutate: disconnect } = useDisconnectWallet();

  const [zkSession, setZkSession] = useState<EnokiZkLoginSession | null>(null);

  const configured = isEnokiConfigured();
  const problems = useMemo(() => enokiConfigProblems(), [configured]);

  const googleWallet = useMemo(
    () => findGoogleWallet(wallets as unknown as readonly WalletLike[]),
    [wallets],
  );

  const connectedWallet = (currentWallet.currentWallet ?? null) as WalletLike | null;
  const provider = useMemo(() => walletProvider(connectedWallet), [connectedWallet]);

  // Read the zkLogin session once a wallet is connected. Never on page load (G6).
  useEffect(() => {
    let cancelled = false;
    if (connectedWallet === null) {
      setZkSession(null);
      return;
    }
    void readZkLoginSession(connectedWallet).then((session) => {
      if (!cancelled) setZkSession(session);
    });
    return () => {
      cancelled = true;
    };
  }, [connectedWallet]);

  const signIn = useCallback(async () => {
    if (!configured) {
      throw new Error(
        `Enoki is not configured. ${enokiConfigProblems().join(' ')}`,
      );
    }
    if (googleWallet === null) {
      throw new Error(
        'The Enoki Google wallet is not registered. registerAphoticEnokiWallets() must run before <WalletProvider> mounts.',
      );
    }
    // dapp-kit's connect takes the wallet-standard wallet object.
    await connect({ wallet: googleWallet as never });
  }, [configured, googleWallet, connect]);

  const signOut = useCallback(() => {
    disconnect();
    setZkSession(null);
  }, [disconnect]);

  const status: SessionStatus = !configured
    ? 'unconfigured'
    : connecting
      ? 'connecting'
      : account !== null
        ? 'connected'
        : 'disconnected';

  return {
    status,
    address: account?.address ?? null,
    provider,
    isZkLogin: provider !== null,
    zkSession,
    problems,
    signIn,
    signOut,
  };
}
