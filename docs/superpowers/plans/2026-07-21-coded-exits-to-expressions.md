# Coded Exits → Expressions (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make coded-strategy panel exits run on the expression language instead of the structured operand/modifier rules, across backtest, sweep/WFO, and live — so Phase 2 can delete the structured stack.

**Architecture:** Keep the coded run machinery (ATR risk, ad-hoc `tf=` HTF fetch loop, posted `series`) exactly where it is. Swap only the exit evaluator: the wrapper that today wraps a `RuleStrategy` will wrap an `ExprRuleStrategy` built from expression exit rows. There are exactly two constructor sites: `run_coded_sync` (covers `/api/backtest` single run + sweep + WFO, all of which call it) and `evaluate_strategy` (live). Coded exit rows travel on new `exprLongExit`/`exprShortExit` request fields, added alongside the existing structured fields (which Phase 2 removes). Coded exit config stays `RuleGroup`-typed — the same expr-carrying container the main rule groups already use (`Rule.expr`) — so no persisted-shape change and no new type.

**Tech Stack:** Backend Python (FastAPI, pydantic v2, pytest). Frontend TypeScript (React, vitest). `ExprRuleStrategy` already exists and supports exit-only (empty entry groups) with `entry`-operand resolution.

## Global Constraints

- No em dashes ("—" / "--") in end-user-visible text or copy. Code, tests, comments, commit messages are fine.
- No backward-compat / migration code. Persisted structured coded-exit rows are simply ignored on load (they show as blank expr rows); do not write a converter. (User decision 2026-07-21.)
- Commit directly to `main`. Do not create branches unless asked.
- Never `git add -A`/`-u`/`.` and never `git stash/checkout/reset/clean`. Stage only the exact files each task names. The uncommitted WIP files `frontend/src/lib/overlays.ts` and `frontend/src/lib/overlays.test.ts` must never be staged or touched.
- Backend tests run from `backend/`: `cd backend && python -m pytest`. Frontend tests run from `frontend/`: `cd frontend && npx vitest run <file>`.
- `npx tsc --noEmit` is a no-op in this repo; typecheck with `cd frontend && npx tsc -b`. There are ~23 pre-existing unrelated tsc errors — do not fix them; only ensure you add no NEW ones.
- Commit trailers on every commit:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01KQj31kEhK1PUdg6xDfpjof
  ```

---

## File Structure

**Backend (modify):**
- `backend/auto_trader/strategy/coded.py` — rename/generalize the exit wrapper to accept any exit `Strategy`.
- `backend/auto_trader/api/schemas.py` — add `exprLongExit`/`exprShortExit` to `BacktestRequest`.
- `backend/auto_trader/api/sweep_apply.py` — `run_coded_sync` builds expr exits.
- `backend/auto_trader/api/routers/strategy.py` — `evaluate_strategy` coded branch builds expr exits.
- `backend/auto_trader/api/routers/backtest.py` — `_validate_coded_exit_series` stops walking structured exit operands (keeps ATR-risk series check).

**Backend (tests):**
- `backend/tests/test_coded_rule_exits.py` — replace rule-based coded-exit tests with expression-based equivalents.

**Frontend (modify):**
- `frontend/src/api.ts` — add `exprLongExit?`/`exprShortExit?` to `BacktestRequest`.
- `frontend/src/BacktestButton.tsx` — coded `baseReq` carries expr exit rows.
- `frontend/src/BacktestSettingsModal.tsx` — coded-exit editor renders `editorMode="expr"`.
- `frontend/src/LiveTradingPanel.tsx` — coded-exit editor renders `editorMode="expr"`.
- `frontend/src/lib/liveEngine.ts` — coded live request carries expr exit rows.
- `frontend/src/lib/backtestWindow.ts` — coded exit warm-up derives from expr rows.

---

## Task 1: Generalize the coded-exit wrapper to any exit Strategy

The wrapper's merge logic (`_CLOSES`, one close per leg per bar, coded's own close wins) is identical regardless of what produces the exit signals. `ExprRuleStrategy` and `RuleStrategy` both expose `on_bar(ctx) -> list[Signal]`. Rename `CodedWithRuleExits` to `CodedWithExprExits` and widen the `rule_exits` param type to `Strategy`. After Phase 1 no caller passes a `RuleStrategy`, and Phase 2 deletes `RuleStrategy`, so a rule-typed alias is not kept.

**Files:**
- Modify: `backend/auto_trader/strategy/coded.py:460-491`
- Test: `backend/tests/test_coded_rule_exits.py`

**Interfaces:**
- Produces: `class CodedWithExprExits(Strategy)` with `__init__(self, coded: CodedStrategy, exit_strategy: Strategy)` and `on_bar(ctx) -> list[Signal]`; `file_brackets_overridden` property preserved.

- [ ] **Step 1: Write the failing test.** Replace the contents of `backend/tests/test_coded_rule_exits.py` with an expression-driven test. It builds a trivial coded strategy that opens a long on the first bar, wraps it in `CodedWithExprExits` with an `ExprRuleStrategy` whose `long_exit` is a compiled `close < EMA(2)` row, and asserts the wrapper emits a SELL close on a bar where the expression is true and the long is held.

```python
from auto_trader.strategy.coded import CodedWithExprExits
from auto_trader.strategy.expr.strategy import ExprRuleStrategy
from auto_trader.strategy.expr.evaluate import compile_row
from auto_trader.strategy.expr.parser import parse
from auto_trader.core.models import Side, Signal
from auto_trader.strategy.base import Context, Strategy
from tests.helpers import make_candles  # existing candle factory; if absent, build Candles inline


