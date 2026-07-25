// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T3.3
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/APP.md §2.1 (<ZkLoginButton/>), §2.4, §7 A1
// @rules      G2 G7
// @depends    ../src/session/enoki.ts (T3.3)
// @facts      registerEnokiWallets() MUST run before <WalletProvider> mounts, so
// @facts        it is called at module scope in main.tsx — it therefore has to be
// @facts        idempotent AND a no-op (never a throw) with an empty .env.
// @facts      The Enoki PRIVATE key must never reach the browser: a value starting
// @facts        with `enoki_private_` is reported as a configuration problem.
// @implements the A1 safety net for the zkLogin wiring.
// @forbidden  a real Enoki registration or network call — '@mysten/enoki' is mocked
// @invariant  1. Two calls to registerAphoticEnokiWallets() register ONCE.
//             2. An unconfigured app still boots (no throw, no registration).
//             3. A zkLogin session grants no capability over vault funds — this
//                module only ever reads identity (G2).
// @ac         docs/APP.md §7 A1
// @verify     cd app && npm test
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  apiKey: '',
  clientId: '',
  redirectUrl: '',
  registerCalls: [] as unknown[],
  unregisterCalls: 0,
  session: null as unknown,
  sessionThrows: false,
  metadata: null as unknown,
  googleWalletName: '' as string,
}));

vi.mock('@mysten/enoki', () => ({
  registerEnokiWallets: (args: unknown) => {
    h.registerCalls.push(args);
    return {
      wallets: {},
      unregister: () => {
        h.unregisterCalls += 1;
      },
    };
  },
  getSession: async () => {
    if (h.sessionThrows) throw new Error('wallet has no enoki:getSession feature');
    return h.session;
  },
  getWalletMetadata: () => h.metadata,
  isGoogleWallet: (wallet: { name?: string }) =>
    h.googleWalletName.length > 0 && wallet?.name === h.googleWalletName,
}));

const fakeClient = { __fake: 'sui-client' };
vi.mock('../src/lib/suiClient', () => ({
  getSuiClient: () => fakeClient,
  getJsonRpcClient: () => fakeClient,
  resetSuiClients: () => {},
}));

vi.mock('../src/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config')>();
  const zkLogin: Record<string, unknown> = { ...actual.config.zkLogin };
  Object.defineProperty(zkLogin, 'enokiApiKey', { get: () => h.apiKey, enumerable: true });
  Object.defineProperty(zkLogin, 'googleClientId', { get: () => h.clientId, enumerable: true });
  Object.defineProperty(zkLogin, 'redirectUrl', { get: () => h.redirectUrl, enumerable: true });
  return { ...actual, config: { ...actual.config, zkLogin } };
});

import {
  enokiConfigProblems,
  findGoogleWallet,
  isEnokiConfigured,
  readZkLoginSession,
  registerAphoticEnokiWallets,
  unregisterAphoticEnokiWallets,
  walletProvider,
} from '../src/session/enoki';

const PUBLIC_KEY = 'enoki_public_0123456789abcdef';
const CLIENT_ID = '901837773954-abcdefghij.apps.googleusercontent.com';

function configure() {
  h.apiKey = PUBLIC_KEY;
  h.clientId = CLIENT_ID;
}

beforeEach(() => {
  unregisterAphoticEnokiWallets();
  h.apiKey = '';
  h.clientId = '';
  h.redirectUrl = '';
  h.registerCalls = [];
  h.unregisterCalls = 0;
  h.session = null;
  h.sessionThrows = false;
  h.metadata = null;
  h.googleWalletName = '';
});

afterEach(() => {
  unregisterAphoticEnokiWallets();
});

describe('enokiConfigProblems()', () => {
  it('is empty when both public credentials are present', () => {
    configure();
    expect(enokiConfigProblems()).toEqual([]);
    expect(isEnokiConfigured()).toBe(true);
  });

  it('names VITE_ENOKI_API_KEY when the api key is missing', () => {
    h.clientId = CLIENT_ID;
    const problems = enokiConfigProblems();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/VITE_ENOKI_API_KEY/);
    expect(isEnokiConfigured()).toBe(false);
  });

  it('names VITE_ZKLOGIN_CLIENT_ID when the Google client id is missing', () => {
    h.apiKey = PUBLIC_KEY;
    const problems = enokiConfigProblems();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/VITE_ZKLOGIN_CLIENT_ID/);
    expect(isEnokiConfigured()).toBe(false);
  });

  it('names both when nothing is configured', () => {
    const problems = enokiConfigProblems();
    expect(problems).toHaveLength(2);
    expect(problems.join(' ')).toMatch(/VITE_ENOKI_API_KEY/);
    expect(problems.join(' ')).toMatch(/VITE_ZKLOGIN_CLIENT_ID/);
  });

  it('flags a PRIVATE key that must never be shipped to the browser', () => {
    h.apiKey = 'enoki_private_shouldneverbehere';
    h.clientId = CLIENT_ID;
    const problems = enokiConfigProblems();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/PRIVATE key/);
  });
});

