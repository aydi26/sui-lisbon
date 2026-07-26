// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       B8.batch.reveal
// @phase      2
// @status     DONE
// @spec       move/sources/batch.move — `public fun new_order(submitter, is_bid, limit_price,
//             qty_sats, salt): Order` · `public fun reveal_order(b: &mut Batch, index: u64,
//             order: Order, clock: &Clock)`
// @spec       docs/DESIGN-V2.md §3 (the commitment binds the PLAINTEXT; reveal is permissionless)
// @spec       docs/DESIGN-V2.md §2 (the measured ceilings) · aphotic.md §9 (liveness, not privilege)
// @rules      G5 G7 G8 G10
// @depends    ./read.ts · ./order.ts · ../privacy/seal.ts · ../privacy/session.ts ·
//             ../storage/walrus.ts · ../clearing/bytes.ts · ../sui/send.ts · ../vault/context.ts
// @facts      ★★ THERE IS NO `batch::reveal_many`. The build brief named one; the shipped module
// @facts        has `reveal_order(b, index, order, clock)`, one order at a time, and `Order` is a
// @facts        struct that only `new_order` can mint. Batching therefore happens in the PTB:
// @facts        N × (`new_order` → `reveal_order`) in one transaction, which is the same thing
// @facts        through the door that exists. Chunking is unchanged; only the shape is.
// @facts      ★★ EVERY COMMITMENT IS CHECKED LOCALLY BEFORE ANYTHING IS SUBMITTED. `reveal_order`
// @facts        asserts `order_commitment(&order) == sealed.commitment` and
// @facts        `order.submitter == sealed.submitter`. Checking both here means one bad ciphertext
// @facts        costs a skipped index, not a reverted transaction that takes every GOOD reveal in
// @facts        the same PTB down with it. That is the whole reason this runs before the send.
// @facts      ★ THE CIPHERTEXT IS CHECKED TOO, against `ct_hash`, before it is handed to Seal. A
// @facts        substituted blob then fails at the hash instead of somewhere inside the SDK.
// @facts      ★ REVEAL IS PERMISSIONLESS AND THAT IS THE ANTI-GRIEF PROPERTY. After `close_ms`
// @facts        anyone who can fetch the Seal shares can produce the reveal, which is why binding
// @facts        the commitment to the plaintext does not reintroduce commit–reveal's grief problem.
// @facts      ★ CHUNK DERIVATION, stated rather than guessed. Pure bytes per revealed order:
// @facts          address 32 ‖ bool 1 ‖ u64 8 ‖ u64 8 ‖ vector<u8> salt (1 ULEB + 32) ‖ u64 index 8
// @facts          = 90 bytes.  floor(16384 / 90) = 182  ⇒ MAX_REVEALS_PER_TX.
// @facts        The brief's "roughly 220" assumed a smaller per-order encoding; 182 is what THIS
// @facts        encoding costs, and it is the number the code uses. `--chunk` may only lower it.
// @facts      ⚠ WALRUS BLOB IDS. `blob_id` is `vector<u8>` on chain. 32 bytes ⇒ a raw id, rendered
// @facts        base64url (unpadded) for the aggregator; anything else ⇒ already-encoded ASCII.
// @facts        The heuristic is stated because getting it wrong fails as a 404, not as an error
// @facts        that names the cause.
// @facts      ⚠ THE REVEAL WINDOW IS `now <= closed_at_ms + reveal_grace_ms`. Past it, `reveal_order`
// @facts        aborts ERevealWindowClosed and the batch clears on whatever was revealed — checked
// @facts        locally so a late run says so instead of buying an abort.
// @implements export const REVEAL_PURE_BYTES_PER_ORDER / MAX_PURE_ARGUMENT_BYTES / MAX_REVEALS_PER_TX
// @implements export interface RevealDeps / RevealOptions / RevealReport / RevealOutcome
// @implements export function walrusBlobId(raw: Uint8Array): string
// @implements export function verifyCiphertext(row, ciphertext): void
// @implements export function verifyPlaintext(row, plaintext): RevealOutcome
// @implements export function buildRevealTx(d, batchObjectId, entries): Transaction
// @implements export async function runReveal(deps, d, opts): Promise<RevealReport>
// @forbidden  submitting a reveal whose commitment was not checked locally first
// @forbidden  a plaintext order in a log, a journal, or an error message
// @forbidden  falling back to plaintext when Seal declines (G8)
// @invariant  1. No index reaches a PTB unless its ct hash, its submitter and its commitment
//                all matched locally.
// @invariant  2. Already-revealed indices are skipped (reveal_order aborts EAlreadyRevealed).
// @invariant  3. A rejected order is REPORTED with its reason; it is never silently dropped.
// @invariant  4. Chunk size never exceeds MAX_REVEALS_PER_TX.
// @ac         test/reveal.test.ts — commitment mismatch, ct-hash mismatch, chunking, PTB shape
// @verify     npm run test -- reveal
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { Signer } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';

