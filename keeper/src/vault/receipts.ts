// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       B8.vault.receipts
// @phase      2
// @status     DONE
// @spec       move/sources/vault.move — `public struct DepositReceipt has key, store` /
//             `public struct RedeemReceipt has key, store` · `claim_deposit` / `claim_redeem`
// @spec       docs/DESIGN-V2.md §6 ("claim_deposit recomputes the SAME mul_div per receipt")
// @spec       aphotic.md §9 (liveness is not a privilege — no cap gates a claim)
// @rules      G2 G10
// @depends    ./context.ts · @mysten/sui/bcs
// @facts      ★ ERC-7540 SHAPE: funds enter, shares are NOT minted, and the RECEIPT carries the
// @facts        claim across the epoch boundary. `epoch < vault.epoch` is the whole readiness
// @facts        test — a receipt from the CURRENT epoch has not been priced yet and
// @facts        `claim_deposit` aborts with ENotYetPriced.
// @facts      ★ HONEST SCOPE OF "PERMISSIONLESS". Neither claim function takes a capability, so
// @facts        nothing about the keeper's identity authorizes it (aphotic.md §9). But a receipt is
// @facts        an ADDRESS-OWNED object, so the transaction that consumes it must be signed by its
// @facts        owner. The crank is therefore permissionless in the sense that matters — no
// @facts        privilege, no gatekeeper — and still bounded by ordinary Sui ownership. Say both.
// @facts      ⚠ BCS layout, verbatim from the Move struct order. A `UID` and an `ID` are both 32
// @facts        raw address bytes with no length prefix:
// @facts          DepositReceipt: id ‖ vault_id ‖ u64 epoch ‖ address requester ‖ u64 assets_sats
// @facts          RedeemReceipt:  id ‖ vault_id ‖ u64 epoch ‖ address requester ‖ u64 shares
// @facts      ⚠ `include: { json: true }` is NOT used: upstream documents the JSON projection's
// @facts        field names as varying between gRPC and JSON-RPC. `content` is the stable path.
// @implements export type ReceiptKind
// @implements export interface Receipt
// @implements export const DEPOSIT_RECEIPT / REDEEM_RECEIPT
// @implements export function receiptType(packageId, kind): string
// @implements export function decodeReceipt(kind, objectId, content): Receipt
// @implements export async function listReceipts(deps, packageId, owner, kind): Promise<Receipt[]>
// @implements export function claimable(receipts, vaultEpoch, vaultId): Receipt[]
// @forbidden  claiming a receipt whose epoch is not yet priced — that is a guaranteed revert
// @forbidden  gating a claim on a KeeperCap anywhere in this client (aphotic.md §9)
// @invariant  1. `claimable` returns ONLY receipts with `epoch < vaultEpoch` and a matching vault.
// @invariant  2. Decoding rejects a short/oversized content buffer rather than reading garbage.
// @invariant  3. Listing follows every page; a truncated list would silently skip claims.
// @ac         test/claim.test.ts — decoding, epoch filtering, and vault-mismatch rejection
// @verify     npm run test -- claim
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { bcs } from '@mysten/sui/bcs';

import type { ObjectId, SuiAddress } from '../types.js';
import { AphoticError } from '../util/errors.js';

import { normalizeId, type ChainDeps } from './context.js';

export type ReceiptKind = 'deposit' | 'redeem';

export const DEPOSIT_RECEIPT = 'DepositReceipt' as const;
export const REDEEM_RECEIPT = 'RedeemReceipt' as const;

export interface Receipt {
  readonly kind: ReceiptKind;
  readonly objectId: ObjectId;
  readonly vaultId: ObjectId;
  readonly epoch: bigint;
  readonly requester: SuiAddress;
  /** Deposit: assets in sats. Redeem: shares. The unit follows the kind — never mix them. */
  readonly amount: bigint;
}

/**
 * Both receipts share a layout, so one schema decodes either. The trailing u64 is
 * `assets_sats` for a deposit and `shares` for a redeem — the `kind` on the decoded value
 * is what keeps the two units apart downstream.
 */
const RECEIPT_BCS = bcs.struct('Receipt', {
  id: bcs.Address,
  vault_id: bcs.Address,
  epoch: bcs.u64(),
  requester: bcs.Address,
  amount: bcs.u64(),
});

/** 32 + 32 + 8 + 32 + 8. Fixed: there is no variable-length field. */
export const RECEIPT_BCS_LEN = 112;

export function receiptType(packageId: ObjectId, kind: ReceiptKind): string {
  return `${packageId}::vault::${kind === 'deposit' ? DEPOSIT_RECEIPT : REDEEM_RECEIPT}`;
}

export function decodeReceipt(kind: ReceiptKind, objectId: ObjectId, content: Uint8Array): Receipt {
  if (content.length !== RECEIPT_BCS_LEN) {
    // Invariant 2. A struct that changed shape must stop the crank, not be half-read: a
    // misaligned `epoch` would compare against the vault epoch and claim the wrong receipts.
    throw new AphoticError(
      'BadReceiptContent',
      `${kind} receipt ${objectId} has ${content.length} content bytes, expected ${RECEIPT_BCS_LEN} — ` +
        'the Move struct changed shape; regenerate this decoder before cranking anything',
    );
  }
  const raw = RECEIPT_BCS.parse(content);
  return {
    kind,
    objectId,
    vaultId: raw.vault_id,
    epoch: BigInt(raw.epoch),
    requester: raw.requester,
    amount: BigInt(raw.amount),
  };
}

/**
 * The page shape we consume, declared rather than imported: the two transports' `listOwnedObjects`
 * are generic in different `Include` parameters, so the union's inferred return type is recursive
 * at the `cursor` assignment. `../oracle/deepbook.ts` narrows the same way for the same reason.
 */
interface OwnedPage {
  readonly objects: readonly { readonly objectId: string; readonly content: Uint8Array }[];
  readonly hasNextPage: boolean;
  readonly cursor: string | null;
}

/** Every page (invariant 3) of one receipt kind owned by `owner`. */
export async function listReceipts(
  deps: ChainDeps,
  packageId: ObjectId,
  owner: SuiAddress,
  kind: ReceiptKind,
): Promise<Receipt[]> {
  const type = receiptType(packageId, kind);
  const out: Receipt[] = [];
  let cursor: string | null = null;

  for (;;) {
    const page: OwnedPage = (await deps.client.core.listOwnedObjects({
      owner,
      type,
      cursor,
      include: { content: true },
    })) as unknown as OwnedPage;
    for (const object of page.objects) {
      out.push(decodeReceipt(kind, object.objectId, object.content));
    }
    if (!page.hasNextPage || page.cursor === null) break;
    cursor = page.cursor;
  }

  return out;
}

/**
 * The receipts whose epoch has already been priced by an approved NAV (invariant 1).
 *
 * `epoch < vaultEpoch` is exactly the Move assertion, mirrored so the crank never pays gas to
 * be told `ENotYetPriced`. The vault check is not paranoia: an address can hold receipts from
 * several vaults, and `claim_deposit` aborts `EVaultMismatch` on a foreign one.
 */
export function claimable(
  receipts: readonly Receipt[],
  vaultEpoch: bigint,
  vaultId: ObjectId,
): Receipt[] {
  const wanted = normalizeId(vaultId);
  return receipts.filter((r) => r.epoch < vaultEpoch && normalizeId(r.vaultId) === wanted);
}
