// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T3.1, T3.3
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/APP.md §2 (Screen 1 — Deposit, L56-L106)
// @spec       docs/APP.md ERRATA E-A3 (sponsor pays, depositor sends) · E-A5 (derivation)
// @spec       docs/BUILD-PLAN.md Phase 3 T3.1/T3.3
// @spec       docs/RECON.md R6 (live Hashi config), R7 (deposit/confirm_deposit)
// @rules      G1 G2 G6 G7 G8
// @depends    ../../components (T0.4) · ../../components/ZkLoginButton.tsx (T3.3)
//             ../../fixtures (T0.4) · ../../config.ts (T0.4) · ../../lib/format.ts
//             ./useDepositAddress.ts (T3.1) · ./depositAddress.ts (T3.1) · ./deposit.css
//             keeper/src/execution/sweep.ts (T2.4) · keeper/src/execution/crank.ts (T2.3)
// @facts      bitcoin_deposit_minimum = 30_000 sats · dust floor 546 sats
// @facts      bitcoin_confirmation_threshold = 6
// @facts      bitcoin_deposit_time_delay_ms = 600_000
// @facts      Six stages; 1-4 are Bitcoin/slow (~70 min total), 5-6 are Sui-instant.
// @facts      ⚠ entry fun hashi::deposit::confirm_deposit(hashi, request_id, clock,
// @facts        ctx) is PERMISSIONLESS — our keeper cranks it for EVERYONE, not
// @facts        only for our depositors. That is a demo asset. (RECON R7)
// @facts      ⚠ Do NOT call hashi deposit registration from the app — the
// @facts        `deposit({signer, txid, utxos, recipient})` path lives in the
// @facts        keeper. The app's role is derive-address + observe + surface-sweep.
// @facts      ⚠ The lifecycle here is FIXTURE-DRIVEN and labelled as pre-staged.
// @facts        `@mysten/hashi@0.6.0` has no view.depositStatus / waitForDeposit —
// @facts        those calls in docs/APP.md §2.3 do not exist (ERRATA E-A4). Live
// @facts        lifecycle reads arrive with the keeper's adapter; until then the
// @facts        screen shows pre-staged state and SAYS SO, which is what G6 wants
// @facts        anyway.
// @facts      DEPOSIT ADDRESS IS REAL MONEY. There is no mock derivation: signed
// @facts        out we show the fixture address dimmed and labelled; signed in we
// @facts        derive from the live on-chain keys or we show an error. Never a
// @facts        plausible-looking substitute.
// @external   generateDepositAddress({ mpcMasterCompressed, guardianBtcXOnly,
//                                      suiAddress, network })  // FOUR args, E-A5
// @implements export function DepositScreen(): JSX.Element
// @forbidden  a server round-trip for address derivation — A1 intercepts network
// @forbidden  presenting the ~70-min BTC path as fast — G1/G6, A3
// @forbidden  a canonical id literal in this file — G7, A10
// @forbidden  claiming hBTC is trustless or non-custodial — G8
// @invariant  1. <LifecycleStepper/> renders exactly six stages with their time
//                classes (A2).
//             2. <DepositRealityBanner/> copy is always present (A3).
//             3. In DEMO_MODE=mock nothing here touches signet or RPC (A11) — the
//                only network call is gated behind a signed-in session, which is
//                itself gated behind a user click.
//             4. The exit destination is described as pinned on-chain at deposit
//                and immutable; nothing on this screen can set or change it (G2).
// @ac         docs/APP.md §7 A1 A2 A3 A8 A10 A11
// @verify     cd app && npx tsc --noEmit
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { ReactNode } from 'react';

import { AddressPill, LifecycleStepper, QrCode } from '../../components';
import { SponsorshipNote, ZkLoginButton } from '../../components/ZkLoginButton';
import { config, isMock, missingLiveConfig } from '../../config';
import { DEPOSIT_STAGES, depositFixtures, warmDeposit } from '../../fixtures';
import { formatBtc, formatSats, truncateMiddle } from '../../lib/format';
import { suiTxUrl } from '../../lib/explorer';
import { useAphoticSession } from '../../session/useSession';