class _OpenLongOnce(Strategy):
    """Minimal coded stand-in: BUY 1 on the first bar, nothing after."""
    hedged = False
    file_brackets_overridden = False

    def __init__(self):
        self._opened = False

    def on_bar(self, ctx: Context) -> list[Signal]:
        if not self._opened:
            self._opened = True
            return [Signal(Side.BUY, 1, "", leg="long")]
        return []


def test_coded_with_expr_exits_fires_exit():
    candles = make_candles([100, 100, 100, 1])  # last close plunges below EMA(2)
    resolution = "MINUTE"
    row = compile_row(parse("close < EMA(2)"), candles, resolution, {})
    exits = ExprRuleStrategy([], [row], [], [], quantity=1.0)
    strat = CodedWithExprExits(_OpenLongOnce(), exits)

    ctx = Context()
    ctx.history = candles
    ctx.position_long = 1
    ctx.long_entry_price = 100.0
    ctx.bar = candles[-1]
    out = strat.on_bar(ctx)
    assert any(s.side == Side.SELL and s.leg == "long" for s in out)
```

(If `tests/helpers.make_candles` does not exist, construct `Candle` objects inline the way neighboring backend tests do — grep `backend/tests/test_expr_*.py` for the pattern and copy it.)

- [ ] **Step 2: Run it to verify it fails.**

Run: `cd backend && python -m pytest tests/test_coded_rule_exits.py -v`
Expected: FAIL with `ImportError: cannot import name 'CodedWithExprExits'`.

- [ ] **Step 3: Rename and widen the wrapper.** In `backend/auto_trader/strategy/coded.py`, rename the class and its param. Keep the docstring accurate (exits now come from an expression strategy).

```python
class CodedWithExprExits(Strategy):
    """A coded strategy plus panel-authored expression exit rows: the coded module
    supplies entries (and any exits of its own); an exit-only strategy (empty entry
    groups) contributes rule-based exits. One close per leg per bar — the coded
    module's own close wins when both fire."""

    _CLOSES = {("long", Side.SELL), ("short", Side.BUY)}

    def __init__(self, coded: CodedStrategy, exit_strategy: Strategy) -> None:
        self.coded = coded
        self.exit_strategy = exit_strategy
        self.hedged = coded.hedged

    @property
    def file_brackets_overridden(self) -> bool:
        return self.coded.file_brackets_overridden

    def on_bar(self, ctx: Context) -> list[Signal]:
        out = self.coded.on_bar(ctx)
        closed = {s.leg for s in out if (s.leg, s.side) in self._CLOSES}
        for s in self.exit_strategy.on_bar(ctx):
            if (s.leg, s.side) in self._CLOSES and s.leg not in closed:
                size = ctx.position_long if s.leg == "long" else ctx.position_short
                if size <= 0:
                    continue
                out.append(Signal(s.side, size, s.reason, leg=s.leg,
                                  terms=s.terms, combine=s.combine))
                closed.add(s.leg)
        return out
