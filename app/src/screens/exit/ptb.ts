// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T3.2
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/APP.md §3.3 (Exit: Move calls), §3.1 (<ExitRequestForm/>, <ReclaimButton/>)
// @spec       docs/MOVE-PACKAGE.md#module-gateway · move/sources/gateway.move (T1.3/T1.4, DONE)
// @spec       docs/RECON.md R7 (withdraw.move) · ULTRACODE-BRIEF E-A3 / E-K7 / E-M8
// @rules      G1 G2 G3 G6 G7 G10
// @depends    ../../config.ts (T0.4) · @mysten/sui/transactions
// @facts      Move signatures this file targets (verbatim from move/sources/gateway.move):
// @facts        register_exit_address<B, Q>(vault: &mut Vault<B,Q>, addr: vector<u8>, ctx)
// @facts        exit_to_bitcoin<Q>(vault: &mut Vault<BTC,Q>, hashi: &mut Hashi,
// @facts                           shares_to_burn: u64, book_mid: u128, clock: &Clock, ctx)
// @facts        flush_pending_exit<Q>(vault, hashi, who: address, clock: &Clock, ctx)
// @facts        take_pending_as_hbtc<B, Q>(vault, ctx): Coin<B>
// @facts        reclaim_stalled_exit<Q>(vault, hashi, request_id: address,
// @facts                                book_mid: u128, clock: &Clock, ctx)
// @facts      ⚠ exit_to_bitcoin has NO bitcoin-address parameter. The destination is
// @facts        read from Vault.btc_exit_address, written once by register_exit_address
// @facts        and immutable thereafter. That ABSENCE is the anti-redirect guarantee (G2).
// @facts      ⚠ cancel_withdrawal asserts request.sender == ctx.sender() (RECON R7.3),
// @facts        so reclaim_stalled_exit must be signed by the DEPOSITOR. The keeper can
// @facts        build this PTB; it can never sign it. (E-A3 / E-K7 / E-M8)
// @facts      ⚠ flush_pending_exit is self-service: stage_flush asserts who == ctx.sender(),
// @facts        otherwise the flusher would become the only party able to reclaim.
// @facts      book_mid is the DeepBook mid at FLOAT_SCALING 1e9 (vault::nav_sats, G9),
// @facts        NEVER a raw Pyth price. It is a PTB argument, so valuation is auditable.
// @facts      Sui Clock is 0x6, imported as SUI_CLOCK_OBJECT_ID — never inlined (G7).
// @implements export interface MoveTargets · export function moveTargets(): MoveTargets
//             export function missingTargets(): string[]
//             export function buildRegisterExitAddressTx(program: Uint8Array): Transaction
//             export function buildExitToBitcoinTx(a: ExitCallArgs): Transaction
//             export function buildFlushPendingExitTx(a: FlushCallArgs): Transaction
//             export function buildTakePendingAsHbtcTx(a: TakeCallArgs): Transaction
//             export function buildReclaimStalledExitTx(a: ReclaimCallArgs): Transaction
//             export function describeExitCall(a): CallDescription
//             export function describeReclaimCall(a): CallDescription
//             export function describeRegisterCall(a): CallDescription
// @forbidden  a bitcoin-address argument on ANY exit/reclaim/flush builder — G2
// @forbidden  a priority / fee-bump / expedite argument — you cannot buy queue
//             priority; over-capacity batches are REJECTED, never queued (G3)
// @forbidden  a canonical on-chain id literal here — every id comes from config (G7)
// @forbidden  `number` for sats or shares — bigint only (G10)
// @invariant  1. buildExitToBitcoinTx emits exactly ONE moveCall, and none of its
//                arguments is or contains a Bitcoin address.
// @invariant  2. Every builder throws a descriptive error rather than emitting a PTB
//                against an empty package/vault id.
// @invariant  3. The describe* functions return exactly the arguments the matching
//                build* function encodes — the preview cannot drift from the PTB.
// @ac         docs/APP.md §7 A4 A6
// @verify     cd app && npx tsc --noEmit
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { Transaction } from '@mysten/sui/transactions';
import { SUI_CLOCK_OBJECT_ID } from '@mysten/sui/utils';

import { config } from '../../config';

export interface MoveTargets {
  /** Published `aphotic` package. Empty until the package is published. */
  readonly packageId: string;
  /** The shared `Vault<hBTC, DBUSDC>`. Empty until it exists. */
  readonly vaultId: string;
  /** The bridge's shared object, threaded in from the PTB (never named in Move). */
  readonly hashiObjectId: string;
  /** Type argument `B` — the hBTC coin type. */
  readonly baseType: string;
  /** Type argument `Q` — the DeepBook quote coin type. */
  readonly quoteType: string;
}

export function moveTargets(): MoveTargets {
  return {
    packageId: config.aphotic.packageId,
    vaultId: config.aphotic.vaultId,
    hashiObjectId: config.hashi.objectId,
    baseType: config.hashi.hbtcType,
    quoteType: config.deepbook.dbusdcType,
  };
}

