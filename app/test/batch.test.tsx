// @vitest-environment jsdom
// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F3
// @phase      3
// @status     DONE
// @spec       aphotic.md §7.1 (notes), §7.2 (the batch), §7.4 (what is and is not
//             hidden), §7.5 (Seal committee)
// @spec       docs/DESIGN-V2.md §3 (the commitment binds the PLAINTEXT, the submit
//             cut-off), §5 (clearing, PRICE_SCALE), §11 (the ladder), D8, D9
// @spec       move/sources/batch.move — `Order`, `order_commitment`, `submit_order`
// @spec       move/sources/notes.move — `commitment`, `nullifier`, `compute_root`
// @rules      G7 G8 G10
// @depends    ../src/lib/{order,notes,seal,walrus}.ts · ../src/screens/batch/**
// @facts      ⚠ PRICE_SCALE = 100_000_000 (1e8), matching `clearing::price_scale()`.
// @facts        NOT 1e9. A price scaled at 1e9 is a 10× mispricing that no type
// @facts        checker catches, so the constant is pinned here by value.
// @facts      THE COMMITMENT BINDS THE PLAINTEXT. Every field of `Order` is proven
// @facts        load-bearing below: flip any one and the commitment must move. A
// @facts        field that does not move the digest is a field an adversary can
// @facts        change after the fact.
// @facts      NEVER FALL BACK TO PLAINTEXT (D9). The suite runs with
// @facts        VITE_SEAL_KEY_SERVER_IDS='' — the worst configuration — and asserts
// @facts        `encryptOrder` REFUSES rather than degrading. An order that cannot
// @facts        be sealed is an order that is not submitted.
// @facts      NO FREE-FORM AMOUNT OR PRICE FIELD. The denomination ladder IS the
// @facts        product: a `Balance<BTC>` carries a publicly readable value, so an
// @facts        exact-amount control would make encrypting the order pointless. The
// @facts        price ladder is coarse for the same reason.
// @facts      ⚠ D8 — v1 note spends are LINKABLE (the Merkle path is in the clear,
// @facts        so `leaf_index` names the note). The disclosure renders
// @facts        UNCONDITIONALLY — it is not gated on a wallet, a read or a config.
// @facts      2026-07-26 — /batch WAS TRIMMED for the new /docs page and
// @facts        de-emphasised behind the vault. This file is now also the guard
// @facts        on that trim, in BOTH directions: the pitch essay, the
// @facts        four-state walkthrough, the committee dashboard and the second
// @facts        countdown must stay OFF the screen, while every disclosure above
// @facts        must stay ON it. A trim that took a disclosure with it would be
// @facts        indistinguishable from a trim that worked, without these.
// @implements the /batch safety net: ladder exactness, plaintext binding, the
//             refusal to seal, the cut-off, the linkability disclosure, and that
//             the trim removed only teaching
// @forbidden  relaxing the no-input assertion to accommodate a design tweak
// @forbidden  a network call — every panel is asserted inert on mount
// @invariant  1. Every ladder rung converts to an exact integer price at 1e8.
// @invariant  2. orderCommitment is sensitive to every field of the order.
// @invariant  3. An unconfigured committee refuses to encrypt; an unconfigured
//                publisher refuses to store — both BEFORE any request is made.
// @invariant  4. Nothing on /batch fetches on mount.
// @invariant  5. The screen states D9 and D8 with no wallet, no read, no config.
// @ac         cd app && npm test -- batch
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SuiClientProvider, WalletProvider, createNetworkConfig } from '@mysten/dapp-kit';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bytesEqual, toHex } from '@aphotic/sdk/hash';
import { PRICE_SCALE } from '@aphotic/sdk/clearing';

