// SPIKE frontend series: spike -> flat consolidation -> retrace state machine.
// Mirrors the backend suite (backend/tests/test_spike.py) — same scenarios,
// same expectations — per the parity contract in indicators/core.py.
import { describe, it, expect, vi } from "vitest";
import type { KLineData } from "klinecharts";

vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));

const { computeSpike, spikeSegments } = await import("./spike");
const { SPIKE_OUTPUTS, SPIKE_DEFAULTS, parseSpikeConfig, spikeWarmup } = await import(
  "./spikeOutputs"
);

function bar(low: number, high: number): KLineData {
  return { timestamp: 0, open: low, high, low, close: high, volume: 0 };
}

function flat(n: number, low = 100, high = 101): KLineData[] {
  return Array.from({ length: n }, () => bar(low, high));
}

const CFG = { spikeBars: 3, minSpikePct: 5, flatBars: 3, maxFlatRangePct: 20, maxPatternBars: 60, maxRetracePct: 70 };

// Spike at bar 3: window lows over bars 1..3 bottom out at 100, high 106 is a
// +6% rise (>= 5%) within spikeBars=3. Height 6, flat floor 106 - 20% * 6 = 104.8.
const SPIKE_BARS = [...flat(3), bar(100.5, 106)];

// Three in-band bars after the spike (no new high, lows >= 104.8) latch consolOk.
const CONSOL_BARS = [...SPIKE_BARS, bar(105, 106), bar(105, 105.8), bar(105.2, 105.9)];

