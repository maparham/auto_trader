// Spike: a causal spike -> flat consolidation -> retrace state machine, drawn
// as two price-pane step-lines (the spike's high and base low) while a pattern
// is live. Built for the long-only "vertical spike, flat consolidation, buy
// the ~30% retrace" setup: the pane's rule operands carry the state a
// stateless expression cannot (see spikeOutputs.ts for the operand names).
//
// Ported operation-for-operation to backend indicators/spike.py — keep the
// arithmetic order identical, per the parity contract in indicators/core.py.
// Chart-timeframe only (no MTF pin).
//
// Per bar, in IDLE state a spike arms when the current high is at least
// minSpikePct percent above the NEAREST base in the trailing spikeBars window
// (window includes the current bar): walking back, the running low absorbs
// bars whose lows stay within the flat band's tolerance of it (the basing
// region) and stops at the first bar that pulled away above it — so a stale
// deep low beyond a real pullback never anchors the pattern. That base
// becomes spikeLow and the bar's high spikeHigh. While armed:
//
//   - low below spikeLow invalidates the pattern (reset to IDLE, then the same
//     bar may re-arm through the normal IDLE check);
//   - a new high above spikeHigh extends the spike ONLY if it re-passes the
//     arm condition against its own trailing window (the move is still steep):
//     spikeHigh steps up, barsSinceSpike and the consolidation clock restart,
//     consolOk unlatches. A non-steep new high ends the pattern instead — a
//     grind must not inflate a spike;
//   - before consolOk: a bar whose low holds the flat band
//     [spikeHigh - maxFlatRangePct% of spike height, spikeHigh] counts toward
//     consolidation; flatBars such bars in a row latch consolOk to 1. A dip
//     below the band first voids the pattern (reset, same-bar re-arm allowed);
//   - after consolOk (latched): dips below the flat band are the tradeable
//     retrace (maxRetracePct output tracks the deepest low since the latch),
//     down to the maxRetracePct hard floor — a low below THAT invalidates,
//     because a retrace so deep no longer reads as a high-probability
//     continuation. Entry rules must use retrace bounds inside maxRetracePct;
//   - barsSinceSpike reaching maxPatternBars expires the pattern back to IDLE
//     (same-bar re-arm allowed), so a stale armed pattern cannot absorb a
//     later genuine spike as a mere extension.
import {
  type Indicator,
  type IndicatorDrawParams,
  type IndicatorTemplate,
  type KLineData,
  type SmoothLineStyle,
} from "klinecharts";
import { fullLine } from "./shared";
import { parseSpikeConfig, type SpikeConfig } from "./spikeOutputs";

// Settings-modal toggles.
export interface SpikeExtend {
  // Hide this indicator's value from the legend.
  hideLegendValue?: boolean;
  // Stage labels on the boxes: "spike", "consolidating", "latched" and the
  // end reason ("expired" / "broke base" / "not steep" / "dipped early").
  // Default ON; absent means shown.
  showStageLabels?: boolean;
}

export interface SpikePoint {
  spikeHigh?: number;
  spikeLow?: number;
  barsSinceSpike?: number;
  consolOk?: number;
  retracePct?: number;
  maxRetracePct?: number;
}

// Only the two price-scaled outputs draw; the state/percent outputs are rule
// operands (and legend values) with no line of their own — the PIVOT_BANDS
// barsSince* convention.
const SPIKE_FIGURES = [
  { key: "spikeHigh", title: "Spike High: ", type: "line" },
  { key: "spikeLow", title: "Spike Low: ", type: "line" },
];

const SPIKE_DEFAULT_LINE_STYLES: SmoothLineStyle[] = [
  fullLine("#EF5350", "solid"), // spikeHigh
  fullLine("#26A69A", "solid"), // spikeLow
];

