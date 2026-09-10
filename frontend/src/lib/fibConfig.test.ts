import { describe, it, expect } from "vitest";
import {
  asFibConfig,
  defaultFibConfig,
  fibChannelSegments,
  fibLevelSegments,
  type FibConfig,
} from "./fibConfig";

// Anchors: point0 first click at (x:100, y:200, price 90), point1 at (x:300, y:0, price 110).
// Like the built-in, level 0 sits at point1 (the second click) and level 1 at point0.
const coords = [
  { x: 100, y: 200 },
  { x: 300, y: 0 },
] as const;
const values = [90, 110] as const;
const base = (over: Partial<FibConfig> = {}): FibConfig => ({ ...defaultFibConfig(), ...over });
const seg = (cfg: FibConfig) =>
  fibLevelSegments({ cfg, coordinates: [...coords], values, boundingWidth: 400, precision: 2 });

describe("asFibConfig", () => {
  it("returns defaults for missing/garbage input", () => {
    expect(asFibConfig(undefined)).toEqual(defaultFibConfig());
    expect(asFibConfig("nope")).toEqual(defaultFibConfig());
    // defaults: classic 7 enabled + disabled extensions
    const d = asFibConfig(null);
    expect(d.levels.filter((l) => l.enabled).map((l) => l.value)).toEqual([
      0, 0.236, 0.382, 0.5, 0.618, 0.786, 1,
    ]);
    expect(d.extend).toBe("none");
    expect(d.reverse).toBe(false);
    expect(d.trendLine).toBe(true);
    expect(d.labels).toBe(true);
  });
  it("keeps per-level width/dash overrides and drops malformed ones", () => {
    const c = asFibConfig({
      levels: [
        { value: 0.5, enabled: true, color: "#123456", size: 3, style: "dashed" },
        { value: 0.618, enabled: true, color: "#654321", size: "fat", style: "wavy" },
      ],
    });
    expect(c.levels[0].size).toBe(3);
    expect(c.levels[0].style).toBe("dashed");
    expect(c.levels[1].size).toBeUndefined();
    expect(c.levels[1].style).toBeUndefined();
  });
  it("keeps a valid stored config verbatim and fills missing flags", () => {
    const stored = { levels: [{ value: 0.5, enabled: true, color: "#123456" }], reverse: true };
    const c = asFibConfig(stored);
    expect(c.levels).toEqual(stored.levels);
    expect(c.reverse).toBe(true);
    expect(c.extend).toBe("none"); // filled default
  });
});

describe("fibLevelSegments", () => {
  it("spans only the anchors' x-range and interpolates y from level 0 at point1", () => {
    const segs = seg(base());
    const l0 = segs.find((s) => s.level === 0)!;
    const l1 = segs.find((s) => s.level === 1)!;
    const l05 = segs.find((s) => s.level === 0.5)!;
    expect([l0.x1, l0.x2]).toEqual([100, 300]);
    expect(l0.y).toBe(0); // point1's y
    expect(l1.y).toBe(200); // point0's y
    expect(l05.y).toBe(100);
  });
  it("labels carry ratio and interpolated price at the given precision", () => {
    const segs = seg(base());
    expect(segs.find((s) => s.level === 0)!.label).toBe("0 (110.00)");
    expect(segs.find((s) => s.level === 0.618)!.label).toBe("0.618 (97.64)"); // 110 - 0.618*20
  });
  it("skips disabled levels", () => {
    const cfg = base();
    cfg.levels = cfg.levels.map((l) => (l.value === 0.5 ? { ...l, enabled: false } : l));
    expect(seg(cfg).some((s) => s.level === 0.5)).toBe(false);
  });
  it("reverse swaps which anchor is level 0", () => {
    const segs = seg(base({ reverse: true }));
    expect(segs.find((s) => s.level === 0)!.y).toBe(200); // now point0's y
    expect(segs.find((s) => s.level === 0)!.label).toBe("0 (90.00)");
    expect(segs.find((s) => s.level === 1)!.y).toBe(0);
  });
  it("extend widens the span to the pane edges", () => {
    const l = (cfg: FibConfig) => seg(cfg).find((s) => s.level === 0)!;
    expect([l(base({ extend: "left" })).x1, l(base({ extend: "left" })).x2]).toEqual([0, 300]);
    expect([l(base({ extend: "right" })).x1, l(base({ extend: "right" })).x2]).toEqual([100, 400]);
    expect([l(base({ extend: "both" })).x1, l(base({ extend: "both" })).x2]).toEqual([0, 400]);
  });
  it("extrapolates levels outside [0,1]", () => {
    const cfg = base();
    cfg.levels = [{ value: 1.618, enabled: true, color: "#2962ff" }];
    const s = seg(cfg)[0];
    expect(s.y).toBeCloseTo(0 + (200 - 0) * 1.618); // beyond point0
    expect(s.label).toBe("1.618 (77.64)"); // 110 - 1.618*20
  });
  it("carries per-level width/dash overrides onto the segment", () => {
    const cfg = base();
    cfg.levels = [
      { value: 0.5, enabled: true, color: "#123456", size: 2, style: "dashed" },
      { value: 0.618, enabled: true, color: "#654321" },
    ];
    const [a, b] = seg(cfg);
    expect([a.size, a.style]).toEqual([2, "dashed"]);
    expect([b.size, b.style]).toEqual([undefined, undefined]);
  });
  it("returns [] when fewer than 2 coordinates", () => {
    expect(
      fibLevelSegments({
        cfg: base(),
        coordinates: [{ x: 1, y: 1 }],
        values,
        boundingWidth: 400,
        precision: 2,
      }),
    ).toEqual([]);
  });
});

