// @vitest-environment jsdom
// The clear (✕ / footer "Clear results") must leave nothing stale behind: the
// trade review card, the "Took …" duration readout, and the trades-tab select
// notice all render against the cleared result if clear() forgets them. The
// core teardown (chart artifacts + persisted result) is clearBacktest's job and
// is asserted only as a call here — its internals are covered in lib/backtest.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

import { installMemStorage } from "./lib/testMemStorage";

installMemStorage();

const { clearBacktest } = vi.hoisted(() => ({ clearBacktest: vi.fn() }));

vi.mock("./lib/backtest", () => ({
  runAndRender: vi.fn(),
  clearBacktest,
  fitBacktestTrades: vi.fn(),
  coverBacktestHistory: vi.fn(async () => null),
  oldestBacktestAnchorMs: () => null,
  renderWfoArtifacts: vi.fn(),
  isChartReplaying: () => false,
  backtestActionBlockedByReplay: () => null,
}));
vi.mock("./lib/indicators", () => ({ liveExprInstances: () => [] }));

import {
  backtestClearRequest,
  backtestDurationSignal,
  backtestResultSignal,
  backtestSelectNoticeSignal,
  requestBacktestClear,
  tradeReviewSignal,
} from "./lib/signals";
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

describe("clear leaves no stale backtest state", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    backtestResultSignal.set(null);
    tradeReviewSignal.set(null);
    backtestDurationSignal.set(null);
    backtestSelectNoticeSignal.set(null);
  });

  it("nulls the review card, duration readout and select notice along with the result", () => {
    render(
      <BacktestButton
        controller={controller as never}
        period={{ resolution: "MINUTE_5" } as never}
        epic="GOLD"
        brokerId="dukascopy"
        priceSide="mid"
      />,
    );
    act(() => {
      backtestResultSignal.set({ trades: [] } as never);
      tradeReviewSignal.set({ tradeIndex: 0 } as never);
      backtestDurationSignal.set(1234);
      backtestSelectNoticeSignal.set("3 trades selected");
    });
    act(() => requestBacktestClear());
    expect(clearBacktest).toHaveBeenCalledTimes(1);
    expect(backtestResultSignal.value).toBeNull();
    expect(tradeReviewSignal.value).toBeNull();
    expect(backtestDurationSignal.value).toBeNull();
    expect(backtestSelectNoticeSignal.value).toBeNull();
  });
});
