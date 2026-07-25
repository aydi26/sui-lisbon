// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.3, T2.10
// @phase      2  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/KEEPER.md §1.2 (the CLI commands + the `run` pseudo-cycle)
// @spec       docs/BUILD-PLAN.md#phase-0 (T0.3 keeper scaffold) · #phase-2 (T2.10 e2e run loop)
// @rules      G2 G5 G6 G7 G8
// @depends    ./config.ts (T0.6) · ./util/env.ts · ./util/errors.ts · every layer under src/
// @facts      COMMANDS (docs/KEEPER.md §1.2), with the task that implements each body:
// @facts        create-vault --strategy <file>                        T2.6  (+ T1.1 on-chain)
// @facts        publish-strategy --strategy <file>                    T2.6  (Seal -> Walrus only)
// @facts        run          --vault <ID>                             T2.10 (the main loop)
// @facts        crank        [--all]                                  T2.3  (permissionless public good)
// @facts        sweep        --deposit <req>                          T2.4  (sponsored; user needs no SUI)
// @facts        exit         --vault <ID> --shares <n>                T2.5  (pinned destination — G2)
// @facts        reclaim      --request <id>                           T2.5  (DEPOSITOR-signed; PRINTS an unsigned PTB)
// @facts        verify       --vault <ID> --from-epoch <N> [--limiter] T4.3 (trustless replay — G5)
// @facts      ★ `run` tick (docs/KEEPER.md §1.2): snapshot{book, oracle, hashiFlow, limiter} →
// @facts        oracle.assertNoDivergence → privacy.decrypt → strategy.evaluate → routing.route →
// @facts        execution.apply → journal.record.
// @facts      ★ The limiter fed into `evaluate` is verify.deriveLimiter over the on-chain
// @facts        WithdrawalSigned stream — NEVER adapter.guardian.limiterStatus() (G5).
// @facts      ★ `reclaim` NEVER SUBMITS. `hashi::withdraw::cancel_withdrawal` is sender-bound to the
// @facts        depositor (docs/RECON.md R7.3) ⇒ a keeper-signed reclaim aborts on-chain. The command
// @facts        PRINTS the unsigned transaction bytes in BASE64 — exactly what the depositor's
// @facts        zkLogin session signs — and falls back to the unresolved JSON plan when object
// @facts        references cannot be resolved offline (ERRATA E-K7). No Signer is ever in scope.
// @facts      HASHI_ADAPTER defaults to `mock` ⇒ every command runs offline with zero live Hashi (G7).
// @facts      `assertRealModeComplete` fails fast, listing EVERY missing variable, before any live work.
// @facts      G6: nothing here blocks on a Bitcoin confirmation. `exit` returns as soon as the Sui
// @facts        PTB lands; settlement is polled out-of-band and the demo shows an earlier signet txid.
// @facts      ★ PUBLIC REPLAY SURFACE — the run loop and `verify/` MUST agree on the two contexts a
// @facts        replay needs, and both are derived from PUBLIC config so a tier-1 verifier holding no
// @facts        keys reproduces them exactly:
// @facts          rulesetContextFor(cfg)      tick/lot/minSize + withdrawal min + divergence bound
// @facts          routeContextFor(cfg, atMs)  expireTs = atMs + cfg.loop.makerTimeoutMs
// @facts                                      maxIocSats = cfg.deepbook.minSize * MAX_IOC_MULTIPLE
// @facts        `expireTs` therefore uses the PUBLIC cfg.loop.makerTimeoutMs, never the ENCRYPTED
// @facts        params.makerTimeoutMs — otherwise a public routing replay could never reproduce a
// @facts        maker order's expiry. params.makerTimeoutMs governs the loop's own re-quote window.
// @facts      ★ `replayFnsFor(cfg)` rebuilds the per-tick RouteContext from `book.atMs`, which IS
// @facts        journaled — `replaySegment` only carries ONE RouteContext, so without this the
// @facts        expireTs of every maker order would be reported as a mismatch.
// @implements export interface OptionSpec / CommandSpec / ParsedArgv / CommandContext
// @implements export const COMMANDS: readonly CommandSpec[]
// @implements export function parseArgv(argv: readonly string[]): ParsedArgv
// @implements export function findCommand(name: string): CommandSpec | undefined
// @implements export function usage(command?: CommandSpec): string
// @implements export function missingOptions(spec: CommandSpec, options: ParsedArgv['options']): readonly string[]
// @implements export function resolveEnv(cwd?: string): EnvRecord
// @implements export function rulesetContextFor(cfg: Config): RulesetContext
// @implements export function routeContextFor(cfg: Config, atMs: Millis): RouteContext
// @implements export function replayFnsFor(cfg: Config): ReplayFns
// @implements export function initialRunState(cfg: Config, opts: RunOptions, strategyBlobId: string): RunState
// @implements export async function runTick(cfg, opts, seams, watcher, state): Promise<TickResult>
// @implements export async function runLoop(cfg, opts, seams): Promise<RunReport>
// @implements export function createOfflineVenue(cfg: Config, opts?): OfflineVenue
// @implements export function offlineRunSeams(cfg, deps): RunSeams
// @implements export async function main(argv: readonly string[]): Promise<number>
// @ac         keeper/test/e2e.mock.test.ts — deposit → crank → sweep → run → exit → reclaim →
// @ac           verify, entirely on the mock's logical clock: byte-identical across two runs,
// @ac           reproduced by `verify` at BOTH tiers, zero `Date.now()` and zero `fetch`.
// @forbidden  printing a secret — KEEPER_KEY/OWNER_KEY/session keys never reach stdout (use redactSecrets)
// @forbidden  a `reclaim` path that signs or submits (G2 — see the @facts above)
// @forbidden  a hardcoded canonical id — everything arrives via ./config.ts (gates.ps1 ids)
// @forbidden  fabricating a transaction digest for a simulated execution — a simulated tick
//             journals `result: { skipped: 'offline-simulation' }`, never a digest
// @invariant  1. `parseArgv` / `usage` / `missingOptions` are PURE and independently testable.
// @invariant  2. Exit codes: 0 ok · 1 command failed (incl. not-yet-implemented) · 2 usage error.
// @invariant  3. `main` never throws — every failure becomes an exit code plus a stderr line.
// @invariant  4. Importing this module has NO side effects; it only runs when it IS the entrypoint.
// @invariant  5. `runTick` reads the clock ONLY through `seams.nowMs()` — never `Date.now()`. With
//                the mock adapter that clock is the mock's LOGICAL clock, so the loop is offline
//                and byte-reproducible (G6).
// @invariant  6. The `limiter` handed to `evaluate` and journaled is `limiterAt(deriveLimiter(...))`
//                over the event stream — never `adapter.guardian.limiterStatus()` (G5).
// @ac         docs/BUILD-PLAN.md T2.10 — `run --vault <ID>` executes the full loop against the MOCK
// @verify     node dist/index.js --help          (exit 0, prints every command)
// @verify     npm run build && npm run test -- e2e.mock
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Signer } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { Transaction } from '@mysten/sui/transactions';