```

- [ ] **Step 4: Run it to verify it passes.**

Run: `cd backend && python -m pytest tests/test_coded_rule_exits.py -v`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add backend/auto_trader/strategy/coded.py backend/tests/test_coded_rule_exits.py
git commit -m "$(cat <<'EOF'
refactor(coded): generalize coded-exit wrapper to any exit Strategy (CodedWithExprExits)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KQj31kEhK1PUdg6xDfpjof
EOF
)"
```

---

## Task 2: Add expr exit fields to the backtest request schema

Coded runs go through `BacktestRequest`. Add expression exit rows alongside the structured groups (Phase 2 removes the structured ones). `ExprRowDTO` already exists; `schemas.py` uses `from __future__ import annotations`, so referencing it before its definition line is fine (this is how `EvaluateRequest.exprLongExit` already works).

**Files:**
- Modify: `backend/auto_trader/api/schemas.py` (the `BacktestRequest` class, ~line 423)

**Interfaces:**
- Produces: `BacktestRequest.exprLongExit: list[ExprRowDTO]` and `BacktestRequest.exprShortExit: list[ExprRowDTO]`, both defaulting to `[]`.

- [ ] **Step 1: Add the fields.** In the `BacktestRequest` class body, after the structured `longExit`/`shortExit` field declarations, add:

```python
    # Coded runs carry panel exit rules as EXPRESSIONS here (parallel to the
    # structured longExit/shortExit above, which coded no longer reads). Entries
    # are always the coded module's, so no expr entry fields are needed.
    exprLongExit: list[ExprRowDTO] = []
    exprShortExit: list[ExprRowDTO] = []
```

- [ ] **Step 2: Verify the schema imports/rebuilds cleanly.**

Run: `cd backend && python -c "from auto_trader.api.schemas import BacktestRequest; print('exprLongExit' in BacktestRequest.model_fields)"`
Expected: prints `True`.

- [ ] **Step 3: Commit.**

```bash
git add backend/auto_trader/api/schemas.py
git commit -m "$(cat <<'EOF'
feat(schemas): BacktestRequest carries expr exit rows for coded runs

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KQj31kEhK1PUdg6xDfpjof
EOF
)"
```

---

## Task 3: Wire `run_coded_sync` to build expression exits

`run_coded_sync` (sweep_apply.py) is the single coded engine runner for the backtest single-run route (`_run_coded` calls it), sweeps, and WFO. Replace the `CodedWithRuleExits` + `RuleStrategy` block with `CodedWithExprExits` + `ExprRuleStrategy`, compiling `req.exprLongExit`/`req.exprShortExit`. A parse/validate error must raise `SweepValidationError(422, ...)` so one combo isolates to its error (matches the existing expr sweep behavior in `run_expr_sync`).

**Files:**
- Modify: `backend/auto_trader/api/sweep_apply.py:203-210` (the exit-wrap block) and its imports (line ~20)
- Test: `backend/tests/test_api_backtest.py` (add a coded-with-expr-exit run assertion; if this file does not cover coded, add to `backend/tests/test_coded_rule_exits.py` at the router level or create `backend/tests/test_api_coded_expr_exit.py`)

**Interfaces:**
- Consumes: `CodedWithExprExits` (Task 1), `ExprRuleStrategy`, `compile_row`, `parse`, `validate`, `req.exprLongExit`, `req.exprShortExit`.
- Produces: a module-level helper `_compile_expr_exits(rows, candles, resolution, htf) -> list[CompiledRow]` in sweep_apply.py, raising `SweepValidationError(422, ...)` on `ExprError`.

- [ ] **Step 1: Write the failing test.** Add a test that posts a coded backtest request (via the FastAPI `TestClient`) with `codedStrategy` set to an existing simple strategy file and `exprLongExit=[{"expr": "close < EMA(2)", "enabled": true}]`, and asserts the response is 200 and at least one trade closes on the exit expression. Model it on the existing coded test in `backend/tests/test_coded_rule_exits.py` (find how it names an installed strategy file and builds candles) and the request-building in `backend/tests/test_api_backtest.py`.

```python
def test_api_backtest_coded_expr_exit(client, coded_strategy_name, candles_payload):
    body = {
        # ... reuse the coded request builder from the existing coded test ...
        "codedStrategy": coded_strategy_name,
        "exprLongExit": [{"expr": "close < EMA(2)", "enabled": True}],
        "exprShortExit": [],
    }
    r = client.post("/api/backtest", json=body)
    assert r.status_code == 200, r.text
    trades = r.json()["trades"]
    assert any(t.get("exit_reason") for t in trades)  # an exit fired
```

