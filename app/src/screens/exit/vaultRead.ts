// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T3.2
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/APP.md §3.3 (read Vault.btc_exit_address), §3.4 (Exit state)
// @spec       docs/RECON.md R1 (gRPC v2 is the ONLY transport on the testnet fullnode)
// @spec       move/sources/vault.move public getters (T1.1, DONE)
// @rules      G2 G7 G9
// @depends    ../../lib/suiClient.ts (T0.4) · ./ptb.ts (T3.2) · ./model.ts (T3.2)
// @facts      Depositor records live in `Vault.depositors: Table<address, Depositor>`,
// @facts        so there is no top-level object to read. Every value below is read by
// @facts        SIMULATING the package's own public getters — which also means the
// @facts        read path is exactly the code path the exit PTB will take.
// @facts      Public getters used (verbatim, move/sources/vault.move):
// @facts        total_shares<B,Q>(&Vault): u64      free_btc_sats<B,Q>(&Vault): u64
// @facts        quote_value<B,Q>(&Vault): u64       is_paused<B,Q>(&Vault): bool
// @facts        has_depositor<B,Q>(&Vault, address): bool
// @facts        shares_of<B,Q>(&Vault, address): u64
// @facts        pending_exit_sats<B,Q>(&Vault, address): u64
// @facts        btc_exit_address<B,Q>(&Vault, address): vector<u8>
// @facts      ⚠ vault::btc_exit_address ABORTS EUnregisteredDepositor when the Table
// @facts        has no record, which would fail the WHOLE simulation. (shares_of and
// @facts        pending_exit_sats return 0 for an unknown address — only the address
// @facts        getter aborts.) The per-depositor reads therefore run in a SECOND
// @facts        simulation, gated on has_depositor.
// @facts      ⚠ NAV is NOT read here. vault::nav_sats(vault, book_mid) would abort
// @facts        EZeroNav for a vault holding quote with no price, and one aborting
// @facts        command fails the whole simulation. Instead this returns the two
// @facts        balances nav_sats is computed FROM (free_btc_sats, quote_value) and
// @facts        model.ts::navSatsMirror reproduces the Move arithmetic line for line.
// @facts        A missing price is then a rendered state, never a fabricated zero (G9).
// @external   client.core.simulateTransaction({ transaction, include: { commandResults: true } })
//               → { $kind, commandResults: [{ returnValues: [{ bcs: Uint8Array }] }] }
// @implements export type VaultSnapshot
//             export async function readVaultSnapshot(who: string): Promise<VaultSnapshot>
// @forbidden  constructing a Sui client here — lib/suiClient.ts is the ONE factory
// @forbidden  a canonical on-chain id literal — everything comes from config (G7)
// @forbidden  throwing at the caller: every failure becomes a rendered state
// @forbidden  returning a NAV the chain did not imply — see the nav_sats note above
// @invariant  1. Every number returned came out of the package's own getters.
// @invariant  2. Any RPC/decode failure resolves to { status: 'unavailable' } with a
//                human reason — the screen degrades, it never crashes.
// @invariant  3. It performs reads only. No transaction is ever executed here.
// @ac         docs/APP.md §7 A4 A11
// @verify     cd app && npx tsc --noEmit
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { bcs } from '@mysten/sui/bcs';
import { Transaction } from '@mysten/sui/transactions';

import { getSuiClient } from '../../lib/suiClient';
import type { VaultView } from './model';
import { missingTargets, moveTargets } from './ptb';

export type VaultSnapshot =
  | { readonly status: 'unconfigured'; readonly missing: readonly string[] }
  | {
      readonly status: 'ok';
      /** `navSats` here is the base-only figure; price the quote leg with navSatsMirror. */
      readonly view: VaultView;
      /** vault::free_btc_sats — idle base minus the pooled earmark. */
      readonly freeBtcSats: bigint;
      /** vault::quote_value — idle DBUSDC. Zero today; the book has no mid (E-A7). */
      readonly quoteValue: bigint;
      readonly hasRecord: boolean;
      /** The write-once witness program, or null when nothing is pinned yet (G2). */
      readonly pinnedProgram: Uint8Array | null;
    }
  | { readonly status: 'unavailable'; readonly reason: string };

