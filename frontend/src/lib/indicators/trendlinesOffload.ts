// computeTrendlines on a Web Worker, for the HTF pins.
//
// A pin to a finer timeframe holds a long series (a 1H pin on a 4H chart
// reached ~8k bars), and each zoom-out that extends its history recomputed all
// of it on the main thread: 80 to 530 ms freezes mid-zoom, growing with the
// history. On the worker the chart keeps drawing and the lines land when done.
//
// Short series stay inline: posting the bars costs more than the compute. Any
// worker failure (no Worker in tests, a load error) falls back to inline for
// the rest of the session, so the lines never go missing.
import type { KLineData } from "klinecharts";
import { computeTrendlines } from "./trendlines";
import type { TrendlinesConfig } from "./trendlinesOutputs";

type Result = ReturnType<typeof computeTrendlines>;

/** Below this many bars the inline compute is cheaper than the round trip. */
const OFFLOAD_MIN_BARS = 1500;

let worker: Worker | null = null;
let broken = false;
let nextId = 1;
const pending = new Map<number, { resolve: (r: Result) => void; bars: KLineData[]; cfg: TrendlinesConfig }>();

function fail(): void {
  broken = true;
  worker?.terminate();
  worker = null;
  // Finish whatever was in flight inline rather than dropping it.
  for (const [id, p] of pending) {
    pending.delete(id);
    p.resolve(computeTrendlines(p.bars, p.cfg));
  }
}

function getWorker(): Worker | null {
  if (broken || typeof Worker === "undefined") return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./trendlinesWorker.ts", import.meta.url), { type: "module" });
  } catch (e) {
    console.error("Trendlines worker unavailable", e);
    broken = true;
    return null;
  }
  worker.onmessage = (e: MessageEvent<{ id: number; result?: Result; error?: string }>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.result) p.resolve(e.data.result);
    else {
      console.error("Trendlines worker compute failed", e.data.error);
      p.resolve(computeTrendlines(p.bars, p.cfg));
    }
  };
  worker.onerror = (e) => {
    console.error("Trendlines worker error", e.message);
    fail();
  };
  return worker;
}

export function computeTrendlinesAsync(bars: KLineData[], cfg: TrendlinesConfig): Promise<Result> {
  const w = bars.length >= OFFLOAD_MIN_BARS ? getWorker() : null;
  if (!w) return Promise.resolve(computeTrendlines(bars, cfg));
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, { resolve, bars, cfg });
    w.postMessage({ id, bars, cfg });
  });
}
