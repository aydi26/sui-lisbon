// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F5
// @phase      5
// @status     DONE
// @spec       aphotic.md §1 (the two products), §13 (limitations are published)
// @spec       docs/DESIGN-V2.md §4 (cadence), §5ter (the parity blocker), §9, §10
// @rules      G3 G5 G6 G7 G8
// @depends    ./sections.tsx (F5) · ./docs.css (F5) · ../../config.ts (F1)
// @facts      A TWO-PANE READER: a grouped sidebar on the left, one section in the
// @facts        content pane on the right. Selecting a link swaps the pane with
// @facts        PLAIN REACT STATE — no nested router, no new dependency, no hash
// @facts        routing. /docs is one route and stays one route.
// @facts      WHY THIS PAGE EXISTS: /vault /batch and /verify were carrying the
// @facts        protocol explanation inline, which made them long. The explanation
// @facts        moved here so those screens can be about DOING. This is ADDITIVE —
// @facts        nothing was deleted from them; a later pass trims them.
// @facts      ⚠ The limitations section is an ordinary member of DOCS_SECTIONS and
// @facts        is ALSO rendered in full at the foot of every other section, so it
// @facts        is reachable in zero interactions from wherever a reader lands. It
// @facts        is never behind a toggle and never collapsed by default.
// @facts      The sidebar is ALWAYS in the DOM; under ~900px it is hidden behind
// @facts        .docs-mobile-toggle via the `hidden` attribute, and docs.css
// @facts        re-shows it unconditionally at the desktop breakpoint.
// @implements export function DocsScreen(): JSX.Element
//             export default DocsScreen
// @forbidden  a canonical id literal here — G7 (every id comes from config)
// @forbidden  a router nesting or a new dependency for the pane switch
// @forbidden  collapsing, toggling or conditionally rendering the limitations
// @invariant  1. Exactly one sidebar link carries .active at a time.
// @invariant  2. The honest-limitations content renders on every section, always.
// @invariant  3. Nothing on this route fetches: it is prose plus config reads.
// @ac         renders with no wallet, no published package and no network.
// @verify     cd app && npm run build
// @verify     cd app && npm test -- docs
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { useState } from 'react';
import { Link } from 'react-router-dom';

import { config } from '../../config';
import './docs.css';
import { DOCS_CATEGORIES, DOCS_SECTIONS, type DocsSection } from './sections';

const LIMITATIONS_ID = 'limitations';

function Subsections({ section }: { section: DocsSection }) {
  return (
    <>
      {section.subsections.map((sub) => (
        <section className="docs-subsection" key={`${section.id}:${sub.title}`}>
          <h3 className="docs-subsection-title">{sub.title}</h3>
          <ul className="docs-subsection-list">
            {sub.items.map((item, i) => (
              // The items are authored prose in a fixed order, so the index is a
              // stable key — nothing is inserted, removed or reordered at runtime.
              // eslint-disable-next-line react/no-array-index-key
              <li key={`${section.id}:${sub.title}:${i}`}>{item}</li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

function SectionBody({ section }: { section: DocsSection }) {
  return (
    <article className="docs-content" aria-labelledby={`docs-title-${section.id}`}>
      <h2 className="docs-content-title" id={`docs-title-${section.id}`}>
        {section.title}
      </h2>
      <div className="docs-content-body">
        {section.body.map((paragraph, i) => (
          // eslint-disable-next-line react/no-array-index-key
          <p key={`${section.id}:body:${i}`}>{paragraph}</p>
        ))}
      </div>
      <Subsections section={section} />
    </article>
  );
}

export function DocsScreen() {
  const [activeId, setActiveId] = useState<string>(DOCS_SECTIONS[0].id);
  const [menuOpen, setMenuOpen] = useState(false);

  const active = DOCS_SECTIONS.find((s) => s.id === activeId) ?? DOCS_SECTIONS[0];
  const limitations = DOCS_SECTIONS.find((s) => s.id === LIMITATIONS_ID);

  return (
    <div className="docs-page">
      <button
        type="button"
        className="docs-mobile-toggle"
        aria-expanded={menuOpen}
        aria-controls="docs-sidebar"
        onClick={() => setMenuOpen((open) => !open)}
      >
        <span aria-hidden="true">☰</span>
        {menuOpen ? 'Hide contents' : 'Contents'}
      </button>

      <aside className="docs-sidebar" id="docs-sidebar" hidden={!menuOpen}>
        <div className="docs-sidebar-header">Documentation</div>

        <nav className="docs-sidebar-nav" aria-label="Documentation">
          {DOCS_CATEGORIES.map((category) => (
            <div className="docs-sidebar-category" key={category}>
              <div className="docs-sidebar-category-label">{category}</div>
              <ul className="docs-sidebar-list">
                {DOCS_SECTIONS.filter((s) => s.category === category).map((section) => (
                  <li key={section.id}>
                    <button
                      type="button"
                      className={
                        section.id === active.id
                          ? 'docs-sidebar-link active'
                          : 'docs-sidebar-link'
                      }
                      aria-current={section.id === active.id ? 'true' : undefined}
                      onClick={() => {
                        setActiveId(section.id);
                        setMenuOpen(false);
                      }}
                    >
                      {section.label}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <Link className="docs-sidebar-cta" to="/verify">
          Recompute it yourself
        </Link>
      </aside>

      <main className="docs-main">
        <SectionBody section={active} />

        {/*
          The limitations are not a page you have to find. They render in full at
          the foot of every section — unconditionally, never collapsed — so the
          reader meets them wherever they landed. When the reader IS on that
          section, the pane above already is them, so this copy stands down.
        */}
        {limitations === undefined || active.id === LIMITATIONS_ID ? null : (
          <SectionBody section={limitations} />
        )}

        <p className="docs-note" style={{ fontSize: 'var(--text-xs)', margin: 0 }}>
          Every id, endpoint and scalar on this page is read from this build&rsquo;s configuration
          at render time — Sui {config.sui.network}, Bitcoin signet. Nothing is typed into the page.
        </p>
      </main>
    </div>
  );
}

export default DocsScreen;
