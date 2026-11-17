// The pane an indicator alert watches, as the backend wants it: the type,
// calcParams and extendData verbatim, minus the chart's runtime caches. The
// backend's registry parser decides everything else (outputs, labels,
// refusals); this module mirrors none of it.
import { apiFetch, API_BASE } from "./http";
// signals only type-imports this module, so this is no runtime cycle.
import { bumpAlerts } from "./signals";
import { tryCanonicalTf } from "./timeframe";
import { withChartTimezone } from "./indicatorTimezone";

export interface AlertInstance {
  type: string;
  calcParams: number[];
  extendData: Record<string, unknown>;
}

/** The pane payload: an mtf block shrinks to its pin (`htfSeries` and the
 * other per-bar arrays are chart caches, not settings). Never mutates. */
export function alertInstanceOf(
  type: string,
  calcParams: unknown[] | undefined,
  extendData: unknown,
): AlertInstance {
  const ext: Record<string, unknown> = { ...((extendData ?? {}) as Record<string, unknown>) };
  const mtf = ext.mtf as { timeframe?: unknown } | undefined;
  if (mtf && typeof mtf === "object") {
    if (typeof mtf.timeframe === "string" && mtf.timeframe) ext.mtf = { timeframe: mtf.timeframe };
    else delete ext.mtf;
  }
  // PREV_HL buckets days in the chart's zone, which the server cannot know.
  const stamped = withChartTimezone(type, ext) as Record<string, unknown>;
  return { type, calcParams: (calcParams ?? []).map(Number), extendData: stamped };
}

/** The timeframe an alert on this pane watches: its pin when it has one
 * (canonical form), else the chart's resolution. */
export function alertTimeframeOf(ext: Record<string, unknown> | undefined, resolution: string): string {
  const pin = (ext?.mtf as { timeframe?: string } | undefined)?.timeframe;
  return (pin && tryCanonicalTf(pin)) || resolution;
}

/** A pane's plotted value for a registry output name: result rows key most
 * outputs by the same name, a few by its camelCase form (FVG `bull_top`). */
export function chartValueOf(row: Record<string, number | undefined> | undefined, output: string): number | undefined {
  if (!row) return undefined;
  const v = row[output] ?? row[output.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase())];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

let alertable: ReadonlySet<string> | null = null;
let inflight: Promise<void> | null = null;

/** The registry types an alert may watch (GET /api/alerts/indicators), once. */
export function loadAlertableTypes(): Promise<void> {
  if (alertable || inflight) return inflight ?? Promise.resolve();
  inflight = (async () => {
    try {
      const res = await apiFetch(`${API_BASE}/api/alerts/indicators`);
      if (res.ok) {
        alertable = new Set(((await res.json()) as { types: string[] }).types);
        // Legends and menus drew before the types were known; redraw them.
        bumpAlerts();
      }
    } catch {
      /* retried by the next call */
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export const isAlertableType = (type: string): boolean => alertable?.has(type) ?? false;
