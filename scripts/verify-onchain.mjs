#!/usr/bin/env node
// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       ops — live-testnet verification harness, no BUILD-PLAN unit id
// @phase      ops
// @status     DONE
// @spec       docs/RECON.md#r1 (L6-L15) · #r4 (L43-L53) · #r5 (L55-L68)
// @spec       docs/RECON.md#r6 (L70-L74) · #r8 (L101-L112) · #r10 (L152-L158) · #r11 (L160-L167)
// @spec       docs/FACTS.md#hashi-onchain-config · #hbtc · #deepbook-venue · #pyth
// @spec       docs/DAY-ONE-RESULTS.md — the [D<n>] receipts these assertions re-prove live
// @rules      G1 (the Hashi facts this re-checks) · G7 (ids arrive as config, never hardcoded)
// @depends    nothing — plain node ESM, ZERO npm dependencies, `fetch` only
// @facts      ⚠ SANCTIONED ID LITERALS. Per docs/CONVENTIONS.md §2.6 canonical ids may live
// @facts        only in keeper/src/config.ts, app/src/config.ts, *.env.example, move/Move.toml.
// @facts        This harness is the ONE extra sanctioned place: it is the tool that PROVES those
// @facts        ids, so it must be able to run before any of them exists. Ids are read from
// @facts        keeper/.env → keeper/src/config.ts → the DEFAULTS block below, in that order.
// @facts      CHAIN_ID = "4c78adac"                        (RECON R1, re-verified live 2026-07-25)
// @facts      HASHI_OBJECT initialSharedVersion = 805474231 (RECON R5)
// @facts      POOL initialSharedVersion         = 946570339 (RECON R5)
// @facts      DeepBook original 0xfb28c4cb… v1 · superseded 0x22be4cad… v17 · callable 0xd874d241… v20 (RECON R4)
// @facts      hBTC 8 dec / symbol "hBTC" · DBUSDC 6 dec     (RECON R5)
// @facts      Hashi config: withdrawal_min=30000 deposit_min=30000 delay=600000ms
// @facts        confirmations=6 cancel_cooldown=3600000ms paused=false   (RECON R6)
// @facts      pool::mid_price<B,Q>(&Pool, &Clock): u64                    (deepbookv3 pool.move L1397)
// @facts      pool::get_level2_range<B,Q>(&Pool, u64 low, u64 high, bool is_bid, &Clock)
// @facts        : (vector<u64>, vector<u64>)                              (deepbookv3 pool.move L1442)
// @facts      book.move EEmptyOrderbook = 2 ⇒ MoveAbort 2 on mid_price is the KNOWN empty-book
// @facts        case and is a PASS, not a failure (RECON R10: testnet book has zero volume).
// @facts      Pyth BETA Crypto.BTC/USD = 0xf9c0172ba10dfa4d19088d94f5bf61d3b54d5bd7483a322a982e1373ee8ea31b
// @external   ⚠⚠ suix_queryEvents `MoveModule` filters the EMITTING module, NOT the event type's
// @external      module. Hashi's withdrawal_queue::* events are emitted from module `withdraw`,
// @external      so {MoveModule: {module:"withdrawal_queue"}} returns ZERO rows. Use
// @external      {MoveEventModule: {...}} — verified live. The keeper watcher (T2.2) must do the same.
// @external   ⚠ https://fullnode.testnet.sui.io:443 serves gRPC only — JSON-RPC 404s (RECON R1).
// @external      This harness therefore talks to the JSON-RPC mirrors, never the fullnode.
// @implements P0 chain identity · P1 objects · P2 coin metadata · P3 pool book (devInspect)
// @implements P4 Hashi config · P5 Hashi events · P6 Pyth Hermes beta
// @forbidden  any npm dependency — must run on a bare checkout with no `npm install`
// @invariant  1. Exits non-zero if ANY row is FAIL.
// @invariant  2. Every RPC call fails over across all mirrors before reporting FAIL.
// @ac         every row PASS on a healthy testnet
// @verify     node scripts/verify-onchain.mjs
// @verify     node scripts/verify-onchain.mjs --json
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);

