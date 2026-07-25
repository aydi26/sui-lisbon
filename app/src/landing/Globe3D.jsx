// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.4
// @phase      0
// @status     DONE
// @spec       docs/RECON.md R13 (Globe3D fetches 4 remote CDN assets at runtime →
//             vendor them; its cloud rAF loop is never cancelled → fix on port)
// @rules      G7
// @depends    globe.gl ^2.45.3 · three ^0.183.2 (split into the 'globe' chunk by
//             app/vite.config.ts so /deposit never downloads the hero)
// @facts      Ported VERBATIM from the upstream Globe3D.jsx (docs/RECON.md R13).
// @facts        Every easing/threshold/curvature constant below is byte-identical.
// @facts      VENDORED ASSETS (app/public/globe/, fetched 2026-07-25) — the hero
// @facts        must render OFFLINE at the venue, so NO remote CDN URL survives:
// @facts          /globe/earth-blue-marble.jpg            1_461_877 B
// @facts          /globe/earth-topology.png                 378_243 B
// @facts          /globe/clouds.png                       5_033_486 B
// @facts          /globe/ne_110m_admin_0_countries.geojson   488_013 B
// @facts      THEME: atmosphereColor #16c8d9 (abysse cyan). Was #6366f1 upstream.
// @facts      DO NOT TOUCH — scroll maths shared with LandingPage.jsx:
// @facts        progress   = clamp01((scrollY - vh*0.8) / (vh*2.4))
// @facts        repaint threshold |Δprogress| > 0.004
// @facts        altitude   = 0.006 + (max(0.1, sqrt(POP_EST)*7e-5) - 0.006)*progress
// @facts        capA/sideA/strokeA = progress * 0.45 / 0.12 / 0.25, toFixed(3)
// @facts        zoom       = 1 + smoothstep((progress-0.6)/0.4)*0.7
// @facts        heroEnd    = vh*3.6 ; globeFade = clamp01(1-(y-heroEnd*0.88)/(heroEnd*0.12))
// @facts        autoRotateSpeed = 0.6 + progress*2 ; cloud spin -0.006*PI/180 per frame
// @implements export default function Globe3D({ onReady })
// @forbidden  ANY remote CDN asset URL — the venue may be offline
// @forbidden  changing any easing curve, threshold or curvature constant above
// @invariant  1. The cloud-layer requestAnimationFrame loop is cancelled on
//                unmount (upstream leaked it — RECON R13).
// @invariant  2. The renderer is disposed and its WebGL context force-lost on
//                unmount, so remounting /  never accumulates contexts.
// @ac         hero renders with the network unplugged.
// @verify     cd app && npm run build   # a separate 'globe' chunk must exist
// @verify     Select-String -Path app\src\landing\* -Pattern 'https?://cdn'  # empty
// └── END CONTRACT ───────────────────────────────────────────────────────────

import React, { useEffect, useRef } from "react";
import Globe from "globe.gl";
import * as THREE from "three";

export default function Globe3D({ onReady }) {
  const containerRef = useRef(null);
  const globeRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current || globeRef.current) return;

    const el = containerRef.current;
    const world = Globe({ animateIn: false, rendererConfig: { antialias: true, alpha: true } })(el)
      .backgroundColor("rgba(0,0,0,0)")
      .showAtmosphere(true)
      .atmosphereColor("#16c8d9")
      .atmosphereAltitude(0.18)
      .globeImageUrl("/globe/earth-blue-marble.jpg")
      .bumpImageUrl("/globe/earth-topology.png")
      .polygonCapColor(() => "rgba(255, 255, 255, 0)")
      .polygonSideColor(() => "rgba(255, 255, 255, 0)")
      .polygonStrokeColor(() => "rgba(255, 255, 255, 0)")
      .polygonsTransitionDuration(0);

    world.controls().autoRotate = true;
    world.controls().autoRotateSpeed = 0.6;
    world.controls().enableZoom = false;
    world.controls().enablePan = false;
    world.controls().enableRotate = false;
    world.pointOfView({ lat: 25, lng: 0, altitude: 2.8 });

    globeRef.current = world;

    let features = [];
    let lastProgress = -1;

    // Leak fix (RECON R13): the cloud spin loop below is cancelled on unmount.
    let cloudsFrame = 0;
    let disposed = false;

    // Countries
    fetch("/globe/ne_110m_admin_0_countries.geojson")
      .then((r) => r.json())
      .then((geo) => {
        features = geo.features.filter((d) => d.properties.ISO_A2 !== "AQ");
        world.polygonsData(features);
        world.polygonAltitude(0.006);
      });

    // Clouds
    new THREE.TextureLoader().load(
      "/globe/clouds.png",
      (tex) => {
        if (disposed) return;
        const clouds = new THREE.Mesh(
          new THREE.SphereGeometry(world.getGlobeRadius() * 1.004, 75, 75),
          new THREE.MeshPhongMaterial({ map: tex, transparent: true, opacity: 0.45 })
        );
        world.scene().add(clouds);
        (function spin() {
          clouds.rotation.y -= 0.006 * Math.PI / 180;
          cloudsFrame = requestAnimationFrame(spin);
        })();
      }
    );

    // Scroll handler
    const handleScroll = () => {
      const vh = window.innerHeight;
      const y = window.scrollY;

      const progress = Math.min(1, Math.max(0, (y - vh * 0.8) / (vh * 2.4)));

      if (features.length && Math.abs(progress - lastProgress) > 0.004) {
        lastProgress = progress;

        world.polygonAltitude((feat) => {
          const pop = +feat.properties.POP_EST;
          const target = Math.max(0.1, Math.sqrt(pop) * 7e-5);
          return 0.006 + (target - 0.006) * progress;
        });

        const capA = (progress * 0.45).toFixed(3);
        const sideA = (progress * 0.12).toFixed(3);
        const strokeA = (progress * 0.25).toFixed(3);
        world.polygonCapColor(() => `rgba(220, 228, 235, ${capA})`);
        world.polygonSideColor(() => `rgba(200, 212, 225, ${sideA})`);
        world.polygonStrokeColor(() => `rgba(235, 240, 245, ${strokeA})`);
      }

      // Globe zoom
      const zoomProgress = Math.min(1, Math.max(0, (progress - 0.6) / 0.4));
      const eased = zoomProgress * zoomProgress * (3 - 2 * zoomProgress);
      const currentScale = 1 + eased * 0.7;
      const globeWrap = el.parentElement;
      if (globeWrap) {
        globeWrap.style.transform = `scale(${currentScale})`;
      }

      // Fade out globe
      const heroEnd = vh * 3.6;
      const globeFade = Math.max(0, Math.min(1, 1 - (y - heroEnd * 0.88) / (heroEnd * 0.12)));
      if (globeWrap) {
        globeWrap.style.opacity = globeFade;
      }

      world.controls().autoRotateSpeed = 0.6 + progress * 2;
    };

    window.addEventListener("scroll", handleScroll, { passive: true });

    world.onGlobeReady(() => {
      onReady?.();
    });

    return () => {
      disposed = true;
      if (cloudsFrame) cancelAnimationFrame(cloudsFrame);
      window.removeEventListener("scroll", handleScroll);
      if (world.renderer()) {
        world.renderer().dispose();
        world.renderer().forceContextLoss();
      }
      globeRef.current = null;
    };
  }, []);

  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
}
