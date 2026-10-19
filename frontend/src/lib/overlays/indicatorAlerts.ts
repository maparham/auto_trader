// Value-target indicator alerts drawn as dashed alert lines in their
// indicator's own pane (e.g. 70 in the RSI pane). Only the cell the alert is
// linked to, and only while it shows the alert's broker, epic and timeframe
// (a pinned line's alert is on its pin's timeframe, so any chart shows it).
// One instance per ChartController; ChartCore re-attaches it on every
// epic/resolution/broker bind and reconciles it on the alerts signal and on
// indicator add/remove (the pane the line lives in can come and go).
// Also the frozen-trendline (`line`) alerts, drawn as a dashed ray through
// their anchors on the candle pane of the linked cell, while its Trendlines
// pane alerts on the alert's timeframe. Under a coarser pin the ray follows
// the trendline's own stroke instead (pinnedAlertStroke).
import type { Chart, KLineData } from "klinecharts";
import { alertTimeframeOf } from "../indicatorAlertInstance";
import { loadIndicatorAlerts, loadLineAlerts, patchIndicatorAlert } from "../alertsApi";
import { getIndicatorsByPane } from "../indicators";
import { isInsetInstance } from "../indicators/inset";
import { pinnedAlertStroke, type TrendlinesMtf } from "../indicators/trendlines";
import { alertLineStyles, createAlertLine } from "./alertLine";

const ovId = (alertId: string) => `indalert:${alertId}`;
const rayId = (alertId: string) => `lnalert:${alertId}`;

type Drawn = { paneId: string; value: number };
type RayPoints = [{ timestamp: number; value: number }, { timestamp: number; value: number }];
type Ray = { points: RayPoints; key: string };

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
  // here and alerts on the alert's timeframe (a pinned pane, its pin), with
  // the two points the ray runs through.
  private wantedRays(): Map<string, Ray> {
    const out = new Map<string, Ray>();
    if (!this.chart) return out;
    const alerts = loadLineAlerts(this.epic, this.broker);
    if (alerts.length === 0) return out;
    const panes = getIndicatorsByPane(this.chart);
    let dataList: KLineData[] | null = null;
    for (const a of alerts) {
      const link = a.params.link;
      if (!link || link.scope !== this.scope) continue;
      for (const [, inds] of panes) {
        const ind = inds.get(link.instanceId);
        if (!ind) continue;
        const ext = ind.extendData as { mtf?: TrendlinesMtf } | undefined;
        if (alertTimeframeOf(ext as Record<string, unknown> | undefined, this.resolution) !== a.params.timeframe) break;
        const { t1, p1, t2, p2 } = a.params.anchors;
        // Under a coarser pin, the points the trendline's own stroke runs
        // through, so the ray lies on it; otherwise the anchors themselves.
        let points: RayPoints = [
          { timestamp: t1, value: p1 },
          { timestamp: t2, value: p2 },
        ];
        if (ext?.mtf?.timeframe && a.params.timeframe !== this.resolution) {
          dataList ??= this.chart.getDataList();
          const res = ind.result as Array<{ lineIdx?: number }> | undefined;
          const lastIdx = res?.[res.length - 1]?.lineIdx ?? -1;
          points = pinnedAlertStroke(dataList, ext.mtf, lastIdx, { t1, p1, slope: a.params.slope }) ?? points;
        }
        out.set(a.id, { points, key: points.map((q) => `${q.timestamp}:${q.value}`).join("|") });
        break;
      }
    }
    return out;
  }

  private reconcileRays(c: Chart, hidden: boolean, hiddenChanged: boolean): void {
    const want = this.wantedRays();
    for (const [id, geo] of this.rays) {
      const w = want.get(id);
      if (!w) {
        c.removeOverlay({ id: rayId(id) });
        this.rays.delete(id);
        continue;
      }
      if (w.key !== geo) {
        c.overrideOverlay({ id: rayId(id), points: w.points });
        this.rays.set(id, w.key);
      }
      if (hiddenChanged) c.overrideOverlay({ id: rayId(id), visible: !hidden });
    }
    for (const [id, w] of want) {
      if (this.rays.has(id)) continue;
      const made = c.createOverlay({
        id: rayId(id),
        name: "rayLine",
        points: w.points,
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
      if (typeof made === "string") this.rays.set(id, w.key);
    }
  }

  /** Re-place the rays only. The pinned stroke they follow moves with new
   * bars, loaded history and the pin's stash, none of which reconcile hears,
   * so the paint loop calls this; an unchanged ray costs a string compare. */
  refreshRays(): void {
    const c = this.chart;
    if (!c || this.rays.size === 0) return;
    this.reconcileRays(c, this.hidden(), false);
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
