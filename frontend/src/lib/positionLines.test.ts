// @vitest-environment jsdom
// PositionLines reconcile + tradeLineSpecs (pending-merge, labels, draggability).

import { describe, it, expect, beforeEach } from "vitest";
import { PositionLines, tradeLineSpecs, bracketLabels, restingLineEndX, type LineSpec } from "./positionLines";
import type { TradeView } from "./trading";

interface Call {
  fn: "create" | "override" | "remove";
  id?: string;
  arg?: unknown;
}

function fakeChart(bars: { timestamp: number }[] = []) {
  const calls: Call[] = [];
  let seq = 0;
  const chart = {
    getDataList() {
      return bars;
    },
    createOverlay(arg: unknown) {
      const id = `ov-${++seq}`;
      calls.push({ fn: "create", id, arg });
      return id;
    },
    overrideOverlay(arg: { id: string }) {
      calls.push({ fn: "override", id: arg.id, arg });
    },
    removeOverlay(arg: { id: string }) {
      calls.push({ fn: "remove", id: arg.id, arg });
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { chart: chart as any, calls };
}

function spec(over: Partial<LineSpec> = {}): LineSpec {
  return { key: "k1", level: 100, color: "#000", label: "L", draggable: false, restKind: "full", ...over };
}

function trade(over: Partial<TradeView> = {}): TradeView {
  return {
    kind: "position",
    id: "D1",
    epic: "EURUSD",
    side: "buy",
    quantity: 2,
    priceLevel: 100,
    stop: null,
    takeProfit: null,
    upnl: null,
    openedAt: null,
    expiresAt: null,
    leverage: null,
    margin: null,
    ...over,
  };
}

describe("PositionLines.render", () => {
  let chart: ReturnType<typeof fakeChart>;
  let lines: PositionLines;
  beforeEach(() => {
    chart = fakeChart();
    lines = new PositionLines(chart.chart, 5);
  });

  it("creates a line for a new spec", () => {
    lines.render([spec()]);
    expect(chart.calls.filter((c) => c.fn === "create")).toHaveLength(1);
  });

  it("does nothing on an unchanged re-render", () => {
    lines.render([spec()]);
    chart.calls.length = 0;
    lines.render([spec()]);
    expect(chart.calls).toHaveLength(0);
  });

  it("overrides (not recreates) when level changes", () => {
    lines.render([spec({ level: 100 })]);
    chart.calls.length = 0;
    lines.render([spec({ level: 101 })]);
    expect(chart.calls.filter((c) => c.fn === "create")).toHaveLength(0);
    expect(chart.calls.filter((c) => c.fn === "override")).toHaveLength(1);
  });

  it("removes a line whose spec disappears", () => {
    lines.render([spec()]);
    chart.calls.length = 0;
    lines.render([]);
    expect(chart.calls.filter((c) => c.fn === "remove")).toHaveLength(1);
  });

  it("locks a non-draggable line and unlocks a draggable one", () => {
    lines.render([spec({ draggable: true })]);
    const create = chart.calls.find((c) => c.fn === "create");
    expect((create?.arg as { lock: boolean }).lock).toBe(false);
  });

  it("drop reports the quantized level to onDragEnd", () => {
    const dropped: number[] = [];
    lines.render([
      spec({ key: "k1", draggable: true, onDragEnd: (l) => dropped.push(l) }),
    ]);
    // Pull the onPressedMoveEnd handler klinecharts would call, and fire it with
    // a raw dragged value — it must quantize to the drawer's precision (5).
    const create = chart.calls.find((c) => c.fn === "create");
    const handler = (create?.arg as { onPressedMoveEnd: (e: unknown) => void })
      .onPressedMoveEnd;
    handler({ overlay: { id: "ov-1", points: [{ value: 1.234567 }] } });
    expect(dropped).toEqual([1.23457]);
  });

  it("a drop at the unchanged level reports nothing (a click is not an edit)", () => {
    const dropped: number[] = [];
    lines.render([
      spec({ key: "k1", level: 100, draggable: true, onDragEnd: (l) => dropped.push(l) }),
    ]);
    const create = chart.calls.find((c) => c.fn === "create");
    const handler = (create?.arg as { onPressedMoveEnd: (e: unknown) => void })
      .onPressedMoveEnd;
    // A plain click ends a zero-distance press at the same level (sub-precision
    // jitter rounds away) — must NOT stage an edit.
    handler({ overlay: { id: "ov-1", points: [{ value: 100.000001 }] } });
    expect(dropped).toEqual([]);
  });
});

describe("tradeLineSpecs", () => {
  const base = {
    pending: {},
    epic: "EURUSD",
    precision: 2,
    levelsDraggable: true,
    onDrag: () => {},
  };

  it("emits a price line per trade, plus SL/TP only when set", () => {
    const specs = tradeLineSpecs({
      ...base,
      trades: [trade({ stop: 95, takeProfit: 105 })],
    });
    expect(specs.map((s) => s.key)).toEqual(["D1:price", "D1:stop", "D1:tp"]);
  });

  it("omits SL/TP lines when unset", () => {
    const specs = tradeLineSpecs({ ...base, trades: [trade()] });
    expect(specs.map((s) => s.key)).toEqual(["D1:price"]);
  });

  it("merges a pending level over the server level (no snap-back)", () => {
    const specs = tradeLineSpecs({
      ...base,
      trades: [trade({ stop: 95 })],
      pending: { D1: { stop: 96.5 } },
    });
    expect(specs.find((s) => s.key === "D1:stop")?.level).toBe(96.5);
  });

  it("filters to the requested epic", () => {
    const specs = tradeLineSpecs({
      ...base,
      trades: [trade({ epic: "US100" })],
    });
    expect(specs).toHaveLength(0);
  });

  it("labels a position vs a resting order distinctly", () => {
    const pos = tradeLineSpecs({ ...base, trades: [trade()] });
    expect(pos[0].label).toBe("Long 2 @ 100.00");
    const order = tradeLineSpecs({
      ...base,
      trades: [trade({ kind: "order", side: "sell", priceLevel: 105 })],
    });
    expect(order[0].label).toBe("Limit sell 2 @ 105.00");
  });

  it("a resting order's price line is draggable; a filled position's entry is not", () => {
    const pos = tradeLineSpecs({ ...base, trades: [trade()] });
    expect(pos[0].draggable).toBe(false); // filled entry never draggable
    const order = tradeLineSpecs({
      ...base,
      trades: [trade({ kind: "order", id: "O1" })],
    });
    expect(order[0].draggable).toBe(true);
  });

  it("SL/TP draggability follows levelsDraggable", () => {
    const off = tradeLineSpecs({
      ...base,
      levelsDraggable: false,
      trades: [trade({ stop: 95 })],
    });
    expect(off.find((s) => s.key === "D1:stop")?.draggable).toBe(false);
  });

  it("emits draggable draft lines (limit: entry + SL + TP)", () => {
    const specs = tradeLineSpecs({
      ...base,
      trades: [],
      draft: {
        epic: "EURUSD",
        side: "buy",
        quantity: 1,
        type: "limit",
        price: 99,
        stop: 98,
        takeProfit: 101,
        expiresAt: null,
      },
    });
    expect(specs.map((s) => s.key)).toEqual(["draft:price", "draft:stop", "draft:tp"]);
    expect(specs.every((s) => s.draggable)).toBe(true);
    expect(specs[0].label).toBe("Buy limit 1 @ 99.00");
  });

  it("a market draft has no entry line (fills at market)", () => {
    const specs = tradeLineSpecs({
      ...base,
      trades: [],
      draft: {
        epic: "EURUSD",
        side: "sell",
        quantity: 2,
        type: "market",
        price: null,
        stop: 101,
        takeProfit: 99,
        expiresAt: null,
      },
    });
    expect(specs.map((s) => s.key)).toEqual(["draft:stop", "draft:tp"]);
  });

  it("ignores a draft for another epic", () => {
    const specs = tradeLineSpecs({
      ...base,
      trades: [],
      draft: {
        epic: "US100", side: "buy", quantity: 1, type: "limit",
        price: 99, stop: 98, takeProfit: 101, expiresAt: null,
      },
    });
    expect(specs).toHaveLength(0);
  });

  it("treats a null pending field as removed (merges by presence, not ??)", () => {
    const specs = tradeLineSpecs({
      ...base,
      trades: [trade({ stop: 95, takeProfit: 105 })],
      pending: { D1: { stop: null } },
    });
    // stop removed → no SL line; TP untouched.
    expect(specs.map((s) => s.key)).toEqual(["D1:price", "D1:tp"]);
  });

  it("skips all lines for a hidden trade", () => {
    const specs = tradeLineSpecs({
      ...base,
      trades: [trade({ stop: 95, takeProfit: 105 })],
      hidden: new Set(["D1"]),
    });
    expect(specs).toHaveLength(0);
  });

  it("hover overrides hide (a hidden trade's lines reappear while hovered)", () => {
    const specs = tradeLineSpecs({
      ...base,
      trades: [trade({ stop: 95 })],
      hidden: new Set(["D1"]),
      hovered: "D1",
    });
    expect(specs.map((s) => s.key)).toEqual(["D1:price", "D1:stop"]);
  });

  it("marks the hovered trade's lines highlight (others not)", () => {
    const specs = tradeLineSpecs({
      ...base,
      trades: [trade({ id: "D1", stop: 95 }), trade({ id: "D2", priceLevel: 200 })],
      hovered: "D1",
    });
    expect(specs.filter((s) => s.highlight).map((s) => s.key)).toEqual([
      "D1:price",
      "D1:stop",
    ]);
    expect(specs.find((s) => s.key === "D2:price")?.highlight).toBe(false);
  });

  it("select overrides hide (a hidden trade's lines reappear while selected)", () => {
    const specs = tradeLineSpecs({
      ...base,
      trades: [trade({ stop: 95 })],
      hidden: new Set(["D1"]),
      selected: "D1",
    });
    expect(specs.map((s) => s.key)).toEqual(["D1:price", "D1:stop"]);
  });

  it("marks the selected trade's lines selected (others not)", () => {
    const specs = tradeLineSpecs({
      ...base,
      trades: [trade({ id: "D1", stop: 95 }), trade({ id: "D2", priceLevel: 200 })],
      selected: "D1",
    });
    expect(specs.filter((s) => s.selected).map((s) => s.key)).toEqual([
      "D1:price",
      "D1:stop",
    ]);
    expect(specs.find((s) => s.key === "D2:price")?.selected).toBe(false);
  });

  it("a position entry line is bar-anchored to its open time; SL/TP are stubs", () => {
    const specs = tradeLineSpecs({
      ...base,
      trades: [trade({ openedAt: 1_700_000_000_000, stop: 95, takeProfit: 105 })],
    });
    const price = specs.find((s) => s.key === "D1:price");
    expect(price?.restKind).toBe("bar");
    expect(price?.entryTs).toBe(1_700_000_000_000);
    expect(specs.find((s) => s.key === "D1:stop")?.restKind).toBe("stub");
    expect(specs.find((s) => s.key === "D1:tp")?.restKind).toBe("stub");
  });

  it("a position with no open time falls back to a stub entry (can't anchor)", () => {
    const specs = tradeLineSpecs({ ...base, trades: [trade({ openedAt: null })] });
    expect(specs[0].restKind).toBe("stub");
    expect(specs[0].entryTs).toBeUndefined();
  });

  it("a resting order's entry spans the pane (full), not bar-anchored", () => {
    const specs = tradeLineSpecs({
      ...base,
      trades: [trade({ kind: "order", openedAt: 1_700_000_000_000 })],
    });
    expect(specs[0].restKind).toBe("full");
    expect(specs[0].entryTs).toBeUndefined();
  });

  it("draft lines always span the pane (full)", () => {
    const specs = tradeLineSpecs({
      ...base,
      trades: [],
      draft: { epic: "EURUSD", side: "buy", quantity: 1, type: "limit", price: 99, stop: 98, takeProfit: 101, expiresAt: null },
    });
    expect(specs.every((s) => s.restKind === "full")).toBe(true);
  });

  it("emphasized is set by hover, select, or an active drag", () => {
    const t = [trade({ id: "D1", stop: 95 }), trade({ id: "D2", priceLevel: 200 })];
    const hov = tradeLineSpecs({ ...base, trades: t, hovered: "D1" });
    expect(hov.filter((s) => s.emphasized).map((s) => s.key)).toEqual(["D1:price", "D1:stop"]);
    const sel = tradeLineSpecs({ ...base, trades: t, selected: "D1" });
    expect(sel.filter((s) => s.emphasized).map((s) => s.key)).toEqual(["D1:price", "D1:stop"]);
    const drag = tradeLineSpecs({ ...base, trades: t, dragging: "D1" });
    expect(drag.filter((s) => s.emphasized).map((s) => s.key)).toEqual(["D1:price", "D1:stop"]);
    expect(drag.find((s) => s.key === "D2:price")?.emphasized).toBe(false);
  });

  it("merges entry+SL into one red '· BE' line when SL sits at entry (position)", () => {
    const specs = tradeLineSpecs({
      ...base,
      trades: [trade({ priceLevel: 100, stop: 100, openedAt: 1_700_000_000_000 })],
    });
    // Only the entry line survives — no separate :stop.
    expect(specs.map((s) => s.key)).toEqual(["D1:price"]);
    const merged = specs[0];
    expect(merged.color).toBe("#f23645"); // STOP_COLOR — the stop is the live constraint
    expect(merged.draggable).toBe(false); // display-only; un-breakeven via the form
    expect(merged.restKind).toBe("bar"); // keeps the entry-candle anchor + dot
    expect(merged.label).toBe("Long 2 @ 100.00 · BE");
  });

  it("does NOT merge when SL is a tick away from entry", () => {
    const specs = tradeLineSpecs({
      ...base,
      trades: [trade({ priceLevel: 100, stop: 99.99, openedAt: 1 })],
    });
    expect(specs.map((s) => s.key)).toEqual(["D1:price", "D1:stop"]);
    expect(specs[0].color).toBe("#6b7280"); // PRICE_COLOR — normal entry
  });

  it("respects a pending SL dragged to entry (merges) via presence-merge", () => {
    const specs = tradeLineSpecs({
      ...base,
      trades: [trade({ priceLevel: 100, stop: 95, openedAt: 1 })],
      pending: { D1: { stop: 100 } },
    });
    expect(specs.map((s) => s.key)).toEqual(["D1:price"]);
    expect(specs[0].label).toBe("Long 2 @ 100.00 · BE");
  });

  it("never merges a resting order (no fill) even if stop equals price", () => {
    const specs = tradeLineSpecs({
      ...base,
      trades: [trade({ kind: "order", id: "O1", priceLevel: 100, stop: 100 })],
    });
    expect(specs.map((s) => s.key)).toEqual(["O1:price", "O1:stop"]);
    expect(specs.find((s) => s.key === "O1:price")?.color).toBe("#6b7280");
  });

  it("merges entry+TP into one green '· BE' line when TP sits at entry (position)", () => {
    const specs = tradeLineSpecs({
      ...base,
      trades: [trade({ priceLevel: 100, takeProfit: 100, openedAt: 1_700_000_000_000 })],
    });
    // Only the entry line survives — no separate :tp.
    expect(specs.map((s) => s.key)).toEqual(["D1:price"]);
    const merged = specs[0];
    expect(merged.color).toBe("#089981"); // TP_COLOR — the target is the merged level
    expect(merged.draggable).toBe(false); // display-only; un-breakeven via the form
    expect(merged.restKind).toBe("bar"); // keeps the entry-candle anchor + dot
    expect(merged.label).toBe("Long 2 @ 100.00 · BE");
  });

  it("does NOT merge when TP is a tick away from entry", () => {
    const specs = tradeLineSpecs({
      ...base,
      trades: [trade({ priceLevel: 100, takeProfit: 100.01, openedAt: 1 })],
    });
    expect(specs.map((s) => s.key)).toEqual(["D1:price", "D1:tp"]);
    expect(specs[0].color).toBe("#6b7280"); // PRICE_COLOR — normal entry
  });

  it("respects a pending TP dragged to entry (merges) via presence-merge", () => {
    const specs = tradeLineSpecs({
      ...base,
      trades: [trade({ priceLevel: 100, takeProfit: 105, openedAt: 1 })],
      pending: { D1: { takeProfit: 100 } },
    });
    expect(specs.map((s) => s.key)).toEqual(["D1:price"]);
    expect(specs[0].label).toBe("Long 2 @ 100.00 · BE");
  });

  it("stop-breakeven wins when SL and TP both sit at entry (line is red)", () => {
    const specs = tradeLineSpecs({
      ...base,
      trades: [trade({ priceLevel: 100, stop: 100, takeProfit: 100, openedAt: 1 })],
    });
    // Both collapse; the entry line takes the stop's red and only it survives.
    expect(specs.map((s) => s.key)).toEqual(["D1:price"]);
    expect(specs[0].color).toBe("#f23645"); // STOP_COLOR — stop precedence
  });
});

describe("restingLineEndX", () => {
  const W = 1000;

  it("spans the pane when emphasized or restKind full", () => {
    expect(restingLineEndX({ restKind: "bar", emphasized: true, entryX: 400, width: W })).toEqual({ endX: W, dotX: null });
    expect(restingLineEndX({ restKind: "full", emphasized: false, entryX: null, width: W })).toEqual({ endX: W, dotX: null });
  });

  it("stubs a stub line, no dot", () => {
    expect(restingLineEndX({ restKind: "stub", emphasized: false, entryX: null, width: W })).toEqual({ endX: 136, dotX: null });
  });

  it("ends a bar line at its entry candle with a dot when on-body", () => {
    expect(restingLineEndX({ restKind: "bar", emphasized: false, entryX: 400, width: W })).toEqual({ endX: 400, dotX: 400 });
  });

  it("degrades to a stub (no dot) when the entry candle is off the left edge", () => {
    expect(restingLineEndX({ restKind: "bar", emphasized: false, entryX: -50, width: W })).toEqual({ endX: 136, dotX: null });
  });

  it("stays full-width (no dot) when the entry candle is off the right edge", () => {
    // Viewing history from before the entry: everything visible predates it.
    expect(restingLineEndX({ restKind: "bar", emphasized: false, entryX: 1200, width: W })).toEqual({ endX: W, dotX: null });
  });

  it("falls back to a stub when a bar line has no resolvable entry x", () => {
    expect(restingLineEndX({ restKind: "bar", emphasized: false, entryX: null, width: W })).toEqual({ endX: 136, dotX: null });
  });
});

describe("bracketLabels", () => {
  it("reports unsigned magnitude %s and reward/risk for a long", () => {
    // entry 100, TP 110 (+10%), SL 95 (−5%) → R:R = 10/5 = 2
    const l = bracketLabels({ entry: 100, stop: 95, tp: 110 });
    expect(l.tpPct).toBeCloseTo(10);
    expect(l.slPct).toBeCloseTo(5);
    expect(l.rr).toBeCloseTo(2);
  });

  it("is side-agnostic: a short's TP (below entry) still reads as a positive %", () => {
    // Short entry 100: TP 90 (target, BELOW), SL 105 (stop, ABOVE). Magnitudes stay
    // positive — colour, not sign, carries gain/loss. R:R = 10/5 = 2 (same as the long).
    const l = bracketLabels({ entry: 100, stop: 105, tp: 90 });
    expect(l.tpPct).toBeCloseTo(10);
    expect(l.slPct).toBeCloseTo(5);
    expect(l.rr).toBeCloseTo(2);
  });

  it("yields R:R only when both legs are present", () => {
    expect(bracketLabels({ entry: 100, stop: null, tp: 110 }).rr).toBeNull();
    expect(bracketLabels({ entry: 100, stop: 95, tp: null }).rr).toBeNull();
    expect(bracketLabels({ entry: 100, stop: 95, tp: 110 }).rr).not.toBeNull();
  });

  it("suppresses everything without an entry anchor (market draft, no live price)", () => {
    const l = bracketLabels({ entry: null, stop: 95, tp: 110 });
    expect(l).toEqual({ tpPct: null, slPct: null, rr: null });
  });

  it("guards a zero entry (no divide-by-zero)", () => {
    const l = bracketLabels({ entry: 0, stop: -5, tp: 5 });
    expect(l.tpPct).toBeNull();
    expect(l.slPct).toBeNull();
  });
});

describe("PositionLines bar anchoring", () => {
  const barSpec = (over: Partial<LineSpec> = {}) =>
    spec({ restKind: "bar", entryTs: 1_000, ...over });

  it("adds a second, bar-snapped point for a bar-anchored spec", () => {
    // Bars at 900 / 1000 / 1100; entry at 1050 sits in the bar that CONTAINS it (1000),
    // matching how the entry marker anchors (barIndexForTs, not nearest).
    const chart = fakeChart([{ timestamp: 900 }, { timestamp: 1000 }, { timestamp: 1100 }]);
    const lines = new PositionLines(chart.chart, 5);
    lines.render([barSpec({ entryTs: 1050 })]);
    const create = chart.calls.find((c) => c.fn === "create");
    const arg = create?.arg as { points: { value?: number; timestamp?: number }[]; extendData: { hasBar: boolean } };
    expect(arg.points).toHaveLength(2);
    expect(arg.points[1].timestamp).toBe(1000);
    expect(arg.extendData.hasBar).toBe(true);
  });

  it("falls back to a single point (stub) when the entry predates the loaded window", () => {
    const chart = fakeChart([{ timestamp: 1000 }, { timestamp: 1100 }]);
    const lines = new PositionLines(chart.chart, 5);
    lines.render([barSpec({ entryTs: 500 })]); // older than oldest loaded bar (1000)
    const create = chart.calls.find((c) => c.fn === "create");
    const arg = create?.arg as { points: unknown[]; extendData: { hasBar: boolean } };
    expect(arg.points).toHaveLength(1);
    expect(arg.extendData.hasBar).toBe(false);
  });

  it("re-reconciles when the snapped entry bar changes (scroll pages it in)", () => {
    const chart = fakeChart([{ timestamp: 1000 }, { timestamp: 1100 }]);
    const lines = new PositionLines(chart.chart, 5);
    lines.render([barSpec({ entryTs: 500 })]); // off-window → stub
    chart.calls.length = 0;
    // Same spec, but now the entry bar is loaded → the sig must change and override.
    const chart2Bars = [{ timestamp: 400 }, { timestamp: 500 }, { timestamp: 1000 }];
    (chart.chart as unknown as { getDataList: () => unknown }).getDataList = () => chart2Bars;
    lines.render([barSpec({ entryTs: 500 })]);
    expect(chart.calls.filter((c) => c.fn === "override")).toHaveLength(1);
  });
});

describe("PositionLines highlight reconcile", () => {
  it("overrides (not recreates) when only highlight toggles", () => {
    const chart = fakeChart();
    const lines = new PositionLines(chart.chart, 5);
    lines.render([spec()]);
    chart.calls.length = 0;
    lines.render([spec({ highlight: true })]);
    expect(chart.calls.filter((c) => c.fn === "create")).toHaveLength(0);
    expect(chart.calls.filter((c) => c.fn === "override")).toHaveLength(1);
  });
});
