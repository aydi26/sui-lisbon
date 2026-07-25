// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T3.2
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/APP.md §3.4 (Exit state) · §5 (live vs pre-staged boundary)
// @spec       docs/RECON.md R8 (Hashi event names) · R14.2 (txid byte order)
// @spec       move/sources/gateway.move events (T1.3/T1.4, DONE)
// @rules      G1 G2 G3 G6 G7 G10
// @depends    ../../lib/suiClient.ts (T0.4) · ./ptb.ts (T3.2) · ./model.ts (T3.2)
// @facts      This screen's history is READ FROM CHAIN, not from a fixture. The join:
// @facts        1. aphotic::gateway::ExitRequested { vault_id, who, amount_sats, addr_len }
// @facts           — our own receipt, emitted BEFORE the bridge call in the same PTB
// @facts             (gateway.move @invariant 8), so it always exists when the exit landed.
// @facts        2. the SAME transaction's hashi::withdrawal_queue::WithdrawalRequested
// @facts           { request_id, btc_amount, bitcoin_address, timestamp_ms, ... }
// @facts           — supplies the bridge request_id that reclaim needs.
// @facts        3. withdrawal_queue::WithdrawalPickedForProcessing { request_ids, ... }
// @facts           — past this point cancel_withdrawal aborts ECannotCancelProcessingWithdrawal.
// @facts        4. withdrawal_queue::WithdrawalConfirmed { txid, request_ids, ... }
// @facts           — the signet txid. ⚠ R14.2: the on-chain txid is Bitcoin's INTERNAL
// @facts             byte order; every explorer shows the REVERSE. We reverse it here so
// @facts             there is exactly one place this can be wrong.
// @facts        5. withdrawal_queue::WithdrawalCancelled { request_id, ... } — already reclaimed.
// @facts      ⚠ Transport: queryEvents is JSON-RPC-only in @mysten/sui 2.22.1, and the
// @facts        testnet fullnode serves gRPC v2 ONLY (RECON R1). Event reads therefore go
// @facts        through the verified JSON-RPC MIRROR via lib/suiClient.ts — the same
// @facts        exception dapp-kit already runs on. No client is constructed here (G7).
// @external   client.queryEvents({ query: { MoveEventType } | { Transaction }, limit, order })
//               → { data: [{ id: { txDigest }, type, parsedJson, timestampMs, sender }] }
// @implements export type ExitHistory
//             export function displayTxid(internal: unknown): string | null
//             export async function readExitHistory(who: string): Promise<ExitHistory>
// @forbidden  synthesising a digest or a signet txid — a dead explorer link is worse
//             than an honest "nothing on chain yet" (G6)
// @forbidden  a canonical on-chain id literal — every id comes from config (G7)
// @forbidden  any field expressing queue POSITION or purchasable priority (G3)
// @forbidden  throwing at the caller — every failure becomes a rendered state
// @invariant  1. A record only ever carries a digest/txid that was actually observed.
// @invariant  2. Records are returned newest-first.
// @invariant  3. Reads only. No transaction is ever executed here.
// @invariant  4. `bridgeRequestId` is null unless the bridge's own
//                WithdrawalRequested event supplied it. It is NEVER back-filled
//                with the Sui digest: reclaim_stalled_exit takes an `address`, a
//                digest is base58, and the PTB builder would throw on it.
// @ac         docs/APP.md §7 A5 A6
// @verify     cd app && npx tsc --noEmit
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { config } from '../../config';
import { getJsonRpcClient } from '../../lib/suiClient';
import type { ExitRecord } from './model';
import { missingTargets, moveTargets } from './ptb';

export type ExitHistory =
  | { readonly status: 'unconfigured'; readonly missing: readonly string[] }
  | { readonly status: 'ok'; readonly records: readonly ExitRecord[] }
  | { readonly status: 'unavailable'; readonly reason: string };

const WITHDRAWAL_MODULE = 'withdrawal_queue';
/** How far back we look. A demo vault has a handful of exits, not thousands. */
const PAGE = 50;

