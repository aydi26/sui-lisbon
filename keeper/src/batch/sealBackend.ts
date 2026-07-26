// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       B8.batch.sealBackend
// @phase      2
// @status     DONE
// @spec       ../privacy/seal.ts — `export interface SealBackend` (the narrow port this binds)
// @spec       docs/DESIGN-V2.md §3 (the `seal_approve` entry, exactly) · §1 F1 (the LE trap)
// @spec       move/sources/batch.move — `entry fun seal_approve(id: vector<u8>, r: &BatchRegistry,
//             c: &Clock)`
// @rules      G7 G8 G10
// @depends    @mysten/seal@1.3.4 (SealClient · SessionKey) · ../privacy/seal.ts · ../config.ts
// @facts      ★ THIS IS THE COMPOSITION ROOT FOR SEAL, and the only file that names the SDK. The
// @facts        port lives in ../privacy/seal.ts precisely so the SDK is bound in one place; that
// @facts        file's own banner says "production injects one built over SealClient/SessionKey",
// @facts        and this is that injection. Nothing else in keeper/src imports @mysten/seal.
// @facts      ★ THE PORT HAS NO `txBytes`, THE SDK REQUIRES ONE. `SealClient.decrypt` wants the
// @facts        serialized PTB that calls `seal_approve`, because every key server DRY-RUNS it
// @facts        before releasing a share. This adapter builds that PTB itself from the identity it
// @facts        was handed, which is why it closes over the registry id and a client.
// @facts      ★ `EncryptOptions.id` IS A HEX STRING, not bytes. The 48-byte inner identity is
// @facts        hex-encoded here and nowhere else; the LITTLE-ENDIAN layout is decided upstream in
// @facts        ../privacy/seal.ts `sealIdentity` and must not be re-derived here (DESIGN-V2 F1).
// @facts      ★ THE FULL IBE IDENTITY IS `bytes(packageId) ‖ inner`. Seal prefixes the package id
// @facts        itself, so passing the inner id is correct and prefixing it here would land it twice.
// @facts      ⚠ `seal_approve` is `entry`, non-`public`, side-effect free, one command, first
// @facts        argument a non-empty `Pure`. Every one of those is a key-server constraint; the PTB
// @facts        built below satisfies all of them, and `onlyTransactionKind: true` is required
// @facts        because the servers dry-run a transaction KIND, not a signed transaction.
// @facts      ⚠ RESIDUAL TRUST, STATED (G8): the running keeper decrypts in memory. A Nautilus/TEE
// @facts        fix is out of scope. Never claim otherwise.
// @implements export interface MystenSealOptions
// @implements export function createSealBackend(opts): SealBackend
// @forbidden  re-deriving the identity layout here — ../privacy/seal.ts owns it
// @forbidden  falling back to plaintext when a key server declines (G8)
// @forbidden  logging a session key, a derived key, or a plaintext
// @invariant  1. The `seal_approve` PTB has EXACTLY one command.
// @invariant  2. The identity is passed through unchanged; this file never reorders a byte of it.
// @invariant  3. A decrypt failure raises; it never returns an empty or partial plaintext.
// @ac         test/reveal.test.ts — the PTB shape is asserted against the key-server constraints
// @verify     npm run test -- reveal
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { SealClient, SessionKey } from '@mysten/seal';
import { Transaction } from '@mysten/sui/transactions';

import type {
  SealBackend,
  SealDecryptRequest,
  SealEncryptRequest,
  SealSessionKeyRequest,
} from '../privacy/seal.js';
import type { AnySuiClient } from '../sui/client.js';
import type { ObjectId } from '../types.js';
import { bytesToHex } from '../util/bytes.js';

export interface MystenSealOptions {
  readonly client: AnySuiClient;
  /** The shared `BatchRegistry` — `seal_approve`'s second argument. */
  readonly registryId: ObjectId;
  /** Verify key-server authenticity on construction. Default true. */
  readonly verifyKeyServers?: boolean;
}

/**
 * The one-command `seal_approve` transaction KIND every key server dry-runs (invariant 1).
 *
 * `onlyTransactionKind` because the servers evaluate a kind, not a signed transaction: there is
 * no sender, no gas, and nothing here mutates anything.
 */
export async function buildSealApproveTxBytes(
  opts: MystenSealOptions,
  packageId: string,
  identity: Uint8Array,
): Promise<Uint8Array> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::batch::seal_approve`,
    arguments: [
      // Invariant 2: the identity goes across byte for byte. Its LITTLE-ENDIAN layout was
      // decided by ../privacy/seal.ts and re-encoding it here is the F1 bug in a new file.
      tx.pure.vector('u8', Array.from(identity)),
      tx.object(opts.registryId),
      tx.object.clock(),
    ],
  });
  return tx.build({ client: opts.client, onlyTransactionKind: true });
}

/**
 * Bind `@mysten/seal` to the `SealBackend` port.
 *
 * The client is built lazily and cached: constructing a `SealClient` with
 * `verifyKeyServers: true` talks to every key server, and doing that on a code path that may
 * never encrypt would turn a read into a network fan-out.
 */
export function createSealBackend(opts: MystenSealOptions): SealBackend {
  let cached: SealClient | undefined;
  let cachedFor = '';

  const sealClient = (keyServers: readonly string[]): SealClient => {
    const fingerprint = keyServers.join(',');
    if (cached !== undefined && cachedFor === fingerprint) return cached;
    cached = new SealClient({
      // The Sui client shape SealClient needs is `{ core: CoreClient }`, which both transports
      // satisfy; the SDK's own alias is narrower than our union, hence the structural cast.
      suiClient: opts.client as unknown as ConstructorParameters<typeof SealClient>[0]['suiClient'],
      // EXPLICIT server configs from config — @mysten/seal@1.3.4 exports no default set and
      // `getAllowlistedKeyServers` is gone (E-K12). A literal here would trip gates.ps1 ids.
      serverConfigs: keyServers.map((objectId) => ({ objectId, weight: 1 })),
      verifyKeyServers: opts.verifyKeyServers ?? true,
    });
    cachedFor = fingerprint;
    return cached;
  };

  return {
    async encrypt(req: SealEncryptRequest): Promise<Uint8Array> {
      const client = sealClient(req.keyServers);
      const { encryptedObject } = await client.encrypt({
        threshold: req.threshold,
        packageId: req.packageId,
        // `id` is a HEX STRING in this SDK, not bytes. See the @facts note.
        id: bytesToHex(req.identity),
        data: req.data,
      });
      return encryptedObject;
    },

    async decrypt(req: SealDecryptRequest): Promise<Uint8Array> {
      // The port carries no key-server list on decrypt: the encrypted object names its own
      // servers, and SealClient checks ours are a subset of them.
      const client = sealClient([]);
      const txBytes = await buildSealApproveTxBytes(opts, req.packageId, req.identity);
      return client.decrypt({
        data: req.ciphertext,
        sessionKey: req.sessionKey as SessionKey,
        txBytes,
      });
    },

    async createSessionKey(req: SealSessionKeyRequest): Promise<unknown> {
      return SessionKey.create({
        address: req.address,
        packageId: req.packageId,
        ttlMin: req.ttlMinutes,
        signer: req.signer,
        suiClient: opts.client as unknown as Parameters<typeof SessionKey.create>[0]['suiClient'],
      });
    },
  };
}