export function computeSpike(dataList: KLineData[], cfg: SpikeConfig): SpikePoint[] {
  const len = dataList.length;
  const highs = dataList.map((d) => d.high);
  const lows = dataList.map((d) => d.low);

  let armed = false;
  let spikeHigh = 0;
  let spikeLow = 0;
  let spikeBar = 0;
  let consolCount = 0;
  let consolOk = false;
  let maxRetrace = 0;

  const out: SpikePoint[] = new Array(len);
  for (let i = 0; i < len; i++) {
    if (armed && i - spikeBar >= cfg.maxPatternBars) {
      armed = false; // expired: too old to trade, free the machine to re-arm
    }
    if (armed) {
      const height = spikeHigh - spikeLow;
      const flatFloor = spikeHigh - (cfg.maxFlatRangePct / 100) * height;
      if (lows[i] < spikeLow) {
        armed = false; // invalidated: fell through the spike base
      } else if (highs[i] > spikeHigh) {
        // A new high extends the spike ONLY if the move is still steep: the
        // arm condition re-checked against the bar's own trailing window.
        // Without this, a pattern that armed on a marginal rise inflates
        // through a slow grind — each small new high stepping spikeHigh up —
        // until a staircase rally reads as one big "spike" that was never
        // vertical at any point.
        let base = Infinity;
        for (let j = Math.max(0, i - cfg.spikeBars + 1); j <= i; j++) {
          if (lows[j] < base) base = lows[j];
        }
        if (base > 0 && ((highs[i] - base) / base) * 100 >= cfg.minSpikePct) {
          // Steep extension: new anchor high, consolidation restarts.
          spikeHigh = highs[i];
          spikeBar = i;
          consolCount = 0;
          consolOk = false;
          maxRetrace = 0;
        } else {
          // Grind, not a spike leg: the pattern ends here. The IDLE re-arm
          // below re-runs the SAME check and fails the same way, so the bar
          // goes idle rather than instantly re-arming.
          armed = false;
        }
      } else if (!consolOk) {
        if (lows[i] >= flatFloor) {
          consolCount += 1;
          if (consolCount >= cfg.flatBars) consolOk = true;
        } else {
          armed = false; // dipped before consolidating: not this pattern
        }
      } else if (lows[i] < spikeHigh - (cfg.maxRetracePct / 100) * height) {
        // Post-latch hard floor: a retrace below maxRetracePct went too deep
        // for a high-probability continuation.
        armed = false;
      } else {
        maxRetrace = Math.max(maxRetrace, ((spikeHigh - lows[i]) / height) * 100);
      }
    }

    if (!armed) {
      // IDLE (possibly just reset this bar): arm on a sufficient rise from the
      // NEAREST base, not the deepest low the window happens to hold. Walk
      // back accumulating the running low, stopping at the first bar whose
      // low pulled away above the flat band's tolerance of it — a stale deep
      // low beyond a real pullback-up never anchors spikeLow. The base is the
      // swing low a fib drawn over the leg would use, which is what
      // retracePct and the break-invalidation are measured against; a leg
      // whose nearest base misses the rise threshold simply arms later (or
      // not at all), never deeper.
      let runMin = lows[i];
      for (let j = i - 1; j >= Math.max(0, i - cfg.spikeBars + 1); j--) {
        if (lows[j] > runMin + (cfg.maxFlatRangePct / 100) * (highs[i] - runMin)) {
          break; // pulled away from the base: older lows are a different structure
        }
        if (lows[j] < runMin) runMin = lows[j];
      }
      if (runMin > 0 && ((highs[i] - runMin) / runMin) * 100 >= cfg.minSpikePct) {
        armed = true;
        spikeHigh = highs[i];
        spikeLow = runMin;
        spikeBar = i;
        consolCount = 0;
        consolOk = false;
        maxRetrace = 0;
      }
    }

    if (!armed) {
      out[i] = {};
      continue;
    }
    const height = spikeHigh - spikeLow;
    const retrace = height > 0 ? ((spikeHigh - lows[i]) / height) * 100 : 0;
    out[i] = {
      spikeHigh,
      spikeLow,
      barsSinceSpike: i - spikeBar,
      consolOk: consolOk ? 1 : 0,
      retracePct: Math.max(0, retrace),
      maxRetracePct: maxRetrace,
    };
  }
  return out;
}

/** A maximal run of bars sharing one pattern state: same anchors, same phase.
 * The draw callback paints one box per segment — amber while consolidating,
 * green once consolOk latched — so extensions and the latch read as visible
 * seams in the pattern's life. */
export interface SpikeSegment {
  from: number; // inclusive bar indexes
  to: number;
  spikeHigh: number;
  spikeLow: number;
  latched: boolean;
  /** Episode-first segments only, when bar lows are supplied: the bar carrying
   * the base low, so the box starts at the swing low and covers the spike leg
   * itself, not just the pattern's armed life. */
  legFrom?: number;
}

export function spikeSegments(
  points: SpikePoint[],
  opts?: { lows: number[]; spikeBars: number },
): SpikeSegment[] {
  const segs: SpikeSegment[] = [];
  let cur: SpikeSegment | null = null;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p.spikeHigh === undefined || p.spikeLow === undefined) {
      cur = null;
      continue;
    }
    const latched = p.consolOk === 1;
    if (
      cur &&
      cur.spikeHigh === p.spikeHigh &&
      cur.spikeLow === p.spikeLow &&
      cur.latched === latched &&
      cur.to === i - 1
    ) {
      cur.to = i;
      continue;
    }
    const episodeFirst = cur === null;
    cur = { from: i, to: i, spikeHigh: p.spikeHigh, spikeLow: p.spikeLow, latched };
    if (episodeFirst && opts) {
      // spikeLow is some window bar's low verbatim, so exact equality finds
      // the anchor bar; nearest occurrence wins, capped at the arm window.
      for (let j = i; j >= Math.max(0, i - opts.spikeBars + 1); j--) {
        if (opts.lows[j] === p.spikeLow) {
          cur.legFrom = j;
          break;
        }
      }
    }
    segs.push(cur);
  }
  return segs;
}

