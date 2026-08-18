// @vitest-environment jsdom
// A rule can name a pane the chart no longer has (the rules live in the config,
// the panes are chart state). The run re-creates it from the refs rather than
// letting the request omit it and the backend 422 on unknown_indicator_ref.
//
// The unit tests in lib/exprInstances.test.ts cover WHAT gets synthesized; this
// one covers the WIRING that the pure tests can't reach: that the repair runs
// inside run(), BEFORE the chart is read for the request's `indicators` map, so
// the re-created pane is actually shipped.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

import { installMemStorage } from "./lib/testMemStorage";

installMemStorage();

// The pane list the component reads off the chart. Starts empty (the user
// deleted the pane), and the repair spy below pushes into it — standing in for
// importExprInstances actually creating the pane.
// vi.hoisted: vi.mock factories are hoisted above the module body, so anything
// they close over has to be hoisted with them.
const { live, applyPortableInstances } = vi.hoisted(() => {
  const live: Array<{ id: string; type: string; calcParams: number[]; extendData: unknown }> = [];
  const applyPortableInstances = vi.fn((_opts: unknown, indicators: Record<string, {
    type: string; calcParams: number[]; extendData: unknown;
  }>) => {
    for (const [id, p] of Object.entries(indicators)) live.push({ id, ...p });
    return {};
  });
  return { live, applyPortableInstances };
});

vi.mock("./lib/useRuleClipboard", () => ({ applyPortableInstances }));
vi.mock("./lib/indicators", () => ({ liveExprInstances: () => [...live] }));

// The run's data + engine edges: enough candles to clear warm-up, and a result
// shaped like the panel expects. runAndRender returns the request it was given
// so the assertion can read the `indicators` map off it.
// Bars must land inside the resolved window (the last N bars up to now), or the
// run bails with "no candles in the selected range" before it ever posts.
// klinecharts KLineData: `timestamp` in MILLISECONDS. They must also land inside
// the resolved window (the last N bars up to now), or the run bails with
// "no candles in the selected range" before it ever posts.
const nowMs = Date.now();
const bars = Array.from({ length: 2000 }, (_, i) => ({
  timestamp: nowMs - (2000 - i) * 300_000,
  open: 100, high: 101, low: 99, close: 100 + (i % 7), volume: 1,
}));
const { runAndRender } = vi.hoisted(() => ({
  runAndRender: vi.fn(async (_chart: unknown, req: { indicators?: unknown }) => ({
    req,
    epic: "GOLD",
    resolution: "MINUTE_5",
    markers: [],
    trades: [],
    metrics: {},
    equity: [],
  })),
}));

vi.mock("./lib/backtest", () => ({
  runAndRender,
  clearBacktest: vi.fn(),
  fitBacktestTrades: vi.fn(),
  coverBacktestHistory: vi.fn(async () => null),
  oldestBacktestAnchorMs: () => null,
  renderWfoArtifacts: vi.fn(),
  // The replay gate on run(). Real behaviour, spelled out rather than imported,
  // because this factory replaces the module wholesale: this cell is not
  // replaying, so nothing is blocked. (BacktestButton.replay.test.tsx is where
  // the blocked side is exercised, against the real module.)
  isChartReplaying: () => false,
  backtestActionBlockedByReplay: () => null,
}));

vi.mock("./lib/feed", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  fetchRangeWithStatus: vi.fn(async () => ({ bars, degraded: null })),
}));

import { backtestRunRequest } from "./lib/signals";
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

const controller = {
  chart: {} as never,
  scope: "cell1",
  readOnly: signal(false),
  indicators: signal([] as Array<{ id: string; type: string }>),
  indicatorsHidden: signal(false),
  subPanesHidden: signal(false),
};

describe("a run re-creates the panes its rules name but the chart lost", () => {
  afterEach(() => {
    cleanup();
    live.length = 0;
    vi.clearAllMocks();
  });

  it("synthesizes the missing pane and ships it in the request", async () => {
    const cfg = defaultBacktestConfig();
    saveBacktestLastUsed({
      ...cfg,
      longEntry: { combine: "AND", rules: [{ expr: "SLOPE2.50 > SLOPE2.100", enabled: true }] },
      range: { ...cfg.range, mode: "bars", bars: 300, resolution: "MINUTE_5" },
    });

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
      // The run awaits several times (fetch, widen walk, engine); flush enough
      // macrotasks for it to reach the post rather than just its first await.
      for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    });

    // The pane was re-created from the refs: one SLOPE instance carrying BOTH
    // referenced lengths.
    expect(applyPortableInstances).toHaveBeenCalledTimes(1);
    expect(applyPortableInstances.mock.calls[0][1]).toEqual({
      SLOPE2: { type: "SLOPE", calcParams: [50, 100], extendData: {} },
    });
    // ...and the request the engine ran carries it, which is the whole point:
    // a repair that happened after the chart read would ship nothing and 422.
    const req = runAndRender.mock.calls[0]?.[1] as { indicators?: Record<string, unknown> };
    expect(req.indicators).toHaveProperty("SLOPE2");
  });

  it("leaves a run alone when every referenced pane is live", async () => {
    live.push({ id: "SLOPE", type: "SLOPE", calcParams: [50], extendData: {} });
    const cfg = defaultBacktestConfig();
    saveBacktestLastUsed({
      ...cfg,
      longEntry: { combine: "AND", rules: [{ expr: "SLOPE.50 > 0", enabled: true }] },
      range: { ...cfg.range, mode: "bars", bars: 300, resolution: "MINUTE_5" },
    });

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
      // The run awaits several times (fetch, widen walk, engine); flush enough
      // macrotasks for it to reach the post rather than just its first await.
      for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    });

    expect(applyPortableInstances.mock.calls[0]?.[1]).toEqual({});
  });

  it("a DISABLED rule's dead pane is not re-created (the backend skips the row)", async () => {
    const cfg = defaultBacktestConfig();
    saveBacktestLastUsed({
      ...cfg,
      longEntry: { combine: "AND", rules: [{ expr: "SLOPE2.50 > 0", enabled: false }] },
      range: { ...cfg.range, mode: "bars", bars: 300, resolution: "MINUTE_5" },
    });

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
      // The run awaits several times (fetch, widen walk, engine); flush enough
      // macrotasks for it to reach the post rather than just its first await.
      for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    });

    expect(applyPortableInstances.mock.calls[0]?.[1]).toEqual({});
  });
});
