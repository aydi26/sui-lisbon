// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T3.3
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/APP.md §1 (session/), §2.1 (<ZkLoginButton/>), §2.4, §7 A1
// @spec       docs/BUILD-PLAN.md Phase 3 T3.3
// @spec       docs/FACTS.md#seal-walrus-zklogin
// @rules      G2 G7
// @depends    ../config.ts (T0.4) · ../lib/suiClient.ts (T0.4)
// @facts      Onboarding is Enoki-backed zkLogin, registered as a WALLET-STANDARD
// @facts        wallet. `registerEnokiWallets()` is the supported API in
// @facts        @mysten/enoki 1.2.7; EVERY React hook exported from
// @facts        '@mysten/enoki/react' (EnokiFlowProvider, useEnokiFlow, useZkLogin,
// @facts        useZkLoginSession, useAuthCallback) is marked @deprecated in the
// @facts        shipped .d.mts. We therefore use registerEnokiWallets + dapp-kit's
// @facts        own wallet hooks. Do NOT reintroduce EnokiFlow.
// @facts      Registration MUST happen BEFORE <WalletProvider> mounts, otherwise
// @facts        dapp-kit's autoConnect races the wallet-standard registry and the
// @facts        Google wallet is missing on first paint.
// @facts      Gas sponsorship is NOT app code: an Enoki app configured with a gas
// @facts        pool sponsors its wallets' transactions server-side. That is why
// @facts        VITE_SPONSOR_URL is optional — sponsorship changes who PAYS, never
// @facts        who the SENDER is.
// @facts      AuthProvider ∈ 'google' | 'facebook' | 'twitch' | 'onefc' | 'playtron'
// @facts      EnokiNetwork  ∈ 'mainnet' | 'testnet' | 'devnet'
// @facts      ⚠ The Enoki PRIVATE key and the Google OAuth client SECRET must never
// @facts        reach the browser, a .env.example, a doc, or a commit. Only the
// @facts        PUBLIC api key and the PUBLIC client id appear here.
// @external   registerEnokiWallets({ apiKey, client, network, providers }):
//               { wallets: Partial<Record<AuthProvider, EnokiWallet>>, unregister: () => void }
//             getSession(wallet, { network? }): Promise<ZkLoginSession | null>
//             getWalletMetadata(wallet): { provider: AuthProvider } | null
//             isEnokiWallet(wallet) / isGoogleWallet(wallet): boolean
// @implements export function isEnokiConfigured(): boolean
//             export function enokiConfigProblems(): string[]
//             export function registerAphoticEnokiWallets(): () => void
//             export function unregisterAphoticEnokiWallets(): void
//             export function findGoogleWallet(wallets): WalletLike | null
//             export function readZkLoginSession(wallet): Promise<ZkLoginSession | null>
//             export function walletProvider(wallet): string | null
// @forbidden  '@mysten/enoki/react' — every export there is deprecated
// @forbidden  constructing a Sui client here — use ../lib/suiClient.ts (one factory)
// @forbidden  a canonical id or endpoint literal here — G7
// @forbidden  storing a JWT, an ephemeral key or a salt in localStorage ourselves;
//             the Enoki wallet owns that lifecycle
// @invariant  1. registerAphoticEnokiWallets() is idempotent — calling it twice
//                returns the SAME unregister fn and never double-registers.
//             2. It is a no-op (not a throw) when Enoki is unconfigured, so the
//                app still builds and renders with an empty .env.
//             3. A zkLogin session grants NO capability over vault funds — exits
//                still go through the Move-pinned gateway (G2).
// @ac         docs/APP.md §7 A1 — login yields a Sui address; derivation is client-side.
// @verify     cd app && npx tsc --noEmit
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

import {
  getSession,
  getWalletMetadata,
  isGoogleWallet,
  registerEnokiWallets,
} from '@mysten/enoki';

import { config } from '../config';
import { getSuiClient } from '../lib/suiClient';

/**
 * The structural slice of a wallet-standard wallet we actually need. dapp-kit
 * and @wallet-standard/ui hand back several nominally-different wallet shapes;
 * Enoki's own helpers accept them all, so we keep the surface minimal rather
 * than importing a concrete class we would then have to cast.
 */