import { bip21 } from '../../hashi/depositAddress';
import { useDepositAddress } from './useDepositAddress';
import { DepositHbtcPanel } from './DepositHbtcPanel';
import { SignetArrivals } from './SignetArrivals';

import './deposit.css';

/** GR1/GR6 copy. Never softened. */
function DepositRealityBanner() {
  return (
    <div className="dep-banner" role="note">
      <span className="dep-banner-title">The Bitcoin side takes about 70 minutes</span>
      <p>
        Six signet confirmations, a committee approval and a fixed 10-minute delay. That leg is
        pre-staged for the demo — it is not something a three-minute walkthrough can wait on.
        Everything after it — the permissionless <code>confirm_deposit</code> crank and the
        sponsored sweep into shares — settles on Sui in one checkpoint.
      </p>
    </div>
  );
}

/** Honest degradation: live mode with day-one blanks still unfilled. */
function LiveConfigBanner() {
  const missing = missingLiveConfig();
  if (isMock() || missing.length === 0) return null;
  return (
    <div className="dep-banner dep-banner-config" role="note">
      <span className="dep-banner-title">Live mode, incomplete configuration</span>
      <p>
        These environment values are still empty, so anything depending on them is inert:{' '}
        <span className="aphotic-mono">{missing.join(', ')}</span>.
      </p>
    </div>
  );
}

function StepHead({ num, title, note }: { num: string; title: string; note?: string }) {
  return (
    <div className="dep-step-head">
      <span className="dep-step-num">{num}</span>
      <span className="dep-step-title">{title}</span>
      {note ? <span className="dep-step-note">{note}</span> : null}
    </div>
  );
}

