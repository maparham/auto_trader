# Strategy Panel Parameters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Coded Python strategies declare tunable params in `meta["params"]`; the app renders panel controls for them, layers the existing engine risk + exit-rule sections onto coded runs (panel overrides file brackets), keeps backtest and live value sets separate, and adds 1–2 axis parameter sweeps with a table + heatmap.

**Architecture:** Backend gains a param schema module (validate + resolve), `codedParams` on both run requests, `ctx.param()` in `StrategyContext`, bracket-stripping when panel risk is set, a `CodedWithRuleExits` composition wrapper, and a chunk-friendly `/api/backtest/sweep` endpoint. Frontend gains a per-filename two-set (backtest/live) coded-config store, a `StrategyParams` control component, coded-mode risk/exit sections in both panels (an "effective cfg" trick reuses `buildSeries` unchanged), and a chunked sweep client + results table/heatmap.

**Tech Stack:** FastAPI + Pydantic + pytest (backend), React + TypeScript + vitest (frontend).

**Spec:** `docs/superpowers/specs/2026-07-09-strategy-panel-params-design.md`

## Global Constraints

- Work directly on `main` — no branches (user rule).
- No backward-compat/migration code — single user, no old data (user rule).
- Reuse shared components (`NumberField`, `InfoTip`, `Tooltip`, `RiskSection`, `RuleGroupSection`) — never hand-roll parallels.
- UI copy: standard trading terms, concise, light theme is canonical.
- Backend tests: `cd backend && python -m pytest tests/<file> -v`. Frontend tests: `cd frontend && npx vitest run src/<file>`.
- Python indicator internals stay plain loops (TS parity) — this feature must not touch `indicators/`.
- Precedence rule (spec): panel risk configured for a side ⇒ file `sl=`/`tp=` on that side are ignored (stripped before the engine). With no panel risk, file brackets behave exactly as today.
- Sweep caps: ≤200 combos total (frontend), ≤50 combos per request (backend 422).

---

### Task 1: Backend param schema — validate, list, serve

**Files:**
- Create: `backend/auto_trader/strategy/params.py`
- Modify: `backend/auto_trader/strategy/loader.py` (StrategyInfo + `_describe`)
- Modify: `backend/auto_trader/api/schemas.py` (ParamSpecDTO, StrategyInfoDTO)
- Modify: `backend/auto_trader/api/routers/strategies.py` (pass params through)
- Test: `backend/tests/test_strategy_params.py`, extend `backend/tests/test_api_strategies.py`

**Interfaces:**
- Consumes: `loader.StrategyInfo`, `loader._describe`, `StrategyInfoDTO` (all existing).
- Produces: `params.validate_params_schema(meta: dict | None) -> list[dict]` (raises `ValueError` with a readable message on a bad schema); `StrategyInfo.params: tuple[dict, ...]`; `StrategyInfoDTO.params: list[ParamSpecDTO]`. Task 2 uses `validate_params_schema`; Task 6 consumes the DTO shape.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_strategy_params.py`:

```python
"""Schema validation for meta["params"] on coded strategies."""

import pytest

from auto_trader.strategy.params import validate_params_schema


def spec(**kw):
    base = {"name": "ema_fast", "type": "int", "default": 9}
    base.update(kw)
    return base


def test_no_meta_or_no_params_is_empty():
    assert validate_params_schema(None) == []
    assert validate_params_schema({}) == []
    assert validate_params_schema({"name": "X"}) == []


def test_valid_schema_normalized():
    out = validate_params_schema({"params": [
        {"name": "ema_fast", "label": "Fast EMA", "type": "int",
         "default": 9, "min": 2, "max": 200, "step": 1},
        {"name": "rsi_max", "type": "float", "default": 70.0},
        {"name": "longs_only", "type": "bool", "default": True},
        {"name": "mode", "type": "choice", "default": "fast", "options": ["fast", "slow"]},
    ]})
    assert [p["name"] for p in out] == ["ema_fast", "rsi_max", "longs_only", "mode"]
    assert out[0]["label"] == "Fast EMA"
    assert out[1]["label"] == "rsi_max"          # label defaults to name
    assert out[1]["default"] == 70.0


def test_rejects_bad_shapes():
    with pytest.raises(ValueError, match="params must be a list"):
        validate_params_schema({"params": {"a": 1}})
    with pytest.raises(ValueError, match="duplicate param name"):
        validate_params_schema({"params": [spec(), spec()]})
    with pytest.raises(ValueError, match="invalid param name"):
        validate_params_schema({"params": [spec(name="not an ident!")]})
    with pytest.raises(ValueError, match="unknown type"):
        validate_params_schema({"params": [spec(type="str")]})
    with pytest.raises(ValueError, match="default"):
        validate_params_schema({"params": [{"name": "a", "type": "int"}]})


def test_default_type_checked():
    with pytest.raises(ValueError, match="default"):
        validate_params_schema({"params": [spec(default="nine")]})
    with pytest.raises(ValueError, match="default"):
        validate_params_schema({"params": [spec(default=9.5)]})       # int param, float default
    with pytest.raises(ValueError, match="default"):
        validate_params_schema({"params": [spec(type="bool", default=1)]})  # bool wants bool
    # int default for a float param is fine (coerced to float)
    out = validate_params_schema({"params": [spec(type="float", default=9)]})
    assert out[0]["default"] == 9.0


def test_min_max_bounds():
    with pytest.raises(ValueError, match="min"):
        validate_params_schema({"params": [spec(min=10, max=5)]})
    with pytest.raises(ValueError, match="default"):
        validate_params_schema({"params": [spec(default=1, min=2, max=50)]})
    with pytest.raises(ValueError, match="min/max/step"):
        validate_params_schema({"params": [spec(type="bool", default=True, min=0)]})


def test_choice_needs_options():
    with pytest.raises(ValueError, match="options"):
        validate_params_schema({"params": [spec(type="choice", default="a")]})
    with pytest.raises(ValueError, match="default"):
        validate_params_schema({"params": [
            spec(type="choice", default="c", options=["a", "b"])]})
    with pytest.raises(ValueError, match="options"):
        validate_params_schema({"params": [spec(options=["a"])]})     # non-choice with options
```

Extend `backend/tests/test_api_strategies.py` (follow its existing tmp-dir + monkeypatch fixture pattern) with:

```python
PARAMS_STRAT = '''
meta = {"name": "P", "params": [
    {"name": "ema_fast", "type": "int", "default": 9, "min": 2, "max": 50},
]}
def on_bar(ctx):
    return []
'''

BAD_PARAMS_STRAT = '''
meta = {"name": "BP", "params": [{"name": "x", "type": "int"}]}
def on_bar(ctx):
    return []
'''


def test_strategies_list_includes_params(tmp_path, monkeypatch, client):
    (tmp_path / "p.py").write_text(PARAMS_STRAT)
    monkeypatch.setattr(loader, "STRATEGIES_DIR", tmp_path)
    body = client.get("/api/strategies").json()
    p = next(s for s in body if s["filename"] == "p.py")
    assert p["params"] == [{
        "name": "ema_fast", "label": "ema_fast", "type": "int", "default": 9,
        "min": 2, "max": 50, "step": None, "options": None, "help": None,
    }]


def test_bad_params_schema_is_a_load_error(tmp_path, monkeypatch, client):
    (tmp_path / "bp.py").write_text(BAD_PARAMS_STRAT)
    monkeypatch.setattr(loader, "STRATEGIES_DIR", tmp_path)
    body = client.get("/api/strategies").json()
    bp = next(s for s in body if s["filename"] == "bp.py")
    assert bp["error"] and "default" in bp["error"]
    assert bp["params"] == []
```

(Adapt fixture names to what `test_api_strategies.py` actually uses — read it first; it already monkeypatches `loader.STRATEGIES_DIR`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_strategy_params.py tests/test_api_strategies.py -v`
Expected: FAIL — `ModuleNotFoundError: auto_trader.strategy.params`, then missing `params` key assertions.

- [ ] **Step 3: Implement `params.py`**

```python
"""Schema for meta["params"] on coded strategies: what the panel can tune.

A param spec is a plain dict: {name, label?, type, default, min?, max?, step?,
options?, help?}. `validate_params_schema` normalizes a module's declared list
(raising ValueError on nonsense — surfaced as the file's load error);
`resolve_params` (Task 2) merges panel-sent values over the defaults."""

from __future__ import annotations

TYPES = ("int", "float", "bool", "choice")
_KEYS = {"name", "label", "type", "default", "min", "max", "step", "options", "help"}


def validate_params_schema(meta: dict | None) -> list[dict]:
    """Normalize meta["params"] into a canonical list of spec dicts (every key
    present, label defaulted to name, float defaults coerced). Raises ValueError
    with a param-naming message on any invalid spec."""
    raw = (meta or {}).get("params")
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ValueError("meta['params'] must be a list of param dicts")
    out: list[dict] = []
    seen: set[str] = set()
    for i, spec in enumerate(raw):
        if not isinstance(spec, dict):
            raise ValueError(f"params[{i}] must be a dict")
        extra = set(spec) - _KEYS
        if extra:
            raise ValueError(f"params[{i}] has unknown keys {sorted(extra)}")
        name = spec.get("name")
        if not isinstance(name, str) or not name.isidentifier():
            raise ValueError(f"params[{i}]: invalid param name {name!r}")
        if name in seen:
            raise ValueError(f"duplicate param name '{name}'")
        seen.add(name)
        ptype = spec.get("type")
        if ptype not in TYPES:
            raise ValueError(f"param '{name}': unknown type {ptype!r} (want one of {TYPES})")
        if "default" not in spec:
            raise ValueError(f"param '{name}': default is required")
        default = _check_value(name, ptype, spec.get("options"), spec["default"], "default")
        options = spec.get("options")
        if ptype == "choice":
            if (not isinstance(options, list) or not options
                    or not all(isinstance(o, str) for o in options)):
                raise ValueError(f"param '{name}': choice needs a non-empty str list in options")
        elif options is not None:
            raise ValueError(f"param '{name}': options only valid for type 'choice'")
        lo, hi, step = spec.get("min"), spec.get("max"), spec.get("step")
        if ptype in ("bool", "choice") and any(v is not None for v in (lo, hi, step)):
            raise ValueError(f"param '{name}': min/max/step only valid for int/float")
        for label, v in (("min", lo), ("max", hi), ("step", step)):
            if v is not None and not isinstance(v, (int, float)):
                raise ValueError(f"param '{name}': {label} must be a number")
        if lo is not None and hi is not None and lo > hi:
            raise ValueError(f"param '{name}': min {lo} > max {hi}")
        if lo is not None and default < lo or hi is not None and default > hi:
            raise ValueError(f"param '{name}': default {default} outside [min, max]")
        label = spec.get("label")
        if label is not None and not isinstance(label, str):
            raise ValueError(f"param '{name}': label must be a string")
        help_ = spec.get("help")
        if help_ is not None and not isinstance(help_, str):
            raise ValueError(f"param '{name}': help must be a string")
        out.append({
            "name": name, "label": label or name, "type": ptype, "default": default,
            "min": lo, "max": hi, "step": step,
            "options": list(options) if ptype == "choice" else None, "help": help_,
        })
    return out


def _check_value(name: str, ptype: str, options, value, what: str):
    """Type-check (and minimally coerce) one value against a param type.
    Returns the coerced value; raises ValueError naming the param."""
    if ptype == "int":
        # bool is an int subclass — reject it explicitly.
        if isinstance(value, bool) or not isinstance(value, int):
            if isinstance(value, float) and value.is_integer():
                return int(value)
            raise ValueError(f"param '{name}': {what} {value!r} is not an int")
        return value
    if ptype == "float":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"param '{name}': {what} {value!r} is not a number")
        return float(value)
    if ptype == "bool":
        if not isinstance(value, bool):
            raise ValueError(f"param '{name}': {what} {value!r} is not a bool")
        return value
    # choice
    if not isinstance(value, str) or (options is not None and value not in options):
        raise ValueError(f"param '{name}': {what} {value!r} not in options {options}")
    return value
```