export interface WalletLike {
  readonly name: string;
  readonly icon?: string;
  readonly accounts?: readonly { readonly address: string }[];
}

/** Shape returned by Enoki's `enoki:getSession` wallet feature. */
export interface EnokiZkLoginSession {
  readonly maxEpoch: number;
  readonly randomness: string;
  readonly expiresAt: number;
  readonly jwt?: string;
}

let unregister: (() => void) | null = null;

/** True when both public Enoki credentials are present. */
export function isEnokiConfigured(): boolean {
  return (
    config.zkLogin.enokiApiKey.length > 0 && config.zkLogin.googleClientId.length > 0
  );
}

/**
 * Human-readable reasons Enoki cannot start. Empty array ⇒ good to go.
 * The deposit screen renders these instead of a dead "Sign in" button, so a
 * misconfiguration is visible rather than silent.
 */
export function enokiConfigProblems(): string[] {
  const problems: string[] = [];
  if (config.zkLogin.enokiApiKey.length === 0) {
    problems.push('VITE_ENOKI_API_KEY is empty — create an app at portal.enoki.mystenlabs.com and copy its PUBLIC key.');
  }
  if (config.zkLogin.googleClientId.length === 0) {
    problems.push('VITE_ZKLOGIN_CLIENT_ID is empty — create a Google OAuth 2.0 Web client id and register it in the Enoki portal.');
  }
  if (config.zkLogin.enokiApiKey.startsWith('enoki_private_')) {
    problems.push('VITE_ENOKI_API_KEY looks like a PRIVATE key. Never ship the private key to the browser — use the public one.');
  }
  return problems;
}

/**
 * Registers the Enoki zkLogin wallets with the wallet-standard registry.
 *
 * MUST run before `<WalletProvider>` mounts (see main.tsx). Idempotent, and a
 * no-op when Enoki is unconfigured so `npm run build` and mock-mode demos work
 * with an empty .env.
 *
 * @returns an `unregister` function (a no-op when nothing was registered).
 */
export function registerAphoticEnokiWallets(): () => void {
  if (unregister !== null) return unregister;
  if (!isEnokiConfigured()) return () => {};

  const network = config.sui.network === 'mainnet' ? 'mainnet' : 'testnet';

  const registration = registerEnokiWallets({
    apiKey: config.zkLogin.enokiApiKey,
    client: getSuiClient(),
    network,
    providers: {
      google: {
        clientId: config.zkLogin.googleClientId,
        // Empty ⇒ let Enoki default to window.location.origin.
        ...(config.zkLogin.redirectUrl.length > 0
          ? { redirectUrl: config.zkLogin.redirectUrl }
          : {}),
      },
    },
  });

  unregister = registration.unregister;
  return unregister;
}

/** Drops the registration. Exposed for tests and hot-reload cleanliness. */
export function unregisterAphoticEnokiWallets(): void {
  if (unregister !== null) {
    unregister();
    unregister = null;
  }
}

/** Finds the Google-backed Enoki wallet in a dapp-kit wallet list. */
export function findGoogleWallet<T extends WalletLike>(wallets: readonly T[]): T | null {
  for (const wallet of wallets) {
    // Enoki's guard accepts both Wallet and UiWallet shapes.
    if (isGoogleWallet(wallet as never)) return wallet;
  }
  return null;
}

/** `'google' | 'facebook' | …` for an Enoki wallet, else null. */
export function walletProvider(wallet: WalletLike | null): string | null {
  if (wallet === null) return null;
  const metadata = getWalletMetadata(wallet as never);
  return metadata === null ? null : metadata.provider;
}

/**
 * Reads the live zkLogin session (maxEpoch, randomness, expiry) from the wallet.
 * Returns null for a non-Enoki wallet or when there is no active session.
 */
export async function readZkLoginSession(
  wallet: WalletLike | null,
): Promise<EnokiZkLoginSession | null> {
  if (wallet === null) return null;
  try {
    const session = await getSession(wallet as never);
    return (session as EnokiZkLoginSession | null) ?? null;
  } catch {
    // A non-Enoki wallet has no such feature. Not an error condition.
    return null;
  }
}
