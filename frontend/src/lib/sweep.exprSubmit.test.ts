// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { submitExprSweepJob } from "../api";
import type { ExprBacktestRequest } from "../api";
import type { Costs } from "./backtestConfig";
import { runSweep } from "./sweep";
import { sweepStateSignal } from "./signals";

const costs: Costs = {
  quantity: 1,
  commissionPerSide: 0,
  slippage: { kind: "fixed", value: 0, atrMult: 0 },
  spread: 0,
  finLongDailyPct: 0,
  finShortDailyPct: 0,
  startingCash: 10000,
};

const exprReq: ExprBacktestRequest = {
  epic: "TESTEPIC",
  resolution: "HOUR",
  candles: [],
  longEntry: [],
  longExit: [],
  shortEntry: [],
  shortExit: [],
  longEnabled: true,
  shortEnabled: true,
  costs,
  tradeFromTime: 0,
};

const oneComboAxis = [
  { kind: "range" as const, target: "lit:n", label: "n", from: 1, to: 1, step: 1 },
];

// A fetch mock that answers the submit POST with { jobId, total } and then any
// poll GET with a terminal job status (running:false, rows:[]), so
// pollToCompletion resolves on its first poll. Records the URL of every call.
function makeFetchMock() {
  const urls: string[] = [];
  const mock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    urls.push(url);
    const isPoll = url.includes("/api/backtest/sweep/jobs/");
    const body = isPoll
      ? { rows: [], done: 1, total: 1, running: false, cancelled: false, error: null, etaSeconds: null }
      : { jobId: "j1", total: 1 };
    return {
      ok: true,
      status: 200,
      json: async () => body,
    } as unknown as Response;
  });
  return { mock, urls };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  sessionStorage.clear();
  sweepStateSignal.set(null);
});

describe("submitExprSweepJob", () => {
  it("posts to /api/expr/sweep/jobs with the expr rows and sweep body, returns parsed result", async () => {
    const { mock } = makeFetchMock();
    vi.stubGlobal("fetch", mock);

    const combos = [{ "lit:n": 1 }];
    const windows = [100, 200];
    const res = await submitExprSweepJob(exprReq, combos, windows);

    expect(res).toEqual({ jobId: "j1", total: 1 });
    expect(mock).toHaveBeenCalledTimes(1);
    const [url, init] = mock.mock.calls[0];
    expect(String(url).endsWith("/api/expr/sweep/jobs")).toBe(true);
    expect(init?.method).toBe("POST");
    const sent = JSON.parse(init?.body as string);
    expect(sent.epic).toBe("TESTEPIC");
    expect(sent.longEntry).toEqual([]);
    expect(sent.sweep).toEqual({ combos, windows });
  });
});

describe("runSweep endpoint selection", () => {
  it("submits to the EXPR endpoint when opts.expr is true", async () => {
    vi.useFakeTimers();
    const { mock, urls } = makeFetchMock();
    vi.stubGlobal("fetch", mock);

    const p = runSweep(exprReq, oneComboAxis, { expr: true, onRows: () => {}, windows: [1, 2] });
    await vi.advanceTimersByTimeAsync(700);
    await p;

    const submitUrl = urls[0];
    expect(submitUrl.endsWith("/api/expr/sweep/jobs")).toBe(true);
  });

  it("submits to the STRUCTURED endpoint when opts.expr is absent", async () => {
    vi.useFakeTimers();
    const { mock, urls } = makeFetchMock();
    vi.stubGlobal("fetch", mock);

    const p = runSweep(exprReq, oneComboAxis, { onRows: () => {} });
    await vi.advanceTimersByTimeAsync(700);
    await p;

    const submitUrl = urls[0];
    expect(submitUrl.endsWith("/api/backtest/sweep/jobs")).toBe(true);
  });
});
