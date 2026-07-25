#!/usr/bin/env node
// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       B2 (docs/STATUS.md L153-L157 "Known blockers") — ops tooling, no BUILD-PLAN task id
// @phase      ops  [CUT-LINE ADJACENT — NAV has no mid until this book has two sides]
// @status     DONE
// @spec       docs/STATUS.md#known-blockers (B2: hBTC/DBUSDC book empty on both sides)
// @spec       docs/RECON.md#r4 (L43-L53 DeepBook callable pkg) · #r5 (L55-L68 ids) · #r10 (L154-L160 venue reality)
// @spec       docs/RECON.md#r11 (L162-L169 Pyth BETA feed) · docs/DEPLOYED.md (our BalanceManager)
// @rules      G4 G7 G8 G9 G10
// @depends    keeper/src/config.ts + keeper/.env (the ONLY id homes, G7) · the `sui` CLI for signing
// @facts      DEEPBOOK PRICE UNIT: quote_units = base_units * price / 1e9  (FLOAT_SCALING = 1_000_000_000)
// @facts        base = hBTC 8 dec (sats) · quote = DBUSDC 6 dec
// @facts        ⇒ price = usd_per_btc * 1e7   and   usd_per_btc = price / 1e7
// @facts      Pool<hBTC,DBUSDC> book params READ LIVE 2026-07-25 via devInspect pool::pool_book_params:
// @facts        tick_size = 1_000_000 · lot_size = 1_000 sats · min_size = 100_000 sats (0.001 BTC)
// @facts      Pool<hBTC,DBUSDC> trade params: taker 1_000_000 (10 bps) · maker 500_000 (5 bps) · stake 100 DEEP
// @facts        whitelisted = false · registered_pool = true
// @facts      deepbook::constants::FEE_PENALTY_MULTIPLIER = 1_250_000_000 (fees in the INPUT coin cost 25% more)
// @facts      deepbook::constants POST_ONLY = 3 · SELF_MATCHING_ALLOWED = 0 · NO_RESTRICTION = 0
// @facts      ⚠ DBUSDC TreasuryCap 0x13641879f48973e88d31e694b208beff5f9addddba602a4155715762477e4d87
// @facts        is owner = AddressOwner 0x754a43970ec22d78110069ca1b45fb20818348363648b6b486edf0045dea559e
// @facts        — NOT shared ⇒ `DBUSDC::mint` is UNREACHABLE for us. Same for DBUSDT and DBTC.
// @facts        (This script re-queries it every run; it never trusts this comment.)
// @external   public fun deepbook::pool::place_limit_order<B,Q>(
// @external       self: &mut Pool<B,Q>, balance_manager: &mut BalanceManager, trade_proof: &TradeProof,
// @external       client_order_id: u64, order_type: u8, self_matching_option: u8, price: u64,
// @external       quantity: u64, is_bid: bool, pay_with_deep: bool, expire_timestamp: u64,
// @external       clock: &Clock, ctx: &TxContext): OrderInfo            // OrderInfo has copy,drop,store
// @external   public fun deepbook::pool::swap_exact_base_for_quote<B,Q>(
// @external       self: &mut Pool<B,Q>, base_in: Coin<B>, deep_in: Coin<DEEP>, min_quote_out: u64,
// @external       clock: &Clock, ctx: &mut TxContext): (Coin<B>, Coin<Q>, Coin<DEEP>)
// @external       ⚠ pay_with_deep is INFERRED as `deep_in.value() > 0`; pass coin::zero<DEEP> for input-coin fees.
// @external       ⚠ silently returns the inputs UNCHANGED when the rounded size < pool min_size.
// @external   public fun deepbook::balance_manager::deposit<T>(&mut BalanceManager, Coin<T>, &mut TxContext)
// @external   public fun deepbook::balance_manager::generate_proof_as_owner(&mut BalanceManager, &TxContext): TradeProof
// @external       ⚠ both assert ctx.sender() == balance_manager.owner()
// @external   public fun deepbook::pool::mid_price<B,Q>(&Pool<B,Q>, &Clock): u64
// @external       ⚠⚠ asserts ask.is_some() && bid.is_some() (book.move EEmptyOrderbook = 2).
// @external          Seeding ONE side does NOT make mid_price callable. Both sides or nothing.
// @implements report()        — what is obtainable, with live evidence, never a claim
// @implements planBid()       — price/quantity/cost against the LIVE pool params
// @implements renderPtb()     — the exact `sui client ptb` invocation
// @implements main()          — dry-run by default; on-chain writes ONLY behind --execute
// @forbidden  a canonical id literal in this file — G7, scripts/gates.ps1 `ids`
// @forbidden  any on-chain write without --execute — enforced by requireExecute()
// @forbidden  congestion / "the bridge is tight" copy — G8; this file makes no bridge claims at all
// @invariant  1. Without --execute the process NEVER submits a signed transaction.
// @invariant  2. Every number printed under "OBTAINABLE" comes from a live RPC read this run.
// @invariant  3. A bid whose implied BTC price deviates from the Pyth BETA feed by more than
// @invariant     --max-deviation-bps is REFUSED unless --allow-off-market is passed.
// @invariant  4. Money is bigint. No float ever reaches a u64 argument.
// @ac         `node scripts/seed-book.mjs` exits 0 and prints an honest OBTAINABLE table
// @ac         `node scripts/seed-book.mjs --execute` is the only path that writes
// @verify     node scripts/seed-book.mjs
// @verify     node scripts/seed-book.mjs --swap-sui=18 --chain-dry-run
// @verify     powershell -NoProfile -File scripts/gates.ps1 ids
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);

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
  console.log(`seed-book.mjs — seed the hBTC/DBUSDC DeepBook book (blocker B2)

  node scripts/seed-book.mjs [options]

  RECON (always runs, read-only):
    reports what inventory is actually obtainable on testnet right now —
    DBUSDC mintability, every DBUSDC acquisition route and its depth, our
    balances, the BalanceManager, and both sides of the live book.

  ACTIONS (opt-in):
    --swap-sui=<n>          sell n SUI into the SUI/DBUSDC book for DBUSDC
    --swap-only             acquire DBUSDC and stop; do not plan or place an order
    --side=bid|ask          which side to rest (default bid; ask needs hBTC)
    --qty=<sats>            order size in sats (default = pool min_size)
    --price=<u64>           explicit DeepBook price (default: derived from Pyth BETA)
    --usd=<n>               derive the price from this USD/BTC instead of Pyth
    --max-deviation-bps=<n> refuse an order this far off the oracle (default 500)
    --allow-off-market      place the order anyway, knowingly, off market
    --slippage-bps=<n>      swap min_quote_out tolerance (default 100)
    --gas-budget=<mist>     default 100000000

  SAFETY:
    --execute               ACTUALLY SIGN AND SUBMIT. Without it nothing is written.
    --chain-dry-run         additionally run the PTB through \`sui client ptb --dry-run\`
                            (no state change) to prove it is well formed
    --json                  machine-readable output
    --help                  this text

  Exits 1 if the requested action is impossible; 0 for a pure recon run.`);
  process.exit(0);
}

