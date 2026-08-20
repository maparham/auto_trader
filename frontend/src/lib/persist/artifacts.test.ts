import { describe, it, expect, beforeEach } from "vitest";
import { installMemStorage } from "../testMemStorage";

installMemStorage();
const { saveBacktestResult, loadBacktestResult, loadSweepResultId, saveSweepResultId, clearSweepResultId, matchBacktestKey, matchSweepPointerKey, loadInsetBand, saveInsetBand } =
  await import("./artifacts");
const { save } = await import("./core");
const { EQUITY_PERSIST_CAP } = await import("../equityDownsample");

beforeEach(() => localStorage.clear());

// Minimal BacktestResult-shaped object with an oversized equity array + candles.
const bigResult = (nEquity: number) =>
  ({
    epic: "US100",
    resolution: "MINUTE_5",
    candles: Array.from({ length: 10 }, (_, i) => ({ timestamp: i, open: 1, high: 1, low: 1, close: 1, volume: 0 })),
    markers: [],
    trades: [],
    equity: Array.from({ length: nEquity }, (_, i) => ({ time: 1000 + i, value: i + 0.111 })),
    summary: { net_pnl: 0, n_trades: 0, win_rate: 0, max_drawdown: 0 },
    metrics: {} as never,
  }) as unknown as import("../../api").BacktestResult;

const KEY = "auto-trader.tab.A.backtest.US100";

describe("saveBacktestResult / loadBacktestResult", () => {
  it("downsamples equity to <= cap and strips candles on save", () => {
    const ok = saveBacktestResult("tab.A", "US100", bigResult(37128));
    expect(ok).toBe(true);
    const loaded = loadBacktestResult("tab.A", "US100")!;
    expect(loaded.equity.length).toBeLessThanOrEqual(EQUITY_PERSIST_CAP + 1);
    expect((loaded as { candles?: unknown }).candles).toBeUndefined();
    expect(loaded.equity[0].time).toBe(1000);
  });

  it("returns false when the underlying write is dropped", () => {
    const orig = localStorage.setItem.bind(localStorage);
    localStorage.setItem = () => {
      throw new DOMException("quota", "QuotaExceededError");
    };
    try {
      expect(saveBacktestResult("tab.A", "US100", bigResult(10))).toBe(false);
    } finally {
      localStorage.setItem = orig;
    }
  });

  it("self-heals an already-oversized stored entry on load (downsamples + rewrites)", () => {
    // Write a pre-fix oversized entry DIRECTLY (bypassing saveBacktestResult) to
    // simulate data saved before this fix.
    const oversized = { ...bigResult(37128) };
    delete (oversized as { candles?: unknown }).candles;
    save(KEY, oversized);
    expect(JSON.parse(localStorage.getItem(KEY)!).equity.length).toBe(37128);

    const loaded = loadBacktestResult("tab.A", "US100")!;
    expect(loaded.equity.length).toBeLessThanOrEqual(EQUITY_PERSIST_CAP + 1);
    // The rewrite reclaimed space: the stored entry is now slim too.
    expect(JSON.parse(localStorage.getItem(KEY)!).equity.length).toBeLessThanOrEqual(
      EQUITY_PERSIST_CAP + 1,
    );
  });

  it("leaves an already-slim entry untouched on load", () => {
    saveBacktestResult("tab.A", "US100", bigResult(50));
    const before = localStorage.getItem(KEY);
    loadBacktestResult("tab.A", "US100");
    expect(localStorage.getItem(KEY)).toBe(before);
  });

  it("boundary: does not self-heal a just-capped entry (cap+1 points)", () => {
    // A raw equity of 4000 points, when downsampled with step=ceil(4000/2000)=2,
    // yields 2000 strided points + 1 appended final point = 2001 total.
    // This tests the exact boundary: downsampleEquity always appends the final
    // point, so a freshly-capped entry is at most cap+1. Only entries beyond
    // that are genuinely legacy-oversized and worth re-downsampling.
    saveBacktestResult("tab.A", "US100", bigResult(4000));
    const beforeLoad = localStorage.getItem(KEY)!;
    const beforeParsed = JSON.parse(beforeLoad);
    expect(beforeParsed.equity.length).toBe(2001); // Just-capped at cap+1

    // Load once: should NOT trigger self-heal rewrite (the entry is already slim).
    const loaded = loadBacktestResult("tab.A", "US100")!;
    const afterLoad = localStorage.getItem(KEY)!;

    // Assert: localStorage unchanged (no spurious re-downsampling).
    expect(afterLoad).toBe(beforeLoad);
    // Assert: returned result still has 2001 points (not re-thinned).
    expect(loaded.equity.length).toBe(2001);
  });
});

