// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.5
// @phase      0  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/KEEPER.md §2.1 (types), §2.2 (interface), §9.2 (limiter replay inputs)
// @spec       docs/RECON.md#r8 (REAL event names + the WithdrawalSigned gap), #r7 (Move surface)
// @rules      G1 G3 G5 G6 G7
// @depends    ../types.ts (Sats/Millis/Secs/BtcAddress)
// @facts      Event families, VERBATIM Move struct names (docs/RECON.md R8):
// @facts        treasury         : Minted<T>, Burned<T>
// @facts        deposit          : DepositRequested, DepositApproved, DepositConfirmed, ExpiredDepositDeleted
// @facts        withdrawal_queue : WithdrawalRequested, WithdrawalApproved, WithdrawalPickedForProcessing,
// @facts                           WithdrawalInputsSigned, WithdrawalSigned, WithdrawalPresigsReassigned,
// @facts                           WithdrawalConfirmed, WithdrawalCancelled
// @facts      ⚠⚠ `WithdrawalSigned { withdrawal_txn_id, request_ids, signatures, guardian_signatures }`
// @facts        carries NO amount and NO timestamp — yet it is THE event that advances the
// @facts        Guardian bucket (G5). Therefore the NORMALIZED form must synthesise both:
// @facts          sats  = SUM over request_ids of WithdrawalRequested.btc_amount
// @facts                  (fallback: WithdrawalPickedForProcessing.withdrawal_outputs[i].amount)
// @facts          atMs  = the SUI EVENT ENVELOPE timestampMs (NOT a struct field)
// @facts        `satsSource` records which join produced the amount; 'unresolved' means the
// @facts        replay MUST NOT be trusted for that boundary.
// @facts      ⚠ `treasury::Minted<T>` carries ONLY `amount` — there is NO recipient field.
// @facts        Never claim the mint recipient is readable from the event (it is encoded in the
// @facts        UTXO derivation path, which is exactly why the keeper cannot redirect a mint, G2).
// @facts      ⚠ ERRATA vs docs/KEEPER.md §2.1 / docs/FACTS.md#events (both abbreviate):
// @facts        - kind is the VERBATIM struct name ⇒ 'WithdrawalPickedForProcessing', not 'WithdrawalPicked'
// @facts        - `utxo_pool::UtxoSpent` is NOT in the RECON R8 verified list ⇒ not modelled here
// @facts        - Minted has no `recipient`
// @facts      ERRORS mirrored from Hashi Move (docs/RECON.md R7): 30_000 sats minimum,
// @facts        20|32-byte address, requester-only cancel, 1 h cancel cooldown.
// @implements export type Sats (re-export) / BtcAddress (re-export)
// @implements export type DepositStatus / WithdrawalStatus
// @implements export interface DepositAddress / DepositView / WithdrawalView / Utxo
// @implements export interface LimiterStatus
// @implements export type HashiEventKind / HashiEvent / HashiEventOf<K> / HashiEventBase
// @implements export interface EventCursor + EVENT_CURSOR_GENESIS
// @forbidden  a `number` field for any satoshi amount
// @forbidden  inventing event fields that the Move struct does not carry (see the two ⚠ above)
// @invariant  1. EVERY normalized event carries BOTH `atMs` and `atSecs` (atSecs = floor(atMs/1000)).
// @invariant  2. `seq` is the EVENT-LOG cursor, NOT the limiter's `next_seq`. Do not conflate them.
// @verify     npm run typecheck
// @verify     npm test -- hashi.mock
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { BtcAddress, Millis, Sats, Secs, SuiAddress } from '../types.js';

export type { BtcAddress, Sats };

// ── Lifecycle ────────────────────────────────────────────────────────────────

/** Deposit lifecycle (~70 min end-to-end — NEVER live-demoable, G6). */
export type DepositStatus = 'Requested' | 'Approved' | 'Confirmed' | 'Expired';

/** Withdrawal lifecycle (~1.5–2 h end-to-end — NEVER live-demoable, G6). */
export type WithdrawalStatus =
  | 'Requested'
  | 'Approved'
  | 'PickedForProcessing'
  | 'Signed'
  | 'Confirmed'
  | 'Cancelled';

/** Client-side P2TR derivation — no server is involved (docs/FACTS.md#hashi-sdk). */
export interface DepositAddress {
  /** Bech32m P2TR address on signet. */
  readonly p2tr: string;
  /** The Sui address the mint is bound to (encoded in the derivation path). */
  readonly suiAddress: SuiAddress;
}

