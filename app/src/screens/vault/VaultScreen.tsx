// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F2
// @phase      1
// @status     DONE
// @spec       aphotic.md §1 (redemption-carry vault), §6.2 (NAV: two parties),
//             §7.6 (the carry), §7.7 (NAV legs and the honest gap), §8 (fees)
// @spec       docs/DESIGN-V2.md §6 (approve_nav, the O(1) form), D2 (do not demo
//             the carry), D3 (we deployed the lending counterparty ourselves)
// @rules      G7 G8
// @depends    ../../components (F1) · ../../config.ts (F1) · ../../screens/docs (F5)
// @facts      THIS SCREEN IS ABOUT DOING. /docs owns the teaching: since it landed,
// @facts        every paragraph here that explained the PROTOCOL rather than the
// @facts        CONTROL in front of the reader has been cut, and what is left is a
// @facts        caption plus a link. Four surfaces, in the order a holder needs
// @facts        them: position → the one request control → NAV → limitations.
// @facts      WHAT SURVIVED, AND WHY CUTTING IT WOULD BE DISHONEST:
// @facts        · the entry control says REQUEST, never Deposit or Redeem — funds
// @facts          enter, but no share exists until the epoch is priced;
// @facts        · the NAV panel stays itemised, with the native-BTC leg greyed,
// @facts          badged "not verifiable by Move" and printed with its cap;
// @facts        · D2 — WE DO NOT DEMO THE CARRY. 117 pools in the DeepBook registry,
// @facts          exactly one involves hBTC, and it is empty on BOTH sides: hBTC's
// @facts          `treasury::mint` is public(package) and the DBUSDC TreasuryCap is
// @facts          address-owned. There is no inventory to seed with;
// @facts        · D3 — no hBTC lending market exists on Sui testnet at all, so the
// @facts          idle-yield counterparty is one we deployed (AllocationPanel);
// @facts        · LimitationsPanel, custodial first, on every render.
// @facts      WHAT LEFT, AND WHERE IT WENT: the carry explainer, the NAV-legs
// @facts        explainer, the four-stage lifecycle stepper and the keeper
// @facts        capability essay are all /docs sections now. The clearing countdown
// @facts        was a duplicate — App.tsx renders it inline in the shell nav.
// @facts      NAV IS TWO PARTIES, NOT TWO SCOPES: `propose_nav` (keeper, records
// @facts        only) and `approve_nav` (admin multisig, commits).
// @facts      Fees are charged on MATCHED VOLUME and REALISED CARRY, never on AUM.
// @implements export function VaultScreen(): JSX.Element
// @forbidden  a free-form amount field — the denomination ladder is the only size
//             control in this app
// @forbidden  presenting the vault position, NAV or APY as live before the reads
//             exist — every unwired panel renders <PendingCall/>
// @forbidden  a canonical id literal here — G7
// @forbidden  re-importing a /docs explanation back onto this screen
// @invariant  1. No control is enabled that cannot complete.
// @invariant  2. The carry is described as designed-and-not-demoed, never as running.
// @invariant  3. A panel is readable in five seconds: number, label, one caption.
// @ac         renders with no wallet and no published package.
// @ac         app/test/vault.test.tsx — the rounding twin matches Move's mul_div
//             on the dust cases, the digest twin is field-sensitive across all ten
//             signed fields, every reader refuses before the wire when unwired, and
//             the screen fires nothing on mount.
// @verify     cd app && npm run build
// @verify     cd app && npm test -- vault
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { Link } from 'react-router-dom';

import { LimitationsPanel } from '../../components';
import { config } from '../../config';
import AllocationPanel from './AllocationPanel';
import NavPanel from './NavPanel';
import PositionPanel from './PositionPanel';

export function VaultScreen() {
  return (
    <div className="ap-page">
      <header className="ap-screen-head">
        <h1>Redemption-carry vault</h1>
        <p>
          Buy the claim below par, redeem it at par through the queue, keep the spread. You{' '}
          <strong>request</strong>; the epoch prices at 06:00 and 18:00 UTC — the keeper runs{' '}
          <code>propose_nav</code>, an admin multisig runs <code>approve_nav</code> — and then you
          claim. <Link to="/docs">Why the spread exists →</Link>
        </p>
      </header>

      <p className="ap-reason ap-reason--warn">
        We are not demonstrating the carry. The one hBTC pool on testnet is empty on both sides and
        neither asset can be minted, so the entry leg is built and tested with no market to run
        against.
      </p>

      <PositionPanel />

      <NavPanel />

      <AllocationPanel />

      <LimitationsPanel
        title="What this vault does not do"
        only={['custodial', 'lending', 'nav-gap', 'calm-markets']}
      />

      <p className="aphotic-muted" style={{ fontSize: 'var(--text-xs)' }}>
        Sui {config.sui.network}. Amounts are satoshis; hBTC has {config.constants.hbtcDecimals}{' '}
        decimals. Fees are charged on matched volume and realised carry, never on AUM.
      </p>
    </div>
  );
}

export default VaultScreen;
