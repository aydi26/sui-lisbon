// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T3.3, T3.4
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/APP.md §1 (session/)
// @rules      G7
// @depends    ./enoki.ts · ./useSession.ts · ./useBalance.ts
// @facts      THE STABLE IMPORT PATH for every other unit in the app:
// @facts        import { useAphoticSession, useHbtcBalance } from '../../session';
// @facts        import { useAphoticTx } from '../../lib/tx';
// @facts      Deep imports still work; this barrel exists so the session surface can
// @facts        be reorganised without touching a screen.
// @implements re-exports of the session + balance API
// @forbidden  adding logic here — it is a barrel
// @verify     cd app && npx tsc --noEmit
// └── END CONTRACT ───────────────────────────────────────────────────────────

export {
  enokiConfigProblems,
  findGoogleWallet,
  isEnokiBackedWallet,
  isEnokiConfigured,
  readZkLoginSession,
  registerAphoticEnokiWallets,
  unregisterAphoticEnokiWallets,
  walletLabel,
  walletProvider,
} from './enoki';
export type { EnokiZkLoginSession, WalletLike } from './enoki';

export { APHOTIC_CHAIN, useAphoticSession } from './useSession';
export type { AphoticSession, SessionStatus } from './useSession';

export { useCoinBalance, useHbtcBalance, useSuiBalance } from './useBalance';
export type { BalanceRead } from './useBalance';
