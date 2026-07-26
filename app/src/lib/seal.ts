// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F3
// @phase      3
// @status     DONE
// @spec       aphotic.md §7.5 (committee composition; NOT Enoki)
// @spec       docs/DESIGN-V2.md §3 (the seal_approve entry, the 48-byte inner id),
//             F1 (LITTLE-ENDIAN), F2 (no sender check), D5, D9
// @spec       move/sources/batch.move — `entry fun seal_approve(id, &BatchRegistry,
//             &Clock)` and `check_policy`
// @rules      G7 G8
// @depends    @aphotic/sdk/seal/identity · @aphotic/sdk/seal/committee
//             · @aphotic/sdk/hash · ./suiClient.ts · ./moveRead.ts · ../config.ts
// @facts      THE IDENTITY IS LITTLE-ENDIAN AND IS NOT BUILT HERE. It comes from
// @facts        `sdk/src/seal/identity.ts::encodeInnerId`, the one file that owns
// @facts        the encoding, because the Move decoder (`bcs::peel_u64`) reads
// @facts        little-endian and the historical bug wrote big-endian. Getting it
// @facts        backwards produces a policy that NEVER OPENS and fails SILENTLY.
// @facts      Full IBE identity = bytes(packageId) ‖ inner(48). @mysten/seal builds
// @facts        that itself in `createFullId`, so `encrypt({ packageId, id })`
// @facts        takes the INNER id as hex and nothing else.
// @facts      DECRYPTION needs a `seal_approve` transaction to dry-run. It carries
// @facts        NO SENDER CHECK (F2): after `close_ms` anybody can satisfy it,
// @facts        which is what makes reveal permissionless and kills
// @facts        grief-by-non-revelation.
// @facts      ⚠ D9 — n = 5 servers across 5 DISTINCT OPERATORS, t = 3. Count
// @facts        operators, not servers. NEVER fall back to plaintext: there is no
// @facts        code path in this module that returns an unencrypted order, and
// @facts        `encryptOrder` throws rather than degrade.
// @facts      ⚠ Enoki must never appear in the committee — it is our zkLogin salt
// @facts        provider, and one party holding identity linkage AND a decryption
// @facts        share defeats the whole arrangement.
// @implements export function sealConfigured · sealCommittee
// @implements export async function encryptOrder(args)
// @implements export function buildSealApprove(tx, innerId)
// @implements export async function sealApproveBytes(innerId)
// @implements export async function decryptOrder(args)
// @implements export async function probeCommittee(opts?)
// @forbidden  a plaintext fallback of any kind
// @forbidden  building the inner identity here — sdk/seal/identity.ts owns it
// @forbidden  an Enoki key server in the committee
// @invariant  1. encryptOrder throws unless at least `threshold` servers are
//                configured — it never quietly lowers the threshold.
// @invariant  2. The inner id is exactly 48 bytes, LITTLE-ENDIAN, and carries no
//                sender.
// @ac         app/test/seal.test.ts — the identity is the sdk's LE encoding, the
//             approve PTB carries the id/registry/clock triple, and an
//             under-configured committee refuses.
// @verify     cd app && npm run build
// @verify     cd app && npm test -- seal
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { SealClient, SessionKey } from '@mysten/seal';
import { bcs } from '@mysten/sui/bcs';
import { Transaction } from '@mysten/sui/transactions';

import { toHex } from '@aphotic/sdk/hash';
import { probeAll, type ProbeResult, type ProbeTarget } from '@aphotic/sdk/seal/committee';
import { encodeInnerId } from '@aphotic/sdk/seal/identity';

import { config } from '../config';
import { CLOCK_ID, aphoticTarget, requireWired } from './moveRead';
import { getSuiClient } from './suiClient';

const BYTES = bcs.vector(bcs.u8());

/** True when this build has enough committee members to meet its own threshold. */
export function sealConfigured(): boolean {
  const { keyServerIds, threshold } = config.seal;
  return keyServerIds.length > 0 && keyServerIds.length >= threshold;
}

export interface CommitteeMember {
  readonly objectId: string;
  readonly baseUrl: string;
}

/** The configured committee, index-aligned ids and URLs. */
export function sealCommittee(): readonly CommitteeMember[] {
  return config.seal.keyServerIds.map((objectId, i) => ({
    objectId,
    baseUrl: config.seal.keyServerUrls[i] ?? '',
  }));
}

let client: SealClient | null = null;

function sealClient(): SealClient {
  if (client === null) {
    if (!sealConfigured()) {
      throw new Error(
        `Seal is not configured: ${config.seal.keyServerIds.length} key server(s) for a ` +
          `threshold of ${config.seal.threshold}. We do not lower the threshold and we never ` +
          'fall back to plaintext.',
      );
    }
    client = new SealClient({
      suiClient: getSuiClient(),
      serverConfigs: config.seal.keyServerIds.map((objectId) => ({ objectId, weight: 1 })),
      // The /verify screen probes liveness explicitly and shows what answered.
      // Silent verification here would hide exactly what that panel exists to say.
      verifyKeyServers: false,
    });
  }
  return client;
}

