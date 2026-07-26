# Documentation index

Start with [`SUBMISSION.md`](SUBMISSION.md) if you are evaluating this, or
[`DEMO.md`](DEMO.md) if you are about to present it.

## For a reader

| Document | What it answers |
|---|---|
| [`SUBMISSION.md`](SUBMISSION.md) | The problem, the mechanism, what is deployed, what is independently verifiable, and the limitations. |
| [`DEMO.md`](DEMO.md) | The runbook. Pre-flight, the minute-by-minute script with exact commands, the **live-vs-pre-staged boundary**, and the fallback. |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Component map, object and capability graph, the flows, the trust boundaries. |
| [`GOVERNANCE.md`](GOVERNANCE.md) | Who holds what, the two-party NAV split, and the deviations of record. |

## For someone verifying a claim

| Document | What it answers |
|---|---|
| [`DEPLOYED.md`](DEPLOYED.md) | **Every published id and transaction digest.** Append-only — a row is never overwritten, so an old journal entry stays resolvable against the ids it was written with. |
| [`RECON.md`](RECON.md) | **Verified ground truth** from live reconnaissance: Hashi's Move surface, the limiter algorithm, event names, DeepBook reality, Pyth, transport. Never re-derived; where another document disagrees, this one wins. |
| [`FACTS.md`](FACTS.md) | The canonical values — ids, coin types, signatures, ceilings, cadence constants, the denomination ladder. |
| [`DESIGN-V2.md`](DESIGN-V2.md) | The reconciliation record. Includes **§5ter and §5quater**, which document a parity failure between the Move implementation and the specification — found by a third implementation written to check it. Read those before trusting any cross-implementation claim. |
| [`LIMITS.md`](LIMITS.md) | The measured on-chain ceilings, and what is reasoned rather than measured. |

## For someone changing the code

| Document | What it answers |
|---|---|
| [`CONVENTIONS.md`](CONVENTIONS.md) | The APHOTIC CONTRACT banner every source file carries, and the invariant gates. |
| [`MOVE-PACKAGE.md`](MOVE-PACKAGE.md) | The Move package, module by module. Where this and the shipped code disagree, **the code and its tests win** and this file is what needs correcting. |
| [`DEPLOY.md`](DEPLOY.md) | Shipping the front-end. The `VITE_*` build-time inlining trap, and the `cleanUrls` landmine that 404s every deep link. |
| [`STATUS.md`](STATUS.md) | The per-task ledger: what is done, what is blocked, and the run log. |

## Archive

[`archive/`](archive/) holds documents from **before the pivot**, when this was a
private market-making vault rather than a redemption-carry vault plus a sealed-order
auction. They are kept because they are the evidence behind resolved unknowns, not
because they describe the current product. Do not follow them.
