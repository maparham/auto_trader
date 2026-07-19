import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";

function okJson(body: unknown) {
  return { ok: true, json: () => Promise.resolve(body) } as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe("wfo api", () => {
  it("submitWfoJob posts walkforward payload and returns schemes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ jobId: "j1", total: 9, schemes: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const req = { epic: "X" } as unknown as api.BacktestRequest;
    const wf: api.WalkForwardPayload = {
      combos: [{ "param:fast": 5 }],
      axes: [{ kind: "range", targets: ["param:fast"], values: [5, 10] }],
      schedule: { mode: "rolling", trainSpan: "3m", testSpan: "1m" },
    };
    const out = await api.submitWfoJob(req, wf, "local");
    expect(out.jobId).toBe("j1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/backtest/walkforward/jobs");
    expect(String(url)).not.toContain("target=remote");
    expect(JSON.parse((init as RequestInit).body as string).walkforward.schedule.trainSpan).toBe("3m");
  });

  it("pollWfoJob carries cursor and remote target", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({
      phase: "grid", done: 1, total: 9, running: true, cancelled: false,
      error: null, etaSeconds: 5, foldRows: [], result: null,
    }));
    vi.stubGlobal("fetch", fetchMock);
    const st = await api.pollWfoJob("j1", 3, "remote");
    expect(st.phase).toBe("grid");
    expect(String(fetchMock.mock.calls[0][0])).toContain("/walkforward/jobs/j1?cursor=3&target=remote");
  });

  it("fold table and archive endpoints hit the right URLs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ rows: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await api.getWfoFoldTable("j1", "s0/f2", "local");
    expect(String(fetchMock.mock.calls[0][0])).toContain("/fold?key=s0%2Ff2");
    fetchMock.mockResolvedValue(okJson([]));
    await api.listWfoArchives("EURUSD");
    expect(String(fetchMock.mock.calls[1][0])).toContain("/walkforward/archive?epic=EURUSD");
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve(undefined) } as Response);
    await api.deleteWfoArchive("a1");
    expect((fetchMock.mock.calls[2][1] as RequestInit).method).toBe("DELETE");
  });

  it("non-ok surfaces backend detail", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 422,
      json: () => Promise.resolve({ detail: "walkforward.combos is required" }),
      text: () => Promise.resolve(""),
    } as unknown as Response));
    await expect(api.submitWfoJob({} as never, { combos: [], axes: [], schedule: { mode: "rolling", trainSpan: "3m", testSpan: "1m" } }, "local"))
      .rejects.toThrow(/combos is required/);
  });
});
