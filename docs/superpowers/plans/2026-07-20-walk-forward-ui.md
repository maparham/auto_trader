# Walk-Forward Optimization UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Frontend for the walk-forward optimization backend: a third run mode (Backtest | Sweep | Walk-forward) with schedule config, live-streaming results (robustness scorecard, matrix strip, folds table, parameter drift, fold drill-in), stitched OOS equity + fold shading on the chart, and an archive with a robustness ranking view.

**Architecture:** Mirrors the sweep feature end to end: API client functions in `api.ts`, pure logic + run pipeline in `lib/wfo.ts` publishing a `wfoStateSignal`, mode/config integration in `BacktestSettingsModal.tsx`, a `WfoResults.tsx` sibling of `SweepResults.tsx`, and chart rendering via new exported helpers in `lib/backtest.ts` that reuse the existing equity-indicator and period-overlay machinery. The parameter grid is the existing sweep axes UI unchanged; walk-forward only adds the schedule block and a different executor.

**Tech Stack:** React 19 + TypeScript + Vite, hand-rolled `Signal` pub/sub, klinecharts 10 (via existing `lib/backtest.ts` machinery), vitest (+ @testing-library/react with per-file `// @vitest-environment jsdom` pragma), plain global CSS in `App.css`.

## Global Constraints

- Work directly on `main` (user rule: never branch unless asked).
- No em dashes ("—"/"--") in any UI copy or user-facing text.
- Plain-language UI copy; audience is educated traders (standard trading terms fine).
- Reuse shared components: `Tooltip`/`InfoTip` (never `title=`), `NumberField`, `SortHeader` idioms, existing `.seg`/`.seg-on`, `.modal-*`, `pos`/`neg` tone classes. No shadows; content-sized; light theme is canonical.
- Frontend dir: `/Users/mahmoudparham/auto_trader/frontend`. Tests: `npx vitest run <file>` from there; typecheck with `npx tsc --noEmit`.
- Vitest env is `node` by default; React component tests MUST start with `// @vitest-environment jsdom`.
- Fetch mocking idiom in lib tests: `vi.spyOn(api, "<fn>")`, never global fetch stubs; timers via `vi.useFakeTimers()` + `advanceTimersByTimeAsync`.
- Backend payloads: request DTOs are camelCase (`walkforward: {combos, axes, schedule:{mode,trainSpan,testSpan,step,minTrainTrades,minTestTrades}, objective:{metric,selection,composite}, matrixTrainSpans, evalMode}`); the `result` payload is snake_case inside camelCase envelopes. Jobs 404 one hour after completion; archive endpoints are the fallback. Fold-table key format `s{scheme}/f{fold}` via `?key=`. `combo: null` with `error: null` on a fold means "no eligible winner". Backend 422s WFO combos containing `period:`/`timeWindow:` targets and range axes without `values`.
- Commit after every task with `feat(wfo-ui):` prefix and the standard Claude trailer.

## File Structure

| File | Responsibility |
|---|---|
| `frontend/src/api.ts` (modify) | WFO job + archive client functions and payload/result types |
| `frontend/src/lib/wfo.ts` (new) | Schedule model + persistence, axes conversion, run pipeline, resume memo |
| `frontend/src/lib/signals.ts` (modify) | `wfoStateSignal`, `wfoRequestSignal`, `wfoCancelRequest`, equity/band toggles |
| `frontend/src/components/RunBar.tsx` (modify) | Third mode button |
| `frontend/src/lib/persist/defaults.ts` (modify) | `BacktestRunMode` third value, `loadWfoSchedule`/`saveWfoSchedule` |
| `frontend/src/BacktestButton.tsx` (modify) | Walk-forward run branch + chart render on completion |
| `frontend/src/BacktestSettingsModal.tsx` (modify) | Mode wiring, schedule section mount, results mount, footer dispatch |
| `frontend/src/WfoConfig.tsx` (new) | Schedule config section (spans, mode, objective) |
| `frontend/src/WfoResults.tsx` (new) | Scorecard, matrix strip, folds table, drift strip, fold drill-in, archive list |
| `frontend/src/lib/backtest.ts` (modify) | `renderWfoArtifacts`/`clearWfoArtifacts` (stitched equity + fold bands) |
| `frontend/src/App.css` (modify) | `.wfo-*` styles (folded into the tasks that need them) |

---

### Task 1: API client functions and types (`api.ts`)

**Files:**
- Modify: `frontend/src/api.ts` (after the sweep archive functions, ~line 657)
- Test: `frontend/src/lib/wfoApi.test.ts`

**Interfaces (Produces):**

```ts
// ---- walk-forward types -----------------------------------------------------
export interface WfoAxis {
  kind: "range" | "list";
  targets: string[];
  values?: number[];               // ordered swept values, range axes only
}
export interface WfoSchedule {
  mode: "rolling" | "anchored";
  trainSpan: string;               // backend token grammar: 10d, 2w, 3m, 500b
  testSpan: string;
  step?: string | null;
  minTrainTrades?: number;
  minTestTrades?: number;
}
export interface WfoObjective {
  metric: string;
  selection: "best" | "plateau";
  composite?: Record<string, number> | null;
}
export interface WalkForwardPayload {
  combos: Array<Record<string, number | boolean | string>>;
  axes: WfoAxis[];
  schedule: WfoSchedule;
  objective?: WfoObjective;
  matrixTrainSpans?: string[];
}
export interface WfoFoldRow {       // streamed winner row (job status foldRows)
  key: string;                      // "s0/f2"
  combo: Record<string, number | boolean | string> | null;
  oos_metrics: Record<string, number | null> | null;
  error: string | null;
}
export interface WfoFold {          // result payload, snake_case
  train_from: number; train_to: number; test_from: number; test_to: number;
  combo: Record<string, number | boolean | string> | null;
  is_metrics: Record<string, number | null> | null;
  oos_metrics: Record<string, number | null> | null;
  wfe: number | null;
  low_sample: boolean;
  error: string | null;
}
export interface WfoScheme {
  train_span: string;
  folds: WfoFold[];
  stitched: {
    equity: Array<[number, number]>;         // summed, [unix s, equity]
    equity_scaled: Array<[number, number]>;  // compounded
    trades: Array<{ entry_time: number; exit_time: number; pnl: number; side: string; fold: number }>;
    metrics: Record<string, number | null>;
  };
  stability: {
    per_axis: Record<string, { stability: number; adjacency: number; values: Array<number | string | null> }>;
    overall: number | null;
    adjacency: number | null;
  };
  robustness: Record<string, number | null>; // wfe_median, robustness_score, ...
}
export interface WfoResult {
  eval_mode: string;
  objective: WfoObjective;
  schedule: Record<string, unknown>;
  axes: WfoAxis[];
  schemes: WfoScheme[];
  grid_errors?: { failed: number; total: number; sample: string | null };
}
export interface WfoJobStatus {
  phase: "grid" | "test" | "aggregate" | "done";
  done: number; total: number;
  running: boolean; cancelled: boolean;
  error: string | null;
  etaSeconds: number | null;
  foldRows: WfoFoldRow[];
  result: WfoResult | null;
}
export interface WfoArchiveSummary {
  id: string; created_at: number; epic: string; timeframe: string;
  name: string | null; n_schemes: number | null;
  robustness_score: number | null; wfe_median: number | null;
}
```

Functions (each following the sweep-job idiom verbatim: `errorDetail` on non-ok, `?target=remote` query param):

