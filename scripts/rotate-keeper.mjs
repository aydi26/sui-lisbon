#!/usr/bin/env node
// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       ops — governance rotation, no BUILD-PLAN unit id
// @phase      ops
// @status     DONE
// @spec       aphotic.md §6.2 (NAV is two PARTIES, not two scopes)
// @spec       move/sources/vault.move  — `rotate_keeper<B,Q,S>(v, &AdminCap, addr, ctx)`
// @spec       move/sources/caps.move   — `rotate_keeper_cap`: bumps `keeper_epoch`,
//             sets `reg.keeper`, and transfers a FRESH `KeeperCap` to the new address.
//             The old cap goes stale by epoch; nothing has to be clawed back.
// @rules      G3 (the two-party split) · G7 (every id arrives as config)
// @facts      THE PROBLEM THIS FIXES. `scripts/verify-onchain.mjs` reports
// @facts        `admin != keeper  FAIL` whenever one address holds both roles. On
// @facts        2026-07-26 that was the live state: `Vault.caps.admin` and
// @facts        `.keeper` were both 0xd41b0cd8…f333d. The Move is not at fault —
// @facts        the bytecode is identical either way — so no upgrade is needed.
// @facts        ONE transaction, signed by the AdminCap holder, closes it.
// @facts      WHAT IT DOES NOT DO. It does not move the AdminCap. Handing over
// @facts        admin is the two-step `initiate_admin_transfer` /
// @facts        `accept_admin_transfer` dance and can strand the vault if step 2
// @facts        never runs, so it is deliberately out of scope here. Rotating the
// @facts        KEEPER is the one-transaction, non-bricking half.
// @facts      Type arguments are read off the live object's type, never guessed —
// @facts        `Vault<B, Q, S>` is generic and the share type S is deployment-local.
// @implements node scripts/rotate-keeper.mjs <new-keeper-address> [--execute]
// @forbidden  sending without a successful dry run first (the repo-wide
//             devInspect-then-send rule — a revert must never be broadcast)
// @forbidden  a hardcoded object id — everything resolves from env / keeper/.env
// @forbidden  rotating the keeper TO the admin address: that is a no-op that looks
//             like a fix, and it would leave `verify-onchain` failing
// @invariant  1. Dry runs by default. `--execute` is required to sign anything.
// @invariant  2. Refuses when the new keeper equals the current admin.
// @invariant  3. Refuses when the new keeper is already the keeper (nothing to do).
// @invariant  4. Prints the before state, read from chain, before proposing a change.
// @verify     node scripts/rotate-keeper.mjs 0x<addr>           # dry run, safe
// @verify     node scripts/verify-onchain.mjs                   # admin != keeper PASS
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── config resolution: process.env → keeper/.env ─────────────────────────────
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
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (v !== '') out[k] = v;
  }
  return out;
}

const dotEnv = parseDotEnv(join(REPO, 'keeper', '.env'));
const cfg = (k) => process.env[k] ?? dotEnv[k] ?? '';

const PACKAGE_ID = cfg('APHOTIC_PACKAGE_ID');
const VAULT_ID = cfg('APHOTIC_VAULT_ID') || cfg('VAULT_ID');
const ADMIN_CAP_ID = cfg('APHOTIC_ADMIN_CAP_ID');
const RPC = cfg('SUI_JSON_RPC_URL') || 'https://rpc-testnet.suiscan.xyz:443';
const GAS_BUDGET = cfg('ROTATE_GAS_BUDGET') || '30000000';

const ADDRESS_RE = /^0x[0-9a-fA-F]{64}$/;

function die(msg) {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
}

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) die(`${method}: ${json.error.message}`);
  return json.result;
}

/** `Vault<B, Q, S>` → ['B', 'Q', 'S'], split at DEPTH ZERO so nested generics survive. */
function typeArgsOf(objectType) {
  const open = objectType.indexOf('<');
  if (open === -1) die(`vault type carries no type arguments: ${objectType}`);
  const inner = objectType.slice(open + 1, objectType.lastIndexOf('>'));
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '<') depth++;
    else if (c === '>') depth--;
    else if (c === ',' && depth === 0) {
      out.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(inner.slice(start).trim());
  return out;
}

// ── go ──────────────────────────────────────────────────────────────────────
const newKeeper = process.argv[2];
const execute = process.argv.includes('--execute');

if (!newKeeper || newKeeper.startsWith('--')) {
  console.error(`
  Rotate the vault's KEEPER role to a second address, so that NAV really is two
  parties: the keeper proposes, the admin approves.

    node scripts/rotate-keeper.mjs <new-keeper-address>            # dry run
    node scripts/rotate-keeper.mjs <new-keeper-address> --execute   # sign and send

  Signs with whatever \`sui client active-address\` is, which MUST be the address
  that owns the AdminCap. Nothing here moves the AdminCap itself.
`);
  process.exit(2);
}
if (!ADDRESS_RE.test(newKeeper)) die(`not a Sui address: ${newKeeper}`);

