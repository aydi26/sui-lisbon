// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.3, T0.6
// @phase      0
// @status     DONE
// @spec       docs/KEEPER.md §12 (env var table)
// @spec       docs/BUILD-PLAN.md#phase-0 (T0.6 config wiring proof)
// @rules      G7 G10
// @facts      NO zod / NO dotenv dependency — hand-rolled, zero-dep, auditable.
// @facts      Sui object/package ids are `0x` + 64 lowercase hex chars (32 bytes).
// @facts      A Move struct tag is `<0x…64hex>::<module>::<Name>[<…>]`.
// @implements export type EnvRecord = Readonly<Record<string, string | undefined>>
// @implements export function parseDotenv(text: string): Record<string, string>
// @implements export function loadDotenvInto(env, text): void
// @implements export function readString(env, key, fallback): string
// @implements export function readOptional(env, key): string | undefined
// @implements export function readEnum<T extends string>(env, key, allowed, fallback): T
// @implements export function readInt(env, key, fallback): number
// @implements export function readBigInt(env, key, fallback): bigint
// @implements export function readBool(env, key, fallback): boolean
// @implements export function readList(env, key, fallback): readonly string[]
// @implements export function readObjectId(env, key, fallback): string
// @implements export function readStructTag(env, key, fallback): string
// @implements export function readUrl(env, key, fallback): string
// @implements export function isObjectId(v: string): boolean
// @implements export function isStructTag(v: string): boolean
// @forbidden  printing/logging any value whose key contains KEY / SECRET / PRIVATE
// @invariant  1. Every reader throws ConfigError naming the offending variable.
// @invariant  2. Readers are pure functions of the passed EnvRecord (never touch process.env directly).
// @verify     npm test -- config
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { ConfigError } from './errors.js';

export type EnvRecord = Readonly<Record<string, string | undefined>>;

/** Keys whose values must never be printed, logged, journaled or serialized. */
export const SECRET_KEY_PATTERN = /(KEY|SECRET|MNEMONIC|SEED|PASSWORD|TOKEN)$/;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

/** `0x` + 64 lowercase hex chars. Sui addresses/object ids/package ids are always 32 bytes. */
const OBJECT_ID_RE = /^0x[0-9a-f]{64}$/;
/** `<pkg>::<module>::<Name>` with optional generic parameters. */
const STRUCT_TAG_RE = /^0x[0-9a-f]{1,64}::[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*(<.+>)?$/;

export function isObjectId(v: string): boolean {
  return OBJECT_ID_RE.test(v);
}

export function isStructTag(v: string): boolean {
  return STRUCT_TAG_RE.test(v);
}

/**
 * Minimal `.env` parser: `KEY=value`, `#` comments, optional `export ` prefix,
 * single/double quoted values (double quotes honour `\n`). Zero dependencies.
 */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1).replace(/\\n/g, '\n');
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/** Merge parsed `.env` text into a mutable env record WITHOUT overriding already-set variables. */
export function loadDotenvInto(env: Record<string, string | undefined>, text: string): void {
  for (const [key, value] of Object.entries(parseDotenv(text))) {
    if (env[key] === undefined || env[key] === '') env[key] = value;
  }
}

function raw(env: EnvRecord, key: string): string | undefined {
  const v = env[key];
  if (v === undefined) return undefined;
  const trimmed = v.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function readOptional(env: EnvRecord, key: string): string | undefined {
  return raw(env, key);
}

export function readString(env: EnvRecord, key: string, fallback: string): string {
  return raw(env, key) ?? fallback;
}

export function readEnum<const T extends string>(
  env: EnvRecord,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const v = raw(env, key);
  if (v === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(v)) {
    throw new ConfigError(`${key} must be one of ${allowed.join(' | ')} — got "${v}"`, [key]);
  }
  return v as T;
}

export function readInt(env: EnvRecord, key: string, fallback: number): number {
  const v = raw(env, key);
  if (v === undefined) return fallback;
  if (!/^-?\d+$/.test(v)) {
    throw new ConfigError(`${key} must be an integer — got "${v}"`, [key]);
  }
  const n = Number(v);
  if (!Number.isSafeInteger(n)) {
    throw new ConfigError(`${key} is not a safe integer: ${v}`, [key]);
  }
  return n;
}

export function readBigInt(env: EnvRecord, key: string, fallback: bigint): bigint {
  const v = raw(env, key);
  if (v === undefined) return fallback;
  if (!/^\d+$/.test(v.replace(/_/g, ''))) {
    throw new ConfigError(`${key} must be a non-negative integer (sats) — got "${v}"`, [key]);
  }
  return BigInt(v.replace(/_/g, ''));
}

export function readBool(env: EnvRecord, key: string, fallback: boolean): boolean {
  const v = raw(env, key);
  if (v === undefined) return fallback;
  const lowered = v.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(lowered)) return true;
  if (['0', 'false', 'no', 'off'].includes(lowered)) return false;
  throw new ConfigError(`${key} must be a boolean — got "${v}"`, [key]);
}

export function readList(env: EnvRecord, key: string, fallback: readonly string[]): readonly string[] {
  const v = raw(env, key);
  if (v === undefined) return fallback;
  return Object.freeze(
    v
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

export function readObjectId(env: EnvRecord, key: string, fallback: string): string {
  const v = raw(env, key) ?? fallback;
  if (v !== '' && !isObjectId(v)) {
    throw new ConfigError(`${key} must be 0x + 64 lowercase hex chars — got "${v}"`, [key]);
  }
  return v;
}

export function readStructTag(env: EnvRecord, key: string, fallback: string): string {
  const v = raw(env, key) ?? fallback;
  if (v !== '' && !isStructTag(v)) {
    throw new ConfigError(`${key} must be a Move struct tag <pkg>::<module>::<Name> — got "${v}"`, [key]);
  }
  return v;
}

export function readUrl(env: EnvRecord, key: string, fallback: string): string {
  const v = raw(env, key) ?? fallback;
  if (v === '') return v;
  try {
    // eslint-disable-next-line no-new
    new URL(v);
  } catch {
    throw new ConfigError(`${key} must be an absolute URL — got "${v}"`, [key]);
  }
  return v;
}
