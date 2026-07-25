// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.3, T0.5
// @phase      0
// @status     DONE
// @spec       docs/CONVENTIONS.md §1 (banner grammar)
// @spec       docs/KEEPER.md §2.4 (MOCK throws NotReady / RateLimitExceeded)
// @spec       docs/RECON.md#r7 (Hashi Move abort names mirrored 1:1 by the mock)
// @rules      G3 G7
// @facts      Hashi Move aborts mirrored here VERBATIM (docs/RECON.md R7):
// @facts        EBelowMinimumWithdrawal          — btc.value() < 30_000
// @facts        EInvalidBitcoinAddress           — addr_len != 20 && != 32
// @facts        EUnauthorizedCancellation        — request.sender != ctx.sender()
// @facts        ECannotCancelProcessingWithdrawal
// @facts        ECooldownNotElapsed              — now < created_ms + 3_600_000
// @facts      RateLimitExceeded is a REJECTION, never a queue (G3).
// @implements export class AphoticError extends Error
// @implements export class NotImplementedError extends AphoticError
// @implements export class ConfigError extends AphoticError
// @implements export class NotFoundError extends AphoticError
// @implements export class NotReadyError extends AphoticError
// @implements export class TimeoutError extends AphoticError
// @implements export class RateLimitExceededError extends AphoticError
// @implements export class InvalidInputsError extends AphoticError
// @implements export class BelowMinimumWithdrawalError extends AphoticError
// @implements export class BelowMinimumDepositError extends AphoticError
// @implements export class InvalidBitcoinAddressError extends AphoticError
// @implements export class UnauthorizedCancellationError extends AphoticError
// @implements export class CannotCancelProcessingWithdrawalError extends AphoticError
// @implements export class CooldownNotElapsedError extends AphoticError
// @invariant  1. Every error carries a stable `code` string so tests never match on message text.
// @verify     npm test
// └── END CONTRACT ───────────────────────────────────────────────────────────

/** Base class for every error this keeper raises. `code` is the stable, testable discriminant. */
export class AphoticError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Thrown by every stub that a later BUILD-PLAN task must implement. */
export class NotImplementedError extends AphoticError {
  constructor(what: string, task: string) {
    super('NotImplemented', `TODO(${task}): ${what} is not implemented yet`);
  }
}

/** Configuration is missing/invalid. Carries the offending variable names. */
export class ConfigError extends AphoticError {
  readonly missing: readonly string[];

  constructor(message: string, missing: readonly string[] = []) {
    super('ConfigError', message);
    this.missing = missing;
  }
}

export class NotFoundError extends AphoticError {
  constructor(what: string) {
    super('NotFound', `not found: ${what}`);
  }
}

/** A lifecycle step was attempted before its mandatory delay elapsed. */
export class NotReadyError extends AphoticError {
  readonly readyAtMs: number;

  constructor(what: string, readyAtMs: number, nowMs: number) {
    super('NotReady', `${what} not ready: ready at ${readyAtMs}ms, now ${nowMs}ms`);
    this.readyAtMs = readyAtMs;
  }
}

export class TimeoutError extends AphoticError {
  constructor(what: string, timeoutMs: number) {
    super('Timeout', `${what} timed out after ${timeoutMs}ms`);
  }
}

/**
 * Guardian limiter rejection. G3: over-capacity batches are REJECTED, never queued.
 * You cannot buy priority in Hashi's global withdrawal queue.
 */
export class RateLimitExceededError extends AphoticError {
  readonly requestedSats: bigint;
  readonly availableSats: bigint;

  constructor(requestedSats: bigint, availableSats: bigint) {
    super(
      'RateLimitExceeded',
      `guardian limiter rejected batch: requested ${requestedSats} sats, capacity ${availableSats} sats`,
    );
    this.requestedSats = requestedSats;
    this.availableSats = availableSats;
  }
}

/** Guardian limiter `InvalidInputs` (seq mismatch or non-monotonic timestamp). */
export class InvalidInputsError extends AphoticError {
  constructor(reason: string) {
    super('InvalidInputs', `guardian limiter rejected inputs: ${reason}`);
  }
}

/** Mirrors `hashi::withdraw` abort `EBelowMinimumWithdrawal` (30_000 sats, docs/RECON.md R7). */
export class BelowMinimumWithdrawalError extends AphoticError {
  constructor(sats: bigint, minimumSats: bigint) {
    super(
      'EBelowMinimumWithdrawal',
      `withdrawal of ${sats} sats is below the Hashi minimum of ${minimumSats} sats`,
    );
  }
}

/** Mirrors the deposit-side floor: `bitcoin_deposit_minimum` = 30_000 sats (docs/RECON.md R6). */
export class BelowMinimumDepositError extends AphoticError {
  constructor(sats: bigint, minimumSats: bigint) {
    super(
      'EBelowMinimumDeposit',
      `deposit of ${sats} sats is below the Hashi minimum of ${minimumSats} sats`,
    );
  }
}

/** Mirrors `hashi::withdraw` abort `EInvalidBitcoinAddress` (20 P2WPKH | 32 P2TR bytes). */
export class InvalidBitcoinAddressError extends AphoticError {
  constructor(byteLength: number) {
    super(
      'EInvalidBitcoinAddress',
      `bitcoin address must be 20 bytes (P2WPKH) or 32 bytes (P2TR), got ${byteLength}`,
    );
  }
}

/**
 * Mirrors `hashi::withdraw` abort `EUnauthorizedCancellation`.
 * ⚠ docs/RECON.md R7.3: `cancel_withdrawal` asserts `request.sender == ctx.sender()`
 * ⇒ reclaim is DEPOSITOR-callable only; the keeper can NEVER call it.
 */
export class UnauthorizedCancellationError extends AphoticError {
  constructor(requester: string, caller: string) {
    super(
      'EUnauthorizedCancellation',
      `only the original requester (${requester}) may cancel; caller was ${caller}`,
    );
  }
}

/** Mirrors `hashi::withdraw` abort `ECannotCancelProcessingWithdrawal`. */
export class CannotCancelProcessingWithdrawalError extends AphoticError {
  constructor(requestId: string, status: string) {
    super(
      'ECannotCancelProcessingWithdrawal',
      `withdrawal ${requestId} is past the pre-commit window (status ${status})`,
    );
  }
}

/** Mirrors `hashi::withdraw` abort `ECooldownNotElapsed` (1h, `withdrawal_cancellation_cooldown_ms`). */
export class CooldownNotElapsedError extends AphoticError {
  constructor(readyAtMs: number, nowMs: number) {
    super('ECooldownNotElapsed', `cancellation cooldown not elapsed: ready at ${readyAtMs}ms, now ${nowMs}ms`);
  }
}
