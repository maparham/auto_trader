// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { clearSweepJob, rememberSweepJob, resumeSweep, stopResumedSweep } from "./sweepResume";
import { runSweep, sweepCatchState } from "./sweep";
import { sweepStateSignal, sweepCancelServer, requestSweepCancel } from "./signals";

const oneComboAxis = [{ kind: "range" as const, target: "param:n", label: "n", from: 1, to: 1, step: 1 }];

const row = (n: number): api.SweepRow =>
  ({ combo: { "param:n": n }, metrics: null, error: null, windows: null });

const status = (over: Partial<api.SweepJobStatus>): api.SweepJobStatus => ({
  rows: [], done: 0, total: 0, running: true, cancelled: false, error: null, etaSeconds: null, ...over,
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  sessionStorage.clear();
  sweepStateSignal.set(null);
  sweepCancelServer.value = true; // default; requestSweepCancel/stopResumedSweep mutate it
});

describe("resumeSweep", () => {
  it("returns false and makes no api calls when nothing is remembered", async () => {
    const poll = vi.spyOn(api, "pollSweepJob");
    expect(await resumeSweep()).toBe(false);
    expect(poll).not.toHaveBeenCalled();
  });

  it("clears the memo and returns false when the poll rejects (job gone / 404)", async () => {
    rememberSweepJob("j1", "local");
    vi.spyOn(api, "pollSweepJob").mockRejectedValue(new Error("sweep poll failed (404)"));
    expect(await resumeSweep()).toBe(false);
    expect(sessionStorage.getItem("at.sweepJob")).toBeNull();
  });

  it("publishes the final state and clears the memo for an already-finished job", async () => {
    rememberSweepJob("j1", "remote");
    vi.spyOn(api, "pollSweepJob").mockResolvedValue(
      status({ rows: [row(1), row(2)], done: 2, total: 2, running: false }),
    );
    expect(await resumeSweep()).toBe(true);
    expect(sweepStateSignal.value).toMatchObject({ done: 2, total: 2, running: false });
    expect(sweepStateSignal.value?.rows).toHaveLength(2);
    expect(sweepStateSignal.value?.cancelled).toBeUndefined();
    expect(sweepStateSignal.value?.error).toBeUndefined();
    expect(sessionStorage.getItem("at.sweepJob")).toBeNull();
  });

  it("publishes running rows immediately then polls the running job to completion", async () => {
    vi.useFakeTimers();
    rememberSweepJob("j1", "local");
    let call = 0;
    vi.spyOn(api, "pollSweepJob").mockImplementation(async (_id, cursor) => {
      call++;
      if (call === 1) return status({ rows: [row(1)], done: 1, total: 3, running: true });
      if (call === 2) return status({ rows: [row(1), row(2)].slice(cursor), done: 2, total: 3, running: true });
      return status({ rows: [row(1), row(2), row(3)].slice(cursor), done: 3, total: 3, running: false });
    });
    expect(await resumeSweep()).toBe(true);
    expect(sweepStateSignal.value).toMatchObject({ running: true, done: 1 });
    await vi.advanceTimersByTimeAsync(700 * 2);
    expect(sweepStateSignal.value).toMatchObject({ running: false });
    expect(sweepStateSignal.value?.rows).toHaveLength(3);
    expect(sessionStorage.getItem("at.sweepJob")).toBeNull();
  });

  it("maps a foreign-cancelled re-attached job to cancelled, not an error", async () => {
    vi.useFakeTimers();
    rememberSweepJob("j1", "local");
    let call = 0;
    vi.spyOn(api, "pollSweepJob").mockImplementation(async (_id, cursor) => {
      call++;
      if (call === 1) return status({ rows: [row(1)], done: 1, total: 3, running: true });
      return status({ rows: [row(1)].slice(cursor), done: 1, total: 3, running: false, cancelled: true });
    });
    expect(await resumeSweep()).toBe(true);
    await vi.advanceTimersByTimeAsync(700);
    expect(sweepStateSignal.value).toMatchObject({ running: false, cancelled: true });
    expect(sweepStateSignal.value?.error).toBeUndefined();
  });

  it("cancels the server job and shows cancelled (not error) when a resumed job is Cancel'd", async () => {
    vi.useFakeTimers();
    rememberSweepJob("j1", "local");
    vi.spyOn(api, "pollSweepJob").mockImplementation(async (_id, cursor) =>
      status({ rows: [row(1)].slice(cursor), done: 1, total: 3, running: true }),
    );
    const cancel = vi.spyOn(api, "cancelSweepJob").mockResolvedValue(undefined as never);
    expect(await resumeSweep()).toBe(true);
    expect(sweepStateSignal.value).toMatchObject({ running: true, done: 1 });
    requestSweepCancel(true); // explicit Cancel: also kill the server job
    await vi.advanceTimersByTimeAsync(700);
    expect(cancel).toHaveBeenCalledWith("j1", "local");
    expect(sweepStateSignal.value).toMatchObject({ running: false, cancelled: true });
    expect(sweepStateSignal.value?.error).toBeUndefined();
    expect(sessionStorage.getItem("at.sweepJob")).toBeNull();
  });

  it("stopResumedSweep stops the poll without cancelling the server job or clearing the memo", async () => {
    vi.useFakeTimers();
    rememberSweepJob("j1", "local");
    const poll = vi.spyOn(api, "pollSweepJob").mockImplementation(async (_id, cursor) =>
      status({ rows: [row(1)].slice(cursor), done: 1, total: 3, running: true }),
    );
    const cancel = vi.spyOn(api, "cancelSweepJob").mockResolvedValue(undefined as never);
    expect(await resumeSweep()).toBe(true);
    const afterResume = poll.mock.calls.length;
    stopResumedSweep(); // takeover/detach: stop this poll, leave the job running
    await vi.advanceTimersByTimeAsync(700);
    await vi.advanceTimersByTimeAsync(700);
    expect(poll.mock.calls.length).toBe(afterResume); // no further polling
    expect(cancel).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("at.sweepJob")).not.toBeNull();
  });

  it("detach abort (Cancel with server=false) neither resurrects a torn-down state nor drops the memo", async () => {
    vi.useFakeTimers();
    rememberSweepJob("j1", "local");
    vi.spyOn(api, "pollSweepJob").mockImplementation(async (_id, cursor) =>
      status({ rows: [row(1)].slice(cursor), done: 1, total: 3, running: true }),
    );
    const cancel = vi.spyOn(api, "cancelSweepJob").mockResolvedValue(undefined as never);
    expect(await resumeSweep()).toBe(true);
    await vi.advanceTimersByTimeAsync(700); // let a batch land
    expect(sweepStateSignal.value).toMatchObject({ running: true });
    // The modal-close cleanup: tear the state down, then detach the poll.
    sweepStateSignal.set(null);
    requestSweepCancel(false);
    await vi.advanceTimersByTimeAsync(700 * 2);
    expect(sweepStateSignal.value).toBeNull(); // no ghost publish after teardown
    expect(cancel).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("at.sweepJob")).not.toBeNull(); // re-attachable
  });

  it("foreign backend cancel (no local abort) publishes cancelled and clears the memo", async () => {
    vi.useFakeTimers();
    rememberSweepJob("j1", "local");
    let call = 0;
    vi.spyOn(api, "pollSweepJob").mockImplementation(async (_id, cursor) => {
      call++;
      if (call === 1) return status({ rows: [row(1)], done: 1, total: 3, running: true });
      return status({ rows: [row(1)].slice(cursor), done: 1, total: 3, running: false, cancelled: true });
    });
    expect(await resumeSweep()).toBe(true);
    await vi.advanceTimersByTimeAsync(700);
    expect(sweepStateSignal.value).toMatchObject({ running: false, cancelled: true });
    expect(sweepStateSignal.value?.error).toBeUndefined();
    expect(sessionStorage.getItem("at.sweepJob")).toBeNull();
  });

  it("clearSweepJob removes the memo", () => {
    rememberSweepJob("j1", "local");
    expect(sessionStorage.getItem("at.sweepJob")).not.toBeNull();
    clearSweepJob();
    expect(sessionStorage.getItem("at.sweepJob")).toBeNull();
  });
});

