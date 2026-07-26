# DEPLOY.md — shipping `app/` to Vercel

> Purpose: the exact steps to put `app/` on Vercel, and the one class of mistake that silently
> breaks it (build-time env inlining).
> Only `app/` is deployed — `move/`, `lending/`, `sdk/`, `clearing-rs/` and `keeper/` are not
> web-servable.
>
> **Updated 2026-07-26.** Everything in this file was executed, not quoted. The live output of
> each command is reproduced below it.

## 0. Status of record

| Thing | Value |
|---|---|
| Vercel project | `adrianverdes27-gmailcoms-projects/aphotic` (owner `aiden778`) |
| Production alias | **https://aphotic-taupe.vercel.app** |
| Git repo connected | `aydi26/sui-lisbon` — so a push to `main` also triggers a build |
| Env vars pushed | 24 of 36 (the 12 empty ones are the unpublished v2 ids — see §3) |

> ⚠ **The live production deploy is a `--prebuilt` bridge deploy** (2026-07-26). At the time it was
> made, `app/src/lib/notes.ts:391` failed `tsc --noEmit`
> (`TS2322: Type 'EventId | undefined' is not assignable to …`), which fails
> `npm --prefix app run build` and therefore fails a normal Vercel build. `vite build` alone is
> unaffected (esbuild strips types without checking them), so the bundle that is live is correct —
> but it was produced locally and uploaded, bypassing the typecheck.
>
> **Once that error is fixed, go back to the normal path — one command, nothing else to undo:**
>
> ```bash
> cd app && npm run build          # must be green FIRST
> cd .. && npx vercel deploy --prod --yes
> ```
>
> The committed `vercel.json` is what that command uses and it is correct. Delete `.vercel/output`
> afterwards so no stale prebuilt bundle can be uploaded by accident.

---

## 1. THE TRAP — read this before anything else

**Vite inlines every `VITE_*` at BUILD time. Nothing reads them at runtime.**

A variable that is missing from the Vercel project environment does **not** throw. It compiles to
the empty string `""`, the bundle ships, the site loads, and the app renders as though the chain
simply had no data. There is no stack trace, no 500, no red console line — just a product that
looks broken in a way that reads like a chain problem.

Three consequences, all of which have bitten this repo:

1. **Changing a variable in the Vercel dashboard does nothing until you redeploy.** The value is
   baked into `assets/index-*.js`. Editing it and refreshing the page changes nothing.
2. **Every `VITE_*` value ends up in the public JavaScript bundle.** Only public values may go
   there: the Enoki `enoki_public_…` key and the Google OAuth *client id* are public by design.
   The Enoki `enoki_private_…` key, an OAuth *client secret*, and any Sui private key must never
   be a `VITE_*` variable — see §7.
3. **A build with no env at all still succeeds.** `npm run build` is green either way.

The app's only defence is `app/src/config.ts` → `configProblems()`, which is rendered at the top of
every screen and names each missing key with what it breaks (`blocking` vs `degraded`). Treat that
banner as the deploy's smoke test: **if it lists anything on production, the deploy is not done.**

---

## 2. What is deployed, and the repo-level config

Only the Vite SPA in `app/`. The keeper is a long-running Node process holding a signing key —
a serverless platform is the wrong shape for it; see §8.

Both config files live at the **repo root**, not in `app/`, because the Vercel Root Directory is
`./` and `vercel.json` reaches into `app/` itself.

| File | Role |
|---|---|
| `vercel.json` | Install/build/output commands, the SPA rewrite, cache + security headers. `"framework": null` so no preset overrides them. |
| `.vercelignore` | Keeps `move/`, `lending/`, `keeper/`, `clearing-rs/`, `scripts/`, `docs/`, the test trees and every `.env` out of the upload. |

```jsonc
"installCommand":  "npm --prefix app ci",        // needs app/package-lock.json (committed)
"buildCommand":    "npm --prefix app run build", // = tsc --noEmit && vite build
"outputDirectory": "app/dist",
"rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]
```

### ⚠ LANDMINE: never set `cleanUrls: true`

It was set, and it broke every deep link. `cleanUrls` turns `/index.html` into a **308 redirect** to
`/`, so the rewrite's destination stops resolving to a file. The symptom is deceptive — the home
page works and every other route 404s:

```
$ curl -o /dev/null -w "%{http_code}" https://aphotic-taupe.vercel.app/vault
404                              # with cleanUrls: true
200                              # after removing it
```

If deep links 404 again, check that key first.

### The rewrite and the routes

Every route in `app/src/routes.tsx` is client-side with no file behind it, so the catch-all rewrite
is mandatory. Vercel matches real static files *before* rewrites, so `/assets/*`, `/fonts/*`,
`/globe/*` and `/logos/*` are unaffected.

**Because the rewrite is a catch-all, `vercel.json` never needs editing when routes change.** Read
the current route list from `app/src/routes.tsx` — today it is `/`, `/vault`, `/batch`, `/verify`.

### Cache headers