/** The address panel — every state it can legitimately be in. */
function DepositAddressCard() {
  const { status } = useAphoticSession();
  const { address, uri, isLoading, error, selfCheck, provenance, suiAddress, retry } =
    useDepositAddress();

  const minimum = config.hashi.depositMinSats;

  let body: ReactNode;

  if (!selfCheck.ok) {
    // The SDK's derivation no longer reproduces the golden vector. Showing an
    // address here could cost a user their BTC permanently.
    body = (
      <div className="dep-state dep-state-error" role="alert">
        <span className="dep-state-title">Derivation self-check failed</span>
        <p className="dep-state-body">
          The bundled Hashi SDK no longer reproduces the known-good deposit address for our test
          vector ({selfCheck.detail}). No address is shown: Bitcoin sent to a wrong address cannot
          be recovered.
        </p>
      </div>
    );
  } else if (suiAddress === null) {
    body = (
      <>
        <QrCode value={bip21(warmDeposit.depositAddress)} placeholder alt="Pre-staged demo deposit address" />
        <p className="dep-address-caption">
          {status === 'unconfigured'
            ? 'Pre-staged demo address. Your own address is derived from your Sui address once zkLogin is available.'
            : 'Pre-staged demo address. Sign in and yours is derived in this browser, offline.'}
        </p>
      </>
    );
  } else if (isLoading) {
    body = (
      <div className="dep-state">
        <span className="dep-state-title">Reading the bridge keys…</span>
        <p className="dep-state-body">
          Fetching the committee MPC master key and the guardian key from the Hashi shared object.
          The derivation itself then runs offline, in this browser.
        </p>
      </div>
    );
  } else if (error !== null) {
    body = (
      <div className="dep-state dep-state-error" role="alert">
        <span className="dep-state-title">Could not derive your address</span>
        <p className="dep-state-body">{error}</p>
        <p className="dep-state-body">
          Your address depends on two public keys held on-chain. We will not substitute a fallback
          key — that would produce a real-looking address whose coins nobody can spend.
        </p>
        <button type="button" className="dep-retry" onClick={retry}>
          Try again
        </button>
      </div>
    );
  } else if (address !== null && uri !== null) {
    body = (
      <>
        <QrCode value={uri} alt={`Bitcoin deposit address ${address}`} />
        <div className="dep-address-full">
          <AddressPill
            label="Your signet deposit address (P2TR, derived in your browser)"
            value={address}
            truncate={false}
          />
        </div>
        <p className="dep-address-caption">
          The QR encodes <span className="aphotic-mono">{bip21('…')}</span> so a wallet opens
          straight to a send screen. Scan it or copy the address above — they are the same
          destination.
        </p>
      </>
    );
  } else {
    body = (
      <div className="dep-state">
        <span className="dep-state-title">No address yet</span>
        <p className="dep-state-body">Sign in to derive your personal deposit address.</p>
      </div>
    );
  }

  return (
    <section className="aphotic-card dep-step">
      <StepHead num="02" title="Send BTC to your address" note="signet" />

      <div className="dep-address">
        {body}

        {/* A public read of a public chain — where the BTC actually is, on demand. */}
        <SignetArrivals address={address} />

        <div className="dep-minimum">
          <span className="dep-minimum-value">{formatSats(minimum)}</span>
          <p className="dep-minimum-note">
            Minimum deposit ({formatBtc(minimum)}). Hashi&apos;s on-chain{' '}
            <code>bitcoin_deposit_minimum</code> rejects anything smaller — it will not be credited
            and it will not mint. Bitcoin&apos;s own dust floor is{' '}
            {formatSats(config.constants.dustFloorSats)}.
          </p>
        </div>

        <details className="dep-proof">
          <summary>How this address was derived</summary>
          <div className="dep-proof-body">
            <span className={selfCheck.ok ? 'dep-check' : 'dep-check dep-check-bad'}>
              {selfCheck.ok ? '✓ derivation self-check passed' : '✕ derivation self-check failed'}
            </span>
            <p className="dep-state-body" style={{ maxWidth: 'none', textAlign: 'left' }}>
              The address is a 2-of-2 taproot output — guardian key plus a child key derived from
              the committee&apos;s MPC master key and your Sui address — with a long-dated recovery
              leaf. Both public keys are read from the Hashi shared object; the taproot construction
              and the bech32m encoding run entirely in this tab. Before deriving anything we replay a
              recorded known-answer vector through the same code path, so an SDK upgrade cannot
              silently change where your BTC goes.
            </p>
            {provenance !== null ? (
              <>
                <dl className="dep-kv">
                  <dt>Hashi object</dt>
                  <dd className="aphotic-mono">{truncateMiddle(provenance.objectId, 10)}</dd>
                </dl>
                <dl className="dep-kv">
                  <dt>MPC master key (SEC1)</dt>
                  <dd className="aphotic-mono">{truncateMiddle(provenance.mpcSec1Hex, 10)}</dd>
                </dl>
                <dl className="dep-kv">
                  <dt>Guardian key (x-only)</dt>
                  <dd className="aphotic-mono">{truncateMiddle(provenance.guardianHex, 10)}</dd>
                </dl>
              </>
            ) : null}
          </div>
        </details>
      </div>
    </section>
  );
}

/** Sign-in step. Enoki state is handled inside <ZkLoginButton/>. */
function SignInCard() {
  const { status, address } = useAphoticSession();

  return (
    <section className="aphotic-card dep-step">
      <StepHead
        num="01"
        title="Sign in"
        note={status === 'connected' ? 'ready' : 'google · zklogin'}
      />
      <ZkLoginButton hint="Google sign-in creates your Sui address in this browser. No seed phrase, no extension." />
      {status === 'connected' && address !== null ? (
        <AddressPill label="Your Sui address" value={address} truncate={false} />
      ) : null}
      <SponsorshipNote />
    </section>
  );
}

function ConfirmDepositCrankNote() {
  return (
    <div className="dep-aside-note">
      <span className="dep-tag dep-tag-sui">Stage 5 · permissionless</span>
      <p>
        Confirmation is <strong>permissionless</strong>: <code>hashi::deposit::confirm_deposit</code>{' '}
        is an entry function anyone can call. Our keeper cranks it for every pending deposit in the
        queue, not only for ours. It is the one part of the Bitcoin leg that really is instant, and
        it is a live on-chain transition we can run on camera.
      </p>
    </div>
  );
}

