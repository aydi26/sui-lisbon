// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F1
// @phase      0
// @status     DONE
// @spec       aphotic.md §13 (known limitations), §7.4 (what is NOT hidden),
//             §7.7 (the honest NAV gap), §6.3 (the boundary Move cannot enforce)
// @spec       docs/DESIGN-V2.md D8 (v1 spends are LINKABLE), D3 (we deployed the
//             lending counterparty ourselves), D10 (validator floor 7 / live 32)
// @rules      G8
// @depends    ../config.ts (F1) · ../theme.css
// @facts      D8 — v1 NOTE SPENDS ARE LINKABLE. The spec says spends publish a
// @facts        nullifier "without revealing which leaf"; that is true only WITH a
// @facts        ZK membership proof. In v1 the Merkle path is supplied IN THE
// @facts        CLEAR, so `path_index` names the leaf. v1 delivers UNIFORMITY,
// @facts        NOT UNLINKABILITY. Do not soften this sentence.
// @facts      D10 — Sui's per-validator voting-power cap is
// @facts        min(10000, max(1000, ceil(10000/n))) = 10 % while n >= 10, so the
// @facts        PROTOCOL FLOOR for a colluding quorum is 7 validators; LIVE
// @facts        TESTNET TODAY is 32. Quote BOTH, always labelled: a bare "7"
// @facts        overstates the risk, a bare "32" understates the guarantee.
// @facts      D3 — Suilend/Navi/Scallop have no testnet deployment at all and no
// @facts        hBTC market exists on Sui testnet, so we deployed the lending
// @facts        counterparty OURSELVES. Say so everywhere.
// @facts      G8 — hBTC IS custodial-threshold wrapped BTC. The differentiation is
// @facts        composing the bridge's ON-CHAIN machinery, not the token's trust
// @facts        model.
// @implements export function LimitationsPanel(props?): JSX.Element
//             export const LIMITATIONS: readonly Limitation[]
// @forbidden  softening, hedging or collapsing any row below — disclosing these is
//             what makes the rest credible
// @forbidden  a bare validator number without its label — D10
// @invariant  1. Every row states the limitation FIRST and the mitigation second,
//                never the reverse.
// @invariant  2. The linkability row is always visible, never behind a toggle.
// @ac         the four named rows render verbatim.
// @verify     cd app && npm test -- limitations
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { config } from '../config';

export interface Limitation {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  /** What is being done about it, or null when the honest answer is "nothing yet". */
  readonly mitigation: string | null;
}

const { validatorFloor, validatorsLive } = config.constants;

