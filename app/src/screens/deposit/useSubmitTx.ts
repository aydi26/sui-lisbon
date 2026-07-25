// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       T3.1, T3.3
// @phase      3  [CUT-LINE CRITICAL]
// @status     DONE
// @spec       docs/APP.md §2 (Screen 1 — Deposit), ERRATA E-A3 (sponsor pays, depositor sends)
// @spec       docs/RECON.md R1 (gRPC for our own reads; dapp-kit runs on the mirror)
// @rules      G1 G2 G7
// @depends    ../../lib/suiClient.ts (T0.4) · @mysten/dapp-kit 1.1.9
// @facts      dapp-kit's useSignAndExecuteTransaction routes through the CONNECTED
// @facts        wallet. For an Enoki zkLogin wallet that means Enoki signs with the
// @facts        user's zkLogin key and its gas pool pays. Sponsorship changes who
// @facts        PAYS; the SENDER is always the connected account (E-A3, G2).
// @facts      The wallet returns a digest, not events. Effects propagate to the read
// @facts        fullnode a moment later, so the event read is a short bounded poll —
// @facts        never an unbounded spinner (G6).
// @facts      ⚠ Executed through the wallet, which builds against dapp-kit's JSON-RPC
// @facts        mirror; our own confirmation read goes over gRPC (lib/suiClient.ts).
// @external   useSignAndExecuteTransaction().mutateAsync({ transaction }) → { digest }
//             client.core.getTransaction({ digest, include: { events: true } })
// @implements export interface SubmitResult · export interface SubmitState
//             export function useSubmitTx(): SubmitState
//             export function waitForEvents(digest, attempts?): Promise<readonly unknown[]>
// @forbidden  constructing a Sui client here — lib/suiClient.ts is the ONE factory
// @forbidden  swallowing a failure: every rejection becomes a rendered message
// @invariant  1. `isPending` is true for exactly the span between click and settle,
//                so a button can never be double-fired.
//             2. A failed execution leaves `digest` null and `error` non-null.
// @ac         docs/APP.md §7 A1
// @verify     cd app && npx tsc --noEmit
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { useCallback, useState } from 'react';
import { useSignAndExecuteTransaction } from '@mysten/dapp-kit';
import type { Transaction } from '@mysten/sui/transactions';

import { getSuiClient } from '../../lib/suiClient';

export interface SubmitResult {
  readonly digest: string;
  /** Events emitted by the transaction, empty when they could not be read back. */
  readonly events: readonly unknown[];
}

export interface SubmitState {
  readonly submit: (tx: Transaction) => Promise<SubmitResult>;
  readonly isPending: boolean;
  readonly digest: string | null;
  readonly error: string | null;
  readonly reset: () => void;
}

/**
 * Poll for the transaction's events. Bounded and short: the transaction has
 * already executed, we are only waiting for the read node to catch up.
 */
export async function waitForEvents(digest: string, attempts = 6): Promise<readonly unknown[]> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const result = await getSuiClient().core.getTransaction({
        digest,
        include: { events: true },
      });
      const transaction = result.$kind === 'Transaction' ? result.Transaction : result.FailedTransaction;
      const events = transaction?.events;
      if (events !== undefined) return events;
    } catch {
      // Not visible on this node yet. Fall through to the wait below.
    }
    await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
  }
  return [];
}

export function useSubmitTx(): SubmitState {
  const { mutateAsync } = useSignAndExecuteTransaction();
  const [isPending, setIsPending] = useState(false);
  const [digest, setDigest] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (tx: Transaction): Promise<SubmitResult> => {
      setIsPending(true);
      setError(null);
      setDigest(null);
      try {
        const output = await mutateAsync({ transaction: tx });
        setDigest(output.digest);
        const events = await waitForEvents(output.digest);
        return { digest: output.digest, events };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        throw err instanceof Error ? err : new Error(message);
      } finally {
        setIsPending(false);
      }
    },
    [mutateAsync],
  );

  const reset = useCallback(() => {
    setDigest(null);
    setError(null);
  }, []);

  return { submit, isPending, digest, error, reset };
}
