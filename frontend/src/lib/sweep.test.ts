import { describe, expect, it, vi } from "vitest";
import { axisColumnLabel, axisOptionFor, comboAxisLabel, comboAxisText, comboCount, enumerateCombos, materializePeriodAxes, mirrorRiskAxes, opAxisTarget, robustWindowBounds, ruleAxisTarget, runSweep, sweepCatchState, SWEEP_MAX_COMBOS } from "./sweep";
import * as api from "../api";

const axis = (target: string, from: number, to: number, step: number) =>
  ({ kind: "range" as const, target, label: target, from, to, step });

const listAxis = (target: string, options: { label: string; patch: Record<string, number | string> }[]) =>
  ({ kind: "list" as const, target, label: target, options });

describe("enumerateCombos", () => {
  it("walks one axis inclusively", () => {
    expect(enumerateCombos([axis("param:n", 1, 2, 0.5)])).toEqual([
      { "param:n": 1 }, { "param:n": 1.5 }, { "param:n": 2 },
    ]);
  });

  it("builds the cartesian product for two axes", () => {
    const combos = enumerateCombos([axis("param:a", 1, 2, 1), axis("param:b", 10, 30, 10)]);
    expect(combos).toHaveLength(6);
    expect(combos[0]).toEqual({ "param:a": 1, "param:b": 10 });
    expect(comboCount([axis("param:a", 1, 2, 1), axis("param:b", 10, 30, 10)])).toBe(6);
  });

  it("walks negative and descending ranges", () => {
    expect(enumerateCombos([axis("param:n", -1, 0, 0.5)])).toEqual([
      { "param:n": -1 }, { "param:n": -0.5 }, { "param:n": 0 },
    ]);
    // Descending endpoints (0 → -1) enumerate downward instead of returning empty.
    expect(enumerateCombos([axis("param:n", 0, -1, 0.5)])).toEqual([
      { "param:n": 0 }, { "param:n": -0.5 }, { "param:n": -1 },
    ]);
    expect(comboCount([axis("param:n", 0, -1, 0.5)])).toBe(3);
  });

  it("guards degenerate steps", () => {
    expect(comboCount([axis("param:a", 1, 10, 0)])).toBe(Infinity);   // Run stays disabled
    expect(enumerateCombos([axis("param:a", 5, 5, 1)])).toEqual([{ "param:a": 5 }]);
  });

  it("writes a mirrored target with the same value into every combo", () => {
    const a = { ...axis("risk:long.stop.value", 1, 2, 1), mirrorTarget: "risk:short.stop.value" };
    expect(enumerateCombos([a])).toEqual([
      { "risk:long.stop.value": 1, "risk:short.stop.value": 1 },
      { "risk:long.stop.value": 2, "risk:short.stop.value": 2 },
    ]);
    expect(comboCount([a])).toBe(2);                 // a mirror never multiplies combos
  });

  it("crosses three axes: first axis varies fastest, count multiplies", () => {
    const axes = [axis("param:a", 1, 2, 1), axis("param:b", 10, 20, 10), axis("param:c", 0, 1, 1)];
    const combos = enumerateCombos(axes);
    expect(combos).toHaveLength(8);
    expect(combos[0]).toEqual({ "param:a": 1, "param:b": 10, "param:c": 0 });
    expect(combos[7]).toEqual({ "param:a": 2, "param:b": 20, "param:c": 1 });
    expect(comboCount(axes)).toBe(8);
  });

  it("SWEEP_MAX_COMBOS is 1000", () => {
    expect(SWEEP_MAX_COMBOS).toBe(1000);
  });
});

describe("mirrorRiskAxes", () => {
  it("stamps long-side risk axes with their short mirror, passes others through", () => {
    const risk = axis("risk:long.target.mult", 1, 3, 1);
    const param = axis("param:n", 1, 2, 1);
    const [m, p] = mirrorRiskAxes([risk, param]);
    if (m.kind !== "range") throw new Error("expected range axis");
    expect(m.mirrorTarget).toBe("risk:short.target.mult");
    expect(p).toEqual(param);
  });
});