import { config } from '../src/config';
import {
  DISCOUNT_STEPS_BPS,
  PAR_PRICE,
  SALT_LEN,
  decodeOrderPlaintext,
  discountBpsForPrice,
  encodeOrder,
  encodeOrderPlaintext,
  newSalt,
  orderCommitment,
  priceForDiscountBps,
  type PlainOrder,
} from '../src/lib/order';
import {
  NOTE_TREE_DEPTH,
  commitment,
  nullifier,
  pathMatchesRoot,
  randomBytes,
  rootFromLeaves,
  rootFromPath,
  siblingsFor,
} from '../src/lib/notes';
import { encryptOrder, innerIdentity, sealConfigured } from '../src/lib/seal';
import { blobIdBytes, blobIdFromBytes, ciphertextHash, putBlob, walrusConfigured } from '../src/lib/walrus';
import type { BatchSnapshot, LiveBatch, RegistrySnapshot } from '../src/lib/batch';
import BatchScreen from '../src/screens/batch/BatchScreen';
import NotePanel from '../src/screens/batch/NotePanel';
import OrderTicket from '../src/screens/batch/OrderTicket';

// ── fixtures ────────────────────────────────────────────────────────────────

const ADDRESS = `0x${'ab'.repeat(32)}`;

function order(patch: Partial<PlainOrder> = {}): PlainOrder {
  return {
    submitter: ADDRESS,
    isBid: true,
    limitPrice: PAR_PRICE,
    qtySats: 100_000_000n,
    salt: new Uint8Array(SALT_LEN).fill(7),
    ...patch,
  };
}

const REGISTRY: RegistrySnapshot = {
  cadenceMs: 43_200_000n,
  offsetMs: 21_600_000n,
  policyVersion: 1n,
  maxBatchSize: 256n,
  submitCutoffMs: 60_000n,
  revealGraceMs: 600_000n,
  nextBatchId: 2n,
  liveBatches: 1n,
};

function batchAt(closeMs: bigint, state = 0): BatchSnapshot {
  return {
    objectId: `0x${'cd'.repeat(32)}`,
    batchId: 1n,
    state,
    policyVersion: 1n,
    openedAtMs: 0n,
    closeMs,
    closedAtMs: 0n,
    maxOrders: 256n,
    submitCutoffMs: 60_000n,
    revealGraceMs: 600_000n,
    orderCount: 3n,
    revealedCount: 0n,
  };
}

function live(closeMs: bigint, state = 0): LiveBatch {
  return { registry: REGISTRY, batch: batchAt(closeMs, state) };
}

const { networkConfig } = createNetworkConfig({
  testnet: { network: 'testnet', url: config.sui.jsonRpcUrl },
});

function wrap(node: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <SuiClientProvider networks={networkConfig} defaultNetwork="testnet">
        <WalletProvider>{node}</WalletProvider>
      </SuiClientProvider>
    </QueryClientProvider>,
  );
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn(() => Promise.reject(new Error('the network is down')));
  vi.stubGlobal('fetch', fetchSpy);
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ── the price scale, pinned by value ────────────────────────────────────────

describe('the price scale', () => {
  it('is 1e8, matching clearing::price_scale() — not 1e9', () => {
    expect(PRICE_SCALE).toBe(100_000_000n);
    expect(PAR_PRICE).toBe(100_000_000n);
  });

  it('prices par as exactly one quote sat per base sat', () => {
    expect(priceForDiscountBps(0n)).toBe(PRICE_SCALE);
  });

  it('converts every ladder rung to an exact integer — no rounding anywhere', () => {
    for (const bps of DISCOUNT_STEPS_BPS) {
      const price = priceForDiscountBps(bps);
      expect(price * 10_000n).toBe(PAR_PRICE * (10_000n - bps));
      expect(discountBpsForPrice(price)).toBe(bps);
    }
  });

  it('keeps the ladder coarse — a precise price fingerprints an order', () => {
    expect(DISCOUNT_STEPS_BPS).toEqual([0n, 5n, 10n, 25n, 50n, 100n]);
    // Every gap is at least 5 bps: fine enough to express intent, too coarse to
    // act as a serial number.
    for (let i = 1; i < DISCOUNT_STEPS_BPS.length; i += 1) {
      expect(DISCOUNT_STEPS_BPS[i]! - DISCOUNT_STEPS_BPS[i - 1]!).toBeGreaterThanOrEqual(5n);
    }
  });

  it('refuses a discount outside [0, 10000] bps', () => {
    expect(() => priceForDiscountBps(-1n)).toThrow(RangeError);
    expect(() => priceForDiscountBps(10_001n)).toThrow(RangeError);
  });
});

