// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F1
// @phase      0
// @status     DONE
// @spec       aphotic.md §9 (devInspect-before-send, fail-soft)
// @spec       move/sources/*.move — the `const E…: u64 = n;` blocks are the source
//             of truth for every abort code mapped below. Transcribed from the v2
//             modules on 2026-07-26: vault(26) batch(19) clearing(8, starting at 2)
//             notes(18) balance(7) caps(12) allocate(13) carry(7).
// @rules      G2 G7 G8 G10
// @depends    ../config.ts (F1) · ./suiClient.ts (F1) · ../session/useSession.ts
// @facts      THE ONE SEND PATH. Every screen that writes to chain goes through
// @facts        useAphoticTx(); nothing else may call useSignAndExecuteTransaction.
// @facts      dapp-kit 1.1.9 `useSignAndExecuteTransaction` signs AND executes via
// @facts        the connected wallet-standard wallet (extension OR Enoki zkLogin —
// @facts        both are wallet-standard, so there is exactly one code path).
// @facts      The wallet-standard `chain` is `sui:<network>`, built from
// @facts        config.sui.network. Never inline 'sui:testnet' (G7).
// @facts      Move abort rendering seen in the wild:
// @facts        MoveAbort(MoveLocation { module: ModuleId { address: 148a11…,
// @facts        name: Identifier("vault") }, function: 4, instruction: 27,
// @facts        function_name: Some("claim_deposit") }, 4) in command 2
// @facts      ⚠ The REAL hashi package uses `#[error]` byte-string constants, so
// @facts        its abort codes are CLEVER (high bit set) and are NOT comparable to
// @facts        a small u64. We never guess a clever code's meaning: we match the
// @facts        upstream byte-string when the node echoes it, else we surface raw.
// @facts      ⚠⚠ APHOTIC_ABORTS carries ONLY rows read out of a module's own
// @facts        `const E…: u64 = n;` block. A code that is not in the table falls
// @facts        back to the raw abort string — a confidently wrong explanation of
// @facts        a failed transaction is worse than an ugly one. Never add a row
// @facts        by guessing a code from a name.
// @external   useSignAndExecuteTransaction({ transaction, chain }) → { digest }
//             client.core.getTransaction({ digest })
// @implements export type TxErrorKind · TxResult · MoveAbortInfo · TxBuilder
//             export const APHOTIC_ABORTS
//             export function parseMoveAbort(raw): MoveAbortInfo | null
//             export function describeTxError(err): TxFailure
//             export function waitForTransaction(digest, opts?): Promise<boolean>
//             export function useAphoticTx(opts?): AphoticTx
// @forbidden  throwing at the caller — send() ALWAYS resolves to a TxResult
// @forbidden  swallowing an unknown abort: an unmapped code falls back to the raw
//             string, never to a fabricated explanation
// @forbidden  constructing a Sui client here — lib/suiClient.ts is the ONE factory
// @forbidden  a canonical on-chain id literal — everything comes from config (G7)
// @invariant  1. send() never throws and never returns undefined.
// @invariant  2. When disabledReason !== null, send() short-circuits without ever
//                opening a wallet popup — the caller was supposed to disable the
//                button and show that same one-line reason.
// @invariant  3. The SENDER is always the connected account. Sponsorship (Enoki gas
//                pool) changes who pays, never who signs — that is what keeps a
//                reclaim satisfying Hashi's `request.sender == ctx.sender()`
//                (docs/FACTS.md#hashi-move-api).
// @invariant  4. waitForTransaction is best-effort: it can never turn a successful
//                execution into a reported failure.
// @ac         app/test/tx.test.ts — a Move abort renders as human text, not a hex dump.
// @verify     cd app && npx tsc --noEmit
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { useCallback, useMemo, useState } from 'react';
import { useCurrentAccount, useSignAndExecuteTransaction } from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';

import { config } from '../config';
import { APHOTIC_CHAIN as SESSION_CHAIN } from '../session/useSession';
import { getSuiClient } from './suiClient';

// ── result shape ─────────────────────────────────────────────────────────────