const AS_JSON = flag('json', false) === true;
const EXECUTE = flag('execute', false) === true;
const CHAIN_DRY_RUN = flag('chain-dry-run', false) === true;
const ALLOW_OFF_MARKET = flag('allow-off-market', false) === true;
const SWAP_SUI = flag('swap-sui', null) === null ? null : Number(flag('swap-sui', 0));
const SWAP_ONLY = flag('swap-only', false) === true;
const SIDE = String(flag('side', 'bid')).toLowerCase();
const QTY_OVERRIDE = flag('qty', null) === null ? null : BigInt(String(flag('qty')));
const PRICE_OVERRIDE = flag('price', null) === null ? null : BigInt(String(flag('price')));
const USD_OVERRIDE = flag('usd', null) === null ? null : String(flag('usd'));
const MAX_DEV_BPS = BigInt(String(flag('max-deviation-bps', '500')));
const SLIPPAGE_BPS = BigInt(String(flag('slippage-bps', '100')));
const GAS_BUDGET = String(flag('gas-budget', '100000000'));
const TIMEOUT = Number(flag('timeout', 30000));

if (SIDE !== 'bid' && SIDE !== 'ask') {
  console.error(`--side must be "bid" or "ask", got ${SIDE}`);
  process.exit(2);
}

// ─────────────────────────────────────────────────────────────────────────────
// Config resolution. G7: this file holds NO canonical id. Everything comes from
// keeper/.env → keeper/src/config.ts, exactly like scripts/verify-onchain.mjs.
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

/** Pull `key: 'value'` / `key = 'value'` out of keeper/src/config.ts. */
function scrapeConfig(src, key, pattern) {
  const re = new RegExp(`\\b${key}\\b\\s*[:=]\\s*[\`'"]?(${pattern})[\`'"]?`);
  const m = src.match(re);
  return m ? m[1] : null;
}
function scrapeNum(src, key) {
  const m = src.match(new RegExp(`\\b${key}\\b\\s*[:=]\\s*([0-9_]+)`));
  return m ? m[1].replace(/_/g, '') : null;
}

const CFG_TS_PATH = join(REPO, 'keeper', 'src', 'config.ts');
if (!existsSync(CFG_TS_PATH)) {
  console.error(`cannot resolve ids: ${CFG_TS_PATH} is missing. This script never hardcodes ids (G7).`);
  process.exit(2);
}
// ⚠ Strip `//` comment lines FIRST. config.ts carries an APHOTIC CONTRACT banner whose
// `@facts` lines quote the SAME constant names with the id ELIDED to its first few nibbles
// plus an ellipsis. Scraping those yields a truncated package id, which silently produces a
// wrong coin type and a devInspect that fails with "Dependent package not found on-chain".
const CFG_TS = readFileSync(CFG_TS_PATH, 'utf8')
  .split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const DOTENV = parseDotEnv(join(REPO, 'keeper', '.env'));

const HEX = '0x[0-9a-fA-F]{4,}';
const TYPE = '0x[0-9a-fA-F]{4,}::[A-Za-z0-9_]+::[A-Za-z0-9_]+';

// The hBTC / DBUSDC coin types are built in config.ts by template literal, so
// reconstruct them from the package ids the same way config.ts does.
const HASHI_PKG = scrapeConfig(CFG_TS, 'HASHI_PACKAGE_ID', HEX);
const DBUSDC_PKG = scrapeConfig(CFG_TS, 'DBUSDC_PACKAGE_ID', HEX);

const CFG = {
  rpcMirrors: (() => {
    const block = CFG_TS.match(/suiJsonRpcMirrors\s*:\s*\[([\s\S]*?)\]/);
    const urls = block ? [...block[1].matchAll(/['"`](https?:\/\/[^'"`]+)['"`]/g)].map((m) => m[1]) : [];
    return urls.length ? urls : ['https://rpc-testnet.suiscan.xyz:443'];
  })(),
  deepbookPackageId: process.env.DEEPBOOK_PACKAGE_ID ?? DOTENV.DEEPBOOK_PACKAGE_ID ?? scrapeConfig(CFG_TS, 'deepbookPackageId', HEX),
  deepbookOriginalPackageId: scrapeConfig(CFG_TS, 'deepbookOriginalPackageId', HEX),
  poolId: process.env.DEEPBOOK_POOL ?? DOTENV.DEEPBOOK_POOL ?? scrapeConfig(CFG_TS, 'deepbookPoolId', HEX),
  poolIsv: Number(scrapeNum(CFG_TS, 'deepbookPoolInitialSharedVersion')),
  hbtcType: HASHI_PKG ? `${HASHI_PKG}::btc::BTC` : scrapeConfig(CFG_TS, 'hbtcCoinType', TYPE),
  dbusdcType: DBUSDC_PKG ? `${DBUSDC_PKG}::DBUSDC::DBUSDC` : scrapeConfig(CFG_TS, 'dbusdcCoinType', TYPE),
  hbtcDecimals: Number(scrapeNum(CFG_TS, 'hbtcDecimals') ?? 8),
  dbusdcDecimals: Number(scrapeNum(CFG_TS, 'dbusdcDecimals') ?? 6),
  balanceManagerId: process.env.BALANCE_MANAGER_ID ?? DOTENV.BALANCE_MANAGER_ID ?? null,
  keeperAddress: process.env.SUI_KEEPER_ADDRESS ?? DOTENV.SUI_KEEPER_ADDRESS ?? null,
  hermes: scrapeConfig(CFG_TS, 'hermesEndpoint', 'https?://[^\'"`]+'),
  pythFeedId: scrapeConfig(CFG_TS, 'pythBtcUsdFeedId', HEX),
  deepbookIndexer: 'https://deepbook-indexer.testnet.mystenlabs.com',
};

const missing = Object.entries(CFG).filter(([, v]) => v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v)));
if (missing.length) {
  console.error(`config resolution failed for: ${missing.map(([k]) => k).join(', ')}`);
  process.exit(2);
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants that belong to DeepBook, not to us. Sourced from
// deepbookv3 packages/deepbook/sources/helper/constants.move at the rev
// move/Move.toml pins. These are protocol constants, not canonical ids.
// ─────────────────────────────────────────────────────────────────────────────
const FLOAT_SCALING = 1_000_000_000n;
const FEE_PENALTY_MULTIPLIER = 1_250_000_000n;
const ORDER_TYPE_POST_ONLY = 3;
const SELF_MATCHING_ALLOWED = 0;
const SUI_TYPE = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
const CLOCK_ID = '0x6';
const CLOCK_ISV = 1;
const ZERO_SENDER = '0x' + '0'.repeat(64);
const EEMPTY_ORDERBOOK = 2; // book.move

// ─────────────────────────────────────────────────────────────────────────────
// Transport (JSON-RPC mirrors — RECON R1: the fullnode is gRPC-only)
// ─────────────────────────────────────────────────────────────────────────────
let activeRpc = null;
async function rpc(method, params) {
  const eps = activeRpc ? [activeRpc, ...CFG.rpcMirrors.filter((m) => m !== activeRpc)] : CFG.rpcMirrors;
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
      if (json.error) return { ok: false, err: json.error };
      return { ok: true, result: json.result };
    } catch (e) { last = `${url} ${e.message}`; }
  }
  return { ok: false, err: last };
}

async function httpJson(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT), headers: { accept: 'application/json' } });
    if (!r.ok) return { ok: false, err: `HTTP ${r.status}` };
    return { ok: true, body: await r.json() };
  } catch (e) { return { ok: false, err: e.message }; }
}

