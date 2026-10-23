// Dashed clones of picked trendlines. A clone stays while any live rule holder
// (the backtest config, an armed live snapshot, the open screener draft) keeps
// that line, the way a line alert's dashed line outlives its trendline. One
// clone per geometry, labelled with every id that holds it. Saved screens that
// are not open in the screener draw nothing.
//
// Drawn only on a chart showing the line's own timeframe: the slope is per bar
// of that timeframe, so another chart's bars would tilt it. The clone runs from
// its first anchor to the chart's last bar, like a line alert's ray.
//
// reconcile() re-reads the holders (on pickedLinesChanged and on every bind);
// refresh() runs every paint and only re-places the held lines against the
// current bars, touching an overlay only when its points or label changed.
import type { Chart, KLineData, OverlayFigure, OverlayTemplate } from "klinecharts";
import { registerOverlay } from "klinecharts";
import { lineGeoKey, type Lines, type PickedLine } from "../pickedLines";
import { loadBacktestLastUsed } from "../persist/defaults";
import { loadArmed, loadArmedAccount } from "../liveEngine";
import { getScreenerDraft } from "../screenerDraft";
import { clipSegmentToRect, DRAW_CLIP_PAD } from "../indicators/shared";
import { loadedLinePoints, toLastBar, type RayPoints } from "./indicatorAlerts";

const LABEL_SEP = " · ";

/** The clones a chart on (epic, broker) should draw, keyed by lineGeoKey: one
 *  per geometry, its label every id that holds it in holder order. */
export function wantedClones(
  epic: string,
  broker: string,
  sources: Array<{ lines?: Lines }>,
): Map<string, { line: PickedLine; label: string }> {
  const out = new Map<string, { line: PickedLine; label: string }>();
  for (const s of sources) {
    for (const [id, l] of Object.entries(s.lines ?? {})) {
      if (l.epic !== epic || (l.broker && broker && l.broker !== broker)) continue;
      const k = lineGeoKey(l);
      const cur = out.get(k);
      if (!cur) out.set(k, { line: l, label: id });
      else if (!cur.label.split(LABEL_SEP).includes(id)) cur.label = `${cur.label}${LABEL_SEP}${id}`;
    }
  }
  return out;
}

// Muted next to the amber alert line: neutral gray, a shorter dash.
const CLONE_COLOR = "rgba(128, 128, 128, 0.7)";
const CLONE_DASH = [2, 4];
const LABEL_GAP = 4;

/** The clone's own template: the dashed segment, clipped so a line running far
 *  off the pane never reaches the rasterizer (dash generation walks the full
 *  length), plus its label just right of the end while that end is on the pane.
 *  Never throws: a throw in a klinecharts draw callback kills later layouts. */
export const pickedLineCloneTemplate: OverlayTemplate = {
  name: "pickedLineClone",
  totalStep: 3,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: (params) => {
    try {
      const { overlay, coordinates, bounding } = params;
      if (!coordinates || coordinates.length < 2) return [];
      const [a, b] = coordinates;
      const seg = clipSegmentToRect(
        a.x, a.y, b.x, b.y,
        -DRAW_CLIP_PAD, -DRAW_CLIP_PAD,
        bounding.width + DRAW_CLIP_PAD, bounding.height + DRAW_CLIP_PAD,
      );
      if (!seg) return [];
      const figures: OverlayFigure[] = [
        {
          type: "line",
          attrs: { coordinates: [{ x: seg[0], y: seg[1] }, { x: seg[2], y: seg[3] }] },
          styles: { color: CLONE_COLOR, size: 1, style: "dashed", dashedValue: CLONE_DASH },
          ignoreEvent: true,
        },
      ];
      const label = typeof overlay.extendData === "string" ? overlay.extendData : "";
      const end = a.x > b.x ? a : b;
      if (label && end.x >= 0 && end.x <= bounding.width && end.y >= 0 && end.y <= bounding.height) {
        figures.push({
          type: "text",
          attrs: { x: end.x + LABEL_GAP, y: end.y, text: label, align: "left", baseline: "middle" },
          styles: {
            color: CLONE_COLOR,
            size: 11,
            family: "-apple-system, system-ui, sans-serif",
            backgroundColor: "transparent",
            borderColor: "transparent",
            borderSize: 0,
            paddingLeft: 0,
            paddingRight: 0,
            paddingTop: 0,
            paddingBottom: 0,
          },
          ignoreEvent: true,
        });
      }
      return figures;
    } catch {
      return [];
    }
  },
};
// Module-scope, like alertPriceLine: every boot mode that imports the
// controller can draw clones.
registerOverlay(pickedLineCloneTemplate);

