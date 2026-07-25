// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T3.3, T3.4
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/APP.md §2.1 (<ZkLoginButton/>), §2.4, §7 A1
// @spec       docs/BUILD-PLAN.md Phase 3 T3.3
// @rules      G2 G6 G7
// @depends    ./enoki.ts (T3.3) · ../config.ts (T0.4)
// @facts      TWO sign-in paths, ONE session. A browser-extension wallet and an
// @facts        Enoki zkLogin wallet are BOTH wallet-standard wallets, so dapp-kit's
// @facts        own hooks drive both and this hook stays a single typed facade.
// @facts        Nothing here forks on provider except the LABEL and the zkLogin
// @facts        session read.
// @facts      Signing in with Google = connecting to the Enoki Google wallet. Enoki
// @facts        opens a popup, so signIn() MUST be called from a user gesture.
// @facts      Sponsorship is server-side (Enoki gas pool). Nothing here pays gas,
// @facts        and the SENDER is always the user's own address (G2, ERRATA E-A3).
// @facts      NETWORK GUARD: a wallet-standard account advertises `chains`, e.g.
// @facts        ['sui:testnet']. An account whose chains list is non-empty and does
// @facts        NOT contain `sui:<configured network>` is on the wrong network and
// @facts        every write must be disabled with a stated reason rather than left
// @facts        to fail confusingly in the wallet. An EMPTY chains list means the
// @facts        wallet declined to say — we do not guess, we allow and let the abort
// @facts        speak.
// @implements export type SessionStatus = 'unconfigured' | 'disconnected' | 'connecting' | 'connected'
//             export interface AphoticSession
//             export function useAphoticSession(): AphoticSession
//             export const APHOTIC_CHAIN: string
// @forbidden  '@mysten/enoki/react' — deprecated
// @forbidden  persisting a JWT / ephemeral key / salt ourselves
// @forbidden  a network literal — the expected chain is derived from config (G7)
// @invariant  1. status === 'unconfigured' ONLY when Enoki lacks its public keys
//                AND no wallet is connected — a browser-extension wallet must never
//                be masked by an Enoki misconfiguration.
//             2. signIn() throws a descriptive error instead of opening a popup
//                when Enoki is unconfigured; the UI renders `problems` instead of a
//                dead button.
//             3. A connected session grants NO capability over vault funds — exits
//                go through the Move-pinned gateway, reclaims are depositor-signed (G2).
//             4. No network call happens until signIn()/connectWallet() is invoked
//                (G6: a demo must not fire requests on page load).
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

import { config } from '../config';
import {
  enokiConfigProblems,
  findGoogleWallet,
  isEnokiBackedWallet,
  isEnokiConfigured,
  readZkLoginSession,
  walletLabel,
  walletProvider,
  type EnokiZkLoginSession,
  type WalletLike,
} from './enoki';

export type SessionStatus = 'unconfigured' | 'disconnected' | 'connecting' | 'connected';

/** Wallet-standard chain identifier for the configured network, e.g. `sui:testnet`. */
export const APHOTIC_CHAIN = `sui:${config.sui.network}`;

export interface AphoticSession {
  readonly status: SessionStatus;
  /** The user's Sui address. Derived client-side from the JWT for zkLogin. */
  readonly address: string | null;
  /** 'google' for the zkLogin wallet, null for a browser-extension wallet. */
  readonly provider: string | null;
  /** True when the connected wallet is an Enoki zkLogin wallet (not an extension). */
  readonly isZkLogin: boolean;
  /** `Google · zkLogin` / `Sui Wallet` / `Not connected`. Safe to render directly. */
  readonly providerLabel: string;
  /** The connected wallet's own name, or null. */
  readonly walletName: string | null;
  /** maxEpoch / randomness / expiry, read from the wallet. Null until connected. */
  readonly zkSession: EnokiZkLoginSession | null;

