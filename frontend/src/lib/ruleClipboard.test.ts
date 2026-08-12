import { describe, it, expect } from "vitest";
import { decodeRuleClipboard, encodeRuleClipboard, sameInstanceConfig } from "./ruleClipboard";

const LIVE = [
  { id: "SLOPE", type: "SLOPE", calcParams: [9, 21], extendData: { units: "pctBar", barHours: 1 } },
  { id: "ATR1", type: "ATR", calcParams: [14], extendData: { smoothing: "ema" } },
  { id: "EMA", type: "EMA", calcParams: [9], extendData: {} },
];

describe("encode/decode round-trip", () => {
  it("carries the rules and the configs of exactly the panes they reference", () => {
    const rules = [
      { expr: "SLOPE.9 > 0 and EMA(9) < candle.close", enabled: true },
      { expr: "ATR1.to14 > 0.5", enabled: false, count: 2 },
    ];
    const out = decodeRuleClipboard(encodeRuleClipboard(rules, LIVE));
    expect(out).not.toBeNull();
    expect(out!.rules).toEqual(rules);
    // SLOPE + ATR1 referenced by instance; the EMA pane is not (EMA(9) is a call).
    expect(Object.keys(out!.indicators).sort()).toEqual(["ATR1", "SLOPE"]);
    expect(out!.indicators.SLOPE).toEqual({
      type: "SLOPE",
      calcParams: [9, 21],
      // barHours is runtime state (resolution-derived), stripped at encode.
      extendData: { units: "pctBar" },
    });
  });

  it("a rule with no instance refs ships an empty indicators map", () => {
    const out = decodeRuleClipboard(encodeRuleClipboard([{ expr: "EMA(9) > SMA(21)" }], LIVE));
    expect(out!.indicators).toEqual({});
  });
});

describe("decodeRuleClipboard rejects foreign clipboard content", () => {
  it.each([
    ["plain text", "hello"],
    ["other JSON", JSON.stringify({ a: 1 })],
    ["indicator envelope", JSON.stringify({ __autoTraderIndicator: 1, type: "EMA" })],
    ["tag without rules", JSON.stringify({ __autoTraderRules: 1 })],
    ["empty rules", JSON.stringify({ __autoTraderRules: 1, rules: [] })],
  ])("%s", (_label, text) => {
    expect(decodeRuleClipboard(text)).toBeNull();
  });

  it("sanitises junk fields instead of trusting them", () => {
    const out = decodeRuleClipboard(
      JSON.stringify({
        __autoTraderRules: 1,
        rules: [{ expr: 42, enabled: "yes", count: "3" }, { expr: "x > 0" }, null],
        indicators: {
          OK: { type: "SLOPE", calcParams: [9, "junk"], extendData: null, visible: "yes", styles: 7 },
          BAD: { calcParams: [1] },
        },
      }),
    );
    // The exprless entry is junk — a rule IS its expression — and is dropped.
    expect(out!.rules).toEqual([{ expr: "x > 0", enabled: undefined, count: undefined }]);
    expect(out!.indicators).toEqual({ OK: { type: "SLOPE", calcParams: [9], extendData: {} } });
  });

  it("rules with only junk entries decode to null", () => {
    expect(
      decodeRuleClipboard(JSON.stringify({ __autoTraderRules: 1, rules: [{ expr: 42 }, null] })),
    ).toBeNull();
  });
});

describe("runtime state is stripped from the envelope", () => {
  it("drops barHours and the MTF series stash but keeps the pinned timeframe", () => {
    const live = [
      {
        id: "SLOPE",
        type: "SLOPE",
        calcParams: [9],
        extendData: {
          units: "pctBar",
          barHours: 4,
          mtf: {
            timeframe: "HOUR",
            htfStarts: [1, 2, 3],
            htfMs: 3_600_000,
            htfSeriesByLine: [[1, 2]],
            htfMaBaseByLine: [[1, 2]],
            htfAccelByLine: [[0, 0]],
          },
        },
      },
    ];
    const out = decodeRuleClipboard(encodeRuleClipboard([{ expr: "SLOPE.9 > 0" }], live));
    expect(out!.indicators.SLOPE.extendData).toEqual({
      units: "pctBar",
      mtf: { timeframe: "HOUR" },
    });
  });

  it("ships the pane's appearance (visible + line styles) when captured", () => {
    const live = [{ id: "ATR1", type: "ATR", calcParams: [14], extendData: {} }];
    const appearance = {
      ATR1: { visible: false, styles: { lines: [{ color: "#f00", size: 2 }] } },
      UNREFERENCED: { visible: true },
    };
    const out = decodeRuleClipboard(
      encodeRuleClipboard([{ expr: "ATR1.to14 > 1" }], live, appearance),
    );
    expect(out!.indicators.ATR1.visible).toBe(false);
    expect(out!.indicators.ATR1.styles).toEqual({ lines: [{ color: "#f00", size: 2 }] });
    expect(Object.keys(out!.indicators)).toEqual(["ATR1"]);
  });
});

describe("sameInstanceConfig", () => {
  const payload = { type: "SLOPE", calcParams: [9, 21], extendData: { units: "pctBar" } };
  it("matches on type + calcParams + extendData", () => {
    expect(
      sameInstanceConfig(
        { id: "SLOPE", type: "SLOPE", calcParams: [9, 21], extendData: { units: "pctBar" } },
        payload,
      ),
    ).toBe(true);
  });
  it("differs on any authored setting", () => {
    expect(
      sameInstanceConfig({ id: "SLOPE", type: "SLOPE", calcParams: [9], extendData: { units: "pctBar" } }, payload),
    ).toBe(false);
    expect(
      sameInstanceConfig({ id: "SLOPE", type: "SLOPE", calcParams: [9, 21], extendData: { units: "pctHour" } }, payload),
    ).toBe(false);
    expect(
      sameInstanceConfig({ id: "X", type: "ATR", calcParams: [9, 21], extendData: { units: "pctBar" } }, payload),
    ).toBe(false);
  });
  it("ignores the resolution-derived barHours on either side", () => {
    expect(
      sameInstanceConfig(
        { id: "SLOPE", type: "SLOPE", calcParams: [9, 21], extendData: { units: "pctBar", barHours: 4 } },
        { ...payload, extendData: { units: "pctBar", barHours: 0.5 } },
      ),
    ).toBe(true);
  });
  it("ignores display state and the MTF runtime stash — same authored pane", () => {
    expect(
      sameInstanceConfig(
        {
          id: "SLOPE",
          type: "SLOPE",
          calcParams: [9, 21],
          extendData: {
            units: "pctBar",
            userVisible: false,
            visibility: { mode: "some" },
            mtf: { timeframe: "HOUR", htfStarts: [1, 2], htfSeriesByLine: [[1]] },
          },
        },
        { ...payload, extendData: { units: "pctBar", mtf: { timeframe: "HOUR" } } },
      ),
    ).toBe(true);
    // …but a different pinned timeframe is an authored difference.
    expect(
      sameInstanceConfig(
        { id: "SLOPE", type: "SLOPE", calcParams: [9, 21], extendData: { units: "pctBar", mtf: { timeframe: "DAY" } } },
        { ...payload, extendData: { units: "pctBar", mtf: { timeframe: "HOUR" } } },
      ),
    ).toBe(false);
  });
  it("treats an absent mtf and a null pin as the same (chart timeframe)", () => {
    expect(
      sameInstanceConfig(
        { id: "SLOPE", type: "SLOPE", calcParams: [9, 21], extendData: { units: "pctBar", mtf: { timeframe: null } } },
        payload,
      ),
    ).toBe(true);
  });
});
