import { describe, expect, it } from "vitest";
import type { KLineData } from "klinecharts";
import { maSeries, htfCoverageStartMs, HTF_WARMUP_BARS } from "./mtf";

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
