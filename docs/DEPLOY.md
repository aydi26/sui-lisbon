# DEPLOY.md — shipping the app to Vercel

> Purpose: the exact steps to put `app/` on Vercel, and the one class of mistake that will silently break it (build-time env inlining).
> Read after: `docs/STATUS.md`. Only `app/` is deployed — `move/`, `lending/`, `sdk/` and `keeper/` are not web-servable.
>
> **Updated 2026-07-26 for the v2 pivot.** Everything mechanical in this file survives unchanged —
> `vercel.json`, the `VITE_*` inlining trap, the Enoki/Google origin registration, the vendored
> globe textures. What changed is **which routes exist** and **which ids the app is wired to**;
> both are marked ⚠ below. The app is being rewritten by another agent while you read this, so
> confirm the route list against `app/src/routes.tsx` before relying on it.
>
> ⚠ **Deployment is below the cut line.** `docs/BUILD-PLAN.md` puts Vercel in "do not start before
> the line is green". Do not spend the last hour before a demo on a deploy.

## What is deployed

Only the Vite SPA in `app/`. The Move package lives on Sui testnet; the keeper is a long-running Node process that must **not** be deployed to Vercel (it holds a signing key and runs a loop — a serverless platform is the wrong shape for it).

`app/` has **zero imports from `keeper/` or `move/`**, which is what makes this a single-directory deploy. Keep it that way, or update `.vercelignore` at the same time.

## Repo-level config (already committed)

| File | Role |
|---|---|
| `vercel.json` | Explicit install/build/output commands, SPA rewrites, cache + security headers. `framework: null` so no preset overrides them. |
| `.vercelignore` | Keeps `move/`, `keeper/`, `docs/`, the Hashi source dumps and every `.env` out of the upload. |

Key settings inside `vercel.json`:

```jsonc
"installCommand":   "npm --prefix app ci",     // needs app/package-lock.json (committed)
"buildCommand":     "npm --prefix app run build", // tsc --noEmit && vite build
"outputDirectory":  "app/dist",
"rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]  // react-router BrowserRouter
```

The catch-all rewrite is required: **every** app route is client-side with no file behind it. Vercel matches static files first, so `/assets/*`, `/fonts/*`, `/globe/*` and `/logos/*` are unaffected.

⚠ **The route list changed with the pivot.** v1 served `/deposit`, `/exit` and `/transparency`. The
v2 app drops `/exit` (there is no pinned-exit flow any more) and adds the auction screens. The
catch-all rewrite means **you do not need to change `vercel.json` when routes change** — but do
confirm the current list in `app/src/routes.tsx` before writing it into a slide.

## One-time setup

1. **Import the repo** at vercel.com → New Project → `aydi26/sui-lisbon`.
2. **Leave Root Directory as `./`** — `vercel.json` already points at `app/`. (If you instead set Root Directory to `app`, delete the root `vercel.json` or its paths will be wrong.)
3. **Add the environment variables** (below) for the Production, Preview and Development scopes.
4. Deploy.

## Environment variables — the thing that silently breaks

Vite **inlines every `VITE_*` value at build time**. They are not read at runtime. Two consequences:

- Changing a variable in the Vercel dashboard does nothing until you **redeploy**.
- Every `VITE_*` value ends up **in the public JavaScript bundle**. Only ever put public values there. The Enoki *private* key, a Google OAuth *client secret*, and any Sui private key must never be a `VITE_*` variable.

Copy the values from `app/.env.example`. The ones that actually matter:

| Variable | Value | Note |
|---|---|---|
| `VITE_DEMO_MODE` | `mock` until the vault is live, then `live` | `mock` renders every screen from fixtures with zero network |
| `VITE_SUI_GRPC_URL` | `https://fullnode.testnet.sui.io:443` | gRPC v2 — the default read transport |
| `VITE_SUI_JSONRPC_URL` | `https://rpc-testnet.suiscan.xyz:443` | mirror; the official fullnode returns 404 for JSON-RPC |
| `VITE_ENOKI_API_KEY` | `enoki_public_…` | **public** key only |
| `VITE_ZKLOGIN_CLIENT_ID` | Google OAuth Web client id | public |
| `VITE_APHOTIC_PACKAGE_ID` / `VITE_VAULT_ID` | filled at publish time | empty ⇒ the app stays in mock. ⚠ **Nothing is published for v2** — see `docs/DEPLOYED.md` |
| `VITE_WALRUS_AGGREGATOR` / `VITE_WALRUS_PUBLISHER` | `https://aggregator.walrus-testnet.walrus.space` / `…/publisher…` | v2 uses Walrus for the **encrypted order blobs**, so the app now needs the *publisher* too, not only the aggregator |

⚠ **New for v2:** the app is a Seal **encryptor**, so it needs the key-server object ids and the
threshold. `@mysten/seal@1.3.4` requires explicit `serverConfigs` — it exports no
`getAllowlistedKeyServers` and ships no default set. Committee is **5 operators, t = 3, and it
excludes Enoki** (`docs/FACTS.md#seal-identity`). Enoki may still be used for zkLogin onboarding;
what it must never be is a member of the Seal committee, because it would then hold both identity
linkage and a decryption share.

⚠ **Also new for v2:** the app resolves `sdk/` through `app/vite.config.ts` `resolve.alias`. If a
Vercel build fails to resolve `sdk/*`, that alias is the first thing to check — `sdk/` has no build
step and is consumed as TypeScript source.

Everything else has a correct default in `app/src/config.ts`.

## Enoki / Google must know the deployed origin

zkLogin sign-in fails with `redirect_uri_mismatch` (or an Enoki 403) unless the **deployed origin** is registered in both places, in addition to `http://localhost:5173`:

1. **Enoki portal** → your app → allowed origins → add `https://<your-project>.vercel.app` (and any custom domain).
2. **Google Cloud console** → your OAuth client → *Authorized JavaScript origins* **and** *Authorized redirect URIs* → same origin.

Vercel preview deployments get a **different hostname per commit**, which cannot be pre-registered. Either add a stable preview alias and register that, or accept that zkLogin only works on production and on localhost.

Verify at any time:

```bash
node scripts/check-enoki.mjs https://<your-project>.vercel.app
```

## Verify a deploy

```bash
curl -sI https://<project>.vercel.app/            | head -1   # 200
curl -sI https://<project>.vercel.app/<any-route> | head -1   # 200 (rewrite → index.html)
curl -sI https://<project>.vercel.app/logos/aphotic-mark.svg  # 200
curl -sI https://<project>.vercel.app/globe/earth-blue-marble.jpg  # 200, cached
```

The globe textures are **vendored into `app/public/globe/`** on purpose — the upstream landing page fetched them from jsDelivr at runtime, which makes the hero fail on venue wifi. If `/globe/*` 404s, the hero renders a black sphere.

## Not deployed here

- **The keeper** — needs a persistent process and a signing key. Run it on a VM/container, or locally during the demo. It holds a `KeeperCap`, which is `key`-only and epoch-bound, so a compromised deployment cannot name a destination — but it is still a signing key and Vercel is the wrong shape for it.
- **`sdk/`, `move/`, `lending/`** — libraries and on-chain packages, nothing to serve.
- **`VITE_KEEPER_VERIFY_URL`** defaults to `http://localhost:8787`. On a deployed site that endpoint is unreachable, so any "re-run this off-chain" affordance reports the keeper as offline. Point it at a public keeper URL if you expose one.

> **A deployed site does not need the keeper to be useful.** Everything on the auction's critical
> path — close, reveal, clear, settle, claim — is **permissionless**, so the app can drive it
> directly from a user's wallet. `verify_fill` is an on-chain read. If the keeper is unreachable,
> the site should degrade to "nobody is optimising gas for you", not to "the product is down".