describe("resumeSweep archives a sweep that completes on re-attach", () => {
  const archiveMeta = {
    epic: "CS.D.EURUSD.MINI.IP",
    timeframe: "HOUR",
    axes: oneComboAxis,
    windows: null,
  };

  it("archives an already-finished job with its remembered metadata + rows", async () => {
    rememberSweepJob("j1", "local", archiveMeta);
    vi.spyOn(api, "pollSweepJob").mockResolvedValue(
      status({ rows: [row(1), row(2)], done: 2, total: 2, running: false }),
    );
    const save = vi.spyOn(api, "saveSweepArchive").mockResolvedValue({ id: "a1" });
    expect(await resumeSweep()).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({
      epic: "CS.D.EURUSD.MINI.IP",
      timeframe: "HOUR",
      name: null,
      axes: oneComboAxis,
      rows: [row(1), row(2)],
      windows: null,
    });
  });

  it("archives a still-running job once it polls to completion", async () => {
    vi.useFakeTimers();
    rememberSweepJob("j1", "local", archiveMeta);
    let call = 0;
    vi.spyOn(api, "pollSweepJob").mockImplementation(async (_id, cursor) => {
      call++;
      if (call === 1) return status({ rows: [row(1)], done: 1, total: 2, running: true });
      return status({ rows: [row(1), row(2)].slice(cursor), done: 2, total: 2, running: false });
    });
    const save = vi.spyOn(api, "saveSweepArchive").mockResolvedValue({ id: "a1" });
    expect(await resumeSweep()).toBe(true);
    expect(save).not.toHaveBeenCalled(); // not yet: still running
    await vi.advanceTimersByTimeAsync(700);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0].rows).toHaveLength(2);
  });

  it("does NOT archive when the memo carries no metadata (old memo / not captured)", async () => {
    rememberSweepJob("j1", "local"); // no archive meta
    vi.spyOn(api, "pollSweepJob").mockResolvedValue(
      status({ rows: [row(1)], done: 1, total: 1, running: false }),
    );
    const save = vi.spyOn(api, "saveSweepArchive").mockResolvedValue({ id: "a1" });
    expect(await resumeSweep()).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });

  it("does NOT archive a cancelled re-attached job", async () => {
    rememberSweepJob("j1", "local", archiveMeta);
    vi.spyOn(api, "pollSweepJob").mockResolvedValue(
      status({ rows: [row(1)], done: 1, total: 2, running: false, cancelled: true }),
    );
    const save = vi.spyOn(api, "saveSweepArchive").mockResolvedValue({ id: "a1" });
    expect(await resumeSweep()).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });
});

