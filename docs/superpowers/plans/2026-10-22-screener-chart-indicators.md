# Screener Chart Indicators Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a screen's condition and columns reference chart indicator panes (`RSI.bullDiv`) with the pane's full settings, computed by the backend on every screened symbol.

**Architecture:** Reuse the backtest's instance plumbing end to end. Backend: the run/save bodies carry the backtest's `indicators` map, `compile_screen` resolves and validates it, `judge` passes it to the evaluator, the store persists it. Frontend: the screen keeps a copy of referenced pane payloads; the editor offers copy plus active-chart panes; a generic pick hook (split out of the backtest's) inserts a clicked pane's token.

**Tech Stack:** FastAPI + pydantic v2, stdlib sqlite3, pytest; React 19 + TypeScript, vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-22-screener-chart-indicators-design.md`

## Global Constraints

- Commit directly on `main`, staging files by explicit path. Never stash, clean or restore.
- Never use em dashes or `--` in UI text, comments or commit messages.
- Run only the affected test files. Never the full frontend suite. `npx tsc -b` and `npx eslint <files>` from `frontend/` must report zero errors.
- Backend tests: `cd backend && python3 -m pytest tests/<file> -q`.
- Tooltips use `InfoTip` / `Tooltip`, never `title=`. Tip text is `string[]` of short lines.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Indicators map limits: at most 16 entries, at most 32768 bytes of JSON, every type registered in `SERIES_INDICATORS`.
- Judging concurrency: a per-runner compute semaphore of 2.

## Review Focus

1. A saved screen loaded while a different chart is focused, where that chart has a pane with the same id but other settings: Run must apply the screen's copy, not the chart's. (Task 5 `screenPayload` test, Task 6 panel test.)
2. A screen that references nothing must send `indicators: {}` and behave exactly as before. (Task 1 existing tests unchanged, Task 6 panel test.)
3. An old `screens.db` created before this change must open, list, update and keep its rows. (Task 3 migration test.)
4. A column expression referencing a pane (`RSI.value`) is judged with the instance, not refused. (Task 1 test.)
5. Cancel during a heavy run must not keep starting new judges. (Task 2 test.)

---

### Task 1: Instances in the screen evaluator

**Files:**
- Modify: `backend/auto_trader/core/screen_eval.py`
- Test: `backend/tests/test_screen_eval.py`

**Interfaces:**
- Produces: `compile_screen(expression: str, columns: list[dict], indicators: dict[str, dict] | None = None) -> CompiledScreen`; `CompiledScreen` gains a required last field `instances: dict[str, ResolvedInstance]`; `compile_screen` is its only constructor. `judge` signature unchanged.

- [ ] **Step 1: Write the failing tests** (append to `tests/test_screen_eval.py`)

```python
RSI_PANE = {"RSI": {"type": "RSI", "calcParams": [14], "extendData": {}}}
PINNED_SLOPE = {"SLOPE": {"type": "SLOPE", "calcParams": [5],
                          "extendData": {"slopePeriod": 3, "mtf": {"timeframe": "1H"}}}}


def test_instance_ref_in_condition_compiles_and_judges():
    cs = compile_screen("RSI.value < 101", [], RSI_PANE)
    assert "RSI" in cs.instances
    j = judge(cs, _bars([float(x % 7 + 10) for x in range(80)]), "HOUR")
    assert j.skip_reason is None and j.matched


def test_instance_ref_in_column():
    cs = compile_screen("candle.close > 0", [{"name": "R", "expression": "RSI.value"}], RSI_PANE)
    j = judge(cs, _bars([float(x % 7 + 10) for x in range(80)]), "HOUR")
    assert j.matched and j.columns["R"] is not None


def test_divergence_warmup_sizes_the_fetch():
    cs = compile_screen("count(RSI.bullDiv, 5) >= 1", [], RSI_PANE)
    assert cs.warmup >= 14 + 60 + 5 + 5
    assert bars_needed(cs) == min(2000, cs.warmup * 5)


def test_unknown_instance_uses_screen_wording():
    with pytest.raises(ScreenSpecError) as e:
        compile_screen("RSI.value < 30", [])
    assert e.value.err.code == "unknown_indicator_ref"
    assert e.value.err.message == "RSI is not one of this screen's indicators. Add it to a chart and pick it from there."


def test_unknown_instance_in_column_names_the_column():
    with pytest.raises(ScreenSpecError) as e:
        compile_screen("candle.close > 0", [{"name": "x", "expression": "ATR.14"}], RSI_PANE)
    assert (e.value.field, e.value.index) == ("columns", 0)
    assert "ATR is not one of this screen's indicators" in e.value.err.message


def test_pinned_pane_refused_with_its_own_message():
    with pytest.raises(ScreenSpecError) as e:
        compile_screen("SLOPE.5 > 0", [], PINNED_SLOPE)
    assert e.value.err.code == "screen_tf_unsupported"
    assert e.value.err.message == (
        "SLOPE is pinned to 1H in its settings. Screens run on one timeframe, so unpin it on the chart.")


def test_text_tf_pin_keeps_its_message():
    with pytest.raises(ScreenSpecError) as e:
        compile_screen("candle.close > EMA(9)@D", [], RSI_PANE)
    assert e.value.err.message == "Timeframe pins like @D are not available in screens yet."
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && python3 -m pytest tests/test_screen_eval.py -q`
Expected: the new tests FAIL (`compile_screen() takes 2 positional arguments`).

- [ ] **Step 3: Implement**

In `screen_eval.py`:
- Module docstring: replace "Screens have no chart panes and fetch no higher timeframes, so `@tf` pins and pane references are refused at compile time rather than misjudged." with "Screens fetch no higher timeframes, so `@tf` pins and panes pinned to a timeframe in their settings are refused at compile time rather than misjudged. Pane references resolve against the screen's own `indicators` map."
- Imports: `from auto_trader.indicators.registry import ResolvedInstance, resolve_instances`.
- Add `instances: dict[str, ResolvedInstance]` as the last field of `CompiledScreen`.
- Replace `_refuse_unsupported` and add the message rewrite:

```python
def _refuse_unsupported(node: N.Node, src: str, instances: dict[str, ResolvedInstance]) -> None:
    if referenced_tfs(node, None):
        raise ExprError("screen_tf_unsupported",
                        "Timeframe pins like @D are not available in screens yet.",
                        0, len(src))
    for iid, inst in instances.items():
        pin = referenced_tfs(node, {iid: inst})
        if pin:
            raise ExprError("screen_tf_unsupported",
                            f"{iid} is pinned to {next(iter(pin))} in its settings. "
                            "Screens run on one timeframe, so unpin it on the chart.",
                            0, len(src))


def _screen_wording(e: ExprError, src: str) -> ExprError:
    """validate() says "on this chart"; a screen has no chart."""
    if e.code != "unknown_indicator_ref":
        return e
    iid = src[e.start:e.end].split(".", 1)[0]
    return ExprError(e.code, f"{iid} is not one of this screen's indicators. "
                     "Add it to a chart and pick it from there.", e.start, e.end)
```

- `compile_screen(expression, columns, indicators=None)`:

```python
def compile_screen(expression: str, columns: list[dict],
                   indicators: dict[str, dict] | None = None) -> CompiledScreen:
    instances = resolve_instances(indicators or {})
    try:
        row = parse(expression)
        validate(row, is_exit=False, instances=instances)
        _refuse_unsupported(row, expression, instances)
    except ExprError as e:
        raise ScreenSpecError("expression", 0, _screen_wording(e, expression)) from e
    cols: list[tuple[str, N.Node]] = []
    for idx, col in enumerate(columns):
        src = col["expression"]
        try:
            node = parse_value(src)
            validate_value(node, instances)
            _refuse_unsupported(node, src, instances)
        except ExprError as e:
            raise ScreenSpecError("columns", idx, _screen_wording(e, src)) from e
        cols.append((col["name"], node))
    warm = max([warmup_bars(row, None, instances)] + [warmup_bars(n, None, instances) for _, n in cols])
    return CompiledScreen(row, expression, cols, warm, instances)
```

- `judge`: pass `cs.instances` as the `instances` argument of `compile_row(cs.row, bars, resolution, {}, cs.instances, source=cs.source)` and `series_of(node, bars, resolution, {}, cs.instances)`.
- Check `ExprError`'s constructor argument order in `strategy/expr/errors.py` and match it (the existing `_refuse_unsupported` call shows `(code, message, start, end)`).

- [ ] **Step 4: Run to verify they pass**

Run: `cd backend && python3 -m pytest tests/test_screen_eval.py tests/test_screen_jobs.py -q`
Expected: all PASS, including every pre-existing test.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/core/screen_eval.py backend/tests/test_screen_eval.py
git commit -m "feat(screener): resolve chart indicator instances in screen expressions"
```

---

### Task 2: Indicators on the run/save bodies, compute cap

**Files:**
- Modify: `backend/auto_trader/api/routers/screens.py`, `backend/auto_trader/api/screen_jobs.py`
- Test: `backend/tests/test_api_screens.py`, `backend/tests/test_screen_jobs.py`

**Interfaces:**
- Consumes: `compile_screen(expression, columns, indicators)` from Task 1.
- Produces: `ScreenRunBody.indicators: dict[str, IndicatorInstanceDTO]`; `_data()` includes `"indicators": {id: dto.model_dump(exclude_none=True)}` (consumed by Task 3's store); `ScreenJobs(loader=None, per_broker=4, clock=time.time, per_compute=2)`.

- [ ] **Step 1: Write the failing tests**

Read `tests/test_api_screens.py` first and reuse its client fixture and request helpers (the `isolated` fixture at the top). Append:

```python
RSI_PANE = {"RSI": {"type": "RSI", "calcParams": [14], "extendData": {}}}


def test_run_with_indicator_ref(client):
    r = client.post("/api/screens/run", json={
        "broker": "yfinance", "resolution": "DAY", "symbols": ["AAPL"],
        "expression": "RSI.value < 101", "indicators": RSI_PANE})
    assert r.status_code == 200, r.text


def test_unknown_ref_422_names_field(client):
    r = client.post("/api/screens/run", json={
        "broker": "yfinance", "resolution": "DAY", "symbols": ["AAPL"],
        "expression": "RSI.value < 30"})
    assert r.status_code == 422
    assert r.json()["detail"]["field"] == "expression"


def test_unregistered_type_422(client):
    r = client.post("/api/screens/run", json={
        "broker": "yfinance", "resolution": "DAY", "symbols": ["AAPL"],
        "expression": "candle.close > 0",
        "indicators": {"MACD": {"type": "MACD", "calcParams": [12, 26, 9]}}})
    assert r.status_code == 422
    assert "MACD" in r.text


def test_indicator_caps_422(client):
    many = {f"RSI{i}": {"type": "RSI", "calcParams": [14]} for i in range(17)}
    big = {"RSI": {"type": "RSI", "calcParams": [14], "extendData": {"pad": "x" * 40000}}}
    for ind in (many, big):
        r = client.post("/api/screens/run", json={
            "broker": "yfinance", "resolution": "DAY", "symbols": ["AAPL"],
            "expression": "candle.close > 0", "indicators": ind})
        assert r.status_code == 422, ind.keys()


def test_save_roundtrips_indicators(client):
    r = client.post("/api/screens", json={
        "name": "Div", "broker": "yfinance", "resolution": "DAY", "symbols": ["AAPL"],
        "expression": "count(RSI.bullDiv, 5) >= 1", "indicators": RSI_PANE})
    assert r.status_code == 200, r.text
    assert r.json()["indicators"]["RSI"]["type"] == "RSI"
```

Adapt `client` to whatever the file's fixture is actually named; keep the bodies exactly.

Append to `tests/test_screen_jobs.py`:

```python
def test_compute_cap_bounds_concurrent_judges(monkeypatch):
    import threading
    import auto_trader.api.screen_jobs as sj
    live, peak, lock = [0], [0], threading.Lock()
    real = sj.judge

    def slow_judge(cs, bars, res):
        with lock:
            live[0] += 1
            peak[0] = max(peak[0], live[0])
        try:
            import time as _t
            _t.sleep(0.02)
            return real(cs, bars, res)
        finally:
            with lock:
                live[0] -= 1

    monkeypatch.setattr(sj, "judge", slow_judge)

    async def run():
        table = {f"S{i}": _bars([11.0] * 5) for i in range(8)}
        jobs = ScreenJobs(loader=_loader(table), clock=lambda: NOW, per_compute=2)
        jid = _start(jobs, list(table))
        st = await _finish(jobs, "u1", jid)
        assert st["status"] == "done"
    asyncio.run(run())
    assert peak[0] <= 2


def test_cancel_stops_starting_judges(monkeypatch):
    import auto_trader.api.screen_jobs as sj
    started = []
    real = sj.judge

    def slow_judge(cs, bars, res):
        started.append(1)
        import time as _t
        _t.sleep(0.05)
        return real(cs, bars, res)

    monkeypatch.setattr(sj, "judge", slow_judge)

    async def run():
        table = {f"S{i}": _bars([11.0] * 5) for i in range(20)}
        jobs = ScreenJobs(loader=_loader(table), clock=lambda: NOW, per_compute=2)
        jid = _start(jobs, list(table))
        await asyncio.sleep(0.01)
        assert jobs.cancel("u1", jid)
        await _finish(jobs, "u1", jid)
        await asyncio.sleep(0.2)
    asyncio.run(run())
    assert len(started) <= 4
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && python3 -m pytest tests/test_api_screens.py tests/test_screen_jobs.py -q`
Expected: the new tests FAIL.

- [ ] **Step 3: Implement**

`screens.py`:

```python
import json
from auto_trader.api.schemas import IndicatorInstanceDTO
from auto_trader.indicators.registry import SERIES_INDICATORS, instance_type_of

_MAX_INDICATORS = 16
_MAX_INDICATOR_BYTES = 32768
```

On `ScreenRunBody` add `indicators: dict[str, IndicatorInstanceDTO] = Field(default_factory=dict)` and:

```python
    @field_validator("indicators")
    @classmethod
    def _check_indicators(cls, v: dict[str, IndicatorInstanceDTO]) -> dict[str, IndicatorInstanceDTO]:
        if len(v) > _MAX_INDICATORS:
            raise ValueError(f"at most {_MAX_INDICATORS} indicators per screen")
        size = len(json.dumps({k: d.model_dump(exclude_none=True) for k, d in v.items()}))
        if size > _MAX_INDICATOR_BYTES:
            raise ValueError("indicator settings are too large")
        for iid, d in v.items():
            t = d.type or instance_type_of(iid)
            if t not in SERIES_INDICATORS:
                raise ValueError(f"{iid}: {t} can't be used in a screen")
        return v
```

Add a helper and use it in `_compile` and `_data`:

```python
def _indicators(body: ScreenRunBody) -> dict[str, dict]:
    return {k: d.model_dump(exclude_none=True) for k, d in body.indicators.items()}
```

`_compile`: `compile_screen(body.expression, [c.model_dump() for c in body.columns], _indicators(body))`.
`_data`: add `"indicators": _indicators(body)`.

`screen_jobs.py`:
- `__init__` gains `per_compute: int = 2` and `self._compute = asyncio.Semaphore(per_compute)`. Create the semaphore lazily on first use if the module-level `SCREEN_JOBS = ScreenJobs()` would otherwise bind it outside a loop (Python 3.10+ semaphores bind on first await, so a plain attribute is fine; confirm the project's Python is 3.12 per CI).
- In `_one`, wrap the judge: `async with self._compute: j = await asyncio.to_thread(judge, cs, bars, resolution)`.
- Module docstring: add one sentence, "Judging runs in threads under a per-runner cap of 2, separate from the per-broker fetch cap, because heavy panes (Trendlines) cost far more than a fetch; a cancelled run starts no further judges, though up to two in flight finish in their threads."

- [ ] **Step 4: Run to verify they pass**

Run: `cd backend && python3 -m pytest tests/test_api_screens.py tests/test_screen_jobs.py tests/test_screen_eval.py -q`
Expected: all PASS. `test_save_roundtrips_indicators` may still fail until Task 3; if so, mark it with `@pytest.mark.xfail(reason="store column lands in Task 3", strict=True)` and remove the mark in Task 3.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/routers/screens.py backend/auto_trader/api/screen_jobs.py backend/tests/test_api_screens.py backend/tests/test_screen_jobs.py
git commit -m "feat(screener): accept an indicators map on screen runs and saves, cap judging"
```

---

### Task 3: Persist indicators with saved screens

**Files:**
- Modify: `backend/auto_trader/core/screen_store.py`
- Test: `backend/tests/test_screen_store.py`, `backend/tests/test_api_screens.py` (drop the xfail mark if Task 2 added one)

**Interfaces:**
- Consumes: `data["indicators"]` from Task 2's `_data()`; absent key means `{}`.
- Produces: every row dict carries `"indicators": dict`.

- [ ] **Step 1: Write the failing tests** (append to `tests/test_screen_store.py`)

```python
import sqlite3

IND = {"RSI": {"type": "RSI", "calcParams": [14], "extendData": {}}}


def test_indicators_roundtrip(store):
    row = asyncio.run(store.create("u1", {**DATA, "indicators": IND}))
    assert row["indicators"] == IND
    upd = asyncio.run(store.update("u1", row["id"], {**DATA, "indicators": {}}))
    assert upd["indicators"] == {}


def test_missing_indicators_key_stores_empty(store):
    row = asyncio.run(store.create("u1", DATA))
    assert row["indicators"] == {}


def test_old_table_is_migrated(tmp_path):
    path = str(tmp_path / "old.db")
    conn = sqlite3.connect(path)
    conn.executescript("""
    CREATE TABLE screens (
      user_id TEXT NOT NULL, id TEXT NOT NULL,
      name TEXT NOT NULL, broker TEXT NOT NULL, resolution TEXT NOT NULL,
      symbols TEXT NOT NULL, expression TEXT NOT NULL, columns TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, id));
    INSERT INTO screens VALUES ('u1','s1','Old','yfinance','DAY','["AAPL"]','candle.close > 0','[]',1,1);
    """)
    conn.commit()
    conn.close()
    s = ScreenStore(path)
    rows = asyncio.run(s.list("u1"))
    assert rows[0]["id"] == "s1" and rows[0]["indicators"] == {}
    upd = asyncio.run(s.update("u1", "s1", {**DATA, "indicators": IND}))
    assert upd["indicators"] == IND
    assert asyncio.run(s.create("u1", DATA))["indicators"] == {}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && python3 -m pytest tests/test_screen_store.py -q`
Expected: new tests FAIL with `KeyError: 'indicators'`.

- [ ] **Step 3: Implement**

- `_SCHEMA`: add `indicators TEXT NOT NULL DEFAULT '{}',` after `columns TEXT NOT NULL,` (new databases get it directly).
- `_COLS = "id,name,broker,resolution,symbols,expression,columns,created_at,updated_at,indicators"`.
- `_connect`:

```python
    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path)
        conn.executescript(_SCHEMA)
        # Tables from before indicators existed: add the column once.
        cols = {r[1] for r in conn.execute("PRAGMA table_info(screens)")}
        if "indicators" not in cols:
            conn.execute("ALTER TABLE screens ADD COLUMN indicators TEXT NOT NULL DEFAULT '{}'")
            conn.commit()
        return conn
```

- `_row`: add `"indicators": json.loads(r[9] or "{}")`.
- `create`: name the columns.

```python
                conn.execute(
                    "INSERT INTO screens (user_id,id,name,broker,resolution,symbols,expression,"
                    "columns,created_at,updated_at,indicators) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    (user_id, sid, data["name"], data["broker"], data["resolution"],
                     json.dumps(data["symbols"]), data["expression"],
                     json.dumps(data["columns"]), now, now,
                     json.dumps(data.get("indicators") or {})))
```

- `update`: add `indicators=?` to the SET list and `json.dumps(data.get("indicators") or {})` in the matching position.

- [ ] **Step 4: Run to verify they pass**

Run: `cd backend && python3 -m pytest tests/test_screen_store.py tests/test_api_screens.py -q`
Expected: all PASS (remove any xfail mark from Task 2 first).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/core/screen_store.py backend/tests/test_screen_store.py backend/tests/test_api_screens.py
git commit -m "feat(screener): store each saved screen's indicator settings"
```

---

### Task 4: Generic indicator pick hook

**Files:**
- Create: `frontend/src/lib/useIndicatorPick.ts`, `frontend/src/lib/useIndicatorPick.test.tsx`
- Modify: `frontend/src/backtestSettings/useExprPick.ts`

**Interfaces:**
- Produces:

```ts
export interface IndicatorPick<T> {
  armed: T | null;
  arm: (target: T) => void;
  disarm: () => void;
}
export function useIndicatorPick<T>(
  controller: ChartController | null,
  onToken: (target: T, token: string) => void,
): IndicatorPick<T> | undefined; // undefined when controller is null
```

- `useExprPick(controller, setCfg)` keeps its exact return shape (`{ armed, arm(group, row), disarm } | undefined`), now built on `useIndicatorPick`.

- [ ] **Step 1: Write the failing test** (`lib/useIndicatorPick.test.tsx`)

```tsx
// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("./exprPick", () => ({ pickedIndicatorToken: vi.fn(() => "RSI.bullDiv") }));
vi.mock("./notify", () => ({ toast: vi.fn() }));

import { Signal } from "./signals";
import { useIndicatorPick } from "./useIndicatorPick";
import { pickedIndicatorToken } from "./exprPick";
import { toast } from "./notify";

function fakeController() {
  return {
    chart: {},
    indicatorPickArmed: new Signal<boolean>(false),
    indicatorPickResult: new Signal<unknown>(null),
  } as never;
}

describe("useIndicatorPick", () => {
  it("delivers one token to the armed target and disarms", () => {
    const c = fakeController() as { indicatorPickArmed: Signal<boolean>; indicatorPickResult: Signal<unknown> };
    const onToken = vi.fn();
    const { result } = renderHook(() => useIndicatorPick<string>(c as never, onToken));
    act(() => result.current!.arm("condition"));
    expect(c.indicatorPickArmed.value).toBe(true);
    act(() => c.indicatorPickResult.set({ id: "RSI" }));
    expect(onToken).toHaveBeenCalledWith("condition", "RSI.bullDiv");
    expect(result.current!.armed).toBeNull();
    expect(c.indicatorPickArmed.value).toBe(false);
    act(() => c.indicatorPickResult.set({ id: "RSI" }));
    expect(onToken).toHaveBeenCalledTimes(1);
  });

  it("ignores clicks while unarmed", () => {
    const c = fakeController() as { indicatorPickResult: Signal<unknown> };
    const onToken = vi.fn();
    renderHook(() => useIndicatorPick<string>(c as never, onToken));
    act(() => c.indicatorPickResult.set({ id: "RSI" }));
    expect(onToken).not.toHaveBeenCalled();
  });

  it("two mounted hooks: only the last armed one receives the click", () => {
    const c = fakeController() as { indicatorPickResult: Signal<unknown> };
    const a = vi.fn();
    const b = vi.fn();
    const ha = renderHook(() => useIndicatorPick<string>(c as never, a));
    const hb = renderHook(() => useIndicatorPick<string>(c as never, b));
    act(() => ha.result.current!.arm("x"));
    act(() => hb.result.current!.arm("y"));
    expect(ha.result.current!.armed).toBeNull();
    act(() => c.indicatorPickResult.set({ id: "RSI" }));
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledWith("y", "RSI.bullDiv");
  });

  it("toasts when the pane has no expression form", () => {
    vi.mocked(pickedIndicatorToken).mockReturnValueOnce(null);
    const c = fakeController() as { indicatorPickResult: Signal<unknown> };
    const onToken = vi.fn();
    const { result } = renderHook(() => useIndicatorPick<string>(c as never, onToken));
    act(() => result.current!.arm("condition"));
    act(() => c.indicatorPickResult.set({ id: "MACD" }));
    expect(onToken).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith("That indicator has no expression equivalent.");
  });

  it("returns undefined without a controller", () => {
    const { result } = renderHook(() => useIndicatorPick<string>(null, vi.fn()));
    expect(result.current).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run src/lib/useIndicatorPick.test.tsx`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** `lib/useIndicatorPick.ts`

```ts
// "Pick from chart" for any expression field: a field arms the chart, the
// user clicks an on-chart indicator, and its expression token goes to that
// field. Several hooks can be mounted at once (backtest panel, screener) and
// all hear the controller's one indicatorPickResult, so a module-level owner
// token decides who gets the click: arming takes ownership, and a hook whose
// ownership was taken drops its own armed target.
import { useEffect, useRef, useState } from "react";
import type { ChartController } from "./chartController";
import { pickedIndicatorToken } from "./exprPick";
import { toast } from "./notify";
import { Signal } from "./signals";

const owner = new Signal<symbol | null>(null);

export interface IndicatorPick<T> {
  armed: T | null;
  arm: (target: T) => void;
  disarm: () => void;
}

export function useIndicatorPick<T>(
  controller: ChartController | null,
  onToken: (target: T, token: string) => void,
): IndicatorPick<T> | undefined {
  const [me] = useState(() => Symbol("indicatorPick"));
  const [armed, setArmed] = useState<T | null>(null);
  const armedRef = useRef(armed);
  armedRef.current = armed;
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;

  useEffect(() => owner.subscribe((o) => { if (o !== me) setArmed(null); }), [me]);

  useEffect(() => {
    if (!controller) return;
    const unsub = controller.indicatorPickResult.subscribe((sel) => {
      const target = armedRef.current;
      if (!sel || target === null || owner.value !== me) return;
      controller.indicatorPickResult.set(null); // consume one-shot
      setArmed(null);
      owner.set(null);
      controller.indicatorPickArmed.set(false);
      // pickedIndicatorToken owns the chart-side normalisation, notably a click
      // on a Slope's acceleration companion, which the expression language
      // spells as an OUTPUT of its parent ("SLOPE.accel9").
      const token = controller.chart ? pickedIndicatorToken(controller.chart, sel) : null;
      if (!token) {
        toast("That indicator has no expression equivalent.");
        return;
      }
      onTokenRef.current(target, token);
    });
    return () => {
      unsub();
      if (owner.value === me) {
        owner.set(null);
        controller.indicatorPickArmed.set(false); // never leave the chart armed if the panel closes
      }
    };
  }, [controller, me]);

  if (!controller) return undefined;
  return {
    armed,
    arm: (target) => {
      owner.set(me);
      setArmed(target);
      controller.indicatorPickArmed.set(true);
    },
    disarm: () => {
      if (owner.value === me) owner.set(null);
      setArmed(null);
      controller.indicatorPickArmed.set(false);
    },
  };
}
```

The test's fake controller has `chart: {}`, so `pickedIndicatorToken` (mocked) runs. Its `sel` type is `SelectedIndicator`; cast as needed.

Rewrite `useExprPick` on top of it, keeping its signature and return shape:

```ts
type Group = "longEntry" | "longExit" | "shortEntry" | "shortExit";

export function useExprPick(controller: ChartController | null, setCfg: Dispatch<SetStateAction<BacktestConfig>>) {
  // "Pick from chart" (expression editor): a rule row arms the chart, the user
  // clicks an on-chart indicator, and its expression token (e.g. "EMA(9)") is
  // appended to that row. One armed row at a time; the generic hook owns the
  // arm/consume cycle (lib/useIndicatorPick.ts).
  const pick = useIndicatorPick<{ group: Group; row: number }>(controller, (target, token) => {
    setCfg((c) => {
      const g = c[target.group] as { rules: Array<{ expr?: string }> };
      const rules = g.rules.map((r, i) => (i === target.row ? { ...r, expr: (r.expr ?? "") + token } : r));
      return { ...c, [target.group]: { ...g, rules } };
    });
  });
  return pick
    ? { armed: pick.armed, arm: (group: Group, row: number) => pick.arm({ group, row }), disarm: pick.disarm }
    : undefined;
}
```

Drop the now-unused imports (`pickedIndicatorToken`, `toast`, and `useRef`/`useState` only if `useExprInstances` no longer needs them; it does use `useState`/`useEffect`).

- [ ] **Step 4: Run to verify**

Run: `cd frontend && npx vitest run src/lib/useIndicatorPick.test.tsx && npx tsc -b && npx eslint src/lib/useIndicatorPick.ts src/lib/useIndicatorPick.test.tsx src/backtestSettings/useExprPick.ts`
Expected: tests PASS, zero tsc errors, zero eslint errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/useIndicatorPick.ts frontend/src/lib/useIndicatorPick.test.tsx frontend/src/backtestSettings/useExprPick.ts
git commit -m "refactor: split pick-from-chart into a generic useIndicatorPick hook"
```

---

### Task 5: Screen indicator copy helpers and client types

**Files:**
- Create: `frontend/src/lib/screenerIndicators.ts`, `frontend/src/lib/screenerIndicators.test.ts`
- Modify: `frontend/src/lib/screens.ts`, `frontend/src/lib/screenerDraft.ts`

**Interfaces:**
- Consumes: `LiveInstance`, `ExprInstancePayload`, `exprInstancesFor`, `collectExprInstances` from `lib/exprInstances.ts`; `ExprInstance` from `lib/expr/catalog.ts`.
- Produces:

```ts
export type PaneCopy = Record<string, ExprInstancePayload>;
export function copyAsLive(copy: PaneCopy): LiveInstance[];
export function editorInstances(copy: PaneCopy, chart: readonly ExprInstance[]): ExprInstance[];
export function screenPayload(copy: PaneCopy, chartLive: readonly LiveInstance[], exprs: string[]): PaneCopy;
export function refreshFromChart(copy: PaneCopy, chartLive: readonly LiveInstance[]): PaneCopy;
export function paneLabels(copy: PaneCopy): string[];
```

- `ScreenDraft` gains `indicators: Record<string, ExprInstancePayload>`; `Screen` inherits it (server rows always carry it after Task 3). `ScreenerDraftState` gains `indicators: PaneCopy`, `EMPTY_SCREENER_DRAFT.indicators = {}`.

- [ ] **Step 1: Write the failing test** (`lib/screenerIndicators.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { copyAsLive, editorInstances, paneLabels, refreshFromChart, screenPayload } from "./screenerIndicators";

const rsi = (len: number) => ({ type: "RSI", calcParams: [len], extendData: {} });
const live = (id: string, len: number) => ({ id, ...rsi(len) });

describe("screenerIndicators", () => {
  it("copy wins over a chart pane with the same id", () => {
    const out = screenPayload({ RSI: rsi(14) }, [live("RSI", 7)], ["RSI.bullDiv"]);
    expect(out.RSI.calcParams).toEqual([14]);
  });

  it("chart supplies ids the copy lacks", () => {
    const out = screenPayload({}, [live("RSI", 7)], ["RSI.value < 30"]);
    expect(out.RSI.calcParams).toEqual([7]);
  });

  it("keeps only referenced panes", () => {
    const out = screenPayload({ RSI: rsi(14), RSI1: rsi(9) }, [live("RSI2", 5)], ["RSI.value < 30", "1"]);
    expect(Object.keys(out)).toEqual(["RSI"]);
  });

  it("nothing referenced gives an empty map", () => {
    expect(screenPayload({ RSI: rsi(14) }, [live("RSI", 7)], ["candle.close > 0"])).toEqual({});
  });

  it("refresh replaces only ids the chart also has", () => {
    const out = refreshFromChart({ RSI: rsi(14), RSI1: rsi(9) }, [live("RSI", 7)]);
    expect(out.RSI.calcParams).toEqual([7]);
    expect(out.RSI1.calcParams).toEqual([9]);
  });

  it("editor list: copy first, chart adds missing ids, pinned panes dropped", () => {
    const chart = [
      { id: "RSI", outputs: ["value"], timeframe: null },
      { id: "ATR", outputs: ["14"], timeframe: null },
      { id: "SLOPE", outputs: ["5"], timeframe: "1H" },
    ];
    const ids = editorInstances({ RSI: rsi(14) }, chart).map((i) => i.id);
    expect(ids).toEqual(["RSI", "ATR"]);
  });

  it("copyAsLive and labels", () => {
    expect(copyAsLive({ RSI: rsi(14) })).toEqual([live("RSI", 14)]);
    expect(paneLabels({ RSI: rsi(14) })[0]).toMatch(/^RSI/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run src/lib/screenerIndicators.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** `lib/screenerIndicators.ts`

```ts
// A screen's own copy of the chart panes its expressions reference. The copy
// wins for every id it holds; the active chart only supplies ids the copy
// lacks, so a saved screen applies the settings it was saved with whatever
// chart is focused. "Refresh from chart" is the one way a copied pane changes.
import type { ExprInstance } from "./expr/catalog";
import {
  collectExprInstances,
  exprInstancesFor,
  type ExprInstancePayload,
  type LiveInstance,
} from "./exprInstances";

export type PaneCopy = Record<string, ExprInstancePayload>;

export function copyAsLive(copy: PaneCopy): LiveInstance[] {
  return Object.entries(copy).map(([id, p]) => ({
    id, type: p.type, calcParams: p.calcParams, extendData: p.extendData,
  }));
}

/** The editor's list: the copy's panes, then chart panes the copy lacks.
 * Timeframe-pinned panes are dropped: screens refuse them, so the editor
 * should flag them as unknown instead of accepting them. */
export function editorInstances(copy: PaneCopy, chart: readonly ExprInstance[]): ExprInstance[] {
  const own = exprInstancesFor(copyAsLive(copy));
  const ids = new Set(own.map((i) => i.id));
  return [...own, ...chart.filter((i) => !ids.has(i.id))].filter((i) => i.timeframe == null);
}

/** The request's `indicators` map, which also becomes the new copy. */
export function screenPayload(copy: PaneCopy, chartLive: readonly LiveInstance[], exprs: string[]): PaneCopy {
  const list = [...copyAsLive(copy), ...chartLive.filter((i) => !(i.id in copy))];
  return collectExprInstances(list, exprs);
}

export function refreshFromChart(copy: PaneCopy, chartLive: readonly LiveInstance[]): PaneCopy {
  const out: PaneCopy = { ...copy };
  for (const inst of chartLive) {
    if (!(inst.id in copy)) continue;
    out[inst.id] = { type: inst.type, calcParams: inst.calcParams ?? [], extendData: inst.extendData ?? {} };
  }
  return out;
}

/** One short label per copied pane, e.g. "RSI (14)". */
export function paneLabels(copy: PaneCopy): string[] {
  return Object.entries(copy).map(([id, p]) =>
    p.calcParams.length ? `${id} (${p.calcParams.join(", ")})` : id);
}
```

`refreshFromChart` replaces with the chart's raw payload; `screenPayload` then stamps the zone on the next Run/Save, the same as a fresh pick.

`lib/screens.ts`: add `import type { ExprInstancePayload } from "./exprInstances";` and `indicators: Record<string, ExprInstancePayload>;` to `ScreenDraft`.

`lib/screenerDraft.ts`: import `PaneCopy` from `./screenerIndicators`, add `indicators: PaneCopy;` to `ScreenerDraftState` and `indicators: {},` to `EMPTY_SCREENER_DRAFT`.

- [ ] **Step 4: Run to verify**

Run: `cd frontend && npx vitest run src/lib/screenerIndicators.test.ts && npx tsc -b`
Expected: tests PASS. tsc reports errors only in `ScreenerPanel.tsx` (the draft object and `setScreenerDraft` call lack `indicators`); Task 6 fixes those. If you need a green tsc to commit, add `indicators: {}` to the `draft` literal and the `setScreenerDraft` call in `ScreenerPanel.tsx` as a stopgap.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/screenerIndicators.ts frontend/src/lib/screenerIndicators.test.ts frontend/src/lib/screens.ts frontend/src/lib/screenerDraft.ts frontend/src/ScreenerPanel.tsx
git commit -m "feat(screener): pane copy helpers and indicators on the screen types"
```

---

### Task 6: Screener panel wiring

**Files:**
- Modify: `frontend/src/ScreenerPanel.tsx`, `frontend/src/App.tsx`, `frontend/src/App.css`
- Test: `frontend/src/ScreenerPanel.test.tsx`

**Interfaces:**
- Consumes: `useIndicatorPick` (Task 4), `editorInstances`, `screenPayload`, `refreshFromChart`, `paneLabels`, `PaneCopy` (Task 5), `useExprInstances` from `backtestSettings/useExprPick.ts`, `liveExprInstances` from `lib/indicators.ts`.
- Produces: `ScreenerPanel` prop `controller: ChartController | null`.

- [ ] **Step 1: Write the failing tests** (append inside the `describe` of `ScreenerPanel.test.tsx`)

At the top of the file, next to the other `vi.mock` calls:

```tsx
const chartPanes = { live: [] as Array<{ id: string; type: string; calcParams: number[]; extendData: unknown }>, editor: [] as Array<{ id: string; outputs: string[]; timeframe: string | null }> };
vi.mock("./lib/indicators", () => ({ liveExprInstances: vi.fn(() => chartPanes.live) }));
vi.mock("./backtestSettings/useExprPick", () => ({ useExprInstances: vi.fn(() => chartPanes.editor) }));
```

In `beforeEach`, reset: `chartPanes.live = []; chartPanes.editor = [];`.

Every existing `render(<ScreenerPanel ...`: add `controller={null}`; for the instance tests pass a fake controller. Update `const props = { tabs: [], ...}` to include `controller: null`.

```tsx
  const fakeController = () => ({
    chart: {},
    indicatorPickArmed: new Signal<boolean>(false),
    indicatorPickResult: new Signal<unknown>(null),
  }) as never;

  it("Run sends the referenced chart pane and shows it on the Indicators line", async () => {
    chartPanes.live = [{ id: "RSI", type: "RSI", calcParams: [14], extendData: {} }];
    render(<ScreenerPanel brokerId="yfinance" tabs={[]} controller={fakeController()} priceSide="mid" onOpen={() => {}} onClose={() => {}} />);
    fillAndRun("AAPL", "count(RSI.bullDiv, 5) >= 1");
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(startScreen).toHaveBeenCalled());
    expect(vi.mocked(startScreen).mock.calls[0][0].indicators).toEqual({
      RSI: { type: "RSI", calcParams: [14], extendData: {} },
    });
    expect(await screen.findByText("RSI (14)")).toBeTruthy();
  });

  it("a loaded screen's copy wins over the focused chart", async () => {
    vi.mocked(listScreens).mockResolvedValue([{
      ...SAVED, expression: "RSI.value < 30",
      indicators: { RSI: { type: "RSI", calcParams: [14], extendData: {} } },
    }]);
    chartPanes.live = [{ id: "RSI", type: "RSI", calcParams: [7], extendData: {} }];
    render(<ScreenerPanel brokerId="yfinance" tabs={[]} controller={fakeController()} priceSide="mid" onOpen={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole("option", { name: "Saved one" })).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Saved screens"), { target: { value: "s1" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(startScreen).toHaveBeenCalled());
    expect(vi.mocked(startScreen).mock.calls[0][0].indicators.RSI.calcParams).toEqual([14]);
  });

  it("Refresh from chart takes the chart's settings for shared ids", async () => {
    vi.mocked(listScreens).mockResolvedValue([{
      ...SAVED, expression: "RSI.value < 30",
      indicators: { RSI: { type: "RSI", calcParams: [14], extendData: {} } },
    }]);
    chartPanes.live = [{ id: "RSI", type: "RSI", calcParams: [7], extendData: {} }];
    render(<ScreenerPanel brokerId="yfinance" tabs={[]} controller={fakeController()} priceSide="mid" onOpen={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole("option", { name: "Saved one" })).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Saved screens"), { target: { value: "s1" } });
    fireEvent.click(screen.getByRole("button", { name: "Refresh from chart" }));
    expect(await screen.findByText("RSI (7)")).toBeTruthy();
  });

  it("a screen with no pane refs sends an empty map", async () => {
    setup();
    fillAndRun();
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(startScreen).toHaveBeenCalled());
    expect(vi.mocked(startScreen).mock.calls[0][0].indicators).toEqual({});
  });

  it("pick from chart appends to the condition", async () => {
    const c = fakeController() as unknown as { indicatorPickResult: Signal<unknown> };
    render(<ScreenerPanel brokerId="yfinance" tabs={[]} controller={c as never} priceSide="mid" onOpen={() => {}} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Condition"), { target: { value: "count(" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Pick an indicator from the chart" })[0]);
    act(() => c.indicatorPickResult.set({ id: "RSI" }));
    expect((screen.getByLabelText("Condition") as HTMLTextAreaElement).value).toBe("count(RSI.bullDiv");
  });
```

For the pick test, mock `./lib/exprPick` at the top: `vi.mock("./lib/exprPick", () => ({ pickedIndicatorToken: vi.fn(() => "RSI.bullDiv") }));`. Import `act` from `@testing-library/react` and `Signal` from `./lib/signals`. `SAVED` in the existing file needs `indicators: {}` added for the `Screen` type.

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx vitest run src/ScreenerPanel.test.tsx`
Expected: the new tests FAIL.

- [ ] **Step 3: Implement**

`ScreenerPanel.tsx`:
- Imports: `ChartController` type, `useExprInstances` from `./backtestSettings/useExprPick`, `liveExprInstances` from `./lib/indicators`, `useIndicatorPick` from `./lib/useIndicatorPick`, and the Task 5 helpers.
- `Props` gains `controller: ChartController | null`. Pass it through `ScreenerPanel` to `ScreenerForm` (already spread).
- State: `const [indicators, setIndicators] = useState<PaneCopy>(initial.indicators ?? {});` (`?? {}` covers drafts held in memory from before this change during a hot reload).
- `const chartEditor = useExprInstances(controller);` and `const instances = useMemo(() => editorInstances(indicators, chartEditor), [indicators, chartEditor]);`. Pass `instances={instances}` to `RuleExpressionInput`.
- `const chartLive = () => (controller?.chart ? liveExprInstances(controller.chart) : []);`
- `const capture = () => screenPayload(indicators, chartLive(), [expression, ...columns.map((c) => c.expression)]);`
- `draft` stays for fields other than indicators; in `run` and `save`, compute `const inds = capture(); setIndicators(inds);` and send `{ ...draft, indicators: inds }`.
- `setScreenerDraft` call and its deps list gain `indicators`.
- `load(s)`: `setIndicators(s?.indicators ?? {});`.
- Pick: `type PickTarget = { kind: "condition" } | { kind: "column"; index: number };`

```tsx
  const pick = useIndicatorPick<PickTarget>(controller, (t, token) => {
    if (t.kind === "condition") setExpression((e) => e + token);
    else setColumns((cs) => cs.map((x, j) => (j === t.index ? { ...x, expression: x.expression + token } : x)));
  });
  const pickToggle = (target: PickTarget, isArmed: boolean) =>
    pick && (
      <Tooltip content={isArmed ? "Click an indicator on the chart, or click here to cancel" : "Pick an indicator from the chart"}>
        <button
          type="button"
          className={`bt-rule-toggle bt-pick-toggle${isArmed ? " on" : ""}`}
          onClick={() => (isArmed ? pick.disarm() : pick.arm(target))}
          aria-label="Pick an indicator from the chart"
          aria-pressed={isArmed}
        >
          ◎
        </button>
      </Tooltip>
    );
```

  `setExpression` is a `useState` setter, so the updater form works. Put `pickToggle({ kind: "condition" }, pick?.armed?.kind === "condition")` in the Condition label row before the timeframe control, and `pickToggle({ kind: "column", index: i }, pick?.armed?.kind === "column" && pick.armed.index === i)` before each column's remove button. Removing a column while it is armed calls `pick?.disarm()` first.
- Indicators line, right after `RuleExpressionInput`:

```tsx
        {Object.keys(indicators).length > 0 && (
          <div className="sc-inds">
            <span className="sc-label-name">Indicators<InfoTip title="Indicators" text={[
              "Settings copied from the chart on run or save.",
              "The copy is kept with the screen.",
              "Refresh from chart to pick up changes.",
            ]} /></span>
            <span className="sc-inds-list">{paneLabels(indicators).map((l) => <span key={l}>{l}</span>)}</span>
            {controller && (
              <button className="sc-link" onClick={() => setIndicators((c) => refreshFromChart(c, chartLive()))}>
                Refresh from chart
              </button>
            )}
          </div>
        )}
```

- Condition InfoTip: append the line "Pivot-based outputs see up to 2000 bars, so they can differ from the chart." and "Pick a chart indicator with ◎ to use its settings.".

`App.css` (next to the other `.sc-*` rules):

```css
.sc-inds { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; color: var(--text-dim); }
.sc-inds-list { display: flex; flex-wrap: wrap; gap: 4px; }
.sc-inds-list > span { padding: 0 6px; border-radius: 8px; color: var(--text);
  background: color-mix(in srgb, var(--text) 10%, transparent); }
.sc-inds .sc-link { margin-left: auto; }
```

`App.tsx`: pass `controller={focusedController}` to `<ScreenerPanel`.

- [ ] **Step 4: Run to verify**

Run: `cd frontend && npx vitest run src/ScreenerPanel.test.tsx src/lib/useIndicatorPick.test.tsx src/lib/screenerIndicators.test.ts && npx tsc -b && npx eslint src/ScreenerPanel.tsx src/ScreenerPanel.test.tsx src/App.tsx`
Expected: all PASS, zero tsc and eslint errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/ScreenerPanel.tsx frontend/src/ScreenerPanel.test.tsx frontend/src/App.tsx frontend/src/App.css
git commit -m "feat(screener): use chart indicators in screens, with pick from chart"
```

---

### Task 7: Live check

- [ ] **Step 1:** With the dev servers running (`localhost:8000` and `:5173`), ask the user before driving their tab. In the app: add an RSI with divergence on a chart, open the Screener, pick `RSI` via ◎, write `count(RSI.bullDiv, 5) >= 1`, source "All tabs", Run. Expect a result list with no `unknown_indicator_ref` error, and the Indicators line showing `RSI (14)`.
- [ ] **Step 2:** Save the screen, focus a chart without RSI, load the screen, Run. Expect the same kind of result (the copy is applied).
- [ ] **Step 3:** Report outcomes to the user. No commit unless a fix was needed.
