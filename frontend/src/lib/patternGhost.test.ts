import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  MAX_GHOST_BARS,
  MIN_GHOST_BARS,
  capturePattern,
  zflat,
  distance,
  prefixSimilarity,
  fitToWindow,
  anchorToPrice,
  ghostGeometry,
  ghostLabelLines,
  windowUnder,
  readoutLayout,
  ghostPrices,
  formatSimilarity,
  similarityTint,
  asGhostStyle,
  GHOST_STYLE_DEFAULT,
  type GhostBar,
} from "./patternGhost";
import type { PatternBar } from "./patternSearch";

// A deterministic little series: enough movement that nothing is flat, and
// distinct opens/highs/lows/closes so a mis-ordered flatten shows up.
function bars(n: number, base = 100): PatternBar[] {
  return Array.from({ length: n }, (_, i) => {
    const o = base + i * 2 + (i % 3);
    return { ts: 1_700_000_000 + i * 60, o, h: o + 3 + (i % 2), l: o - 2 - (i % 4), c: o + 1 - (i % 5) };
  });
}

function ghostBars(n: number, base = 100): GhostBar[] {
  return bars(n, base).map((b) => ({ open: b.o, high: b.h, low: b.l, close: b.c }));
}

const META = { epic: "US100", resolution: "5m" };

describe("capturePattern", () => {
  it("stores the bars as ratios to the first open, with the source metadata", () => {
    const src = bars(4);
    const p = capturePattern(src, META)!;
    expect(p.epic).toBe("US100");
    expect(p.resolution).toBe("5m");
    expect(p.fromTs).toBe(src[0].ts);
    expect(p.toTs).toBe(src[src.length - 1].ts);
    expect(p.bars).toHaveLength(4);
    expect(p.bars[0].open).toBeCloseTo(1, 8);
    expect(p.bars[2].close).toBeCloseTo(src[2].c / src[0].o, 8);
  });

  it("keeps the newest bars when the selection exceeds the cap", () => {
    const src = bars(MAX_GHOST_BARS + 10);
    const p = capturePattern(src, META)!;
    expect(p.bars).toHaveLength(MAX_GHOST_BARS);
    expect(p.fromTs).toBe(src[10].ts); // the range narrows to what was kept
    expect(p.toTs).toBe(src[src.length - 1].ts);
    expect(p.truncated).toBe(true);
  });

  it("rejects a selection below the minimum, or one with no usable prices", () => {
    expect(capturePattern(bars(MIN_GHOST_BARS - 1), META)).toBeNull();
    expect(capturePattern([], META)).toBeNull();
    const zeroOpen = bars(3);
    zeroOpen[0] = { ...zeroOpen[0], o: 0 };
    expect(capturePattern(zeroOpen, META)).toBeNull();
  });
});

describe("zflat", () => {
  it("normalizes with ONE mean and sd over every value, bar-major o,h,l,c", () => {
    const z = zflat(ghostBars(3))!;
    expect(z).toHaveLength(12);
    const mean = z.reduce((a, b) => a + b, 0) / z.length;
    const sd = Math.sqrt(z.reduce((a, b) => a + b * b, 0) / z.length - mean * mean);
    expect(mean).toBeCloseTo(0, 10);
    expect(sd).toBeCloseTo(1, 10);
    // Bar-major: the first four entries are bar 0's open/high/low/close, so the
    // low is the smallest of them and the high the largest.
    expect(Math.min(z[0], z[1], z[2], z[3])).toBe(z[2]);
    expect(Math.max(z[0], z[1], z[2], z[3])).toBe(z[1]);
  });

  it("has nothing to normalize when the window never moves", () => {
    const flat: GhostBar[] = [
      { open: 5, high: 5, low: 5, close: 5 },
      { open: 5, high: 5, low: 5, close: 5 },
    ];
    expect(zflat(flat)).toBeNull();
  });
});