// ── the commitment binds the plaintext ──────────────────────────────────────

describe('orderCommitment', () => {
  it('encodes the DEPLOYED Move struct: 32B address ‖ bool ‖ u64 ‖ u64 ‖ ULEB ‖ salt', () => {
    const bytes = encodeOrder(order());
    expect(bytes).toHaveLength(32 + 1 + 8 + 8 + 1 + SALT_LEN);
    expect(bytes[32]).toBe(1); // is_bid = true
    expect(bytes[32 + 1 + 8 + 8]).toBe(SALT_LEN); // ULEB length of the salt
  });

  it('is deterministic for the same order', () => {
    expect(toHex(orderCommitment(order()))).toBe(toHex(orderCommitment(order())));
  });

  it('moves when ANY field moves — every field is load-bearing', () => {
    const base = toHex(orderCommitment(order()));
    const variants: readonly Partial<PlainOrder>[] = [
      { submitter: `0x${'cd'.repeat(32)}` },
      { isBid: false },
      { limitPrice: priceForDiscountBps(25n) },
      { qtySats: 1_000_000n },
      { salt: new Uint8Array(SALT_LEN).fill(9) },
    ];
    for (const patch of variants) {
      expect(toHex(orderCommitment(order(patch)))).not.toBe(base);
    }
  });

  it('refuses a salt that is not exactly 32 bytes', () => {
    expect(() => encodeOrder(order({ salt: new Uint8Array(16) }))).toThrow(RangeError);
  });

  it('draws a fresh 32-byte salt from the platform CSPRNG each time', () => {
    const a = newSalt();
    const b = newSalt();
    expect(a).toHaveLength(SALT_LEN);
    expect(bytesEqual(a, b)).toBe(false);
  });
});

describe('the sealed payload', () => {
  it('round-trips every field, so a third party can reveal it with no schema handshake', () => {
    const o = order({ isBid: false, limitPrice: priceForDiscountBps(50n), qtySats: 10_000_000n });
    const decoded = decodeOrderPlaintext(encodeOrderPlaintext(o));
    expect(decoded.submitter).toBe(o.submitter);
    expect(decoded.isBid).toBe(o.isBid);
    expect(decoded.limitPrice).toBe(o.limitPrice);
    expect(decoded.qtySats).toBe(o.qtySats);
    expect(bytesEqual(decoded.salt, o.salt)).toBe(true);
  });

  it('re-derives the SAME commitment after a round trip — reveal cannot drift', () => {
    const o = order({ isBid: false, limitPrice: priceForDiscountBps(10n) });
    const back = decodeOrderPlaintext(encodeOrderPlaintext(o));
    expect(toHex(orderCommitment(back))).toBe(toHex(orderCommitment(o)));
  });

  it('refuses a half-parsed payload rather than revealing a partial order', () => {
    const truncated = new TextEncoder().encode(JSON.stringify({ v: 1, submitter: ADDRESS }));
    expect(() => decodeOrderPlaintext(truncated)).toThrow(/missing a field/i);
  });
});

// ── notes: the commitment, the nullifier, the path ──────────────────────────

describe('note commitments', () => {
  const secret = new Uint8Array(32).fill(1);
  const r = new Uint8Array(32).fill(2);

  it('domain-separates the leaf, the nullifier and the node hashes', () => {
    const leaf = toHex(commitment(0, secret, r));
    const nul = toHex(nullifier(secret, 0n));
    expect(leaf).not.toBe(nul);
  });

  it('binds the denomination — the same secret at another tier is another note', () => {
    expect(toHex(commitment(0, secret, r))).not.toBe(toHex(commitment(1, secret, r)));
  });

  it('binds the leaf index into the nullifier, so one note spends once', () => {
    expect(toHex(nullifier(secret, 0n))).not.toBe(toHex(nullifier(secret, 1n)));
  });

  it('refuses a secret or randomness that is not 32 bytes', () => {
    expect(() => commitment(0, new Uint8Array(16), r)).toThrow(RangeError);
    expect(() => commitment(0, secret, new Uint8Array(31))).toThrow(RangeError);
  });

  it('draws note material from the platform CSPRNG', () => {
    expect(bytesEqual(randomBytes(32), randomBytes(32))).toBe(false);
  });
});

