// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F2
// @phase      1
// @status     DONE
// @spec       aphotic.md §2 (hard constraints — nothing is presented as live that
//             is not), §13 (limitations are published)
// @rules      G8
// @depends    react · ./tx.ts (describeTxError)
// @facts      THE HOUSE RULE THIS HOOK EXISTS TO ENFORCE: a read happens because
// @facts        the user asked for it, and its three outcomes — idle, in flight,
// @facts        failed — are all VISIBLE. A panel that silently retries or that
// @facts        renders stale data as fresh is the thing PendingCall was built to
// @facts        prevent, one level up.
// @facts      `status: 'idle'` is not "empty": it means NOBODY HAS ASKED YET, and
// @facts        the screen says exactly that rather than showing a zero.
// @implements export type AsyncStatus · AsyncState
// @implements export function useAsyncAction<T>(): AsyncAction<T>
// @forbidden  running the action from an effect — every call site is a click
// @forbidden  swallowing an error: `error` is the rendered message, always set
// @invariant  1. `run` never throws; the failure lands in `state.error`.
// @invariant  2. A late response from a superseded run cannot overwrite a newer
//                one — the run counter drops it.
// @ac         app/test/useAsyncAction.test.ts — idle→loading→ready, the error
//             path, and a stale run being ignored.
// @verify     cd app && npm test -- useAsyncAction
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { useCallback, useRef, useState } from 'react';

import { describeTxError } from './tx';

export type AsyncStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface AsyncState<T> {
  readonly status: AsyncStatus;
  readonly data: T | null;
  /** Human-readable. Never a raw object, never null while status is 'error'. */
  readonly error: string | null;
}

export interface AsyncAction<T> {
  readonly state: AsyncState<T>;
  readonly run: (fn: () => Promise<T>) => Promise<void>;
  readonly reset: () => void;
  /** Replace the held value without a round trip — for an optimistic local edit. */
  readonly set: (data: T) => void;
}

const IDLE = { status: 'idle', data: null, error: null } as const;

export function useAsyncAction<T>(): AsyncAction<T> {
  const [state, setState] = useState<AsyncState<T>>(IDLE);
  const runId = useRef(0);

  const run = useCallback(async (fn: () => Promise<T>): Promise<void> => {
    const id = runId.current + 1;
    runId.current = id;
    setState((prev) => ({ status: 'loading', data: prev.data, error: null }));
    try {
      const data = await fn();
      if (runId.current !== id) return; // superseded
      setState({ status: 'ready', data, error: null });
    } catch (err) {
      if (runId.current !== id) return;
      // Reuse the send path's classifier: a failed READ deserves the same
      // honesty as a failed write, including a Move abort rendered in words.
      setState((prev) => ({
        status: 'error',
        data: prev.data,
        error: describeTxError(err).message,
      }));
    }
  }, []);

  const reset = useCallback(() => {
    runId.current += 1;
    setState(IDLE);
  }, []);

  const set = useCallback((data: T) => {
    runId.current += 1;
    setState({ status: 'ready', data, error: null });
  }, []);

  return { state, run, reset, set };
}