import { assertRealModeComplete, loadConfig, type Config } from './config.js';
import { crank as runCrank, type CrankResult } from './execution/crank.js';
import { exit as executeExit } from './execution/exit.js';
import { buildReclaimTx } from './execution/reclaim.js';
import { sweep as executeSweep } from './execution/sweep.js';
import { apply as applyPlan, type TradeContext } from './execution/trade.js';
import { createHashiAdapter, type HashiAdapter } from './hashi/index.js';
import { createMockHashiAdapter, type MockHashiAdapter, type MockOptions } from './hashi/mock.js';
import { createWatcher, type FlowState, type Watcher } from './hashi/watcher.js';
import {
  appendRecord,
  buildRecord,
  isPublishDue,
  openSegment,
  publishSegment,
  type AnchorObjectRefs,
} from './journal/record.js';
import { GENESIS_SEQ, type DecisionSegment } from './journal/schema.js';
import { assertNoDivergence } from './oracle/divergence.js';
import {
  deepbookPriceToUsdFixed,
  tick as oracleTick,
  type OracleDeps,
  type OracleTick,
} from './oracle/index.js';
import type { PythPrice } from './oracle/pyth.js';
import { createTwapWindow, type TwapWindow } from './oracle/twap.js';
import { venueParams } from './routing/book.js';
import { assembleBook, type Level2Range } from './routing/deepbook.js';
import { route, type RouteContext } from './routing/route.js';
import { evaluate, type RulesetContext, type StrategyInputs } from './strategy/evaluate.js';
import {
  defaultParams,
  paramsFingerprint,
  validateParams,
  type StrategyParams,
} from './strategy/params.js';
import { rulesetHash } from './strategy/evaluate.js';
import { createSuiClient, type AnySuiClient } from './sui/client.js';
import type {
  Decision,
  Digest,
  LimiterSample,
  Millis,
  ObjectId,
  OrderId,
  Plan,
  Sats,
} from './types.js';
import { loadDotenvInto, type EnvRecord } from './util/env.js';
import { AphoticError, ConfigError } from './util/errors.js';
import { createRng } from './util/rng.js';
import {
  deriveLimiterFromAdapter,
  limiterAt,
  PUBLISHED_REPLAY_FNS,
  verifyVault,
  type ReplayFns,
  type UnrecordedInputs,
} from './verify/index.js';

/** Keep in sync with `keeper/package.json` — printed by `--version`. */
export const KEEPER_VERSION = '0.0.1';

// ─────────────────────────────────────────────────────────────────────────────
// Command table
// ─────────────────────────────────────────────────────────────────────────────

export interface OptionSpec {
  /** Long name, kebab-case, without the leading `--`. */
  readonly name: string;
  readonly kind: 'string' | 'boolean';
  readonly required?: boolean;
  /** Placeholder shown in usage, e.g. `<ID>`. */
  readonly value?: string;
  readonly describe: string;
}

export interface CommandSpec {
  readonly name: string;
  /** BUILD-PLAN task that implements this command's body. */
  readonly task: string;
  readonly summary: string;
  readonly options: readonly OptionSpec[];
  /** Extra lines printed under the command in `--help`. */
  readonly notes?: readonly string[];
}

export const COMMANDS: readonly CommandSpec[] = Object.freeze([
  {
    name: 'create-vault',
    task: 'T2.6',
    summary: 'Encrypt strategy params (Seal), store the ciphertext (Walrus), publish the vault.',
    options: [
      { name: 'strategy', kind: 'string', required: true, value: '<file>', describe: 'strategy parameter file (JSON)' },
      { name: 'keeper', kind: 'string', value: '<address>', describe: 'keeper address to delegate the TradeCap to' },
    ],
    notes: ['Delegates ONLY a DeepBook TradeCap to the keeper (G2).'],
  },
  {
    name: 'publish-strategy',
    task: 'T2.6',
    summary: 'Seal-encrypt a strategy file and put the CIPHERTEXT on Walrus. Prints the blob id.',
    options: [
      { name: 'strategy', kind: 'string', required: true, value: '<file>', describe: 'strategy parameter file (JSON)' },
      { name: 'vault', kind: 'string', value: '<ID>', describe: 'vault the Seal identity is namespaced to' },
      { name: 'epoch', kind: 'string', value: '<n>', describe: 'Seal version epoch (default SEAL_VERSION_EPOCH)' },
    ],
    notes: [
      'ENCRYPT BEFORE UPLOAD, always — Walrus blobs are public and permanently discoverable (G8).',
      'The identity is (vault object id ‖ version epoch); rotating the epoch invalidates old shares.',
    ],
  },
  {
    name: 'run',
    task: 'T2.10',
    summary: 'Main loop: watch -> evaluate -> route -> execute -> journal. Long-running.',
    options: [
      { name: 'vault', kind: 'string', required: true, value: '<ID>', describe: 'shared Vault object id' },
      { name: 'once', kind: 'boolean', describe: 'run a single tick and exit (CI/demo)' },
      { name: 'ticks', kind: 'string', value: '<n>', describe: 'stop after n ticks (default: unbounded)' },
      {
        name: 'offline',
        kind: 'boolean',
        describe: 'MOCK adapter + a simulated venue on a logical clock; opens no socket',
      },
    ],
    notes: [
      'The limiter input is the trustless replay, never the SDK hint (G5).',
      '--offline requires HASHI_ADAPTER=mock. Every simulated tick journals result.skipped, never a digest.',
    ],
  },
  {
    name: 'crank',
    task: 'T2.3',
    summary: 'Run the PERMISSIONLESS confirm_deposit for pending Hashi deposits.',
    options: [
      { name: 'all', kind: 'boolean', describe: 'crank every eligible deposit, not just this vault’s users' },
      { name: 'request', kind: 'string', value: '<id>', describe: 'crank one specific deposit request id' },
    ],
    notes: ['A public good: the mint destination is fixed in the UTXO derivation path (G2).'],
  },
  {
    name: 'sweep',
    task: 'T2.4',
    summary: 'Sponsored PTB: move freshly minted hBTC into vault shares (user needs no SUI).',
    options: [
      { name: 'deposit', kind: 'string', required: true, value: '<req>', describe: 'Hashi deposit request id' },
      { name: 'vault', kind: 'string', value: '<ID>', describe: 'target vault (defaults to VAULT_ID)' },
    ],
  },
  {
    name: 'exit',
    task: 'T2.5',
    summary: 'Burn shares -> gateway::exit_to_bitcoin to the ON-CHAIN-PINNED destination.',
    options: [
      { name: 'vault', kind: 'string', required: true, value: '<ID>', describe: 'shared Vault object id' },
      { name: 'shares', kind: 'string', required: true, value: '<n>', describe: 'shares to burn (sats-denominated)' },
    ],
    notes: [
      'The keeper never supplies a destination — Move reads the write-once pinned one (G2).',
      'Sub-30,000-sat exits are pooled on-chain, not submitted (G3).',
    ],
  },
  {
    name: 'reclaim',
    task: 'T2.5',
    summary: 'PRINT an unsigned reclaim PTB for a stalled exit. The DEPOSITOR signs it, never the keeper.',
    options: [
      { name: 'request', kind: 'string', required: true, value: '<id>', describe: 'stalled Hashi withdrawal request id' },
      { name: 'vault', kind: 'string', value: '<ID>', describe: 'vault holding the pooled/burned shares' },
      { name: 'depositor', kind: 'string', value: '<address>', describe: 'the depositor who must sign (tx sender)' },
      { name: 'mid', kind: 'string', value: '<px>', describe: 'DeepBook mid for the re-credit share math' },
    ],
    notes: ['cancel_withdrawal is sender-bound to the depositor — a keeper signature aborts (E-K7).'],
  },
  {
    name: 'verify',
    task: 'T4.3',
    summary: 'Replay journaled decisions; --limiter re-derives the Guardian bucket from on-chain events.',
    options: [
      { name: 'vault', kind: 'string', required: true, value: '<ID>', describe: 'shared Vault object id' },
      { name: 'from-epoch', kind: 'string', value: '<N>', describe: 'first journal segment sequence (default 0)' },
      { name: 'limiter', kind: 'boolean', describe: 'also re-derive + diff the limiter trajectory (G5)' },
    ],
    notes: ['Exits 0 only when every decision reproduces (A3/A10).'],
  },
]);

/** Boolean option names across every command + the globals — drives value-less flag parsing. */
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set<string>([
  'help',
  'version',
  ...COMMANDS.flatMap((c) => c.options.filter((o) => o.kind === 'boolean').map((o) => o.name)),
]);

// ─────────────────────────────────────────────────────────────────────────────
// Parsing (PURE)
// ─────────────────────────────────────────────────────────────────────────────

