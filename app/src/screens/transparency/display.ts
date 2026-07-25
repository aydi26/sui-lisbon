// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T5.2
// @phase      5
// @status     DONE
// @spec       docs/APP.md §4.1 (<DecisionLogViewer/> fields), §4.4 (state shapes)
// @spec       docs/GOLDEN-RULES.md G9 G10
// @rules      G9 G10
// @depends    ../../fixtures (T0.4)
// @facts      USD prices in a DecisionRecord are 8-dec fixed point BIGINTS
// @facts        (oracleUsd8, bookMidUsd8). Never widen them to `number` — the
// @facts        no-float rule is load-bearing, not stylistic (E-M5, G10).
// @facts      NAV/collateral is valued at the DeepBook MID; Pyth is the divergence
// @facts        breaker input only (G9). Label them that way, always.
// @facts      Divergence in bps = (bookMid - oracle) * 10_000 / oracle, integer
// @facts        bigint arithmetic, truncated toward zero.
// @facts      Timestamps render in UTC so two people reading the same record read
// @facts        the same string.
// @implements export function formatUsd8(v: bigint): string
//             export function divergenceBps(oracleUsd8, bookMidUsd8): bigint
//             export function formatUtc(ms: number): string
//             export function formatAge(ms: number): string
//             export function groupDigits(s: string): string
// @forbidden  Number(bigintSats) / floating-point maths on money — G10
// @invariant  1. No function here converts a money bigint to `number`.
// @ac         docs/APP.md §7 A9
// @verify     cd app && npx tsc --noEmit
// └── END CONTRACT ───────────────────────────────────────────────────────────

const USD_SCALE = 100_000_000n; // 8 decimals
const CENT_SCALE = 1_000_000n; // 8 decimals → 2 displayed

export function groupDigits(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** `$118,260.00` from an 8-dec fixed-point bigint. No floating point. */
export function formatUsd8(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = groupDigits((abs / USD_SCALE).toString());
  const cents = ((abs % USD_SCALE) / CENT_SCALE).toString().padStart(2, '0');
  return `${negative ? '-' : ''}$${whole}.${cents}`;
}

/**
 * Signed divergence of the DeepBook mid from the Pyth reading, in basis points.
 * Positive = the book is trading above the oracle. Integer bigint maths.
 */
export function divergenceBps(oracleUsd8: bigint, bookMidUsd8: bigint): bigint {
  if (oracleUsd8 === 0n) return 0n;
  return ((bookMidUsd8 - oracleUsd8) * 10_000n) / oracleUsd8;
}

export function formatBps(bps: bigint): string {
  return `${bps > 0n ? '+' : ''}${bps.toString()} bps`;
}

/** `2026-07-25 08:13:20Z` — UTC, so every reader sees the same string. */
export function formatUtc(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')}Z`;
}

/** Coarse human age: `42 s`, `9 min`, `3 h`, `364 d`. */
export function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 90) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

/** Host of a URL, for compact provenance chips. Never throws. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
