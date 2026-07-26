#!/usr/bin/env node
// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       D4 / §2 "Measure, do not assume, the 5 M computation cap" — ops tooling
// @phase      ops  [BATCH-SIZE CRITICAL — MAX_BATCH_SIZE cannot be chosen without this]
// @status     DONE
// @spec       docs/DESIGN-V2.md §2 (the measured ceilings) · §5 (clearing) · §9 (sdk parity)
// @rules      G7 G8 G10
// @depends    keeper/.env → keeper/src/config.ts for APHOTIC_PACKAGE_ID (the ONLY id homes, G7)
// @depends    a PUBLISHED package that exports clearing::sort_step / clearing::price_step
// @facts      NONE OF THESE CEILINGS CAN BE RAISED BY PAYING MORE GAS. A bigger budget buys
// @facts        storage, never computation:
// @facts          max_gas_computation_bucket        = 5_000_000 computation units / tx
// @facts          object_runtime_max_num_store_entries = 1_000 Table entries / tx
// @facts          max_num_event_emit                = 1_024 events / tx
// @facts      ⚠ UNIT TRAP. devInspect returns `effects.gasUsed.computationCost` in MIST, which
// @facts        is (bucketed computation units × reference gas price). The 5 M cap is in UNITS.
// @facts        This script divides by suix_getReferenceGasPrice and compares UNITS, and prints
// @facts        both numbers so the conversion is auditable rather than assumed.
// @facts      ⚠ BUCKETING. Sui rounds computation up to the next bucket, so a measured value is
// @facts        an UPPER bound on the true cost and the deltas between small n are quantised.
// @facts        That is the conservative direction for a ceiling, and it is stated in the report.
// @facts      THRESHOLD = 3_500_000 units = 70% of the cap. Exceeding it at n=256 is the signal
// @facts        DESIGN-V2 §2 names: drop the default to 128 and split price_step into
// @facts        price_scan_step + alloc_step, both cursor-driven.
// @facts      RECON R1: the testnet fullnode is gRPC v2 ONLY (JSON-RPC → HTTP 404). devInspect
// @facts        here goes to the JSON-RPC MIRROR, which is what mirrors are for — probes.
// @implements resolvePackage()   — env → keeper/.env → keeper/src/config.ts, never a literal
// @implements buildOrders()      — deterministic synthetic n-order batches (seeded LCG)
// @implements resolveArguments() — SIGNATURE-DRIVEN: reads the normalized Move signature off
// @implements                      chain and fills each parameter, so this file does not have to
// @implements                      guess an ABI that has not landed yet
// @implements measure()          — devInspect + computationCost → units
// @implements writeReport()      — scripts/LIMITS.generated.md
// @forbidden  a canonical id literal in this file — G7, scripts/gates.ps1 `ids`
// @forbidden  any on-chain WRITE — devInspect only; this script never signs anything
// @forbidden  crashing when APHOTIC_PKG is unset or clearing.move has not landed — it must
// @forbidden    degrade with the reason stated and say plainly that NOTHING WAS MEASURED
// @invariant  1. Exit code is non-zero iff a MEASURED step exceeded the threshold.
// @invariant  2. An unmeasured run is never reported as a pass — it prints NOT MEASURED and
// @invariant     exits non-zero under --require-measurement (for CI).
// @invariant  3. Every number in the report came from a devInspect in this run.
// @invariant  4. The generated file says, in its own header, that docs/LIMITS.md is the
// @invariant     intended home and that this script does not own docs/.
// @ac         `node scripts/measure-clearing.mjs` exits 0 and explains itself with no package
// @ac         `node scripts/measure-clearing.mjs` writes scripts/LIMITS.generated.md
// @verify     node scripts/measure-clearing.mjs --help
// @verify     node scripts/measure-clearing.mjs
// @verify     powershell -NoProfile -File scripts/gates.ps1 ids
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);

// ─────────────────────────────────────────────────────────────────────────────
// The ceilings. Protocol constants, not our choices, and not raisable by paying.
// ─────────────────────────────────────────────────────────────────────────────
const MAX_GAS_COMPUTATION_BUCKET = 5_000_000;   // computation units per transaction
const MAX_STORE_ENTRIES = 1_000;                // object_runtime_max_num_store_entries
const MAX_EVENT_EMIT = 1_024;                   // max_num_event_emit
const THRESHOLD_UNITS = 3_500_000;              // 70% of the bucket — DESIGN-V2 §2