import { blake2b256 } from '../clearing/bytes.js';
import type { Config } from '../config.js';
import { decryptPayload, type SealDeps } from '../privacy/seal.js';
import { assertUsable, type SealSession } from '../privacy/session.js';
import { STATE_SEALED } from '../schedule/index.js';
import { get as walrusGet } from '../storage/walrus.js';
import { sendChecked } from '../sui/send.js';
import type { Millis, ObjectId } from '../types.js';
import { bytesEqual, bytesToHex } from '../util/bytes.js';
import { AphoticError } from '../util/errors.js';
import type { ChainDeps, Deployment } from '../vault/context.js';

import { decodeOrder, orderCommitment, type PlainOrder } from './order.js';
import { readBatch, readSealedOrders, type BatchState_, type SealedOrderRow } from './read.js';

/** address 32 ‖ bool 1 ‖ u64 8 ‖ u64 8 ‖ (ULEB 1 + salt 32) ‖ u64 index 8. */
export const REVEAL_PURE_BYTES_PER_ORDER = 90;
/** Sui protocol `max_pure_argument_size`. */
export const MAX_PURE_ARGUMENT_BYTES = 16_384;
/** floor(16384 / 90). See the @facts note on why this is 182 and not the brief's ~220. */
export const MAX_REVEALS_PER_TX = Math.floor(MAX_PURE_ARGUMENT_BYTES / REVEAL_PURE_BYTES_PER_ORDER);

/** Walrus read port. Structurally satisfied by `storage/walrus.ts::get`. */
export interface BlobReader {
  (cfg: Config, blobId: string): Promise<Uint8Array>;
}

export interface RevealDeps extends ChainDeps {
  /** Seal port. Absent ⇒ every decrypt fails loudly — never a silent plaintext path (G8). */
  readonly seal: SealDeps;
  readonly readBlob?: BlobReader;
}

export interface RevealOptions {
  readonly signer: Signer;
  readonly batchObjectId: ObjectId;
  readonly session: SealSession;
  /** Injected clock (ms epoch) — the window check must be replayable. */
  readonly nowMs: Millis;
  readonly chunkSize?: number;
  readonly dryRun?: boolean;
}

export type RevealOutcome =
  | { readonly index: number; readonly ok: true; readonly order: PlainOrder }
  | { readonly index: number; readonly ok: false; readonly reason: string };

export interface RevealReport {
  readonly batch: BatchState_;
  readonly considered: number;
  readonly alreadyRevealed: number;
  readonly accepted: readonly number[];
  readonly rejected: readonly { readonly index: number; readonly reason: string }[];
  readonly digests: readonly string[];
  readonly broadcast: boolean;
}

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** 32 raw bytes ⇒ unpadded base64url. Anything else ⇒ the bytes already ARE the ascii id. */
export function walrusBlobId(raw: Uint8Array): string {
  if (raw.length !== 32) return new TextDecoder().decode(raw);
  let out = '';
  for (let i = 0; i < raw.length; i += 3) {
    const b0 = raw[i] as number;
    const b1 = raw[i + 1];
    const b2 = raw[i + 2];
    out += B64URL[b0 >> 2] as string;
    out += B64URL[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)] as string;
    if (b1 === undefined) break;
    out += B64URL[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)] as string;
    if (b2 === undefined) break;
    out += B64URL[b2 & 0x3f] as string;
  }
  return out;
}

/** `ct_hash` binds the ciphertext. A substituted blob fails HERE, not inside the Seal SDK. */
export function verifyCiphertext(row: SealedOrderRow, ciphertext: Uint8Array): void {
  const got = blake2b256(ciphertext);
  if (!bytesEqual(got, row.ctHash)) {
    throw new AphoticError(
      'CtHashMismatch',
      `order ${row.index}: fetched ciphertext hashes to 0x${bytesToHex(got)} but the batch records ` +
        `0x${bytesToHex(row.ctHash)} — the blob is not the one that was committed`,
    );
  }
}

/**
 * The two assertions `reveal_order` makes, run locally (invariant 1).
 *
 * ⚠ No order field is ever put into the reason string. A rejection message that quoted a price
 * or a size would publish, in a log, the one thing the whole batch design encrypts.
 */