// ── sanctioned id literals (see @facts above) ────────────────────────────────
const DEFAULTS = {
  CHAIN_ID: '4c78adac',
  HASHI_PACKAGE_ID: '0xfcea10cadbb553c4874201584abf68771592678952efd957b2e82c010c7f4360',
  HASHI_OBJECT_ID: '0x22c0ce66ce09df2dc88a31bd320d4177b766518b9b88010368cfbdcd724528f8',
  HASHI_OBJECT_ISV: 805474231,
  DEEPBOOK_POOL: '0x5cdaebf264f8b0db4233098cb4cca33d11e4d8c179d5fbd36a5bed361a55ced6',
  DEEPBOOK_POOL_ISV: 946570339,
  DEEPBOOK_PACKAGE_ID: '0xd874d2417a55bfa6479bffa06ad950fea144ef93a94cc6c49f32b03e386bbb24',
  DEEPBOOK_PACKAGE_VERSION: 20,
  DEEPBOOK_ORIGINAL_PACKAGE_ID: '0xfb28c4cbc6865bd1c897d26aecbe1f8792d1509a20ffec692c800660cbec6982',
  DEEPBOOK_ORIGINAL_VERSION: 1,
  DEEPBOOK_SUPERSEDED_PACKAGE_ID: '0x22be4cade64bf2d02412c7e8d0e8beea2f78828b948118d46735315409371a3c',
  DEEPBOOK_SUPERSEDED_VERSION: 17,
  DBUSDC_PACKAGE_ID: '0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7',
  HBTC_COIN_TYPE: '0xfcea10cadbb553c4874201584abf68771592678952efd957b2e82c010c7f4360::btc::BTC',
  DBUSDC_COIN_TYPE: '0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC',
  PYTH_STATE_ID: '0x243759059f4c3111179da5878c12f68d612c21a8d54d85edc86164bb18be1c7c',
  PYTH_PACKAGE_ID: '0xabf837e98c26087cba0883c0a7a28326b1fa3c5e1e2c5abdb486f9e8f594c837',
  WORMHOLE_STATE_ID: '0x31358d198147da50db32eda2562951d53973a0c0ad5ed738e9b17d88b213d790',
  PYTH_BTC_USD_FEED_ID: '0xf9c0172ba10dfa4d19088d94f5bf61d3b54d5bd7483a322a982e1373ee8ea31b',
  HERMES_ENDPOINT: 'https://hermes-beta.pyth.network',

  // ── OUR OWN deployment — APHOTIC v2 ───────────────────────────────────────
  // Everything above is someone else's; everything here is ours. Overridable
  // from keeper/.env so a redeploy needs no code change.
  //
  // ⚠ RETARGETED 2026-07-26. These were the v1-product ids
  // (package 0x148a1191…dee54, vault 0x9236a21c…afec7). They are DELIBERATELY
  // BLANK now, and must not be restored: that package is the deleted DeepBook
  // market-making product. Leaving them here made this script report PASS for
  // objects the codebase no longer uses — a green run against the wrong contract,
  // which is worse than no run at all. The v1 ids remain in docs/DEPLOYED.md
  // § LEGACY so old digests stay resolvable.
  //
  // They are blank rather than filled because the v2 package IS NOT PUBLISHED:
  // `sui client publish` is rejected on chain with
  // VMVerificationOrDeserializationError — `clearing::Clearing` declares 39 fields
  // and the Sui verifier caps a struct at 32 (B25). Every check below WARNs while
  // unset, and asserts against chain the moment keeper/.env carries a real id.
  //
  // published-at vs original stay separate on purpose: `Vault<...>`'s type string
  // keeps the ORIGINAL forever while moveCalls must target the published-at, so
  // checking the vault's type against the target would break on the first upgrade
  // — the same two-id trap DeepBook sets (R4).
  APHOTIC_PACKAGE_ID: '',
  APHOTIC_ORIGINAL_PACKAGE_ID: '',
  APHOTIC_VAULT_ID: '',
  APHOTIC_VAULT_ISV: undefined,
  // v2 runtime objects. There are exactly THREE shared objects: the Vault above,
  // the BatchRegistry and the AdapterRegistry. NoteTree / NullifierSet / DenomLadder
  // / CapRegistry / both BalanceBooks are embedded in the Vault BY VALUE and have no
  // id of their own — there is deliberately nothing here to check them with.
  APHOTIC_BATCH_REGISTRY_ID: '',
  APHOTIC_ADAPTER_REGISTRY_ID: '',
  // Capabilities, asserted by OWNER: the whole two-party governance claim is that
  // these are not held by the same address.
  APHOTIC_ADMIN_CAP_ID: '',
  APHOTIC_ADMIN_ADDRESS: '',
  APHOTIC_KEEPER_CAP_ID: '',
  APHOTIC_KEEPER_ADDRESS: '',
  APHOTIC_UPGRADE_CAP_ID: '',
  DEEPBOOK_BALANCE_MANAGER_ID: '0x5766ed0b5e3fd310da9ccd723912198450872d9e2c83a473ed59cd5ab51990e2',
  DEEPBOOK_BALANCE_MANAGER_ISV: 947353675,
};

// RECON R1 — ordered JSON-RPC mirrors. `sui-testnet.public.blastapi.io` is dead (403).
const RPC_MIRRORS = [
  'https://rpc-testnet.suiscan.xyz:443',
  'https://sui-testnet-rpc.publicnode.com',
  'https://sui-testnet.nodeinfra.com',
];

// Hashi config keys asserted by P4 (RECON R6).
const HASHI_CONFIG_EXPECTED = {
  bitcoin_withdrawal_minimum: '30000',
  bitcoin_deposit_minimum: '30000',
  bitcoin_deposit_time_delay_ms: '600000',
  bitcoin_confirmation_threshold: '6',
  withdrawal_cancellation_cooldown_ms: '3600000',
  paused: 'false',
};

const CLOCK_ID = '0x6';
const CLOCK_ISV = 1;
const ZERO_SENDER = '0x0000000000000000000000000000000000000000000000000000000000000000';

