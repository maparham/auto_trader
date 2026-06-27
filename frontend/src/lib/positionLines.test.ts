// PositionLines reconcile + tradeLineSpecs (pending-merge, labels, draggability).

import { describe, it, expect, beforeEach } from "vitest";
import { PositionLines, tradeLineSpecs, type LineSpec } from "./positionLines";
import type { TradeView } from "./trading";

interface Call {
  fn: "create" | "override" | "remove";
  id?: string;
  arg?: unknown;
}

function fakeChart() {
  const calls: Call[] = [];
  let seq = 0;
  const chart = {
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
  return { key: "k1", level: 100, color: "#000", label: "L", draggable: false, ...over };
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
        price: 99, stop: 98, takeProfit: 101,
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
