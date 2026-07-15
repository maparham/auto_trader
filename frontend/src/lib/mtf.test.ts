import { describe, expect, it } from "vitest";
import type { KLineData } from "klinecharts";
import { maSeries, normalizeMaKind, htfCoverageStartMs, HTF_WARMUP_BARS } from "./mtf";

// Minimal flat bars (open=high=low=close) one step apart.
function bars(closes: number[]): KLineData[] {
  return closes.map((c, i) => ({
    timestamp: i * 60_000,
    open: c,
    high: c,
    low: c,
    close: c,
    volume: 0,
  }));
}

describe("maSeries smoothing", () => {
  const closes = Array.from({ length: 30 }, (_, i) => 100 + i);

  it("smooths the defined tail without blanking the line (SMA base + EMA smoothing)", () => {
    const { smoothing } = maSeries(bars(closes), "sma", 5, {
      smoothing: { type: "ema", length: 3 },
    });
    expect(smoothing).toBeDefined();
    expect(smoothing!.length).toBe(30);
    // SMA(5) warms up over the first 4 bars -> undefined; the rest is smoothed.
    expect(smoothing!.slice(0, 4).every((v) => v === undefined)).toBe(true);
    const tail = smoothing!.slice(4);
    expect(tail.length).toBeGreaterThan(0);
    expect(tail.every((v) => typeof v === "number" && Number.isFinite(v))).toBe(true);
  });

  it("SMA base + SMA smoothing also stays finite", () => {
    const { smoothing } = maSeries(bars(closes), "sma", 5, {
      smoothing: { type: "sma", length: 3 },
    });
    // Last value must be a real number, not undefined/NaN.
    const last = smoothing![smoothing!.length - 1];
    expect(typeof last).toBe("number");
    expect(Number.isFinite(last as number)).toBe(true);
  });

  it("returns the base as a SEPARATE line, never overwritten by smoothing (TV behavior)", () => {
    const plain = maSeries(bars(closes), "sma", 5);
    const withSmooth = maSeries(bars(closes), "sma", 5, {
      smoothing: { type: "ema", length: 3 },
    });
    // Base line is identical whether or not smoothing is on.
    expect(withSmooth.base).toEqual(plain.base);
    // Smoothing is a distinct line, not equal to the base.
    expect(withSmooth.smoothing).toBeDefined();
    expect(withSmooth.smoothing).not.toEqual(withSmooth.base);
  });

  it("omits the smoothing line when smoothing is off", () => {
    const off = maSeries(bars(closes), "sma", 5, { smoothing: { type: "none", length: 3 } });
    expect(off.smoothing).toBeUndefined();
    expect(off.base).toEqual(maSeries(bars(closes), "sma", 5).base);
  });

  it("applies offset to the base line only, leaving smoothing unshifted (matches TV)", () => {
    const noOffset = maSeries(bars(closes), "sma", 5, {
      smoothing: { type: "ema", length: 3 },
    });
    const offset = maSeries(bars(closes), "sma", 5, {
      offset: 2,
      smoothing: { type: "ema", length: 3 },
    });
    // Base shifted forward by 2 bars: offset.base[i+2] === noOffset.base[i].
    for (let i = 0; i < closes.length - 2; i++) {
      expect(offset.base[i + 2]).toBe(noOffset.base[i]);
    }
    // Smoothing is computed from the unshifted base, so offset does not move it.
    expect(offset.smoothing).toEqual(noOffset.smoothing);
  });
});

describe("htfCoverageStartMs", () => {
  const HOUR = 3_600_000;
  const oldest = 1_000 * HOUR; // arbitrary oldest chart bar

  it("reaches back to before the oldest chart bar by the MA length plus warmup", () => {
    // The HTF series must start `length` HTF bars before the oldest chart bar so
    // alignment covers it and the MA is already converged there.
    expect(htfCoverageStartMs(oldest, HOUR, 9)).toBe(oldest - (9 + HTF_WARMUP_BARS) * HOUR);
  });

  it("adds the MA length so the oldest visible bars are not blank/unconverged", () => {
    // Longer MA => reaches strictly further back (more warmup). Load-bearing term.
    const short = htfCoverageStartMs(oldest, HOUR, 9);
    const long = htfCoverageStartMs(oldest, HOUR, 200);
    expect(short - long).toBe((200 - 9) * HOUR);
  });

  it("returns the oldest bar unchanged when htfMs is not positive", () => {
    expect(htfCoverageStartMs(oldest, 0, 9)).toBe(oldest);
  });
});

