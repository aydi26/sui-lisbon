// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.4
// @phase      0
// @status     DONE
// @spec       docs/RECON.md R13 (landing-page port: source, deps, the ONE EVM
//             coupling, the 3-card CSS constraint, the re-theme surface)
// @spec       docs/GOLDEN-RULES.md G8 (every copy string on this page)
// @rules      G7 G8
// @depends    ./Globe3D.jsx · ./BeamSection.jsx · ./HorizontalScroll.jsx
//             ./FAQ.jsx · ./stats.js · ./LandingPage.css
// @facts      There is NO contact form and NO email address anywhere on this page,
// @facts        by explicit product decision. The second CTA routes to /verify
// @facts        instead. ContactModal.jsx is deleted — do not reintroduce it or
// @facts        any mailto: link.
// @facts      ⚠ The route targets here MUST match src/routes.tsx: "/vault" for the
// @facts        primary CTA, "/verify" for the secondary. A stale target does not
// @facts        404 — the catch-all bounces it back to "/", which during a demo
// @facts        looks like a button that does nothing.
// @facts      Ported VERBATIM from the upstream landing page (docs/RECON.md R13
// @facts        names the repo + path; never re-derive it here).
// @facts        Every timing constant, scroll formula and NumberFlow config is
// @facts        byte-identical to upstream. Only copy, theme and the three
// @facts        pre-declared code changes differ.
// @facts      Scroll fade formula (DO NOT TOUCH — shared with Globe3D.jsx):
// @facts        progress = clamp01((scrollY - vh*0.8) / (vh*2.4))
// @facts        fade     = max(0, 1 - progress/0.55)
// @facts      NumberFlow timing (DO NOT TOUCH): duration 1600,
// @facts        easing cubic-bezier(0.16, 1, 0.3, 1), for BOTH transform + spin.
// @facts      Loader fallback: 5000 ms. Stats reveal: 400 ms after globe-ready.
// @facts      Stats poll interval: 30_000 ms.
// @facts      ⚠ This file is .jsx ON PURPOSE — src/landing is excluded from
// @facts        tsconfig so the port stays byte-comparable with upstream.
// @implements export default function LandingPage({ onConnect, connecting, refreshKey })
// @forbidden  ANY upstream brand/chain/standard string surviving the port. The
//             exact token list is in the landing gate (docs/RECON.md R13); it is
//             deliberately NOT spelled out here so the gate greps clean.
// @forbidden  claiming hBTC is trustless or non-custodial — G8
// @forbidden  a canonical id literal here — G7 (ids arrive via ./stats.js → ../config)
// @forbidden  importing the upstream EVM-only aggregate reader — ./stats.js replaced it
// @invariant  1. readAggregateStats() never throws, so the hero always renders.
// @invariant  2. The left counter is LABELLED as the bridge's circulating hBTC —
//                it is Hashi's number, and must never read as Aphotic's AUM (G8).
// @invariant  3. onConnect defaults to navigating to /vault (react-router).
// @ac         docs/APP.md §7 A11 — renders in mock mode with zero signet/RPC.
// @verify     cd app && npm run build
// @verify     the landing brand gate (docs/RECON.md R13 token list) over
//             app\src\landing\* must return NOTHING
// └── END CONTRACT ───────────────────────────────────────────────────────────