/** Return values of one simulated read PTB, in command order. */
async function simulateReads(tx: Transaction): Promise<Uint8Array[]> {
  const result = await getSuiClient().core.simulateTransaction({
    transaction: tx,
    include: { commandResults: true },
    checksEnabled: false,
  });
  if (result.$kind !== 'Transaction') {
    throw new Error('the simulation aborted');
  }
  const commands = result.commandResults ?? [];
  return commands.map((command) => {
    const first = command.returnValues[0];
    if (first === undefined) throw new Error('a getter returned nothing');
    return first.bcs;
  });
}

const readU64 = (bytes: Uint8Array): bigint => BigInt(bcs.u64().parse(bytes));
const readBool = (bytes: Uint8Array): boolean => bcs.bool().parse(bytes);
const readBytes = (bytes: Uint8Array): Uint8Array => Uint8Array.from(bcs.vector(bcs.u8()).parse(bytes));

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Live read of everything the exit screen needs, via the package's own public
 * getters. Never throws: every failure mode is a rendered state.
 */
export async function readVaultSnapshot(who: string): Promise<VaultSnapshot> {
  const missing = missingTargets();
  if (missing.length > 0) return { status: 'unconfigured', missing };

  const t = moveTargets();
  const typeArguments = [t.baseType, t.quoteType];

  // ── pass 1: vault-wide getters (never abort) ───────────────────────────────
  let totalShares = 0n;
  let freeBtcSats = 0n;
  let quoteValue = 0n;
  let paused = false;
  let hasRecord = false;

  try {
    const tx = new Transaction();
    tx.setSender(who);
    for (const fn of ['total_shares', 'free_btc_sats', 'quote_value', 'is_paused'] as const) {
      tx.moveCall({ target: `${t.packageId}::vault::${fn}`, typeArguments, arguments: [tx.object(t.vaultId)] });
    }
    tx.moveCall({
      target: `${t.packageId}::vault::has_depositor`,
      typeArguments,
      arguments: [tx.object(t.vaultId), tx.pure.address(who)],
    });

    const out = await simulateReads(tx);
    totalShares = readU64(out[0]);
    freeBtcSats = readU64(out[1]);
    quoteValue = readU64(out[2]);
    paused = readBool(out[3]);
    hasRecord = readBool(out[4]);
  } catch (error) {
    return {
      status: 'unavailable',
      reason: `Could not read the Vault (${reason(error)}). The package may not be published at this id yet.`,
    };
  }

  // ── pass 2: per-depositor getters (abort without a Table record) ───────────
  let myShares = 0n;
  let pendingExitSats = 0n;
  let pinnedProgram: Uint8Array | null = null;

  if (hasRecord) {
    try {
      const tx = new Transaction();
      tx.setSender(who);
      for (const fn of ['shares_of', 'pending_exit_sats', 'btc_exit_address'] as const) {
        tx.moveCall({
          target: `${t.packageId}::vault::${fn}`,
          typeArguments,
          arguments: [tx.object(t.vaultId), tx.pure.address(who)],
        });
      }
      const out = await simulateReads(tx);
      myShares = readU64(out[0]);
      pendingExitSats = readU64(out[1]);
      const program = readBytes(out[2]);
      pinnedProgram = program.length > 0 ? program : null;
    } catch (error) {
      return {
        status: 'unavailable',
        reason: `Read your depositor record but could not decode it (${reason(error)}).`,
      };
    }
  }

  // The unpriced, base-only figure — exactly what vault::nav_sats returns while
  // `quote == 0`, which is the vault's state today. The caller re-prices with
  // model.ts::navSatsMirror once a quote leg and a mid both exist.
  const view: VaultView = {
    totalShares,
    navSats: freeBtcSats,
    myShares,
    pendingExitSats,
    // The hBTC/DBUSDC book is empty on both sides; there is no mid to read (E-A7).
    bookMid: null,
    paused,
  };

  return { status: 'ok', view, freeBtcSats, quoteValue, hasRecord, pinnedProgram };
}
