# GOLDEN-RULES.md — read FIRST, re-check before any Hashi/DeepBook/oracle claim or code

> Purpose: the guardrail doc. These are hard-won corrections from three verification passes. Violating one produces either a wrong implementation or a claim a MystenLabs judge kills in ten seconds. Short, blunt, imperative.
> Read after: nothing — read this FIRST, then `docs/FACTS.md`.
> Canonical values (IDs/signatures) live in `docs/FACTS.md`; this doc is the WHY + the NEVER.

## The 10 rules

### G1 — hBTC is a fungible coin; Bitcoin latency lives ONLY at the mint/burn boundary
- **Rule:** hBTC is a standard fungible `Coin<hashi::btc::BTC>` (8 dec, sats, unregulated). Moving/splitting/merging it on Sui settles in ONE checkpoint (sub-second). Bitcoin/Guardian latency exists ONLY at deposit-mint and withdraw-burn.
- **Why:** source-verified (`btc.move`, `treasury.move`). It is not a position object.
- **NEVER** claim Bitcoin latency protects, delays, or gates any on-Sui operation (share moves, NAV updates, order placement). **NEVER** model hBTC as a non-fungible/position object.

### G2 — Keeper holds ONLY a DeepBook `TradeCap`
- **Rule:** the keeper can place/cancel orders and nothing else. Exits are composed in Move (`gateway::exit_to_bitcoin`) to a Bitcoin address pinned on-chain at deposit and immutable thereafter.
- **Why:** this is the entire non-custodial thesis — a fully compromised keeper can neither steal nor redirect funds.
- **NEVER** give the keeper `WithdrawCap` or `DepositCap`. **NEVER** let the exit destination be a runtime/keeper input; it is write-once at deposit.

### G3 — You cannot buy priority in Hashi's global withdrawal queue
- **Rule:** the Guardian bucket **rejects** over-capacity batches (`RateLimitExceeded`), it does not hold an orderable queue. `next_seq` is a per-batch counter assigned off-chain by a committee leader ("generally FIFO, not strict").
- **Why:** source-verified (`limiter.rs`, `withdraw.move`). A protocol can only ration the RATE at which it calls `request_withdrawal` and order its OWN pending exits — never jump the global queue.
- **NEVER** design a feature that assumes buying/holding a global queue slot or guaranteeing prompt native-BTC delivery you don't control.

### G4 — No Cetus hBTC pool: router is DeepBook maker + IOC only
- **Rule:** router = DeepBook `POST_ONLY` maker + IOC sweep on the SAME `Pool<hBTC,DBUSDC>`. No Cetus taker leg, no CLMM ranges for the BTC vault.
- **Why:** verified — no Cetus hBTC pool exists. (The base `README (8).md` SUI/USDC design uses Cetus/CLMM; that path does NOT carry to the BTC vault.)
- **NEVER** add a Cetus dependency or CLMM range logic to the BTC vault. **NEVER** let `README (8).md`'s Cetus router leak in.

### G5 — The limiter is TRUSTLESSLY replayable, not a trusted SDK read
- **Rule:** the Guardian `LocalLimiter` is advanced purely by on-chain `WithdrawalSigned` events via `project_capacity() = min(cap, tokens + elapsed*refill_rate)`. `verify/` re-derives the whole bucket trajectory from the `WithdrawalRequested/PickedForProcessing/Signed` stream. Only two genesis scalars (`refill_rate`, `max_bucket_capacity`) are trust anchors, both observationally boundable.
- **Why:** this is the strongest form of Aphotic's verifiable-determinism thesis. The SDK `guardian.limiterStatus` is a convenience read, not the source of truth.
- **NEVER** frame the congestion/limiter signal as "we trust an SDK call." The MOCK and `verify/` MUST import ONE identical `projectCapacity` function (`keeper/src/hashi/limiter.ts`) — arg order `(tokens, refillRate, cap, elapsedMs)` per `docs/KEEPER.md` §2.4.

### G6 — The BTC leg is never live-demoable
- **Rule:** deposit ~70 min, withdrawal ~1.5–2 h. Pre-stage confirmed hBTC and a broadcast withdrawal. The Sui side is instant; show an earlier confirmed signet tx in an explorer.
- **Why:** signet confirmations + committee delays cannot fit a 3-minute demo.
- **NEVER** put a live Bitcoin confirmation in the demo critical path. Demo congestion by REPLAY, not live saturation.