describe("distance", () => {
  it("is zero for the same shape at a different price level and scale", () => {
    const a = ghostBars(6, 100);
    const scaled = a.map((b) => ({
      open: b.open * 3 + 5000,
      high: b.high * 3 + 5000,
      low: b.low * 3 + 5000,
      close: b.close * 3 + 5000,
    }));
    expect(distance(a, scaled)!).toBeCloseTo(0, 10);
  });

  it("is 2 for an exact inversion, matching the backend's scale", () => {
    const a = ghostBars(6);
    // Negating every component point for point (not swapping high and low,
    // which is a different window) is what the metric's upper bound means.
    const flipped = a.map((b) => ({
      open: -b.open,
      high: -b.high,
      low: -b.low,
      close: -b.close,
    }));
    expect(distance(a, flipped)!).toBeCloseTo(2, 10);
  });

  it("is undefined against a flat or short window", () => {
    const a = ghostBars(4);
    const flat = a.map(() => ({ open: 1, high: 1, low: 1, close: 1 }));
    expect(distance(a, flat)).toBeNull();
    expect(distance(a, a.slice(0, 3))).toBeNull();
  });
});

describe("prefixSimilarity", () => {
  it("scores every prefix, so the reader sees where the match breaks down", () => {
    const ghost = ghostBars(5);
    const sims = prefixSimilarity(ghost, ghost);
    expect(sims).toHaveLength(5);
    expect(sims[0]).toBeNull(); // one candle is not a sequence
    sims.slice(1).forEach((s) => expect(s).toBeCloseTo(1, 10));
  });

  it("falls as the underlying bars stop agreeing", () => {
    const ghost = ghostBars(6);
    const actual = ghost.map((b, i) =>
      i < 3 ? b : { open: b.close, high: b.close + 1, low: b.close - 9, close: b.close - 8 },
    );
    const sims = prefixSimilarity(ghost, actual);
    expect(sims[2]!).toBeGreaterThan(sims[5]!);
    sims.slice(1).forEach((s) => {
      expect(s).not.toBeNull();
      expect(s!).toBeGreaterThanOrEqual(0);
      expect(s!).toBeLessThanOrEqual(1);
    });
  });

  it("reports nothing for the bars that have no candle under them", () => {
    const ghost = ghostBars(5);
    const sims = prefixSimilarity(ghost, ghost.slice(0, 3));
    expect(sims.slice(3)).toEqual([null, null]);
    expect(sims[2]).toBeCloseTo(1, 10);
  });

  it("has no score for a single bar: one candle has no sequence to compare", () => {
    const ghost = ghostBars(3);
    expect(prefixSimilarity(ghost, ghost)[0]).toBeNull();
  });
});

describe("fitToWindow", () => {
  it("maps the ghost into the window's own price space, leaving the score alone", () => {
    const ghost = ghostBars(5, 1);
    const actual = ghostBars(5, 20_000).map((b) => ({
      open: b.open * 7,
      high: b.high * 7,
      low: b.low * 7,
      close: b.close * 7,
    }));
    const fitted = fitToWindow(ghost, actual)!;
    const flat = (bs: GhostBar[]) => bs.flatMap((b) => [b.open, b.high, b.low, b.close]);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = (xs: number[]) => {
      const m = mean(xs);
      return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
    };
    expect(mean(flat(fitted))).toBeCloseTo(mean(flat(actual)), 6);
    expect(sd(flat(fitted))).toBeCloseTo(sd(flat(actual)), 6);
    expect(distance(fitted, ghost)!).toBeCloseTo(0, 10);
  });

  it("gives up when there is no window, or the window never moves", () => {
    const ghost = ghostBars(4);
    expect(fitToWindow(ghost, [])).toBeNull();
    expect(fitToWindow(ghost, ghost.map(() => ({ open: 2, high: 2, low: 2, close: 2 })))).toBeNull();
  });
});

describe("anchorToPrice", () => {
  it("scales the stored ratios onto a price the user dropped the ghost at", () => {
    const ghost = ghostBars(3, 100);
    const stored = capturePattern(bars(3, 100), META)!.bars;
    const placed = anchorToPrice(stored, 21_000);
    expect(placed[0].open).toBeCloseTo(21_000, 6);
    expect(placed[1].close / placed[0].open).toBeCloseTo(ghost[1].close / ghost[0].open, 6);
  });
});

