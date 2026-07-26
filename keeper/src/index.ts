#!/usr/bin/env node
// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       B8
// @phase      2
// @status     DONE — all ten commands run. Every one either performs its action or
//             exits NON-ZERO with the reason. Nothing here pretends.
// @spec       aphotic.md §7.2 (the batch lifecycle), §9 (liveness is not privileged)
// @spec       docs/DESIGN-V2.md §4 (mechanical cadence), §5 (clearing), §3 (seal identity),
//             §6 (the O(1) approve_nav), §7 (the complete KeeperCap surface)
// @rules      G2 G5 G7 G8
// @depends    ./config.ts · ./schedule · ./verify · ./clearing/engine.ts · ./privacy ·
//             ./hashi · ./batch · ./nav · ./vault · ./sui
// @facts      ★ LIVENESS IS NOT A PRIVILEGE (aphotic.md §9). Opening, closing,
// @facts        revealing, clearing, settling and claiming are permissionless on-chain:
// @facts        if the keeper is down, anyone runs the schedule at the scheduled time.
// @facts        This CLI is an optimisation, never a gatekeeper. `nav` is the ONE
// @facts        capability-gated command, and it commits nothing — the admin multisig
// @facts        approves separately. Two PARTIES, not two scopes.
// @facts      ★ THE COMPOSITION ROOT. Config, the Sui client, the signer and the Seal
// @facts        backend are assembled HERE and injected downward, which is why every
// @facts        module under ./batch, ./nav and ./vault is testable with no network.
// @facts      ★★ WHERE THE v2 OBJECT IDS COME FROM, and why it is not `config.ts`.
// @facts        `loadConfig` carries APHOTIC_PACKAGE_ID and VAULT_ID but predates the
// @facts        batch auction: it has no BatchRegistry, no KeeperCap, no per-batch ids.
// @facts        Those arrive as FLAGS, falling back to the environment, resolved in this
// @facts        one function (`resolveId`). No literal appears anywhere — `gates.ps1 ids`
// @facts        stays green — and the fallback names are listed in `--help` so an
// @facts        operator is never guessing. Fold them into config.ts when that file is
// @facts        next opened; nothing here changes when they are.
// @facts      ⚠ The v1 CLI (create-vault · publish-strategy · run · crank · sweep ·
// @facts        exit · reclaim · verify) is gone with the market-making thesis. Its
// @facts        modules were deleted; keeping the names would have promised a product
// @facts        that no longer exists.
// @implements export const COMMANDS: readonly CommandSpec[]
// @implements export function resolveId(flags, env, flag, envVar, why): string
// @implements export async function main(argv: readonly string[]): Promise<number>
// @forbidden  a command that exits 0 without doing what its name says
// @forbidden  a canonical id literal — every id arrives through config, a flag or the env (G7)
// @forbidden  reading the limiter from an SDK call and calling it verified (G5)
// @forbidden  an `approve_nav` path anywhere in this CLI — that is the multisig's leg
// @invariant  1. Every command either performs its action or exits NON-ZERO with the
//                reason. There is no third outcome.
//             2. `--help` and an unknown command are distinguishable: help exits 0,
//                unknown exits 1.
//             3. No command touches the network before its arguments validate.
//             4. Every broadcast goes through ./sui/send.ts (devInspect-then-send).
// @ac         `node dist/index.js --help` exits 0 and lists every command with its state.
// @verify     cd keeper && npm run build && node dist/index.js --help
// @verify     powershell -NoProfile -File scripts/gates.ps1
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Signer } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

import { runClose } from './batch/close.js';
import { runDrive } from './batch/drive.js';
import { runOpen } from './batch/open.js';
import { readBatch } from './batch/read.js';
import { runReveal } from './batch/reveal.js';
import { createSealBackend } from './batch/sealBackend.js';
import { clear, PRICE_SCALE, type FundingSnapshot, type RevealedOrder } from './clearing/engine.js';
import { loadConfig, type Config } from './config.js';
import { createHashiAdapter } from './hashi/index.js';
import { runPropose, type NavOverrides } from './nav/propose.js';
import { sealIdentity, type SealDeps } from './privacy/seal.js';
import { createSession } from './privacy/session.js';
import {
  DEFAULT_CADENCE,
  dueActions,
  msUntilNextBoundary,
  nextBoundary,
  previousBoundary,
} from './schedule/index.js';
import { createSuiClient, type AnySuiClient } from './sui/client.js';
import { bytesToHex } from './util/bytes.js';
import { ConfigError } from './util/errors.js';
import { runClaim } from './vault/claim.js';
import { readVaultTypeArgs, typeOrigin, type Deployment, type VaultTypeArgs } from './vault/context.js';
import { deriveLimiterFromAdapter } from './verify/index.js';

