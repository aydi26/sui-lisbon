// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.3
// @phase      0
// @status     DONE
// @spec       docs/RECON.md#r1 (RPC transport — VERIFIED LIVE 2026-07-25)
// @spec       docs/KEEPER.md §1.1 (dependencies), §10 (startup sequence)
// @rules      G7
// @depends    ../config.ts (T0.6) · @mysten/sui@2.22.1
// @facts      ★ `https://fullnode.testnet.sui.io:443` serves gRPC v2 ONLY.
// @facts        Its JSON-RPC endpoint returns 404 — REMOVED. Never point SuiJsonRpcClient at it.
// @facts      DEFAULT transport = SuiGrpcClient from '@mysten/sui/grpc'.
// @facts      JSON-RPC is OPT-IN (`SUI_TRANSPORT=jsonRpc`) for probes/cross-checks, against the
// @facts        verified mirrors (chain id 4c78adac): rpc-testnet.suiscan.xyz ·
// @facts        sui-testnet-rpc.publicnode.com · sui-testnet.nodeinfra.com.
// @facts        `sui-testnet.public.blastapi.io` is DEAD (403). `suix_getNormalizedMoveModulesByPackage`
// @facts        is unsupported on every mirror.
// @external   new SuiGrpcClient({ network, baseUrl })   // @mysten/sui/grpc — VERIFIED from node_modules:
//               SuiGrpcClientOptions = { network: Network; mvr?: MvrOptions }
//                                    & ({ transport: RpcTransport } | GrpcWebOptions)
//               GrpcWebOptions requires `baseUrl: string`.
//             new SuiJsonRpcClient({ network, url })    // @mysten/sui/jsonRpc — VERIFIED:
//               SuiJsonRpcClientOptions = { network } & ({ url } | { transport })
//               ⚠ the whole JSON-RPC client is marked @deprecated upstream.
// @implements export type AnySuiClient = SuiGrpcClient | SuiJsonRpcClient
// @implements export function createSuiClient(cfg: Config): AnySuiClient
// @implements export function createGrpcClient(cfg: Config, baseUrl?: string): SuiGrpcClient
// @implements export function createJsonRpcClient(cfg: Config, url?: string): SuiJsonRpcClient
// @implements export function jsonRpcMirrorClients(cfg: Config): SuiJsonRpcClient[]
// @implements export function isGrpc(client: AnySuiClient): client is SuiGrpcClient
// @forbidden  constructing a Sui client ANYWHERE else in keeper/src — this is the single site
// @forbidden  a hardcoded RPC URL outside config.ts
// @invariant  1. createSuiClient honours cfg.sui.transport and nothing else.
// @invariant  2. No network call happens at construction time (clients are lazy).
// @verify     npm run typecheck
// @verify     npm test -- config
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { SuiGrpcClient, isSuiGrpcClient } from '@mysten/sui/grpc';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';

import type { Config } from '../config.js';

export type AnySuiClient = SuiGrpcClient | SuiJsonRpcClient;

/**
 * THE default transport: gRPC v2. Constructing this performs no I/O.
 *
 * `baseUrl` overrides `cfg.sui.grpcUrl` for one-off probes; production code passes only `cfg`.
 */
export function createGrpcClient(cfg: Config, baseUrl: string = cfg.sui.grpcUrl): SuiGrpcClient {
  return new SuiGrpcClient({ network: cfg.sui.network, baseUrl });
}

/**
 * OPT-IN JSON-RPC client, for probes and cross-checks only.
 *
 * ⚠ Do NOT pass `https://fullnode.testnet.sui.io:443` here — that host removed JSON-RPC (404).
 * Use `cfg.sui.jsonRpcUrl` (a verified mirror) or one of `cfg.sui.jsonRpcMirrors`.
 */
export function createJsonRpcClient(cfg: Config, url: string = cfg.sui.jsonRpcUrl): SuiJsonRpcClient {
  return new SuiJsonRpcClient({ network: cfg.sui.network, url });
}

/** One client per verified JSON-RPC mirror — for quorum/cross-check probes (docs/DAY-ONE.md). */
export function jsonRpcMirrorClients(cfg: Config): SuiJsonRpcClient[] {
  return cfg.sui.jsonRpcMirrors.map((url) => createJsonRpcClient(cfg, url));
}

/**
 * The ONE place a Sui client is constructed (G7). Every module takes the client as a
 * dependency; nothing else calls a client constructor.
 */
export function createSuiClient(cfg: Config): AnySuiClient {
  return cfg.sui.transport === 'jsonRpc' ? createJsonRpcClient(cfg) : createGrpcClient(cfg);
}

export function isGrpc(client: AnySuiClient): client is SuiGrpcClient {
  return isSuiGrpcClient(client);
}

export type { SuiGrpcClient, SuiJsonRpcClient };