describe("computeSpike", () => {
  it("is all-undefined while idle", () => {
    for (const p of computeSpike(flat(4), CFG)) {
      expect(p).toEqual({});
    }
  });

  it("sets the anchors at the spike bar", () => {
    const pts = computeSpike(SPIKE_BARS, CFG);
    expect(pts[2]).toEqual({});
    expect(pts[3].spikeHigh).toBe(106);
    expect(pts[3].spikeLow).toBe(100);
    expect(pts[3].barsSinceSpike).toBe(0);
    expect(pts[3].consolOk).toBe(0);
    // Current-bar dip as % of spike height: (106 - 100.5) / 6.
    expect(pts[3].retracePct).toBeCloseTo(91.6667, 3);
    expect(pts[3].maxRetracePct).toBe(0);
  });

  it("does not arm on a rise below the threshold", () => {
    const pts = computeSpike([...flat(3), bar(100.5, 104)], CFG); // +4% < 5%
    expect(pts[3]).toEqual({});
  });

  it("latches consolOk after flatBars in-band bars", () => {
    const pts = computeSpike(CONSOL_BARS, CFG);
    expect(pts.slice(3).map((p) => p.consolOk)).toEqual([0, 0, 0, 1]);
    expect(pts[6].barsSinceSpike).toBe(3);
    expect(pts[6].spikeHigh).toBe(106);
  });

  it("voids the pattern on a dip below the flat band before the latch", () => {
    // Bar 4 low 103 < flat floor 104.8 with consolOk still 0; its own window
    // (rise 104 vs low 100 = +4%) does not re-arm.
    const pts = computeSpike([...SPIKE_BARS, bar(103, 104)], CFG);
    expect(pts[4]).toEqual({});
  });

  it("extends the spike on a steep new high and restarts the clock", () => {
    // Bar 5's window (bars 3..5) still bottoms at bar 3's low 100.5, so the
    // rise to 107 is +6.5% — steep, a true extension.
    const pts = computeSpike([...SPIKE_BARS, bar(105, 106), bar(105, 107)], CFG);
    expect(pts[5].spikeHigh).toBe(107);
    expect(pts[5].spikeLow).toBe(100);
    expect(pts[5].barsSinceSpike).toBe(0);
    expect(pts[5].consolOk).toBe(0);
  });

  it("ends the pattern on a non-steep new high instead of extending", () => {
    // Consolidation latches over bars 4..6, whose lows lift the trailing
    // window off the spike base. Bar 7's marginal new high 106.5 rises only
    // +1.4% from its own window low 105 — a grind, not a spike leg — so the
    // pattern dies rather than inflating (and the same failed check keeps the
    // bar from re-arming).
    const pts = computeSpike([...CONSOL_BARS, bar(105.5, 106.5)], CFG);
    expect(pts[7]).toEqual({});
  });

  it("tracks current and max retrace depth after the latch", () => {
    // Post-latch dips below the FLAT band are fine — the tradeable retrace —
    // as long as they hold the (deeper) Max Retrace floor. CFG's
    // maxRetracePct 70 puts that floor at 101.8, so lows 104 / 104.5 track.
    const pts = computeSpike([...CONSOL_BARS, bar(104, 105), bar(104.5, 105.5)], CFG);
    expect(pts[7].retracePct).toBeCloseTo(33.3333, 3); // (106-104)/6
    expect(pts[8].retracePct).toBeCloseTo(25.0, 3);
    expect(pts[7].maxRetracePct).toBeCloseTo(33.3333, 3);
    expect(pts[8].maxRetracePct).toBeCloseTo(33.3333, 3); // deepest so far
    expect(pts[8].consolOk).toBe(1); // latched through the dip
  });

  it("invalidates on a dip below Max Retrace after the latch", () => {
    // Max Retrace is the post-latch hard floor: a dip past it means the bull
    // continuation is no longer high-probability, so the pattern dies. With
    // maxRetracePct 30 the floor is 104.2; bar 7's low 104 crosses it.
    const pts = computeSpike([...CONSOL_BARS, bar(104, 105)], { ...CFG, maxRetracePct: 30 });
    expect(pts[7]).toEqual({});
  });

  it("invalidates on a break below the spike low", () => {
    // Bar 7 low 99.5 < spikeLow 100; its own window (104 vs 99.5 = +4.5%)
    // does not immediately re-arm.
    const pts = computeSpike([...CONSOL_BARS, bar(99.5, 104)], CFG);
    expect(pts[7]).toEqual({});
  });

  it("anchors the base to the nearest qualifying swing low", () => {
    // Window reaches the old deep low 95, but a real pullback-up (bar 1, low
    // 101) separates it from the spike leg. The base walk stops at that
    // pullback: spikeLow anchors to the leg's own low 98, not the stale 95 —
    // matching the swing low a fib drawn over the leg would use.
    const cfg = { ...CFG, spikeBars: 6 };
    const pts = computeSpike([bar(95, 96), bar(101, 102), bar(98.5, 99.5), bar(98, 106)], cfg);
    expect(pts[3].spikeLow).toBe(98);
    expect(pts[3].spikeHigh).toBe(106);
  });

  it("extends the base walk through the basing region", () => {
    // Qualification needs lookback (rise from bar 1's low), and the walk keeps
    // absorbing bars that stay near the running low — base is the full basing
    // region's low, same as the old window minimum when no pullback separates.
    const cfg = { ...CFG, spikeBars: 6 };
    const pts = computeSpike([bar(100, 101), bar(100, 101), bar(100.5, 103), bar(102, 105.5)], cfg);
    expect(pts[3].spikeLow).toBe(100);
    expect(pts[3].spikeHigh).toBe(105.5);
  });

  it("expires the pattern after maxPatternBars", () => {
    // Spike at bar 3; bars 4..8 hold the flat band, so nothing else resets the
    // machine — at age 5 (bar 8) the pattern expires and the in-band bars
    // cannot re-arm (+1% < 5%).
    const cfg = { ...CFG, maxPatternBars: 5 };
    const pts = computeSpike([...SPIKE_BARS, ...flat(5, 105, 106)], cfg);
    expect(pts[7].spikeHigh).toBe(106); // age 4: still armed
    expect(pts[8]).toEqual({}); // age 5: expired
  });

  it("frees a new spike to arm with fresh anchors after expiry", () => {
    // First spike at bar 3 expires at bar 7 (age 4). Bar 9's high 111 then
    // arms a NEW spike from its own trailing window (low 105). Without expiry
    // the old pattern would still be armed and 111 would EXTEND it, keeping
    // spikeLow 100 — the stale-anchor bug this parameter exists to fix.
    const cfg = { ...CFG, maxPatternBars: 4 };
    const pts = computeSpike(
      [...SPIKE_BARS, ...flat(4, 105, 106), bar(105, 105.5), bar(105.5, 111)],
      cfg,
    );
    expect(pts[8]).toEqual({});
    expect(pts[9].spikeLow).toBe(105);
    expect(pts[9].spikeHigh).toBe(111);
    expect(pts[9].barsSinceSpike).toBe(0);
  });
});