(Replace fixtures/keys with the exact ones the existing coded test uses. Read `test_coded_rule_exits.py` before writing — reuse its candle payload and strategy filename verbatim.)

- [ ] **Step 2: Run it to verify it fails.**

Run: `cd backend && python -m pytest tests/test_api_backtest.py -k coded_expr_exit -v` (or the file you added it to)
Expected: FAIL (exit never fires because `run_coded_sync` still reads the empty structured `longExit`).

- [ ] **Step 3: Add the compile helper and rewire.** In `sweep_apply.py`, update the imports to add `CodedWithExprExits` (drop `CodedWithRuleExits` once no longer used here — but `run_expr_sync`/other funcs may not use it; verify) and the expr compile pieces (`compile_row`, `parse`, `validate` are already imported for `run_expr_sync` — reuse them). Add:

```python
def _compile_expr_exits(rows, candles, resolution, htf):
    """Parse+validate+compile enabled, non-blank expression exit rows. Isolation:
    a parse/validate problem raises SweepValidationError(422) so one sweep combo
    fails to its own error row (matches run_expr_sync)."""
    compiled = []
    for row in rows:
        if not row.enabled or not row.expr.strip():
            continue
        try:
            node = parse(row.expr)
            validate(node, is_exit=True)
        except ExprError as e:
            raise SweepValidationError(422, e.message)
        compiled.append(compile_row(node, candles, resolution, htf))
    return compiled
```

Then replace the exit-wrap block (currently lines 203-210) with:

```python
        long_exit = _compile_expr_exits(req.exprLongExit, candles, req.resolution, htf_candles)
        short_exit = _compile_expr_exits(req.exprShortExit, candles, req.resolution, htf_candles)
        if long_exit or short_exit:
            strategy = CodedWithExprExits(strategy, ExprRuleStrategy(
                [], long_exit, [], short_exit,
                quantity=req.costs.quantity,
                long_enabled=req.longEnabled, short_enabled=req.shortEnabled,
            ))
```

Confirm `ExprError`, `SweepValidationError`, `ExprRuleStrategy`, `compile_row`, `parse`, `validate` are imported at the top of `sweep_apply.py` (most already are for `run_expr_sync`); add any that are missing.

- [ ] **Step 4: Run it to verify it passes.**

Run: `cd backend && python -m pytest tests/test_api_backtest.py -k coded_expr_exit -v`
Expected: PASS.

- [ ] **Step 5: Run the coded + sweep test group to check nothing regressed.**

Run: `cd backend && python -m pytest tests/test_coded_rule_exits.py tests/test_api_backtest.py tests/test_api_backtest_rule_sweep.py -v`
Expected: PASS (structured coded-exit assertions that used `longExit` may need updating to `exprLongExit` — update them, they are testing the new behavior).

- [ ] **Step 6: Commit.**

```bash
git add backend/auto_trader/api/sweep_apply.py backend/tests/test_api_backtest.py backend/tests/test_coded_rule_exits.py
git commit -m "$(cat <<'EOF'
feat(coded): run_coded_sync evaluates coded exits as expressions

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KQj31kEhK1PUdg6xDfpjof
EOF
)"
```

---

## Task 4: Wire the live evaluate route to build expression exits

`evaluate_strategy` (routers/strategy.py) already has `_compile_expr_group` and `EvaluateRequest.exprLongExit`/`exprShortExit`. Replace the coded branch's `CodedWithRuleExits` + `RuleStrategy` (lines ~210-217) with `CodedWithExprExits` + `ExprRuleStrategy` compiled from the expr exit fields.

**Files:**
- Modify: `backend/auto_trader/api/routers/strategy.py` (imports ~line 21; coded branch ~lines 210-217)
- Test: `backend/tests/test_api_strategy_evaluate.py`

**Interfaces:**
- Consumes: `CodedWithExprExits`, `_compile_expr_group` (already in this module), `req.exprLongExit`, `req.exprShortExit`, `htf` (already built for the exprMode branch — build it in the coded branch too if not present).

- [ ] **Step 1: Write the failing test.** In `test_api_strategy_evaluate.py`, add a coded-live test: post `/api/strategy/evaluate` with `codedStrategy` set, a held long `position`, and `exprLongExit=[{"expr":"close < EMA(2)","enabled":true}]` on candles where the last close is below EMA(2); assert the response `actions` contains a close of the long. Model the request on the existing coded-evaluate test in this file.