describe("runSweep", () => {
  it("chunks sequentially, reports progress, retries a failed chunk once", async () => {
    const combos45 = [axis("param:n", 1, 45, 1)];
    const calls: number[] = [];
    let failedOnce = false;
    vi.spyOn(api, "runSweepChunk").mockImplementation(async (_req, combos) => {
      calls.push(combos.length);
      if (calls.length === 2 && !failedOnce) { failedOnce = true; throw new Error("net"); }
      return combos.map((c) => ({ combo: c, metrics: null, error: null, windows: null }));
    });
    const progress: number[] = [];
    const rows = await runSweep({} as never, combos45, {
      onRows: (_r, done) => progress.push(done),
    });
    expect(rows).toHaveLength(45);
    expect(calls).toEqual([20, 20, 20, 5]);          // second chunk retried
    expect(progress).toEqual([20, 40, 45]);
  });

  it("sends each chunk's done/total position for the backend log", async () => {
    const progressArgs: Array<{ done: number; total: number } | undefined> = [];
    vi.spyOn(api, "runSweepChunk").mockImplementation(async (_req, combos, progress) => {
      progressArgs.push(progress);
      return combos.map((c) => ({ combo: c, metrics: null, error: null, windows: null }));
    });
    await runSweep({} as never, [axis("param:n", 1, 45, 1)], { onRows: () => {} });
    // 45 combos over 20-combo chunks: 0/45, 20/45, 40/45.
    expect(progressArgs).toEqual([
      { done: 0, total: 45 },
      { done: 20, total: 45 },
      { done: 40, total: 45 },
    ]);
  });

  it("aborts between chunks", async () => {
    vi.spyOn(api, "runSweepChunk").mockResolvedValue([]);
    const ctl = new AbortController();
    const p = runSweep({} as never, [axis("param:n", 1, 45, 1)], {
      onRows: () => ctl.abort(), signal: ctl.signal,
    });
    await expect(p).rejects.toThrow(/aborted/i);
  });

  it("a cancel landing while a chunk is failing suppresses the retry", async () => {
    const ctl = new AbortController();
    const spy = vi.spyOn(api, "runSweepChunk").mockImplementation(async () => {
      ctl.abort();                 // user cancels while the request is in flight...
      throw new Error("net");      // ...and that request then fails
    });
    spy.mockClear();               // spy history persists across tests in this file
    const onRows = vi.fn();
    const p = runSweep({} as never, [axis("param:n", 1, 45, 1)], { onRows, signal: ctl.signal });
    await expect(p).rejects.toThrow(/aborted/i);
    expect(spy).toHaveBeenCalledTimes(1);            // no post-cancel retry
    expect(onRows).not.toHaveBeenCalled();
  });

  it("forwards opts.windows to every chunk", async () => {
    const spy = vi.spyOn(api, "runSweepChunk").mockResolvedValue([]);
    spy.mockClear();               // spy history persists across tests in this file
    await runSweep({} as never, [axis("param:n", 1, 2, 1)], { onRows: () => {}, windows: [1, 2, 3] });
    expect(spy).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), [1, 2, 3]);
  });
});

describe("robustWindowBounds", () => {
  const DAY = 86_400_000;

  it("splits a month into weekly windows", () => {
    const from = Date.UTC(2026, 2, 1);
    const to = from + 28 * DAY;
    const bounds = robustWindowBounds(from, to);
    expect(bounds).toHaveLength(5); // 4 windows
    expect(bounds[0]).toBe(Math.round(from / 1000));
    expect(bounds[4]).toBe(Math.round(to / 1000));
    for (let i = 1; i < bounds.length; i++) expect(bounds[i]).toBeGreaterThan(bounds[i - 1]);
  });

  it("splits a year into monthly windows and a week into daily windows", () => {
    const from = Date.UTC(2026, 0, 1);
    expect(robustWindowBounds(from, from + 365 * DAY)).toHaveLength(13);
    expect(robustWindowBounds(from, from + 7 * DAY)).toHaveLength(8);
  });

  it("clamps auto N to at least 3 and at most 30", () => {
    const from = Date.UTC(2026, 0, 1);
    expect(robustWindowBounds(from, from + 1 * DAY)).toHaveLength(4);      // min 3
    expect(robustWindowBounds(from, from + 3650 * DAY)).toHaveLength(31);  // max 30
  });

  it("uses the override count when given, clamped to 2..50", () => {
    const from = Date.UTC(2026, 0, 1);
    expect(robustWindowBounds(from, from + 28 * DAY, 6)).toHaveLength(7);
    expect(robustWindowBounds(from, from + 28 * DAY, 1)).toHaveLength(3);
    expect(robustWindowBounds(from, from + 28 * DAY, 99)).toHaveLength(51);
  });
});