export interface ParsedArgv {
  readonly command?: string;
  readonly options: Readonly<Record<string, string | boolean>>;
  readonly positionals: readonly string[];
  readonly help: boolean;
  readonly version: boolean;
}

/**
 * Parse `--name value`, `--name=value`, bare boolean flags, `-h`, `-v` and `--`.
 * PURE — no env, no clock, no I/O.
 */
export function parseArgv(argv: readonly string[]): ParsedArgv {
  const options: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  let command: string | undefined;
  let terminated = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) continue;

    if (terminated) {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      terminated = true;
      continue;
    }

    if (token === '-h') {
      options['help'] = true;
      continue;
    }
    if (token === '-v') {
      options['version'] = true;
      continue;
    }

    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      if (eq > 0) {
        options[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      if (BOOLEAN_FLAGS.has(body)) {
        options[body] = true;
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        options[body] = next;
        i += 1;
      } else {
        options[body] = true;
      }
      continue;
    }

    if (command === undefined) command = token;
    else positionals.push(token);
  }

  return {
    ...(command === undefined ? {} : { command }),
    options,
    positionals,
    help: options['help'] === true,
    version: options['version'] === true,
  };
}

export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((c) => c.name === name);
}

/** Required options the caller did not supply. PURE. */
export function missingOptions(
  spec: CommandSpec,
  options: ParsedArgv['options'],
): readonly string[] {
  return spec.options
    .filter((o) => o.required === true)
    .filter((o) => {
      const v = options[o.name];
      return v === undefined || v === '' || v === true;
    })
    .map((o) => `--${o.name}`);
}

