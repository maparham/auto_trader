import { describe, it, expect } from "vitest";
import {
  cramersV,
  rankBiserial,
  quartileEdges,
  winLossContrast,
  type FieldContrast,
} from "./contrast";
import type { StoredBacktestResult } from "./persist";

type Trade = StoredBacktestResult["trades"][number];

function trade(over: Partial<Trade>): Trade {
  return {
    side: "buy",
    quantity: 1,
    entry_time: 1000,
    entry_price: 100,
    exit_time: 2000,
    exit_price: 101,
    pnl: 1,
    leg: "long",
    reason: "target",
    stop_initial: null,
    stop_final: null,
    target: null,
    mae: 0,
    mfe: 0,
    mae_r: null,
    mfe_r: null,
    context: null,
    ...over,
  } as Trade;
}

// n trades with the given context field value, w of them winners.
function batch(n: number, w: number, ctx: Record<string, unknown>): Trade[] {
  return Array.from({ length: n }, (_, i) =>
    trade({ entry_time: 1000 + i, pnl: i < w ? 1 : -1, context: ctx as Trade["context"] }),
  );
}

describe("cramersV", () => {
  it("matches the hand-computed value for a 2x2 table", () => {
    // buckets x (wins, losses): [[20,10],[10,20]] -> chi2 = 20/3, V = sqrt(chi2/60) = 1/3
    expect(cramersV([[20, 10], [10, 20]])).toBeCloseTo(1 / 3, 10);
  });

  it("is 0 when the outcome mix is identical across buckets", () => {
    expect(cramersV([[10, 10], [5, 5]])).toBeCloseTo(0, 10);
  });

  it("is 0 for degenerate tables (one bucket, or one outcome)", () => {
    expect(cramersV([[10, 5]])).toBe(0);
    expect(cramersV([[10, 0], [5, 0]])).toBe(0);
  });
});

