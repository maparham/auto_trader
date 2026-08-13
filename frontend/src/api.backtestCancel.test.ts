import { afterEach, expect, it, vi } from "vitest";
import { cancelBacktestRun, runBacktest, runExprBacktest } from "./api";

afterEach(() => vi.restoreAllMocks());

const okResponse = { ok: true, json: async () => ({}) } as Response;

it("cancelBacktestRun POSTs the cancel route and swallows a 404 (run already done)", async () => {
  const fetchMock = vi.fn(async () => ({ ok: false, status: 404 }) as Response);
  vi.stubGlobal("fetch", fetchMock);
  await expect(cancelBacktestRun("pid-1")).resolves.toBeUndefined();
  const [url, init] = fetchMock.mock.calls[0];
  expect(String(url)).toContain("/api/backtest/cancel/pid-1");
  expect((init as RequestInit).method).toBe("POST");
});

it("runBacktest threads an AbortSignal into fetch", async () => {
  const fetchMock = vi.fn(async () => okResponse);
  vi.stubGlobal("fetch", fetchMock);
  const ctl = new AbortController();
  await runBacktest({ epic: "X" } as never, ctl.signal);
  expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBe(ctl.signal);
});

it("runExprBacktest threads an AbortSignal into fetch", async () => {
  const fetchMock = vi.fn(async () => okResponse);
  vi.stubGlobal("fetch", fetchMock);
  const ctl = new AbortController();
  await runExprBacktest({ epic: "X" } as never, ctl.signal);
  expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBe(ctl.signal);
});
