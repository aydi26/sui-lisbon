// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F2
// @phase      1
// @status     DONE
// @spec       aphotic.md §1 (redemption-carry vault), §6.2 (NAV: two parties),
//             §7.6 (the carry), §7.7 (NAV legs and the honest gap), §8 (fees)
// @spec       docs/DESIGN-V2.md §6 (approve_nav, the O(1) form), D2 (do not demo
//             the carry), D3 (we deployed the lending counterparty ourselves)
// @rules      G7 G8
// @depends    ../../components (F1) · ../../config.ts (F1) · ../../lib/tx.ts
// @facts      THE PRODUCT: buy hBTC at a discount on the secondary market, redeem
// @facts        it one-for-one through the Hashi withdrawal queue, capture the
// @facts        spread. Idle capital earns lending yield between carries.
// @facts      WHY THE SPREAD EXISTS: redemption goes through an on-chain queue,
// @facts        rate-limited by the Guardian's token bucket, batched roughly every
// @facts        10 minutes, and paused entirely during Hashi reconfiguration —
// @facts        which follows every Sui epoch boundary. Exit latency is therefore
// @facts        variable and partly predictable, and the discount is the market
// @facts        price of that latency.
// @facts      NAV IS TWO PARTIES, NOT TWO SCOPES: `propose_nav` (keeper, records
// @facts        only) and `approve_nav` (admin multisig, commits). The common
// @facts        production pattern separates SCOPES, so one compromised automation
// @facts        key performs both legs. Affordable here because valuation is twice
// @facts        daily and approval is a signature, not a continuous duty.
// @facts      approve_nav is O(1) BY CONSTRUCTION: it must not iterate requests,
// @facts        because object_runtime_max_num_store_entries = 1000 makes any
// @facts        per-request loop a liveness bug waiting to happen. It checks a
// @facts        digest, an age, a NAV jump bound, a clearing-vs-mid deviation and
// @facts        the native-BTC cap, then writes ONE epoch price.
// @facts      ⚠ D2 — WE DO NOT DEMO THE CARRY. 117 pools in the DeepBook registry,
// @facts        exactly one involves hBTC, and it is empty on BOTH sides:
// @facts        hBTC's `treasury::mint` is public(package) and the DBUSDC
// @facts        TreasuryCap is address-owned. There is no inventory to seed with.
// @facts      ⚠ D3 — no hBTC lending market exists on Sui testnet at all, so the
// @facts        idle-yield counterparty is one we deployed. Say so on screen.
// @facts      ⚠ A PAUSED VAULT STILL LETS HOLDERS LEAVE: request_redeem and
// @facts        claim_redeem do not assert_not_paused.
// @facts      Fees are charged on MATCHED VOLUME and REALISED CARRY, never on AUM —
// @facts        the strategy is idle most of the time by design.
// @implements export function VaultScreen(): JSX.Element
// @forbidden  a free-form amount field — the denomination ladder is the only size
//             control in this app
// @forbidden  presenting the vault position, NAV or APY as live before the reads
//             exist — every unwired panel renders <PendingCall/>
// @forbidden  a canonical id literal here — G7
// @invariant  1. No control is enabled that cannot complete.
// @invariant  2. The carry is described as designed-and-not-demoed, never as running.
// @ac         renders with no wallet and no published package.
// @ac         app/test/vault.test.tsx — the rounding twin matches Move's mul_div
//             on the dust cases, the digest twin is field-sensitive across all ten
//             signed fields, every reader refuses before the wire when unwired, and
//             the screen fires nothing on mount.
// @verify     cd app && npm run build
// @verify     cd app && npm test -- vault
// └── END CONTRACT ───────────────────────────────────────────────────────────

import {
  EpochClock,
  KeeperCapabilityBadge,
  LifecycleStepper,
  LimitationsPanel,
  type LifecycleStage,
} from '../../components';
import { config } from '../../config';
import AllocationPanel from './AllocationPanel';
import NavPanel from './NavPanel';
import PositionPanel from './PositionPanel';

/**
 * The asynchronous deposit lifecycle, ERC-7540-shaped and adapted to Move. It is
 * copy, not a read: every stage below is a property of the design, so it is
 * honest to render it before the entry points exist.
 */
const NAV_EPOCH_STAGES: readonly LifecycleStage[] = [
  {
    index: 1,
    label: 'Request',
    signal: 'Your hBTC moves into the vault’s pending-deposit balance and you hold a receipt.',
    expected: 'One checkpoint',
    timeClass: 'sui',
  },
  {
    index: 2,
    label: 'Keeper proposes a NAV',
    signal: 'propose_nav records the valuation and its digest. It commits nothing.',
    expected: 'At the next 06:00 / 18:00 UTC pass',
    timeClass: 'delay',
  },
  {
    index: 3,
    label: 'Admin multisig approves',
    signal:
      'approve_nav re-checks the digest the multisig signed, the proposal age, the NAV jump bound, the clearing-vs-mid deviation and the native-BTC cap — then writes one epoch price.',
    expected: 'A signature, not a duty cycle',
    timeClass: 'delay',
  },
  {
    index: 4,
    label: 'Claim',
    signal:
      'claim_deposit recomputes the same rounding-down mul_div per receipt, so the dust always stays with the vault and never with a claimant.',
    expected: 'One checkpoint, whenever you like',
    timeClass: 'sui',
  },
];