interface RawEvent {
  readonly id: { readonly txDigest: string };
  readonly type: string;
  readonly parsedJson?: unknown;
  readonly timestampMs?: string | null;
  readonly sender?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function readString(source: Record<string, unknown> | null, key: string): string | null {
  const v = source?.[key];
  return typeof v === 'string' ? v : null;
}

function readBigint(source: Record<string, unknown> | null, key: string): bigint | null {
  const v = source?.[key];
  if (typeof v === 'string') {
    try {
      return BigInt(v);
    } catch {
      return null;
    }
  }
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
  return null;
}

function readIdList(source: Record<string, unknown> | null, key: string): string[] {
  const v = source?.[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * ⚠ RECON R14.2 — Hashi stores a Bitcoin txid in INTERNAL byte order; every
 * explorer displays the reverse. `vector<u8>` arrives from JSON-RPC as a number
 * array (and, defensively, sometimes as a hex string).
 */
export function displayTxid(internal: unknown): string | null {
  let bytes: number[] | null = null;

  if (Array.isArray(internal) && internal.every((b) => typeof b === 'number')) {
    bytes = internal as number[];
  } else if (typeof internal === 'string') {
    const clean = internal.trim().replace(/^0x/i, '');
    if (/^[0-9a-f]+$/i.test(clean) && clean.length % 2 === 0) {
      bytes = [];
      for (let i = 0; i < clean.length; i += 2) bytes.push(Number.parseInt(clean.slice(i, i + 2), 16));
    }
  }

  if (bytes === null || bytes.length !== 32) return null;
  return bytes
    .slice()
    .reverse()
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function byType(type: string): Promise<RawEvent[]> {
  const page = await getJsonRpcClient().queryEvents({
    query: { MoveEventType: type },
    limit: PAGE,
    order: 'descending',
  });
  return page.data as unknown as RawEvent[];
}

async function byTransaction(digest: string): Promise<RawEvent[]> {
  const page = await getJsonRpcClient().queryEvents({
    query: { Transaction: digest },
    limit: PAGE,
    order: 'ascending',
  });
  return page.data as unknown as RawEvent[];
}

/**
 * Every exit this address has ever made, reconstructed from the on-chain event
 * stream. Never throws: each failure mode is a rendered state.
 */
export async function readExitHistory(who: string): Promise<ExitHistory> {
  const missing = missingTargets();
  if (missing.length > 0) return { status: 'unconfigured', missing };

  const t = moveTargets();
  const hashiPkg = config.hashi.packageId;
  const requestedType = `${t.packageId}::gateway::ExitRequested`;

  try {
    const ours = (await byType(requestedType)).filter((e) => {
      const json = asRecord(e.parsedJson);
      return readString(json, 'who') === who;
    });

    if (ours.length === 0) return { status: 'ok', records: [] };

    // Bridge-side status, read once and joined by request_id.
    const [picked, confirmed, cancelled] = await Promise.all([
      byType(`${hashiPkg}::${WITHDRAWAL_MODULE}::WithdrawalPickedForProcessing`),
      byType(`${hashiPkg}::${WITHDRAWAL_MODULE}::WithdrawalConfirmed`),
      byType(`${hashiPkg}::${WITHDRAWAL_MODULE}::WithdrawalCancelled`),
    ]);

    const pickedIds = new Set<string>();
    for (const e of picked) for (const id of readIdList(asRecord(e.parsedJson), 'request_ids')) pickedIds.add(id);

    const confirmedTxid = new Map<string, string>();
    for (const e of confirmed) {
      const json = asRecord(e.parsedJson);
      const txid = displayTxid(json?.['txid']);
      for (const id of readIdList(json, 'request_ids')) {
        if (txid !== null) confirmedTxid.set(id, txid);
      }
    }

    const cancelledIds = new Set<string>();
    for (const e of cancelled) {
      const id = readString(asRecord(e.parsedJson), 'request_id');
      if (id !== null) cancelledIds.add(id);
    }

    // The bridge request_id lives in the SAME transaction as our own receipt.
    const records: ExitRecord[] = [];
    for (const receipt of ours) {
      const json = asRecord(receipt.parsedJson);
      const amountSats = readBigint(json, 'amount_sats') ?? 0n;
      const digest = receipt.id.txDigest;

      let requestId: string | null = null;
      try {
        const siblings = await byTransaction(digest);
        for (const sibling of siblings) {
          if (!sibling.type.startsWith(`${hashiPkg}::${WITHDRAWAL_MODULE}::WithdrawalRequested`)) continue;
          requestId = readString(asRecord(sibling.parsedJson), 'request_id');
          if (requestId !== null) break;
        }
      } catch {
        // The bridge leg is unreadable but our own receipt is real. Keep the
        // record and let the UI say the request_id could not be resolved.
        requestId = null;
      }

      if (requestId !== null && cancelledIds.has(requestId)) continue;

      const txid = requestId === null ? null : (confirmedTxid.get(requestId) ?? null);
      const isPicked = requestId !== null && pickedIds.has(requestId);

      records.push({
        requestId: requestId ?? digest,
        // ⚠ NEVER fall back to the digest here. `reclaim_stalled_exit` takes an
        // `address`, and a Sui digest is base58 — passing one would throw while
        // building the PTB. Null means "no reclaim can be offered for this row",
        // which is what the timeline renders.
        bridgeRequestId: requestId,
        amountSats,
        phase: txid !== null ? 'done' : isPicked ? 'B' : 'A',
        burnDigest: digest,
        signetTxid: txid,
        requestedAtMs: Number(receipt.timestampMs ?? '0'),
        picked: isPicked,
        simulated: false,
      });
    }

    records.sort((a, b) => b.requestedAtMs - a.requestedAtMs);
    return { status: 'ok', records };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      status: 'unavailable',
      reason: `Could not read the exit event stream (${reason}). Nothing is wrong with your funds — this is a read path only.`,
    };
  }
}