const SPIKE_AMBER = "#F59E0B"; // consolidating: pattern forming, not yet tradeable
const SPIKE_GREEN = "#26A69A"; // latched: consolidation confirmed, dips are the trade
const SPIKE_RED = "#EF5350"; // spike-high edge

function hexWithAlpha(hex: string, alpha: number): string {
  const a = Math.round(alpha * 255).toString(16).padStart(2, "0");
  return `${hex}${a}`;
}

/** Phase-shaded pattern boxes replacing the bare step-lines: one translucent
 * box per state segment over the pattern's full height (amber consolidating,
 * green latched), a dashed flat-floor line while the band still voids the
 * pattern (solid once dips below it became the tradeable retrace), and thin
 * spike-high/base edges. Same suppress-the-figures contract as SR_LEVELS'
 * zones: the declared figures stay for the legend and click-to-rule tokens. */
function drawSpike(params: IndicatorDrawParams<SpikePoint, unknown, unknown>): boolean {
  const { ctx, chart, indicator, xAxis, yAxis } = params;
  const result = (indicator.result ?? []) as SpikePoint[];
  if (!result.length) return true;
  const cfg = parseSpikeConfig(indicator.calcParams);
  const ext = (indicator.extendData ?? {}) as SpikeExtend;
  const barPxRaw = xAxis.convertToPixel(1) - xAxis.convertToPixel(0);
  const half = Number.isFinite(barPxRaw) ? Math.abs(barPxRaw) / 2 : 0;
  const dataList = chart.getDataList();
  const lows = dataList.map((d) => d.low);
  // Labels are legible only when bars have real width; a zoomed-out chart
  // keeps the boxes and drops the text.
  const labels = ext.showStageLabels !== false && half * 2 >= 5;
  const segs = spikeSegments(result, { lows, spikeBars: cfg.spikeBars });

  ctx.save();
  for (const s of segs) {
    // The box's left edge: the base low's bar for an episode's first segment
    // (covering the spike leg and its swing low), the segment start otherwise.
    const x0 = xAxis.convertToPixel(s.legFrom ?? s.from) - half;
    const x1 = xAxis.convertToPixel(s.to) + half;
    const w = x1 - x0;
    if (w <= 0) continue;
    const yTop = yAxis.convertToPixel(s.spikeHigh);
    const yBot = yAxis.convertToPixel(s.spikeLow);
    const color = s.latched ? SPIKE_GREEN : SPIKE_AMBER;
    ctx.fillStyle = hexWithAlpha(color, s.latched ? 0.16 : 0.11);
    ctx.fillRect(x0, yTop, w, Math.max(1, yBot - yTop));
    // The flat band itself, tinted a shade deeper: the strip price must hold
    // for the consolidation to count. Makes "dipped early" legible — you see
    // the zone the low fell out of.
    const bandFloor = s.spikeHigh - (cfg.maxFlatRangePct / 100) * (s.spikeHigh - s.spikeLow);
    ctx.fillStyle = hexWithAlpha(color, 0.1);
    ctx.fillRect(x0, yTop, w, Math.max(1, yAxis.convertToPixel(bandFloor) - yTop));
    // Edges: spike high in red, base in teal — what the old figures showed,
    // now bound to their box. Dotted, so they read as pattern bounds rather
    // than price levels.
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.strokeStyle = hexWithAlpha(SPIKE_RED, 0.8);
    ctx.beginPath();
    ctx.moveTo(x0, yTop);
    ctx.lineTo(x1, yTop);
    ctx.stroke();
    ctx.strokeStyle = hexWithAlpha(SPIKE_GREEN, 0.8);
    ctx.beginPath();
    ctx.moveTo(x0, yBot);
    ctx.lineTo(x1, yBot);
    ctx.stroke();
    ctx.setLineDash([]);
    // Flat floor: the band's lower bound, the pattern's lifelong hard floor.
    // Long dashes pre-latch, fine dots once latched (dips down TO it are the
    // tradeable retrace; through it, death). Skipped for segments shorter than 3 bars
    // unless latched — during a fast rally every 1-bar extension is its own
    // segment, and a stepping trail of floor dashes is clutter for a floor
    // that never had time to matter.
    if (!s.latched && s.to - s.from + 1 < 3) continue;
    // Latched segments draw the operative boundary — the Max Retrace kill
    // floor; amber ones draw the flat-band floor the consolidation must hold.
    const floorPct = s.latched ? cfg.maxRetracePct : cfg.maxFlatRangePct;
    const floor = s.spikeHigh - (floorPct / 100) * (s.spikeHigh - s.spikeLow);
    const yFloor = yAxis.convertToPixel(floor);
    // Starts at the ARM bar, not the leg's left edge — the floor only means
    // something once the pattern is armed, and drawing it across the rising
    // leg's candles would just add noise.
    const xArm = xAxis.convertToPixel(s.from) - half;
    ctx.strokeStyle = hexWithAlpha(color, 0.9);
    ctx.setLineDash(s.latched ? [2, 3] : [4, 3]);
    ctx.beginPath();
    ctx.moveTo(xArm, yFloor);
    ctx.lineTo(x1, yFloor);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // Stage labels, drawn as a second pass so text sits over the fills. One
  // label per transition: "spike" at each episode's birth, "consolidating"
  // once a pre-latch segment holds long enough to mean it, "latched" at the
  // confirmation, and the end reason where an episode dies.
  if (labels) {
    ctx.font = "600 10px ui-monospace, Menlo, monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    // Solid color chip under white text: the fills are near-transparent, so
    // bare text sinks into the candles behind it.
    // Inside-row chips ("consolidating", "latched") sit at the same height; a
    // latch a few bars after the consolidation chip would stamp over its tail,
    // so left-aligned chips shift right past the previous chip on their row.
    const rowRight = new Map<number, number>();
    const chip = (text: string, x: number, yBase: number, color: string, align: "left" | "right") => {
      const w = ctx.measureText(text).width + 8;
      let x0 = align === "right" ? x - w : x;
      if (align === "left") {
        x0 = Math.max(x0, (rowRight.get(Math.round(yBase)) ?? -Infinity) + 3);
        rowRight.set(Math.round(yBase), x0 + w);
      }
      ctx.fillStyle = hexWithAlpha(color, 0.92);
      ctx.beginPath();
      ctx.roundRect(x0, yBase - 11, w, 14, 3);
      ctx.fill();
      ctx.fillStyle = "#FFFFFF";
      ctx.fillText(text, x0 + 4, yBase);
    };
    let prev: SpikeSegment | null = null;
    let consolLabeled = false;
    for (const s of segs) {
      const episodeFirst = s.from === 0 || result[s.from - 1].spikeHigh === undefined;
      if (episodeFirst) {
        prev = null;
        consolLabeled = false;
      }
      const yTop = yAxis.convertToPixel(s.spikeHigh);
      const xSeg = xAxis.convertToPixel(s.from) - half;
      if (episodeFirst) {
        chip("spike", xAxis.convertToPixel(s.legFrom ?? s.from) - half + 1, yTop - 5, SPIKE_AMBER, "left");
      }
      // Once per episode: every extension makes its own pre-latch segment, and
      // a chip per segment stamps overlapping copies across a stepping rally.
      if (!s.latched && !episodeFirst && !consolLabeled && s.to - s.from + 1 >= 3) {
        chip("consolidating", xSeg + 2, yTop + 14, SPIKE_AMBER, "left");
        consolLabeled = true;
      }
      if (s.latched && (!prev || !prev.latched)) {
        chip("latched", xSeg + 2, yTop + 14, SPIKE_GREEN, "left");
      }
      const next = s.to + 1;
      if (next < result.length && result[next].spikeHigh === undefined) {
        const p = result[s.to];
        let reason = s.latched ? "too deep" : "dipped early";
        if (lows[next] < s.spikeLow) reason = "broke base";
        else if ((p.barsSinceSpike ?? 0) + 1 >= cfg.maxPatternBars) reason = "expired";
        else if (dataList[next].high > s.spikeHigh) reason = "not steep";
        chip(reason, xAxis.convertToPixel(s.to) + half - 1, yTop - 5, SPIKE_RED, "right");
      }
      prev = s;
    }
  }
  ctx.restore();
  return true; // boxes replace the default figure lines
}

// Spike/consolidation/retrace pattern. calcParams =
// [spikeBars, minSpikePct, flatBars, maxFlatRangePct, maxPatternBars,
// maxRetracePct].
export const SPIKE_TEMPLATE: Omit<IndicatorTemplate, "name"> = {
  shortName: "Spike",
  series: "price",
  precision: 2,
  calcParams: [5, 2, 5, 15, 60, 70],
  figures: SPIKE_FIGURES,
  styles: { lines: SPIKE_DEFAULT_LINE_STYLES },
  calc: (dataList: KLineData[], ind: Indicator) =>
    computeSpike(dataList, parseSpikeConfig(ind.calcParams)),
  draw: (params) => drawSpike(params as IndicatorDrawParams<SpikePoint, unknown, unknown>),
};