- `/assets/*` and `/fonts/*` — `max-age=31536000, immutable`. Safe: Vite content-hashes them.
- `/globe/*`, `/logos/*` — 7 days. Not hashed, but they change ~never.
- **everything else — `no-cache, no-store, must-revalidate`.** This is what stops a stale
  `index.html` from pinning a browser to a dead `assets/index-<oldhash>.js` after a redeploy. It is
  written as a negative lookahead (`/((?!assets/|fonts/|globe/|logos/).*)`) so that no path is ever
  matched by two competing `Cache-Control` rules.

### ⚠ `.vercelignore` and `sdk/src`

`app/tsconfig.json` maps `"@aphotic/sdk/*" → "../sdk/src/*.ts"` and includes `src`, so the moment
any file under `app/src` imports `@aphotic/sdk`, **`tsc --noEmit` reaches outside `app/`**.
`sdk/src/` is therefore deliberately *not* excluded. Excluding it turns a green local build into a
red Vercel build with a confusing `TS2307: Cannot find module`.

---

## 3. Environment variables — never transcribe them

> **The id list is NOT reproduced in this file, on purpose.** A transcribed object id goes stale
> silently the moment a package is republished. `app/.env.example` is the single source; read it.

`app/.env.example` is the canonical list of every `VITE_*` the build consumes. It is annotated:
`[RECON Rn]` = verified live on testnet, do not re-derive; `[v2]` = filled in at publish time.

Print the current full list at any moment:

```bash
grep -oE '^VITE_[A-Z0-9_]+' app/.env.example        # every variable the build reads
grep -nE '^VITE_[A-Z0-9_]+=\s*(#|$)' app/.env.example   # the ones still blank
```

`app/src/config.ts` supplies a correct default for the network, Hashi, DeepBook, Walrus-aggregator
and explorer values, so a missing one of those degrades rather than breaks. The variables with **no
default** — and therefore the ones a deploy must actually carry — are exactly the keys listed by
`configProblems()` in `app/src/config.ts`: the eight Aphotic v2 object ids, the Seal committee ids,
the Walrus publisher, and the two zkLogin values.

### Push the whole set to Vercel in one shot

This reads `app/.env.local` (gitignored, never uploaded) and pushes every non-empty value to the
Production and Preview scopes. Empty values are skipped — an unset variable and an empty one are
the same thing to Vite.

```bash
while IFS= read -r line; do
  case "$line" in VITE_*=*) ;; *) continue;; esac
  k="${line%%=*}"; v="${line#*=}"
  v="$(printf '%s' "$v" | sed -E 's/[[:space:]]+#.*$//; s/[[:space:]]+$//')"
  [ -z "$v" ] && { echo "SKIP (empty) $k"; continue; }
  printf '%s' "$v" | npx vercel env add "$k" production --force >/dev/null 2>&1 &&
  printf '%s' "$v" | npx vercel env add "$k" preview    --force >/dev/null 2>&1 &&
  echo "OK   $k" || echo "FAIL $k"
done < app/.env.local
```

Observed 2026-07-26: `added=24 skipped=12`. The 12 skipped are the unpublished v2 ids
(`VITE_APHOTIC_PACKAGE_ID`, `VITE_VAULT_ID`, `VITE_GOVERNANCE_ID`, `VITE_BATCH_REGISTRY_ID`,
`VITE_NOTE_TREE_ID`, `VITE_NULLIFIER_SET_ID`, `VITE_BALANCE_LEDGER_ID`,
`VITE_ADAPTER_ALLOWLIST_ID`, …) plus three intentionally-blank ones.

**When the v2 package is published**, the ids land in `app/.env.example` / `app/.env.local`. Rerun
the loop above and then **redeploy** — §5. Setting them without redeploying changes nothing (§1).

---

## 4. Enoki / Google must know the deployed origin

zkLogin returns a 403 (Enoki) or `redirect_uri_mismatch` (Google) unless the **deployed origin** is
registered in **both** places, alongside `http://localhost:5173`.

1. **Enoki portal** — https://portal.enoki.mystenlabs.com → your app → *Allowed origins* → add
   `https://aphotic-taupe.vercel.app` (and any custom domain).
2. **Google Cloud console** → APIs & Services → Credentials → your OAuth 2.0 **Web application**
   client. The same origin must appear in **both** lists:
   - **Authorised JavaScript origins** → `https://aphotic-taupe.vercel.app`
   - **Authorised redirect URIs** → `https://aphotic-taupe.vercel.app`

   Registering only the first is the classic mistake: sign-in then fails with
   `redirect_uri_mismatch`. Google also refuses any non-`localhost` `http://` origin.
3. Confirm the Google client id is registered under the Enoki app's Google provider.

Verify — the script takes any origin, and normalises a bare host, a trailing slash or a deep link
down to the `scheme://host[:port]` form Enoki actually stores:

