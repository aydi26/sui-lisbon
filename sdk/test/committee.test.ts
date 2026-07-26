// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T6.7
// @phase      3
// @status     DONE
// @spec       docs/DESIGN-V2.md#D9 (n=5 over 5 OPERATORS, t=3; probe needs BOTH the header and
//             the query param; NEVER fall back to plaintext)
// @spec       aphotic.md §7.5 (no Enoki in the committee)
// @rules      G7 G8
// @depends    ../src/seal/committee.ts
// @facts      The probe is exercised with an INJECTED fetch that asserts the request shape, so
// @facts        this suite opens no socket. A real 400 is what a missing header or a missing
// @facts        ?service_id= produces, and the fake reproduces exactly that.
// @implements describe('operator counting') · describe('health probe') · describe('no plaintext')
// @verify     npx vitest run committee
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertQuorumLive,
  CLIENT_SDK_VERSION,
  CLIENT_SDK_VERSION_HEADER,
  DEFAULT_COMMITTEE_N,
  DEFAULT_COMMITTEE_T,
  distinctOperators,
  liveServers,
  oneServerPerOperator,
  probeAll,
  probeHeaders,
  probeService,
  selectCommittee,
  serviceProbeUrl,
  TESTNET_KEY_SERVERS,
  type FetchLike,
  type KeyServer,
  type ProbeResult,
} from '../src/seal/committee.js';

const SOURCE_PATH = fileURLToPath(new URL('../src/seal/committee.ts', import.meta.url));

