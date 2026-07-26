// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F5
// @phase      5
// @status     DONE
// @spec       aphotic.md §1 (the two products), §7 (mechanisms), §13 (limitations
//             are published), §22 (naming rule)
// @spec       docs/DESIGN-V2.md §4 (cadence is derived, never operator-chosen),
//             §5ter (THE CLEARING PARITY CLAIM DOES NOT HOLD), §9 (D9 Seal
//             committee), §10 D10 (validator floor), §11 (denomination ladder)
// @rules      G3 G5 G6 G7 G8
// @depends    ../../config.ts (F1) · ../../lib/explorer.ts (F1)
// @facts      THIS FILE IS PROSE, NOT LOGIC. It is the explanation the three doing
// @facts        screens (/vault /batch /verify) should not have to carry inline.
// @facts        It is ADDITIVE — nothing was deleted from those screens.
// @facts      EVERY id, url and scalar rendered here arrives from `config` (G7).
// @facts        A `0x…` literal in this file fails the `ids` gate. There is exactly
// @facts        one literal-id site in app/ and it is src/config.ts.
// @facts      ⚠ vitest.config.ts pins every id-bearing VITE_* to '', so every row
// @facts        below MUST render honestly when its value is the empty string —
// @facts        "not configured in this build", never a dead link, never a guess.
// @facts      CADENCE = 06:00 / 18:00 UTC, derived from cadenceMs/cadenceOffsetMs.
// @facts        `close_ms` is DERIVED and `open_batch` takes no timestamp, so no
// @facts        operator picks the moment and a full batch does NOT close early.
// @facts      SEAL: n key servers across n DISTINCT OPERATORS, threshold t (D9).
// @facts        Count operators, not servers.
// @facts      VALIDATOR COLLUSION: protocol floor 7, live testnet today 32 (D10).
// @facts        Always both numbers, always labelled.
// @facts      hBTC IS custodial-threshold wrapped BTC (G8). The differentiation is
// @facts        composing the bridge's ON-CHAIN machinery, never the token's trust
// @facts        model. Never soften this.
// @implements export interface DocsSection · DocsSubsection
//             export const DOCS_SECTIONS: readonly DocsSection[]
//             export const DOCS_CATEGORIES: readonly string[]
// @forbidden  a canonical id literal here — G7, enforced by scripts/gates.ps1 ids
// @forbidden  putting the limitations behind a toggle — they render unconditionally
// @forbidden  the names banned by aphotic.md §22
// @invariant  1. Every section id is unique and stable (it is the sidebar key).
// @invariant  2. The limitations section is a plain member of DOCS_SECTIONS, so it
//                can never be conditionally omitted.
// @invariant  3. No value is rendered that was not read from `config`.
// @ac         `rg '0x[a-f0-9]{16,}' src/screens/docs` returns nothing.
// @verify     cd app && npm run build
// @verify     cd app && npm test -- docs
// └── END CONTRACT ───────────────────────────────────────────────────────────

import type { ReactNode } from 'react';

import { config } from '../../config';
import { suiObjectUrl } from '../../lib/explorer';

export interface DocsSubsection {
  readonly title: string;
  readonly items: readonly ReactNode[];
}

export interface DocsSection {
  /** Stable sidebar key. */
  readonly id: string;
  /** Sidebar grouping — rendered as a category label. */
  readonly category: string;
  /** Sidebar link text. */
  readonly label: string;
  /** Content-pane heading. */
  readonly title: string;
  /** Lead paragraphs. */
  readonly body: readonly ReactNode[];
  readonly subsections: readonly DocsSubsection[];
}

// ── id / value rows ──────────────────────────────────────────────────────────

/** Short middle-elided form. Ids are long and the label is the content. */
function elide(value: string): string {
  return value.length > 22 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
}

/**
 * One on-chain object, linked to the configured Sui explorer.
 *
 * An empty value is the normal state of a fresh clone and of a CI project whose
 * `VITE_*` was never set — Vite inlines these at build time, so the bundle just
 * contains `""` and there is no runtime error to catch. We say so rather than
 * rendering a link to nowhere.
 */
