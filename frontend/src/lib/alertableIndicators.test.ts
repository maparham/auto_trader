import { describe, it, expect } from "vitest";
import { checkAlertable, indicatorAlertLabel } from "./alertableIndicators";

describe("checkAlertable", () => {
  it("maps the EMA template to MA/ema with defaults", () => {
    const r = checkAlertable("EMA", [50], {}, "HOUR", true);
    expect(r).toEqual({
      ok: true,
      identity: { indicator: "MA", calcParams: [50], config: { maType: "ema", source: "close" }, priceTarget: true },
    });
  });
  it("keeps an MA template flipped to ema as ema", () => {
    const r = checkAlertable("MA", [20], { maType: "ema", source: "hl2" }, "HOUR", true);
    expect(r.ok && r.identity.config).toEqual({ maType: "ema", source: "hl2" });
  });
  it.each([
    [{ mtf: { timeframe: "HOUR_4" } }, "higher-timeframe"],
    [{ offset: 2 }, "offset"],
    [{ smoothing: { type: "ema", length: 9 } }, "smoothed"],
  ])("blocks unsupported MA config %j", (ext, word) => {
    const r = checkAlertable("EMA", [50], ext, "HOUR", true);
    expect(r.ok).toBe(false);
    expect(!r.ok && "reason" in r && r.reason).toContain(word);
  });
  // Boundaries computed from backend/auto_trader/indicators/alertable.py's
  // warmup() against MAX_WARMUP (1950): the last length it accepts and the
  // first it 422s with "length too long for alerts".
  it.each([
    ["EMA", {}, 564],
    ["MA", { maType: "evwma" }, 247],
    ["RSI", {}, 246],
    ["ATR", {}, 246],
    ["ATR", { smoothing: "ema" }, 437],
  ] as const)("mirrors the backend warm-up cap for %s %j (max length %d)", (type, ext, max) => {
    expect(checkAlertable(type, [max], ext, "HOUR", true).ok).toBe(true);
    const r = checkAlertable(type, [max + 1], ext, "HOUR", true);
    expect(!r.ok && "reason" in r && r.reason).toBe("Length too long for alerts");
  });
  it("sma, vwma and wma-smoothed ATR stay within the cap up to 1000", () => {
    expect(checkAlertable("MA", [1000], { maType: "sma" }, "HOUR", true).ok).toBe(true);
    expect(checkAlertable("MA", [1000], { maType: "vwma" }, "HOUR", true).ok).toBe(true);
    expect(checkAlertable("ATR", [1000], { smoothing: "wma" }, "HOUR", true).ok).toBe(true);
  });
  it("blocks volume-weighted MAs on a market with no volume", () => {
    const r = checkAlertable("MA", [20], { maType: "vwma" }, "HOUR", false);
    expect(!r.ok && "reason" in r && r.reason).toBe("This market has no volume data");
  });
  it("refuses a source the alertable registry doesn't support, for MA and RSI", () => {
    // hlcc4 is a real chart source (mtf.ts) that ALERTABLE's SOURCES doesn't
    // include: silently falling back to "close" would watch a different
    // line than the one on screen (preflight F7).
    const ma = checkAlertable("EMA", [50], { source: "hlcc4" }, "HOUR", true);
    expect(!ma.ok && "reason" in ma && ma.reason).toBe("Alerts on this source are coming later");
    const rsi = checkAlertable("RSI", [14], { source: "hlcc4" }, "HOUR", true);
    expect(!rsi.ok && "reason" in rsi && rsi.reason).toBe("Alerts on this source are coming later");
  });
  it("missing source still defaults to close (only an unrecognized one is refused)", () => {
    const r = checkAlertable("RSI", [14], {}, "HOUR", true);
    expect(r.ok && r.identity.config.source).toBe("close");
  });
  it("non-native timeframe gives a coming-later reason; seconds hide the entry", () => {
    const r = checkAlertable("RSI", [14], {}, "HOUR_2", true);
    expect(!r.ok && "reason" in r && r.reason).toBe("Alerts on this timeframe are coming later");
    expect(checkAlertable("RSI", [14], {}, "SECOND_5", true)).toEqual({ ok: false, hidden: true });
  });
  it("deferred types say coming later; unknown types hide", () => {
    const r = checkAlertable("BOLL", [20, 2], {}, "HOUR", true);
    expect(!r.ok && "reason" in r && r.reason).toBe("Alerts on BOLL are coming later");
    expect(checkAlertable("FVG", [], {}, "HOUR", true)).toEqual({ ok: false, hidden: true });
  });
  it("labels match the backend wording", () => {
    const r = checkAlertable("ATR", [14], { smoothing: "sma" }, "HOUR", true);
    expect(r.ok && indicatorAlertLabel(r.identity, "HOUR")).toBe("ATR 14 sma (1H)");
  });
});