describe("ruleAxisTarget", () => {
  it("builds an operand length target", () => {
    expect(ruleAxisTarget("long", "entry", 0, "left.length")).toBe("rule:long.entry.0.left.length");
  });

  it("builds an operand value target for the right side", () => {
    expect(ruleAxisTarget("short", "exit", 2, "right.value")).toBe("rule:short.exit.2.right.value");
  });

  it("builds a count target with no operand side", () => {
    expect(ruleAxisTarget("long", "exit", 1, "count")).toBe("rule:long.exit.1.count");
  });
});

describe("sweepCatchState", () => {
  const prev = { rows: [{ combo: { "param:n": 1 }, metrics: null, error: null, windows: null }], done: 20, total: 45, running: true };

  it("marks a user cancel neutrally, keeping landed rows and no error", () => {
    const next = sweepCatchState(prev, true, new Error("sweep aborted"));
    expect(next).toEqual({ rows: prev.rows, done: 20, total: 45, running: false, cancelled: true });
    expect(next.error).toBeUndefined();
  });

  it("marks a real failure as an error, not a cancel", () => {
    const next = sweepCatchState(prev, false, new Error("net down"));
    expect(next).toEqual({ rows: prev.rows, done: 20, total: 45, running: false, error: "net down" });
    expect(next.cancelled).toBeUndefined();
  });

  it("prefers the abort signal over the error when both are present (race)", () => {
    // A cancel that races a chunk failure: the promise rejects with the chunk's
    // error, but the signal is already aborted — must still read as a cancel.
    const next = sweepCatchState(prev, true, new Error("net down"));
    expect(next.cancelled).toBe(true);
    expect(next.error).toBeUndefined();
  });

  it("falls back to a generic message for a non-Error rejection", () => {
    const next = sweepCatchState(null, false, "oops");
    expect(next).toEqual({ rows: [], done: 0, total: 0, running: false, error: "sweep failed" });
  });
});

