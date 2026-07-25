// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.4
// @phase      0
// @status     DONE
// @spec       docs/RECON.md R13 (copy surface: FAQ.jsx ITEMS, 5 Q/A)
// @spec       docs/GOLDEN-RULES.md G8 "Pitch honesty" (L44-L47, L72-L77)
// @spec       docs/GOLDEN-RULES.md G1 G2 G3 G6
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
// @invariant  1. ITEMS.length === 5 and includes the four mandated questions.
// @invariant  2. The hBTC answer states the custodial-threshold trust model plainly.
// @ac         docs/GOLDEN-RULES.md L72-L77 — the on-record honesty lines appear here.
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

import React, { useState } from "react";

const ITEMS = [
  {
    q: "What is Aphotic?",
    a: "Aphotic is a non-custodial, private market-making vault for native Bitcoin on Sui. You deposit BTC, it arrives on Sui as hBTC through the Hashi bridge, and an off-chain keeper quotes it maker-first against DBUSDC on the DeepBook v3 order book. The strategy driving those quotes stays Seal-encrypted, every decision is written to Walrus, and your Bitcoin only ever leaves to an address you pinned on-chain at deposit.",
  },
  {
    q: "What is hBTC, exactly?",
    a: "hBTC is custodial-threshold wrapped BTC, and we say so plainly. Your Bitcoin is held under a threshold Schnorr key split across a subset of Sui validators, in a 2-of-2 arrangement with a Guardian enclave, with a roughly 60-day Bitcoin-script recovery leaf as the escape hatch. That is a real trust assumption and Aphotic does not remove it. Our differentiation is not the token's trust model, it is what we compose out of the bridge's on-chain machinery: exits pinned in Move, a withdrawal limiter anyone can re-derive from Hashi's own events, and a permissionless deposit crank.",
  },
  {
    q: "What can the keeper actually do?",
    a: "It can place and cancel DeepBook orders. That is the whole list. The keeper holds only a DeepBook TradeCap, never a withdraw or deposit capability, and it never sees or supplies a Bitcoin address: exits are composed in Move directly into Hashi's request_withdrawal using the destination written once into the vault at deposit. A fully compromised keeper can lose you money by trading badly. It cannot take your funds, and it cannot send them anywhere else.",
  },
  {
    q: "How fast is a withdrawal?",
    a: "The Sui side is instant. hBTC is an ordinary fungible coin, so redeeming shares and moving balances settles in one checkpoint, sub-second. The native-BTC leg is the slow part: roughly 1.5 to 2 hours from request to a confirmed signet transaction, because it goes through Hashi's committee signing and Bitcoin confirmations. Nobody can shorten that, including us. Hashi's global withdrawal queue rejects over-capacity batches rather than ordering them, so there is no priority to buy. What Aphotic does instead is ration its own egress and keep a redemption buffer, and it shows you the bridge congestion it is reacting to.",
  },
  {
    q: "Is it live?",
    a: "Aphotic runs on Sui testnet with the Bitcoin side on signet. The Move package, the DeepBook hBTC/DBUSDC book and the Hashi bridge are all real and on-chain. The native-BTC legs are pre-staged for demos for the timing reasons above, and anything you see that is pre-staged is labelled as pre-staged.",
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
