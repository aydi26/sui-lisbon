// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T3.2
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/APP.md §3 (Screen 2 — Exit, L109-L154) · §7 A4 A5 A6 A8 A11
// @spec       docs/BUILD-PLAN.md Phase 3 T3.2 · docs/MOVE-PACKAGE.md#gateway
// @spec       docs/RECON.md R7 (withdraw.move) · R6 (live config) · R14.2 (txid order)
// @rules      G1 G2 G3 G6 G7 G8 G9
// @depends    ./RegisterExitAddress.tsx · ./ExitRequestForm.tsx · ./PendingPool.tsx
//             ./ExitTimeline.tsx · ./vaultRead.ts · ./history.ts · ./bookMid.ts
//             ./ptb.ts · ./model.ts · ./exit.css
//             ../../components (T0.4) · ../../lib/tx.ts (T3.4)
//             ../../session/useSession.ts (T3.3) · ../../lib/explorer.ts (T0.4)
// @facts      EVERYTHING ON THIS SCREEN IS LIVE. The vault position is simulated
// @facts        against the package's own public getters (./vaultRead.ts); the exit
// @facts        history is joined from the on-chain event stream (./history.ts); the
// @facts        five buttons build and send real PTBs through the app's ONE send path
// @facts        (lib/tx.ts useAphoticTx). There is no fixture behind any of it.
// @facts      HASHI_WITHDRAWAL_MIN_SATS = 30_000 · dust floor 546
// @facts      withdrawal_cancellation_cooldown_ms = 3_600_000
// @facts      Pinned address is 20 B (P2WPKH) or 32 B (P2TR); anything else aborts
// @facts        EInvalidBitcoinAddress upstream, so ../../lib/bech32.ts rejects it at
// @facts        PIN time, which is the last recoverable moment.
// @facts      ⚠ gateway::exit_to_bitcoin takes NO bitcoin-address argument. The
// @facts        destination is read from Vault.btc_exit_address (G2). <CallPreview/>
// @facts        renders the real argument list so that absence is checkable on screen.
// @facts      ⚠ hashi::withdraw::cancel_withdrawal asserts
// @facts        request.sender == ctx.sender() ⇒ reclaim is DEPOSITOR-signed only;
// @facts        the keeper can build it and can never submit it. (RECON R7.3)
// @facts      ⚠ v3 removed the owner emergency withdraw from vault.move. The ONLY
// @facts        ways value leaves the vault are a depositor's own pro-rata redemption
// @facts        and this pinned exit — not even the owner has a path.
// @facts      ⚠ `paused` is NOT an exit blocker. vault::burn_shares_for_btc is
// @facts        deliberately ungated on it (vault.move @invariant 9) so a paused vault
// @facts        still lets depositors leave. Disabling the button on pause would state
// @facts        a reason that is not true, so this screen says the opposite out loud.
// @facts      ⚠ NAV is re-derived by model.ts::navSatsMirror from free_btc_sats and
// @facts        quote_value, NOT read via vault::nav_sats — that getter aborts EZeroNav
// @facts        for a quote-holding vault with no mid, and one aborting command fails
// @facts        the whole read simulation. An unpriceable NAV renders as "cannot be
// @facts        valued" with the reason, never as a zero (G9).
// @facts      ⚠ A history row whose bridge request_id could not be read offers NO
// @facts        reclaim button: reclaim_stalled_exit takes an `address` and a Sui
// @facts        digest is base58 — the builder would throw on it.
// @facts      ⚠ Below 30_000 sats Move POOLS and submits nothing, so the success copy
// @facts        after a pooling burn must not claim the bridge has anything.
// @facts      ⚠ Over-capacity batches are REJECTED (RateLimitExceeded), never queued.
// @facts        There is no priority to offer and the bridge is not congested (~100
// @facts        BTC/day) — this screen must contain no scarcity copy. (G3, G8)
// @facts      Phase A = one Sui checkpoint. Phase B ≈ 1.5-2 h on signet and is never
// @facts        live-demoed (G6) — the two legs are drawn as two clocks, never one bar.
// @facts      book_mid is Pyth-BETA-derived (./bookMid.ts) and labelled as such: the
// @facts        hBTC/DBUSDC book is empty on both sides, so pool::mid_price aborts
// @facts        EEmptyOrderbook. It is passed honestly and is not load-bearing while
// @facts        the vault holds no quote leg (vault.move v3 nav_sats). (G9)
// @external   useAphoticTx().send(builder) → TxResult   (lib/tx.ts, the ONE send path)
//             readVaultSnapshot(who) · readExitHistory(who) · readBookMid()
// @implements export function ExitScreen(): JSX.Element
// @forbidden  ANY editable destination field — G2, A4
// @forbidden  a priority / fast / expedite control — G3, A6
// @forbidden  a live progress bar blocking on Bitcoin during judging — G6
// @forbidden  a canonical id literal in this file — G7, A10
// @forbidden  a clickable-and-silent control: every disabled button carries a
//             one-line reason next to it
// @forbidden  a fixture standing in for live data on this screen
// @invariant  1. The pinned address renders as immutable, with <PinningExplainer/>.
// @invariant  2. Amounts below 30_000 sats route to the pending pool, never to
//                request_withdrawal — Move decides, and the form says so first.
// @invariant  3. Every explorer link points at a digest/txid actually observed.
// @invariant  4. No write ever happens without the user's own signature.
// @ac         docs/APP.md §7 A4 A5 A6
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';