```python
def test_evaluate_coded_expr_exit_closes_long(client, coded_strategy_name):
    body = {
        # ... reuse the existing coded-evaluate request body ...
        "codedStrategy": coded_strategy_name,
        "position": {"side": "buy", "quantity": 1, "open_level": 100.0, "open_time": None},
        "exprLongExit": [{"expr": "close < EMA(2)", "enabled": True}],
        "exprShortExit": [],
    }
    r = client.post("/api/strategy/evaluate", json=body)
    assert r.status_code == 200, r.text
    actions = r.json()["actions"]
    assert any(a["kind"] == "close" and a["leg"] == "long" for a in actions)
```

(Match the exact `actions` DTO field names by reading `ActionDTO` and an existing evaluate test first.)

- [ ] **Step 2: Run it to verify it fails.**

Run: `cd backend && python -m pytest tests/test_api_strategy_evaluate.py -k coded_expr_exit -v`
Expected: FAIL (coded branch still builds `RuleStrategy` from empty structured `longExit`).

- [ ] **Step 3: Rewire the coded branch.** Add `CodedWithExprExits` to the imports (line ~21) and drop `CodedWithRuleExits` if no longer used in the file. Ensure an `htf` dict is available in the coded branch (the coded branch already builds `htf_candles` for the tf-fetch loop; build the compile-time `htf` from `req.htfCandles` the same way the exprMode branch does at lines ~143-146). Replace the exit-wrap block:

```python
            long_exit = _compile_expr_group(req.exprLongExit, candles, req.resolution, htf, is_exit=True, group="longExit")
            short_exit = _compile_expr_group(req.exprShortExit, candles, req.resolution, htf, is_exit=True, group="shortExit")
            if long_exit or short_exit:
                strategy = CodedWithExprExits(strategy, ExprRuleStrategy(
                    [], long_exit, [], short_exit,
                    quantity=1.0,
                    long_enabled=req.longEnabled, short_enabled=req.shortEnabled,
                ))
```

Where `htf` is:

```python
        htf: dict[str, list[Candle]] = {
            tf: [_candle(c) for c in bars]
            for tf, bars in (req.htfCandles or {}).items()
        }
```

