import { describe, expect, it } from "vitest";
import { computeTrendlines } from "./trendlines";
import { computeTrendlinesAsync } from "./trendlinesOffload";
import { TRENDLINES_DEFAULTS } from "./trendlinesOutputs";
import { synthBars } from "./trendlinesSynth.testutil";

describe("computeTrendlinesAsync", () => {
  it("falls back to the inline compute where there is no Worker", async () => {
    const bars = synthBars(2000);
    const cfg = { ...TRENDLINES_DEFAULTS };
    expect(await computeTrendlinesAsync(bars, cfg)).toEqual(computeTrendlines(bars, cfg));
  });
});
