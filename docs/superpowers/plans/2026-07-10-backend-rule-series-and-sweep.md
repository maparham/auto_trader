# Backend-owned rule series + rule-based parameter sweeping — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move rule-series computation to the backend (business logic belongs server-side) and add parameter sweeping to the rule-based backtest that rides on it.

**Architecture:** A new pure Python assembler rebuilds the `series` dict `RuleStrategy` consumes — from the candles the request already carries — reusing the parity-tested leaf math in `backend/auto_trader/indicators/`. The single-run route stops trusting browser-shipped native series and calls the assembler; the sweep route loops over combos, patching the rule tree/risk per combo, memoizing each distinct series once per run. Chart-operand/drawing (`kind:"series"`) series remain browser-supplied and are the one exception.

**Tech Stack:** Python 3.12 / FastAPI / Pydantic v2 (backend), pytest; TypeScript / React / Preact-signals (frontend), Vitest.

## Global Constraints

- **Parity is exact.** Backend indicator math must equal the frontend's to `pytest.approx(rel=1e-12, abs=1e-12)`. Do NOT "improve" arithmetic — identical IEEE-754 operation order is the contract (`indicators/core.py` header).
- **No back-compat / migration code without asking.** Single-person project, no other users, no old data. The single-run route is migrated outright — it does not keep a "read shipped series if present" fallback. (`[[no-legacy-code]]`)
- **Business logic belongs on the backend.** Native indicators are computed server-side; the browser ships only candles + chart-operand/drawing series. (`[[backend-owns-business-logic]]`)
- **Live trading is out of scope.** `RuleStrategy` is unchanged — only *who fills its `series` dict* changes, and only in the backtest router. Live keeps populating it browser-side. (`[[live-trading-engine]]`)
- **Work on `main`.** Commit directly; do not branch. (`[[work-on-main-not-branches]]`)
- **Sweepable surface:** native indicators EMA/SMA/RSI/AVWAP/VOL/VOLMA over length / `@tf` / slope `~len`; const thresholds; exit counts; risk stop/target value & mult. Chart-operand/drawing series are NOT sweepable.

---

## File Structure

**Create:**
- `backend/auto_trader/strategy/rule_series.py` — the pure eager series assembler.
- `backend/tests/test_rule_series.py` — unit tests for the assembler.
- `backend/tests/test_rule_series_parity.py` — config-level parity gate vs frontend `buildSeries`.
- `backend/tests/fixtures/rule_series_golden.json` — generated golden (candles + config + htf + expected series).
- `frontend/src/lib/ruleSeriesParityGolden.test.ts` — generates the golden above.
- `backend/tests/test_api_backtest_rule_sweep.py` — rule-sweep endpoint tests.

**Modify:**
- `backend/auto_trader/api/routers/backtest.py` — validation inversion, `_run_rule` extraction, `_apply_rule_combo`, sweep generalization.
- `backend/auto_trader/api/schemas.py` — `SweepDTO` docstring (rule target grammar).
- `frontend/src/BacktestButton.tsx` — stop shipping native/ATR series; allow rule sweep.
- `frontend/src/lib/backtestSeries.ts` — split out a "chart-operand series only" build for the request.
- `frontend/src/lib/sweep.ts` — extend `SweepAxis.target` grammar comment.
- `frontend/src/BacktestSettingsModal.tsx` — `toggleRuleSweepAxis` + per-operand sweep toggles.

---

## Phase 1 — Backend series assembler

### Task 1: Base-timeframe assembler (native indicators, slope, ATR)

**Files:**
- Create: `backend/auto_trader/strategy/rule_series.py`
- Test: `backend/tests/test_rule_series.py`

**Interfaces:**
- Consumes: `Operand`, `series_name` (`strategy/rule.py`); `ema_series, sma_series, rsi_series, atr_series, avwap_series` (`indicators/core.py`); `slope_of` (`indicators/mtf.py`); `Candle` (`core/models.py`); `resolution_seconds` (`core/candle_aggregate.py`).
- Produces:
  - `htf_timeframes(operands: Iterable[Operand], base_resolution: str) -> set[str]` — distinct non-base, non-None operand timeframes.
  - `build_rule_series(operands: Iterable[Operand], candles: list[Candle], base_resolution: str, htf_candles: dict[str, list[Candle]], atr_lengths: Iterable[int] = ()) -> dict[str, list[float | None]]` — the series map `RuleStrategy`/`BacktestEngine` consume. Skips `kind=="series"` operands (chart operands are browser-supplied). Computes each distinct `series_name` once.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_rule_series.py
from datetime import datetime, timezone
from auto_trader.core.models import Candle
from auto_trader.indicators.core import ema_series, sma_series, rsi_series, avwap_series
from auto_trader.strategy.rule import Operand
from auto_trader.strategy.rule_series import build_rule_series, htf_timeframes


def _candles(closes, vols=None):
    vols = vols or [1.0] * len(closes)
    return [
        Candle(time=datetime.fromtimestamp(i * 3600, tz=timezone.utc),
               open=c, high=c + 1, low=c - 1, close=c, volume=v)
        for i, (c, v) in enumerate(zip(closes, vols))
    ]


def test_base_indicators_match_leaves():
    cs = _candles([10, 11, 12, 13, 14, 15, 16, 17])
    ops = [
        Operand(kind="indicator", indicator="EMA", length=3),
        Operand(kind="indicator", indicator="SMA", length=2),
        Operand(kind="indicator", indicator="VOL"),
        Operand(kind="indicator", indicator="VOLMA", length=2),
    ]
    out = build_rule_series(ops, cs, "HOUR", {})
    closes = [c.close for c in cs]
    assert out["EMA_3"] == ema_series(closes, 3)
    assert out["SMA_2"] == sma_series(closes, 2)
    assert out["VOL"] == [c.volume for c in cs]
    assert out["VOLMA_2"] == sma_series([c.volume for c in cs], 2)


