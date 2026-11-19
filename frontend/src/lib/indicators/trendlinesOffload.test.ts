import { afterEach, describe, expect, it, vi } from "vitest";
import { computeTrendlines } from "./trendlines";
import { computeTrendlinesAsync } from "./trendlinesOffload";
import { TRENDLINES_DEFAULTS } from "./trendlinesOutputs";
import { synthBars } from "./trendlinesSynth.testutil";

describe("computeTrendlinesAsync", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock("./trendlines");
    vi.resetModules();
  });

  it("falls back to the inline compute where there is no Worker", async () => {
    const bars = synthBars(2000);
    const cfg = { ...TRENDLINES_DEFAULTS };
    expect(await computeTrendlinesAsync(bars, cfg)).toEqual(computeTrendlines(bars, cfg));
  });

  it("rejects, never hangs, when the worker and the inline fallback both fail", async () => {
    class FailingWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: ErrorEvent) => void) | null = null;
      postMessage(msg: { id: number }) {
        queueMicrotask(() => this.onmessage?.({ data: { id: msg.id, error: "boom" } } as MessageEvent));
      }
      terminate() {}
    }
    vi.stubGlobal("Worker", FailingWorker);
    vi.doMock("./trendlines", () => ({
      computeTrendlines: () => {
        throw new Error("inline boom");
      },
    }));
    vi.resetModules();
    const { computeTrendlinesAsync: run } = await import("./trendlinesOffload");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(run(synthBars(2000), { ...TRENDLINES_DEFAULTS })).rejects.toThrow("inline boom");
  });
});
