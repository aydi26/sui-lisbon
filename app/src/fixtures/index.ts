// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.4
// @phase      0
// @status     DONE
// @spec       docs/APP.md §5 (demo: pre-staged vs live)
// @rules      G6 G7
// @depends    ./types.ts ./deposit.ts ./exit.ts ./bridge.ts ./transparency.ts
// @facts      In DEMO_MODE=mock the three screens render from `demoFixtures`
// @facts        ALONE — zero signet, zero RPC (docs/APP.md §7 A11).
// @implements export const demoFixtures: DemoFixtures
//             re-exports of every fixture module
// @forbidden  importing a fixture module from a screen directly — go through here
// @invariant  1. demoFixtures is frozen at module scope (deterministic renders).
// @ac         docs/APP.md §7 A11
// @verify     cd app && npx tsc --noEmit
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { bridgeFixture } from './bridge';
import { DEPOSIT_STAGES, depositFixtures, warmDeposit } from './deposit';
import { EXIT_PHASES, exitFixtures, prestagedConfirmedExit } from './exit';
import { decisionFixtures, strategyFixture } from './transparency';
import type { DemoFixtures } from './types';

export * from './types';
export { DEPOSIT_STAGES, depositFixtures, warmDeposit };
export { EXIT_PHASES, exitFixtures, prestagedConfirmedExit };
export { bridgeFixture };
export { decisionFixtures, strategyFixture };

export const demoFixtures: DemoFixtures = Object.freeze({
  deposits: depositFixtures,
  exits: exitFixtures,
  bridge: bridgeFixture,
  decisions: decisionFixtures,
  strategy: strategyFixture,
  breakerTripped: false,
});