describe("ghostGeometry", () => {
  const priceToY = (v: number) => 500 - v; // higher price, smaller y

  it("steps one bar at a time from the anchor and shapes each candle", () => {
    const g = ghostGeometry(
      [
        { open: 100, high: 110, low: 95, close: 105 },
        { open: 105, high: 106, low: 90, close: 92 },
      ],
      { anchorX: 200, barSpace: 12, priceToY },
    );
    expect(g).toHaveLength(2);
    expect(g[0].x).toBe(200);
    expect(g[1].x).toBe(212);
    expect(g[0].w).toBeLessThan(12);
    expect(g[0].up).toBe(true);
    expect(g[1].up).toBe(false);
    expect(g[0].wickTop).toBe(priceToY(110));
    expect(g[0].wickH).toBe(priceToY(95) - priceToY(110));
    expect(g[0].bodyTop).toBe(priceToY(105));
    expect(g[0].bodyH).toBeCloseTo(5, 6);
  });

  it("takes the chart's own candle width when given one", () => {
    const g = ghostGeometry([{ open: 1, high: 2, low: 0, close: 1.5 }], {
      anchorX: 0,
      barSpace: 12,
      bodyWidth: 9,
      priceToY,
    });
    expect(g[0].w).toBe(9);
  });

  it("keeps a doji visible instead of collapsing it to nothing", () => {
    const g = ghostGeometry([{ open: 100, high: 101, low: 99, close: 100 }], {
      anchorX: 0,
      barSpace: 8,
      priceToY,
    });
    expect(g[0].bodyH).toBeGreaterThan(0);
  });
});

describe("ghostLabelLines", () => {
  const pattern = capturePattern(bars(6), META)!;

  it("says what it scores and how long it is", () => {
    const [head, sub] = ghostLabelLines(pattern, 0.912, { epic: "US100", sameTimeframe: true, compared: 6 });
    expect(head).toBe("match 91%");
    expect(sub).toBe("6 bars");
  });

  it("names the source only where it differs from the chart it sits on", () => {
    const [, sub] = ghostLabelLines(pattern, 0.5, { epic: "DE40", sameTimeframe: false, compared: 6 });
    expect(sub).toContain("5m");
    expect(sub).toContain("US100");
  });

  it("does not claim a match before there is one", () => {
    const [head] = ghostLabelLines(pattern, null, { epic: "US100", sameTimeframe: true, compared: 0 });
    expect(head).not.toContain("%");
  });

  it("says how much of the pattern was scored when it hangs past the newest bar", () => {
    // Otherwise "match 87%" reads as a verdict on all six bars when only two
    // had candles under them — and pasting against the live edge is the point.
    const [, sub] = ghostLabelLines(pattern, 0.87, { epic: "US100", sameTimeframe: true, compared: 2 });
    expect(sub).toBe("2 of 6 bars");
  });
});

describe("readout formatting", () => {
  it("shows a percentage, and a dash when there is no score", () => {
    expect(formatSimilarity(0.9123)).toBe("91%");
    expect(formatSimilarity(1)).toBe("100%");
    expect(formatSimilarity(null)).toBe("-");
  });

  it("tints by how close the match is, and stays neutral without a score", () => {
    expect(similarityTint(0.95)).not.toBe(similarityTint(0.5));
    expect(similarityTint(null)).toBe(similarityTint(null));
    expect(typeof similarityTint(0.7)).toBe("string");
  });
});