/** Env keys that must be filled before ANY of these PTBs can be submitted. */
export function missingTargets(): string[] {
  const t = moveTargets();
  const missing: string[] = [];
  if (t.packageId.length === 0) missing.push('VITE_APHOTIC_PACKAGE_ID');
  if (t.vaultId.length === 0) missing.push('VITE_VAULT_ID');
  return missing;
}

function requireTargets(): MoveTargets {
  const missing = missingTargets();
  if (missing.length > 0) {
    throw new Error(
      `Cannot build this transaction: ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} empty. The aphotic package is not published yet.`,
    );
  }
  return moveTargets();
}

// ── argument description (shared by the builders and the on-screen preview) ──

export interface CallArg {
  readonly name: string;
  readonly type: string;
  readonly value: string;
  readonly note?: string;
}

export interface CallDescription {
  readonly target: string;
  readonly typeArguments: readonly string[];
  readonly args: readonly CallArg[];
  readonly returns?: string;
  /** Rendered under the argument list. States what is NOT here, and why. */
  readonly absence?: string;
}

const PKG_PLACEHOLDER = '<aphotic>';
const VAULT_PLACEHOLDER = '<vault>';
const HASHI_PLACEHOLDER = '<hashi>';

function pkg(): string {
  const id = config.aphotic.packageId;
  return id.length > 0 ? id : PKG_PLACEHOLDER;
}

function vaultRef(): string {
  const id = config.aphotic.vaultId;
  return id.length > 0 ? id : VAULT_PLACEHOLDER;
}

function hashiRef(): string {
  const id = config.hashi.objectId;
  return id.length > 0 ? id : HASHI_PLACEHOLDER;
}

const CLOCK_ARG: CallArg = {
  name: 'clock',
  type: '&Clock',
  value: SUI_CLOCK_OBJECT_ID,
  note: 'the shared Clock, for the bridge’s cooldown arithmetic',
};

// ── T1.3 · register the write-once destination ──────────────────────────────

export function describeRegisterCall(program: Uint8Array): CallDescription {
  const t = moveTargets();
  return {
    target: `${pkg()}::gateway::register_exit_address`,
    typeArguments: [t.baseType, t.quoteType],
    args: [
      { name: 'vault', type: '&mut Vault<B, Q>', value: vaultRef() },
      {
        name: 'addr',
        type: 'vector<u8>',
        value: `${program.length} bytes`,
        note: 'the witness program, written ONCE. A second call aborts EExitAddressAlreadySet.',
      },
    ],
    absence:
      'This is the only call in the whole protocol that accepts a Bitcoin destination — and it can succeed at most once per depositor.',
  };
}

/**
 * Pin the sender's Bitcoin payout address. WRITE-ONCE: any later call aborts
 * `EExitAddressAlreadySet` (G2).
 */
export function buildRegisterExitAddressTx(program: Uint8Array): Transaction {
  const t = requireTargets();
  const tx = new Transaction();
  tx.moveCall({
    target: `${t.packageId}::gateway::register_exit_address`,
    typeArguments: [t.baseType, t.quoteType],
    arguments: [tx.object(t.vaultId), tx.pure.vector('u8', Array.from(program))],
  });
  return tx;
}

// ── T1.3 · the composed, destination-pinned exit ────────────────────────────

export interface ExitCallArgs {
  readonly sharesToBurn: bigint;
  /** DeepBook mid, FLOAT_SCALING 1e9. NEVER a raw Pyth price (G9). */
  readonly bookMid: bigint;
}

export function describeExitCall(a: ExitCallArgs): CallDescription {
  const t = moveTargets();
  return {
    target: `${pkg()}::gateway::exit_to_bitcoin`,
    typeArguments: [t.quoteType],
    args: [
      { name: 'vault', type: '&mut Vault<BTC, Q>', value: vaultRef() },
      { name: 'hashi', type: '&mut Hashi', value: hashiRef(), note: 'the bridge’s shared object' },
      { name: 'shares_to_burn', type: 'u64', value: a.sharesToBurn.toString() },
      {
        name: 'book_mid',
        type: 'u128',
        value: a.bookMid.toString(),
        note: 'DeepBook mid at 1e9 scaling — NAV is valued at the book, never at raw Pyth',
      },
      CLOCK_ARG,
    ],
    absence:
      'There is no bitcoin_address argument. The destination is read inside Move from Vault.btc_exit_address, so no caller — you, us, or a fully compromised keeper — can redirect this payout.',
  };
}

/**
 * ONE PTB: burn shares → split `Balance<BTC>` → `request_withdrawal` to the
 * PINNED address. Sub-minimum proceeds are pooled inside Move and nothing is
 * submitted to the bridge (G3). The Sui leg settles in one checkpoint (G1); the
 * ~1.5–2 h Bitcoin leg happens inside the bridge afterwards (G6).
 */
