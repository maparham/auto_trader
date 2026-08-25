import { describe, expect, it } from "vitest";
import {
  SR_ATR_LEN,
  SR_LEVELS_DEFAULTS,
  SR_LEVELS_OUTPUTS,
  parseSrConfig,
  srLevelsWarmup,
} from "./srLevelsOutputs";

describe("SR_LEVELS_OUTPUTS", () => {
  it("pins the fixed output names, support first", () => {
    // support first: the chart click-to-insert token emits outputs[0], and the
    // backend's sr_outputs orders them the same way.
    expect(SR_LEVELS_OUTPUTS).toEqual(["support", "resistance"]);
  });
});

describe("parseSrConfig", () => {
  it("takes every default from an empty params list", () => {
    expect(parseSrConfig([])).toEqual(SR_LEVELS_DEFAULTS);
    expect(parseSrConfig(undefined)).toEqual(SR_LEVELS_DEFAULTS);
  });

  it("reads the five params positionally", () => {
    expect(parseSrConfig([11, 1.5, 3, 4, 200])).toEqual({
      pivotLen: 11,
      atrMult: 1.5,
      minTouches: 3,
      maxLevels: 4,
      maxBars: 200,
    });
  });

  it("falls back per field on anything non-finite or <= 0", () => {
    // Only the bad fields take defaults; atrMult keeps the value it was given.
    expect(parseSrConfig(["x", 0.25, 0, NaN, -3])).toEqual({
      ...SR_LEVELS_DEFAULTS,
      atrMult: 0.25,
    });
  });

  it("floors the integer fields (atrMult stays fractional)", () => {
    const cfg = parseSrConfig([11.9, 0.75, 2.9, 8.5, 500.5]);
    expect(cfg).toEqual({
      pivotLen: 11,
      atrMult: 0.75,
      minTouches: 2,
      maxLevels: 8,
      maxBars: 500,
    });
  });
});

describe("srLevelsWarmup", () => {
  it("is ATR(14) plus one full pivot window, mirroring backend sr_warmup", () => {
    expect(srLevelsWarmup(parseSrConfig([11, 0.5, 2, 8, 500]))).toBe(SR_ATR_LEN + 2 * 11);
    expect(srLevelsWarmup(SR_LEVELS_DEFAULTS)).toBe(SR_ATR_LEN + 2 * SR_LEVELS_DEFAULTS.pivotLen);
  });

  it("ignores the level-retention window, which is a drawing depth not a warm-up", () => {
    const short = parseSrConfig([11, 0.5, 2, 8, 50]);
    const long = parseSrConfig([11, 0.5, 2, 8, 5000]);
    expect(srLevelsWarmup(short)).toBe(srLevelsWarmup(long));
  });
});
