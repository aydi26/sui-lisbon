// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F1
// @phase      0
// @status     DONE
// @spec       docs/DESIGN-V2.md §11 (ladder + why the floor matters)
// @spec       aphotic.md §7.1 (notes), §2 constraint 4 (escrow must not leak size)
// @rules      G7 G10
// @depends    ../config.ts (F1) · ../lib/format.ts · ../theme.css
// @facts      LADDER = [1_000_000, 10_000_000, 100_000_000, 1_000_000_000] sats
// @facts        = 0.01 / 0.1 / 1 / 10 hBTC. Governed, APPEND-ONLY — repricing a
// @facts        live tier would revalue live notes.
// @facts      The floor is load-bearing: 0.01 hBTC = 1_000_000 sats sits far above
// @facts        Hashi's 30_000-sat withdrawal minimum, so EVERY denomination is
// @facts        individually redeemable.
// @facts      THE ARGUMENT, which belongs on screen and not just in a doc:
// @facts        denominations create UNIFORMITY, not privacy. Privacy comes from
// @facts        the crowd. A ladder fine enough to express an exact amount
// @facts        fragments participants into singleton anonymity sets and is worth
// @facts        LESS than no ladder at all.
// @facts      ⚠ A free-form `Balance<BTC>` in an order object carries a publicly
// @facts        readable amount and would defeat the entire design — which is why
// @facts        there is no free-form amount field anywhere in this app.
// @implements export function DenominationLadder(props): JSX.Element
//             export const DENOMINATIONS: readonly Denomination[]
// @forbidden  a free-form amount <input> anywhere in app/ — the ladder IS the
//             product; an "advanced: exact amount" affordance is the attack
// @forbidden  a 5th tier added client-side — the ladder is governed on-chain
// @invariant  1. Exactly `config.constants.denominationsSats.length` buttons.
// @invariant  2. Every value is a bigint number of sats.
// @invariant  3. The uniformity note renders unconditionally — it is the reason
//                the control looks like this, and hiding it invites a redesign.
// @ac         four buttons; selecting one reports its sats value as a bigint.
// @verify     cd app && npm test -- denomination
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { config } from '../config';
import { formatBtcCompact } from '../lib/format';

export interface Denomination {
  /** Index into the governed on-chain ladder. This is what a `Note` stores. */
  readonly index: number;
  readonly sats: bigint;
  /** `0.01 hBTC`. */
  readonly label: string;
}

export const DENOMINATIONS: readonly Denomination[] = config.constants.denominationsSats.map(
  (sats, index) => ({ index, sats, label: `${formatBtcCompact(sats)} hBTC` }),
);

export interface DenominationLadderProps {
  /** Index of the selected tier, or null for none. */
  readonly selected: number | null;
  readonly onSelect: (denom: Denomination) => void;
  /** Per-tier count the connected participant holds, keyed by index. */
  readonly held?: Readonly<Record<number, number>>;
  readonly disabled?: boolean;
  /** One line explaining a disabled ladder. Rendered, never swallowed. */
  readonly disabledReason?: string | null;
  readonly label?: string;
}

export function DenominationLadder({
  selected,
  onSelect,
  held,
  disabled = false,
  disabledReason = null,
  label = 'Size',
}: DenominationLadderProps) {
  return (
    <div className="ap-ladder" role="group" aria-label={`${label} — fixed denominations`}>
      <span className="ap-eyebrow">{label} · fixed denominations only</span>

      <div className="ap-ladder-row">
        {DENOMINATIONS.map((d) => {
          const active = selected === d.index;
          const count = held?.[d.index];
          return (
            <button
              key={d.index}
              type="button"
              className={active ? 'ap-btn ap-btn--primary' : 'ap-btn'}
              aria-pressed={active}
              disabled={disabled}
              onClick={() => onSelect(d)}
            >
              <span className="ap-num">{d.label}</span>
              <span className="ap-ladder-sub">
                {count === undefined ? `${d.sats.toLocaleString('en-US')} sats` : `${count} held`}
              </span>
            </button>
          );
        })}
      </div>

      {disabled && disabledReason !== null ? (
        <p className="ap-reason ap-reason--warn">{disabledReason}</p>
      ) : null}

      <p className="ap-reason">
        There is no free-form amount field in this application, and that is deliberate.
        Denominations create <strong>uniformity, not privacy</strong> — privacy comes from the
        crowd. A ladder fine enough to express an exact amount fragments participants into
        singleton anonymity sets and is worth less than no ladder at all. The floor is chosen so
        every tier stays individually redeemable: 0.01 hBTC is 1,000,000 sats, far above Hashi&rsquo;s{' '}
        {config.hashi.withdrawalMinSats.toLocaleString('en-US')}-sat withdrawal minimum.
      </p>
    </div>
  );
}

export default DenominationLadder;