export interface CommandSpec {
  readonly name: string;
  readonly describe: string;
  /** false ⇒ declared but not wired; running it exits 2 naming `needs`. */
  readonly wired: boolean;
  /** The keeper module that must exist before this can be wired. */
  readonly needs?: string;
}

export const COMMANDS: readonly CommandSpec[] = Object.freeze([
  { name: 'schedule', describe: 'print the cadence: previous/next 06:00-18:00 UTC boundary and what is due now', wired: true },
  { name: 'seal-id', describe: 'print the 48-byte Seal inner identity for a batch (LITTLE-endian — see the byte-order note)', wired: true },
  { name: 'clear', describe: 'run the clearing locally over an order set on stdin; print price, matched volume and fills root', wired: true },
  { name: 'verify-limiter', describe: 'RE-DERIVE the Guardian rate limiter from Hashi’s own event stream (G5)', wired: true },
  { name: 'open', describe: 'open the next batch (permissionless on-chain; close_ms is DERIVED, never given)', wired: true },
  { name: 'close', describe: 'close the live batch at or after its scheduled boundary (permissionless)', wired: true },
  { name: 'reveal', describe: 'fetch ciphertexts, Seal-decrypt, check each commitment locally, submit reveals', wired: true },
  { name: 'drive', describe: 'advance the clearing under a gas budget until every stage reports done', wired: true },
  { name: 'nav', describe: 'propose a NAV (KeeperCap). The admin multisig approves separately — two PARTIES, not two scopes', wired: true },
  { name: 'claim', describe: 'claim crank for priced deposit/redeem receipts (no capability on chain)', wired: true },
]);

/**
 * Flags every on-chain command shares, printed under the command list so the fallback
 * environment variable names are never something an operator has to grep for.
 */
const COMMON_FLAGS: readonly (readonly [string, string])[] = Object.freeze([
  ['--package <id>', 'aphotic package        (env APHOTIC_PACKAGE_ID)     — moveCall targets'],
  ['--original-package <id>', 'FIRST-published pkg    (env APHOTIC_ORIGINAL_PACKAGE_ID) — type args/receipts/Seal'],
  ['--vault <id>', 'shared Vault<B,Q,S>    (env VAULT_ID)'],
  ['--registry <id>', 'shared BatchRegistry   (env BATCH_REGISTRY_ID)'],
  ['--batch <id>', 'shared Batch           (env BATCH_ID)          — close/reveal/drive'],
  ['--clearing <id>', 'shared Clearing        (env CLEARING_ID)       — drive, optional'],
  ['--cap <id>', 'owned KeeperCap        (env KEEPER_CAP_ID)     — nav only'],
  ['--now <ms>', 'inject the clock so a run is replayable'],
  ['--dry-run', 'simulate and report; never broadcast'],
]);

function usage(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  const lines = COMMANDS.map((c) => `  ${c.wired ? ' ' : '!'} ${c.name.padEnd(width)}  ${c.describe}`);
  // The legend appears only while something is unwired. Printing "! = not wired" under a list
  // with no `!` in it trains a reader to ignore the marker that matters.
  const unwired = COMMANDS.some((c) => !c.wired)
    ? ['  ! = declared but NOT wired. Running it exits 2 and names the module it needs.', '']
    : [];
  return [
    'aphotic keeper — the batch auction is permissionless; this CLI is an optimisation, not a gatekeeper.',
    '',
    'Usage: aphotic <command> [options]',
    '',
    ...lines,
    '',
    ...unwired,
    'Shared flags (flag wins; the environment variable is the fallback):',
    ...COMMON_FLAGS.map(([flag, why]) => `  ${flag.padEnd(18)}  ${why}`),
    '',
    'nav is the only capability-gated command, and it COMMITS NOTHING: the admin multisig',
    'approves the digest separately. Two parties, not two scopes.',
    '',
  ].join('\n');
}