/** A Bitcoin UTXO being registered against a deposit request. */
export interface Utxo {
  readonly txid: string;
  readonly vout: number;
  readonly sats: Sats;
  /** Derivation path binding the mint to a Sui recipient. The keeper CANNOT change it (G2). */
  readonly derivationPath?: string;
}

export interface DepositView {
  readonly requestId: string;
  readonly status: DepositStatus;
  readonly sats: Sats;
  readonly recipient: SuiAddress;
  /** ms at which `confirm_deposit` becomes callable (approval + `bitcoin_deposit_time_delay_ms`). */
  readonly confirmableAtMs?: Millis;
}

export interface WithdrawalView {
  readonly requestId: string;
  readonly status: WithdrawalStatus;
  readonly sats: Sats;
  /** 20-byte P2WPKH or 32-byte P2TR witness program. Pinned on-chain at deposit (G2). */
  readonly bitcoinAddress: BtcAddress;
  /** Present once broadcast; for the demo this is an EARLIER, already-confirmed tx (G6). */
  readonly signetTxid?: string;
}

// ── Guardian limiter reading ─────────────────────────────────────────────────

/**
 * A token-bucket reading. Field names follow docs/KEEPER.md §2.1.
 *
 * ⚠ G5: when `source === 'sdk-hint'` this is an UNVERIFIED CONVENIENCE READ. The authoritative
 * bucket is `verify.deriveLimiter()` replaying `projectCapacity` over the on-chain
 * `WithdrawalSigned` stream (`source === 'replay'`). Never feed an 'sdk-hint' into
 * `strategy.evaluate()`; feed the replay.
 */
export interface LimiterStatus {
  /** Available capacity NOW (projected to `asOfMs`). */
  readonly tokens: Sats;
  /** Genesis scalar, sats/second. Trust anchor #1. */
  readonly refillRate: Sats;
  /** Genesis scalar, bucket ceiling in sats. Trust anchor #2. */
  readonly maxBucketCapacity: Sats;
  /** ms epoch of this reading. */
  readonly asOfMs: Millis;
  /** Unix seconds of this reading (the limiter's native base). */
  readonly asOfSecs: Secs;
  /** Next expected batch sequence number. */
  readonly nextSeq: bigint;
  /** Where this reading came from. 'replay' is the only trustworthy one (G5). */
  readonly source: 'replay' | 'sdk-hint';
}

// ── Events ───────────────────────────────────────────────────────────────────

export interface HashiEventBase {
  /** Event-log cursor (monotonic, resumable). NOT the limiter's `next_seq`. */
  readonly seq: bigint;
  /** Sui event-envelope timestamp, milliseconds. */
  readonly atMs: Millis;
  /** floor(atMs / 1000) — the Guardian limiter's native time base. */
  readonly atSecs: Secs;
  /** Sui transaction digest that emitted the event, when known. */
  readonly txDigest?: string;
}

/** Where a `WithdrawalSigned.sats` value came from (the raw struct has no amount). */
export type SatsSource = 'requested' | 'picked' | 'unresolved';

export interface WithdrawalOutput {
  readonly sats: Sats;
  readonly bitcoinAddress: BtcAddress;
}