export type TxErrorKind =
  /** No wallet / no account connected. */
  | 'not-connected'
  /** The connected wallet does not advertise the configured Sui network. */
  | 'wrong-network'
  /** A required id is missing from the build-time env. */
  | 'unconfigured'
  /** The user closed or declined the wallet prompt. */
  | 'user-rejected'
  /** A Move `assert!` fired. `abort` carries the module + code. */
  | 'move-abort'
  /** Gas coin problems (budget, balance, no coins). */
  | 'insufficient-gas'
  /** Transport failure — RPC unreachable, timeout, CORS. */
  | 'network'
  /** Anything we could not classify. `message` is the raw string. */
  | 'unknown';

export interface MoveAbortInfo {
  /** Move module name, e.g. `vault`. Null when the string did not carry one. */
  readonly module: string | null;
  /** Move function name when the node reported it. */
  readonly functionName: string | null;
  /** The raw abort code. u64, so bigint. */
  readonly code: bigint;
  /** True for a `#[error]` byte-string constant (high bit set) — NOT a plain code. */
  readonly clever: boolean;
  /** `EBelowHashiMinimum` etc. Null when the code is not one we ship. */
  readonly constantName: string | null;
  /** One-line human explanation. Null when we refuse to guess. */
  readonly explanation: string | null;
}

export interface TxSuccess {
  readonly status: 'success';
  readonly digest: string;
  /** False when the digest never showed up on the read node inside the wait window. */
  readonly confirmed: boolean;
}

export interface TxFailure {
  readonly status: 'error';
  readonly kind: TxErrorKind;
  /** Always human-readable. Falls back to the raw string rather than to silence. */
  readonly message: string;
  readonly abort?: MoveAbortInfo;
  /** The unmodified error text, kept so a developer can always see the truth. */
  readonly raw: string;
}

export type TxResult = TxSuccess | TxFailure;

/** Either a prebuilt Transaction, or a builder that fills one in. */
export type TxBuilder = (tx: Transaction) => Transaction | void;
export type TxInput = Transaction | TxBuilder;

// ── abort tables (verbatim from the Move sources) ────────────────────────────

interface AbortEntry {
  readonly name: string;
  readonly text: string;
}

/**
 * Aphotic's own error constants, module → code → meaning.
 *
 * ⚠ EVERY ROW WAS TRANSCRIBED FROM THE `const E…: u64 = n;` BLOCK AT THE TOP OF
 * THE NAMED MODULE, in order, on 2026-07-26. Not one is inferred from a name and
 * not one is carried over from v1. The rule that made this table empty still
 * holds: a confidently wrong explanation of a failed transaction is worse than
 * an ugly raw string, so a code that is not below degrades to the raw text.
 *
 * ⚠ `aphotic::clearing` starts at 2 — there is no code 1 in that module. The gap
 * is real; do not "fix" it by shifting the rows up.
 *
 * ⚠ The keys are MODULE names as the node renders them (`Identifier("vault")`),
 * which is why `balance.move` is keyed `balance` even though `vault.move`
 * imports it under the alias `ledger`.
 */