const ovId = (k: string) => `pickline:${k}`;

export class PickedLineClones {
  private chart: Chart | null = null;
  private broker = "";
  private epic = "";
  private resolution = "";
  // The holders' lines as last read by reconcile(); refresh() places these.
  private want = new Map<string, { line: PickedLine; label: string }>();
  private drawn = new Map<string, string>(); // geoKey -> points|label signature
  private timesCache: { list: KLineData[]; n: number; last: number; times: number[] } | null = null;

  attach(chart: Chart, broker: string, epic: string, resolution: string): void {
    if (chart !== this.chart) {
      // A remounted chart owns none of our overlays.
      this.drawn.clear();
      this.timesCache = null;
    } else if (epic !== this.epic || broker !== this.broker || resolution !== this.resolution) {
      for (const k of this.drawn.keys()) chart.removeOverlay({ id: ovId(k) });
      this.drawn.clear();
    }
    this.chart = chart;
    this.broker = broker;
    this.epic = epic;
    this.resolution = resolution;
  }

  private sources(): Array<{ lines?: Lines }> {
    const account = loadArmedAccount(this.epic);
    return [
      { lines: loadBacktestLastUsed()?.lines },
      { lines: account ? loadArmed(this.epic, account)?.cfg.lines : undefined },
      { lines: getScreenerDraft(this.broker).lines },
    ];
  }

  /** Re-read the holders, then place. */
  reconcile(): void {
    if (!this.chart) return;
    try {
      const all = wantedClones(this.epic, this.broker, this.sources());
      for (const [k, w] of all) if (w.line.timeframe !== this.resolution) all.delete(k);
      this.want = all;
    } catch {
      this.want = new Map();
    }
    this.refresh();
  }

  /** Re-place the held lines against the current bars. Runs every paint; an
   *  unchanged clone costs one signature compare. */
  refresh(): void {
    const c = this.chart;
    if (!c) return;
    try {
      for (const k of [...this.drawn.keys()]) {
        if (!this.want.has(k)) {
          c.removeOverlay({ id: ovId(k) });
          this.drawn.delete(k);
        }
      }
      if (this.want.size === 0) return;
      const dataList = c.getDataList() as KLineData[];
      const times = this.barTimes(dataList);
      for (const [k, w] of this.want) {
        const l = w.line;
        const raw: RayPoints =
          loadedLinePoints(
            { tRef: l.tRef, pRef: l.pRef, slope: l.slope, anchors: { t1: l.t1, p1: l.p1, t2: l.t2, p2: l.p2 } },
            times,
            dataList,
          ) ?? [
            { timestamp: l.t1, value: l.p1 },
            { timestamp: l.t2, value: l.p2 },
          ];
        const points = toLastBar(c, raw, dataList);
        if (!points) continue;
        const sig = `${points.map((q) => `${q.timestamp}:${q.value}`).join("|")}|${w.label}`;
        const prev = this.drawn.get(k);
        if (prev === sig) continue;
        if (prev != null) {
          c.overrideOverlay({ id: ovId(k), points, extendData: w.label } as never);
          this.drawn.set(k, sig);
          continue;
        }
        const made = c.createOverlay({
          id: ovId(k),
          name: pickedLineCloneTemplate.name,
          points,
          extendData: w.label,
          mode: "normal",
          needDefaultXAxisFigure: false,
          needDefaultYAxisFigure: false,
          // Locked and app-owned: the geometry is frozen in its holders.
          lock: true,
          // v10 deletes an overlay on right-click unless the handler prevents it.
          onRightClick: (e: { preventDefault?: () => void }) => {
            e.preventDefault?.();
            return true;
          },
        } as never);
        if (typeof made === "string") this.drawn.set(k, sig);
      }
    } catch {
      // Runs inside the paint loop: never let a bad line break the chart.
    }
  }

  // The chart's bar open times, rebuilt only when the data list changes.
  private barTimes(list: KLineData[]): number[] {
    const n = list.length;
    const last = list[n - 1]?.timestamp ?? NaN;
    const c = this.timesCache;
    if (c && c.list === list && c.n === n && c.last === last) return c.times;
    const times = list.map((d) => d.timestamp);
    this.timesCache = { list, n, last, times };
    return times;
  }
}
