# Backtest Bar Rule Inspector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let a user toggle "Inspect" in the Backtest panel and click any bar inside the run to see every rule group's terms (with pass/fail), the AND/OR verdict, and the engine's outcome + gate reason for that bar.

**Architecture:** The backend engine, when `inspect=True`, records a per-bar trace (all four rule groups evaluated with pass/fail, plus the engine gate outcome) alongside the result. It rides the `/api/backtest` response only when requested. The frontend holds the trace in memory (session-only, never persisted), and a new `BacktestInspectorPanel` renders the clicked bar's trace. No rule logic runs in the browser.

**Tech Stack:** Python 3.11 (FastAPI, dataclasses, pytest) backend; React + TypeScript (klinecharts, vitest) frontend.

## Global Constraints

- Timestamps are UTC; `Candle.time` is the bar OPEN time. Trace `time` is unix seconds.
- `inspect=False` (default) must add **zero** cost to a normal run and return `bar_traces=None`.
- Trace is **session-only**: returned in the response, held in a frontend `Signal`, never written to `localStorage` (`persist/artifacts.ts` untouched for trace).
- Reuse existing term display (`signalGlyphs.ts` `termLabel`/`opSymbol`, `BacktestSignalPopover` row styling). Only extend types with a `pass` field.
- Work on `main` directly. No backward-compat/migration code.

---

## File Structure

**Backend**
- `core/models.py` — add `InspectorTerm`, `BarGroupTrace`, `BarTrace`.
- `strategy/rule.py` — add `inspect_groups(ctx, i)` producing `tuple[BarGroupTrace, ...]` with all terms + pass.
- `engine/backtest.py` — `inspect` flag on engine; per-bar capture; `BacktestResult.bar_traces`.
- `api/schemas.py` — `InspectorTermDTO`, `BarGroupTraceDTO`, `BarTraceDTO`; `inspect` on request; `bar_traces` on response.
- `api/routers/backtest.py` — thread `inspect` into `_run_rule`/engine; map + window-trim `bar_traces`.
- `tests/` — `test_backtest_inspector.py`.

**Frontend**
- `lib/api.ts` — `InspectorTerm`, `BarGroupTrace`, `BarTrace` types; `inspect` on request; `bar_traces` on result; map in the fetch.
- `lib/backtestInspect.ts` (new) — in-memory `Signal<Map<number, BarTrace>>` store + helpers (set/clear/lookup by bar time).
- `BacktestInspectorPanel.tsx` (new) — renders a `BarTrace`.
- `BacktestPanel.tsx` — "Inspect" toggle + wire selected-bar state + mount the panel.
- `ChartCore.tsx` — inspect-mode click → bar timestamp via `convertFromPixel`; publish to a signal.
- tests: `BacktestInspectorPanel.test.tsx`.

---

## Task 1: Backend trace models

**Files:** Modify `backend/auto_trader/core/models.py`. Test `backend/tests/test_backtest_inspector.py`.

**Produces:** `InspectorTerm(left_label,left_val,op,right_label,right_val,left_tf,right_tf,passed)`, `BarGroupTrace(group,combine,terms,passed)`, `BarTrace(bar_index,time,groups,action,reason,in_position_long,in_position_short,window_active,warmed_up,spacing_ok)`.

- [ ] Add the three frozen dataclasses to `core/models.py` (after `RuleTerm`). `group` is one of `"longEntry"|"shortEntry"|"longExit"|"shortExit"`; `action` is `"opened"|"suppressed"|"none"`; `reason: str | None`; `spacing_ok: bool | None`.
- [ ] Commit.

## Task 2: `RuleStrategy.inspect_groups`

**Files:** Modify `strategy/rule.py`. Test `test_backtest_inspector.py`.

**Consumes:** Task 1 models. **Produces:** `RuleStrategy.inspect_groups(ctx, i) -> tuple[BarGroupTrace, ...]` — the four groups in order longEntry, shortEntry, longExit, shortExit, each with **all** rules captured (pass/fail) via `_all_terms`.

- [ ] **Step 1 (test):** With a strategy whose `longEntry` is `EMA... gt const` etc., call `inspect_groups(ctx, i)` at a bar where one term is true and one false; assert 4 groups returned, longEntry `terms` has the right pass booleans and values, `passed` matches the AND/OR rollup.
- [ ] **Step 2:** Run → fails (no method).
- [ ] **Step 3 (impl):** Add `_all_terms(group, ctx, i, side) -> tuple[InspectorTerm, ...]` — like `_terms` but no `if not passed: continue`; capture each rule's `passed = self._base_true_at(r, ctx, i, side)` (raw comparison, count-agnostic — inspector shows the bar's comparison), values via `_operand_values`, labels/tf via `_term_label`/`_operand_timeframe`. Add `inspect_groups` calling `_eval_group` for each group's `passed` and `_all_terms` for terms, tagging the group name. Empty-rule group → `terms=(), passed=False`.
- [ ] **Step 4:** Run → passes.
- [ ] **Step 5:** Commit.

