// @vitest-environment jsdom
//
// Running a backtest from this tab while the focused cell is REPLAYING is the
// third mouth on a leak whose other two are already closed (the series-load path
// in chart/useLiveMarketData, the cross-tab push in App, both via
// backtestPanelActionForReplay). A fresh run publishes its whole result
// including `period` as a real calendar range — the field lib/replayReveal drops
// because BacktestPanel renders it unmasked — then pages real post-cursor
// history into the replaying chart and fits the view to the full traded span.
//
// The gate sits at the top of run(), which is the single entrance for the
// backtest, sweep AND walk-forward modes (and for the agent bridge, which bumps
// the same request signal), so this file is what proves all of those are covered.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

import { installMemStorage } from "./lib/testMemStorage";

installMemStorage();

// Only the run's SIDE EFFECTS are stubbed. registerReplayingChart /
// isChartReplaying / backtestActionBlockedByReplay stay real: they are the thing
// under test.
const stubs = vi.hoisted(() => ({
  runAndRender: vi.fn(async () => ({
    epic: "GOLD",
    resolution: "MINUTE_5",
    markers: [],
    trades: [],
    metrics: {},
    equity: [],
  })),
  fitBacktestTrades: vi.fn(),
  coverBacktestHistory: vi.fn(async () => null),
  renderWfoArtifacts: vi.fn(),
}));
vi.mock("./lib/backtest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/backtest")>()),
  ...stubs,
}));

const nowMs = Date.now();
const bars = Array.from({ length: 2000 }, (_, i) => ({
  timestamp: nowMs - (2000 - i) * 300_000,
  open: 100, high: 101, low: 99, close: 100 + (i % 7), volume: 1,
}));
vi.mock("./lib/feed", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  fetchRangeWithStatus: vi.fn(async () => ({ bars, degraded: null })),
}));

import { registerReplayingChart } from "./lib/backtest";
import {
  backtestMessagesSignal, backtestRunningSignal, backtestRunRequest,
  sweepAxesSignal, sweepStateSignal,
} from "./lib/signals";
import { saveBacktestLastUsed } from "./lib/persist";
import { defaultBacktestConfig } from "./lib/backtestConfig";
import BacktestButton from "./BacktestButton";

function signal<T>(initial: T) {
  let v = initial;
  const subs = new Set<() => void>();
  return {
    get value() { return v; },
    set(next: T) { v = next; subs.forEach((f) => f()); },
    subscribe(f: () => void) { subs.add(f); return () => subs.delete(f); },
  };
}

// A stand-in Chart: the replaying registry is a WeakMap keyed by identity, and
// nothing on the blocked path touches the instance.
const chart = { getIndicators: () => [] } as never;
const controller = {
  chart,
  scope: "cell1",
  readOnly: signal(false),
  replaying: signal(false),
  indicators: signal([] as Array<{ id: string; type: string }>),
  indicatorsHidden: signal(false),
  subPanesHidden: signal(false),
};

const runOnce = async () => {
  render(
    <BacktestButton
      controller={controller as never}
      period={{ resolution: "MINUTE_5" } as never}
      epic="GOLD"
      brokerId="dukascopy"
      priceSide="mid"
    />,
  );
  await act(async () => {
    backtestRunRequest.set(backtestRunRequest.value + 1);
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
  });
};

describe("a run started while the cell is REPLAYING", () => {
  beforeEach(() => {
    const cfg = defaultBacktestConfig();
    saveBacktestLastUsed({
      ...cfg,
      range: { ...cfg.range, mode: "bars", bars: 300, resolution: "MINUTE_5" },
    });
    backtestMessagesSignal.set({ error: null });
  });
  afterEach(() => {
    cleanup();
    registerReplayingChart(chart, null);
    // Module-global: axes left set would route the NEXT test's run into the
    // sweep branch.
    sweepAxesSignal.set([]);
    sweepStateSignal.set(null);
    vi.clearAllMocks();
  });

  it("never reaches the engine, and never touches the chart's history or view", async () => {
    registerReplayingChart(chart, () => true);
    await runOnce();
    expect(stubs.runAndRender).not.toHaveBeenCalled();
    // The two calls that follow a run: paging real post-cursor bars in, and
    // fitting the view to the full traded span (both of which would show the
    // user where the session is headed).
    expect(stubs.coverBacktestHistory).not.toHaveBeenCalled();
    expect(stubs.fitBacktestTrades).not.toHaveBeenCalled();
  });

  it("explains the refusal instead of looking like a run that did nothing", async () => {
    registerReplayingChart(chart, () => true);
    await runOnce();
    expect(backtestMessagesSignal.value.error).toMatch(/replay/i);
  });

  it("refuses in the shape the agent bridge can read", async () => {
    // agent/actions/backtest.ts resolves ui_invoke("backtest.run") off two
    // signals: it only attributes an error to ITS run once `running` has gone
    // true, and it settles when `running` goes false. Reproduced here, because a
    // refusal that flipped neither would leave the agent waiting out a 5s start
    // timeout and then reporting the wrong reason ("run did not start").
    let started = false;
    let settled = false;
    let runError: string | null = null;
    const unsubs = [
      backtestRunningSignal.subscribe((running) => {
        if (running) started = true;
        else if (started) settled = true;
      }),
      backtestMessagesSignal.subscribe((m) => {
        if (started && m.error) runError = m.error;
      }),
    ];
    registerReplayingChart(chart, () => true);
    await runOnce();
    unsubs.forEach((u) => u());
    expect(started).toBe(true);
    expect(settled).toBe(true);
    expect(runError).toMatch(/replay/i);
    // ...and it is still a refusal, not a run that happened to fail.
    expect(stubs.runAndRender).not.toHaveBeenCalled();
  });

  it("refuses a SWEEP on the sweep's own channel", async () => {
    // agent/actions/sweep.ts settles on sweepStateSignal, not on the two signals
    // backtest.run watches, so the wave-1 refusal was invisible to it:
    // ui_invoke("sweep.start") sat out its own 5s START_TIMEOUT_MS and then
    // rejected with "sweep did not start (is a chart with a symbol open and
    // focused?)" — the wrong reason, five seconds late, with sweepAxesSignal
    // held for that whole window. Its subscriber settles on a terminal state
    // carrying an `error` even before the run started, which is exactly what a
    // refusal should publish. The panel's sweep view reads the same signal, so
    // this is also how a refused sweep speaks in the UI.
    sweepAxesSignal.set([{ param: "ema_len", values: [10, 20] } as never]);
    sweepStateSignal.set(null);
    registerReplayingChart(chart, () => true);
    await runOnce();
    expect(sweepStateSignal.value?.running).toBe(false);
    expect(sweepStateSignal.value?.error).toMatch(/replay/i);
    expect(stubs.runAndRender).not.toHaveBeenCalled();
  });

  it("leaves the sweep channel alone when the refused run was not a sweep", async () => {
    sweepAxesSignal.set([]);
    sweepStateSignal.set(null);
    registerReplayingChart(chart, () => true);
    await runOnce();
    expect(sweepStateSignal.value).toBeNull();
  });

  it("still runs normally once the session is over", async () => {
    registerReplayingChart(chart, () => false);
    await runOnce();
    expect(stubs.runAndRender).toHaveBeenCalledTimes(1);
    expect(backtestMessagesSignal.value.error).toBeNull();
  });
});
