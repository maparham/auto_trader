// @vitest-environment jsdom
// Picked trendlines (L<n>) on a backtest run: the request carries only the
// lines the shipped rows reference, and the backend's warnings are toasted.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

import { installMemStorage } from "./lib/testMemStorage";

installMemStorage();

// The chart's live panes (none here) and a no-op pane repair: this test needs
// neither, only that run() reaches the engine with its request.
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

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("./lib/notify", async (orig) => ({ ...(await orig<Record<string, unknown>>()), toast }));
vi.mock("./lib/useRuleClipboard", () => ({ applyPortableInstances }));
vi.mock("./lib/indicators", () => ({ liveExprInstances: () => [...live] }));

// Enough candles to clear warm-up, timestamped (ms) inside the resolved
// window so the run reaches the post. runAndRender echoes the request it was
// given so the test can read `lines` off it.
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

describe("picked lines on a run", () => {
  afterEach(() => {
    cleanup();
    live.length = 0;
    vi.clearAllMocks();
  });

  const LINE = { epic: "GOLD", broker: "dukascopy", timeframe: "MINUTE_5", t1: 1, p1: 1, t2: 2, p2: 2, slope: 1, tRef: 3, pRef: 3 };

  it("sends only the referenced lines and toasts the result's warnings", async () => {
    runAndRender.mockImplementationOnce(async (_c: unknown, req: { indicators?: unknown }) => ({
      req, epic: "GOLD", resolution: "MINUTE_5", markers: [], trades: [], metrics: {}, equity: [],
      warnings: ["L1 was picked on another chart"],
    }) as never);
    const cfg = defaultBacktestConfig();
    saveBacktestLastUsed({
      ...cfg,
      longEntry: { combine: "AND", rules: [{ expr: "candle.close x> L1", enabled: true }] },
      lines: { L1: LINE, L2: { ...LINE, p2: 9 } },
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
      for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    });

    const req = runAndRender.mock.calls[0]?.[1] as { lines?: Record<string, unknown> };
    expect(req.lines).toEqual({ L1: LINE });
    expect(toast).toHaveBeenCalledWith("L1 was picked on another chart");
  });
});
