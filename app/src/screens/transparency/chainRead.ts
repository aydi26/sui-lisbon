// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T5.2
// @phase      5
// @status     DONE
// @spec       docs/APP.md §4 (Screen 3 — Transparency), §4.4 (state shapes)
// @spec       docs/RECON.md R1 (transport), R4 (DeepBook two-id split), R10 (empty book)
// @spec       docs/DEPLOYED.md v3 (package · Vault · BalanceManager of record)
// @spec       move/sources/vault.move (Vault fields + nav_sats semantics)
// @spec       move/sources/journal.move (DecisionRecorded { vault_id, seq, blob_id })
// @rules      G2 G5 G7 G8 G9 G10
// @depends    ../../lib/suiClient.ts (T0.4) · ../../config.ts (T0.4)
// @facts      ⚠ TRANSPORT: gRPC v2 has NO event RPC (RECON R1 / E-K8 gap #3) and its
// @facts        simulateTransaction refuses a sender that owns no gas. Every read in
// @facts        this module therefore runs over the verified JSON-RPC MIRROR
// @facts        (config.sui.jsonRpcUrl) obtained from lib/suiClient.ts — the ONE
// @facts        factory. Verified live 2026-07-25: the mirror answers
// @facts        suix_queryEvents / sui_getObject / sui_devInspectTransactionBlock
// @facts        and returns `access-control-allow-origin: *`, so a browser may read
// @facts        it directly. No client is constructed here (transport gate).
// @facts      Vault<B,Q> is read as ONE object with showContent, not as a PTB of
// @facts        getters: the fields are public, the object is shared, and one read
// @facts        cannot half-succeed. B = config.hashi.hbtcType, Q = the DBUSDC type.
// @facts      nav_sats semantics (move/sources/vault.move L358, v3): free =
// @facts        idle_btc − total_pending_exit_sats; if the QUOTE leg is zero the
// @facts        function RETURNS `free` with no price at all. A base-only vault is
// @facts        therefore exactly valuable with an empty book — which is our state.
// @facts        Only when quote != 0 is a DeepBook mid load-bearing (G9), and there
// @facts        we report "no mid" rather than substitute Pyth.
// @facts      ⚠ pool::get_level2_range aborts `3` if price_high exceeds DeepBook's
// @facts        MAX_PRICE = (1<<63)−1. Verified live: with the correct range the
// @facts        hBTC/DBUSDC book returns ([],[]) on BOTH sides — an empty book is a
// @facts        successful read, never an error (E-A7, RECON R10).
// @facts      ⚠ devInspect needs a sender but not a funded one: the zero address
// @facts        works, so this screen needs no session (verification is permissionless).
// @facts      strategy_blob_id is `vector<u8>`. A real Walrus id is the ASCII of a
// @facts        base64url string; the vault currently carries the ONE-BYTE 0x00
// @facts        placeholder recorded in docs/DEPLOYED.md § Known-incomplete.
// @implements export class ChainReadError
//             export interface VaultOnChain / VaultEnvelope / BookDepth / JournalEntry
//             export async function readVaultOnChain(signal?): Promise<VaultOnChain>
//             export async function readBookDepth(signal?): Promise<BookDepth>
//             export async function readJournal(signal?): Promise<readonly JournalEntry[]>
//             export function describeBlobId(bytes): { kind, display }
// @forbidden  constructing a Sui client here — lib/suiClient.ts is the ONE factory
// @forbidden  a canonical on-chain id literal — everything arrives from config (G7)
// @forbidden  substituting a Pyth price for a missing DeepBook mid — G9
// @forbidden  `number` for any sats-valued field — bigint only (G10)
// @invariant  1. Reads only. No transaction is ever executed or signed here.
// @invariant  2. Every failure is a ChainReadError carrying the endpoint and the
//                verbatim upstream reason — the screen renders it, never hides it.
// @invariant  3. An empty book and an empty journal are SUCCESSFUL results.
// @ac         docs/APP.md §7 A7 A9
// @verify     cd app && npx tsc --noEmit
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { bcs } from '@mysten/sui/bcs';
import { Transaction } from '@mysten/sui/transactions';

import { config } from '../../config';
import { getJsonRpcClient } from '../../lib/suiClient';

/** DeepBook rejects a range whose upper bound exceeds this (verified: abort 3). */
const DEEPBOOK_MIN_PRICE = 1n;
const DEEPBOOK_MAX_PRICE = (1n << 63n) - 1n;

/** devInspect needs *a* sender, not a funded one. */
const ZERO_ADDRESS = `0x${'0'.repeat(64)}`;