/** Usage text for one command, or the full table. PURE. */
export function usage(command?: CommandSpec): string {
  const lines: string[] = [];
  if (command === undefined) {
    lines.push('aphotic-keeper — Aphotic x Hashi keeper (DeepBook TradeCap only; exits are pinned in Move).');
    lines.push('');
    lines.push('USAGE');
    lines.push('  aphotic-keeper <command> [options]');
    lines.push('');
    lines.push('COMMANDS');
    // Width is derived, not hardcoded: adding a command must never misalign the table.
    const width = COMMANDS.reduce((w, c) => Math.max(w, c.name.length), 0);
    for (const c of COMMANDS) {
      lines.push(`  ${c.name.padEnd(width)}  ${c.summary}`);
    }
    lines.push('');
    lines.push('GLOBAL');
    lines.push('  -h, --help       show this help (or `<command> --help`)');
    lines.push('  -v, --version    print the keeper version');
    lines.push('');
    lines.push('ENVIRONMENT');
    lines.push('  HASHI_ADAPTER=mock (default) runs the entire keeper offline — no live Hashi.');
    lines.push('  All identifiers come from keeper/.env (see .env.example); none are compiled in.');
    return lines.join('\n');
  }

  const flags = command.options
    .map((o) => {
      const body = o.kind === 'boolean' ? `--${o.name}` : `--${o.name} ${o.value ?? '<value>'}`;
      return o.required === true ? body : `[${body}]`;
    })
    .join(' ');

  lines.push(`aphotic-keeper ${command.name} ${flags}`.trimEnd());
  lines.push('');
  lines.push(`  ${command.summary}`);
  lines.push(`  implemented by ${command.task}`);
  if (command.options.length > 0) {
    lines.push('');
    lines.push('OPTIONS');
    for (const o of command.options) {
      const body = o.kind === 'boolean' ? `--${o.name}` : `--${o.name} ${o.value ?? '<value>'}`;
      const req = o.required === true ? ' (required)' : '';
      lines.push(`  ${body.padEnd(24)} ${o.describe}${req}`);
    }
  }
  if (command.notes !== undefined && command.notes.length > 0) {
    lines.push('');
    lines.push('NOTES');
    for (const n of command.notes) lines.push(`  - ${n}`);
  }
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Environment
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `process.env` overlaid with `<cwd>/.env` (real variables win; the file only fills gaps).
 * A missing `.env` is normal — mock mode needs nothing set.
 */
export function resolveEnv(cwd: string = process.cwd()): EnvRecord {
  const env: Record<string, string | undefined> = { ...process.env };
  try {
    loadDotenvInto(env, readFileSync(resolve(cwd, '.env'), 'utf8'));
  } catch {
    // No .env — expected in CI and in mock mode.
  }
  return env;
}

// ─────────────────────────────────────────────────────────────────────────────
// The PUBLIC replay surface — one definition shared by `run` and `verify` (G5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `maxIocSats = cfg.deepbook.minSize * MAX_IOC_MULTIPLE`.
 *
 * A PUBLIC, config-derived bound on what one tick may cross for, so a tier-1 verifier holding no
 * keys rebuilds the identical `RouteContext`. 100 lots of the venue minimum = 0.1 BTC on the live
 * pool (min_size 100_000 sats).
 */
export const MAX_IOC_MULTIPLE = 100n;

/** Records per journal segment before it is flushed regardless of the lag window. */
export const DEFAULT_MAX_RECORDS_PER_SEGMENT = 64;

/** Venue constants + envelope bounds the pure `evaluate` needs. Config-derived (G7). */
export function rulesetContextFor(cfg: Config): RulesetContext {
  const venue = venueParams(cfg);
  return {
    tickSize: venue.tickSize,
    lotSize: venue.lotSize,
    minSize: venue.minSize,
    withdrawalMinimumSats: cfg.hashi.withdrawalMinimumSats,
    maxOracleDivergenceBps: cfg.pyth.divergenceBps,
  };
}

/**
 * The routing context for a tick taken at `atMs`.
 *
 * `expireTs` uses the PUBLIC `cfg.loop.makerTimeoutMs` deliberately — see the banner's PUBLIC
 * REPLAY SURFACE note. A verifier reading only the journal (which carries `book.atMs`) and the
 * public config reproduces this exactly.
 */
export function routeContextFor(cfg: Config, atMs: Millis): RouteContext {
  const venue = venueParams(cfg);
  return {
    tickSize: venue.tickSize,
    lotSize: venue.lotSize,
    minSize: venue.minSize,
    expireTs: atMs + cfg.loop.makerTimeoutMs,
    maxIocSats: venue.minSize * MAX_IOC_MULTIPLE,
  };
}

/**
 * Replay functions that rebuild the per-tick `RouteContext` from the journaled `book.atMs`.
 *
 * `replaySegment` carries ONE `RouteContext` for a whole segment, but `expireTs` moves with every
 * tick. Without this wrapper every maker order would be reported as an `expireTs` mismatch — a
 * logging artefact masquerading as a routing divergence.
 */
export function replayFnsFor(cfg: Config): ReplayFns {
  return {
    evaluate: PUBLISHED_REPLAY_FNS.evaluate,
    route: (decision, book, ctx) => PUBLISHED_REPLAY_FNS.route(decision, book, { ...ctx, ...routeContextFor(cfg, book.atMs) }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The run loop (T2.10)
// ─────────────────────────────────────────────────────────────────────────────

/** What one tick did on the venue. `skipped` is the honest outcome of a simulated/dry tick. */
export interface ExecOutcome {
  readonly result: { readonly digest: Digest } | { readonly skipped: string };
  /** Maker order ids still resting after this tick — the next tick's `cancels`. */
  readonly restingOrderIds: readonly OrderId[];
}

/** Vault-side inputs `evaluate` needs that live outside the Hashi event stream. */
export interface VaultSnapshot {
  /** Un-deployed hBTC the vault may quote against, in sats. */
  readonly idleHBtcSats: Sats;
  /** Exit demand already telegraphed to us (pooled + in-flight), in sats. */
  readonly pendingExitDemandSats: Sats;
}

/**
 * Every I/O edge of the loop, injected.
 *
 * With the MOCK adapter plus {@link offlineRunSeams} the whole set is satisfiable with zero
 * sockets and zero wall-clock reads (invariant 5) — which is exactly what the cut-line e2e test
 * exercises, using the same production loop the live keeper runs.
 */
export interface RunSeams {
  readonly hashi: HashiAdapter;
  /** The ONLY clock the loop reads (invariant 5). Mock ⇒ the mock's logical clock. */
  readonly nowMs: () => Millis;
  /** Advance to the next tick. Mock ⇒ advances the logical clock; never sleeps (G6). */
  readonly sleep: (ms: Millis) => Promise<void>;
  readonly readOracle: (nowMs: Millis, window: TwapWindow) => Promise<OracleTick>;
  /** Decrypted strategy parameters. Called once per tick; implementations should cache. */
  readonly loadParams: () => Promise<StrategyParams>;
  /** Blob id of the strategy VERSION in force — journaled, never the parameters (G8). */
  readonly strategyBlobId: string;
  readonly readVault: (nowMs: Millis, flow: FlowState) => Promise<VaultSnapshot>;
  readonly execute: (plan: Plan, ctx: TradeContext) => Promise<ExecOutcome>;
  /** Absent ⇒ segments are closed in memory and returned, never uploaded. */
  readonly publish?: (segment: DecisionSegment) => Promise<string>;
  /** Absent ⇒ the permissionless crank does not run inside the loop. */
  readonly crank?: (nowMs: Millis) => Promise<CrankResult>;
  readonly log: (line: string) => void;
}

export interface RunOptions {
  readonly vaultId: ObjectId;
  /** One tick, then stop. */
  readonly once?: boolean;
  /** Stop after this many ticks (including skipped ones). */
  readonly maxTicks?: number;
  /** Wall/logical ms between ticks. Defaults to `cfg.hashi.eventPollIntervalMs`. */
  readonly tickIntervalMs?: Millis;
  readonly maxRecordsPerSegment?: number;
  /** Prefix of the seeded jitter seed. Journaled inside `Decision.jitterSeed`. */
  readonly jitterSeedPrefix?: string;
  /** Stop the loop on the first tick that throws. Default: keep going, count it as skipped. */
  readonly stopOnError?: boolean;
}

export interface RunState {
  readonly window: TwapWindow;
  readonly segment: DecisionSegment;
  readonly closedSegments: readonly DecisionSegment[];
  readonly restingOrderIds: readonly OrderId[];
  readonly lastDecisionAtMs?: Millis;
  readonly ticks: number;
  readonly skipped: number;
}

export interface TickOutcome {
  readonly tickMs: Millis;
  readonly decision: Decision;
  readonly plan: Plan;
  readonly record: import('./types.js').DecisionRecord;
  readonly limiter: LimiterSample;
  readonly flow: FlowState;
  /** The `StrategyInputs` fields the journal does NOT carry — hand these to a tier-2 replay. */
  readonly unrecorded: UnrecordedInputs;
  readonly crank?: CrankResult;
  readonly publishedBlobId?: string;
}

export interface TickResult {
  readonly state: RunState;
  /** Absent ⇒ the tick produced no journal record; `skipReason` says why. */
  readonly outcome?: TickOutcome;
  readonly skipReason?: string;
}

export interface RunReport {
  readonly ticks: number;
  readonly skipped: number;
  readonly outcomes: readonly TickOutcome[];
  /** Every segment the run produced, closed ones first, the open one last if non-empty. */
  readonly segments: readonly DecisionSegment[];
  readonly state: RunState;
}

/** Fresh loop state: an empty TWAP window and journal segment `GENESIS_SEQ`. */
export function initialRunState(cfg: Config, opts: RunOptions, strategyBlobId: string): RunState {
  return {
    window: createTwapWindow(cfg.pyth.twapWindowMs),
    segment: openSegment({
      vaultId: opts.vaultId,
      seq: GENESIS_SEQ,
      strategyBlobId,
      ruleset: rulesetHash(),
    }),
    closedSegments: [],
    restingOrderIds: [],
    ticks: 0,
    skipped: 0,
  };
}

/**
 * ONE tick of docs/KEEPER.md §1.2.
 *
 *   watch → (crank) → deriveLimiter (G5) → oracle → assertNoDivergence → decrypt →
 *   evaluate → route → execute → journal
 *
 * Reads the clock only through `seams.nowMs()` (invariant 5) and takes its limiter reading only
 * from the trustless event replay (invariant 6).
 */
export async function runTick(
  cfg: Config,
  opts: RunOptions,
  seams: RunSeams,
  watcher: Watcher,
  state: RunState,
): Promise<TickResult> {
  const tickMs = seams.nowMs();

  // 1. WATCH — fold the public Hashi stream into the peg-flow accumulator.
  await watcher.poll();
  const flow = watcher.flow();

  // 2. CRANK — the permissionless public good, before we value anything (a confirm mints hBTC).
  const crankResult = seams.crank === undefined ? undefined : await seams.crank(tickMs);

  // 3. LIMITER — ★ G5: the TRUSTLESS replay over WithdrawalRequested/Picked/Signed/Cancelled.
  //    `guardian.limiterStatus()` is never consulted here; it is an unverified hint.
  const trajectory = await deriveLimiterFromAdapter(seams.hashi, { limiter: cfg.limiter });
  const limiter = limiterAt(trajectory, tickMs, { limiter: cfg.limiter });

  // 4. ORACLE — Pyth BETA + the DeepBook book/TWAP. Fails closed: no snapshot ⇒ no tick.
  let oracle: OracleTick;
  try {
    oracle = await seams.readOracle(tickMs, state.window);
    assertNoDivergence(cfg, oracle.snapshot, tickMs);
  } catch (error) {
    const reason = error instanceof AphoticError ? `${error.code}: ${error.message}` : String(error);
    seams.log(`tick ${tickMs} skipped — ${reason}`);
    return {
      state: { ...state, ticks: state.ticks + 1, skipped: state.skipped + 1 },
      skipReason: reason,
    };
  }

  // 5. DECRYPT — the plaintext lives only in this process's memory (G8).
  const params = await seams.loadParams();
  const vault = await seams.readVault(tickMs, flow);

  // 6. EVALUATE — pure, deterministic, seeded.
  const jitterSeed = `${opts.jitterSeedPrefix ?? 'aphotic'}:${opts.vaultId}:${tickMs}`;
  const unrecorded: UnrecordedInputs = {
    idleHBtcSats: vault.idleHBtcSats,
    pendingExitDemandSats: vault.pendingExitDemandSats,
    restingOrderIds: state.restingOrderIds,
    ...(state.lastDecisionAtMs === undefined ? {} : { lastDecisionAtMs: state.lastDecisionAtMs }),
  };
  const inputs: StrategyInputs = {
    book: oracle.book,
    oracle: oracle.snapshot,
    limiter,
    pendingMintSats: flow.pendingMintSats,
    pendingBurnSats: flow.pendingBurnSats,
    idleHBtcSats: unrecorded.idleHBtcSats,
    pendingExitDemandSats: unrecorded.pendingExitDemandSats,
    tickMs,
    jitterSeed,
    restingOrderIds: unrecorded.restingOrderIds,
    ...(unrecorded.lastDecisionAtMs === undefined ? {} : { lastDecisionAtMs: unrecorded.lastDecisionAtMs }),
  };
  const decision = evaluate(params, inputs, rulesetContextFor(cfg));

  // 7. ROUTE — maker POST_ONLY first, IOC residual on the SAME book (G4).
  const plan = route(decision, oracle.book, routeContextFor(cfg, tickMs));

  // 8. EXECUTE — TradeCap only (G2).
  const tradeCtx: TradeContext = {
    vaultId: opts.vaultId,
    keeperCapId: cfg.deepbook.tradeCapId,
    bookMid: oracle.book.mid,
    oracleMid: oracle.snapshot.deepbookMid,
    expireTs: tickMs + cfg.loop.makerTimeoutMs,
    pendingExitDemandSats: vault.pendingExitDemandSats,
    projectedCapacitySats: limiter.tokens,
  };
  const exec = await seams.execute(plan, tradeCtx);

  // 9. JOURNAL — every input `evaluate`/`route` consumed, so the tick is replayable (G5).
  const record = buildRecord({
    tickMs,
    oracle: oracle.snapshot,
    book: oracle.book,
    limiter,
    pendingMintSats: flow.pendingMintSats,
    pendingBurnSats: flow.pendingBurnSats,
    signedCursorSeq: watcher.cursor.seq,
    strategyBlobId: seams.strategyBlobId,
    ruleset: rulesetHash(),
    decision,
    plan,
    result: exec.result,
  });

  let segment = appendRecord(state.segment, record);
  let closed = state.closedSegments;
  let publishedBlobId: string | undefined;

  const maxRecords = opts.maxRecordsPerSegment ?? DEFAULT_MAX_RECORDS_PER_SEGMENT;
  if (isPublishDue(segment, tickMs, cfg.loop.logPublishLagMs, maxRecords)) {
    if (seams.publish !== undefined) {
      publishedBlobId = await seams.publish(segment);
      seams.log(`journal segment ${segment.meta.seq} published as ${publishedBlobId}`);
    } else {
      seams.log(
        `journal segment ${segment.meta.seq} closed with ${segment.records.length} record(s) — NOT published (no Walrus publisher configured)`,
      );
    }
    closed = [...closed, segment];
    segment = openSegment({
      vaultId: opts.vaultId,
      seq: segment.meta.seq + 1n,
      strategyBlobId: seams.strategyBlobId,
      ruleset: rulesetHash(),
    });
  }

  seams.log(
    `tick ${tickMs} ${decision.action}${decision.cause === undefined ? '' : ` (${decision.cause})`} ` +
      `bid ${decision.bidPx}x${decision.bidSz} ask ${decision.askPx}x${decision.askSz} ` +
      `maker ${plan.makerOrders.length} ioc ${plan.iocOrders.length} cancels ${plan.cancels.length} ` +
      `tokens ${limiter.tokens} queue ${limiter.queueDepth} ` +
      `-> ${'digest' in exec.result ? exec.result.digest : `skipped:${exec.result.skipped}`}`,
  );

  return {
    state: {
      ...state,
      window: oracle.window,
      segment,
      closedSegments: closed,
      restingOrderIds: exec.restingOrderIds,
      // A cooldown `noop` is not a decision: it must not push the cooldown window forward.
      lastDecisionAtMs: decision.action === 'noop' ? state.lastDecisionAtMs : tickMs,
      ticks: state.ticks + 1,
    },
    outcome: {
      tickMs,
      decision,
      plan,
      record,
      limiter,
      flow,
      unrecorded,
      ...(crankResult === undefined ? {} : { crank: crankResult }),
      ...(publishedBlobId === undefined ? {} : { publishedBlobId }),
    },
  };
}

/** Drive {@link runTick} until `--once` / `--ticks` says stop. */
export async function runLoop(cfg: Config, opts: RunOptions, seams: RunSeams): Promise<RunReport> {
  const watcher = createWatcher(seams.hashi);
  let state = initialRunState(cfg, opts, seams.strategyBlobId);
  const outcomes: TickOutcome[] = [];

  const maxTicks = opts.once === true ? 1 : (opts.maxTicks ?? Number.POSITIVE_INFINITY);
  const intervalMs = opts.tickIntervalMs ?? cfg.hashi.eventPollIntervalMs;

  for (let i = 0; i < maxTicks; i++) {
    if (i > 0) await seams.sleep(intervalMs);
    try {
      const result = await runTick(cfg, opts, seams, watcher, state);
      state = result.state;
      if (result.outcome !== undefined) outcomes.push(result.outcome);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      seams.log(`tick failed — ${reason}`);
      state = { ...state, ticks: state.ticks + 1, skipped: state.skipped + 1 };
      if (opts.stopOnError === true) throw error;
    }
  }

  const segments = [...state.closedSegments, ...(state.segment.records.length > 0 ? [state.segment] : [])];
  return { ticks: state.ticks, skipped: state.skipped, outcomes, segments, state };
}

// ─────────────────────────────────────────────────────────────────────────────
// The offline (simulated) venue — CI + demo. Opens no socket, reads no wall clock.
// ─────────────────────────────────────────────────────────────────────────────

export interface OfflineVenueOptions {
  /** Reference price, WHOLE USD per BTC. Aligned down to the venue tick. */
  readonly usdPerBtc?: bigint;
  /** Levels per side. */
  readonly levels?: number;
  /** Size of the top level, sats; level i carries `i * topLevelSats`. */
  readonly topLevelSats?: Sats;
}

export interface OfflineVenue {
  /** Drop-in for `RunSeams.readOracle` — runs the REAL `oracle.tick` over injected sources. */
  readOracle(nowMs: Millis, window: TwapWindow): Promise<OracleTick>;
  /** The raw DeepBook price the synthetic book is centred on. */
  readonly midDbPrice: bigint;
}

/**
 * The raw DeepBook price whose USD value is `usdPerBtc`, aligned DOWN to the venue tick.
 *
 * Inverse of `oracle/index.ts::deepbookPriceToUsdFixed`:
 *   usdFixed = dbPrice · 10^(2·bDec − qDec − 9)
 */
function dbPriceForUsd(cfg: Config, usdPerBtc: bigint): bigint {
  const exp = 2 * cfg.hashi.hbtcDecimals - cfg.deepbook.dbusdcDecimals - 9;
  const usdFixed = usdPerBtc * 10n ** BigInt(cfg.hashi.hbtcDecimals);
  const raw = exp >= 0 ? usdFixed / 10n ** BigInt(exp) : usdFixed * 10n ** BigInt(-exp);
  const tick = cfg.deepbook.tickSize;
  const aligned = (raw / tick) * tick;
  return aligned > 0n ? aligned : tick;
}

function syntheticRange(
  midDbPrice: bigint,
  tick: bigint,
  levels: number,
  topLevelSats: Sats,
  isBid: boolean,
): Level2Range {
  const prices: bigint[] = [];
  const quantities: Sats[] = [];
  for (let i = 1; i <= levels; i++) {
    const step = BigInt(i) * tick;
    const px = isBid ? midDbPrice - step : midDbPrice + step;
    if (px <= 0n) break;
    prices.push(px);
    quantities.push(topLevelSats * BigInt(i));
  }
  return { prices, quantities };
}

/**
 * A deterministic two-sided book + a Pyth reading that agrees with it exactly.
 *
 * ⚠ SIMULATED. This exists because (E-M7/R10) the live `Pool<hBTC,DBUSDC>` is empty on both sides
 * and Hermes is a network call — neither can drive an offline, deterministic e2e. It is wired
 * through the REAL `oracle.tick`, so staleness, TWAP and the divergence breaker are the production
 * code paths; only the two leaf sources are substituted.
 */
export function createOfflineVenue(cfg: Config, opts: OfflineVenueOptions = {}): OfflineVenue {
  const levels = opts.levels ?? 5;
  const topLevelSats = opts.topLevelSats ?? cfg.deepbook.minSize * 10n;
  const midDbPrice = dbPriceForUsd(cfg, opts.usdPerBtc ?? 100_000n);
  const usdFixed = deepbookPriceToUsdFixed(cfg, midDbPrice);
  let seq = 0n;

  return {
    midDbPrice,
    async readOracle(nowMs, window) {
      // `nowMs` is captured per read so the injected Pyth reading is always fresh at exactly the
      // tick instant — never a wall-clock read (invariant 5).
      const deps: OracleDeps = {
        cfg,
        deepbook: { cfg, client: undefined as unknown as AnySuiClient },
        readBookImpl: async (_d, o) =>
          assembleBook(
            cfg,
            syntheticRange(midDbPrice, cfg.deepbook.tickSize, levels, topLevelSats, true),
            syntheticRange(midDbPrice, cfg.deepbook.tickSize, levels, topLevelSats, false),
            o.atMs,
          ),
        fetchPriceImpl: async (): Promise<PythPrice> => {
          seq += 1n;
          // expo = −hbtcDecimals ⇒ scaleToSats() returns `usdFixed` unchanged, so the synthetic
          // Pyth reading and the synthetic DeepBook mid agree and the breaker measures 0 bps.
          return {
            px: usdFixed,
            conf: usdFixed / 10_000n,
            expo: -cfg.hashi.hbtcDecimals,
            publishTimeMs: nowMs,
            seq,
            feedId: cfg.pyth.btcUsdFeedId,
          };
        },
      };
      return oracleTick(deps, { nowMs, window });
    },
  };
}

export interface OfflineSeamOptions {
  readonly vaultId: ObjectId;
  readonly hashi: MockHashiAdapter;
  /** Signs the permissionless crank. The mock ignores it; `real` would not. */
  readonly signer?: Signer;
  readonly params?: StrategyParams;
  readonly venue?: OfflineVenueOptions;
  /** Address whose mock hBTC balance is treated as the vault's idle inventory. */
  readonly vaultBalanceAddress?: string;
  readonly log?: (line: string) => void;
  /** Run the permissionless crank inside the loop. Default true when a signer is supplied. */
  readonly crank?: boolean;
  /** Simulated maker order ids so the requote/cancel path is exercised. Default true. */
  readonly simulateOrderIds?: boolean;
}

/**
 * Seams that make the WHOLE loop run offline against the deterministic mock.
 *
 * Everything here is either the production module (oracle.tick, crank, evaluate, route, journal)
 * or an explicitly simulated leaf. A simulated execution NEVER fabricates a digest: it journals
 * `result: { skipped: 'offline-simulation' }`.
 */
export function offlineRunSeams(cfg: Config, opts: OfflineSeamOptions): RunSeams {
  if (cfg.hashi.adapter !== 'mock') {
    throw new ConfigError('offline run seams require HASHI_ADAPTER=mock (G7)', ['HASHI_ADAPTER']);
  }

  const mock = opts.hashi;
  const venue = createOfflineVenue(cfg, opts.venue ?? {});
  const params = opts.params ?? defaultParams(cfg);
  const strategyBlobId = `local-${paramsFingerprint(params)}`;
  const log = opts.log ?? ((line: string) => console.log(line));
  const balanceAddress = opts.vaultBalanceAddress ?? opts.vaultId;
  const orderRng = createRng(`aphotic-offline-orders:${opts.vaultId}`);
  const simulateOrderIds = opts.simulateOrderIds ?? true;
  const signer = opts.signer;
  const wantCrank = opts.crank ?? signer !== undefined;

  return {
    hashi: mock,
    strategyBlobId,
    nowMs: () => mock.nowMs(),
    // The mock advances a LOGICAL clock and never sleeps (G6) — this is what makes the loop
    // deterministic AND fast enough to be a unit test.
    sleep: async (ms) => {
      mock.advanceMs(ms);
    },
    readOracle: (nowMs, window) => venue.readOracle(nowMs, window),
    loadParams: async () => params,
    readVault: async (_nowMs, flow) => ({
      idleHBtcSats: await mock.view.balance(balanceAddress),
      pendingExitDemandSats: flow.pendingBurnSats,
    }),
    execute: async (plan) => {
      const resting: OrderId[] = [];
      if (simulateOrderIds) {
        // Simulated DeepBook order ids (u128 on-chain). Seeded, so a replay of the same run gets
        // the same ids and the requote/cancel path is reproducible.
        for (let i = 0; i < plan.makerOrders.length; i++) resting.push(orderRng.nextU64());
      }
      return { result: { skipped: 'offline-simulation' }, restingOrderIds: resting };
    },
    ...(wantCrank && signer !== undefined
      ? {
          crank: (nowMs: Millis) =>
            runCrank(
              { cfg, hashi: mock, client: undefined as unknown as AnySuiClient, signer },
              { all: true, nowMs, sleep: async () => undefined },
            ),
        }
      : {}),
    log,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch
// ─────────────────────────────────────────────────────────────────────────────

export interface CommandContext {
  readonly cfg: Config;
  readonly options: ParsedArgv['options'];
  readonly positionals: readonly string[];
}

type Handler = (ctx: CommandContext) => Promise<void>;

function str(ctx: CommandContext, name: string): string | undefined {
  const v = ctx.options[name];
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function flag(ctx: CommandContext, name: string): boolean {
  return ctx.options[name] === true;
}

function requireStr(ctx: CommandContext, name: string): string {
  const v = str(ctx, name);
  if (v === undefined) throw new ConfigError(`--${name} is required`, []);
  return v;
}

function requireSats(ctx: CommandContext, name: string): Sats {
  const raw = requireStr(ctx, name);
  if (!/^\d+$/.test(raw)) {
    throw new ConfigError(`--${name} must be a non-negative integer in sats — got ${JSON.stringify(raw)}`, []);
  }
  return BigInt(raw);
}

/**
 * A signer for `role`.
 *
 * In `mock` mode a missing key yields a DETERMINISTIC dev keypair: the mock ignores the signer
 * entirely, and refusing to run offline would defeat G7. In `real` mode a missing key is fatal —
 * `assertRealModeComplete` has already said so, and this is the backstop.
 */
function signerFor(cfg: Config, role: 'keeper' | 'owner'): Signer {
  const key = role === 'keeper' ? cfg.secrets.keeperKey : cfg.secrets.ownerKey;
  if (key !== undefined && key !== '') return Ed25519Keypair.fromSecretKey(key);
  if (cfg.hashi.adapter === 'mock') {
    // Deterministic and clearly labelled: byte n of the secret is the role's ordinal.
    return Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(role === 'keeper' ? 1 : 2));
  }
  throw new ConfigError(
    `${role === 'keeper' ? 'KEEPER_KEY' : 'OWNER_KEY'} is not set — required to sign in real mode`,
    [role === 'keeper' ? 'KEEPER_KEY' : 'OWNER_KEY'],
  );
}

function requireVault(cfg: Config, ctx: CommandContext): ObjectId {
  const vaultId = str(ctx, 'vault') ?? cfg.aphotic.vaultId;
  if (vaultId === '') throw new ConfigError('no vault: pass --vault <ID> or set VAULT_ID', ['VAULT_ID']);
  return vaultId;
}

/**
 * The DeepBook mid the share math is valued at (G9 — never raw Pyth).
 *
 * ⚠ E-M7/R10: the live pool is empty on both sides, so this legitimately fails today. Refusing is
 * the correct behaviour — a vault valued at a guessed mid is worse than a vault that will not move.
 */
function requireMid(ctx: CommandContext): bigint {
  const raw = str(ctx, 'mid');
  if (raw === undefined || !/^\d+$/.test(raw) || BigInt(raw) <= 0n) {
    throw new AphoticError(
      'NoBookMid',
      'a DeepBook mid is required to value shares (G9). The live Pool<hBTC,DBUSDC> is empty on ' +
        'both sides (E-M7), so `pool::mid_price` aborts and `get_level2_range` returns ([], []). ' +
        'Pass --mid <raw DeepBook price> once the book is two-sided.',
    );
  }
  return BigInt(raw);
}

/**
 * Read + VALIDATE an operator strategy file.
 *
 * `"50000000n"` decodes to a bigint so a sats field survives JSON without becoming a `number`
 * (G10: money is never `number`). `validateParams` is the trust boundary and rejects anything
 * partial, non-finite or venue-illegal before a single byte is encrypted.
 */
function loadStrategyFile(ctx: CommandContext): StrategyParams {
  const file = requireStr(ctx, 'strategy');
  const raw: unknown = JSON.parse(readFileSync(resolve(file), 'utf8'), (_k, v: unknown) =>
    typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v,
  );
  console.log(`strategy file      ${resolve(file)}`);
  return validateParams(raw as StrategyParams, ctx.cfg);
}

/**
 * Encrypt then upload. `requireSealBackend` throws a ConfigError naming exactly what is missing
 * (E-K12: `@mysten/seal` is not an installed dependency), which is the actionable failure — never
 * a silent plaintext fallback.
 */
async function sealAndPut(ctx: CommandContext, params: StrategyParams): Promise<string> {
  const vaultId = str(ctx, 'vault') ?? ctx.cfg.aphotic.vaultId;
  const epochRaw = str(ctx, 'epoch');
  const versionEpoch =
    epochRaw !== undefined && /^\d+$/.test(epochRaw) ? Number(epochRaw) : ctx.cfg.seal.versionEpoch;
  const { publishStrategy } = await import('./privacy/seal.js');
  const { blobId } = await publishStrategy(
    { cfg: ctx.cfg, client: createSuiClient(ctx.cfg) },
    params,
    { vaultId, versionEpoch },
  );
  return blobId;
}

/** The `client` slot of `Transaction.build` — named so the injection below stays one line. */
type TxBuildClient = NonNullable<Parameters<Transaction['build']>[0]>['client'];

const HANDLERS: Readonly<Record<string, Handler>> = {
  /**
   * Validate + fingerprint the operator's strategy file, then Seal-encrypt it and put the
   * ciphertext on Walrus (T2.6 `privacy/seal.ts`). Publishing the Vault object itself is an
   * on-chain step that belongs to T1.1 + the deploy scripts; this command produces the blob id
   * that step consumes.
   */
  'create-vault': async (ctx) => {
    const params = loadStrategyFile(ctx);

    console.log(`params fingerprint ${paramsFingerprint(params)}`);
    console.log(`ruleset            ${rulesetHash()}`);
    const delegate = str(ctx, 'keeper') ?? (ctx.cfg.sui.keeperAddress === '' ? '(unset)' : ctx.cfg.sui.keeperAddress);
    console.log(`keeper delegate    ${delegate} — TradeCap ONLY (G2)`);

    const blobId = await sealAndPut(ctx, params);
    console.log(`strategy blob      ${blobId}`);
    console.log('next: pass this blob id to `aphotic::vault::create_vault` (deploy script / T1.1).');
  },

  /**
   * Seal-encrypt the operator's strategy file and put the CIPHERTEXT on Walrus (T2.6).
   *
   * The plaintext never reaches the store: `privacy/seal.ts::publishStrategy` encrypts first, and
   * `storage/walrus.ts` refuses an unencrypted strategy payload outright (G8).
   */
  'publish-strategy': async (ctx) => {
    const params = loadStrategyFile(ctx);
    console.log(`params fingerprint ${paramsFingerprint(params)}`);
    const blobId = await sealAndPut(ctx, params);
    console.log(`strategy blob      ${blobId}`);
  },

  run: async (ctx) => {
    const vaultId = requireVault(ctx.cfg, ctx);
    const offline = flag(ctx, 'offline');
    const ticksRaw = str(ctx, 'ticks');
    const opts: RunOptions = {
      vaultId,
      ...(flag(ctx, 'once') ? { once: true } : {}),
      ...(ticksRaw !== undefined && /^\d+$/.test(ticksRaw) ? { maxTicks: Number(ticksRaw) } : {}),
    };

    if (offline) {
      if (ctx.cfg.hashi.adapter !== 'mock') {
        throw new ConfigError('--offline requires HASHI_ADAPTER=mock (G7)', ['HASHI_ADAPTER']);
      }
      const mock = createMockHashiAdapter(ctx.cfg);
      const seams = offlineRunSeams(ctx.cfg, {
        vaultId,
        hashi: mock,
        signer: signerFor(ctx.cfg, 'keeper'),
      });
      console.log('run: OFFLINE — mock Hashi, simulated venue, logical clock. No socket is opened.');
      const report = await runLoop(ctx.cfg, { ...opts, maxTicks: opts.maxTicks ?? 8 }, seams);
      console.log(
        `run: ${report.ticks} tick(s), ${report.skipped} skipped, ${report.segments.length} journal segment(s)`,
      );
      return;
    }

    const seams = await liveRunSeams(ctx.cfg, vaultId);
    const report = await runLoop(ctx.cfg, opts, seams);
    console.log(`run: ${report.ticks} tick(s), ${report.skipped} skipped`);
  },

  crank: async (ctx) => {
    const hashi = createHashiAdapter(ctx.cfg);
    const requestId = str(ctx, 'request');
    const result = await runCrank(
      { cfg: ctx.cfg, hashi, client: createSuiClient(ctx.cfg), signer: signerFor(ctx.cfg, 'keeper') },
      {
        nowMs: nowMsFor(hashi),
        ...(requestId === undefined ? { all: flag(ctx, 'all') } : { requestIds: [requestId] }),
      },
    );
    console.log(`crank: attempted ${result.attempted}`);
    for (const o of result.outcomes) {
      console.log(`  ${o.requestId}  ${o.status}${o.digest === undefined ? '' : `  ${o.digest}`}${o.reason === undefined ? '' : `  (${o.reason})`}`);
    }
    if (result.outcomes.some((o) => o.status === 'failed')) {
      throw new AphoticError('CrankPartialFailure', 'at least one deposit failed to confirm — see above');
    }
  },

  /**
   * Sponsored sweep. TWO signatures over the SAME bytes: the depositor's (they own the coins and
   * the shares) and the sponsor's (they own the gas). The keeper is only ever the sponsor (G2), so
   * without a depositor key there is nothing here to sign and we say so.
   */
  sweep: async (ctx) => {
    const vaultId = requireVault(ctx.cfg, ctx);
    const depositRequestId = requireStr(ctx, 'deposit');
    const depositor = signerFor(ctx.cfg, 'owner');
    const sponsor = signerFor(ctx.cfg, 'keeper');
    const result = await executeSweep(
      { cfg: ctx.cfg, client: createSuiClient(ctx.cfg), sponsor, depositor },
      {
        vaultId,
        depositRequestId,
        recipient: depositor.toSuiAddress(),
        bookMid: requireMid(ctx),
      },
    );
    console.log(`sweep: ${result.digest}`);
    console.log(`  swept  ${result.sweptSats} sats`);
    console.log(`  shares ${result.sharesMinted} to ${result.recipient}`);
  },

  exit: async (ctx) => {
    const vaultId = requireVault(ctx.cfg, ctx);
    const shares = requireSats(ctx, 'shares');
    const hashi = createHashiAdapter(ctx.cfg);
    const result = await executeExit(
      { cfg: ctx.cfg, client: createSuiClient(ctx.cfg), hashi, signer: signerFor(ctx.cfg, 'keeper') },
      { vaultId, sharesToBurn: shares, bookMid: requireMid(ctx) },
    );
    console.log(`exit: ${result.digest}`);
    console.log(`  sats   ${result.sats}`);
    console.log(
      result.pooled
        ? '  POOLED on-chain — below the 30,000-sat bridge minimum, so nothing was submitted (G3).'
        : `  request ${result.requestId ?? '(not yet joined)'} — settlement is ~1.5-2 h (G6), never live-demoed.`,
    );
  },

  /**
   * ★ PRINTS an unsigned PTB and stops. `hashi::withdraw::cancel_withdrawal` asserts
   * `request.sender == ctx.sender()`, so a keeper signature over these bytes aborts on-chain by
   * design (E-K7). This handler must never sign or submit.
   */
  reclaim: async (ctx) => {
    const vaultId = requireVault(ctx.cfg, ctx);
    const hashiRequestId = requireStr(ctx, 'request');
    const depositor = str(ctx, 'depositor');
    if (depositor === undefined) {
      throw new ConfigError('--depositor <address> is required: the PTB sender must be the depositor (G2)', []);
    }
    const tx = buildReclaimTx(ctx.cfg, {
      vaultId,
      hashiRequestId,
      depositor,
      bookMid: requireMid(ctx),
    });
    console.log('reclaim: UNSIGNED PTB — hand this to the depositor. The keeper can never sign it (G2/E-K7).');
    console.log(`  sender ${depositor}`);

    // The deliverable is the SIGNABLE bytes. Building them resolves the shared-object references,
    // which needs a node; when that is unavailable we print the unresolved plan instead of
    // pretending. Either way nothing here signs or submits (invariant: no Signer is in scope).
    try {
      const bytes = await tx.build({ client: createSuiClient(ctx.cfg) as unknown as TxBuildClient });
      console.log('  transactionBlockBytes (base64) — the depositor signs EXACTLY these bytes:');
      console.log(Buffer.from(bytes).toString('base64'));
    } catch (error) {
      // Two honest causes, both worth seeing verbatim: no node reachable, or the chain itself
      // refusing the reclaim (e.g. `assert_reclaim_caller` — the request is not this depositor's,
      // or it is past the pre-commit window). Neither is papered over.
      console.log(
        `  could not build the signable bytes: ${error instanceof Error ? error.message : String(error)}`,
      );
      console.log('  unsigned PTB, JSON form — build + sign it in the depositor’s zkLogin session:');
      console.log(await tx.toJSON());
    }
  },

  verify: async (ctx) => {
    const vaultId = requireVault(ctx.cfg, ctx);
    const fromRaw = str(ctx, 'from-epoch');
    const fromSeq = fromRaw !== undefined && /^\d+$/.test(fromRaw) ? BigInt(fromRaw) : 0n;
    const result = await verifyVault(
      { cfg: ctx.cfg, client: createSuiClient(ctx.cfg), hashi: createHashiAdapter(ctx.cfg) },
      {
        vaultId,
        fromSeq,
        ...(flag(ctx, 'limiter') ? { withLimiter: true } : {}),
        replay: {
          ruleset: rulesetContextFor(ctx.cfg),
          route: routeContextFor(ctx.cfg, 0),
          fns: replayFnsFor(ctx.cfg),
        },
      },
    );
    console.log(`verify: tier ${result.tier} · ${result.segments} segment(s) · ${result.ticks} tick(s)`);
    for (const f of result.failures) console.log(`  UNFETCHABLE seq ${f.seq} (${f.blobId}): ${f.reason}`);
    for (const m of result.mismatches) {
      console.log(`  MISMATCH tick ${m.tickMs} [${m.tier}] ${m.field}: expected ${m.expected}, got ${m.actual}`);
    }
    if (!result.reproduced) {
      throw new AphoticError('VerifyFailed', `${result.mismatches.length} mismatch(es), ${result.failures.length} unfetchable segment(s)`);
    }
    console.log('verify: REPRODUCED — every decision replays from the journal.');
  },
};

/** Logical clock for the mock, wall clock for everything else. */
function nowMsFor(hashi: HashiAdapter): Millis {
  return hashi.kind === 'mock' ? (hashi as MockHashiAdapter).nowMs() : Date.now();
}

/**
 * Live seams: real transports for the oracle and the venue, real Walrus journaling.
 *
 * ⚠ Two honest gaps, both surfaced rather than papered over:
 *   - `readVault` reads the hBTC balance of the vault ADDRESS. A shared `Vault` object holds a
 *     `Balance<BTC>` inside itself, not `Coin<BTC>` objects, so this reads 0 until the vault-state
 *     read lands with T1.1/T3.x — the loop then quotes nothing, which is the safe direction.
 *   - `execute` refuses unless `APHOTIC_PACKAGE_ID` and `TRADE_CAP_ID` are set; a plan is skipped,
 *     never silently "succeeded".
 */
async function liveRunSeams(cfg: Config, vaultId: ObjectId): Promise<RunSeams> {
  const hashi = createHashiAdapter(cfg);
  const client = createSuiClient(cfg);
  const signer = signerFor(cfg, 'keeper');
  const params = defaultParams(cfg);
  const canTrade = cfg.aphotic.packageId !== '' && cfg.deepbook.tradeCapId !== '';
  const canPublish = cfg.walrus.publisher !== '' && cfg.aphotic.packageId !== '';

  const refs: AnchorObjectRefs = {
    vaultId,
    journalCursorId: '',
    keeperCapId: cfg.deepbook.tradeCapId,
  };

  return {
    hashi,
    strategyBlobId: `local-${paramsFingerprint(params)}`,
    nowMs: () => Date.now(),
    sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
    readOracle: (nowMs, window) => oracleTick({ cfg, deepbook: { cfg, client } }, { nowMs, window }),
    loadParams: async () => params,
    readVault: async (_nowMs, flow) => ({
      idleHBtcSats: await hashi.view.balance(vaultId),
      pendingExitDemandSats: flow.pendingBurnSats,
    }),
    execute: async (plan, tradeCtx) => {
      if (!canTrade) {
        return { result: { skipped: 'unpublished-package-or-no-tradecap' }, restingOrderIds: [] };
      }
      if (plan.makerOrders.length === 0 && plan.iocOrders.length === 0 && plan.cancels.length === 0) {
        return { result: { skipped: 'empty-plan' }, restingOrderIds: [] };
      }
      const applied = await applyPlan({ cfg, client, signer }, plan, tradeCtx);
      const resting = applied.outcomes
        .filter((o) => o.kind === 'maker' && o.orderId !== undefined)
        .map((o) => o.orderId as OrderId);
      return { result: { digest: applied.digest }, restingOrderIds: resting };
    },
    ...(canPublish
      ? {
          publish: async (segment: DecisionSegment) => {
            const published = await publishSegment({ cfg, client, signer, refs }, segment);
            return published.blobId;
          },
        }
      : {}),
    crank: (nowMs) => runCrank({ cfg, hashi, client, signer }, { all: true, nowMs }),
    log: (line) => console.log(line),
  };
}

/**
 * CLI entrypoint. Never throws (invariant 3).
 *
 * Exit codes: 0 ok · 1 command failed (including "not implemented yet") · 2 usage error.
 */
export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgv(argv);

  if (parsed.version) {
    console.log(KEEPER_VERSION);
    return 0;
  }

  if (parsed.command === undefined) {
    console.log(usage());
    return parsed.help ? 0 : 2;
  }

  const spec = findCommand(parsed.command);
  if (spec === undefined) {
    console.error(`aphotic-keeper: unknown command "${parsed.command}"`);
    console.error('');
    console.error(usage());
    return 2;
  }

  if (parsed.help) {
    console.log(usage(spec));
    return 0;
  }

  const missing = missingOptions(spec, parsed.options);
  if (missing.length > 0) {
    console.error(`aphotic-keeper ${spec.name}: missing required option(s): ${missing.join(', ')}`);
    console.error('');
    console.error(usage(spec));
    return 2;
  }

  let cfg: Config;
  try {
    cfg = loadConfig(resolveEnv());
    // Fails fast in `real` mode, listing EVERY missing variable in one throw. No-op under `mock`.
    assertRealModeComplete(cfg);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`aphotic-keeper: ${error.message}`);
      return 2;
    }
    console.error(`aphotic-keeper: ${String(error)}`);
    return 2;
  }

  const handler = HANDLERS[spec.name];
  if (handler === undefined) {
    console.error(`aphotic-keeper: no handler registered for "${spec.name}"`);
    return 1;
  }

  try {
    await handler({ cfg, options: parsed.options, positionals: parsed.positionals });
    return 0;
  } catch (error) {
    if (error instanceof AphoticError) {
      console.error(`aphotic-keeper ${spec.name}: ${error.message}`);
      return 1;
    }
    console.error(`aphotic-keeper ${spec.name}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

// ── entrypoint guard (invariant 4: importing this module has no side effects) ─
function isEntrypoint(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  try {
    return fileURLToPath(import.meta.url) === resolve(invoked);
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  void main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(`aphotic-keeper: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    },
  );
}

// Re-exported so `MockOptions` stays reachable from the package entrypoint for tooling/tests.
export type { MockOptions };