for (const [k, v] of [
  ['APHOTIC_PACKAGE_ID', PACKAGE_ID],
  ['APHOTIC_VAULT_ID', VAULT_ID],
  ['APHOTIC_ADMIN_CAP_ID', ADMIN_CAP_ID],
]) {
  if (!v) die(`${k} is unset — put it in keeper/.env or the environment (G7)`);
}

console.log('Aphotic — rotate the keeper role');
console.log(`  rpc         : ${RPC}`);
console.log(`  package     : ${PACKAGE_ID}`);
console.log(`  vault       : ${VAULT_ID}`);
console.log(`  admin cap   : ${ADMIN_CAP_ID}`);

const vault = await rpc('sui_getObject', [
  VAULT_ID,
  { showType: true, showContent: true, showOwner: true },
]);
const caps = vault?.data?.content?.fields?.caps?.fields;
if (!caps) die('vault exposed no `caps` field — wrong id, or a package upgrade moved it');

const admin = caps.admin;
const keeper = caps.keeper;
console.log('\n  BEFORE, read from chain');
console.log(`    admin       : ${admin}`);
console.log(`    keeper      : ${keeper}   (epoch ${caps.keeper_epoch})`);
console.log(
  `    two-party   : ${admin.toLowerCase() === keeper.toLowerCase() ? 'NOT LIVE — one key holds both roles' : 'live'}`,
);

if (newKeeper.toLowerCase() === admin.toLowerCase()) {
  die(
    'that address is the ADMIN. Rotating the keeper onto the admin address is a no-op\n' +
      '    that looks like a fix — verify-onchain would still fail. Pick a second party.',
  );
}
if (newKeeper.toLowerCase() === keeper.toLowerCase()) {
  die(`that address is ALREADY the keeper (epoch ${caps.keeper_epoch}). Nothing to do.`);
}

const typeArgs = typeArgsOf(vault.data.type);
console.log(`\n  type args   : ${typeArgs.join(' , ')}`);
console.log(`  new keeper  : ${newKeeper}`);

const args = [
  'client',
  'call',
  '--package',
  PACKAGE_ID,
  '--module',
  'vault',
  '--function',
  'rotate_keeper',
  '--type-args',
  ...typeArgs,
  '--args',
  VAULT_ID,
  ADMIN_CAP_ID,
  newKeeper,
  '--gas-budget',
  GAS_BUDGET,
];

// Dry run ALWAYS. A revert must never be broadcast.
console.log('\n  DRY RUN …');
let dry;
try {
  dry = execFileSync('sui', [...args, '--dry-run'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  const out = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim();
  die(`dry run failed — nothing was sent.\n\n${out}`);
}
const failed = /failure|error/i.test(dry) && !/status.*success/i.test(dry);
console.log(dry.split('\n').filter((l) => /Status|Error|Gas|Owner|Created|Mutated/i.test(l)).slice(0, 12).join('\n') || dry.slice(0, 600));
if (failed) die('dry run reports a failure — not sending.');
console.log('  DRY RUN OK.');

if (!execute) {
  console.log('\n  Nothing was signed. Re-run with --execute to send it.\n');
  process.exit(0);
}

console.log('\n  EXECUTING …');
try {
  const out = execFileSync('sui', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  console.log(out.split('\n').filter((l) => /Digest|Status|Created|Owner/i.test(l)).slice(0, 12).join('\n') || out.slice(0, 800));
} catch (e) {
  die(`send failed.\n\n${`${e.stdout ?? ''}${e.stderr ?? ''}`.trim()}`);
}

const after = await rpc('sui_getObject', [VAULT_ID, { showContent: true }]);
const a = after?.data?.content?.fields?.caps?.fields;
console.log('\n  AFTER, read from chain');
console.log(`    admin       : ${a?.admin}`);
console.log(`    keeper      : ${a?.keeper}   (epoch ${a?.keeper_epoch})`);
console.log(
  `    two-party   : ${String(a?.admin).toLowerCase() === String(a?.keeper).toLowerCase() ? 'STILL NOT LIVE' : 'LIVE'}`,
);
console.log('\n  Now re-run:  node scripts/verify-onchain.mjs   (expect `admin != keeper  PASS`)');
console.log('  And update APHOTIC_KEEPER_ADDRESS / APHOTIC_KEEPER_CAP_ID in keeper/.env.\n');
