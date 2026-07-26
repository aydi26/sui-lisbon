// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T6.7
// @phase      3
// @status     DONE
// @spec       docs/DESIGN-V2.md#D9 (n = 5 across 5 distinct OPERATORS, t = 3; count operators,
//             not servers; health-probe /v1/service; refuse to open a batch below t live;
//             NEVER fall back to plaintext)
// @spec       docs/DESIGN-V2.md#D5 (testnet needs no Enoki: @mysten/seal@1.3.4 makes
//             serverConfigs required and ships no default set)
// @spec       aphotic.md §7.5 (compose the Seal committee WITHOUT Enoki — Enoki is both a
//             zkLogin salt provider and a key server; using both hands one party identity
//             linkage AND a decryption share)
// @rules      G7 G8
// @depends    (nothing at runtime — `fetch` is INJECTED, so this module is testable offline)
// @facts      Verified-live testnet key-server object ids:
// @facts        Mysten testnet-1 0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75
// @facts        Mysten testnet-2 0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8
// @facts        Ruby Nodes      0x6068c0acb197dddbacd4746a9de7f025b2ed5a5b6c1b1ab44dade4426d141da2
// @facts        NodeInfra       0x5466b7df5c15b508678d51496ada8afab0d6f70a01c10613123382b1b8131007
// @facts        Natsai          0x3c93ec1474454e1b47cf485a4e5361a5878d722b9492daf10ef626a76adc3dad
// @facts        Overclock       0x9c949e53c36ab7a9c484ed9e8b43267a77d4b8d70e79aa6b39042e3d4c434105
// @facts        Triton One      0x4cded1abeb52a22b6becb42a91d3686a4c901cf52eee16234214d0b5b2da4c46
// @facts      ★ COUNT OPERATORS, NOT SERVERS — the two Mysten entries are ONE failure domain.
// @facts        7 servers, 6 operators. Default n = 5 over 5 DISTINCT operators, t = 3.
// @facts      ⚠ The /v1/service probe needs BOTH a `Client-Sdk-Version` header AND a
// @facts        `?service_id=` query param, or it returns 400 — not 404, not 200. Omitting
// @facts        either makes every server look dead.
// @facts      ⚠ 3 of the 10 advertised testnet servers are down and versions skew
// @facts        0.4.4 / 0.6.7 / 0.6.11 (D9). Liveness must be probed, never assumed.
// @facts      ⚠ Base URLs are NOT hardcoded here: a key server's endpoint lives on its
// @facts        on-chain KeyServer object and can be rotated by its operator. Inventing a URL
// @facts        would be exactly the kind of un-sourced literal CONVENTIONS §2.5 forbids.
// @facts        Resolve it on chain, then pass it to `probeService`.
// @implements export interface KeyServer
// @implements export const TESTNET_KEY_SERVERS: readonly KeyServer[]
// @implements export const DEFAULT_COMMITTEE_N: number
// @implements export const DEFAULT_COMMITTEE_T: number
// @implements export const CLIENT_SDK_VERSION_HEADER: string
// @implements export const CLIENT_SDK_VERSION: string
// @implements export function distinctOperators(servers: readonly KeyServer[]): string[]
// @implements export function oneServerPerOperator(servers: readonly KeyServer[]): KeyServer[]
// @implements export function selectCommittee(servers: readonly KeyServer[], opts?: CommitteeOptions): Committee
// @implements export function serviceProbeUrl(baseUrl: string, serviceId: string): string
// @implements export function probeHeaders(): Record<string, string>
// @implements export async function probeService(target: ProbeTarget, fetchImpl?: FetchLike): Promise<ProbeResult>
// @implements export async function probeAll(targets: readonly ProbeTarget[], fetchImpl?: FetchLike): Promise<ProbeResult[]>
// @implements export function liveServers(servers: readonly KeyServer[], results: readonly ProbeResult[]): KeyServer[]
// @implements export function assertQuorumLive(committee: Committee, results: readonly ProbeResult[]): void
// @forbidden  ANY plaintext fallback. There is no code path in this package that returns an
//             unencrypted order. `test/committee.test.ts` greps this source for the words
//             `plaintext` / `fallback` outside comments and fails if either appears in code.
// @forbidden  an Enoki key server in the committee — aphotic.md §7.5
// @forbidden  counting two servers of the same operator toward n — one failure domain
// @forbidden  a hardcoded base URL — resolve it from the on-chain KeyServer object
// @invariant  1. selectCommittee returns exactly n servers over exactly n distinct operators.
// @invariant  2. selectCommittee is deterministic: same input order ⇒ same committee.
// @invariant  3. selectCommittee THROWS when fewer than n distinct operators are available —
//                it never silently returns a weaker committee.
// @invariant  4. serviceProbeUrl always carries `service_id`, and probeHeaders always carries
//                `Client-Sdk-Version`. Both, or the server answers 400.
// @invariant  5. assertQuorumLive throws unless at least `t` committee members answered OK.
// @ac         test/committee.test.ts — operator counting, determinism, 400-shape probe, no
//             plaintext path
// @verify     npx vitest run committee
// └── END CONTRACT ───────────────────────────────────────────────────────────