## Task 3: Engine per-bar capture

**Files:** Modify `engine/backtest.py`. Test `test_backtest_inspector.py`.

**Consumes:** Tasks 1-2. **Produces:** `BacktestEngine(..., inspect=False)`; `BacktestResult.bar_traces: list[BarTrace]` (empty unless inspect).

Design (cross-bar): the signal for bar `i` fills at `i+1`. During the loop capture per-bar snapshots; after the loop, resolve `action`/`reason` from `result.fills` (which carry `signal_time`).

- [ ] **Step 1 (test):** A run reproducing the real scene — a long opens at bar E, `longEntry` stays true for later bars while the position is held. Assert: bar E trace `action=="opened"`; a later held bar with `longEntry.passed` has `action=="suppressed"`, `reason=="already in position"`, `in_position_long is True`. A separate run with a session mask inactive at a passing bar → `reason=="outside session window"`, `window_active is False`.
- [ ] **Step 2:** Run → fails.
- [ ] **Step 3 (impl):**
  - Add `inspect` param to `__init__`, store `self.inspect`.
  - Add `bar_traces: list[BarTrace] = field(default_factory=list)` to `BacktestResult`.
  - Inside the loop, when `self.inspect` and the strategy has `inspect_groups`, after the ctx updates (~line 211) append a snapshot dict: `{i, time, groups: strategy.inspect_groups(ctx, i), in_long: ctx.position_long>0, in_short: ctx.position_short>0, window_i: active}`.
  - After the main loop, build `result.bar_traces`: for each snapshot at index `i`:
    - `opened = any(f for f in result.fills if f.signal_time == snap.time and ((f.leg=="long" and f.side is Side.BUY) or (f.leg=="short" and f.side is Side.SELL)))`.
    - `entry_pass_long = group longEntry.passed`; `entry_pass_short = shortEntry.passed`.
    - `action/reason`: if `opened` → `("opened", None)`. Elif an entry group passed → `"suppressed"` with reason by engine precedence for the fill bar `i+1` (guard `i+1 < len(candles)`, else treat window inactive):
      - `next_active = is_active(self.mask, candles[i+1].time)`; if not `next_active` → `"outside session window"`;
      - elif (`entry_pass_long and snap.in_long`) or (`entry_pass_short and snap.in_short`) → `"already in position"`;
      - else → `"spacing or position cap"`.
    - else → `("none", None)`.
    - `warmed_up = all(t.left_val is not None and t.right_val is not None for g in snap.groups if g.passed or g.group in ("longEntry","shortEntry") for t in g.terms)` (True when nothing relevant was None; treat empty as True).
    - `spacing_ok`: `None` for MVP unless `action=="suppressed"` and reason endswith "cap" → `False`.
    - Append `BarTrace(...)`.
- [ ] **Step 4:** Run → passes.
- [ ] **Step 5:** Commit.

## Task 4: API schema + route

**Files:** Modify `api/schemas.py`, `api/routers/backtest.py`. Test `test_backtest_inspector.py` (route-level via TestClient) or extend existing API test.

**Consumes:** Task 3. **Produces:** request `inspect: bool = False`; response `bar_traces: list[BarTraceDTO] | None = None`.

- [ ] **Step 1 (test):** POST `/api/backtest` with `inspect: true` on a small rule run returns `bar_traces` non-null with one entry per windowed bar, each having 4 `groups`; with `inspect` omitted returns `bar_traces == None`.
- [ ] **Step 2:** Run → fails.
- [ ] **Step 3 (impl):** Add DTOs `InspectorTermDTO(left,lval,op,right,rval,leftTf,rightTf,pass_ field aliased "pass")`, `BarGroupTraceDTO(group,combine,terms,passed)`, `BarTraceDTO(time,groups,action,reason,inPositionLong,inPositionShort,windowActive,warmedUp,spacingOk)`. (`pass` is a Python keyword → use `Field(alias="pass")` with `populate_by_name`.) Add `inspect: bool = False` to `BacktestRequest`; `bar_traces: list[BarTraceDTO] | None = None` to `BacktestResponse`. Thread `inspect=req.inspect` into `_run_rule`→`BacktestEngine(..., inspect=req.inspect)`. In the route, when `req.inspect`, map `result.bar_traces` to DTOs, keeping only bars with `time >= req.tradeFromTime` (window trim, matching equity). Coded strategies: `inspect` yields gate-only traces (no `inspect_groups`) → `bar_traces` stays empty list; return `None` if empty to keep the shape simple.
- [ ] **Step 4:** Run → passes. Also run full backend suite: `pytest -q`.
- [ ] **Step 5:** Commit.

## Task 5: Frontend types + fetch mapping

**Files:** Modify `frontend/src/lib/api.ts`. Test `frontend/src/lib/api.test.ts` if present, else fold into panel test.