def test_avwap_and_price_slope_and_atr():
    cs = _candles([10, 11, 12, 13, 14], vols=[1, 2, 3, 4, 5])
    anchor_ms = int(cs[1].time.timestamp() * 1000)
    ops = [
        Operand(kind="indicator", indicator="AVWAP", anchor=anchor_ms),
        Operand(kind="price", field="close", slope_len=2),
    ]
    out = build_rule_series(ops, cs, "HOUR", {}, atr_lengths=[3])
    assert out[f"AVWAP_{anchor_ms}"] == avwap_series(cs, anchor_ms)
    assert out["close~2"][0] is None and out["close~2"][2] is not None
    assert "ATR_3" in out and len(out["ATR_3"]) == len(cs)


def test_series_kind_operand_is_skipped():
    cs = _candles([10, 11, 12])
    ops = [Operand(kind="series", series_key="EMA_abc123", label="EMA(9)")]
    out = build_rule_series(ops, cs, "HOUR", {})
    assert "EMA_abc123" not in out  # chart operands are browser-supplied, not recomputed


def test_htf_timeframes_collects_non_base():
    ops = [
        Operand(kind="indicator", indicator="EMA", length=9, timeframe="HOUR_4"),
        Operand(kind="indicator", indicator="EMA", length=9),          # base
        Operand(kind="indicator", indicator="RSI", length=14, timeframe="DAY"),
    ]
    assert htf_timeframes(ops, "HOUR") == {"HOUR_4", "DAY"}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_rule_series.py -x -q`
Expected: FAIL — `ModuleNotFoundError: auto_trader.strategy.rule_series`.

- [ ] **Step 3: Write minimal implementation**

```python
# backend/auto_trader/strategy/rule_series.py
"""Eager server-side assembly of the series dict RuleStrategy consumes.

The frontend's buildSeries (frontend/src/lib/backtestSeries.ts) is the source of
truth for shape and ordering; this mirrors it operation-for-operation over the
same parity-tested leaf math so a rule backtest computed here equals the one the
chart drew. Skips chart-operand/drawing operands (kind="series"): those depend on
live chart state and stay browser-supplied."""

from __future__ import annotations

from collections.abc import Iterable, Sequence

from auto_trader.core.candle_aggregate import resolution_seconds
from auto_trader.core.models import Candle
from auto_trader.indicators.core import (
    atr_series, avwap_series, ema_series, rsi_series, sma_series,
)
from auto_trader.indicators.mtf import align_htf_to_base, slope_of
from auto_trader.strategy.rule import Operand, series_name


def _tf_hours(resolution: str) -> float:
    return (resolution_seconds(resolution) or 3600) / 3600


def _compute_raw(op: Operand, candles: Sequence[Candle]) -> list[float | None]:
    """Mirror frontend computeRaw for native operands (kind != series)."""
    if op.kind == "price":
        return [getattr(c, op.field) for c in candles]
    if op.kind != "indicator":
        return [None] * len(candles)
    closes = [c.close for c in candles]
    if op.indicator == "EMA":
        return ema_series(closes, op.length or 0)
    if op.indicator == "SMA":
        return sma_series(closes, op.length or 0)
    if op.indicator == "VOLMA":
        return sma_series([c.volume for c in candles], op.length or 0)
    if op.indicator == "VOL":
        return [c.volume for c in candles]
    if op.indicator == "AVWAP":
        return avwap_series(candles, op.anchor or 0)
    if op.indicator == "RSI":
        return rsi_series(closes, op.length or 14)
    return [None] * len(candles)


def _derive(op: Operand, candles: Sequence[Candle], bar_hours: float) -> list[float | None]:
    raw = _compute_raw(op, candles)
    if op.slope_len is None:
        return raw
    return slope_of(raw, op.slope_len, bar_hours)


def htf_timeframes(operands: Iterable[Operand], base_resolution: str) -> set[str]:
    out: set[str] = set()
    for op in operands:
        if op.kind in ("indicator", "series") and op.timeframe and op.timeframe != base_resolution:
            out.add(op.timeframe)
    return out


def build_rule_series(
    operands: Iterable[Operand],
    candles: list[Candle],
    base_resolution: str,
    htf_candles: dict[str, list[Candle]],
    atr_lengths: Iterable[int] = (),
) -> dict[str, list[float | None]]:
    out: dict[str, list[float | None]] = {}
    base_ms = [int(c.time.timestamp() * 1000) for c in candles]
    for op in operands:
        if op.kind == "series":
            continue                       # chart operand: browser-supplied
        name = series_name(op)
        if name is None or name in out:
            continue
        tf = op.timeframe if op.kind == "indicator" else None
        if not tf or tf == base_resolution:
            out[name] = _derive(op, candles, _tf_hours(base_resolution))
            continue
        htf = htf_candles.get(tf, [])
        htf_ms = (resolution_seconds(tf) or 0) * 1000
        values = _derive(op, htf, _tf_hours(tf))
        out[name] = align_htf_to_base(base_ms, htf, values, htf_ms)
    for length in atr_lengths:
        out.setdefault(f"ATR_{length}", atr_series(candles, length))
    return out
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_rule_series.py -x -q`
Expected: PASS (4 passed). The HTF test only exercises `htf_timeframes`; alignment is Task 2.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/strategy/rule_series.py backend/tests/test_rule_series.py
git commit -m "feat(backtest): eager backend rule-series assembler (base timeframe)"
```

---

### Task 2: HTF alignment path in the assembler

**Files:**
- Modify: `backend/auto_trader/strategy/rule_series.py` (already handles the HTF branch — this task adds the test that proves it)
- Test: `backend/tests/test_rule_series.py`