export const LIMITATIONS: readonly Limitation[] = [
  {
    id: 'custodial',
    title: 'hBTC is custodial-threshold wrapped BTC',
    body:
      'It is a claim on a committee-managed pool of Bitcoin UTXOs. Deposits are approved by attestation, not by an on-chain light client — Sui has no Bitcoin light client and Hashi does not use SPV proofs. Aphotic inherits every one of those trust assumptions.',
    mitigation:
      'The differentiation is composing the bridge’s on-chain machinery — the public queue we route around, the replayable limiter, the deterministic clearing — not the token’s trust model. Aphotic is not trustless; it is no less trustworthy than the venue it serves, and that is the honest bar.',
  },
  {
    id: 'linkable',
    title: 'v1 note spends are LINKABLE',
    body:
      'The design says a spend publishes a nullifier without revealing which leaf it spends. That is true only with a zero-knowledge membership proof. In v1 the Merkle path is supplied in the clear, so the path index names the leaf. v1 delivers uniformity, not unlinkability.',
    mitigation:
      'The commitment and nullifier machinery earns its keep by making the ZK tier a verifier swap rather than a redesign: same tree, same nullifier format, a Groth16 check in place of the cleartext path. Groth16 compatibility is unverified and gated on a spike, not a plan.',
  },
  {
    id: 'lending',
    title: 'We deployed the lending counterparty ourselves',
    body:
      'No hBTC lending market exists on Sui testnet at all. Suilend, Navi and Scallop have no testnet deployment; AlphaLend’s markets are testcoins and SUI; Navi mainnet holds no Hashi hBTC. So the idle-yield leg trades against a counterparty we deployed.',
    mitigation:
      'The adapter is shaped to the real ERC-4626-ish surface, so a mainnet adapter is a new module rather than a refactor. Nothing on this screen should be read as evidence of external demand.',
  },
  {
    id: 'seal-threshold',
    title: 'Pre-close confidentiality is t-of-n, and post-close nothing is hidden',
    body:
      `A colluding quorum of Seal key servers decrypts orders early: the committee is ${config.seal.threshold}-of-${Math.max(config.seal.keyServerIds.length, 5)} across distinct operators, so it is a threshold assumption, not a proof. After close, every order becomes visible — including unfilled ones, which are exploitable in the next batch.`,
    mitigation:
      'Both close with the same upgrade: replace the time-lock policy with a PCR-gated policy so only an attested enclave ever decrypts. Order format, Seal integration and the settlement contract are unchanged. Designed for, not built.',
  },
  {
    id: 'validators',
    title: `Validator collusion floor: protocol floor ${validatorFloor}, live testnet today ${validatorsLive}`,
    body:
      `Hashi’s committee weight mirrors Sui consensus voting power. The per-validator cap is 10 % while there are at least ten validators, so a certificate needs at least ${validatorFloor} colluding validators as a protocol floor — while the live testnet set is ${validatorsLive}.`,
    mitigation:
      `Both numbers, always labelled. A bare “${validatorFloor}” overstates the risk; a bare “${validatorsLive}” understates the guarantee.`,
  },
  {
    id: 'nav-gap',
    title: 'NAV is not fully reconstructible',
    body:
      'Every leg but one sits behind a Sui RPC endpoint. The last leg — native BTC at the redemption address — lives in the Bitcoin UTXO set and Move cannot read it.',
    mitigation:
      'The redemption address is published and pinned so anyone can check the balance, and NAV attribution to that leg is capped at the sum of on-Sui-readable withdrawal claims that produced it: the unverifiable component can never exceed the verifiable claim behind it. A Bitcoin header relay would close the gap — roadmap, not dependency.',
  },
  {
    id: 'anonymity-set',
    title: 'There is no anonymity set at launch',
    body:
      'Uniform notes hide nothing among three participants. This property emerges with volume and cannot be bootstrapped cryptographically. Two-sided flow is the principal risk to the auction, and it is economic, not technical.',
    mitigation:
      'The vault does not depend on two-sided flow, which is why it ships first. The auction needs a market and follows.',
  },
  {
    id: 'calm-markets',
    title: 'The venue may be worth little in calm markets',
    body:
      'If the Guardian’s token bucket is generously sized, the redemption queue clears in minutes and there is no spread to carry. Aphotic is closer to congestion insurance than to a bridge.',
    mitigation:
      'One structural point in its favour: the limiter config lives in the enclave’s init config, whose hash each key provisioner recomputes independently, so widening throughput under stress requires a fresh ceremony with a quorum. Congestion, once it starts, persists.',
  },
];

export interface LimitationsPanelProps {
  /** Render only these ids, in this order. Omit for all of them. */
  readonly only?: readonly string[];
  readonly title?: string;
}

export function LimitationsPanel({
  only,
  title = 'What this does not do',
}: LimitationsPanelProps = {}) {
  const rows =
    only === undefined
      ? LIMITATIONS
      : only.map((id) => LIMITATIONS.find((l) => l.id === id)).filter((l): l is Limitation => l !== undefined);

  return (
    <section className="aphotic-card ap-limitations" aria-label="Known limitations">
      <h3 style={{ fontSize: 'var(--text-md)', margin: 0 }}>{title}</h3>
      <p className="aphotic-muted" style={{ marginTop: 0 }}>
        Stated without hedging. Disclosing these is what makes the rest credible.
      </p>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--space-4)' }}>
        {rows.map((row) => (
          <li key={row.id}>
            <strong style={{ fontSize: 'var(--text-base)' }}>{row.title}</strong>
            <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', margin: 'var(--space-1) 0 0' }}>
              {row.body}
            </p>
            {row.mitigation !== null ? <p className="ap-reason">{row.mitigation}</p> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default LimitationsPanel;
