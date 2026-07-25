#!/usr/bin/env node
// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T3.3
// @phase      3
// @status     DONE
// @spec       docs/APP.md §2.1 (<ZkLoginButton/>), §7 A1
// @rules      G7
// @facts      Enoki REST base = https://api.enoki.mystenlabs.com, version prefix
// @facts        /v1, auth header `Authorization: Bearer <apiKey>` (read from
// @facts        @mysten/enoki 1.2.7 dist/EnokiClient/index.mjs — DEFAULT_API_URL).
// @facts      GET /v1/app returns { data: { allowedOrigins, authenticationProviders,
// @facts        domains } }. zkLogin CANNOT work while authenticationProviders is
// @facts        empty or the app origin is missing from allowedOrigins.
// @facts      Reads VITE_ENOKI_API_KEY from app/.env.local, then app/.env, then the
// @facts        process env. Never prints the key beyond a masked prefix.
// @implements node scripts/check-enoki.mjs [origin]
// @forbidden  printing the full api key, or accepting an `enoki_private_` key
// @invariant  1. Exit code 0 ⇔ the key is valid AND google is registered AND the
//                origin is allow-listed. Anything else exits non-zero.
// @verify     node scripts/check-enoki.mjs http://localhost:5173
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = process.argv[2] ?? 'http://localhost:5173';

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

const apiKey = env.VITE_ENOKI_API_KEY ?? '';
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

console.log('');
if (failed) {
  console.log('Enoki is NOT ready — zkLogin sign-in will fail until the above is fixed.');
  process.exit(1);
}
console.log('Enoki is ready.');
