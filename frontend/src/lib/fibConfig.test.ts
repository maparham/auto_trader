import { describe, it, expect } from "vitest";
import { asFibConfig, defaultFibConfig, fibLevelSegments, type FibConfig } from "./fibConfig";

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