export const APHOTIC_ABORTS: Readonly<Record<string, Readonly<Record<number, AbortEntry>>>> = {
  vault: {
    1: { name: 'ELpSupplyNotZero', text: 'That share coin has already been minted against — a vault can only be created from a treasury with zero supply.' },
    2: { name: 'EPaused', text: 'The vault is paused, so no new deposit is accepted. Redeeming and claiming still work: pausing stops new risk, not the exit.' },
    3: { name: 'EZeroAmount', text: 'The amount is zero.' },
    4: { name: 'ENoProposal', text: 'There is no NAV proposal outstanding to act on.' },
    5: { name: 'EDigestMismatch', text: 'The digest does not match the proposal on chain — the numbers being approved are not the numbers that were signed.' },
    6: { name: 'EProposalStale', text: 'The proposal is older than the governed maximum age, so it can no longer be approved.' },
    7: { name: 'EProposalEpochMismatch', text: 'The proposal belongs to a different epoch than the vault is in now.' },
    8: { name: 'EIdleMismatch', text: 'The proposal’s idle-balance leg does not equal what the vault actually holds. That is the one NAV leg Move can check itself, and it did.' },
    9: { name: 'ENavLegUncapped', text: 'The native-BTC leg exceeds the on-Sui withdrawal claims behind it. Move cannot see Bitcoin, so it caps that leg by the claims that produced it.' },
    10: { name: 'EClaimsRegressed', text: 'The reported Hashi claims went backwards from the last approved valuation.' },
    11: { name: 'ENavJump', text: 'The NAV per share moved further than the governed jump bound allows in one epoch.' },
    12: { name: 'EPriceDeviation', text: 'The clearing price deviates from the book mid by more than the governed bound.' },
    13: { name: 'ESolvency', text: 'The action would leave committed shares worth more than the vault’s assets. It reverted rather than let that stand.' },
    14: { name: 'ESupplyDrift', text: 'Minted supply plus owed-but-unminted shares no longer equals committed supply.' },
    15: { name: 'ENotYetPriced', text: 'This receipt’s epoch has not been priced yet. It becomes claimable once the admin multisig approves that epoch’s NAV.' },
    16: { name: 'EVaultMismatch', text: 'That receipt belongs to a different vault.' },
    17: { name: 'EInsufficientAssets', text: 'The vault does not hold enough to release that claim right now.' },
    18: { name: 'ENotPaused', text: 'The vault is not paused.' },
    19: { name: 'EUnpauseNotArmed', text: 'Unpausing has not been armed. Pausing is one transaction; resuming needs an earlier arming transaction plus a delay.' },
    20: { name: 'EUnpauseTooEarly', text: 'The unpause delay has not elapsed yet. Cheap to stop, expensive to resume — on chain.' },
    21: { name: 'EBadParam', text: 'A parameter is outside its permitted range.' },
    22: { name: 'EEscrowLocked', text: 'A clearing is in flight, so escrow cannot move. A fill was sized against this ledger when the clearing loaded it.' },
    23: { name: 'EDenomMismatch', text: 'The payment is not exactly that denomination. Notes are fixed-size by design — that is what makes them uniform.' },
    24: { name: 'EOverflow', text: 'The arithmetic would overflow u64.' },
    25: { name: 'EBelowMinDeposit', text: 'The deposit is below the vault’s governed minimum.' },
    26: { name: 'ENoClearingActive', text: 'There is no active clearing to end.' },
  },
  batch: {
    1: { name: 'EBadState', text: 'The batch is not in the state that call requires — transitions are monotonic and no path returns to OPEN.' },
    2: { name: 'ETooEarly', text: 'The batch cannot be closed before its scheduled instant. The close time is derived from the cadence, not chosen by anyone.' },
    3: { name: 'ESubmitWindowClosed', text: 'Submission is closed for the last 60 seconds before the boundary, so a submit can never race an early key release.' },
    4: { name: 'EBatchFull', text: 'The batch is full. It rejects further orders and still waits for the boundary — a full batch does not close early.' },
    5: { name: 'ECommitmentMismatch', text: 'The revealed order does not hash to the commitment that was submitted. The commitment binds the plaintext, so this cannot be argued with.' },
    6: { name: 'ESubmitterMismatch', text: 'The revealed order names a different submitter than the sealed one.' },
    7: { name: 'EAlreadyRevealed', text: 'That order has already been revealed — by anyone, which is the point.' },
    8: { name: 'ERevealWindowClosed', text: 'The ten-minute reveal window has expired for this batch.' },
    9: { name: 'ERevealWindowOpen', text: 'The reveal window is still open and not every order is revealed, so clearing cannot start against a half-revealed book.' },
    10: { name: 'ENonMonotonic', text: 'That state transition would move the batch backwards.' },
    11: { name: 'EPolicyBumpWithLiveBatch', text: 'The Seal policy version cannot be bumped while a batch is live — it would invalidate a live identity.' },
    12: { name: 'EBatchAlreadyLive', text: 'A batch is already open. Only one window runs at a time.' },
    13: { name: 'EVaultMismatch', text: 'That batch belongs to a different vault.' },
    14: { name: 'EBadDigestLength', text: 'A digest argument is not 32 bytes.' },
    15: { name: 'EBadOrder', text: 'The order is malformed: quantity and limit price must be non-zero and the salt exactly 32 bytes.' },
    16: { name: 'EIndexOutOfRange', text: 'There is no order at that index in this batch.' },
    17: { name: 'EBadParam', text: 'A governed parameter is outside its permitted range.' },
    18: { name: 'ENoAccess', text: 'The Seal time-lock policy denied: either the batch has not closed yet, the policy version is stale, or the identity carries trailing bytes.' },
    19: { name: 'EWrongRegistry', text: 'That registry does not govern this batch.' },
  },
  clearing: {
    2: { name: 'EBadParam', text: 'A parameter is outside its permitted range — a step budget must be greater than zero.' },
    3: { name: 'EWrongBatch', text: 'That clearing belongs to a different batch.' },
    4: { name: 'EWrongVault', text: 'That clearing belongs to a different vault.' },
    5: { name: 'EFillOutsideLimit', text: 'A fill would land outside a participant’s limit price. Limit safety is asserted per fill, not merely assumed from the construction.' },
    6: { name: 'EValueNotPreserved', text: 'Debits did not equal credits plus fee, so settlement reverted. The fee is an explicit third term, never a silent shortfall.' },
    7: { name: 'EOverflow', text: 'The arithmetic would overflow u64.' },
    8: { name: 'EIndexOutOfRange', text: 'There is no fill at that index.' },
    9: { name: 'ENotFinal', text: 'The clearing has not reached settlement, so there is no published root to prove against yet.' },
  },
  notes: {
    1: { name: 'ELadderEmpty', text: 'The denomination ladder cannot be empty.' },
    2: { name: 'ELadderNotAscending', text: 'The denomination ladder must be strictly ascending.' },
    3: { name: 'ELadderTooManyTiers', text: 'Too many denomination tiers. Few, widely spaced tiers are what create uniformity.' },
    4: { name: 'ELadderInUse', text: 'The ladder cannot be re-pointed while notes are outstanding — it would silently revalue every live note.' },
    5: { name: 'EZeroDenomination', text: 'A denomination cannot be zero.' },
    6: { name: 'EBadDenomIndex', text: 'That denomination index is not on the ladder.' },
    7: { name: 'EBadDepth', text: 'The tree depth is outside its permitted range.' },
    8: { name: 'ETreeFull', text: 'The note tree is full.' },
    9: { name: 'EBadDigestLength', text: 'A commitment or digest is not 32 bytes.' },
    10: { name: 'EBadProofLength', text: 'The membership proof does not have one sibling per tree level.' },
    11: { name: 'ELeafIndexOutOfRange', text: 'That leaf index is beyond the tree’s capacity.' },
    12: { name: 'EUnknownRoot', text: 'The proof folds to a root this tree never published. Rebuild the path against the current leaf list — the tree may have grown since.' },
    13: { name: 'ENullifierAlreadySpent', text: 'That note has already been spent. A nullifier is consumed at most once, ever.' },
    14: { name: 'ESecretLength', text: 'The note secret must be exactly 32 bytes.' },
    15: { name: 'ERandomnessLength', text: 'The note randomness must be exactly 32 bytes.' },
    16: { name: 'ENoteBackingMismatch', text: 'Note value in the tree no longer equals the custodied balance behind it.' },
    17: { name: 'ENoteAccountingUnderflow', text: 'The note accounting would go negative.' },
    18: { name: 'ECapVaultMismatch', text: 'That capability belongs to a different vault.' },
  },
  balance: {
    1: { name: 'EZeroAmount', text: 'The amount is zero.' },
    2: { name: 'EInsufficientBalance', text: 'Your internal balance does not cover that. Top it up, or spend a note into it, before submitting.' },
    3: { name: 'ENoAccount', text: 'This address has no internal balance in that book yet.' },
    4: { name: 'EInsolvent', text: 'The book’s credited total no longer equals its custodied balance.' },
    5: { name: 'ESameAccount', text: 'Source and destination are the same account.' },
    6: { name: 'ECapVaultMismatch', text: 'That capability belongs to a different vault.' },
    7: { name: 'EBookNotEmpty', text: 'The book still holds balances.' },
  },
  caps: {
    1: { name: 'ECapVaultMismatch', text: 'That capability belongs to a different vault.' },
    2: { name: 'EStaleAdminEpoch', text: 'That admin capability has been superseded by a rotation.' },
    3: { name: 'EStaleKeeperEpoch', text: 'That keeper capability has been rotated out.' },
    4: { name: 'ENoPendingTransfer', text: 'There is no pending admin transfer to accept or cancel.' },
    5: { name: 'ENotPendingAdmin', text: 'This address is not the pending admin.' },
    6: { name: 'EPaused', text: 'The vault is paused.' },
    7: { name: 'EUnknownKeeperAction', text: 'That keeper action is not one the registry recognises.' },
    8: { name: 'ENotAllowlisted', text: 'That destination is not on the pinned allowlist. The keeper’s functions take no address parameter at all — the allowlist is not a filter, there is nothing to filter.' },
    9: { name: 'ETransferToSelf', text: 'Admin cannot be transferred to the current admin.' },
    10: { name: 'EAlreadyPending', text: 'An admin transfer is already pending.' },
    11: { name: 'EAllowlistFull', text: 'The allowlist is full.' },
    12: { name: 'ENotAllowlistedEntry', text: 'That entry is not on the allowlist.' },
  },
  allocate: {
    1: { name: 'EWrongRegistry', text: 'That adapter registry is not the one this capability governs.' },
    2: { name: 'EAdapterNotAllowed', text: 'That venue is not an allowed adapter.' },
    3: { name: 'EAdapterAlreadyAllowed', text: 'That adapter is already on the allowlist.' },
    4: { name: 'EAdapterDisabled', text: 'That adapter is allowlisted but currently disabled.' },
    5: { name: 'ERegistryPaused', text: 'Allocation is paused registry-wide.' },
    6: { name: 'EVenueCapExceeded', text: 'That allocation would exceed the venue’s cap.' },
    7: { name: 'EZeroAmount', text: 'The amount is zero.' },
    8: { name: 'ENoSharesReceived', text: 'The adapter returned no shares for the deposit.' },
    9: { name: 'EInsufficientShares', text: 'The adapter position does not hold that many shares.' },
    10: { name: 'EValueLoss', text: 'The round trip would return less than it consumed.' },
    11: { name: 'EAdapterStillFunded', text: 'That adapter still holds principal and cannot be removed.' },
    12: { name: 'EEmptyLabel', text: 'An adapter label cannot be empty.' },
    13: { name: 'EStaleMark', text: 'The adapter’s valuation mark is too old to use.' },
  },
  carry: {
    1: { name: 'ECarryValueLoss', text: 'The carry would return less than it consumed. Value preservation is asserted in Move, not assumed.' },
    2: { name: 'EUnpinnedExitAddress', text: 'That Bitcoin address is not the pinned redemption address.' },
    3: { name: 'EInvalidExitAddressLength', text: 'A Bitcoin address program must be 20 bytes (P2WPKH) or 32 bytes (P2TR).' },
    4: { name: 'EHurdleNotMet', text: 'The discount does not clear the entry hurdle: expected latency × cost of capital, plus gas, plus a margin for model error.' },
    5: { name: 'EBelowWithdrawalMinimum', text: 'Below Hashi’s 30,000-sat withdrawal minimum.' },
    6: { name: 'ENotionalCapExceeded', text: 'That would exceed the governed notional cap for a single carry.' },
    7: { name: 'EInvalidPrice', text: 'The price is outside its permitted range.' },
  },
};

