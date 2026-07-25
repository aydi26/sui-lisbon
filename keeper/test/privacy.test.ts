// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T2.6
// @phase      2  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/KEEPER.md §3.3 (Seal identity, session keys, version-epoch rotation)
// @spec       docs/MOVE-PACKAGE.md §3.4 (`vault::seal_approve` / `check_seal_access`)
// @rules      G2 G7 G8 G10
// @depends    ../src/privacy/{seal,session,rotation}.ts · ../src/sui/client.ts · ./support/fixtures.ts
// @facts      `@mysten/seal` is NOT installed ⇒ the SDK is reached through the `SealBackend` port.
// @facts        This suite injects a DETERMINISTIC in-memory backend: it is a test double for the
// @facts        SDK, never a substitute for the on-chain `seal_approve` gate (which is what
// @facts        actually authorizes a share release).
// @facts      ★ THE IDENTITY IS THE SECURITY BOUNDARY: 40 bytes = 32-byte vault id ‖ u64 epoch BE,
// @facts        byte-identical to `aphotic::vault::check_seal_access`. Bumping the epoch changes
// @facts        the identity, which is exactly why rotation revokes previously derived shares.
// @facts      No network, no clock: every timestamp is an argument and the Sui client is built by
// @facts        the single factory (`createSuiClient`) which performs no I/O at construction.
// @implements T2.6 acceptance — Seal encrypt/decrypt with version-epoch identity
// @invariant  1. No test asserts on a message string where a stable `code` exists.
// @verify     npm run test -- privacy
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import {
  encryptParams,
  decryptParams,
  publishStrategy,
  sealIdentity,
  SEAL_ID_VAULT_LEN,
  SEAL_IDENTITY_LEN,
  type BlobStore,
  type SealBackend,
  type SealDeps,
  type SealEncryptRequest,
} from '../src/privacy/seal.js';
import {
  assertUsable,
  createSession,
  isExpired,
  redactSession,
  SESSION_UNUSABLE_CODE,
  type SealSession,
} from '../src/privacy/session.js';
import {
  buildRotateTx,
  nextEpoch,
  rotate,
  type RotationExecutor,
  type RotationPlan,
} from '../src/privacy/rotation.js';
import { defaultParams } from '../src/strategy/params.js';
import { SERIALIZED_PARAMS_BYTES, deserialize } from '../src/strategy/serialize.js';
import { createSuiClient } from '../src/sui/client.js';
import { bytesEqual } from '../src/util/bytes.js';
import { AphoticError, ConfigError } from '../src/util/errors.js';

import { testSigner, testConfig } from './support/fixtures.js';

const VAULT_ID = `0x${'b2'.repeat(32)}`;
const VAULT_CAP_ID = `0x${'b3'.repeat(32)}`;
const PACKAGE_ID = `0x${'a1'.repeat(32)}`;
const KEEPER_ADDR = `0x${'e5'.repeat(32)}`;
const KEY_SERVER_A = `0x${'c3'.repeat(32)}`;
const KEY_SERVER_B = `0x${'d4'.repeat(32)}`;

const cfg = testConfig({
  APHOTIC_PACKAGE_ID: PACKAGE_ID,
  VAULT_ID,
  SUI_KEEPER_ADDRESS: KEEPER_ADDR,
  SEAL_KEY_SERVERS: `${KEY_SERVER_A},${KEY_SERVER_B}`,
  SEAL_THRESHOLD: '2',
});

const client = createSuiClient(cfg);
const params = defaultParams(cfg);

/**
 * Deterministic stand-in for `SealClient`. The ciphertext is `[threshold ‖ identity ‖ frame]`,
 * so `decrypt` can PROVE the identity it was handed matches the one the data was sealed under —
 * which is the property the version epoch relies on.
 */
function fakeBackend(): SealBackend & { readonly encrypts: SealEncryptRequest[] } {
  const encrypts: SealEncryptRequest[] = [];
  return {
    encrypts,
    async encrypt(req) {
      encrypts.push(req);
      const out = new Uint8Array(1 + req.identity.length + req.data.length);
      out[0] = req.threshold;
      out.set(req.identity, 1);
      out.set(req.data, 1 + req.identity.length);
      return out;
    },
    async decrypt({ ciphertext, identity }) {
      const sealed = ciphertext.slice(1, 1 + identity.length);
      if (!bytesEqual(sealed, identity)) {
        // This is what a key server refusing a stale-epoch share looks like from here.
        throw new AphoticError('SealShareDenied', 'identity mismatch: no key share released');
      }
      return ciphertext.slice(1 + identity.length);
    },
    async createSessionKey(req) {
      return { kind: 'fake-session-key', address: req.address, ttlMinutes: req.ttlMinutes };
    },
  };
}

