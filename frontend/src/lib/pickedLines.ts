// Picked trendlines: a Trendlines line frozen into a rule as a bare L<n>. Each
// rule holder (backtest config, armed live snapshot, screener) keeps a Lines
// map beside its text; requests send only the ids the text references. The
// geometry is the line alert's (alertLineOf), so the backend counts it in bars
// of the line's own timeframe.
import type { TrendlineSegment, TrendlineAlertLine } from "./indicators/trendlineMarks";
import { alertTimeframeOf } from "./indicatorAlertInstance";
import { isNativeTf, parseTf } from "./timeframe";

export interface PickedLine {
  epic: string;
  broker: string;
  timeframe: string;
  t1: number; p1: number;
  t2: number; p2: number;
  slope: number;
  tRef: number; pRef: number;
}
export type Lines = Record<string, PickedLine>;

export type { TrendlineAlertLine } from "./indicators/trendlineMarks";

export type LineGateResult =
  | { ok: true; timeframe: string; geometry: TrendlineAlertLine }
  | { ok: false; kind: "seconds" | "unparseable" | "nonNative" | "noGeometry" };

/** Shared gate logic for trendline to alert conversion. Checks timeframe validity
 * and extracts geometry. Returns ok with timeframe+geometry or an error kind. */
export function lineGate(
  seg: TrendlineSegment,
  ext: Record<string, unknown> | undefined,
  resolution: string,
): LineGateResult {
  const timeframe = alertTimeframeOf(ext, resolution);
  try {
    if (parseTf(timeframe).unit === "SECOND") return { ok: false, kind: "seconds" };
  } catch {
    return { ok: false, kind: "unparseable" };
  }
  if (!isNativeTf(timeframe)) return { ok: false, kind: "nonNative" };
  const geometry = seg.alertLine?.() ?? null;
  if (!geometry) return { ok: false, kind: "noGeometry" };
  return { ok: true, timeframe, geometry };
}

export const LINE_ID_RE = /^L\d+$/;
// A bare id: not preceded by a word char or ".", not followed by "." or "(".
const BARE_RE = /(?<![\w.#])L\d+\b(?!\s*[.(])/g;

export function referencedLineIds(rows: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const r of rows) for (const m of r.matchAll(BARE_RE)) out.add(m[0]);
  return out;
}

export function mintLineId(lines: Lines | undefined): string {
  for (let n = 1; ; n++) if (!lines || !(`L${n}` in lines)) return `L${n}`;
}

export function trimLines(lines: Lines | undefined, rows: readonly string[]): Lines | undefined {
  if (!lines) return undefined;
  const used = referencedLineIds(rows);
  const out: Lines = {};
  for (const [id, l] of Object.entries(lines)) if (used.has(id)) out[id] = l;
  return Object.keys(out).length ? out : undefined;
}

export function lineGeoKey(l: PickedLine): string {
  return [l.epic, l.broker, l.timeframe, l.t1, l.p1, l.t2, l.p2, l.slope].join("|");
}

export function pickedLineFromSeg(args: {
  seg: TrendlineSegment;
  ext: Record<string, unknown> | undefined;
  resolution: string;
  epic: string;
  broker: string;
}): { line: PickedLine } | { reason: string } {
  const gate = lineGate(args.seg, args.ext, args.resolution);
  if (!gate.ok) {
    const messages: Record<LineGateResult["kind"], string> = {
      seconds: "Lines can't be picked on seconds charts",
      unparseable: "Lines can't be picked on this timeframe",
      nonNative: "Lines can't be picked on this timeframe yet",
      noGeometry: "This line can't be picked yet",
    };
    return { reason: messages[gate.kind] };
  }
  return { line: { epic: args.epic, broker: args.broker, timeframe: gate.timeframe, ...gate.geometry } };
}