/** Test hook — drops the memoised client. */
export function resetSealClient(): void {
  client = null;
}

/** The 48-byte inner identity for a batch. LITTLE-ENDIAN, from the sdk. */
export function innerIdentity(closeMs: bigint, batchObjectId: string): Uint8Array {
  return encodeInnerId(closeMs, BigInt(config.seal.policyVersion), batchObjectId);
}

export interface EncryptedOrder {
  /** The Seal encrypted object — this is what goes to Walrus. */
  readonly ciphertext: Uint8Array;
  /** The inner identity it was sealed under, for the record. */
  readonly innerId: Uint8Array;
}

/**
 * Seal one order under the batch's time-lock identity.
 *
 * Throws — loudly, and before anything is written anywhere — if the committee is
 * not configured. An order that cannot be sealed is an order that is not
 * submitted.
 */
export async function encryptOrder(args: {
  readonly closeMs: bigint;
  readonly batchObjectId: string;
  readonly plaintext: Uint8Array;
}): Promise<EncryptedOrder> {
  requireWired([['VITE_APHOTIC_PACKAGE_ID', config.aphotic.packageId]]);
  const innerId = innerIdentity(args.closeMs, args.batchObjectId);
  const { encryptedObject } = await sealClient().encrypt({
    threshold: config.seal.threshold,
    packageId: config.aphotic.packageId,
    id: toHex(innerId),
    data: args.plaintext,
  });
  return { ciphertext: encryptedObject, innerId };
}

/**
 * The `seal_approve` call the key servers dry-run.
 *
 * One command, a MoveCall into our own package, a non-empty Pure first argument,
 * side-effect free, denial by abort — every constraint the key server imposes.
 */
export function buildSealApprove(tx: Transaction, innerId: Uint8Array): Transaction {
  requireWired([['VITE_BATCH_REGISTRY_ID', config.aphotic.batchRegistryId]]);
  tx.moveCall({
    target: aphoticTarget('batch', 'seal_approve'),
    arguments: [
      tx.pure(BYTES.serialize(Array.from(innerId)).toBytes()),
      tx.object(config.aphotic.batchRegistryId),
      tx.object(CLOCK_ID),
    ],
  });
  return tx;
}

/** The transaction KIND bytes `SealClient.decrypt` wants. */
export async function sealApproveBytes(innerId: Uint8Array): Promise<Uint8Array> {
  const tx = new Transaction();
  buildSealApprove(tx, innerId);
  return tx.build({ client: getSuiClient(), onlyTransactionKind: true });
}

/**
 * A session key, so the key servers can attribute requests without the wallet
 * signing once per share. The personal message must be signed by the connected
 * wallet — this returns the key half-built, exactly as Seal's flow requires.
 */
export async function createSessionKey(address: string, ttlMin = 10): Promise<SessionKey> {
  requireWired([['VITE_APHOTIC_PACKAGE_ID', config.aphotic.packageId]]);
  return SessionKey.create({
    address,
    packageId: config.aphotic.packageId,
    ttlMin,
    suiClient: getSuiClient(),
  });
}

/**
 * Recover one order's plaintext after `close_ms`.
 *
 * Anyone can do this — that is the design, not a leak. `check_policy` asserts
 * only the policy version and `now >= close_ms`; it reads no sender (F2).
 */
export async function decryptOrder(args: {
  readonly ciphertext: Uint8Array;
  readonly sessionKey: SessionKey;
  readonly innerId: Uint8Array;
}): Promise<Uint8Array> {
  const txBytes = await sealApproveBytes(args.innerId);
  return sealClient().decrypt({
    data: args.ciphertext,
    sessionKey: args.sessionKey,
    txBytes,
  });
}

// ── committee health ────────────────────────────────────────────────────────

export interface CommitteeHealth {
  readonly results: readonly ProbeResult[];
  readonly live: number;
  readonly threshold: number;
  readonly quorum: boolean;
}

/**
 * Probe `/v1/service` on every configured server.
 *
 * ⚠ The probe needs BOTH a `Client-Sdk-Version` header AND a `?service_id=`
 * query param or the server answers 400 — not 404, not 200. Omit either and
 * every server looks dead. Both are supplied by the sdk's `probeService`, which
 * is why this function is a thin wrapper and not its own request builder.
 */
export async function probeCommittee(opts?: {
  readonly fetchImpl?: Parameters<typeof probeAll>[1];
}): Promise<CommitteeHealth> {
  const targets: ProbeTarget[] = sealCommittee()
    .filter((m) => m.baseUrl.length > 0)
    .map((m) => ({
      server: { objectId: m.objectId, operator: m.objectId, label: m.baseUrl },
      baseUrl: m.baseUrl,
    }));
  const results = await probeAll(targets, opts?.fetchImpl);
  const live = results.filter((r) => r.ok).length;
  return { results, live, threshold: config.seal.threshold, quorum: live >= config.seal.threshold };
}
