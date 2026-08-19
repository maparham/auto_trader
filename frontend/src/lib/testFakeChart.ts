// Minimal fake klinecharts Chart for tests that exercise indicator lifecycle:
// carries enough of the Indicator surface for mintInstanceId (name/paneId),
// cloneTemplateFromLive (figures), getIndicatorById and calcParams retunes.
// Pair with vi.mock("klinecharts", ...) whose getSupportedIndicators lists the
// built-in types the test creates (e.g. ["BOLL"]).
import type { Chart, Indicator } from "klinecharts";

export interface FakeLiveIndicator {
  paneId: string;
  name: string;
  calcParams: number[];
  extendData?: unknown;
  figures: unknown[];
}

/** klinecharts' own merge(), reproduced faithfully enough to catch the bug
 * overrideExtend exists for: its isObject() is `typeof v === "object"` and so
 * is TRUE for arrays, which means merge RECURSES into them index by index and
 * never shrinks the target. A fake that simply assigned extendData would pass
 * with that bug in place, which is exactly what this one used to do. */
export function klineMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): void {
  for (const key of Object.keys(source)) {
    const t = target[key];
    const s = source[key];
    if (
      typeof s === "object" &&
      s !== null &&
      typeof t === "object" &&
      t !== null
    )
      klineMerge(t as Record<string, unknown>, s as Record<string, unknown>);
    else target[key] = s;
  }
}

export function fakeChart() {
  let seq = 0;
  const live: FakeLiveIndicator[] = [];
  const overridden: Array<Record<string, unknown>> = [];
  const chart = {
    getIndicators: (q?: { paneId?: string; name?: string }) =>
      live.filter(
        (i) => (!q?.paneId || i.paneId === q.paneId) && (!q?.name || i.name === q.name),
      ) as unknown as Indicator[],
    createIndicator: (arg: unknown) => {
      const value = typeof arg === "string" ? { name: arg } : (arg as {
        name: string; calcParams?: number[]; extendData?: unknown;
      });
      const paneId = `pane_${++seq}`;
      live.push({
        paneId, name: value.name, calcParams: value.calcParams ?? [],
        extendData: value.extendData, figures: [],
      });
      return paneId;
    },
    overrideIndicator: (o: {
      name: string;
      calcParams?: number[];
      extendData?: unknown;
    }) => {
      overridden.push(o as Record<string, unknown>);
      const hit = live.find((i) => i.name === o.name);
      if (!hit) return;
      if (o.calcParams) hit.calcParams = o.calcParams;
      // MERGED, not assigned, because that is what klinecharts does and it is
      // the whole reason a removal needs two calls.
      if (o.extendData !== undefined) {
        if (typeof hit.extendData !== "object" || hit.extendData === null)
          hit.extendData = {};
        klineMerge(
          hit.extendData as Record<string, unknown>,
          o.extendData as Record<string, unknown>,
        );
      }
    },
    removeIndicator: (o: { name: string }) => {
      const k = live.findIndex((i) => i.name === o.name);
      if (k >= 0) live.splice(k, 1);
    },
    setPaneOptions: () => {},
    overrideYAxis: () => {},
  };
  return { chart: chart as unknown as Chart, live, overridden };
}
