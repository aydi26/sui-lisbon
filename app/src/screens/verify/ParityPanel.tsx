// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F4
// @phase      4
// @status     DONE
// @spec       aphotic.md §9 — "a divergence between clearing implementations is a
//             RELEASE BLOCKER". This panel is that blocker, published.
// @spec       docs/DESIGN-V2.md §5ter (THE PARITY CLAIM DOES NOT CURRENTLY HOLD,
//             measured 2026-07-26), §9 (parity asserted at three levels: L1 golden
//             fixtures, L2 property test, L3 against Move)
// @spec       clearing-rs/tests/divergence.rs — the seeded 4 000-book census
// @rules      G8
// @depends    ../../theme.css (F1)
// @facts      THE MEASUREMENT, exactly as recorded: a THIRD implementation was
// @facts        written in Rust specifically to check the parity claim, and the
// @facts        claim FAILED. TypeScript, the 46 golden fixtures and the Rust spec
// @facts        engine agree with one another. MOVE differs — and Move is what
// @facts        settles. Full agreement on 3 407 of 4 000 seeded books (85 %).
// @facts      D1 leaf layout   Move bcs(Fill) = 73 bytes (batch_id, no fee);
// @facts                       §5bis = 81 (fee, no batch_id, u128 price).
// @facts                       ⇒ the two Merkle roots can NEVER match.
// @facts      D2 allocation    Move fills an overfull strictly-inside level
// @facts                       GREEDILY; the spec PRO-RATES. 97/4 000 = 2.4 %.
// @facts      D3 fee           Move folds rounding dust into the fee; the spec
// @facts                       keeps them separate. 516/4 000 = 12.9 % — the most
// @facts                       frequent and the least visible.
// @facts      D4 truncation    Move truncates at LOAD, before price discovery, so
// @facts                       ONE UNDER-FUNDED ACCOUNT MOVES THE UNIFORM PRICE FOR
// @facts                       EVERYONE. Counterexample: 10 on Move, 12 on spec.
// @facts      D5 price width   u64 in Move, u128 in the spec.
// @facts      ⚠ D2 and D4 are genuine DESIGN QUESTIONS, not bugs — which is why the
// @facts        Rust crate keeps BOTH engines rather than picking a winner.
// @facts      WHY THIS IS THE FIRST PANEL: a verification screen's only value is
// @facts        being believed when it says something is fine. Volunteering the one
// @facts        thing that is not fine is worth more than any green tick.
// @facts      2026-07-26: the rest of /verify was trimmed for the new /docs page.
// @facts        THIS PANEL WAS NOT. It moved to the `.ap-panel` grammar and lost
// @facts        one sentence of throat-clearing; every figure, every consequence
// @facts        and the release-blocker framing are untouched, and it still
// @facts        renders FIRST. A trim that quietened this panel would be the one
// @facts        edit that costs the screen its reason to exist.
// @implements export const DIVERGENCES · export function ParityPanel(): JSX.Element
// @forbidden  softening "release blocker", the 15 % figure, or the word NEVER in D1
// @forbidden  claiming bit-identical parity anywhere in this app
// @invariant  1. All five named divergences render, each with its consequence.
// @invariant  2. The panel states that Move is the side that settles.
// @ac         app/test/verify.test.tsx — the five ids, the counts, and the
//             design-question caveat all render.
// @verify     cd app && npm test -- verify
// └── END CONTRACT ───────────────────────────────────────────────────────────

export interface Divergence {
  readonly id: string;
  readonly title: string;
  readonly what: string;
  readonly consequence: string;
  /** How often it bites across the 4 000-book census, where measured. */
  readonly incidence: string;
  /** True when the disagreement is a design choice rather than a defect. */
  readonly designQuestion: boolean;
}

