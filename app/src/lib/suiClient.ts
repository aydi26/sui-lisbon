// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.4
// @phase      0
// @status     DONE
// @spec       docs/RECON.md R1 (transport decision)
// @spec       docs/APP.md §1 (all async reads go through React Query)
// @rules      G7 G9
// @depends    ../config.ts (T0.4)
// @facts      ⚠ The testnet fullnode https://fullnode.testnet.sui.io:443 serves
// @facts        gRPC v2 ONLY — its JSON-RPC endpoint is 404/removed. (RECON R1)
// @facts      ⇒ SuiGrpcClient is the DEFAULT read transport for everything the
// @facts        app reads itself (Vault, journal blob ids, DeepBook mid).
// @facts      ⚠ @mysten/dapp-kit 1.1.9's SuiClientProvider is typed to
// @facts        SuiJsonRpcClient and CANNOT accept a gRPC client. Wallet-side
// @facts        reads therefore run over a verified JSON-RPC MIRROR
// @facts        (https://rpc-testnet.suiscan.xyz:443, chain id 4c78adac).
// @facts        Both URLs live in config.sui.* — never inline one here (G7).
// @external   new SuiGrpcClient({ network: 'testnet', baseUrl: string })
//             new SuiJsonRpcClient({ network: 'testnet', url: string })
// @implements export function getSuiClient(): SuiGrpcClient
//             export function getJsonRpcClient(): SuiJsonRpcClient
//             export function resetSuiClients(): void
// @forbidden  constructing a Sui client anywhere else in app/ — this is the ONE
//             factory (mirrors keeper/src/sui/client.ts, RECON R1)
// @forbidden  hardcoding an endpoint URL — it comes from config
// @invariant  1. Exactly one SuiGrpcClient instance per page load (memoised).
// @invariant  2. Nothing in screens/ or components/ imports @mysten/sui directly
//                for client construction.
// @ac         docs/APP.md §7 A11 — mock mode never touches either client.
// @verify     cd app && npx tsc --noEmit
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { SuiGrpcClient } from '@mysten/sui/grpc';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';

import { config } from '../config';

let grpcClient: SuiGrpcClient | null = null;
let jsonRpcClient: SuiJsonRpcClient | null = null;

/**
 * The app's DEFAULT Sui read client (gRPC v2). Use this for every read the app
 * performs on its own behalf. Memoised: one instance per page load.
 */
export function getSuiClient(): SuiGrpcClient {
  if (grpcClient === null) {
    grpcClient = new SuiGrpcClient({
      network: config.sui.network,
      baseUrl: config.sui.grpcUrl,
    });
  }
  return grpcClient;
}

/**
 * JSON-RPC client over a verified mirror. Exists ONLY because dapp-kit's
 * SuiClientProvider is typed to SuiJsonRpcClient (RECON R1). Prefer
 * `getSuiClient()` for anything the app reads itself.
 */
export function getJsonRpcClient(): SuiJsonRpcClient {
  if (jsonRpcClient === null) {
    jsonRpcClient = new SuiJsonRpcClient({
      network: config.sui.network,
      url: config.sui.jsonRpcUrl,
    });
  }
  return jsonRpcClient;
}

/** Test/demo hook — drops both memoised clients. */
export function resetSuiClients(): void {
  grpcClient = null;
  jsonRpcClient = null;
}
