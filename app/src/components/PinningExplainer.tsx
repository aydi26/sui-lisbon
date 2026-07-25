// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T0.4, T3.2
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/APP.md §3.1 (<PinningExplainer/>, L118)
// @spec       docs/MOVE-PACKAGE.md#gateway · docs/GOLDEN-RULES.md G2
// @rules      G2
// @depends    ../theme.css (T0.4) · aphotic::gateway (T1.3)
// @external   public fun hashi::withdraw::request_withdrawal(
//                 hashi: &mut Hashi, clock: &Clock, btc: Balance<BTC>,
//                 bitcoin_address: vector<u8>, ctx: &mut TxContext)
//             ⚠ asserts addr_len == 20 || addr_len == 32  EInvalidBitcoinAddress
//             ⚠ asserts btc.value() >= 30_000             EBelowMinimumWithdrawal
// @facts      The destination comes from `Vault.btc_exit_address`, written ONCE by
// @facts        gateway::register_exit_address at deposit and immutable after.
// @facts      gateway::exit_to_bitcoin has NO bitcoin_address parameter — that is
// @facts        the whole point, and gates.ps1 g2 enforces it.
// @implements export function PinningExplainer(): JSX.Element
// @forbidden  any editable destination field anywhere in the exit UI — G2, A4
// @invariant  1. The copy states the address is write-once and read from the Vault.
// @invariant  2. No prop lets a caller present a different destination.
// @ac         docs/APP.md §7 A4 — assert no editable field on btc_exit_address
// @verify     cd app && npm run build
// └── END CONTRACT ───────────────────────────────────────────────────────────

export function PinningExplainer() {
  return (
    <section className="aphotic-card">
      <h3 style={{ fontSize: 'var(--text-md)' }}>Why this address cannot change</h3>
      <ol
        style={{
          color: 'var(--text-secondary)',
          fontSize: 'var(--text-sm)',
          paddingLeft: '1.1rem',
          margin: 0,
        }}
      >
        <li>
          At your first deposit, <code>gateway::register_exit_address</code> writes your Bitcoin
          address into the Vault. It is <strong>write-once</strong>: no later call can overwrite it.
        </li>
        <li>
          <code>gateway::exit_to_bitcoin</code> burns your shares, splits the balance and calls
          Hashi’s <code>request_withdrawal</code> in <strong>one atomic PTB</strong>, reading the
          destination from the Vault.
        </li>
        <li>
          That function takes <strong>no Bitcoin-address argument</strong>. There is no code path —
          for you, for us, or for a fully compromised keeper — that supplies a different
          destination.
        </li>
        <li>
          The keeper holds a DeepBook <code>TradeCap</code> and nothing else, so it cannot burn
          shares, cannot request a withdrawal, and cannot reclaim one (Hashi’s{' '}
          <code>cancel_withdrawal</code> is sender-bound to the depositor).
        </li>
      </ol>
    </section>
  );
}

export default PinningExplainer;
