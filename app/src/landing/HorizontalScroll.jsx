// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F1
// @phase      0
// @status     DONE
// @spec       docs/RECON.md R13 (hardcoded to EXACTLY 3 cards; the count is baked
//             into CSS as .hscroll-section{height:300vh} / .hscroll-track{width:300vw})
// @spec       aphotic.md §1 (the two products), §4.2 (the leak), §2 constraint 5
// @rules      G2 G5 G7 G8
// @depends    ./LandingPage.css (.hscroll-*) · app/public/logos/*.svg
// @facts      Ported VERBATIM from the upstream HorizontalScroll.jsx (RECON R13).
// @facts      ⚠⚠ EXACTLY 3 CARDS. Adding a 4th silently desynchronises the scroll:
// @facts        .hscroll-section height 300vh and .hscroll-track width 300vw are
// @facts        hardcoded in LandingPage.css. Change all three together or not at all.
// @facts      DO NOT TOUCH — scroll maths:
// @facts        progress   = clamp01(-rect.top / (section.offsetHeight - vh))
// @facts        translateX = -progress * (numCards - 1) * 100  [vw]
// @facts        segLen     = 1 / numCards
// @facts        local      = clamp(-0.5, 1.5, (progress - segStart) / segLen)
// @facts        titleX     = 600 - local * 1200  [px]
// @facts      THEME: panel gradients p1/p2/p3 live in LandingPage.css; the padlock
// @facts        stroke is #16c8d9 (was #6366f1 upstream).
// @implements export default function HorizontalScroll()
// @forbidden  a 4th card without editing .hscroll-section/.hscroll-track together
// @forbidden  claiming hBTC is trustless or non-custodial — G8
// @invariant  1. CARDS.length === 3 — carry / sealed auction / verify.
// @invariant  2. Card 2 names the PUBLIC withdrawal queue as the leak being routed
//                around, and says uniform-price clearing makes front-running
//                meaningless rather than merely hard.
// @invariant  3. Card 3 states the limiter is RE-DERIVED from Hashi's own events,
//                never read from a trusted SDK call (G5).
// @ac         three panels scroll horizontally across 300vh of vertical scroll.
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

import React, { useEffect, useRef } from "react";

const CARDS = [
  {
    title: "CARRY",
    counter: "01 / 03",
    className: "p1",
    text: "Redemption through the bridge is queued, rate-limited and paused during every reconfiguration, so hBTC trades below par. That discount is the market price of the wait. The vault buys the claim below par, redeems it one-for-one, and captures the spread — while idle capital earns lending yield between carries. Valuation is split across two parties: the keeper proposes a NAV, an admin multisig approves it.",
    icon: <img src="/logos/aphotic-mark.svg" alt="Aphotic" />,
  },
  {
    title: "SEALED",
    counter: "02 / 03",
    className: "p2",
    text: "The withdrawal queue is a public Move object: every pending request shows who, how much, where to, and since when. A desk unwinding is watched forming in real time. Aphotic crosses that flow before it reaches the queue — orders encrypted client-side under a Seal time-lock, cleared at one uniform price at 06:00 and 18:00 UTC. Front-running is not made hard, it is made meaningless.",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="#16c8d9" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="65%" height="65%">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0110 0v4" />
      </svg>
    ),
  },
  {
    title: "VERIFY",
    counter: "03 / 03",
    className: "p3",
    text: "Same order set, same price, always. Clearing runs on-chain in Move with every tie broken, so anyone can recompute it and compare byte-for-byte — a divergence between implementations is a release blocker, not a warning. Fills are provable against a published Merkle root, and the bridge's own rate limiter is re-derived from its event stream rather than taken on faith.",
    icon: <img src="/logos/globe.svg" alt="" />,
  },
];

export default function HorizontalScroll() {
  const sectionRef = useRef(null);
  const trackRef = useRef(null);
  const titlesRef = useRef([]);

  useEffect(() => {
    const section = sectionRef.current;
    const track = trackRef.current;
    if (!section || !track) return;

    const numCards = track.children.length;

    const tick = () => {
      const rect = section.getBoundingClientRect();
      const vh = window.innerHeight;
      const totalScroll = section.offsetHeight - vh;
      let progress = -rect.top / totalScroll;
      progress = Math.max(0, Math.min(1, progress));

      const translateX = -progress * (numCards - 1) * 100;
      track.style.transform = `translateX(${translateX}vw)`;

      const segLen = 1 / numCards;
      titlesRef.current.forEach((title, i) => {
        if (!title) return;
        const segStart = i * segLen;
        const segEnd = (i + 1) * segLen;
        let local = (progress - segStart) / (segEnd - segStart);
        local = Math.max(-0.5, Math.min(1.5, local));
        const x = 600 - local * 1200;
        title.style.transform = `translateX(${x}px)`;
      });
    };

    window.addEventListener("scroll", tick, { passive: true });
    window.addEventListener("resize", tick);
    tick();

    return () => {
      window.removeEventListener("scroll", tick);
      window.removeEventListener("resize", tick);
    };
  }, []);

  return (
    <section className="hscroll-section" ref={sectionRef}>
      <div className="hscroll-sticky">
        <ul className="hscroll-track" ref={trackRef}>
          {CARDS.map((card, i) => (
            <li key={i} className={`hscroll-panel ${card.className}`}>
              <h2
                className="hscroll-bigtitle"
                ref={(el) => (titlesRef.current[i] = el)}
              >
                {card.title}
              </h2>
              <div className="hscroll-counter">{card.counter}</div>
              <div className="hscroll-content">
                <div className="hscroll-content-text">
                  <p>{card.text}</p>
                </div>
                <div className="hscroll-content-icon">{card.icon}</div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