```ts
const wfoJobsBase = (target: SweepTarget) =>
  `${BASE}/api/backtest/walkforward/jobs${target === "remote" ? "?target=remote" : ""}`;

export async function submitWfoJob(
  req: BacktestRequest, wf: WalkForwardPayload, target: SweepTarget,
): Promise<{ jobId: string; total: number; schemes: Array<{ trainSpan: string; folds: Array<Record<string, number>> }> }> {
  const res = await fetch(wfoJobsBase(target), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...req, walkforward: wf }),
  });
  if (!res.ok) throw new Error(await errorDetail(res, `walk-forward submit failed (${res.status})`));
  return res.json();
}

export async function pollWfoJob(jobId: string, cursor: number, target: SweepTarget): Promise<WfoJobStatus> {
  const res = await fetch(
    `${BASE}/api/backtest/walkforward/jobs/${jobId}?cursor=${cursor}${target === "remote" ? "&target=remote" : ""}`,
  );
  if (!res.ok) throw new Error(await errorDetail(res, `walk-forward poll failed (${res.status})`));
  return res.json();
}

export async function cancelWfoJob(jobId: string, target: SweepTarget): Promise<void> {
  const res = await fetch(
    `${BASE}/api/backtest/walkforward/jobs/${jobId}/cancel${target === "remote" ? "?target=remote" : ""}`,
    { method: "POST" },
  );
  if (!res.ok) throw new Error(await errorDetail(res, `walk-forward cancel failed (${res.status})`));
}

export async function getWfoFoldTable(jobId: string, key: string, target: SweepTarget): Promise<{ rows: SweepRow[] }> {
  const res = await fetch(
    `${BASE}/api/backtest/walkforward/jobs/${jobId}/fold?key=${encodeURIComponent(key)}${target === "remote" ? "&target=remote" : ""}`,
  );
  if (!res.ok) throw new Error(await errorDetail(res, `fold table fetch failed (${res.status})`));
  return res.json();
}

export async function listWfoArchives(epic?: string): Promise<WfoArchiveSummary[]> { /* GET /api/backtest/walkforward/archive?epic= */ }
export async function getWfoArchive(id: string): Promise<{ id: string; created_at: number; epic: string; timeframe: string; name: string | null; request: unknown; result: WfoResult }> { /* GET .../archive/{id} */ }
export async function getWfoArchiveTables(id: string): Promise<Record<string, SweepRow[]>> { /* GET .../archive/{id}/tables — response is the tables dict */ }
export async function deleteWfoArchive(id: string): Promise<void> { /* DELETE .../archive/{id} */ }
```

Write the archive four with full bodies following `listSweepArchives`/`getSweepArchive`/`deleteSweepArchive` (`api.ts:601-657`) exactly (same `errorDetail` fallbacks, `epic` as `?epic=` query param on list). Note `getWfoArchiveTables` returns the backend's tables payload; if the backend wraps it (check by reading `routers/backtest.py` archive tables handler), unwrap to the dict here so callers always get `Record<string, SweepRow[]>`.

- [ ] **Step 1: Write the failing test** (`frontend/src/lib/wfoApi.test.ts`, node env, global-fetch stub is acceptable here because we are testing the api module itself, not a consumer):

```ts
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
```

(If `errorDetail` reads `res.json()` vs `res.text()` differently, adapt the non-ok stub to whatever `lib/http.ts` actually reads — open it first.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/mahmoudparham/auto_trader/frontend && npx vitest run src/lib/wfoApi.test.ts`
Expected: FAIL (missing exports).

- [ ] **Step 3: Implement** the types and functions above in `api.ts`, full bodies, following the sweep idioms byte-for-byte.

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/lib/wfoApi.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api.ts frontend/src/lib/wfoApi.test.ts
git commit -m "feat(wfo-ui): walk-forward API client functions and types"
```

---

### Task 2: `lib/wfo.ts` pure core (schedule model, axes conversion, payload builder)

**Files:**
- Create: `frontend/src/lib/wfo.ts`
- Modify: `frontend/src/lib/persist/defaults.ts` (schedule persistence, next to `loadBacktestMode` ~line 170)
- Test: `frontend/src/lib/wfo.test.ts`

**Interfaces:**
- Consumes: `SweepAxis`/`RangeAxis`/`ListAxis` and `axisValues`, `enumerateCombos` from `lib/sweep.ts`; `WfoAxis`, `WalkForwardPayload`, `WfoSchedule`, `WfoObjective` from `api.ts`.
- Produces:

```ts
// lib/wfo.ts
export const TRAIN_SPAN_PICKS = ["2w", "1m", "3m", "6m"] as const;
export interface WfoConfigState {
  trainSpans: string[];          // >=1 selected; first = primary, rest = matrix
  testSpan: string;              // default "1m"
  step: string | null;           // null = testSpan
  mode: "rolling" | "anchored";  // default "rolling"
  metric: string;                // default "sharpe"
  selection: "best" | "plateau"; // default "plateau"
}
export const DEFAULT_WFO_CONFIG: WfoConfigState;
export function wfoAxesFromSweepAxes(axes: SweepAxis[]): { wfoAxes: WfoAxis[]; usable: SweepAxis[]; dropped: string[] };
  // RangeAxis -> {kind:"range", targets:[target, ...(mirrorTarget?[mirrorTarget]:[])], values: axisValues(a)}
  // ListAxis  -> {kind:"list", targets: Object.keys(options[0].patch)} — but DROP (into `dropped`, by label)
  //              any period axis (kind === "period") and any list axis whose option patches contain a key
  //              starting with "period:" or "timeWindow:" (backend 422s those in WFO combos).
  // `usable` = the surviving SweepAxis[] (feed to enumerateCombos); `dropped` = labels for a UI notice.
export function buildWalkForwardPayload(axes: SweepAxis[], cfg: WfoConfigState): { payload: WalkForwardPayload; comboTotal: number; dropped: string[] };
  // usable axes -> enumerateCombos; schedule = {mode, trainSpan: cfg.trainSpans[0], testSpan, step: cfg.step ?? undefined};
  // objective = {metric, selection}; matrixTrainSpans = cfg.trainSpans.slice(1).
  // Throws Error("add at least one parameter axis") when usable axes produce 0 axes,
  // and Error("select a training span") when cfg.trainSpans is empty.
```

- Persistence in `lib/persist/defaults.ts` (device-local, `saveLocal` idiom like `loadBacktestMode`):

```ts
const WFO_SCHEDULE_KEY = `${PREFIX}.wfoSchedule`;
export function loadWfoSchedule<T>(fallback: T): T { return load<T>(WFO_SCHEDULE_KEY, fallback); }
export function saveWfoSchedule<T>(cfg: T): void { saveLocal(WFO_SCHEDULE_KEY, cfg); }
```

(Generic over `T` so `defaults.ts` does not import UI types; `lib/wfo.ts` calls them with `WfoConfigState`.)

- [ ] **Step 1: Write the failing test** (`frontend/src/lib/wfo.test.ts`, node env):

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_WFO_CONFIG, buildWalkForwardPayload, wfoAxesFromSweepAxes } from "./wfo";
import type { SweepAxis } from "./sweep";

const range: SweepAxis = { kind: "range", target: "param:fast", label: "fast", from: 5, to: 15, step: 5 };
const list: SweepAxis = {
  kind: "list", target: "op:long.entry.0", label: "Op",
  options: [{ label: "gt", patch: { "op:long.entry.0": "gt" } }, { label: "lt", patch: { "op:long.entry.0": "lt" } }],
};
const period: SweepAxis = { kind: "period", target: "period", label: "Period", n: 4 };
const timeWin: SweepAxis = {
  kind: "list", target: "timeWindow", label: "Session",
  options: [{ label: "am", patch: { "timeWindow:startMin": 540, "timeWindow:endMin": 720 } as never }],
};