// ── CLI ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (hit === undefined) return dflt;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
};
if (flag('help', false)) {
  console.log(`verify-onchain.mjs — Aphotic x Hashi on-chain harness (zero npm deps)

  node scripts/verify-onchain.mjs [options]

  --only=P0,P3     run only these checks (P0..P6)
  --rpc=<url>      force a single JSON-RPC endpoint (skips mirror failover)
  --timeout=<ms>   per-request timeout (default 30000)
  --json           emit machine-readable JSON instead of the table
  --help           this text

  Exits non-zero if any row is FAIL.`);
  process.exit(0);
}
const ONLY = flag('only', null) ? String(flag('only', '')).split(',').map((s) => s.trim().toUpperCase()) : null;
const TIMEOUT = Number(flag('timeout', 30000));
const AS_JSON = flag('json', false) === true;
const FORCED_RPC = typeof flag('rpc', null) === 'string' ? flag('rpc', null) : null;

// ── config resolution: process.env → keeper/.env → keeper/src/config.ts → DEFAULTS
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

function scrapeConfigTs(path) {
  const out = {};
  if (!existsSync(path)) return out;
  const src = readFileSync(path, 'utf8');
  for (const key of Object.keys(DEFAULTS)) {
    const re = new RegExp(`${key}[^\\n]{0,80}?['"\`](0x[0-9a-fA-F]{4,}(?:::[A-Za-z0-9_]+::[A-Za-z0-9_]+)?)['"\`]`);
    const m = src.match(re);
    if (m) out[key] = m[1];
  }
  return out;
}

const SOURCES = [];
const dotEnv = parseDotEnv(join(REPO, 'keeper', '.env'));
if (Object.keys(dotEnv).length) SOURCES.push('keeper/.env');
const cfgTs = scrapeConfigTs(join(REPO, 'keeper', 'src', 'config.ts'));
if (Object.keys(cfgTs).length) SOURCES.push('keeper/src/config.ts');
if (!SOURCES.length) SOURCES.push('DEFAULTS (built-in)');

const CFG = {};
for (const [k, v] of Object.entries(DEFAULTS)) {
  CFG[k] = process.env[k] ?? dotEnv[k] ?? cfgTs[k] ?? v;
}
// Derive the DBUSDC package from its coin type when the coin type was overridden.
if (typeof CFG.DBUSDC_COIN_TYPE === 'string' && CFG.DBUSDC_COIN_TYPE.includes('::')) {
  CFG.DBUSDC_PACKAGE_ID = CFG.DBUSDC_COIN_TYPE.slice(0, CFG.DBUSDC_COIN_TYPE.indexOf('::'));
}

// ── tiny helpers ─────────────────────────────────────────────────────────────
const norm = (a) => String(a ?? '').replace(/^0x/i, '').toLowerCase().padStart(64, '0');
const short = (a) => { const n = String(a ?? ''); return n.length > 14 ? `${n.slice(0, 10)}…${n.slice(-4)}` : n; };

const ROWS = [];
function row(id, name, status, detail) {
  ROWS.push({ id, name, status, detail: String(detail ?? '') });
}
const enabled = (id) => !ONLY || ONLY.includes(id);

let activeRpc = FORCED_RPC || null;
const rpcErrors = [];

async function rpc(method, params) {
  const endpoints = FORCED_RPC ? [FORCED_RPC] : (activeRpc ? [activeRpc, ...RPC_MIRRORS.filter((m) => m !== activeRpc)] : RPC_MIRRORS);
  let last;
  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(TIMEOUT),
      });
      if (!res.ok) { last = new Error(`${url} HTTP ${res.status}`); rpcErrors.push(last.message); continue; }
      const json = await res.json();
      if (json.error) {
        // A JSON-RPC application error is a real answer from a healthy node — do not fail over.
        activeRpc = url;
        return { ok: false, rpcError: json.error, endpoint: url };
      }
      activeRpc = url;
      return { ok: true, result: json.result, endpoint: url };
    } catch (e) {
      last = new Error(`${url} ${e.message}`);
      rpcErrors.push(last.message);
    }
  }
  return { ok: false, transportError: last ? last.message : 'no endpoint reachable' };
}

async function httpJson(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT), headers: { accept: 'application/json' } });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, body: await res.json() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── BCS writer (only what a read-only devInspect MoveCall needs) ─────────────
class BcsWriter {
  constructor() { this.b = []; }
  u8(n) { this.b.push(n & 0xff); return this; }
  bool(v) { return this.u8(v ? 1 : 0); }
  u16(n) { this.b.push(n & 0xff, (n >> 8) & 0xff); return this; }
  u64(n) { let v = BigInt(n); for (let i = 0; i < 8; i++) { this.b.push(Number(v & 0xffn)); v >>= 8n; } return this; }
  uleb(n) { let v = n >>> 0; do { let byte = v & 0x7f; v >>>= 7; if (v) byte |= 0x80; this.b.push(byte); } while (v); return this; }
  raw(arr) { for (const x of arr) this.b.push(x); return this; }
  vecU8(arr) { this.uleb(arr.length); return this.raw(arr); }
  str(s) { return this.vecU8(Array.from(new TextEncoder().encode(s))); }
  addr(hex) { const h = norm(hex); for (let i = 0; i < 64; i += 2) this.b.push(parseInt(h.slice(i, i + 2), 16)); return this; }
  base64() { return Buffer.from(Uint8Array.from(this.b)).toString('base64'); }
}

