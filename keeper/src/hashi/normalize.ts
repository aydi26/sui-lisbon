// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.5
// @phase      0
// @status     DONE
// @spec       docs/RECON.md#r8 (raw struct fields, verbatim from .hashi_src/*.move)
// @spec       docs/KEEPER.md §2.3 (`eventsSince` normalization), §9.2 (replay inputs)
// @rules      G5 G7
// @depends    ./types.ts · ./eventTypes.ts · ./limiter.ts (msToSecs) · ../util/bytes.ts
// @facts      Raw Move struct fields (snake_case), verbatim:
// @facts        treasury::Minted<T> / Burned<T> { amount }
// @facts        deposit::DepositRequested { request_id, utxo_id, amount, derivation_path,
// @facts                                    timestamp_ms, requester_address, sui_tx_digest }
// @facts        deposit::DepositApproved  { request_id, utxo, cert, approval_timestamp_ms }
// @facts        deposit::DepositConfirmed { request_id, utxo }
// @facts        deposit::ExpiredDepositDeleted { request_id }
// @facts        withdrawal_queue::WithdrawalRequested { request_id, btc_amount, bitcoin_address,
// @facts                                    timestamp_ms, requester_address, sui_tx_digest }
// @facts        withdrawal_queue::WithdrawalApproved { request_id }
// @facts        withdrawal_queue::WithdrawalPickedForProcessing { withdrawal_txn_id, txid,
// @facts                                    request_ids, inputs, withdrawal_outputs,
// @facts                                    change_outputs, timestamp_ms, randomness }
// @facts        withdrawal_queue::WithdrawalInputsSigned { withdrawal_txn_id, signed_count, num_inputs }
// @facts        withdrawal_queue::WithdrawalSigned { withdrawal_txn_id, request_ids,
// @facts                                    signatures, guardian_signatures }     ← NO amount, NO ts
// @facts        withdrawal_queue::WithdrawalPresigsReassigned { withdrawal_txn_id, epoch, presig_start_index }
// @facts        withdrawal_queue::WithdrawalConfirmed { withdrawal_txn_id, txid, change_utxo_ids,
// @facts                                    request_ids, change_utxo_amounts }
// @facts        withdrawal_queue::WithdrawalCancelled { request_id, requester_address, btc_amount }
// @facts      ★ THE JOIN (G5): WithdrawalSigned.sats = SUM over request_ids of
// @facts        WithdrawalRequested.btc_amount; fallback WithdrawalPickedForProcessing
// @facts        .withdrawal_outputs[i].amount. Timestamp comes from the SUI EVENT ENVELOPE.
// @facts      `vector<u8>` arrives as number[] (JSON-RPC) or a base64 string (gRPC); `u64` as a
// @facts        decimal string; `address` as `0x…`.
// @implements export interface RawSuiEvent
// @implements export interface NormalizeContext
// @implements export function createNormalizeContext(): NormalizeContext
// @implements export function normalizeEvent(cfg, raw, seq, ctx): HashiEvent | undefined
// @implements export function normalizeEvents(cfg, raws, startSeq, ctx): HashiEvent[]
// @implements export function resolveSignedSats(ctx, requestIds): { sats: Sats; satsSource: SatsSource }
// @forbidden  importing '@mysten/hashi' here — only hashi/real.ts may
// @forbidden  reading an amount out of WithdrawalSigned's own payload — it has none
// @invariant  1. Unknown/foreign event types normalize to `undefined`, never a throw.
// @invariant  2. atSecs === msToSecs(atMs) for every produced event.
// @invariant  3. The context is append-only: a later event never rewrites an earlier join.
// @verify     npm test -- hashi.mock
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { fromBase64 } from '@mysten/sui/utils';

import type { Config } from '../config.js';
import type { Millis, Sats } from '../types.js';

import { parseHashiEventKind, typeArgOf } from './eventTypes.js';
import { msToSecs } from './limiter.js';
import type { HashiEvent, SatsSource, WithdrawalOutput } from './types.js';

/**
 * Structural view of a Sui event envelope. Deliberately NOT the SDK's `SuiEvent` type:
 * gRPC and JSON-RPC shape these differently and we only need four fields.
 */
export interface RawSuiEvent {
  /** Fully-qualified Move type of the emitted struct. */
  readonly type: string;
  /** Decoded struct fields (snake_case keys). */
  readonly parsedJson: unknown;
  /** ★ The ONLY timestamp `WithdrawalSigned` has (the struct carries none). */
  readonly timestampMs?: string | number | null;
  readonly id?: { readonly txDigest?: string; readonly eventSeq?: string } | undefined;
  readonly transactionDigest?: string | undefined;
}

/**
 * Accumulated join state. Mutated as the stream is walked, in seq order.
 * Persist it alongside the event cursor so a resumed watcher can still resolve joins.
 */