/**
 * The upstream Hashi `#[error]` byte-strings (move/tests/mock_hashi.move mirrors
 * these asserts; the real package is at docs/RECON.md R7). Their abort codes are
 * CLEVER and unreadable, but a node that echoes the constant's byte-string lets
 * us recognise it by text. Match on a distinctive fragment, never on a number.
 */
const HASHI_ERROR_TEXTS: readonly (readonly [string, string])[] = [
  ['below the minimum', 'Hashi rejected the withdrawal: it is under the 30,000 sat minimum.'],
  ['20 bytes (P2WPKH) or 32 bytes', 'Hashi rejected the Bitcoin address: it must be a 20-byte P2WPKH or 32-byte P2TR program.'],
  ['Only the original requester can cancel', 'Only the address that requested this withdrawal can cancel it — that is enforced by Hashi, not by us (G2).'],
  ['cooldown has not elapsed', 'Hashi’s one-hour cancellation cooldown has not elapsed yet.'],
  ['already being processed', 'This withdrawal has already been picked up by the guardians and can no longer be cancelled.'],
  ['not fully signed', 'The withdrawal is not fully signed yet.'],
];

// ── parsing ──────────────────────────────────────────────────────────────────

/** Clever `#[error]` constants set the high bit of the u64 abort code. */
const CLEVER_BIT = 1n << 63n;