**Interfaces:**
- Consumes: `build_rule_series` (Task 1), `align_htf_to_base` (`indicators/mtf.py`).
- Produces: no new symbols — verifies the HTF branch and slope-before-align ordering.

- [ ] **Step 1: Write the failing test**

```python
# append to backend/tests/test_rule_series.py
from auto_trader.indicators.mtf import align_htf_to_base
from auto_trader.indicators.core import ema_series


def test_htf_ema_aligned_closed_bar():
    base = _candles([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21])   # 12 hourly bars
    # HOUR_4 candles: one every 4 base bars, closes 10,14,18
    htf = [
        Candle(time=datetime.fromtimestamp(i * 4 * 3600, tz=timezone.utc),
               open=c, high=c, low=c, close=c, volume=1.0)
        for i, c in enumerate([10.0, 14.0, 18.0])
    ]
    op = Operand(kind="indicator", indicator="EMA", length=2, timeframe="HOUR_4")
    out = build_rule_series([op], base, "HOUR", {"HOUR_4": htf})
    base_ms = [int(c.time.timestamp() * 1000) for c in base]
    htf_ms = 4 * 3600 * 1000
    expected = align_htf_to_base(base_ms, htf, ema_series([10.0, 14.0, 18.0], 2), htf_ms)
    assert out["EMA_2@HOUR_4"] == expected
    # closed-bar: the first HOUR_4 bar (opens at t=0) closes at t=4h, so base bars
    # 0..3 see nothing yet.
    assert out["EMA_2@HOUR_4"][0] is None
    assert out["EMA_2@HOUR_4"][4] is not None
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `cd backend && python -m pytest tests/test_rule_series.py::test_htf_ema_aligned_closed_bar -x -q`
Expected: PASS (Task 1's HTF branch already implements this). If it FAILS, fix the HTF branch in `build_rule_series` until it matches `align_htf_to_base` output.

- [ ] **Step 3: Commit**

```bash
git add backend/tests/test_rule_series.py
git commit -m "test(backtest): assembler HTF alignment (closed-bar, slope-before-align)"
```

---

### Task 3: Config-level parity gate vs frontend buildSeries

This is the acceptance gate for the whole migration: the leaf parity suite covers individual indicators, but NOT the assembly (operand collection, dedup by key, HTF windowing, warmup). This proves the assembled map equals `buildSeries` key-for-key.

**Files:**
- Create: `frontend/src/lib/ruleSeriesParityGolden.test.ts`
- Create: `backend/tests/fixtures/rule_series_golden.json` (generated by the frontend test)
- Create: `backend/tests/test_rule_series_parity.py`

**Interfaces:**
- Consumes: `buildSeries`, `type BacktestConfig`, `collectSeriesOperands` (frontend); `build_rule_series`, `htf_timeframes` (backend).
- Produces: the golden JSON — `{ baseResolution, candles: KLineData[], htf: Record<tf, KLineData[]>, config, series }`.

- [ ] **Step 1: Write the frontend golden generator**

```ts
// frontend/src/lib/ruleSeriesParityGolden.test.ts
// Emits backend/tests/fixtures/rule_series_golden.json — a representative rule
// config (base EMA, an HTF EMA, a sloped price, an AVWAP, an ATR risk) run
// through buildSeries. The backend asserts its assembler reproduces `series`.
import { writeFileSync } from "node:fs";
import { describe, it } from "vitest";
import { buildSeries } from "./backtestSeries";
import type { BacktestConfig } from "./backtestConfig";

function bars(closes: number[], stepMs: number, t0 = 0) {
  return closes.map((c, i) => ({
    timestamp: t0 + i * stepMs, open: c, high: c + 1, low: c - 1, close: c, volume: i + 1,
  }));
}

describe("rule series parity golden", () => {
  it("writes the golden fixture", async () => {
    const HOUR = 3600_000;
    const candles = bars([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21], HOUR);
    const htf4 = bars([10, 14, 18], 4 * HOUR);
    const config: BacktestConfig = {
      longEntry: { combine: "AND", rules: [
        { left: { kind: "indicator", indicator: "EMA", length: 3 }, op: "gt",
          right: { kind: "indicator", indicator: "EMA", length: 2, timeframe: "HOUR_4" } },
        { left: { kind: "price", field: "close", slope: { len: 2 } }, op: "gt",
          right: { kind: "const", value: 0 } },
      ] },
      longExit: { combine: "AND", rules: [] },
      shortEntry: { combine: "AND", rules: [] },
      shortExit: { combine: "AND", rules: [] },
      longRisk: { stop: { kind: "atr", mult: 2, length: 3 }, target: { kind: "none" } },
    } as unknown as BacktestConfig;

    const fetchTimeframe = async (tf: string) =>
      tf === "HOUR_4" ? (htf4 as never) : ([] as never);
    const series = await buildSeries(candles as never, config, "HOUR", fetchTimeframe);

    writeFileSync(
      new URL("../../../backend/tests/fixtures/rule_series_golden.json", import.meta.url),
      JSON.stringify({ baseResolution: "HOUR", candles, htf: { HOUR_4: htf4 }, config, series }, null, 2),
    );
  });
});
```

- [ ] **Step 2: Generate the golden**

Run: `cd frontend && npx vitest run src/lib/ruleSeriesParityGolden.test.ts`
Expected: PASS; `backend/tests/fixtures/rule_series_golden.json` now exists with a non-empty `series` object containing keys `EMA_3`, `EMA_2@HOUR_4`, `close~2`, `ATR_3`.

- [ ] **Step 3: Write the backend parity test**

```python
# backend/tests/test_rule_series_parity.py
"""Config-level parity gate: the assembler's full series map must equal the
frontend buildSeries output for the same config+candles. Regenerate the golden
with `npx vitest run src/lib/ruleSeriesParityGolden.test.ts`."""
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from auto_trader.api.schemas import OperandDTO, RiskConfigDTO, RuleGroupDTO
from auto_trader.core.models import Candle
from auto_trader.strategy.rule_series import build_rule_series, htf_timeframes