**Produces:** `InspectorTerm`, `BarGroupTrace`, `BarTrace` TS types; `runBacktest` (or equivalent) forwards `inspect` and maps `bar_traces` → camelCase `barTraces?: BarTrace[]`.

- [ ] Add types mirroring the DTOs (camelCase; `pass: boolean` on `InspectorTerm`). Add optional `inspect?: boolean` to the request builder and `barTraces?: BarTrace[]` to the result type; map the response array (snake→camel) in the fetch function. Guard: `bar_traces` may be null → `undefined`.
- [ ] Run `npm run build`/`tsc --noEmit` (frontend) to typecheck. Commit.

## Task 6: In-memory trace store

**Files:** Create `frontend/src/lib/backtestInspect.ts`.

**Consumes:** Task 5 types. **Produces:** `inspectTraceSignal: Signal<Map<number, BarTrace> | null>`, `setInspectTraces(barTraces?: BarTrace[])`, `clearInspectTraces()`, `traceAt(time: number): BarTrace | undefined`, plus `inspectSelectedBarSignal: Signal<number | null>` (selected bar time) and `inspectModeSignal: Signal<boolean>`.

- [ ] Implement using the app's `Signal` primitive (match existing `backtestSignalHoverSignal` pattern in `signalGlyphs.ts`/`signals.ts`). `setInspectTraces` builds a `Map` keyed by `barTrace.time`. Clear on new run. Commit.

## Task 7: Inspector panel component

**Files:** Create `frontend/src/BacktestInspectorPanel.tsx`. Test `frontend/src/BacktestInspectorPanel.test.tsx`.

**Consumes:** Tasks 5-6. **Produces:** `<BacktestInspectorPanel />` reading `inspectSelectedBarSignal` + `traceAt`.

- [ ] **Step 1 (test):** Render with a stub trace (selected bar set): asserts group headings for all four groups, a failing term shows the ✗ state and both values, the AND/OR verdict text, and the outcome chip + reason (e.g. "already in position"). A selected bar with no trace → muted "not in backtest range".
- [ ] **Step 2:** Run vitest → fails.
- [ ] **Step 3 (impl):** Build the panel: header with bar time; four group cards ordered relevant-first (entry groups first when the bar's `inPosition{Long,Short}` is false, else exit groups first); each card = term rows reusing `termLabel`/`opSymbol` with a pass/fail dot and `lval`/`rval` (render `—` for null), then the group's `combine` verdict; footer = outcome chip (`opened`/`suppressed`/`no signal`) + `reason` + the four gate checks (window/position/warmed/spacing). No-trace/out-of-range → muted state. Use existing App.css popover classes where possible; add minimal scoped styles.
- [ ] **Step 4:** Run vitest → passes.
- [ ] **Step 5:** Commit.

## Task 8: Panel toggle + chart wiring

**Files:** Modify `frontend/src/BacktestPanel.tsx`, `frontend/src/ChartCore.tsx`.

**Consumes:** Tasks 6-7.

- [ ] `BacktestPanel.tsx`: add an "Inspect" toggle next to the "Periods" control; bind to `inspectModeSignal`; disable with a hint when there is no trace for the current run (`inspectTraceSignal` null) — tooltip "Re-run to inspect". Mount `<BacktestInspectorPanel />` (e.g. an "Inspect" results tab or a section shown when a bar is selected). Ensure the run path sets `inspect: true` in the request when `inspectModeSignal` is on, and calls `setInspectTraces(result.barTraces)` / `clearInspectTraces()` appropriately.
- [ ] `ChartCore.tsx`: when `inspectModeSignal` is on, a candle-pane click maps to a bar timestamp via the existing `convertFromPixel` pattern and sets `inspectSelectedBarSignal`; add a thin highlight of the hovered bar and an inspect cursor. Don't disturb existing click behavior when inspect is off.
- [ ] Typecheck + run relevant vitest. Commit.

## Task 9: Manual verification in the app

- [ ] Reproduce the original scene (US_TECH100 5m, June): turn Inspect on, re-run, click the 08:25 bar; confirm the panel shows the long-entry group true, the outcome "suppressed — already in position", and the gate checks. Click a bar outside the run → muted state. Toggle Inspect off → normal chart clicks resume.
- [ ] Update memory with a pointer to this feature.

---

## Self-Review

- **Spec coverage:** trace model (T1), all-terms eval (T2), engine gates + action/reason (T3), API opt-in + window trim (T4), FE types (T5), session-only store (T6), panel all-groups relevant-first + out-of-range (T7), toggle-then-click + re-run prompt (T8), manual repro (T9). Coded-strategy gate-only path covered in T4.
- **Placeholders:** none — each task carries concrete code/assertions.
- **Type consistency:** `InspectorTerm.passed` (backend) ↔ DTO `pass` alias ↔ FE `pass`; `BarTrace` field names consistent backend snake ↔ DTO camel ↔ FE camel; `inspect_groups` name used in T2/T3; `setInspectTraces`/`traceAt`/`inspectSelectedBarSignal`/`inspectModeSignal` consistent T6-T8.