// The same fixture backend/tests/test_pattern_scan.py asserts against. Two
// implementations of one metric drift silently otherwise: a ghost would score a
// window 91% while the "Find similar" list ranked the same window somewhere
// else entirely.
describe("parity with the server-side pattern search", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("../../../backend/tests/fixtures/pattern_ghost_golden.json", import.meta.url),
      "utf8",
    ),
  ) as { query: number[][]; window: number[][]; prefixDistances: number[] };
  const toBars = (rows: number[][]): GhostBar[] =>
    rows.map(([open, high, low, close]) => ({ open, high, low, close }));

  it("reproduces the backend's distance for every prefix", () => {
    const query = toBars(fixture.query);
    const window = toBars(fixture.window);
    fixture.prefixDistances.forEach((expected, i) => {
      const k = i + 2; // the fixture starts at a 2-bar prefix
      expect(distance(query.slice(0, k), window.slice(0, k))!).toBeCloseTo(expected, 9);
    });
  });

  it("scores a pattern copied at one price level against candles at another", () => {
    const query = toBars(fixture.query);
    const window = toBars(fixture.window);
    const sims = prefixSimilarity(query, window);
    fixture.prefixDistances.forEach((d, i) => {
      expect(sims[i + 1]!).toBeCloseTo(1 - d / 2, 9);
    });
  });
});

describe("windowUnder", () => {
  const list = [
    { timestamp: 100, open: 1, high: 2, low: 0.5, close: 1.5 },
    { timestamp: 200, open: 1.5, high: 2.5, low: 1, close: 2 },
    { timestamp: 300, open: 2, high: 3, low: 1.5, close: 2.5 },
  ];

  it("takes the bars from the anchor rightwards", () => {
    expect(windowUnder(list, { dataIndex: 1 }, 2)).toEqual([
      { open: 1.5, high: 2.5, low: 1, close: 2 },
      { open: 2, high: 3, low: 1.5, close: 2.5 },
    ]);
  });

  it("resolves a fresh point that only carries a timestamp", () => {
    // A just-pasted overlay point has no dataIndex yet; reading dataIndex alone
    // left every pasted ghost scoreless.
    expect(windowUnder(list, { timestamp: 200 }, 2)).toHaveLength(2);
    expect(windowUnder(list, { dataIndex: undefined, timestamp: 300 }, 3)).toHaveLength(1);
  });

  it("trusts the timestamp over a stale index, the way the chart paints it", () => {
    // Paging older bars in renumbers every index but leaves timestamps alone.
    // A dragged point carries both, so an index-first read would score the
    // ghost against candles a page away from the ones it is drawn on.
    const prepended = [{ timestamp: 10, open: 9, high: 9, low: 9, close: 9 }, ...list];
    expect(windowUnder(prepended, { dataIndex: 1, timestamp: 300 }, 1)).toEqual([
      { open: 2, high: 3, low: 1.5, close: 2.5 },
    ]);
  });

  it("has nothing to give past the newest bar, or for an unknown anchor", () => {
    expect(windowUnder(list, { dataIndex: 9 }, 3)).toEqual([]);
    expect(windowUnder(list, { timestamp: 999 }, 3)).toEqual([]);
    expect(windowUnder(list, {}, 3)).toEqual([]);
  });
});

describe("readoutLayout", () => {
  const base = { stripH: 13, gap: 6, labelH: 26, height: 400 };

  it("puts the strip under the ghost and the labels above it", () => {
    const l = readoutLayout({ ...base, top: 100, bottom: 200 });
    expect(l.stripAbove).toBe(false);
    expect(l.stripY).toBe(206);
    expect(l.labelY).toBe(68);
  });

  it("flips the strip above a ghost sitting on the pane floor", () => {
    // The case that made the strip disappear: below the ghost is off the pane,
    // so it would have been clipped away with no sign anything was missing.
    const l = readoutLayout({ ...base, top: 250, bottom: 396 });
    expect(l.stripAbove).toBe(true);
    expect(l.stripY).toBe(231);
    expect(l.stripY + base.stripH).toBeLessThan(400);
  });

  it("keeps both readouts on the pane when the ghost fills it", () => {
    const l = readoutLayout({ ...base, top: 2, bottom: 398 });
    expect(l.stripY).toBeGreaterThanOrEqual(2);
    expect(l.stripY + base.stripH).toBeLessThanOrEqual(400);
    expect(l.labelY).toBeGreaterThanOrEqual(2);
    expect(l.labelY + base.labelH).toBeLessThanOrEqual(400);
  });
});