describe('the Merkle path, built client-side', () => {
  // A small tree is enough to prove the fold; the depth is the contract's.
  const leaves = [0, 1, 2, 3, 4].map((i) =>
    commitment(i % 4, new Uint8Array(32).fill(i + 1), new Uint8Array(32).fill(i + 100)),
  );

  it('folds every leaf to the root the contract would publish', () => {
    const root = rootFromLeaves(leaves, NOTE_TREE_DEPTH);
    for (let i = 0; i < leaves.length; i += 1) {
      const siblings = siblingsFor(leaves, i, NOTE_TREE_DEPTH);
      expect(siblings).toHaveLength(NOTE_TREE_DEPTH);
      expect(bytesEqual(rootFromPath(leaves[i]!, i, siblings), root)).toBe(true);
      expect(pathMatchesRoot(leaves[i]!, i, siblings, root)).toBe(true);
    }
  });

  it('rejects a path presented at the wrong index — the index is part of the claim', () => {
    const root = rootFromLeaves(leaves, NOTE_TREE_DEPTH);
    const siblings = siblingsFor(leaves, 1, NOTE_TREE_DEPTH);
    expect(pathMatchesRoot(leaves[1]!, 2, siblings, root)).toBe(false);
  });

  it('rejects a path against a root nobody published', () => {
    const siblings = siblingsFor(leaves, 0, NOTE_TREE_DEPTH);
    expect(pathMatchesRoot(leaves[0]!, 0, siblings, new Uint8Array(32))).toBe(false);
  });

  it('refuses to build a path for a leaf outside the known list', () => {
    expect(() => siblingsFor(leaves, 99, NOTE_TREE_DEPTH)).toThrow(RangeError);
  });
});

// ── the refusals: never claim encrypted unless it was ───────────────────────

describe('Seal, unconfigured', () => {
  it('reports itself unconfigured when no committee is wired', () => {
    expect(config.seal.keyServerIds).toHaveLength(0);
    expect(sealConfigured()).toBe(false);
  });

  it('REFUSES to encrypt rather than falling back to plaintext (D9)', async () => {
    await expect(
      encryptOrder({
        closeMs: 1_800_000_000_000n,
        batchObjectId: `0x${'cd'.repeat(32)}`,
        plaintext: encodeOrderPlaintext(order()),
      }),
    ).rejects.toThrow();
    // And it refused BEFORE reaching for the network.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('builds a 48-byte inner identity that changes with the close time', () => {
    // The identity is the sdk's LITTLE-ENDIAN encoding; getting it backwards
    // produces a policy that never opens and fails silently.
    const a = innerIdentity(1_800_000_000_000n, `0x${'cd'.repeat(32)}`);
    const b = innerIdentity(1_800_000_043_200n, `0x${'cd'.repeat(32)}`);
    expect(a).toHaveLength(48);
    expect(bytesEqual(a, b)).toBe(false);
  });
});

