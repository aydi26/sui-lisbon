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
// @facts      ⚠ v3 (commit "remove the owner emergency withdraw") deleted the owner's
// @facts        escape hatch from vault.move. There is now NO function through which
// @facts        the owner can move depositor funds, and vault error code 1 is vacant
// @facts        where it used to live. The only two ways value leaves the vault are a
// @facts        depositor's own pro-rata redemption and this pinned exit.
// @implements export function PinningExplainer(): JSX.Element
// @forbidden  any editable destination field anywhere in the exit UI — G2, A4
// @forbidden  claiming hBTC itself is trustless — it is custodial-threshold wrapped
//             BTC and the copy says so (G8)
// @invariant  1. The copy states the address is write-once and read from the Vault.
// @invariant  2. No prop lets a caller present a different destination.
// @invariant  3. The copy names BOTH parties who cannot take funds: the keeper and
//                the owner. Naming only the keeper would overstate nothing but would
//                understate the v3 change.
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
        <li>
          <strong>The owner cannot withdraw either.</strong> The emergency-withdraw function was
          removed from <code>vault.move</code> in v3, so no privileged path out exists any more. The
          only two ways value leaves this vault are your own pro-rata redemption and this pinned
          exit.
        </li>
        <li>
          What arrives on Bitcoin is native BTC released by Hashi&rsquo;s committee. Be clear-eyed
          about the dependency: hBTC is custodial-threshold wrapped BTC. What is trust-minimised here
          is the <em>machinery</em> around it — the destination, the caps, and who may cancel.
        </li>
      </ol>
    </section>
  );
}

export default PinningExplainer;