/**
 * Pull the module, function and code out of a MoveAbort rendering. Returns null
 * when the string is not a Move abort at all.
 *
 * Handles both renderings we have seen:
 *   MoveAbort(MoveLocation { module: ModuleId { address: …, name: Identifier("vault") },
 *             function: 4, instruction: 27, function_name: Some("claim_deposit") }, 4)
 *   MoveAbort(MoveLocation { module: 0x148a…::vault, function: 4, … }, 4)
 * and the terse `... abort code: 4` form, which carries no module.
 */
export function parseMoveAbort(raw: string): MoveAbortInfo | null {
  let module: string | null = null;
  let functionName: string | null = null;
  let code: bigint | null = null;

  const full = /MoveAbort\(([\s\S]*?),\s*(\d+)\)/.exec(raw);
  if (full !== null) {
    const location = full[1];
    code = BigInt(full[2]);

    const identifier = /name:\s*Identifier\("([^"]+)"\)/.exec(location);
    const pathForm = /module:\s*(?:0x)?[0-9a-fA-F]+::([A-Za-z_][A-Za-z0-9_]*)/.exec(location);
    module = identifier?.[1] ?? pathForm?.[1] ?? null;

    const fn = /function_name:\s*Some\("([^"]+)"\)/.exec(location);
    functionName = fn?.[1] ?? null;
  } else {
    const terse = /abort\s*code[:\s]+(\d+)/i.exec(raw);
    if (terse === null) return null;
    code = BigInt(terse[1]);
    const anyModule = /::([A-Za-z_][A-Za-z0-9_]*)::[A-Za-z_]/.exec(raw);
    module = anyModule?.[1] ?? null;
  }

  const clever = code >= CLEVER_BIT;

  // A clever code encodes a constant index and a line number, not a value we
  // may interpret. Recognise the upstream error only by its byte-string.
  if (clever) {
    const matched = HASHI_ERROR_TEXTS.find(([fragment]) => raw.includes(fragment));
    return {
      module,
      functionName,
      code,
      clever: true,
      constantName: null,
      explanation: matched?.[1] ?? null,
    };
  }

  const table = module === null ? undefined : APHOTIC_ABORTS[module];
  const small = code <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(code) : -1;
  const entry = table?.[small];

  return {
    module,
    functionName,
    code,
    clever: false,
    constantName: entry?.name ?? null,
    explanation: entry?.text ?? null,
  };
}

