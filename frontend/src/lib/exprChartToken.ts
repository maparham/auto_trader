// Map a live on-chart indicator instance to an expression-editor insert token, or
// null when the expression language has no equivalent. This is the bridge for
// "pick from chart": the user arms a rule row, clicks an indicator, and its
// token (e.g. "EMA(9)") is inserted.
//
// Two shapes come out of here:
//
//   1. CALL tokens for the editor catalog's parameterised indicators (catalog.ts
//      INDICATORS): EMA / SMA / RSI / VOLMA / VOL. The token restates the
//      chart's parameters, e.g. "EMA(9)".
//   2. INSTANCE REFERENCES for panes whose settings are too rich to restate in a
//      rule — SLOPE, ATR, FVG, TRENDLINES, PIVOT_BANDS, PIVOT_ANALYSIS and
//      SR_LEVELS (the
//      EXPR_INSTANCE_TYPES set; keep a case here for every member), as
//      "<instanceId>.<output>" (e.g. "SLOPE.50",
//      "SLOPE#a1b.accel9"). The rule names the clicked LINE only; the pane stays
//      the single source of truth for MA type, units and smoothing, so retuning
//      any of those leaves every rule that references it correct with no edit.
//      The LENGTH is different: it is what NAMES the line, so retuning 9 to 21
//      makes the rule fail loudly with unknown_indicator_output rather than
//      silently re-point at a different line. The output name must be one the
//      backend's slope_outputs also derives, or the run 422s — hence the
//      slopeOutputs membership check.
//
// AVWAP is intentionally excluded — its chart anchor is a bar timestamp, which
// has no clean AVWAP(anchor) expression mapping. Everything unsupported
// (VWMA/EVWMA moving averages, MACD, BOLL, KDJ, CCI, divergence outputs,
// drawings, …) returns null so the caller can refuse.
//
// Kept free of klinecharts imports so it stays a pure, node-testable function —
// which is why slopeOutputs comes from the leaf indicators/slopeOutputs rather
// than from indicators/slope (a much larger module: its klinecharts import is now
// type-only and erased, but it still pulls in the whole draw/calc chain). The MA
// template kind is the same one-liner as indicators/ma.ts templateMaKind.
import { slopeLengths, slopeOutputs } from "./indicators/slopeOutputs";
import { atrOutputs } from "./atr";
import { FVG_OUTPUTS } from "./indicators/fvgOutputs";
import { TRENDLINES_OUTPUTS } from "./indicators/trendlinesOutputs";
import { PIVOT_BANDS_OUTPUTS } from "./indicators/pivotBandsOutputs";
import { PIVOT_ANALYSIS_OUTPUTS } from "./indicators/pivotAnalysisOutputs";
import { SR_LEVELS_OUTPUTS } from "./indicators/srLevelsOutputs";
import { SPIKE_OUTPUTS } from "./indicators/spikeOutputs";
import type { SlopeExtend } from "./indicators/slope"; // erased at build; no runtime edge
import { normalizeMaKind } from "./mtf";

export interface ExprChartTokenOptions {
  /** The clicked pane's unique instance id (mintInstanceId): "SLOPE" for the
   * first instance of a type, "SLOPE#a1b2c3" for later ones. Required for the
   * instance-reference shape — without it there is nothing to reference. */
  instanceId?: string;
  /** Which of the pane's lines was clicked: an index into its SLOPE LINES
   * (`slopeLengths` order), not into the figure list. They coincide today
   * (figures are `[slope0..slopeN, thHi, thLo]`), but the threshold figures are
   * not referenceable outputs, so the two are not the same list. */
  lineIndex?: number;
  /** Which companion series the click landed on; the acceleration pane is a
   * separate pane over the same instance. */
  output?: "slope" | "accel";
  /** The legend FIGURE the click landed on (LegendFigure.key), for panes whose
   * legend shows more than the plotted line — today only ATR's "atrPct"
   * readout, which picks the pane's `.to%` output. Absent for curve hits and
   * plain row clicks; unknown keys behave like absence. */
  figureKey?: string;
}

