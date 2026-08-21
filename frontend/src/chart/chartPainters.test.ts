import { describe, it, expect, vi } from "vitest";
import type { KLineData } from "klinecharts";

// chartPainters.ts transitively imports the customIndicators barrel + slope.ts,
// which build indicator TEMPLATES at module load (reading klinecharts' runtime
// enums). Stub that surface like the indicator tests do, then top-level `await
// import` so the mock is in place before evaluation.
vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));

const { buildSlopeMaPills, fmtCountdown } = await import("./chartPainters");

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
    getIndicators: () =>
      [...panes].flatMap(([paneId, inner]) =>
        [...inner.values()].map((i) => ({ ...i, paneId })),
      ),
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

describe("fmtCountdown", () => {
  const h = (n: number) => n * 3600;

  it("switches to days + hours once more than a day is left", () => {
    // A weekly bar with 222h to go: "222:00:05" before, unreadable and too wide
    // for the pill.
    expect(fmtCountdown(h(222) + 5)).toBe("9d 6h");
    expect(fmtCountdown(h(26) + 59 * 60 + 59)).toBe("1d 2h");
  });

  it("shows a whole day at the boundary, and H:MM:SS just below it", () => {
    expect(fmtCountdown(h(24))).toBe("1d 0h");
    expect(fmtCountdown(h(24) - 1)).toBe("23:59:59");
  });

  it("keeps the sub-day formats unchanged", () => {
    expect(fmtCountdown(h(2) + 3 * 60 + 4)).toBe("2:03:04");
    expect(fmtCountdown(59 * 60 + 7)).toBe("59:07");
    expect(fmtCountdown(5)).toBe("0:05");
    expect(fmtCountdown(0)).toBe("0:00");
  });
});
