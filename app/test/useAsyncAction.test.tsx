// @vitest-environment jsdom
// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       F2
// @phase      1
// @status     DONE
// @spec       aphotic.md §2 (nothing is presented as live that is not)
// @rules      G8
// @depends    ../src/lib/useAsyncAction.ts (F2)
// @facts      THE CLAIM THIS FILE POLICES: `idle` is not `empty`. A panel that has
// @facts        not been asked for data must be distinguishable from one that was
// @facts        asked and got zero — otherwise every screen silently invents a
// @facts        reading of nothing.
// @facts      A SUPERSEDED RUN MUST NOT WIN. Two clicks in flight and the slower
// @facts        one landing last would otherwise overwrite fresher state with
// @facts        staler state, which is the worst kind of wrong number: a plausible
// @facts        one.
// @implements the hook's invariants 1 and 2
// @forbidden  a network call
// @invariant  1. run() never rejects; a thrown error lands in state.error.
// @invariant  2. A late resolution from a superseded run is dropped.
// @ac         cd app && npm test -- useAsyncAction
// @verify     cd app && npm test -- useAsyncAction
// └── END CONTRACT ───────────────────────────────────────────────────────────

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useAsyncAction } from '../src/lib/useAsyncAction';

afterEach(cleanup);

describe('useAsyncAction', () => {
  it('starts idle, which is NOT the same as empty', () => {
    const { result } = renderHook(() => useAsyncAction<number>());
    expect(result.current.state.status).toBe('idle');
    expect(result.current.state.data).toBeNull();
    expect(result.current.state.error).toBeNull();
  });

  it('goes idle → loading → ready and carries the value', async () => {
    const { result } = renderHook(() => useAsyncAction<number>());
    await act(async () => {
      await result.current.run(async () => 42);
    });
    expect(result.current.state.status).toBe('ready');
    expect(result.current.state.data).toBe(42);
  });

  it('never rejects — a thrown error becomes a rendered message', async () => {
    const { result } = renderHook(() => useAsyncAction<number>());
    await act(async () => {
      // If this rejected, the test would fail here rather than below.
      await result.current.run(async () => {
        throw new Error('the vault is not wired');
      });
    });
    expect(result.current.state.status).toBe('error');
    expect(result.current.state.error).toMatch(/not wired/);
  });

  it('renders a Move abort in words, through the same classifier a send uses', async () => {
    const { result } = renderHook(() => useAsyncAction<number>());
    await act(async () => {
      await result.current.run(async () => {
        throw new Error(
          'MoveAbort(MoveLocation { module: 0x1::vault, function: 4 }, 15) in command 0',
        );
      });
    });
    expect(result.current.state.error).toMatch(/has not been priced yet/i);
  });

  it('keeps the previous value visible while a refresh is in flight', async () => {
    const { result } = renderHook(() => useAsyncAction<number>());
    await act(async () => {
      await result.current.run(async () => 1);
    });
    let release: (() => void) | null = null;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    act(() => {
      void result.current.run(async () => {
        await pending;
        return 2;
      });
    });
    expect(result.current.state.status).toBe('loading');
    // Stale, and labelled loading — never blanked to null mid-refresh.
    expect(result.current.state.data).toBe(1);
    await act(async () => {
      release?.();
      await pending;
    });
    await waitFor(() => expect(result.current.state.data).toBe(2));
  });

  it('drops a superseded run rather than letting it overwrite a newer one', async () => {
    const { result } = renderHook(() => useAsyncAction<string>());
    let releaseSlow: (() => void) | null = null;
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    act(() => {
      void result.current.run(async () => {
        await slow;
        return 'stale';
      });
    });
    await act(async () => {
      await result.current.run(async () => 'fresh');
    });
    expect(result.current.state.data).toBe('fresh');
    await act(async () => {
      releaseSlow?.();
      await slow;
    });
    // The slow run finished LAST and still must not win.
    expect(result.current.state.data).toBe('fresh');
  });

  it('reset returns to idle, not to a zero value', async () => {
    const { result } = renderHook(() => useAsyncAction<number>());
    await act(async () => {
      await result.current.run(async () => 7);
    });
    act(() => result.current.reset());
    expect(result.current.state.status).toBe('idle');
    expect(result.current.state.data).toBeNull();
  });
});
