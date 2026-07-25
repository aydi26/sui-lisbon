# DEPLOYED.md — Aphotic on Sui testnet

> Purpose: the record of what we actually published on chain, and the receipts.
> These are the ids `keeper/.env` and `app/.env.local` are wired to. When the
> package is upgraded, add a row — never overwrite one, so an old journal entry
> stays resolvable.
> Read after: `docs/RECON.md` (which records the ids we depend on but did not deploy).

## v2 — 2026-07-25 (upgrade)

| What | Id |
|---|---|
| **`aphotic` published-at (call this)** | `0xbf55eecc6c840c576c88e05c469f9753ab5ad9212e04c6cf56564f88929875bf` |
| **`aphotic` original-id (type origin)** | `0xbe433a2726fc61391d180ce55cdb8177f9647760b23a7704d42e3b5b9bb72d66` |
| upgrade digest | `56Us71eqUH82AnhXzxibuTts6y4P7eViA3Le5qFpAGBC` |

Every other object below is **unchanged** — the shared `Vault`, the `BalanceManager`, the caps and their ids all survive the upgrade. `Vault<hBTC,DBUSDC>`'s type string still names the **original** id and always will, exactly like DeepBook's two-id split (`docs/RECON.md` R4). So:

- `moveCall` targets → **published-at** (`0xbf55eecc…`)
- type arguments, type-string checks, and events emitted by v1 → **original-id** (`0xbe433a27…`)

Checking the vault's type against the published-at instead would have started failing the moment we upgraded. `scripts/verify-onchain.mjs` asserts both ids and uses the original for the type check.

**What changed in the code.** One misplaced assertion in `vault::nav_sats`:

```move
// before — a 100%-hBTC vault could not be valued at all without a price
assert!(book_mid != 0, EZeroNav);
let quote = vault.dbusdc.value();
if (quote == 0) return free;
```

`book_mid` converts the **quote** leg and nothing else, so a base-only vault has an exact sats NAV with no price input. The guard fired one line too early, which made the vault unvaluable exactly when the book has no mid — the normal state of a pool nobody else makes a market on, and permanently our state given there are ~16 DBUSDC in existence across the whole testnet. The assertion now sits inside the `quote != 0` branch, where the value is genuinely load-bearing.

Covered by two tests that encode the new semantics precisely: `a_base_only_vault_is_valuable_with_no_price_at_all` and `nav_sats_still_rejects_a_zero_mid_once_the_quote_leg_is_non_empty`.

## v1 — 2026-07-25

| What | Id | Notes |
|---|---|---|
| **`aphotic` package** | `0xbe433a2726fc61391d180ce55cdb8177f9647760b23a7704d42e3b5b9bb72d66` | modules `envelope`, `gateway`, `journal`, `router`, `vault` · Immutable |
| **`Vault<hBTC, DBUSDC>`** | `0xf03832c92d4bf745ac720c52fe9198fc928028ce51991059bfe59c0e4ef374e8` | **Shared**, `initialSharedVersion = 947353676` |
| `VaultCap` | `0x232ed471922011b4083e20bfb7c58f923f8c3fd4691ca5522364ff3d506d9b3d` | owned by the deployer — owner-only controls (pause, envelope, emergency withdraw) |
| DeepBook `BalanceManager` | `0x5766ed0b5e3fd310da9ccd723912198450872d9e2c83a473ed59cd5ab51990e2` | **Shared**, `initialSharedVersion = 947353675` |
| `UpgradeCap` | `0xf2660f561f358e02d88e82ec4792916bdd1193f8553cdd6ab43e81c96fd72ca9` | owned by the deployer |
| Deployer / keeper address | `0xd41b0cd83fc1a497a5899eb686e2c7561e75e6d62db2270860d72542f63f333d` | |

Transaction digests:

| Step | Digest |
|---|---|
| publish | `5hFRU5w5ZZ14wo5dtR9vk7vynF2VknzmPudMJeQ7Qs7t` |
| create + share `BalanceManager` | see `balance_manager::new` tx below |
| `create_vault` | `42EiUjFm52revijuNvjX976KvuxgVQSDzF4fk7Xff8qR` |

Publish cost `136 635 480` MIST (~0.137 SUI). The dry run resolved linkage against
the real `hashi` (`0xfcea10ca…`) and `deepbook` packages with no linker error, so
the on-chain `gateway` genuinely calls the live bridge.

## Envelope parameters fixed at creation

| Parameter | Value | Why |
|---|---|---|
| `max_slippage_bps` | `50` | 0.5 % |
| `max_notional_per_epoch_sats` | `100_000_000` | 1 BTC per epoch |
| `min_cooldown_ms` | `30_000` | keeper action spacing |
| `buffer_ratio_bps` | `2_000` | 20 % redemption buffer |
| `limiter_refill_rate` | `115_740` | **live** Guardian value (DAY-ONE D4) |
| `limiter_max_capacity` | `10_000_000_000` | **live** Guardian value — 100 BTC |
| `epoch_start_ms` | `1784984759062` | creation time |

⚠ The limiter scalars are the values read from the live Guardian, **not** the
`1000` / `100_000_000` prior that older docs carry. That prior is wrong by ~100×.
Because the real bucket is ~100 BTC/day, **never write congestion copy** — the
bridge is not tight, and claiming it is would be false.

## Known-incomplete at v1

- `strategy_ciphertext` and `strategy_blob_id` are one-byte placeholders. They
  are filled when Seal encryption lands (T2.6) and the blob is written to
  Walrus (T2.9). The vault is functional without them; only the strategy
  privacy story depends on them.
- The vault holds no hBTC yet — the signet deposit is still confirming.
- No `TradeCap` has been issued to the keeper yet; that happens when the keeper
  first needs to quote (T2.7). The vault references the `BalanceManager` by ID
  only and never holds a `DepositCap`/`WithdrawCap` (G2).

## Verify these ids yourself

```bash
sui client object 0xbe433a2726fc61391d180ce55cdb8177f9647760b23a7704d42e3b5b9bb72d66
sui client object 0xf03832c92d4bf745ac720c52fe9198fc928028ce51991059bfe59c0e4ef374e8
node scripts/verify-onchain.mjs
```