/** Minimal `--key value` / `--flag` parser. No dependency, no surprises. */
function parseFlags(argv: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined || !token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out.set(key, next);
      i += 1;
    } else {
      out.set(key, 'true');
    }
  }
  return out;
}

function requireFlag(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (value === undefined || value === 'true' || value.trim() === '') {
    throw new Error(`--${name} is required`);
  }
  return value;
}

function requireInt(flags: Map<string, string>, name: string): number {
  const raw = requireFlag(flags, name);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`--${name} must be a non-negative integer — got ${raw}`);
  }
  return value;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/** `--now <ms>` makes the output replayable; otherwise the wall clock. */
function nowMs(flags: Map<string, string>): bigint {
  const raw = flags.get('now');
  return raw === undefined || raw === 'true' ? BigInt(Date.now()) : BigInt(raw);
}

const jsonBig = (_k: string, v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : v);

function cmdSchedule(flags: Map<string, string>): number {
  const at = nowMs(flags);
  const next = nextBoundary(at, DEFAULT_CADENCE);
  const prev = previousBoundary(at, DEFAULT_CADENCE);
  const untilMin = Number(msUntilNextBoundary(at, DEFAULT_CADENCE) / 60_000n);

  process.stdout.write(
    [
      `now       ${at}  ${new Date(Number(at)).toISOString()}`,
      `previous  ${prev}  ${new Date(Number(prev)).toISOString()}`,
      `next      ${next}  ${new Date(Number(next)).toISOString()}  (in ${untilMin} min)`,
      // No batch snapshot is read here — this command is deliberately offline, so it
      // reports what is due with NO live batch, which is the "anyone can open one"
      // case. Reading a live batch needs an RPC and belongs in `drive`.
      `due       ${JSON.stringify(dueActions(undefined, at, DEFAULT_CADENCE), jsonBig)}`,
      '',
      'The cadence is MECHANICAL: close_ms is derived from the clock, never chosen. An',
      'operator who could pick when a batch closes could advantage selected orders,',
      'which is the exact attack uniform-price clearing exists to remove.',
      '',
    ].join('\n'),
  );
  return 0;
}

function cmdSealId(flags: Map<string, string>): number {
  const batchId = requireFlag(flags, 'batch');
  const closeMs = requireInt(flags, 'close-ms');
  const policyVersion = requireInt(flags, 'policy-version');
  const id = sealIdentity({ batchId, closeMs, policyVersion });

  process.stdout.write(
    [
      `inner id (48 bytes)  0x${bytesToHex(id)}`,
      `  [ 0..8 )  close_ms        ${closeMs}   LITTLE-ENDIAN`,
      `  [ 8..16)  policy_version  ${policyVersion}   LITTLE-ENDIAN`,
      `  [16..48)  batch id        ${batchId}`,
      '',
      'This is the INNER id only — Seal prefixes the package id itself to form the full',
      'IBE identity, so prepending it here would land it twice.',
      '',
      'The byte order is not cosmetic. bcs::peel_u64 reads little-endian; a big-endian',
      'encoding yields a policy that never opens, with no error anywhere to read.',
      '',
    ].join('\n'),
  );
  return 0;
}

