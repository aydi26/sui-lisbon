#!/usr/bin/env node
// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       ops — deploy tooling, no BUILD-PLAN unit id
// @phase      ops
// @status     DONE
// @spec       docs/DEPLOY.md (Enoki / Google origin registration — the 403 this script prevents)
// @spec       docs/FACTS.md#zklogin (the Enoki endpoints and what zkLogin needs registered)
// @rules      G7 (the api key and the origin arrive as config, never as a literal)
// @facts      Enoki REST base = https://api.enoki.mystenlabs.com, version prefix
// @facts        /v1, auth header `Authorization: Bearer <apiKey>` (read from
// @facts        @mysten/enoki 1.2.7 dist/EnokiClient/index.mjs — DEFAULT_API_URL).
// @facts      GET /v1/app returns { data: { allowedOrigins, authenticationProviders,
// @facts        domains } }. zkLogin CANNOT work while authenticationProviders is
// @facts        empty or the app origin is missing from allowedOrigins.
// @facts      Reads VITE_ENOKI_API_KEY from app/.env.local, then app/.env, then the
// @facts        process env. Never prints the key beyond a masked prefix.
// @implements node scripts/check-enoki.mjs [origin] [--key=enoki_public_…]
// @facts      The ORIGIN argument is normalised: a bare host (`aphotic.vercel.app`),
// @facts        a trailing slash, or a deep link (`https://x.app/vault?a=1`) all
// @facts        reduce to the scheme+host+port form Enoki stores. A bare host with
// @facts        no scheme gets https:// — except localhost/127.0.0.1, which get http://.
// @facts      Google's OAuth client config is NOT readable over any public API, so
// @facts        this script can only REMIND you to register the origin there. Both
// @facts        the Authorised JavaScript origin AND the redirect URI must list it.
// @forbidden  printing the full api key, or accepting an `enoki_private_` key
// @invariant  1. Exit code 0 ⇔ the key is valid AND google is registered AND the
//                origin is allow-listed. Anything else exits non-zero.
// @verify     node scripts/check-enoki.mjs http://localhost:5173
// @verify     node scripts/check-enoki.mjs https://aphotic-taupe.vercel.app
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const keyFlag = argv.find((a) => a.startsWith('--key='))?.slice('--key='.length);
const originArg = argv.find((a) => !a.startsWith('--'));

/**
 * Reduce anything a human might paste to the exact `scheme://host[:port]` string
 * Enoki stores in `allowedOrigins`. A mismatched trailing slash is the single
 * most common reason this check reports "not allow-listed" against an origin
 * that is, in fact, registered.
 */
function normaliseOrigin(raw) {
  const trimmed = String(raw).trim().replace(/\/+$/, '');
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  const isLocal = /^(https?:\/\/)?(localhost|127\.0\.0\.1)(:|$|\/)/i.test(trimmed);
  const withScheme = hasScheme ? trimmed : `${isLocal ? 'http' : 'https'}://${trimmed}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    return trimmed;
  }
}

const ORIGIN = normaliseOrigin(originArg ?? 'http://localhost:5173');

function readEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/\s+#.*$/, '').trim();
  }
  return out;
}

const env = {
  ...readEnvFile(join(ROOT, 'app', '.env')),
  ...readEnvFile(join(ROOT, 'app', '.env.local')),
  ...process.env,
};

const apiKey = keyFlag ?? env.VITE_ENOKI_API_KEY ?? '';
const googleClientId = env.VITE_ZKLOGIN_CLIENT_ID ?? '';

const mask = (k) => (k.length > 18 ? `${k.slice(0, 18)}…${k.slice(-4)}` : '(unset)');
let failed = false;
const fail = (msg) => {
  failed = true;
  console.log(`  FAIL  ${msg}`);
};
const pass = (msg) => console.log(`  PASS  ${msg}`);

console.log('Enoki configuration check');
console.log(`  key       ${mask(apiKey)}`);
console.log(`  origin    ${ORIGIN}`);
console.log('');

if (apiKey.length === 0) {
  fail('VITE_ENOKI_API_KEY is unset (looked in app/.env.local, app/.env, process env).');
  process.exit(1);
}
if (apiKey.startsWith('enoki_private_')) {
  fail('That is a PRIVATE key. It must never reach the browser — use the public one.');
  process.exit(1);
}

let app;
try {
  const res = await fetch('https://api.enoki.mystenlabs.com/v1/app', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    fail(`GET /v1/app returned HTTP ${res.status} — the key is rejected.`);
    process.exit(1);
  }
  app = (await res.json()).data;
  pass('api key accepted by Enoki');
} catch (e) {
  fail(`could not reach the Enoki API: ${e.message}`);
  process.exit(1);
}

const providers = app.authenticationProviders ?? [];
const origins = app.allowedOrigins ?? [];

if (providers.length === 0) {
  fail(
    'no authentication provider registered. In the Enoki portal, add the Google\n' +
      '        provider and paste your Google OAuth 2.0 "Web application" client id.',
  );
} else {
  const google = providers.find((p) => p.providerType === 'google');
  if (google === undefined) {
    fail(`google is not registered (found: ${providers.map((p) => p.providerType).join(', ')})`);
  } else {
    pass(`google provider registered — client id ${google.clientId}`);
    if (googleClientId.length === 0) {
      console.log(`  NOTE  set VITE_ZKLOGIN_CLIENT_ID=${google.clientId} in app/.env.local`);
    } else if (googleClientId !== google.clientId) {
      fail(
        `VITE_ZKLOGIN_CLIENT_ID does not match the portal.\n` +
          `        .env.local: ${googleClientId}\n` +
          `        portal    : ${google.clientId}`,
      );
    } else {
      pass('VITE_ZKLOGIN_CLIENT_ID matches the portal');
    }
  }
}

if (origins.length === 0) {
  fail(`no allowed origin registered. Add ${ORIGIN} in the Enoki portal.`);
} else if (!origins.includes(ORIGIN)) {
  fail(`${ORIGIN} is not allow-listed (registered: ${origins.join(', ')})`);
} else {
  pass(`origin ${ORIGIN} is allow-listed`);
}

// Google's OAuth client configuration is not exposed by any public API, so this
// half can only ever be a reminder — but it is the half that produces the
// `redirect_uri_mismatch` error people lose an hour to.
console.log('');
console.log('  MANUAL  Google Cloud console → APIs & Services → Credentials → your');
console.log('          OAuth 2.0 "Web application" client. BOTH lists must contain');
console.log(`          ${ORIGIN} :`);
console.log('            • Authorised JavaScript origins   →  ' + ORIGIN);
console.log('            • Authorised redirect URIs        →  ' + ORIGIN);
console.log('          Registering only the first one still fails, with');
console.log('          redirect_uri_mismatch. Changes can take a few minutes.');
if (ORIGIN.startsWith('http://') && !/localhost|127\.0\.0\.1/.test(ORIGIN)) {
  fail('Google refuses a non-localhost http:// origin. Use https://.');
}

console.log('');
if (failed) {
  console.log('Enoki is NOT ready — zkLogin sign-in will fail until the above is fixed.');
  process.exit(1);
}
console.log('Enoki is ready (the Google half above is yours to confirm by eye).');