import './exit.css';

import { config } from '../../config';
import { AddressPill, KeeperCapabilityBadge, PinningExplainer } from '../../components';
import { formatSats, renderPinnedAddress, truncateMiddle } from '../../lib/format';
import { suiObjectUrl, suiTxUrl } from '../../lib/explorer';
import { useAphoticTx } from '../../lib/tx';
import { useAphoticSession } from '../../session/useSession';

import ExitRequestForm from './ExitRequestForm';
import ExitTimeline from './ExitTimeline';
import PendingPool from './PendingPool';
import RegisterExitAddress from './RegisterExitAddress';
import CallPreview from './CallPreview';
import { readBookMid, type BookMidReading } from './bookMid';
import { readExitHistory } from './history';
import { readVaultSnapshot } from './vaultRead';
import { navSatsMirror, type ExitRecord, type VaultView } from './model';
import {
  buildExitToBitcoinTx,
  buildFlushPendingExitTx,
  buildReclaimStalledExitTx,
  buildRegisterExitAddressTx,
  buildTakePendingAsHbtcTx,
  describeExitCall,
  missingTargets,
} from './ptb';

type ActionKind = 'register' | 'exit' | 'flush' | 'take' | 'reclaim';

interface Feedback {
  readonly action: ActionKind;
  readonly ok: boolean;
  readonly text: string;
  readonly digest: string | null;
}

const EMPTY_VIEW: VaultView = {
  totalShares: 0n,
  navSats: 0n,
  myShares: 0n,
  pendingExitSats: 0n,
  bookMid: null,
  paused: false,
};

function DigestLink({ digest }: { digest: string }) {
  return (
    <a className="xt-link" href={suiTxUrl(digest)} target="_blank" rel="noreferrer">
      {truncateMiddle(digest, 10)} ↗
    </a>
  );
}

function BookMidPanel({ reading }: { reading: BookMidReading | undefined }) {
  return (
    <div className="xt-kv-row">
      <dt className="xt-kv-key">
        book_mid (Pyth Beta BTC/USD — the hBTC/DBUSDC book has no mid to read)
      </dt>
      <dd className="xt-kv-val">
        {reading === undefined
          ? 'reading…'
          : reading.status === 'unavailable'
            ? reading.reason
            : `${reading.usd} USD → ${reading.mid.toString()}${reading.status === 'stale' ? ' · stale' : ''}`}
      </dd>
    </div>
  );
}

