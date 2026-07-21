// Map a live on-chart indicator instance to an expression-editor insert token, or
// null when the expression language has no equivalent. This is the bridge for
// "pick from chart": the user arms a rule row, clicks an indicator, and its
// token (e.g. "EMA(9)") is inserted.
//
// Mirrors the editor catalog's supported indicators (catalog.ts INDICATORS):
// EMA / SMA / RSI / ATR / VOLMA / VOL. AVWAP is intentionally excluded — its
// chart anchor is a bar timestamp, which has no clean AVWAP(anchor) expression
// mapping. Everything unsupported (VWMA/EVWMA moving averages, MACD, BOLL, KDJ,
// CCI, divergence outputs, drawings, …) returns null so the caller can refuse.
//
// Kept free of klinecharts imports so it stays a pure, node-testable function;
// the MA template kind is the same one-liner as indicators/ma.ts templateMaKind.
import { normalizeMaKind } from "./mtf";

export function chartIndicatorToExprToken(
  indType: string,
  calcParams: number[] | undefined,
  extendData: unknown,
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
    default:
      return null;
  }
}
