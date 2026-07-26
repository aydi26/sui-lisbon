// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F1
// @phase      0
// @status     DONE
// @spec       docs/RECON.md R13 (copy surface: FAQ.jsx ITEMS)
// @spec       aphotic.md §1, §4.2 (the leak), §7.4 (what is not hidden), §13
// @spec       docs/DESIGN-V2.md §7 (KeeperCap), D8 (spends are linkable)
// @rules      G1 G2 G3 G6 G8
// @depends    ./LandingPage.css (.faq-*)
// @facts      Ported VERBATIM from the upstream FAQ.jsx (docs/RECON.md R13).
// @facts        Only ITEMS changed.
// @facts      DO NOT TOUCH: the grid-template-rows 0fr→1fr accordion (CSS) and the
// @facts        single openIndex state (-1 = all closed, click-again toggles shut).
// @facts      HONESTY FACTS quoted in the answers (all source-verified, RECON R6/R7):
// @facts        hBTC = custodial-threshold wrapped BTC: threshold Schnorr across a
// @facts          validator subset, 2-of-2 with a Guardian enclave, ~60-day
// @facts          Bitcoin-script recovery leaf. mpc_threshold = 3334 bps.
// @facts        Sui-side settlement: 1 checkpoint, sub-second (G1).
// @facts        Native-BTC withdrawal: ~1.5-2 h. Deposit: ~70 min (6 signet confs
// @facts          + a 600_000 ms post-approval delay). NEVER live-demoable (G6).
// @facts        Hashi's limiter REJECTS over-capacity batches (RateLimitExceeded);
// @facts          it is not an orderable queue, so priority cannot be bought (G3).
// @implements export default function FAQ()
// @forbidden  calling hBTC trustless, non-custodial, or "just Bitcoin" — G8
// @forbidden  implying Aphotic can expedite a native-BTC withdrawal — G3
// @facts      WEIGHTING: answer 1 opens on the VAULT and describes it in full
// @facts        before the auction is mentioned at all, and says outright that the
// @facts        auction needs a two-sided market to be worth anything. That is the
// @facts        same asymmetry the landing cards and the nav express. It is a
// @facts        presentation decision, not a deletion: answers 2-6 are untouched
// @facts        and the auction keeps its own answer (3).
// @invariant  1. ITEMS.length === 6.
// @invariant  2. The hBTC answer states the custodial-threshold trust model plainly.
// @invariant  3. One item is entirely about what v1 does NOT hide, including that
//                note spends are LINKABLE. It is never removed to tighten the pitch.
// @invariant  4. Answer 3 keeps the queue-leak story in full — the four leaked
//                fields and "meaningless" rather than "hard". Leading with the
//                vault does not mean dropping the leak: the leak is what creates
//                the discount the vault harvests.
// @ac         the on-record honesty lines appear here, in the answers a reader is
//             most likely to open: hBTC is custodial-threshold wrapped BTC · v1
//             note spends are LINKABLE (the Merkle path is public, so the leaf
//             index names the note — uniformity, not unlinkability) · priority in
//             the withdrawal queue cannot be bought · the spread is the price of
//             latency, and if the queue clears in minutes the venue is worth little.
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

import React, { useState } from "react";

const ITEMS = [
  {
    q: "What is Aphotic?",
    a: "A redemption-carry vault, first and mostly. It buys hBTC at a discount on the secondary market, redeems it one-for-one through the Hashi withdrawal queue, and captures the spread, with idle capital earning lending yield between carries. It works from the first deposit, because it needs one side of the market rather than two. Sharing the same balance sheet, second, is a sealed-order batch auction that clears hBTC at a uniform price twice daily, with orders encrypted until the batch closes, so opposing flow crosses directly and never touches the queue. That one is the differentiator, but it needs a two-sided market to be worth anything, and pretending otherwise would be the easiest lie on this page.",
  },
  {
    q: "Why does the spread exist at all?",
    a: "Because exiting takes time, and the time is variable. Redemption goes through an on-chain queue that is rate-limited by the Guardian's token bucket, batched into Bitcoin transactions roughly every ten minutes, and paused entirely during Hashi reconfiguration — which follows every Sui epoch boundary. The discount at which hBTC trades against BTC is the market price of that latency. The carry harvests it; the auction lets participants avoid paying it to anyone. If the bucket is generously sized and the queue clears in minutes, there is no spread and the venue is worth little — Aphotic is closer to congestion insurance than to a bridge.",
  },
  {
    q: "Why an auction, rather than a faster route?",
    a: "Because the withdrawal queue is a public Move object. Every pending request exposes who sent it, how much, to which Bitcoin address, and since when, so a desk unwinding a position is watched forming in real time. Aphotic crosses that flow before it reaches the queue. Orders are encrypted client-side under a Seal time-lock and everything clears at one price at one instant, which does not make front-running hard — it makes it meaningless. And the cadence is mechanical, because an operator who could choose when a batch closes could advantage selected orders, which is the exact attack uniform-price clearing removes.",
  },
  {
    q: "What is hBTC, exactly?",
    a: "hBTC is custodial-threshold wrapped BTC, and we say so plainly. Your Bitcoin is held under a threshold Schnorr key split across a subset of Sui validators, in a 2-of-2 arrangement with a Guardian enclave, with a roughly 60-day Bitcoin-script recovery leaf as the escape hatch. Deposits are approved by committee attestation, not by an on-chain light client. That is a real trust assumption and Aphotic does not remove it. Our differentiation is not the token's trust model, it is what we compose out of the bridge's on-chain machinery: deterministic clearing anyone can recompute, a withdrawal limiter anyone can re-derive from Hashi's own events, and a schedule nobody can move.",
  },
  {
    q: "What can the keeper actually do?",
    a: "Trigger deterministic computation, and nothing else. It can propose a NAV — which records a number and commits nothing — attest the bridge limiter within admin-set bounds, allocate idle capital to a pinned allowlist, and place carry bids behind a value-preservation floor asserted in Move. It cannot approve a NAV, mint, burn, rotate a capability, or change a parameter, and none of its functions takes an address argument at all, so there is no parameter through which a destination could be smuggled. It is also not a gatekeeper: closing, revealing, clearing and settling are permissionless, so if the keeper is down, anyone can run the schedule.",
  },
  {
    q: "What does v1 not hide?",
    a: "More than we would like, and we would rather you heard it here. Before close, size, price and side are hidden subject to the Seal threshold — a colluding quorum of key servers could decrypt early. After close, nothing is hidden, including unfilled orders, which are exploitable in the next batch. And note spends in v1 are linkable: the Merkle path is supplied in the clear, so the leaf index names the note. Fixed denominations deliver uniformity, not unlinkability, and privacy comes from the crowd rather than from the ladder. Aphotic is not trustless. It is no less trustworthy than the venue it serves, which is the honest bar.",
  },
];

const PlusIcon = () => (
  <svg className="faq-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export default function FAQ() {
  const [openIndex, setOpenIndex] = useState(-1);

  return (
    <section className="faq-section">
      <div className="faq-inner">
        <h2 className="faq-title">FAQ</h2>
        <div className="faq-list">
          {ITEMS.map((item, i) => (
            <div key={i} className={`faq-item${openIndex === i ? " open" : ""}`}>
              <button
                className="faq-question"
                onClick={() => setOpenIndex(openIndex === i ? -1 : i)}
              >
                <PlusIcon />
                {item.q}
              </button>
              <div className="faq-content">
                <div><p>{item.a}</p></div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
