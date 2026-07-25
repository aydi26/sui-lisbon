// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.5
// @phase      0  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/KEEPER.md §2 (THE adapter), §10 step 2 (HASHI_ADAPTER selects the impl)
// @spec       docs/BUILD-PLAN.md#phase-0 (T0.5)
// @rules      G5 G7
// @depends    ./adapter.ts · ./mock.ts · ./real.ts · ./limiter.ts · ./types.ts ·
//             ./normalize.ts · ./eventTypes.ts · ../config.ts
// @facts      HASHI_ADAPTER = mock | real. Default `mock` in dev/test/CI (G7).
// @facts      The MOCK and `verify/` MUST import the SAME `projectCapacity` from ./limiter.ts (G5).
// @implements export function createHashiAdapter(cfg: Config, overrides?): HashiAdapter
// @implements export * from './adapter.js' | './limiter.js' | './types.js' |
//             './normalize.js' | './eventTypes.js' | './mock.js' | './real.js'
// @forbidden  importing '@mysten/hashi' anywhere but ./real.ts (G7)
// @invariant  1. Selecting the adapter is the ONLY place the two implementations meet.
// @verify     npm test -- hashi.mock
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { Config } from '../config.js';

import type { HashiAdapter } from './adapter.js';
import { createMockHashiAdapter, type MockOptions } from './mock.js';
import { createRealHashiAdapter } from './real.js';

export * from './adapter.js';
export * from './eventTypes.js';
export * from './limiter.js';
export * from './mock.js';
export * from './normalize.js';
export * from './real.js';
export * from './types.js';

/** Build the adapter selected by `HASHI_ADAPTER`. `mockOptions` is ignored in `real` mode. */
export function createHashiAdapter(cfg: Config, mockOptions: Partial<MockOptions> = {}): HashiAdapter {
  return cfg.hashi.adapter === 'real' ? createRealHashiAdapter(cfg) : createMockHashiAdapter(cfg, mockOptions);
}
