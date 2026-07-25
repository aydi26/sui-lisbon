// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.3, T2.10
// @phase      2  [CUT-LINE CRITICAL]
// @status     PARTIAL   (argv parsing + usage + config loading are REAL; every command body is STUB)
// @spec       docs/KEEPER.md §1.2 (the seven CLI commands + the `run` pseudo-cycle)
// @spec       docs/BUILD-PLAN.md#phase-0 (T0.3 keeper scaffold) · #phase-2 (T2.10 e2e run loop)
// @rules      G2 G5 G6 G7 G8
// @depends    ./config.ts (T0.6) · ./util/env.ts · ./util/errors.ts · every layer under src/
// @facts      COMMANDS (docs/KEEPER.md §1.2), with the task that implements each body:
// @facts        create-vault --strategy <file>                        T2.6  (+ T1.1 on-chain)
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
// @facts        prints the unsigned PTB for the depositor's zkLogin session (ERRATA E-K7).
// @facts      HASHI_ADAPTER defaults to `mock` ⇒ every command runs offline with zero live Hashi (G7).
// @facts      `assertRealModeComplete` fails fast, listing EVERY missing variable, before any live work.
// @facts      G6: nothing here blocks on a Bitcoin confirmation. `exit` returns as soon as the Sui
// @facts        PTB lands; settlement is polled out-of-band and the demo shows an earlier signet txid.
// @implements export interface OptionSpec / CommandSpec / ParsedArgv / CommandContext
// @implements export const COMMANDS: readonly CommandSpec[]
// @implements export function parseArgv(argv: readonly string[]): ParsedArgv
// @implements export function findCommand(name: string): CommandSpec | undefined
// @implements export function usage(command?: CommandSpec): string
// @implements export function missingOptions(spec: CommandSpec, options: ParsedArgv['options']): readonly string[]
// @implements export function resolveEnv(cwd?: string): EnvRecord
// @implements export async function main(argv: readonly string[]): Promise<number>
// @forbidden  printing a secret — KEEPER_KEY/OWNER_KEY/session keys never reach stdout (use redactSecrets)
// @forbidden  a `reclaim` path that signs or submits (G2 — see the @facts above)
// @forbidden  a hardcoded canonical id — everything arrives via ./config.ts (gates.ps1 ids)
// @invariant  1. `parseArgv` / `usage` / `missingOptions` are PURE and independently testable.
// @invariant  2. Exit codes: 0 ok · 1 command failed (incl. not-yet-implemented) · 2 usage error.
// @invariant  3. `main` never throws — every failure becomes an exit code plus a stderr line.
// @invariant  4. Importing this module has NO side effects; it only runs when it IS the entrypoint.
// @ac         docs/BUILD-PLAN.md T2.10 — `run --vault <ID>` executes the full loop against the MOCK
// @verify     node dist/index.js --help          (exit 0, prints all seven commands)
// @verify     node dist/index.js crank           (exit 1, prints the TODO(T2.3) marker)
// @verify     npm run build && npm run test -- e2e.mock
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertRealModeComplete, loadConfig, type Config } from './config.js';
import { loadDotenvInto, type EnvRecord } from './util/env.js';
import { AphoticError, ConfigError, NotImplementedError } from './util/errors.js';

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
    name: 'run',
    task: 'T2.10',
    summary: 'Main loop: watch -> evaluate -> route -> execute -> journal. Long-running.',
    options: [
      { name: 'vault', kind: 'string', required: true, value: '<ID>', describe: 'shared Vault object id' },
      { name: 'once', kind: 'boolean', describe: 'run a single tick and exit (CI/demo)' },
    ],
    notes: ['The limiter input is the trustless replay, never the SDK hint (G5).'],
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
    for (const c of COMMANDS) {
      lines.push(`  ${c.name.padEnd(13)} ${c.summary}`);
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
// Dispatch
// ─────────────────────────────────────────────────────────────────────────────

export interface CommandContext {
  readonly cfg: Config;
  readonly options: ParsedArgv['options'];
  readonly positionals: readonly string[];
}

type Handler = (ctx: CommandContext) => Promise<void>;

const HANDLERS: Readonly<Record<string, Handler>> = {
  // TODO(T2.6): build params, Seal-encrypt, Walrus-put (explicit epochs), publish the Vault +
  //             BalanceManager, mint and delegate ONLY the TradeCap to the keeper (G2).
  'create-vault': async (_ctx) => {
    throw new NotImplementedError('create-vault', 'T2.6');
  },

  // TODO(T2.10): the run loop — watcher.poll -> oracle.read -> assertNoDivergence ->
  //              privacy.decrypt -> strategy.evaluate -> routing.route -> execution.apply ->
  //              journal.record. Limiter input = verify.deriveLimiter (G5), never the SDK hint.
  run: async (_ctx) => {
    throw new NotImplementedError('run', 'T2.10');
  },

  // TODO(T2.3): execution/crank.ts — selectCrankable + one PTB per eligible request; idempotent.
  crank: async (_ctx) => {
    throw new NotImplementedError('crank', 'T2.3');
  },

  // TODO(T2.4): execution/sweep.ts — sponsored PTB (sender = depositor, gas owner = sponsor).
  sweep: async (_ctx) => {
    throw new NotImplementedError('sweep', 'T2.4');
  },

  // TODO(T2.5): execution/exit.ts — ONE moveCall gateway::exit_to_bitcoin. No destination argument (G2).
  exit: async (_ctx) => {
    throw new NotImplementedError('exit', 'T2.5');
  },

  // TODO(T2.5): execution/reclaim.ts — PRINT the unsigned PTB (base64) for the depositor to sign.
  //             This handler must NEVER sign or submit (E-K7).
  reclaim: async (_ctx) => {
    throw new NotImplementedError('reclaim', 'T2.5');
  },

  // TODO(T4.3): verify/index.ts verifyVault — replay + optional trustless limiter re-derivation.
  verify: async (_ctx) => {
    throw new NotImplementedError('verify', 'T4.3');
  },
};

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