export class ChainReadError extends Error {
  readonly endpoint: string;
  readonly what: string;

  constructor(what: string, detail: string) {
    super(`${what} failed against ${config.sui.jsonRpcUrl} — ${detail}`);
    this.name = 'ChainReadError';
    this.what = what;
    this.endpoint = config.sui.jsonRpcUrl;
  }
}

const detailOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// ── tolerant readers for JSON-RPC parsed Move values ─────────────────────────

function fieldsOf(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  // A nested Move struct arrives as { type, fields: {...} }.
  const nested = record['fields'];
  if (typeof nested === 'object' && nested !== null && !Array.isArray(nested)) {
    return nested as Record<string, unknown>;
  }
  return record;
}

function readBig(source: Record<string, unknown>, key: string): bigint {
  const raw = source[key];
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'bigint') {
    try {
      return BigInt(raw);
    } catch {
      return 0n;
    }
  }
  return 0n;
}

function readNum(source: Record<string, unknown>, key: string): number {
  return Number(readBig(source, key));
}

function readStr(source: Record<string, unknown>, key: string): string {
  const raw = source[key];
  return typeof raw === 'string' ? raw : '';
}

function readVecU8(source: Record<string, unknown>, key: string): Uint8Array {
  const raw = source[key];
  if (!Array.isArray(raw)) return new Uint8Array();
  return Uint8Array.from(raw.map((n) => Number(n) & 0xff));
}

// ── the vault ────────────────────────────────────────────────────────────────

export interface VaultEnvelope {
  readonly maxSlippageBps: number;
  readonly maxNotionalPerEpochSats: bigint;
  readonly minCooldownMs: number;
  readonly bufferRatioBps: number;
  /** Guardian genesis scalar #1 — sats per SECOND (RECON R9). */
  readonly limiterRefillRatePerSec: bigint;
  /** Guardian genesis scalar #2 — the bucket ceiling in sats. */
  readonly limiterMaxCapacitySats: bigint;
  readonly epochStartMs: number;
  readonly epochLenMs: number;
  readonly epochNotionalUsedSats: bigint;
  readonly lastActionMs: number;
  readonly maxDivergenceBps: number;
}

export interface VaultOnChain {
  readonly objectId: string;
  readonly version: string;
  readonly digest: string;
  readonly typeString: string;
  readonly initialSharedVersion: string | null;

  readonly totalShares: bigint;
  readonly idleBtcSats: bigint;
  readonly totalPendingExitSats: bigint;
  /** idle − pooled earmark. What the vault may actually spend (vault.move L343). */
  readonly freeBtcSats: bigint;
  readonly quoteValue: bigint;
  /** null ⇒ the quote leg is non-zero and no DeepBook mid exists to value it (G9). */
  readonly navSats: bigint | null;
  readonly depositorCount: number;

  readonly owner: string;
  readonly keeper: string;
  readonly paused: boolean;
  readonly versionEpoch: number;

  readonly strategyBlobId: Uint8Array;
  readonly strategyCiphertextBytes: number;
  /**
   * Lowercase hex of the FIRST BYTES of the on-chain ciphertext. Rendered so the
   * reader can see that what is stored really is opaque; it is never enough to
   * decrypt anything, and it is never a fixture.
   */
  readonly strategyCiphertextPreviewHex: string;

  readonly poolId: string;
  readonly balanceManagerId: string;
  readonly envelope: VaultEnvelope;

  readonly readAtMs: number;
}

/**
 * One live read of the shared `Vault<hBTC, DBUSDC>`. Throws {@link ChainReadError};
 * the screen turns that into rendered text rather than an error boundary.
 */