describe("list axes", () => {
  const op = listAxis("op:long.entry.0", [
    { label: "greater than", patch: { "op:long.entry.0": "gt" } },
    { label: "less than", patch: { "op:long.entry.0": "lt" } },
  ]);

  it("enumerates each option's patch and counts options", () => {
    expect(enumerateCombos([op])).toEqual([
      { "op:long.entry.0": "gt" }, { "op:long.entry.0": "lt" },
    ]);
    expect(comboCount([op])).toBe(2);
    expect(comboCount([listAxis("timeWindow", [])])).toBe(Infinity); // empty list blocks Run
  });

  it("spreads multi-key patches and crosses with a range axis", () => {
    const tw = listAxis("timeWindow", [
      { label: "morning", patch: { "timeWindow:startMin": 480, "timeWindow:endMin": 720, "timeWindow:tz": "UTC" } },
    ]);
    const combos = enumerateCombos([tw, axis("param:n", 1, 2, 1)]);
    expect(combos).toHaveLength(2);
    expect(combos[0]).toEqual({
      "timeWindow:startMin": 480, "timeWindow:endMin": 720, "timeWindow:tz": "UTC", "param:n": 1,
    });
  });

  it("resolves a row's option by patch-subset match", () => {
    expect(axisOptionFor(op, { "op:long.entry.0": "lt", "param:n": 3 })?.label).toBe("less than");
    expect(axisOptionFor(op, { "op:long.entry.0": "gte" })).toBeNull();
    expect(comboAxisText(op, { "op:long.entry.0": "gt" })).toBe("greater than");
    expect(comboAxisText(axis("param:n", 1, 2, 1), { "param:n": 1.5 })).toBe("1.5");
  });

  it("substitutes a rule value axis's x placeholder with the row's value", () => {
    const right = { ...axis("rule:long.entry.0.right.value", 0, 1, 0.5), label: "MA Slope 100 · SMA 9 > x" };
    expect(comboAxisLabel(right, { "rule:long.entry.0.right.value": 0 })).toBe("MA Slope 100 · SMA 9 > 0");
    expect(comboAxisLabel(right, { "rule:long.entry.0.right.value": -1 })).toBe("MA Slope 100 · SMA 9 > -1");
    // Collision-qualified suffix after the placeholder still substitutes.
    const qualified = { ...right, label: "Long 1 · SMA 9 > x (right)" };
    expect(comboAxisLabel(qualified, { "rule:long.entry.0.right.value": 0.5 })).toBe("Long 1 · SMA 9 > 0.5 (right)");
    const left = { ...axis("rule:long.entry.0.left.value", 0, 1, 0.5), label: "x < EMA 21" };
    expect(comboAxisLabel(left, { "rule:long.entry.0.left.value": 1 })).toBe("1 < EMA 21");
  });

  it("appends the value for axes without a placeholder", () => {
    expect(comboAxisLabel({ ...axis("param:n", 1, 2, 1), label: "Fast EMA" }, { "param:n": 2 })).toBe("Fast EMA 2");
    expect(comboAxisLabel({ ...axis("rule:long.entry.0.left.length", 5, 10, 5), label: "EMA 9 length" }, { "rule:long.entry.0.left.length": 5 })).toBe("EMA 9 length 5");
    // A value axis whose stored label lost its placeholder falls back to appending.
    expect(comboAxisLabel({ ...axis("rule:long.entry.0.right.value", 0, 1, 1), label: "threshold" }, { "rule:long.entry.0.right.value": 1 })).toBe("threshold 1");
    expect(comboAxisLabel(op, { "op:long.entry.0": "gt" })).toBe(`${op.label} greater than`);
  });

  it("strips the value placeholder for a per-axis column header", () => {
    const right = { ...axis("rule:long.entry.0.right.value", 0, 1, 0.5), label: "MA Slope 100 · SMA 9 > x" };
    expect(axisColumnLabel(right)).toBe("MA Slope 100 · SMA 9 >");
    const left = { ...axis("rule:long.entry.0.left.value", 0, 1, 0.5), label: "x < EMA 21" };
    expect(axisColumnLabel(left)).toBe("< EMA 21");
    // Non-value axes keep their label verbatim; the value reads under it.
    expect(axisColumnLabel({ ...axis("param:n", 1, 2, 1), label: "Fast EMA" })).toBe("Fast EMA");
    expect(axisColumnLabel({ ...axis("rule:long.entry.0.left.length", 5, 10, 5), label: "EMA 9 length" })).toBe("EMA 9 length");
  });
});

describe("period axes", () => {
  const period = { kind: "period" as const, target: "period", label: "Period", n: 2 };

  it("counts n and refuses to enumerate unmaterialized", () => {
    expect(comboCount([period])).toBe(2);
    expect(() => enumerateCombos([period])).toThrow(/materialized/);
  });

  it("materializes into n contiguous equal windows in unix seconds", () => {
    const fromMs = 1_700_000_000_000;
    const toMs = fromMs + 2 * 86_400_000;
    const [m] = materializePeriodAxes([period], fromMs, toMs);
    if (m.kind !== "list") throw new Error("expected list axis");
    expect(m.options).toHaveLength(2);
    expect(m.options[0].patch).toEqual({
      "period:from": 1_700_000_000, "period:to": 1_700_086_400,
    });
    expect(m.options[1].patch).toEqual({
      "period:from": 1_700_086_400, "period:to": 1_700_172_800,
    });
    expect(m.options[0].label).toMatch(/^W1/);
    // Non-period axes pass through untouched.
    const passthrough = axis("param:n", 1, 2, 1);
    expect(materializePeriodAxes([passthrough], fromMs, toMs)).toEqual([passthrough]);
  });
});

describe("opAxisTarget", () => {
  it("builds the op target path", () => {
    expect(opAxisTarget("long", "entry", 0)).toBe("op:long.entry.0");
    expect(opAxisTarget("short", "exit", 2)).toBe("op:short.exit.2");
  });
});