describe("runSweep memo preservation on poll failure", () => {
  it("keeps the re-attach memo when polling fails 5 times (transport-exhausted)", async () => {
    vi.useFakeTimers();
    vi.spyOn(api, "submitSweepJob").mockResolvedValue({ jobId: "j9", total: 1 });
    vi.spyOn(api, "cancelSweepJob").mockResolvedValue(undefined as never);
    vi.spyOn(api, "pollSweepJob").mockRejectedValue(new Error("proxy 502"));

    const ctl = new AbortController();
    const p = runSweep({} as never, oneComboAxis, { onRows: () => {}, signal: ctl.signal });
    let err: unknown;
    p.catch((e) => { err = e; });
    await vi.advanceTimersByTimeAsync(700 * 5);
    await expect(p).rejects.toThrow("proxy 502");

    // The server job likely keeps running: the memo survives so a reload can
    // re-attach rather than orphaning it.
    expect(sessionStorage.getItem("at.sweepJob")).not.toBeNull();
    // The signal never aborted, so the caller renders this as an error, not a cancel.
    const state = sweepCatchState(null, ctl.signal.aborted, err);
    expect(state.error).toBe("proxy 502");
    expect(state.cancelled).toBeUndefined();
  });

  it("clears the memo on a backend-reported error", async () => {
    vi.useFakeTimers();
    vi.spyOn(api, "submitSweepJob").mockResolvedValue({ jobId: "j8", total: 1 });
    vi.spyOn(api, "cancelSweepJob").mockResolvedValue(undefined as never);
    vi.spyOn(api, "pollSweepJob").mockResolvedValue(
      status({ rows: [], done: 1, total: 1, running: false, error: "boom on the backend" }),
    );

    const p = runSweep({} as never, oneComboAxis, { onRows: () => {} });
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(700);
    await expect(p).rejects.toThrow("boom on the backend");

    expect(sessionStorage.getItem("at.sweepJob")).toBeNull();
  });
});
