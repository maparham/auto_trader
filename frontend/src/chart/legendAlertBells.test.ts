// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { Chart } from "klinecharts";
import type { IndicatorAlert } from "../lib/alertsApi";
import { bellsSig, indicatorAlertBells } from "./legendAlertBells";

// A fake chart holding the named indicators (getIndicatorsByPane reads getIndicators).
const chartWith = (...inds: Array<{ name: string; extendData?: unknown }>) =>
  ({ getIndicators: () => inds.map((i) => ({ paneId: "pane_1", ...i })) }) as unknown as Chart;

function alert(over: Partial<IndicatorAlert> & { output?: string; instanceId?: string; timeframe?: string; scope?: string }): IndicatorAlert {
  const { output = "bullDiv", instanceId = "RSI", timeframe = "HOUR", scope = "cell-1", ...rest } = over;
  return {
    kind: "indicator", id: "al-1", epic: "US100", broker: "capital", condition: "crossing_up", trigger: "once",
    message: "", expiresAt: null, notify: {} as IndicatorAlert["notify"], precision: 2, whole: true,
    label: "RSI 14 bull div (1H)",
    params: { type: "RSI", config: {}, output, timeframe, target: "value", value: 0.5, evalOn: "close", link: { scope, instanceId } },
    ...rest,
  };
}

describe("indicatorAlertBells", () => {
  it("maps alerts to the linked indicator's legend row", () => {
    const got = indicatorAlertBells(chartWith({ name: "RSI" }), [alert({})], "cell-1", "HOUR");
    expect(got.get("RSI")).toEqual([{ id: "al-1", label: "RSI 14 bull div (1H)" }]);
  });

  it("includes curve and level alerts, not only whole-indicator ones", () => {
    const curve = alert({ id: "c", whole: false, output: "value" });
    const got = indicatorAlertBells(chartWith({ name: "RSI" }), [curve], "cell-1", "HOUR");
    expect(got.get("RSI")?.map((b) => b.id)).toEqual(["c"]);
  });

  it("skips other cells, other timeframes, missing indicators and unlinked alerts", () => {
    const got = indicatorAlertBells(
      chartWith({ name: "RSI" }),
      [
        alert({ id: "b", scope: "cell-2" }),
        alert({ id: "c", timeframe: "HOUR_4" }),
        alert({ id: "d", instanceId: "RSI2" }),
        alert({ id: "e", params: { ...alert({}).params, link: null } }),
      ],
      "cell-1",
      "HOUR",
    );
    expect(got.size).toBe(0);
  });

  it("lists several alerts on one indicator", () => {
    const got = indicatorAlertBells(chartWith({ name: "RSI" }), [alert({ id: "a" }), alert({ id: "b", label: undefined, output: "bearDiv" })], "cell-1", "HOUR");
    expect(got.get("RSI")?.map((b) => b.label)).toEqual(["RSI 14 bull div (1H)", "bearDiv"]);
  });

  it("keeps a fired alert's time, and the signature changes only with what shows", () => {
    const chart = chartWith({ name: "RSI" });
    const fired = indicatorAlertBells(chart, [{ ...alert({}), firedAt: 5 }], "cell-1", "HOUR");
    expect(fired.get("RSI")).toEqual([{ id: "al-1", label: "RSI 14 bull div (1H)", firedAt: 5 }]);
    const a = indicatorAlertBells(chart, [alert({})], "cell-1", "HOUR");
    const b = indicatorAlertBells(chart, [alert({ message: "edited" })], "cell-1", "HOUR");
    expect(bellsSig(a)).toBe(bellsSig(b));
    expect(bellsSig(a)).not.toBe(bellsSig(fired));
  });
});