function IdRow({
  label,
  value,
  envKey,
  note,
}: {
  label: string;
  value: string;
  envKey: string;
  note?: string;
}) {
  return (
    <>
      <strong>{label}</strong>
      {' — '}
      {value.length === 0 ? (
        <span className="docs-unwired">
          not configured in this build (<code>{envKey}</code>)
        </span>
      ) : (
        <a className="docs-id-link" href={suiObjectUrl(value)} target="_blank" rel="noreferrer">
          <code>{elide(value)}</code>
        </a>
      )}
      {note === undefined ? null : <span className="docs-note"> · {note}</span>}
    </>
  );
}

/** A plain label/value row for a scalar or a URL that is not an object id. */
function ValueRow({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <>
      <strong>{label}</strong>
      {' — '}
      {value.length === 0 ? (
        <span className="docs-unwired">not configured in this build</span>
      ) : (
        <code>{value.length > 46 ? elide(value) : value}</code>
      )}
      {note === undefined ? null : <span className="docs-note"> · {note}</span>}
    </>
  );
}

// ── derived, never operator-chosen ───────────────────────────────────────────

/** "06:00 and 18:00 UTC", computed from the cadence rather than typed out. */
function cadenceLabel(): string {
  const { cadenceMs, cadenceOffsetMs } = config.constants;
  const perDay = Math.max(1, Math.round(86_400_000 / cadenceMs));
  const hours: string[] = [];
  for (let i = 0; i < perDay; i += 1) {
    const ms = (cadenceOffsetMs + i * cadenceMs) % 86_400_000;
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    hours.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
  }
  return `${hours.join(' and ')} UTC`;
}

const CADENCE = cadenceLabel();

// ── the sections ─────────────────────────────────────────────────────────────

const GETTING_STARTED: DocsSection = {
  id: 'getting-started',
  category: 'Protocol',
  label: 'Getting started',
  title: 'Getting started',
  body: [
    <>
      Aphotic is two things sharing one balance sheet on Sui {config.sui.network} (Bitcoin side ={' '}
      <strong>signet</strong>): a <strong>redemption-carry vault</strong>, which buys the discounted
      claim on bridged BTC that exists because exiting the bridge is queued and rate-limited, and a{' '}
      <strong>sealed-order batch auction</strong>, where orders are encrypted in your own browser
      under a time-lock and cleared together at a single uniform price at {CADENCE}. The vault
      supplies the balance sheet; the auction supplies the venue where the claim changes hands
      before it ever reaches the public queue.
    </>,
  ],
  subsections: [
    {
      title: 'What you need',
      items: [
        <>
          <strong>A Sui wallet on {config.sui.network}</strong> — Slush or Phantom. A wallet that
          advertises a different chain is refused with a stated reason rather than failing inside
          the wallet. Google sign-in via <strong>zkLogin</strong> works too and produces an ordinary
          wallet-standard session, so there is exactly one account model behind both paths.
        </>,
        <>
          <strong>hBTC</strong> — it arrives through <strong>Hashi</strong>, MystenLabs&rsquo; native
          BTC orchestrator. You send signet BTC to a derived deposit address; after{' '}
          {config.hashi.confirmations} confirmations the mint lands on Sui. Hashi rejects
          withdrawals below {config.hashi.withdrawalMinSats.toString()} sats, so that is the floor
          everything above is designed around.
        </>,
        <>
          <strong>SUI for gas.</strong> Every request on the vault and the batch screens is a
          transaction you sign yourself; nothing is custodied on your behalf to make it feel
          smoother.
        </>,
      ],
    },
    {
      title: 'Where to go next',
      items: [
        <>
          <strong>/vault</strong> — deposit, redeem, and read the NAV lifecycle
          (<code>propose_nav</code> then <code>approve_nav</code>).
        </>,
        <>
          <strong>/batch</strong> — encrypt an order client-side and submit it to the live batch.
          Sizes are drawn from a fixed denomination ladder, not a free-form amount field, because a
          free-form amount is itself a fingerprint.
        </>,
        <>
          <strong>/verify</strong> — recompute the clearing yourself. It deliberately does not ask
          for a wallet: demanding one to check somebody else&rsquo;s arithmetic would defeat the
          point of publishing it.
        </>,
      ],
    },
  ],
};

