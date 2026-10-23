// Picked trendlines: a Trendlines line frozen into a rule as a bare L<n>. Each
// rule holder (backtest config, armed live snapshot, screener) keeps a Lines
// map beside its text; requests send only the ids the text references. The
// geometry is the line alert's (alertLineOf), so the backend counts it in bars
// of the line's own timeframe.
import type { TrendlineSegment } from "./indicators/trendlineMarks";
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
  const timeframe = alertTimeframeOf(args.ext, args.resolution);
  try {
    if (parseTf(timeframe).unit === "SECOND") return { reason: "Lines can't be picked on seconds charts" };
  } catch {
    return { reason: "Lines can't be picked on this timeframe" };
  }
  if (!isNativeTf(timeframe)) return { reason: "Lines can't be picked on this timeframe yet" };
  const g = args.seg.alertLine?.() ?? null;
  if (!g) return { reason: "This line can't be picked yet" };
  return { line: { epic: args.epic, broker: args.broker, timeframe, ...g } };
}