/** One Seal key server. `baseUrl` is resolved from the on-chain `KeyServer` object. */
export interface KeyServer {
  /** The on-chain `KeyServer` object id — also the `service_id` the probe must carry. */
  readonly objectId: string;
  /** The FAILURE DOMAIN. Two servers sharing an operator count once. */
  readonly operator: string;
  readonly label: string;
}

/**
 * The pinned testnet set. Seven servers, six operators — Mysten runs two, which is why the
 * selection counts operators (D9).
 */
export const TESTNET_KEY_SERVERS: readonly KeyServer[] = Object.freeze([
  Object.freeze({
    objectId: '0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75',
    operator: 'mysten',
    label: 'Mysten testnet-1',
  }),
  Object.freeze({
    objectId: '0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8',
    operator: 'mysten',
    label: 'Mysten testnet-2',
  }),
  Object.freeze({
    objectId: '0x6068c0acb197dddbacd4746a9de7f025b2ed5a5b6c1b1ab44dade4426d141da2',
    operator: 'ruby-nodes',
    label: 'Ruby Nodes',
  }),
  Object.freeze({
    objectId: '0x5466b7df5c15b508678d51496ada8afab0d6f70a01c10613123382b1b8131007',
    operator: 'nodeinfra',
    label: 'NodeInfra',
  }),
  Object.freeze({
    objectId: '0x3c93ec1474454e1b47cf485a4e5361a5878d722b9492daf10ef626a76adc3dad',
    operator: 'natsai',
    label: 'Natsai',
  }),
  Object.freeze({
    objectId: '0x9c949e53c36ab7a9c484ed9e8b43267a77d4b8d70e79aa6b39042e3d4c434105',
    operator: 'overclock',
    label: 'Overclock',
  }),
  Object.freeze({
    objectId: '0x4cded1abeb52a22b6becb42a91d3686a4c901cf52eee16234214d0b5b2da4c46',
    operator: 'triton-one',
    label: 'Triton One',
  }),
]);

export const DEFAULT_COMMITTEE_N = 5;
export const DEFAULT_COMMITTEE_T = 3;

/** Without this header the key server answers 400 (D9). */
export const CLIENT_SDK_VERSION_HEADER = 'Client-Sdk-Version';
/** Matches `@mysten/seal@1.3.4`, the pinned client. Override per deployment if it moves. */
export const CLIENT_SDK_VERSION = '1.3.4';

export interface CommitteeOptions {
  readonly n?: number;
  readonly t?: number;
}

export interface Committee {
  readonly servers: readonly KeyServer[];
  readonly n: number;
  readonly t: number;
}

/** Distinct failure domains, in first-seen order. */
export function distinctOperators(servers: readonly KeyServer[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of servers) {
    if (seen.has(s.operator)) continue;
    seen.add(s.operator);
    out.push(s.operator);
  }
  return out;
}

/** Keep the FIRST server of each operator — deterministic, and one failure domain each. */
export function oneServerPerOperator(servers: readonly KeyServer[]): KeyServer[] {
  const seen = new Set<string>();
  const out: KeyServer[] = [];
  for (const s of servers) {
    if (seen.has(s.operator)) continue;
    seen.add(s.operator);
    out.push(s);
  }
  return out;
}

/**
 * n servers over n DISTINCT operators, threshold t. Throws rather than degrade: a committee
 * that quietly shrinks is a confidentiality downgrade nobody would notice.
 */
