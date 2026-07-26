// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F2
// @phase      1
// @status     DONE
// @spec       aphotic.md §6.1 (capabilities) · docs/DESIGN-V2.md §7 (INV-C1:
//             keeper-gated functions have NO address parameter at all), D3
// @spec       move/sources/allocate.move — `adapter_count`, `adapter_key_at`,
//             `total_principal_sats`, `total_marked_assets_sats`, `is_paused`
// @rules      G7 G8
// @depends    ../../lib/moveRead.ts (F2) · ../../lib/useAsyncAction.ts
// @facts      THE ALLOWLIST IS NOT A FILTER ON AN ARGUMENT — there is no argument.
// @facts        `allocate` and `deallocate` take no `address` parameter of any
// @facts        kind (INV-C1, enforced by a gate over the Move sources), so a
// @facts        compromised keeper has nowhere to name as a destination.
// @facts      ⚠ D3 — no hBTC lending market exists on Sui testnet at all:
// @facts        Suilend/Navi/Scallop have no testnet deployment, AlphaLend's
// @facts        markets are testcoins + SUI, and Navi mainnet's pools carry no
// @facts        Hashi hBTC. The counterparty behind any adapter listed here is one
// @facts        WE DEPLOYED. That is said on screen, every time.
// @facts      `adapter_key_at` returns `(TypeName, ID)` — the adapter's Move type
// @facts        and the venue object. The per-venue cap accessor is GENERIC over
// @facts        that type, so it is not read here: a cap shown against the wrong
// @facts        type argument would be worse than no cap at all.
// @implements export function AllocationPanel(): JSX.Element
// @forbidden  inventing an adapter, a cap or a yield figure
// @forbidden  a read on mount
// @invariant  1. Nothing renders as an allowlisted destination that was not read.
// @ac         renders unconfigured and names the missing variable.
// @verify     cd app && npm test -- vaultScreen
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { bcs } from '@mysten/sui/bcs';

import { config } from '../../config';
import { formatBtc, truncateMiddle } from '../../lib/format';
import { aphoticTarget, decode, first, nth, readMove, wiringGap } from '../../lib/moveRead';
import { useAsyncAction } from '../../lib/useAsyncAction';

const TypeNameBcs = bcs.struct('TypeName', { name: bcs.string() });

interface AdapterRow {
  readonly typeName: string;
  readonly venueId: string;
}

interface AllowlistRead {
  readonly count: number;
  readonly principalSats: bigint;
  readonly markedSats: bigint;
  readonly paused: boolean;
  readonly adapters: readonly AdapterRow[];
}

export function AllocationPanel() {
  const allowlist = useAsyncAction<AllowlistRead>();
  const gap = wiringGap([
    ['VITE_APHOTIC_PACKAGE_ID', config.aphotic.packageId],
    ['VITE_ADAPTER_ALLOWLIST_ID', config.aphotic.adapterAllowlistId],
  ]);

  const load = async (): Promise<AllowlistRead> => {
    const registry = config.aphotic.adapterAllowlistId;
    const head = await readMove((tx) => {
      for (const fn of ['adapter_count', 'total_principal_sats', 'total_marked_assets_sats', 'is_paused']) {
        tx.moveCall({ target: aphoticTarget('allocate', fn), arguments: [tx.object(registry)] });
      }
    });
    const count = Number(decode.u64(first(head, 0)));
    const rows: AdapterRow[] = [];
    if (count > 0) {
      const keys = await readMove((tx) => {
        for (let i = 0; i < count; i += 1) {
          tx.moveCall({
            target: aphoticTarget('allocate', 'adapter_key_at'),
            arguments: [tx.object(registry), tx.pure.u64(BigInt(i))],
          });
        }
      });
      for (let i = 0; i < count; i += 1) {
        rows.push({
          typeName: TypeNameBcs.parse(nth(keys, i, 0)).name,
          venueId: decode.address(nth(keys, i, 1)),
        });
      }
    }
    return {
      count,
      principalSats: decode.u64(first(head, 1)),
      markedSats: decode.u64(first(head, 2)),
      paused: decode.bool(first(head, 3)),
      adapters: rows,
    };
  };

  const data = allowlist.state.data;

  return (
    <section className="ap-panel">
      <div className="ap-panel-head">
        <h3 className="ap-panel-title">Where idle capital may go</h3>
        <button
          type="button"
          className="ap-btn"
          disabled={gap !== null || allowlist.state.status === 'loading'}
          title={gap ?? 'Read the pinned adapter allowlist'}
          onClick={() => void allowlist.run(load)}
        >
          {allowlist.state.status === 'loading' ? 'Reading…' : 'Read from chain'}
        </button>
      </div>

      <div className="ap-panel-body" style={{ display: 'grid', gap: 'var(--space-4)' }}>
        {gap !== null ? <p className="ap-reason ap-reason--warn">{gap}</p> : null}
        {allowlist.state.error !== null ? (
          <p className="ap-reason ap-reason--error">{allowlist.state.error}</p>
        ) : null}

        <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', margin: 0 }}>
          The keeper can move idle capital only to destinations on this allowlist, and only within
          each destination&rsquo;s cap. The functions take <strong>no address parameter at all</strong>
          , so the allowlist is not a filter applied to an argument — there is no argument to filter.
        </p>

        {data === null ? (
          <p className="ap-reason">Not read yet.</p>
        ) : data.adapters.length === 0 ? (
          <p className="ap-reason">
            The registry holds no allowlisted adapters
            {data.paused ? ' and allocation is paused registry-wide' : ''}. Nothing can be allocated
            anywhere.
          </p>
        ) : (
          <ul className="ap-rows ap-gate-rows">
            {data.adapters.map((a) => (
              <li key={`${a.typeName}:${a.venueId}`}>
                <div className="ap-rowline">
                  <span className="ap-wallet-name aphotic-mono" style={{ fontSize: 'var(--text-xs)' }}>
                    {a.typeName}
                  </span>
                  <span className="aphotic-muted aphotic-mono">{truncateMiddle(a.venueId)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}

        {data === null ? null : (
          <p className="ap-reason">
            {formatBtc(data.principalSats, { suffix: true })} principal deployed, marked at{' '}
            {formatBtc(data.markedSats, { suffix: true })}.
            {data.paused ? ' Allocation is paused registry-wide.' : ''}
          </p>
        )}

        <p className="ap-reason ap-reason--warn">
          No hBTC lending market exists on Sui testnet at all — so the counterparty behind any
          adapter above is one <strong>we deployed ourselves</strong>. The adapter is shaped to the
          real vault-share surface, so a mainnet adapter is a new module rather than a refactor, but
          nothing here is evidence of third-party demand.
        </p>
      </div>
    </section>
  );
}

export default AllocationPanel;