export type HashiEvent =
  // ── treasury ───────────────────────────────────────────────────────────────
  | (HashiEventBase & {
      readonly kind: 'Minted';
      /** Fully-qualified coin type from the generic parameter, e.g. `<pkg>::btc::BTC`. */
      readonly coinType: string;
      readonly sats: Sats;
      /** ⚠ ALWAYS undefined: `Minted<T>` has no recipient field. Kept for shape stability. */
      readonly recipient?: undefined;
    })
  | (HashiEventBase & {
      readonly kind: 'Burned';
      readonly coinType: string;
      readonly sats: Sats;
    })
  // ── deposit ────────────────────────────────────────────────────────────────
  | (HashiEventBase & {
      readonly kind: 'DepositRequested';
      readonly requestId: string;
      readonly sats: Sats;
      readonly requesterAddress: SuiAddress;
      /** Sui address the mint is bound to, when the derivation path resolves to one. */
      readonly derivationPath?: string;
    })
  | (HashiEventBase & {
      readonly kind: 'DepositApproved';
      readonly requestId: string;
      /** Joined from DepositRequested (the struct carries a Utxo, not a bare amount). */
      readonly sats: Sats;
      readonly approvalTimestampMs: Millis;
    })
  | (HashiEventBase & {
      readonly kind: 'DepositConfirmed';
      readonly requestId: string;
      readonly sats: Sats;
    })
  | (HashiEventBase & {
      readonly kind: 'ExpiredDepositDeleted';
      readonly requestId: string;
    })
  // ── withdrawal_queue ───────────────────────────────────────────────────────
  | (HashiEventBase & {
      readonly kind: 'WithdrawalRequested';
      readonly requestId: string;
      readonly sats: Sats;
      readonly bitcoinAddress: BtcAddress;
      readonly requesterAddress: SuiAddress;
    })
  | (HashiEventBase & {
      readonly kind: 'WithdrawalApproved';
      readonly requestId: string;
    })
  | (HashiEventBase & {
      readonly kind: 'WithdrawalPickedForProcessing';
      readonly withdrawalTxnId: string;
      readonly txid: string;
      readonly requestIds: readonly string[];
      readonly outputs: readonly WithdrawalOutput[];
    })
  | (HashiEventBase & {
      readonly kind: 'WithdrawalInputsSigned';
      readonly withdrawalTxnId: string;
      readonly signedCount: bigint;
      readonly numInputs: bigint;
    })
  // ★ THE event that advances the Guardian bucket (G5).
  | (HashiEventBase & {
      readonly kind: 'WithdrawalSigned';
      readonly withdrawalTxnId: string;
      readonly requestIds: readonly string[];
      /** SYNTHESISED — see the @facts block. Never present in the raw struct. */
      readonly sats: Sats;
      /** How `sats` was resolved. 'unresolved' ⇒ the replay is incomplete at this boundary. */
      readonly satsSource: SatsSource;
      readonly signatureCount: number;
    })
  | (HashiEventBase & {
      readonly kind: 'WithdrawalPresigsReassigned';
      readonly withdrawalTxnId: string;
      readonly epoch: bigint;
      readonly presigStartIndex: bigint;
    })
  | (HashiEventBase & {
      readonly kind: 'WithdrawalConfirmed';
      readonly withdrawalTxnId: string;
      /** Signet txid (hex). */
      readonly txid: string;
      readonly requestIds: readonly string[];
    })
  | (HashiEventBase & {
      readonly kind: 'WithdrawalCancelled';
      readonly requestId: string;
      readonly requesterAddress: SuiAddress;
      readonly sats: Sats;
    });

export type HashiEventKind = HashiEvent['kind'];

/** Narrow the union to one kind: `HashiEventOf<'WithdrawalSigned'>`. */
export type HashiEventOf<K extends HashiEventKind> = Extract<HashiEvent, { kind: K }>;

/** Every event kind, in Move-module order. Used to build the `queryEvents` type filters. */
export const HASHI_EVENT_KINDS = [
  'Minted',
  'Burned',
  'DepositRequested',
  'DepositApproved',
  'DepositConfirmed',
  'ExpiredDepositDeleted',
  'WithdrawalRequested',
  'WithdrawalApproved',
  'WithdrawalPickedForProcessing',
  'WithdrawalInputsSigned',
  'WithdrawalSigned',
  'WithdrawalPresigsReassigned',
  'WithdrawalConfirmed',
  'WithdrawalCancelled',
] as const satisfies readonly HashiEventKind[];

/** Which Hashi Move module emits each event kind. */
export const HASHI_EVENT_MODULE = {
  Minted: 'treasury',
  Burned: 'treasury',
  DepositRequested: 'deposit',
  DepositApproved: 'deposit',
  DepositConfirmed: 'deposit',
  ExpiredDepositDeleted: 'deposit',
  WithdrawalRequested: 'withdrawal_queue',
  WithdrawalApproved: 'withdrawal_queue',
  WithdrawalPickedForProcessing: 'withdrawal_queue',
  WithdrawalInputsSigned: 'withdrawal_queue',
  WithdrawalSigned: 'withdrawal_queue',
  WithdrawalPresigsReassigned: 'withdrawal_queue',
  WithdrawalConfirmed: 'withdrawal_queue',
  WithdrawalCancelled: 'withdrawal_queue',
} as const satisfies Record<HashiEventKind, string>;

/** Resumable cursor. `seq` is the NEXT event-log index to read (inclusive). */
export interface EventCursor {
  readonly seq: bigint;
}

/** Read the whole stream from the beginning. */
export const EVENT_CURSOR_GENESIS: EventCursor = Object.freeze({ seq: 0n });