```bash
node scripts/check-enoki.mjs https://aphotic-taupe.vercel.app
node scripts/check-enoki.mjs aphotic-taupe.vercel.app          # same thing
node scripts/check-enoki.mjs http://localhost:5173             # default
node scripts/check-enoki.mjs <origin> --key=enoki_public_…     # without app/.env.local
```

Real output, 2026-07-26:

```
Enoki configuration check
  key       enoki_public_eaf3a…7b06
  origin    https://aphotic-taupe.vercel.app

  PASS  api key accepted by Enoki
  PASS  google provider registered — client id 901837773954-8irovvde51i7o2t9qgnv6k9ttm399fr5.apps.googleusercontent.com
  PASS  VITE_ZKLOGIN_CLIENT_ID matches the portal
  FAIL  https://aphotic-taupe.vercel.app is not allow-listed (registered: http://localhost:5173)
```

⇒ **Action outstanding.** Until that origin is added in the Enoki portal *and* the Google client,
Google sign-in is dark on production. A browser wallet still works, and `configProblems()` reports
this as `degraded`, not `blocking`.

Vercel **preview** deployments get a different hostname per commit and cannot be pre-registered.
Either register a stable preview alias, or accept that zkLogin works on production and localhost
only.

---

## 5. Deploy

The project is already linked (`.vercel/` at the repo root) and the CLI is authenticated as
`aiden778`. From the repo root:

```bash
npx vercel deploy --prod --yes      # production → the aphotic-taupe alias
npx vercel deploy --yes             # preview → a per-deploy hostname
```

If the CLI is not authenticated in your shell, `npx vercel login` first (it opens a browser), or
export a token: `export VERCEL_TOKEN=…` and append `--token "$VERCEL_TOKEN"` to every command.

A deploy runs `installCommand` then `buildCommand` **on Vercel**, so a broken `app/src` fails the
deploy, not just your laptop. Check locally first — it is 12 s versus 2 min:

```bash
cd app && npm run build
```

---

## 6. Verify a deploy

```bash
U=https://aphotic-taupe.vercel.app
for p in / /vault /batch /verify /logos/aphotic-mark.svg /globe/earth-blue-marble.jpg; do
  printf '%s  %s\n' "$(curl -s -o /dev/null -w '%{http_code}' "$U$p")" "$p"
done
```

All six must be `200`. `/vault`, `/batch` and `/verify` return `200` only because of the rewrite —
a `404` there means the rewrite is broken (first suspect: `cleanUrls`, §2).

Then, by eye on the live site:

- **the config banner** at the top of every screen. It must either be absent, or list exactly the
  variables you know are unset. If it names something you *did* set, you set it after the last
  build — redeploy.
- **the globe** on `/`. Textures are vendored into `app/public/globe/` on purpose: the upstream
  landing page fetched them from jsDelivr at runtime, which fails on venue wifi. A black sphere
  means `/globe/*` is 404ing.
- **bundle size.** Expected shape, from the real build:

  | chunk | raw | gzip |
  |---|---|---|
  | `assets/index-*.js` | 838 kB | 262 kB |
  | `assets/globe-*.js` | 1 834 kB | 522 kB |
  | `assets/LandingPage-*.js` | 36 kB | 12 kB |

  The `globe` chunk is split out **deliberately** in `app/vite.config.ts` (`three`, `three-globe`,
  `globe.gl`) and `LandingPage` is `React.lazy`'d in `routes.tsx`, so **`/vault` never downloads
  the hero**. If `index-*.js` jumps past ~1 MB, something static-imported the landing page — do not
  "fix" it by merging the chunks.

  Vitest 3 loads `app/vitest.config.ts` **instead of** `app/vite.config.ts`. Keep them separate;
  merging them silently changes what the production build emits.

---

## 7. Secrets — the hard line

| Value | May it be a `VITE_*`? |
|---|---|
| `enoki_public_…` API key | **Yes** — public by design, it ships in the bundle. |
| `enoki_private_…` API key | **Never.** `scripts/check-enoki.mjs` refuses one outright. |
| Google OAuth **client id** | Yes — public. |
| Google OAuth **client secret** | **Never.** |
| Any Sui private key / keystore | **Never.** |

`app/.env.local` is covered by both `.gitignore` and `.vercelignore`. No env value is committed to
any file in this repo — `app/.env.example` holds only public ids and blanks.

---

## 8. Not deployed here

- **The keeper** — needs a persistent process and a signing key. Run it on a VM or locally during
  the demo. Nothing on the auction's critical path needs it: close, reveal, clear, settle and claim
  are all permissionless, and `verify_fill` is an on-chain read. A deployed site with no keeper
  should degrade to "nobody is optimising gas for you", not to "the product is down".
- **`sdk/`, `move/`, `lending/`, `clearing-rs/`** — libraries and on-chain packages, nothing to
  serve. (`sdk/src` is still uploaded — see §2.)
- **`VITE_KEEPER_VERIFY_URL`**, if reintroduced, defaults to `http://localhost:8787`, which is
  unreachable from a deployed site. Any "re-run this off-chain" affordance will report the keeper
  as offline.