const HOW_IT_WORKS: DocsSection = {
  id: 'how-it-works',
  category: 'Protocol',
  label: 'How it works',
  title: 'How it works',
  body: [
    <>
      There are two legs. They are independent — the auction is worth running whether or not the
      carry is on — but they were built together because each is the other&rsquo;s natural
      counterparty.
    </>,
  ],
  subsections: [
    {
      title: 'The carry',
      items: [
        <>
          Leaving the bridge is <strong>not instant and not first-come-first-served</strong>. A
          withdrawal joins a global queue governed by a token-bucket rate limiter, and a batch over
          capacity is <strong>rejected</strong>, not queued behind the others. You cannot buy
          priority.
        </>,
        <>
          Because the exit is slow and uncertain, hBTC trades <strong>below par</strong> against the
          BTC it represents. That discount is the price of waiting, and it is a real,
          measurable spread rather than an emission.
        </>,
        <>
          The vault <strong>buys that claim at a discount and redeems it one-for-one</strong>. It is
          paid for holding the queue risk that the seller did not want. This is closer to
          congestion insurance than to a bridge.
        </>,
        <>
          The limiter state is <strong>trustlessly replayable</strong>:{' '}
          <code>project_capacity() = min(cap, tokens + elapsed × refill_rate)</code>, re-derived from
          the on-chain <code>WithdrawalSigned</code> event stream. It is never a trusted SDK read.
        </>,
      ],
    },
    {
      title: 'The auction',
      items: [
        <>
          An order is <strong>Seal-encrypted in your browser</strong> under a time-lock identity
          before it leaves the machine. The threshold committee cannot open it early, and we never
          fall back to plaintext — if the committee is unreachable the order is simply not
          submitted.
        </>,
        <>
          At {CADENCE} the batch closes and every order in it clears at{' '}
          <strong>one uniform price</strong>: the price maximising executed volume, ties broken by
          the smaller imbalance and then by the lower price. Integer arithmetic only, no rounding
          discretion.
        </>,
        <>
          Orders strictly inside the clearing price fill in full; orders exactly at it are pro-rated
          by <code>floor(residual × qty / Σqty)</code>, with the remainder handed out one sat at a
          time by largest fractional remainder and tie-broken by canonical position. There is no
          implementation freedom left anywhere in that sentence — that is the point.
        </>,
        <>
          Fills are committed to a Merkle root over the canonical fill list, so any participant can
          prove their own fill against a public root without being shown anyone else&rsquo;s.
        </>,
      ],
    },
  ],
};

const WHY_AUCTION: DocsSection = {
  id: 'why-auction',
  category: 'Protocol',
  label: 'Why an auction',
  title: 'Why an auction',
  body: [
    <>
      This is the part that is actually novel, so it is worth stating plainly rather than burying in
      a mechanism list.
    </>,
  ],
  subsections: [
    {
      title: 'The queue is public, and that is the leak',
      items: [
        <>
          Hashi&rsquo;s <code>WithdrawalRequestQueue</code> is a <strong>public Move object</strong>.
          Every pending request exposes <code>sender</code>, <code>btc_amount</code>,{' '}
          <code>bitcoin_address</code> and <code>created_timestamp_ms</code>. Nothing is hidden;
          nothing needs to be decoded.
        </>,
        <>
          So a desk unwinding a position is <strong>watched forming in real time</strong>. The size,
          the destination and the moment are all readable by anyone who can call a getter — before
          the BTC has moved, and for the entire ~1.5–2 hours the exit takes.
        </>,
        <>
          Aphotic crosses that flow <strong>before it reaches the queue</strong>. A seller who
          crosses in the batch never posts a public withdrawal request at all; the vault, which is
          already carrying queue risk deliberately, is the one that shows up in the queue.
        </>,
      ],
    },
    {
      title: 'Uniform price does not make front-running hard — it makes it meaningless',
      items: [
        <>
          Everyone in a batch executes at <strong>the same price at the same instant</strong>.
          Ordering within the batch buys nothing, so there is no advantage to race for. That is a
          stronger property than making the race expensive.
        </>,
        <>
          Which only holds if <strong>nobody picks the moment</strong>. So <code>close_ms</code> is{' '}
          <strong>derived</strong> from the cadence, and <code>open_batch</code>{' '}
          <strong>takes no timestamp argument</strong> — there is no parameter an operator could
          nudge.
        </>,
        <>
          And a <strong>full batch does not close early</strong>. If filling a batch could pull the
          close forward, then whoever submits the last order chooses the clearing instant, which is
          exactly the discretion the design removes. It closes on the clock or not at all.
        </>,
        <>
          The clearing rule is deterministic and published, so &ldquo;same order set, same price,
          always&rdquo; is a claim you can check rather than trust. See <strong>/verify</strong> —
          and read the parity limitation below before you believe it.
        </>,
      ],
    },
  ],
};