describe("fibLevelSegments off-pane clamping", () => {
  // Levels are dashable per level, and extend mixes a pane edge with a RAW
  // anchor x — a fib panned far off-pane otherwise spans the whole off-pane
  // distance on every enabled level, every frame.
  it("keeps both x endpoints near the pane when anchors sit far off it", () => {
    const cfg = base();
    const segs = fibLevelSegments({
      cfg,
      coordinates: [
        { x: -60_000, y: 200 },
        { x: -50_000, y: 0 },
      ],
      values: [90, 110] as const,
      boundingWidth: 400,
      precision: 2,
    });
    for (const s of segs) {
      expect(Math.abs(s.x1)).toBeLessThan(10_000);
      expect(Math.abs(s.x2)).toBeLessThan(10_000);
    }
  });
});

// Fib channel anchors: base line point0(0,100) → point1(200,100+? ) — use a
// sloped base so the clip has to move y. point2 sets the parallel line.
const chCoords = [
  { x: 100, y: 200 }, // base start
  { x: 300, y: 100 }, // base end (slope -0.5 per px)
  { x: 100, y: 100 }, // third anchor: 100px ABOVE the base at x=100 ⇒ gap -100
] as const;
const chSeg = (cfg: FibConfig, boundingWidth = 400) =>
  fibChannelSegments({ cfg, coordinates: [...chCoords], boundingWidth, boundingHeight: 300 });

