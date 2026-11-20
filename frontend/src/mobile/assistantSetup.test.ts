// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { installMemStorage } from "../lib/testMemStorage";

installMemStorage();

const fetchAssistantStatus = vi.fn();
vi.mock("../assistant/api", async (orig) => ({
  ...(await orig<object>()),
  fetchAssistantStatus: (...a: unknown[]) => fetchAssistantStatus(...a),
}));
const resolveInstrument = vi.fn();
vi.mock("../lib/feed", async (orig) => ({
  ...(await orig<object>()),
  resolveInstrument: (...a: unknown[]) => resolveInstrument(...a),
}));

import { installMobileAssistant, MARKET_SELECT_WAIT_MS } from "./assistantSetup";
import { listActions, invokeAction } from "../agent/registry";
import { focusedChart } from "../agent/actions/chart";
import { focusedDrawings } from "../agent/actions/drawings";
import { buildTools } from "../assistant/tools";
import {
  mobileAccount,
  mobileChartCtx,
  mobileChartScope,
  mobilePeriod,
  mobileSymbol,
} from "./mobileChartState";

const inst = (epic: string) => ({ epic, name: epic, pricePrecision: 2 }) as never;
const ctxFor = (scope: string) => ({ chart: { id: scope }, controller: { scope, overlays: { id: scope } } }) as never;

function showChart(epic: string) {
  mobileSymbol.set(inst(epic));
  mobileChartScope.set({ scope: `mobile:${epic}`, epic } as never);
  mobileChartCtx.set(ctxFor(`mobile:${epic}`));
}

beforeEach(() => {
  mobileAccount.set("capital:demo");
  mobilePeriod.set({ resolution: "HOUR", label: "1h" } as never);
  showChart("US100");
  resolveInstrument.mockImplementation(async (epic: string) => inst(epic));
  installMobileAssistant();
});

describe("installMobileAssistant", () => {
  it("offers the chart, indicator and drawing tools, never backtest or dealing", () => {
    const names = listActions().map((a) => a.name);
    for (const n of ["chart.state", "indicator.add", "drawing.add", "market.select"]) expect(names).toContain(n);
    for (const n of ["backtest.run", "order.place", "sweep.start"]) expect(names).not.toContain(n);
    const tools = buildTools().map((t) => t.name);
    expect(tools).toContain("indicator_add");
    expect(tools).not.toContain("backtest_run");
  });

  it("is safe to call twice and asks for the assistant status", () => {
    expect(() => installMobileAssistant()).not.toThrow();
    expect(fetchAssistantStatus).toHaveBeenCalled();
  });

  it("points the focused chart and drawings at the phone's chart", () => {
    const f = focusedChart();
    expect(f.epic).toBe("US100");
    expect(f.cellId).toBe("mobile");
    expect(f.resolution).toBe("HOUR");
    expect(f.broker).toBe("capital");
    expect(f.scope).toBe("mobile:US100");
    expect(focusedDrawings().cellId).toBe("mobile");
  });

  it("has no focused chart while the mounted one is for another symbol", () => {
    mobileSymbol.set(inst("DE40"));
    expect(() => focusedChart()).toThrow(/no focused chart/);
  });

  it("market.select waits for the new chart before it answers", async () => {
    const p = invokeAction("market.select", { epic: "DE40" }, {} as never);
    let done = false;
    void p.then(() => (done = true));
    await new Promise((r) => setTimeout(r, 50));
    expect(mobileSymbol.value?.epic).toBe("DE40");
    expect(done).toBe(false);
    mobileChartScope.set({ scope: "mobile:DE40", epic: "DE40" } as never);
    mobileChartCtx.set(ctxFor("mobile:DE40"));
    await expect(p).resolves.toMatchObject({ epic: "DE40" });
    expect(focusedChart().epic).toBe("DE40");
  });

  it("market.select gives up with an error when the chart never mounts", async () => {
    vi.useFakeTimers();
    try {
      const p = invokeAction("market.select", { epic: "JP225" }, {} as never);
      const check = expect(p).rejects.toThrow(/did not open/);
      await vi.advanceTimersByTimeAsync(MARKET_SELECT_WAIT_MS + 500);
      await check;
    } finally {
      vi.useRealTimers();
    }
  });
});
