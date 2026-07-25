<div align="center">

# Aphotic

**Private LP strategies with maker-first execution on Sui**

[![Move](https://img.shields.io/badge/Move-2024-0B1D2A)](https://docs.sui.io)
[![Sui](https://img.shields.io/badge/Sui-testnet-2E7FA6)](https://sui.io)
[![Seal](https://img.shields.io/badge/Seal-threshold%20access%20control-B5346E)](https://seal.mystenlabs.com)
[![Walrus](https://img.shields.io/badge/Walrus-audit%20trail-123B54)](https://docs.wal.app)
[![DeepBook](https://img.shields.io/badge/DeepBook-v3-2E7FA6)](https://docs.sui.io/onchain-finance/deepbookv3/deepbook)
[![License](https://img.shields.io/badge/license-MIT-lightgrey)](LICENSE)

*The aphotic zone is the part of the ocean where sunlight stops reaching.*

</div>

---

Aphotic is a non-custodial concentrated-liquidity vault on Sui. A strategy is encrypted client-side and gated by a Move access policy enforced through Seal. A deterministic keeper decrypts it, evaluates it, and executes — routing every rebalance **maker-first onto DeepBook**, falling through to a Cetus taker swap only when the order book cannot fill. Every decision is published to Walrus in a form that can be replayed and checked.

Strategy parameters are not readable on-chain. Not by other LPs, not by searchers, and — once the roadmap's attestation gate lands — not by the keeper operator either.

## Contents

- [Motivation](#motivation)
- [How it works](#how-it-works)
- [Sui stack](#sui-stack)
- [Architecture](#architecture)
- [Execution router](#execution-router)
- [Verifiable determinism](#verifiable-determinism)
- [Storage lifecycle](#storage-lifecycle)
- [Privacy model](#privacy-model)
- [Security model](#security-model)
- [Getting started](#getting-started)
- [Repository layout](#repository-layout)
- [Deployed artifacts](#deployed-artifacts)
- [Scope](#scope)
- [Measurement](#measurement)
- [Prior work](#prior-work)
- [Limitations](#limitations)

## Motivation

Automated CLMM liquidity management is not new on Sui. Cetus Vaults has shipped since March 2024; NODO has operated AI-managed vaults since mid-2025. Both leave two problems open.

**Strategies are public.** A rebalance rule is either published outright or recoverable from three or four observed rebalances. Two consequences follow. Anyone can replicate it at zero cost. And a searcher who knows the trigger can push the pool price onto it, force a rebalance into an unfavourable range, and unwind — a manipulation that costs the attacker a round trip and costs the LP a position.

**Execution cost compounds.** Reaching the target asset ratio for a new range requires a swap on every rebalance. Executed as a taker, that swap pays the pool fee tier plus slippage, every turn. Above modest turnover this — not impermanent loss — determines whether the position beats holding.

Aphotic addresses both using primitives that post-date the incumbents.

## How it works

**Encrypted strategy.** Parameters are serialized with fixed-length padding and encrypted client-side with the Seal SDK, against an identity namespaced to the vault object and carrying a version epoch. Decryption requires a *t*-of-*n* threshold of Seal key servers, each of which dry-runs `aphotic::vault::seal_approve` before releasing a key share. The ciphertext is small enough to sit in the vault object; it is written to Walrus as well so that it remains immutable, versioned, and retrievable without the operator ([details](#storage-lifecycle)).

**Maker-first execution.** On each rebalance the router computes the required swap size, reads the DeepBook order book, and posts the fillable portion as a `POST_ONLY` maker order. Only the residual routes to Cetus. The vault earns the spread on most turns instead of paying it.

**Replayable decisions.** Every evaluation is recorded with its inputs — oracle reads and the level-2 book snapshot that produced the routing choice — and written to Walrus. Anyone can re-run the published decision function against those inputs and confirm the keeper behaved as specified.

**Pooled positions.** Deposits enter an omnibus vault holding aggregate positions. Individual depositors are not attributable to individual ranges, and opposing flows net internally before reaching a venue.

**Onboarding without a wallet.** zkLogin with sponsored transactions: a first deposit requires a Google login and no SUI for gas. Custody remains with the depositor throughout.

## Sui stack

| Primitive | Work it performs | Load-bearing because |
|---|---|---|
| **Move + object model** | Vault as a shared object; strategy access policy; scoped capabilities; constraint envelope, including an on-chain read of the Walrus blob object to confirm the strategy is still retrievable | The security model *is* the Move code. Without it the keeper is a trusted operator holding user funds |
| **Seal** | `seal_approve` authorizes every decryption; identity is namespaced to the vault object and carries a version epoch for revocation and for scoped historical disclosure | Strategy confidentiality is the product thesis. Remove Seal and there is no product |
| **Walrus** | Holds the keeper's decision log — the oracle reads and DeepBook book snapshots behind every action — so determinism can be re-derived by anyone. Also holds versioned strategy ciphertexts: immutable, content-addressed, retrievable without the operator | The log is unbounded and each book snapshot is kilobytes; it cannot live in a Sui object. This is what turns "deterministic" from a claim into something checkable |
| **DeepBook v3** | Primary execution venue: `BalanceManager` custody, `POST_ONLY` maker orders, level-2 book queries for routing, flash loans for atomic rebalance | This is the cost-reduction mechanism, not a fallback route. It is why the strategy can clear its own turnover |
| **zkLogin** | Wallet-free deposit path with sponsored gas | LP automation is a retail product. Requiring a funded Sui wallet before the first deposit is the real conversion barrier |

## Architecture

```
                            ┌──────────────────────────────────────┐
    deposit (zkLogin) ─────►│  VAULT — Sui shared object           │
                            │   • share accounting (NAV)           │
                            │   • constraint envelope (Move)       │
                            │   • strategy ciphertext + blob id    │
                            │   • DeepBook BalanceManager          │
                            └───────────────┬──────────────────────┘
                                            │  TradeCap only
                                            │  (never WithdrawCap)
                                            ▼
      Seal    ◄─── seal_approve ───   ┌─────────────────┐
      (t-of-n key servers)            │     KEEPER      │  off-chain, deterministic
                                      │                 │
      Walrus  ◄─── ciphertext ────    │   evaluate()    │
              ───► decision log ──►   │   route()       │
                                      └────────┬────────┘
                                               │
                      ┌────────────────────────┴────────────────────────┐
                      ▼                                                 ▼
                DeepBook (CLOB)                                   Cetus (CLMM)
          maker-first POST_ONLY,                            position open/close,
          IOC sweep, flash loans                             taker residual, TWAP oracle
                                               ▲
                                               │
                                    Pyth  ─────┘  divergence circuit breaker
```

## Execution router

The core mechanism. When a trigger fires, the vault must move from range `[a, b]` to `[a', b']`, which implies a target asset ratio and therefore a required swap of size δ.

1. Compute δ and the marginal execution price available on the Cetus pool.
2. Query the DeepBook level-2 book. Determine the size fillable at or better than the Cetus marginal price.
3. Split the order:
   - **maker leg** → `POST_ONLY` limit order on DeepBook with `expire_timestamp`
   - **residual** → IOC on DeepBook where the book beats Cetus, otherwise a Cetus taker swap
4. After `MAKER_TIMEOUT_MS`, cancel any unfilled maker remainder and re-route it as taker. The timeout is a strategy parameter, and therefore encrypted.
5. Self-match prevention is enabled: the vault can be resting on the book while an aggregator routes another of its own orders through DeepBook.

Where a rebalance must be atomic — close, swap, reopen with no exposure between steps — the sequence runs in a single PTB against a DeepBook flash loan. The `FlashLoan` hot potato must be returned before the PTB ends or the transaction reverts, which supplies atomicity without additional machinery. The loan is drawn from a different pool than the one being traded, since borrowed funds are no longer available to that pool's matching engine.

Trading fees are payable in DEEP or in the input token. The router supports both paths and selects on held inventory.

## Verifiable determinism

The keeper is rule-based rather than model-driven. That claim is worth nothing unless it can be checked, so every evaluation is recorded in replayable form.

| Field | Contents |
|---|---|
| `oracle` | Pyth price object id and sequence number, plus the Cetus TWAP observation |
| `book` | DeepBook level-2 snapshot at decision time — the heavy field, and the one that makes the routing choice checkable |
| `strategy_blob` | blob id of the strategy version in force at that moment, not the current one |
| `ruleset` | content hash of the compiled decision function |
| `decision` | resulting action: target range, δ, maker/taker split — or an explicit no-op with its cause |
| `result` | transaction digest, or the reason no transaction was issued |

Log segments are written to Walrus and their blob ids emitted on-chain. A Walrus blob id is derived from the blob's content, so the on-chain pointer is self-certifying: a segment cannot be substituted for different bytes after the fact.

```bash
npx ts-node src/index.ts verify --vault <VAULT_ID> --from-epoch <N>
```

The command fetches the log segments, re-runs the published decision function against the recorded inputs, and reports any decision that fails to reproduce.

**Two verification tiers, stated honestly.** Checking that a *trigger* fired correctly requires the strategy plaintext, so full verification is available to the owner and to anyone the owner grants access. Checking that the *routing* was correct does not: given the recorded δ and the recorded book snapshot, whether the maker/taker split was optimal is publicly checkable by anyone. Because Seal identities carry a version epoch, an owner can also disclose a single historical strategy version — making one past window fully public-verifiable — without exposing the strategy currently in force.

## Storage lifecycle

Walrus and Seal are complementary layers, not alternatives: Walrus stores without hiding, Seal hides without storing.

**Encrypt before upload, always.** All blobs stored on Walrus are public and discoverable, contents and metadata alike, and blob ids are not secrets. Nothing reaches a publisher unencrypted.

**Blobs expire, and expiry is a liveness risk.** Blob lifetime is set by an `epochs` parameter at write time, and defaults to a single epoch if omitted. A lapsed strategy blob is a vault that cannot be evaluated. Three mitigations, all implemented:

- `WALRUS_EPOCHS` is set explicitly and long; nothing relies on the default.
- A renewal task extends lifetime before expiry, and alerts if it cannot.
- `envelope.move` reads the Walrus blob object on-chain and requires it to be certified, before its expiry epoch, and not deletable — before permitting a keeper action. The vault also retains the ciphertext in-object, so an expired blob degrades verifiability rather than halting the vault.

**Ciphertext is public for as long as anyone keeps a copy.** This is a permanent property, not a transient one, and it is stated in [Limitations](#limitations).

## Privacy model

Stated precisely.

| Hidden | Visible |
|---|---|
| Strategy parameters: thresholds, range widths, order sizes, cadence, venue preference | That a vault exists, and its aggregate TVL |
| Which depositor runs which strategy | The vault's current positions and tick ranges |
| Pending triggers, prior to firing | That a rebalance occurred, and the range it produced |
| Strategy family — event shapes are uniform across rebalance, DCA and dip-buy | Transaction timing and gas consumption |

Aphotic provides **pre-trade confidentiality and *k*-anonymity within the pool**. It is not on-chain invisibility and it is not a shielded pool. An observer can see what the vault did; they cannot recover the rule that produced it, cannot anticipate the next action, and cannot attribute any action to an individual depositor.

Three mitigations resist inference from repeated observation:

- **Jitter** — randomized delay and size perturbation on every action, bounded so execution cannot degrade beyond a configured tolerance.
- **Netting** — depositors rebalancing in opposite directions cancel internally before any order reaches a venue.
- **Hysteresis** — asymmetric entry and exit bands, so trigger points are not recoverable from the regularity of firing.

The decision log is a deliberate disclosure surface and is published on a lag, so that a live log cannot be used to front-run the vault's own pending maker orders.

## Security model

The keeper runs off-chain. Everything below exists so that this does not require trusting it.

**Capability scoping.** DeepBook's `BalanceManager` issues `DepositCap`, `WithdrawCap` and `TradeCap` independently. The keeper holds only `TradeCap`. It can place and cancel orders; it cannot move funds out. A fully compromised keeper cannot steal.

**Constraint envelope, enforced in Move.** Every keeper action is checked on-chain against limits fixed at vault creation:

| Constraint | Enforcement |
|---|---|
| Maximum slippage per action | bps bound, checked against oracle mid |
| Maximum notional per epoch | cumulative, resets on epoch boundary |
| Venue allowlist | pool ids fixed at creation |
| Minimum rebalance cooldown | clock-based |
| Strategy availability | Walrus blob object read: certified, unexpired, not deletable |
| Global pause | owner-only |
| Emergency withdraw | owner-only, never keeper-gated |

**Oracle safety.** Trigger evaluation reads both Pyth and the Cetus pool TWAP. If the two diverge beyond a configured threshold, evaluation refuses to run. This closes the manipulation path in which an attacker moves the pool to force a rebalance into a disadvantageous range.

**Key rotation.** Seal identities carry a version epoch. Rotating the keeper increments it, invalidating previously derived key shares. A `set_keeper` call alone would not achieve this.

**Residual trust, and the fix.** The keeper operator can read decrypted strategies while they are resident in memory. The remedy is Nautilus: gate `seal_approve` on a TEE attestation whose PCR measurements are registered on-chain, so key shares are released only to an enclave running the published keeper binary. The operator can then execute the strategy but not read it. Out of scope for the event; the interface is designed for it.

## Getting started

**Prerequisites** — Sui CLI (testnet), Node.js 18+, a funded Sui testnet address.

```bash
git clone https://github.com/<org>/aphotic && cd aphotic
```

**Move package**

```bash
cd move
sui move build
sui move test
sui client publish --gas-budget 200000000
```

**Keeper**

```bash
cd keeper
npm install
cp .env.example .env          # see table below
npx ts-node src/index.ts create-vault --strategy ./examples/rebalance.json
npx ts-node src/index.ts run --vault <VAULT_ID>
```

**Verify a keeper's history** — requires no keys, and no relationship with the operator:

```bash
npx ts-node src/index.ts verify --vault <VAULT_ID> --from-epoch <N>
```

**App**

```bash
cd app
npm install
npm run dev
```

| Variable | Purpose |
|---|---|
| `SUI_NETWORK` | `testnet` |
| `OWNER_KEY` | vault creation, deposits, emergency actions |
| `KEEPER_KEY` | holds `TradeCap` only; needs gas and nothing more |
| `APHOTIC_PACKAGE_ID` | published package id |
| `WALRUS_PUBLISHER` / `WALRUS_AGGREGATOR` | write and read endpoints |
| `WALRUS_EPOCHS` | blob lifetime; set explicitly, never left to the one-epoch default |
| `SEAL_THRESHOLD` | key server threshold (default `2`) |
| `SEAL_KEY_SERVERS` | comma-separated server object ids forming the committee |
| `DEEPBOOK_POOL` / `CETUS_POOL` | SUI/USDC venues |
| `PYTH_PRICE_ID` | SUI/USD feed |
| `MAKER_TIMEOUT_MS` | maker leg cancel-and-reroute window |
| `LOG_PUBLISH_LAG_MS` | delay before a decision segment is published |

Keys are read from the environment only. They are never logged, printed or committed; `.env` is gitignored.

## Repository layout

```
aphotic/
├── move/
│   ├── Move.toml
│   └── sources/
│       ├── vault.move           # shared object, share accounting, seal_approve
│       ├── envelope.move        # constraint checks, incl. Walrus blob availability
│       ├── router.move          # execution entrypoints, DeepBook + Cetus calls
│       ├── journal.move         # decision-log blob ids, emitted on-chain
│       └── tests/
├── keeper/                      # TypeScript, off-chain
│   └── src/
│       ├── strategy/            # schema, padded serializer, evaluation rules
│       ├── privacy/             # Seal encrypt/decrypt, session keys, key rotation
│       ├── storage/             # Walrus put/get, lifetime renewal, blob attestation
│       ├── routing/             # L2 book queries, split logic, order lifecycle
│       ├── execution/           # PTB construction, flash-loan rebalance
│       ├── oracle/              # Pyth + TWAP, divergence breaker
│       ├── journal/             # decision records, segment writer
│       └── verify/              # replay engine — the `verify` command
├── app/                         # React + Vite
│   ├── deposit/                 # zkLogin + sponsored transactions
│   ├── builder/                 # strategy builder, client-side encryption
│   └── transparency/            # public vs private surface; decision log viewer
└── analysis/
    └── backtest/                # fee APR vs LVR on historical SUI/USDC
```

## Deployed artifacts

| Item | Value |
|---|---|
| Network | Sui testnet |
| Package id | `<fill>` |
| Vault id | `<fill>` |
| DeepBook `BalanceManager` | `<fill>` |
| Cetus SUI/USDC pool | `<fill>` |
| Example maker fill | `<fill>` |
| Example flash-loan rebalance | `<fill>` |
| Strategy blob (Walrus) | `<fill>` |
| Decision log segment (Walrus) | `<fill>` |

## Scope

**In scope.** Vault Move package with share accounting, versioned `seal_approve` and the constraint envelope · client-side encryption with the ciphertext held in-object and mirrored to Walrus · decision log written to Walrus with blob ids emitted on-chain, and a working `verify` command · DeepBook `BalanceManager` owned by the vault with `TradeCap` delegated to the keeper · the maker-first router, live on testnet · one strategy family (range rebalance) executed end to end · zkLogin deposit path · transparency panel.

**Out of scope.** Nautilus attestation gating · concurrent strategy families · a full backtest framework — one measured comparison ships, not a harness · mainnet.

The trade is deliberate. One strategy that routes correctly across CLOB and CLMM is worth more than three that all execute as takers.

## Measurement

An APY figure without a denominator is not evidence. The submission includes one comparison on historical SUI/USDC data with execution costs included:

- fee revenue against **LVR** (loss-versus-rebalancing) over the window
- net result against **holding**
- net result against a **passive 50/50** position
- maker fill rate, and realized saving against an all-taker counterfactual

If maker-first routing produces no measurable saving, that is the finding and it is reported as such.

## Prior work

A contributor has previously built CLMM keeper prototypes on Sui in a hackathon setting. This repository is a from-scratch build begun at the start of the event. The architecture is different (omnibus multi-depositor vault rather than single-owner), the execution model is new (DeepBook maker-first routing appears in no prior work), and the trust model is new (scoped capabilities, an on-chain constraint envelope, and a replayable decision log). No code is carried over; the commit history reflects this. Disclosed proactively.

## Limitations

- **Unaudited.** Testnet only, experimental software. Use test funds.
- **Cetus dependency.** Cetus was exploited in May 2025 for approximately $223M via an integer overflow in its concentrated-liquidity math. Aphotic inherits exposure to those contracts. Routing the majority of flow through DeepBook reduces, but does not eliminate, that surface.
- **Ciphertext is permanently public.** Walrus blobs are readable by anyone, and anyone may retain a copy indefinitely. If the Seal threshold is ever broken, historical strategies leak retroactively. Rotate versions; do not treat a past strategy as confidential forever.
- **Blob expiry is a liveness dependency.** Renewal is automated and the vault retains an in-object ciphertext copy, but an unrenewed log segment becomes unverifiable once it lapses.
- **Testnet book depth is thin.** Routing results from a testnet demonstration are directionally indicative, not economically meaningful. The measurement section uses historical mainnet data instead.
- **Privacy is inference-resistant, not absolute.** A determined observer with a long window and a narrow hypothesis space may still learn something about strategy family. The decision log widens this surface by design, which is why it publishes on a lag.
- **Threshold assumption.** A collusion of *t* Seal key servers together with the keeper would recover strategy plaintext.

## License

MIT. See [LICENSE](LICENSE).
