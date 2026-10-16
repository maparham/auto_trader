// Value-target indicator alerts drawn as dashed alert lines in their
// indicator's own pane (e.g. 70 in the RSI pane). Only the cell the alert is
// linked to, and only while it shows the alert's broker, epic and timeframe
// (a pinned line's alert is on its pin's timeframe, so any chart shows it).
// One instance per ChartController; ChartCore re-attaches it on every
// epic/resolution/broker bind and reconciles it on the alerts signal and on
// indicator add/remove (the pane the line lives in can come and go).
// Also the frozen-trendline (`line`) alerts, drawn as a dashed ray through
// their anchors on the candle pane of the linked cell, while its Trendlines
// pane alerts on the alert's timeframe.
import type { Chart } from "klinecharts";
import { alertTimeframeOf } from "../indicatorAlertInstance";
import { loadIndicatorAlerts, loadLineAlerts, patchIndicatorAlert, type LineAlert } from "../alertsApi";
import { getIndicatorsByPane } from "../indicators";
import { isInsetInstance } from "../indicators/inset";
import { alertLineStyles, createAlertLine } from "./alertLine";

const ovId = (alertId: string) => `indalert:${alertId}`;
const rayId = (alertId: string) => `lnalert:${alertId}`;

type Drawn = { paneId: string; value: number };

export class IndicatorAlertLines {
  private chart: Chart | null = null;
  private scope = "";
  private broker = "";
  private epic = "";
  private resolution = "";
  private drawn = new Map<string, Drawn>();
  private rays = new Map<string, string>(); // alertId -> geometry key
  // The visibility the drawn lines currently carry (the sidebar eye).
  private shownHidden = false;

  // `hidden` reads the cell's "Hide alert lines" eye (OverlayManager).
  private readonly hidden: () => boolean;
  constructor(hidden: () => boolean = () => false) {
    this.hidden = hidden;
  }

  attach(chart: Chart, scope: string, broker: string, epic: string, resolution: string): void {
    // A different chart instance (cell remount) owns none of our overlays:
    // forget them rather than removing ids from a chart that never had them.
    if (chart !== this.chart) {
      this.drawn.clear();
      this.rays.clear();
    }
    this.chart = chart;
    this.scope = scope;
    this.broker = broker;
    this.epic = epic;
    this.resolution = resolution;
  }

  // The pane to draw in, or null. `timeframe` must be the one this instance
  // alerts on here: the chart's, or its pin's (alertTimeframeOf).
  private paneOf(instanceId: string, timeframe: string): string | null {
    if (!this.chart) return null;
    for (const [paneId, inds] of getIndicatorsByPane(this.chart)) {
      const ind = inds.get(instanceId);
      if (!ind) continue;
      if (alertTimeframeOf(ind.extendData as Record<string, unknown> | undefined, this.resolution) !== timeframe)
        return null;
      // An inset instance sits on candle_pane with its own value scale inside
      // the inset band; candle_pane's y-axis is PRICE, so a line there would
      // draw RSI 70 as a price level. No line until inset-band geometry exists.
      return isInsetInstance(ind) ? null : paneId;
    }
    return null;
  }

  private wanted(): Map<string, Drawn> {
    const out = new Map<string, Drawn>();
    for (const a of loadIndicatorAlerts(this.epic, this.broker)) {
      const p = a.params;
      if (p.target !== "value" || p.value == null || !p.link) continue;
      if (p.link.scope !== this.scope) continue;
      const paneId = this.paneOf(p.link.instanceId, p.timeframe);
      if (paneId) out.set(a.id, { paneId, value: p.value });
    }
    return out;
  }