/** Stage 6 — the sponsored sweep. Built by the keeper; the app only surfaces it. */
function SweepStatus() {
  const completed = depositFixtures.find((d) => d.stage === 6);

  return (
    <div className="dep-aside-note">
      <span className="dep-tag dep-tag-sui">Stage 6 · sponsored sweep</span>
      <p>
        Once <code>treasury::Minted</code> fires, a sponsored PTB sweeps the minted{' '}
        <code>Coin&lt;BTC&gt;</code> into vault shares and pins your Bitcoin exit address on-chain
        in the same transaction. The keeper builds nothing here that could move your coins — it
        holds a DeepBook <code>TradeCap</code> and nothing else.
      </p>
      {completed !== undefined ? (
        <div className="dep-digests">
          <div className="dep-digest">
            <span className="dep-tag">Most recent completed deposit · {formatSats(completed.amountSats)}</span>
            <Digest label="mint" value={completed.mintDigest} />
            <Digest label="sweep" value={completed.sweepDigest} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Digest({ label, value }: { label: string; value?: string }) {
  if (value === undefined) return null;
  const text = truncateMiddle(value, 8);
  return (
    <span className="aphotic-mono" title={value}>
      {label}:{' '}
      {isMock() ? (
        <>
          {text} <span className="dep-tag">fixture</span>
        </>
      ) : (
        <a href={suiTxUrl(value)} target="_blank" rel="noreferrer">
          {text}
        </a>
      )}
    </span>
  );
}

/** G2 + G8, said out loud on the screen where the money enters. */
function DepositHonestyNote() {
  return (
    <div className="dep-aside-note">
      <span className="dep-tag dep-tag-btc">What you are trusting</span>
      <p>
        hBTC is <strong>custodial-threshold wrapped BTC</strong>: a threshold-Schnorr MPC committee
        plus a 2-of-2 guardian holds the native coins. We do not dress that up. What Aphotic adds is
        on-chain and checkable — your Bitcoin exit address is pinned in Move at deposit and is
        immutable afterwards, the exit transaction reads that pinned address rather than any runtime
        input, and cancelling a stalled exit is signed by <em>you</em>, never by the keeper.
      </p>
    </div>
  );
}

export function DepositScreen() {
  const staged = warmDeposit;

  return (
    <div className="ap-page dep">
      <header>
        <span className="dep-eyebrow">Screen 1 · Deposit</span>
        <h1 className="dep-title">Deposit native BTC</h1>
        <p className="dep-lede">
          One Bitcoin transaction in. No wallet extension, no SUI for gas, and the address your BTC
          eventually comes back to is pinned on-chain the moment your deposit lands.
        </p>
      </header>

      <DepositRealityBanner />
      <LiveConfigBanner />

      <div className="dep-grid">
        <div className="dep-col">
          <SignInCard />
          <DepositAddressCard />
          <DepositHbtcPanel />
        </div>

        <div className="dep-col">
          <section className="aphotic-card dep-step">
            <StepHead num="04" title="What happens next" note="6 stages" />
            <div className="dep-aside-note">
              <span className="dep-tag dep-tag-btc">
                Pre-staged demo deposit · stage {staged.stage} of {config.constants.depositStages} ·{' '}
                {formatSats(staged.amountSats)}
              </span>
              <p>
                Standing ops keep deposits warm at each stage so the demo never waits on signet. The
                one below is parked just before the crank — the transition you see next is real.
              </p>
            </div>
            <LifecycleStepper
              stages={DEPOSIT_STAGES}
              current={staged.stage}
              detail={{ 2: `${staged.confs} / ${config.hashi.confirmations} confirmations` }}
            />
          </section>

          <ConfirmDepositCrankNote />
          <SweepStatus />
          <DepositHonestyNote />
        </div>
      </div>
    </div>
  );
}

export default DepositScreen;