GOLDEN = Path(__file__).parent / "fixtures" / "rule_series_golden.json"


def _candles(rows):
    return [
        Candle(time=datetime.fromtimestamp(r["timestamp"] / 1000, tz=timezone.utc),
               open=r["open"], high=r["high"], low=r["low"], close=r["close"], volume=r["volume"])
        for r in rows
    ]


def _operands(cfg):
    ops = []
    for key in ("longEntry", "longExit", "shortEntry", "shortExit"):
        group = cfg.get(key) or {"combine": "AND", "rules": []}
        ops += [o.to_operand() for o in RuleGroupDTO(**group).operands()]
    return ops


def _atr_lengths(cfg):
    lengths = []
    for key in ("longRisk", "shortRisk"):
        if cfg.get(key):
            for name in RiskConfigDTO(**cfg[key]).atr_series_names():
                lengths.append(int(name.split("_")[1]))
    return lengths


def test_assembler_matches_buildSeries_golden():
    g = json.loads(GOLDEN.read_text())
    candles = _candles(g["candles"])
    htf = {tf: _candles(rows) for tf, rows in g["htf"].items()}
    ops = _operands(g["config"])
    out = build_rule_series(ops, candles, g["baseResolution"], htf, _atr_lengths(g["config"]))

    assert set(out) == set(g["series"]), "series keys differ from buildSeries"
    for name, expected in g["series"].items():
        got = out[name]
        assert len(got) == len(expected)
        for a, b in zip(got, expected):
            if a is None or b is None:
                assert a is b, f"{name}: None mismatch"
            else:
                assert a == pytest.approx(b, rel=1e-12, abs=1e-12), f"{name} diverged"
```

- [ ] **Step 4: Run the parity test**

Run: `cd backend && python -m pytest tests/test_rule_series_parity.py -x -q`
Expected: PASS. If keys differ, fix `_compute_raw`/`build_rule_series` ordering to match `buildSeries`; if values diverge, the leaf call or slope/align ordering is wrong.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/ruleSeriesParityGolden.test.ts backend/tests/fixtures/rule_series_golden.json backend/tests/test_rule_series_parity.py
git commit -m "test(backtest): config-level parity gate for backend rule-series assembler"
```

---

## Phase 2 — Single-run migration

### Task 4: Router helper — assemble series (with HTF fetch)

Extract the "collect operands → fetch HTF → build series" orchestration so both the single-run route and the sweep loop share it.

**Files:**
- Modify: `backend/auto_trader/api/routers/backtest.py`
- Test: `backend/tests/test_api_backtest.py` (add one integration assertion)

**Interfaces:**
- Consumes: `htf_timeframes`, `build_rule_series` (Task 1); `deps._fetch_symbol_candles`, `_HTF_WARMUP_BARS`, `resolution_seconds` (existing in `backtest.py`); `RuleGroupDTO.operands`, `OperandDTO.to_operand`, `RiskConfigDTO.atr_series_names`.
- Produces: `async def _assemble_rule_series(req: BacktestRequest, candles: list[Candle]) -> dict[str, list[float | None]]`.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_api_backtest.py — add near the other rule tests
def test_backend_recomputes_ema_ignoring_shipped_series(client, hourly_candles_payload):
    """A rule referencing EMA_3 must run off the BACKEND-computed EMA even when the
    request omits it from `series` (the browser no longer ships native series)."""
    payload = hourly_candles_payload  # helper: 30 hourly candles, tradeFromTime early
    payload["series"] = {}            # ship nothing
    payload["longEntry"] = {"combine": "AND", "rules": [
        {"left": {"kind": "indicator", "indicator": "EMA", "length": 3}, "op": "gt",
         "right": {"kind": "price", "field": "close"}}]}
    payload["longExit"] = {"combine": "AND", "rules": []}
    payload["shortEntry"] = {"combine": "AND", "rules": []}
    payload["shortExit"] = {"combine": "AND", "rules": []}
    r = client.post("/api/backtest", json=payload)
    assert r.status_code == 200  # no "missing series 'EMA_3'" 422
```

*(If `hourly_candles_payload` does not exist, build the payload inline from an existing rule test's fixture in the same file — reuse its candle list and `costs`/`tradeFromTime`/`resolution` keys.)*

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_api_backtest.py::test_backend_recomputes_ema_ignoring_shipped_series -x -q`
Expected: FAIL — 422 `missing series 'EMA_3'` (current validation still requires it).

- [ ] **Step 3: Add the assembler helper**

Add to `backtest.py` (after `_candle_from_dto`):

```python
def _rule_operands(req: BacktestRequest) -> list:
    ops = []
    for group in (req.longEntry, req.longExit, req.shortEntry, req.shortExit):
        ops += [o.to_operand() for o in group.operands()]
    return ops


def _rule_atr_lengths(req: BacktestRequest) -> list[int]:
    lengths: list[int] = []
    for cfg in (req.longRisk, req.shortRisk, req.longScaling, req.shortScaling):
        if cfg is None:
            continue
        for name in cfg.atr_series_names():
            lengths.append(int(name.split("_")[1]))
    return lengths


async def _assemble_rule_series(
    req: BacktestRequest, candles: list[Candle]
) -> dict[str, list[float | None]]:
    """Backend-owned rule series: recompute native indicators from `candles`,
    fetch+align any higher timeframes, and merge in the browser-supplied
    chart-operand series (kind='series', which cannot be recomputed server-side).
    On a native/chart-operand key collision the recomputed value wins."""
    ops = _rule_operands(req)
    htf_candles: dict[str, list[Candle]] = {}
    for tf in htf_timeframes(ops, req.resolution):
        warmup_from = req.candles[0].time - _HTF_WARMUP_BARS * resolution_seconds(tf)
        fetched = await deps._fetch_symbol_candles(
            req.broker, req.epic, tf, 1000, warmup_from, req.candles[-1].time, req.priceSide,
        )
        if not fetched:
            raise HTTPException(422, f"no candles for timeframe '{tf}'")
        htf_candles[tf] = fetched
    computed = build_rule_series(ops, candles, req.resolution, htf_candles, _rule_atr_lengths(req))
    # Chart-operand/drawing series stay browser-supplied; native keys recompute.
    chart_series = {
        series_name(o.to_operand()): req.series.get(series_name(o.to_operand()))
        for group in (req.longEntry, req.longExit, req.shortEntry, req.shortExit)
        for o in group.operands()
        if o.kind == "series"
    }
    return {**{k: v for k, v in chart_series.items() if v is not None}, **computed}
```

