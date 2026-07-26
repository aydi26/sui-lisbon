// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       B8.test.support
// @phase      2
// @status     DONE
// @spec       ../../src/batch/read.ts — the exact getter order the decoders depend on
// @rules      G10
// @facts      ★ These canned returns are ordered to match `BATCH_GETTERS` in ../../src/batch/read.ts.
// @facts        If that list changes, this file must change with it — which is the point: the
// @facts        decode is index-based, so a silent reorder would decode a close time as a state.
// @implements export function bcsSealedOrder(row): Uint8Array
// @implements export const chainFixtures
// @forbidden  a network call
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { bcs } from '@mysten/sui/bcs';

import type { SealedOrderRow } from '../../src/batch/read.js';

import { addressBcs, id, u64, u8 } from './chain.js';

const SEALED_ORDER = bcs.struct('SealedOrder', {
  submitter: bcs.Address,
  commitment: bcs.vector(bcs.u8()),
  ct_hash: bcs.vector(bcs.u8()),
  blob_id: bcs.vector(bcs.u8()),
  submitted_at_ms: bcs.u64(),
});

export function bcsSealedOrder(row: SealedOrderRow): Uint8Array {
  return SEALED_ORDER.serialize({
    submitter: row.submitter,
    commitment: Array.from(row.commitment),
    ct_hash: Array.from(row.ctHash),
    blob_id: Array.from(row.blobId),
    submitted_at_ms: row.submittedAtMs,
  }).toBytes();
}

export const chainFixtures = {
  /** The twelve `BATCH_GETTERS`, in order. close_ms 2000, closed_at 2001, grace 600 000. */
  batch(state: number, orderCount = 2, policyVersion = 1n): Uint8Array[][] {
    return [
      [addressBcs(id('b'))],
      [u64(3n)],
      [u8(state)],
      [u64(policyVersion)],
      [u64(1_000n)],
      [u64(2_000n)],
      [u64(2_001n)],
      [u64(256n)],
      [u64(60_000n)],
      [u64(600_000n)],
      [u64(BigInt(orderCount))],
      [u64(0n)],
    ];
  },
} as const;
