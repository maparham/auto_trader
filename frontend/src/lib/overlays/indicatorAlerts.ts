// Value-target indicator alerts drawn as dashed alert lines in their
// indicator's own pane (e.g. 70 in the RSI pane). Only the cell the alert is
// linked to, and only while it shows the alert's broker, epic and timeframe
// (a pinned line's alert is on its pin's timeframe, so any chart shows it).
// One instance per ChartController; ChartCore re-attaches it on every
// epic/resolution/broker bind and reconciles it on the alerts signal and on
// indicator add/remove (the pane the line lives in can come and go).
// Also the frozen-trendline (`line`) alerts: a dashed line through their
// anchors on the candle pane of the linked cell, while its Trendlines pane
// alerts on the alert's timeframe. Under a coarser pin it follows the
// trendline's own stroke instead (pinnedAlertStroke). The line runs from its
// first anchor to the chart's last bar and stops there, so it lies on the
// trendline while that is drawn and still shows what the alert watches once
// the trendline is gone; the bell past its end (useChartPaint/
// TrendlineAlertBells) marks it.
import type { Chart, KLineData } from "klinecharts";
import { alertTimeframeOf } from "../indicatorAlertInstance";
import { loadIndicatorAlerts, loadLineAlerts, patchIndicatorAlert, type LineAlertParams } from "../alertsApi";
import { getIndicatorsByPane } from "../indicators";
import { isInsetInstance } from "../indicators/inset";
import { pinnedAlertStroke, type TrendlinesMtf } from "../indicators/trendlines";
import { alertLineStyles, createAlertLine } from "./alertLine";

const ovId = (alertId: string) => `indalert:${alertId}`;
const rayId = (alertId: string) => `lnalert:${alertId}`;

type Drawn = { paneId: string; value: number };
type RayPoints = [{ timestamp: number; value: number }, { timestamp: number; value: number }];
// `points` defines the line (the bell extrapolates through them); `drawn` is
// the segment actually drawn, from the first point to the last bar.
type Ray = { points: RayPoints; drawn: RayPoints; key: string };

/**
 * Two points on a line alert's line, both at bars the chart has loaded.
 * `times` are bar open times of the alert's timeframe (the chart's own bars,
 * or a coarser pin's HTF starts); the slope is per bar of them. Anchored on
 * whichever of the reference bar, anchor2, anchor1 is in `times`, counted in
 * those bars, so a first anchor older than the loaded history is not
 * extrapolated by the chart (which spaces unloaded bars in calendar time,
 * weekends included, and tilts the line). Null when no reference is in
 * `times` or fewer than two of its bars are loaded.
 * Exported for the unit test.
 */
export function loadedLinePoints(
  p: Pick<LineAlertParams, "tRef" | "pRef" | "slope" | "anchors">,
  times: readonly number[],
  dataList: readonly KLineData[],
): RayPoints | null {
  const first = dataList[0]?.timestamp;
  const lastT = dataList[dataList.length - 1]?.timestamp;
  if (first == null || lastT == null) return null;
  let jRef = -1;
  let pAt = 0;
  for (const [t, price] of [
    [p.tRef, p.pRef],
    [p.anchors.t2, p.anchors.p2],
    [p.anchors.t1, p.anchors.p1],
  ]) {
    jRef = times.lastIndexOf(t);
    if (jRef >= 0) {
      pAt = price;
      break;
    }
  }
  if (jRef < 0) return null;
  // From anchor1 when it is loaded (the line starts there), else the first
  // loaded bar; to the last loaded bar of `times`.
  let a = 0;
  while (a < times.length && times[a] < first) a++;
  const j1 = times.lastIndexOf(p.anchors.t1);
  if (j1 > a) a = j1;
  let b = times.length - 1;
  while (b >= 0 && times[b] > lastT) b--;
  if (b <= a) return null;
  const at = (j: number) => ({ timestamp: times[j], value: pAt + p.slope * (j - jRef) });
  return [at(a), at(b)];
}