Add the import at the top: `from auto_trader.strategy.rule_series import build_rule_series, htf_timeframes`.

- [ ] **Step 4: Not passing yet — the route still validates.** Proceed to Task 5, which wires this in and removes the stale validation. Run the Task 4 test again after Task 5.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/routers/backtest.py
git commit -m "feat(backtest): _assemble_rule_series helper (native recompute + HTF fetch + chart-operand merge)"
```

---

### Task 5: Migrate the single-run route + invert validation

**Files:**
- Modify: `backend/auto_trader/api/routers/backtest.py` (lines 166–195 validation; 216–239 rule branch)
- Test: `backend/tests/test_api_backtest.py`

**Interfaces:**
- Consumes: `_assemble_rule_series` (Task 4).
- Produces: `async def _run_rule(req, candles) -> BacktestResult` used by the single-run route and (Task 7) the sweep loop.

- [ ] **Step 1: Write/adjust the failing tests**

Keep the Task 4 test. Add the validation-inversion test:

```python
# backend/tests/test_api_backtest.py
def test_chart_operand_series_still_required(client, hourly_candles_payload):
    """kind='series' operands are browser-supplied: omitting the series 422s."""
    payload = hourly_candles_payload
    payload["series"] = {}
    payload["longEntry"] = {"combine": "AND", "rules": [
        {"left": {"kind": "series", "seriesKey": "EMA_deadbeef", "label": "EMA(9)"},
         "op": "gt", "right": {"kind": "const", "value": 0}}]}
    for k in ("longExit", "shortEntry", "shortExit"):
        payload[k] = {"combine": "AND", "rules": []}
    r = client.post("/api/backtest", json=payload)
    assert r.status_code == 422
    assert "EMA_deadbeef" in r.json()["detail"]
```

Also review existing rule tests in this file: any that POST a **hand-authored native series** (e.g. an arbitrary `"EMA_3"` array that is not the true EMA of the candles) and assert trades will now break, because the backend recomputes. Update those to either (a) use a `kind:"series"` chart operand with the shipped array, or (b) assert against the real recomputed EMA. List them in the commit body.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_api_backtest.py -x -q`
Expected: the two new tests FAIL; some pre-existing tests may also fail where they relied on shipped native series.

- [ ] **Step 3: Rewrite the rule-mode validation + extract `_run_rule`**

Replace the rule-mode validation block (currently `backtest.py:166–195`) so it only checks chart-operand/drawing keys and ATR presence is no longer required (the backend computes ATR):

```python
    if req.codedStrategy is None:
        # Native indicator series are recomputed server-side; only chart-operand /
        # drawing operands (kind='series') are browser-supplied and must be present.
        for group in (req.longEntry, req.longExit, req.shortEntry, req.shortExit):
            for op in group.operands():
                if op.kind != "series":
                    continue
                name = series_name(op.to_operand())
                arr = req.series.get(name)
                if arr is None:
                    raise HTTPException(422, f"missing series '{name}' referenced by a rule")
                if len(arr) != len(req.candles):
                    raise HTTPException(
                        422, f"series '{name}' length {len(arr)} != candles length {len(req.candles)}")
    elif req.codedStrategy is not None:
        _validate_coded_exit_series(req)
```

Replace the inline rule branch (`backtest.py:216–239`) with a call to a new helper, defined above the route:

```python
async def _run_rule(req: BacktestRequest, candles: list[Candle]) -> BacktestResult:
    series = await _assemble_rule_series(req, candles)
    strategy = RuleStrategy(
        req.longEntry.to_group(), req.longExit.to_group(),
        req.shortEntry.to_group(), req.shortExit.to_group(),
        series, quantity=req.costs.quantity, trade_from_time=req.tradeFromTime,
        long_enabled=req.longEnabled, short_enabled=req.shortEnabled,
        base_timeframe=req.resolution,
    )
    engine = BacktestEngine(
        strategy,
        starting_cash=req.costs.startingCash,
        commission_per_side=req.costs.commissionPerSide,
        slippage=req.costs.slippage,
        long_risk=req.longRisk.to_risk() if req.longRisk else None,
        short_risk=req.shortRisk.to_risk() if req.shortRisk else None,
        long_scaling=req.longScaling.to_scaling() if req.longScaling else None,
        short_scaling=req.shortScaling.to_scaling() if req.shortScaling else None,
        series=series,
        mask=req.mask.to_mask() if req.mask else None,
    )
    return engine.run(candles)
```

In the route body, replace the `else:` rule branch with:

```python
    else:
        try:
            result = await _run_rule(req, candles)
        except StrategyRuntimeError as e:
            raise HTTPException(422, str(e))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_api_backtest.py tests/test_rule_series.py tests/test_rule_series_parity.py -q`
