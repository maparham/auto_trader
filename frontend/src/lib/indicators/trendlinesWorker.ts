// Worker entry for trendlinesOffload: runs computeTrendlines off the main
// thread. Same engine, same float64 arithmetic, so the result is identical to
// an inline call (the parity contract holds).
import type { KLineData } from "klinecharts";
import { computeTrendlines } from "./trendlines";
import type { TrendlinesConfig } from "./trendlinesOutputs";

self.onmessage = (e: MessageEvent<{ id: number; bars: KLineData[]; cfg: TrendlinesConfig }>) => {
  const { id, bars, cfg } = e.data;
  try {
    self.postMessage({ id, result: computeTrendlines(bars, cfg) });
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
