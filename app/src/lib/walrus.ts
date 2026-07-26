// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F3
// @phase      3
// @status     DONE
// @spec       aphotic.md §7.2 step 1 (the on-chain record is a ciphertext hash and
//             a blob id — a LOCATOR, never a binding)
// @spec       docs/DESIGN-V2.md §3 ("ct_hash and blob_id exist only so a third
//             party can FIND the ciphertext")
// @rules      G7 G8
// @depends    @aphotic/sdk/hash · ../config.ts
// @facts      PUT  <publisher>/v1/blobs?epochs=N   -> { newlyCreated | alreadyCertified }
// @facts      GET  <aggregator>/v1/blobs/<blobId>  -> the bytes
// @facts      The blob id is base64url TEXT, and `submit_order` takes it as
// @facts        `vector<u8>`. We store the ASCII of the id, not a decode of it:
// @facts        the on-chain value has to be the thing a third party can paste
// @facts        into the aggregator URL, or it stops being a locator.
// @facts      ⚠ THE BLOB IS NOT THE COMMITMENT. `commitment` binds the plaintext;
// @facts        `ct_hash` and `blob_id` only say where the ciphertext lives. A
// @facts        publisher that loses the blob costs the submitter their reveal — it
// @facts        cannot change what they committed to.
// @facts      ⚠ Without VITE_WALRUS_PUBLISHER there is no write path. The screen
// @facts        says so and disables submit rather than pretending.
// @implements export function walrusConfigured · blobUrl
// @implements export async function putBlob(bytes, opts?): Promise<string>
// @implements export async function getBlob(blobId, opts?): Promise<Uint8Array>
// @implements export function blobIdBytes · blobIdFromBytes · ciphertextHash
// @forbidden  storing an order PLAINTEXT in Walrus — only the sealed ciphertext
// @forbidden  a fetch on mount
// @invariant  1. blobIdFromBytes(blobIdBytes(id)) === id.
// @invariant  2. Nothing here can succeed without an explicitly configured
//                publisher — there is no default write endpoint.
// @ac         app/test/walrus.test.ts — the round-trip, and an unconfigured
//             publisher refusing before any request is made.
// @verify     cd app && npm run build
// @verify     cd app && npm test -- walrus
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { blake2b256 } from '@aphotic/sdk/hash';

import { config } from '../config';

/** True when this build can WRITE a ciphertext. Reading only needs the aggregator. */
export function walrusConfigured(): boolean {
  return config.walrus.publisherUrl.length > 0;
}

/** Where a third party fetches the ciphertext — the whole reason a blob id is on chain. */
export function blobUrl(blobId: string): string {
  const base = config.walrus.aggregatorUrl.replace(/\/$/, '');
  return `${base}/v1/blobs/${encodeURIComponent(blobId)}`;
}

/** `blake2b256(ciphertext)` — the `ct_hash` field. A locator, not a binding. */
export function ciphertextHash(ciphertext: Uint8Array): Uint8Array {
  return blake2b256(ciphertext);
}

/** The ASCII bytes of the blob id, which is what the Move `vector<u8>` holds. */
export function blobIdBytes(blobId: string): Uint8Array {
  return new TextEncoder().encode(blobId);
}

export function blobIdFromBytes(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

type FetchLike = typeof globalThis.fetch;

interface StoreResponse {
  readonly newlyCreated?: { readonly blobObject?: { readonly blobId?: string } };
  readonly alreadyCertified?: { readonly blobId?: string };
}

/**
 * Publish a ciphertext and return its blob id.
 *
 * Both response shapes are handled: a blob whose content already exists comes
 * back `alreadyCertified`, which is a success and not a duplicate error.
 */
export async function putBlob(
  bytes: Uint8Array,
  opts?: { readonly epochs?: number; readonly fetchImpl?: FetchLike },
): Promise<string> {
  if (!walrusConfigured()) {
    throw new Error(
      'VITE_WALRUS_PUBLISHER is empty in this build, so there is nowhere to publish the ' +
        'ciphertext. Submission is disabled rather than sending an order with a blob id we ' +
        'made up.',
    );
  }
  const base = config.walrus.publisherUrl.replace(/\/$/, '');
  const url = `${base}/v1/blobs?epochs=${opts?.epochs ?? 5}`;
  const doFetch = opts?.fetchImpl ?? globalThis.fetch;
  const response = await doFetch(url, { method: 'PUT', body: bytes as BodyInit });
  if (!response.ok) {
    throw new Error(`Walrus publisher answered ${response.status} — the ciphertext was not stored.`);
  }
  const parsed = (await response.json()) as StoreResponse;
  const blobId = parsed.newlyCreated?.blobObject?.blobId ?? parsed.alreadyCertified?.blobId;
  if (blobId === undefined || blobId.length === 0) {
    throw new Error('Walrus publisher returned no blob id — refusing to submit an order without one.');
  }
  return blobId;
}

/** Fetch a ciphertext by blob id. This is the permissionless half of reveal. */
export async function getBlob(
  blobId: string,
  opts?: { readonly fetchImpl?: FetchLike },
): Promise<Uint8Array> {
  const doFetch = opts?.fetchImpl ?? globalThis.fetch;
  const response = await doFetch(blobUrl(blobId));
  if (!response.ok) {
    throw new Error(`Walrus aggregator answered ${response.status} for blob ${blobId}.`);
  }
  return new Uint8Array(await response.arrayBuffer());
}