Expected: PASS, including the Task 4 test. Fix any updated legacy tests until green.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/routers/backtest.py backend/tests/test_api_backtest.py
git commit -m "feat(backtest): single-run rule route recomputes series backend-side; invert validation to chart-operands only"
```

---

## Phase 3 — Rule-based sweep

### Task 6: `_apply_rule_combo` — target-path patcher

**Files:**
- Modify: `backend/auto_trader/api/routers/backtest.py`
- Modify: `backend/auto_trader/api/schemas.py` (`SweepDTO` docstring)
- Test: `backend/tests/test_api_backtest_rule_sweep.py`

**Interfaces:**
- Consumes: `BacktestRequest`, `_RISK_TARGET`/`_apply_combo` risk logic (existing).
- Produces: `_RULE_TARGET` regex and `def _apply_rule_combo(req: BacktestRequest, combo: dict) -> BacktestRequest` — returns a patched copy. Target grammar:
  - `rule:<long|short>.<entry|exit>.<idx>.<left|right>.<length|value>`
  - `rule:<long|short>.<entry|exit>.<idx>.count`
  - `risk:<long|short>.<stop|target>.<value|mult>` (reused).

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_api_backtest_rule_sweep.py
import pytest
from fastapi import HTTPException
from auto_trader.api.routers.backtest import _apply_rule_combo
from auto_trader.api.schemas import BacktestRequest


def _req(**over):
    base = {
        "epic": "X", "resolution": "HOUR", "candles": [], "series": {},
        "longEntry": {"combine": "AND", "rules": [
            {"left": {"kind": "indicator", "indicator": "EMA", "length": 9}, "op": "gt",
             "right": {"kind": "const", "value": 50.0}}]},
        "longExit": {"combine": "AND", "rules": [
            {"left": {"kind": "price", "field": "close"}, "op": "lt",
             "right": {"kind": "const", "value": 0}, "count": 1}]},
        "shortEntry": {"combine": "AND", "rules": []},
        "shortExit": {"combine": "AND", "rules": []},
        "costs": {"quantity": 1, "commissionPerSide": 0, "slippage": 0, "startingCash": 1000},
        "tradeFromTime": 0,
    }
    base.update(over)
    return BacktestRequest(**base)


def test_patch_indicator_length():
    out = _apply_rule_combo(_req(), {"rule:long.entry.0.left.length": 21})
    assert out.longEntry.rules[0].left.length == 21


def test_patch_const_value_and_count():
    out = _apply_rule_combo(_req(), {"rule:long.entry.0.right.value": 75.0,
                                     "rule:long.exit.0.count": 3})
    assert out.longEntry.rules[0].right.value == 75.0
    assert out.longExit.rules[0].count == 3


def test_bad_path_422s():
    with pytest.raises(HTTPException) as e:
        _apply_rule_combo(_req(), {"rule:long.entry.9.left.length": 5})
    assert e.value.status_code == 422
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_api_backtest_rule_sweep.py -x -q`
Expected: FAIL — `ImportError: cannot import name '_apply_rule_combo'`.

- [ ] **Step 3: Implement**

```python
# backtest.py — near _apply_combo
_RULE_TARGET = re.compile(
    r"^rule:(long|short)\.(entry|exit)\.(\d+)\.(?:(left|right)\.(length|value)|(count))$"
)


def _apply_rule_combo(req: BacktestRequest, combo: dict) -> BacktestRequest:
    """Return a copy of `req` with each combo target patched into the rule tree /
    risk DTO. Reuses `_apply_combo` for `risk:` keys. 422s a malformed or
    out-of-range path so a stale axis can't silently no-op."""
    groups = {
        ("long", "entry"): [r.model_copy(deep=True) for r in req.longEntry.rules],
        ("long", "exit"): [r.model_copy(deep=True) for r in req.longExit.rules],
        ("short", "entry"): [r.model_copy(deep=True) for r in req.shortEntry.rules],
        ("short", "exit"): [r.model_copy(deep=True) for r in req.shortExit.rules],
    }
    risk_combo: dict = {}
    for target, value in combo.items():
        if target.startswith("risk:"):
            risk_combo[target] = value
            continue
        m = _RULE_TARGET.match(target)
        if not m:
            raise HTTPException(422, f"bad sweep target '{target}'")
        side, grp, idx_s, operand, field, count = m.groups()
        rules = groups[(side, grp)]
        idx = int(idx_s)
        if idx >= len(rules):
            raise HTTPException(422, f"sweep target '{target}' index out of range")
        rule = rules[idx]
        if count:
            rules[idx] = rule.model_copy(update={"count": int(value)})
        else:
            op = getattr(rule, operand)
            rules[idx] = rule.model_copy(update={
                operand: op.model_copy(update={field: value})})
    _, long_risk, short_risk = _apply_combo(req, risk_combo)  # risk-only combo
    return req.model_copy(update={
        "longEntry": req.longEntry.model_copy(update={"rules": groups[("long", "entry")]}),
        "longExit": req.longExit.model_copy(update={"rules": groups[("long", "exit")]}),
        "shortEntry": req.shortEntry.model_copy(update={"rules": groups[("short", "entry")]}),
        "shortExit": req.shortExit.model_copy(update={"rules": groups[("short", "exit")]}),
        "longRisk": long_risk, "shortRisk": short_risk,
    })
```