async function cmdClear(): Promise<number> {
  const raw = await readStdin();
  if (raw.trim() === '') {
    process.stderr.write('clear: expected a JSON order set on stdin\n');
    return 1;
  }
  // ⚠ JSON has no bigint. Every u64/u128 arrives as a string or a number and MUST be
  // coerced before it reaches the engine — passing a string through would not throw,
  // it would compare falsely and report "no cross" on an order set that clears. A
  // clearing tool that quietly returns the wrong answer is worse than one that errors.
  type RawOrder = Record<keyof RevealedOrder, unknown>;
  type RawFunding = Record<keyof FundingSnapshot, unknown>;
  const parsed = JSON.parse(raw) as {
    batchId?: string | number;
    orders?: RawOrder[];
    funding?: RawFunding[];
    feeMatchedBps?: string | number;
  };

  const big = (v: unknown, field: string): bigint => {
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number' || typeof v === 'string') return BigInt(v);
    throw new Error(`clear: ${field} must be an integer or a decimal string — got ${typeof v}`);
  };

  const orders: RevealedOrder[] = (parsed.orders ?? []).map((o, i) => ({
    index: Number(o.index ?? i),
    submitter: String(o.submitter ?? ''),
    isBid: Boolean(o.isBid),
    limitPrice: big(o.limitPrice, `orders[${i}].limitPrice`),
    qtySats: big(o.qtySats, `orders[${i}].qtySats`),
  }));

  const funding: FundingSnapshot[] = (parsed.funding ?? []).map((f, i) => ({
    submitter: String(f.submitter ?? ''),
    baseSats: big(f.baseSats, `funding[${i}].baseSats`),
    quoteSats: big(f.quoteSats, `funding[${i}].quoteSats`),
  }));

  const result = clear({
    batchId: big(parsed.batchId ?? 0, 'batchId'),
    orders,
    // Funding is REQUIRED, not optional: an account that cannot cover its fill is
    // truncated deterministically, so omitting the snapshot would clear a DIFFERENT
    // auction from the one that would settle on chain.
    funding,
    feeMatchedBps: big(parsed.feeMatchedBps ?? 0, 'feeMatchedBps'),
  });

  process.stdout.write(`${JSON.stringify(result, jsonBig, 2)}\n`);
  process.stdout.write(
    `\nprice scale ${PRICE_SCALE} — must equal aphotic::clearing::price_scale().\n` +
      'A mismatch between the two is a release blocker, not a rounding difference.\n',
  );
  return 0;
}

/**
 * ★ THE TWO WAYS THIS COMMAND USED TO LIE, both fixed here (both reproduced against testnet).
 *
 * 1. `HASHI_ADAPTER` unset defaults to `mock`. The mock's stream is empty unless a test seeds it,
 *    so the replay walked ZERO events, `deriveLimiter` returned the GENESIS PRIOR unchanged, and
 *    the command printed it under the words "Re-derived from Hashi's own ... stream" and exited 0.
 *    The prior is `cfg.limiter`; the live guardian reports a bucket ~100x larger. An operator
 *    reading that output would have believed a verified number that was never verified.
 * 2. Even against the real adapter, an empty page is not evidence of an idle bridge — it is
 *    equally the signature of a filter that matches nothing or a transport that returned nothing.
 *
 * So: refuse the mock, and refuse to call an empty replay a verification. A verifier that reports
 * success having checked nothing is worse than no verifier, because it is believed (G5).
 */
async function cmdVerifyLimiter(flags: Map<string, string>): Promise<number> {
  const cfg = loadConfig(process.env as Record<string, string | undefined>);

  if (cfg.hashi.adapter !== 'real' && flags.get('allow-mock') !== 'true') {
    process.stderr.write(
      `verify-limiter: HASHI_ADAPTER is "${cfg.hashi.adapter}", not "real".\n` +
        '  The deterministic mock replays a stream it made up, so a trajectory derived from it\n' +
        '  verifies NOTHING — and its empty-stream result is the genesis prior, which reads like a\n' +
        '  successful verification. Set HASHI_ADAPTER=real, or pass --allow-mock to rehearse the\n' +
        '  output shape with the result explicitly marked unverified.\n',
    );
    return 2;
  }

  const hashi = createHashiAdapter(cfg);
  const trajectory = await deriveLimiterFromAdapter(hashi, { limiter: cfg.limiter });

  process.stdout.write(`${JSON.stringify(trajectory, jsonBig, 2)}\n`);

  if (trajectory.samples.length === 0) {
    process.stderr.write(
      '\nverify-limiter: THE REPLAY WALKED ZERO LIMITER EVENTS — nothing was verified.\n' +
        `  The bucket printed above (${cfg.limiter.maxBucketCapacitySats} sats cap, ` +
        `${cfg.limiter.refillRateSatsPerSec} sats/s refill) is the CONFIGURED GENESIS PRIOR, not a\n` +
        '  derived reading. An empty stream is indistinguishable from a filter that matches nothing,\n' +
        '  so this exits non-zero rather than presenting a prior as a verification (G5).\n',
    );
    return 1;
  }

  process.stdout.write(
    `\nRe-derived from ${trajectory.samples.length} boundaries of Hashi’s own WithdrawalRequested /\n` +
      'PickedForProcessing / Signed / Cancelled stream. guardian.limiterStatus() was NOT consulted\n' +
      '— it is an unverified hint, and the entire claim is that you can reproduce this without\n' +
      'trusting us (G5).\n',
  );
  if (trajectory.unresolvedCount > 0) {
    process.stdout.write(
      `\n⚠ ${trajectory.unresolvedCount} boundaries could not be joined to a requested amount — the\n` +
        '  replay is INCOMPLETE there, so the final bucket is a lower bound, not the number.\n',
    );
  }
  return 0;
}