// TypeTag::Struct(StructTag{address, module, name, type_params:[]}) — no generics needed here.
function writeStructTag(w, typeStr) {
  const a = typeStr.indexOf('::');
  const b = typeStr.lastIndexOf('::');
  w.u8(7).addr(typeStr.slice(0, a)).str(typeStr.slice(a + 2, b)).str(typeStr.slice(b + 2)).uleb(0);
}

const sharedInput = (id, isv, mutable) => ({ kind: 'shared', id, isv, mutable: !!mutable });
const pureU64 = (n) => ({ kind: 'pure', bytes: Array.from(Uint8Array.from(new BcsWriter().u64(n).b)) });
const pureBool = (v) => ({ kind: 'pure', bytes: [v ? 1 : 0] });

// TransactionKind::ProgrammableTransaction { inputs, [Command::MoveCall] }
function buildDevInspectMoveCall({ pkg, module, fn, typeArgs, inputs }) {
  const w = new BcsWriter();
  w.u8(0);                       // TransactionKind::ProgrammableTransaction
  w.uleb(inputs.length);
  for (const inp of inputs) {
    if (inp.kind === 'shared') w.u8(1).u8(1).addr(inp.id).u64(inp.isv).bool(inp.mutable); // CallArg::Object(ObjectArg::SharedObject)
    else w.u8(0).vecU8(inp.bytes);                                                        // CallArg::Pure
  }
  w.uleb(1).u8(0);               // one command, Command::MoveCall
  w.addr(pkg).str(module).str(fn);
  w.uleb(typeArgs.length);
  for (const t of typeArgs) writeStructTag(w, t);
  w.uleb(inputs.length);
  for (let i = 0; i < inputs.length; i++) w.u8(1).u16(i);  // Argument::Input(i)
  return w.base64();
}

function decodeU64LE(bytes) {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i] & 0xff);
  return v;
}
function decodeVecU64(bytes) {
  let i = 0, shift = 0, len = 0, byte;
  do { byte = bytes[i++]; len |= (byte & 0x7f) << shift; shift += 7; } while (byte & 0x80);
  const out = [];
  for (let k = 0; k < len; k++) { out.push(decodeU64LE(bytes.slice(i, i + 8))); i += 8; }
  return out;
}
function moveAbortCode(errStr) {
  const m = /MoveAbort\(.*?,\s*(\d+)\)/.exec(String(errStr ?? ''));
  return m ? Number(m[1]) : null;
}

// ── P0 · chain identity ──────────────────────────────────────────────────────
async function checkP0() {
  const r = await rpc('sui_getChainIdentifier', []);
  if (!r.ok) return row('P0', 'chain identity', 'FAIL', r.transportError || JSON.stringify(r.rpcError));
  const ok = r.result === CFG.CHAIN_ID;
  row('P0', 'chain identity', ok ? 'PASS' : 'FAIL', `${r.result} (expected ${CFG.CHAIN_ID}) via ${r.endpoint}`);
}

// ── P1 · objects exist with expected type / owner ────────────────────────────
async function getObject(id) {
  return rpc('sui_getObject', [id, { showType: true, showOwner: true }]);
}

async function checkObject(label, id, expect) {
  const r = await getObject(id);
  if (!r.ok) return row('P1', label, 'FAIL', r.transportError || JSON.stringify(r.rpcError));
  const d = r.result && r.result.data;
  if (!d) return row('P1', label, 'FAIL', `not found: ${JSON.stringify(r.result && r.result.error).slice(0, 120)}`);

  const problems = [];
  const notes = [];

  if (expect.package) {
    if (d.type !== 'package') problems.push(`type=${d.type} (expected "package")`);
    if (d.owner !== 'Immutable') problems.push(`owner=${JSON.stringify(d.owner)} (expected Immutable)`);
    notes.push(`v${d.version}`);
    if (expect.version !== undefined && Number(d.version) !== Number(expect.version)) {
      problems.push(`version=${d.version} (expected ${expect.version})`);
    }
  }
  if (expect.shared) {
    const sh = d.owner && d.owner.Shared;
    if (!sh) problems.push(`owner=${JSON.stringify(d.owner)} (expected Shared)`);
    else {
      notes.push(`Shared isv=${sh.initial_shared_version}`);
      if (expect.isv !== undefined && Number(sh.initial_shared_version) !== Number(expect.isv)) {
        problems.push(`initialSharedVersion=${sh.initial_shared_version} (expected ${expect.isv})`);
      }
    }
  }
  // A capability is only meaningful if it is HELD BY the intended party, so the owner
  // is asserted from chain — not assumed from the transaction that created it.
  if (expect.addressOwner) {
    const ao = d.owner && d.owner.AddressOwner;
    if (!ao) problems.push(`owner=${JSON.stringify(d.owner)} (expected AddressOwner)`);
    else if (ao.toLowerCase() !== String(expect.addressOwner).toLowerCase()) {
      problems.push(`owner=${short(ao)} (expected ${short(expect.addressOwner)})`);
    } else notes.push(`AddressOwner ${short(ao)}`);
  }
  if (expect.typeStartsWith && !String(d.type ?? '').startsWith(expect.typeStartsWith)) {
    problems.push(`type does not start with ${short(expect.typeStartsWith)}`);
  }
  for (const frag of expect.typeContains ?? []) {
    if (!String(d.type ?? '').includes(frag)) problems.push(`type missing ${short(frag)}`);
  }
  if (expect.typeStartsWith) notes.push(`type origin ${short(expect.typeStartsWith)} ok`);

  row('P1', label, problems.length ? 'FAIL' : 'PASS', problems.length ? problems.join('; ') : notes.join(' · '));
}

