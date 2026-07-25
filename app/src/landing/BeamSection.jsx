// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.4
// @phase      0
// @status     DONE
// @spec       docs/RECON.md R13 (re-theme surface: "the 6 gradient pairs in
//             BeamSection.jsx"; copy surface: h2 + p + 6 logos)
// @spec       docs/GOLDEN-RULES.md G8 (the paragraph below is the honest pitch)
// @rules      G2 G7 G8
// @depends    ./AnimatedBeam.js · app/public/logos/*.svg
// @facts      Ported VERBATIM from the upstream BeamSection.jsx (docs/RECON.md R13).
// @facts      DO NOT TOUCH — beam geometry/timing:
// @facts        curvature  -75 / 0 / 75 (mirrored for the reversed right column)
// @facts        endYOffset -10 /  0 / 10
// @facts        duration   4 + i*0.3   ·  delay  i*0.4     (i = 0..5)
// @facts        init runs inside requestAnimationFrame(requestAnimationFrame(...))
// @facts          so the circles have laid out before getBoundingClientRect().
// @facts      THEME (abysse + bitcoin orange) — the 6 gradient pairs:
// @facts        cyan  #16c8d9 · #4fdcea · #7fe3ef      orange #F7931A · #ffa937
// @facts      LAYOUT: left column  = b1 b2 b3 (Sui-side assets, forward beams)
// @facts              centre       = bC (Aphotic)
// @facts              right column = b5 b6 b7 (native/underlying, reversed beams)
// @implements export default function BeamSection()
// @forbidden  any upstream brand string, or the upstream EVM logo assets, that
//             the landing gate bans (token list: docs/RECON.md R13)
// @forbidden  claiming hBTC is trustless or non-custodial — G8
// @invariant  1. Exactly 6 beams; each is destroy()ed on unmount.
// @invariant  2. Every <img> has a non-empty, accurate alt.
// @ac         the paragraph names the TradeCap-only keeper and the pinned exit (G2).
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

import React, { useEffect, useRef } from "react";
import { AnimatedBeam } from "./AnimatedBeam.js";

const APHOTIC_MARK = <img src="/logos/aphotic-mark.svg" alt="Aphotic" />;

export default function BeamSection() {
  const containerRef = useRef(null);
  const b1 = useRef(null);
  const b2 = useRef(null);
  const b3 = useRef(null);
  const b5 = useRef(null);
  const b6 = useRef(null);
  const b7 = useRef(null);
  const bC = useRef(null);
  const beamsRef = useRef([]);

  useEffect(() => {
    const init = () => {
      if (!containerRef.current || !bC.current) return;
      const center = bC.current;
      const beamConfigs = [
        { from: b1.current, curvature: -75, endYOffset: -10, gradientStart: '#16c8d9', gradientStop: '#7fe3ef' },
        { from: b2.current, curvature: 0, endYOffset: 0, gradientStart: '#F7931A', gradientStop: '#16c8d9' },
        { from: b3.current, curvature: 75, endYOffset: 10, gradientStart: '#16c8d9', gradientStop: '#7fe3ef' },
        { from: b5.current, curvature: -75, endYOffset: -10, reverse: true, gradientStart: '#4fdcea', gradientStop: '#7fe3ef' },
        { from: b6.current, curvature: 0, endYOffset: 0, reverse: true, gradientStart: '#F7931A', gradientStop: '#ffa937' },
        { from: b7.current, curvature: 75, endYOffset: 10, reverse: true, gradientStart: '#4fdcea', gradientStop: '#7fe3ef' },
      ];
      beamsRef.current = beamConfigs.map((b, i) =>
        new AnimatedBeam({
          container: containerRef.current,
          to: center,
          duration: 4 + i * 0.3,
          delay: i * 0.4,
          ...b,
        })
      );
    };

    requestAnimationFrame(() => requestAnimationFrame(init));

    return () => {
      beamsRef.current.forEach((b) => b.destroy());
      beamsRef.current = [];
    };
  }, []);

  return (
    <section className="beam-section">
      <div className="beam-inner">
        <div className="beam-container" ref={containerRef}>
          <div className="beam-grid">
            <div className="beam-row">
              <div className="beam-circle" ref={b1}><img src="/logos/bitcoin-btc-logo.svg" alt="hBTC" /></div>
              <div className="beam-circle" ref={b5}><img src="/logos/bitcoin-btc-logo.svg" alt="Native BTC on signet" /></div>
            </div>
            <div className="beam-row">
              <div className="beam-circle" ref={b2}><img src="/logos/usd-coin-usdc-logo.svg" alt="DBUSDC" /></div>
              <div className="beam-circle center" ref={bC}>{APHOTIC_MARK}</div>
              <div className="beam-circle" ref={b6}><img src="/logos/usd-coin-usdc-logo.svg" alt="USDC" /></div>
            </div>
            <div className="beam-row">
              <div className="beam-circle" ref={b3}><img src="/logos/sui-logo.svg" alt="SUI" /></div>
              <div className="beam-circle" ref={b7}><img src="/logos/sui-logo.svg" alt="Sui testnet" /></div>
            </div>
          </div>
        </div>
        <div className="beam-text-side">
          <h2><span className="line-1">Private Market Making,</span><br />Native Bitcoin</h2>
          <p>Aphotic is a non-custodial vault that market-makes hBTC against DBUSDC on DeepBook v3, driven by a strategy that stays Seal-encrypted end to end. Native BTC enters and leaves through Hashi, and the Bitcoin exit address is pinned on-chain in Move at deposit — so the keeper, which holds only a DeepBook TradeCap, can trade but can never take or redirect. Sui testnet, Bitcoin signet.</p>
        </div>
      </div>
    </section>
  );
}