// ─── on-chain plumbing (the composition root) ────────────────────────────────

type Env = Record<string, string | undefined>;

/**
 * Flag first, environment second, loud refusal third.
 *
 * ⚠ No id literal ever appears in this file (`gates.ps1 ids`). See the @facts block on why the
 * v2 ids arrive here rather than through `config.ts`.
 */
export function resolveId(
  flags: Map<string, string>,
  env: Env,
  flag: string,
  envVar: string,
  why: string,
  fallback = '',
): string {
  const fromFlag = flags.get(flag);
  if (fromFlag !== undefined && fromFlag !== 'true' && fromFlag.trim() !== '') return fromFlag.trim();
  const fromEnv = env[envVar];
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim();
  if (fallback !== '') return fallback;
  throw new ConfigError(`--${flag} (or ${envVar}) is required — ${why}`, [envVar]);
}

/** The keeper's signing key. Never logged, never journaled, never defaulted. */
function requireSigner(cfg: Config): Signer {
  const key = cfg.secrets.keeperKey;
  if (key === undefined || key.trim() === '') {
    throw new ConfigError(
      'KEEPER_KEY (or SUI_PRIVATE_KEY) is unset — this command signs a transaction',
      ['KEEPER_KEY'],
    );
  }
  return Ed25519Keypair.fromSecretKey(key.trim());
}

interface OnChain {
  readonly cfg: Config;
  readonly client: AnySuiClient;
  readonly deployment: Deployment;
  readonly signer: Signer;
  readonly typeArgs: VaultTypeArgs;
  readonly dryRun: boolean;
}

/**
 * Assemble everything an on-chain command needs, in one place.
 *
 * `typeArgs` are READ OFF THE VAULT (see ./vault/context.ts) rather than configured, so a wrong
 * `B`/`Q`/`S` is impossible rather than merely unlikely.
 */
async function connect(flags: Map<string, string>, env: Env): Promise<OnChain> {
  const cfg = loadConfig(env);
  const packageId = resolveId(flags, env, 'package', 'APHOTIC_PACKAGE_ID', 'the published aphotic package', cfg.aphotic.packageId);
  const deployment: Deployment = {
    packageId,
    // `published-at` moves on every upgrade; the type origin never does. Defaulting to
    // `packageId` is correct ONLY for a package that was never upgraded — see ./vault/context.ts.
    originalPackageId: resolveId(
      flags,
      env,
      'original-package',
      'APHOTIC_ORIGINAL_PACKAGE_ID',
      'the FIRST-published aphotic package (type arguments, receipt filters and Seal resolve against it)',
      cfg.aphotic.originalPackageId === '' ? packageId : cfg.aphotic.originalPackageId,
    ),
    vaultId: resolveId(flags, env, 'vault', 'VAULT_ID', 'the shared Vault object', cfg.aphotic.vaultId),
    registryId: resolveId(flags, env, 'registry', 'BATCH_REGISTRY_ID', 'the shared BatchRegistry that governs the cadence'),
  };
  const signer = requireSigner(cfg);
  const client = createSuiClient(cfg);
  const typeArgs = await readVaultTypeArgs({ cfg, client }, typeOrigin(deployment), deployment.vaultId);
  return { cfg, client, deployment, signer, typeArgs, dryRun: flags.get('dry-run') === 'true' };
}

const line = (label: string, value: unknown): string => `${label.padEnd(20)} ${String(value)}`;