  /** Browser-extension wallets available to connect (Enoki ones are excluded). */
  readonly extensionWallets: readonly WalletLike[];
  /** True when the Enoki Google wallet is registered and connectable. */
  readonly googleAvailable: boolean;
  /** True when both public Enoki credentials are present. */
  readonly enokiReady: boolean;
  /** One line for a disabled Google button, or null when it can be clicked. */
  readonly zkLoginDisabledReason: string | null;
  /** Non-empty when Enoki is misconfigured — render these instead of a dead button. */
  readonly problems: readonly string[];

  /** e.g. `sui:testnet`. What this build expects the wallet to be on. */
  readonly expectedChain: string;
  /** Chains the connected account advertises. Empty when it did not say. */
  readonly chains: readonly string[];
  /** False only when the wallet positively advertises a different network. */
  readonly onCorrectNetwork: boolean;
  /** One line naming the network mismatch, or null. */
  readonly networkProblem: string | null;

  /** Opens the Google popup. MUST be called from a user gesture. */
  readonly signIn: () => Promise<void>;
  /** Connects a specific wallet-standard wallet (the extension path). */
  readonly connectWallet: (wallet: WalletLike) => Promise<void>;
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

  const allWallets = wallets as unknown as readonly WalletLike[];
  const googleWallet = useMemo(() => findGoogleWallet(allWallets), [allWallets]);

  // Extension wallets only. The Google/zkLogin path has its own affordance, so
  // listing it twice would make the choice less obvious, not more.
  const extensionWallets = useMemo(
    () => allWallets.filter((wallet) => !isEnokiBackedWallet(wallet)),
    [allWallets],
  );

  const connectedWallet = (currentWallet.currentWallet ?? null) as WalletLike | null;
  const provider = useMemo(() => walletProvider(connectedWallet), [connectedWallet]);
  const providerLabel = useMemo(() => walletLabel(connectedWallet), [connectedWallet]);

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
      throw new Error(`Enoki is not configured. ${enokiConfigProblems().join(' ')}`);
    }
    if (googleWallet === null) {
      throw new Error(
        'The Enoki Google wallet is not registered. registerAphoticEnokiWallets() must run before <WalletProvider> mounts.',
      );
    }
    // dapp-kit's connect takes the wallet-standard wallet object.
    await connect({ wallet: googleWallet as never });
  }, [configured, googleWallet, connect]);

  const connectWallet = useCallback(
    async (wallet: WalletLike) => {
      await connect({ wallet: wallet as never });
    },
    [connect],
  );

  const signOut = useCallback(() => {
    disconnect();
    setZkSession(null);
  }, [disconnect]);

  // Connection state wins over configuration state: an extension wallet must
  // never be hidden behind an Enoki misconfiguration (invariant 1).
  const status: SessionStatus =
    account !== null
      ? 'connected'
      : connecting
        ? 'connecting'
        : configured
          ? 'disconnected'
          : 'unconfigured';

  const chains = useMemo(
    () => ((account?.chains ?? []) as readonly string[]).slice(),
    [account],
  );
  // An empty chains list means the wallet declined to say. Do not guess.
  const onCorrectNetwork = chains.length === 0 || chains.includes(APHOTIC_CHAIN);
  const networkProblem = onCorrectNetwork
    ? null
    : `This wallet is on ${chains.join(', ')} — Aphotic runs on ${config.sui.network}. Switch networks in the wallet, then reconnect.`;

  const zkLoginDisabledReason = !configured
    ? 'Google sign-in is unavailable: this build has no Enoki credentials.'
    : googleWallet === null
      ? 'The Enoki Google wallet did not register in this browser. Reload the page.'
      : null;

  return {
    status,
    address: account?.address ?? null,
    provider,
    isZkLogin: provider !== null,
    providerLabel,
    walletName: connectedWallet?.name ?? null,
    zkSession,

    extensionWallets,
    googleAvailable: configured && googleWallet !== null,
    enokiReady: configured,
    zkLoginDisabledReason,
    problems,

    expectedChain: APHOTIC_CHAIN,
    chains,
    onCorrectNetwork,
    networkProblem,

    signIn,
    connectWallet,
    signOut,
  };
}