- [ ] **Step 4: Wire into loader + DTO + route**

`loader.py` — add the field and validate in `_describe` (a bad schema must become the file's `error`, so raise `StrategyLoadError` there):

```python
# imports
from auto_trader.strategy.params import validate_params_schema

@dataclass(frozen=True, slots=True)
class StrategyInfo:
    filename: str
    name: str
    description: str
    hedged: bool
    params: tuple[dict, ...] = ()
    error: str | None = None


def _describe(module: ModuleType, filename: str) -> StrategyInfo:
    meta = getattr(module, "meta", None)
    meta = meta if isinstance(meta, dict) else {}
    doc = (module.__doc__ or "").strip()
    try:
        params = validate_params_schema(meta)
    except ValueError as e:
        raise StrategyLoadError(f"{filename}: bad meta['params'] — {e}") from e
    return StrategyInfo(
        filename=filename,
        name=str(meta.get("name") or Path(filename).stem),
        description=str(meta.get("description") or doc),
        hedged=bool(meta.get("hedged", False)),
        params=tuple(params),
    )
```

Note `list_strategies` already catches `StrategyLoadError` from the `load_strategy` call but calls `_describe` outside that try — move the `_describe` call INSIDE the existing `try` block so a schema error lands in the file's `error` row (the two error branches already build `StrategyInfo(..., error=...)`; `params` defaults to `()` there).

`schemas.py` — next to `StrategyInfoDTO`:

```python
class ParamSpecDTO(BaseModel):
    """One tunable knob a coded strategy declares in meta['params']."""
    name: str
    label: str
    type: Literal["int", "float", "bool", "choice"]
    default: int | float | bool | str
    min: float | None = None
    max: float | None = None
    step: float | None = None
    options: list[str] | None = None
    help: str | None = None


class StrategyInfoDTO(BaseModel):
    """One discovered backend/strategies/*.py file."""
    filename: str
    name: str
    description: str
    hedged: bool
    params: list[ParamSpecDTO] = []
    error: str | None = None
```

`routers/strategies.py` — add `params=[ParamSpecDTO(**p) for p in i.params],` to the DTO construction.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_strategy_params.py tests/test_api_strategies.py tests/test_coded_strategy.py -v`
Expected: all PASS (including pre-existing coded tests — StrategyInfo gained a defaulted field only).

- [ ] **Step 6: Commit**

```bash
git add backend/auto_trader/strategy/params.py backend/auto_trader/strategy/loader.py backend/auto_trader/api/schemas.py backend/auto_trader/api/routers/strategies.py backend/tests/test_strategy_params.py backend/tests/test_api_strategies.py
git commit -m "feat(strategies): meta['params'] schema — validated, listed via /api/strategies"
```

---

### Task 2: Backend `ctx.param()` + `codedParams` through both routes

**Files:**
- Modify: `backend/auto_trader/strategy/params.py` (add `resolve_params`)
- Modify: `backend/auto_trader/strategy/coded.py` (`CodedStrategy.__init__`, `StrategyContext.param`)
- Modify: `backend/auto_trader/api/schemas.py` (`codedParams` on both requests)
- Modify: `backend/auto_trader/api/routers/backtest.py`, `backend/auto_trader/api/routers/strategy.py`
- Modify: `backend/strategies/ema_cross.py` (declare params, use `ctx.param`)
- Test: extend `backend/tests/test_strategy_params.py`, `backend/tests/test_coded_strategy.py`, `backend/tests/test_api_backtest_coded.py`, `backend/tests/test_api_evaluate_coded.py`

**Interfaces:**
- Consumes: `validate_params_schema` (Task 1); `CodedStrategy(module, candles, quantity, trade_from_time=, htf_candles=, base_timeframe=)` (existing).
- Produces: `resolve_params(module: ModuleType, sent: dict | None) -> dict[str, object]` (raises `ValueError` naming the param on a bad value; ignores unknown sent keys); `CodedStrategy(..., params: dict | None = None)` keyword; `ctx.param(name)` for strategy authors; `codedParams: dict[str, int | float | bool | str] | None = None` on `BacktestRequest` and `EvaluateRequest`. Tasks 3–5 pass `params=` through; Task 6+ sends `codedParams`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_strategy_params.py`:

```python
from types import ModuleType

from auto_trader.strategy.params import resolve_params


def module_with(params_meta) -> ModuleType:
    m = ModuleType("m")
    m.meta = {"params": params_meta}
    return m


INT_SPEC = [{"name": "ema_fast", "type": "int", "default": 9, "min": 2, "max": 50}]


def test_resolve_defaults_when_nothing_sent():
    m = module_with(INT_SPEC)
    assert resolve_params(m, None) == {"ema_fast": 9}
    assert resolve_params(m, {}) == {"ema_fast": 9}


def test_resolve_overlays_and_coerces():
    m = module_with(INT_SPEC + [{"name": "r", "type": "float", "default": 70.0}])
    out = resolve_params(m, {"ema_fast": 12.0, "r": 65})
    assert out == {"ema_fast": 12, "r": 65.0}
    assert isinstance(out["ema_fast"], int) and isinstance(out["r"], float)


def test_resolve_ignores_unknown_and_rejects_bad():
    m = module_with(INT_SPEC)
    assert resolve_params(m, {"gone": 1}) == {"ema_fast": 9}   # stale key: dropped
    import pytest
    with pytest.raises(ValueError, match="ema_fast"):
        resolve_params(m, {"ema_fast": "nine"})
    with pytest.raises(ValueError, match="outside"):
        resolve_params(m, {"ema_fast": 999})                   # out of range → 422 at the route
```

Append to `backend/tests/test_coded_strategy.py` (reuse its `module_from`/`make_candles` helpers):

```python
PARAM_STRAT = '''
meta = {"params": [{"name": "n", "type": "int", "default": 3}]}
def on_bar(ctx):
    if ctx.position.is_flat and len(ctx.closes) >= ctx.param("n"):
        return [ctx.buy(reason=f"n={ctx.param('n')}")]
    return []
'''


def test_ctx_param_reads_sent_value_and_default():
    candles = make_candles(10)
    mod = exec_module(PARAM_STRAT)          # match this file's existing module-exec helper
    default_run = BacktestEngine(CodedStrategy(mod, candles, quantity=1.0)).run(candles)
    sent_run = BacktestEngine(
        CodedStrategy(mod, candles, quantity=1.0, params={"n": 8})
    ).run(candles)
    # With n=8 the first entry comes later than with the default n=3.
    assert sent_run.fills[0].time > default_run.fills[0].time


def test_ctx_param_unknown_name_raises():
    candles = make_candles(5)
    mod = exec_module('def on_bar(ctx):\n    return [] if ctx.param("nope") else []')
    with pytest.raises(StrategyRuntimeError, match="nope"):
        BacktestEngine(CodedStrategy(mod, candles, quantity=1.0)).run(candles)
```

Append to `backend/tests/test_api_backtest_coded.py` (its `base_request` + fixture pattern):

```python
PARAMS_API_STRAT = '''
meta = {"params": [{"name": "n", "type": "int", "default": 3, "min": 1, "max": 50}]}
def on_bar(ctx):
    if ctx.position.is_flat and len(ctx.closes) >= ctx.param("n"):
        return [ctx.buy(reason="go")]
    return []
'''


def test_backtest_coded_params_change_behavior(client, strategies):
    candles = make_candles(30)
    req = base_request("params_api.py", candles)
    r1 = client.post("/api/backtest", json=req).json()
    req["codedParams"] = {"n": 20}
    r2 = client.post("/api/backtest", json=req).json()
    assert r2["markers"][0]["time"] > r1["markers"][0]["time"]


def test_backtest_coded_params_bad_value_422(client, strategies):
    req = base_request("params_api.py", make_candles(10))
    req["codedParams"] = {"n": "lots"}
    resp = client.post("/api/backtest", json=req)
    assert resp.status_code == 422
    assert "n" in resp.json()["detail"]
```

(Register `params_api.py` with `PARAMS_API_STRAT` in that file's `strategies` fixture.) Mirror the two tests in `test_api_evaluate_coded.py` against `/api/strategy/evaluate` (assert an action/no-action difference or that the 422 fires; follow that file's request builder).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_strategy_params.py tests/test_coded_strategy.py tests/test_api_backtest_coded.py tests/test_api_evaluate_coded.py -v`
Expected: FAIL — no `resolve_params`, unexpected `params=` kwarg, unknown `codedParams` field ignored by pydantic → behavior identical, 200 not 422.

- [ ] **Step 3: Implement**

`params.py` — append:

```python
def resolve_params(module, sent: dict | None) -> dict:
    """Panel values overlaid on the module's declared defaults. Unknown sent
    keys are dropped (file edited between runs — stale keys must not error);
    a value that doesn't fit its spec raises ValueError naming the param."""
    schema = validate_params_schema(getattr(module, "meta", None) if isinstance(getattr(module, "meta", None), dict) else None)
    out = {p["name"]: p["default"] for p in schema}
    specs = {p["name"]: p for p in schema}
    for name, value in (sent or {}).items():
        spec = specs.get(name)
        if spec is None:
            continue
        v = _check_value(name, spec["type"], spec["options"], value, "value")
        lo, hi = spec["min"], spec["max"]
        if lo is not None and v < lo or hi is not None and v > hi:
            raise ValueError(f"param '{name}': value {v} outside [min, max]")
        out[name] = v
    return out
```

`coded.py` — `CodedStrategy.__init__` gains `params: dict | None = None`; store:

```python
from auto_trader.strategy.params import resolve_params
...
        # Resolved panel params (defaults when none sent). Direct instantiation
        # (tests) may omit them; routes resolve first so a bad value 422s
        # before any bars run.
        self.params = params if params is not None else resolve_params(module, None)
```

`StrategyContext` — add next to the indicator methods:

```python
    def param(self, name: str):
        """A panel-tunable value declared in meta["params"] (panel value if
        set, else the declared default)."""
        try:
            return self._strategy.params[name]
        except KeyError:
            declared = sorted(self._strategy.params) or ["<none declared>"]
            raise StrategyRuntimeError(
                f"unknown param '{name}' — declared params: {declared}"
            ) from None
```

`schemas.py` — on BOTH `BacktestRequest` and `EvaluateRequest`, next to `codedStrategy`:

```python
    codedParams: dict[str, int | float | bool | str] | None = None
```

Both routes, in the coded branch right after `load_strategy` succeeds:

```python
        try:
            resolved_params = resolve_params(module, req.codedParams)
        except ValueError as e:
            raise HTTPException(422, str(e))
```

and pass `params=resolved_params` into every `CodedStrategy(...)` construction (backtest.py builds it inside the NeedTimeframe loop — resolve ONCE before the loop; strategy.py likewise).

`ema_cross.py` — make it the reference example:

```python
"""EMA fast/slow crossover with an RSI filter. Longs only.
Attaches a %-based stop and target; exits early when RSI tops the ceiling.

Higher-timeframe values: ctx.ema(9, tf="HOUR_4"); slopes: ctx.slope("EMA", 9, 3)."""

meta = {
    "name": "EMA Cross + RSI",
    "params": [
        {"name": "ema_fast", "label": "Fast EMA", "type": "int", "default": 9, "min": 2, "max": 200, "step": 1},
        {"name": "ema_slow", "label": "Slow EMA", "type": "int", "default": 21, "min": 2, "max": 400, "step": 1},
        {"name": "rsi_max", "label": "RSI ceiling", "type": "float", "default": 70, "min": 0, "max": 100},
        {"name": "stop_pct", "label": "Stop %", "type": "float", "default": 2.0, "min": 0.1, "max": 20},
        {"name": "target_pct", "label": "Target %", "type": "float", "default": 4.0, "min": 0.1, "max": 50},
    ],
}


def on_bar(ctx):
    fast, slow = ctx.param("ema_fast"), ctx.param("ema_slow")
    if ctx.position.is_flat and ctx.ema(fast) is not None and ctx.ema(slow) is not None:
        if ctx.ema(fast) > ctx.ema(slow) and (ctx.rsi(14) or 0) < ctx.param("rsi_max"):
            return [ctx.buy(
                sl=ctx.close * (1 - ctx.param("stop_pct") / 100),
                tp=ctx.close * (1 + ctx.param("target_pct") / 100),
                reason=f"EMA{fast}>EMA{slow} & RSI<{ctx.param('rsi_max')}",
                note={"ema_fast": ctx.ema(fast), "ema_slow": ctx.ema(slow), "rsi": ctx.rsi(14)},
            )]
    if ctx.position.is_long and (ctx.rsi(14) or 0) > ctx.param("rsi_max"):
        return [ctx.close_long(reason=f"RSI>{ctx.param('rsi_max')}")]
    return []
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/ -v`
Expected: all PASS (full suite — `ema_cross.py` changed, parity/backtest tests must stay green).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader backend/strategies/ema_cross.py backend/tests
git commit -m "feat(strategies): ctx.param() + codedParams through backtest and evaluate"
```

---

### Task 3: Backend — panel risk overrides file brackets on coded runs

**Files:**
- Modify: `backend/auto_trader/strategy/coded.py` (`panel_risk_legs`, `file_brackets_overridden`)
- Modify: `backend/auto_trader/api/schemas.py` (`BacktestResponse.fileBracketsOverridden`)
- Modify: `backend/auto_trader/api/routers/backtest.py`, `backend/auto_trader/api/routers/strategy.py`
- Test: extend `backend/tests/test_backtest_signal_brackets.py`

**Interfaces:**
- Consumes: `CodedStrategy` (Tasks 1–2 shape); `BacktestEngine(long_risk=, short_risk=)` (existing); evaluate route's existing "signal bracket else risk config" logic at `strategy.py:171-187`.
- Produces: `CodedStrategy(..., panel_risk_legs: frozenset[str] = frozenset())`; `CodedStrategy.file_brackets_overridden: bool` (set when a stripped signal actually carried sl/tp); `BacktestResponse.fileBracketsOverridden: bool = False`. Task 8's panel chip reads the response field.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_backtest_signal_brackets.py` (reuse its candle/engine helpers):

```python
BRACKET_STRAT = '''
def on_bar(ctx):
    if ctx.position.is_flat:
        return [ctx.buy(sl=ctx.close * 0.99, tp=ctx.close * 1.01, reason="in")]
    return []
'''


def test_panel_risk_strips_file_brackets():
    candles = make_candles(40)
    mod = exec_module(BRACKET_STRAT)
    strat = CodedStrategy(mod, candles, quantity=1.0, panel_risk_legs=frozenset({"long"}))
    risk = RiskConfig(StopSpec("pct", 5.0), TargetSpec("pct", 10.0))
    result = BacktestEngine(strat, long_risk=risk).run(candles)
    assert strat.file_brackets_overridden is True
    # Engine applied the 5% panel stop, not the 1% file stop.
    t = result.trades[0]
    assert t.stop_initial is not None
    assert abs(t.stop_initial / t.entry_price - 0.95) < 0.005


def test_no_panel_risk_keeps_file_brackets():
    candles = make_candles(40)
    mod = exec_module(BRACKET_STRAT)
    strat = CodedStrategy(mod, candles, quantity=1.0)
    result = BacktestEngine(strat).run(candles)
    assert strat.file_brackets_overridden is False
    t = result.trades[0]
    assert abs(t.stop_initial / t.entry_price - 0.99) < 0.005
```

API-level, append to `backend/tests/test_api_backtest_coded.py`:

```python
def test_backtest_response_flags_bracket_override(client, strategies):
    req = base_request("bracket.py", make_candles(40))          # register BRACKET_STRAT as bracket.py
    assert client.post("/api/backtest", json=req).json()["fileBracketsOverridden"] is False
    req["longRisk"] = {"stop": {"kind": "pct", "value": 5}, "target": {"kind": "none"}}
    assert client.post("/api/backtest", json=req).json()["fileBracketsOverridden"] is True
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_backtest_signal_brackets.py tests/test_api_backtest_coded.py -v`
Expected: FAIL — unexpected `panel_risk_legs` kwarg / missing response field.

- [ ] **Step 3: Implement**

`coded.py` `__init__`: add `panel_risk_legs: frozenset[str] = frozenset()` param; store it and `self.file_brackets_overridden = False`. In `on_bar`'s open branch, replace the direct `stop_level=a.stop, target_level=a.target` with:

```python
                stop, target = a.stop, a.target
                if a.leg in self.panel_risk_legs:
                    # Panel risk owns this side's exits: the file's sl=/tp= are
                    # dropped so the engine's side-level RiskConfig applies.
                    if stop is not None or target is not None:
                        self.file_brackets_overridden = True
                    stop = target = None
                signals.append(Signal(
                    side, qty, a.reason, leg=a.leg,
                    terms=_note_terms(a.note),
                    stop_level=stop, target_level=target,
                    quantity_explicit=a.qty is not None,
                ))
```

Both routes' coded branches compute once, before constructing the strategy:

```python
        panel_risk_legs = frozenset(
            leg for leg, r in (("long", req.longRisk), ("short", req.shortRisk)) if r is not None
        )
```

and pass `panel_risk_legs=panel_risk_legs` to `CodedStrategy(...)`. In `backtest.py`, after the run loop, thread `fileBracketsOverridden=strategy.file_brackets_overridden` into the `BacktestResponse(...)` construction; add the field to the DTO:

```python
    fileBracketsOverridden: bool = False
```

`strategy.py` (evaluate) needs no bracket logic change beyond the constructor kwarg — with `stop_level`/`target_level` stripped, its existing `else compute from risk config` branch (lines 174–181) applies the panel risk. Note for live: the ATR risk kinds read `req.series` (`_atr(...)`) — the frontend starts sending those series in Task 9.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/ -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader backend/tests
git commit -m "feat(coded): panel risk overrides file sl=/tp= brackets, flagged in the response"
```

---

### Task 4: Backend — exit rule groups compose onto coded runs

**Files:**
- Modify: `backend/auto_trader/strategy/coded.py` (add `CodedWithRuleExits`)
- Modify: `backend/auto_trader/api/routers/backtest.py`, `backend/auto_trader/api/routers/strategy.py`
- Test: `backend/tests/test_coded_rule_exits.py`

**Interfaces:**
- Consumes: `CodedStrategy`; `RuleStrategy(long_entry, long_exit, short_entry, short_exit, series, quantity, ...)` (`strategy/rule.py:168`); `RuleGroupDTO.to_group()`; fact verified in code: `RuleStrategy._eval_group` returns `False` for an empty group (`rule.py:253-254`), so empty entry groups never fire.
- Produces: `CodedWithRuleExits(coded: CodedStrategy, rule_exits: RuleStrategy)` — a `Strategy` whose `on_bar` returns the coded signals plus rule-exit signals, deduped to one close per leg per bar. Routes build it whenever a coded request carries non-empty `longExit`/`shortExit` rules.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_coded_rule_exits.py`:

```python
"""Exit rule groups riding along on a coded run (panel exits for coded mode)."""

from datetime import datetime, timedelta, timezone
from types import ModuleType

from auto_trader.core.models import Candle, Side
from auto_trader.engine.backtest import BacktestEngine
from auto_trader.strategy.coded import CodedStrategy, CodedWithRuleExits
from auto_trader.strategy.rule import Operand, Rule, RuleGroup, RuleStrategy

HOLD_FOREVER = '''
def on_bar(ctx):
    if ctx.position.is_flat:
        return [ctx.buy(reason="in")]
    return []
'''

CLOSES_ITSELF = '''
def on_bar(ctx):
    if ctx.position.is_flat:
        return [ctx.buy(reason="in")]
    return [ctx.close_long(reason="own exit")]
'''


def make_candles(n=20):
    t0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return [Candle(time=t0 + timedelta(hours=i), open=100, high=101, low=99,
                   close=100, volume=10) for i in range(n)]


def exec_module(src: str) -> ModuleType:
    m = ModuleType("m")
    exec(src, m.__dict__)
    return m


def exits_only_rule_strategy(exit_rule: Rule, series) -> RuleStrategy:
    empty = RuleGroup(combine="AND", rules=[])
    exit_group = RuleGroup(combine="AND", rules=[exit_rule])
    return RuleStrategy(empty, exit_group, empty, RuleGroup(combine="AND", rules=[]),
                        series, quantity=1.0)


def test_rule_exit_closes_coded_position():
    candles = make_candles(20)
    # Series that flips above 0 at bar 10 — rule: SIG > 0 exits.
    series = {"SIG": [(-1.0 if i < 10 else 1.0) for i in range(20)]}
    rule = Rule(left=Operand(kind="series", name="SIG"), op="gt",
                right=Operand(kind="const", value=0.0))
    coded = CodedStrategy(exec_module(HOLD_FOREVER), candles, quantity=1.0)
    strat = CodedWithRuleExits(coded, exits_only_rule_strategy(rule, series))
    result = BacktestEngine(strat).run(candles)
    assert result.trades, "rule exit should have closed the coded entry"
    assert result.trades[0].reason_out and "own exit" not in result.trades[0].reason_out


def test_one_close_per_leg_when_both_fire():
    candles = make_candles(20)
    series = {"SIG": [1.0] * 20}                       # rule exit true every bar
    rule = Rule(left=Operand(kind="series", name="SIG"), op="gt",
                right=Operand(kind="const", value=0.0))
    coded = CodedStrategy(exec_module(CLOSES_ITSELF), candles, quantity=1.0)
    strat = CodedWithRuleExits(coded, exits_only_rule_strategy(rule, series))
    ctx_signals = []
    # Run through the engine; if both closes emitted per bar the engine would
    # see a second close on a flat book — assert trades come out 1 close each.
    result = BacktestEngine(strat).run(candles)
    for t in result.trades:
        assert t.reason_out == "own exit"              # coded close wins (emitted first)


def test_no_zero_size_close_on_the_entry_bar():
    # Rule exit is TRUE on the very bar the coded strategy signals its entry
    # (flat → buy). The position hasn't filled yet, so the rule exit's size is
    # 0 — it must be skipped, not emitted; the exit then fires the NEXT bar.
    candles = make_candles(20)
    series = {"SIG": [1.0] * 20}
    rule = Rule(left=Operand(kind="series", name="SIG"), op="gt",
                right=Operand(kind="const", value=0.0))
    coded = CodedStrategy(exec_module(HOLD_FOREVER), candles, quantity=1.0)
    strat = CodedWithRuleExits(coded, exits_only_rule_strategy(rule, series))
    result = BacktestEngine(strat).run(candles)
    assert result.trades, "positions should open and be rule-exited"
    for t in result.trades:
        assert t.quantity > 0
        assert t.exit_time > t.entry_time              # never closed on the entry bar
```

Adapt the `Rule`/`Operand` constructor kwargs to the real dataclasses in `strategy/rule.py` — read them first (names like `left`/`op`/`right`/`kind`/`value` must match exactly what `RuleGroupDTO.to_group()` produces).

Then an API test in `test_api_backtest_coded.py`: post a coded request whose `longExit` has one rule against an inline `series` (same SIG shape) and assert the trade's exit reason comes from the rule.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_coded_rule_exits.py -v`
Expected: FAIL — `ImportError: CodedWithRuleExits`.

- [ ] **Step 3: Implement**

`coded.py`:

```python
class CodedWithRuleExits(Strategy):
    """A coded strategy plus panel-authored exit rule groups: the coded module
    supplies entries (and any exits of its own); a RuleStrategy configured with
    EMPTY entry groups contributes rule-based exits. One close per leg per bar
    — the coded module's own close wins when both fire."""

    _CLOSES = {("long", Side.SELL), ("short", Side.BUY)}

    def __init__(self, coded: CodedStrategy, rule_exits: "RuleStrategy") -> None:
        self.coded = coded
        self.rule_exits = rule_exits
        self.hedged = coded.hedged

    @property
    def file_brackets_overridden(self) -> bool:
        return self.coded.file_brackets_overridden

    def on_bar(self, ctx: Context) -> list[Signal]:
        out = self.coded.on_bar(ctx)
        closed = {s.leg for s in out if (s.leg, s.side) in self._CLOSES}
        for s in self.rule_exits.on_bar(ctx):
            if (s.leg, s.side) in self._CLOSES and s.leg not in closed:
                # Rule exits close the WHOLE held side, like coded ctx.exit().
                # size can be 0 on the coded entry's own signal bar (the buy
                # hasn't filled yet) — a zero-size close must not be emitted.
                size = ctx.position_long if s.leg == "long" else ctx.position_short
                if size <= 0:
                    continue
                out.append(Signal(s.side, size, s.reason, leg=s.leg,
                                  terms=s.terms, combine=s.combine))
                closed.add(s.leg)
        return out
```

(`from auto_trader.strategy.rule import RuleStrategy` under `TYPE_CHECKING`, or import directly — `rule.py` does not import `coded.py`, so no cycle.)

Both routes' coded branches, after constructing `CodedStrategy` (inside the NeedTimeframe rebuild loop in `backtest.py`, since the strategy is rebuilt per pass):

```python
            strategy: Strategy = CodedStrategy(...)  # existing construction
            if req.longExit.rules or req.shortExit.rules:
                empty = RuleGroupDTO(combine="AND", rules=[]).to_group()
                strategy = CodedWithRuleExits(strategy, RuleStrategy(
                    empty, req.longExit.to_group(), empty, req.shortExit.to_group(),
                    req.series, quantity=req.costs.quantity,
                    long_enabled=req.longEnabled, short_enabled=req.shortEnabled,
                    base_timeframe=req.resolution,
                ))
```

The `fileBracketsOverridden` read in `backtest.py` still works via the property. In `strategy.py` (evaluate), the coded branch calls `strategy.on_bar(ctx)` — the same wrapping applies before that call; evaluate's existing series-validation for rule mode (missing-series 422) must also run for coded requests that carry exit rules — check where that validation lives (`backtest.py:56/85` guard block) and make its condition include `req.codedStrategy is not None and (req.longExit.rules or req.shortExit.rules)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/ -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader backend/tests
git commit -m "feat(coded): panel exit rule groups compose onto coded runs (backtest + live)"
```

---

### Task 5: Backend sweep endpoint

**Files:**
- Modify: `backend/auto_trader/api/schemas.py` (SweepDTO, SweepRowDTO, SweepResponse, `BacktestRequest.sweep`)
- Modify: `backend/auto_trader/api/routers/backtest.py` (extract shared run helper + `/api/backtest/sweep`)
- Test: `backend/tests/test_api_backtest_sweep.py`

**Interfaces:**
- Consumes: everything Tasks 2–4 produce; `compute_metrics(trades, equity, net_pnl, starting_cash, resolution_secs)` (`engine/metrics.py:16`); `resolution_seconds`.
- Produces: `POST /api/backtest/sweep` accepting a `BacktestRequest` with `sweep: {"combos": [{"param:ema_fast": 5, "risk:long.stop.value": 1.0}, ...]}` (≤50 combos/request), returning `{"rows": [{"combo": {...}, "metrics": {...} | null, "error": str | null}]}` where metrics = `{net_pnl, n_trades, win_rate, max_drawdown, profit_factor, return_pct}`. Task 6's client types mirror this exactly.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_api_backtest_sweep.py` (reuse `make_candles`/`base_request`/fixture patterns from `test_api_backtest_coded.py`; register `PARAMS_API_STRAT` from Task 2 and `RAISING`-on-param strategy):

```python
SWEEP_STRAT = '''
meta = {"params": [{"name": "n", "type": "int", "default": 3, "min": 1, "max": 50}]}
def on_bar(ctx):
    if ctx.param("n") == 13:
        raise RuntimeError("unlucky combo")
    if ctx.position.is_flat and len(ctx.closes) >= ctx.param("n"):
        return [ctx.buy(sl=ctx.close * 0.99, reason="go")]
    return []
'''


def sweep_request(candles, combos):
    req = base_request("sweep.py", candles)
    req["sweep"] = {"combos": combos}
    return req


def test_sweep_rows_one_per_combo_with_metrics(client, strategies):
    candles = make_candles(40)
    rows = client.post("/api/backtest/sweep", json=sweep_request(
        candles, [{"param:n": 3}, {"param:n": 20}],
    )).json()["rows"]
    assert len(rows) == 2
    assert rows[0]["combo"] == {"param:n": 3}
    assert rows[0]["error"] is None
    m = rows[0]["metrics"]
    assert set(m) == {"net_pnl", "n_trades", "win_rate", "max_drawdown",
                      "profit_factor", "return_pct"}
    # Different n => different trade counts.
    assert rows[0]["metrics"]["n_trades"] != rows[1]["metrics"]["n_trades"]


def test_sweep_risk_target_patches_risk(client, strategies):
    candles = make_candles(40)
    req = sweep_request(candles, [{"risk:long.stop.value": 0.1},
                                  {"risk:long.stop.value": 10.0}])
    req["longRisk"] = {"stop": {"kind": "pct", "value": 2}, "target": {"kind": "none"}}
    rows = client.post("/api/backtest/sweep", json=req).json()["rows"]
    # A 0.1% stop churns out more (stopped) trades than a 10% stop.
    assert rows[0]["metrics"]["n_trades"] > rows[1]["metrics"]["n_trades"]


def test_sweep_error_isolated_per_combo(client, strategies):
    rows = client.post("/api/backtest/sweep", json=sweep_request(
        make_candles(40), [{"param:n": 13}, {"param:n": 3}],
    )).json()["rows"]
    assert rows[0]["metrics"] is None and "unlucky" in rows[0]["error"]
    assert rows[1]["error"] is None and rows[1]["metrics"]["n_trades"] > 0


def test_sweep_caps_combos(client, strategies):
    resp = client.post("/api/backtest/sweep", json=sweep_request(
        make_candles(10), [{"param:n": i} for i in range(1, 52)],
    ))
    assert resp.status_code == 422


def test_sweep_bad_target_422(client, strategies):
    resp = client.post("/api/backtest/sweep", json=sweep_request(
        make_candles(10), [{"bogus:thing": 1}],
    ))
    assert resp.status_code == 422
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_api_backtest_sweep.py -v`
Expected: FAIL — 404 (no route).

- [ ] **Step 3: Refactor + implement**

First extract the existing coded-run body in `backtest.py` (the load → resolve → NeedTimeframe loop → `engine.run`, lines ~88–140) into a helper so single-run and sweep share it:

```python
async def _run_coded(
    req: BacktestRequest, candles: list[Candle], module: ModuleType,
    resolved_params: dict, long_risk_dto: RiskConfigDTO | None,
    short_risk_dto: RiskConfigDTO | None, htf_candles: dict[str, list[Candle]],
) -> tuple[BacktestResult, Strategy]:
    """One coded engine run: NeedTimeframe retry included; risk DTOs are
    passed explicitly (the sweep patches them per combo). Mutates htf_candles
    so repeat combos skip the fetch."""
```

Move the loop body in verbatim, replacing `req.longRisk`/`req.shortRisk` reads with the explicit DTO args (both in `panel_risk_legs` and the `BacktestEngine(long_risk=..., short_risk=...)` construction) and `req.codedParams` with `resolved_params`. The single-run endpoint calls it with `req.longRisk, req.shortRisk`. Keep the rule-mode path untouched.

Then schemas:

```python
class SweepDTO(BaseModel):
    """Explicit combo list — the frontend enumerates the grid and chunks it.
    Keys: "param:<name>" (codedParams override) or
    "risk:<long|short>.<stop|target>.<value|mult>"."""
    combos: list[dict[str, float | int | bool | str]]


class SweepRowDTO(BaseModel):
    combo: dict[str, float | int | bool | str]
    metrics: dict | None = None
    error: str | None = None


class SweepResponse(BaseModel):
    rows: list[SweepRowDTO]
```

and `sweep: SweepDTO | None = None` on `BacktestRequest`.

Route:

```python
_SWEEP_MAX_COMBOS = 50
_RISK_TARGET = re.compile(r"^risk:(long|short)\.(stop|target)\.(value|mult)$")


def _apply_combo(req: BacktestRequest, combo: dict) -> tuple[dict, RiskConfigDTO | None, RiskConfigDTO | None]:
    """Split one combo into codedParams overrides + patched risk DTOs.
    Raises HTTPException(422) on a malformed target key."""
    params = dict(req.codedParams or {})
    risks = {"long": req.longRisk, "short": req.shortRisk}
    for target, value in combo.items():
        if target.startswith("param:"):
            name = target[len("param:"):]
            if not name.isidentifier():
                raise HTTPException(422, f"bad sweep target '{target}'")
            params[name] = value
            continue
        m = _RISK_TARGET.match(target)
        if not m:
            raise HTTPException(422, f"bad sweep target '{target}'")
        side, spec_name, field = m.groups()
        risk = risks[side]
        if risk is None:
            raise HTTPException(422, f"sweep target '{target}' but no {side} risk configured")
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            raise HTTPException(422, f"sweep target '{target}' needs a numeric value")
        spec = getattr(risk, spec_name).model_copy(update={field: float(value)})
        risks[side] = risk.model_copy(update={spec_name: spec})
    return params, risks["long"], risks["short"]


@router.post("/api/backtest/sweep", response_model=SweepResponse)
async def backtest_sweep(req: BacktestRequest) -> SweepResponse:
    if req.sweep is None or not req.sweep.combos:
        raise HTTPException(422, "sweep.combos is required")
    if len(req.sweep.combos) > _SWEEP_MAX_COMBOS:
        raise HTTPException(422, f"too many combos in one request (max {_SWEEP_MAX_COMBOS})")
    if req.codedStrategy is None:
        raise HTTPException(422, "sweep requires a coded strategy")
    try:
        module = loader.load_strategy(req.codedStrategy, loader.STRATEGIES_DIR)
    except StrategyLoadError as e:
        raise HTTPException(422, str(e))
    candles = [_candle_from_dto(c) for c in req.candles]
    htf_candles: dict[str, list[Candle]] = {}     # shared across every combo
    rows: list[SweepRowDTO] = []
    for combo in req.sweep.combos:
        params_sent, long_risk, short_risk = _apply_combo(req, combo)
        try:
            resolved = resolve_params(module, params_sent)
            result, _ = await _run_coded(
                req, candles, module, resolved, long_risk, short_risk, htf_candles,
            )
        except HTTPException:
            raise                                  # request-shaped problems fail the chunk
        except Exception as e:                     # noqa: BLE001 — one combo must not kill the rest
            rows.append(SweepRowDTO(combo=combo, error=str(e)))
            continue
        metrics = compute_metrics(result.trades, result.equity, result.net_pnl,
                                  req.costs.startingCash, resolution_seconds(req.resolution))
        rows.append(SweepRowDTO(combo=combo, metrics={
            "net_pnl": round(result.net_pnl, 5),
            "n_trades": result.n_trades,
            "win_rate": round(result.win_rate, 4),
            "max_drawdown": round(result.max_drawdown, 5),
            "profit_factor": metrics.get("profit_factor"),
            "return_pct": metrics.get("return_pct"),
        }))
    return SweepResponse(rows=rows)
```

(A `ValueError` from `resolve_params` on a swept value lands in the row's `error` via the broad except — a bad combo value greys one row, matching the spec. Bad target *keys* 422 the whole chunk, which is a malformed request, not a bad combo.)

Known/accepted: the chunk's ≤50 `engine.run` calls are CPU-bound inside one `async def`, blocking the event loop for the chunk's duration. Fine at this scale (single user, ~20-combo chunks); revisit with `run_in_executor` only if the UI visibly stalls during sweeps — do NOT add it preemptively.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/ -v`
Expected: all PASS (single-run coded tests confirm the `_run_coded` extraction changed nothing).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader backend/tests
git commit -m "feat(backtest): /api/backtest/sweep — per-combo coded runs with shared HTF fetches"
```

---

### Task 6: Frontend types + coded-config store (two value sets)

**Files:**
- Modify: `frontend/src/api.ts` (ParamSpec, StrategyInfo.params, codedParams + fileBracketsOverridden, sweep types + `runSweepChunk`)
- Modify: `frontend/src/lib/liveTypes.ts` (`EvaluateRequest.codedParams`)
- Create: `frontend/src/lib/codedConfig.ts`
- Test: `frontend/src/lib/codedConfig.test.ts`

**Interfaces:**
- Consumes: `save`/`load` from `lib/persist/core.ts` (synced by default — no DEVICE_LOCAL registration needed); `RiskConfig`, `RuleGroup` from `lib/backtestConfig.ts`; Task 1's ParamSpec JSON and Task 5's sweep JSON.
- Produces (exact — Tasks 7–10 import these):

```typescript
// api.ts
export interface ParamSpec {
  name: string; label: string; type: "int" | "float" | "bool" | "choice";
  default: number | boolean | string;
  min: number | null; max: number | null; step: number | null;
  options: string[] | null; help: string | null;
}
// StrategyInfo gains: params: ParamSpec[];
// BacktestRequest + BacktestResult gain: codedParams?: ParamValues; fileBracketsOverridden?: boolean;
export type ParamValues = Record<string, number | boolean | string>;
export interface SweepRow { combo: Record<string, number | boolean | string>;
  metrics: { net_pnl: number; n_trades: number; win_rate: number; max_drawdown: number;
             profit_factor: number | null; return_pct: number } | null;
  error: string | null; }
export async function runSweepChunk(req: BacktestRequest,
  combos: Array<Record<string, number | boolean | string>>): Promise<SweepRow[]>

// lib/codedConfig.ts
export interface CodedStrategyConfig {
  params: ParamValues;
  longRisk?: RiskConfig; shortRisk?: RiskConfig;
  longExit: RuleGroup; shortExit: RuleGroup;
}
export type CodedSetName = "backtest" | "live";
export function loadCodedCfg(set: CodedSetName, filename: string): CodedStrategyConfig
export function saveCodedCfg(set: CodedSetName, filename: string, cfg: CodedStrategyConfig): void
export function resolveParamValues(specs: ParamSpec[], stored: ParamValues): ParamValues
export function codedCfgsDiffer(a: CodedStrategyConfig, b: CodedStrategyConfig): boolean
```

- [ ] **Step 1: Write the failing tests**

`frontend/src/lib/codedConfig.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from "vitest";
import {
  codedCfgsDiffer, loadCodedCfg, resolveParamValues, saveCodedCfg,
} from "./codedConfig";
import type { ParamSpec } from "../api";

const spec = (over: Partial<ParamSpec> = {}): ParamSpec => ({
  name: "ema_fast", label: "Fast EMA", type: "int", default: 9,
  min: 2, max: 50, step: 1, options: null, help: null, ...over,
});

beforeEach(() => localStorage.clear());

describe("codedConfig store", () => {
  it("returns an empty default config for an unknown filename", () => {
    const cfg = loadCodedCfg("backtest", "new.py");
    expect(cfg.params).toEqual({});
    expect(cfg.longExit.rules).toEqual([]);
    expect(cfg.longRisk).toBeUndefined();
  });

  it("keeps backtest and live sets independent", () => {
    const base = loadCodedCfg("backtest", "s.py");
    saveCodedCfg("backtest", "s.py", { ...base, params: { ema_fast: 12 } });
    expect(loadCodedCfg("backtest", "s.py").params).toEqual({ ema_fast: 12 });
    expect(loadCodedCfg("live", "s.py").params).toEqual({});
  });

  it("keeps per-filename configs independent", () => {
    const base = loadCodedCfg("backtest", "a.py");
    saveCodedCfg("backtest", "a.py", { ...base, params: { ema_fast: 12 } });
    expect(loadCodedCfg("backtest", "b.py").params).toEqual({});
  });
});

describe("resolveParamValues", () => {
  it("fills defaults and keeps valid stored values", () => {
    expect(resolveParamValues([spec()], {})).toEqual({ ema_fast: 9 });
    expect(resolveParamValues([spec()], { ema_fast: 12 })).toEqual({ ema_fast: 12 });
  });

  it("drops unknown keys and out-of-range/mistyped values", () => {
    expect(resolveParamValues([spec()], { gone: 1, ema_fast: 999 }))
      .toEqual({ ema_fast: 9 });
    expect(resolveParamValues([spec()], { ema_fast: "nine" }))
      .toEqual({ ema_fast: 9 });
    expect(resolveParamValues(
      [spec({ type: "choice", default: "a", options: ["a", "b"], min: null, max: null, step: null })],
      { ema_fast: "c" },
    )).toEqual({ ema_fast: "a" });
  });
});

describe("codedCfgsDiffer", () => {
  it("detects param and risk drift", () => {
    const a = loadCodedCfg("backtest", "x.py");
    expect(codedCfgsDiffer(a, { ...a })).toBe(false);
    expect(codedCfgsDiffer(a, { ...a, params: { n: 1 } })).toBe(true);
    expect(codedCfgsDiffer(a, {
      ...a, longRisk: { stop: { kind: "pct", value: 2 }, target: { kind: "none" } },
    })).toBe(true);
  });

  it("ignores key order and absent-vs-undefined fields", () => {
    const a = { ...loadCodedCfg("backtest", "x.py"), params: { a: 1, b: 2 } };
    const b = { ...loadCodedCfg("backtest", "x.py"), params: { b: 2, a: 1 } };
    expect(codedCfgsDiffer(a, b)).toBe(false);
    expect(codedCfgsDiffer(a, { ...a, longRisk: undefined })).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/codedConfig.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`lib/codedConfig.ts`:

```typescript
// Per-strategy-file coded config: the panel-tunable half of a coded run
// (params + risk + exit rule groups). BACKTEST and LIVE are deliberately
// SEPARATE sets — fiddling with a knob in the backtest panel must never
// change what an armed live strategy does. Synced via save() (cross-device).

import type { ParamSpec, ParamValues } from "../api";
import type { RiskConfig, RuleGroup } from "./backtestConfig";
import { load, save } from "./persist/core";

export interface CodedStrategyConfig {
  params: ParamValues;
  longRisk?: RiskConfig;
  shortRisk?: RiskConfig;
  longExit: RuleGroup;
  shortExit: RuleGroup;
}

export type CodedSetName = "backtest" | "live";

// ONE persist key PER (set, filename) — never a whole-store snapshot object.
// A single store object would be the full-snapshot-write pattern that caused
// the cross-tab overlay stomp: two panels editing configs for DIFFERENT files
// would race on the shared key and last-write-wins would drop one edit.
const KEY = (set: CodedSetName, filename: string) =>
  `auto-trader.codedCfg.${set}.${filename}`;

const emptyGroup = (): RuleGroup => ({ combine: "AND", rules: [] });

export function defaultCodedCfg(): CodedStrategyConfig {
  return { params: {}, longExit: emptyGroup(), shortExit: emptyGroup() };
}

export function loadCodedCfg(set: CodedSetName, filename: string): CodedStrategyConfig {
  return load<CodedStrategyConfig | null>(KEY(set, filename), null) ?? defaultCodedCfg();
}

export function saveCodedCfg(set: CodedSetName, filename: string, cfg: CodedStrategyConfig): void {
  save(KEY(set, filename), cfg);
}

/** Stored values overlaid on the schema's defaults; anything stale (unknown
 * name, wrong type, out of range, not in options) silently falls back to the
 * default — the file may have changed since the values were saved. */
export function resolveParamValues(specs: ParamSpec[], stored: ParamValues): ParamValues {
  const out: ParamValues = {};
  for (const s of specs) {
    const v = stored[s.name];
    out[s.name] = isValid(s, v) ? (s.type === "int" ? Math.round(v as number) : v!) : s.default;
  }
  return out;
}

function isValid(s: ParamSpec, v: number | boolean | string | undefined): boolean {
  if (v === undefined) return false;
  if (s.type === "bool") return typeof v === "boolean";
  if (s.type === "choice") return typeof v === "string" && (s.options ?? []).includes(v);
  if (typeof v !== "number" || !Number.isFinite(v)) return false;
  if (s.min !== null && v < s.min) return false;
  if (s.max !== null && v > s.max) return false;
  return true;
}

/** Structural compare — JSON.stringify would be key-order sensitive and flash
 * spurious "differs from backtest" / "edits apply on next arm" badges when two
 * code paths build the same config with keys in a different order. */
export function codedCfgsDiffer(a: CodedStrategyConfig, b: CodedStrategyConfig): boolean {
  return !deepEqual(a, b);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual(
    (a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k],
  ));
}
```

`api.ts`: add `ParamSpec`, `ParamValues`, `params: ParamSpec[]` on `StrategyInfo`, `codedParams?: ParamValues` on `BacktestRequest`, `fileBracketsOverridden?: boolean` on `BacktestResult`, `SweepRow`, and (mirroring the existing `runBacktest` fetch helper style):

```typescript
export async function runSweepChunk(
  req: BacktestRequest,
  combos: Array<Record<string, number | boolean | string>>,
): Promise<SweepRow[]> {
  const res = await fetch(`${API_BASE}/api/backtest/sweep`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...req, sweep: { combos } }),
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()).rows as SweepRow[];
}
```

(Match the surrounding fetch idiom in `api.ts` exactly — error shape, base-URL constant name.) `lib/liveTypes.ts`: add `codedParams?: ParamValues;` to `EvaluateRequest`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/codedConfig.test.ts && npx tsc --noEmit -p .`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api.ts frontend/src/lib/liveTypes.ts frontend/src/lib/codedConfig.ts frontend/src/lib/codedConfig.test.ts
git commit -m "feat(frontend): coded param types + per-file backtest/live coded-config store"
```

---

### Task 7: `StrategyParams` control component

**Files:**
- Create: `frontend/src/components/StrategyParams.tsx`
- Test: `frontend/src/components/StrategyParams.test.tsx`

**Interfaces:**
- Consumes: `ParamSpec`, `ParamValues` (Task 6); `NumberField` (`components/NumberField.tsx`); `InfoTip` (`components/InfoTip.tsx`).
- Produces:

```typescript
export function StrategyParams(props: {
  specs: ParamSpec[];
  values: ParamValues;                    // resolved (defaults already filled)
  onChange: (values: ParamValues) => void;
  sweep?: {                               // Task 10 wires this; undefined = no sweep toggles
    axes: SweepAxis[];                    // from lib/sweep.ts
    onToggle: (target: string, spec: ParamSpec) => void;
  };
}): JSX.Element | null                    // null when specs is empty
```

- [ ] **Step 1: Write the failing tests**

`frontend/src/components/StrategyParams.test.tsx` (follow the render/fireEvent idioms of `StrategyPicker.test.tsx`):

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StrategyParams } from "./StrategyParams";
import type { ParamSpec } from "../api";

const specs: ParamSpec[] = [
  { name: "ema_fast", label: "Fast EMA", type: "int", default: 9,
    min: 2, max: 50, step: 1, options: null, help: "EMA length" },
  { name: "longs_only", label: "Longs only", type: "bool", default: true,
    min: null, max: null, step: null, options: null, help: null },
  { name: "mode", label: "Mode", type: "choice", default: "fast",
    min: null, max: null, step: null, options: ["fast", "slow"], help: null },
];

describe("StrategyParams", () => {
  it("renders one control per spec with default hints", () => {
    render(<StrategyParams specs={specs}
      values={{ ema_fast: 9, longs_only: true, mode: "fast" }} onChange={() => {}} />);
    expect(screen.getByText("Fast EMA")).toBeTruthy();
    expect(screen.getByRole("switch")).toBeTruthy();
    expect(screen.getByRole("combobox")).toBeTruthy();
    expect(screen.getByText(/default 9/)).toBeTruthy();
  });

  it("emits changed values and marks them changed", () => {
    const onChange = vi.fn();
    const { container, rerender } = render(<StrategyParams specs={specs}
      values={{ ema_fast: 9, longs_only: true, mode: "fast" }} onChange={onChange} />);
    fireEvent.click(screen.getByRole("switch"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ longs_only: false }));
    rerender(<StrategyParams specs={specs}
      values={{ ema_fast: 12, longs_only: true, mode: "fast" }} onChange={onChange} />);
    expect(container.querySelector(".sp-changed")).toBeTruthy();
  });

  it("Reset all restores every default", () => {
    const onChange = vi.fn();
    render(<StrategyParams specs={specs}
      values={{ ema_fast: 12, longs_only: false, mode: "slow" }} onChange={onChange} />);
    fireEvent.click(screen.getByText("Reset all"));
    expect(onChange).toHaveBeenCalledWith({ ema_fast: 9, longs_only: true, mode: "fast" });
  });

  it("renders nothing for an empty schema", () => {
    const { container } = render(
      <StrategyParams specs={[]} values={{}} onChange={() => {}} />);
    expect(container.firstChild).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/StrategyParams.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`components/StrategyParams.tsx`:

```tsx
// Panel controls for a coded strategy's declared meta["params"] knobs.
// One row per spec: NumberField (int/float, clamped), switch (bool), or
// select (choice), with the default shown subtly and changed values tinted.