export const DIVERGENCES: readonly Divergence[] = [
  {
    id: 'D1',
    title: 'Fill leaf layout — 73 bytes against 81',
    what:
      "Move's bcs(Fill) is 73 bytes and carries batch_id with no fee. The specification's leaf is 81 bytes: it carries a fee, carries no batch_id, and widens price to u128.",
    consequence:
      'The two Merkle roots can NEVER match for a non-empty fill set. Byte-comparing them today is meaningless, so this app proves fills against the root the contract published and against nothing else.',
    incidence: 'every non-empty fill set',
    designQuestion: false,
  },
  {
    id: 'D2',
    title: 'Allocation — greedy against pro-rata',
    what:
      'Move fills an overfull strictly-inside level greedily; the specification pro-rates it. Bids 60@10 + 60@10 against ask 50@5 give 50/0 on Move and 25/25 on the spec.',
    consequence:
      'Two participants at the same price receive different fills depending on which implementation runs.',
    incidence: '97 of 4 000 books (2.4 %)',
    designQuestion: true,
  },
  {
    id: 'D3',
    title: 'Fee — rounding dust folded in',
    what:
      'Move folds rounding dust into the fee; the specification keeps the two separate. Asserted exactly: move.fee_quote == spec.fee_quote + spec.dust_quote.',
    consequence:
      'The most frequent divergence and the least visible one — the totals still balance, so nothing looks wrong until you compare the fee line.',
    incidence: '516 of 4 000 books (12.9 %)',
    designQuestion: false,
  },
  {
    id: 'D4',
    title: 'Truncation timing — one under-funded account moves the price',
    what:
      'Move truncates an under-funded account at load, before price discovery. The specification truncates after. A counterexample clears at 10 on Move and at 12 on the spec.',
    consequence:
      'A funding shortfall in one account changes the uniform clearing price for everyone in the batch. That is a design question, not a rounding one.',
    incidence: 'measured on the seeded census',
    designQuestion: true,
  },
  {
    id: 'D5',
    title: 'Price width — u64 against u128',
    what:
      'Move prices are u64; the specification uses u128. The u128-max-price fixture is not expressible against Move at all.',
    consequence: 'A price the specification admits cannot be represented on chain.',
    incidence: 'boundary fixtures only',
    designQuestion: false,
  },
];

function Row({ d }: { readonly d: Divergence }) {
  return (
    <li className="ap-rowline">
      <div className="ap-row" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: '0.75rem' }}>
        <strong>
          <span className="aphotic-mono">{d.id}</span> — {d.title}
        </strong>
        <span className={d.designQuestion ? 'ap-chip' : 'ap-chip ap-chip--warn'}>
          {d.designQuestion ? 'design question' : 'defect'}
        </span>
      </div>
      <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', margin: '0.35rem 0' }}>{d.what}</p>
      <p className="ap-reason ap-reason--warn" style={{ margin: 0 }}>
        {d.consequence}
      </p>
      <p className="aphotic-muted" style={{ fontSize: 'var(--text-sm)', margin: '0.35rem 0 0' }}>
        Incidence: {d.incidence}
      </p>
    </li>
  );
}

/**
 * The parity failure, first on the page and undiluted.
 *
 * Nothing here is fetched: it is a measurement that was taken once, recorded in
 * `docs/DESIGN-V2.md` §5ter and `clearing-rs/tests/divergence.rs`, and is being
 * republished rather than summarised.
 */
export function ParityPanel() {
  return (
    <section className="ap-panel" aria-label="Clearing parity — the claim does not currently hold">
      <div className="ap-panel-head">
        <h3 className="ap-panel-title">The parity claim does not currently hold</h3>
        <span className="ap-chip ap-chip--warn">
          <span className="ap-chip-dot" aria-hidden="true" />
          release blocker
        </span>
      </div>

      <div className="ap-panel-body" style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <p className="ap-msg ap-msg--bad" style={{ margin: 0 }}>
          A divergence between clearing implementations is a <strong>release blocker</strong>. We
          wrote a third implementation, in Rust, specifically to check for one — and it found one.
          The TypeScript, the 46 golden fixtures and the Rust spec engine all agree with each other.{' '}
          <strong>Move differs</strong>, and Move is what settles.
        </p>

        <div className="ap-grid ap-grid--2">
          <div className="ap-metric">
            <div className="ap-metric-label">Seeded books in full agreement</div>
            <div className="ap-metric-value">3 407 / 4 000</div>
            <div className="ap-metric-sub">85 % — so 15 % diverge</div>
          </div>
          <div className="ap-metric">
            <div className="ap-metric-label">Named divergences</div>
            <div className="ap-metric-value">5</div>
            <div className="ap-metric-sub">two of them are design questions, not bugs</div>
          </div>
        </div>

        <ul className="ap-rows" style={{ listStyle: 'none', padding: 0 }}>
          {DIVERGENCES.map((d) => (
            <Row key={d.id} d={d} />
          ))}
        </ul>

        <p className="ap-reason">
          Which side is right is a human decision, which is why the Rust crate implements{' '}
          <strong>both</strong> engines rather than picking a winner. Until D1 is resolved we claim
          bit-identical parity nowhere, and this app never compares a locally recomputed root
          against the published one as though a match were expected. Full detail:{' '}
          <code>docs/DESIGN-V2.md</code> §5ter and <code>clearing-rs/tests/divergence.rs</code>.
        </p>
      </div>
    </section>
  );
}

export default ParityPanel;