async function checkP1() {
  await checkObject('Hashi package', CFG.HASHI_PACKAGE_ID, { package: true, version: 1 });
  await checkObject('Hashi shared object', CFG.HASHI_OBJECT_ID, {
    shared: true, isv: CFG.HASHI_OBJECT_ISV, typeStartsWith: `${CFG.HASHI_PACKAGE_ID}::hashi::Hashi`,
  });
  await checkObject('Pool<hBTC,DBUSDC>', CFG.DEEPBOOK_POOL, {
    shared: true, isv: CFG.DEEPBOOK_POOL_ISV,
    typeStartsWith: `${CFG.DEEPBOOK_ORIGINAL_PACKAGE_ID}::pool::Pool<`,
    typeContains: [CFG.HBTC_COIN_TYPE, CFG.DBUSDC_COIN_TYPE],
  });
  await checkObject('DeepBook pkg (original)', CFG.DEEPBOOK_ORIGINAL_PACKAGE_ID, { package: true, version: CFG.DEEPBOOK_ORIGINAL_VERSION });
  await checkObject('DeepBook pkg (superseded)', CFG.DEEPBOOK_SUPERSEDED_PACKAGE_ID, { package: true, version: CFG.DEEPBOOK_SUPERSEDED_VERSION });
  await checkObject('DeepBook pkg (callable)', CFG.DEEPBOOK_PACKAGE_ID, { package: true, version: CFG.DEEPBOOK_PACKAGE_VERSION });
  await checkObject('DBUSDC package', CFG.DBUSDC_PACKAGE_ID, { package: true });
  await checkObject('Pyth State', CFG.PYTH_STATE_ID, { shared: true, typeStartsWith: `${CFG.PYTH_PACKAGE_ID}::state::State` });
  await checkObject('Pyth package', CFG.PYTH_PACKAGE_ID, { package: true });
  await checkObject('Wormhole State', CFG.WORMHOLE_STATE_ID, { shared: true, typeContains: ['::state::State'] });

  // ── our own deployment ──────────────────────────────────────────────────────
  // Skipped rather than failed when unset, so this script still runs green on a
  // clean checkout that has not published yet.
  if (!CFG.APHOTIC_PACKAGE_ID) {
    row('P1', 'aphotic package', 'WARN', 'APHOTIC_PACKAGE_ID unset — v2 publish REJECTED on chain (B25: Clearing has 39 fields, limit 32)');
  } else {
    await checkObject('aphotic pkg (callable)', CFG.APHOTIC_PACKAGE_ID, { package: true });
    if (CFG.APHOTIC_ORIGINAL_PACKAGE_ID && CFG.APHOTIC_ORIGINAL_PACKAGE_ID !== CFG.APHOTIC_PACKAGE_ID) {
      await checkObject('aphotic pkg (original)', CFG.APHOTIC_ORIGINAL_PACKAGE_ID, { package: true });
    }
  }
  // v2 `Vault<B, Q, S>` — THREE type args, not two. Order is load-bearing: B is the
  // base (hBTC), Q the auction quote, S the LP share coin. Swapped, share math would
  // price the base asset in the wrong unit. The type is checked against the ORIGINAL
  // id, which is what a type string keeps forever.
  const APHOTIC_ORIGIN = CFG.APHOTIC_ORIGINAL_PACKAGE_ID || CFG.APHOTIC_PACKAGE_ID;
  if (!CFG.APHOTIC_VAULT_ID) {
    row('P1', 'Vault<B,Q,S>', 'WARN', 'APHOTIC_VAULT_ID unset — no vault created yet (B25/B26)');
  } else {
    await checkObject('Vault<B,Q,S>', CFG.APHOTIC_VAULT_ID, {
      shared: true,
      isv: CFG.APHOTIC_VAULT_ISV,
      typeStartsWith: `${APHOTIC_ORIGIN}::vault::Vault<`,
      typeContains: [CFG.HBTC_COIN_TYPE],
    });
  }

  // The other two shared objects. Both carry `vault_id` in Move, so a mismatch here
  // means a registry bound to a different vault than the one we are pointing at.
  if (!CFG.APHOTIC_BATCH_REGISTRY_ID) {
    row('P1', 'BatchRegistry', 'WARN', 'APHOTIC_BATCH_REGISTRY_ID unset — not created yet (B25/B26)');
  } else {
    await checkObject('BatchRegistry', CFG.APHOTIC_BATCH_REGISTRY_ID, {
      shared: true,
      typeStartsWith: `${APHOTIC_ORIGIN}::batch::BatchRegistry`,
    });
  }
  if (!CFG.APHOTIC_ADAPTER_REGISTRY_ID) {
    row('P1', 'AdapterRegistry', 'WARN', 'APHOTIC_ADAPTER_REGISTRY_ID unset — not created yet (B25)');
  } else {
    await checkObject('AdapterRegistry', CFG.APHOTIC_ADAPTER_REGISTRY_ID, {
      shared: true,
      typeStartsWith: `${APHOTIC_ORIGIN}::allocate::AdapterRegistry`,
    });
  }

  // Capabilities — asserted by OWNER, because a cap in the wrong hands is the whole
  // risk. `AdminCap` and `KeeperCap` are `key`-only (no `store`), so they can only be
  // AddressOwner; if the two resolve to the same address the two-party NAV split that
  // the governance claim rests on is silently void, so that is checked explicitly.
  if (!CFG.APHOTIC_ADMIN_CAP_ID) {
    row('P1', 'AdminCap', 'WARN', 'APHOTIC_ADMIN_CAP_ID unset — not minted yet (B25/B26)');
  } else {
    await checkObject('AdminCap', CFG.APHOTIC_ADMIN_CAP_ID, {
      typeStartsWith: `${APHOTIC_ORIGIN}::caps::AdminCap`,
      addressOwner: CFG.APHOTIC_ADMIN_ADDRESS || undefined,
    });
  }
  if (!CFG.APHOTIC_KEEPER_CAP_ID) {
    row('P1', 'KeeperCap', 'WARN', 'APHOTIC_KEEPER_CAP_ID unset — not minted yet (B25/B26)');
  } else {
    await checkObject('KeeperCap', CFG.APHOTIC_KEEPER_CAP_ID, {
      typeStartsWith: `${APHOTIC_ORIGIN}::caps::KeeperCap`,
      addressOwner: CFG.APHOTIC_KEEPER_ADDRESS || undefined,
    });
  }
  if (CFG.APHOTIC_ADMIN_ADDRESS && CFG.APHOTIC_KEEPER_ADDRESS) {
    const same = CFG.APHOTIC_ADMIN_ADDRESS.toLowerCase() === CFG.APHOTIC_KEEPER_ADDRESS.toLowerCase();
    row('P1', 'admin != keeper', same ? 'FAIL' : 'PASS',
      same ? 'AdminCap and KeeperCap resolve to the SAME address — the two-party NAV split is void'
           : `admin ${short(CFG.APHOTIC_ADMIN_ADDRESS)} != keeper ${short(CFG.APHOTIC_KEEPER_ADDRESS)}`);
  }
  if (!CFG.APHOTIC_UPGRADE_CAP_ID) {
    row('P1', 'UpgradeCap', 'WARN', 'APHOTIC_UPGRADE_CAP_ID unset — nothing published yet (B25)');
  } else {
    await checkObject('UpgradeCap', CFG.APHOTIC_UPGRADE_CAP_ID, { typeStartsWith: '0x2::package::UpgradeCap' });
  }
  if (CFG.DEEPBOOK_BALANCE_MANAGER_ID) {
    await checkObject('DeepBook BalanceManager', CFG.DEEPBOOK_BALANCE_MANAGER_ID, {
      shared: true,
      isv: CFG.DEEPBOOK_BALANCE_MANAGER_ISV,
      typeStartsWith: `${CFG.DEEPBOOK_ORIGINAL_PACKAGE_ID}::balance_manager::BalanceManager`,
    });
  }
}