async function graphql(query) {
  for (const url of ['https://graphql.testnet.sui.io/graphql']) {
    try {
      const r = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query }), signal: AbortSignal.timeout(TIMEOUT),
      });
      if (!r.ok) return { ok: false, err: `HTTP ${r.status}` };
      const j = await r.json();
      if (j.errors) return { ok: false, err: JSON.stringify(j.errors).slice(0, 200) };
      return { ok: true, data: j.data };
    } catch (e) { return { ok: false, err: e.message }; }
  }
  return { ok: false, err: 'no graphql endpoint' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimal BCS — only what a read-only devInspect MoveCall needs.
// (Same shape as scripts/verify-onchain.mjs; kept local so this file has zero deps.)
// ─────────────────────────────────────────────────────────────────────────────
const norm = (a) => String(a ?? '').replace(/^0x/i, '').toLowerCase().padStart(64, '0');
/** `0x2::sui::SUI` and the 64-nibble form are the same type — compare canonically. */
const normType = (t) => {
  const i = String(t ?? '').indexOf('::');
  return i === -1 ? String(t ?? '') : `0x${norm(String(t).slice(0, i))}${String(t).slice(i)}`;
};
class BcsWriter {
  constructor() { this.b = []; }
  u8(n) { this.b.push(n & 0xff); return this; }
  bool(v) { return this.u8(v ? 1 : 0); }
  u16(n) { this.b.push(n & 0xff, (n >> 8) & 0xff); return this; }
  u64(n) { let v = BigInt(n); for (let i = 0; i < 8; i++) { this.b.push(Number(v & 0xffn)); v >>= 8n; } return this; }
  uleb(n) { let v = n >>> 0; do { let x = v & 0x7f; v >>>= 7; if (v) x |= 0x80; this.b.push(x); } while (v); return this; }
  raw(a) { for (const x of a) this.b.push(x); return this; }
  vecU8(a) { this.uleb(a.length); return this.raw(a); }
  str(s) { return this.vecU8(Array.from(new TextEncoder().encode(s))); }
  addr(h) { const n = norm(h); for (let i = 0; i < 64; i += 2) this.b.push(parseInt(n.slice(i, i + 2), 16)); return this; }
  base64() { return Buffer.from(Uint8Array.from(this.b)).toString('base64'); }
}
function writeStructTag(w, t) {
  const a = t.indexOf('::'), b = t.lastIndexOf('::');
  w.u8(7).addr(t.slice(0, a)).str(t.slice(a + 2, b)).str(t.slice(b + 2)).uleb(0);
}
const sharedIn = (id, isv, mutable = false) => ({ kind: 'shared', id, isv, mutable });
const pureU64 = (n) => ({ kind: 'pure', bytes: Array.from(Uint8Array.from(new BcsWriter().u64(n).b)) });
const pureBool = (v) => ({ kind: 'pure', bytes: [v ? 1 : 0] });

function buildMoveCall({ pkg, module, fn, typeArgs, inputs }) {
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
  for (const t of typeArgs) writeStructTag(w, t);
  w.uleb(inputs.length);
  for (let i = 0; i < inputs.length; i++) w.u8(1).u16(i);
  return w.base64();
}
const decU64 = (b) => { let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[i] & 0xff); return v; };
function decVecU64(b) {
  let i = 0, s = 0, l = 0, x;
  do { x = b[i++]; l |= (x & 0x7f) << s; s += 7; } while (x & 0x80);
  const out = [];
  for (let k = 0; k < l; k++) { out.push(decU64(b.slice(i, i + 8))); i += 8; }
  return out;
}
const abortCode = (e) => { const m = /MoveAbort\(.*?,\s*(\d+)\)/.exec(String(e ?? '')); return m ? Number(m[1]) : null; };

