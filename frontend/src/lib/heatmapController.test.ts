import { expect, it } from "vitest";
import { alignValuesToBars, buildClosenessRequest } from "./heatmapController";

it("aligns endpoint values to chart bar timestamps by time", () => {
  const barTimes = [0, 60, 120, 180];
  const resp = { times: [0, 120], values: [0.4, 0.9] };
  // bars without a matching endpoint time are null
  expect(alignValuesToBars(barTimes, resp)).toEqual([0.4, null, 0.9, null]);
});

it("returns null request when the active side has no enabled rows", () => {
  const cfg = {
    longEntry: { combine: "AND", rules: [] },
    shortEntry: { combine: "AND", rules: [{ expr: "close > 100", enabled: true }] },
  };
  const view = {
    side: "long", basis: "volatility", width: 2, window: 50, atrLength: 14,
    agg: "max", baseResolution: "MINUTE",
  };
  const win = { broker: "capital", epic: "X", priceSide: "mid", displayResolution: "HOUR", fromTime: 0, toTime: 3600 };
  expect(buildClosenessRequest(cfg as never, view as never, win as never)).toBeNull();
});

it("builds a request from the active side's enabled rows", () => {
  const cfg = {
    longEntry: { combine: "OR", rules: [
      { expr: "close > 100", enabled: true },
      { expr: "close > 90", enabled: false },
    ] },
    shortEntry: { combine: "AND", rules: [] },
  };
  const view = {
    side: "long", basis: "volatility", width: 2, window: 50, atrLength: 14,
    agg: "max", baseResolution: "MINUTE",
  };
  const win = { broker: "capital", epic: "X", priceSide: "mid", displayResolution: "HOUR", fromTime: 0, toTime: 3600 };
  const req = buildClosenessRequest(cfg as never, view as never, win as never);
  expect(req).not.toBeNull();
  expect(req!.rows).toEqual(["close > 100"]);   // disabled row dropped
  expect(req!.combine).toBe("OR");
  expect(req!.baseResolution).toBe("MINUTE");
  expect(req!.displayResolution).toBe("HOUR");
});