const DEFAULT_SIZES = [16, 32, 64, 128, 256, 384, 512];
const DEFAULT_FNS = ['sort_step', 'price_step'];
const DEFAULT_MODULE = 'clearing';
const OUT_FILE = join(HERE, 'LIMITS.generated.md');
const INTENDED_DEST = 'docs/LIMITS.md';

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (hit === undefined) return dflt;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
};

if (flag('help', false)) {
  console.log(`measure-clearing.mjs — measure the clearing computation ceiling (DESIGN-V2 §2)

  node scripts/measure-clearing.mjs [options]

  Builds synthetic n-order batches and devInspects clearing::sort_step and
  clearing::price_step for each n, converting computationCost (MIST) into
  computation UNITS so it can be compared against the 5 000 000 bucket cap.

  Nothing is signed. Nothing is written on chain.

  OPTIONS
    --sizes=16,32,64        override the n ladder (default ${DEFAULT_SIZES.join(',')})
    --budget=<n>            the cursor budget passed to a *_step (default = n)
    --tick=<n>              tick size for price candidates (default 1000000)
    --threshold=<units>     failure threshold (default ${THRESHOLD_UNITS} = 70% of the cap)
    --pkg=<0x..>            override the package id (else APHOTIC_PKG / keeper/.env / config.ts)
    --batch=<0x..>          shared Batch object id      (env APHOTIC_BATCH)
    --registry=<0x..>       shared BatchRegistry id     (env APHOTIC_BATCH_REGISTRY)
    --require-measurement   exit non-zero if nothing could be measured (for CI)
    --module=<name>         module to inspect (default ${DEFAULT_MODULE})
    --fns=a,b               functions to inspect (default ${DEFAULT_FNS.join(',')})
                            --module/--fns exist so the devInspect + unit-conversion
                            plumbing can be SMOKE-TESTED against any published pure
                            function before clearing.move lands. Measuring something
                            else is not measuring clearing; the report says which.
    --json                  machine-readable output
    --timeout=<ms>          RPC timeout (default 30000)
    --help                  this text

  EXIT
    0  every measured step is under the threshold, or nothing was measurable
       and --require-measurement was not passed (the reason is printed)
    1  a measured step exceeded the threshold, or --require-measurement and
       nothing was measurable
    2  a hard error (bad arguments)

  Writes ${OUT_FILE.replace(/\\/g, '/')}.
  The intended home is ${INTENDED_DEST}; this script does not own docs/, so it
  writes next to itself and says so. Copy it over when docs/ is quiet.`);
  process.exit(0);
}

const AS_JSON = flag('json', false) === true;
const REQUIRE_MEASUREMENT = flag('require-measurement', false) === true;
const TIMEOUT = Number(flag('timeout', 30000));
const THRESHOLD = Number(flag('threshold', THRESHOLD_UNITS));
const TICK = BigInt(String(flag('tick', '1000000')));
const BUDGET_OVERRIDE = flag('budget', null) === null ? null : Number(flag('budget'));
const SIZES = String(flag('sizes', DEFAULT_SIZES.join(',')))
  .split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
const CLEARING_MODULE = String(flag('module', DEFAULT_MODULE));
const TARGET_FNS = String(flag('fns', DEFAULT_FNS.join(','))).split(',').map((s) => s.trim()).filter(Boolean);
const IS_SMOKE_TEST = CLEARING_MODULE !== DEFAULT_MODULE || TARGET_FNS.join(',') !== DEFAULT_FNS.join(',');

if (!SIZES.length) { console.error('--sizes resolved to nothing'); process.exit(2); }
if (!TARGET_FNS.length) { console.error('--fns resolved to nothing'); process.exit(2); }

// ─────────────────────────────────────────────────────────────────────────────
// Config resolution. G7: this file holds NO canonical id. Same chain as
// scripts/seed-book.mjs — env → keeper/.env → keeper/src/config.ts.
// ─────────────────────────────────────────────────────────────────────────────
function parseDotEnv(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (v !== '') out[k] = v;
  }
  return out;
}