// ── P2 · coin metadata ───────────────────────────────────────────────────────
async function checkCoin(label, coinType, expectDecimals, expectSymbol) {
  const r = await rpc('suix_getCoinMetadata', [coinType]);
  if (!r.ok) return row('P2', label, 'FAIL', r.transportError || JSON.stringify(r.rpcError).slice(0, 140));
  const m = r.result;
  if (!m) return row('P2', label, 'FAIL', 'no coin metadata returned');
  const problems = [];
  if (Number(m.decimals) !== expectDecimals) problems.push(`decimals=${m.decimals} (expected ${expectDecimals})`);
  if (expectSymbol && m.symbol !== expectSymbol) problems.push(`symbol=${m.symbol} (expected ${expectSymbol})`);
  row('P2', label, problems.length ? 'FAIL' : 'PASS', problems.length ? problems.join('; ') : `${m.decimals} dec · symbol ${m.symbol}`);
}

async function checkP2() {
  await checkCoin('hBTC metadata', CFG.HBTC_COIN_TYPE, 8, 'hBTC');
  await checkCoin('DBUSDC metadata', CFG.DBUSDC_COIN_TYPE, 6, null);
  const s = await rpc('suix_getTotalSupply', [CFG.HBTC_COIN_TYPE]);
  if (!s.ok || !s.result) {
    row('P2', 'hBTC total supply', 'WARN', `unavailable: ${s.transportError || JSON.stringify(s.rpcError).slice(0, 100)}`);
  } else {
    const sats = BigInt(s.result.value);
    row('P2', 'hBTC total supply', 'INFO', `${sats} sats (${(Number(sats) / 1e8).toFixed(5)} BTC)`);
  }
}

