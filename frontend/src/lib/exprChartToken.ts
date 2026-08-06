// Map a live on-chart indicator instance to an expression-editor insert token, or
// null when the expression language has no equivalent. This is the bridge for
// "pick from chart": the user arms a rule row, clicks an indicator, and its
// token (e.g. "EMA(9)") is inserted.
//
// Two shapes come out of here:
//
//   1. CALL tokens for the editor catalog's parameterised indicators (catalog.ts
//      INDICATORS): EMA / SMA / RSI / ATR / VOLMA / VOL. The token restates the
//      chart's parameters, e.g. "EMA(9)".
//   2. INSTANCE REFERENCES for panes whose settings are too rich to restate in a
//      rule — today SLOPE, as "<instanceId>.<output>" (e.g. "SLOPE.slope1",
//      "SLOPE#a1b.accel0"). The rule names the clicked LINE only; the pane stays
//      the single source of truth for MA type, length, units and smoothing, so
//      retuning the pane leaves every rule that references it correct with no
//      edit. The output name must be one the backend's slope_outputs also
//      derives, or the run 422s — hence the slopeOutputs membership check.
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
import { slopeOutputs } from "./indicators/slopeOutputs";
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
    case "ATR":
      return hasLen ? `ATR(${len})` : null;
    case "VOLMA":
      return hasLen ? `VOLMA(${len})` : null;
    case "VOL":
      return "VOL"; // bar volume, arity 0
    // The SLOPE pane's settings stay in the pane: the token references the
    // clicked LINE, never its parameters, so changing the pane's length or units
    // leaves every rule that uses it correct with no edit.
    case "SLOPE": {
      if (!opts?.instanceId) return null;
      const ext = (extendData ?? {}) as SlopeExtend;
      const kind = opts.output === "accel" ? "accel" : "slope";
      const output = `${kind}${opts.lineIndex ?? 0}`;
      // Refuses a line the pane does not draw (index past slopeLengths' 5-line
      // cap or past the configured count) and an accel ref when the companion
      // is off — both are outputs the backend would reject.
      if (!slopeOutputs(calcParams, ext).includes(output)) return null;
      return `${opts.instanceId}.${output}`;
    }
    default:
      return null;
  }
}
