import { describe, it, expect, vi } from "vitest";
import { evaluateStrategy } from "../api";
import type { EvaluateRequest } from "./liveTypes";

const REQ: EvaluateRequest = {
  epic: "EURUSD", resolution: "MINUTE",
  candles: [{ time: 1700, open: 10, high: 10, low: 10, close: 10, volume: 0 }],
  series: {},
  longEntry: { combine: "AND", rules: [] },
  longExit: { combine: "AND", rules: [] },
  shortEntry: { combine: "AND", rules: [] },
  shortExit: { combine: "AND", rules: [] },
  longEnabled: true, shortEnabled: true,
  position: null,
};

describe("evaluateStrategy", () => {
  it("POSTs to /api/strategy/evaluate and returns actions", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ actions: [{ kind: "open", leg: "long", side: "buy", reason: "x" }] }), { status: 200 }),
    );
    const res = await evaluateStrategy(REQ);
    expect((spy.mock.calls[0][0] as string)).toContain("/api/strategy/evaluate");
    expect(res.actions[0].kind).toBe("open");
  });
});