export function ExitScreen() {
  const session = useAphoticSession();
  const address = session.address;
  const tx = useAphoticTx();

  const [pending, setPending] = useState<ActionKind | null>(null);
  const [reclaimingId, setReclaimingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // A stated countdown, never a spinner (G6). One tick a second, no network.
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const configMissing = useMemo(() => missingTargets(), []);
  const configured = configMissing.length === 0;

  const vaultQuery = useQuery({
    queryKey: ['exit', 'vault', address],
    queryFn: () => readVaultSnapshot(address as string),
    enabled: configured && address !== null,
  });

  const historyQuery = useQuery({
    queryKey: ['exit', 'history', address],
    queryFn: () => readExitHistory(address as string),
    enabled: configured && address !== null,
  });

  const midQuery = useQuery({
    queryKey: ['exit', 'bookMid'],
    queryFn: ({ signal }) => readBookMid(signal),
    staleTime: 30_000,
    // G6: no request before the user is in. Signed out there is no position to
    // price, and a demo must not reach for Hermes on page load.
    enabled: address !== null,
  });

  const snapshot = vaultQuery.data;
  const pinnedProgram = snapshot?.status === 'ok' ? snapshot.pinnedProgram : null;
  const pinned = pinnedProgram === null ? null : renderPinnedAddress(pinnedProgram);

  const mid = midQuery.data;
  const bookMid = mid !== undefined && mid.status !== 'unavailable' ? mid.mid : null;

  // NAV is re-derived here rather than read, because vault::nav_sats aborts
  // EZeroNav for a quote-holding vault with no price and one aborting command
  // fails the whole read simulation. navSatsMirror is the Move arithmetic,
  // line for line — and it reports "unpriced" instead of inventing a zero.
  const nav = useMemo(
    () =>
      snapshot?.status === 'ok'
        ? navSatsMirror(snapshot.freeBtcSats, snapshot.quoteValue, bookMid)
        : null,
    [snapshot, bookMid],
  );

  const view: VaultView =
    snapshot?.status === 'ok'
      ? { ...snapshot.view, navSats: nav?.status === 'ok' ? nav.sats : 0n, bookMid }
      : EMPTY_VIEW;

  const records: readonly ExitRecord[] =
    historyQuery.data?.status === 'ok' ? historyQuery.data.records : [];

  const refresh = useCallback(() => {
    void vaultQuery.refetch();
    void historyQuery.refetch();
    void midQuery.refetch();
  }, [vaultQuery, historyQuery, midQuery]);

  // ── one honest reason per blocked control ─────────────────────────────────
  const baseBlock: string | null = !configured
    ? `This build has no vault to call — ${configMissing.join(' and ')} empty.`
    : session.status === 'unconfigured'
      ? `Sign-in is unavailable: ${session.problems.join(' ')}`
      : address === null
        ? 'Sign in with Google first — Move reads the sender, so the signature has to be yours.'
        : tx.disabledReason;

  const readBlock: string | null =
    snapshot === undefined
      ? null
      : snapshot.status === 'unavailable'
        ? snapshot.reason
        : snapshot.status === 'unconfigured'
          ? `Missing ${snapshot.missing.join(' and ')}.`
          : null;

  // Until the first read lands we know nothing about this depositor, so every
  // write is held with a stated reason rather than offered on a guess.
  const loadingBlock: string | null =
    address !== null && snapshot === undefined
      ? 'Reading your position from chain — one moment.'
      : null;

  const registerBlock: string | null =
    baseBlock ??
    readBlock ??
    loadingBlock ??
    (pinned !== null
      ? 'An address is already pinned. register_exit_address is write-once — a second call aborts EExitAddressAlreadySet.'
      : null);

  const exitBlock: string | null =
    baseBlock ??
    readBlock ??
    loadingBlock ??
    // ⚠ `paused` is deliberately NOT a blocker. vault::burn_shares_for_btc is
    // explicitly not gated on it (@invariant 9) — a paused vault must still let
    // depositors leave. Disabling the button here would be a false reason.
    (pinned === null
      ? 'Pin your Bitcoin exit address first — exit_to_bitcoin reads the destination out of the Vault and has nowhere else to get it.'
      : view.myShares === 0n
        ? 'You hold no shares in this vault yet. Deposit hBTC on the Deposit screen first — an exit burns shares.'
        : nav?.status === 'unpriced'
          ? nav.reason
          : null);

  const poolBlock: string | null = baseBlock ?? readBlock ?? loadingBlock;
  const reclaimBlock: string | null = baseBlock ?? readBlock ?? loadingBlock;

  const feedbackFor = (action: ActionKind, ok: boolean): ReactNode | null => {
    if (feedback === null || feedback.action !== action || feedback.ok !== ok) return null;
    return (
      <>
        {feedback.text}
        {feedback.digest === null ? null : (
          <>
            {' '}
            <DigestLink digest={feedback.digest} />
          </>
        )}
      </>
    );
  };

  const run = useCallback(
    async (action: ActionKind, build: () => unknown, successText: string) => {
      setPending(action);
      setFeedback(null);
      const result = await tx.send(() => build() as never, { label: action });
      if (result.status === 'success') {
        setFeedback({ action, ok: true, text: successText, digest: result.digest });
        refresh();
      } else {
        setFeedback({ action, ok: false, text: result.message, digest: null });
      }
      setPending(null);
      setReclaimingId(null);
    },
    [tx, refresh],
  );

  const onRegister = useCallback(
    (program: Uint8Array) =>
      void run(
        'register',
        () => buildRegisterExitAddressTx(program),
        'Pinned on-chain. This address is now the only destination any exit of yours can ever reach.',
      ),
    [run],
  );

  const onExit = useCallback(
    (sharesToBurn: bigint, willPool: boolean) =>
      void run(
        'exit',
        () => buildExitToBitcoinTx({ sharesToBurn, bookMid: bookMid ?? 0n }),
        // Move decided this, not the UI: below 30,000 sats `stage_exit` pools and
        // submits nothing. Saying "the bridge has it" here would be a lie.
        willPool
          ? 'Shares burned and the proceeds pooled inside the Vault. Nothing went to the bridge — the amount is under Hashi’s 30,000-sat minimum, which the bridge rejects rather than queues. Take it back as hBTC whenever you like, or top the pool up and flush it yourself.'
          : 'Sui leg settled in one checkpoint. The Bitcoin leg is now the bridge’s, and takes about 1.5–2 h.',
      ),
    [run, bookMid],
  );

  const onFlush = useCallback(
    () =>
      void run(
        'flush',
        () => buildFlushPendingExitTx({ who: address as string }),
        'Pool submitted to the bridge, to the same pinned address.',
      ),
    [run, address],
  );

  const onTake = useCallback(
    () =>
      void run(
        'take',
        () => buildTakePendingAsHbtcTx({ recipient: address as string }),
        'Taken back as hBTC on Sui — one checkpoint, no bridge involved.',
      ),
    [run, address],
  );

  const onReclaim = useCallback(
    (record: ExitRecord) => {
      const requestId = record.bridgeRequestId;
      if (requestId === null) {
        // Unreachable from the UI (the button is not rendered without an id) —
        // kept so the guard survives a future refactor of the timeline.
        setFeedback({
          action: 'reclaim',
          ok: false,
          text: 'This exit has no bridge request_id yet, and reclaim_stalled_exit takes exactly that id. Re-read from chain and try again.',
          digest: null,
        });
        return;
      }
      setReclaimingId(record.requestId);
      void run(
        'reclaim',
        () => buildReclaimStalledExitTx({ requestId, bookMid: bookMid ?? 0n }),
        'Cancelled at the bridge and your shares re-credited at the current NAV.',
      );
    },
    [run, bookMid],
  );

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <div className="ap-page xt">
      <header>
        <p className="xt-eyebrow">Screen 2 · Exit</p>
        <h1 className="xt-title">Your BTC leaves to an address only you ever chose</h1>
        <p className="xt-lede">
          The destination is written into the Vault once, at deposit, and read back out inside Move
          on every exit. No function in this protocol accepts a Bitcoin address at exit time — not
          from you, not from us, not from a fully compromised keeper.
        </p>

        <div className="xt-legs">
          <div className="xt-leg xt-leg--sui">
            <span className="xt-leg-name">Sui leg</span>
            <span className="xt-leg-value">one checkpoint</span>
            <span className="xt-leg-sub">shares burn + request_withdrawal, atomically</span>
          </div>
          <div className="xt-leg xt-leg--btc">
            <span className="xt-leg-name">Bitcoin leg</span>
            <span className="xt-leg-value">~1.5–2 h</span>
            <span className="xt-leg-sub">the bridge’s clock, never a demo’s</span>
          </div>
          <div className="xt-leg">
            <span className="xt-leg-name">Reclaim window</span>
            <span className="xt-leg-value">after 1 h</span>
            <span className="xt-leg-sub">signed by you, impossible for the keeper</span>
          </div>
        </div>
      </header>

      {address === null ? (
        <section className="xt-panel xt-panel--accent">
          <div className="xt-panel-head">
            <h2 className="xt-panel-title">Sign in to see your position</h2>
            <span className="xt-badge">zkLogin · Google</span>
          </div>
          <p className="xt-copy">
            Every write on this screen carries <em>your</em> address as the Move sender. That is not
            a formality: Hashi&rsquo;s <code>cancel_withdrawal</code> asserts{' '}
            <code>request.sender == ctx.sender()</code>, so a reclaim is only ever valid from your
            own session. Gas is sponsored — sponsorship changes who pays, never who signs.
          </p>
          {session.problems.length > 0 ? (
            <p className="xt-msg xt-msg--warn">{session.problems.join(' ')}</p>
          ) : null}
          <div className="xt-actions">
            <button
              type="button"
              className="xt-btn xt-btn--primary"
              disabled={session.zkLoginDisabledReason !== null || session.status === 'connecting'}
              title={session.zkLoginDisabledReason ?? undefined}
              onClick={() => {
                void session.signIn().catch((error: unknown) => {
                  setFeedback({
                    action: 'register',
                    ok: false,
                    text: error instanceof Error ? error.message : String(error),
                    digest: null,
                  });
                });
              }}
            >
              {session.status === 'connecting' ? 'Opening Google…' : 'Sign in with Google'}
            </button>

            {/* Any installed wallet-standard extension is an equally valid signer.
                Offering only Google would make an Enoki outage a dead end. */}
            {session.extensionWallets.map((wallet) => (
              <button
                key={wallet.name}
                type="button"
                className="xt-btn"
                disabled={session.status === 'connecting'}
                onClick={() => {
                  void session.connectWallet(wallet).catch((error: unknown) => {
                    setFeedback({
                      action: 'register',
                      ok: false,
                      text: error instanceof Error ? error.message : String(error),
                      digest: null,
                    });
                  });
                }}
              >
                Connect {wallet.name}
              </button>
            ))}
          </div>

          {session.zkLoginDisabledReason === null ? null : (
            <p className="xt-hint">{session.zkLoginDisabledReason}</p>
          )}
          {session.extensionWallets.length === 0 ? (
            <p className="xt-hint">
              No browser wallet extension detected — Google sign-in is the path here, and it derives
              a real Sui address client-side. Nothing about it is a demo shortcut.
            </p>
          ) : null}
          {feedback !== null && feedback.action === 'register' && !feedback.ok ? (
            <p className="xt-msg xt-msg--bad">{feedback.text}</p>
          ) : null}
        </section>
      ) : null}

      <div className="xt-grid">
        <div className="xt-col">
          {pinned === null ? (
            <RegisterExitAddress
              onRegister={onRegister}
              busy={pending === 'register'}
              blockedReason={registerBlock}
              result={feedbackFor('register', true)}
              errorText={feedbackFor('register', false)}
            />
          ) : (
            <section className="xt-panel xt-panel--accent">
              <div className="xt-panel-head">
                <h2 className="xt-panel-title">Your pinned exit address</h2>
                <span className="xt-badge xt-badge--lock">immutable</span>
              </div>

              <AddressPill
                label={`On-chain Vault.btc_exit_address — ${pinned.kind}, ${pinnedProgram?.length ?? 0} bytes`}
                value={pinned.bech32}
                truncate={false}
                immutable
              />

              <dl className="xt-kv">
                <div className="xt-kv-row">
                  <dt className="xt-kv-key">Witness program (the bytes Move stores)</dt>
                  <dd className="xt-kv-val">{pinned.hex}</dd>
                </div>
              </dl>

              <p className="xt-copy">
                This was written once by <code>gateway::register_exit_address</code> and there is no
                function that can overwrite it. <code>gateway::exit_to_bitcoin</code> reads it from
                the Vault and takes no address argument at all, so a fully compromised keeper has
                nothing to redirect — it can place and cancel DeepBook orders, and that is the whole
                of its authority. And since v3 removed the owner emergency withdraw, the owner
                cannot move your funds either: the only ways value leaves this vault are your own
                pro-rata redemption and this pinned exit.
              </p>

              {feedback !== null && feedback.action === 'register' && feedback.ok ? (
                <p className="xt-msg xt-msg--ok">
                  {feedback.text}
                  {feedback.digest === null ? null : (
                    <>
                      {' '}
                      <DigestLink digest={feedback.digest} />
                    </>
                  )}
                </p>
              ) : null}

              <KeeperCapabilityBadge />
              <PinningExplainer />
            </section>
          )}

          <ExitRequestForm
            view={view}
            freeBtcSats={snapshot?.status === 'ok' ? snapshot.freeBtcSats : 0n}
            bookMid={bookMid}
            onExit={onExit}
            busy={pending === 'exit'}
            blockedReason={exitBlock}
            result={feedbackFor('exit', true)}
            errorText={feedbackFor('exit', false)}
          />

          {view.pendingExitSats > 0n && address !== null ? (
            <PendingPool
              who={address}
              pendingExitSats={view.pendingExitSats}
              onFlush={onFlush}
              onTake={onTake}
              busy={pending === 'flush' ? 'flush' : pending === 'take' ? 'take' : null}
              blockedReason={poolBlock}
              result={feedbackFor('flush', true) ?? feedbackFor('take', true)}
              errorText={feedbackFor('flush', false) ?? feedbackFor('take', false)}
            />
          ) : null}

          <section className="xt-panel">
            <div className="xt-panel-head">
              <h2 className="xt-panel-title">What we cannot offer you</h2>
              <span className="xt-badge">and why that is the honest answer</span>
            </div>
            <p className="xt-copy">
              There is no expedite button here, and there never will be. Hashi&rsquo;s Guardian
              limiter is a token bucket: an over-capacity batch is <strong>rejected</strong> (
              <code>RateLimitExceeded</code>), not held in an orderable queue. Nobody can buy a place
              in a queue that does not exist. What a protocol <em>can</em> do is ration its own
              egress rate and verify the bucket&rsquo;s trajectory by replaying the bridge&rsquo;s own{' '}
              <code>WithdrawalSigned</code> events — which is what the Transparency screen does.
            </p>
            <p className="xt-hint">
              For scale: the bridge&rsquo;s capacity is on the order of 100 BTC a day. Nothing here is
              scarce; it is simply rate-shaped, and the shape is public.
            </p>
          </section>
        </div>

        <div className="xt-col">
          <section className="xt-panel">
            <div className="xt-panel-head">
              <h2 className="xt-panel-title">Live vault state</h2>
              <span className="xt-badge xt-badge--ok">read from chain</span>
            </div>

            {snapshot === undefined && address !== null ? (
              <p className="xt-hint">Simulating the package&rsquo;s own public getters…</p>
            ) : null}
            {readBlock === null ? null : <p className="xt-msg xt-msg--warn">{readBlock}</p>}

            <dl className="xt-kv">
              <div className="xt-kv-row">
                <dt className="xt-kv-key">Vault</dt>
                <dd className="xt-kv-val">
                  <a
                    className="xt-link"
                    href={suiObjectUrl(config.aphotic.vaultId)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {truncateMiddle(config.aphotic.vaultId, 10)} ↗
                  </a>
                </dd>
              </div>
              <div className="xt-kv-row">
                <dt className="xt-kv-key">
                  NAV (sats){nav?.status === 'ok' && snapshot?.status === 'ok' && snapshot.quoteValue === 0n ? ' — base only, no price needed' : ''}
                </dt>
                <dd className={nav?.status === 'unpriced' ? 'xt-kv-val' : 'xt-kv-val xt-kv-val--accent'}>
                  {nav === null ? '—' : nav.status === 'ok' ? formatSats(nav.sats) : 'cannot be valued'}
                </dd>
              </div>
              {nav?.status === 'unpriced' ? (
                <div className="xt-kv-row">
                  <dt className="xt-kv-key">Why</dt>
                  <dd className="xt-kv-val">{nav.reason}</dd>
                </div>
              ) : null}
              <div className="xt-kv-row">
                <dt className="xt-kv-key">Idle DBUSDC held (quote leg)</dt>
                <dd className="xt-kv-val">
                  {snapshot?.status === 'ok' ? snapshot.quoteValue.toString() : '—'}
                </dd>
              </div>
              <div className="xt-kv-row">
                <dt className="xt-kv-key">Total shares</dt>
                <dd className="xt-kv-val">
                  {view.totalShares.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
                </dd>
              </div>
              <div className="xt-kv-row">
                <dt className="xt-kv-key">Your pooled earmark</dt>
                <dd className="xt-kv-val">{formatSats(view.pendingExitSats)}</dd>
              </div>
              <div className="xt-kv-row">
                <dt className="xt-kv-key">Paused</dt>
                <dd className="xt-kv-val">
                  {view.paused ? 'yes — exits still work' : 'no'}
                </dd>
              </div>
              <BookMidPanel reading={mid} />
            </dl>

            <p className="xt-hint">
              NAV is valued at the book, never at a raw oracle price. The hBTC/DBUSDC book is empty
              on both sides today, so there is no mid to quote — and a vault holding only hBTC has an
              exact sats NAV that needs no price at all, which is why v3 moved that guard inside the
              quote branch. The Pyth Beta figure above is shown for what it is: what the vault will
              use the moment it holds a quote leg.
            </p>

            <div className="xt-actions">
              <button
                type="button"
                className="xt-btn"
                disabled={address === null || vaultQuery.isFetching || historyQuery.isFetching}
                title={
                  address === null
                    ? 'Sign in first — there is no position to read while signed out'
                    : vaultQuery.isFetching || historyQuery.isFetching
                      ? 'A read is already in flight'
                      : 'Re-read your position, your exit history and the mid from chain'
                }
                onClick={refresh}
              >
                {vaultQuery.isFetching || historyQuery.isFetching ? 'Reading…' : 'Re-read from chain'}
              </button>
            </div>
            {address === null ? (
              <p className="xt-hint">Sign in to read your own position.</p>
            ) : null}
          </section>

          <ExitTimeline
            records={records}
            nowMs={nowMs}
            bookMid={bookMid}
            onReclaim={onReclaim}
            reclaimingId={pending === 'reclaim' ? reclaimingId : null}
            blockedReason={reclaimBlock}
            reclaimResult={feedbackFor('reclaim', true)}
            reclaimError={feedbackFor('reclaim', false)}
            historyNote={
              historyQuery.data?.status === 'unavailable' ? historyQuery.data.reason : null
            }
          />

          <section className="xt-panel">
            <div className="xt-panel-head">
              <h2 className="xt-panel-title">The call, in full</h2>
              <span className="xt-badge xt-badge--lock">no destination argument</span>
            </div>
            <p className="xt-copy">
              This is the exact argument list the Exit button encodes. Read it: there is no Bitcoin
              address in it. That absence is the guarantee — not a policy we promise to keep, but a
              parameter that does not exist.
            </p>
            <CallPreview
              call={describeExitCall({ sharesToBurn: 0n, bookMid: bookMid ?? 0n })}
              caption="gateway::exit_to_bitcoin"
            />
          </section>
        </div>
      </div>
    </div>
  );
}

export default ExitScreen;
