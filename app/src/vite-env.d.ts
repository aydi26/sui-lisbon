/// <reference types="vite/client" />

// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       X.app
// @phase      0
// @status     DONE
// @spec       docs/DEPLOY.md "Environment variables — the thing that silently breaks"
//             (the VITE_* table, and the build-time-inlining trap)
// @rules      G7
// @depends    ../.env.example (X.app)
// @facts      Every var here MUST also exist in app/.env.example, and is read in
// @facts        EXACTLY one place: src/config.ts.
// @implements interface ImportMetaEnv
// @forbidden  reading import.meta.env anywhere except src/config.ts — G7
// @verify     cd app && npx tsc --noEmit
// └── END CONTRACT ───────────────────────────────────────────────────────────

interface ImportMetaEnv {
  // network / transport
  readonly VITE_SUI_NETWORK?: string;
  readonly VITE_SUI_GRPC_URL?: string;
  readonly VITE_SUI_JSONRPC_URL?: string;

  // aphotic
  readonly VITE_APHOTIC_PACKAGE_ID?: string;
  readonly VITE_VAULT_ID?: string;

  // hashi
  readonly VITE_HASHI_PACKAGE_ID?: string;
  readonly VITE_HASHI_OBJECT_ID?: string;
  readonly VITE_HBTC_TYPE?: string;
  readonly VITE_HASHI_WITHDRAWAL_MIN_SATS?: string;
  readonly VITE_HASHI_DEPOSIT_MIN_SATS?: string;
  readonly VITE_HASHI_DEPOSIT_DELAY_MS?: string;
  readonly VITE_HASHI_CONFIRMATIONS?: string;
  readonly VITE_HASHI_CANCEL_COOLDOWN_MS?: string;

  // deepbook
  readonly VITE_DEEPBOOK_POOL?: string;
  readonly VITE_DBUSDC_TYPE?: string;
  readonly VITE_DEEPBOOK_PACKAGE?: string;
  readonly VITE_DEEPBOOK_ORIGINAL_PACKAGE?: string;

  // pyth
  readonly VITE_PYTH_STATE?: string;
  readonly VITE_PYTH_PACKAGE?: string;
  readonly VITE_PYTH_HERMES_URL?: string;
  readonly VITE_PYTH_FEED_ID?: string;

  // walrus
  readonly VITE_WALRUS_AGGREGATOR?: string;

  // zkLogin / sponsorship
  readonly VITE_ZKLOGIN_CLIENT_ID?: string;
  readonly VITE_SPONSOR_URL?: string;

  // keeper verify/ replay
  readonly VITE_KEEPER_VERIFY_URL?: string;

  // explorers
  readonly VITE_SIGNET_EXPLORER?: string;
  readonly VITE_SUI_EXPLORER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