/** Flatten `error.cause` chains and stringify anything else. */
function rawTextOf(err: unknown): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  let cursor: unknown = err;
  while (cursor !== null && cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor);
    if (cursor instanceof Error) {
      parts.push(cursor.message);
      cursor = (cursor as { cause?: unknown }).cause;
      continue;
    }
    if (typeof cursor === 'string') {
      parts.push(cursor);
      break;
    }
    if (typeof cursor === 'object') {
      const record = cursor as { message?: unknown; error?: unknown };
      if (typeof record.message === 'string') parts.push(record.message);
      else {
        try {
          parts.push(JSON.stringify(cursor));
        } catch {
          parts.push(String(cursor));
        }
      }
      cursor = record.error;
      continue;
    }
    parts.push(String(cursor));
    break;
  }
  const text = parts.filter((p) => p.length > 0).join(' · ');
  return text.length > 0 ? text : String(err);
}

const REJECTED = /(user\s+(rejected|declined|denied|cancell?ed))|(rejected\s+(the\s+)?(request|transaction))|(request\s+rejected)|(popup\s+closed)|\b4001\b/i;
const GAS = /(insufficient\s+gas)|(gas\s+balance)|(no\s+valid\s+gas)|(GasBalanceTooLow)|(InsufficientCoinBalance)|(unable\s+to\s+select\s+gas)/i;
const NETWORK = /(failed to fetch)|(network\s*error)|(fetch failed)|(ECONNREFUSED)|(ETIMEDOUT)|(timed?\s*out)|(\b50[023]\b)|(CORS)/i;