describe("ghostPrices", () => {
  const shape = ghostBars(4, 1); // copied ratios: values around 1
  const candles = ghostBars(4, 21_000);
  const spread = (bs: GhostBar[]) =>
    Math.max(...bs.map((b) => b.high)) - Math.min(...bs.map((b) => b.low));

  it("fits onto the candles under it by default", () => {
    const p = ghostPrices(shape, { actual: candles, reference: candles, anchorPrice: 20_000 });
    expect(distance(p, shape)!).toBeCloseTo(0, 10); // same shape
    expect(spread(p)).toBeCloseTo(spread(candles), 6); // and the candles' size
  });

  it("keeps a pinned ghost exactly where it was placed", () => {
    const p = ghostPrices(shape, {
      actual: candles,
      reference: candles,
      anchorPrice: 20_000,
      pinnedFit: { mean: 5_000, sd: 40 },
    });
    const flat = p.flatMap((b) => [b.open, b.high, b.low, b.close]);
    const mean = flat.reduce((a, b) => a + b, 0) / flat.length;
    expect(mean).toBeCloseTo(5_000, 6);
  });

  it("leaves a ghost pinned before fits were stored where its owner put it", () => {
    const p = ghostPrices(shape, {
      actual: candles,
      reference: candles,
      anchorPrice: 20_000,
      pinned: true,
    });
    expect(p[0].open).toBeCloseTo(20_000, 6); // the old anchor-price placement
  });

  it("borrows the chart's own scale when it hangs past the newest bar", () => {
    // Anchoring the raw ratios off the drop price instead makes a 2%-swing
    // pattern jump to several times the height of the candles beside it.
    const p = ghostPrices(shape, { actual: [], reference: candles, anchorPrice: 20_000 });
    expect(spread(p)).toBeCloseTo(spread(candles), 6);
    expect(distance(p, shape)!).toBeCloseTo(0, 10);
  });

  it("falls back to the anchor price with nothing loaded at all", () => {
    const p = ghostPrices(shape, { actual: [], reference: [], anchorPrice: 20_000 });
    expect(p[0].open).toBeCloseTo(20_000, 6);
  });

  it("does not take its scale from a single candle", () => {
    // One bar's four values are not a scale: fitting to them makes the ghost
    // pulse as it is dragged over the live edge.
    const one = ghostPrices(shape, { actual: candles.slice(0, 1), reference: candles, anchorPrice: 20_000 });
    const none = ghostPrices(shape, { actual: [], reference: candles, anchorPrice: 20_000 });
    expect(one).toEqual(none);
  });
});

describe("asGhostStyle", () => {
  it("reads a ghost pasted before styling existed as the look it already had", () => {
    expect(asGhostStyle(undefined)).toEqual(GHOST_STYLE_DEFAULT);
  });

  it("keeps what was stored", () => {
    expect(asGhostStyle({ shape: "line", opacity: 0.8, color: "#9598a1", score: false })).toEqual({
      shape: "line",
      opacity: 0.8,
      color: "#9598a1",
      score: false,
    });
  });

  it("refuses an opacity that would make the ghost invisible", () => {
    expect(asGhostStyle({ opacity: 0 }).opacity).toBe(0.15);
    expect(asGhostStyle({ opacity: 4 }).opacity).toBe(1);
    expect(asGhostStyle({ opacity: Number.NaN }).opacity).toBe(GHOST_STYLE_DEFAULT.opacity);
  });

  it("falls back to the chart's own colours on junk", () => {
    expect(asGhostStyle({ color: "" }).color).toBe("direction");
    expect(asGhostStyle({ shape: "blob" as unknown as "line" }).shape).toBe("candles");
  });
});

describe("ghostGeometry close line", () => {
  it("carries each bar's close in pixels", () => {
    const bars: GhostBar[] = [
      { open: 1, high: 1.2, low: 0.9, close: 1.1 },
      { open: 1.1, high: 1.3, low: 1, close: 1 },
    ];
    const cs = ghostGeometry(bars, { anchorX: 0, barSpace: 10, priceToY: (v) => 100 - v * 10 });
    expect(cs[0].closeY).toBeCloseTo(100 - 11);
    expect(cs[1].closeY).toBeCloseTo(100 - 10);
  });
});