### G7 — Isolate ALL Hashi behind an adapter + deterministic MOCK from line one
- **Rule:** one TypeScript adapter interface wraps every Hashi touchpoint; a deterministic MOCK (mirroring `project_capacity` exactly) lets the whole system run with no live Hashi. On-chain Hashi calls are confined to `gateway.move`. All IDs come from config/env, never literals in logic.
- **Why:** Hashi testnet is days old and will ship breaking changes. Isolation = the demo never blocks on a fresh endpoint.
- **NEVER** call the Hashi SDK or `hashi::` Move functions outside the adapter / `gateway.move`. **NEVER** hardcode a canonical ID outside `config.ts` / `.env.example`.

### G8 — Pitch honesty: differentiate on the machinery, not the token's trust model
- **Rule:** hBTC IS custodial-threshold wrapped BTC (threshold Schnorr + Guardian 2-of-2 + ~60-day recovery leaf). State this plainly. The differentiation is composing the bridge's on-chain machinery: Move-pinned exits, the trustlessly-verifiable bridge-aware envelope, the permissionless deposit crank, the peg-flow signal.
- **Why:** a Mysten judge will test whether you understand your own dependency; honesty about the trust model is a credibility asset.
- **NEVER** claim hBTC is trustless or non-custodial. **NEVER** claim the differentiation is the token.

### G9 — Pin Pyth, use the Beta feed, value at DeepBook mid
- **Rule:** on testnet use the Pyth **Beta-channel** BTC/USD feed id (verify via Hermes, `docs/DAY-ONE.md` D5); pin Pyth State + package versions (DAO auto-upgrade 2026-08-18); add staleness guards. Value NAV/collateral at the live **DeepBook mid**, not raw oracle price (hBTC depeg defence). Oracle-divergence breaker = Pyth vs DeepBook TWAP.
- **NEVER** hardcode the stable/mainnet feed id on testnet. **NEVER** value hBTC at raw Pyth BTC/USD.

### G10 — Move 2024 idioms; sats; events; error constants
- **Rule:** Move 2024 edition throughout. Amounts in sats (`u64`). Emit an event for every externally-visible state transition. Error constants named `E<Reason>`. Tests under `tests/`.

---

## Common mistakes to avoid (corrected in earlier design passes — do not re-introduce)

1. **Treating hBTC as an object/position.** It's a fungible `Coin<BTC>` (G1). The `struct BTC has key {id}` in source is only the currency witness, not what users hold.
2. **"Bitcoin latency means we don't need instant liquidation / it protects the position."** FALSE — on-Sui movement is instant (G1). Latency is only at the native-BTC boundary.
3. **Assuming you can queue or buy priority in the global bucket.** FALSE — it rejects over-capacity (G3). You ration only your own egress rate.
4. **Framing the limiter as a trusted SDK read.** It's trustlessly replayable from events (G5).
5. **Adding a Cetus taker leg or CLMM ranges to the BTC vault.** No Cetus hBTC pool (G4).
6. **The keeper ever touching `WithdrawCap`.** TradeCap only (G2).
7. **Trying to live-demo the BTC deposit/withdraw leg.** Pre-stage; show replay + an earlier signet tx (G6).
8. **Citing unverifiable prior art (e.g. "Wift").** No public record was found; never present it to the jury.
9. **Importing the shelved "Meridian" bond mechanics** (`BTC_FIXED_INCOME.md`) — PT/YT on non-yield-bearing hBTC is out of scope and economically ill-posed here. Aphotic is a market-making vault, not a bond.
10. **Valuing collateral/NAV at raw Pyth** instead of DeepBook mid (G9) — ignores hBTC depeg under exit throttling.
11. **Hardcoding IDs in logic** instead of config (G7) — Hashi testnet IDs can move.

## Pitch honesty (say these on record — they are credibility assets)

- "hBTC is custodial-threshold wrapped BTC; we don't hide that. Our edge is composing the bridge's on-chain machinery."
- "Liquidation/order flow is instant on Sui — Bitcoin latency never touches on-Sui operations. It lives only at the native-BTC boundary, and there we make it trustlessly verifiable."
- "We ration our own egress and verify the bridge's congestion by replaying Hashi's own `WithdrawalSigned` events — we do not, and cannot, buy priority in Hashi's global queue."
- "The keeper holds only a DeepBook TradeCap; it can trade, it can never take. Exits are pinned in Move at deposit."