describe('registerAphoticEnokiWallets()', () => {
  it('is a no-op (never a throw) when Enoki is unconfigured', () => {
    let unregister: (() => void) | undefined;
    expect(() => {
      unregister = registerAphoticEnokiWallets();
    }).not.toThrow();
    expect(typeof unregister).toBe('function');
    expect(h.registerCalls).toHaveLength(0);
    // Calling the returned no-op is also safe.
    expect(() => unregister?.()).not.toThrow();
  });

  it('registers exactly once and is idempotent', () => {
    configure();
    const first = registerAphoticEnokiWallets();
    const second = registerAphoticEnokiWallets();
    const third = registerAphoticEnokiWallets();

    expect(h.registerCalls).toHaveLength(1);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('passes the PUBLIC api key, the client id and the app Sui client', () => {
    configure();
    registerAphoticEnokiWallets();

    const args = h.registerCalls[0] as {
      apiKey: string;
      client: unknown;
      network: string;
      providers: { google: { clientId: string; redirectUrl?: string } };
    };
    expect(args.apiKey).toBe(PUBLIC_KEY);
    expect(args.apiKey.startsWith('enoki_private_')).toBe(false);
    expect(args.client).toBe(fakeClient);
    expect(args.network).toBe('testnet');
    expect(args.providers.google.clientId).toBe(CLIENT_ID);
    // Empty ⇒ omitted so Enoki defaults to window.location.origin.
    expect('redirectUrl' in args.providers.google).toBe(false);
  });

  it('forwards an explicit redirect url when one is configured', () => {
    configure();
    h.redirectUrl = 'http://localhost:5173';
    registerAphoticEnokiWallets();
    const args = h.registerCalls[0] as { providers: { google: { redirectUrl?: string } } };
    expect(args.providers.google.redirectUrl).toBe('http://localhost:5173');
  });

  it('unregisters and allows a clean re-registration', () => {
    configure();
    registerAphoticEnokiWallets();
    unregisterAphoticEnokiWallets();
    expect(h.unregisterCalls).toBe(1);

    registerAphoticEnokiWallets();
    expect(h.registerCalls).toHaveLength(2);
  });

  it('unregistering when nothing was registered is safe', () => {
    expect(() => unregisterAphoticEnokiWallets()).not.toThrow();
    expect(h.unregisterCalls).toBe(0);
  });
});

describe('wallet helpers', () => {
  it('findGoogleWallet picks the Enoki Google wallet, else null', () => {
    h.googleWalletName = 'Sign in with Google';
    const wallets = [{ name: 'Slush' }, { name: 'Sign in with Google' }];
    expect(findGoogleWallet(wallets)?.name).toBe('Sign in with Google');
    expect(findGoogleWallet([{ name: 'Slush' }])).toBeNull();
    expect(findGoogleWallet([])).toBeNull();
  });

  it('walletProvider reads the Enoki metadata, and is null for a plain wallet', () => {
    expect(walletProvider(null)).toBeNull();
    h.metadata = { provider: 'google' };
    expect(walletProvider({ name: 'Sign in with Google' })).toBe('google');
    h.metadata = null;
    expect(walletProvider({ name: 'Slush' })).toBeNull();
  });

  it('readZkLoginSession returns the session, and null for a non-Enoki wallet', async () => {
    await expect(readZkLoginSession(null)).resolves.toBeNull();

    h.session = { maxEpoch: 812, randomness: '42', expiresAt: 1_800_000_000_000 };
    await expect(readZkLoginSession({ name: 'Sign in with Google' })).resolves.toEqual(h.session);

    h.sessionThrows = true;
    await expect(readZkLoginSession({ name: 'Slush' })).resolves.toBeNull();
  });
});