// Bars with per-bar volume (the flat-price bars() helper above pins volume to 0,
// which is exactly the degenerate case for the volume-weighted kinds). Shared
// with ma.test.ts so the bar shape cannot drift between the two suites.
import { vbars } from "./testBars";

describe("maSeries vwma", () => {
  it("is the volume-weighted mean over the window", () => {
    const { base } = maSeries(vbars([10, 20, 30, 40], [1, 2, 3, 4]), "vwma", 2);
    expect(base[0]).toBeUndefined(); // warm-up: window not full
    expect(base[1]).toBeCloseTo(50 / 3, 10); // (10*1 + 20*2) / 3
    expect(base[2]).toBeCloseTo(26, 10); // (20*2 + 30*3) / 5
    expect(base[3]).toBeCloseTo(250 / 7, 10); // (30*3 + 40*4) / 7
  });
  it("is undefined wherever the window's volume sum is 0", () => {
    const { base } = maSeries(vbars([10, 20, 30], [1, 0, 0]), "vwma", 2);
    expect(base[1]).toBeCloseTo(10, 10); // (10*1 + 20*0) / 1
    expect(base[2]).toBeUndefined(); // window volume 0
  });
  it("is all-undefined on a volumeless instrument", () => {
    const { base } = maSeries(vbars([10, 20, 30], [0, 0, 0]), "vwma", 2);
    expect(base).toEqual([undefined, undefined, undefined]);
  });
});

describe("maSeries vwma float residue", () => {
  it("gaps on an all-zero window even after fractional volumes slid out", () => {
    // 0.1 + 0.2 leaves a nonzero float residue when subtracted back out; the
    // exact-count guard must still treat the [0, 0] window as empty.
    const { base } = maSeries(vbars([10, 20, 30, 40], [0.1, 0.2, 0, 0]), "vwma", 2);
    expect(base[1]).toBeDefined();
    expect(base[2]).toBeDefined(); // window [0.2, 0] still carries volume
    expect(base[3]).toBeUndefined(); // window [0, 0]: gap, not pv-residue garbage
  });
});

describe("maSeries evwma", () => {
  it("seeds from the source price at the first full window, then recurses", () => {
    const { base } = maSeries(vbars([10, 20, 30], [1, 2, 3]), "evwma", 2);
    expect(base[0]).toBeUndefined(); // warm-up
    expect(base[1]).toBeCloseTo(20, 10); // seed = price at first full window
    // nbfs = 2+3 = 5: (20*(5-3) + 3*30) / 5
    expect(base[2]).toBeCloseTo(26, 10);
  });
  it("holds the prior value across a zero-volume bar", () => {
    const { base } = maSeries(vbars([10, 20, 30], [1, 1, 0]), "evwma", 2);
    expect(base[1]).toBeCloseTo(20, 10);
    // nbfs = 1+0 = 1, vol = 0: (20*(1-0) + 0) / 1 = 20
    expect(base[2]).toBeCloseTo(20, 10);
  });
  it("goes undefined on a zero-volume window and re-seeds at the next usable bar", () => {
    const { base } = maSeries(vbars([10, 20, 30, 40, 50], [1, 1, 0, 0, 2]), "evwma", 2);
    expect(base[1]).toBeCloseTo(20, 10);
    expect(base[2]).toBeCloseTo(20, 10); // nbfs = 1: holds
    expect(base[3]).toBeUndefined(); // nbfs = 0
    expect(base[4]).toBeCloseTo(50, 10); // re-seeded from price
  });
  it("respects the source option", () => {
    // vbars sets high = close + 1, so an evwma over "high" tracks price + 1.
    const { base } = maSeries(vbars([10, 20, 30], [1, 2, 3]), "evwma", 2, { source: "high" });
    expect(base[1]).toBeCloseTo(21, 10);
  });
});

describe("maSeries evwma float residue", () => {
  it("does not re-seed off a residue window after fractional volumes slid out", () => {
    const { base } = maSeries(vbars([10, 20, 30, 40], [0.1, 0.2, 0, 0]), "evwma", 2);
    expect(base[2]).toBeDefined(); // window [0.2, 0] holds the prior value
    expect(base[3]).toBeUndefined(); // window [0, 0]: undefined, recursion reset
  });
});

describe("normalizeMaKind", () => {
  it("passes valid kinds through and falls back otherwise", () => {
    expect(normalizeMaKind("vwma")).toBe("vwma");
    expect(normalizeMaKind("evwma")).toBe("evwma");
    expect(normalizeMaKind("sma")).toBe("sma");
    expect(normalizeMaKind(undefined)).toBe("ema");
    expect(normalizeMaKind("garbage", "sma")).toBe("sma");
  });
});