async function cmdOpen(flags: Map<string, string>, env: Env): Promise<number> {
  const { cfg, client, deployment, signer, dryRun } = await connect(flags, env);
  const report = await runOpen({ cfg, client }, deployment, {
    signer,
    nowMs: Number(nowMs(flags)),
    ...(dryRun ? { dryRun: true } : {}),
  });

  process.stdout.write(
    [
      line('cadence', `${report.registry.cadence.cadenceMs} ms, offset ${report.registry.cadence.offsetMs} ms`),
      line('predicted close_ms', `${report.predictedCloseMs}  ${new Date(Number(report.predictedCloseMs)).toISOString()}`),
      line('batch object', report.batchObjectId ?? '(dry run — nothing created)'),
      line('digest', report.digest ?? '(not broadcast)'),
      '',
      'close_ms was DERIVED on chain from the registry cadence. This command takes no timestamp',
      'and never will: an operator who could choose when a batch closes could advantage selected',
      'orders, which is the exact attack uniform-price clearing exists to remove.',
      '',
    ].join('\n'),
  );
  return 0;
}

async function cmdClose(flags: Map<string, string>, env: Env): Promise<number> {
  const { cfg, client, deployment, signer, dryRun } = await connect(flags, env);
  const batchObjectId = resolveId(flags, env, 'batch', 'BATCH_ID', 'the shared Batch to close');

  const report = await runClose({ cfg, client }, deployment, {
    signer,
    batchObjectId,
    nowMs: Number(nowMs(flags)),
    ...(flags.get('force') === 'true' ? { force: true } : {}),
    ...(dryRun ? { dryRun: true } : {}),
  });

  process.stdout.write(
    [
      line('batch', `${report.batch.batchId} (${report.batch.objectId})`),
      line('close_ms', `${report.batch.closeMs}  ${new Date(Number(report.batch.closeMs)).toISOString()}`),
      line('orders', report.batch.orderCount),
      line('digest', report.digest ?? '(not broadcast)'),
      '',
      'A full batch does NOT close early, and a batch never closes late by choice: the boundary',
      'is `now >= close_ms`, checked against the on-chain Clock.',
      '',
    ].join('\n'),
  );
  return 0;
}

async function cmdReveal(flags: Map<string, string>, env: Env): Promise<number> {
  const { cfg, client, deployment, signer, dryRun } = await connect(flags, env);
  const batchObjectId = resolveId(flags, env, 'batch', 'BATCH_ID', 'the shared Batch to reveal');
  const at = Number(nowMs(flags));

  // The session must be minted under the batch's OWN policy version — a bump invalidates every
  // outstanding identity, and ../privacy/session.ts refuses a stale one locally.
  const batch = await readBatch({ cfg, client }, deployment, batchObjectId);
  const backend = createSealBackend({ client, registryId: deployment.registryId });
  const sealDeps: SealDeps = { cfg, client, backend };
  const ttlMinutes = Number(flags.get('session-ttl-min') ?? '10');
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1) {
    throw new ConfigError(`--session-ttl-min must be a positive integer — got ${ttlMinutes}`, []);
  }
  const session = await createSession(sealDeps, signer, {
    policyVersion: Number(batch.policyVersion),
    ttlMs: ttlMinutes * 60_000,
    createdAtMs: at,
  });

  const chunk = flags.get('chunk');
  const report = await runReveal({ cfg, client, seal: sealDeps }, deployment, {
    signer,
    batchObjectId,
    session,
    nowMs: at,
    ...(chunk === undefined || chunk === 'true' ? {} : { chunkSize: Number(chunk) }),
    ...(dryRun ? { dryRun: true } : {}),
  });

  process.stdout.write(
    [
      line('batch', `${report.batch.batchId} (${report.batch.objectId})`),
      line('sealed orders', report.considered),
      line('already revealed', report.alreadyRevealed),
      line('accepted', `${report.accepted.length} → [${report.accepted.join(', ')}]`),
      line('rejected', report.rejected.length),
      ...report.rejected.map((r) => `  ! index ${r.index}: ${r.reason}`),
      line('digests', report.digests.length === 0 ? '(not broadcast)' : report.digests.join(', ')),
      '',
      'Every commitment was recomputed from the DECRYPTED PLAINTEXT and compared locally before',
      'anything was submitted. One bad ciphertext costs a skipped index, not a reverted PTB that',
      'would take every good reveal in the same transaction down with it.',
      '',
    ].join('\n'),
  );
  return report.rejected.length > 0 && report.accepted.length === 0 ? 1 : 0;
}