export function buildExitToBitcoinTx(a: ExitCallArgs): Transaction {
  const t = requireTargets();
  const tx = new Transaction();
  tx.moveCall({
    target: `${t.packageId}::gateway::exit_to_bitcoin`,
    typeArguments: [t.quoteType],
    arguments: [
      tx.object(t.vaultId),
      tx.object(t.hashiObjectId),
      tx.pure.u64(a.sharesToBurn),
      tx.pure.u128(a.bookMid),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

// ── T1.4 · the pooled small-exit path ───────────────────────────────────────

export interface FlushCallArgs {
  /** MUST equal the signer. `stage_flush` asserts `who == ctx.sender()` (E-M8). */
  readonly who: string;
}

export function describeFlushCall(a: FlushCallArgs): CallDescription {
  const t = moveTargets();
  return {
    target: `${pkg()}::gateway::flush_pending_exit`,
    typeArguments: [t.quoteType],
    args: [
      { name: 'vault', type: '&mut Vault<BTC, Q>', value: vaultRef() },
      { name: 'hashi', type: '&mut Hashi', value: hashiRef() },
      {
        name: 'who',
        type: 'address',
        value: a.who,
        note: 'asserted equal to the signer — a third-party flush would make that third party the only party able to reclaim',
      },
      CLOCK_ARG,
    ],
    absence: 'No destination argument here either — the pooled sats leave to the same pinned address.',
  };
}

export function buildFlushPendingExitTx(a: FlushCallArgs): Transaction {
  const t = requireTargets();
  const tx = new Transaction();
  tx.moveCall({
    target: `${t.packageId}::gateway::flush_pending_exit`,
    typeArguments: [t.quoteType],
    arguments: [
      tx.object(t.vaultId),
      tx.object(t.hashiObjectId),
      tx.pure.address(a.who),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

export interface TakeCallArgs {
  /** Where the resulting `Coin<hBTC>` goes — the sender's own address. */
  readonly recipient: string;
}

export function describeTakeCall(a: TakeCallArgs): CallDescription {
  const t = moveTargets();
  return {
    target: `${pkg()}::gateway::take_pending_as_hbtc`,
    typeArguments: [t.baseType, t.quoteType],
    args: [{ name: 'vault', type: '&mut Vault<B, Q>', value: vaultRef() }],
    returns: `Coin<${t.baseType}> → transferred to ${a.recipient}`,
    absence:
      'No bridge surface at all: this stays on Sui and settles in one checkpoint. You keep custodial-threshold wrapped BTC instead of waiting for the pool to clear the 30,000-sat minimum.',
  };
}

/** Take the sub-minimum earmark back as hBTC on Sui. Instant, one checkpoint (G1). */
export function buildTakePendingAsHbtcTx(a: TakeCallArgs): Transaction {
  const t = requireTargets();
  const tx = new Transaction();
  const coin = tx.moveCall({
    target: `${t.packageId}::gateway::take_pending_as_hbtc`,
    typeArguments: [t.baseType, t.quoteType],
    arguments: [tx.object(t.vaultId)],
  });
  tx.transferObjects([coin], tx.pure.address(a.recipient));
  return tx;
}

// ── T1.4 · reclaim — DEPOSITOR-SIGNED, never keeper-signed ──────────────────

export interface ReclaimCallArgs {
  /** The bridge's withdrawal request id (an address-shaped object id). */
  readonly requestId: string;
  readonly bookMid: bigint;
}

export function describeReclaimCall(a: ReclaimCallArgs): CallDescription {
  const t = moveTargets();
  return {
    target: `${pkg()}::gateway::reclaim_stalled_exit`,
    typeArguments: [t.quoteType],
    args: [
      { name: 'vault', type: '&mut Vault<BTC, Q>', value: vaultRef() },
      { name: 'hashi', type: '&mut Hashi', value: hashiRef() },
      { name: 'request_id', type: 'address', value: a.requestId },
      { name: 'book_mid', type: 'u128', value: a.bookMid.toString(), note: 'shares are re-credited at the CURRENT NAV' },
      CLOCK_ARG,
    ],
    absence:
      'Hashi’s cancel_withdrawal asserts request.sender == ctx.sender(). This PTB is only valid when YOU sign it — the keeper can build it and can never submit it.',
  };
}

/**
 * Cancel a stalled bridge request and re-credit the shares.
 *
 * ⚠ DEPOSITOR-SIGNED ONLY (RECON R7.3 / E-A3). Sponsored gas is fine —
 * sponsorship changes who PAYS, never who the SENDER is.
 */
export function buildReclaimStalledExitTx(a: ReclaimCallArgs): Transaction {
  const t = requireTargets();
  const tx = new Transaction();
  tx.moveCall({
    target: `${t.packageId}::gateway::reclaim_stalled_exit`,
    typeArguments: [t.quoteType],
    arguments: [
      tx.object(t.vaultId),
      tx.object(t.hashiObjectId),
      tx.pure.address(a.requestId),
      tx.pure.u128(a.bookMid),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}
