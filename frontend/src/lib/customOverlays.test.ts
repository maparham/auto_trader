// jsdom, not the suite's default node env: this module imports klinecharts,
// which touches `window` at import time.
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { matchBand, patternGhost } from "./customOverlays";

// The unit that was wrong, driven directly: klinecharts hands createPointFigures
// the two anchors ALREADY resolved to bar-CENTER pixel x values, so the half-bar
// that makes a band enclose its candles has to be taken here, in pixel space,
// off getBarSpace(). Nudging the anchor timestamps instead cannot work — a
// timestamp resolves to a whole bar index (floor search), so half a timeframe
// either snaps a bar over or does nothing at all. A FakeChart that stores
// timestamps can never catch that; measuring the figure's coordinates can.
function stubChart(bar: number) {
  return { getBarSpace: () => ({ bar }) };
}

// x coordinates of the polygon the template emits, left edge first.
function edges(centreXs: number[], bar: number): { left: number; right: number } {
  const figures = matchBand.createPointFigures!({
    coordinates: centreXs.map((x) => ({ x, y: 0 })),
    bounding: { height: 400, width: 800, left: 0, right: 0, top: 0, bottom: 0 },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    chart: stubChart(bar) as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any) as Array<{ attrs: { coordinates: Array<{ x: number }> } }>;
  const xs = figures[0].attrs.coordinates.map((c) => c.x);
  return { left: Math.min(...xs), right: Math.max(...xs) };
}

describe("matchBand geometry (encloses the candles, does not stop at their centres)", () => {
  it("pushes each edge half a bar outside the anchored bars' centres", () => {
    const bar = 10;
    // A 5-bar match: centres 10px apart, first at -980 (behind the live edge).
    const { left, right } = edges([-980, -940], bar);
    expect(left).toBe(-980 - bar / 2);
    expect(right).toBe(-940 + bar / 2);
    // Stated as width: 5 bars wide, not 4.
    expect(right - left).toBe(5 * bar);
  });

  it("holds the enclosure at a different bar spacing", () => {
    // The half-bar is read per-render from getBarSpace(), so zooming must not
    // leave the band a fixed number of pixels wrong.
    for (const bar of [4, 10, 24.5]) {
      const { left, right } = edges([100, 100 + 3 * bar], bar);
      expect(left).toBe(100 - bar / 2);
      expect(right).toBe(100 + 3 * bar + bar / 2);
    }
  });

  it("gives the two bands an exactly shared edge, so the divider is one line", () => {
    // The aftermath band is anchored on the FIRST forward bar, which klinecharts
    // lays out one bar-space right of the match's last bar (layout is by index,
    // so this holds across session gaps too). Its left edge must land exactly on
    // the match band's right edge: no gap, no overlap.
    const bar = 10;
    const lastMatchCentre = -940;
    const firstFwdCentre = lastMatchCentre + bar;
    const matched = edges([-980, lastMatchCentre], bar);
    const aftermath = edges([firstFwdCentre, firstFwdCentre + 2 * bar], bar);
    expect(aftermath.left).toBe(matched.right);
  });

  it("is inert until both anchors exist", () => {
    const figures = matchBand.createPointFigures!({
      coordinates: [{ x: 10, y: 0 }],
      bounding: { height: 400, width: 800, left: 0, right: 0, top: 0, bottom: 0 },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      chart: stubChart(10) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(figures).toEqual([]);
  });

  it("draws full height and stays non-interactive, with no styles of its own", () => {
    const figures = matchBand.createPointFigures!({
      coordinates: [{ x: 10, y: 0 }, { x: 50, y: 0 }],
      bounding: { height: 400, width: 800, left: 0, right: 0, top: 0, bottom: 0 },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      chart: stubChart(10) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any) as unknown as Array<Record<string, unknown>>;
    const ys = (figures[0].attrs as { coordinates: Array<{ y: number }> }).coordinates.map((c) => c.y);
    expect(Math.min(...ys)).toBe(0);
    expect(Math.max(...ys)).toBe(400);
    expect(figures[0].ignoreEvent).toBe(true);
    // No `styles` key at all: that is what lets overlay.styles.polygon through,
    // and it is how one template paints the match and the dimmer aftermath.
    expect("styles" in figures[0]).toBe(false);
  });
});

// --- patternGhost -----------------------------------------------------------
// The pasted pattern overlay. Everything it draws is derived on each repaint
// from the copied shape plus the candles under it, so these drive the template
// directly with a stub chart (same idiom as matchBand above) and read the
// figures back.
describe("patternGhost", () => {
  const GHOST = {
    bars: [
      { open: 1, high: 1.02, low: 0.99, close: 1.01 },
      { open: 1.01, high: 1.04, low: 1.0, close: 1.03 },
      { open: 1.03, high: 1.05, low: 1.01, close: 1.02 },
    ],
    epic: "DE40",
    resolution: "5m",
    fromTs: 1_700_000_000,
    toTs: 1_700_000_120,
  };

  // Candles 20x the ghost's price level: the case the tool exists for.
  const CANDLES = [
    { timestamp: 1_800_000_000, open: 21_000, high: 21_050, low: 20_980, close: 21_030 },
    { timestamp: 1_800_000_300, open: 21_030, high: 21_090, low: 21_010, close: 21_070 },
    { timestamp: 1_800_000_600, open: 21_070, high: 21_110, low: 21_040, close: 21_060 },
  ];

  function figuresFor(opts: {
    fit?: { mean: number; sd: number };
    /** Anchor bar. A real point carries the bar's timestamp; one anchored past
     *  the newest bar carries an index and no timestamp (materializePoints
     *  strips it), which is what `noTimestamp` models. */
    dataIndex?: number | undefined;
    noTimestamp?: boolean;
    value?: number;
    bar?: number;
    dataList?: typeof CANDLES;
    /** Partial ghostStyle; asGhostStyle fills the rest. */
    style?: Record<string, unknown>;
  } = {}) {
    const bar = opts.bar ?? 24;
    const list = opts.dataList ?? CANDLES;
    const idx = "dataIndex" in opts ? opts.dataIndex : 0;
    return patternGhost.createPointFigures!({
      overlay: {
        points: [
          {
            timestamp: opts.noTimestamp ? undefined : list[idx ?? 0]?.timestamp,
            dataIndex: idx,
            value: opts.value ?? 21_000,
          },
        ],
        extendData: {
          ghost: GHOST,
          ghostPinned: !!opts.fit,
          ghostFit: opts.fit,
          ghostStyle: opts.style,
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      coordinates: [{ x: 300, y: 200 }],
      bounding: { height: 400, width: 800, left: 0, right: 0, top: 0, bottom: 0 },
      chart: {
        getBarSpace: () => ({ bar, gapBar: bar - 4 }),
        getDataList: () => opts.dataList ?? CANDLES,
        getPeriod: () => ({ span: 5, type: "minute" }),
        getSymbol: () => ({ ticker: "US100", pricePrecision: 2 }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      // A linear price axis is all the geometry needs.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      yAxis: { convertToPixel: (v: number) => 1000 - v / 100 } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      xAxis: null as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any) as unknown as Array<Record<string, unknown>>;
  }

  const texts = (figs: Array<Record<string, unknown>>) =>
    figs.filter((f) => f.type === "text").map((f) => (f.attrs as { text: string }).text);

  it("paints the close line instead of bodies when asked", () => {
    const figs = figuresFor({ style: { shape: "line" } });
    // No bodies at all, and one segment between each pair of closes; the strip
    // cells are the only rects left.
    const lines = figs.filter((f) => f.type === "line");
    expect(lines).toHaveLength(2); // 3 closes -> 2 segments
    const seg = lines[0].attrs as { coordinates: Array<{ x: number; y: number }> };
    expect(seg.coordinates[1].x - seg.coordinates[0].x).toBe(24);
    // No painted bodies: the three bar-shaped rects left are invisible hit
    // targets (so the thin line is still draggable), plus the strip cells.
    const rects = figs.filter((f) => f.type === "rect" && "width" in (f.attrs as object));
    expect(rects).toHaveLength(6);
    expect(rects.slice(0, 3).every((f) => (f.styles as { color: string }).color === "rgba(0, 0, 0, 0)")).toBe(true);
    expect(rects.slice(0, 3).every((f) => f.ignoreEvent !== true)).toBe(true);
  });

  it("paints at the opacity and colour the user chose", () => {
    const figs = figuresFor({ style: { opacity: 1, color: "#9598a1" } });
    const body = figs.find((f) => f.type === "rect" && "width" in (f.attrs as object))!;
    const styles = body.styles as { color: string; borderColor: string };
    expect(styles.color).toBe("rgba(149, 152, 161, 1)");
    // Up and down bars share the one colour once direction is off (the bodies
    // come first; the strip cells after them carry the score tints).
    const colors = new Set(
      figs
        .filter((f) => f.type === "rect" && "width" in (f.attrs as object))
        .slice(0, 3)
        .map((f) => (f.styles as { color: string }).color),
    );
    expect(colors).toEqual(new Set(["rgba(149, 152, 161, 1)"]));
  });

  it("drops the strip and the headline when the score is switched off", () => {
    const figs = figuresFor({ style: { score: false } });
    const rects = figs.filter((f) => f.type === "rect" && "width" in (f.attrs as object));
    expect(rects).toHaveLength(3); // three bodies, no strip cells
    // Only the provenance line survives — no "match 91%" headline, no cell %.
    const t = texts(figs);
    expect(t).toHaveLength(1);
    expect(t[0]).not.toMatch(/%/);
  });

  it("draws nothing without a copied shape", () => {
    const figures = patternGhost.createPointFigures!({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      overlay: { points: [{ timestamp: 1, value: 1 }], extendData: {} } as any,
      coordinates: [{ x: 10, y: 10 }],
      bounding: { height: 400, width: 800, left: 0, right: 0, top: 0, bottom: 0 },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      chart: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      yAxis: { convertToPixel: (v: number) => v } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(figures).toEqual([]);
  });

  it("lays one candle per bar out from the anchor", () => {
    const bodies = figuresFor().filter((f) => f.type === "rect" && "width" in (f.attrs as object));
    // 3 candle bodies + 3 strip cells.
    expect(bodies).toHaveLength(6);
    const xs = bodies.slice(0, 3).map((f) => (f.attrs as { x: number }).x);
    expect(xs[1] - xs[0]).toBe(24);
    expect(xs[2] - xs[1]).toBe(24);
  });

  it("auto-fits onto the candles it is scoring, 20x its own price level", () => {
    const figs = figuresFor();
    const wick = figs.find((f) => f.type === "line")!;
    const y = (wick.attrs as { coordinates: Array<{ y: number }> }).coordinates[0].y;
    // The first bar's high sits within the candles' price band (~21_000), not
    // near the copied ratios (~1) — that is the auto-fit doing its job.
    expect(y).toBeGreaterThan(1000 - 21_200 / 100);
    expect(y).toBeLessThan(1000 - 20_800 / 100);
  });

  it("draws a pinned ghost at the placement it was pinned at, size included", () => {
    // The pin freezes the whole affine map. Anchoring by price alone kept the
    // position but took the SCALE from the copied ratios, so a small nudge
    // could resize the ghost several-fold on release.
    const fitted = figuresFor();
    const pinned = figuresFor({ fit: { mean: 5_000, sd: 40 } });
    const span = (figs: Array<Record<string, unknown>>) => {
      const ys = figs
        .filter((f) => f.type === "line")
        .flatMap((f) => (f.attrs as { coordinates: Array<{ y: number }> }).coordinates.map((c) => c.y));
      return { top: Math.min(...ys), bottom: Math.max(...ys) };
    };
    const p = span(pinned);
    const f = span(fitted);
    expect(p.top).not.toBeCloseTo(f.top, 3); // moved to where it was placed
    // Mean 5000 through this axis is y = 1000 - 50; the height comes from sd 40.
    expect((p.top + p.bottom) / 2).toBeCloseTo(1000 - 5_000 / 100, 0);
    expect(p.bottom - p.top).toBeGreaterThan(f.bottom - f.top); // sd 40 ≫ the candles'
  });

  it("prints the running score per candle, and the overall score above", () => {
    const t = texts(figuresFor());
    // Three strip cells (the first has no score: one candle is not a sequence)
    // plus the two label lines.
    expect(t).toHaveLength(5);
    expect(t[0]).toBe("-");
    expect(t[1]).toMatch(/^\d+%$/);
    expect(t.some((x) => /^match \d+%$/.test(x))).toBe(true);
  });

  it("scores a just-pasted ghost, whose point carries only a timestamp", () => {
    // klinecharts fills dataIndex in later; reading it alone left every freshly
    // pasted ghost showing "no match yet" over candles it was sitting on.
    const t = texts(figuresFor({ dataIndex: undefined, value: 21_000 }));
    expect(t.some((x) => /^match \d+%$/.test(x))).toBe(true);
  });

  it("discloses how much of the pattern is actually over candles", () => {
    // Anchored on the last bar: only one of the three has a candle under it, so
    // there is no sequence to score and nothing may claim there is.
    const t = texts(figuresFor({ dataIndex: 2 }));
    expect(t).toContain("no match yet");
    expect(t.some((x) => x.includes("1 of 3 bars"))).toBe(true);
  });

  it("scores the covered part when the ghost runs off the live edge", () => {
    const t = texts(figuresFor({ dataIndex: 1 }));
    expect(t.some((x) => /^match \d+%$/.test(x))).toBe(true);
    expect(t.some((x) => x.includes("2 of 3 bars"))).toBe(true);
  });

  it("drops the per-candle numbers when the bars are too narrow to read them", () => {
    const t = texts(figuresFor({ bar: 8 }));
    expect(t).toHaveLength(2); // labels only
  });

  it("says nothing about a match where there are no candles under it", () => {
    const t = texts(figuresFor({ dataIndex: 99, noTimestamp: true, dataList: CANDLES }));
    expect(t.some((x) => x.includes("%"))).toBe(false);
    expect(t).toContain("no match yet");
  });

  it("names the source market and timeframe only when they differ", () => {
    const sameChart = texts(figuresFor());
    expect(sameChart.some((x) => x.includes("DE40"))).toBe(true); // copied elsewhere
    expect(sameChart.some((x) => x.includes("3 bars"))).toBe(true);
    // The chart IS on 5m, so the timeframe is not repeated.
    expect(sameChart.some((x) => x.includes("5m"))).toBe(false);
  });

  it("leaves the readout non-interactive so it can't swallow a drag", () => {
    const figs = figuresFor();
    const strip = figs.filter((f) => f.type === "text" || (f.styles as { style?: string })?.style === "fill");
    strip.forEach((f) => expect(f.ignoreEvent).toBe(true));
    // The candles themselves stay interactive: that is what the user grabs.
    const body = figs.find((f) => (f.styles as { style?: string })?.style === "stroke_fill")!;
    expect(body.ignoreEvent).toBeUndefined();
  });
});