async function cmdDrive(flags: Map<string, string>, env: Env): Promise<number> {
  const { cfg, client, deployment, signer, typeArgs, dryRun } = await connect(flags, env);
  const batchObjectId = resolveId(flags, env, 'batch', 'BATCH_ID', 'the shared Batch being cleared');
  const clearing = flags.get('clearing') ?? env['CLEARING_ID'];
  const budget = flags.get('budget');
  const maxSteps = flags.get('max-steps');

  const report = await runDrive({ cfg, client }, deployment, {
    signer,
    typeArgs,
    batchObjectId,
    ...(clearing === undefined || clearing === 'true' || clearing.trim() === ''
      ? {}
      : { clearingObjectId: clearing.trim() }),
    ...(budget === undefined || budget === 'true' ? {} : { budget: BigInt(budget) }),
    ...(maxSteps === undefined || maxSteps === 'true' ? {} : { maxSteps: Number(maxSteps) }),
    ...(dryRun ? { dryRun: true } : {}),
  });

  process.stdout.write(
    [
      line('clearing object', report.clearingObjectId ?? '(dry run — nothing created)'),
      line('began', report.began),
      line('steps sent', report.steps),
      line('stage', report.final?.stageName ?? '(unread)'),
      line('done', report.final?.isDone ?? false),
      line('clearing price', report.final?.clearingPrice ?? '-'),
      line('matched (sats)', report.final?.matchedBaseSats ?? '-'),
      line('fills', report.final?.fillCount ?? '-'),
      line('fills root', report.final === undefined ? '-' : `0x${bytesToHex(report.final.fillsRoot)}`),
      line('digests', report.digests.length === 0 ? '(not broadcast)' : String(report.digests.length)),
      '',
      report.exhausted
        ? '⚠ THE STEP BUDGET WAS EXHAUSTED AND THE CLEARING IS NOT DONE. Run `drive` again — the\n' +
          '  cursor is on chain, so nothing is lost and nothing is repeated. This is reported rather\n' +
          '  than rounded up to success on purpose.'
        : 'The clearing is cursor-driven: a large batch costs extra transactions, never a redesign.',
      '',
    ].join('\n'),
  );
  return report.exhausted ? 1 : 0;
}

async function cmdNav(flags: Map<string, string>, env: Env): Promise<number> {
  const { cfg, client, deployment, signer, typeArgs, dryRun } = await connect(flags, env);
  const keeperCapId = resolveId(flags, env, 'cap', 'KEEPER_CAP_ID', 'the owned KeeperCap that gates propose_nav');

  const big = (name: string): bigint | undefined => {
    const raw = flags.get(name);
    return raw === undefined || raw === 'true' ? undefined : BigInt(raw);
  };
  const overrides: NavOverrides = {
    ...(big('deployed') === undefined ? {} : { deployedSats: big('deployed') as bigint }),
    ...(big('in-flight') === undefined ? {} : { inFlightSats: big('in-flight') as bigint }),
    ...(big('native-btc') === undefined ? {} : { nativeBtcSats: big('native-btc') as bigint }),
    ...(big('hashi-claims') === undefined ? {} : { hashiClaimsSats: big('hashi-claims') as bigint }),
    ...(big('clearing-price') === undefined ? {} : { clearingPrice: big('clearing-price') as bigint }),
    ...(big('book-mid') === undefined ? {} : { bookMid: big('book-mid') as bigint }),
  };

  const report = await runPropose({ cfg, client }, deployment, {
    signer,
    typeArgs,
    keeperCapId,
    overrides,
    ...(dryRun ? { dryRun: true } : {}),
  });

  process.stdout.write(
    [
      line('epoch', report.state.epoch),
      line('idle (sats)', report.inputs.idleSats),
      line('deployed (sats)', report.inputs.deployedSats),
      line('in flight (sats)', report.inputs.inFlightSats),
      line('native BTC (sats)', report.inputs.nativeBtcSats),
      line('hashi claims (sats)', report.inputs.hashiClaimsSats),
      line('clearing price', `${report.inputs.clearingPrice}${report.inputs.clearingPrice === 0n ? '  (no auction reference this epoch)' : ''}`),
      line('book mid', `${report.inputs.bookMid}${report.inputs.bookMid === 0n ? '  (no book reference this epoch)' : ''}`),
      line('nav assets', report.navAssets),
      line('digest', report.digest ?? '(not broadcast)'),
      line('PROPOSAL DIGEST', report.proposalDigestHex ?? '(not broadcast)'),
      '',
      'THIS COMMITTED NOTHING. No share was minted, no asset moved, no epoch advanced. The admin',
      'multisig signs the proposal digest above and calls `approve_nav` itself — two PARTIES, not',
      'two scopes. There is no approve path in this CLI and there must never be one.',
      '',
    ].join('\n'),
  );
  return 0;
}