describe("wfoAxesFromSweepAxes", () => {
  it("converts range and list axes, drops period and timeWindow axes", () => {
    const { wfoAxes, usable, dropped } = wfoAxesFromSweepAxes([range, list, period, timeWin]);
    expect(wfoAxes).toEqual([
      { kind: "range", targets: ["param:fast"], values: [5, 10, 15] },
      { kind: "list", targets: ["op:long.entry.0"] },
    ]);
    expect(usable.map((a) => a.target)).toEqual(["param:fast", "op:long.entry.0"]);
    expect(dropped).toEqual(["Period", "Session"]);
  });

  it("includes mirrorTarget in range targets", () => {
    const mirrored: SweepAxis = { ...range, mirrorTarget: "risk:short.stop.value" } as SweepAxis;
    const { wfoAxes } = wfoAxesFromSweepAxes([mirrored]);
    expect(wfoAxes[0].targets).toEqual(["param:fast", "risk:short.stop.value"]);
  });
});

describe("buildWalkForwardPayload", () => {
  it("builds payload with matrix spans and combo total", () => {
    const cfg = { ...DEFAULT_WFO_CONFIG, trainSpans: ["3m", "1m"], testSpan: "2w", step: null };
    const { payload, comboTotal } = buildWalkForwardPayload([range, list], cfg);
    expect(comboTotal).toBe(6);
    expect(payload.combos).toHaveLength(6);
    expect(payload.schedule).toEqual({ mode: "rolling", trainSpan: "3m", testSpan: "2w", step: undefined });
    expect(payload.matrixTrainSpans).toEqual(["1m"]);
    expect(payload.objective).toEqual({ metric: "sharpe", selection: "plateau" });
  });

  it("throws on no usable axes / no train span", () => {
    expect(() => buildWalkForwardPayload([period], DEFAULT_WFO_CONFIG)).toThrow(/parameter axis/);
    expect(() => buildWalkForwardPayload([range], { ...DEFAULT_WFO_CONFIG, trainSpans: [] })).toThrow(/training span/);
  });
});
```

- [ ] **Step 2: Run to verify failure**: `npx vitest run src/lib/wfo.test.ts` — FAIL (module missing).

- [ ] **Step 3: Implement** `lib/wfo.ts` per the Interfaces block (import `axisValues`, `enumerateCombos` from `./sweep`; `DEFAULT_WFO_CONFIG = { trainSpans: ["3m"], testSpan: "1m", step: null, mode: "rolling", metric: "sharpe", selection: "plateau" }`), and add the two persistence functions to `lib/persist/defaults.ts`.

- [ ] **Step 4: Run tests + typecheck**: `npx vitest run src/lib/wfo.test.ts && npx tsc --noEmit` — PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/wfo.ts frontend/src/lib/wfo.test.ts frontend/src/lib/persist/defaults.ts
git commit -m "feat(wfo-ui): wfo config model, axes conversion, payload builder"
```

---

### Task 3: Run pipeline, signals, resume (`lib/wfo.ts` + `lib/signals.ts`)

**Files:**
- Modify: `frontend/src/lib/signals.ts` (next to the sweep signals, ~line 470)
- Modify: `frontend/src/lib/wfo.ts`
- Test: `frontend/src/lib/wfoRun.test.ts`

**Interfaces:**
- Consumes: `submitWfoJob`, `pollWfoJob`, `cancelWfoJob`, `WfoJobStatus`, `WfoFoldRow`, `WfoResult`, `SweepTarget` from `api.ts`.
- Produces in `lib/signals.ts`:

```ts
export interface WfoRunState {
  phase: "grid" | "test" | "aggregate" | "done";
  done: number; total: number;
  running: boolean;
  cancelled?: boolean;
  error?: string;
  etaSeconds?: number | null;
  foldRows: import("../api").WfoFoldRow[];
  result: import("../api").WfoResult | null;
  jobId?: string;
  startedAt?: number;
}
export const wfoStateSignal = new Signal<WfoRunState | null>(null);
// Modal -> BacktestButton handoff (one-shot request payload, cleared by the consumer):
export const wfoRequestSignal = new Signal<import("../api").WalkForwardPayload | null>(null);
export const wfoCancelRequest = new Signal<number>(0);
export const wfoCancelServer = { value: true };
export function requestWfoCancel(server = true): void { wfoCancelServer.value = server; wfoCancelRequest.set(wfoCancelRequest.value + 1); }
// chart toggles (mirror backtestEquityShownSignal idiom):
export const wfoEquityShownSignal = new Signal<boolean>(true);
export const wfoBandsShownSignal = new Signal<boolean>(true);
export const wfoEquityCompoundedSignal = new Signal<boolean>(true);
```

- Produces in `lib/wfo.ts`:

```ts
export const WFO_POLL_MS = 700;
export function runWalkForward(
  baseReq: BacktestRequest,
  wf: WalkForwardPayload,
  opts: {
    signal?: AbortSignal;
    target?: SweepTarget;                       // default "local"
    shouldCancelServer?: () => boolean;         // default () => true
    onState: (st: WfoRunState) => void;         // caller publishes to wfoStateSignal
  },
): Promise<WfoResult | null>;
// submit -> rememberWfoJob(jobId, target) -> poll loop (cursor over foldRows, tolerate
// 5 consecutive poll failures like pollToCompletion in sweep.ts:274) -> on final status:
// clearWfoJob(); return result (null when cancelled). On abort: cancel server job only
// when shouldCancelServer(); throw Error("walk-forward aborted").
export function rememberWfoJob(jobId: string, target: SweepTarget): void;  // sessionStorage "at.wfoJob"
export function readWfoMemo(): { jobId: string; target: SweepTarget } | null;
export function clearWfoJob(): void;
export async function resumeWfo(): Promise<boolean>;
// Re-attach on reload: read memo; pollWfoJob(jobId, 0); if 404/error -> clearWfoJob(), false.
// If finished -> publish a done WfoRunState to wfoStateSignal, clearWfoJob(), true.
// If running -> publish current state and start a poll loop wired to wfoCancelRequest/
// wfoCancelServer (mirror continueResume in lib/sweepResume.ts:120), true.
```

- [ ] **Step 1: Write the failing test** (`frontend/src/lib/wfoRun.test.ts`, node env, api spies + fake timers, mirroring `lib/sweep.test.ts` structure — read that file first):

```ts
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
    await vi.advanceTimersByTimeAsync(WFO_POLL_MS);
    ctl.abort();
    await expect(async () => { await vi.advanceTimersByTimeAsync(WFO_POLL_MS * 2); await p; }).rejects.toThrow(/aborted/);
    expect(cancel).toHaveBeenCalledWith("j1", "local");
  });
});

describe("resumeWfo", () => {
  it("returns false with no memo; re-attaches a finished job", async () => {
    expect(await resumeWfo()).toBe(false);
    vi.spyOn(api, "submitWfoJob").mockResolvedValue({ jobId: "j2", total: 4, schemes: [] });
    vi.spyOn(api, "pollWfoJob")
      .mockImplementationOnce(() => new Promise(() => {}))   // first run never finishes
      .mockResolvedValue(DONE);                              // resume sees it done
    const ctl = new AbortController();
    void runWalkForward(REQ, WF, { signal: ctl.signal, onState: () => {} }).catch(() => {});
    await vi.advanceTimersByTimeAsync(1);
    expect(readWfoMemo()?.jobId).toBe("j2");
    ctl.abort();                                             // detach without server cancel
    expect(await resumeWfo()).toBe(true);
    expect(wfoStateSignal.value?.phase).toBe("done");
    expect(readWfoMemo()).toBeNull();
  });
});
```

