import { describe, it, expect, beforeEach, vi } from "vitest";
import { clearRegistryForTest, invokeAction } from "../registry";
import { registerSweepActions } from "./sweep";
import {
  sweepAxesSignal, sweepStateSignal, backtestRunRequest, backtestRunningSignal,
} from "../../lib/signals";

const CTX = () => ({ progress: vi.fn(), signal: new AbortController().signal });

beforeEach(() => {
  clearRegistryForTest();
  sweepAxesSignal.set([]);
  sweepStateSignal.set(null);
  backtestRunningSignal.set(false);
  registerSweepActions();
});

describe("sweep actions", () => {
  it("sweep.start publishes axes, bumps the run request, resolves with rows", async () => {
    const axes = [{ param: "period", values: [5, 10] }] as never;
    const unsub = backtestRunRequest.subscribe(() => {
      expect(sweepAxesSignal.value).toEqual(axes);
      sweepStateSignal.set({ rows: [], done: 0, total: 2, running: true });
      setTimeout(() => {
        sweepStateSignal.set({
          rows: [{ pnl: 1 } as never, { pnl: 2 } as never],
          done: 2, total: 2, running: false,
        });
      }, 0);
    });
    const ctx = CTX();
    const res = (await invokeAction("sweep.start", { axes }, ctx)) as { rows: unknown[] };
    unsub();
    expect(res.rows).toHaveLength(2);
    expect(ctx.progress).toHaveBeenCalled();
    // The axes lifecycle belongs to sweep.start: a later backtest.run must not
    // be silently routed into the sweep branch.
    expect(sweepAxesSignal.value).toEqual([]);
  });

  it("sweep.start rejects when the sweep errors", async () => {
    const unsub = backtestRunRequest.subscribe(() => {
      sweepStateSignal.set({ rows: [], done: 0, total: 1, running: true });
      setTimeout(() => {
        sweepStateSignal.set({
          rows: [], done: 0, total: 1, running: false, error: "combo failed",
        });
      }, 0);
    });
    await expect(
      invokeAction("sweep.start", { axes: [{ param: "p", values: [1] }] }, CTX()),
    ).rejects.toThrow(/combo failed/);
    unsub();
    expect(sweepAxesSignal.value).toEqual([]);
  });

  it("sweep.start rejects immediately when a backtest is already running", async () => {
    backtestRunningSignal.set(true);
    const axes = [{ param: "p", values: [1] }];
    await expect(invokeAction("sweep.start", { axes }, CTX())).rejects.toThrow(/already running/);
    // The rejected call must not clobber the axes.
    expect(sweepAxesSignal.value).toEqual([]);
  });

  it("sweep.start ignores a previous finished sweep state", async () => {
    // A completed run from earlier this session is still on the signal; the new
    // invocation must wait for ITS state, not resolve off the leftover.
    sweepStateSignal.set({ rows: [{ pnl: 7 } as never], done: 1, total: 1, running: false });
    const ctx = CTX();
    const p = invokeAction("sweep.start", { axes: [{ param: "p", values: [1] }] }, ctx) as
      Promise<{ rows: unknown[] }>;
    let settled = false;
    void p.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    sweepStateSignal.set({ rows: [], done: 0, total: 1, running: true });
    sweepStateSignal.set({ rows: [{ pnl: 3 } as never], done: 1, total: 1, running: false });
    const res = await p;
    expect(res.rows).toHaveLength(1);
  });

  it("sweep.start rejects when the sweep state is cleared mid-run", async () => {
    // Closing the backtest settings panel unmounts the modal, whose cleanup runs
    // requestSweepCancel(false) + sweepStateSignal.set(null). BacktestButton's
    // catch deliberately skips republishing in that case (aborted && state null),
    // so a null publish after the run started is the only terminal signal there is.
    const unsub = backtestRunRequest.subscribe(() => {
      sweepStateSignal.set({ rows: [], done: 0, total: 2, running: true });
      setTimeout(() => sweepStateSignal.set(null), 0);
    });
    await expect(
      invokeAction("sweep.start", { axes: [{ param: "p", values: [1] }] }, CTX()),
    ).rejects.toThrow(/cleared/);
    unsub();
    expect(sweepAxesSignal.value).toEqual([]);

    // ...and the next invocation is not blocked by the abandoned one.
    const unsub2 = backtestRunRequest.subscribe(() => {
      sweepStateSignal.set({ rows: [], done: 0, total: 1, running: true });
      setTimeout(() => {
        sweepStateSignal.set({ rows: [{ pnl: 4 } as never], done: 1, total: 1, running: false });
      }, 0);
    });
    const res = (await invokeAction(
      "sweep.start", { axes: [{ param: "p", values: [1] }] }, CTX(),
    )) as { rows: unknown[] };
    unsub2();
    expect(res.rows).toHaveLength(1);
  });

  it("sweep.start settles on abort even if no terminal state arrives", async () => {
    vi.useFakeTimers();
    try {
      const unsub = backtestRunRequest.subscribe(() => {
        sweepStateSignal.set({ rows: [], done: 0, total: 1, running: true });
      });
      const ctl = new AbortController();
      const p = invokeAction(
        "sweep.start", { axes: [{ param: "p", values: [1] }] },
        { progress: vi.fn(), signal: ctl.signal },
      );
      const settled = vi.fn();
      void p.then(settled, settled);
      unsub();
      ctl.abort();
      // The abort asks the runner to cancel; a well-behaved run publishes a
      // cancelled state. Nothing arrives here, so the grace window must settle it.
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(3000);
      await expect(p).rejects.toThrow(/cancel/i);
      expect(sweepAxesSignal.value).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sweep.rows reads the current rows", async () => {
    sweepStateSignal.set({ rows: [{ pnl: 9 } as never], done: 1, total: 1, running: false });
    const rows = (await invokeAction("sweep.rows", {}, CTX())) as Array<{ pnl: number }>;
    expect(rows[0].pnl).toBe(9);
  });
});
