// Deflated Sharpe Ratio (Bailey & Lopez de Prado): probability the true
// Sharpe is above 0 after discounting the expected max Sharpe of N trials.
import { describe, expect, it } from "vitest";
import type { SweepRow } from "../api";
import { expectedMaxSharpe, normCdf, normInv, probabilisticSharpe, withDsr } from "./deflatedSharpe";

function row(metrics: Partial<NonNullable<SweepRow["metrics"]>> | null, combo = {}): SweepRow {
  return { combo, metrics: metrics as SweepRow["metrics"], windows: null, error: metrics ? null : "boom" };
}

// A healthy row: 40 trades, per-trade SR 0.3 (sqn = 0.3 * sqrt(40)), mild
// negative skew, slightly fat tails.
function healthy(sqn = 0.3 * Math.sqrt(40)): SweepRow {
  return row({ sqn, n_trades: 40, trade_skew: -0.5, trade_kurtosis: 4 });
}

describe("normCdf / normInv", () => {
  it("matches known values", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(normCdf(1.959964)).toBeCloseTo(0.975, 4);
    expect(normCdf(-1.959964)).toBeCloseTo(0.025, 4);
  });

  it("normInv is the inverse of normCdf", () => {
    for (const p of [0.01, 0.25, 0.5, 0.9, 0.99]) {
      expect(normCdf(normInv(p))).toBeCloseTo(p, 5);
    }
  });
});

describe("expectedMaxSharpe", () => {
  it("is 0 when the trial Sharpes do not vary or there is one trial", () => {
    expect(expectedMaxSharpe(0, 100)).toBe(0);
    expect(expectedMaxSharpe(1, 1)).toBe(0);
  });

  it("grows with the number of trials", () => {
    const few = expectedMaxSharpe(0.04, 10);
    const many = expectedMaxSharpe(0.04, 1000);
    expect(few).toBeGreaterThan(0);
    expect(many).toBeGreaterThan(few);
  });
});

describe("probabilisticSharpe", () => {
  it("matches the hand formula for normal returns", () => {
    // skew 0, kurtosis 3 => denominator 1 + sr^2 / 2.
    const sr = 0.3, n = 40;
    const expected = normCdf((sr * Math.sqrt(n - 1)) / Math.sqrt(1 + sr ** 2 / 2));
    expect(probabilisticSharpe(sr, 0, n, 0, 3)).toBeCloseTo(expected, 10);
  });

  it("is 0.5 for a zero Sharpe against a zero benchmark", () => {
    expect(probabilisticSharpe(0, 0, 40, 0, 3)).toBeCloseTo(0.5, 8);
  });

  it("guards degenerate inputs", () => {
    expect(probabilisticSharpe(0.3, 0, 1, 0, 3)).toBeNull(); // n - 1 = 0
    // Pathological skew/kurtosis making the variance term non-positive.
    expect(probabilisticSharpe(2, 0, 40, 3, 1)).toBeNull();
  });
});

describe("withDsr", () => {
  it("injects a dsr probability in (0, 1) on valid rows", () => {
    const rows = withDsr([healthy(), healthy(0.1 * Math.sqrt(40))]);
    const d = rows[0].metrics?.dsr;
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(1);
  });

  it("deflates harder as more combos are tried", () => {
    // Same target row, once among 2 trials, once among 40 varied trials.
    const spread = (k: number) => Array.from({ length: k }, (_, i) => healthy((0.05 + 0.01 * i) * Math.sqrt(40)));
    const small = withDsr([healthy(), ...spread(1)]);
    const large = withDsr([healthy(), ...spread(39)]);
    expect(large[0].metrics!.dsr!).toBeLessThan(small[0].metrics!.dsr!);
  });

  it("skips rows without the needed inputs and excludes them from the trial count", () => {
    const rows = withDsr([healthy(), row(null), row({ sqn: null, n_trades: 5 })]);
    expect(rows[1].metrics).toBeNull();
    expect(rows[2].metrics?.dsr).toBeNull();
  });

  it("leaves dsr null when the trade moments are missing (old cached rows)", () => {
    const rows = withDsr([row({ sqn: 2, n_trades: 40 }), healthy()]);
    expect(rows[0].metrics?.dsr).toBeNull();
  });

  it("does not mutate the input rows", () => {
    const input = [healthy(), healthy(1)];
    withDsr(input);
    expect(input[0].metrics && "dsr" in input[0].metrics).toBe(false);
  });
});
