// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T3.4
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/APP.md §1 (lib/), §2.4, §3.3 (exit PTB), §7 A1 A4
// @spec       docs/APP.md ERRATA E-A3 (reclaim is DEPOSITOR-signed; sponsorship
//             changes who PAYS, never who the SENDER is)
// @spec       move/sources/vault.move · gateway.move · envelope.move · router.move
//             · journal.move — the `const E…: u64 = n;` blocks are the source of
//             truth for every abort code mapped below
// @rules      G2 G7 G8 G10
// @depends    ../config.ts (T0.4) · ./suiClient.ts (T0.4) · ../session/useSession.ts
// @facts      THE ONE SEND PATH. Every screen that writes to chain goes through
// @facts        useAphoticTx(); nothing else may call useSignAndExecuteTransaction.
// @facts      dapp-kit 1.1.9 `useSignAndExecuteTransaction` signs AND executes via
// @facts        the connected wallet-standard wallet (extension OR Enoki zkLogin —
// @facts        both are wallet-standard, so there is exactly one code path).
// @facts      The wallet-standard `chain` is `sui:<network>`, built from
// @facts        config.sui.network. Never inline 'sui:testnet' (G7).
// @facts      Move abort rendering seen in the wild:
// @facts        MoveAbort(MoveLocation { module: ModuleId { address: 148a11…,
// @facts        name: Identifier("gateway") }, function: 4, instruction: 27,
// @facts        function_name: Some("exit_to_bitcoin") }, 4) in command 2
// @facts      ⚠ The REAL hashi package uses `#[error]` byte-string constants, so
// @facts        its abort codes are CLEVER (high bit set) and are NOT comparable to
// @facts        a small u64. We never guess a clever code's meaning: we match the
// @facts        upstream byte-string when the node echoes it, else we surface raw.
// @facts      Aphotic's own modules use plain `const E…: u64` — those ARE mapped.
// @facts      vault code 1 is VACANT (the removed owner emergency withdraw). An
// @facts        abort 1 from ::vault:: must NOT be given a meaning.
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
//                reclaim satisfying Hashi's `request.sender == ctx.sender()` (E-A3).
// @invariant  4. waitForTransaction is best-effort: it can never turn a successful
//                execution into a reported failure.
// @ac         docs/APP.md §7 A4 — a Move abort renders as human text, not a hex dump.
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
  /** Move module name, e.g. `gateway`. Null when the string did not carry one. */
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
 * Mirrors the `const E…: u64 = n;` block at the top of each file under
 * `move/sources/`. Keep in sync; an unmapped code degrades to the raw string,
 * which is ugly but honest.
 *
 * ⚠ `vault` code 1 is deliberately ABSENT: it belonged to the removed owner
 * emergency withdraw and the slot was left vacant so an old client decoding
 * abort 1 finds nothing rather than a different meaning.
 */
export const APHOTIC_ABORTS: Readonly<Record<string, Readonly<Record<number, AbortEntry>>>> = {
  vault: {
    2: { name: 'ENotAuthorized', text: 'That capability is not authorised for this vault action.' },
    3: { name: 'EZeroShares', text: 'The vault has no shares outstanding, so there is nothing to price.' },
    4: { name: 'EZeroDeposit', text: 'A deposit of zero sats is not accepted.' },
    5: { name: 'EInsufficientShares', text: 'You do not hold enough vault shares for that amount.' },
    6: { name: 'EPaused', text: 'The vault is paused: deposits, exits and trading are all halted.' },
    7: { name: 'EStaleVersionEpoch', text: 'Your page is on an old strategy version epoch — reload and retry.' },
    8: { name: 'EBadIdentityNamespace', text: 'The Seal identity namespace does not belong to this vault.' },
    9: { name: 'ECapVaultMismatch', text: 'That capability belongs to a different vault.' },
    10: { name: 'EUnregisteredDepositor', text: 'This address has no depositor record in the vault yet — deposit first.' },
    11: { name: 'EZeroNav', text: 'The vault values at zero, so a share price cannot be computed.' },
    12: { name: 'EOverflow', text: 'That amount overflows the vault’s 64-bit sats accounting.' },
    13: { name: 'EZeroRedemption', text: 'That share amount redeems to zero sats — increase it.' },
    14: { name: 'EInsufficientIdle', text: 'The vault’s idle balance is short: capital is currently deployed on the order book.' },
    15: { name: 'EExitAddressAlreadySet', text: 'A Bitcoin exit address is already pinned for you. Pinning is write-once and cannot be changed.' },
    16: { name: 'ENothingPending', text: 'There is no pending exit to flush for this address.' },
  },
  gateway: {
    1: { name: 'EBadAddressLength', text: 'That is not a 20-byte P2WPKH or 32-byte P2TR witness program — Hashi accepts no other shape.' },
    2: { name: 'EExitAddressAlreadySet', text: 'Your Bitcoin exit address is already pinned on-chain. It is immutable by design — that is what stops a compromised keeper redirecting funds.' },
    3: { name: 'EExitAddressUnset', text: 'No Bitcoin exit address is pinned for you yet. Register one before exiting.' },
    4: { name: 'EBelowHashiMinimum', text: 'Below Hashi’s 30,000 sat withdrawal minimum. The amount pools on-chain until it clears the floor — it is not a queue position.' },
    5: { name: 'ENotDepositor', text: 'Only the depositor can do this. Reclaims and exits are depositor-signed.' },
    6: { name: 'ERequesterMismatch', text: 'The signer does not match the address this call is being made for.' },
  },
  envelope: {
    1: { name: 'EPaused', text: 'The risk envelope is paused — no action passes the gate.' },
    2: { name: 'ECooldown', text: 'The envelope cooldown has not elapsed since the last action.' },
    3: { name: 'EOracleDivergence', text: 'Pyth and the DeepBook book disagree beyond the allowed band — trading is halted until they reconverge.' },
    4: { name: 'EBufferBreach', text: 'That size would eat into the redemption buffer reserved for exits.' },
    5: { name: 'ENotionalCap', text: 'That size exceeds the per-action notional cap.' },
    6: { name: 'ESlippage', text: 'The price is further from the book mid than the envelope allows.' },
    7: { name: 'EBlobUnavailable', text: 'The Walrus decision blob is missing or not attested available.' },
  },
  router: {
    1: { name: 'EWrongPool', text: 'That is not the pool this vault trades.' },
    2: { name: 'ENotKeeper', text: 'Only the keeper’s TradeCap may place orders. It can trade; it can never take (G2).' },
    3: { name: 'EBadTick', text: 'The price is not on the pool’s tick grid.' },
    4: { name: 'EBadLot', text: 'The quantity is not a whole number of lots.' },
    5: { name: 'EBelowMinSize', text: 'The order is below the pool’s minimum size.' },
    6: { name: 'EEmptyBook', text: 'The order book is empty on at least one side, so there is no mid to quote against.' },
    7: { name: 'ENotPostOnly', text: 'The maker leg must be POST_ONLY and this order would have crossed.' },
  },
  journal: {
    1: { name: 'EStaleSeq', text: 'That journal sequence number is not ahead of the last one recorded.' },
    2: { name: 'ECursorVaultMismatch', text: 'That journal cursor belongs to a different vault.' },
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
 *   MoveAbort(MoveLocation { module: ModuleId { address: …, name: Identifier("gateway") },
 *             function: 4, instruction: 27, function_name: Some("exit_to_bitcoin") }, 4)
 *   MoveAbort(MoveLocation { module: 0x148a…::gateway, function: 4, … }, 4)
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