describe('Walrus, unconfigured', () => {
  it('reports itself unconfigured when no publisher is wired', () => {
    expect(walrusConfigured()).toBe(false);
  });

  it('REFUSES to store before making any request', async () => {
    await expect(putBlob(new Uint8Array([1, 2, 3]))).rejects.toThrow(/VITE_WALRUS_PUBLISHER/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('round-trips a blob id as ASCII — the on-chain value stays a usable locator', () => {
    const id = 'q1w2E3r4-T5y6_U7i8';
    expect(blobIdFromBytes(blobIdBytes(id))).toBe(id);
  });

  it('hashes the ciphertext, and the hash moves with the bytes', () => {
    const h = ciphertextHash(new Uint8Array([1, 2, 3]));
    expect(h).toHaveLength(32);
    expect(bytesEqual(h, ciphertextHash(new Uint8Array([1, 2, 4])))).toBe(false);
  });
});

// ── the screen: no free-form fields, and nothing fires on mount ─────────────

describe('<BatchScreen/> unconfigured', () => {
  it('renders with no wallet, no package and the network down', () => {
    expect(() => wrap(<BatchScreen />)).not.toThrow();
  });

  it('fetches nothing on mount — every read is click-gated', () => {
    wrap(<BatchScreen />);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('has NO free-form amount or price field anywhere on the route', () => {
    const { container } = wrap(<BatchScreen />);
    expect(container.querySelectorAll('input')).toHaveLength(0);
    expect(container.querySelectorAll('textarea')).toHaveLength(0);
    expect(container.querySelectorAll('[contenteditable]')).toHaveLength(0);
  });

  it('keeps ONE line of why — the queue is public — and leaves the argument to /docs', () => {
    const text = wrap(<BatchScreen />).container.textContent ?? '';
    expect(text).toMatch(/public Move object/i);
    expect(text).toMatch(/docs/i);
    // The three-paragraph pitch this screen used to open with now lives on
    // /docs. If it comes back, the trim has been undone.
    expect(text).not.toMatch(/watched forming, request by request/i);
    expect(text).not.toMatch(/that is a structural answer rather than a latency race/i);
  });

  it('states that uniform-price clearing makes front-running MEANINGLESS, not hard', () => {
    const text = wrap(<BatchScreen />).container.textContent ?? '';
    expect(text).toMatch(/meaningless/i);
  });

  it('counts the Seal committee in distinct OPERATORS, not servers', () => {
    const text = wrap(<BatchScreen />).container.textContent ?? '';
    expect(text).toMatch(/distinct operators/i);
    // Confidentiality before close is a threshold assumption, and is named as one.
    expect(text).toMatch(/3-of-5|threshold/i);
  });

  it('leaves committee HEALTH to /verify but keeps the refusal on the control', () => {
    // The probe dashboard is a verification surface, not a trading one, so it
    // moved. What may not move is D9: this route still says, unconditionally,
    // that an order which cannot be sealed is not submitted.
    const text = wrap(<BatchScreen />).container.textContent ?? '';
    expect(text).not.toMatch(/probe the committee/i);
    expect(text).toMatch(/never fall back to plaintext/i);
  });

  it('refuses rather than degrading when no committee is wired', () => {
    const text = wrap(<BatchScreen />).container.textContent ?? '';
    expect(text).toMatch(/never fall back to plaintext/i);
  });

  it('reads as a SECONDARY surface — no lifecycle essay, no second countdown', () => {
    // The vault leads. /batch may not compete for attention with a four-state
    // walkthrough or a clock the app shell already renders.
    const text = wrap(<BatchScreen />).container.textContent ?? '';
    expect(text).not.toMatch(/One window, four states/i);
    expect(text).not.toMatch(/What is hidden, and for how long/i);
    expect(text).not.toMatch(/to clearing/i);
  });

  it('renders the D8 linkability disclosure UNCONDITIONALLY', () => {
    // No wallet, no config, no read — it still says v1 spends are linkable.
    const text = wrap(<BatchScreen />).container.textContent ?? '';
    expect(text).toMatch(/uniformity, not unlinkability/i);
  });

  it('says reveal is permissionless, so nobody can grief a batch by going offline', () => {
    const text = wrap(<BatchScreen />).container.textContent ?? '';
    expect(text).toMatch(/grief a batch by going offline/i);
  });
});

describe('<OrderTicket/> the submit cut-off', () => {
  const CLOSE = 1_800_000_000_000n;

  it('marks submission closed inside the 60 s cut-off', () => {
    const { container } = wrap(
      <OrderTicket live={live(CLOSE)} nowMs={Number(CLOSE) - 30_000} onSubmitted={() => {}} />,
    );
    expect(container.textContent ?? '').toMatch(/submission closed/i);
  });

  it('keeps submit disabled in every one of these states', () => {
    // Whatever the reason, the control is never live-looking-but-dead.
    for (const nowMs of [Number(CLOSE) - 30_000, Number(CLOSE) - 600_000]) {
      const { container } = wrap(
        <OrderTicket live={live(CLOSE)} nowMs={nowMs} onSubmitted={() => {}} />,
      );
      const submit = [...container.querySelectorAll('button')].find((b) =>
        /seal and send/i.test(b.textContent ?? ''),
      );
      expect(submit).toBeDefined();
      expect(submit!.hasAttribute('disabled')).toBe(true);
      cleanup();
    }
  });

  it('states the MOST FUNDAMENTAL blocker first — an unpublished package outranks the cut-off', () => {
    // The suite pins VITE_APHOTIC_PACKAGE_ID to ''. A screen that complained
    // about the cut-off while the package itself is unset would send the reader
    // to fix the wrong thing.
    const { container } = wrap(
      <OrderTicket live={live(CLOSE)} nowMs={Number(CLOSE) - 30_000} onSubmitted={() => {}} />,
    );
    expect(container.textContent ?? '').toMatch(/VITE_APHOTIC_PACKAGE_ID/);
  });

  it('is NOT in the cut-off comfortably before close', () => {
    const { container } = wrap(
      <OrderTicket live={live(CLOSE)} nowMs={Number(CLOSE) - 600_000} onSubmitted={() => {}} />,
    );
    expect(container.textContent ?? '').not.toMatch(/submission closed/i);
  });

  it('greys submit at exactly the boundary — the cut-off is inclusive', () => {
    // now + cutoff > close is the contract's condition; one ms inside it closes.
    const { container } = wrap(
      <OrderTicket live={live(CLOSE)} nowMs={Number(CLOSE) - 60_000 + 1} onSubmitted={() => {}} />,
    );
    expect(container.textContent ?? '').toMatch(/submission closed/i);
  });

  it('never describes a SEALED batch as open', () => {
    // The badge is driven by the batch's actual state, not by the clock alone.
    const { container } = wrap(
      <OrderTicket live={live(CLOSE, 1)} nowMs={Number(CLOSE) - 600_000} onSubmitted={() => {}} />,
    );
    const text = container.textContent ?? '';
    expect(text).toMatch(/batch 1 sealed/i);
    expect(text).not.toMatch(/batch 1 open/i);
  });

  it('offers only ladder rungs — no free-form size or price control', () => {
    const { container } = wrap(
      <OrderTicket live={live(CLOSE)} nowMs={Number(CLOSE) - 600_000} onSubmitted={() => {}} />,
    );
    expect(container.querySelectorAll('input')).toHaveLength(0);
    expect(container.querySelectorAll('textarea')).toHaveLength(0);
  });

  it('states that no amount, side or price lands on chain', () => {
    const { container } = wrap(
      <OrderTicket live={live(CLOSE)} nowMs={Number(CLOSE) - 600_000} onSubmitted={() => {}} />,
    );
    const text = container.textContent ?? '';
    expect(text).toMatch(/no amount, no side, no price/i);
    expect(text).toMatch(/binds the plaintext/i);
  });
});

describe('<NotePanel/> the secret and the disclosure', () => {
  it('renders unconfigured with the spend path blocked and stated', () => {
    const { container } = wrap(<NotePanel typeArgs={null} onChanged={() => {}} />);
    expect(container.textContent ?? '').toMatch(/type parameters|not configured|VITE_/i);
  });

  it('discloses that a spend is linkable to the deposit that funded it', () => {
    const { container } = wrap(<NotePanel typeArgs={null} onChanged={() => {}} />);
    const text = container.textContent ?? '';
    expect(text).toMatch(/leaf index names the/i);
    expect(text).toMatch(/uniformity, not unlinkability/i);
  });

  it('explains why escrow is topped up independently of trading', () => {
    const { container } = wrap(<NotePanel typeArgs={null} onChanged={() => {}} />);
    expect(container.textContent ?? '').toMatch(/leaks timing/i);
  });

  it('offers no free-form amount field', () => {
    const { container } = wrap(<NotePanel typeArgs={null} onChanged={() => {}} />);
    expect(container.querySelectorAll('input')).toHaveLength(0);
  });

  it('fetches nothing on mount', () => {
    wrap(<NotePanel typeArgs={null} onChanged={() => {}} />);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