describe("sweep result pointer (per scope + epic)", () => {
  it("round-trips an archive id and isolates scope + epic", () => {
    expect(loadSweepResultId("tab.A", "US100")).toBeNull();

    saveSweepResultId("tab.A", "US100", "sw-1");
    expect(loadSweepResultId("tab.A", "US100")).toBe("sw-1");

    // A different cell (scope) on the same epic has its own binding.
    expect(loadSweepResultId("tab.A.cell.b", "US100")).toBeNull();
    // The same cell on a different epic is independent.
    expect(loadSweepResultId("tab.A", "US500")).toBeNull();

    saveSweepResultId("tab.A.cell.b", "US100", "sw-2");
    expect(loadSweepResultId("tab.A", "US100")).toBe("sw-1");
    expect(loadSweepResultId("tab.A.cell.b", "US100")).toBe("sw-2");
  });

  it("clears the pointer", () => {
    saveSweepResultId("tab.A", "US100", "sw-1");
    clearSweepResultId("tab.A", "US100");
    expect(loadSweepResultId("tab.A", "US100")).toBeNull();
  });
});

describe("matchBacktestKey", () => {
  it("matches a visible scope's backtest key and extracts the epic", () => {
    expect(matchBacktestKey("auto-trader.tab.A.backtest.US100", ["tab.A"])).toEqual({
      scope: "tab.A",
      epic: "US100",
    });
    expect(
      matchBacktestKey("auto-trader.tab.A.cell.b.backtest.EURUSD", ["tab.A", "tab.A.cell.b"]),
    ).toEqual({ scope: "tab.A.cell.b", epic: "EURUSD" });
  });

  it("does not cross-match between a tab scope and its cell scopes", () => {
    // The cell key starts with the tab scope's prefix but not its backtest
    // prefix — it must resolve to the cell scope only.
    expect(matchBacktestKey("auto-trader.tab.A.cell.b.backtest.US100", ["tab.A"])).toBeNull();
  });

  it("returns null for non-backtest content keys and empty epics", () => {
    expect(matchBacktestKey("auto-trader.tab.A.drawings.US100", ["tab.A"])).toBeNull();
    expect(matchBacktestKey("auto-trader.tab.A.backtest.", ["tab.A"])).toBeNull();
    expect(matchBacktestKey("auto-trader.tab.B.backtest.US100", ["tab.A"])).toBeNull();
  });
});

describe("matchSweepPointerKey", () => {
  it("matches a visible scope's sweep pointer key, and nothing else", () => {
    expect(matchSweepPointerKey("auto-trader.tab.A.sweep.US100", ["tab.A"])).toEqual({
      scope: "tab.A",
      epic: "US100",
    });
    expect(matchSweepPointerKey("auto-trader.tab.A.backtest.US100", ["tab.A"])).toBeNull();
    expect(matchSweepPointerKey("auto-trader.tab.B.sweep.US100", ["tab.A"])).toBeNull();
  });
});

describe("inset band height", () => {
  it("round-trips the dragged fraction per scope", () => {
    saveInsetBand("tab.A", 0.42);
    expect(loadInsetBand("tab.A")).toBe(0.42);
    // Per cell: a second chart in the same tab keeps its own band.
    expect(loadInsetBand("tab.B")).toBeNull();
  });

  it("reads null for a cell that was never dragged, so the default applies", () => {
    expect(loadInsetBand("tab.A")).toBeNull();
  });

  it("rejects a stored non-number instead of handing a NaN band to the chart", () => {
    save("auto-trader.tab.A.insetBand", "half" as never);
    expect(loadInsetBand("tab.A")).toBeNull();
  });
});