function deps(over: Partial<SealDeps> = {}): SealDeps {
  return { cfg, client, backend: fakeBackend(), ...over };
}

function session(over: Partial<SealSession> = {}): SealSession {
  return {
    vaultId: VAULT_ID,
    versionEpoch: 0,
    createdAtMs: 1_000_000,
    expiresAtMs: 1_600_000,
    key: { kind: 'fake-session-key' },
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
describe('privacy/seal — the identity IS the security boundary', () => {
  it('is 40 bytes: 32-byte vault id ‖ big-endian u64 epoch (mirrors vault::check_seal_access)', () => {
    const id = sealIdentity({ vaultId: VAULT_ID, versionEpoch: 258 });
    expect(id.length).toBe(SEAL_IDENTITY_LEN);
    expect(id.length).toBe(40);
    expect(Array.from(id.subarray(0, SEAL_ID_VAULT_LEN))).toEqual(Array.from({ length: 32 }, () => 0xb2));
    // 258 = 0x0102 big-endian in the last 8 bytes.
    expect(Array.from(id.subarray(SEAL_ID_VAULT_LEN))).toEqual([0, 0, 0, 0, 0, 0, 1, 2]);
  });

  it('changes with the epoch — that is precisely what revokes previously derived shares', () => {
    const a = sealIdentity({ vaultId: VAULT_ID, versionEpoch: 0 });
    const b = sealIdentity({ vaultId: VAULT_ID, versionEpoch: 1 });
    expect(bytesEqual(a, b)).toBe(false);
    expect(bytesEqual(a.subarray(0, SEAL_ID_VAULT_LEN), b.subarray(0, SEAL_ID_VAULT_LEN))).toBe(true);
  });

  it('invariant 2 — no vault id and no valid epoch means no identity, therefore no encryption', () => {
    expect(() => sealIdentity({ vaultId: '', versionEpoch: 0 })).toThrowError(ConfigError);
    expect(() => sealIdentity({ vaultId: VAULT_ID, versionEpoch: -1 })).toThrowError(ConfigError);
    expect(() => sealIdentity({ vaultId: VAULT_ID, versionEpoch: 1.5 })).toThrowError(ConfigError);
    expect(() => sealIdentity({ vaultId: `0x${'aa'.repeat(33)}`, versionEpoch: 0 })).toThrowError(ConfigError);
  });

  it('encrypts the CONSTANT-LENGTH frame with the configured threshold and key servers (E-K12)', async () => {
    const backend = fakeBackend();
    const result = await encryptParams(deps({ backend }), params, { vaultId: VAULT_ID, versionEpoch: 3 });
    expect(backend.encrypts).toHaveLength(1);
    const req = backend.encrypts[0]!;
    expect(req.data.length).toBe(SERIALIZED_PARAMS_BYTES);
    expect(req.threshold).toBe(2);
    expect(req.keyServers).toEqual([KEY_SERVER_A, KEY_SERVER_B]);
    expect(req.packageId).toBe(PACKAGE_ID);
    expect(result.identity).toEqual(sealIdentity({ vaultId: VAULT_ID, versionEpoch: 3 }));
  });

  it('invariant 3 — ciphertext length is a function of the frame, not of the values', async () => {
    const d = deps();
    const a = await encryptParams(d, params, { vaultId: VAULT_ID, versionEpoch: 0 });
    const b = await encryptParams(
      d,
      { ...params, spreadBps: 9_000, skewBps: -9_000, maxNotionalPerEpochSats: 18_446_744_073_709_551_615n },
      { vaultId: VAULT_ID, versionEpoch: 0 },
    );
    expect(b.ciphertext.length).toBe(a.ciphertext.length);
  });

  it('fails LOUDLY with no Seal backend — never a silent plaintext fallback (G8)', async () => {
    await expect(
      encryptParams({ cfg, client }, params, { vaultId: VAULT_ID, versionEpoch: 0 }),
    ).rejects.toThrowError(ConfigError);
  });

  it('refuses to encrypt when the threshold exceeds the configured key servers', async () => {
    const thin = testConfig({
      APHOTIC_PACKAGE_ID: PACKAGE_ID,
      VAULT_ID,
      SEAL_KEY_SERVERS: KEY_SERVER_A,
      SEAL_THRESHOLD: '2',
    });
    await expect(
      encryptParams({ cfg: thin, client, backend: fakeBackend() }, params, {
        vaultId: VAULT_ID,
        versionEpoch: 0,
      }),
    ).rejects.toThrowError(ConfigError);
  });

  it('round-trips: decrypt under the SAME (vault, epoch) returns the exact parameters', async () => {
    const d = deps();
    const { ciphertext } = await encryptParams(d, params, { vaultId: VAULT_ID, versionEpoch: 4 });
    const out = await decryptParams(d, ciphertext, session({ versionEpoch: 4 }));
    expect(out).toEqual(params);
  });

  it('a session from the PREVIOUS epoch cannot decrypt the rotated ciphertext', async () => {
    const d = deps();
    const { ciphertext } = await encryptParams(d, params, { vaultId: VAULT_ID, versionEpoch: 5 });
    await expect(decryptParams(d, ciphertext, session({ versionEpoch: 4 }))).rejects.toMatchObject({
      code: 'SealShareDenied',
    });
  });

  it('invariant 4 — a corrupted frame is an ERROR, never a silent fallback to defaults', async () => {
    const d = deps();
    const { ciphertext } = await encryptParams(d, params, { vaultId: VAULT_ID, versionEpoch: 0 });
    const tampered = Uint8Array.from(ciphertext);
    tampered[1 + SEAL_IDENTITY_LEN] = 0x7f; // the frame's version byte
    await expect(decryptParams(d, tampered, session())).rejects.toMatchObject({
      code: 'EBadStrategyFrame',
    });
  });

  it('publishStrategy uploads the CIPHERTEXT with explicit epochs — encrypt before upload (G8)', async () => {
    const puts: { bytes: Uint8Array; epochs: number }[] = [];
    const storage: BlobStore = {
      async put(_cfg, bytes, opts) {
        puts.push({ bytes, epochs: opts.epochs });
        return { blobId: 'blob-abc' };
      },
    };
    const d = deps({ storage });
    const { blobId, ciphertext } = await publishStrategy(d, params, { vaultId: VAULT_ID, versionEpoch: 7 });

    expect(blobId).toBe('blob-abc');
    expect(puts).toHaveLength(1);
    expect(puts[0]!.epochs).toBe(cfg.walrus.epochs);
    expect(cfg.walrus.epochs).toBeGreaterThanOrEqual(2);
    expect(Array.from(puts[0]!.bytes)).toEqual(Array.from(ciphertext));
    // The bytes that left the process are NOT the plaintext frame.
    expect(puts[0]!.bytes.length).not.toBe(SERIALIZED_PARAMS_BYTES);
    // …and they still decrypt back to exactly what we sealed.
    const frame = puts[0]!.bytes.slice(1 + SEAL_IDENTITY_LEN);
    expect(deserialize(frame)).toEqual(params);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('privacy/session — short-lived, epoch-scoped, never a fund capability (G2)', () => {
  it('mints a session bound to (vault, epoch) with a ttl rounded UP to whole Seal minutes', async () => {
    const backend = fakeBackend();
    const s = await createSession({ cfg, client, backend }, testSigner(1), {
      vaultId: VAULT_ID,
      versionEpoch: 2,
      ttlMs: 90_000,
      createdAtMs: 1_000_000,
    });
    expect(s.vaultId).toBe(VAULT_ID);
    expect(s.versionEpoch).toBe(2);
    expect(s.expiresAtMs).toBe(1_090_000);
    expect(s.key).toMatchObject({ ttlMinutes: 2, address: testSigner(1).toSuiAddress() });
  });

  it('refuses to mint without a package id — the share gate is `aphotic::vault::seal_approve`', async () => {
    const noPkg = testConfig({ VAULT_ID, SEAL_KEY_SERVERS: KEY_SERVER_A });
    await expect(
      createSession({ cfg: noPkg, client, backend: fakeBackend() }, testSigner(1), {
        vaultId: VAULT_ID,
        versionEpoch: 0,
        ttlMs: 60_000,
        createdAtMs: 0,
      }),
    ).rejects.toThrowError(ConfigError);
  });

  it('invariant 1 — expiry is PURE: nowMs is an argument, never a clock read', () => {
    const s = session({ createdAtMs: 1_000, expiresAtMs: 2_000 });
    expect(isExpired(s, 1_999)).toBe(false);
    expect(isExpired(s, 2_000)).toBe(true);
    expect(isExpired(s, 5_000)).toBe(true);
  });

  it('invariant 2 — assertUsable checks vault AND epoch AND expiry, with a stable code', () => {
    const s = session({ versionEpoch: 3, expiresAtMs: 2_000 });
    expect(() => assertUsable(s, { vaultId: VAULT_ID, versionEpoch: 3 }, 1_500)).not.toThrow();

    for (const bad of [
      () => assertUsable(s, { vaultId: `0x${'11'.repeat(32)}`, versionEpoch: 3 }, 1_500),
      () => assertUsable(s, { vaultId: VAULT_ID, versionEpoch: 4 }, 1_500),
      () => assertUsable(s, { vaultId: VAULT_ID, versionEpoch: 3 }, 2_000),
    ]) {
      expect(bad).toThrowError(AphoticError);
      try {
        bad();
      } catch (e) {
        expect((e as AphoticError).code).toBe(SESSION_UNUSABLE_CODE);
      }
    }
  });

  it('invariant 3 — redactSession removes the key material without mutating the original', () => {
    const s = session({ key: { secret: 'do-not-log-me' } });
    const r = redactSession(s);
    expect(r.key).toBe('***');
    expect(JSON.stringify(r)).not.toContain('do-not-log-me');
    expect(s.key).toEqual({ secret: 'do-not-log-me' });
    expect(r.vaultId).toBe(s.vaultId);
    expect(r.versionEpoch).toBe(s.versionEpoch);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('privacy/rotation — bump AND re-encrypt, atomically', () => {
  const plan: RotationPlan = {
    vaultId: VAULT_ID,
    vaultCapId: VAULT_CAP_ID,
    fromEpoch: 0,
    toEpoch: 1,
    params,
    previousBlobId: 'blob-old',
  };

  it('invariant 2 — epochs are monotonic and gapless', () => {
    expect(nextEpoch(0)).toBe(1);
    expect(nextEpoch(41)).toBe(42);
    expect(() => nextEpoch(-1)).toThrowError(ConfigError);
    expect(() => nextEpoch(1.5)).toThrowError(ConfigError);
  });

  it('invariant 1 — ONE PTB carries set_keeper (the epoch bump) THEN update_strategy', () => {
    const tx = buildRotateTx(cfg, plan, new Uint8Array([1, 2, 3]), 'blob-new');
    const commands = tx.getData().commands;
    const moveCalls = commands.filter((c) => c.$kind === 'MoveCall');
    expect(moveCalls).toHaveLength(2);
    expect(moveCalls[0]!.MoveCall!.module).toBe('vault');
    expect(moveCalls[0]!.MoveCall!.function).toBe('set_keeper');
    expect(moveCalls[1]!.MoveCall!.function).toBe('update_strategy');
    // The Vault is generic over the pair (G7) — both type args come from config, never literals.
    expect(moveCalls[0]!.MoveCall!.typeArguments).toEqual([
      cfg.hashi.hbtcCoinType,
      cfg.deepbook.dbusdcCoinType,
    ]);
    // `set_keeper` returns a KeeperCap the PTB must consume.
    expect(commands.some((c) => c.$kind === 'TransferObjects')).toBe(true);
    // The sender is deliberately unset: OWNER_KEY signs, and only the signer may be sender (G2).
    expect(tx.getData().sender).toBeNull();
  });

  it('refuses to bump the epoch without a real re-encryption', () => {
    expect(() => buildRotateTx(cfg, plan, new Uint8Array(0), 'blob-new')).toThrowError(AphoticError);
    expect(() => buildRotateTx(cfg, plan, new Uint8Array([1]), '')).toThrowError(AphoticError);
    expect(() => buildRotateTx(cfg, { ...plan, toEpoch: 5 }, new Uint8Array([1]), 'b')).toThrowError(
      ConfigError,
    );
  });

  it('re-encrypts under the NEW epoch, keeps the old blob, and returns the digest', async () => {
    const backend = fakeBackend();
    const puts: Uint8Array[] = [];
    const storage: BlobStore = {
      async put(_cfg, bytes) {
        puts.push(bytes);
        return { blobId: 'blob-new' };
      },
    };
    const seen: { sender: string | null | undefined }[] = [];
    const executor: RotationExecutor = async ({ tx }) => {
      seen.push({ sender: tx.getData().sender });
      return { digest: 'DiGeStBaSe58' };
    };

    const result = await rotate(
      { cfg, client, owner: testSigner(2), backend, storage, executor },
      plan,
    );

    expect(result).toEqual({
      digest: 'DiGeStBaSe58',
      toEpoch: 1,
      blobId: 'blob-new',
      previousBlobId: 'blob-old', // invariant 4 — retained for scoped historical disclosure
    });
    expect(seen).toHaveLength(1);
    // The ciphertext was sealed under toEpoch, NOT fromEpoch — that is the revocation.
    expect(backend.encrypts).toHaveLength(1);
    expect(backend.encrypts[0]!.identity).toEqual(
      sealIdentity({ vaultId: VAULT_ID, versionEpoch: 1 }),
    );
    expect(puts).toHaveLength(1);
  });

  it('does not touch the chain when the re-encryption fails (no backend ⇒ no transaction)', async () => {
    let executed = 0;
    const executor: RotationExecutor = async () => {
      executed += 1;
      return { digest: 'never' };
    };
    await expect(
      rotate({ cfg, client, owner: testSigner(2), executor }, plan),
    ).rejects.toThrowError(ConfigError);
    expect(executed).toBe(0);
  });
});
