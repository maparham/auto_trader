import { describe, it, expect, vi } from "vitest";
import type { KLineData } from "klinecharts";

// chartPainters.ts transitively imports the customIndicators barrel + slope.ts,
// which build indicator TEMPLATES at module load (reading klinecharts' runtime
// enums). Stub that surface like the indicator tests do, then top-level `await
// import` so the mock is in place before evaluation.
vi.mock("klinecharts", () => ({
  LineType: { Solid: "solid", Dashed: "dashed" },
  PolygonType: { Fill: "fill", Stroke: "stroke", StrokeFill: "stroke_fill" },
  IndicatorSeries: { Normal: "normal", Price: "price" },
  TooltipShowRule: { Always: "always", FollowCross: "follow_cross", None: "none" },
  registerIndicator: () => {},
  registerOverlay: () => {},
}));

const { buildSlopeMaPills } = await import("./chartPainters");

const bar = (t: number, c: number): KLineData =>
  ({ timestamp: t, open: c, high: c, low: c, close: c, volume: 1 }) as KLineData;

// ~25 ascending bars so a length-21 MA actually resolves values (SMA(21) needs a
// full window before it emits anything).
const DATA: KLineData[] = Array.from({ length: 25 }, (_, i) => bar(i * 60_000, 100 + i));

// A minimal fake `chart` exposing only what buildSlopeMaPills reads.
function fakeChart(slope: {
  showMa?: boolean;
  maType?: string;
  curveLabels?: unknown;
  visible?: boolean;
  calcParams?: unknown[];
}) {
  const ind = {
    name: "SLOPE",
    visible: slope.visible ?? true,
    calcParams: slope.calcParams ?? [21],
    extendData: {
      indType: "SLOPE",
      showMa: slope.showMa,
      maType: slope.maType ?? "ema",
      ...(slope.curveLabels !== undefined ? { curveLabels: slope.curveLabels } : {}),
    },
  };
  const panes = new Map([["pane_1", new Map([["SLOPE", ind]])]]);
  return {
    getIndicatorByPaneId: () => panes,
    getDataList: () => DATA,
    getVisibleRange: () => ({ from: 0, to: DATA.length }),
    convertToPixel: (pts: Array<unknown>) => pts.map(() => ({ x: 100, y: 200 })),
  } as never;
}

describe("buildSlopeMaPills", () => {
  const maxX = 500;

  it("returns [] when showMa is off", () => {
    expect(buildSlopeMaPills(fakeChart({ showMa: false }), [], maxX)).toEqual([]);
  });

  it("returns [] when not active and not always (default when-selected)", () => {
    expect(buildSlopeMaPills(fakeChart({ showMa: true }), [], maxX)).toEqual([]);
  });

  it("emits one pill for an active Slope with default config", () => {
    const pills = buildSlopeMaPills(
      fakeChart({ showMa: true }),
      [{ paneId: "x", name: "SLOPE" }],
      maxX,
    );
    expect(pills.length).toBe(1);
    expect(pills[0].text).toBe("EMA 21");
    expect(pills[0].side).toBe("right");
    expect(pills[0].align).toBe("center");
    expect(pills[0].maxX).toBe(maxX);
    expect(typeof pills[0].color).toBe("string");
  });

  it("emits when always=true even with no active targets", () => {
    const pills = buildSlopeMaPills(
      fakeChart({ showMa: true, curveLabels: { enabled: true, always: true } }),
      [],
      maxX,
    );
    expect(pills.length).toBe(1);
    expect(pills[0].text).toBe("EMA 21");
  });

  it("returns [] when curve labels are disabled, even for an active target", () => {
    expect(
      buildSlopeMaPills(
        fakeChart({ showMa: true, curveLabels: { enabled: false } }),
        [{ paneId: "x", name: "SLOPE" }],
        maxX,
      ),
    ).toEqual([]);
  });
});