/**
 * Turn any thrown value into a rendered failure. NEVER returns an empty message:
 * an unclassified error keeps its raw text, because a wrong explanation is worse
 * than an ugly one.
 */
export function describeTxError(err: unknown): TxFailure {
  const raw = rawTextOf(err);

  const abort = parseMoveAbort(raw);
  if (abort !== null) {
    const where =
      abort.module === null
        ? 'A Move assertion failed'
        : `${abort.module}${abort.functionName === null ? '' : `::${abort.functionName}`} rejected the call`;
    const message =
      abort.explanation !== null
        ? abort.explanation
        : `${where} (abort code ${abort.code.toString()}${abort.clever ? ', a byte-string error constant' : ''}). Raw: ${raw}`;
    return { status: 'error', kind: 'move-abort', message, abort, raw };
  }

  if (REJECTED.test(raw)) {
    return {
      status: 'error',
      kind: 'user-rejected',
      message: 'You declined the transaction in your wallet. Nothing was sent.',
      raw,
    };
  }
  if (GAS.test(raw)) {
    return {
      status: 'error',
      kind: 'insufficient-gas',
      message: `Gas could not be paid from this account. ${raw}`,
      raw,
    };
  }
  if (NETWORK.test(raw)) {
    return {
      status: 'error',
      kind: 'network',
      message: `The Sui node could not be reached. ${raw}`,
      raw,
    };
  }
  return { status: 'error', kind: 'unknown', message: raw, raw };
}

// ── confirmation ─────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Best-effort read-your-writes: poll the gRPC read node until the digest is
 * visible so a screen's follow-up read does not show pre-transaction state.
 *
 * On-Sui settlement is one checkpoint (G1) — this normally returns on the first
 * or second attempt. It NEVER throws and its `false` return is not a failure of
 * the transaction, only of our wait.
 */
export async function waitForTransaction(
  digest: string,
  opts?: { attempts?: number; delayMs?: number },
): Promise<boolean> {
  const attempts = opts?.attempts ?? 8;
  const delayMs = opts?.delayMs ?? 400;
  for (let i = 0; i < attempts; i += 1) {
    try {
      await getSuiClient().core.getTransaction({ digest });
      return true;
    } catch {
      await sleep(delayMs);
    }
  }
  return false;
}

// ── the hook ─────────────────────────────────────────────────────────────────

/**
 * Wallet-standard chain identifier for the configured network. Single source:
 * session/useSession.ts owns the value, this only narrows its type for the
 * wallet-standard `chain` parameter.
 */
export const APHOTIC_CHAIN = SESSION_CHAIN as `${string}:${string}`;

export interface SendOptions {
  /** Shown in nothing — it is for your own logging/telemetry hooks. */
  readonly label?: string;
  /** Default true. Set false to return as soon as the wallet reports a digest. */
  readonly waitForConfirmation?: boolean;
}

export interface UseAphoticTxOptions {
  /**
   * Default true. When true, send() refuses (with a reason) while
   * VITE_APHOTIC_PACKAGE_ID / VITE_VAULT_ID are empty, because every write this
   * app performs targets our own package.
   */
  readonly requiresPackage?: boolean;
}