describe("spikeSegments", () => {
  it("splits an episode at the consolOk latch", () => {
    // Pattern arms at bar 3, latches at bar 6: one amber (pre-latch) segment,
    // one green (latched) segment, same anchors.
    const segs = spikeSegments(computeSpike(CONSOL_BARS, CFG));
    expect(segs).toEqual([
      { from: 3, to: 5, spikeHigh: 106, spikeLow: 100, latched: false },
      { from: 6, to: 6, spikeHigh: 106, spikeLow: 100, latched: true },
    ]);
  });

  it("splits at an extension (anchors change)", () => {
    const segs = spikeSegments(computeSpike([...SPIKE_BARS, bar(105, 106), bar(105, 107)], CFG));
    expect(segs).toEqual([
      { from: 3, to: 4, spikeHigh: 106, spikeLow: 100, latched: false },
      { from: 5, to: 5, spikeHigh: 107, spikeLow: 100, latched: false },
    ]);
  });

  it("separates episodes across idle gaps", () => {
    // The void at bar 4 (dip below the flat band) ends the first episode; a
    // fresh spike at bar 6 starts a second one.
    const pts = computeSpike([...SPIKE_BARS, bar(103, 104), bar(103, 104.5), bar(103.5, 110)], CFG);
    const segs = spikeSegments(pts);
    expect(segs).toEqual([
      { from: 3, to: 3, spikeHigh: 106, spikeLow: 100, latched: false },
      { from: 6, to: 6, spikeHigh: 110, spikeLow: 103, latched: false },
    ]);
  });

  it("returns nothing for an idle series", () => {
    expect(spikeSegments(computeSpike(flat(4), CFG))).toEqual([]);
  });

  it("extends an episode's first segment left to the base low's bar", () => {
    // Spike arms at bar 3 with base 100; the nearest bar carrying that low is
    // bar 2, so the episode's box starts there — covering the leg and its
    // swing low, not just the pattern's armed life.
    const candles = CONSOL_BARS;
    const segs = spikeSegments(computeSpike(candles, CFG), {
      lows: candles.map((c) => c.low),
      spikeBars: CFG.spikeBars,
    });
    expect(segs[0]).toEqual({ from: 3, to: 5, spikeHigh: 106, spikeLow: 100, latched: false, legFrom: 2 });
    // Later segments of the same episode (here: the latch) are untouched.
    expect(segs[1]).toEqual({ from: 6, to: 6, spikeHigh: 106, spikeLow: 100, latched: true });
  });
});

describe("spikeOutputs", () => {
  it("pins the fixed output names, spikeHigh first", () => {
    expect(SPIKE_OUTPUTS).toEqual([
      "spikeHigh",
      "spikeLow",
      "barsSinceSpike",
      "consolOk",
      "retracePct",
      "maxRetracePct",
    ]);
  });

  it("takes every default from an empty params list", () => {
    expect(parseSpikeConfig([])).toEqual(SPIKE_DEFAULTS);
    expect(parseSpikeConfig(null)).toEqual(SPIKE_DEFAULTS);
  });

  it("reads params positionally", () => {
    expect(parseSpikeConfig([3, 5, 3, 20])).toEqual(CFG);
    expect(parseSpikeConfig([3, 5, 3, 20, 50, 55])).toEqual({ ...CFG, maxPatternBars: 50, maxRetracePct: 55 });
  });

  it("falls back to defaults on zero / negative / garbage", () => {
    expect(parseSpikeConfig([0, -1, "x", 0, 0, -3])).toEqual(SPIKE_DEFAULTS);
  });

  it("charges the trailing window plus the pattern lifetime as warm-up", () => {
    // State at a bar can depend on a pattern that armed up to maxPatternBars
    // earlier, itself needing its trailing spike window.
    expect(spikeWarmup(CFG)).toBe(3 + 60);
  });
});