Notes for the implementer: node env has no `sessionStorage` — `lib/sweepResume.ts` already handles that (read how: it guards with try/catch or a feature check; mirror it, and if it uses a module-level fallback map in tests, do the same). The detach-abort in the resume test must NOT call `cancelWfoJob` (pass `shouldCancelServer: () => false` internally on abort when the abort came without a cancel request — simplest: `runWalkForward` only cancels when `opts.shouldCancelServer?.() ?? true`; the test's plain abort uses the default `true`, so pass `shouldCancelServer: () => false` in the test's second run if needed to keep the memo. Adapt the test to whichever contract you implement, keeping the FIRST test's memo-cleared assertion and the resume flow intact).

- [ ] **Step 2: Run to verify failure**: `npx vitest run src/lib/wfoRun.test.ts` — FAIL.

- [ ] **Step 3: Implement** the signals block in `lib/signals.ts` and the pipeline in `lib/wfo.ts`, closely mirroring `runSweep`/`pollToCompletion` (`lib/sweep.ts:274-399`) and `lib/sweepResume.ts` (memo key `"at.wfoJob"`).

- [ ] **Step 4: Run tests + typecheck**: `npx vitest run src/lib/wfoRun.test.ts src/lib/wfo.test.ts && npx tsc --noEmit` — PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/wfo.ts frontend/src/lib/signals.ts frontend/src/lib/wfoRun.test.ts
git commit -m "feat(wfo-ui): walk-forward run pipeline, signals, resume"
```

---

### Task 4: Third run mode (RunBar, persist, BacktestButton executor)

**Files:**
- Modify: `frontend/src/lib/persist/defaults.ts:171` (`BacktestRunMode`)
- Modify: `frontend/src/components/RunBar.tsx:19-55` (`RunMode`, `ModeSeg`)
- Modify: `frontend/src/BacktestButton.tsx` (run branch, ~line 360-435 where the sweep branch lives)
- Test: `frontend/src/components/RunBar.test.tsx` (extend or create), `frontend/src/lib/wfoRun.test.ts` untouched

**Interfaces:**
- Produces: `export type BacktestRunMode = "backtest" | "sweep" | "walkforward";` (persist/defaults.ts). `ModeSeg` renders three buttons: labels `Backtest`, `Sweep`, `Walk-fwd` (Tooltip on the third: "Walk-forward optimization: pick parameters on train windows, verify out-of-sample"); props unchanged (`mode`, `onSelectMode`, `modeBadge`); `modeBadge` renders inside whichever of Sweep/Walk-fwd is active (pass a second optional slot `wfoBadge?: ReactNode` rendered inside the Walk-fwd button).
- `BacktestButton.run()` walk-forward branch: when `wfoRequestSignal.value` is non-null at run time, consume it (`const wf = wfoRequestSignal.value; wfoRequestSignal.set(null)`), build the same `BacktestRequest` the sweep branch builds (same candles/series/config assembly — reuse the exact request object the sweep branch submits, minus the `sweep` field), then:

```ts
const ctl = new AbortController();
const unsub = wfoCancelRequest.subscribe(() => ctl.abort());
wfoStateSignal.set({ phase: "grid", done: 0, total: 0, running: true, foldRows: [], result: null, startedAt: Date.now() });
try {
  const result = await runWalkForward(req, wf, {
    signal: ctl.signal,
    target: sweepTargetSignal.value,
    shouldCancelServer: () => wfoCancelServer.value,
    onState: (st) => wfoStateSignal.set(st),
  });
  if (result) renderWfoOnChart(chart, result, 0);   // Task 7 provides this; until then, guard behind a typeof check or land the import in Task 7 — see note below
} catch (e) {
  wfoStateSignal.set(wfoCatchState(wfoStateSignal.value, ctl.signal.aborted, e));
} finally { unsub(); }
```

  Task ordering note: this task lands WITHOUT the `renderWfoOnChart` call (chart wiring is Task 7); leave a plain `void result;` there. Add `wfoCatchState(prev, aborted, err): WfoRunState` to `lib/wfo.ts` mirroring `sweepCatchState` (`lib/sweep.ts:401`).
- Read `BacktestButton.tsx` fully before editing: the sweep branch shows exactly where the request object is assembled and where `sweepStateSignal` publishes; the WFO branch is a sibling `if` BEFORE the sweep branch (a consumed `wfoRequestSignal` takes precedence; both never fire together because the modal sets only one).

- [ ] **Step 1: Write the failing test** (`frontend/src/components/RunBar.test.tsx`):

```tsx
// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModeSeg } from "./RunBar";

afterEach(cleanup);

describe("ModeSeg", () => {
  it("renders three modes and dispatches walkforward", () => {
    const onSelect = vi.fn();
    render(<ModeSeg mode="sweep" onSelectMode={onSelect} modeBadge={null} wfoBadge={null} />);
    const wfoBtn = screen.getByRole("button", { name: /walk-fwd/i });
    fireEvent.click(wfoBtn);
    expect(onSelect).toHaveBeenCalledWith("walkforward");
    expect(screen.getByRole("button", { name: /sweep/i })).toHaveAttribute("aria-pressed", "true");
  });

  it("marks walkforward active", () => {
    render(<ModeSeg mode="walkforward" onSelectMode={() => {}} modeBadge={null} wfoBadge={<span>3/9</span>} />);
    expect(screen.getByRole("button", { name: /walk-fwd/i })).toHaveAttribute("aria-pressed", "true");
  });
});
```

- [ ] **Step 2: Run to verify failure**: `npx vitest run src/components/RunBar.test.tsx` — FAIL (two-mode seg).

- [ ] **Step 3: Implement**: widen `BacktestRunMode`; update `RunMode` in RunBar (import the persisted type instead of redefining if trivial, else keep the local union in sync); add the third button + optional `wfoBadge` prop; add the BacktestButton branch + `wfoCatchState`. Existing callers of `ModeSeg` compile because `wfoBadge` is optional.

- [ ] **Step 4: Run**: `npx vitest run src/components/RunBar.test.tsx && npx tsc --noEmit` — PASS. Also run the full frontend suite once (`npx vitest run`) since `BacktestRunMode` widened: fix any exhaustiveness errors it flags (e.g. `bt-mode-${btMode}` CSS class sites are string-interpolating and fine).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/persist/defaults.ts frontend/src/components/RunBar.tsx frontend/src/components/RunBar.test.tsx frontend/src/BacktestButton.tsx frontend/src/lib/wfo.ts
git commit -m "feat(wfo-ui): third run mode and walk-forward executor branch"
```

---

### Task 5: Schedule config section (`WfoConfig.tsx`) and modal wiring

**Files:**
- Create: `frontend/src/WfoConfig.tsx`
- Modify: `frontend/src/BacktestSettingsModal.tsx` (mode wiring per anchors below)
- Modify: `frontend/src/App.css` (`.wfo-config` block)
- Test: `frontend/src/WfoConfig.test.tsx`

**Interfaces:**
- Produces:

```tsx
export function WfoConfig(props: {
  cfg: WfoConfigState;
  onChange: (next: WfoConfigState) => void;
  comboTotal: number;          // from buildWalkForwardPayload (0 when invalid)
  droppedAxes: string[];       // labels of period/timeWindow axes excluded in WFO mode
}): JSX.Element
```

Layout (one `.wfo-config` block, App.css styles: flat, content-sized, kebab `.wfo-*` classes, `pos`/`neg` tones only where meaningful):
  - "Train" row: four toggle chips (`TRAIN_SPAN_PICKS`), multi-select (`.seg`/`.seg-on` idiom); first selected is primary, extra selections = matrix mode; an `InfoTip` title="Training window" text={["How much history each fold optimizes on.", "Select several lengths to compare them in one run (matrix)."]}.
  - "Test" row: chips `1w / 2w / 1m` + rolling/anchored two-button seg with InfoTip ("Rolling slides a fixed train window; anchored grows it from the range start").
  - "Objective" row: metric `<select>` with options sharpe / sqn / net_pnl / return_pct / profit_factor, and Best/Plateau seg (plateau default) with InfoTip ("Plateau picks the cell whose neighborhood is good, not the luckiest single cell").
  - Advanced (collapsed `<details>`): step chips (`= test / 1w / 2w`).
  - Footer line: `{comboTotal} combos x {trainSpans.length} scheme(s)`; when `droppedAxes.length`, a `.wfo-note` line: `Period and session axes are ignored in walk-forward: {labels}`.
- Modal wiring (all anchors from the current file; re-locate by searching the quoted code if lines drifted):
  1. `BacktestSettingsModal.tsx:419-425` — `btMode` already types as `BacktestRunMode`; no change needed beyond the union widening.
  2. `:625` — change `const sweepEditable = btMode === "sweep"` to `const sweepEditable = btMode !== "backtest"` so the axes toggles work in walk-forward mode too. In `togglePeriodSweepAxis` (`:799`) and `toggleTimeWindowSweepAxis` (`:759`) add an early return when `btMode === "walkforward"`; also hide those two toggle buttons when `btMode === "walkforward"` (the period toggle renders at `:1792`).
  3. Add state: `const [wfoCfg, setWfoCfg] = useState<WfoConfigState>(() => loadWfoSchedule(DEFAULT_WFO_CONFIG));` and `const changeWfoCfg = (n: WfoConfigState) => { setWfoCfg(n); saveWfoSchedule(n); };`
  4. Mount `<WfoConfig ... />` directly under the sweep-axes section, rendered only when `btMode === "walkforward"`; compute `comboTotal`/`droppedAxes` via `buildWalkForwardPayload` in a `useMemo` wrapped in try/catch (0/[] on throw).
  5. `runFromFooter` (`:1478`): add a walk-forward branch before the sweep branch:

```ts
if (btMode === "walkforward") {
  try {
    const { payload } = buildWalkForwardPayload(mirrorRiskAxes(sweepAxes), wfoCfg);
    wfoRequestSignal.set(payload);
    sweepCombosOverrideSignal.set(null);
    run();
  } catch (e) {
    setFooterError(e instanceof Error ? e.message : String(e));  // reuse whatever error affordance runFromFooter's sweep branch uses; if none, add a local error state rendered next to the run button
  }
  return;
}
```

     Holdout clamp: apply the same `splitHoldout(...).trainToMs` clamp the sweep branch applies (`:1501`) to the request range — the walk-forward range must also respect the lockbox. The range flows through the request object BacktestButton builds, exactly as for sweeps (verify while reading `runFromFooter`: if the clamp happens via `resolveWindow`/config rather than signals, mirror that path).
  6. `runLabel`/`runDisabled` (`:1665`): walkforward mode label `Run walk-forward`, disabled when `comboTotal === 0 || wfoCfg.trainSpans.length === 0` or a wfo run is in progress (`wfoStateSignal.value?.running`).
  7. `modeSeg` (`:1613`): pass `wfoBadge` showing either live progress (`{phase} {done}/{total}` from `wfoStateSignal`) or `{comboTotal}x{schemes}` when idle.
  8. Mount-resume effect (next to `resumeSweep()` at `:844`): `if (wfoStateSignal.value === null) void resumeWfo();` and force `setBtMode("walkforward")` when a running wfo re-attaches (mirror `:845`).
  9. Modal-close cleanup (`:855` area): `requestWfoCancel(false)` alongside the sweep detach.

- [ ] **Step 1: Write the failing test** (`frontend/src/WfoConfig.test.tsx`):

```tsx
// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WfoConfig } from "./WfoConfig";
import { DEFAULT_WFO_CONFIG } from "./lib/wfo";

afterEach(cleanup);

describe("WfoConfig", () => {
  it("multi-selects train spans (matrix) and reports objective changes", () => {
    const onChange = vi.fn();
    render(<WfoConfig cfg={{ ...DEFAULT_WFO_CONFIG, trainSpans: ["3m"] }} onChange={onChange} comboTotal={12} droppedAxes={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "6m" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ trainSpans: ["3m", "6m"] }));
    fireEvent.click(screen.getByRole("button", { name: /best/i }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ selection: "best" }));
  });

  it("deselecting the last train span is blocked", () => {
    const onChange = vi.fn();
    render(<WfoConfig cfg={{ ...DEFAULT_WFO_CONFIG, trainSpans: ["3m"] }} onChange={onChange} comboTotal={1} droppedAxes={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "3m" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows combo math and dropped-axes note", () => {
    render(<WfoConfig cfg={{ ...DEFAULT_WFO_CONFIG, trainSpans: ["2w", "3m"] }} onChange={() => {}} comboTotal={40} droppedAxes={["Period"]} />);
    expect(screen.getByText(/40 combos/)).toBeTruthy();
    expect(screen.getByText(/2 scheme/)).toBeTruthy();
    expect(screen.getByText(/Period/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify failure**: `npx vitest run src/WfoConfig.test.tsx` — FAIL.

- [ ] **Step 3: Implement** `WfoConfig.tsx` + App.css block, then the 9 modal wiring points. The modal is 4400 lines: make each edit surgically at the quoted anchors, and run `npx tsc --noEmit` after each group.

- [ ] **Step 4: Run**: `npx vitest run src/WfoConfig.test.tsx && npx vitest run && npx tsc --noEmit` — PASS (full suite guards the modal edits).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/WfoConfig.tsx frontend/src/WfoConfig.test.tsx frontend/src/BacktestSettingsModal.tsx frontend/src/App.css
git commit -m "feat(wfo-ui): walk-forward schedule config and modal wiring"
```

---

### Task 6: Results panel core (`WfoResults.tsx`: scorecard, matrix strip, folds table, drift strip)

**Files:**
- Create: `frontend/src/WfoResults.tsx`
- Modify: `frontend/src/BacktestSettingsModal.tsx` (mount next to SweepResults, `:1574-1597` area)
- Modify: `frontend/src/App.css` (`.wfo-results` block)
- Test: `frontend/src/WfoResults.test.tsx`

**Interfaces:**
- Produces:

```tsx
export const WfoResults = memo(function WfoResults(props: {
  state: WfoRunState;                          // live or reconstructed-from-archive
  onApplyCombo: (combo: Record<string, number | boolean | string>) => void;
  onLoadFoldTable: (key: string) => Promise<SweepRow[]>;  // job or archive backed
  axes: SweepAxis[];                           // usable sweep axes for labels/heatmap
  schemeIndex: number;
  onSchemeIndex: (i: number) => void;
}): JSX.Element)
```

Sections, top to bottom (all data from `state.result?.schemes[schemeIndex]`; while running, show a progress header from `state` [phase label: `grid` -> "evaluating grid", `test` -> "testing winners", `aggregate` -> "aggregating"] with the `.sweep-progress` bar idiom and the streamed `state.foldRows` in the folds table with dates parsed from the row key + submit schemes when available; keep it simple: during a run show key/combo/OOS net columns only):
  1. **Scorecard**: robustness score as the lead stat card (0-100, tone `pos` >= 60, `neg` < 40), then WFE (median), % folds profitable, OOS Sharpe, OOS max DD, stability, OOS trades. Each an `InfoTip` (score tip lists the component weights; WFE tip: "Out-of-sample return relative to in-sample, annualized. Above ~0.5 is strong; negative means train gains did not carry forward"). When `state.result?.grid_errors` reports `failed === total`, render a `.wfo-error` banner: `All {total} combos failed: {sample}`.
  2. **Matrix strip** (only when `schemes.length > 1`): compact table, one row per scheme: train span, score, WFE, % profitable, OOS Sharpe, DD, stability; click selects `onSchemeIndex(i)`; selected row `.seg-on`-style highlight.
  3. **Folds table**: columns Window (test from-to dates via the app's date formatting; copy the `formatPeriodDateRange` usage from `lib/sweep.ts:161` area), Params (chosen combo via `comboAxisText(axes, combo)` from `lib/sweep.ts:209`), IS obj, OOS return %, OOS trades, WFE. Sortable using the local `SweepSortHeader` pattern (copy the 25-line component from `SweepResults.tssx:622` rather than importing a private symbol — or export it from SweepResults; exporting is preferred, do that). Rows with `low_sample` greyed (`.sweep-failed` class reuse); `combo === null && error === null` renders "no eligible winner"; `error` renders the error on hover (Tooltip). Row click calls `props.onLoadFoldTable(key)` and expands the drill-in (Task 8 fills the drill-in body; this task renders the fetched rows count as a placeholder line `Fold table: {n} combos` to keep the task independently testable).
  4. **Parameter drift strip**: for each entry in `stability.per_axis`: axis label, stability + adjacency numbers, and an inline SVG step-line (width 220, height 36, no shadows): x = fold index, y = the chosen value mapped onto the axis's sorted unique values from `per_axis[t].values` (nulls break the line). Pure helper `driftPath(values: Array<number | string | null>): string` exported for tests.
- Modal mount: inside `resultsBody` (`:1574`), sibling of the SweepResults mount, gated `btMode === "walkforward"` with the same CSS display:none show/hide idiom; props wired to `wfoStateSignal` mirror state, `applySweepComboStable` (same apply path: WFO combos are sweep-grammar combos), `onLoadFoldTable` = live job fetch via `getWfoFoldTable(state.jobId, key, target)`, axes = the `usable` axes memo from Task 5.

- [ ] **Step 1: Write the failing test** (`frontend/src/WfoResults.test.tsx`):

```tsx
// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WfoResults, driftPath } from "./WfoResults";
import type { WfoRunState } from "./lib/signals";

afterEach(cleanup);

const fold = (i: number, over: Partial<import("./api").WfoFold> = {}): import("./api").WfoFold => ({
  train_from: 1000 + i, train_to: 2000 + i, test_from: 2000 + i, test_to: 3000 + i,
  combo: { "param:fast": 5 + i }, is_metrics: { sharpe: 1.2 }, oos_metrics: { return_pct: 2.5, net_pnl: 25, n_trades: 12 },
  wfe: 0.7, low_sample: false, error: null, ...over,
});
const scheme = (span: string): import("./api").WfoScheme => ({
  train_span: span,
  folds: [fold(0), fold(1, { combo: null, error: null }), fold(2, { low_sample: true })],
  stitched: { equity: [[2000, 10000], [2999, 10100]], equity_scaled: [[2000, 10000], [2999, 10100]], trades: [], metrics: { sharpe: 1.1, max_drawdown_pct: 4.2 } },
  stability: { per_axis: { "param:fast": { stability: 0.8, adjacency: 1, values: [5, 6, 7] } }, overall: 0.8, adjacency: 1 },
  robustness: { robustness_score: 71.5, wfe_median: 0.7, pct_folds_profitable: 0.67, oos_sharpe: 1.1, oos_max_drawdown_pct: 4.2, param_stability: 0.8, oos_trades_total: 36 },
});
const doneState = (schemes = [scheme("3m")]): WfoRunState => ({
  phase: "done", done: 6, total: 6, running: false, foldRows: [],
  result: { eval_mode: "sliced", objective: { metric: "sharpe", selection: "plateau" }, schedule: {}, axes: [], schemes },
});

describe("WfoResults", () => {
  it("renders scorecard, folds incl. no-winner and low-sample rows", () => {
    render(<WfoResults state={doneState()} onApplyCombo={() => {}} onLoadFoldTable={() => Promise.resolve([])}
      axes={[{ kind: "range", target: "param:fast", label: "fast", from: 5, to: 15, step: 5 }]} schemeIndex={0} onSchemeIndex={() => {}} />);
    expect(screen.getByText("71.5")).toBeTruthy();
    expect(screen.getByText(/no eligible winner/i)).toBeTruthy();
    expect(document.querySelectorAll(".wfo-fold-row").length).toBe(3);
  });

  it("matrix strip appears for 2+ schemes and selects", () => {
    const onScheme = vi.fn();
    render(<WfoResults state={doneState([scheme("2w"), scheme("3m")])} onApplyCombo={() => {}} onLoadFoldTable={() => Promise.resolve([])}
      axes={[]} schemeIndex={0} onSchemeIndex={onScheme} />);
    fireEvent.click(screen.getByText("3m"));
    expect(onScheme).toHaveBeenCalledWith(1);
  });

  it("shows all-combos-failed banner", () => {
    const st = doneState();
    st.result = { ...st.result!, grid_errors: { failed: 4, total: 4, sample: "boom" } };
    render(<WfoResults state={st} onApplyCombo={() => {}} onLoadFoldTable={() => Promise.resolve([])} axes={[]} schemeIndex={0} onSchemeIndex={() => {}} />);
    expect(screen.getByText(/All 4 combos failed/)).toBeTruthy();
  });

  it("driftPath maps values to a polyline and breaks on null", () => {
    expect(driftPath([5, 6, 7])).toMatch(/^M/);
    expect(driftPath([5, null, 7]).match(/M/g)!.length).toBe(2);
    expect(driftPath([])).toBe("");
  });
});
```

- [ ] **Step 2: Run to verify failure**: `npx vitest run src/WfoResults.test.tsx` — FAIL.

- [ ] **Step 3: Implement** `WfoResults.tsx` (+ export `SweepSortHeader` from `SweepResults.tsx` and reuse it), App.css `.wfo-*` styles, and the modal mount.

- [ ] **Step 4: Run**: `npx vitest run src/WfoResults.test.tsx && npx vitest run && npx tsc --noEmit` — PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/WfoResults.tsx frontend/src/WfoResults.test.tsx frontend/src/SweepResults.tsx frontend/src/BacktestSettingsModal.tsx frontend/src/App.css
git commit -m "feat(wfo-ui): walk-forward results panel core"
```

---

### Task 7: Stitched OOS equity + fold shading on the chart (`lib/backtest.ts`)

**Files:**
- Modify: `frontend/src/lib/backtest.ts` (new exported functions near `renderArtifacts` ~line 1501)
- Modify: `frontend/src/BacktestButton.tsx` (call on completion + teardown on clear/mode switch)
- Test: `frontend/src/lib/wfoChart.test.ts`

**Interfaces:**
- Produces in `lib/backtest.ts`:

```ts
export function wfoEquityPoints(scheme: WfoScheme, compounded: boolean): Array<[number, number]>;
  // (compounded ? scheme.stitched.equity_scaled : scheme.stitched.equity).map(([s, v]) => [s * 1000, v])
export function wfoFoldBandPoints(scheme: WfoScheme): Array<{ from: number; to: number }>;
  // alternating test segments: every SECOND fold's [test_from*1000, test_to*1000] (alternating tint via skip)
export function renderWfoArtifacts(chart: Chart, scheme: WfoScheme): void;
  // teardownArtifacts(chart) first (one results overlay at a time), then:
  // - equity: reuse EQUITY_INDICATOR machinery — chart.createIndicator({ name: EQUITY_INDICATOR,
  //   extendData: wfoEquityPoints(scheme, wfoEquityCompoundedSignal.value) }, false), id into
  //   artifacts.equityIndicatorId; gated on wfoEquityShownSignal.value, re-rendered on
  //   wfoEquityShownSignal/wfoEquityCompoundedSignal changes (subscribe + store unsub in artifacts.unsub chain,
  //   exactly as renderArtifacts does with backtestEquityShownSignal at :1527).
  // - fold bands: ensurePeriodOverlayRegistered(); for each band from wfoFoldBandPoints,
  //   chart.createOverlay({ name: PERIOD_OVERLAY, lock: true, points: [{ timestamp: from }, { timestamp: to }] })
  //   (match the exact points shape drawPeriodBands at :910 uses — read it and mirror), ids into
  //   artifacts.periodBandIds; gated on wfoBandsShownSignal.
export function clearWfoArtifacts(chart: Chart): void;  // = teardownArtifacts(chart)
```

  All four are implemented INSIDE `lib/backtest.ts` where `artifactsByChart`, `teardownArtifacts`, `EQUITY_INDICATOR`, `PERIOD_OVERLAY`, `ensurePeriodOverlayRegistered` are already in scope; only the four names are exported. Pure helpers (`wfoEquityPoints`, `wfoFoldBandPoints`) carry the unit conversion so they are testable without a chart.
- `BacktestButton.tsx`: in the Task 4 walk-forward branch, replace `void result;` with `renderWfoArtifacts(chart, result.schemes[0])` (chart = the same chart handle the sweep/backtest paths use at that site). Also clear on mode-switch/new backtest: the existing `runAndRender`/`clearBacktest` paths already call `teardownArtifacts`, which covers WFO artifacts too (verify by reading `:1081` and `:1843`; no extra wiring needed if so — state the finding in the report). Scheme switching from `WfoResults` re-renders: subscribe in the modal (Task 6 mount site) is NOT needed; instead export a tiny helper from `BacktestButton` or call `renderWfoArtifacts` from the modal's `onSchemeIndex` handler with the active chart obtained the same way `applySweepCombo` reaches the chart (read how the modal triggers chart-affecting actions — it goes through signals to BacktestButton; mirror with a `wfoRenderRequest` Signal<{schemeIndex:number}|null> in `lib/signals.ts` consumed by BacktestButton). Keep it minimal: `wfoRenderRequest.set({ schemeIndex })` in the modal; BacktestButton subscribes once and re-renders from the stored last result.

- [ ] **Step 1: Write the failing test** (`frontend/src/lib/wfoChart.test.ts`, node env, pure helpers only):

```ts
import { describe, expect, it } from "vitest";
import { wfoEquityPoints, wfoFoldBandPoints } from "./backtest";

const scheme = {
  train_span: "3m",
  folds: [
    { test_from: 100, test_to: 200 }, { test_from: 200, test_to: 300 }, { test_from: 300, test_to: 400 },
  ],
  stitched: { equity: [[100, 10000], [199, 10100]], equity_scaled: [[100, 10000], [199, 10200]], trades: [], metrics: {} },
} as never;

describe("wfo chart helpers", () => {
  it("converts equity to ms and honors compounded flag", () => {
    expect(wfoEquityPoints(scheme, false)).toEqual([[100_000, 10000], [199_000, 10100]]);
    expect(wfoEquityPoints(scheme, true)[1][1]).toBe(10200);
  });
  it("bands alternate test segments in ms", () => {
    expect(wfoFoldBandPoints(scheme)).toEqual([
      { from: 100_000, to: 200_000 }, { from: 300_000, to: 400_000 },
    ]);
  });
});
```

- [ ] **Step 2: Run to verify failure**: `npx vitest run src/lib/wfoChart.test.ts` — FAIL.

- [ ] **Step 3: Implement** the four functions in `lib/backtest.ts`, the `wfoRenderRequest` signal, and the BacktestButton wiring (render on completion + re-render on `wfoRenderRequest` + confirm teardown coverage).

- [ ] **Step 4: Run**: `npx vitest run src/lib/wfoChart.test.ts && npx vitest run && npx tsc --noEmit` — PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/backtest.ts frontend/src/lib/wfoChart.test.ts frontend/src/lib/signals.ts frontend/src/BacktestButton.tsx frontend/src/BacktestSettingsModal.tsx
git commit -m "feat(wfo-ui): stitched OOS equity and fold shading on chart"
```

---

### Task 8: Fold drill-in (per-fold ranked table + heatmap via SweepResults)

**Files:**
- Modify: `frontend/src/WfoResults.tsx`
- Test: `frontend/src/WfoResults.test.tsx` (extend)

**Interfaces:**
- Consumes: `SweepResults` (already exported; props `{rows, axes, onApply, onRefine?, progress?}`) and `props.onLoadFoldTable(key): Promise<SweepRow[]>`.
- Produces: clicking a fold row toggles an expanded drill-in section under the folds table rendering `<SweepResults rows={foldRows} axes={props.axes} onApply={props.onApplyCombo} progress={null} />`, with a loading line while fetching and a `.wfo-error` line on fetch failure (the fold-table endpoint 404s an hour after the job; the error copy must say `Fold tables expire with the job; reopen from the archive`). Only one fold expanded at a time; fetched tables cached per key in component state.

- [ ] **Step 1: Write the failing test** (extend `WfoResults.test.tsx`):

```tsx
it("fold click loads ranked table into SweepResults drill-in", async () => {
  const rows = [{ combo: { "param:fast": 5 }, metrics: { net_pnl: 10, n_trades: 3, win_rate: 0.5, max_drawdown: 1 }, windows: null, error: null }];
  const load = vi.fn().mockResolvedValue(rows);
  render(<WfoResults state={doneState()} onApplyCombo={() => {}} onLoadFoldTable={load}
    axes={[{ kind: "range", target: "param:fast", label: "fast", from: 5, to: 15, step: 5 }]} schemeIndex={0} onSchemeIndex={() => {}} />);
  fireEvent.click(document.querySelectorAll(".wfo-fold-row")[0]);
  expect(load).toHaveBeenCalledWith("s0/f0");
  await screen.findByText(/fast/);          // SweepResults table rendered with axis labels
  fireEvent.click(document.querySelectorAll(".wfo-fold-row")[0]);   // collapse
  expect(load).toHaveBeenCalledTimes(1);    // cached, no refetch on re-expand
});

it("drill-in fetch failure shows expiry copy", async () => {
  const load = vi.fn().mockRejectedValue(new Error("wfo job not found"));
  render(<WfoResults state={doneState()} onApplyCombo={() => {}} onLoadFoldTable={load} axes={[]} schemeIndex={0} onSchemeIndex={() => {}} />);
  fireEvent.click(document.querySelectorAll(".wfo-fold-row")[0]);
  await screen.findByText(/reopen from the archive/i);
});
```

(The cache assertion: collapse then re-expand in the first test before asserting call count — add the second expand click.)

- [ ] **Step 2: Run to verify failure** — FAIL.
- [ ] **Step 3: Implement** the drill-in.
- [ ] **Step 4: Run**: `npx vitest run src/WfoResults.test.tsx && npx tsc --noEmit` — PASS.
- [ ] **Step 5: Commit**

```bash
git add frontend/src/WfoResults.tsx frontend/src/WfoResults.test.tsx
git commit -m "feat(wfo-ui): per-fold ranked table drill-in"
```

---

### Task 9: Archive list + robustness ranking view

**Files:**
- Create: `frontend/src/WfoArchive.tsx`
- Modify: `frontend/src/WfoResults.tsx` (mount archive when idle), `frontend/src/BacktestSettingsModal.tsx` (fold-table source switches to archive for reopened results)
- Test: `frontend/src/WfoArchive.test.tsx`

**Interfaces:**
- Produces:

```tsx
export function WfoArchive(props: {
  epic?: string;
  onOpen: (archive: { id: string; result: WfoResult }) => void;
}): JSX.Element
```

  - Loads `listWfoArchives(props.epic)` on mount (and undefined-epic "all" toggle). Renders the **ranking table**: sorted by `robustness_score` desc (nulls last); columns Score (lead, `pos`/`neg` toned, with an InfoTip explaining the composite), WFE, Schemes, Epic, TF, Date, Delete (`ConfirmDialog`-guarded like other destructive actions — read `ConfirmDialog.tsx` usage). Row click: `getWfoArchive(id)` then `props.onOpen`. Empty state copy: `No walk-forward runs yet. Results save here automatically when a run finishes.`
  - This IS the design's ranking view (design 9.4): score is the primary sort; net profit intentionally absent from summaries.
- Reopen flow: `WfoResults` gains an optional `archiveId?: string`; when the modal opens an archive (state `wfoArchiveOpen: {id, result} | null`), it renders `WfoResults` with a reconstructed done-state (`{phase:"done", done:0, total:0, running:false, foldRows:[], result}`) and `onLoadFoldTable = async (key) => (await getWfoArchiveTables(id))[key] ?? []` (fetch once, cache the dict). Archive shown inside the walk-forward results area when there is no live/last run (`wfoStateSignal.value === null && !wfoArchiveOpen`), plus a small `Archive` link-button in the WfoResults header to get back to the list.

- [ ] **Step 1: Write the failing test** (`frontend/src/WfoArchive.test.tsx`):

```tsx
// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { WfoArchive } from "./WfoArchive";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const SUMMARIES: api.WfoArchiveSummary[] = [
  { id: "a", created_at: 1, epic: "EURUSD", timeframe: "HOUR", name: null, n_schemes: 1, robustness_score: 40.0, wfe_median: 0.3 },
  { id: "b", created_at: 2, epic: "EURUSD", timeframe: "HOUR", name: null, n_schemes: 2, robustness_score: 82.5, wfe_median: 0.8 },
  { id: "c", created_at: 3, epic: "GOLD", timeframe: "HOUR", name: null, n_schemes: 1, robustness_score: null, wfe_median: null },
];

describe("WfoArchive", () => {
  it("ranks by robustness score desc, nulls last", async () => {
    vi.spyOn(api, "listWfoArchives").mockResolvedValue(SUMMARIES);
    render(<WfoArchive onOpen={() => {}} />);
    await waitFor(() => expect(screen.getByText("82.5")).toBeTruthy());
    const rows = document.querySelectorAll(".wfo-arch-row");
    expect(rows[0].textContent).toContain("82.5");
    expect(rows[2].textContent).toContain("GOLD");
  });

  it("opens an archive on row click", async () => {
    vi.spyOn(api, "listWfoArchives").mockResolvedValue([SUMMARIES[1]]);
    const full = { id: "b", created_at: 2, epic: "EURUSD", timeframe: "HOUR", name: null, request: {}, result: { eval_mode: "sliced", objective: { metric: "sharpe", selection: "plateau" }, schedule: {}, axes: [], schemes: [] } };
    vi.spyOn(api, "getWfoArchive").mockResolvedValue(full as never);
    const onOpen = vi.fn();
    render(<WfoArchive onOpen={onOpen} />);
    await waitFor(() => screen.getByText("82.5"));
    fireEvent.click(document.querySelector(".wfo-arch-row")!);
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "b" })));
  });

  it("shows empty state", async () => {
    vi.spyOn(api, "listWfoArchives").mockResolvedValue([]);
    render(<WfoArchive onOpen={() => {}} />);
    await waitFor(() => expect(screen.getByText(/No walk-forward runs yet/)).toBeTruthy());
  });
});
```

- [ ] **Step 2: Run to verify failure** — FAIL.
- [ ] **Step 3: Implement** `WfoArchive.tsx`, the reopen flow in the modal, App.css `.wfo-arch-*`.
- [ ] **Step 4: Run**: `npx vitest run src/WfoArchive.test.tsx && npx vitest run && npx tsc --noEmit` — PASS.
- [ ] **Step 5: Commit**

```bash
git add frontend/src/WfoArchive.tsx frontend/src/WfoArchive.test.tsx frontend/src/WfoResults.tsx frontend/src/BacktestSettingsModal.tsx frontend/src/App.css
git commit -m "feat(wfo-ui): archive list and robustness ranking view"
```

---

### Task 10: Live end-to-end verification (no new code expected)

**Files:** none planned (fix commits only if verification finds bugs).

This task is performed with the running app (backend `uvicorn` + frontend HMR dev server, which are normally already running: do NOT kill or restart them; check `http://localhost:5173` and `http://localhost:8000/docs` first). Use browser automation (claude-in-chrome) in the LIGHT theme. Checklist:

- [ ] **Step 1**: Open the backtest settings modal on a symbol with deep history (a yfinance daily/hourly market). Switch mode seg to Walk-fwd. Verify: sweep axes toggles work, period/session toggles hidden, WfoConfig renders with 3m default, combo math line correct.
- [ ] **Step 2**: Toggle 2+ params into axes (small grid, <= 30 combos), select train 2w + 1m (matrix), test 1w. Run. Verify: badge shows phase + progress; folds table streams winner rows; on completion the scorecard, matrix strip, folds table, drift strip all populate; stitched equity appears as a chart sub-pane with alternating fold shading; compounded/summed toggle changes the curve.
- [ ] **Step 3**: Click a fold row: ranked table + heatmap drill-in loads; apply a combo from it: mode flips to backtest and a backtest runs with those params (existing applySweepCombo behavior).
- [ ] **Step 4**: Reload the page mid-run (submit a bigger grid first): resume re-attaches and completes. Cancel a run: state shows cancelled, no result.
- [ ] **Step 5**: Verify infeasible schedule copy: pick 6m train on a symbol with ~4 months of data: submit 422 detail surfaces next to the run button.
- [ ] **Step 6**: Archive: after 1-2 completed runs, idle walk-forward view lists them ranked by score; reopen restores the full results incl. fold drill-in (served from archive tables); delete works with confirm.
- [ ] **Step 7**: Run the full frontend suite + typecheck one last time (`npx vitest run && npx tsc --noEmit`) and the backend suite (`cd ../backend && python -m pytest tests -q`). Commit any fixes found with `fix(wfo-ui):` prefixes.

---

## Self-Review Notes

- **Design doc section 9 coverage:** 9.1 config (Task 5 + WindowTimeline fold preview NOT included — deliberately deferred, the timeline extension is cosmetic and the submit response's scheme windows would drive it; noted as follow-up), 9.2 results panel items 1-7 (Tasks 6, 7, 8; IS-equity ghost curve deferred), 9.3 progress/resume/archive tab (Tasks 3, 9), 9.4 ranking (Task 9, summaries-backed).
- **Cross-task type consistency:** `WfoRunState` (Task 3) consumed by Tasks 4-9; `WfoConfigState`/`buildWalkForwardPayload` (Task 2) consumed by Task 5; `onLoadFoldTable(key) => Promise<SweepRow[]>` consistent across Tasks 6, 8, 9; `renderWfoArtifacts(chart, scheme)` + `wfoRenderRequest` (Task 7) consumed from BacktestButton.
- **Known deliberate scope cuts** (state in reports, do not silently expand): WindowTimeline fold-band preview; IS equity ghost overlay; per-fold heatmap "fold selector on the main heatmap" (drill-in per fold covers it); composite-objective editor UI (backend supports it; UI ships metric+selection only).