  reconcile(): void {
    const c = this.chart;
    if (!c) return;
    const want = this.wanted();
    const hidden = this.hidden();
    const hiddenChanged = hidden !== this.shownHidden;
    if (hiddenChanged) {
      for (const id of this.drawn.keys()) c.overrideOverlay({ id: ovId(id), visible: !hidden });
      this.shownHidden = hidden;
    }
    for (const [id, cur] of this.drawn) {
      const w = want.get(id);
      if (!w || w.paneId !== cur.paneId) {
        c.removeOverlay({ id: ovId(id) });
        this.drawn.delete(id);
      }
    }
    for (const [id, w] of want) {
      const cur = this.drawn.get(id);
      if (!cur) {
        if (createAlertLine(c, { id: ovId(id), paneId: w.paneId, value: w.value, visible: !hidden }) == null) continue;
      } else if (cur.value !== w.value) {
        c.overrideOverlay({ id: ovId(id), points: [{ value: w.value }] });
      }
      this.drawn.set(id, w);
    }
    this.reconcileRays(c, hidden, hiddenChanged);
  }

  // Line alerts to draw: linked to this cell, whose Trendlines instance is
  // here and alerts on the alert's timeframe (a pinned pane, its pin).
  private wantedRays(): Map<string, LineAlert> {
    const out = new Map<string, LineAlert>();
    if (!this.chart) return out;
    const alerts = loadLineAlerts(this.epic, this.broker);
    if (alerts.length === 0) return out;
    const panes = getIndicatorsByPane(this.chart);
    for (const a of alerts) {
      const link = a.params.link;
      if (!link || link.scope !== this.scope) continue;
      for (const [, inds] of panes) {
        const ind = inds.get(link.instanceId);
        if (!ind) continue;
        const ext = ind.extendData as Record<string, unknown> | undefined;
        if (alertTimeframeOf(ext, this.resolution) === a.params.timeframe) out.set(a.id, a);
        break;
      }
    }
    return out;
  }

  private reconcileRays(c: Chart, hidden: boolean, hiddenChanged: boolean): void {
    const want = this.wantedRays();
    for (const [id, geo] of this.rays) {
      const a = want.get(id)?.params.anchors;
      if (!a || `${a.t1}:${a.p1}:${a.t2}:${a.p2}` !== geo) {
        c.removeOverlay({ id: rayId(id) });
        this.rays.delete(id);
      } else if (hiddenChanged) {
        c.overrideOverlay({ id: rayId(id), visible: !hidden });
      }
    }
    for (const [id, a] of want) {
      if (this.rays.has(id)) continue;
      const { t1, p1, t2, p2 } = a.params.anchors;
      const made = c.createOverlay({
        id: rayId(id),
        name: "rayLine",
        points: [
          { timestamp: t1, value: p1 },
          { timestamp: t2, value: p2 },
        ],
        styles: alertLineStyles(false),
        visible: !hidden,
        mode: "normal",
        needDefaultXAxisFigure: false,
        needDefaultYAxisFigure: false,
        // Locked and app-owned: the geometry is frozen with the alert.
        lock: true,
        // v10 deletes an overlay on right-click unless the handler prevents it.
        onRightClick: (e: { preventDefault?: () => void }) => {
          e.preventDefault?.();
          return true;
        },
      } as never);
      if (typeof made === "string") this.rays.set(id, `${t1}:${p1}:${t2}:${p2}`);
    }
  }

  lines(): Array<{ alertId: string; paneId: string; value: number }> {
    return [...this.drawn].map(([alertId, w]) => ({ alertId, ...w }));
  }

  preview(alertId: string, value: number): void {
    const cur = this.drawn.get(alertId);
    if (!cur || !this.chart) return;
    this.chart.overrideOverlay({ id: ovId(alertId), points: [{ value }] });
    this.drawn.set(alertId, { ...cur, value });
  }

  commit(alertId: string, value: number): void {
    // Significant digits, not fixed decimals: an ATR level on FX (0.00052)
    // would collapse under toFixed(4).
    const v = Number(value.toPrecision(6));
    this.preview(alertId, v);
    void patchIndicatorAlert(alertId, { params: { value: v } });
  }
}
