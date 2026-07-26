// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F2
// @phase      1
// @status     DONE
// @spec       move/sources/vault.move — `request_deposit` asserts
//             `assets_sats >= v.params.min_deposit_sats` (EBelowMinDeposit)
// @spec       move/sources/vault.move — `set_min_deposit<B,Q,S>(v, &AdminCap, min_sats)`
// @spec       aphotic.md §1 (async request/settle) · CLAUDE.md G2 G7 G9 G10
// @rules      G2 G7 G9 G10
// @depends    ../lib/format.ts · ../theme.css
// @facts      ★ WHY THIS EXISTS, AND WHY IT IS NOT DenominationLadder.
// @facts        /vault used the NOTE ladder — 1_000_000 / 10_000_000 / 100_000_000 /
// @facts        1_000_000_000 sats — as its deposit size control. That floor is
// @facts        0.01 hBTC, while the live vault's `min_deposit_sats` is 1_000 sats:
// @facts        the screen demanded a THOUSAND TIMES what the contract does. A
// @facts        testnet faucet pays out well under 0.01 hBTC, so every tier was
// @facts        unaffordable, every button was disabled, and /vault looked broken
// @facts        while the chain was fine. Observed 2026-07-26: wallet 663_717 sats
// @facts        against a 1_000_000-sat floor.
// @facts      ★ THE NOTE LADDER IS NOT WRONG — IT IS FOR A DIFFERENT OBJECT. G9
// @facts        fixes note denominations because ESCROW MUST NOT LEAK ORDER SIZE,
// @facts        and it is append-only because repricing a tier revalues live notes.
// @facts        A vault request is not a note: `request_deposit` mints a
// @facts        `DepositReceipt` whose amount is public, and adds to
// @facts        `pending_deposit_assets`, a public running sum. THE SIZE IS ALREADY
// @facts        ON CHAIN IN CLEARTEXT. Borrowing the note ladder here bought zero
// @facts        privacy and cost the vault every user who is not already whale-sized.
// @facts        DENOMINATIONS is therefore untouched — G9 holds, notes are unchanged.
// @facts      ★ THE FLOOR COMES FROM THE CHAIN, NEVER FROM A CONSTANT HERE. Tiers are
// @facts        decade steps from the vault's own `min_deposit_sats`, so an admin
// @facts        `set_min_deposit` moves this control with it and the two can never
// @facts        drift. Before a read there is no floor to know, so the ladder renders
// @facts        NO NUMBER and says why (PositionPanel invariant 1).
// @implements export interface VaultSize / VaultSizeLadderProps
// @implements export function vaultSizes(minSats: bigint): readonly VaultSize[]
// @implements export function VaultSizeLadder(props): JSX.Element
// @forbidden  a hardcoded sats floor — the vault's `min_deposit_sats` is the floor
// @forbidden  reusing DENOMINATIONS here; that ladder governs notes (G9)
// @forbidden  claiming size uniformity for a vault request — the receipt is public
// @invariant  1. Every tier is >= the on-chain minimum, so no tier can abort
//                EBelowMinDeposit.
// @invariant  2. No number renders before `minSats` was read from chain.
// @invariant  3. A tier costing more than the holder has is disabled AND says so on
//                the button itself, never only beside it.
// @ac         app/test/vaultSize.test.tsx
// @verify     cd app && npm test -- vaultSize
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { formatBtcCompact, formatSats } from '../lib/format';

/** One selectable request size. `index` is a position in THIS ladder, not a note denom. */
export interface VaultSize {
  readonly index: number;
  readonly sats: bigint;
  readonly label: string;
}

/** How many decade steps the ladder offers above the floor. */
const STEPS = 4;

/**
 * Decade steps from the vault's own minimum: `min, min×10, min×100, min×1000`.
 *
 * Anchoring on `min_deposit_sats` is the whole point — it is the exact quantity
 * `request_deposit` asserts against, so tier 0 is the smallest request the
 * contract will accept and no tier here can ever abort `EBelowMinDeposit`.
 */
export function vaultSizes(minSats: bigint): readonly VaultSize[] {
  const floor = minSats > 0n ? minSats : 1n;
  return Array.from({ length: STEPS }, (_, index) => {
    const sats = floor * 10n ** BigInt(index);
    return { index, sats, label: formatSats(sats) };
  });
}

export interface VaultSizeLadderProps {
  readonly selected: number | null;
  readonly onSelect: (size: VaultSize) => void;
  /** The vault's `min_deposit_sats`, read from chain. `null` before any read. */
  readonly minSats: bigint | null;
  /** What the holder actually has, in this direction's unit. `null` before any read. */
  readonly heldUnits: bigint | null;
  /** Which unit the ladder is counting — hBTC sats in, share units out. */
  readonly unit: 'sats' | 'shares';
  readonly label?: string;
}

export function VaultSizeLadder({
  selected,
  onSelect,
  minSats,
  heldUnits,
  unit,
  label = 'Size',
}: VaultSizeLadderProps) {
  // Invariant 2: with no floor read, there is no honest number to draw.
  if (minSats === null) {
    return (
      <div className="ap-ladder" role="group" aria-label={`${label} — read the floor first`}>
        <span className="ap-eyebrow">{label}</span>
        <p className="ap-reason">
          Sizes appear once the vault is read. The floor is the vault&rsquo;s own{' '}
          <code>min_deposit_sats</code>, so this control cannot offer a request the contract
          would reject — and it is not guessed from a constant in this app.
        </p>
      </div>
    );
  }

  const sizes = vaultSizes(minSats);

  return (
    <div className="ap-ladder" role="group" aria-label={`${label} — from the vault minimum`}>
      <span className="ap-eyebrow">
        {label} · floor {formatSats(minSats)}, from chain
      </span>

      <div className="ap-ladder-row">
        {sizes.map((s) => {
          const active = selected === s.index;
          // Invariant 3: unaffordable is a state of the BUTTON, with its reason on it.
          const short = heldUnits !== null && heldUnits < s.sats;
          const title = short
            ? `More than you hold (${unit === 'sats' ? formatSats(heldUnits) : `${heldUnits.toLocaleString('en-US')} share units`}).`
            : unit === 'sats'
              ? `Request ${s.label} into the vault`
              : `Surrender ${s.sats.toLocaleString('en-US')} share units`;
          return (
            <button
              key={s.index}
              type="button"
              className={active ? 'ap-btn ap-btn--primary' : 'ap-btn'}
              aria-pressed={active}
              disabled={short}
              title={title}
              onClick={() => onSelect(s)}
            >
              <span className="ap-num">
                {unit === 'sats' ? s.label : `${s.sats.toLocaleString('en-US')} units`}
              </span>
              <span className="ap-ladder-sub">
                {short
                  ? 'more than you hold'
                  : unit === 'sats'
                    ? `${formatBtcCompact(s.sats)} hBTC`
                    : 'share units'}
              </span>
            </button>
          );
        })}
      </div>

      <p className="ap-reason">
        These are the vault&rsquo;s sizes, not the auction&rsquo;s. A vault request is public by
        construction — the receipt carries its amount and{' '}
        <code>pending_deposit_assets</code> is a running total anyone can read — so there is no
        size to hide here and no uniformity claimed. The fixed denominations that <em>do</em>{' '}
        carry that argument belong to sealed orders, where escrow must not leak size.
      </p>
    </div>
  );
}

export default VaultSizeLadder;