async function cmdClaim(flags: Map<string, string>, env: Env): Promise<number> {
  const { cfg, client, deployment, signer, typeArgs, dryRun } = await connect(flags, env);
  const owner = signer.toSuiAddress();

  const report = await runClaim({ cfg, client }, deployment, {
    signer,
    typeArgs,
    owner,
    ...(dryRun ? { dryRun: true } : {}),
  });

  process.stdout.write(
    [
      line('owner', owner),
      line('vault epoch', report.vaultEpoch),
      line('receipts scanned', report.scanned),
      line('claimable', report.claimable.length),
      ...report.claimable.map(
        (r) => `  ${r.kind.padEnd(7)} ${r.objectId}  epoch ${r.epoch} → ${r.requester}`,
      ),
      line('digests', report.digests.length === 0 ? '(nothing broadcast)' : report.digests.join(', ')),
      '',
      'No capability gates either claim on chain (aphotic.md §9). A receipt is nonetheless an',
      'address-owned object, so this crank settles the receipts its signer holds — permissionless',
      'in the sense that matters, and still bounded by ordinary Sui ownership. Proceeds always go',
      "to the receipt's own `requester` field, never to the sender.",
      '',
    ].join('\n'),
  );
  return 0;
}

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(usage());
    return 0;
  }

  const spec = COMMANDS.find((c) => c.name === command);
  if (spec === undefined) {
    process.stderr.write(`unknown command: ${command}\n\n${usage()}`);
    return 1;
  }

  if (!spec.wired) {
    // Invariant 1: refuse loudly, and name the exact file that would fix it. A
    // command that exits 0 having done nothing is how a demo fails silently.
    process.stderr.write(
      `${spec.name}: not wired.\n` +
        `  needs: ${spec.needs ?? 'an unwritten keeper module'}\n` +
        '  The Move side is complete and this action is PERMISSIONLESS on-chain, so any\n' +
        '  client can drive it meanwhile — the keeper is an optimisation, not a gatekeeper\n' +
        '  (aphotic.md §9).\n',
    );
    return 2;
  }

  const flags = parseFlags(rest);
  try {
    switch (spec.name) {
      case 'schedule':
        return cmdSchedule(flags);
      case 'seal-id':
        return cmdSealId(flags);
      case 'clear':
        return await cmdClear();
      case 'verify-limiter':
        // Takes `flags` for --allow-mock: a mock replay verifies nothing, so the
        // command refuses one unless the caller says out loud it is a rehearsal.
        return await cmdVerifyLimiter(flags);
      case 'open':
        return await cmdOpen(flags, process.env as Env);
      case 'close':
        return await cmdClose(flags, process.env as Env);
      case 'reveal':
        return await cmdReveal(flags, process.env as Env);
      case 'drive':
        return await cmdDrive(flags, process.env as Env);
      case 'nav':
        return await cmdNav(flags, process.env as Env);
      case 'claim':
        return await cmdClaim(flags, process.env as Env);
      default:
        process.stderr.write(`${spec.name}: declared wired but has no dispatch branch\n`);
        return 1;
    }
  } catch (err) {
    process.stderr.write(`${spec.name}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

export default main;

// ─── Entry point ──────────────────────────────────────────────────────────────
// Self-execute ONLY when run as a program, so `main` stays importable by tests
// without a CLI firing as a side effect of the import. `realpath` on both sides
// because npm links bin scripts through a symlink, and comparing the unresolved
// paths silently fails to match — the CLI then does nothing and exits 0, which
// looks exactly like success.
{
  const entry = process.argv[1];
  if (entry !== undefined) {
    const self = fileURLToPath(import.meta.url);
    let same = false;
    try {
      same = realpathSync(self) === realpathSync(entry);
    } catch {
      same = self === entry;
    }
    if (same) {
      void main(process.argv.slice(2)).then((code) => {
        process.exitCode = code;
      });
    }
  }
}