describe("fibChannelSegments", () => {
  it("returns nothing before the third anchor exists", () => {
    expect(
      fibChannelSegments({
        cfg: base(),
        coordinates: chCoords.slice(0, 2),
        boundingWidth: 400,
        boundingHeight: 300,
      }),
    ).toEqual([]);
  });

  it("puts level 0 on the base line and level 1 on the parallel through point2", () => {
    const segs = chSeg(base());
    const l0 = segs.find((s) => s.level === 0)!;
    const l1 = segs.find((s) => s.level === 1)!;
    expect([l0.x1, l0.y1, l0.x2, l0.y2]).toEqual([100, 200, 300, 100]);
    expect([l1.x1, l1.y1, l1.x2, l1.y2]).toEqual([100, 100, 300, 0]);
  });

  it("keeps every level parallel to the base (same slope, interpolated offset)", () => {
    const segs = chSeg(base());
    const slope = (s: (typeof segs)[number]) => (s.y2 - s.y1) / (s.x2 - s.x1);
    for (const s of segs) expect(slope(s)).toBeCloseTo(-0.5, 10);
    const l05 = segs.find((s) => s.level === 0.5)!;
    expect(l05.y1).toBe(150); // halfway between the base (200) and the parallel (100)
  });

  it("labels with the ratio alone — a sloped line has no single price", () => {
    expect(chSeg(base()).map((s) => s.label)).toContain("0.618");
    expect(chSeg(base()).every((s) => !s.label.includes("("))).toBe(true);
  });

  it("reverse swaps the base and parallel lines", () => {
    const segs = chSeg(base({ reverse: true }));
    expect(segs.find((s) => s.level === 0)!.y1).toBe(100); // now the parallel
    expect(segs.find((s) => s.level === 1)!.y1).toBe(200); // now the base
  });

  it("extends to the pane edges along the line, recomputing y (no shear)", () => {
    const segs = chSeg(base({ extend: "both" }));
    const l0 = segs.find((s) => s.level === 0)!;
    expect([l0.x1, l0.y1]).toEqual([0, 250]); // base extrapolated back to x=0
    expect([l0.x2, l0.y2]).toEqual([400, 50]); // …and out to the right edge
  });

  it("extend:right only widens the right end", () => {
    const l0 = chSeg(base({ extend: "right" })).find((s) => s.level === 0)!;
    expect([l0.x1, l0.y1]).toEqual([100, 200]);
    expect(l0.x2).toBe(400);
  });

  it("clamps a far off-pane anchor to the pad, with the y that belongs there", () => {
    const far = [
      { x: -50000, y: 200 },
      { x: 300, y: 100 },
      { x: 300, y: 0 },
    ];
    const l0 = fibChannelSegments({
      cfg: base(),
      coordinates: far,
      boundingWidth: 400,
      boundingHeight: 300,
    }).find((s) => s.level === 0)!;
    expect(l0.x1).toBe(-2000); // -DRAW_CLIP_PAD
    // slope = (100-200)/(300 - -50000); y at x=-2000 stays on the line
    const slope = (100 - 200) / (300 + 50000);
    expect(l0.y1).toBeCloseTo(200 + slope * (-2000 + 50000), 6);
  });

  it("clips a near-vertical channel to the padded pane instead of shooting y off", () => {
    // Base anchors 2px apart in x, 300 apart in y ⇒ slope 150. A padded x alone
    // would put y in the hundreds of thousands.
    const steep = [
      { x: 100, y: 0 },
      { x: 102, y: 300 },
      { x: 100, y: 40 },
    ];
    const segs = fibChannelSegments({
      cfg: base(),
      coordinates: steep,
      boundingWidth: 400,
      boundingHeight: 300,
    });
    expect(segs.length).toBeGreaterThan(0);
    for (const s of segs) {
      for (const y of [s.y1, s.y2]) {
        expect(y).toBeGreaterThanOrEqual(-2000);
        expect(y).toBeLessThanOrEqual(300 + 2000);
      }
    }
  });

  it("drops a level whose whole span sits off the padded pane", () => {
    // Horizontal base far above the pane; the parallel is far above too, so every
    // level is out of the box.
    const above = [
      { x: 100, y: -900000 },
      { x: 300, y: -900000 },
      { x: 200, y: -900010 },
    ];
    expect(
      fibChannelSegments({
        cfg: base(),
        coordinates: above,
        boundingWidth: 400,
        boundingHeight: 300,
      }),
    ).toEqual([]);
  });

  it("draws nothing for a vertical base (both anchors on one candle)", () => {
    const vertical = [
      { x: 200, y: 50 },
      { x: 200, y: 250 },
      { x: 260, y: 150 },
    ];
    for (const extend of ["none", "both"] as const) {
      expect(
        fibChannelSegments({
          cfg: base({ extend }),
          coordinates: vertical,
          boundingWidth: 400,
          boundingHeight: 300,
        }),
      ).toEqual([]);
    }
  });

  it("carries per-level color and width/dash overrides through", () => {
    const cfg = base({
      levels: [{ value: 0.5, enabled: true, color: "#abcdef", size: 3, style: "dashed" }],
    });
    const [s] = chSeg(cfg);
    expect(s.color).toBe("#abcdef");
    expect(s.size).toBe(3);
    expect(s.style).toBe("dashed");
  });
});
