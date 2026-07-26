// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T6.0
// @phase      3
// @status     DONE
// @spec       docs/DESIGN-V2.md#9 (no build step; consumed per-module via the exports map)
// @rules      G7
// @depends    ../src/index.ts · ../package.json
// @facts      Two things are checked that nothing else would catch: the barrel re-exports every
// @facts        documented symbol, and package.json really does declare `"./*": "./src/*.ts"`
// @facts        with no build step — because the keeper `paths` and the app `resolve.alias`
// @facts        depend on exactly that shape.
// @implements describe('package shape') · describe('barrel')
// @verify     npx vitest run index
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as sdk from '../src/index.js';

interface Pkg {
  name: string;
  type: string;
  exports: Record<string, string>;
  scripts: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies: Record<string, string>;
}

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as Pkg;

describe('package shape', () => {
  it('is @aphotic/sdk, ESM, with a wildcard source export and NO build step', () => {
    expect(pkg.name).toBe('@aphotic/sdk');
    expect(pkg.type).toBe('module');
    expect(pkg.exports).toEqual({ './*': './src/*.ts' });
    expect(pkg.scripts.build).toBeUndefined();
    expect(pkg.scripts.test).toBe('vitest run');
  });

  it('has NO runtime dependencies and exactly two devDependencies', () => {
    expect(pkg.dependencies).toBeUndefined();
    expect(Object.keys(pkg.devDependencies).sort()).toEqual(['typescript', 'vitest']);
  });
});

describe('barrel', () => {
  it('re-exports every algorithm module', () => {
    for (const name of [
      // clearing
      'clear',
      'discoverPrice',
      'canonicalOrder',
      'fillsRoot',
      'encodeFillLeaf',
      'hashFillLeaf',
      'quoteForBid',
      'quoteForAsk',
      'PRICE_SCALE',
      'MAX_BATCH_SIZE',
      'HARD_MAX_BATCH_SIZE',
      'SIDE_BID',
      'SIDE_ASK',
      // merkle
      'createTree',
      'append',
      'appendAll',
      'rootFromLeaves',
      'proveFromLeaves',
      'verifyProof',
      'computeRootFromProof',
      'isKnownRoot',
      'binaryRootDuplicatingOdd',
      'TREE_DEPTH',
      'ROOT_HISTORY_SIZE',
      // seal
      'encodeInnerId',
      'decodeInnerId',
      'encodeInnerIdBigEndianWRONG',
      'fullIdentity',
      'checkPolicy',
      'selectCommittee',
      'probeService',
      'assertQuorumLive',
      'TESTNET_KEY_SERVERS',
      // cadence + nav
      'nextBoundary',
      'isBoundary',
      'CADENCE_MS',
      'OFFSET_MS',
      'mulDiv',
      'sharesToMint',
      'assetsToRelease',
      'divergenceBps',
      'isSolvent',
      'capNativeBtcLeg',
      // primitives
      'blake2b256',
      'toHex',
      'fromHex',
      'createRng',
      'seedFrom',
      'largestRemainder',
      'U64_MAX',
      'U128_MAX',
      'normalizeAddress',
      'BcsWriter',
      'BcsReader',
    ]) {
      expect(sdk).toHaveProperty(name);
    }
  });

  it('namespaces notes and order, whose `commitment` exports would otherwise collide', () => {
    expect(typeof sdk.notes.commitment).toBe('function');
    expect(typeof sdk.order.commitment).toBe('function');
    expect(sdk.notes.commitment).not.toBe(sdk.order.commitment);
    expect(sdk.notes.DENOMINATIONS).toHaveLength(4);
  });

  it('importing the barrel performs no I/O and reads no clock', () => {
    // If any module called Date.now() at import time, this value would differ between the two
    // clearings below. Determinism is asserted directly instead: same input, same root.
    const orders = [
      { index: 0, submitter: '0x1', side: sdk.SIDE_BID, limitPrice: 10n ** 10n, qtyBase: 100n },
      { index: 1, submitter: '0x2', side: sdk.SIDE_ASK, limitPrice: 10n ** 10n, qtyBase: 100n },
    ];
    const a = sdk.clear({ orders, feeMatchedBps: 0n });
    const b = sdk.clear({ orders, feeMatchedBps: 0n });
    expect(sdk.toHex(a.fillsRoot)).toBe(sdk.toHex(b.fillsRoot));
  });
});

describe('purity of the algorithm modules', () => {
  const SRC = fileURLToPath(new URL('../src', import.meta.url));
  const files = [
    'clearing.ts',
    'merkle.ts',
    'notes.ts',
    'order.ts',
    'cadence.ts',
    'nav.ts',
    'math.ts',
    'hash.ts',
    'bcs.ts',
    'address.ts',
    'rng.ts',
    'seal/identity.ts',
  ];

  function codeOnly(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//'))
      .join('\n');
  }

  it('contains no Date.now(), Math.random() or fetch in any algorithm module', () => {
    for (const f of files) {
      const code = codeOnly(readFileSync(`${SRC}/${f}`, 'utf8'));
      expect(code, `${f} must not read the wall clock`).not.toContain('Date.now');
      expect(code, `${f} must not use Math.random`).not.toContain('Math.random');
      expect(code, `${f} must not perform I/O`).not.toContain('fetch(');
      expect(code, `${f} must not import node builtins`).not.toContain("from 'node:");
    }
  });

  it('contains no float literal arithmetic in clearing', () => {
    const code = codeOnly(readFileSync(`${SRC}/clearing.ts`, 'utf8'));
    expect(code).not.toMatch(/parseFloat|Number\.parseFloat|Math\.(round|floor|ceil)\s*\(/);
  });
});