describe('the pinned testnet registry', () => {
  it('has seven servers across six operators — Mysten runs two', () => {
    expect(TESTNET_KEY_SERVERS).toHaveLength(7);
    expect(distinctOperators(TESTNET_KEY_SERVERS)).toHaveLength(6);
    expect(TESTNET_KEY_SERVERS.filter((s) => s.operator === 'mysten')).toHaveLength(2);
  });

  it('pins the verified object ids', () => {
    expect(TESTNET_KEY_SERVERS.map((s) => s.objectId)).toEqual([
      '0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75',
      '0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8',
      '0x6068c0acb197dddbacd4746a9de7f025b2ed5a5b6c1b1ab44dade4426d141da2',
      '0x5466b7df5c15b508678d51496ada8afab0d6f70a01c10613123382b1b8131007',
      '0x3c93ec1474454e1b47cf485a4e5361a5878d722b9492daf10ef626a76adc3dad',
      '0x9c949e53c36ab7a9c484ed9e8b43267a77d4b8d70e79aa6b39042e3d4c434105',
      '0x4cded1abeb52a22b6becb42a91d3686a4c901cf52eee16234214d0b5b2da4c46',
    ]);
    for (const s of TESTNET_KEY_SERVERS) expect(s.objectId).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('contains no Enoki key server', () => {
    // aphotic.md §7.5: Enoki is both a zkLogin salt provider and a key server. Using it for
    // both hands one party identity linkage AND a decryption share.
    for (const s of TESTNET_KEY_SERVERS) {
      expect(s.operator.toLowerCase()).not.toContain('enoki');
      expect(s.label.toLowerCase()).not.toContain('enoki');
    }
  });

  it('is frozen', () => {
    expect(Object.isFrozen(TESTNET_KEY_SERVERS)).toBe(true);
  });
});

describe('committee selection counts OPERATORS, not servers', () => {
  it('defaults to n=5, t=3', () => {
    expect(DEFAULT_COMMITTEE_N).toBe(5);
    expect(DEFAULT_COMMITTEE_T).toBe(3);
    const c = selectCommittee(TESTNET_KEY_SERVERS);
    expect(c.n).toBe(5);
    expect(c.t).toBe(3);
    expect(c.servers).toHaveLength(5);
  });

  it('never puts two servers of the same operator in one committee', () => {
    const c = selectCommittee(TESTNET_KEY_SERVERS);
    expect(distinctOperators(c.servers)).toHaveLength(5);
    expect(c.servers.filter((s) => s.operator === 'mysten')).toHaveLength(1);
  });

  it('oneServerPerOperator keeps the FIRST of each operator, deterministically', () => {
    const pool = oneServerPerOperator(TESTNET_KEY_SERVERS);
    expect(pool).toHaveLength(6);
    expect(pool[0]!.label).toBe('Mysten testnet-1');
    expect(oneServerPerOperator(TESTNET_KEY_SERVERS)).toEqual(pool);
  });

  it('is deterministic — the same input yields the same committee, 50 times', () => {
    const first = selectCommittee(TESTNET_KEY_SERVERS).servers.map((s) => s.objectId);
    for (let i = 0; i < 50; i++) {
      expect(selectCommittee(TESTNET_KEY_SERVERS).servers.map((s) => s.objectId)).toEqual(first);
    }
  });

  it('THROWS rather than silently returning a weaker committee', () => {
    // Seven servers but only two operators: n=5 is unsatisfiable.
    const twoOperators: KeyServer[] = TESTNET_KEY_SERVERS.map((s, i) => ({
      ...s,
      operator: i < 4 ? 'alpha' : 'beta',
    }));
    expect(() => selectCommittee(twoOperators)).toThrow(/EInsufficientOperators/);
    expect(() => selectCommittee(twoOperators)).toThrow(/have 2/);
  });

  it('rejects nonsensical n and t', () => {
    expect(() => selectCommittee(TESTNET_KEY_SERVERS, { n: 0 })).toThrow(/EBadCommitteeN/);
    expect(() => selectCommittee(TESTNET_KEY_SERVERS, { n: 5, t: 6 })).toThrow(/EBadCommitteeT/);
    expect(() => selectCommittee(TESTNET_KEY_SERVERS, { n: 5, t: 0 })).toThrow(/EBadCommitteeT/);
  });

  it('accepts a smaller committee when asked explicitly', () => {
    const c = selectCommittee(TESTNET_KEY_SERVERS, { n: 3, t: 2 });
    expect(c.servers).toHaveLength(3);
    expect(distinctOperators(c.servers)).toHaveLength(3);
  });
});

describe('the /v1/service health probe', () => {
  it('always carries service_id in the query string', () => {
    expect(serviceProbeUrl('https://ks.example', '0xabc')).toBe(
      'https://ks.example/v1/service?service_id=0xabc',
    );
  });

  it('tolerates a trailing slash on the base url', () => {
    expect(serviceProbeUrl('https://ks.example/', '0xabc')).toBe(
      'https://ks.example/v1/service?service_id=0xabc',
    );
  });

  it('always carries the Client-Sdk-Version header', () => {
    expect(probeHeaders()).toEqual({ [CLIENT_SDK_VERSION_HEADER]: CLIENT_SDK_VERSION });
    expect(CLIENT_SDK_VERSION_HEADER).toBe('Client-Sdk-Version');
  });

  /** A key server that answers 400 unless BOTH the header and the query param are present. */
  const strictFetch: FetchLike = async (url, init) => {
    const hasVersion = init?.headers?.[CLIENT_SDK_VERSION_HEADER] !== undefined;
    const hasServiceId = url.includes('service_id=');
    if (!hasVersion || !hasServiceId) {
      return { ok: false, status: 400, text: async () => 'missing header or service_id' };
    }
    return { ok: true, status: 200, text: async () => '{"version":"0.6.11"}' };
  };

  it('gets a 200 when the request is well formed', async () => {
    const r = await probeService(
      { server: TESTNET_KEY_SERVERS[0]!, baseUrl: 'https://ks.example' },
      strictFetch,
    );
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.url).toContain('service_id=');
    expect(r.operator).toBe('mysten');
  });

  it('would get a 400 if the header were dropped — this is the D9 trap, reproduced', async () => {
    const headerless: FetchLike = async (url) => strictFetch(url, {});
    const r = await probeService(
      { server: TESTNET_KEY_SERVERS[0]!, baseUrl: 'https://ks.example' },
      headerless,
    );
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });

  it('would get a 400 if service_id were dropped', async () => {
    const noParam: FetchLike = async (_url, init) =>
      strictFetch('https://ks.example/v1/service', init);
    const r = await probeService(
      { server: TESTNET_KEY_SERVERS[0]!, baseUrl: 'https://ks.example' },
      noParam,
    );
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });

  it('turns a thrown network error into a RESULT, never an exception', async () => {
    const dead: FetchLike = async () => {
      throw new Error('ECONNREFUSED');
    };
    const r = await probeService(
      { server: TESTNET_KEY_SERVERS[0]!, baseUrl: 'https://ks.example' },
      dead,
    );
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
    expect(r.error).toContain('ECONNREFUSED');
  });

  it('probeAll preserves order and probes every target', async () => {
    const targets = TESTNET_KEY_SERVERS.map((s) => ({ server: s, baseUrl: 'https://ks.example' }));
    const results = await probeAll(targets, strictFetch);
    expect(results).toHaveLength(7);
    expect(results.map((r) => r.objectId)).toEqual(TESTNET_KEY_SERVERS.map((s) => s.objectId));
  });
});

describe('quorum enforcement — never degrade, never fall back', () => {
  const committee = selectCommittee(TESTNET_KEY_SERVERS);

  const result = (s: KeyServer, ok: boolean): ProbeResult => ({
    objectId: s.objectId,
    operator: s.operator,
    ok,
    status: ok ? 200 : 503,
    url: serviceProbeUrl('https://ks.example', s.objectId),
  });

  it('liveServers filters to the OK subset', () => {
    const results = committee.servers.map((s, i) => result(s, i < 3));
    expect(liveServers(committee.servers, results)).toHaveLength(3);
  });

  it('passes at exactly t live', () => {
    const results = committee.servers.map((s, i) => result(s, i < 3));
    expect(() => assertQuorumLive(committee, results)).not.toThrow();
  });

  it('THROWS one below t, and names who is down', () => {
    const results = committee.servers.map((s, i) => result(s, i < 2));
    expect(() => assertQuorumLive(committee, results)).toThrow(/ESealQuorumUnavailable/);
    expect(() => assertQuorumLive(committee, results)).toThrow(/2 of 5/);
    expect(() => assertQuorumLive(committee, results)).toThrow(/Down: /);
  });

  it('THROWS when nothing is live — there is no "degraded" return value', () => {
    const results = committee.servers.map((s) => result(s, false));
    expect(() => assertQuorumLive(committee, results)).toThrow(/ESealQuorumUnavailable/);
  });

  it('ignores an OK result for a server that is not in the committee', () => {
    const outsider = TESTNET_KEY_SERVERS[6]!; // Triton One, excluded by n=5
    expect(committee.servers.some((s) => s.objectId === outsider.objectId)).toBe(false);
    const results = [...committee.servers.map((s) => result(s, false)), result(outsider, true)];
    expect(() => assertQuorumLive(committee, results)).toThrow(/ESealQuorumUnavailable/);
  });
});

describe('no plaintext fallback exists — asserted against the source, not the docs', () => {
  const source = readFileSync(SOURCE_PATH, 'utf8');

  /** Strip `//` line comments and `/* *​/` blocks, leaving only executable code. */
  function codeOnly(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//'))
      .join('\n');
  }

  it('the module source mentions plaintext ONLY in comments', () => {
    expect(source.toLowerCase()).toContain('plaintext'); // it is discussed, at length
    expect(codeOnly(source).toLowerCase()).not.toContain('plaintext');
  });

  it('no executable line mentions a fallback or an unencrypted path', () => {
    const code = codeOnly(source).toLowerCase();
    expect(code).not.toContain('fallback');
    expect(code).not.toContain('unencrypted');
    expect(code).not.toContain('cleartext');
  });

  it('exports nothing whose name suggests a bypass', () => {
    const exported = Object.keys({
      assertQuorumLive,
      distinctOperators,
      liveServers,
      oneServerPerOperator,
      probeAll,
      probeHeaders,
      probeService,
      selectCommittee,
      serviceProbeUrl,
    });
    for (const name of exported) {
      expect(name.toLowerCase()).not.toMatch(/plain|fallback|bypass|skip|insecure/);
    }
  });
});