Update `SweepDTO`'s docstring in `schemas.py` to document the `rule:` grammar alongside `param:`/`risk:`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_api_backtest_rule_sweep.py -x -q`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/routers/backtest.py backend/auto_trader/api/schemas.py backend/tests/test_api_backtest_rule_sweep.py
git commit -m "feat(backtest): rule-tree sweep target grammar (_apply_rule_combo)"
```

---

### Task 7: Generalize `/api/backtest/sweep` for rule strategies

**Files:**
- Modify: `backend/auto_trader/api/routers/backtest.py` (`backtest_sweep`, lines 335–384)
- Test: `backend/tests/test_api_backtest_rule_sweep.py`

**Interfaces:**
- Consumes: `_apply_rule_combo` (Task 6), `_run_rule` (Task 5), `compute_metrics`, `resolution_seconds`.
- Produces: rule branch inside `backtest_sweep` — one `SweepRowDTO` per combo, per-combo error isolation.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_api_backtest_rule_sweep.py — endpoint tests
def test_rule_sweep_endpoint(client, hourly_candles_payload):
    payload = hourly_candles_payload
    payload["series"] = {}
    payload["longEntry"] = {"combine": "AND", "rules": [
        {"left": {"kind": "indicator", "indicator": "EMA", "length": 3}, "op": "gt",
         "right": {"kind": "price", "field": "close"}}]}
    for k in ("longExit", "shortEntry", "shortExit"):
        payload[k] = {"combine": "AND", "rules": []}
    payload["sweep"] = {"combos": [
        {"rule:long.entry.0.left.length": 3},
        {"rule:long.entry.0.left.length": 5},
    ]}
    r = client.post("/api/backtest/sweep", json=payload)
    assert r.status_code == 200
    rows = r.json()["rows"]
    assert len(rows) == 2
    assert all(row["metrics"] is not None for row in rows)
    assert rows[0]["combo"]["rule:long.entry.0.left.length"] == 3
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_api_backtest_rule_sweep.py::test_rule_sweep_endpoint -x -q`
Expected: FAIL — 422 `sweep requires a coded strategy`.

- [ ] **Step 3: Implement the rule branch**

In `backtest_sweep`, replace the hard guard `if req.codedStrategy is None: raise HTTPException(422, "sweep requires a coded strategy")` with a branch. Keep the combo-count cap. For the rule branch:

```python
    candles = [_candle_from_dto(c) for c in req.candles]
    if req.codedStrategy is None:
        # Rule sweep: validate chart-operand series once, patch + recompute per combo.
        for group in (req.longEntry, req.longExit, req.shortEntry, req.shortExit):
            for op in group.operands():
                if op.kind == "series" and series_name(op.to_operand()) not in req.series:
                    raise HTTPException(422, f"missing series '{series_name(op.to_operand())}'")
        rows: list[SweepRowDTO] = []
        for combo in req.sweep.combos:
            try:
                patched = _apply_rule_combo(req, combo)
                result = await _run_rule(patched, candles)
            except HTTPException:
                raise
            except Exception as e:                 # noqa: BLE001 — isolate one combo
                rows.append(SweepRowDTO(combo=combo, error=str(e)))
                continue
            metrics = compute_metrics(result.trades, result.equity, result.net_pnl,
                                      req.costs.startingCash, resolution_seconds(req.resolution))
            rows.append(SweepRowDTO(combo=combo, metrics={
                "net_pnl": round(result.net_pnl, 5), "n_trades": result.n_trades,
                "win_rate": round(result.win_rate, 4), "max_drawdown": round(result.max_drawdown, 5),
                "profit_factor": metrics.get("profit_factor"), "return_pct": metrics.get("return_pct"),
            }))
        return SweepResponse(rows=rows)
    # ...existing coded path unchanged below...
```

Move the existing coded-only validation (`_validate_coded_exit_series`, module load, declared-param check) inside an `else`/after the rule `return` so it only runs for coded requests.

**Note on series reuse:** `_run_rule` recomputes the full series map per combo. Each map is deduped internally (`build_rule_series` computes each distinct `series_name` once), so an un-swept EMA is computed once *per combo* but not N× *within* a combo. Cross-combo memoization of un-swept series is a possible later optimization; do NOT add it now (YAGNI) — but `log`/comment that un-swept series recompute per combo so it isn't mistaken for shared.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_api_backtest_rule_sweep.py tests/test_api_backtest_sweep.py -q`
Expected: PASS — rule sweep works AND the existing coded sweep tests still pass.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/routers/backtest.py backend/tests/test_api_backtest_rule_sweep.py
git commit -m "feat(backtest): rule-based parameter sweep endpoint"
```

---

## Phase 4 — Frontend

### Task 8: Stop shipping native series; keep only chart-operand series

**Files:**
- Modify: `frontend/src/lib/backtestSeries.ts`
- Modify: `frontend/src/BacktestButton.tsx`
- Test: `frontend/src/lib/backtestSeries.test.ts` (add a case) — or the nearest existing test of `buildSeries`.

**Interfaces:**
- Produces: `buildChartOperandSeries(candles, cfg, baseResolution, fetchTimeframe): Promise<Record<string, Array<number|null>>>` — computes ONLY `kind:"series"` operands (chart operands/drawings), which the backend can't recompute. Native indicators, slope, and ATR are dropped from the request payload.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/lib/backtestSeries.test.ts
import { describe, it, expect } from "vitest";
import { buildChartOperandSeries } from "./backtestSeries";

it("emits only chart-operand series, not native indicators", async () => {
  const candles = Array.from({ length: 5 }, (_, i) => ({
    timestamp: i * 3600_000, open: 10 + i, high: 11 + i, low: 9 + i, close: 10 + i, volume: 1,
  }));
  const cfg = { longEntry: { combine: "AND", rules: [
    { left: { kind: "indicator", indicator: "EMA", length: 3 }, op: "gt",
      right: { kind: "const", value: 0 } }] },
    longExit: { combine: "AND", rules: [] }, shortEntry: { combine: "AND", rules: [] },
    shortExit: { combine: "AND", rules: [] } };
  const out = await buildChartOperandSeries(candles as never, cfg as never, "HOUR", async () => [] as never);
  expect(Object.keys(out)).toHaveLength(0);   // EMA_3 is native → backend computes it
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/backtestSeries.test.ts`
Expected: FAIL — `buildChartOperandSeries` is not exported.