// ⚠ Strip comment lines FIRST — config.ts banners quote the same constant names with the id
// ELIDED to a few nibbles plus an ellipsis. The {60,} floor is a second, independent guard.
function scrapeConfigId(path, keys) {
  if (!existsSync(path)) return null;
  const src = readFileSync(path, 'utf8').split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  for (const k of keys) {
    const m = src.match(new RegExp(`\\b${k}\\b\\s*[:=]\\s*['"\`]?(0x[0-9a-fA-F]{60,})['"\`]?`));
    if (m) return m[1];
  }
  return null;
}

const DOTENV = parseDotEnv(join(REPO, 'keeper', '.env'));
const CFG_TS = join(REPO, 'keeper', 'src', 'config.ts');

function resolveId(cliFlag, envKeys, configKeys) {
  const cli = flag(cliFlag, null);
  if (typeof cli === 'string' && cli) return { value: cli, from: `--${cliFlag}` };
  for (const k of envKeys) {
    if (process.env[k]) return { value: process.env[k], from: `process env ${k}` };
  }
  for (const k of envKeys) {
    if (DOTENV[k]) return { value: DOTENV[k], from: `keeper/.env ${k}` };
  }
  const scraped = scrapeConfigId(CFG_TS, configKeys);
  if (scraped) return { value: scraped, from: `keeper/src/config.ts (${configKeys.join('/')})` };
  return { value: null, from: 'UNRESOLVED' };
}

const PKG = resolveId('pkg', ['APHOTIC_PKG', 'APHOTIC_PACKAGE_ID'], ['APHOTIC_PACKAGE_ID', 'aphoticPackageId']);
const BATCH = resolveId('batch', ['APHOTIC_BATCH', 'BATCH_ID'], ['batchId']);
const REGISTRY = resolveId('registry', ['APHOTIC_BATCH_REGISTRY', 'BATCH_REGISTRY_ID'], ['batchRegistryId']);

