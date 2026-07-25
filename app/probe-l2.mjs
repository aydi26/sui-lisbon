// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T5.3
// @phase      5
// @status     DONE
// @spec       docs/RECON.md R10 (the hosted DeepBook indexer does not list this pool)
// @spec       docs/APP.md ERRATA E-A7 (an empty book is a DEFINED state)
// @rules      G4 G7 G9
// @depends    app/.env.local (the ids of record) · @mysten/sui 2.22.1
// @facts      Ops probe: what the hBTC/DBUSDC book actually holds, straight off
// @facts        pool::get_level2_range by devInspect. On an EMPTY side the call
// @facts        SUCCEEDS and returns ([], []) — that is the answer, not a failure.
// @facts        pool::mid_price would abort EEmptyOrderbook and is never called.
// @facts      ⚠ Every id is read from app/.env.local, never written here: the `ids`
// @facts        gate fails the whole repo on a canonical id outside config/.env (G7).
// @implements node app/probe-l2.mjs
// @forbidden  a canonical on-chain id literal in this file — G7
// @verify     cd app && node probe-l2.mjs
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bcs } from '@mysten/sui/bcs';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';

const here = dirname(fileURLToPath(import.meta.url));

/** The app's own env file is the single source of ids for this probe (G7). */
function env(name) {
  for (const file of ['.env.local', '.env.example']) {
    let text;
    try {
      text = readFileSync(join(here, file), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (match !== null && match[1] === name) {
        const value = match[2].trim().replace(/^['"]|['"]$/g, '');
        if (value !== '') return value;
      }
    }
  }
  throw new Error(`${name} is not set in app/.env.local — nothing to probe.`);
}

const RPC = env('VITE_SUI_JSONRPC_URL');
const POOL = env('VITE_DEEPBOOK_POOL');
const DEEPBOOK = env('VITE_DEEPBOOK_PACKAGE');
const BASE = env('VITE_HBTC_TYPE');
const QUOTE = env('VITE_DBUSDC_TYPE');
const ZERO = `0x${'0'.repeat(64)}`;

const client = new SuiJsonRpcClient({ network: 'testnet', url: RPC });

const tx = new Transaction();
for (const isBid of [true, false]) {
  tx.moveCall({
    target: `${DEEPBOOK}::pool::get_level2_range`,
    typeArguments: [BASE, QUOTE],
    arguments: [
      tx.object(POOL),
      tx.pure.u64(1n),
      tx.pure.u64((1n << 63n) - 1n),
      tx.pure.bool(isBid),
      tx.object.clock(),
    ],
  });
}

const bytes = await tx.build({ client, onlyTransactionKind: true });
const result = await client.devInspectTransactionBlock({ sender: ZERO, transactionBlock: bytes });

console.log('pool  ', POOL);
console.log('status', JSON.stringify(result.effects?.status));

const vec = bcs.vector(bcs.u64());
const sides = ['bids', 'asks'];
(result.results ?? []).forEach((command, index) => {
  const [prices, quantities] = (command.returnValues ?? []).map(([b]) =>
    vec.parse(Uint8Array.from(b)),
  );
  console.log(
    `${sides[index] ?? `cmd${index}`}: ${prices?.length ?? 0} level(s)`,
    prices?.length ? { prices, quantities } : '(empty side — a read, not an error)',
  );
});
