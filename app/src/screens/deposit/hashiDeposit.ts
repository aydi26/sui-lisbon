// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T3.1
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/RECON.md R14 (there is no relayer; the txid is byte-reversed;
//             never register against a mempool txid)
// @spec       docs/RECON.md R6 R7 · docs/FACTS.md#hashi-move-api
// @spec       scripts/register-deposit.ps1 (the operator twin of this module)
// @rules      G1 G3 G6 G7 G8
// @depends    ../../config.ts (T0.4) · @mysten/sui/transactions
// @facts      ⚠ THIS IS THE DEPOSIT SCREEN'S ONLY HASHI BOUNDARY (G7). Every
// @facts        `hashi::` target and every signet HTTP read in Screen 1 lives here;
// @facts        no component or hook calls the bridge directly. Ids come from config.
// @facts      ⚠⚠ NOBODY REGISTERS YOUR DEPOSIT FOR YOU. Verified empirically (R14.1):
// @facts        20 consecutive DepositRequested events had 20 DISTINCT senders, and
// @facts        sender == derivation_path == requester_address in every one. Hashi has
// @facts        no relayer watching deposit addresses. A user who sends BTC and closes
// @facts        the tab is stuck until someone submits this transaction.
// @facts      ⚠⚠ TXID BYTE ORDER (R14.2). hashi::utxo::utxo_id takes the txid in
// @facts        Bitcoin's INTERNAL byte order — the REVERSE of what every explorer
// @facts        and every API shows. Passing the displayed order registers a UTXO that
// @facts        does not exist; the transaction SUCCEEDS and the committee simply never
// @facts        approves it. `reverseTxid` is the one place this can be wrong.
// @facts      ⚠ Never register against a mempool txid (R14.3): an unconfirmed tx can be
// @facts        RBF-replaced, and the amounts and vouts change with it. Registration is
// @facts        gated on bitcoin_confirmation_threshold = 6 confirmations.
// @facts      Call chain (verbatim, verified against the deployed package):
// @facts        public fun hashi::utxo::utxo_id(txid: address, vout: u32): UtxoId
// @facts        public fun hashi::utxo::utxo(id: UtxoId, amount: u64,
// @facts                                     derivation_path: Option<address>): Utxo
// @facts        entry  fun hashi::deposit::deposit(hashi: &mut Hashi, utxo: Utxo,
// @facts                                           clock: &Clock, ctx: &mut TxContext)
// @facts        entry  fun hashi::deposit::confirm_deposit(hashi: &mut Hashi,
// @facts                   request_id: address, clock: &Clock, ctx: &mut TxContext)
// @facts        derivation_path MUST be the Sui address the deposit address was derived
// @facts        from — it is where the hBTC mints.
// @facts      confirm_deposit is PERMISSIONLESS: anyone may call it for anyone. That is
// @facts        a public good, not a privilege — and it is the one part of the Bitcoin
// @facts        leg that is genuinely instant and on-camera demoable (G6).
// @facts      Signet reads use the mempool.space API derived from config.explorers.signet.
// @facts        Read-only, public, and never in the derivation path (the address itself
// @facts        is derived offline in ../../hashi/depositAddress.ts).
// @implements export function reverseTxid(displayed: string): string
//             export interface SignetUtxo · export interface SignetArrival
//             export function fetchSignetArrivals(address, signal): Promise<SignetArrival>
//             export function buildRegisterUtxoTx(a: RegisterUtxoArgs): Transaction
//             export function buildConfirmDepositTx(requestId: string): Transaction
//             export function describeRegisterCall(a: RegisterUtxoArgs): HashiCallDescription
//             export function extractRequestId(events: readonly unknown[]): string | null
// @forbidden  a canonical id literal here — every id comes from config (G7)
// @forbidden  submitting a registration below the confirmation threshold — R14.3
// @forbidden  a priority / fee-bump argument anywhere: you cannot buy queue
//             priority, over-capacity batches are REJECTED, not queued (G3)
// @invariant  1. reverseTxid is an involution on 64 hex chars and throws on anything
//                else — it never silently passes a malformed txid through.
//             2. buildRegisterUtxoTx emits exactly three commands and always passes the
//                REVERSED txid.
//             3. Nothing here signs anything; every builder returns an unsigned PTB.
// @ac         docs/APP.md §7 A5 A10
// @verify     cd app && npx tsc --noEmit
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { Transaction } from '@mysten/sui/transactions';
import { SUI_CLOCK_OBJECT_ID } from '@mysten/sui/utils';

import { config } from '../../config';

// ── txid byte order (R14.2) ─────────────────────────────────────────────────

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Explorer-displayed txid → Bitcoin's internal byte order, which is what
 * `hashi::utxo::utxo_id` expects. Callers ALWAYS hand in the displayed form so
 * there is exactly one place this can be wrong.
 */
export function reverseTxid(displayed: string): string {
  const clean = displayed.trim().replace(/^0x/, '').toLowerCase();
  if (!HEX64.test(clean)) {
    throw new Error(`A Bitcoin txid is 64 hex characters; got ${clean.length}.`);
  }
  let out = '';
  for (let i = 62; i >= 0; i -= 2) out += clean.slice(i, i + 2);
  return out;
}

// ── signet reads ────────────────────────────────────────────────────────────

/** mempool.space REST base, derived from the configured explorer (G7). */
function signetApi(): string {
  return `${config.explorers.signet.replace(/\/+$/, '')}/api`;
}

export interface SignetUtxo {
  /** Explorer-displayed order. Reversed only at the PTB boundary. */
  readonly txid: string;
  readonly vout: number;
  readonly sats: bigint;
  readonly confirmed: boolean;
  /** null while unconfirmed. */
  readonly blockHeight: number | null;
  /** 0 while unconfirmed. */
  readonly confirmations: number;
}

export interface SignetArrival {
  readonly utxos: readonly SignetUtxo[];
  readonly tipHeight: number | null;
  /** True when the explorer answered — distinguishes "nothing yet" from "no data". */
  readonly reachable: boolean;
}

interface MempoolVout {
  readonly scriptpubkey_address?: string;
  readonly value?: number;
}

interface MempoolTx {
  readonly txid?: string;
  readonly vout?: MempoolVout[];
  readonly status?: { readonly confirmed?: boolean; readonly block_height?: number };
}

/**
 * Every output paying `address`, newest first, with a real confirmation depth.
 *
 * This is a public read of a public chain: it tells the depositor exactly where
 * their BTC is, instead of a spinner that cannot know (G6).
 */
export async function fetchSignetArrivals(
  address: string,
  signal?: AbortSignal,
): Promise<SignetArrival> {
  const base = signetApi();

  const [txsResponse, tipResponse] = await Promise.all([
    fetch(`${base}/address/${address}/txs`, { signal }),
    fetch(`${base}/blocks/tip/height`, { signal }),
  ]);

  if (!txsResponse.ok) {
    throw new Error(`mempool.space returned HTTP ${txsResponse.status} for this address.`);
  }

  const txs = (await txsResponse.json()) as MempoolTx[];
  const tipHeight = tipResponse.ok ? Number(await tipResponse.text()) : null;

  const utxos: SignetUtxo[] = [];
  for (const tx of txs) {
    if (typeof tx.txid !== 'string') continue;
    const outputs = tx.vout ?? [];
    for (let vout = 0; vout < outputs.length; vout += 1) {
      const output = outputs[vout];
      if (output?.scriptpubkey_address !== address) continue;
      const confirmed = tx.status?.confirmed === true;
      const blockHeight = confirmed ? (tx.status?.block_height ?? null) : null;
      const confirmations =
        confirmed && blockHeight !== null && tipHeight !== null
          ? Math.max(0, tipHeight - blockHeight + 1)
          : 0;
      utxos.push({
        txid: tx.txid,
        vout,
        sats: BigInt(Math.round(output.value ?? 0)),
        confirmed,
        blockHeight,
        confirmations,
      });
    }
  }

  return { utxos, tipHeight, reachable: true };
}

// ── registration (R14.1) ────────────────────────────────────────────────────

export interface RegisterUtxoArgs {
  /** Explorer-displayed txid. Reversed inside the builder, never by the caller. */
  readonly txid: string;
  readonly vout: number;
  readonly sats: bigint;
  /** The Sui address the deposit address was derived from — where hBTC mints. */
  readonly recipient: string;
}

export interface HashiCallArg {
  readonly name: string;
  readonly type: string;
  readonly value: string;
  readonly note?: string;
}

export interface HashiCallDescription {
  readonly target: string;
  readonly args: readonly HashiCallArg[];
  readonly absence?: string;
}

function requireHashiIds(): { packageId: string; objectId: string } {
  const packageId = config.hashi.packageId;
  const objectId = config.hashi.objectId;
  if (packageId.length === 0 || objectId.length === 0) {
    throw new Error('VITE_HASHI_PACKAGE_ID / VITE_HASHI_OBJECT_ID are empty.');
  }
  return { packageId, objectId };
}

export function describeRegisterCall(a: RegisterUtxoArgs): HashiCallDescription {
  const packageId = config.hashi.packageId;
  const prefix = packageId.length > 0 ? packageId : '<hashi>';
  let internal: string;
  try {
    internal = `0x${reverseTxid(a.txid)}`;
  } catch {
    internal = '<invalid txid>';
  }
  return {
    target: `${prefix}::deposit::deposit`,
    args: [
      {
        name: 'txid',
        type: 'address',
        value: internal,
        note: 'your txid in Bitcoin’s INTERNAL byte order — the reverse of what the explorer shows',
      },
      { name: 'vout', type: 'u32', value: String(a.vout) },
      { name: 'amount', type: 'u64', value: `${a.sats.toString()} sats` },
      {
        name: 'derivation_path',
        type: 'Option<address>',
        value: a.recipient,
        note: 'where the hBTC mints — the same Sui address your deposit address was derived from',
      },
    ],
    absence:
      'There is no fee, priority or expedite argument. Hashi’s queue cannot be jumped: over-capacity batches are rejected, never re-ordered.',
  };
}

/**
 * The registration PTB: `utxo_id → utxo → deposit`. Three commands, one
 * transaction, and the txid is reversed here and only here.
 */
export function buildRegisterUtxoTx(a: RegisterUtxoArgs): Transaction {
  const { packageId, objectId } = requireHashiIds();
  if (a.sats <= 0n) throw new Error('The UTXO amount must be greater than zero.');
  if (a.recipient.length === 0) throw new Error('No Sui address to mint to.');

  const internalTxid = `0x${reverseTxid(a.txid)}`;

  const tx = new Transaction();
  const utxoId = tx.moveCall({
    target: `${packageId}::utxo::utxo_id`,
    arguments: [tx.pure.address(internalTxid), tx.pure.u32(a.vout)],
  });
  const utxo = tx.moveCall({
    target: `${packageId}::utxo::utxo`,
    arguments: [utxoId, tx.pure.u64(a.sats), tx.pure.option('address', a.recipient)],
  });
  tx.moveCall({
    target: `${packageId}::deposit::deposit`,
    arguments: [tx.object(objectId), utxo, tx.object(SUI_CLOCK_OBJECT_ID)],
  });
  return tx;
}

/** The PERMISSIONLESS crank. Anyone may call it, for anyone's deposit. */
export function buildConfirmDepositTx(requestId: string): Transaction {
  const { packageId, objectId } = requireHashiIds();
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(requestId.trim())) {
    throw new Error('A request id is a 0x-prefixed hex object id.');
  }
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::deposit::confirm_deposit`,
    arguments: [
      tx.object(objectId),
      tx.pure.address(requestId.trim()),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

// ── reading the registration back ───────────────────────────────────────────

interface EventLike {
  readonly eventType?: string;
  readonly json?: unknown;
}

/** Depth-first hunt for a named field in a decoded event body. */
function findField(node: unknown, name: string, depth = 0): unknown {
  if (node === null || typeof node !== 'object' || depth > 8) return undefined;
  const record = node as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, name)) return record[name];
  for (const child of Object.values(record)) {
    const hit = findField(child, name, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * `request_id` out of the `deposit::DepositRequested` emitted by the registration.
 * Returns null rather than guessing — the confirm crank then asks for it explicitly.
 */
export function extractRequestId(events: readonly unknown[]): string | null {
  for (const raw of events) {
    const event = raw as EventLike;
    if (typeof event.eventType !== 'string') continue;
    if (!event.eventType.endsWith('::deposit::DepositRequested')) continue;
    const value = findField(event.json, 'request_id');
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}