export function verifyPlaintext(row: SealedOrderRow, plaintext: Uint8Array): RevealOutcome {
  let order: PlainOrder;
  try {
    order = decodeOrder(plaintext);
  } catch (err) {
    return {
      index: row.index,
      ok: false,
      reason: `undecodable order frame — ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (order.submitter.toLowerCase() !== row.submitter.toLowerCase()) {
    return {
      index: row.index,
      ok: false,
      reason: 'submitter does not match the sealed order (reveal_order aborts ESubmitterMismatch)',
    };
  }

  const commitment = orderCommitment(order);
  if (!bytesEqual(commitment, row.commitment)) {
    return {
      index: row.index,
      ok: false,
      reason:
        `commitment 0x${bytesToHex(commitment)} does not match the on-chain ` +
        `0x${bytesToHex(row.commitment)} (reveal_order aborts ECommitmentMismatch)`,
    };
  }

  return { index: row.index, ok: true, order };
}

/** N × (`new_order` → `reveal_order`) in one transaction. No capability, no address parameter. */
export function buildRevealTx(
  d: Deployment,
  batchObjectId: ObjectId,
  entries: readonly { readonly index: number; readonly order: PlainOrder }[],
): Transaction {
  if (entries.length > MAX_REVEALS_PER_TX) {
    // Invariant 4 — the pure-argument ceiling is not negotiable at runtime.
    throw new AphoticError(
      'ChunkTooLarge',
      `${entries.length} reveals exceeds MAX_REVEALS_PER_TX (${MAX_REVEALS_PER_TX})`,
    );
  }
  const tx = new Transaction();
  for (const entry of entries) {
    const order = tx.moveCall({
      target: `${d.packageId}::batch::new_order`,
      arguments: [
        tx.pure.address(entry.order.submitter),
        tx.pure.bool(entry.order.isBid),
        tx.pure.u64(entry.order.limitPrice),
        tx.pure.u64(entry.order.qtySats),
        tx.pure.vector('u8', Array.from(entry.order.salt)),
      ],
    });
    tx.moveCall({
      target: `${d.packageId}::batch::reveal_order`,
      arguments: [tx.object(batchObjectId), tx.pure.u64(entry.index), order, tx.object.clock()],
    });
  }
  return tx;
}

export async function runReveal(
  deps: RevealDeps,
  d: Deployment,
  opts: RevealOptions,
): Promise<RevealReport> {
  const batch = await readBatch(deps, d, opts.batchObjectId);

  if (batch.state !== STATE_SEALED) {
    throw new AphoticError(
      'EBadState',
      `batch ${batch.batchId} is in state ${batch.state}, not SEALED — reveal_order aborts ` +
        'EBadState outside the sealed window. Close it first, or it has already moved on.',
    );
  }

  const now = BigInt(opts.nowMs);
  const graceEnds = batch.closedAtMs + batch.revealGraceMs;
  if (now > graceEnds) {
    throw new AphoticError(
      'ERevealWindowClosed',
      `the reveal grace ended at ${graceEnds} and the local clock says ${now}. reveal_order ` +
        'aborts ERevealWindowClosed; the batch will clear on whatever was revealed in time.',
    );
  }

  const identity = {
    batchId: batch.objectId,
    closeMs: Number(batch.closeMs),
    policyVersion: Number(batch.policyVersion),
  } as const;
  // Local, before any key server is asked: a session minted under a stale policy version is
  // refused here rather than declined remotely with no explanation.
  assertUsable(opts.session, identity, opts.nowMs);

  const rows = await readSealedOrders(deps, d, opts.batchObjectId, batch.orderCount);
  const readBlob = deps.readBlob ?? ((cfg, blobId) => walrusGet(cfg, blobId));

  const accepted: { readonly index: number; readonly order: PlainOrder }[] = [];
  const rejected: { readonly index: number; readonly reason: string }[] = [];
  let alreadyRevealed = 0;

  for (const row of rows) {
    if (row.isRevealed) {
      alreadyRevealed += 1; // Invariant 2 — reveal_order aborts EAlreadyRevealed.
      continue;
    }
    try {
      const ciphertext = await readBlob(deps.cfg, walrusBlobId(row.blobId));
      verifyCiphertext(row, ciphertext);
      const plaintext = await decryptPayload(deps.seal, ciphertext, opts.session, identity);
      const outcome = verifyPlaintext(row, plaintext);
      if (outcome.ok) accepted.push({ index: outcome.index, order: outcome.order });
      else rejected.push({ index: outcome.index, reason: outcome.reason });
    } catch (err) {
      // Invariant 3: one unreachable blob or one declined share must not stop the other reveals.
      rejected.push({
        index: row.index,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const chunkSize = Math.min(opts.chunkSize ?? MAX_REVEALS_PER_TX, MAX_REVEALS_PER_TX);
  if (chunkSize < 1) throw new RangeError(`--chunk must be >= 1 — got ${String(opts.chunkSize)}`);

  const digests: string[] = [];
  let broadcast = false;

  for (let i = 0; i < accepted.length; i += chunkSize) {
    const group = accepted.slice(i, i + chunkSize);
    const tx = buildRevealTx(d, opts.batchObjectId, group);
    tx.setSender(opts.signer.toSuiAddress());
    const result = await sendChecked({ client: deps.client }, tx, {
      what: `batch::reveal_order ×${group.length}`,
      signer: opts.signer,
      ...(opts.dryRun === true ? { dryRun: true } : {}),
    });
    if (result.digest !== undefined) digests.push(result.digest);
    broadcast = broadcast || result.broadcast;
  }

  return {
    batch,
    considered: rows.length,
    alreadyRevealed,
    accepted: accepted.map((a) => a.index),
    rejected,
    digests,
    broadcast,
  };
}