export class IndicatorAlertLines {
  private chart: Chart | null = null;
  private scope = "";
  private broker = "";
  private epic = "";
  private resolution = "";
  private drawn = new Map<string, Drawn>();
  private rays = new Map<string, string>(); // alertId -> geometry key
  // The most recently computed ray geometry per alert id, for rayPoints(): the
  // bell past the line's end reads this rather than the live-detected
  // TrendLine list, which can re-extend its second touch as new bars arrive
  // and would otherwise lose a match the alert itself never moved off.
  private lastPoints = new Map<string, RayPoints>();
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
      this.lastPoints.clear();
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
        dataList ??= this.chart.getDataList();
        const pinned = !!ext?.mtf?.timeframe && a.params.timeframe !== this.resolution;
        // Under a coarser pin, the points the trendline's own stroke runs
        // through, so the ray lies on it. Otherwise (or when that stroke is
        // not on the chart) two points on the alert's own line that are
        // inside the loaded bars; the anchors themselves only as a last resort.
        let points: RayPoints | null = null;
        if (pinned && ext?.mtf) {
          const res = ind.result as Array<{ lineIdx?: number }> | undefined;
          const lastIdx = res?.[res.length - 1]?.lineIdx ?? -1;
          points = pinnedAlertStroke(dataList, ext.mtf, lastIdx, { t1, p1, slope: a.params.slope });
        }
        points ??= loadedLinePoints(a.params, pinned ? ext?.mtf?.htfStarts ?? [] : this.barTimes(dataList), dataList);
        points ??= [
          { timestamp: t1, value: p1 },
          { timestamp: t2, value: p2 },
        ];
        const drawn = this.toLastBar(points, dataList);
        if (drawn) out.set(a.id, { points, drawn, key: drawn.map((q) => `${q.timestamp}:${q.value}`).join("|") });
        break;
      }
    }
    return out;
  }

  // The line through `points`, cut at the last bar: interpolated in pixel
  // space, the same way the bell extrapolates, so both sit on one line under
  // either axis scale. The end value is rounded so a pan or zoom re-deriving
  // it does not churn the overlay.
  private toLastBar(points: RayPoints, dataList: KLineData[]): RayPoints | null {
    const c = this.chart;
    const last = dataList[dataList.length - 1];
    if (!c || !last) return null;
    if (last.timestamp <= points[0].timestamp) return null;
    const filter = { paneId: "candle_pane", absolute: true };
    const px = c.convertToPixel(
      [points[0], points[1], { timestamp: last.timestamp, value: points[1].value }],
      filter,
    ) as Array<{ x?: number; y?: number }>;
    const [q0, q1, end] = px;
    if (q0?.x == null || q0.y == null || q1?.x == null || q1.y == null || end?.x == null || q1.x === q0.x) return null;
    const y = q0.y + ((q1.y - q0.y) * (end.x - q0.x)) / (q1.x - q0.x);
    const pt = c.convertFromPixel([{ x: end.x, y }], filter) as Array<{ value?: number }>;
    const value = pt[0]?.value;
    if (value == null || !Number.isFinite(value)) return null;
    return [points[0], { timestamp: last.timestamp, value: Number(value.toPrecision(8)) }];
  }

  // The chart's bar open times, rebuilt only when the data list changes:
  // refreshRays runs every paint, and the list can be thousands of bars.
  private timesCache: { list: KLineData[]; n: number; last: number; times: number[] } | null = null;
  private barTimes(list: KLineData[]): number[] {
    const n = list.length;
    const last = list[n - 1]?.timestamp ?? NaN;
    const c = this.timesCache;
    if (c && c.list === list && c.n === n && c.last === last) return c.times;
    const times = list.map((d) => d.timestamp);
    this.timesCache = { list, n, last, times };
    return times;
  }

  private reconcileRays(c: Chart, hidden: boolean, hiddenChanged: boolean): void {
    const want = this.wantedRays();
    this.lastPoints = new Map([...want].map(([id, w]) => [id, w.points]));
    for (const [id, geo] of this.rays) {
      const w = want.get(id);
      if (!w) {
        c.removeOverlay({ id: rayId(id) });
        this.rays.delete(id);
        continue;
      }
      if (w.key !== geo) {
        c.overrideOverlay({ id: rayId(id), points: w.drawn });
        this.rays.set(id, w.key);
      }
      if (hiddenChanged) c.overrideOverlay({ id: rayId(id), visible: !hidden });
    }
    for (const [id, w] of want) {
      if (this.rays.has(id)) continue;
      const made = c.createOverlay({
        id: rayId(id),
        name: "segment",
        points: w.drawn,
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

  /** Re-place the rays only. Their end follows the last bar, and the pinned
   * stroke they follow moves with new bars, loaded history and the pin's
   * stash, none of which reconcile hears, so the paint loop calls this; an
   * unchanged ray costs a string compare. Also creates a ray reconcile could
   * not place before the chart had bars. */
  refreshRays(): void {
    const c = this.chart;
    if (!c) return;
    this.reconcileRays(c, this.hidden(), false);
  }

  /** The two points the alert's ray runs through (frozen anchors, or the
   * pinned stroke under a coarser pin), for extrapolating its bell past the
   * last bar; independent of the live TRENDLINES detection moving on. */
  rayPoints(alertId: string): RayPoints | null {
    return this.lastPoints.get(alertId) ?? null;
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