export interface NormalizeContext {
  /** requestId -> btc_amount, from `WithdrawalRequested`. Primary source. */
  readonly requestedSats: Map<string, Sats>;
  /** requestId -> amount, from `WithdrawalPickedForProcessing.withdrawal_outputs`. Fallback. */
  readonly pickedSats: Map<string, Sats>;
  /** requestId -> amount, from `DepositRequested`. Used to fill DepositApproved/Confirmed. */
  readonly depositSats: Map<string, Sats>;
}

export function createNormalizeContext(): NormalizeContext {
  return { requestedSats: new Map(), pickedSats: new Map(), depositSats: new Map() };
}

/**
 * Resolve the sats a signed batch consumed from the Guardian bucket.
 *
 * G5: this number IS the bucket debit. If any request cannot be joined the result is
 * marked `'unresolved'` and the replay must be treated as incomplete at that boundary
 * rather than silently under-debiting.
 */
export function resolveSignedSats(
  ctx: NormalizeContext,
  requestIds: readonly string[],
): { sats: Sats; satsSource: SatsSource } {
  let sats = 0n;
  let usedPicked = false;
  let missing = false;

  for (const id of requestIds) {
    const requested = ctx.requestedSats.get(id);
    if (requested !== undefined) {
      sats += requested;
      continue;
    }
    const picked = ctx.pickedSats.get(id);
    if (picked !== undefined) {
      sats += picked;
      usedPicked = true;
      continue;
    }
    missing = true;
  }

  if (missing) return { sats, satsSource: 'unresolved' };
  return { sats, satsSource: usedPicked ? 'picked' : 'requested' };
}

/** Normalize one raw event. Returns `undefined` when the type is not a Hashi event of `cfg`'s package. */
export function normalizeEvent(
  cfg: Config,
  raw: RawSuiEvent,
  seq: bigint,
  ctx: NormalizeContext,
): HashiEvent | undefined {
  const kind = parseHashiEventKind(cfg, raw.type);
  if (kind === undefined) return undefined;

  const fields = asRecord(raw.parsedJson) ?? {};
  const atMs = asMillis(raw.timestampMs);
  const atSecs = msToSecs(atMs);
  const txDigest = raw.transactionDigest ?? raw.id?.txDigest;
  const base = { seq, atMs, atSecs, ...(txDigest === undefined ? {} : { txDigest }) };

  switch (kind) {
    case 'Minted':
      return { ...base, kind, coinType: typeArgOf(raw.type) ?? cfg.hashi.hbtcCoinType, sats: u64(fields['amount']) };

    case 'Burned':
      return { ...base, kind, coinType: typeArgOf(raw.type) ?? cfg.hashi.hbtcCoinType, sats: u64(fields['amount']) };

    case 'DepositRequested': {
      const requestId = addr(fields['request_id']);
      const sats = u64(fields['amount']);
      if (!ctx.depositSats.has(requestId)) ctx.depositSats.set(requestId, sats);
      const derivationPath = str(fields['derivation_path']);
      return {
        ...base,
        kind,
        requestId,
        sats,
        requesterAddress: addr(fields['requester_address']),
        ...(derivationPath === undefined ? {} : { derivationPath }),
      };
    }

    case 'DepositApproved': {
      const requestId = addr(fields['request_id']);
      return {
        ...base,
        kind,
        requestId,
        sats: utxoSats(fields['utxo']) ?? ctx.depositSats.get(requestId) ?? 0n,
        approvalTimestampMs: Number(u64(fields['approval_timestamp_ms'])),
      };
    }

    case 'DepositConfirmed': {
      const requestId = addr(fields['request_id']);
      return {
        ...base,
        kind,
        requestId,
        sats: utxoSats(fields['utxo']) ?? ctx.depositSats.get(requestId) ?? 0n,
      };
    }

    case 'ExpiredDepositDeleted':
      return { ...base, kind, requestId: addr(fields['request_id']) };

    case 'WithdrawalRequested': {
      const requestId = addr(fields['request_id']);
      const sats = u64(fields['btc_amount']);
      // ★ Primary side of the G5 join.
      if (!ctx.requestedSats.has(requestId)) ctx.requestedSats.set(requestId, sats);
      return {
        ...base,
        kind,
        requestId,
        sats,
        bitcoinAddress: bytes(fields['bitcoin_address']),
        requesterAddress: addr(fields['requester_address']),
      };
    }

    case 'WithdrawalApproved':
      return { ...base, kind, requestId: addr(fields['request_id']) };

    case 'WithdrawalPickedForProcessing': {
      const requestIds = addrList(fields['request_ids']);
      const outputs = outputList(fields['withdrawal_outputs']);
      // ★ Fallback side of the G5 join: outputs are positionally aligned with request_ids.
      requestIds.forEach((id, i) => {
        const out = outputs[i];
        if (out !== undefined && !ctx.pickedSats.has(id)) ctx.pickedSats.set(id, out.sats);
      });
      return {
        ...base,
        kind,
        withdrawalTxnId: addr(fields['withdrawal_txn_id']),
        txid: addr(fields['txid']),
        requestIds,
        outputs,
      };
    }

    case 'WithdrawalInputsSigned':
      return {
        ...base,
        kind,
        withdrawalTxnId: addr(fields['withdrawal_txn_id']),
        signedCount: u64(fields['signed_count']),
        numInputs: u64(fields['num_inputs']),
      };

    case 'WithdrawalSigned': {
      // ★★ The struct has NO amount and NO timestamp. Both are synthesised here:
      //    sats  <- join over request_ids (see resolveSignedSats)
      //    atMs  <- the Sui event envelope (base.atMs)
      const requestIds = addrList(fields['request_ids']);
      const { sats, satsSource } = resolveSignedSats(ctx, requestIds);
      const signatures = fields['signatures'];
      return {
        ...base,
        kind,
        withdrawalTxnId: addr(fields['withdrawal_txn_id']),
        requestIds,
        sats,
        satsSource,
        signatureCount: Array.isArray(signatures) ? signatures.length : 0,
      };
    }

    case 'WithdrawalPresigsReassigned':
      return {
        ...base,
        kind,
        withdrawalTxnId: addr(fields['withdrawal_txn_id']),
        epoch: u64(fields['epoch']),
        presigStartIndex: u64(fields['presig_start_index']),
      };

    case 'WithdrawalConfirmed':
      return {
        ...base,
        kind,
        withdrawalTxnId: addr(fields['withdrawal_txn_id']),
        txid: addr(fields['txid']),
        requestIds: addrList(fields['request_ids']),
      };

    case 'WithdrawalCancelled':
      return {
        ...base,
        kind,
        requestId: addr(fields['request_id']),
        requesterAddress: addr(fields['requester_address']),
        sats: u64(fields['btc_amount']),
      };

    default:
      return undefined;
  }
}