// ─────────────────────────────────────────────────────────────────────────────
// Transport — JSON-RPC mirrors only (RECON R1: the fullnode is gRPC-only)
// ─────────────────────────────────────────────────────────────────────────────
const MIRRORS = (() => {
  if (!existsSync(CFG_TS)) return ['https://rpc-testnet.suiscan.xyz:443'];
  const src = readFileSync(CFG_TS, 'utf8');
  const block = src.match(/suiJsonRpcMirrors\s*:\s*\[([\s\S]*?)\]/);
  const urls = block ? [...block[1].matchAll(/['"`](https?:\/\/[^'"`]+)['"`]/g)].map((m) => m[1]) : [];
  return urls.length ? urls : ['https://rpc-testnet.suiscan.xyz:443'];
})();

let activeRpc = null;
async function rpc(method, params) {
  const eps = activeRpc ? [activeRpc, ...MIRRORS.filter((m) => m !== activeRpc)] : MIRRORS;
  let last = 'no endpoint reachable';
  for (const url of eps) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(TIMEOUT),
      });
      if (!res.ok) { last = `${url} HTTP ${res.status}`; continue; }
      const json = await res.json();
      activeRpc = url;
      if (json.error) return { ok: false, err: typeof json.error === 'string' ? json.error : JSON.stringify(json.error).slice(0, 300) };
      return { ok: true, result: json.result };
    } catch (e) { last = `${url} ${e.message}`; }
  }
  return { ok: false, err: last };
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimal BCS writer — only what a read-only devInspect MoveCall needs.
// Same shape as scripts/seed-book.mjs and scripts/verify-onchain.mjs.
// ─────────────────────────────────────────────────────────────────────────────
const norm = (a) => String(a ?? '').replace(/^0x/i, '').toLowerCase().padStart(64, '0');
const ZERO_SENDER = '0x' + '0'.repeat(64);
const CLOCK_ID = '0x6';
const CLOCK_ISV = 1;

class BcsWriter {
  constructor() { this.b = []; }
  u8(n) { this.b.push(n & 0xff); return this; }
  bool(v) { return this.u8(v ? 1 : 0); }
  u16(n) { this.b.push(n & 0xff, (n >> 8) & 0xff); return this; }
  u32(n) { let v = n >>> 0; for (let i = 0; i < 4; i++) { this.b.push(v & 0xff); v >>>= 8; } return this; }
  u64(n) { let v = BigInt(n); for (let i = 0; i < 8; i++) { this.b.push(Number(v & 0xffn)); v >>= 8n; } return this; }
  uleb(n) { let v = n >>> 0; do { let x = v & 0x7f; v >>>= 7; if (v) x |= 0x80; this.b.push(x); } while (v); return this; }
  raw(a) { for (const x of a) this.b.push(x); return this; }
  vecU8(a) { this.uleb(a.length); return this.raw(a); }
  str(s) { return this.vecU8(Array.from(new TextEncoder().encode(s))); }
  addr(h) { const n = norm(h); for (let i = 0; i < 64; i += 2) this.b.push(parseInt(n.slice(i, i + 2), 16)); return this; }
  bytes() { return this.b.slice(); }
  base64() { return Buffer.from(Uint8Array.from(this.b)).toString('base64'); }
}

const sharedIn = (id, isv, mutable = false) => ({ kind: 'shared', id, isv, mutable });
const pureBytes = (bytes) => ({ kind: 'pure', bytes });
const pureU64 = (n) => pureBytes(new BcsWriter().u64(n).bytes());
const pureU8 = (n) => pureBytes([Number(n) & 0xff]);
const pureBool = (v) => pureBytes([v ? 1 : 0]);
const pureVecU8 = (arr) => pureBytes(new BcsWriter().vecU8(arr).bytes());

function buildMoveCall({ pkg, module, fn, typeArgs = [], inputs }) {
  const w = new BcsWriter();
  w.u8(0);
  w.uleb(inputs.length);
  for (const i of inputs) {
    if (i.kind === 'shared') w.u8(1).u8(1).addr(i.id).u64(i.isv).bool(i.mutable);
    else w.u8(0).vecU8(i.bytes);
  }
  w.uleb(1).u8(0);
  w.addr(pkg).str(module).str(fn);
  w.uleb(typeArgs.length);
  for (const t of typeArgs) {
    const a = t.indexOf('::'), b = t.lastIndexOf('::');
    w.u8(7).addr(t.slice(0, a)).str(t.slice(a + 2, b)).str(t.slice(b + 2)).uleb(0);
  }
  w.uleb(inputs.length);
  for (let i = 0; i < inputs.length; i++) w.u8(1).u16(i);
  return w.base64();
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic synthetic batches. Seeded LCG — no Math.random anywhere, so a
// re-run of this measurement produces the same orders and the same numbers.
// ─────────────────────────────────────────────────────────────────────────────
function lcg(seed) {
  let s = BigInt(seed) & 0xffffffffn;
  return () => { s = (s * 1664525n + 1013904223n) & 0xffffffffn; return Number(s); };
}

/**
 * n orders straddling a mid price, half bids half asks, with:
 *  - repeated limit prices (exercises the pro-rata + largest-remainder path)
 *  - repeated submitters (exercises the submitter-bytes tie-break)
 *  - a guaranteed cross (otherwise price_step short-circuits and measures nothing)
 * This is the WORST-CASE shape for sorting and price discovery, which is the only
 * shape a ceiling may be derived from.
 */
function buildOrders(n, tick) {
  const rnd = lcg(0xA9107 + n);
  const mid = 100n * tick;
  const orders = [];
  for (let i = 0; i < n; i++) {
    const isBid = i % 2 === 0;
    // Levels repeat every ~8 orders so ties are dense, not incidental.
    const level = BigInt(rnd() % 8);
    const price = isBid ? mid + level * tick : mid - level * tick;   // guaranteed to cross
    const qty = BigInt(1000 + (rnd() % 64) * 1000);
    // 16 distinct submitters, so the submitter tie-break is exercised at every n.
    const who = '0x' + (rnd() % 16).toString(16).padStart(2, '0').repeat(32);
    orders.push({ submitter: who, price, qty, isBid, index: i });
  }
  return orders;
}

/** BCS `vector<Order>` with Order = { submitter: address, limit_price: u64, qty: u64, is_bid: bool }. */
function encodeOrders(orders) {
  const w = new BcsWriter();
  w.uleb(orders.length);
  for (const o of orders) w.addr(o.submitter).u64(o.price).u64(o.qty).bool(o.isBid);
  return w.bytes();
}

// ─────────────────────────────────────────────────────────────────────────────
// Signature-driven argument construction.
//
// clearing.move has not landed, so this file must not hardcode an ABI it cannot
// see. It reads the NORMALIZED signature off chain and fills each parameter from
// what it knows. A parameter it cannot fill is named in the report and the
// measurement degrades — it is never silently guessed.
// ─────────────────────────────────────────────────────────────────────────────
function typeName(t) {
  if (typeof t === 'string') return t;                              // "U64" | "Bool" | "Address"
  if (t && t.Reference) return `&${typeName(t.Reference)}`;
  if (t && t.MutableReference) return `&mut ${typeName(t.MutableReference)}`;
  if (t && t.Vector) return `vector<${typeName(t.Vector)}>`;
  if (t && t.Struct) return `${t.Struct.address}::${t.Struct.module}::${t.Struct.name}`;
  if (t && t.TypeParameter !== undefined) return `T${t.TypeParameter}`;
  return JSON.stringify(t);
}
const baseStructName = (t) => {
  const s = typeName(t).replace(/^&(mut )?/, '');
  const parts = s.split('::');
  return parts.length === 3 ? parts[2] : null;
};

const objectCache = new Map();
async function sharedRef(id, mutable) {
  if (!objectCache.has(id)) {
    const r = await rpc('sui_getObject', [id, { showOwner: true, showType: true }]);
    objectCache.set(id, r.ok ? r.result?.data ?? null : null);
  }
  const d = objectCache.get(id);
  const isv = d?.owner?.Shared?.initial_shared_version;
  if (isv === undefined || isv === null) return null;
  return sharedIn(id, Number(isv), mutable);
}

/**
 * Fill each declared parameter. `&TxContext` is dropped (it is implicit).
 * Returns { inputs } or { missing: [<param description>...] }.
 */
async function resolveArguments(params, ctx) {
  const inputs = [];
  const missing = [];
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    const name = typeName(p);
    if (/TxContext$/.test(name)) continue;                          // implicit, never an input
    const mutable = !!p?.MutableReference;
    const struct = baseStructName(p);

    if (name === 'U64') { inputs.push(pureU64(ctx.nextU64())); continue; }
    if (name === 'U8') { inputs.push(pureU8(ctx.nextU64())); continue; }
    if (name === 'Bool') { inputs.push(pureBool(true)); continue; }
    if (name === 'vector<U8>') { inputs.push(pureVecU8(ctx.ordersBcs)); continue; }

    if (struct === 'Clock') { inputs.push(sharedIn(CLOCK_ID, CLOCK_ISV, mutable)); continue; }
    if (struct === 'Batch' || struct === 'BatchState') {
      if (!BATCH.value) { missing.push(`#${i} ${name} — set APHOTIC_BATCH or --batch`); continue; }
      const r = await sharedRef(BATCH.value, mutable);
      if (!r) { missing.push(`#${i} ${name} — ${BATCH.value} is not a readable shared object`); continue; }
      inputs.push(r); continue;
    }
    if (struct === 'BatchRegistry') {
      if (!REGISTRY.value) { missing.push(`#${i} ${name} — set APHOTIC_BATCH_REGISTRY or --registry`); continue; }
      const r = await sharedRef(REGISTRY.value, mutable);
      if (!r) { missing.push(`#${i} ${name} — ${REGISTRY.value} is not a readable shared object`); continue; }
      inputs.push(r); continue;
    }
    missing.push(`#${i} ${name} — no resolver; extend resolveArguments()`);
  }
  return missing.length ? { missing } : { inputs };
}

const abortCode = (e) => { const m = /MoveAbort\(.*?,\s*(\d+)\)/.exec(String(e ?? '')); return m ? Number(m[1]) : null; };

async function measure(pkg, fn, params, ordersBcs, budget) {
  let u64Turn = 0;
  const ctx = {
    ordersBcs,
    nextU64: () => (u64Turn++ === 0 ? BigInt(budget) : TICK),      // 1st u64 = budget/cursor, 2nd = tick
  };
  const built = await resolveArguments(params, ctx);
  if (built.missing) return { ok: false, unmeasurable: built.missing.join(' · ') };

  const tx = buildMoveCall({ pkg, module: CLEARING_MODULE, fn, inputs: built.inputs });
  const r = await rpc('sui_devInspectTransactionBlock', [ZERO_SENDER, tx, null, null]);
  if (!r.ok) return { ok: false, unmeasurable: `devInspect transport: ${r.err}` };

  const st = r.result?.effects?.status;
  const gas = r.result?.effects?.gasUsed;
  const computationCost = gas ? BigInt(gas.computationCost) : null;
  if (st?.status !== 'success') {
    // A MoveAbort still consumed and reported computation, so it is still a real
    // measurement — but say so, because an aborting path may be a SHORTER path.
    return {
      ok: computationCost !== null,
      aborted: true,
      abortCode: abortCode(st?.error),
      err: String(st?.error).slice(0, 200),
      computationCost,
    };
  }
  return { ok: true, aborted: false, computationCost };
}

// ─────────────────────────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────────────────────────
const LINES = [];
const say = (s = '') => { if (!AS_JSON) console.log(s); LINES.push(s); };
const h1 = (s) => { say(); say(s); say('─'.repeat(Math.max(20, s.length))); };
const fmt = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US'));

function writeReport(rows, meta) {
  const md = [];
  md.push('# LIMITS — measured clearing ceilings');
  md.push('');
  md.push('> GENERATED by `scripts/measure-clearing.mjs`. Do not edit by hand.');
  md.push('>');
  md.push(`> **Intended home: \`${INTENDED_DEST}\`.** The generator does not own \`docs/\`, so it writes`);
  md.push('> next to itself. Copy this file over when `docs/` is not being rewritten concurrently.');
  md.push('');
  if (IS_SMOKE_TEST) {
    md.push(`> ## ⚠⚠ SMOKE TEST — target is \`${CLEARING_MODULE}::{${TARGET_FNS.join(', ')}}\`, NOT`);
    md.push(`> \`${DEFAULT_MODULE}::{${DEFAULT_FNS.join(', ')}}\`. These numbers prove the measurement`);
    md.push('> plumbing works. They do NOT measure clearing and must not justify `MAX_BATCH_SIZE`.');
    md.push('');
  }
  md.push(`- generated: ${meta.generatedAt}`);
  md.push(`- target: \`${CLEARING_MODULE}::{${TARGET_FNS.join(', ')}}\`${IS_SMOKE_TEST ? '  ⚠ SMOKE TEST' : ''}`);
  md.push(`- package: \`${meta.pkg ?? 'UNRESOLVED'}\`${meta.pkgFrom ? ` (from: ${meta.pkgFrom})` : ''}`);
  md.push(`- endpoint: ${meta.rpc ?? 'none reached'}`);
  md.push(`- reference gas price: ${fmt(meta.gasPrice)} MIST/unit`);
  md.push(`- threshold: ${fmt(meta.threshold)} units (70% of the ${fmt(MAX_GAS_COMPUTATION_BUCKET)} bucket cap)`);
  md.push('');
  md.push('## The ceilings, and why paying more does not move them');
  md.push('');
  md.push('| Limit | Value | Raisable by a bigger gas budget? |');
  md.push('|---|---:|---|');
  md.push(`| \`max_gas_computation_bucket\` | ${fmt(MAX_GAS_COMPUTATION_BUCKET)} units/tx | **No** — a bigger budget buys storage only |`);
  md.push(`| \`object_runtime_max_num_store_entries\` | ${fmt(MAX_STORE_ENTRIES)} /tx | **No** |`);
  md.push(`| \`max_num_event_emit\` | ${fmt(MAX_EVENT_EMIT)} /tx | **No** |`);
  md.push('');
  md.push('## Measurements');
  md.push('');
  if (!rows.length) {
    md.push('**NOTHING WAS MEASURED.**');
    md.push('');
    for (const r of meta.reasons) md.push(`- ${r}`);
  } else {
    md.push('| n | function | computationCost (MIST) | computation units | % of cap | verdict |');
    md.push('|---:|---|---:|---:|---:|---|');
    for (const r of rows) {
      const pct = r.units === null ? '—' : ((r.units / MAX_GAS_COMPUTATION_BUCKET) * 100).toFixed(1) + '%';
      md.push(`| ${r.n} | \`${r.fn}\` | ${fmt(r.computationCost)} | ${fmt(r.units)} | ${pct} | ${r.verdict} |`);
    }
    md.push('');
    md.push('⚠ Sui rounds computation up to the next bucket, so each figure is an **upper bound**');
    md.push('on the true cost and the deltas between adjacent small `n` are quantised. That is the');
    md.push('conservative direction for a ceiling.');
  }
  md.push('');
  md.push('## What to do if a step is over');
  md.push('');
  md.push('DESIGN-V2 §2: if `price_step` at n=256 exceeds the threshold, drop `MAX_BATCH_SIZE` to');
  md.push('128 and split `price_step` into `price_scan_step` + `alloc_step`, both cursor-driven.');
  md.push('The API must already anticipate that — `sort_step` and `settle_step` take a `budget` and');
  md.push('advance an on-chain cursor from day one, so this is a split, not a redesign.');
  md.push('');
  writeFileSync(OUT_FILE, md.join('\n') + '\n', 'utf8');
}

// ─────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  const reasons = [];
  const rows = [];
  let exitCode = 0;

  h1('CONFIG (resolved from env → keeper/.env → keeper/src/config.ts — no id literal lives in this file)');
  say(`  package                 ${PKG.value ?? 'UNRESOLVED'}  (${PKG.from})`);
  say(`  Batch object            ${BATCH.value ?? 'unset'}  (${BATCH.from})`);
  say(`  BatchRegistry           ${REGISTRY.value ?? 'unset'}  (${REGISTRY.from})`);
  say(`  n ladder                ${SIZES.join(', ')}`);
  say(`  threshold               ${fmt(THRESHOLD)} units (${((THRESHOLD / MAX_GAS_COMPUTATION_BUCKET) * 100).toFixed(0)}% of the ${fmt(MAX_GAS_COMPUTATION_BUCKET)} cap)`);
  say(`  target                  ${CLEARING_MODULE}::{${TARGET_FNS.join(', ')}}`);
  say('  mode                    devInspect only — nothing is signed, nothing is written');
  if (IS_SMOKE_TEST) {
    say('');
    say(`  ⚠⚠ SMOKE TEST — the target is NOT ${DEFAULT_MODULE}::{${DEFAULT_FNS.join(', ')}}.`);
    say('     This run proves the devInspect + unit-conversion plumbing works. It does NOT');
    say('     measure clearing and MUST NOT be used to justify MAX_BATCH_SIZE.');
  }

  h1('CEILINGS (none of these can be raised by paying more gas)');
  say(`  max_gas_computation_bucket            ${fmt(MAX_GAS_COMPUTATION_BUCKET)} units / tx  ← what this script measures`);
  say(`  object_runtime_max_num_store_entries  ${fmt(MAX_STORE_ENTRIES)} / tx        ← one Table entry per settle participant`);
  say(`  max_num_event_emit                    ${fmt(MAX_EVENT_EMIT)} / tx        ← 1 BatchSettled + 1 Filled per fill`);

  // ── preconditions ─────────────────────────────────────────────────────────
  h1('PRECONDITIONS');
  if (!PKG.value) {
    reasons.push('APHOTIC_PKG is unset and no package id could be resolved from keeper/.env or keeper/src/config.ts. Publish the package and set APHOTIC_PKG, or pass --pkg=0x…');
    say('  ✗ no package id — NOTHING CAN BE MEASURED');
  } else {
    say(`  ✓ package id resolved`);
  }

  let gasPrice = null;
  let fns = null;
  if (PKG.value) {
    const gp = await rpc('suix_getReferenceGasPrice', []);
    if (gp.ok) { gasPrice = Number(gp.result); say(`  ✓ reference gas price  ${fmt(gasPrice)} MIST/unit`); }
    else { reasons.push(`reference gas price unreadable (${gp.err}) — computationCost cannot be converted to UNITS, and the 5 M cap is in units`); say(`  ✗ reference gas price: ${gp.err}`); }

    const mod = await rpc('sui_getNormalizedMoveModule', [PKG.value, CLEARING_MODULE]);
    if (!mod.ok) {
      reasons.push(`the published package exposes no \`${CLEARING_MODULE}\` module (${mod.err}). clearing.move has not landed or is not published yet.`);
      say(`  ✗ ${CLEARING_MODULE} module: ${mod.err}`);
    } else {
      fns = mod.result?.exposedFunctions ?? {};
      const have = TARGET_FNS.filter((f) => fns[f]);
      const lack = TARGET_FNS.filter((f) => !fns[f]);
      say(`  ✓ ${CLEARING_MODULE} module found · exposes ${Object.keys(fns).length} function(s)`);
      if (have.length) say(`    present : ${have.join(', ')}`);
      if (lack.length) {
        say(`    MISSING : ${lack.join(', ')}`);
        reasons.push(`\`${CLEARING_MODULE}\` does not expose ${lack.join(', ')} — nothing to devInspect for those.`);
      }
    }
  }

  // ── measure ───────────────────────────────────────────────────────────────
  h1('MEASUREMENTS');
  if (fns && gasPrice) {
    say('    n   function      computationCost (MIST)   units      % of cap   verdict');
    for (const n of SIZES) {
      const orders = buildOrders(n, TICK);
      const ordersBcs = encodeOrders(orders);
      const budget = BUDGET_OVERRIDE ?? n;
      for (const fn of TARGET_FNS) {
        if (!fns[fn]) continue;
        const params = fns[fn].parameters ?? [];
        const m = await measure(PKG.value, fn, params, ordersBcs, budget);
        if (!m.ok) {
          reasons.push(`n=${n} ${fn}: ${m.unmeasurable}`);
          say(`  ${String(n).padStart(4)}   ${fn.padEnd(12)} NOT MEASURED — ${m.unmeasurable}`);
          continue;
        }
        const units = m.computationCost === null ? null : Math.round(Number(m.computationCost) / gasPrice);
        const over = units !== null && units > THRESHOLD;
        const verdict = units === null ? 'NO DATA' : over ? 'OVER THRESHOLD' : 'ok';
        if (over) exitCode = 1;
        if (m.aborted) reasons.push(`n=${n} ${fn}: devInspect ABORTED (code ${m.abortCode}) — the measured path may be shorter than the real one: ${m.err}`);
        const pct = units === null ? '—' : ((units / MAX_GAS_COMPUTATION_BUCKET) * 100).toFixed(1) + '%';
        say(`  ${String(n).padStart(4)}   ${fn.padEnd(12)} ${fmt(m.computationCost).padStart(22)}   ${fmt(units).padStart(9)}   ${pct.padStart(8)}   ${verdict}${m.aborted ? ' (ABORTED)' : ''}`);
        rows.push({ n, fn, computationCost: m.computationCost === null ? null : Number(m.computationCost), units, verdict: m.aborted ? `${verdict} (aborted ${m.abortCode})` : verdict });
      }
    }
  } else {
    say('  NOT MEASURED. Reasons:');
    for (const r of reasons) say(`    · ${r}`);
  }

  // ── verdict ───────────────────────────────────────────────────────────────
  h1('VERDICT');
  const measured = rows.filter((r) => r.units !== null).length;
  if (measured === 0) {
    say('  ✗ NOTHING WAS MEASURED — this is NOT a pass. MAX_BATCH_SIZE cannot be justified from this run.');
    for (const r of reasons) say(`    · ${r}`);
    if (REQUIRE_MEASUREMENT) { say('  --require-measurement was passed ⇒ exiting non-zero.'); exitCode = 1; }
    else { say('  (--require-measurement was not passed, so this run exits 0 with the reason stated.)'); }
  } else {
    const worst = rows.filter((r) => r.units !== null).reduce((a, b) => (b.units > a.units ? b : a));
    say(`  ${measured} step(s) measured · worst = ${worst.fn} at n=${worst.n}: ${fmt(worst.units)} units (${((worst.units / MAX_GAS_COMPUTATION_BUCKET) * 100).toFixed(1)}% of the cap)`);
    if (exitCode !== 0) {
      say(`  ✗ AT LEAST ONE STEP EXCEEDS ${fmt(THRESHOLD)} UNITS.`);
      say('    DESIGN-V2 §2: drop MAX_BATCH_SIZE to 128 and split price_step into');
      say('    price_scan_step + alloc_step, both cursor-driven.');
    } else {
      say(`  ✓ every measured step is under ${fmt(THRESHOLD)} units.`);
    }
  }

  writeReport(rows, {
    generatedAt: new Date().toISOString(),
    pkg: PKG.value, pkgFrom: PKG.from, rpc: activeRpc, gasPrice, threshold: THRESHOLD, reasons,
  });
  say('');
  say(`  report written : ${OUT_FILE.replace(/\\/g, '/')}`);
  say(`  intended home  : ${INTENDED_DEST}  (this script does not own docs/ — copy it over when docs/ is quiet)`);
  say('');

  if (AS_JSON) {
    console.log(JSON.stringify({
      package: PKG.value, gasPrice, threshold: THRESHOLD, rows, reasons, measured, exitCode,
      ceilings: { maxGasComputationBucket: MAX_GAS_COMPUTATION_BUCKET, maxStoreEntries: MAX_STORE_ENTRIES, maxEventEmit: MAX_EVENT_EMIT },
    }, null, 2));
  }
  return exitCode;
}

main().then((c) => process.exit(c)).catch((e) => {
  console.error(e?.stack ?? String(e));
  process.exit(2);
});
