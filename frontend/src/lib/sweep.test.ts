import { describe, expect, it, vi } from "vitest";
import { comboCount, enumerateCombos, mirrorRiskAxes, ruleAxisTarget, runSweep, sweepCatchState, SWEEP_CHUNK_SIZE } from "./sweep";
import * as api from "../api";

const axis = (target: string, from: number, to: number, step: number) =>
  ({ target, label: target, from, to, step });

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
});

describe("mirrorRiskAxes", () => {
  it("stamps long-side risk axes with their short mirror, passes others through", () => {
    const risk = axis("risk:long.target.mult", 1, 3, 1);
    const param = axis("param:n", 1, 2, 1);
    const [m, p] = mirrorRiskAxes([risk, param]);
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
      return combos.map((c) => ({ combo: c, metrics: null, error: null }));
    });
    const progress: number[] = [];
    const rows = await runSweep({} as never, combos45, {
      onRows: (_r, done) => progress.push(done),
    });
    expect(rows).toHaveLength(45);
    expect(calls).toEqual([20, 20, 20, 5]);          // second chunk retried
    expect(progress).toEqual([20, 40, 45]);
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
  const prev = { rows: [{ combo: { "param:n": 1 }, metrics: null, error: null }], done: 20, total: 45, running: true };

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
