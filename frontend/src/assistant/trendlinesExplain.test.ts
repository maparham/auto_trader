// @vitest-environment jsdom
// trendlines_explain_line on real INTC weekly bars (capital-live, Nov 2026):
// a falling line from the 142.34 June high through the 130.30 September high,
// hidden by Max Distance once the live price drops under ~59.5.
import { describe, expect, it } from "vitest";
import type { KLineData } from "klinecharts";
import { explainTrendline, type ExplainDeps } from "./trendlinesExplain";
import rows from "./trendlinesExplain.fixture.json";

// The user's pane settings, Max Distance (%) at 108.17.
const PARAMS = [5, 0, 2, 11, 90, 50, 2, 0, 40, 0, 0, 0.3, -0.3, 0, 0, 0, 3, 0.3, 88, 0, 108.17, 0.58, 5, 0, 12, 10, 3, 0, 0, 0.01, 0, 0, 0];
const T1 = Date.UTC(2026, 5, 29); // week of the 142.34 high
const T2 = Date.UTC(2026, 8, 21); // week of the 130.30 high

function deps(lastClose: number, extra: Partial<ExplainDeps> = {}): ExplainDeps {
  const bars = (rows as number[][]).map(([timestamp, open, high, low, close]) =>
    ({ timestamp, open, high, low, close, volume: 0 }) as KLineData);
  bars[bars.length - 1] = { ...bars[bars.length - 1], close: lastClose };
  const ind = { name: "TRENDLINES", paneId: "candle_pane", calcParams: PARAMS, extendData: { indType: "TRENDLINES" }, result: [] };
  const chart = { getIndicators: () => [ind], getDataList: () => bars };
  return { chart: chart as never, drawingPoints: () => null, ...extra };
}

const line = { id: "TRENDLINES", t1: T1, p1: 142.34, t2: T2, p2: 130.3 };

describe("explainTrendline", () => {
  it("names Max Distance as the blocker and verifies the smallest fix", async () => {
    const r = await explainTrendline(line, deps(59.4));
    if ("error" in r) throw new Error(r.error);
    expect(r.out.drawn).toBe(false);
    expect(r.out.noCandidate).toBe(false);
    expect(r.out.blockedBy.map((b) => b.gate)).toEqual(["distancePct"]);
    expect(r.out.blockedBy[0].limit).toBe(108.17);
    expect(r.out.blockedBy[0].measured!).toBeGreaterThan(108.17);
    expect(r.out.fix?.changes).toHaveLength(1);
    const ch = r.out.fix!.changes[0];
    expect(ch.from).toBe(108.17);
    expect(ch.to).toBeGreaterThan(108.17);
    expect(ch.to).toBeLessThan(112);
    expect(ch.label).toMatch(/distance/i);
  });

  it("reports a drawn line as drawn, with nothing blocking it", async () => {
    const r = await explainTrendline(line, deps(65.25));
    if ("error" in r) throw new Error(r.error);
    expect(r.out).toMatchObject({ drawn: true, blockedBy: [], fix: null });
  });

  it("reads the target from a drawing", async () => {
    const pts = [{ timestamp: T2, value: 130.3 }, { timestamp: T1, value: 142.34 }];
    const r = await explainTrendline({ id: "TRENDLINES", drawingId: "d1" }, deps(65.25, { drawingPoints: (id) => (id === "d1" ? pts : null) }));
    if ("error" in r) throw new Error(r.error);
    expect(r.out.drawn).toBe(true);
    const missing = await explainTrendline({ id: "TRENDLINES", drawingId: "nope" }, deps(65.25));
    expect(missing).toEqual({ error: "NOT_FOUND: no drawing with id nope" });
  });

  it("refuses an unknown or non-Trendlines id", async () => {
    expect(await explainTrendline({ ...line, id: "RSI" }, deps(60))).toEqual({ error: "NOT_FOUND: no indicator with id RSI" });
  });
});
