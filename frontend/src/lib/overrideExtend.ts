// overrideExtend: the one safe way to write extendData onto a LIVE indicator.
//
// A LEAF with no runtime imports (Chart is type-only), like trendlinesOutputs:
// lib/indicators.ts pulls klinecharts' runtime in, which throws in a node test
// environment, and half the callers here are node-testable modules.
import type { Chart } from "klinecharts";

/** Write extendData onto a LIVE indicator so that REMOVALS land.
 *
 * klinecharts' overrideIndicator MERGES extendData through its own merge(),
 * whose isObject() is true for arrays, so it recurses into them index by index.
 * A shorter array therefore never shrinks the live one: index 2 of the old
 * value survives because the new value simply has nothing to say about it. The
 * same holds for a nested object that has dropped a key.
 *
 * So every key whose value is an object or an array is CLEARED first, in its
 * own call. merge assigns anything non-object wholesale, so the key becomes
 * null; the second call then writes the new value into an empty slot. Two calls
 * are the price of a removal that repaints.
 *
 * Pass a partial patch or a whole extendData: only the keys given are touched,
 * which is what lets a caller leave its neighbours alone.
 *
 * Found the hard way. Unpinning a trendline saved correctly and never
 * repainted, and the same shape was then found on the sessions and time-window
 * delete buttons, on the heatmap's own "paint nothing" path, and on every MTF
 * timeframe switch. */
export function overrideExtend(
  chart: Chart,
  paneId: string,
  name: string,
  extendData: Record<string, unknown>,
  calcParams?: unknown[],
): void {
  const nested = Object.keys(extendData).filter(
    (k) => typeof extendData[k] === "object" && extendData[k] !== null,
  );
  if (nested.length)
    chart.overrideIndicator({
      paneId,
      name,
      extendData: Object.fromEntries(
        nested.map((k) => [k, null]),
      ) as unknown as Record<string, unknown>,
    });
  chart.overrideIndicator({
    paneId,
    name,
    ...(calcParams ? { calcParams: calcParams as number[] } : {}),
    extendData: extendData as unknown as Record<string, unknown>,
  });
}