describe("rankBiserial", () => {
  it("is +1 when every winner value exceeds every loser value", () => {
    expect(rankBiserial([4, 5, 6], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  it("is -1 when every winner value is below every loser value", () => {
    expect(rankBiserial([1, 2, 3], [4, 5, 6])).toBeCloseTo(-1, 10);
  });

  it("is 0 for identical distributions (ties count half)", () => {
    expect(rankBiserial([1, 2], [1, 2])).toBeCloseTo(0, 10);
  });
});

describe("quartileEdges", () => {
  it("splits values into four equal buckets", () => {
    const edges = quartileEdges([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(edges).toHaveLength(3);
    const counts = [0, 0, 0, 0];
    for (const v of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const idx = edges.findIndex((e) => v <= e);
      counts[idx === -1 ? 3 : idx]++;
    }
    expect(counts).toEqual([2, 2, 2, 2]);
  });
});

describe("winLossContrast", () => {
  it("returns [] when a run is all wins or all losses", () => {
    const trades = batch(30, 30, { trend: "up" });
    expect(winLossContrast(trades)).toEqual([]);
  });

  it("skips fields with fewer than 20 valued trades", () => {
    // trend present on only 10 trades; session on all 30
    const rare = [
      ...batch(10, 8, { trend: "up", session: "london" }),
      ...batch(20, 4, { session: "ny" }),
    ];
    const fields = winLossContrast(rare).map((f) => f.field);
    expect(fields).not.toContain("trend");
    expect(fields).toContain("session");
  });

  it("ranks a separating field above a non-separating one", () => {
    // trend separates hard (up: 18/20 wins, down: 2/20); session is 50/50 everywhere
    const trades = [
      ...batch(20, 18, { trend: "up", session: "london" }),
      ...batch(20, 2, { trend: "down", session: "london" }),
      ...batch(10, 5, { trend: "up", session: "ny" }),
      ...batch(10, 5, { trend: "down", session: "ny" }),
    ];
    const out = winLossContrast(trades);
    const trend = out.find((f) => f.field === "trend")!;
    const session = out.find((f) => f.field === "session")!;
    expect(trend.effect).toBeGreaterThan(session.effect);
    expect(out.indexOf(trend)).toBeLessThan(out.indexOf(session));
  });

  it("reports per-bucket win rate, delta vs overall, and low-sample flags", () => {
    const trades = [...batch(20, 16, { trend: "up" }), ...batch(20, 4, { trend: "down" }), ...batch(3, 1, { trend: "flat" })];
    const trend = winLossContrast(trades).find((f) => f.field === "trend")!;
    const up = trend.buckets.find((b) => b.bucket === "up")!;
    const flat = trend.buckets.find((b) => b.bucket === "flat")!;
    const overall = 21 / 43;
    expect(up.n).toBe(20);
    expect(up.win_rate).toBeCloseTo(0.8, 10);
    expect(up.delta).toBeCloseTo(0.8 - overall, 10);
    expect(up.low_sample).toBe(false);
    expect(flat.low_sample).toBe(true);
  });

  it("writes a conjecture naming the extreme bucket and both rates", () => {
    const trades = [...batch(20, 16, { trend: "up" }), ...batch(20, 4, { trend: "down" })];
    const trend = winLossContrast(trades).find((f) => f.field === "trend")!;
    // down bucket is 20% vs 50% overall -> losses concentrate there
    expect(trend.conjecture).toBe(
      "Losses concentrate where trend is down: 20% win rate vs 50% overall.",
    );
  });

  it("maps day_of_week to day names and hour_utc to 4-hour buckets", () => {
    const trades = [
      ...batch(20, 15, { day_of_week: 0, hour_utc: 9 }),
      ...batch(20, 5, { day_of_week: 4, hour_utc: 14 }),
    ];
    const out = winLossContrast(trades, 0);
    const dow = out.find((f) => f.field === "day_of_week")!;
    expect(dow.buckets.map((b) => b.bucket)).toEqual(["Mon", "Fri"]);
    const hour = out.find((f) => f.field === "hour_utc")!;
    expect(hour.buckets.map((b) => b.bucket)).toEqual(["08:00-12:00", "12:00-16:00"]);
  });

  it("buckets numeric fields into quartiles and ranks by rank-biserial", () => {
    // dist_swing_high low for winners, high for losers: perfect separation
    const trades = [
      ...Array.from({ length: 20 }, (_, i) =>
        trade({ pnl: 1, context: { dist_swing_high: i * 0.1 } as Trade["context"] })),
      ...Array.from({ length: 20 }, (_, i) =>
        trade({ pnl: -1, context: { dist_swing_high: 10 + i * 0.1 } as Trade["context"] })),
    ];
    const f = winLossContrast(trades).find((x) => x.field === "dist_swing_high")!;
    expect(f.effect).toBeCloseTo(1, 10);
    expect(f.buckets).toHaveLength(4);
    expect(f.buckets[0].win_rate).toBeCloseTo(1, 10);
    expect(f.buckets[3].win_rate).toBeCloseTo(0, 10);
  });

  it("derives holding time as a contrast field with duration bucket labels", () => {
    const quick = Array.from({ length: 20 }, (_, i) =>
      trade({ pnl: 1, entry_time: 0, exit_time: 60 + i, context: { trend: "up" } as Trade["context"] }));
    const slow = Array.from({ length: 20 }, (_, i) =>
      trade({ pnl: -1, entry_time: 0, exit_time: 7200 + i * 60, context: { trend: "up" } as Trade["context"] }));
    const f = winLossContrast([...quick, ...slow]).find((x) => x.field === "held")!;
    expect(f.effect).toBeCloseTo(1, 10);
    expect(f.label).toBe("holding time");
    expect(f.buckets[0].bucket).toMatch(/m/); // duration-formatted, not raw seconds
  });

  it("carries each bucket's trade indices, in entry order", () => {
    const trades = [
      ...batch(20, 16, { trend: "up" }),
      ...batch(20, 4, { trend: "down" }),
    ];
    const trend = winLossContrast(trades).find((f) => f.field === "trend")!;
    const up = trend.buckets.find((b) => b.bucket === "up")!;
    const down = trend.buckets.find((b) => b.bucket === "down")!;
    expect(up.indices).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(down.indices).toEqual(Array.from({ length: 20 }, (_, i) => 20 + i));
  });

  it("carries indices for numeric-field buckets too", () => {
    const trades = [
      ...Array.from({ length: 20 }, (_, i) =>
        trade({ pnl: 1, context: { dist_swing_high: i * 0.1 } as Trade["context"] })),
      ...Array.from({ length: 20 }, (_, i) =>
        trade({ pnl: -1, context: { dist_swing_high: 10 + i * 0.1 } as Trade["context"] })),
    ];
    const f = winLossContrast(trades).find((x) => x.field === "dist_swing_high")!;
    expect(f.buckets.flatMap((b) => b.indices).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 40 }, (_, i) => i),
    );
    expect(f.buckets[0].indices.every((i) => i < 20)).toBe(true);
  });

  it("orders every returned field by descending effect", () => {
    const trades = [
      ...batch(20, 18, { trend: "up", session: "london", vol_regime: "low" }),
      ...batch(20, 2, { trend: "down", session: "ny", vol_regime: "low" }),
    ];
    const out = winLossContrast(trades);
    const effects = out.map((f: FieldContrast) => f.effect);
    expect([...effects].sort((a, b) => b - a)).toEqual(effects);
  });
});