const ARCHITECTURE: DocsSection = {
  id: 'architecture',
  category: 'Technical',
  label: 'Architecture',
  title: 'Architecture',
  body: [
    <>
      Ten Move modules, a TypeScript keeper that holds no discretion, one shared{' '}
      <code>sdk/</code> so the clearing algorithm exists in exactly one place, and a Rust twin built
      for no reason other than to check it.
    </>,
  ],
  subsections: [
    {
      title: 'The pieces',
      items: [
        <>
          <strong>Move package</strong> — ten modules: the vault and its NAV lifecycle, the batch
          registry and cadence, the sealed-order book, clearing, the note tree and nullifier set,
          the balance ledger that holds order escrow <em>outside</em> vault NAV, the adapter
          allowlist, governance, and the Hashi boundary. The bridge surface is confined to one
          module so there is a single place to audit it.
        </>,
        <>
          <strong>The keeper holds no discretion.</strong> It cranks: open the batch, close it on
          the derived boundary, fetch the decryption shares, run the published clearing algorithm,
          submit the result. It cannot choose a price, cannot choose a moment, and cannot move
          depositor funds. Whatever it can do is what the caps it holds allow, and it holds the
          minimum.
        </>,
        <>
          <strong>One shared <code>sdk/</code>.</strong> The clearing algorithm is imported by the
          keeper and by this app; a second copy in a screen would reintroduce exactly the drift the
          parity tests exist to catch. The app aliases <code>@aphotic/sdk/*</code> straight at the
          SDK source.
        </>,
        <>
          <strong>A Rust twin.</strong> Two implementations that agree prove very little — they can
          share an author&rsquo;s misreading. A third, written from the spec in a different
          language, is what turned a green suite into a found bug. It did: see the parity limitation.
        </>,
      ],
    },
    {
      title: 'What runs where',
      items: [
        <>
          <strong>In your browser</strong> — order encryption, the Merkle path for a note spend, the
          deposit-address derivation, and the recomputation on /verify. None of it needs our server.
        </>,
        <>
          <strong>On chain</strong> — custody, the batch state machine, the clearing result and its
          root, the note tree, and every parameter that could otherwise be quietly changed.
        </>,
        <>
          <strong>Off chain, untrusted</strong> — the keeper and Walrus blob storage. Both are
          replaceable; neither is trusted with a decision.
        </>,
      ],
    },
  ],
};

const CONTRACTS: DocsSection = {
  id: 'contracts',
  category: 'Technical',
  label: 'Smart contracts',
  title: 'Smart contracts',
  body: [
    <>
      Everything this build actually points at, read from its configuration and linked to{' '}
      <code>{config.explorers.sui}</code>. Nothing here is typed into this page — an id literal in a
      screen file fails our <code>ids</code> gate, and there is exactly one literal-id site in the
      app.
    </>,
  ],
  subsections: [
    {
      title: 'Package and shared objects',
      items: [
        <IdRow
          label="Aphotic package"
          value={config.aphotic.packageId}
          envKey="VITE_APHOTIC_PACKAGE_ID"
          note="the moveCall target"
        />,
        <IdRow
          label="Aphotic package (original)"
          value={config.aphotic.originalPackageId}
          envKey="VITE_APHOTIC_ORIGINAL_PACKAGE_ID"
          note="type-argument origin — it diverges from the target the moment we upgrade"
        />,
        <IdRow
          label="Vault"
          value={config.aphotic.vaultId}
          envKey="VITE_VAULT_ID"
          note="shares, NAV lifecycle, fees"
        />,
        <IdRow
          label="BatchRegistry"
          value={config.aphotic.batchRegistryId}
          envKey="VITE_BATCH_REGISTRY_ID"
          note="cadence, policy version, the live batch pointer"
        />,
        <IdRow
          label="AdapterRegistry"
          value={config.aphotic.adapterAllowlistId}
          envKey="VITE_ADAPTER_ALLOWLIST_ID"
          note="the pinned lending-adapter destinations — idle balance can only ever go somewhere on this list"
        />,
        <IdRow
          label="Governance"
          value={config.aphotic.governanceId}
          envKey="VITE_GOVERNANCE_ID"
          note="caps, pause state, governed parameters"
        />,
        <IdRow
          label="BalanceLedger"
          value={config.aphotic.balanceLedgerId}
          envKey="VITE_BALANCE_LEDGER_ID"
          note="order escrow, held deliberately OUTSIDE vault NAV"
        />,
        <IdRow
          label="NoteTree"
          value={config.aphotic.noteTreeId}
          envKey="VITE_NOTE_TREE_ID"
          note="the append-only commitment tree"
        />,
        <IdRow
          label="NullifierSet"
          value={config.aphotic.nullifierSetId}
          envKey="VITE_NULLIFIER_SET_ID"
          note="single-use spend tags"
        />,
      ],
    },
    {
      title: 'The aphotic_lending market',
      items: [
        <>
          The hBTC lending counterparty is a <strong>separately published package</strong>, reached
          only through the destinations pinned in the <strong>AdapterRegistry</strong> above — the
          vault cannot send idle balance anywhere that is not on that list.
        </>,
        <>
          This build does not carry its package id as a <code>VITE_*</code> of its own, so there is
          nothing honest to link here; open the AdapterRegistry above and read the pinned
          destinations. <strong>We deployed that market ourselves</strong> and its APY is ours, not
          a market rate — see the limitations.
        </>,
      ],
    },
  ],
};

const NETWORK: DocsSection = {
  id: 'network',
  category: 'Reference',
  label: 'Network configuration',
  title: 'Network configuration',
  body: [
    <>
      Every value below is read from this build&rsquo;s configuration at render time. If one says
      &ldquo;not configured&rdquo;, that is the truth about the bundle you are looking at, not a
      placeholder.
    </>,
  ],
  subsections: [
    {
      title: 'Sui and Bitcoin',
      items: [
        <ValueRow
          label="Sui network"
          value={config.sui.network}
          note="reads and writes both target it"
        />,
        <ValueRow
          label="Sui gRPC"
          value={config.sui.grpcUrl}
          note="the default read transport — the testnet fullnode is gRPC-v2-only"
        />,
        <ValueRow
          label="Sui JSON-RPC mirror"
          value={config.sui.jsonRpcUrl}
          note="required because dapp-kit is typed to the JSON-RPC client"
        />,
        <ValueRow label="Sui explorer" value={config.explorers.sui} />,
        <ValueRow
          label="Bitcoin network"
          value="signet"
          note="the BTC leg is never instant — see the limitations"
        />,
        <ValueRow label="Bitcoin explorer" value={config.explorers.bitcoin} />,
      ],
    },
    {
      title: 'Hashi',
      items: [
        <IdRow
          label="Hashi package"
          value={config.hashi.packageId}
          envKey="VITE_HASHI_PACKAGE_ID"
        />,
        <IdRow label="Hashi object" value={config.hashi.objectId} envKey="VITE_HASHI_OBJECT_ID" />,
        <ValueRow label="hBTC type" value={config.hashi.hbtcType} note="8 decimals, amounts in sats" />,
        <ValueRow
          label="Withdrawal minimum"
          value={`${config.hashi.withdrawalMinSats.toString()} sats`}
          note="Hashi rejects anything below it"
        />,
        <ValueRow
          label="Deposit minimum"
          value={`${config.hashi.depositMinSats.toString()} sats`}
        />,
        <ValueRow
          label="Signet confirmations"
          value={String(config.hashi.confirmations)}
          note="required before a deposit is approved"
        />,
        <ValueRow
          label="Cancel cooldown"
          value={`${Math.round(config.hashi.cancelCooldownMs / 60_000)} minutes`}
          note="cancel_withdrawal cooldown"
        />,
      ],
    },
    {
      title: 'DeepBook',
      items: [
        <IdRow
          label="hBTC pool"
          value={config.deepbook.poolId}
          envKey="VITE_DEEPBOOK_POOL"
          note="reference mid for the carry entry and the NAV deviation check"
        />,
        <IdRow
          label="DeepBook package"
          value={config.deepbook.packageId}
          envKey="VITE_DEEPBOOK_PACKAGE"
          note="moveCall target"
        />,
        <IdRow
          label="DeepBook package (original)"
          value={config.deepbook.originalPackageId}
          envKey="VITE_DEEPBOOK_ORIGINAL_PACKAGE"
          note="type-argument origin"
        />,
        <ValueRow label="Quote asset" value={config.deepbook.dbusdcType} />,
      ],
    },
    {
      title: 'Seal committee',
      items: [
        <>
          <strong>Shape</strong>
          {' — '}
          {config.seal.keyServerIds.length === 0 ? (
            <span className="docs-unwired">
              not configured in this build (<code>VITE_SEAL_KEY_SERVER_IDS</code>); threshold t ={' '}
              {config.seal.threshold} is set but there are no key servers to meet it, so no order
              could be encrypted. We never fall back to plaintext.
            </span>
          ) : (
            <>
              n = {config.seal.keyServerIds.length} key servers across{' '}
              {config.seal.keyServerIds.length} <strong>distinct operators</strong>, threshold t ={' '}
              {config.seal.threshold}. Count operators, not servers — n servers run by one party is
              a committee of one.
            </>
          )}
        </>,
        <>
          <strong>Policy version</strong> — {config.seal.policyVersion}. Bumping it invalidates every
          outstanding identity at once.
        </>,
        <>
          <strong>Enoki is never a key server.</strong> It is used for zkLogin only. Giving one
          party both identity linkage and a decryption share would defeat the committee, so the
          separation is structural rather than a policy we promise to keep.
        </>,
      ],
    },
    {
      title: 'Walrus',
      items: [
        <ValueRow
          label="Aggregator"
          value={config.walrus.aggregatorUrl}
          note="reads the order ciphertexts"
        />,
        <ValueRow
          label="Publisher"
          value={config.walrus.publisherUrl}
          note="writes them; without it ciphertexts can be read but not published"
        />,
      ],
    },
    {
      title: 'Protocol constants (not env-tunable)',
      items: [
        <ValueRow label="Clearing cadence" value={CADENCE} note="derived, never operator-chosen" />,
        <ValueRow
          label="Denomination ladder"
          value={config.constants.denominationsSats
            .map((s) => `${Number(s) / 10 ** config.constants.hbtcDecimals} hBTC`)
            .join(' · ')}
          note="append-only — repricing a live tier would revalue live notes"
        />,
        <ValueRow
          label="Submit cutoff"
          value={`${Math.round(config.constants.submitCutoffMs / 1_000)} s before close`}
        />,
        <ValueRow
          label="Reveal grace"
          value={`${Math.round(config.constants.revealGraceMs / 60_000)} minutes after close`}
        />,
        <ValueRow
          label="Max batch size"
          value={`${config.constants.maxBatchSize} orders`}
          note={`hard ceiling ${config.constants.hardMaxBatchSize}, asserted in the setter`}
        />,
      ],
    },
  ],
};

const LIMITATIONS: DocsSection = {
  id: 'limitations',
  category: 'Reference',
  label: 'Honest limitations',
  title: 'Honest limitations',
  body: [
    <>
      This section is the point of the page, not an appendix. It is rendered in full, unconditionally
      — nothing here is behind a toggle or collapsed by default, because a limitation you have to
      click to find is a limitation you were hoping nobody would read.
    </>,
  ],
  subsections: [
    {
      title: 'What we inherit',
      items: [
        <>
          <strong>hBTC is custodial-threshold wrapped BTC.</strong> It is threshold Schnorr across a
          validator subset, 2-of-2 with a Guardian enclave, with a ~60-day recovery leaf. It is{' '}
          <strong>not trustless</strong>. Aphotic inherits <em>every one</em> of Hashi&rsquo;s trust
          assumptions and adds its own on top. The differentiation is composing the bridge&rsquo;s
          on-chain machinery — the public queue, the replayable limiter, the pinned exits — never the
          token&rsquo;s trust model.
        </>,
        <>
          <strong>Validator collusion: protocol floor 7, live testnet today {config.constants.validatorsLive}.</strong>{' '}
          Quoting the floor alone overstates the risk; quoting the live count alone understates what
          the protocol actually guarantees. Both numbers, always, always labelled.
        </>,
        <>
          <strong>The BTC leg is never instant.</strong> A deposit takes roughly 70 minutes; a
          withdrawal 1.5–2 hours. No amount of Sui-side speed changes that, and anything that looks
          instant in a demo was pre-staged.
        </>,
      ],
    },
    {
      title: 'What v1 does not do',
      items: [
        <>
          <strong>v1 note spends are LINKABLE.</strong> The Merkle path is supplied in the clear, so
          the leaf index names the note. What the denomination ladder buys is{' '}
          <strong>uniformity, not unlinkability</strong> — privacy comes from the crowd, not from
          the ladder. On a quiet day the crowd is small and the ladder buys you very little.
        </>,
        <>
          <strong>We deployed the hBTC lending counterparty ourselves</strong>, because none exists
          on Sui testnet. Its APY is <strong>ours, not a market rate</strong>. Treat any yield number
          it produces as an integration test, not as evidence of demand.
        </>,
        <>
          <strong>The carry is not executed in this version.</strong> The DeepBook hBTC book is empty
          on both sides and we can mint neither leg, so there is no price to trade against. The
          machinery is built and tested; it has not been run against a live spread.
        </>,
        <>
          <strong>If the spread vanishes, the venue is worth little.</strong> Aphotic is closer to
          congestion insurance than to a bridge — it is paid for queue risk. In calm markets there is
          not much queue risk to be paid for.
        </>,
      ],
    },
    {
      title: 'The open release blocker',
      items: [
        <>
          <strong>The Move↔TypeScript clearing parity FAILS.</strong> We wrote a third
          implementation, in Rust, specifically to check it. TypeScript, the 46 golden fixtures and
          the Rust spec engine all agree with each other. <strong>Move differs on 15 % of 4 000
          seeded books</strong>, across five named divergences.
        </>,
        <>
          The fill-leaf layouts are <strong>73 versus 81 bytes</strong>, so the Merkle roots can
          never match — this is not a rounding disagreement that a tolerance could absorb.
        </>,
        <>
          By our own rules that is a <strong>release blocker, and it is open</strong>. We are
          publishing it rather than shipping quietly around it, because a determinism claim you
          cannot check is not a claim. Details in <code>docs/DESIGN-V2.md</code> §5ter.
        </>,
      ],
    },
  ],
};

export const DOCS_SECTIONS: readonly DocsSection[] = [
  GETTING_STARTED,
  HOW_IT_WORKS,
  WHY_AUCTION,
  ARCHITECTURE,
  CONTRACTS,
  NETWORK,
  LIMITATIONS,
];

/** Sidebar groups, in first-appearance order. */
export const DOCS_CATEGORIES: readonly string[] = DOCS_SECTIONS.reduce<string[]>((acc, s) => {
  if (!acc.includes(s.category)) acc.push(s.category);
  return acc;
}, []);
