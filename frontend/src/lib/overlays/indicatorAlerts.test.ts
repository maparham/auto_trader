import { describe, it, expect, vi } from "vitest";
vi.mock("klinecharts", () => ({ registerOverlay: () => {}, registerIndicator: () => {}, registerYAxis: () => {}, getSupportedIndicators: () => [] }));
const alerts: unknown[] = [];
const lineAlerts: unknown[] = [];
vi.mock("../alertsApi", async (orig) => ({
  ...(await orig<typeof import("../alertsApi")>()),
  loadIndicatorAlerts: () => alerts,
  loadLineAlerts: () => lineAlerts,
  patchIndicatorAlert: vi.fn(() => Promise.resolve(true)),
}));
import { IndicatorAlertLines } from "./indicatorAlerts";
import { patchIndicatorAlert } from "../alertsApi";
import { ChartController } from "../chartController";

function fakeChart() {
  const created: Array<Record<string, unknown>> = [];
  return {
    created,
    chart: {
      createOverlay: (o: Record<string, unknown>) => { created.push(o); return o.id as string; },
      removeOverlay: vi.fn(),
      overrideOverlay: vi.fn(),
      getIndicators: () => [{ name: "RSI", paneId: "pane_rsi" }, { name: "TRENDLINES", paneId: "candle_pane", extendData: {} }],
    },
  };
}
const valueAlert = (scope: string, tf = "HOUR") => ({
  kind: "indicator", id: "al-1", epic: "US100", broker: "b", condition: "greater", trigger: "every",
  message: "", expiresAt: null, notify: {}, precision: 2,
  params: { type: "RSI", config: { source: "close" }, output: "value", timeframe: tf, target: "value", value: 70, evalOn: "close",
    link: { scope, instanceId: "RSI" } },
});

describe("IndicatorAlertLines", () => {
  it("draws a value line in the linked indicator's pane, only for this cell and timeframe", () => {
    alerts.splice(0, alerts.length, valueAlert("s1"), { ...valueAlert("s2"), id: "al-2" }, { ...valueAlert("s1", "DAY"), id: "al-3" });
    const { chart, created } = fakeChart();
    const lines = new IndicatorAlertLines();
    lines.attach(chart as never, "s1", "b", "US100", "HOUR");
    lines.reconcile();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      paneId: "pane_rsi", points: [{ value: 70 }],
      lock: true, needDefaultXAxisFigure: false,
    });
    // v10 deletes an overlay on right-click unless the handler calls
    // preventDefault (F8) - prove createAlertLine's handler actually does.
    const pd = vi.fn();
    (created[0].onRightClick as (e: { preventDefault: () => void }) => boolean)({ preventDefault: pd });
    expect(pd).toHaveBeenCalled();
    expect(lines.lines()).toEqual([{ alertId: "al-1", paneId: "pane_rsi", value: 70 }]);
  });

  it("moves, then removes, the line as the alert and its pane change", () => {
    alerts.splice(0, alerts.length, valueAlert("s1"));
    const inds = [{ name: "RSI", paneId: "pane_rsi" }];
    const { chart, created } = fakeChart();
    chart.getIndicators = () => inds;
    const lines = new IndicatorAlertLines();
    lines.attach(chart as never, "s1", "b", "US100", "HOUR");
    lines.reconcile();
    lines.reconcile(); // idempotent: no second line
    expect(created).toHaveLength(1);
    const a = valueAlert("s1");
    alerts.splice(0, alerts.length, { ...a, params: { ...a.params, value: 65 } });
    lines.reconcile();
    expect(chart.overrideOverlay).toHaveBeenCalledWith({ id: "indalert:al-1", points: [{ value: 65 }] });
    inds.splice(0); // the RSI pane was removed
    lines.reconcile();
    expect(chart.removeOverlay).toHaveBeenCalledWith({ id: "indalert:al-1" });
    expect(lines.lines()).toEqual([]);
  });

  it("previews a drag on the chart and commits it as a params.value patch", () => {
    alerts.splice(0, alerts.length, valueAlert("s1"));
    const { chart } = fakeChart();
    const lines = new IndicatorAlertLines();
    lines.attach(chart as never, "s1", "b", "US100", "HOUR");
    lines.reconcile();
    lines.preview("al-1", 66.5);
    expect(lines.lines()[0].value).toBe(66.5);
    expect(patchIndicatorAlert).not.toHaveBeenCalled();
    lines.commit("al-1", 0.000523456789);
    expect(patchIndicatorAlert).toHaveBeenCalledWith("al-1", { params: { value: 0.000523457 } });
    expect(lines.lines()[0].value).toBe(0.000523457);
  });

  it("follows the Hide alert lines eye: created hidden, re-shown on toggle", () => {
    alerts.splice(0, alerts.length, valueAlert("s1"));
    let hidden = true;
    const { chart, created } = fakeChart();
    const lines = new IndicatorAlertLines(() => hidden);
    lines.attach(chart as never, "s1", "b", "US100", "HOUR");
    lines.reconcile();
    expect(created[0]).toMatchObject({ visible: false });
    hidden = false;
    lines.reconcile();
    expect(chart.overrideOverlay).toHaveBeenCalledWith({ id: "indalert:al-1", visible: true });
  });

  it("draws no line for an inset instance, and restores it when inset is toggled off", () => {
    alerts.splice(0, alerts.length, valueAlert("s1"));
    const inds: Array<Record<string, unknown>> = [{ name: "RSI", paneId: "candle_pane", extendData: { inset: true } }];
    const { chart, created } = fakeChart();
    chart.getIndicators = () => inds as never;
    const lines = new IndicatorAlertLines();
    lines.attach(chart as never, "s1", "b", "US100", "HOUR");
    lines.reconcile();
    expect(created).toHaveLength(0);
    expect(lines.lines()).toEqual([]);
    // setIndicatorInset(off): remove, then re-add in its own sub-pane, then reconcile.
    inds.splice(0, 1, { name: "RSI", paneId: "pane_rsi2", extendData: {} });
    lines.reconcile();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ paneId: "pane_rsi2", points: [{ value: 70 }] });
  });

  it("ChartController wires the sidebar eye to its indicator alert lines", () => {
    alerts.splice(0, alerts.length, valueAlert("s1"));
    const { chart, created } = fakeChart();
    const ctl = new ChartController("c1", "s1");
    ctl.indicatorAlerts.attach(chart as never, "s1", "b", "US100", "HOUR");
    ctl.indicatorAlerts.reconcile();
    expect(created[0]).toMatchObject({ visible: true });
    ctl.overlays.setAlertsHidden(true);
    expect(chart.overrideOverlay).toHaveBeenCalledWith({ id: "indalert:al-1", visible: false });
  });
});