function CarryPanel() {
  return (
    <section className="aphotic-card">
      <h3 style={{ fontSize: 'var(--text-md)', margin: 0 }}>Where the yield comes from</h3>
      <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
        Hashi mints hBTC against a committee-managed pool of Bitcoin UTXOs. Redemption goes through
        an on-chain queue, rate-limited by the Guardian&rsquo;s token bucket, batched into Bitcoin
        transactions roughly every ten minutes, and paused entirely during Hashi reconfiguration —
        which follows every Sui epoch boundary. Exit latency is therefore variable and only partly
        predictable, and the discount at which hBTC trades against BTC is the market price of that
        latency.
      </p>
      <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
        The vault buys the claim below par, redeems it at par, and captures the spread. The entry
        hurdle is expected latency × cost of capital + gas + a margin for latency-model error, and
        the model outputs a <em>distribution</em> over wait time rather than a point estimate. The
        tail is the risk; the carry is never sized off the mean.
      </p>
      <p className="ap-reason ap-reason--warn">
        We are not demonstrating the carry, and we will not pretend otherwise. The DeepBook registry
        holds one hBTC pool and it is empty on both sides: hBTC&rsquo;s <code>treasury::mint</code>{' '}
        is <code>public(package)</code> and the quote asset&rsquo;s treasury capability is
        address-owned, so we can mint neither leg and there is no inventory to seed with. The entry
        leg is built and tested; it has no market to run against on testnet.
      </p>
      <p className="ap-reason ap-reason--warn">
        The idle-yield leg has the same shape of caveat: no hBTC lending market exists on Sui
        testnet at all, so the counterparty is one we deployed ourselves. The adapter is shaped to
        the real vault-share surface, so a mainnet adapter is a new module rather than a refactor.
      </p>
    </section>
  );
}

function NavLegsPanel() {
  return (
    <section className="aphotic-card">
      <h3 style={{ fontSize: 'var(--text-md)', margin: 0 }}>What NAV is made of</h3>
      <ul style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', paddingLeft: '1.1rem' }}>
        <li>Idle hBTC and idle quote held by the vault — read directly.</li>
        <li>Lending positions — the adapter&rsquo;s shares converted to assets.</li>
        <li>Notes in escrow — denomination × count, net of nullified.</li>
        <li>Pending Hashi withdrawals — the queue&rsquo;s own <code>btc_amount</code> fields.</li>
        <li>In-flight withdrawal transactions referencing our request ids.</li>
        <li>
          <strong>Native BTC at the redemption address — not readable by Move.</strong>
        </li>
      </ul>
      <p className="ap-reason">
        All legs are valued at par: one BTC is one hBTC, and the carry P&amp;L accrues through the
        entry discount rather than through a mark. The last leg is the honest gap — a single-chain
        vault has a fully reconstructible NAV because every input sits behind one RPC endpoint, and
        this one crosses to Bitcoin, where Sui has no light client. Attribution to that leg is
        capped at the sum of on-Sui-readable withdrawal claims that produced it. Do not present this
        NAV as fully reconstructible.
      </p>
      <p className="ap-reason">
        Fees are charged on matched volume and realised carry, never on assets under management. The
        strategy is idle most of the time by design, and an AUM fee would be a charge for waiting.
      </p>
    </section>
  );
}

export function VaultScreen() {
  return (
    <div className="ap-page">
      <header className="ap-screen-head">
        <h1>Redemption-carry vault</h1>
        <p>
          Buy the claim below par, redeem it at par through the queue, capture the spread. Shares are
          a fungible coin, not a position object, so they stay composable. Valuation runs twice
          daily and is split across two parties: the keeper proposes, an admin multisig approves.
        </p>
      </header>

      <div className="ap-grid ap-grid--2">
        <EpochClock />

        <PositionPanel />
      </div>

      <NavPanel />

      <section className="aphotic-card">
        <h3 style={{ fontSize: 'var(--text-md)', margin: 0 }}>How a deposit becomes shares</h3>
        <p className="aphotic-muted" style={{ marginTop: 0 }}>
          Four steps, two of which are somebody else&rsquo;s signature rather than a wait on a chain.
        </p>
        <LifecycleStepper stages={NAV_EPOCH_STAGES} current={1} />
      </section>

      <div className="ap-grid ap-grid--2">
        <CarryPanel />
        <NavLegsPanel />
      </div>

      <div className="ap-grid ap-grid--2">
        <KeeperCapabilityBadge />

        <AllocationPanel />
      </div>

      <LimitationsPanel
        title="What this vault does not do"
        only={['custodial', 'lending', 'nav-gap', 'calm-markets']}
      />

      <p className="aphotic-muted" style={{ fontSize: 'var(--text-xs)' }}>
        Sui {config.sui.network}. Amounts are satoshis; hBTC has {config.constants.hbtcDecimals}{' '}
        decimals.
      </p>
    </div>
  );
}

export default VaultScreen;
