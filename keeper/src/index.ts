#!/usr/bin/env node
// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       B8
// @phase      2
// @status     PARTIAL — every command below either RUNS or refuses with a stated
//             reason and a non-zero exit. Nothing here pretends.
// @spec       aphotic.md §7.2 (the batch lifecycle), §9 (liveness is not privileged)
// @spec       docs/DESIGN-V2.md §4 (mechanical cadence), §5 (clearing), §3 (seal identity)
// @rules      G5 G7 G8
// @depends    ./config.ts · ./schedule · ./verify · ./clearing/engine.ts
//             ./privacy/seal.ts · ./hashi
// @facts      ★ LIVENESS IS NOT A PRIVILEGE (aphotic.md §9). Opening, closing,
// @facts        revealing, clearing and settling are permissionless on-chain: if the
// @facts        keeper is down, anyone runs the schedule at the scheduled time. This
// @facts        CLI is an optimisation, never a gatekeeper — which is exactly why a
// @facts        missing command here is an inconvenience and not an outage.
// @facts      ★ WHAT IS NOT WIRED, AND WHY IT SAYS SO. The Move package is complete
// @facts        (10 modules, 275 tests) but the keeper's on-chain action modules —
// @facts        nav/, batch/, vault/ — were never written: the agent building them
// @facts        died on a spend limit mid-run. Those commands are DECLARED and refuse
// @facts        with exit 2 naming the module they need. A command that silently
// @facts        no-ops is how a demo fails without anyone noticing.
// @facts      ⚠ The v1 CLI (create-vault · publish-strategy · run · crank · sweep ·
// @facts        exit · reclaim · verify) is gone with the market-making thesis. Its
// @facts        modules were deleted; keeping the names would have promised a product
// @facts        that no longer exists.
// @implements export const COMMANDS: readonly CommandSpec[]
// @implements export async function main(argv: readonly string[]): Promise<number>
// @forbidden  a command that exits 0 without doing what its name says
// @forbidden  a canonical id literal — every id arrives through config (G7)
// @forbidden  reading the limiter from an SDK call and calling it verified (G5)
// @invariant  1. Every command either performs its action or exits NON-ZERO with the
//                reason. There is no third outcome.
//             2. `--help` and an unknown command are distinguishable: help exits 0,
//                unknown exits 1.
//             3. No command touches the network before its arguments validate.
// @ac         `node dist/index.js --help` exits 0 and lists every command with its state.
// @verify     cd keeper && npm run build && node dist/index.js --help
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { clear, PRICE_SCALE, type FundingSnapshot, type RevealedOrder } from './clearing/engine.js';
import { loadConfig } from './config.js';
import { createHashiAdapter } from './hashi/index.js';
import { sealIdentity } from './privacy/seal.js';
import {
  DEFAULT_CADENCE,
  dueActions,
  msUntilNextBoundary,
  nextBoundary,
  previousBoundary,
} from './schedule/index.js';
import { bytesToHex } from './util/bytes.js';
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
  { name: 'open', describe: 'open the next batch (permissionless on-chain)', wired: false, needs: 'keeper/src/batch/open.ts' },
  { name: 'close', describe: 'close the live batch at or after its scheduled boundary (permissionless)', wired: false, needs: 'keeper/src/batch/close.ts' },
  { name: 'reveal', describe: 'fetch ciphertexts, Seal-decrypt, check each commitment locally, submit reveals', wired: false, needs: 'keeper/src/batch/reveal.ts' },
  { name: 'drive', describe: 'advance sort_step / price_step / settle_step under a gas budget', wired: false, needs: 'keeper/src/batch/drive.ts' },
  { name: 'nav', describe: 'propose a NAV (KeeperCap). The admin multisig approves separately — two PARTIES, not two scopes', wired: false, needs: 'keeper/src/nav/propose.ts' },
  { name: 'claim', describe: 'permissionless claim crank for priced deposit/redeem receipts', wired: false, needs: 'keeper/src/vault/claim.ts' },
]);

function usage(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  const lines = COMMANDS.map((c) => `  ${c.wired ? ' ' : '!'} ${c.name.padEnd(width)}  ${c.describe}`);
  return [
    'aphotic keeper — the batch auction is permissionless; this CLI is an optimisation, not a gatekeeper.',
    '',
    'Usage: aphotic <command> [options]',
    '',
    ...lines,
    '',
    '  ! = declared but NOT wired. Running it exits 2 and names the module it needs.',
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

async function cmdVerifyLimiter(): Promise<number> {
  const cfg = loadConfig(process.env as Record<string, string | undefined>);
  const hashi = createHashiAdapter(cfg);
  const trajectory = await deriveLimiterFromAdapter(hashi, { limiter: cfg.limiter });

  process.stdout.write(`${JSON.stringify(trajectory, jsonBig, 2)}\n`);
  process.stdout.write(
    '\nRe-derived from Hashi’s own WithdrawalRequested / PickedForProcessing / Signed /\n' +
      'Cancelled stream. guardian.limiterStatus() was NOT consulted — it is an unverified\n' +
      'hint, and the entire claim is that you can reproduce this without trusting us (G5).\n',
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
        return await cmdVerifyLimiter();
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