/** Normalize a page of raw events, assigning consecutive cursor seqs from `startSeq`. */
export function normalizeEvents(
  cfg: Config,
  raws: readonly RawSuiEvent[],
  startSeq: bigint,
  ctx: NormalizeContext,
): HashiEvent[] {
  const out: HashiEvent[] = [];
  let seq = startSeq;
  for (const raw of raws) {
    const event = normalizeEvent(cfg, raw, seq, ctx);
    if (event === undefined) continue;
    out.push(event);
    seq += 1n;
  }
  return out;
}

// ── decoding helpers ─────────────────────────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function asMillis(v: string | number | null | undefined): Millis {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  return 0;
}

/** Move `u64` — always a decimal string over the wire, but tolerate number/bigint. */
function u64(v: unknown): Sats {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  return 0n;
}

/** Move `address` / `ID`. */
function addr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  // `Option<address>` decodes to `{ fields: { vec: [...] } }` or a bare value/null.
  const rec = asRecord(v);
  const some = rec?.['some'] ?? rec?.['vec'];
  if (typeof some === 'string') return some;
  if (Array.isArray(some) && typeof some[0] === 'string') return some[0];
  return undefined;
}

function addrList(v: unknown): readonly string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** Move `vector<u8>`: number[] (JSON-RPC), `0x…` hex, or base64 (gRPC). */
function bytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return Uint8Array.from(v.map((x) => (typeof x === 'number' ? x & 0xff : 0)));
  if (typeof v === 'string') {
    if (v.startsWith('0x')) {
      const hex = v.slice(2);
      const out = new Uint8Array(Math.floor(hex.length / 2));
      for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      return out;
    }
    try {
      return fromBase64(v);
    } catch {
      return new Uint8Array(0);
    }
  }
  return new Uint8Array(0);
}

/** `Utxo` shape varies by transport; the amount field is what we need. */
function utxoSats(v: unknown): Sats | undefined {
  const rec = asRecord(v);
  if (rec === undefined) return undefined;
  const inner = asRecord(rec['fields']) ?? rec;
  const raw = inner['amount'] ?? inner['value'] ?? inner['sats'];
  if (raw === undefined || raw === null) return undefined;
  return u64(raw);
}

function outputList(v: unknown): readonly WithdrawalOutput[] {
  if (!Array.isArray(v)) return [];
  const out: WithdrawalOutput[] = [];
  for (const item of v) {
    const rec = asRecord(item);
    if (rec === undefined) continue;
    const inner = asRecord(rec['fields']) ?? rec;
    out.push({ sats: u64(inner['amount']), bitcoinAddress: bytes(inner['bitcoin_address']) });
  }
  return out;
}