export async function readVaultOnChain(signal?: AbortSignal): Promise<VaultOnChain> {
  if (config.aphotic.vaultId === '') {
    throw new ChainReadError('Vault read', 'VITE_VAULT_ID is empty — there is no object to read');
  }

  let response: Awaited<ReturnType<ReturnType<typeof getJsonRpcClient>['getObject']>>;
  try {
    response = await getJsonRpcClient().getObject({
      id: config.aphotic.vaultId,
      options: { showContent: true, showType: true, showOwner: true },
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (err) {
    throw new ChainReadError('Vault read', detailOf(err));
  }

  if (response.error !== undefined && response.error !== null) {
    throw new ChainReadError('Vault read', JSON.stringify(response.error));
  }
  const data = response.data;
  if (data === undefined || data === null) {
    throw new ChainReadError('Vault read', 'the node returned no object data');
  }

  const content = data.content;
  if (content === undefined || content === null || content.dataType !== 'moveObject') {
    throw new ChainReadError('Vault read', 'the object carries no parsed Move content');
  }

  const f = fieldsOf(content.fields);
  if (Object.keys(f).length === 0) {
    throw new ChainReadError('Vault read', 'the parsed Move content had no fields');
  }

  const envelope = fieldsOf(f['envelope']);
  const depositors = fieldsOf(f['depositors']);

  const idleBtcSats = readBig(f, 'idle_btc');
  const totalPendingExitSats = readBig(f, 'total_pending_exit_sats');
  const freeBtcSats = idleBtcSats > totalPendingExitSats ? idleBtcSats - totalPendingExitSats : 0n;
  const quoteValue = readBig(f, 'dbusdc');

  const owner = data.owner;
  const initialSharedVersion =
    typeof owner === 'object' && owner !== null && 'Shared' in owner
      ? String((owner as { Shared: { initial_shared_version: number | string } }).Shared.initial_shared_version)
      : null;

  return {
    objectId: data.objectId,
    version: String(data.version),
    digest: String(data.digest),
    typeString: String(data.type ?? content.type),
    initialSharedVersion,

    totalShares: readBig(f, 'total_shares'),
    idleBtcSats,
    totalPendingExitSats,
    freeBtcSats,
    quoteValue,
    // vault::nav_sats returns `free` verbatim when the quote leg is empty — no price
    // needed, and no price invented when one WOULD be needed (G9).
    navSats: quoteValue === 0n ? freeBtcSats : null,
    depositorCount: readNum(depositors, 'size'),

    owner: readStr(f, 'owner'),
    keeper: readStr(f, 'keeper'),
    paused: f['paused'] === true,
    versionEpoch: readNum(f, 'version_epoch'),

    strategyBlobId: readVecU8(f, 'strategy_blob_id'),
    strategyCiphertextBytes: readVecU8(f, 'strategy_ciphertext').length,
    strategyCiphertextPreviewHex: Array.from(readVecU8(f, 'strategy_ciphertext').slice(0, 32))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join(''),

    poolId: readStr(f, 'pool_id'),
    balanceManagerId: readStr(f, 'balance_manager_id'),

    envelope: {
      maxSlippageBps: readNum(envelope, 'max_slippage_bps'),
      maxNotionalPerEpochSats: readBig(envelope, 'max_notional_per_epoch_sats'),
      minCooldownMs: readNum(envelope, 'min_cooldown_ms'),
      bufferRatioBps: readNum(envelope, 'buffer_ratio_bps'),
      limiterRefillRatePerSec: readBig(envelope, 'limiter_refill_rate'),
      limiterMaxCapacitySats: readBig(envelope, 'limiter_max_capacity'),
      epochStartMs: readNum(envelope, 'epoch_start_ms'),
      epochLenMs: readNum(envelope, 'epoch_len_ms'),
      epochNotionalUsedSats: readBig(envelope, 'epoch_notional_used_sats'),
      lastActionMs: readNum(envelope, 'last_action_ms'),
      maxDivergenceBps: readNum(envelope, 'max_divergence_bps'),
    },

    readAtMs: Date.now(),
  };
}

// ── the DeepBook book (an empty book is a RESULT, not a failure) ─────────────

export interface BookLevel {
  readonly priceRaw: bigint;
  readonly quantityRaw: bigint;
}

export interface BookDepth {
  readonly poolId: string;
  readonly bids: readonly BookLevel[];
  readonly asks: readonly BookLevel[];
  /** true ⇒ both sides are empty, so `pool::mid_price` would abort EEmptyOrderbook. */
  readonly empty: boolean;
  readonly readAtMs: number;
}

const U64_VECTOR = bcs.vector(bcs.u64());

function decodeSide(returnValues: readonly (readonly [number[], string])[] | undefined): BookLevel[] {
  if (returnValues === undefined) return [];
  const prices = returnValues[0];
  const quantities = returnValues[1];
  if (prices === undefined || quantities === undefined) return [];
  const px = U64_VECTOR.parse(Uint8Array.from(prices[0])).map((v) => BigInt(v));
  const qty = U64_VECTOR.parse(Uint8Array.from(quantities[0])).map((v) => BigInt(v));
  const levels: BookLevel[] = [];
  for (let i = 0; i < Math.min(px.length, qty.length); i += 1) {
    levels.push({ priceRaw: px[i] as bigint, quantityRaw: qty[i] as bigint });
  }
  return levels;
}

/**
 * Both sides of `Pool<hBTC, DBUSDC>` by devInspect of DeepBook's own
 * `pool::get_level2_range`. NEVER `pool::mid_price` — that aborts on an empty book
 * (E-M7/E-A7), and "there is no market" is a fact we want to render, not an error.
 */
export async function readBookDepth(signal?: AbortSignal): Promise<BookDepth> {
  const client = getJsonRpcClient();
  const tx = new Transaction();

  for (const isBid of [true, false]) {
    tx.moveCall({
      // v20 CALLABLE package id; the type args resolve against the v1 origin (RECON R4).
      target: `${config.deepbook.packageId}::pool::get_level2_range`,
      typeArguments: [config.hashi.hbtcType, config.deepbook.dbusdcType],
      arguments: [
        tx.object(config.deepbook.poolId),
        tx.pure.u64(DEEPBOOK_MIN_PRICE),
        tx.pure.u64(DEEPBOOK_MAX_PRICE),
        tx.pure.bool(isBid),
        tx.object.clock(),
      ],
    });
  }

  try {
    const bytes = await tx.build({ client, onlyTransactionKind: true });
    const result = await client.devInspectTransactionBlock({
      sender: ZERO_ADDRESS,
      transactionBlock: bytes,
      ...(signal === undefined ? {} : { signal }),
    });

    if (result.effects.status.status !== 'success') {
      throw new Error(result.effects.status.error ?? 'devInspect reported a failure');
    }

    const results = result.results ?? [];
    return {
      poolId: config.deepbook.poolId,
      bids: decodeSide(results[0]?.returnValues),
      asks: decodeSide(results[1]?.returnValues),
      empty: (results[0]?.returnValues?.[0]?.[0].length ?? 1) <= 1 &&
        (results[1]?.returnValues?.[0]?.[0].length ?? 1) <= 1,
      readAtMs: Date.now(),
    };
  } catch (err) {
    throw new ChainReadError('DeepBook depth read', detailOf(err));
  }
}

// ── the decision log, as anchored on chain ───────────────────────────────────

export interface JournalEntry {
  readonly seq: number;
  readonly vaultId: string;
  /** Raw `blob_id` bytes exactly as emitted. Opaque to the Move module and to us. */
  readonly blobId: Uint8Array;
  readonly txDigest: string;
  readonly timestampMs: number;
  readonly sender: string;
}

/**
 * `aphotic::journal::DecisionRecorded` for the configured package, newest first.
 *
 * An EMPTY result is the honest, expected answer today: the keeper has not written a
 * decision-log segment against the v3 package yet. Nothing is synthesised to fill it.
 */
export async function readJournal(signal?: AbortSignal): Promise<readonly JournalEntry[]> {
  if (config.aphotic.packageId === '') {
    throw new ChainReadError('Journal read', 'VITE_APHOTIC_PACKAGE_ID is empty');
  }

  try {
    const page = await getJsonRpcClient().queryEvents({
      query: { MoveEventType: `${config.aphotic.packageId}::journal::DecisionRecorded` },
      limit: 50,
      order: 'descending',
      ...(signal === undefined ? {} : { signal }),
    });

    return page.data.map((event) => {
      const parsed = fieldsOf(event.parsedJson);
      return {
        seq: readNum(parsed, 'seq'),
        vaultId: readStr(parsed, 'vault_id'),
        blobId: readVecU8(parsed, 'blob_id'),
        txDigest: event.id.txDigest,
        timestampMs: Number(event.timestampMs ?? 0),
        sender: event.sender,
      };
    });
  } catch (err) {
    throw new ChainReadError('Journal read', detailOf(err));
  }
}

// ── blob ids ─────────────────────────────────────────────────────────────────

export type BlobIdKind = 'placeholder' | 'walrus-id' | 'opaque';

export interface DescribedBlobId {
  readonly kind: BlobIdKind;
  /** What to show a human. Never empty. */
  readonly display: string;
  readonly byteLength: number;
}

const PRINTABLE = /^[A-Za-z0-9_\-=+/]+$/;

/**
 * Classify the vault's `strategy_blob_id` bytes without guessing.
 * ≤1 byte ⇒ the documented placeholder (docs/DEPLOYED.md § Known-incomplete).
 * Printable ASCII ⇒ a Walrus blob id string. Anything else ⇒ hex, labelled opaque.
 */
export function describeBlobId(bytes: Uint8Array): DescribedBlobId {
  if (bytes.length <= 1) {
    return { kind: 'placeholder', display: 'one-byte placeholder (0x00)', byteLength: bytes.length };
  }
  const ascii = String.fromCharCode(...bytes);
  if (PRINTABLE.test(ascii)) {
    return { kind: 'walrus-id', display: ascii, byteLength: bytes.length };
  }
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return { kind: 'opaque', display: `0x${hex}`, byteLength: bytes.length };
}
