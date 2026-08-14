import { describe, it, expect, beforeEach, vi } from "vitest";
// vitest runs the .ts suite in the 'node' env (see vite.config.ts) and
// lib/persist touches localStorage at module-eval time, so the in-memory
// stand-in must be installed before the imports below (vite-node preserves
// statement order, same trick as lib/codedConfig.test.ts).
import { installMemStorage } from "../../lib/testMemStorage";

installMemStorage();

import { clearRegistryForTest, invokeAction } from "../registry";
import { registerBacktestActions } from "./backtest";
import {
  backtestResultSignal, backtestRunningSignal, backtestRunRequest,
  backtestMessagesSignal, backtestProgressSignal,
} from "../../lib/signals";

const CTX = () => ({ progress: vi.fn(), signal: new AbortController().signal });

beforeEach(() => {
  clearRegistryForTest();
  localStorage.clear();
  backtestResultSignal.set(null);
  backtestRunningSignal.set(false);
  backtestMessagesSignal.set({ error: null });
  backtestProgressSignal.set(null);
  registerBacktestActions();
});

describe("backtest actions", () => {
  it("config.get returns defaults when nothing saved", async () => {
    const cfg = (await invokeAction("backtest.config.get", {}, CTX())) as any;
    expect(cfg).toHaveProperty("costs");
    expect(cfg).toHaveProperty("range");
  });

  it("config.set merges a patch and persists", async () => {
    const merged = (await invokeAction(
      "backtest.config.set",
      { patch: { codedStrategy: "sma_cross.py", mode: "coded" } },
      CTX(),
    )) as any;
    expect(merged.codedStrategy).toBe("sma_cross.py");
    const again = (await invokeAction("backtest.config.get", {}, CTX())) as any;
    expect(again.codedStrategy).toBe("sma_cross.py");
  });

  it("backtest.run bumps the run-request signal and resolves on completion", async () => {
    let bumped = 0;
    const unsub = backtestRunRequest.subscribe(() => {
      bumped++;
      // Simulate BacktestButton: start, then publish a result and finish.
      backtestRunningSignal.set(true);
      setTimeout(() => {
        backtestResultSignal.set({ summary: { pnl: 42 } } as any);
        backtestRunningSignal.set(false);
      }, 0);
    });
    const res = (await invokeAction("backtest.run", {}, CTX())) as any;
    unsub();
    expect(bumped).toBe(1);
    expect(res.summary.pnl).toBe(42);
  });

  it("backtest.run rejects when the run publishes an error", async () => {
    const unsub = backtestRunRequest.subscribe(() => {
      backtestRunningSignal.set(true);
      setTimeout(() => {
        backtestMessagesSignal.set({ error: "no candles in the selected range" });
        backtestRunningSignal.set(false);
      }, 0);
    });
    await expect(invokeAction("backtest.run", {}, CTX())).rejects.toThrow(/no candles/);
    unsub();
  });

  it("backtest.run ignores a stale error left over from an earlier run", async () => {
    // The previous run's error is still on the messages signal when this run
    // starts; only errors published DURING the run may reject it.
    backtestMessagesSignal.set({ error: "no candles in the selected range" });
    const unsub = backtestRunRequest.subscribe(() => {
      backtestRunningSignal.set(true);
      setTimeout(() => {
        backtestResultSignal.set({ summary: { pnl: 5 } } as any);
        backtestRunningSignal.set(false);
      }, 0);
    });
    const res = (await invokeAction("backtest.run", {}, CTX())) as any;
    unsub();
    expect(res.summary.pnl).toBe(5);
  });

  it("backtest.run surfaces an error published several ticks after the finish", async () => {
    // BacktestButton flips running off imperatively but publishes the error via
    // a React passive effect, which can land well after the flip on a heavy
    // commit. The grace window must still report the real message — and it must
    // be anchored to the FINISH, not to handler entry, so this run takes longer
    // (250ms) than the whole grace window (100ms) before it finishes.
    const unsub = backtestRunRequest.subscribe(() => {
      backtestRunningSignal.set(true);
      setTimeout(() => backtestRunningSignal.set(false), 250);
      setTimeout(() => backtestMessagesSignal.set({ error: "engine exploded" }), 290);
    });
    await expect(invokeAction("backtest.run", {}, CTX())).rejects.toThrow(/engine exploded/);
    unsub();
  });

  it("backtest.run rejects a cancelled run instead of resolving with the old result", async () => {
    // The previous run's result is still on the signal; a cancelled run
    // publishes nothing new, so it must not be reported as this run's output.
    backtestResultSignal.set({ summary: { pnl: 99 } } as any);
    const unsub = backtestRunRequest.subscribe(() => {
      backtestRunningSignal.set(true);
      setTimeout(() => backtestRunningSignal.set(false), 0);
    });
    await expect(invokeAction("backtest.run", {}, CTX())).rejects.toThrow(/without a result/);
    unsub();
  });

  it("backtest.run streams progress published during the run", async () => {
    const ctx = CTX();
    const unsub = backtestRunRequest.subscribe(() => {
      backtestRunningSignal.set(true);
      setTimeout(() => {
        backtestProgressSignal.set({ phase: "simulate", label: "bars", pct: 50, etaS: null });
        backtestResultSignal.set({ summary: { pnl: 1 } } as any);
        backtestRunningSignal.set(false);
      }, 0);
    });
    await invokeAction("backtest.run", {}, ctx);
    unsub();
    expect(ctx.progress).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "simulate", pct: 50 }),
    );
  });

  it("backtest.result reads the published result", async () => {
    backtestResultSignal.set({ summary: { pnl: 7 } } as any);
    const r = (await invokeAction("backtest.result", {}, CTX())) as any;
    expect(r.summary.pnl).toBe(7);
  });

  it("backtest.progress reads the live progress", async () => {
    backtestProgressSignal.set({ phase: "download", label: "candles", pct: 10, etaS: 3 });
    const p = (await invokeAction("backtest.progress", {}, CTX())) as any;
    expect(p.pct).toBe(10);
  });

  it("backtest.cancel bumps the cancel request", async () => {
    const { backtestCancelRequest } = await import("../../lib/signals");
    const before = backtestCancelRequest.value;
    await invokeAction("backtest.cancel", {}, CTX());
    expect(backtestCancelRequest.value).toBe(before + 1);
  });
});