async function devInspect(spec) {
  const r = await rpc('sui_devInspectTransactionBlock', [ZERO_SENDER, buildMoveCall(spec), null, null]);
  if (!r.ok) return { ok: false, err: typeof r.err === 'string' ? r.err : JSON.stringify(r.err).slice(0, 200) };
  const st = r.result?.effects?.status;
  if (st?.status !== 'success') return { ok: false, abort: abortCode(st?.error), err: String(st?.error).slice(0, 200) };
  return { ok: true, rv: r.result?.results?.[0]?.returnValues ?? [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Price arithmetic. All bigint. Prices are carried as micro-USD per BTC so no
// float ever reaches a u64 argument (invariant 4).
// ─────────────────────────────────────────────────────────────────────────────
const pow10 = (n) => 10n ** BigInt(n);

/** DeepBook price from micro-USD per BTC. price = usd * 10^qdec * 1e9 / 10^bdec / 1e6 */
function priceFromMicroUsd(microUsdPerBtc) {
  return (microUsdPerBtc * pow10(CFG.dbusdcDecimals) * FLOAT_SCALING) / (pow10(CFG.hbtcDecimals) * 1_000_000n);
}
/** Inverse of priceFromMicroUsd. */
function microUsdFromPrice(price) {
  return (price * pow10(CFG.hbtcDecimals) * 1_000_000n) / (pow10(CFG.dbusdcDecimals) * FLOAT_SCALING);
}
const fmtUsd = (microUsd) => `$${(Number(microUsd) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const fmtUnits = (u, dec) => (Number(u) / Number(pow10(dec))).toLocaleString('en-US', { maximumFractionDigits: dec });
const floorTo = (v, step) => (step === 0n ? v : (v / step) * step);

// ─────────────────────────────────────────────────────────────────────────────
// RECON
// ─────────────────────────────────────────────────────────────────────────────
const LINES = [];
const REPORT = { obtainable: {}, pool: {}, plan: null, verdict: [] };
const say = (s = '') => { if (!AS_JSON) console.log(s); LINES.push(s); };
const h1 = (s) => { say(); say(s); say('─'.repeat(Math.max(20, s.length))); };

async function readPoolParams(poolId, isv, typeArgs) {
  const pool = sharedIn(poolId, isv);
  const out = {};
  const bp = await devInspect({ pkg: CFG.deepbookPackageId, module: 'pool', fn: 'pool_book_params', typeArgs, inputs: [pool] });
  if (bp.ok) { [out.tickSize, out.lotSize, out.minSize] = bp.rv.map((x) => decU64(x[0])); } else out.bookParamsErr = bp.err;
  const tp = await devInspect({ pkg: CFG.deepbookPackageId, module: 'pool', fn: 'pool_trade_params', typeArgs, inputs: [pool] });
  if (tp.ok) { [out.takerFee, out.makerFee, out.stakeRequired] = tp.rv.map((x) => decU64(x[0])); } else out.tradeParamsErr = tp.err;
  const wl = await devInspect({ pkg: CFG.deepbookPackageId, module: 'pool', fn: 'whitelisted', typeArgs, inputs: [pool] });
  out.whitelisted = wl.ok ? wl.rv[0][0][0] === 1 : null;
  return out;
}

async function readBook(poolId, isv, typeArgs) {
  const pool = sharedIn(poolId, isv);
  const clock = sharedIn(CLOCK_ID, CLOCK_ISV);
  const lo = pureU64(1n), hi = pureU64((1n << 63n) - 1n);
  const side = async (isBid) => {
    const r = await devInspect({
      pkg: CFG.deepbookPackageId, module: 'pool', fn: 'get_level2_range', typeArgs,
      inputs: [pool, lo, hi, pureBool(isBid), clock],
    });
    if (!r.ok) return { err: r.err, abort: r.abort };
    return { prices: decVecU64(r.rv[0][0]), qty: decVecU64(r.rv[1][0]) };
  };
  const bids = await side(true);
  const asks = await side(false);
  const mid = await devInspect({ pkg: CFG.deepbookPackageId, module: 'pool', fn: 'mid_price', typeArgs, inputs: [pool, clock] });
  return {
    bids, asks,
    mid: mid.ok ? decU64(mid.rv[0][0]) : null,
    midErr: mid.ok ? null : (mid.abort === EEMPTY_ORDERBOOK ? 'MoveAbort 2 = EEmptyOrderbook (needs BOTH sides)' : mid.err),
  };
}

/** Is a `0x2::coin::TreasuryCap<T>` shared (⇒ anyone can mint) or owned (⇒ we cannot)? */
async function treasuryCapOwnership(coinType) {
  const q = `query { objects(filter: {type: "0x2::coin::TreasuryCap<${coinType}>"}) { nodes { address owner { __typename ... on Shared { initialSharedVersion } ... on AddressOwner { address { address } } } } } }`;
  const r = await graphql(q);
  if (!r.ok) return { err: r.err };
  const nodes = r.data?.objects?.nodes ?? [];
  if (!nodes.length) return { found: false };
  const n = nodes[0];
  return {
    found: true,
    id: n.address,
    ownerKind: n.owner?.__typename ?? 'unknown',
    owner: n.owner?.address?.address ?? null,
    isv: n.owner?.initialSharedVersion ?? null,
    mintableByAnyone: n.owner?.__typename === 'Shared',
  };
}

async function pythMicroUsd() {
  const r = await httpJson(`${CFG.hermes}/v2/updates/price/latest?ids[]=${CFG.pythFeedId}&encoding=hex`);
  if (!r.ok) return { err: r.err };
  const p = r.body?.parsed?.[0]?.price;
  if (!p) return { err: 'no parsed price' };
  // micro-USD = price * 10^(expo + 6)
  const shift = Number(p.expo) + 6;
  const raw = BigInt(p.price);
  const micro = shift >= 0 ? raw * pow10(shift) : raw / pow10(-shift);
  return { microUsd: micro, publishTime: Number(p.publish_time), conf: BigInt(p.conf) };
}

/** Discover the SUI/DBUSDC pool from the indexer, then VERIFY it on chain. */
async function findAcquisitionPool() {
  const override = flag('acquire-pool', null);
  const r = await httpJson(`${CFG.deepbookIndexer}/get_pools`);
  let poolId = typeof override === 'string' ? override : null;
  let deepType = null;
  let pools = [];
  if (r.ok && Array.isArray(r.body)) {
    pools = r.body;
    if (!poolId) {
      const hit = pools.find((p) => normType(p.base_asset_id) === normType(SUI_TYPE) && normType(p.quote_asset_id) === normType(CFG.dbusdcType));
      poolId = hit?.pool_id ?? null;
    }
    const deepPool = pools.find((p) => String(p.base_asset_symbol).toUpperCase() === 'DEEP');
    deepType = deepPool?.base_asset_id ?? null;
  }
  if (!poolId) return { err: 'no SUI/DBUSDC pool found', pools };
  const o = await rpc('sui_getObject', [poolId, { showOwner: true, showType: true }]);
  const d = o.ok ? o.result?.data : null;
  const isv = d?.owner?.Shared?.initial_shared_version;
  const typeOk = normType(String(d?.type ?? '').split('<')[0]) === normType(`${CFG.deepbookOriginalPackageId}::pool::Pool`)
    && String(d?.type ?? '').includes(CFG.dbusdcType.slice(2, 12));
  return { poolId, isv: isv === undefined ? null : Number(isv), typeOk, deepType, pools };
}

/** Every book whose QUOTE is DBUSDC: how much DBUSDC could a seller extract from its bids? */
function dbusdcRoutes(pools, books) {
  const out = [];
  for (const p of pools) {
    if (normType(p.quote_asset_id) !== normType(CFG.dbusdcType)) continue;
    const b = books[p.pool_name];
    if (!b || b.err) { out.push({ pool: p.pool_name, err: b?.err ?? 'no book' }); continue; }
    // indexer returns human-decimal [price, size] pairs; sum price*size for gross DBUSDC.
    const gross = (b.bids ?? []).reduce((a, [px, q]) => a + Number(px) * Number(q), 0);
    out.push({ pool: p.pool_name, base: p.base_asset_symbol, levels: (b.bids ?? []).length, grossDbusdc: gross });
  }
  return out.sort((a, b) => (b.grossDbusdc ?? 0) - (a.grossDbusdc ?? 0));
}

// ─────────────────────────────────────────────────────────────────────────────
// PTB rendering — the exact `sui client ptb` invocation, never a paraphrase.
// ─────────────────────────────────────────────────────────────────────────────
function renderPtb(plan) {
  const a = [];
  const P = CFG.deepbookPackageId;
  if (plan.swap) {
    a.push('--split-coins', 'gas', `[${plan.swap.mistIn}]`, '--assign', 'sui_in');
    a.push('--move-call', '0x2::coin::zero', `<${plan.swap.deepType}>`, '--assign', 'deep_zero');
    a.push('--move-call', `${P}::pool::swap_exact_base_for_quote`,
      `<${SUI_TYPE},${CFG.dbusdcType}>`,
      `@${plan.swap.poolId}`, 'sui_in.0', 'deep_zero', String(plan.swap.minQuoteOut), `@${CLOCK_ID}`);
    a.push('--assign', 'swapped');
    a.push('--move-call', `${P}::balance_manager::deposit`, `<${CFG.dbusdcType}>`,
      `@${CFG.balanceManagerId}`, 'swapped.1');
    a.push('--transfer-objects', '[swapped.0, swapped.2]', `@${plan.sender}`);
  }
  if (plan.order) {
    a.push('--move-call', `${P}::balance_manager::generate_proof_as_owner`, `@${CFG.balanceManagerId}`);
    a.push('--assign', 'proof');
    a.push('--move-call', `${P}::pool::place_limit_order`,
      `<${CFG.hbtcType},${CFG.dbusdcType}>`,
      `@${CFG.poolId}`, `@${CFG.balanceManagerId}`, 'proof',
      String(plan.order.clientOrderId), String(ORDER_TYPE_POST_ONLY), String(SELF_MATCHING_ALLOWED),
      String(plan.order.price), String(plan.order.qty),
      String(plan.order.isBid), 'false', String(plan.order.expireMs), `@${CLOCK_ID}`);
  }
  a.push('--gas-budget', GAS_BUDGET);
  return a;
}

function suiBin() {
  if (process.env.SUI_BIN) return process.env.SUI_BIN;
  const local = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'sui', 'sui.exe') : null;
  if (local && existsSync(local)) return local;
  return 'sui';
}

function quoteArg(s) {
  return /[\s\[\]<>,]/.test(s) ? `"${s}"` : s;
}

function runSui(args, { capture = true } = {}) {
  const r = spawnSync(suiBin(), args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.error) return { ok: false, err: r.error.message };
  return { ok: r.status === 0, code: r.status, stdout: capture ? (r.stdout ?? '') : '', stderr: r.stderr ?? '' };
}

// ─────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────
let exitCode = 0;

async function main() {
  h1('CONFIG (resolved from keeper/.env → keeper/src/config.ts — no id literal lives in this file)');
  say(`  DeepBook callable pkg   ${CFG.deepbookPackageId}`);
  say(`  Pool<hBTC,DBUSDC>       ${CFG.poolId}  (isv ${CFG.poolIsv})`);
  say(`  BalanceManager          ${CFG.balanceManagerId}`);
  say(`  hBTC                    ${CFG.hbtcType}  (${CFG.hbtcDecimals} dec)`);
  say(`  DBUSDC                  ${CFG.dbusdcType}  (${CFG.dbusdcDecimals} dec)`);
  say(`  sender                  ${CFG.keeperAddress}`);
  say(`  mode                    ${EXECUTE ? '*** EXECUTE — WILL SIGN AND SUBMIT ***' : 'DRY RUN (no on-chain write)'}`);

  // ── 1. Is DBUSDC mintable? ────────────────────────────────────────────────
  h1('1. CAN WE MINT DBUSDC?');
  const cap = await treasuryCapOwnership(CFG.dbusdcType);
  REPORT.obtainable.dbusdcTreasuryCap = cap;
  if (cap.err) {
    say(`  ✗ could not query the TreasuryCap: ${cap.err}`);
  } else if (!cap.found) {
    say('  ✗ no 0x2::coin::TreasuryCap<DBUSDC> object is indexed — cannot mint.');
  } else {
    say(`  TreasuryCap<DBUSDC>   ${cap.id}`);
    say(`  owner                 ${cap.ownerKind}${cap.owner ? ` ${cap.owner}` : ''}${cap.isv ? ` isv=${cap.isv}` : ''}`);
    if (cap.mintableByAnyone) {
      say('  ✓ SHARED ⇒ `DBUSDC::mint(&mut TreasuryCap, ...)` is callable by anyone. The bid side is unlocked.');
    } else {
      say('  ✗ NOT shared. `DBUSDC::mint` takes `&mut TreasuryCap<DBUSDC>`, so only that owner can mint.');
      say('    ⇒ We cannot mint DBUSDC. The only DBUSDC we can get is DBUSDC that already exists on a book.');
    }
  }

  // ── 2. What DBUSDC can we buy? ────────────────────────────────────────────
  h1('2. WHAT DBUSDC IS BUYABLE ON TESTNET RIGHT NOW?');
  const acq = await findAcquisitionPool();
  const books = {};
  for (const p of acq.pools ?? []) {
    if (normType(p.quote_asset_id) !== normType(CFG.dbusdcType)) continue;
    const b = await httpJson(`${CFG.deepbookIndexer}/orderbook/${p.pool_name}?level=2&depth=50`);
    books[p.pool_name] = b.ok ? b.body : { err: b.err };
  }
  const routes = dbusdcRoutes(acq.pools ?? [], books);
  REPORT.obtainable.routes = routes;
  say('  Every DeepBook testnet book quoted in DBUSDC, and the DBUSDC sitting in its BIDS');
  say('  (that is the entire pool of DBUSDC a stranger can extract by selling into it):');
  say('');
  say('    book             base    bid levels   gross DBUSDC extractable');
  let totalGross = 0;
  for (const r of routes) {
    if (r.err) { say(`    ${String(r.pool).padEnd(16)} ${'-'.padEnd(7)} ${'-'.padStart(10)}   ${r.err}`); continue; }
    totalGross += r.grossDbusdc;
    say(`    ${String(r.pool).padEnd(16)} ${String(r.base ?? '').padEnd(7)} ${String(r.levels).padStart(10)}   ${r.grossDbusdc.toFixed(3)}`);
  }
  say(`    ${''.padEnd(16)} ${''.padEnd(7)} ${'TOTAL'.padStart(10)}   ${totalGross.toFixed(3)} DBUSDC (gross, before fees)`);
  REPORT.obtainable.totalGrossDbusdc = totalGross;
  say('');
  say('  ⚠ These are indexer reads of OTHER pools. Our own pool is NOT in the indexer (RECON R10);');
  say('    everything about it below is read by devInspect against the chain.');

  if (acq.err) {
    say(`  ✗ no SUI/DBUSDC acquisition pool: ${acq.err}`);
  } else {
    say(`  SUI/DBUSDC pool       ${acq.poolId} (isv ${acq.isv}) type verified on chain: ${acq.typeOk ? 'yes' : 'NO'}`);
  }

  // ── 3. Our inventory ──────────────────────────────────────────────────────
  h1('3. OUR INVENTORY');
  const bal = await rpc('suix_getAllBalances', [CFG.keeperAddress]);
  const balances = {};
  if (bal.ok) for (const b of bal.result ?? []) balances[normType(b.coinType)] = BigInt(b.totalBalance);
  REPORT.obtainable.walletBalances = Object.fromEntries(Object.entries(balances).map(([k, v]) => [k, String(v)]));
  const suiBal = balances[normType(SUI_TYPE)] ?? 0n;
  const hbtcWallet = balances[normType(CFG.hbtcType)] ?? 0n;
  const dbusdcWallet = balances[normType(CFG.dbusdcType)] ?? 0n;
  say(`  wallet SUI            ${fmtUnits(suiBal, 9)}`);
  say(`  wallet hBTC           ${hbtcWallet} sats`);
  say(`  wallet DBUSDC         ${fmtUnits(dbusdcWallet, CFG.dbusdcDecimals)}`);

  const bmObj = await rpc('sui_getObject', [CFG.balanceManagerId, { showOwner: true, showType: true }]);
  const bmIsv = bmObj.ok ? Number(bmObj.result?.data?.owner?.Shared?.initial_shared_version ?? 0) : 0;
  const bmIn = sharedIn(CFG.balanceManagerId, bmIsv);
  const bmOwner = await devInspect({ pkg: CFG.deepbookPackageId, module: 'balance_manager', fn: 'owner', typeArgs: [], inputs: [bmIn] });
  const ownerAddr = bmOwner.ok ? '0x' + Buffer.from(bmOwner.rv[0][0]).toString('hex') : null;
  say(`  BalanceManager owner  ${ownerAddr ?? `unreadable (${bmOwner.err})`}`);
  const weOwnBm = ownerAddr !== null && norm(ownerAddr) === norm(CFG.keeperAddress);
  say(`  we own it             ${weOwnBm ? 'yes ⇒ generate_proof_as_owner + deposit are callable' : 'NO ⇒ we cannot deposit or place orders through it'}`);
  const bmBal = {};
  for (const [n, t] of [['hBTC', CFG.hbtcType], ['DBUSDC', CFG.dbusdcType]]) {
    const r = await devInspect({ pkg: CFG.deepbookPackageId, module: 'balance_manager', fn: 'balance', typeArgs: [t], inputs: [bmIn] });
    bmBal[n] = r.ok ? decU64(r.rv[0][0]) : null;
    say(`  BM balance<${n.padEnd(6)}>   ${bmBal[n] === null ? `unreadable (${r.err})` : bmBal[n]}`);
  }
  REPORT.obtainable.balanceManager = { id: CFG.balanceManagerId, isv: bmIsv, owner: ownerAddr, weOwnIt: weOwnBm, balances: Object.fromEntries(Object.entries(bmBal).map(([k, v]) => [k, v === null ? null : String(v)])) };

  // ── 4. The pool ───────────────────────────────────────────────────────────
  h1('4. Pool<hBTC,DBUSDC> — LIVE (devInspect, never the indexer)');
  const typeArgs = [CFG.hbtcType, CFG.dbusdcType];
  const params = await readPoolParams(CFG.poolId, CFG.poolIsv, typeArgs);
  const book = await readBook(CFG.poolId, CFG.poolIsv, typeArgs);
  REPORT.pool = {
    tickSize: String(params.tickSize ?? ''), lotSize: String(params.lotSize ?? ''), minSize: String(params.minSize ?? ''),
    takerFee: String(params.takerFee ?? ''), makerFee: String(params.makerFee ?? ''), whitelisted: params.whitelisted,
    bidLevels: book.bids.prices?.length ?? null, askLevels: book.asks.prices?.length ?? null,
    mid: book.mid === null ? null : String(book.mid), midErr: book.midErr,
  };
  say(`  tick_size             ${params.tickSize}`);
  say(`  lot_size              ${params.lotSize} sats`);
  say(`  min_size              ${params.minSize} sats  (= ${fmtUnits(params.minSize ?? 0n, CFG.hbtcDecimals)} BTC — the smallest order this pool accepts)`);
  say(`  taker / maker fee     ${params.takerFee} / ${params.makerFee}  (1e9 = 100%)`);
  say(`  whitelisted           ${params.whitelisted}  ⇒ pay_with_deep=false is required (no DEEP needed, fee comes out of the input coin)`);
  const showSide = (name, s) => {
    if (s.err) return say(`  ${name.padEnd(21)} unreadable: ${s.err}`);
    if (!s.prices.length) return say(`  ${name.padEnd(21)} EMPTY`);
    say(`  ${name.padEnd(21)} ${s.prices.length} level(s), best ${s.prices[0]} x ${s.qty[0]} sats (${fmtUsd(microUsdFromPrice(s.prices[0]))}/BTC)`);
  };
  showSide('bids', book.bids);
  showSide('asks', book.asks);
  say(`  mid_price             ${book.mid === null ? `ABORTS — ${book.midErr}` : `${book.mid} (${fmtUsd(microUsdFromPrice(book.mid))}/BTC)`}`);
  say('');
  say('  ⚠ pool::mid_price asserts `ask.is_some() && bid.is_some()`. Seeding ONE side does not');
  say('    make it callable — but get_level2_range / best_bid_price do work one-sided.');

  // ── 5. Reference price ────────────────────────────────────────────────────
  h1('5. REFERENCE PRICE (Pyth BETA channel — G9)');
  const pyth = await pythMicroUsd();
  let refMicroUsd = null;
  if (USD_OVERRIDE !== null) {
    refMicroUsd = BigInt(Math.round(Number(USD_OVERRIDE) * 1e6));
    say(`  --usd override        ${fmtUsd(refMicroUsd)}/BTC`);
  } else if (pyth.err) {
    say(`  ✗ Hermes unavailable: ${pyth.err}`);
  } else {
    refMicroUsd = pyth.microUsd;
    const ageS = Math.floor(Date.now() / 1000) - pyth.publishTime;
    say(`  BTC/USD (beta feed)   ${fmtUsd(refMicroUsd)}   published ${ageS}s ago`);
    say(`  ⇒ DeepBook price      ${priceFromMicroUsd(refMicroUsd)}`);
  }
  REPORT.obtainable.referenceMicroUsd = refMicroUsd === null ? null : String(refMicroUsd);

  // ── 6. What a fair-value seed actually costs ──────────────────────────────
  h1('6. WHAT A FAIR-VALUE SEED COSTS vs WHAT WE CAN PAY');
  const minSize = params.minSize ?? 0n;
  if (refMicroUsd !== null && minSize > 0n) {
    const fairPrice = floorTo(priceFromMicroUsd(refMicroUsd), params.tickSize ?? 1n);
    const fairQuote = (minSize * fairPrice) / FLOAT_SCALING;
    const feeMul = ((params.makerFee ?? 0n) * FEE_PENALTY_MULTIPLIER) / FLOAT_SCALING;
    const fairFee = (fairQuote * feeMul) / FLOAT_SCALING;
    say(`  smallest legal BID at ${fmtUsd(refMicroUsd)}/BTC:`);
    say(`    quantity            ${minSize} sats (pool min_size — cannot go smaller)`);
    say(`    price               ${fairPrice}`);
    say(`    quote required      ${fmtUnits(fairQuote + fairFee, CFG.dbusdcDecimals)} DBUSDC (incl. ${fmtUnits(fairFee, CFG.dbusdcDecimals)} input-coin maker fee)`);
    say(`  smallest legal ASK at the same price:`);
    say(`    base required       ${minSize} sats of hBTC (we hold ${hbtcWallet + (bmBal.hBTC ?? 0n)})`);
    say('');
    const affordableGross = BigInt(Math.floor(totalGross * Number(pow10(CFG.dbusdcDecimals))));
    const maxPrice = minSize > 0n ? floorTo((affordableGross * FLOAT_SCALING) / minSize, params.tickSize ?? 1n) : 0n;
    say(`  DBUSDC reachable      ${totalGross.toFixed(3)} (gross, the whole testnet)`);
    say(`  ⇒ highest bid we could ever post at min_size: price ${maxPrice} = ${fmtUsd(microUsdFromPrice(maxPrice))}/BTC`);
    const ratioBps = fairPrice > 0n ? (maxPrice * 10_000n) / fairPrice : 0n;
    say(`  ⇒ that is ${(Number(ratioBps) / 100).toFixed(1)}% of fair value.`);
    REPORT.obtainable.fairPrice = String(fairPrice);
    REPORT.obtainable.maxReachablePrice = String(maxPrice);
    REPORT.obtainable.reachablePctOfFairBps = String(ratioBps);
    if (ratioBps < 10_000n - MAX_DEV_BPS) {
      say('');
      say('  ✗✗ VERDICT: the bid side of this pool CANNOT be seeded at a credible price.');
      say('     There is not enough DBUSDC in existence on any reachable testnet book, and the');
      say('     DBUSDC TreasuryCap is owned by a third party. This is an inventory fact, not a bug.');
      REPORT.verdict.push('bid-side-unseedable-at-fair-value');
    }
  } else {
    say('  (skipped — no reference price and/or pool params unreadable)');
  }

  // ── 7. Plan ───────────────────────────────────────────────────────────────
  h1('7. PLAN');
  const plan = { sender: CFG.keeperAddress, swap: null, order: null };

  if (SWAP_SUI !== null && SWAP_SUI > 0) {
    if (acq.err || !acq.poolId || !acq.isv || !acq.typeOk) {
      say('  ✗ cannot plan the swap: no verified SUI/DBUSDC pool.');
      exitCode = 1;
    } else if (!acq.deepType) {
      say('  ✗ cannot plan the swap: DEEP coin type not discoverable (needed for coin::zero<DEEP>).');
      exitCode = 1;
    } else {
      const mistIn = BigInt(Math.round(SWAP_SUI * 1e9));
      const q = await devInspect({
        pkg: CFG.deepbookPackageId, module: 'pool', fn: 'get_quote_quantity_out_input_fee',
        typeArgs: [SUI_TYPE, CFG.dbusdcType], inputs: [sharedIn(acq.poolId, acq.isv), pureU64(mistIn), sharedIn(CLOCK_ID, CLOCK_ISV)],
      });
      const quoteOut = q.ok ? decU64(q.rv[1][0]) : 0n;
      const minQuoteOut = (quoteOut * (10_000n - SLIPPAGE_BPS)) / 10_000n;
      say(`  swap                  ${SWAP_SUI} SUI → DBUSDC on ${acq.poolId}`);
      say(`    simulated out       ${fmtUnits(quoteOut, CFG.dbusdcDecimals)} DBUSDC  (get_quote_quantity_out_input_fee)`);
      say(`    min_quote_out       ${minQuoteOut} (${SLIPPAGE_BPS} bps slippage)`);
      say(`    fee mode            input coin (deep_in = coin::zero<DEEP>)`);
      if (quoteOut === 0n) { say('    ✗ the swap would return nothing — refusing to plan it.'); exitCode = 1; }
      else plan.swap = { poolId: acq.poolId, isv: acq.isv, mistIn: String(mistIn), minQuoteOut: String(minQuoteOut), deepType: acq.deepType, expectedOut: String(quoteOut) };
      if (mistIn >= suiBal) { say(`    ✗ ${SWAP_SUI} SUI exceeds the wallet balance and leaves nothing for gas — refusing.`); plan.swap = null; exitCode = 1; }
    }
  } else {
    say('  swap                  none (pass --swap-sui=<n> to buy DBUSDC with SUI)');
  }

  // Order plan
  if (SWAP_ONLY) {
    say('  order                 skipped (--swap-only): acquire inventory now, rest an order in a later run');
    REPORT.plan = plan;
    return finish(plan, book, totalGross, hbtcWallet, bmBal);
  }
  const isBid = SIDE === 'bid';
  const qty = QTY_OVERRIDE ?? minSize;
  let price = PRICE_OVERRIDE;
  if (price === null && refMicroUsd !== null) price = floorTo(priceFromMicroUsd(refMicroUsd), params.tickSize ?? 1n);
  if (price === null) {
    say('  order                 ✗ no price available (no --price, no --usd, Hermes down)');
    exitCode = 1;
  } else {
    const quoteNeeded = (qty * price) / FLOAT_SCALING;
    const feeMul = ((params.makerFee ?? 0n) * FEE_PENALTY_MULTIPLIER) / FLOAT_SCALING;
    const fee = (quoteNeeded * feeMul) / FLOAT_SCALING;
    const impliedMicroUsd = microUsdFromPrice(price);
    const devBps = refMicroUsd && refMicroUsd > 0n
      ? ((impliedMicroUsd > refMicroUsd ? impliedMicroUsd - refMicroUsd : refMicroUsd - impliedMicroUsd) * 10_000n) / refMicroUsd
      : 0n;
    say(`  order                 POST_ONLY ${SIDE.toUpperCase()}  ${qty} sats @ ${price}  (${fmtUsd(impliedMicroUsd)}/BTC)`);
    say(`    deviation vs oracle ${devBps} bps (limit ${MAX_DEV_BPS})`);
    say(`    needs in the BM     ${isBid ? `${fmtUnits(quoteNeeded + fee, CFG.dbusdcDecimals)} DBUSDC` : `${qty} sats hBTC`}`);
    const haveQuote = (bmBal.DBUSDC ?? 0n) + BigInt(plan.swap ? plan.swap.expectedOut : 0);
    const haveBase = bmBal.hBTC ?? 0n;
    const have = isBid ? haveQuote : haveBase;
    const need = isBid ? quoteNeeded + fee : qty;

    const problems = [];
    if (minSize <= 0n) problems.push('pool min_size is unreadable — refusing to size an order blind');
    if (qty <= 0n) problems.push('quantity resolves to 0');
    if (qty < minSize) problems.push(`quantity ${qty} < pool min_size ${minSize} (EOrderBelowMinimumSize)`);
    if ((params.lotSize ?? 1n) > 0n && qty % (params.lotSize ?? 1n) !== 0n) problems.push(`quantity not a multiple of lot_size ${params.lotSize}`);
    if ((params.tickSize ?? 1n) > 0n && price % (params.tickSize ?? 1n) !== 0n) problems.push(`price not a multiple of tick_size ${params.tickSize}`);
    if (!weOwnBm) problems.push('we do not own the BalanceManager');
    if (have < need) problems.push(`insufficient inventory: have ${have}, need ${need}`);
    if (devBps > MAX_DEV_BPS && !ALLOW_OFF_MARKET) problems.push(`price is ${devBps} bps off the oracle — pass --allow-off-market to place it knowingly`);

    if (problems.length) {
      say('    ✗ NOT PLACEABLE:');
      for (const p of problems) say(`        · ${p}`);
      exitCode = 1;
    } else {
      plan.order = { isBid, qty: String(qty), price: String(price), clientOrderId: 1, expireMs: String(BigInt(Date.now()) + 30n * 24n * 3600n * 1000n) };
      say('    ✓ placeable');
    }
  }
  REPORT.plan = plan;
  return finish(plan, book, totalGross, hbtcWallet, bmBal);
}

/** Section 8 + SUMMARY. Shared by the normal path and the --swap-only early return. */
function finish(plan, book, totalGross, hbtcWallet, bmBal) {
  // ── 8. The PTB ────────────────────────────────────────────────────────────
  h1('8. THE EXACT PTB');
  if (!plan.swap && !plan.order) {
    say('  (nothing to build — no action is currently possible; see the verdict above)');
  } else {
    const args = renderPtb(plan);
    const cmd = ['sui', 'client', 'ptb', ...args].map(quoteArg).join(' ');
    say('  ' + cmd.replace(/ --/g, '\n    --'));
    REPORT.ptb = args;

    if (CHAIN_DRY_RUN) {
      say('');
      say('  running `sui client ptb --dry-run` (no state change) …');
      const r = runSui(['client', 'ptb', ...args, '--dry-run']);
      say(`  exit ${r.code ?? 'n/a'}`);
      const tail = ((r.stdout || '') + (r.stderr || '')).split(/\r?\n/).filter(Boolean);
      for (const l of tail.slice(0, 40)) say('    ' + l);
      if (!r.ok) exitCode = 1;
    }

    if (EXECUTE) {
      if (exitCode !== 0) {
        say('');
        say('  ✗ refusing to execute: the plan above has unresolved problems.');
      } else {
        say('');
        say('  *** EXECUTING ***');
        const r = runSui(['client', 'ptb', ...args, '--json'], { capture: true });
        say(`  exit ${r.code ?? 'n/a'}`);
        for (const l of ((r.stdout || '') + (r.stderr || '')).split(/\r?\n/).filter(Boolean).slice(0, 60)) say('    ' + l);
        if (!r.ok) exitCode = 1;
      }
    } else {
      say('');
      say('  DRY RUN — nothing was signed or submitted. Add --execute to actually run it.');
    }
  }

  h1('SUMMARY');
  say(`  DBUSDC mintable by us       ${REPORT.obtainable.dbusdcTreasuryCap?.mintableByAnyone ? 'YES' : 'NO'}`);
  say(`  DBUSDC reachable on books   ${totalGross.toFixed(3)}`);
  say(`  hBTC we hold                ${hbtcWallet + (bmBal.hBTC ?? 0n)} sats`);
  say(`  book                        bids ${book.bids.prices?.length ?? '?'} · asks ${book.asks.prices?.length ?? '?'}`);
  say(`  mid_price                   ${book.mid === null ? 'UNDEFINED (needs both sides)' : String(book.mid)}`);
  say(`  action taken                ${EXECUTE && exitCode === 0 ? 'executed' : 'none (dry run)'}`);

  if (AS_JSON) console.log(JSON.stringify(REPORT, (_, v) => (typeof v === 'bigint' ? String(v) : v), 2));
}

main().then(() => process.exit(exitCode)).catch((e) => {
  console.error(e?.stack ?? String(e));
  process.exit(2);
});