import type { ParamSpec, ParamValues } from "../api";
import type { SweepAxis } from "../lib/sweep";
import { InfoTip } from "./InfoTip";
import { NumberField } from "./NumberField";

interface Props {
  specs: ParamSpec[];
  values: ParamValues;
  onChange: (values: ParamValues) => void;
  sweep?: { axes: SweepAxis[]; onToggle: (target: string, spec: ParamSpec) => void };
}

export function StrategyParams({ specs, values, onChange, sweep }: Props) {
  if (!specs.length) return null;
  const set = (name: string, v: number | boolean | string) =>
    onChange({ ...values, [name]: v });
  const defaults = Object.fromEntries(specs.map((s) => [s.name, s.default]));
  const anyChanged = specs.some((s) => values[s.name] !== s.default);

  return (
    <div className="strategy-params">
      <div className="sp-head">
        <span className="sp-title">Parameters</span>
        {anyChanged && (
          <button type="button" className="sp-reset" onClick={() => onChange(defaults)}>
            Reset all
          </button>
        )}
      </div>
      {specs.map((s) => {
        const v = values[s.name] ?? s.default;
        const changed = v !== s.default;
        const swept = sweep?.axes.some((a) => a.target === `param:${s.name}`);
        return (
          <div key={s.name} className={`sp-row${changed ? " sp-changed" : ""}`}>
            <span className="sp-label">
              {s.label}
              {s.help && <InfoTip text={s.help} />}
            </span>
            {s.type === "bool" ? (
              <button type="button" role="switch" aria-checked={v as boolean}
                className="sp-switch" onClick={() => set(s.name, !(v as boolean))} />
            ) : s.type === "choice" ? (
              <select value={v as string} onChange={(e) => set(s.name, e.target.value)}>
                {(s.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : swept ? null : (
              <NumberField value={v as number}
                onChange={(n) => set(s.name, clamp(s, n))} />
            )}
            {(s.type === "int" || s.type === "float") && sweep && (
              <button type="button" className={`sp-sweep${swept ? " on" : ""}`}
                title="Sweep this parameter"
                onClick={() => sweep.onToggle(`param:${s.name}`, s)}>⇄</button>
            )}
            <span className="sp-default">default {String(s.default)}</span>
          </div>
        );
      })}
    </div>
  );
}

function clamp(s: ParamSpec, n: number): number {
  let v = s.type === "int" ? Math.round(n) : n;
  if (s.min !== null) v = Math.max(s.min, v);
  if (s.max !== null) v = Math.min(s.max, v);
  return v;
}
```

Create `lib/sweep.ts` with just the `SweepAxis` type for now (Task 10 fills it in): `export interface SweepAxis { target: string; label: string; from: number; to: number; step: number }`. Add the `.strategy-params` styles next to wherever `StrategyPicker`'s styles live (same CSS file the backtest modal uses) — flat, no shadows, content-sized, light-first; `.sp-changed .sp-label` gets the accent tint; `.sp-default` is small muted text.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/StrategyParams.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/StrategyParams.tsx frontend/src/components/StrategyParams.test.tsx frontend/src/lib/sweep.ts
git commit -m "feat(frontend): StrategyParams — panel controls for coded strategy params"
```

---

### Task 8: Backtest panel integration (coded mode = params + risk + exits)

**Files:**
- Modify: `frontend/src/BacktestSettingsModal.tsx` (coded-mode sections, ~line 966-970)
- Modify: `frontend/src/BacktestButton.tsx` (request assembly, ~lines 180-219)
- Modify: `frontend/src/BacktestPanel.tsx` (override chip)
- Test: extend `frontend/src/BacktestSettingsModal.test.tsx`

**Interfaces:**
- Consumes: `loadCodedCfg("backtest", f)` / `saveCodedCfg` / `resolveParamValues` (Task 6); `StrategyParams` (Task 7); existing `RiskSection` (`BacktestSettingsModal.tsx:1186`), `RuleGroupSection` (`:1682`), `buildSeries` (`lib/backtestSeries.ts:35`), `StrategyPicker` (which already fetches `StrategyInfo[]` — lift the fetched list up or re-request via the existing `fetchStrategies()` so the modal knows the selected file's `params`).
- Produces: the **effective-cfg pattern** other tasks reuse — for a coded run, build `effCfg: BacktestConfig = { ...cfg, longEntry: EMPTY, shortEntry: EMPTY, longExit: coded.longExit, shortExit: coded.shortExit, longRisk: coded.longRisk, shortRisk: coded.shortRisk }` and pass it to `buildSeries` (entry groups empty ⇒ series come out exit-scoped automatically, risk-ATR series included via `riskAtrLengths`) and to the request's group/risk fields. Request also carries `codedParams: resolveParamValues(specs, coded.params)`.

- [ ] **Step 1: Write the failing test**

Extend `BacktestSettingsModal.test.tsx` (follow its existing mount/mock pattern — it already renders the modal and switches modes):

```tsx
it("coded mode shows params, risk and exit-rule sections editing the backtest set", async () => {
  // Mock fetchStrategies to return one strategy with a params schema.
  // (Follow the file's existing api-mocking idiom.)
  const strategies = [{
    filename: "ema_cross.py", name: "EMA Cross", description: "", hedged: false,
    error: null,
    params: [{ name: "ema_fast", label: "Fast EMA", type: "int", default: 9,
               min: 2, max: 50, step: 1, options: null, help: null }],
  }];
  // render modal with cfg.mode="coded", cfg.codedStrategy="ema_cross.py"
  // assert: screen.getByText("Fast EMA"), two RiskSection headings
  // ("Stop", "Take profit" — match RiskSection's actual copy), and the exit
  // group titles ("Sell to close" / "Buy to close").
  // change Fast EMA to 12 → loadCodedCfg("backtest", "ema_cross.py").params.ema_fast === 12
});
```

Write it against the file's real harness (read the existing tests first; keep the same helpers). The essential assertions: sections render in coded mode, an edit lands in `loadCodedCfg("backtest", ...)`, and rules mode is unchanged.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/BacktestSettingsModal.test.tsx`
Expected: new test FAILS (sections absent), existing tests PASS.

- [ ] **Step 3: Implement the modal**

In `BacktestSettingsModal.tsx`'s coded branch (after `<StrategyPicker>`):

- Hold `codedCfg` state: `const [codedCfg, setCodedCfg] = useState(() => cfg.codedStrategy ? loadCodedCfg("backtest", cfg.codedStrategy) : defaultCodedCfg());` re-loaded in an effect when `cfg.codedStrategy` changes. Every setter writes through: `const updateCoded = (c: CodedStrategyConfig) => { setCodedCfg(c); if (cfg.codedStrategy) saveCodedCfg("backtest", cfg.codedStrategy, c); };`
- Selected strategy's `params` schema comes from the fetched `StrategyInfo[]` — `StrategyPicker` already fetches the list internally; lift that fetch into the modal (single `fetchStrategies()` effect, pass the list into `StrategyPicker` as a prop) so the modal can read `selected.params`. Update `StrategyPicker`'s props accordingly (it keeps its reload button; reload calls the lifted refetch).
- Render, in order: `<StrategyParams specs={selected?.params ?? []} values={resolveParamValues(selected?.params ?? [], codedCfg.params)} onChange={(params) => updateCoded({ ...codedCfg, params })} />`, then per side (reuse the side tabs pattern or stack Long/Short) `RiskSection` bound to `codedCfg.longRisk`/`shortRisk` and `RuleGroupSection` with `isExit` bound to `codedCfg.longExit`/`shortExit` (pass the same clipboard/avwap/resolution props `SidePanel` passes at lines 1390-1404).
- Under the risk sections, a static muted note: `When set here, stop/target overrides any sl=/tp= the strategy file passes.`
- Spec's inline 422: the frontend clamps values so a param 422 is rare (stale schema mid-edit), but when a run fails with a detail string naming a declared param, render that message in red under the Parameters section instead of only in the generic run-error spot.

- [ ] **Step 4: Wire the run assembly**

`BacktestButton.tsx` coded branch (lines ~187-204): build the effective cfg and stop skipping series:

```typescript
const coded = cfg.mode === "coded" && !!cfg.codedStrategy;
const codedCfg = coded ? loadCodedCfg("backtest", cfg.codedStrategy!) : null;
const EMPTY = { combine: "AND" as const, rules: [] };
const effCfg = coded
  ? { ...cfg, longEntry: EMPTY, shortEntry: EMPTY,
      longExit: codedCfg!.longExit, shortExit: codedCfg!.shortExit,
      longRisk: codedCfg!.longRisk, shortRisk: codedCfg!.shortRisk }
  : cfg;
const series = await buildSeries(candles, effCfg, resolution, fetchTf);
```

and in the request: groups/risk from `effCfg` (coded entries stay the EMPTY groups), `codedParams: coded ? resolveParamValues(specs, codedCfg!.params) : undefined` (the strategy list is already fetched for the picker — thread `specs` through or refetch here; a stale-schema mismatch is harmless since the backend re-validates). Keep `broker`/`priceSide` exactly as today.

`BacktestPanel.tsx`: where the summary chips render (~lines 102-112), add a muted chip when `result.fileBracketsOverridden`: `file sl/tp overridden` with a `Tooltip`: `The strategy file passed sl=/tp= but panel risk is configured — panel risk was applied.`

- [ ] **Step 5: Run tests + typecheck**

Run: `cd frontend && npx vitest run && npx tsc --noEmit -p .`
Expected: all PASS.

- [ ] **Step 6: Verify in the app**

With backend + frontend dev servers running (do NOT restart the user's HMR servers), open the backtest panel → Strategy mode: params render for `ema_cross.py`, editing Fast EMA persists across a reload, setting a Long stop % and running shows the override chip, and adding an exit rule (e.g. `RSI(14) > 60`) produces exits with that rule's reason in the trades table.

- [ ] **Step 7: Commit**

```bash
git add frontend/src
git commit -m "feat(backtest): coded mode gets panel params, risk and exit-rule sections"
```

---

### Task 9: Live panel integration (separate live set + Copy from backtest)

**Files:**
- Modify: `frontend/src/lib/liveState.ts` (`ArmedSnapshot.coded`)
- Modify: `frontend/src/lib/liveController.ts` (embed coded cfg at arm, ~line 151)
- Modify: `frontend/src/lib/liveEngine.ts` (coded request carries params/risk/exits/series, lines ~99-127)
- Modify: `frontend/src/LiveTradingPanel.tsx` (sections between lines ~156 and ~199)
- Test: extend `frontend/src/lib/liveEngine.test.ts`

**Interfaces:**
- Consumes: `loadCodedCfg("live", f)` / `saveCodedCfg` / `codedCfgsDiffer` (Task 6); `StrategyParams`, `RiskSection`, `RuleGroupSection` (Tasks 7–8); `deps.buildSeries` (already injected into liveEngine); Task 8's effective-cfg pattern.
- Produces: `ArmedSnapshot.coded?: CodedStrategyConfig` — frozen at arm; every cycle builds the coded request from the snapshot (params, risk, exit groups, exit-scoped series). Live panel edits write to the live set; edits while armed set the existing `pendingEdits`-style drift indication (snapshot vs current live set via `codedCfgsDiffer`).

- [ ] **Step 1: Write the failing tests**

Extend `liveEngine.test.ts` (it already asserts the coded request shape at ~lines 87-88 — those assertions change):

```typescript
it("coded cycle sends params, risk, exit groups and exit-scoped series from the snapshot", async () => {
  const coded = {
    params: { ema_fast: 12 },
    longRisk: { stop: { kind: "pct", value: 2 }, target: { kind: "none" } },
    longExit: { combine: "AND", rules: [RSI_EXIT_RULE] },   // reuse/make a rule fixture
    shortExit: { combine: "AND", rules: [] },
  };
  // arm snapshot built with snapshot.coded = coded (follow the file's snapshot fixture)
  const req = capturedEvaluateRequest();   // the file's existing capture pattern
  expect(req.codedParams).toEqual({ ema_fast: 12 });
  expect(req.longRisk).toEqual(coded.longRisk);
  expect(req.longExit.rules.length).toBe(1);
  expect(deps.buildSeries).toHaveBeenCalled();             // no longer skipped in coded mode
});

it("coded cycle without a coded snapshot still sends empty groups and no risk", async () => {
  // snapshot.coded undefined → request matches today's shape (regression guard)
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/liveEngine.test.ts`
Expected: new tests FAIL.

- [ ] **Step 3: Implement**

`liveState.ts`: add `coded?: CodedStrategyConfig;` to `ArmedSnapshot`. `liveController.ts` arm flow (~line 151): when `draft.mode === "coded" && draft.codedStrategy`, set `snapshot.coded = loadCodedCfg("live", draft.codedStrategy)` at the same point the draft is frozen.

`liveEngine.ts` (~lines 99-127): in the coded branch, derive the effective cfg from the snapshot and reuse `buildSeries`:

```typescript
const codedCfg = coded ? snap.coded : null;
const EMPTY = { combine: "AND" as const, rules: [] };
const effCfg = coded
  ? { ...cfg, longEntry: EMPTY, shortEntry: EMPTY,
      longExit: codedCfg?.longExit ?? EMPTY, shortExit: codedCfg?.shortExit ?? EMPTY,
      longRisk: codedCfg?.longRisk, shortRisk: codedCfg?.shortRisk }
  : cfg;
const series = await deps.buildSeries(
  bars as never, effCfg, resolution, (async (tf: string) => await fetchTf(tf)) as never,
);
```

(One call for both modes — for rule mode `effCfg === cfg`.) Request fields become: `longExit: coded ? effCfg.longExit : activeGroup(cfg.longExit)` (likewise short), `longRisk: coded ? codedCfg?.longRisk ?? undefined : cfg.longRisk ?? null` (likewise short), plus `codedParams: coded ? codedCfg?.params : undefined`. Entry groups in coded mode stay `EMPTY`. Everything else (guards, broker, priceSide) unchanged.

`LiveTradingPanel.tsx` coded block (after line ~156): mirror Task 8's sections but bound to the LIVE set:

- `const [liveCoded, setLiveCoded] = useState(...)` loaded from `loadCodedCfg("live", filename)`, write-through on change (same `updateCoded` shape as Task 8, set name `"live"`).
- Above the sections, a row with:
  - **Copy from backtest** button → `updateCoded(loadCodedCfg("backtest", filename))`.
  - When `codedCfgsDiffer(liveCoded, loadCodedCfg("backtest", filename))`, a muted hint `differs from backtest`.
  - When armed and `snapshot.coded` exists and `codedCfgsDiffer(liveCoded, snapshot.coded)`, reuse the panel's existing pending-edits presentation (`pendingEdits` badge pattern) with copy `edits apply on next arm`.
- Params schema: fetch via `fetchStrategies()` (the panel shows the strategy name already; extend that fetch) and pass `selected.params` to `StrategyParams`.

- [ ] **Step 4: Run tests + typecheck**

Run: `cd frontend && npx vitest run && npx tsc --noEmit -p .`
Expected: all PASS.

- [ ] **Step 5: Verify in the app**

In the Live panel (demo account), coded mode: edit a param → backtest set unchanged (check the backtest panel); Copy from backtest pulls values; arm with a param tweak → the evaluate request in the network tab carries `codedParams` and the panel log stays clean; editing while armed shows the drift badge and does NOT change the running request payloads.

- [ ] **Step 6: Commit**

```bash
git add frontend/src
git commit -m "feat(live): separate live coded config — params/risk/exits frozen at arm, copy-from-backtest"
```

---

### Task 10: Sweep UI — axes, chunked client, table + heatmap

**Files:**
- Modify: `frontend/src/lib/sweep.ts` (full implementation)
- Create: `frontend/src/SweepResults.tsx`
- Modify: `frontend/src/BacktestSettingsModal.tsx` (axis toggles + from/to/step + counter), `frontend/src/BacktestPanel.tsx` or the Strategy tab host (results view + run wiring)
- Test: `frontend/src/lib/sweep.test.ts`, `frontend/src/SweepResults.test.tsx`

**Interfaces:**
- Consumes: `runSweepChunk` + `SweepRow` (Task 6); `StrategyParams`' `sweep` prop (Task 7); the coded request assembly (Task 8) as the base request builder.
- Produces:

```typescript
// lib/sweep.ts
export interface SweepAxis { target: string; label: string; from: number; to: number; step: number }
export function enumerateCombos(axes: SweepAxis[]): Array<Record<string, number>>
export function comboCount(axes: SweepAxis[]): number
export const SWEEP_MAX_COMBOS = 200;
export const SWEEP_CHUNK_SIZE = 20;
export async function runSweep(
  baseReq: BacktestRequest, axes: SweepAxis[],
  opts: { onRows: (rows: SweepRow[], done: number, total: number) => void;
          signal?: AbortSignal },
): Promise<SweepRow[]>        // sequential ~20-combo chunks; one retry per failed
                              // chunk, then throws keeping already-delivered rows
```

- [ ] **Step 1: Write the failing tests**

`frontend/src/lib/sweep.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { comboCount, enumerateCombos, runSweep, SWEEP_CHUNK_SIZE } from "./sweep";
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

  it("guards degenerate steps", () => {
    expect(comboCount([axis("param:a", 1, 10, 0)])).toBe(Infinity);   // Run stays disabled
    expect(enumerateCombos([axis("param:a", 5, 5, 1)])).toEqual([{ "param:a": 5 }]);
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
});
```

`frontend/src/SweepResults.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SweepResults } from "./SweepResults";

const rows = [
  { combo: { "param:n": 5, "risk:long.stop.value": 1 },
    metrics: { net_pnl: 100, n_trades: 4, win_rate: 0.5, max_drawdown: 20,
               profit_factor: 2, return_pct: 1 }, error: null },
  { combo: { "param:n": 10, "risk:long.stop.value": 1 },
    metrics: { net_pnl: -50, n_trades: 2, win_rate: 0, max_drawdown: 60,
               profit_factor: null, return_pct: -0.5 }, error: null },
  { combo: { "param:n": 5, "risk:long.stop.value": 2 }, metrics: null, error: "boom" },
];
const axes = [
  { target: "param:n", label: "n", from: 5, to: 10, step: 5 },
  { target: "risk:long.stop.value", label: "Stop %", from: 1, to: 2, step: 1 },
];

describe("SweepResults", () => {
  it("renders a row per combo, greys failures, sorts by column", () => {
    render(<SweepResults rows={rows} axes={axes} onApply={() => {}} />);
    expect(screen.getAllByRole("row")).toHaveLength(4);   // header + 3
    expect(document.querySelector(".sweep-error")).toBeTruthy();
    fireEvent.click(screen.getByText("Net P/L"));         // sort desc
    const first = screen.getAllByRole("row")[1];
    expect(first.textContent).toContain("100");
  });

  it("applies a combo on row click", () => {
    const onApply = vi.fn();
    render(<SweepResults rows={rows} axes={axes} onApply={onApply} />);
    fireEvent.click(screen.getAllByRole("row")[1]);
    expect(onApply).toHaveBeenCalledWith(rows[0].combo);
  });

  it("renders a 2-axis heatmap grid colored by metric", () => {
    render(<SweepResults rows={rows} axes={axes} onApply={() => {}} />);
    expect(document.querySelectorAll(".sweep-cell").length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/sweep.test.ts src/SweepResults.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement `lib/sweep.ts`**

```typescript
// Sweep grid enumeration + chunked execution. One request per ~20 combos so
// no single call can hit a client/gateway timeout; progress and partial
// results come per chunk, cancel works between chunks, a failed chunk gets
// one retry. (Spec: docs/superpowers/specs/2026-07-09-strategy-panel-params-design.md)

import { runSweepChunk, type BacktestRequest, type SweepRow } from "../api";

export interface SweepAxis {
  target: string;   // "param:<name>" | "risk:<side>.<stop|target>.<value|mult>"
  label: string;
  from: number;
  to: number;
  step: number;
}

export const SWEEP_MAX_COMBOS = 200;
export const SWEEP_CHUNK_SIZE = 20;

function axisValues(a: SweepAxis): number[] {
  if (!(a.step > 0) || a.to < a.from) return [];
  const out: number[] = [];
  // Epsilon guards float accumulation (1 + 0.1*n drift) at the inclusive end.
  for (let v = a.from; v <= a.to + a.step * 1e-9; v += a.step) {
    out.push(Number(v.toPrecision(12)));
  }
  return out;
}

export function comboCount(axes: SweepAxis[]): number {
  return axes.reduce((n, a) => {
    const len = axisValues(a).length;
    return len === 0 ? Infinity : n * len;
  }, axes.length ? 1 : 0);
}

export function enumerateCombos(axes: SweepAxis[]): Array<Record<string, number>> {
  let combos: Array<Record<string, number>> = [{}];
  for (const a of axes) {
    combos = axisValues(a).flatMap((v) =>
      combos.map((c) => ({ ...c, [a.target]: v })));
  }
  return axes.length ? combos : [];
}

export async function runSweep(
  baseReq: BacktestRequest,
  axes: SweepAxis[],
  opts: {
    onRows: (rows: SweepRow[], done: number, total: number) => void;
    signal?: AbortSignal;
  },
): Promise<SweepRow[]> {
  const combos = enumerateCombos(axes);
  const all: SweepRow[] = [];
  for (let i = 0; i < combos.length; i += SWEEP_CHUNK_SIZE) {
    if (opts.signal?.aborted) throw new Error("sweep aborted");
    const chunk = combos.slice(i, i + SWEEP_CHUNK_SIZE);
    let rows: SweepRow[];
    try {
      rows = await runSweepChunk(baseReq, chunk);
    } catch {
      rows = await runSweepChunk(baseReq, chunk);   // one retry, then throw
    }
    all.push(...rows);
    opts.onRows(rows, all.length, combos.length);
  }
  return all;
}
```

- [ ] **Step 4: Implement `SweepResults.tsx`**

A results view with: sortable metrics table (reuse the app's existing sort-header pattern — see `SortHeader.test.tsx`'s component), error rows greyed with `Tooltip` on hover showing `row.error`, best value per metric column subtly highlighted, and for exactly 2 axes a DOM grid heatmap (x = axis 0 values, y = axis 1 values, cell background from a diverging scale around 0 on a selectable metric, default `net_pnl`; 1 axis → a single-row strip). Row/cell click calls `onApply(combo)`. Props:

```typescript
export function SweepResults(props: {
  rows: SweepRow[];
  axes: SweepAxis[];
  onApply: (combo: Record<string, number | boolean | string>) => void;
  progress?: { done: number; total: number } | null;   // renders "N / M" while running
}): JSX.Element
```

Metric columns: `Net P/L`, `Return %`, `Trades`, `Win rate`, `Drawdown`, `Profit factor`. Diverging color: green ramp for positive, red for negative, neutral at 0 — inline `style={{ background }}` computed from the min/max of the selected metric; no chart library.

- [ ] **Step 5: Wire the panel**

`BacktestSettingsModal.tsx` (coded mode):
- Sweep axes state `const [sweepAxes, setSweepAxes] = useState<SweepAxis[]>([])` (session-only — not persisted).
- Pass `sweep={{ axes: sweepAxes, onToggle }}` to `StrategyParams`. `onToggle(target, spec)`: if present remove; else append `{ target, label: spec.label, from: spec.min ?? spec.default as number, to: spec.max ?? (spec.default as number) * 2, step: spec.step ?? 1 }` and drop the oldest axis beyond 2.
- For each active axis render a from/to/step row (`NumberField` ×3) replacing that param's single input (StrategyParams already hides it when swept — Task 7's `swept ? null` branch).
- Risk numeric fields: next to `RiskSection`'s value/mult `NumberField`s in coded mode only, the same ⇄ toggle building targets like `risk:long.stop.value` (add an optional `sweep` prop to `RiskSection` mirroring `StrategyParams`'; rule mode passes nothing and renders exactly as today).
- Combo counter near the Run button: `const n = comboCount(sweepAxes)` → `12 × 9 = 108 runs` (red + Run disabled when `n > SWEEP_MAX_COMBOS` or `!isFinite(n)`).

Run wiring (where the normal coded run is assembled — Task 8's `BacktestButton.tsx` path): when `sweepAxes.length > 0`, instead of `runBacktest`, call `runSweep(baseReq, sweepAxes, { onRows })` with the SAME base request (it already carries candles/codedParams/risk/exits/series), stream rows into state rendered by `<SweepResults>` in the panel's Strategy tab, show `progress`, and a Cancel button driving an `AbortController`. `onApply(combo)`: write `param:*` values into the backtest coded set (`saveCodedCfg`), `risk:*` values into the stored risk fields, clear `sweepAxes`, and trigger the normal single run — the existing `runAndRender` path renders trades/equity, and the panel controls now show the applied values.

- [ ] **Step 6: Run all tests + typecheck**

Run: `cd frontend && npx vitest run && npx tsc --noEmit -p . && cd ../backend && python -m pytest tests/ -q`
Expected: everything PASSES.

- [ ] **Step 7: Verify in the app**

Sweep `ema_fast` 5→30 step 1 × Stop % 1→3 step 0.5 (a real chart, thousand-bar range): progress counts up in ~20-combo steps, table fills incrementally, heatmap colors by Net P/L, clicking the best cell applies those values to the controls and renders that run's trades on the chart. Cancel mid-sweep stops after the current chunk.

- [ ] **Step 8: Commit**

```bash
git add frontend/src
git commit -m "feat(backtest): parameter sweeps — 1-2 axes, chunked runs, table + heatmap, click-to-apply"
```

---

## Post-plan checks

- Full suites: `cd backend && python -m pytest tests/ -q` and `cd frontend && npx vitest run && npx tsc --noEmit -p .`
- Parity guard: nothing in `backend/auto_trader/indicators/` changed; `python -m pytest tests/test_indicator_parity.py -q` still green.
- Live smoke (demo account): arm coded with a param tweak + panel risk → broker order carries the panel bracket levels.