- [ ] **Step 3: Implement**

Add `buildChartOperandSeries` in `backtestSeries.ts` — the same loop as `buildSeries` but `continue` unless `op.kind === "series"`, and drop the ATR loop. Keep `buildSeries` for any non-backtest caller (chart preview) but switch the backtest request path (`BacktestButton.tsx`) to `buildChartOperandSeries`. Confirm no other backtest caller still sends the full `buildSeries` map into `/api/backtest`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/backtestSeries.test.ts && npx tsc --noEmit`
Expected: PASS + typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/backtestSeries.ts frontend/src/BacktestButton.tsx frontend/src/lib/backtestSeries.test.ts
git commit -m "feat(backtest): browser ships only chart-operand series; backend computes natives"
```

---

### Task 9: Rule sweep axis picker + allow rule sweeps

**Files:**
- Modify: `frontend/src/BacktestSettingsModal.tsx`
- Modify: `frontend/src/BacktestButton.tsx`
- Modify: `frontend/src/lib/sweep.ts` (extend the `SweepAxis.target` doc-comment)

**Interfaces:**
- Consumes: `sweepAxes`/`setSweepAxes`, existing `toggleRiskSweepAxis` pattern (`BacktestSettingsModal.tsx:448`), `SweepAxisRow`, `enumerateCombos`.
- Produces: `toggleRuleSweepAxis(target: string, current: number)` emitting `rule:<side>.<entry|exit>.<idx>.<left|right>.length` / `.value` / `rule:<side>.<...>.count` targets.

- [ ] **Step 1: Add `toggleRuleSweepAxis`** — mirror `toggleRiskSweepAxis` (same 2-axis cap, same default from/to/step heuristics):

```tsx
const toggleRuleSweepAxis = (target: string, current: number) => {
  setSweepAxes((axes) => {
    if (axes.some((a) => a.target === target)) return axes.filter((a) => a.target !== target);
    const base = current || 1;
    const next: SweepAxis = {
      target,
      label: target.replace(/^rule:/, ""),
      from: base,
      to: base * 2,
      step: Math.max(base / 10, 1),
    };
    const appended = [...axes, next];
    return appended.length > 2 ? appended.slice(appended.length - 2) : appended;
  };
};
```

- [ ] **Step 2: Wire a per-field sweep toggle** in `OperandPicker`/rule-row rendering (the numeric `length`/const `value` inputs, and the exit `CountField`). Each field gets a small "sweep" toggle button (reuse the same control the risk fields use for `toggleRiskSweepAxis`) that calls `toggleRuleSweepAxis(target, currentValue)` with the operand's path. The path is built from the side/group/rule-index/operand already in scope where the row is rendered. Render selected rule axes with the existing `SweepAxisRow` (it is axis-agnostic).

- [ ] **Step 3: Allow rule sweeps in `BacktestButton`** — remove/relax the coded-only gate so a run with `sweepAxes.length > 0` calls `runSweep(baseReq, axes, …)` for rule strategies too (the backend now supports it). `baseReq` uses `buildChartOperandSeries` from Task 8.

- [ ] **Step 4: Verify** — `cd frontend && npx tsc --noEmit && npx vitest run` and a manual smoke test (Task 10).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/BacktestSettingsModal.tsx frontend/src/BacktestButton.tsx frontend/src/lib/sweep.ts
git commit -m "feat(backtest): rule-strategy sweep axis picker + enable rule sweeps"
```

---

### Task 10: End-to-end verification (manual, via the run skill)

**Files:** none (verification only).

- [ ] **Step 1:** Start the app (use the `/run` skill or the project's dev servers — do NOT kill the user's HMR servers, `[[dev-environment]]`).
- [ ] **Step 2:** Open a chart, build a rule strategy using a native EMA cross, run a single backtest. Confirm results are unchanged vs. before the migration (same trades/metrics) — this is the migration's real-world parity check.
- [ ] **Step 3:** Mark the EMA length as a sweep axis, set a small range, run the sweep. Confirm the heatmap/table renders one cell per length and clicking a cell applies it.
- [ ] **Step 4:** Confirm the `/api/backtest` and `/api/backtest/sweep` request payloads no longer carry native `EMA_*`/`ATR_*` keys in `series` (browser dev-tools network tab), only any chart-operand keys.
- [ ] **Step 5:** Close any browser tab this session opened (`[[dev-environment]]`).

---

## Self-Review

**Spec coverage:**
- Backend eager assembler (design §Architecture.1) → Tasks 1–2.
- Dedup/memoize by `series_name` → Task 1 (`if name in out: continue`), noted in Task 7.
- HTF fetch reuse + slope-before-align → Tasks 2, 4.
- Validation inversion, per-kind, collision "recomputed wins" (design §Architecture.2) → Tasks 4–5.
- Sweep endpoint generalization + `_run_rule` extraction (design §Architecture.3) → Tasks 5, 7.
- Target-path grammar (design §Architecture.4; resolves Open Question) → Task 6, using the `rule:` prefix.
- Frontend axis picker (design §Architecture.5) → Task 9.
- New config-level parity fixture (design §Verification) → Task 3.
- Non-goal: live untouched → `RuleStrategy` unmodified across all tasks. Non-goal: exotics/chart-operands not swept → Task 8 keeps them browser-supplied, Task 6 grammar has no path to them.

**Open questions resolved here:** target-path syntax = `rule:` prefix (Task 6); collision policy = recomputed native value wins, shipped native keys are simply not read (Tasks 4–5).

**Known risk called out for the implementer:** Task 5 Step 1 — pre-existing rule tests that POST hand-authored native series will break under recompute and must be migrated to chart-operand form or real recomputed expectations. This is expected, not a regression.
