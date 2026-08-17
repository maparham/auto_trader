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
    overrideIndicator: (o: { name: string; calcParams?: number[] }) => {
      overridden.push(o as Record<string, unknown>);
      const hit = live.find((i) => i.name === o.name);
      if (hit && o.calcParams) hit.calcParams = o.calcParams;
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