// ── P3 · pool book via devInspect ────────────────────────────────────────────
async function devInspect(txBytes) {
  return rpc('sui_devInspectTransactionBlock', [ZERO_SENDER, txBytes, null, null]);
}

async function checkP3() {
  const pool = sharedInput(CFG.DEEPBOOK_POOL, CFG.DEEPBOOK_POOL_ISV, false);
  const clock = sharedInput(CLOCK_ID, CLOCK_ISV, false);
  const typeArgs = [CFG.HBTC_COIN_TYPE, CFG.DBUSDC_COIN_TYPE];

  // pool::mid_price<hBTC,DBUSDC>(&Pool, &Clock): u64
  {
    const tx = buildDevInspectMoveCall({ pkg: CFG.DEEPBOOK_PACKAGE_ID, module: 'pool', fn: 'mid_price', typeArgs, inputs: [pool, clock] });
    const r = await devInspect(tx);
    if (!r.ok) {
      row('P3', 'pool::mid_price', 'FAIL', `transport/type error: ${r.transportError || JSON.stringify(r.rpcError).slice(0, 160)}`);
    } else {
      const status = r.result?.effects?.status;
      if (status?.status === 'success') {
        const rv = r.result?.results?.[0]?.returnValues?.[0];
        row('P3', 'pool::mid_price', 'PASS', rv ? `mid = ${decodeU64LE(rv[0])} (${rv[1]})` : 'success, no return value decoded');
      } else {
        const code = moveAbortCode(status?.error);
        // book.move EEmptyOrderbook = 2 — the expected state of a zero-volume testnet book (RECON R10).
        const known = code === 2;
        row('P3', 'pool::mid_price', known ? 'PASS' : 'FAIL',
          known ? 'MoveAbort 2 = EEmptyOrderbook (known empty book, RECON R10)' : `abort: ${String(status?.error).slice(0, 160)}`);
      }
    }
  }

  // pool::get_level2_range<hBTC,DBUSDC>(&Pool, u64, u64, bool, &Clock): (vector<u64>, vector<u64>)
  {
    const tx = buildDevInspectMoveCall({
      pkg: CFG.DEEPBOOK_PACKAGE_ID, module: 'pool', fn: 'get_level2_range', typeArgs,
      inputs: [pool, pureU64(1n), pureU64(100_000_000_000_000n), pureBool(true), clock],
    });
    const r = await devInspect(tx);
    if (!r.ok) {
      row('P3', 'pool::get_level2_range', 'FAIL', `transport/type error: ${r.transportError || JSON.stringify(r.rpcError).slice(0, 160)}`);
    } else {
      const status = r.result?.effects?.status;
      if (status?.status === 'success') {
        const rv = r.result?.results?.[0]?.returnValues ?? [];
        const prices = rv[0] ? decodeVecU64(rv[0][0]) : [];
        const qty = rv[1] ? decodeVecU64(rv[1][0]) : [];
        row('P3', 'pool::get_level2_range', 'PASS', `bids: ${prices.length} level(s)${prices.length ? ` best ${prices[0]} x ${qty[0]}` : ' (empty book)'}`);
      } else {
        const code = moveAbortCode(status?.error);
        const known = code === 2;
        row('P3', 'pool::get_level2_range', known ? 'PASS' : 'FAIL',
          known ? 'MoveAbort 2 = EEmptyOrderbook (known empty book)' : `abort: ${String(status?.error).slice(0, 160)}`);
      }
    }
  }
}

