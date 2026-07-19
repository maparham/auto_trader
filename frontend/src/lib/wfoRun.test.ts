import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { runWalkForward, readWfoMemo, resumeWfo, WFO_POLL_MS } from "./wfo";
import { wfoStateSignal } from "./signals";

const REQ = { epic: "X", resolution: "HOUR" } as unknown as api.BacktestRequest;
const WF: api.WalkForwardPayload = {
  combos: [{ "param:fast": 5 }],
  axes: [{ kind: "range", targets: ["param:fast"], values: [5] }],
  schedule: { mode: "rolling", trainSpan: "3m", testSpan: "1m" },
};
const DONE: api.WfoJobStatus = {
  phase: "done", done: 4, total: 4, running: false, cancelled: false, error: null,
  etaSeconds: null, foldRows: [{ key: "s0/f0", combo: { "param:fast": 5 }, oos_metrics: { net_pnl: 1 }, error: null }],
  result: { eval_mode: "sliced", objective: { metric: "sharpe", selection: "plateau" }, schedule: {}, axes: [], schemes: [] },
};

beforeEach(() => { vi.useFakeTimers(); sessionStorage.clear?.(); wfoStateSignal.set(null); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("runWalkForward", () => {
  it("submits, polls to done, streams states, clears memo", async () => {
    vi.spyOn(api, "submitWfoJob").mockResolvedValue({ jobId: "j1", total: 4, schemes: [] });
    const poll = vi.spyOn(api, "pollWfoJob")
      .mockResolvedValueOnce({ ...DONE, phase: "grid", running: true, done: 1, foldRows: [], result: null })
      .mockResolvedValueOnce(DONE);
    const states: string[] = [];
    const p = runWalkForward(REQ, WF, { onState: (s) => states.push(`${s.phase}:${s.done}`) });
    await vi.advanceTimersByTimeAsync(WFO_POLL_MS * 3);
    const result = await p;
    expect(result?.eval_mode).toBe("sliced");
    expect(states[0]).toBe("grid:1");
    expect(states.at(-1)).toBe("done:4");
    expect(poll).toHaveBeenCalledWith("j1", 0, "local");
    expect(readWfoMemo()).toBeNull();
  });

  it("abort cancels server job when shouldCancelServer", async () => {
    vi.spyOn(api, "submitWfoJob").mockResolvedValue({ jobId: "j1", total: 4, schemes: [] });
    vi.spyOn(api, "pollWfoJob").mockImplementation(
      () => new Promise((r) => setTimeout(() => r({ ...DONE, phase: "grid", running: true, result: null, foldRows: [] }), 100)),
    );
    const cancel = vi.spyOn(api, "cancelWfoJob").mockResolvedValue(undefined);
    const ctl = new AbortController();
    const p = runWalkForward(REQ, WF, { signal: ctl.signal, onState: () => {} });
    // Attach the rejection handler up front (sweep.test idiom) so the abort's
    // rejection during the timer advance never surfaces as an unhandled rejection.
    const assertion = expect(p).rejects.toThrow(/aborted/);
    await vi.advanceTimersByTimeAsync(WFO_POLL_MS);
    ctl.abort();
    await vi.advanceTimersByTimeAsync(WFO_POLL_MS * 2);
    await assertion;
    expect(cancel).toHaveBeenCalledWith("j1", "local");
  });
});

describe("resumeWfo", () => {
  it("returns false with no memo; re-attaches a finished job", async () => {
    expect(await resumeWfo()).toBe(false);
    vi.spyOn(api, "submitWfoJob").mockResolvedValue({ jobId: "j2", total: 4, schemes: [] });
    vi.spyOn(api, "pollWfoJob")
      .mockImplementationOnce(() => new Promise(() => {}))   // first run's poll never resolves
      .mockResolvedValue(DONE);                              // resume sees it done
    vi.spyOn(api, "cancelWfoJob").mockResolvedValue(undefined);
    const ctl = new AbortController();
    // Detach on close: keep the memo so a reload can re-attach (no server cancel).
    void runWalkForward(REQ, WF, { signal: ctl.signal, shouldCancelServer: () => false, onState: () => {} }).catch(() => {});
    await vi.advanceTimersByTimeAsync(WFO_POLL_MS);           // submit + first poll (hangs, job "running")
    expect(readWfoMemo()?.jobId).toBe("j2");
    ctl.abort();                                             // detach without server cancel
    expect(await resumeWfo()).toBe(true);
    expect(wfoStateSignal.value?.phase).toBe("done");
    expect(readWfoMemo()).toBeNull();
  });
});