export function selectCommittee(
  servers: readonly KeyServer[],
  opts: CommitteeOptions = {},
): Committee {
  const n = opts.n ?? DEFAULT_COMMITTEE_N;
  const t = opts.t ?? DEFAULT_COMMITTEE_T;
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`EBadCommitteeN: ${n}`);
  if (!Number.isInteger(t) || t < 1 || t > n) throw new RangeError(`EBadCommitteeT: t=${t} n=${n}`);
  const pool = oneServerPerOperator(servers);
  if (pool.length < n) {
    throw new RangeError(
      `EInsufficientOperators: need ${n} distinct operators, have ${pool.length} ` +
        `(from ${servers.length} servers). Refusing to open a batch with a weaker committee.`,
    );
  }
  return { servers: Object.freeze(pool.slice(0, n)), n, t };
}

// ── health probe ────────────────────────────────────────────────────────────

/** The minimal slice of `fetch` this module needs. Injected, so tests never open a socket. */
export interface FetchLike {
  (
    url: string,
    init?: { readonly method?: string; readonly headers?: Record<string, string> },
  ): Promise<{ readonly ok: boolean; readonly status: number; text(): Promise<string> }>;
}

export interface ProbeTarget {
  readonly server: KeyServer;
  /** Resolved from the on-chain `KeyServer` object — never hardcoded here. */
  readonly baseUrl: string;
}

export interface ProbeResult {
  readonly objectId: string;
  readonly operator: string;
  readonly ok: boolean;
  readonly status: number;
  /** The URL actually requested — asserted by the tests to carry `service_id`. */
  readonly url: string;
  readonly body?: string;
  readonly error?: string;
}

/** `<base>/v1/service?service_id=<objectId>`. The query param is NOT optional (D9). */
export function serviceProbeUrl(baseUrl: string, serviceId: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}/v1/service?service_id=${encodeURIComponent(serviceId)}`;
}

/** The header set the probe MUST send. Without it the server answers 400 (D9). */
export function probeHeaders(): Record<string, string> {
  return { [CLIENT_SDK_VERSION_HEADER]: CLIENT_SDK_VERSION };
}

function defaultFetch(): FetchLike {
  const f = (globalThis as { fetch?: unknown }).fetch;
  if (typeof f !== 'function') {
    throw new Error('no global fetch available — pass a FetchLike explicitly');
  }
  return f as FetchLike;
}

/** GET `/v1/service`. Never throws: a dead server is a RESULT, not an exception. */
export async function probeService(
  target: ProbeTarget,
  fetchImpl?: FetchLike,
): Promise<ProbeResult> {
  const url = serviceProbeUrl(target.baseUrl, target.server.objectId);
  const base = {
    objectId: target.server.objectId,
    operator: target.server.operator,
    url,
  };
  try {
    const impl = fetchImpl ?? defaultFetch();
    const res = await impl(url, { method: 'GET', headers: probeHeaders() });
    const body = await res.text();
    return { ...base, ok: res.ok, status: res.status, body };
  } catch (e) {
    return { ...base, ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Probe every target. Order-preserving. */
export async function probeAll(
  targets: readonly ProbeTarget[],
  fetchImpl?: FetchLike,
): Promise<ProbeResult[]> {
  return Promise.all(targets.map((t) => probeService(t, fetchImpl)));
}

/** The subset of `servers` whose probe came back OK. */
export function liveServers(
  servers: readonly KeyServer[],
  results: readonly ProbeResult[],
): KeyServer[] {
  const ok = new Set(results.filter((r) => r.ok).map((r) => r.objectId));
  return servers.filter((s) => ok.has(s.objectId));
}

/**
 * Refuse to open a batch below `t` live members (D9).
 *
 * Throws. There is deliberately no "degraded" return value and no unencrypted path: an
 * order that cannot be sealed is an order that is not submitted.
 */
export function assertQuorumLive(committee: Committee, results: readonly ProbeResult[]): void {
  const live = liveServers(committee.servers, results);
  if (live.length < committee.t) {
    const down = committee.servers
      .filter((s) => !live.some((l) => l.objectId === s.objectId))
      .map((s) => s.label);
    throw new Error(
      `ESealQuorumUnavailable: ${live.length} of ${committee.n} key servers live, need ` +
        `t=${committee.t}. Down: ${down.join(', ')}. Refusing to open a batch.`,
    );
  }
}