// ── P4 · Hashi config VecMap ─────────────────────────────────────────────────
function readConfigVecMap(objResult) {
  const entries = objResult?.data?.content?.fields?.config?.fields?.config?.fields?.contents;
  if (!Array.isArray(entries)) return null;
  const out = {};
  for (const e of entries) {
    const k = e?.fields?.key;
    const v = e?.fields?.value?.fields?.pos0;
    if (k !== undefined) out[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  return out;
}

async function checkP4() {
  const r = await rpc('sui_getObject', [CFG.HASHI_OBJECT_ID, { showContent: true }]);
  if (!r.ok) return row('P4', 'Hashi config', 'FAIL', r.transportError || JSON.stringify(r.rpcError).slice(0, 140));
  const cfg = readConfigVecMap(r.result);
  if (!cfg) return row('P4', 'Hashi config', 'FAIL', 'config VecMap not found at content.fields.config.fields.config.fields.contents');
  for (const [key, expected] of Object.entries(HASHI_CONFIG_EXPECTED)) {
    const got = cfg[key];
    if (got === undefined) row('P4', `cfg ${key}`, 'FAIL', 'key absent from the on-chain config VecMap');
    else row('P4', `cfg ${key}`, got === expected ? 'PASS' : 'FAIL', got === expected ? got : `${got} (expected ${expected})`);
  }
}

// ── P5 · Hashi events ────────────────────────────────────────────────────────
async function checkEventModule(moduleName) {
  // ⚠ MoveEventModule (event TYPE's module), NOT MoveModule (emitting module). See @external.
  const r = await rpc('suix_queryEvents', [{ MoveEventModule: { package: CFG.HASHI_PACKAGE_ID, module: moduleName } }, null, 25, true]);
  if (!r.ok) return row('P5', `events ${moduleName}`, 'FAIL', r.transportError || JSON.stringify(r.rpcError).slice(0, 140));
  const data = r.result?.data ?? [];
  if (!data.length) return row('P5', `events ${moduleName}`, 'FAIL', 'zero events returned (module name or filter wrong?)');
  const types = [...new Set(data.map((e) => e.type))];
  const ts = data[0].timestampMs;
  row('P5', `events ${moduleName}`, 'PASS', `${data.length} row(s) · envelope timestampMs=${ts} · latest ${new Date(Number(ts)).toISOString()}`);
  for (const t of types) row('P5', `  type`, 'INFO', t);
}

async function checkP5() {
  await checkEventModule('withdrawal_queue');
  await checkEventModule('deposit');
}

// ── P6 · Pyth Hermes beta ────────────────────────────────────────────────────
async function checkP6() {
  const base = String(CFG.HERMES_ENDPOINT).replace(/\/+$/, '');
  const listed = await httpJson(`${base}/v2/price_feeds?query=BTC%2FUSD&asset_type=crypto`);
  if (!listed.ok) return row('P6', 'pyth beta feed id', 'FAIL', `${base} ${listed.error}`);
  const feeds = Array.isArray(listed.body) ? listed.body : [];
  const btc = feeds.find((f) => f?.attributes?.symbol === 'Crypto.BTC/USD');
  if (!btc) return row('P6', 'pyth beta feed id', 'FAIL', `Crypto.BTC/USD absent from ${feeds.length} beta feed(s)`);
  const matches = norm(btc.id) === norm(CFG.PYTH_BTC_USD_FEED_ID);
  row('P6', 'pyth beta feed id', matches ? 'PASS' : 'FAIL',
    matches ? `Crypto.BTC/USD = 0x${btc.id}` : `got 0x${btc.id}, expected ${CFG.PYTH_BTC_USD_FEED_ID}`);

  const idNoPrefix = norm(CFG.PYTH_BTC_USD_FEED_ID);
  const latest = await httpJson(`${base}/v2/updates/price/latest?ids%5B%5D=${idNoPrefix}&encoding=hex&parsed=true`);
  if (!latest.ok) return row('P6', 'pyth price freshness', 'FAIL', latest.error);
  const parsed = latest.body?.parsed?.[0];
  if (!parsed?.price) return row('P6', 'pyth price freshness', 'FAIL', 'no parsed price in Hermes response');
  const px = Number(parsed.price.price) * 10 ** Number(parsed.price.expo);
  const ageS = Math.floor(Date.now() / 1000) - Number(parsed.price.publish_time);
  const status = ageS > 3600 ? 'FAIL' : (ageS > 120 ? 'WARN' : 'PASS');
  row('P6', 'pyth price freshness', status, `BTC/USD ${px.toFixed(2)} · publish_time ${parsed.price.publish_time} · age ${ageS}s`);
}

// ── run ──────────────────────────────────────────────────────────────────────
const CHECKS = [['P0', checkP0], ['P1', checkP1], ['P2', checkP2], ['P3', checkP3], ['P4', checkP4], ['P5', checkP5], ['P6', checkP6]];

for (const [id, fn] of CHECKS) {
  if (!enabled(id)) continue;
  try {
    await fn();
  } catch (e) {
    row(id, `${id} harness error`, 'FAIL', e && e.stack ? e.stack.split('\n')[0] : String(e));
  }
}

const failed = ROWS.filter((r) => r.status === 'FAIL');
const warned = ROWS.filter((r) => r.status === 'WARN');

if (AS_JSON) {
  console.log(JSON.stringify({
    chain: CFG.CHAIN_ID, endpoint: activeRpc, idSources: SOURCES,
    rows: ROWS, failed: failed.length, warned: warned.length,
  }, null, 2));
} else {
  const wId = Math.max(5, ...ROWS.map((r) => r.id.length));
  const wName = Math.max(20, ...ROWS.map((r) => r.name.length));
  const wSt = 6;
  const line = (a, b, c, d) => `${String(a).padEnd(wId)}  ${String(b).padEnd(wName)}  ${String(c).padEnd(wSt)}  ${d}`;
  console.log('');
  console.log('Aphotic x Hashi — on-chain verification (Sui testnet)');
  console.log(`  rpc        : ${activeRpc ?? '(none reached)'}${FORCED_RPC ? ' [forced]' : ' [mirror failover]'}`);
  console.log(`  id source  : ${SOURCES.join(' > ')}`);
  console.log(`  time       : ${new Date().toISOString()}`);
  console.log('');
  console.log(line('CHECK', 'WHAT', 'RESULT', 'DETAIL'));
  console.log('-'.repeat(wId + wName + wSt + 40));
  for (const r of ROWS) console.log(line(r.id, r.name, r.status, r.detail));
  console.log('');
  console.log(`  ${ROWS.filter((r) => r.status === 'PASS').length} PASS · ${failed.length} FAIL · ${warned.length} WARN · ${ROWS.filter((r) => r.status === 'INFO').length} INFO`);
  if (rpcErrors.length) console.log(`  mirror fallbacks: ${[...new Set(rpcErrors)].join(' | ')}`);
  console.log('');
}

process.exit(failed.length ? 1 : 0);