export interface AphoticTx {
  /** Build → sign → execute. Always resolves; never throws. */
  readonly send: (input: TxInput, opts?: SendOptions) => Promise<TxResult>;
  /** True while the wallet prompt is open / the tx is executing. */
  readonly isPending: boolean;
  /** The most recent result, for inline rendering. */
  readonly last: TxResult | null;
  readonly reset: () => void;
  /** True when a send can actually be attempted. */
  readonly canSend: boolean;
  /**
   * One line explaining why not, or null. Render this next to a DISABLED button —
   * a clickable-and-silent control is the thing this whole module exists to
   * prevent.
   */
  readonly disabledReason: string | null;
  /** The address that will sign and send. */
  readonly sender: string | null;
}

/**
 * The single send path for the whole app.
 *
 * ```tsx
 * const tx = useAphoticTx();
 * const onClick = async () => {
 *   const result = await tx.send((t) => { t.moveCall({ … }); });
 *   if (result.status === 'success') refetch();
 * };
 * <button disabled={!tx.canSend || tx.isPending} onClick={onClick}>Exit</button>
 * {tx.disabledReason && <p className="reason">{tx.disabledReason}</p>}
 * ```
 */
export function useAphoticTx(opts?: UseAphoticTxOptions): AphoticTx {
  const requiresPackage = opts?.requiresPackage ?? true;
  const account = useCurrentAccount();
  const { mutateAsync, isPending } = useSignAndExecuteTransaction();
  const [last, setLast] = useState<TxResult | null>(null);

  const sender = account?.address ?? null;

  const guard = useMemo((): { kind: TxErrorKind; reason: string } | null => {
    if (account === null) {
      return { kind: 'not-connected', reason: 'Connect a wallet or sign in with Google first.' };
    }
    const chains = account.chains ?? [];
    if (chains.length > 0 && !chains.includes(APHOTIC_CHAIN)) {
      return {
        kind: 'wrong-network',
        reason: `This wallet is not on ${config.sui.network}. Switch networks in the wallet, then reconnect.`,
      };
    }
    if (requiresPackage) {
      const missing: string[] = [];
      if (config.aphotic.packageId.length === 0) missing.push('VITE_APHOTIC_PACKAGE_ID');
      if (config.aphotic.vaultId.length === 0) missing.push('VITE_VAULT_ID');
      if (missing.length > 0) {
        return {
          kind: 'unconfigured',
          reason: `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} empty — this build has no vault to call.`,
        };
      }
    }
    return null;
  }, [account, requiresPackage]);

  const send = useCallback(
    async (input: TxInput, sendOpts?: SendOptions): Promise<TxResult> => {
      if (guard !== null) {
        const blocked: TxFailure = {
          status: 'error',
          kind: guard.kind,
          message: guard.reason,
          raw: guard.reason,
        };
        setLast(blocked);
        return blocked;
      }

      let transaction: Transaction;
      try {
        if (typeof input === 'function') {
          const fresh = new Transaction();
          const returned = input(fresh);
          transaction = returned ?? fresh;
        } else {
          transaction = input;
        }
        if (sender !== null) transaction.setSenderIfNotSet(sender);
      } catch (err) {
        const failure = describeTxError(err);
        setLast(failure);
        return failure;
      }

      try {
        const output = await mutateAsync({ transaction, chain: APHOTIC_CHAIN });
        const digest = (output as { digest?: string }).digest ?? '';
        if (digest.length === 0) {
          const failure: TxFailure = {
            status: 'error',
            kind: 'unknown',
            message: 'The wallet executed the transaction but returned no digest.',
            raw: JSON.stringify(output ?? null),
          };
          setLast(failure);
          return failure;
        }
        const confirmed =
          sendOpts?.waitForConfirmation === false ? false : await waitForTransaction(digest);
        const success: TxSuccess = { status: 'success', digest, confirmed };
        setLast(success);
        return success;
      } catch (err) {
        const failure = describeTxError(err);
        setLast(failure);
        return failure;
      }
    },
    [guard, mutateAsync, sender],
  );

  const reset = useCallback(() => setLast(null), []);

  return {
    send,
    isPending,
    last,
    reset,
    canSend: guard === null,
    disabledReason: guard?.reason ?? null,
    sender,
  };
}