Place the `htf` build before the coded branch so both the tf-loop and the compile can use it (do not shadow the loop's `htf_candles`).

- [ ] **Step 4: Update the coded-exit series validation for expr.** In the coded branch of `evaluate_strategy` (lines ~117-133), the structured exit-operand series walk (`for group in (req.longExit, req.shortExit): for op in group.operands(): series_name(op)...`) no longer applies — coded expr exits reference no posted series. Remove that exit-operand loop; keep the ATR-risk series check (lines ~128-133).

- [ ] **Step 5: Run it to verify it passes.**

Run: `cd backend && python -m pytest tests/test_api_strategy_evaluate.py -v`
Expected: PASS (update any existing coded-evaluate test that fed structured `longExit` to feed `exprLongExit` instead).

- [ ] **Step 6: Commit.**

```bash
git add backend/auto_trader/api/routers/strategy.py backend/tests/test_api_strategy_evaluate.py
git commit -m "$(cat <<'EOF'
feat(live): evaluate coded exits as expressions in /api/strategy/evaluate

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KQj31kEhK1PUdg6xDfpjof
EOF
)"
```

---

## Task 5: Drop the structured coded exit-series validation in the backtest route

`_validate_coded_exit_series` (routers/backtest.py:154-179) walks structured exit operands to require their posted series. Coded expr exits reference no posted series, so that loop is dead and would 422 spuriously if any structured `longExit` lingered. Remove the exit-operand loop; keep the `req.series` length check and the ATR-risk `atr_series_names` check.

**Files:**
- Modify: `backend/auto_trader/api/routers/backtest.py:154-179`
- Test: `backend/tests/test_api_backtest.py` (the coded run test from Task 3 already exercises this path; ensure it still passes)

- [ ] **Step 1: Remove the structured exit-operand loop.** Delete the block:

```python
    for group in (req.longExit, req.shortExit):
        for op in group.operands():
            name = series_name(op.to_operand())
            if name is not None and name not in req.series:
                raise HTTPException(422, f"missing series '{name}' referenced by a rule")
```

Keep the surrounding `req.series` length loop and the ATR-risk loop. Update the docstring to say exit rules are validated at compile time now (expr parse/validate), not via series presence.

- [ ] **Step 2: Run the coded route tests.**

Run: `cd backend && python -m pytest tests/test_api_backtest.py tests/test_coded_rule_exits.py -v`
Expected: PASS.

- [ ] **Step 3: Run the full backend suite to catch structured-coupling regressions.**

Run: `cd backend && python -m pytest -q`
Expected: PASS. If a structured-only test that fed coded `longExit` fails, update it to `exprLongExit` (it is asserting the migrated behavior). Do NOT delete `rule.py` or its unit tests here — that is Phase 2.

- [ ] **Step 4: Commit.**

```bash
git add backend/auto_trader/api/routers/backtest.py
git commit -m "$(cat <<'EOF'
refactor(coded): validate coded exits at expr compile, drop structured series walk

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KQj31kEhK1PUdg6xDfpjof
EOF
)"
```

---

## Task 6: Frontend — coded backtest request carries expr exit rows

`BacktestButton.tsx` sends coded runs on `baseReq` (structured `BacktestRequest`) via `runBacktest` → `/api/backtest`. Add `exprLongExit`/`exprShortExit` to `baseReq`, built with the existing `exprRows` helper from the coded exit groups. Add the two optional fields to the `BacktestRequest` TS type.

**Files:**
- Modify: `frontend/src/api.ts` (the `BacktestRequest` interface, ~line 310-337)
- Modify: `frontend/src/BacktestButton.tsx` (the `baseReq` object, ~line 360-390; `exprRows` is defined at ~397 — hoist it above `baseReq` or inline the mapping)

**Interfaces:**
- Consumes: `effCfg.longExit`, `effCfg.shortExit` (coded exit `RuleGroup`s, now expr-carrying).
- Produces: `BacktestRequest.exprLongExit?: ExprRow[]`, `BacktestRequest.exprShortExit?: ExprRow[]`.

- [ ] **Step 1: Add the TS fields.** In `frontend/src/api.ts`, in the `BacktestRequest` interface, add:

```ts
  // Coded runs send panel exits as expressions here (parallel to the structured
  // longExit/shortExit, which coded no longer reads).
  exprLongExit?: ExprRow[];
  exprShortExit?: ExprRow[];
```

Confirm `ExprRow` is exported/imported in `api.ts` (it is used by `ExprBacktestRequest`); if it is a local type there, no import is needed.

- [ ] **Step 2: Hoist `exprRows` and populate `baseReq`.** In `BacktestButton.tsx`, move the `const exprRows = (g: RuleGroup): ExprRow[] => ...` definition (currently ~line 397) to ABOVE the `baseReq` object literal so `baseReq` can call it. Then in `baseReq`, after `shortExit: activeGroup(effCfg.shortExit),`, add:

```ts
        // Coded exits run as expressions; the structured longExit/shortExit above
        // are ignored by the coded backend and removed in Phase 2.
        exprLongExit: exprRows(effCfg.longExit),
        exprShortExit: exprRows(effCfg.shortExit),
```

- [ ] **Step 3: Typecheck.**

Run: `cd frontend && npx tsc -b 2>&1 | grep -c "BacktestButton\|api.ts"`
Expected: `0` (no new errors in these files).

- [ ] **Step 4: Commit.**

```bash
git add frontend/src/api.ts frontend/src/BacktestButton.tsx
git commit -m "$(cat <<'EOF'
feat(coded-fe): send coded backtest exits as expression rows

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KQj31kEhK1PUdg6xDfpjof
EOF
)"
```

---

## Task 7: Frontend — coded live request carries expr exit rows

`liveEngine.ts` builds the live evaluate request. It already sends `exprLongExit`/`exprShortExit` for non-coded (`exprLongExit: coded ? undefined : exprRows(cfg.longExit)`, ~line 148). For coded it currently sends structured `longExit: coded ? activeGroup(effCfg.longExit) : ...` (~line 143). Switch coded to send expr exit rows from the coded config's exit groups.

**Files:**
- Modify: `frontend/src/lib/liveEngine.ts` (~lines 108-165)
- Modify: `frontend/src/lib/liveTypes.ts` (confirm `exprLongExit?`/`exprShortExit?` exist on the request type — they do, lines ~49; add `exprShortExit?` if missing)
- Test: `frontend/src/lib/liveEngine.test.ts` if present (assert coded request carries expr exits)

**Interfaces:**
- Consumes: `codedCfg.longExit`, `codedCfg.shortExit`, the existing `exprRows` helper (~line 129).

- [ ] **Step 1: Send coded expr exits.** In `liveEngine.ts`, change the `exprLongExit`/`exprShortExit` fields so coded uses the coded config's exit groups:

```ts
    exprLongExit: coded ? exprRows(codedCfg?.longExit ?? emptyGroup) : exprRows(cfg.longExit),
    exprShortExit: coded ? exprRows(codedCfg?.shortExit ?? emptyGroup) : exprRows(cfg.shortExit),
```

(Match the exact variable names in scope — `codedCfg`, `emptyGroup`, `cfg` — by reading lines 90-165 first. If the non-coded side only sent `exprLongExit` when `!coded`, keep that behavior for the non-coded branch and only add the coded branch.)

- [ ] **Step 2: Confirm the live request type has both expr exit fields.** In `liveTypes.ts`, ensure both `exprLongExit?: Array<{ expr: string; enabled: boolean }>` and `exprShortExit?: ...` exist (line ~49 shows `exprLongExit`; add `exprShortExit` if absent).

- [ ] **Step 3: Typecheck + run any live-engine test.**

Run: `cd frontend && npx tsc -b 2>&1 | grep -c "liveEngine\|liveTypes"` → Expected `0`.
Run: `cd frontend && npx vitest run src/lib/liveEngine.test.ts` (if the file exists) → Expected PASS.

- [ ] **Step 4: Commit.**

```bash
git add frontend/src/lib/liveEngine.ts frontend/src/lib/liveTypes.ts
git commit -m "$(cat <<'EOF'
feat(coded-fe): send coded live exits as expression rows

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KQj31kEhK1PUdg6xDfpjof
EOF
)"
```

---

## Task 8: Frontend — render the coded-exit editors in expression mode

Two coded-exit editors currently render `editorMode="structured"`: the backtest modal (`BacktestSettingsModal.tsx:2750`, passing `openChartPicker` at ~2762) and the live panel (`LiveTradingPanel.tsx:225`). Switch both to `editorMode="expr"` and drop the structured-only props (`openChartPicker`). This makes coded exits authored in the same CodeMirror expression editor as the main groups, including the "pick from chart" ◎ button.

**Files:**
- Modify: `frontend/src/BacktestSettingsModal.tsx:2745-2765`
- Modify: `frontend/src/LiveTradingPanel.tsx:220-227`

- [ ] **Step 1: Switch the backtest modal coded-exit editor.** At `BacktestSettingsModal.tsx:2750`, change `editorMode="structured"` to `editorMode="expr"` and remove the `openChartPicker` prop passed to that `RuleGroupSection`/`RuleRow`. If the expr editor requires the `pickIndicator` prop (the ◎ pick-from-chart handle) to render, wire it the same way the main groups do via the `sidePick(...)` helper; if `pickIndicator` is optional, omit it for coded in this task.

- [ ] **Step 2: Switch the live panel coded-exit editor.** At `LiveTradingPanel.tsx:225`, change the coded exit `RuleGroupSection` to `editorMode="expr"` and drop any structured-only prop it passes.

- [ ] **Step 3: Typecheck.**

Run: `cd frontend && npx tsc -b 2>&1 | grep -c "BacktestSettingsModal\|LiveTradingPanel"`
Expected: `0` new errors (the pre-existing count for these files, if any, must not increase — capture it with the same grep against `git stash`-free HEAD only by comparing to the known baseline; do NOT stash).

- [ ] **Step 4: Run the modal test suites.**

Run: `cd frontend && npx vitest run src/BacktestSettingsModal.expr.test.tsx src/BacktestSettingsModal.test.tsx`
Expected: The expr suite passes; the 19 pre-existing structured failures in `BacktestSettingsModal.test.tsx` remain (do not fix them here — Phase 2 removes structured tests). Confirm you added no NEW failures by comparing the failed count to the known baseline of 19.

- [ ] **Step 5: Commit.**

```bash
git add frontend/src/BacktestSettingsModal.tsx frontend/src/LiveTradingPanel.tsx
git commit -m "$(cat <<'EOF'
feat(coded-fe): author coded exits in the expression editor

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KQj31kEhK1PUdg6xDfpjof
EOF
)"
```

---

## Task 9: Frontend — coded exit warm-up from expression rows

Warm-up (how many bars of history to fetch before `tradeFromTime`) must account for coded exit expressions (e.g. `EMA(200)` needs 200 bars). `backtestWindow.ts` (`warmupOf`) computes warm-up. Confirm it reads `Rule.expr` from the coded exit groups; if it still derives warm-up from structured operands for coded, switch it to the expr path the main groups use.

**Files:**
- Modify: `frontend/src/lib/backtestWindow.ts`
- Test: `frontend/src/lib/backtestWindow.test.ts` (if present)

- [ ] **Step 1: Inspect `warmupOf`.** Read `backtestWindow.ts`. Determine whether coded exit warm-up flows through the same expr-row warm-up the main groups use. If `warmupOf` already walks `Rule.expr` for all groups, no code change is needed — record that and skip to Step 3.

- [ ] **Step 2: If needed, route coded exits through the expr warm-up.** Make `warmupOf` include the coded exit groups' `expr` rows in its max-lookback computation, mirroring how it handles the main groups' expr rows. (Exact edit depends on the file; keep the structured-operand branch intact for now — Phase 2 removes it.)

- [ ] **Step 3: Typecheck + test.**

Run: `cd frontend && npx tsc -b 2>&1 | grep -c "backtestWindow"` → Expected `0`.
Run: `cd frontend && npx vitest run src/lib/backtestWindow.test.ts` (if present) → Expected PASS.

- [ ] **Step 4: Commit (only if changed).**

```bash
git add frontend/src/lib/backtestWindow.ts
git commit -m "$(cat <<'EOF'
fix(coded-fe): derive coded exit warm-up from expression rows

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KQj31kEhK1PUdg6xDfpjof
EOF
)"
```

---

## Task 10: End-to-end verification

Prove the migration works in the real app before declaring Phase 1 done. Use the `/verify` skill (or drive the app manually): open the backtest panel, switch to Coded mode, pick a coded strategy, author a coded exit as an expression (e.g. `close < EMA(20)`), run a backtest, and confirm trades close on that expression. Then confirm ATR-based panel risk still applies on a coded run (the regression the architecture was chosen to avoid).

**Files:** none (verification only).

- [ ] **Step 1: Backend + frontend suites green.**

Run: `cd backend && python -m pytest -q` → Expected PASS (structured `rule.py` unit tests still present and passing; they are Phase 2's to delete).
Run: `cd frontend && npx vitest run` → Expected: no NEW failures beyond the known pre-existing structured ones.

- [ ] **Step 2: Drive the app.** Launch via the project run flow. In the backtest panel: Coded mode → select a strategy → coded exit editor shows the expression editor (not the operand pickers) → type `close < EMA(20)` → run. Confirm the run returns trades and at least one closes via the exit. Confirm an ATR stop configured in the coded panel risk still produces a stop-based exit (ATR risk not regressed).

- [ ] **Step 3: Confirm no structured coded-exit path remains.**

Run: `cd backend && grep -rn "CodedWithRuleExits\|RuleStrategy(" auto_trader/ | grep -v test`
Expected: no `CodedWithRuleExits`; `RuleStrategy(` may still appear ONLY where structured `/api/backtest` non-coded or structured `/api/strategy/evaluate` non-coded builds it (those are Phase 2 deletions). No coded site builds `RuleStrategy`.

- [ ] **Step 4: Report Phase 1 complete** and hand off to the Phase 2 plan (structured-stack deletion), which is written separately.

---

## Self-Review Notes

- **Spec coverage:** Phase 1 of the spec (migrate coded exits across backtest, sweep/WFO, live; keep coded machinery/ATR; drop persisted structured exits with no converter) maps to Tasks 1-9; verification to Task 10. Phase 2 (deletions) is a separate plan by design.
- **Type consistency:** `CodedWithExprExits(coded, exit_strategy)` (Task 1) is consumed identically in Tasks 3 and 4. `exprLongExit`/`exprShortExit` names are consistent across schema (Task 2), backend wiring (Tasks 3-4), and frontend (Tasks 6-7). `exprRows(g: RuleGroup): ExprRow[]` reused in Tasks 6-7.
- **Deferred to Phase 2 (intentionally):** `rule.py`, `RuleStrategy`, `RuleGroupDTO`, structured request fields/branches, `chartOperand*`, structured editor code, and their tests all remain live through Phase 1 so the suite stays green; they are deleted only once no runner builds structured rules.