import React, { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import NumberFlow from "@number-flow/react";
import Globe3D from "./Globe3D.jsx";
import BeamSection from "./BeamSection.jsx";
import HorizontalScroll from "./HorizontalScroll.jsx";
import FAQ from "./FAQ.jsx";
import { readAggregateStats } from "./stats.js";
import "./LandingPage.css";

/**
 * All three props are OPTIONAL — src/routes.tsx renders `<LandingPage />` bare.
 * The JSDoc below is load-bearing: tsc pulls this .jsx in through that import
 * (tsconfig `exclude` drops it from the program ROOTS, not from resolution), so
 * without it the inferred prop type is required and `npm run build` fails.
 *
 * @param {Object} [props]
 * @param {() => void} [props.onConnect] Overrides the default navigate("/deposit").
 * @param {boolean} [props.connecting]   Renders the button's "Connecting..." state.
 * @param {unknown} [props.refreshKey]   Change it to force a stats re-read.
 */
export default function LandingPage({ onConnect, connecting = false, refreshKey } = {}) {
  const navigate = useNavigate();
  const [loaderVisible, setLoaderVisible] = useState(true);
  const [statsReady, setStatsReady] = useState(false);
  const [circulating, setCirculating] = useState(0);
  const [minutes, setMinutes] = useState(0);
  const [statsOk, setStatsOk] = useState(true);
  const statsRef = useRef(null);

  // "Enter the vault" — the landing page has no wallet step of its own; it hands
  // off to the vault screen, which owns the session and the deposit request.
  const handleEnter = useCallback(() => {
    if (onConnect) {
      onConnect();
      return;
    }
    navigate("/vault");
  }, [onConnect, navigate]);

  const handleGlobeReady = useCallback(() => {
    setLoaderVisible(false);
    setTimeout(() => setStatsReady(true), 400);
  }, []);

  // Fallback: hide loader after 5s even if globe fails to load
  useEffect(() => {
    const timeout = setTimeout(() => {
      setLoaderVisible(false);
      setStatsReady(true);
    }, 5000);
    return () => clearTimeout(timeout);
  }, []);

  // Aggregate counters — read wallet-free over the Sui gRPC v2 fullnode so the
  // landing page shows live numbers BEFORE the user enters the vault. Never
  // throws: on any failure both counters stay at 0. Re-polls every 30s so demo
  // activity is visible.
  useEffect(() => {
    let cancelled = false;
    const fetchStats = async () => {
      const { circulating: c, minutesToClearing: m, ok } = await readAggregateStats();
      if (cancelled) return;
      setCirculating(c);
      setMinutes(m);
      setStatsOk(ok);
    };
    fetchStats();
    const interval = setInterval(fetchStats, 30_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [refreshKey]);

  // Fade stats with scroll
  useEffect(() => {
    const handleScroll = () => {
      if (!statsRef.current) return;
      const vh = window.innerHeight;
      const y = window.scrollY;
      const progress = Math.min(1, Math.max(0, (y - vh * 0.8) / (vh * 2.4)));
      const fade = Math.max(0, 1 - progress / 0.55);
      statsRef.current.style.opacity = fade;
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <div className="landing">
      <div className={`loader${loaderVisible ? "" : " hide"}`} />

      <section className="hero">
        <div className="globe-wrap">
          <Globe3D onReady={handleGlobeReady} />
        </div>
      </section>

      <nav className="landing-nav">
        <div className="nav-logo"><img src="/logos/aphotic-mark.svg" alt="Aphotic" className="nav-logo-img" /> APHOTIC</div>
        <button className="nav-btn" onClick={handleEnter} disabled={connecting}>
          {connecting ? "Connecting..." : "Enter the vault"}
        </button>
      </nav>

      <div className={`stats-row${statsReady ? " ready" : ""}`} ref={statsRef}>
        <div className="stat-block">
          <div className="stat-label">
            {statsOk ? "hBTC in circulation · sats" : "hBTC in circulation · read unavailable"}
          </div>
          <div className="stat-value">
            <span className="dollar">₿</span>
            <NumberFlow
              value={circulating}
              format={{ useGrouping: true, maximumFractionDigits: 0 }}
              locales="en-US"
              transformTiming={{ duration: 1600, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }}
              spinTiming={{ duration: 1600, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }}
            />
          </div>
        </div>
        <div className="stat-block">
          <div className="stat-label">Minutes to next clearing</div>
          <div className="stat-value">
            <span className="dollar"></span>
            <NumberFlow
              value={minutes}
              format={{ useGrouping: true, maximumFractionDigits: 0 }}
              locales="en-US"
              transformTiming={{ duration: 1600, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }}
              spinTiming={{ duration: 1600, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }}
            />
          </div>
        </div>
      </div>

      <BeamSection />
      <HorizontalScroll />

      <section className="cta-section">
        <h2>Bitcoin, Working Quietly</h2>
        <p>Two things sharing one balance sheet: a vault that buys the redemption claim below par and redeems it at par, and a sealed-order auction that clears hBTC at one uniform price twice a day. Sui testnet · Bitcoin signet.</p>
        <div className="cta-buttons">
          <button className="gradient-btn" onClick={handleEnter} disabled={connecting}>
            {connecting ? "Connecting..." : "Enter the vault"}
          </button>
          <button className="ghost-btn" onClick={() => navigate("/verify")}>
            Recompute it yourself
          </button>
        </div>
      </section>

      <FAQ />

      <section className="footer-title">
        <div className="footer-title-inner">
          <div className="big-title">APHOTIC</div>
        </div>
      </section>
    </div>
  );
}