const lineAlert = (scope: string, tf = "HOUR") => ({
  kind: "line", id: "al-l", epic: "US100", broker: "b", condition: "crossing", trigger: "every",
  message: "", expiresAt: null, notify: {}, precision: 2,
  params: { timeframe: tf, evalOn: "close", tRef: 9, pRef: 13, slope: 0.5,
    anchors: { t1: 2, p1: 10, t2: 6, p2: 12 }, link: { scope, instanceId: "TRENDLINES", lineKey: "2:6" } },
});

describe("IndicatorAlertLines: line alerts", () => {
  it("draws a dashed ray through the anchors on the linked cell's timeframe only", () => {
    alerts.splice(0, alerts.length);
    lineAlerts.splice(0, lineAlerts.length, lineAlert("s1"), { ...lineAlert("s1", "DAY"), id: "al-l2" }, { ...lineAlert("s2"), id: "al-l3" });
    const { chart, created } = fakeChart();
    const lines = new IndicatorAlertLines();
    lines.attach(chart as never, "s1", "b", "US100", "HOUR");
    lines.reconcile();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      id: "lnalert:al-l", name: "rayLine", lock: true,
      points: [{ timestamp: 2, value: 10 }, { timestamp: 6, value: 12 }],
    });
    lineAlerts.splice(0, lineAlerts.length);
    lines.reconcile();
    expect(chart.removeOverlay).toHaveBeenCalledWith({ id: "lnalert:al-l" });
  });

  it("follows the pinned stroke on a finer chart and moves with new bars", () => {
    // 15m chart under a 1h pin: HTF bar 2 (chart bars 8..11) bottoms at 90 on
    // chart bar 10, where the trendline's stroke starts.
    const T0 = 1_700_000_000_000;
    const M15 = 900_000;
    const H1 = 3_600_000;
    const bars = Array.from({ length: 40 }, (_, i) => {
      const t = T0 + i * M15;
      return { timestamp: t, open: 100, high: 100, low: i === 10 ? 90 : 100, close: 100, volume: 1 };
    });
    const ext = {
      mtf: { timeframe: "HOUR", htfStarts: Array.from({ length: 10 }, (_, i) => T0 + i * H1), htfMs: H1, waitClose: false },
    };
    const result = [{ lineIdx: 8 }];
    const a = lineAlert("s1");
    a.params = { ...a.params, slope: 1, anchors: { t1: T0 + 2 * H1, p1: 90, t2: T0 + 6 * H1, p2: 94 } };
    alerts.splice(0, alerts.length);
    lineAlerts.splice(0, lineAlerts.length, a);
    const created: Array<Record<string, unknown>> = [];
    const chart = {
      createOverlay: (o: Record<string, unknown>) => { created.push(o); return o.id as string; },
      removeOverlay: vi.fn(),
      overrideOverlay: vi.fn(),
      getDataList: () => bars,
      getIndicators: () => [{ name: "TRENDLINES", paneId: "candle_pane", extendData: ext, result }],
    };
    const lines = new IndicatorAlertLines();
    lines.attach(chart as never, "s1", "b", "US100", "MINUTE_15");
    lines.reconcile();
    expect(created[0]).toMatchObject({
      points: [{ timestamp: bars[10].timestamp, value: 90 }, { timestamp: bars[39].timestamp, value: 97.75 }],
    });
    lines.refreshRays();
    expect(chart.overrideOverlay).not.toHaveBeenCalled();
    bars.push({ timestamp: T0 + 40 * M15, open: 100, high: 100, low: 100, close: 100, volume: 1 });
    lines.refreshRays();
    expect(chart.overrideOverlay).toHaveBeenCalledWith({
      id: "lnalert:al-l",
      points: [{ timestamp: bars[10].timestamp, value: 90 }, { timestamp: bars[40].timestamp, value: 98 }],
    });
  });
});