export function chartIndicatorToExprToken(
  indType: string,
  calcParams: number[] | undefined,
  extendData: unknown,
  opts?: ExprChartTokenOptions,
): string | null {
  const len = Number(calcParams?.[0]);
  const hasLen = Number.isFinite(len) && len > 0;
  const maType =
    extendData && typeof extendData === "object"
      ? (extendData as { maType?: unknown }).maType
      : undefined;

  switch (indType) {
    // The MA family carries its kind in extendData.maType; the template name
    // (EMA/MA) is only the default. Resolve the EFFECTIVE kind so an "EMA"
    // instance flipped to SMA emits SMA (and a VWMA/EVWMA flip emits nothing).
    case "EMA":
    case "MA": {
      if (!hasLen) return null;
      const kind = normalizeMaKind(maType, indType === "EMA" ? "ema" : "sma");
      if (kind === "ema") return `EMA(${len})`;
      if (kind === "sma") return `SMA(${len})`;
      return null; // vwma / evwma have no expression equivalent
    }
    case "RSI":
      // Only the value line maps; divergence outputs are a separate concern the
      // caller never reaches here (it passes the instance, not an output line).
      return hasLen ? `RSI(${len})` : null;
    // ATR panes carry a Smoothing setting the ATR(length) FUNCTION cannot
    // restate (the function is RMA-only), so a clicked pane emits an instance
    // ref and the pane stays the source of truth — same contract as SLOPE.
    // The fallback CALL shape survives for two callers: one with no instance
    // context at all, and the unreachable-but-possible bare "ATR" id (pre-mint
    // fix), which cannot parse as a ref because ATR is a registered function
    // name. Both are RMA-identical only for an unsmoothed pane, which is the
    // default — a smoothed pane always arrives with a distinct id ("ATR1" or a
    // legacy "ATR#<rand>"), and any id other than the bare type name parses.
    case "ATR": {
      const id = opts?.instanceId;
      // The legend's ATR% readout picks the pct output; anything else (the
      // value figure, a curve hit, a row click) picks the value line.
      const outIdx = opts?.figureKey === "atrPct" ? 1 : 0;
      // atrOutputs falls back to 14 on a garbage length, exactly as the
      // backend's parse_atr_config does, so the ref stays valid on both stacks.
      if (id && id !== indType) return `${id}.${atrOutputs(calcParams)[outIdx]}`;
      // Same defaults-identical fallback story as ATR(len): right for an
      // unconfigured pane, and a configured one always has a ref-able id.
      if (!hasLen) return null;
      return outIdx === 1 ? `ATR%(${len})` : `ATR(${len})`;
    }
    case "VOLMA":
      return hasLen ? `VOLMA(${len})` : null;
    case "VOL":
      return "VOL"; // bar volume, arity 0
    // The SLOPE pane's settings stay in the pane: the token references the
    // clicked LINE, so changing the pane's units, MA kind or smoothing leaves
    // every rule that uses it correct with no edit. The length is the exception
    // — it is the line's NAME, and retuning it is meant to break the rule.
    case "SLOPE": {
      if (!opts?.instanceId) return null;
      const ext = (extendData ?? {}) as SlopeExtend;
      // Outputs are named by the pane's MA LENGTH, so the clicked line index is
      // resolved to its length here rather than spelled as an ordinal. Two
      // lines configured to the same length share one name — they are the same
      // series, so either click inserts the same correct token.
      const length = slopeLengths(calcParams)[opts.lineIndex ?? 0];
      if (length === undefined) return null;
      const output = opts.output === "accel" ? `accel${length}` : `${length}`;
      // The undefined check above already refused a line the pane does not draw
      // (an index past slopeLengths' 5-line cap or past the configured count);
      // this one refuses an accel ref while the companion is off. Both are
      // outputs the backend's slope_outputs would reject.
      if (!slopeOutputs(calcParams, ext).includes(output)) return null;
      return `${opts.instanceId}.${output}`;
    }
    // FVG's four outputs are FIXED names, not lengths, so — unlike SLOPE — no
    // retune can invalidate a ref: the params reshape the same four series. The
    // clicked legend figure names the output directly (the figure keys ARE the
    // backend's output names), and a row click with no figure takes bull_top,
    // FVG_OUTPUTS[0]. The bare "FVG" id is ref-able because no expression
    // function shares the name (mintInstanceId's refCollision check).
    case "FVG": {
      const id = opts?.instanceId;
      if (!id) return null;
      const key = opts?.figureKey;
      const output = (FVG_OUTPUTS as readonly string[]).includes(key ?? "")
        ? (key as string)
        : FVG_OUTPUTS[0];
      return `${id}.${output}`;
    }
    // TRENDLINES reads exactly like FVG: four FIXED output names, so no retune
    // can invalidate a ref (the params reshape the same four series). It has no
    // chart figures at all — the pane declares `figures: []` and paints its own
    // canvas — so in practice every click arrives without a figureKey and takes
    // TRENDLINES_OUTPUTS[0], tl_support. The key is still honoured when one is
    // passed, so a future legend that names the outputs needs no change here.
    // Falling through to `default` instead would toast "no expression
    // equivalent" on a pane that exposes four operands.
    case "TRENDLINES": {
      const id = opts?.instanceId;
      if (!id) return null;
      const key = opts?.figureKey;
      const output = (TRENDLINES_OUTPUTS as readonly string[]).includes(key ?? "")
        ? (key as string)
        : TRENDLINES_OUTPUTS[0];
      return `${id}.${output}`;
    }
    // PIVOT_BANDS reads exactly like FVG/TRENDLINES: two FIXED output names
    // ("pivotHigh"/"pivotLow", same strings as its figure keys), so no retune
    // can invalidate a ref. A row click with no figureKey takes outputs[0],
    // pivotHigh.
    case "PIVOT_BANDS": {
      const id = opts?.instanceId;
      if (!id) return null;
      const key = opts?.figureKey;
      const output = (PIVOT_BANDS_OUTPUTS as readonly string[]).includes(key ?? "")
        ? (key as string)
        : PIVOT_BANDS_OUTPUTS[0];
      return `${id}.${output}`;
    }
    // PIVOT_ANALYSIS exposes four FIXED outputs (pivotHigh/pivotLow/deltaPct/
    // deltaT), but only the first two are drawn as figures — deltaPct/deltaT
    // are draw-only labels with no clickable line, so a click can only ever
    // resolve to pivotHigh/pivotLow (the other two remain typeable by hand in
    // the editor). No retune can invalidate a ref, same as FVG/TRENDLINES.
    case "PIVOT_ANALYSIS": {
      const id = opts?.instanceId;
      if (!id) return null;
      const key = opts?.figureKey;
      const output = (PIVOT_ANALYSIS_OUTPUTS as readonly string[]).includes(key ?? "")
        ? (key as string)
        : PIVOT_ANALYSIS_OUTPUTS[0];
      return `${id}.${output}`;
    }
    // SR_LEVELS reads exactly like FVG: two FIXED output names
    // ("support"/"resistance", the same strings as its figure keys), so no
    // retune can invalidate a ref — the params reshape the same two series.
    // Its figure lines are draw-suppressed (the pane paints zones instead), so
    // in practice a click arrives without a figureKey and takes outputs[0],
    // support; the key is still honoured when the legend passes one.
    case "SR_LEVELS": {
      const id = opts?.instanceId;
      if (!id) return null;
      const key = opts?.figureKey;
      const output = (SR_LEVELS_OUTPUTS as readonly string[]).includes(key ?? "")
        ? (key as string)
        : SR_LEVELS_OUTPUTS[0];
      return `${id}.${output}`;
    }
    // SPIKE reads like PIVOT_BANDS: six FIXED output names, only the two
    // price-scaled ones (spikeHigh/spikeLow) drawn as figures, so a click
    // resolves to those (the state/percent outputs remain typeable by hand in
    // the editor). No retune can invalidate a ref.
    case "SPIKE": {
      const id = opts?.instanceId;
      if (!id) return null;
      const key = opts?.figureKey;
      const output = (SPIKE_OUTPUTS as readonly string[]).includes(key ?? "")
        ? (key as string)
        : SPIKE_OUTPUTS[0];
      return `${id}.${output}`;
    }
    default:
      return null;
  }
}
