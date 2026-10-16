# Indicator Alerts on the Series Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Indicator alerts read every registered custom indicator through the backtest series registry, with no alert-only indicator logic left on either side.

**Architecture:** An indicator alert stores `{type, config, output}`, where `config` is the registry's own parsed config serialized to JSON. The backend validates and computes through `SERIES_INDICATORS` plus a small `ALERT_SPECS` table (which outputs are alertable, labels, refusals, heavy/sparse flags). The frontend sends the raw pane (`instance`) and asks `POST /api/alerts/describe` for outputs, labels and the current value, so it mirrors nothing.

**Tech Stack:** Python 3 / FastAPI / pytest (backend), React + TypeScript / vitest (frontend), sqlite (`alerts.db`).

**Spec:** `docs/superpowers/specs/2026-10-16-registry-indicator-alerts-design.md`

## Global Constraints

- klinecharts built-in indicators (BOLL, MACD, KDJ, CCI, DMI, SAR, ...) stay out of scope.
- No em dashes ("—" or "--") in any UI text or prose you write. Split the sentence instead.
- Run ONLY the test files a task names, never the full frontend suite. Backend: `cd backend && .venv/bin/python -m pytest <files> -q`. Frontend: `cd frontend && npx vitest run <files>`.
- Frontend typecheck is `cd frontend && npx tsc -b` (not `--noEmit`); lint is `npx eslint <files>`. Both must stay at zero errors.
- Commit on the current branch (`main`). Never create a branch. The worktree is shared with other sessions: never `git stash`, `git clean`, `git restore`, `git checkout -- <file>`; stage files by explicit path only.
- Never read the production `alerts.db`; tests use `tmp_path` databases.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Do not push.

## Rulings against the spec (made while planning; each lists its cost)

1. **`ALERT_SPECS` is its own dict** in `indicators/alert_specs.py`, keyed by registry type, instead of new fields on `IndicatorSeriesSpec`. Why: the registry's existing tests and the expression layer construct/compare `IndicatorSeriesSpec` and never need alert data. Cost if wrong: one more import to keep in step; a test pins `ALERT_SPECS.keys() <= SERIES_INDICATORS.keys()`.
2. **Stored `config` is the parsed config dataclass serialized** (`dataclasses.asdict`, sorted JSON), not a per-indicator `canonical(cfg) -> {calcParams, extendData}`. It is canonical by construction (ignored extendData keys and `3` vs `3.0` vanish in parsing) and needs no per-indicator code. Cost: a config with a field JSON cannot hold (inf, an enum) fails the round-trip test in Task 2 and must be special-cased there.
3. **Every alert series seeds the full `SEED_CAP`** (`warmup()` returns `MAX_WARMUP`, and the hub's `min(need + 50, SEED_CAP)` makes that 2000 bars), not "max(need + 50, 500)". Why: the chart computes on thousands of bars; EMA/RMA and every pivot-based indicator converge closer to the chart with the deepest seed, and the cost is one cached 2000-bar fetch per series. Readiness still uses the registry warm-up.
4. **An `event` output alert is stored as `target: "value", value: 0.5, condition: "crossing_up", evalOn: "close"`.** A 0/1 series crossing up through 0.5 is exactly "became 1 on this closed bar", so the evaluator, the engine and dedup need no new condition. Validation forces those four fields for event outputs and 422s `evalOn: "intrabar"`.
5. **`backend/tests/fixtures/indicator_parity/values.json` is frozen** and becomes the migration golden: it holds the chart's own MA/RSI/ATR/TRENDLINES values for the 12 configs today's alerts allow. `alertableParity.test.ts` (its generator) and `alertable.json` are deleted.
6. **The legend bell and indicator menu no longer show a disabled entry with a reason.** "Add alert" shows for every alertable type on a non-seconds chart; the reason (if any) shows inside the modal from `describe`, with Create disabled.
7. **TRENDLINES alerts only on `tl_nearest`** (as today). The ranked `tl_<n>` outputs change identity on every compute, so alerting on "rank 1" would watch a different line each bar.

## Review Focus

1. A pane whose `extendData` carries large runtime arrays (an MA or TRENDLINES pinned pane: `mtf.htfSeries`, `mtf.htfStarts`) is sent to the backend reduced to `mtf: {timeframe}`. Pinned in Task 7 (`alertInstanceOf` test).
2. Changing a pane's pin re-points its alerts to the new timeframe (the server derives `timeframe` from the pin). Pinned in Task 3 (`test_pin_sets_the_alert_timeframe`).
3. Pressing OK in the settings modal without changing anything must not reset an alert's crossing baseline: the PATCH carries the same instance, so `sig()` is unchanged. Pinned in Task 6 (`test_patch_same_instance_keeps_sig`).
4. Turning off a feature an alert watches (MA smoothing off while an alert is on `smoothingMa`) gets a 422 on re-point, and the user is asked to delete or keep. Pinned in Task 3 (`test_output_must_exist`) and Task 9 (`syncAlertsAfterEdit` refused test).
5. `describe` on an epic with no live alert series still returns values (one-off load), and a failed load returns `lastValues: {}`, not a 500. Pinned in Task 6.

---

### Task 1: MA and EMA panes in the registry

**Files:**
- Create: `backend/auto_trader/indicators/ma.py`
- Modify: `backend/auto_trader/indicators/registry.py` (imports; two entries in `SERIES_INDICATORS`)
- Create: `frontend/src/lib/indicators/maParity.test.ts`
- Create (generated): `backend/tests/fixtures/indicator_parity/ma_pane.json`
- Create: `backend/tests/test_ma_pane.py`

**Interfaces:**
- Produces: `MaConfig` (frozen dataclass: `length: int, ma_type: str, source: str, offset: int, smoothing: tuple[str, int] | None, envelope: bool, timeframe: str | None`), `parse_ma_config(calc_params, extend_data, *, template: str) -> MaConfig`, `ma_outputs(cfg) -> tuple[str, ...]`, `ma_pane_series(cfg, output, candles, bar_hours) -> list[float | None]`, `ma_warmup(cfg, output) -> int`. Registry keys `"MA"` (template `sma`) and `"EMA"` (template `ema`).
- MA/EMA are NOT added to the frontend `EXPR_INSTANCE_TYPES`: `mintInstanceId` would otherwise mint `EMA1` for new panes (EMA is an expr function name).

- [ ] **Step 1: Write the TS fixture generator test**

`frontend/src/lib/indicators/maParity.test.ts`:

```ts
// Writes (UPDATE_PARITY=1) or checks backend/tests/fixtures/indicator_parity/ma_pane.json:
// the chart's own computeMa output for the MA pane options the backend port
// (backend/auto_trader/indicators/ma.py) must reproduce.
import { describe, it, expect, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
vi.mock("klinecharts", () => ({
  registerIndicator: () => {},
  registerOverlay: () => {},
  registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));
import type { KLineData } from "klinecharts";
import { computeMa, type MaExtend } from "./ma";

const FILE = new URL("../../../../backend/tests/fixtures/indicator_parity/ma_pane.json", import.meta.url);

function candles(): KLineData[] {
  const out: KLineData[] = [];
  let p = 100;
  for (let i = 0; i < 400; i++) {
    const drift = Math.sin(i / 7) * 1.3 + Math.cos(i / 17) * 0.7;
    const open = p;
    const close = p + drift;
    const high = Math.max(open, close) + 0.4 + (i % 5) * 0.1;
    const low = Math.min(open, close) - 0.3 - (i % 3) * 0.1;
    out.push({ timestamp: 1_700_000_000_000 + i * 3_600_000, open, high, low, close, volume: 100 + (i % 11) * 10 });
    p = close;
  }
  return out;
}

const CASES: Array<{ type: "MA" | "EMA"; calcParams: number[]; extendData: MaExtend }> = [
  { type: "EMA", calcParams: [9], extendData: {} },
  { type: "MA", calcParams: [20], extendData: {} },
  { type: "MA", calcParams: [20], extendData: { maType: "ema", source: "hlcc4" } },
  { type: "EMA", calcParams: [21], extendData: { offset: 3 } },
  { type: "MA", calcParams: [10], extendData: { smoothing: { type: "ema", length: 5 } } },
  { type: "EMA", calcParams: [10], extendData: { smoothing: { type: "sma", length: 4 }, offset: 2 } },
  { type: "MA", calcParams: [14], extendData: { maType: "vwma", envelope: true } },
  { type: "MA", calcParams: [14], extendData: { maType: "evwma" } },
];

const KEYS = ["ma", "smoothingMa", "bandHi", "bandLo"] as const;

function build() {
  const data = candles();
  return {
    candles: data.map((k) => [k.timestamp, k.open, k.high, k.low, k.close, k.volume]),
    cases: CASES.map((c) => {
      const pts = computeMa(data, c.type === "EMA" ? "ema" : "sma", c.calcParams[0], c.extendData);
      const values: Record<string, (number | null)[]> = {};
      for (const k of KEYS) {
        const s = pts.map((p) => p[k] ?? null);
        if (s.some((v) => v !== null)) values[k] = s;
      }
      return { ...c, values };
    }),
  };
}

describe("MA pane parity fixture", () => {
  it("matches the committed fixture", () => {
    const fresh = build();
    if (process.env.UPDATE_PARITY === "1") writeFileSync(FILE, JSON.stringify(fresh) + "\n");
    expect(JSON.parse(readFileSync(FILE, "utf8"))).toEqual(JSON.parse(JSON.stringify(fresh)));
  });
});
```

- [ ] **Step 2: Generate the fixture**

Run: `cd frontend && UPDATE_PARITY=1 npx vitest run src/lib/indicators/maParity.test.ts`
Expected: PASS, and `backend/tests/fixtures/indicator_parity/ma_pane.json` exists. If `computeMa` or `MaExtend` is not exported from `ma.ts`, export it (add `export` only; no other change).

- [ ] **Step 3: Write the failing backend test**

`backend/tests/test_ma_pane.py`:

```python
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from auto_trader.core.models import Candle
from auto_trader.indicators.ma import ma_outputs, ma_warmup, parse_ma_config
from auto_trader.indicators.registry import SERIES_INDICATORS

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "indicator_parity" / "ma_pane.json").read_text())
CANDLES = [
    Candle(datetime.fromtimestamp(t / 1000, tz=timezone.utc), o, h, l, c, v)
    for t, o, h, l, c, v in FIXTURE["candles"]
]


@pytest.mark.parametrize("case", FIXTURE["cases"], ids=lambda c: f"{c['type']}-{json.dumps(c['extendData'])}")
def test_ma_pane_matches_the_chart(case):
    spec = SERIES_INDICATORS[case["type"]]
    cfg = spec.parse_config(case["calcParams"], case["extendData"])
    assert set(spec.outputs(cfg)) == set(case["values"])
    for output, want in case["values"].items():
        got = spec.series(cfg, output, CANDLES, 1.0)
        assert len(got) == len(want)
        for i, (g, w) in enumerate(zip(got, want)):
            if w is None:
                assert g is None, (output, i)
            else:
                assert g == pytest.approx(w, rel=1e-9, abs=1e-12), (output, i)


def test_template_defaults():
    assert parse_ma_config([], {}, template="ema").length == 9
    assert parse_ma_config([], {}, template="sma").length == 20
    assert parse_ma_config([20], {"maType": "bogus"}, template="ema").ma_type == "ema"
    assert parse_ma_config([20], {"source": "bogus"}, template="sma").source == "close"


def test_pinned_pane_has_no_bands_and_reports_its_pin():
    cfg = parse_ma_config([20], {"envelope": True, "mtf": {"timeframe": "HOUR_4", "htfSeries": [1, 2]}}, template="sma")
    assert cfg.timeframe == "HOUR_4"
    assert ma_outputs(cfg) == ("ma",)
    assert SERIES_INDICATORS["MA"].timeframe(cfg) == "HOUR_4"


def test_warmup():
    cfg = parse_ma_config([20], {"offset": 3, "smoothing": {"type": "ema", "length": 5}}, template="sma")
    assert ma_warmup(cfg, "ma") == 23
    assert ma_warmup(cfg, "smoothingMa") == 25
    assert ma_warmup(cfg, "bandHi") == 0
```

- [ ] **Step 4: Run it to make sure it fails**

Run: `cd backend && .venv/bin/python -m pytest tests/test_ma_pane.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'auto_trader.indicators.ma'`.

- [ ] **Step 5: Implement `ma.py`**

`backend/auto_trader/indicators/ma.py`:

```python
"""EMA / MA panes (registry types `EMA` and `MA`). Mirrors the chart-timeframe
path of frontend lib/indicators/ma.ts computeMa: length in calcParams[0],
maType/source/offset/smoothing/envelope on extendData, a pin in
extendData.mtf.timeframe (whoever feeds this the pin's bars computes on
them; a pinned pane draws no envelope, as on the chart)."""
from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

from auto_trader.core.models import Candle
from auto_trader.indicators.core import PRICE_SOURCES, ema_series, sma_series
from auto_trader.indicators.slope import MA_KINDS, ma_base

_SMOOTH_TYPES = ("sma", "ema")


@dataclass(frozen=True, slots=True)
class MaConfig:
    length: int
    ma_type: str
    source: str
    offset: int
    smoothing: tuple[str, int] | None
    envelope: bool
    timeframe: str | None


def _num(v: object) -> float | None:
    if isinstance(v, bool) or not isinstance(v, (int, float, str)):
        return None
    try:
        n = float(v)
    except ValueError:
        return None
    return n if math.isfinite(n) else None


def parse_ma_config(calc_params: object, extend_data: object, *, template: str) -> MaConfig:
    """`Number(calcParams[0]) || default` like the template's calc; every other
    field falls back to the chart's own default on anything malformed."""
    p = list(calc_params) if isinstance(calc_params, (list, tuple)) else []
    n = _num(p[0]) if p else None
    length = int(n) if n else (9 if template == "ema" else 20)
    ext = extend_data if isinstance(extend_data, dict) else {}
    ma_type = ext.get("maType") if ext.get("maType") in MA_KINDS else template
    source = ext.get("source") if ext.get("source") in PRICE_SOURCES else "close"
    off = _num(ext.get("offset"))
    offset = int(off) if off else 0
    sm = ext.get("smoothing")
    smoothing: tuple[str, int] | None = None
    if isinstance(sm, dict) and sm.get("type") in _SMOOTH_TYPES:
        sl = _num(sm.get("length"))
        if sl and sl > 0:
            smoothing = (sm["type"], int(sl))
    mtf = ext.get("mtf") if isinstance(ext.get("mtf"), dict) else {}
    tf = mtf.get("timeframe")
    return MaConfig(
        length=length, ma_type=ma_type, source=source, offset=offset, smoothing=smoothing,
        envelope=bool(ext.get("envelope")), timeframe=tf if isinstance(tf, str) and tf else None,
    )


def ma_outputs(cfg: MaConfig) -> tuple[str, ...]:
    out = ("ma",)
    if cfg.smoothing is not None:
        out += ("smoothingMa",)
    if cfg.envelope and cfg.timeframe is None:
        out += ("bandHi", "bandLo")
    return out


def _shift(series: list[float | None], k: int) -> list[float | None]:
    """mtf.ts applyOffset: offset > 0 plots the line k bars later."""
    if not k:
        return series
    out: list[float | None] = [None] * len(series)
    for i, v in enumerate(series):
        j = i + k
        if 0 <= j < len(series):
            out[j] = v
    return out


def _smooth(base: list[float | None], s: tuple[str, int]) -> list[float | None]:
    """mtf.ts maSeries smoothing: smooth only the defined tail, keep the gap."""
    start = next((i for i, v in enumerate(base) if v is not None), None)
    out: list[float | None] = [None] * len(base)
    if start is None:
        return out
    defined = [float(v) for v in base[start:]]  # contiguous once defined
    kind, length = s
    smoothed = ema_series(defined, length) if kind == "ema" else sma_series(defined, length)
    for i, v in enumerate(smoothed):
        out[start + i] = v
    return out


def ma_pane_series(cfg: MaConfig, output: str, candles: Sequence[Candle], bar_hours: float) -> list[float | None]:
    """bar_hours is unused; the IndicatorSeriesSpec signature requires it."""
    if output not in ma_outputs(cfg):
        return [None] * len(candles)
    if output == "bandHi":
        return ma_base(candles, cfg.ma_type, cfg.length, "high")
    if output == "bandLo":
        return ma_base(candles, cfg.ma_type, cfg.length, "low")
    base = ma_base(candles, cfg.ma_type, cfg.length, cfg.source)
    if output == "smoothingMa":
        return _smooth(base, cfg.smoothing)  # type: ignore[arg-type]  # outputs() guarantees it
    return _shift(base, cfg.offset)


def ma_warmup(cfg: MaConfig, output: str) -> int:
    if output not in ma_outputs(cfg):
        return 0
    if output == "ma":
        return cfg.length + max(cfg.offset, 0)
    if output == "smoothingMa":
        return cfg.length + cfg.smoothing[1]  # type: ignore[index]
    return cfg.length
```

If `MA_KINDS` is not importable from `slope.py`, define `MA_KINDS = ("ema", "sma", "vwma", "evwma")` in `ma.py` instead.

- [ ] **Step 6: Register MA and EMA**

In `backend/auto_trader/indicators/registry.py`, add `from functools import partial` and `from auto_trader.indicators import ma as _ma` to the imports, and these two entries to `SERIES_INDICATORS` (alphabetical position is not required):

```python
    "EMA": IndicatorSeriesSpec(
        parse_config=partial(_ma.parse_ma_config, template="ema"),
        outputs=_ma.ma_outputs,
        series=_ma.ma_pane_series,
        warmup=_ma.ma_warmup,
        timeframe=lambda cfg: cfg.timeframe,
    ),
    "MA": IndicatorSeriesSpec(
        parse_config=partial(_ma.parse_ma_config, template="sma"),
        outputs=_ma.ma_outputs,
        series=_ma.ma_pane_series,
        warmup=_ma.ma_warmup,
        timeframe=lambda cfg: cfg.timeframe,
    ),
```

- [ ] **Step 7: Run the tests**

Run: `cd backend && .venv/bin/python -m pytest tests/test_ma_pane.py tests/test_indicator_registry.py tests/test_indicator_series_api.py tests/test_expr_instances_route.py -q`
Expected: PASS. If a registry test asserts the exact key set, add `"EMA"` and `"MA"` to it. `series_api.compute_indicator_series` checks its `SIMPLE` set first, so `EMA`/`MA` keep their simple behavior there; do not change that file.

- [ ] **Step 8: Commit**

```bash
git add backend/auto_trader/indicators/ma.py backend/auto_trader/indicators/registry.py \
  backend/tests/test_ma_pane.py backend/tests/fixtures/indicator_parity/ma_pane.json \
  frontend/src/lib/indicators/maParity.test.ts
# plus any registry test you had to touch, and ma.ts if you added an export
git commit -m "feat(indicators): MA and EMA panes in the series registry"
```

---

### Task 2: Alert metadata and the alert series module

**Files:**
- Create: `backend/auto_trader/indicators/alert_specs.py`
- Create: `backend/auto_trader/indicators/alert_series.py`
- Create: `backend/tests/test_alert_specs.py`

**Interfaces:**
- Consumes: `SERIES_INDICATORS` (Task 1 adds MA/EMA).
- Produces (`alert_specs.py`): `AlertOutput(kind: Literal["level","event"]="level", price_scale: bool=False, price_only: bool=False)`, `AlertSpec(outputs, label, heavy=False, sparse=False, needs_volume=..., refusal=..., side_series=None)`, `ALERT_SPECS: dict[str, AlertSpec]`, `EVENT_LEVEL = 0.5`.
- Produces (`alert_series.py`): `SEED_CAP = 2000`, `MAX_WARMUP = 1950`, frozen dataclass `IndicatorKey(indicator: str, config: str = "", output: str = "value", bar_hours: float = 0.0, calc: tuple[float, ...] = ())`, `line_key(t_ref, p_ref, slope) -> IndicatorKey`, `config_json(cfg) -> str`, `config_of(indicator: str, config: str) -> Any` (cached), `key_of(params: dict) -> IndicatorKey`, `compute(key, candles) -> dict[str, list[float | None]]`, `warmup(key) -> int`, `min_bars(key) -> int`, `sparse(key) -> bool`, `heavy(key) -> bool`, `projects_intrabar(key) -> bool`.
- Nothing imports these yet; `alertable.py` stays until Task 3.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_alert_specs.py`:

```python
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from auto_trader.core.models import Candle
from auto_trader.indicators.alert_series import (
    MAX_WARMUP, IndicatorKey, compute, config_json, config_of, heavy, key_of, line_key, min_bars,
    projects_intrabar, sparse, warmup,
)
from auto_trader.indicators.alert_specs import ALERT_SPECS
from auto_trader.indicators.registry import SERIES_INDICATORS

_VALUES = json.loads((Path(__file__).parent / "fixtures" / "indicator_parity" / "values.json").read_text())
CANDLES = [
    Candle(datetime.fromtimestamp(t / 1000, tz=timezone.utc), o, h, l, c, v)
    for t, o, h, l, c, v in _VALUES["candles"]
]


def test_every_alert_spec_is_a_registry_type():
    assert set(ALERT_SPECS) <= set(SERIES_INDICATORS)
    assert set(ALERT_SPECS) == {
        "MA", "EMA", "RSI", "ATR", "TRENDLINES", "SLOPE", "FVG", "PIVOT_BANDS",
        "PIVOT_ANALYSIS", "SR_LEVELS", "SPIKE", "AUTO_FIB",
    }


@pytest.mark.parametrize("t", sorted(ALERT_SPECS))
def test_config_round_trips_through_json(t):
    cfg = SERIES_INDICATORS[t].parse_config(None, None)
    raw = config_json(cfg)
    json.loads(raw)  # strict JSON: config_json uses allow_nan=False
    assert config_of(t, raw) == cfg


@pytest.mark.parametrize("t", sorted(ALERT_SPECS))
def test_alert_outputs_are_registry_outputs(t):
    cfg = SERIES_INDICATORS[t].parse_config(None, None)
    outs = ALERT_SPECS[t].outputs(cfg)
    assert outs, t
    assert set(outs) <= set(SERIES_INDICATORS[t].outputs(cfg))
    for name in outs:
        assert ALERT_SPECS[t].label(cfg, name)


def test_parsing_ignores_unknown_extend_data_and_number_spelling():
    a = SERIES_INDICATORS["RSI"].parse_config([14], {"source": "hl2", "hideLegendValue": True})
    b = SERIES_INDICATORS["RSI"].parse_config([14.0], {"source": "hl2"})
    assert config_json(a) == config_json(b)


def test_labels_keep_todays_wording():
    p = lambda t, c, e: SERIES_INDICATORS[t].parse_config(c, e)  # noqa: E731
    assert ALERT_SPECS["MA"].label(p("MA", [20], {"maType": "ema"}), "ma") == "EMA 20"
    assert ALERT_SPECS["MA"].label(p("MA", [20], {"source": "hl2"}), "ma") == "SMA 20 hl2"
    assert ALERT_SPECS["RSI"].label(p("RSI", [14], {}), "value") == "RSI 14"
    assert ALERT_SPECS["RSI"].label(p("RSI", [14], {"source": "hl2"}), "value") == "RSI 14 hl2"
    assert ALERT_SPECS["ATR"].label(p("ATR", [14], {}), "14") == "ATR 14"
    assert ALERT_SPECS["ATR"].label(p("ATR", [14], {"smoothing": "ema"}), "14") == "ATR 14 ema"
    assert ALERT_SPECS["TRENDLINES"].label(p("TRENDLINES", [], {}), "tl_nearest") == "Trendlines nearest"
    fib = p("AUTO_FIB", [], {})
    assert ALERT_SPECS["AUTO_FIB"].label(fib, "f0_618") == "Auto fib 0.618"
    assert ALERT_SPECS["AUTO_FIB"].label(fib, "fm0_236") == "Auto fib -0.236"


def test_output_kinds():
    rsi = ALERT_SPECS["RSI"].outputs(SERIES_INDICATORS["RSI"].parse_config(None, None))
    assert rsi["value"].kind == "level" and not rsi["value"].price_scale
    assert rsi["bullDiv"].kind == "event"
    tl = ALERT_SPECS["TRENDLINES"].outputs(SERIES_INDICATORS["TRENDLINES"].parse_config(None, None))
    assert list(tl) == ["tl_nearest"] and tl["tl_nearest"].price_only
    ma = ALERT_SPECS["MA"].outputs(SERIES_INDICATORS["MA"].parse_config([20], {"envelope": True}))
    assert list(ma) == ["ma", "bandHi", "bandLo"] and all(o.price_scale for o in ma.values())


def _key(t, calc, ext, output, bar_hours=1.0):
    cfg = SERIES_INDICATORS[t].parse_config(calc, ext)
    return IndicatorKey(t, config_json(cfg), output, bar_hours)


def test_compute_matches_the_registry_series():
    k = _key("RSI", [14], {}, "value")
    cfg = SERIES_INDICATORS["RSI"].parse_config([14], {})
    assert compute(k, CANDLES) == {"value": SERIES_INDICATORS["RSI"].series(cfg, "value", CANDLES, 1.0)}


def test_trendlines_nearest_carries_its_side_series():
    out = compute(_key("TRENDLINES", [], {}, "tl_nearest"), CANDLES)
    assert set(out) == {"value", "held", "slope", "a1", "a2"}
    assert len(out["value"]) == len(CANDLES)


def test_line_key_compute():
    t0 = int(CANDLES[10].time.timestamp() * 1000)
    out = compute(line_key(t0, 100.0, 0.5), CANDLES)["value"]
    assert out[9] is None and out[10] == 100.0 and out[12] == 101.0


def test_flags():
    tl = _key("TRENDLINES", [], {}, "tl_nearest")
    rsi = _key("RSI", [14], {}, "value")
    sr = _key("SR_LEVELS", [], {}, "support")
    assert heavy(tl) and projects_intrabar(tl) and sparse(tl)
    assert not heavy(rsi) and not projects_intrabar(rsi) and not sparse(rsi)
    assert heavy(sr) and not projects_intrabar(sr) and sparse(sr)
    assert warmup(rsi) == warmup(tl) == MAX_WARMUP
    assert min_bars(rsi) == SERIES_INDICATORS["RSI"].warmup(SERIES_INDICATORS["RSI"].parse_config([14], {}), "value")
    assert min_bars(line_key(1, 1.0, 0.0)) == 1


def test_key_of_reads_stored_params():
    cfg = SERIES_INDICATORS["ATR"].parse_config([14], {})
    params = {"type": "ATR", "config": json.loads(config_json(cfg)), "output": "14", "timeframe": "HOUR"}
    k = key_of(params)
    assert k.indicator == "ATR" and k.output == "14" and k.bar_hours == 1.0
    assert k == key_of({**params, "config": dict(reversed(list(params["config"].items())))})
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd backend && .venv/bin/python -m pytest tests/test_alert_specs.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'auto_trader.indicators.alert_series'`.

- [ ] **Step 3: Implement `alert_specs.py`**

Before writing, open each indicator module to confirm the config field names used below (`RsiConfig.length/source`, `AtrConfig.length/smoothing`, `SlopeConfig`, `MaConfig`). Labels for MA/RSI/ATR/TRENDLINES must equal `alertable.indicator_label` today.

```python
"""What an alert may watch on each registry indicator, and how to name it.
The values themselves always come from SERIES_INDICATORS; this table only
says which outputs are alertable, which sit on the price axis, which are 0/1
events, the alert label, and the per-indicator refusals."""
from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any, Literal

from auto_trader.core.alert_bars import candle_ms
from auto_trader.core.models import Candle
from auto_trader.indicators.registry import SERIES_INDICATORS
from auto_trader.indicators.trendlines import TL_NEAREST, TrendLine, compute_trendlines, project_at

EVENT_LEVEL = 0.5  # a 0/1 event crosses up through this on the bar it fires


@dataclass(frozen=True, slots=True)
class AlertOutput:
    kind: Literal["level", "event"] = "level"
    price_scale: bool = False
    price_only: bool = False


LEVEL = AlertOutput()
PRICE = AlertOutput(price_scale=True)
EVENT = AlertOutput(kind="event")


def _no_volume(cfg: Any) -> bool:
    return False


def _no_refusal(cfg: Any, timeframe: str) -> str | None:
    return None


@dataclass(frozen=True, slots=True)
class AlertSpec:
    outputs: Callable[[Any], dict[str, AlertOutput]]
    label: Callable[[Any, str], str]
    heavy: bool = False   # closed values compute off the event loop; intrabar reads the last close
    sparse: bool = False  # a ready series may hold None (no level right now)
    needs_volume: Callable[[Any], bool] = _no_volume
    refusal: Callable[[Any, str], str | None] = _no_refusal
    # Replaces `series` for one output that needs more than its value (the
    # Trendlines held line): returns {"value": [...], <side>: [...]}.
    side_series: Callable[[Any, str, Sequence[Candle]], dict[str, list[float | None]]] | None = None


def _src(source: str) -> str:
    return "" if source == "close" else f" {source}"


# ---- MA / EMA ----

_MA_SUFFIX = {"ma": "", "smoothingMa": " smoothing", "bandHi": " upper band", "bandLo": " lower band"}


def _ma_label(cfg: Any, output: str) -> str:
    off = f" offset {cfg.offset}" if cfg.offset else ""
    return f"{cfg.ma_type.upper()} {cfg.length}{_src(cfg.source)}{off}{_MA_SUFFIX[output]}"


def _ma_outputs(cfg: Any) -> dict[str, AlertOutput]:
    return {name: PRICE for name in SERIES_INDICATORS["MA"].outputs(cfg)}


def _ma_refusal(cfg: Any, timeframe: str) -> str | None:
    return "Alerts need a length of at least 1" if cfg.length < 1 else None


_MA = AlertSpec(
    outputs=_ma_outputs, label=_ma_label,
    needs_volume=lambda cfg: cfg.ma_type in ("vwma", "evwma"), refusal=_ma_refusal,
)

# ---- RSI ----

_RSI_EVENTS = {
    "bullDiv": "bullish divergence", "bearDiv": "bearish divergence",
    "hBullDiv": "hidden bullish divergence", "hBearDiv": "hidden bearish divergence",
}


def _rsi_label(cfg: Any, output: str) -> str:
    base = f"RSI {cfg.length}{_src(cfg.source)}"
    return base if output == "value" else f"{base} {_RSI_EVENTS[output]}"


_RSI = AlertSpec(
    outputs=lambda cfg: {"value": LEVEL, **{k: EVENT for k in _RSI_EVENTS}},
    label=_rsi_label,
)

# ---- ATR ----


def _atr_label(cfg: Any, output: str) -> str:
    sm = "" if cfg.smoothing == "rma" else f" {cfg.smoothing}"
    return f"ATR {cfg.length}{sm}" + (" %" if output.endswith(".to%") else "")


_ATR = AlertSpec(
    outputs=lambda cfg: {name: LEVEL for name in SERIES_INDICATORS["ATR"].outputs(cfg)},
    label=_atr_label,
)

# ---- TRENDLINES (nearest line only, see plan ruling 7) ----


def _tl_side(cfg: Any, output: str, candles: Sequence[Candle]) -> dict[str, list[float | None]]:
    """value: the nearest line at bar i. held: the line nearest at bar i-1,
    projected to bar i (a close-mode cross is judged against it). slope /
    a1 / a2: that line's slope per bar and anchor open times, so intrabar can
    project it and the engine can tell a switch. Moved from alertable.py."""
    n = len(candles)
    nearest: list[TrendLine | None] = [None] * n
    points, _ = compute_trendlines(candles, cfg, nearest_out=nearest)
    held: list[float | None] = [None] * n
    for i in range(1, n):
        prev = nearest[i - 1]
        if prev is not None:
            held[i] = project_at(prev, i)
    return {
        "value": [p.get(TL_NEAREST) for p in points],
        "held": held,
        "slope": [None if ln is None else (ln.p2 - ln.p1) / (ln.i2 - ln.i1) for ln in nearest],
        "a1": [None if ln is None else float(candle_ms(candles[ln.i1])) for ln in nearest],
        "a2": [None if ln is None else float(candle_ms(candles[ln.i2])) for ln in nearest],
    }


_TL = AlertSpec(
    outputs=lambda cfg: {TL_NEAREST: AlertOutput(price_scale=True, price_only=True)},
    label=lambda cfg, output: "Trendlines nearest",
    heavy=True, sparse=True,
    refusal=lambda cfg, tf: "Nearest-line alerts need 5m or longer" if tf == "MINUTE" else None,
    side_series=_tl_side,
)

# ---- the rest: fixed output vocabularies ----


def _fixed(prefix: str, names: dict[str, tuple[str, AlertOutput]], type_: str) -> AlertSpec:
    return AlertSpec(
        outputs=lambda cfg: {k: names[k][1] for k in SERIES_INDICATORS[type_].outputs(cfg) if k in names},
        label=lambda cfg, output: f"{prefix} {names[output][0]}",
        heavy=True, sparse=True,
    )


_FVG = _fixed("FVG", {
    "bull_top": ("bull top", PRICE), "bull_bottom": ("bull bottom", PRICE),
    "bear_top": ("bear top", PRICE), "bear_bottom": ("bear bottom", PRICE),
}, "FVG")
_SR = _fixed("S/R", {"support": ("support", PRICE), "resistance": ("resistance", PRICE)}, "SR_LEVELS")
_PB = _fixed("Pivot bands", {
    "pivotHigh": ("high", PRICE), "pivotLow": ("low", PRICE),
    "barsSinceHigh": ("bars since high", LEVEL), "barsSinceLow": ("bars since low", LEVEL),
}, "PIVOT_BANDS")
_PA = _fixed("Pivot analysis", {
    "pivotHigh": ("high", PRICE), "pivotLow": ("low", PRICE),
    "deltaPct": ("change %", LEVEL), "deltaT": ("bars between", LEVEL),
}, "PIVOT_ANALYSIS")
_SPIKE = _fixed("Spike", {
    "spikeHigh": ("high", PRICE), "spikeLow": ("low", PRICE), "barsSinceSpike": ("bars since", LEVEL),
    "consolOk": ("consolidation", EVENT), "retracePct": ("retrace %", LEVEL),
    "maxRetracePct": ("max retrace %", LEVEL),
}, "SPIKE")


def _slope_label(cfg: Any, output: str) -> str:
    return f"Slope accel {output[len('accel'):]}" if output.startswith("accel") else f"Slope {output}"


_SLOPE = AlertSpec(
    outputs=lambda cfg: {name: LEVEL for name in SERIES_INDICATORS["SLOPE"].outputs(cfg)},
    label=_slope_label,
)


def _fib_label(cfg: Any, output: str) -> str:
    if output in ("high", "low"):
        return f"Auto fib {output}"
    # fib_output_name: "f", then "m" when negative, then |ratio| with "." as "_"
    # (f0_618, fm0_236).
    body = output[1:]
    neg = body.startswith("m")
    return f"Auto fib {'-' if neg else ''}{(body[1:] if neg else body).replace('_', '.')}"


_FIB = AlertSpec(
    outputs=lambda cfg: {k: PRICE for k in SERIES_INDICATORS["AUTO_FIB"].outputs(cfg) if k != "dir"},
    label=_fib_label,
    heavy=True, sparse=True,
)

ALERT_SPECS: dict[str, AlertSpec] = {
    "MA": _MA, "EMA": _MA, "RSI": _RSI, "ATR": _ATR, "TRENDLINES": _TL, "SLOPE": _SLOPE,
    "FVG": _FVG, "PIVOT_BANDS": _PB, "PIVOT_ANALYSIS": _PA, "SR_LEVELS": _SR, "SPIKE": _SPIKE,
    "AUTO_FIB": _FIB,
}
```

Notes for the implementer:
- `_ma_outputs` reads `SERIES_INDICATORS["MA"].outputs`; EMA shares the same `ma_outputs` function, so that is correct for both.
- Check `compute_trendlines`'s real signature for `nearest_out`; `alertable._trendlines_values` calls it as `compute_trendlines(candles, cfg, nearest_out=nearest)`, which is what `_tl_side` copies.

- [ ] **Step 4: Implement `alert_series.py`**

```python
"""Alert-side view of the series registry: the hub's key, its compute, its
seed/readiness numbers. Values come from SERIES_INDICATORS (or, for the
Trendlines nearest line, ALERT_SPECS' side series); nothing is computed here."""
from __future__ import annotations

import dataclasses
import json
import typing
from collections.abc import Sequence
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

from auto_trader.core.alert_bars import candle_ms
from auto_trader.core.candle_aggregate import resolution_seconds
from auto_trader.core.models import Candle
from auto_trader.indicators.alert_specs import ALERT_SPECS
from auto_trader.indicators.registry import SERIES_INDICATORS

SEED_CAP = 2000
MAX_WARMUP = SEED_CAP - 50


@dataclass(frozen=True)
class IndicatorKey:
    indicator: str               # registry type, or "LINE"
    config: str = ""             # config_json of the parsed config
    output: str = "value"
    bar_hours: float = 0.0
    calc: tuple[float, ...] = ()  # LINE only: (tRef, pRef, slope)


def line_key(t_ref: int, p_ref: float, slope: float) -> IndicatorKey:
    """The hub need for a `line` alert: a straight line in bars from tRef."""
    return IndicatorKey("LINE", calc=(float(t_ref), float(p_ref), float(slope)))


def config_json(cfg: Any) -> str:
    return json.dumps(dataclasses.asdict(cfg), sort_keys=True, allow_nan=False)


def _tupleize(v: Any) -> Any:
    if isinstance(v, list):
        return tuple(_tupleize(x) for x in v)
    if isinstance(v, dict):
        return {k: _tupleize(x) for k, x in v.items()}
    return v


def _build(cls: type, data: dict) -> Any:
    hints = typing.get_type_hints(cls)
    kw = {}
    for f in dataclasses.fields(cls):
        v, t = data[f.name], hints[f.name]
        kw[f.name] = _build(t, v) if dataclasses.is_dataclass(t) and isinstance(v, dict) else _tupleize(v)
    return cls(**kw)


@lru_cache(maxsize=512)
def config_of(indicator: str, config: str) -> Any:
    """The parsed config back from its JSON (raises KeyError/TypeError on a
    config that is not this type's)."""
    cls = type(SERIES_INDICATORS[indicator].parse_config(None, None))
    return _build(cls, json.loads(config))


def key_of(params: dict) -> IndicatorKey:
    """Stored indicator-alert params -> the hub key."""
    return IndicatorKey(
        params["type"],
        json.dumps(params["config"], sort_keys=True, allow_nan=False),
        params["output"],
        resolution_seconds(params["timeframe"]) / 3600.0,
    )


def compute(key: IndicatorKey, candles: Sequence[Candle]) -> dict[str, list[float | None]]:
    if key.indicator == "LINE":
        t_ref, p_ref, slope = key.calc
        times = [candle_ms(c) for c in candles]
        try:
            j = times.index(int(t_ref))
        except ValueError:
            return {"value": [None] * len(candles)}
        return {"value": [None if k < j else p_ref + slope * (k - j) for k in range(len(candles))]}
    cfg = config_of(key.indicator, key.config)
    side = ALERT_SPECS[key.indicator].side_series
    if side is not None:
        return side(cfg, key.output, candles)
    return {"value": SERIES_INDICATORS[key.indicator].series(cfg, key.output, candles, key.bar_hours)}


def warmup(key: IndicatorKey) -> int:
    """Seed target: the deepest history the cap allows, for every series
    (plan ruling 3). Readiness is min_bars."""
    return MAX_WARMUP


def min_bars(key: IndicatorKey) -> int:
    if key.indicator == "LINE":
        return 1
    cfg = config_of(key.indicator, key.config)
    return max(1, SERIES_INDICATORS[key.indicator].warmup(cfg, key.output))


def sparse(key: IndicatorKey) -> bool:
    return key.indicator != "LINE" and ALERT_SPECS[key.indicator].sparse


def heavy(key: IndicatorKey) -> bool:
    return key.indicator != "LINE" and ALERT_SPECS[key.indicator].heavy


def projects_intrabar(key: IndicatorKey) -> bool:
    """Intrabar projects the held line one bar on (Trendlines nearest)."""
    return key.indicator != "LINE" and ALERT_SPECS[key.indicator].side_series is not None
```

If `resolution_seconds` rejects a canonical timeframe such as `"HOUR"`, use the same converter `series_api.py` uses (it passes the chart resolution string) or `core.timeframe`'s seconds helper; the test `test_key_of_reads_stored_params` pins `HOUR -> 1.0`.

- [ ] **Step 5: Run the tests**

Run: `cd backend && .venv/bin/python -m pytest tests/test_alert_specs.py -q`
Expected: PASS. If `test_config_round_trips_through_json` fails for one type, fix `_build` for that field shape (for example an `Optional[SomeDataclass]` field: unwrap `typing.get_args`), never by excluding the type.

- [ ] **Step 6: Commit**

```bash
git add backend/auto_trader/indicators/alert_specs.py backend/auto_trader/indicators/alert_series.py backend/tests/test_alert_specs.py
git commit -m "feat(alerts): alert metadata and series view over the indicator registry"
```

---

### Task 3: Indicator alerts run on the registry

**Files:**
- Modify: `backend/auto_trader/core/alert_kinds.py` (imports, `IndicatorKind`, new `upgrade_params`, `LineKind.indicator_key` import source)
- Modify: `backend/auto_trader/core/alert_indicators.py` (imports, `_off_loop`, `values()`)
- Modify: `backend/auto_trader/core/alert_engine.py:49` (import `IndicatorKey` from `alert_series`)
- Delete: `backend/auto_trader/indicators/alertable.py`, `backend/tests/test_alertable.py`
- Modify: `backend/tests/test_indicator_parity.py` (drop the two alertable tests and the `alertable` import)
- Modify: `backend/tests/test_alert_kinds.py`, `backend/tests/test_alert_indicators.py`, `backend/tests/test_alert_engine.py`, `backend/tests/test_telegram_rich_alerts.py` (convert indicator params to the new shape)

**Interfaces:**
- Consumes: Task 2's `alert_series` and `alert_specs`.
- Produces: stored indicator params are `{type, config, output, timeframe, target, value, evalOn, link, condition, trigger}`. Create/patch may send `instance: {type, calcParams, extendData}` instead of `type`/`config`; `validate` consumes and removes it. `upgrade_params(params: dict) -> dict` converts the old `{indicator, calcParams, config, line}` shape (pure, returns new-shape params unchanged). `IndicatorKind.refusal_for(type_: str, cfg, timeframe: str) -> str | None` (used by Task 6's describe).

- [ ] **Step 1: Write the new kind tests**

Append to `backend/tests/test_alert_kinds.py` (and add the imports at the top):

```python
import json

import pytest

from auto_trader.core.alert_kinds import INDICATOR, upgrade_params
from auto_trader.indicators.alert_series import config_json
from auto_trader.indicators.registry import SERIES_INDICATORS


def _new(type_="RSI", calc=(14,), ext=None, output="value", **kw):
    p = {
        "instance": {"type": type_, "calcParams": list(calc), "extendData": ext or {}},
        "output": output, "timeframe": "HOUR", "target": "value", "value": 70.0,
        "evalOn": "close", "condition": "crossing", "trigger": "once", "link": None,
    }
    p.update(kw)
    return p


def test_instance_is_parsed_and_dropped():
    p = _new(ext={"source": "hl2", "hideLegendValue": True})
    INDICATOR.validate(p, lambda: True)
    assert "instance" not in p and p["type"] == "RSI"
    cfg = SERIES_INDICATORS["RSI"].parse_config([14], {"source": "hl2"})
    assert p["config"] == json.loads(config_json(cfg))


def test_output_must_exist():
    with pytest.raises(ValueError, match="params.output"):
        INDICATOR.validate(_new("MA", (20,), {}, "smoothingMa", target="price"), lambda: True)


def test_unregistered_type_is_refused():
    with pytest.raises(ValueError, match="not alertable"):
        INDICATOR.validate(_new("BOLL", (20,), {}, "up"), lambda: True)


def test_pin_sets_the_alert_timeframe():
    p = _new("MA", (20,), {"mtf": {"timeframe": "HOUR_4"}}, "ma", target="price")
    INDICATOR.validate(p, lambda: True)
    assert p["timeframe"] == "HOUR_4"


def test_event_output_is_stored_as_a_cross_up():
    p = _new(output="bullDiv", condition="greater", value=3.0)
    INDICATOR.validate(p, lambda: True)
    assert (p["target"], p["value"], p["condition"], p["evalOn"]) == ("value", 0.5, "crossing_up", "close")
    with pytest.raises(ValueError, match="intrabar"):
        INDICATOR.validate(_new(output="bullDiv", evalOn="intrabar"), lambda: True)


def test_price_target_needs_a_price_scale_output():
    with pytest.raises(ValueError, match="target"):
        INDICATOR.validate(_new(target="price"), lambda: True)
    with pytest.raises(ValueError, match="target"):
        INDICATOR.validate(_new("TRENDLINES", (), {}, "tl_nearest", target="value"), lambda: True)


def test_volume_weighted_intrabar_needs_streaming():
    p = _new("MA", (20,), {"maType": "vwma"}, "ma", target="price", evalOn="intrabar")
    with pytest.raises(ValueError, match="live volume"):
        INDICATOR.validate(p, lambda: False)


def test_trendlines_refuses_one_minute():
    with pytest.raises(ValueError, match="5m"):
        INDICATOR.validate(_new("TRENDLINES", (), {}, "tl_nearest", target="price", timeframe="MINUTE"), lambda: True)


def test_sig_ignores_spelling_and_unknown_keys():
    a, b = _new(calc=(14,), ext={"x": 1}), _new(calc=(14.0,))
    INDICATOR.validate(a, lambda: True)
    INDICATOR.validate(b, lambda: True)
    assert INDICATOR.sig(a) == INDICATOR.sig(b)


def test_stored_params_revalidate_without_instance():
    p = _new()
    INDICATOR.validate(p, lambda: True)
    again = dict(p)
    INDICATOR.validate(again, lambda: True)
    assert again == p


@pytest.mark.parametrize("old,type_,output", [
    ({"indicator": "MA", "calcParams": [20], "config": {"maType": "ema", "source": "hl2"}}, "MA", "ma"),
    ({"indicator": "RSI", "calcParams": [14], "config": {"source": "close"}}, "RSI", "value"),
    ({"indicator": "ATR", "calcParams": [14], "config": {"smoothing": "ema"}}, "ATR", "14"),
])
def test_upgrade_params(old, type_, output):
    common = {"line": "value", "timeframe": "HOUR", "target": "value", "value": 1.0, "evalOn": "close",
              "condition": "crossing", "trigger": "once", "link": {"scope": "s", "instanceId": "X"}}
    new = upgrade_params({**old, **common})
    assert new["type"] == type_ and new["output"] == output
    assert not {"indicator", "calcParams", "line"} & set(new)
    assert new["link"] == common["link"] and new["timeframe"] == "HOUR"
    assert upgrade_params(new) == new


def test_upgrade_unknown_legacy_indicator_is_a_value_error():
    with pytest.raises(ValueError, match="not alertable"):
        upgrade_params({"indicator": "BOLL", "calcParams": [20], "config": {}})


def test_step_level_close_cross_is_prev_close_vs_prev_value():
    from datetime import datetime, timezone
    from auto_trader.core.models import Candle
    p = _new("SR_LEVELS", (), {}, "support", target="price", value=None)
    INDICATOR.validate(p, lambda: True)
    t = datetime(2026, 1, 1, tzinfo=timezone.utc)
    before, last = Candle(t, 10, 10, 10, 10.0, 1), Candle(t, 9, 9, 9, 9.0, 1)
    cur, prev = INDICATOR.resolve_close(p, last, before, {"value": 9.5}, {"value": 8.0})
    assert cur == (9.0, 9.5) and prev == (10.0, 8.0)
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd backend && .venv/bin/python -m pytest tests/test_alert_kinds.py -q`
Expected: FAIL with `ImportError: cannot import name 'upgrade_params'`.

- [ ] **Step 3: Rewrite `IndicatorKind` and add `upgrade_params`**

In `backend/auto_trader/core/alert_kinds.py` replace the `alertable` import with:

```python
from auto_trader.indicators.alert_series import MAX_WARMUP, IndicatorKey, config_json, config_of, key_of, line_key
from auto_trader.indicators.alert_specs import ALERT_SPECS, EVENT_LEVEL
from auto_trader.indicators.registry import SERIES_INDICATORS
from auto_trader.indicators.trendlines import TL_NEAREST
```

Add above `class IndicatorKind`:

```python
_LEGACY = {
    # old indicator -> (type, extendData from old config, output from length)
    "MA": ("MA", lambda c: {"maType": c.get("maType", "sma"), "source": c.get("source", "close")}, lambda n: "ma"),
    "RSI": ("RSI", lambda c: {"source": c.get("source", "close")}, lambda n: "value"),
    "ATR": ("ATR", lambda c: {"smoothing": c.get("smoothing", "rma")}, lambda n: str(n)),
    "TRENDLINES": ("TRENDLINES", lambda c: {}, lambda n: TL_NEAREST),
}


def upgrade_params(params: dict) -> dict:
    """Old `{indicator, calcParams, config, line}` indicator params -> the
    registry shape. New-shape params come back unchanged. Used by the store
    migration, by re-arm from triggered history, and by the engine for any
    row it reads."""
    if "indicator" not in params:
        return params
    legacy = _LEGACY.get(params["indicator"])
    if legacy is None:
        raise ValueError(f"params.indicator {params['indicator']!r} is not alertable")
    type_, ext_of, out_of = legacy
    calc = list(params.get("calcParams") or [])
    ext = ext_of(params.get("config") or {})
    cfg = SERIES_INDICATORS[type_].parse_config(calc, ext)
    new = {k: v for k, v in params.items() if k not in ("indicator", "calcParams", "config", "line")}
    new.update(type=type_, config=json.loads(config_json(cfg)), output=out_of(int(calc[0]) if calc else 0))
    return new


def _parsed(params: dict) -> tuple[str, Any]:
    """(type, parsed config) from `instance` (consumed) or the stored pair."""
    inst = params.pop("instance", None)
    if inst is not None:
        if not isinstance(inst, dict):
            raise ValueError("params.instance must be {type, calcParams, extendData}")
        type_ = inst.get("type")
        if type_ not in ALERT_SPECS:
            raise ValueError(f"params.instance.type {type_!r} is not alertable")
        cfg = SERIES_INDICATORS[type_].parse_config(inst.get("calcParams"), inst.get("extendData"))
        params["type"], params["config"] = type_, json.loads(config_json(cfg))
        return type_, cfg
    type_ = params.get("type")
    if type_ not in ALERT_SPECS or not isinstance(params.get("config"), dict):
        raise ValueError("params.instance is required")
    try:
        return type_, config_of(type_, json.dumps(params["config"], sort_keys=True, allow_nan=False))
    except (KeyError, TypeError, ValueError):
        raise ValueError(f"params.config is not a valid {type_} config") from None
```

Replace the whole `class IndicatorKind` with:

```python
class IndicatorKind:
    @staticmethod
    def refusal_for(type_: str, cfg: Any, timeframe: str) -> str | None:
        """Why an alert on this pane at this timeframe is refused, or None.
        Shared by validate and /api/alerts/describe."""
        try:
            canon = _tf.canonicalize(timeframe)
        except _tf.TimeframeError:
            canon = None
        if canon is None or not _tf.is_native(canon):
            return "Alerts on this timeframe are coming later"
        return ALERT_SPECS[type_].refusal(cfg, canon)

    def validate(self, params: dict, streams: Callable[[], bool]) -> None:
        params.update(upgrade_params(params))
        for stale in ("indicator", "calcParams", "line"):
            params.pop(stale, None)
        type_, cfg = _parsed(params)
        spec, alert = SERIES_INDICATORS[type_], ALERT_SPECS[type_]
        outs = alert.outputs(cfg)
        out = params.get("output")
        if out not in outs:
            raise ValueError(f"params.output must be one of {sorted(outs)}")
        pin = spec.timeframe(cfg)
        if pin:
            params["timeframe"] = pin
        o = outs[out]
        if o.kind == "event":
            if params.get("evalOn") == "intrabar":
                raise ValueError("params.evalOn: event alerts fire on a closed bar, not intrabar")
            params.update(target="value", value=EVENT_LEVEL, condition="crossing_up", evalOn="close")
        _validate_common(params)
        _validate_series_params(params)
        reason = self.refusal_for(type_, cfg, params["timeframe"])
        if reason:
            raise ValueError(reason)
        if spec.warmup(cfg, out) > MAX_WARMUP:
            raise ValueError("params: length too long for alerts")
        target = params.get("target")
        if target not in ("price", "value"):
            raise ValueError("params.target must be 'price' or 'value'")
        if o.price_only and target != "price":
            raise ValueError("params.target must be 'price' for this output")
        if target == "price" and not o.price_scale:
            raise ValueError("params.target 'price' needs an output on the price axis")
        if target == "value":
            if not _finite_number(params.get("value")):
                raise ValueError("params.value must be a finite number")
        else:
            params["value"] = None
        link = params.get("link")
        if link is not None and not (
            isinstance(link, dict)
            and isinstance(link.get("scope"), str) and 0 < len(link["scope"]) <= 200
            and isinstance(link.get("instanceId"), str) and 0 < len(link["instanceId"]) <= 64
        ):
            raise ValueError("params.link must be {scope, instanceId} strings or null")
        if params["evalOn"] == "intrabar" and alert.needs_volume(cfg) and not streams():
            raise ValueError(
                "params.evalOn 'intrabar' needs live volume; this broker only has quotes"
            )

    def bar_resolution(self, params: dict) -> str:
        return params["timeframe"]

    def eval_on(self, params: dict) -> str:
        return params["evalOn"]

    def indicator_key(self, params: dict) -> IndicatorKey:
        return key_of(upgrade_params(params))

    def resolve(self, params, price, values):
        line = (values or {}).get("value")
        if line is None or not math.isfinite(line):
            return None
        if params["target"] == "price":
            return (price, line)
        return (line, params["value"])

    def _held_line(self, params: dict) -> bool:
        return ALERT_SPECS[upgrade_params(params)["type"]].side_series is not None

    def resolve_close(self, params, last, before, vals, pvals):
        if not self._held_line(params):
            return _resolve_close_default(self, params, last, before, vals, pvals)
        # The line nearest at the previous close, at both bars: `held` is it
        # projected to this bar, the previous `value` is it at its own bar.
        # A switch to another line is therefore never read as a cross.
        held = (vals or {}).get("held")
        was = (pvals or {}).get("value")
        cur = (last.close, held) if last is not None and held is not None and math.isfinite(held) else None
        prev = (before.close, was) if before is not None and was is not None and math.isfinite(was) else None
        return cur, prev

    def level_sig(self, params, values):
        if not values or not self._held_line(params):
            return None
        return (values.get("a1"), values.get("a2"))

    def label(self, params: dict) -> str:
        p = upgrade_params(params)
        cfg = config_of(p["type"], json.dumps(p["config"], sort_keys=True, allow_nan=False))
        return f"{ALERT_SPECS[p['type']].label(cfg, p['output'])} ({_tf.label(p['timeframe'])})"

    def sig(self, params: dict) -> str:
        p = upgrade_params(params)
        keys = ("type", "config", "output", "target", "value", "timeframe", "evalOn", "condition", "trigger")
        return json.dumps({k: p.get(k) for k in keys}, sort_keys=True)

    def payload_extras(self, params: dict, pair: Pair) -> dict:
        return {
            "label": self.label(params),
            "target": params["target"],
            "subject": pair[0],
            "evalOn": params["evalOn"],
        }
```

`LineKind.indicator_key` keeps calling `line_key(...)`, now imported from `alert_series`. Remove the now-unused `TRENDLINES_REFUSED_TF`, `indicator_label`, `validate_indicator`, `volume_weighted` references.

- [ ] **Step 4: Switch the hub and the engine**

In `backend/auto_trader/core/alert_indicators.py`:

```python
from auto_trader.indicators.alert_series import (
    SEED_CAP, IndicatorKey, compute, heavy, min_bars, projects_intrabar, sparse, warmup,
)
```

Delete `_OFF_LOOP` and make `_off_loop` read:

```python
def _off_loop(ind: IndicatorKey) -> bool:
    return heavy(ind)
```

In `IndicatorHub.values()` replace the `if ind.indicator == "TRENDLINES":` block with:

```python
        if projects_intrabar(ind):
            # The held line (nearest at the last close) one bar on: a
            # projection, never a forming-bar recompute of the whole detector.
            closed = st.closed_vals[ind]
            v, s = closed.get("value"), closed.get("slope")
            return {**closed, "value": v + s if v is not None and s is not None else None}
        if heavy(ind):
            # Step levels that move only on a close: the last close's value.
            return st.closed_vals[ind]
```

Update the module docstring's `indicators.alertable.compute` mention to `indicators.alert_series.compute`. In `backend/auto_trader/core/alert_engine.py:49` import `IndicatorKey` from `auto_trader.indicators.alert_series`.

- [ ] **Step 5: Delete the alertable module and its tests**

```bash
git rm backend/auto_trader/indicators/alertable.py backend/tests/test_alertable.py
```

In `backend/tests/test_indicator_parity.py` delete `test_alertable_registry_matches_frontend`, `test_alertable_values_match_frontend`, the `_ALERTABLE_VALUES`/`_ALERTABLE_CANDLES` module globals and the `from auto_trader.indicators.alertable import ...` line (Task 4 moves the values check into the migration test).

Then: `cd backend && grep -rn "alertable" auto_trader tests scripts` must print nothing except comments you then fix.

- [ ] **Step 6: Convert the existing indicator-alert tests**

In `test_alert_kinds.py`, `test_alert_indicators.py`, `test_alert_engine.py`, `test_telegram_rich_alerts.py`, every indicator alert built in the old shape (`"indicator": ..., "calcParams": ..., "config": ..., "line": "value"`) is converted by wrapping the params dict in `upgrade_params(...)` (import it from `auto_trader.core.alert_kinds`), and every hub key built as `IndicatorKey("MA", (20,), (("maType","sma"),("source","close")))` (old 3-tuple form) is replaced by `key_of(upgrade_params(<the matching params>))` from `alert_series`. Do not change what a test asserts, except:
- assertions on seed sizes (`need + 50`) now expect `SEED_CAP` (plan ruling 3);
- assertions that a TRENDLINES alert's label is "Trendlines nearest (1H)" stay as they are.

If a test asserts behavior the spec changed on purpose (for example "offset must be 0" or "smoothed MA refused"), delete that test and say so in the commit message.

- [ ] **Step 7: Run the tests**

Run: `cd backend && .venv/bin/python -m pytest tests/test_alert_kinds.py tests/test_alert_indicators.py tests/test_alert_engine.py tests/test_telegram_rich_alerts.py tests/test_alert_specs.py tests/test_indicator_parity.py tests/test_alerts_api.py -q`
Expected: PASS except `test_alerts_api.py` cases that POST the old shape; convert those the same way (POST bodies may stay in the old shape on purpose: `validate` upgrades them, which is what keeps an old frontend tab working during deploy). Keep at least one test that POSTs the old shape and asserts the stored row is in the new shape.

- [ ] **Step 8: Commit**

```bash
git add backend/auto_trader/core/alert_kinds.py backend/auto_trader/core/alert_indicators.py \
  backend/auto_trader/core/alert_engine.py backend/tests/test_alert_kinds.py \
  backend/tests/test_alert_indicators.py backend/tests/test_alert_engine.py \
  backend/tests/test_telegram_rich_alerts.py backend/tests/test_indicator_parity.py backend/tests/test_alerts_api.py
git commit -m "feat(alerts): indicator alerts evaluate through the series registry"
```

---

### Task 4: Migrate stored alerts and history

**Files:**
- Modify: `backend/auto_trader/core/alert_store.py` (migration step 2)
- Modify: `backend/auto_trader/api/alert_hooks.py` (`_rearm`)
- Modify: `backend/auto_trader/api/routers/alerts.py` (`get_triggered`)
- Create: `backend/tests/test_alert_registry_migration.py`

**Interfaces:**
- Consumes: `upgrade_params` (Task 3), `key_of`/`compute` (Task 2).
- Produces: after `AlertStore(path)` opens a DB, every `kind = 'indicator'` row is in the new shape; a re-armed triggered alert and the `alert` in `GET /api/alerts/triggered` entries are upgraded on read.

- [ ] **Step 1: Write the failing tests**

```python
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import pytest

from auto_trader.core.alert_kinds import upgrade_params
from auto_trader.core.alert_store import AlertStore
from auto_trader.core.models import Candle
from auto_trader.indicators.alert_series import compute, key_of

_VALUES = json.loads((Path(__file__).parent / "fixtures" / "indicator_parity" / "values.json").read_text())
CANDLES = [
    Candle(datetime.fromtimestamp(t / 1000, tz=timezone.utc), o, h, l, c, v)
    for t, o, h, l, c, v in _VALUES["candles"]
]


@pytest.mark.parametrize("case", _VALUES["cases"], ids=lambda c: f"{c['indicator']}-{c['config']}")
def test_migrated_alert_reads_the_charts_values(case):
    """values.json is the chart's own series for every config today's alerts
    allow (frozen, plan ruling 5); a migrated alert must read the same."""
    params = upgrade_params({**case, "line": "value", "timeframe": "HOUR"})
    got = compute(key_of(params), CANDLES)["value"]
    assert len(got) == len(case["values"])
    for i, (g, want) in enumerate(zip(got, case["values"])):
        if want is None:
            assert g is None, i
        else:
            assert g == pytest.approx(want, rel=1e-6, abs=1e-9), i


def _old_row(alert_id="al-1"):
    return {
        "indicator": "RSI", "calcParams": [14], "config": {"source": "close"}, "line": "value",
        "timeframe": "HOUR", "target": "value", "value": 70, "evalOn": "close",
        "condition": "crossing", "trigger": "once", "link": None,
    }


def test_store_migrates_old_indicator_rows(tmp_path):
    db = tmp_path / "alerts.db"
    AlertStore(str(db))  # schema + migrations up to today
    conn = sqlite3.connect(db)
    conn.execute("PRAGMA user_version = 1")  # pretend migration 2 never ran
    conn.execute(
        "INSERT INTO alerts (user_id, id, broker, epic, kind, params, message, expires_at, notify, precision,"
        " active, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ("u1", "al-1", "b", "E", "indicator", json.dumps(_old_row()), "", None, "{}", 2, 1, 0, 0),
    )
    conn.commit()
    conn.close()
    AlertStore(str(db))
    conn = sqlite3.connect(db)
    params = json.loads(conn.execute("SELECT params FROM alerts WHERE id = 'al-1'").fetchone()[0])
    assert params["type"] == "RSI" and params["output"] == "value" and "indicator" not in params
```

If the `alerts` table's column list differs from the INSERT above, read `_SCHEMA` in `alert_store.py` and match it exactly.

- [ ] **Step 2: Run them to make sure the store test fails**

Run: `cd backend && .venv/bin/python -m pytest tests/test_alert_registry_migration.py -q`
Expected: the parametrized value tests PASS (Task 3 already reads the registry); `test_store_migrates_old_indicator_rows` FAILS (`KeyError: 'type'` or the old keys still present).

- [ ] **Step 3: Add migration step 2**

In `alert_store.py`:

```python
log = logging.getLogger(__name__)  # add `import logging` if the module has no logger


def _migrate_indicator_params(conn: sqlite3.Connection) -> None:
    # Indicator alerts move to the series-registry shape ({type, config,
    # output}); see core/alert_kinds.upgrade_params. A row that cannot be
    # upgraded is left as is and logged, never dropped.
    from auto_trader.core.alert_kinds import upgrade_params

    rows = conn.execute("SELECT user_id, id, params FROM alerts WHERE kind = 'indicator'").fetchall()
    for user_id, alert_id, raw in rows:
        try:
            new = upgrade_params(json.loads(raw))
        except (KeyError, TypeError, ValueError, IndexError):
            log.warning("alert %s: indicator params could not be upgraded", alert_id, exc_info=True)
            continue
        conn.execute(
            "UPDATE alerts SET params = ? WHERE user_id = ? AND id = ?", (json.dumps(new), user_id, alert_id)
        )
```

and register it: `run_migrations(conn, {1: _migrate_triggered_alert_json, 2: _migrate_indicator_params})`. The function-local import avoids a store-to-kinds import at module load; keep it local.

- [ ] **Step 4: Upgrade on read for history**

In `api/alert_hooks.py` `_rearm`, before `ALERT_STORE.create`:

```python
    if row.get("kind") == "indicator":
        row = {**row, "params": upgrade_params(row["params"])}
```

(import `upgrade_params` from `auto_trader.core.alert_kinds`). In `api/routers/alerts.py` `get_triggered`, after parsing `e["alert"]`:

```python
        a = e["alert"]
        if isinstance(a, dict) and a.get("kind") == "indicator" and isinstance(a.get("params"), dict):
            try:
                a["params"] = upgrade_params(a["params"])
                a["label"] = INDICATOR.label(a["params"])
            except (KeyError, TypeError, ValueError):
                pass
```

Add a test to `backend/tests/test_alerts_api.py` that inserts a triggered entry whose `alert_json` holds an old-shape indicator row (use the existing triggered-entry helper in that file, or `ALERT_STORE.add_triggered` as the other tests there do) and asserts `GET /api/alerts/triggered` returns `alert.params.type == "RSI"` and a non-empty `alert.label`.

- [ ] **Step 5: Run the tests**

Run: `cd backend && .venv/bin/python -m pytest tests/test_alert_registry_migration.py tests/test_alert_store.py tests/test_alerts_api.py -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/auto_trader/core/alert_store.py backend/auto_trader/api/alert_hooks.py \
  backend/auto_trader/api/routers/alerts.py backend/tests/test_alert_registry_migration.py backend/tests/test_alerts_api.py
git commit -m "feat(alerts): migrate stored indicator alerts to the registry shape"
```

---

### Task 5: Hub one-off values

**Files:**
- Modify: `backend/auto_trader/core/alert_indicators.py` (new `peek`)
- Modify: `backend/auto_trader/core/alert_engine.py` (new `peek_values`)
- Test: `backend/tests/test_alert_indicators.py`

**Interfaces:**
- Produces: `IndicatorHub.peek(key: SeriesKey, inds: list[IndicatorKey]) -> dict[IndicatorKey, float | None]` (async) and `AlertEngine.peek_values(user_id: str, broker: str, epic: str, timeframe: str, inds: list[IndicatorKey]) -> dict[IndicatorKey, float | None]` (async; `{}` when the engine has no hub).

- [ ] **Step 1: Write the failing tests**

Add to `test_alert_indicators.py` (it already defines `H`, `KEY`, `c()`, `FakeLoader`, `make()` and imports `Sample`; Task 3 converted its `SMA3`/`SMA5` keys):

```python
from auto_trader.core.alert_kinds import upgrade_params
from auto_trader.indicators.alert_series import key_of

RSI3 = key_of(upgrade_params({"indicator": "RSI", "calcParams": [3], "config": {"source": "close"},
                              "line": "value", "timeframe": "HOUR"}))


def test_peek_cold_series_loads_once_and_registers_nothing():
    async def main():
        now = [20 * H + 1]
        hub, loader, _ = make([c(i * H, float(i % 4)) for i in range(0, 20)], now)
        out = await hub.peek(KEY, [RSI3])
        assert isinstance(out[RSI3], float)
        assert len(loader.calls) == 1
        assert not hub.has_feed(KEY[0], KEY[1])

    asyncio.run(main())


def test_peek_reads_a_ready_live_series():
    async def main():
        now = [20 * H + 1]
        hub, loader, _ = make([c(i * H, float(i % 4)) for i in range(0, 20)], now)
        hub.set_needs({KEY: {RSI3}})
        await hub.on_sample(KEY[0], KEY[1], Sample(now[0], 10.0, None, None))
        await hub.settle()
        assert hub.ready(KEY, RSI3)
        calls = len(loader.calls)
        out = await hub.peek(KEY, [RSI3])
        assert out[RSI3] == hub.values(KEY, RSI3, intrabar=False)["value"]
        assert len(loader.calls) == calls  # no extra load

    asyncio.run(main())


def test_peek_failed_load_returns_none():
    async def main():
        now = [20 * H + 1]
        hub, loader, _ = make([c(i * H, float(i)) for i in range(0, 20)], now)
        loader.degraded = True
        assert await hub.peek(KEY, [RSI3]) == {RSI3: None}

    asyncio.run(main())
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd backend && .venv/bin/python -m pytest tests/test_alert_indicators.py -q -k peek`
Expected: FAIL with `AttributeError: 'IndicatorHub' object has no attribute 'peek'`.

- [ ] **Step 3: Implement `peek`**

In `IndicatorHub` (reads section):

```python
    async def peek(self, key: SeriesKey, inds: list[IndicatorKey]) -> dict[IndicatorKey, float | None]:
        """Each key's latest closed `value`, for the alert dialog's prefill:
        from the live series when it is ready, else a one-off load of the
        same seed this hub would use (nothing registered)."""
        out: dict[IndicatorKey, float | None] = {}
        cold: list[IndicatorKey] = []
        for ind in inds:
            if self.ready(key, ind):
                out[ind] = self._states[key].closed_vals[ind].get("value")
            else:
                cold.append(ind)
        if not cold:
            return out
        scratch = _State(BarSeries(key[2], key[3], cap=SEED_CAP))
        bars = await self._load(key, scratch, SEED_CAP)
        if bars is None:
            return {**out, **{ind: None for ind in cold}}
        closed = scratch.series.keep_closed(bars, self._now_ms())
        loop = asyncio.get_running_loop()
        for ind in cold:
            try:
                vals = await loop.run_in_executor(_OFF_LOOP_POOL, compute, ind, closed) if heavy(ind) else compute(ind, closed)
            except Exception:
                log.warning("alert indicator peek failed for %s", key, exc_info=True)
                out[ind] = None
                continue
            series = vals.get("value") or []
            out[ind] = series[-1] if series else None
        return out
```

In `AlertEngine`:

```python
    async def peek_values(
        self, user_id: str, broker: str, epic: str, timeframe: str, inds: list[IndicatorKey],
    ) -> dict[IndicatorKey, float | None]:
        if self._hub is None:
            return {}
        return await self._hub.peek((broker, epic, timeframe, self.price_side_for(user_id)), inds)
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && .venv/bin/python -m pytest tests/test_alert_indicators.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/core/alert_indicators.py backend/auto_trader/core/alert_engine.py backend/tests/test_alert_indicators.py
git commit -m "feat(alerts): one-off indicator values from the alert hub"
```

---

### Task 6: API: describe, alertable types, labels, patch semantics

**Files:**
- Modify: `backend/auto_trader/api/routers/alerts.py`
- Modify: `backend/auto_trader/api/schemas.py` (if request bodies live there; else define in the router like the existing bodies)
- Modify: `backend/scripts/alert_probe.py:76-86`
- Modify: `CLAUDE.md` (## Alerts)
- Test: `backend/tests/test_alerts_api.py`

**Interfaces:**
- Consumes: `INDICATOR.refusal_for`, `ALERT_SPECS`, `ALERT_ENGINE.peek_values`, `key_of`.
- Produces:
  - `GET /api/alerts/indicators` -> `{"types": [sorted alertable registry types]}`.
  - `POST /api/alerts/describe` body `{broker, epic, timeframe, instance?: {type, calcParams, extendData}, alertId?: str}` -> `{type, timeframe, outputs: [{name, label, kind, priceScale, priceOnly}], lastValues: {name: float | null}, needsVolume: bool, refusal: str | null}`. 404 when `alertId` is unknown; 422 when neither is given or `instance.type` is not alertable.
  - Indicator rows in `GET /api/alerts`, `POST` and `PATCH` responses carry a top-level `label`.
  - PATCH no longer deep-merges `params.config`; `params.instance` replaces the stored pane whole.

- [ ] **Step 1: Write the failing tests**

Add to `test_alerts_api.py` (reuse its client fixture and `_body` helpers; build new-shape bodies with `params={"instance": {...}, "output": ..., ...}`):

```python
def test_alertable_types(client):
    r = client.get("/api/alerts/indicators")
    assert r.status_code == 200
    assert {"MA", "EMA", "RSI", "ATR", "TRENDLINES", "SR_LEVELS"} <= set(r.json()["types"])


def test_describe_lists_outputs_and_refusal(client):
    r = client.post("/api/alerts/describe", json={
        "broker": "b", "epic": "E", "timeframe": "HOUR",
        "instance": {"type": "RSI", "calcParams": [14], "extendData": {}},
    })
    assert r.status_code == 200
    d = r.json()
    assert d["type"] == "RSI" and d["timeframe"] == "HOUR" and d["refusal"] is None
    by = {o["name"]: o for o in d["outputs"]}
    assert by["value"] == {"name": "value", "label": "RSI 14", "kind": "level", "priceScale": False, "priceOnly": False}
    assert by["bullDiv"]["kind"] == "event"
    assert isinstance(d["lastValues"], dict)


def test_describe_follows_the_pin_and_refuses_seconds(client):
    pinned = client.post("/api/alerts/describe", json={
        "broker": "b", "epic": "E", "timeframe": "HOUR",
        "instance": {"type": "MA", "calcParams": [20], "extendData": {"mtf": {"timeframe": "DAY"}}},
    }).json()
    assert pinned["timeframe"] == "DAY"
    secs = client.post("/api/alerts/describe", json={
        "broker": "b", "epic": "E", "timeframe": "SECOND_30",
        "instance": {"type": "RSI", "calcParams": [14], "extendData": {}},
    }).json()
    assert secs["refusal"] == "Alerts on this timeframe are coming later"


def test_describe_unknown_type_422(client):
    r = client.post("/api/alerts/describe", json={
        "broker": "b", "epic": "E", "timeframe": "HOUR",
        "instance": {"type": "BOLL", "calcParams": [20], "extendData": {}},
    })
    assert r.status_code == 422


def test_list_and_create_carry_label(client):
    saved = client.post("/api/alerts", json=_rsi_body()).json()   # define _rsi_body with the new shape
    assert saved["label"] == "RSI 14 (1H)"
    rows = client.get("/api/alerts").json()["alerts"]
    assert next(r for r in rows if r["id"] == saved["id"])["label"] == "RSI 14 (1H)"


def test_patch_instance_replaces_the_pane(client):
    saved = client.post("/api/alerts", json=_rsi_body(ext={"source": "hl2"})).json()
    r = client.patch(f"/api/alerts/{saved['id']}", json={"params": {"instance": {
        "type": "RSI", "calcParams": [21], "extendData": {}}}})
    assert r.status_code == 200
    assert r.json()["params"]["config"]["length"] == 21
    assert r.json()["params"]["config"]["source"] == "close"


def test_patch_same_instance_keeps_sig(client):
    body = _rsi_body()
    saved = client.post("/api/alerts", json=body).json()
    r = client.patch(f"/api/alerts/{saved['id']}", json={"params": {"instance": body["params"]["instance"]}})
    assert r.status_code == 200
    assert INDICATOR.sig(r.json()["params"]) == INDICATOR.sig(saved["params"])


def test_patch_onto_a_missing_output_422(client):
    saved = client.post("/api/alerts", json=_ma_body(ext={"smoothing": {"type": "ema", "length": 5}},
                                                       output="smoothingMa")).json()
    r = client.patch(f"/api/alerts/{saved['id']}", json={"params": {"instance": {
        "type": "MA", "calcParams": [20], "extendData": {}}}})
    assert r.status_code == 422
```

Define `_rsi_body(ext=None)` and `_ma_body(ext=None, output="ma")` next to the existing `_body` helpers, returning a full create body with `params={"instance": {...}, "output": ..., "timeframe": "HOUR", "target": "value" (RSI) / "price" (MA), "value": 70 (RSI) / None (MA), "evalOn": "close", "condition": "crossing", "trigger": "once", "link": None}`.

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd backend && .venv/bin/python -m pytest tests/test_alerts_api.py -q`
Expected: the new tests FAIL (404 on `/api/alerts/indicators` and `/describe`, no `label`).

- [ ] **Step 3: Implement**

In `api/routers/alerts.py`:

```python
from auto_trader.core.alert_kinds import INDICATOR, upgrade_params
from auto_trader.indicators.alert_series import IndicatorKey, config_json, config_of
from auto_trader.indicators.alert_specs import ALERT_SPECS
from auto_trader.indicators.registry import SERIES_INDICATORS


def _decorate(row: dict) -> dict:
    if row.get("kind") == "indicator":
        try:
            row["label"] = INDICATOR.label(row["params"])
        except (KeyError, TypeError, ValueError):
            pass
    return row


class DescribeBody(BaseModel):
    broker: str
    epic: str
    timeframe: str
    instance: dict[str, Any] | None = None
    alertId: str | None = None


@router.get("/api/alerts/indicators")
async def alertable_indicators() -> dict[str, Any]:
    return {"types": sorted(ALERT_SPECS)}


@router.post("/api/alerts/describe")
async def describe_alert(request: Request, body: DescribeBody) -> dict[str, Any]:
    user = current_user(request)
    if body.alertId is not None:
        rows = await ALERT_STORE.list_user(user)
        row = next((r for r in rows if r["id"] == body.alertId and r.get("kind") == "indicator"), None)
        if row is None:
            raise HTTPException(404, f"alert not found: {body.alertId}")
        p = upgrade_params(row["params"])
        type_ = p["type"]
        cfg = config_of(type_, json.dumps(p["config"], sort_keys=True, allow_nan=False))
        timeframe = p["timeframe"]
    elif body.instance is not None:
        type_ = body.instance.get("type")
        if type_ not in ALERT_SPECS:
            raise HTTPException(422, f"{type_!r} is not alertable")
        cfg = SERIES_INDICATORS[type_].parse_config(body.instance.get("calcParams"), body.instance.get("extendData"))
        timeframe = SERIES_INDICATORS[type_].timeframe(cfg) or body.timeframe
    else:
        raise HTTPException(422, "instance or alertId is required")
    alert = ALERT_SPECS[type_]
    refusal = INDICATOR.refusal_for(type_, cfg, timeframe)
    outs = alert.outputs(cfg)
    last: dict[str, float | None] = {}
    if refusal is None:
        try:
            canon = _tf.canonicalize(timeframe)
            keys = {name: IndicatorKey(type_, config_json(cfg), name, resolution_seconds(canon) / 3600.0) for name in outs}
            got = await ALERT_ENGINE.peek_values(user, body.broker, body.epic, canon, list(keys.values()))
            last = {name: got.get(k) for name, k in keys.items()}
            timeframe = canon
        except Exception:  # a prefill is best effort; the dialog still opens
            log.warning("describe: values failed for %s %s", body.broker, body.epic, exc_info=True)
    return {
        "type": type_,
        "timeframe": timeframe,
        "outputs": [
            {"name": n, "label": alert.label(cfg, n), "kind": o.kind, "priceScale": o.price_scale, "priceOnly": o.price_only}
            for n, o in outs.items()
        ],
        "lastValues": last,
        "needsVolume": alert.needs_volume(cfg),
        "refusal": refusal,
    }
```

Use the module's existing imports for `_tf` (`auto_trader.core.timeframe`), `resolution_seconds`, `log` and `json` (add any that are missing). Register the two new routes ABOVE `@router.patch("/api/alerts/{alert_id}")` and `@router.delete(...)` so the path parameter route cannot shadow them.

Wrap the return value of `list_alerts` rows, `create_alert` and `patch_alert` with `_decorate(...)`.

In `patch_alert`, delete the whole `config` deep-merge block (from the comment "`config` is itself a nested dict" through `merged["config"] = {...}`). A PATCH carrying `params.instance` now replaces the pane: `validate` consumes `instance`, overwriting `type` and `config`.

- [ ] **Step 4: Update the probe**

In `backend/scripts/alert_probe.py` replace the indicator params dict with:

```python
                "params": {
                    "instance": {"type": "MA", "calcParams": [2], "extendData": {"maType": "sma"}},
                    "output": "ma", "timeframe": "MINUTE", "target": "value", "value": -1e12,
                    "condition": "greater", "trigger": "once", "evalOn": "intrabar", "link": None,
                },
```

`target: "value"` on an MA output is allowed (only `price_only` outputs refuse a value target). Keep the print line as is.

- [ ] **Step 5: Update CLAUDE.md**

In the `## Alerts` section, replace the paragraph starting "Alert kinds live in `core/alert_kinds.py`" up to "Probe an indicator alert with `python3 -m scripts.alert_probe --indicator`." with:

```
Alert kinds live in `core/alert_kinds.py` (`price_level`, `indicator`,
`line`): each validates its params and resolves a `(subject, level)` pair;
`core/alert_eval.py` is the one evaluator. Indicator alerts run on the
backtest series registry: params are `{type, config, output}` where `config`
is the registry's parsed config as JSON (`indicators/alert_series.py`), and
`indicators/alert_specs.py` says which outputs of each type are alertable
(level or 0/1 event, price axis or not), the label and the refusals. Create
and patch take the raw pane as `params.instance` and the server parses it;
old `{indicator, calcParams, config}` params are upgraded by
`alert_kinds.upgrade_params` (store migration 2, re-arm, triggered history).
The frontend mirrors none of this: `GET /api/alerts/indicators` lists the
alertable types and `POST /api/alerts/describe` returns a pane's outputs,
labels, refusal and current values from the alert hub. Event outputs are
stored as a close-mode cross up through 0.5. "Every" alerts fire at most once
per bar of their timeframe. Probe an indicator alert with
`python3 -m scripts.alert_probe --indicator`.
```

and in the Trendlines paragraph replace "Nearest-line alerts are `indicator` alerts on `TRENDLINES` with the canonical 33-slot calcParams;" with "Nearest-line alerts are `indicator` alerts on `TRENDLINES`, output `tl_nearest` (the only alertable Trendlines output);".

- [ ] **Step 6: Run the tests**

Run: `cd backend && .venv/bin/python -m pytest tests/test_alerts_api.py tests/test_alert_kinds.py -q`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/auto_trader/api/routers/alerts.py backend/scripts/alert_probe.py backend/tests/test_alerts_api.py CLAUDE.md
# plus backend/auto_trader/api/schemas.py if you put DescribeBody there
git commit -m "feat(alerts): describe endpoint, alertable types and labels for indicator alerts"
```

---

### Task 7: Frontend alert data layer

**Files:**
- Create: `frontend/src/lib/indicatorAlertInstance.ts`
- Create: `frontend/src/lib/indicatorAlertInstance.test.ts`
- Modify: `frontend/src/lib/alertsApi.ts` (types, row mapping, wire params, labels, describe/types/repoint)
- Modify: `frontend/src/lib/alertsApi.test.ts`

**Interfaces:**
- Produces (`indicatorAlertInstance.ts`): `interface AlertInstance { type: string; calcParams: number[]; extendData: Record<string, unknown> }`, `alertInstanceOf(type: string, calcParams: unknown[] | undefined, extendData: unknown): AlertInstance`, `alertTimeframeOf(ext: Record<string, unknown> | undefined, resolution: string): string` (moved verbatim from `alertableIndicators.ts`), `chartValueOf(row: Record<string, number | undefined> | undefined, output: string): number | undefined`, `loadAlertableTypes(): Promise<void>`, `isAlertableType(type: string): boolean`.
- Produces (`alertsApi.ts`): `IndicatorAlertParams = { type: string; config: Record<string, unknown>; output: string; timeframe: string; target: AlertTarget; value: number | null; evalOn: EvalOn; link: {scope, instanceId} | null; instance?: AlertInstance }`; `IndicatorAlert.label?: string`; `interface DescribedOutput { name: string; label: string; kind: "level" | "event"; priceScale: boolean; priceOnly: boolean }`; `interface AlertDescription { type: string; timeframe: string; outputs: DescribedOutput[]; lastValues: Record<string, number | null>; needsVolume: boolean; refusal: string | null }`; `describeIndicatorAlert(body: { broker: string; epic: string; timeframe: string; instance?: AlertInstance; alertId?: string }): Promise<AlertDescription | null>`; `repointIndicatorAlert(id: string, instance: AlertInstance): Promise<"ok" | "refused" | "failed">`.

- [ ] **Step 1: Write the failing tests**

`frontend/src/lib/indicatorAlertInstance.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { alertInstanceOf, alertTimeframeOf, chartValueOf } from "./indicatorAlertInstance";

describe("alertInstanceOf", () => {
  it("keeps only the pin of an mtf block", () => {
    const ext = { maType: "ema", mtf: { timeframe: "HOUR_4", htfSeries: [1, 2, 3], htfStarts: [1, 2, 3] } };
    expect(alertInstanceOf("EMA", [20], ext)).toEqual({
      type: "EMA", calcParams: [20], extendData: { maType: "ema", mtf: { timeframe: "HOUR_4" } },
    });
  });
  it("drops an mtf block with no pin and never mutates the pane", () => {
    const ext = { mtf: { htfSeries: [1] } };
    expect(alertInstanceOf("RSI", undefined, ext)).toEqual({ type: "RSI", calcParams: [], extendData: {} });
    expect(ext).toEqual({ mtf: { htfSeries: [1] } });
  });
});

describe("alertTimeframeOf", () => {
  it("prefers the pin", () => {
    expect(alertTimeframeOf({ mtf: { timeframe: "HOUR_4" } }, "MINUTE_5")).toBe("HOUR_4");
    expect(alertTimeframeOf({}, "MINUTE_5")).toBe("MINUTE_5");
  });
});

describe("chartValueOf", () => {
  it("reads the output name or its camelCase result key", () => {
    expect(chartValueOf({ ma: 5 }, "ma")).toBe(5);
    expect(chartValueOf({ bullTop: 7 }, "bull_top")).toBe(7);
    expect(chartValueOf({ ma: NaN }, "ma")).toBeUndefined();
    expect(chartValueOf(undefined, "ma")).toBeUndefined();
  });
});
```

If `alertTimeframeOf`'s canonical form for "HOUR_4" differs (it runs `tryCanonicalTf`), assert whatever `tryCanonicalTf("HOUR_4")` returns.

In `alertsApi.test.ts`, convert every indicator-alert fixture from `params: { identity: {...}, line: "value", ... }` to `params: { type, config, output, ... }` (for example `type: "RSI", config: { length: 14, source: "close" }, output: "value"`), and add:

```ts
it("maps a server row's label and new params", () => {
  // feed a GET /api/alerts response through the same path the existing row-mapping tests use
  // with row { kind: "indicator", label: "RSI 14 (1H)", params: { type: "RSI", config: {...}, output: "value", ... } }
  // and assert loadAllIndicatorAlerts()[0].label === "RSI 14 (1H)" and .params.output === "value"
});
it("alertLabel uses the server label", () => {
  // alertLabel({ ...an indicator alert, label: "RSI 14 (1H)", params: { target: "value", value: 70, ... } }, 2)
  // contains "RSI 14 (1H)"
});
it("repointIndicatorAlert reports a 422 as refused without a toast", async () => {
  // mock apiFetch to return { ok: false, status: 422, json: async () => ({ detail: "x" }) }
  // expect(await repointIndicatorAlert(id, instance)).toBe("refused") and no toast call
});
```

Write those three bodies against the mocks `alertsApi.test.ts` already sets up (read its top first); each must assert the values named in its comment.

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd frontend && npx vitest run src/lib/indicatorAlertInstance.test.ts src/lib/alertsApi.test.ts`
Expected: FAIL (module not found; label/params mismatches).

- [ ] **Step 3: Implement `indicatorAlertInstance.ts`**

```ts
// The pane an indicator alert watches, as the backend wants it: the type,
// calcParams and extendData verbatim, minus the chart's runtime caches. The
// backend's registry parser decides everything else (outputs, labels,
// refusals); this module mirrors none of it.
import { apiFetch, url } from "./api";
import { tryCanonicalTf } from "./timeframe";

export interface AlertInstance {
  type: string;
  calcParams: number[];
  extendData: Record<string, unknown>;
}

/** The pane payload: an mtf block shrinks to its pin (`htfSeries` and the
 * other per-bar arrays are chart caches, not settings). Never mutates. */
export function alertInstanceOf(type: string, calcParams: unknown[] | undefined, extendData: unknown): AlertInstance {
  const ext: Record<string, unknown> = { ...((extendData ?? {}) as Record<string, unknown>) };
  const mtf = ext.mtf as { timeframe?: unknown } | undefined;
  if (mtf && typeof mtf === "object") {
    if (typeof mtf.timeframe === "string" && mtf.timeframe) ext.mtf = { timeframe: mtf.timeframe };
    else delete ext.mtf;
  }
  return { type, calcParams: (calcParams ?? []).map(Number), extendData: ext };
}

/** The timeframe an alert on this pane watches: its pin when it has one
 * (canonical form), else the chart's resolution. */
export function alertTimeframeOf(ext: Record<string, unknown> | undefined, resolution: string): string {
  const pin = (ext?.mtf as { timeframe?: string } | undefined)?.timeframe;
  return (pin && tryCanonicalTf(pin)) || resolution;
}

/** A pane's plotted value for a registry output name: result rows key most
 * outputs by the same name, a few by its camelCase form (FVG `bull_top`). */
export function chartValueOf(row: Record<string, number | undefined> | undefined, output: string): number | undefined {
  if (!row) return undefined;
  const v = row[output] ?? row[output.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase())];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

let alertable: ReadonlySet<string> | null = null;
let inflight: Promise<void> | null = null;

/** The registry types an alert may watch (GET /api/alerts/indicators), once. */
export function loadAlertableTypes(): Promise<void> {
  if (alertable || inflight) return inflight ?? Promise.resolve();
  inflight = (async () => {
    try {
      const res = await apiFetch(url("/api/alerts/indicators", true));
      if (res.ok) alertable = new Set(((await res.json()) as { types: string[] }).types);
    } catch {
      /* retried by the next call */
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export const isAlertableType = (type: string): boolean => alertable?.has(type) ?? false;
```

Use the same `apiFetch`/`url` import paths `alertsApi.ts` uses (read its imports; adjust these two import lines to match).

- [ ] **Step 4: Update `alertsApi.ts`**

1. Replace `import { ALERTABLE, type IndicatorIdentity, indicatorAlertLabel } from "./alertableIndicators";` with `import { loadAlertableTypes, type AlertInstance } from "./indicatorAlertInstance";`.
2. Replace `IndicatorAlertParams` with the shape in this task's Interfaces block, and add `label?: string;` to `IndicatorAlert`.
3. `rowToIndicatorAlert`: set `label: (row as { label?: string }).label` and
   ```ts
   params: {
     type: p.type as string,
     config: (p.config as Record<string, unknown>) ?? {},
     output: p.output as string,
     timeframe: p.timeframe as string,
     target: p.target as AlertTarget,
     value: (p.value as number | null) ?? null,
     evalOn: p.evalOn as EvalOn,
     link: (p.link as IndicatorAlertParams["link"]) ?? null,
   },
   ```
4. `indicatorWireParams` becomes:
   ```ts
   function indicatorWireParams(a: { condition: AlertCondition; trigger: AlertTrigger; params: IndicatorAlertParams }) {
     return { ...a.params, condition: a.condition, trigger: a.trigger };
   }
   ```
5. Delete `rowToIndicatorAlertLabel`; in `triggeredRowToClient` use `label: row.alert?.label ?? (row.alert?.params && row.kind === "line" ? lineAlertLabel(row.alert.params.timeframe as string) : undefined)` (keep the existing line branch exactly; add `label?: string` to the `alert` type of `TriggeredRow`).
6. `alertLabel`: `const what = a.label ?? a.params.output;`.
7. `addIndicatorAlert`: after `if (res?.ok)`, replace `return true` with
   ```ts
   if (res?.ok) {
     try {
       indicatorCache.set(a.id, rowToIndicatorAlert((await res.json()) as AlertRow));
       bumpAlerts();
     } catch { /* keep the optimistic row */ }
     return true;
   }
   ```
   and drop `instance` from the cached optimistic row (`const { instance: _i, ...stored } = a.params;` before `indicatorCache.set`), keeping it in the wire body.
8. In `resyncAlerts` (the function that GETs `/api/alerts`), add `void loadAlertableTypes();` at its start.
9. Add:
   ```ts
   export interface DescribedOutput { name: string; label: string; kind: "level" | "event"; priceScale: boolean; priceOnly: boolean }
   export interface AlertDescription {
     type: string; timeframe: string; outputs: DescribedOutput[];
     lastValues: Record<string, number | null>; needsVolume: boolean; refusal: string | null;
   }

   export async function describeIndicatorAlert(body: {
     broker: string; epic: string; timeframe: string; instance?: AlertInstance; alertId?: string;
   }): Promise<AlertDescription | null> {
     const res = await sendJson("/api/alerts/describe", "POST", body);
     if (!res?.ok) return null;
     try { return (await res.json()) as AlertDescription; } catch { return null; }
   }

   /** Point an alert at the pane's current settings. "refused": the server
    * says these settings can't be alerted on (the caller asks delete or keep). */
   export async function repointIndicatorAlert(id: string, instance: AlertInstance): Promise<"ok" | "refused" | "failed"> {
     const res = await sendJson(`/api/alerts/${encodeURIComponent(id)}`, "PATCH", { params: { instance } });
     if (res?.ok) {
       try {
         indicatorCache.set(id, rowToIndicatorAlert((await res.json()) as AlertRow));
         bumpAlerts();
       } catch { /* the next resync fixes the cache */ }
       return "ok";
     }
     if (res?.status === 422) return "refused";
     await reportFailure(res, "Alert update failed");
     return "failed";
   }
   ```
   Use the real row type name `rowToIndicatorAlert` takes (named `AlertRow` here).

- [ ] **Step 5: Run the tests and the typecheck**

Run: `cd frontend && npx vitest run src/lib/indicatorAlertInstance.test.ts src/lib/alertsApi.test.ts`
Expected: PASS. `npx tsc -b` will still fail in files Tasks 8 and 9 change (modal, draft, sync, paint); that is expected here. Confirm the remaining errors are only in: `IndicatorAlertModal.tsx`, `chart/indicatorAlertDraft.ts`, `chart/useIndicatorCommands.ts`, `chart/useChartPaint.ts`, `lib/indicatorAlertSync.ts`, `lib/signals.ts`, `lib/overlays/indicatorAlerts.ts`, `chart/lineAlertDraft.ts`, `IndicatorSettings.tsx`, `agent/actions/indicators.ts` and their tests.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/indicatorAlertInstance.ts frontend/src/lib/indicatorAlertInstance.test.ts \
  frontend/src/lib/alertsApi.ts frontend/src/lib/alertsApi.test.ts
git commit -m "feat(alerts): frontend indicator-alert data layer on the registry shape"
```

---

### Task 8: Alert modal and its entry points

**Files:**
- Modify: `frontend/src/lib/signals.ts:66-75` (`IndicatorAlertDraft`)
- Modify: `frontend/src/chart/indicatorAlertDraft.ts` (whole file)
- Modify: `frontend/src/chart/indicatorAlertDraft.test.ts`
- Modify: `frontend/src/chart/useIndicatorCommands.ts:646-670, 699-706`
- Modify: `frontend/src/IndicatorAlertModal.tsx` (whole `Body`)
- Modify: `frontend/src/IndicatorAlertModal.test.tsx`

**Interfaces:**
- Consumes: `alertInstanceOf`, `alertTimeframeOf`, `isAlertableType` (Task 7), `describeIndicatorAlert`, `addIndicatorAlert`, `patchIndicatorAlert`.
- Produces: `IndicatorAlertDraft = { epic; broker; precision; instance: AlertInstance; chartTimeframe: string; link: {scope, instanceId}; quoteOnly: boolean }`; `buildIndicatorAlertDraft(args) -> { draft: IndicatorAlertDraft } | null`.

- [ ] **Step 1: Rewrite the modal tests**

Replace `frontend/src/IndicatorAlertModal.test.tsx` with tests that mock `describeIndicatorAlert` (add it to the `vi.hoisted` block and the `vi.mock("./lib/alertsApi", ...)` override next to `addIndicatorAlert`), resolving to a description, then `await screen.findBy...` for the async render:

```tsx
const RSI_DESC = {
  type: "RSI", timeframe: "HOUR", needsVolume: false, refusal: null,
  outputs: [
    { name: "value", label: "RSI 14", kind: "level", priceScale: false, priceOnly: false },
    { name: "bullDiv", label: "RSI 14 bullish divergence", kind: "event", priceScale: false, priceOnly: false },
  ],
  lastValues: { value: 55.5, bullDiv: 0 },
};
const MA_DESC = {
  type: "MA", timeframe: "HOUR", needsVolume: false, refusal: null,
  outputs: [{ name: "ma", label: "SMA 20", kind: "level", priceScale: true, priceOnly: false }],
  lastValues: { ma: 101.5 },
};
const draft = (over = {}) => ({
  epic: "US100", broker: "b", precision: 2, chartTimeframe: "HOUR",
  instance: { type: "RSI", calcParams: [14], extendData: {} },
  link: { scope: "s", instanceId: "RSI" }, quoteOnly: false, ...over,
});
```

Tests (each renders `<IndicatorAlertModal request={{ mode: "create", draft: draft() }} ... />` unless stated):
1. "prefills the value from the server once described": `describe` -> `RSI_DESC`; `expect(await screen.findByDisplayValue("55.5"))`; the `.al-subject` text is `"Indicator"`; `screen.queryByLabelText("Compare")` is null.
2. "offers a Line picker when the pane has several outputs": `screen.getByLabelText("Line")` exists with options "RSI 14" and "RSI 14 bullish divergence".
3. "an event output reads as a sentence with no value": change "Line" to `bullDiv`; `screen.getByText("happens")` exists; `screen.queryByLabelText("Alert value")` is null; "As it happens" radio is disabled; Create sends `params` matching `{ output: "bullDiv", target: "value", value: 0.5, evalOn: "close" }` and `condition: "crossing_up"`.
4. "price-scale outputs show Compare defaulting to Price": `describe` -> `MA_DESC`, draft instance MA; `(await screen.findByLabelText("Compare")).value` is `"price"`; `screen.getByText("the curve")`.
5. "a refusal disables Create and says why": `describe` -> `{ ...RSI_DESC, refusal: "Alerts on this timeframe are coming later" }`; the text shows; Create button is disabled.
6. "creates with the instance and the described timeframe": Create sends `params` matching `{ instance: draft().instance, output: "value", timeframe: "HOUR", target: "value", value: 55.5, evalOn: "close" }`.
7. "edit mode describes by alert id and patches without an instance": `loadAll` returns one alert `{ kind: "indicator", id: "al-1", label: "RSI 14 (1H)", params: { type: "RSI", config: {}, output: "value", timeframe: "HOUR", target: "value", value: 70, evalOn: "close", link: null }, ... }`; `describe` is called with `{ alertId: "al-1", ... }`; Save calls `patch("al-1", expect.objectContaining({ params: expect.not.objectContaining({ instance: expect.anything() }) }))`.
8. Keep the three message tests (untyped message saved empty; default text not baked in; custom message kept), adapted to await the describe.

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd frontend && npx vitest run src/IndicatorAlertModal.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Update the draft type and builder**

`signals.ts`:

```ts
export interface IndicatorAlertDraft {
  epic: string;
  broker: string;
  precision: number;
  instance: AlertInstance;
  /** The pane's pin, else the chart's resolution (alertTimeframeOf). */
  chartTimeframe: string;
  link: { scope: string; instanceId: string };
  quoteOnly: boolean;
}
```

(`import type { AlertInstance } from "./indicatorAlertInstance";`, drop the `IndicatorIdentity` import.)

`chart/indicatorAlertDraft.ts`:

```ts
// Turns a live chart indicator into an alert draft, or null to hide the
// entry. Shared by the legend bell and the indicator menu. Whether the pane's
// settings can be alerted on is the server's call (POST /api/alerts/describe,
// shown in the dialog), not this file's.
import type { Chart } from "klinecharts";
import { alertInstanceOf, alertTimeframeOf, isAlertableType } from "../lib/indicatorAlertInstance";
import { getIndicator } from "../lib/indicators";
import { indTypeOf } from "../lib/indicators/shared";
import { parseTf } from "../lib/timeframe";
import type { IndicatorAlertDraft } from "../lib/signals";

export function buildIndicatorAlertDraft(args: {
  chart: Chart; paneId: string; name: string; scope: string; epic: string; broker: string;
  precision: number; resolution: string; quoteOnly: boolean;
}): { draft: IndicatorAlertDraft } | null {
  const ind = getIndicator(args.chart, args.paneId, args.name);
  if (!ind) return null;
  const type = indTypeOf(ind);
  if (!isAlertableType(type)) return null;
  try {
    if (parseTf(args.resolution).unit === "SECOND") return null;
  } catch {
    return null;
  }
  const ext = ind.extendData as Record<string, unknown> | undefined;
  return {
    draft: {
      epic: args.epic, broker: args.broker, precision: args.precision,
      instance: alertInstanceOf(type, ind.calcParams as unknown[], ext),
      chartTimeframe: alertTimeframeOf(ext, args.resolution),
      link: { scope: args.scope, instanceId: args.name }, quoteOnly: args.quoteOnly,
    },
  };
}
```

Rewrite `chart/indicatorAlertDraft.test.ts` to pin: hidden (null) for a type not in the alertable set (stub the set by mocking `../lib/indicatorAlertInstance`'s `isAlertableType`), hidden on a seconds chart, and a draft carrying the stripped instance and the pin's timeframe for a pinned pane.

`chart/useIndicatorCommands.ts`: `legendAlertCheck` returns `r === null ? null : { reason: null }`, and the menu item block becomes:

```ts
        ...((): MenuItem[] => {
          const r = alertDraftFor(paneId, name);
          return r === null
            ? []
            : [{ label: "Add alert", icon: MenuIcons.bell, onClick: () => indicatorAlertRequest.set({ mode: "create", draft: r.draft }) }];
        })(),
```

- [ ] **Step 4: Rewrite the modal body**

`IndicatorAlertModal.tsx`: `IndicatorAlertModal` keeps its edit/create split but passes `{ epic, broker, precision, quoteOnly, link, timeframe, instance? , alertId? }`:

```tsx
  const base = isEdit
    ? {
        epic: existing!.epic, broker: existing!.broker, precision: existing!.precision,
        timeframe: existing!.params.timeframe, link: existing!.params.link,
        quoteOnly: !supportsStreaming(existing!.broker), alertId: existing!.id, instance: undefined,
      }
    : { ...request.draft, timeframe: request.draft.chartTimeframe, alertId: undefined };
```

`Body` (replace the old one; keep the footer and the `AlertCommonFields` usage exactly as they are today):

```tsx
function Body({ base, existing, isEdit, defaults, now, onClose }: {
  base: {
    epic: string; broker: string; precision: number; timeframe: string;
    link: IndicatorAlert["params"]["link"]; quoteOnly: boolean;
    instance: AlertInstance | undefined; alertId: string | undefined;
  };
  existing?: IndicatorAlert; isEdit: boolean; defaults: AlertDefaults; now: number; onClose: () => void;
}) {
  const common = useAlertCommonState(existing, defaults, now, isEdit);
  const [desc, setDesc] = useState<AlertDescription | null>(null);
  const [output, setOutput] = useState<string | null>(existing?.params.output ?? null);
  const [target, setTarget] = useState<AlertTarget | null>(existing?.params.target ?? null);
  const [condition, setCondition] = useState<AlertCondition>(existing?.condition ?? defaults.condition);
  const [value, setValue] = useState(existing?.params.value != null ? String(existing.params.value) : "");
  const [typed, setTyped] = useState(existing != null);
  const [evalOn, setEvalOn] = useState<EvalOn>(existing?.params.evalOn ?? "close");

  useEffect(() => {
    let live = true;
    void describeIndicatorAlert({
      broker: base.broker, epic: base.epic, timeframe: base.timeframe,
      ...(base.alertId ? { alertId: base.alertId } : { instance: base.instance }),
    }).then((d) => { if (live) setDesc(d); });
    return () => { live = false; };
  }, [base.broker, base.epic, base.timeframe, base.alertId, base.instance]);

  const out = desc?.outputs.find((o) => o.name === output) ?? desc?.outputs[0] ?? null;
  const event = out?.kind === "event";
  const tgt: AlertTarget = event ? "value" : out?.priceOnly ? "price" : target ?? (out?.priceScale ? "price" : "value");
  useEffect(() => {
    // Prefill from the server's value for this output until the user types.
    if (!out || typed || tgt !== "value" || event) return;
    const v = desc?.lastValues[out.name];
    setValue(v != null ? fmtIndicatorValue(v) : "");
  }, [desc, out, typed, tgt, event]);

  const intrabarBlocked = event || (desc?.needsVolume === true && base.quoteOnly);
  const label = out ? `${out.label} (${tfLabel(desc!.timeframe)})` : "";
  const num = Number(value);
  const valid = desc != null && desc.refusal == null && out != null
    && (event || tgt === "price" || (value.trim() !== "" && Number.isFinite(num)));
  const levelText = tgt === "value" && !event && valid ? fmtIndicatorValue(num) : "";
  const autoMsg = `${base.epic} ${event ? `${label} happens` : conditionPhrase(label, condition, tgt, levelText)}`;

  async function save() {
    if (!valid || !out || !desc) return;
    const params = {
      output: out.name, timeframe: desc.timeframe, target: tgt,
      value: event ? 0.5 : tgt === "value" ? num : null,
      evalOn: event ? ("close" as const) : evalOn, link: base.link,
    };
    const msg = common.message.trim();
    const fields = {
      condition: event ? ("crossing_up" as const) : condition, trigger: common.trigger,
      message: msg === autoMsg ? "" : msg, expiresAt: common.expiresAt, notify: common.notify,
    };
    const ok = isEdit
      ? await patchIndicatorAlert(existing!.id, { ...fields, params })
      : await addIndicatorAlert({
          kind: "indicator", id: newId(), epic: base.epic, broker: base.broker, precision: base.precision,
          createdAt: Date.now(), label,
          params: { ...params, type: desc.type, config: {}, instance: base.instance }, ...fields,
        });
    if (ok) onClose();
  }
  // ... return (FloatingModal) below
}
```

The JSX inside `alert-body` (keep footer, title and `AlertCommonFields` as today; pass `autoMsg` wherever the old code passed it):

```tsx
        <div className="al-field">
          <span>Indicator</span>
          <strong>{label || "..."}</strong>
        </div>
        {desc?.refusal && (
          <div className="al-field">
            <span />
            <span className="al-refusal">{desc.refusal}</span>
          </div>
        )}
        {desc && desc.outputs.length > 1 && (
          <div className="al-field">
            <span>Line</span>
            <select className="al-operator" aria-label="Line" value={out?.name}
              onChange={(e) => {
                setOutput(e.target.value); setTarget(null); setTyped(false);
                if (desc.outputs.find((o) => o.name === e.target.value)?.kind === "event") setEvalOn("close");
              }}>
              {desc.outputs.map((o) => <option key={o.name} value={o.name}>{o.label}</option>)}
            </select>
          </div>
        )}
        {out?.priceOnly && (
          <div className="al-field">
            <span>History</span>
            <span>Uses the last 2000 bars</span>
          </div>
        )}
        {out && (
          <div className="al-field">
            <span>Condition</span>
            <div className="al-cond al-sentence">
              {event ? (
                <>
                  <span className="al-subject">{out.label}</span>
                  <span className="al-subject">happens</span>
                </>
              ) : (
                <>
                  {out.priceScale && !out.priceOnly ? (
                    <select className="al-operator" aria-label="Compare" value={tgt}
                      onChange={(e) => setTarget(e.target.value as AlertTarget)}>
                      <option value="price">Price</option>
                      <option value="value">Indicator</option>
                    </select>
                  ) : (
                    <span className="al-subject">{out.priceOnly ? "Price" : "Indicator"}</span>
                  )}
                  <select className="al-operator" aria-label="Alert condition" value={condition}
                    onChange={(e) => setCondition(e.target.value as AlertCondition)}>
                    {CONDITIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                  {tgt === "value" ? (
                    <input className="al-value" type="number" step="any" aria-label="Alert value"
                      value={value} onChange={(e) => { setValue(e.target.value); setTyped(true); }} autoFocus />
                  ) : (
                    <span className="al-subject">the curve</span>
                  )}
                </>
              )}
            </div>
          </div>
        )}
```

Keep the existing Evaluate radio row exactly as it is, with its `disabled` driven by `intrabarBlocked`. Imports: drop `indicatorAlertLabel, volumeWeighted`; add `describeIndicatorAlert, type AlertDescription` from `./lib/alertsApi`, `type AlertInstance` from `./lib/indicatorAlertInstance`, and `tfLabel` from `./lib/timeframe`. Add `.al-refusal { color: var(--muted); }` to `App.css` next to the other `.al-` rules if no muted-text class fits; reuse an existing one if it does.

- [ ] **Step 5: Run the tests**

Run: `cd frontend && npx vitest run src/IndicatorAlertModal.test.tsx src/chart/indicatorAlertDraft.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/signals.ts frontend/src/chart/indicatorAlertDraft.ts frontend/src/chart/indicatorAlertDraft.test.ts \
  frontend/src/chart/useIndicatorCommands.ts frontend/src/IndicatorAlertModal.tsx frontend/src/IndicatorAlertModal.test.tsx
# plus frontend/src/App.css if you added .al-refusal
git commit -m "feat(alerts): indicator alert dialog built from the server's describe"
```

---

### Task 9: Settings sync, chart surfaces, and removing the frontend mirror

**Files:**
- Modify: `frontend/src/lib/indicatorAlertSync.ts`, `frontend/src/lib/indicatorAlertSync.test.ts`
- Modify: `frontend/src/IndicatorSettings.tsx:116, 1944-1948`
- Modify: `frontend/src/agent/actions/indicators.ts:21, 197-199`, `frontend/src/agent/actions/indicators.test.ts`
- Modify: `frontend/src/chart/useChartPaint.ts:45, 840-851`
- Modify: `frontend/src/lib/overlays/indicatorAlerts.ts:12`, `frontend/src/chart/lineAlertDraft.ts:3`
- Delete: `frontend/src/lib/alertableIndicators.ts`, `frontend/src/lib/alertableIndicators.test.ts`, `frontend/src/lib/alertableParity.test.ts`, `backend/tests/fixtures/indicator_parity/alertable.json`
- Modify: any remaining test that builds an indicator alert in the old shape (find them in Step 5)

**Interfaces:**
- Consumes: `repointIndicatorAlert`, `alertInstanceOf`, `alertTimeframeOf`, `chartValueOf`.
- Produces: `syncAlertsAfterEdit(scope: string, instanceId: string, instance: AlertInstance): Promise<void>`. `planSync` is deleted.

- [ ] **Step 1: Rewrite the sync tests**

In `indicatorAlertSync.test.ts`, drop the `planSync` tests and add (mock `repointIndicatorAlert`, `linkedAlerts` and `requestConfirm` the way the file already mocks `patchIndicatorAlert`/`requestConfirm`):

```ts
it("re-points every linked alert to the pane's new settings", async () => {
  linked.mockReturnValue([alertA, alertB]);
  repoint.mockResolvedValue("ok");
  await syncAlertsAfterEdit("s", "RSI", INSTANCE);
  expect(repoint).toHaveBeenCalledWith(alertA.id, INSTANCE);
  expect(repoint).toHaveBeenCalledWith(alertB.id, INSTANCE);
  expect(confirm).not.toHaveBeenCalled();
});
it("asks delete or keep for the alerts the server refused", async () => {
  linked.mockReturnValue([alertA, alertB]);
  repoint.mockImplementation(async (id: string) => (id === alertB.id ? "refused" : "ok"));
  await syncAlertsAfterEdit("s", "RSI", INSTANCE);
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(confirm.mock.calls[0][0].message).toContain("1 alert");
});
it("a failed request is not treated as a refusal", async () => {
  linked.mockReturnValue([alertA]);
  repoint.mockResolvedValue("failed");
  await syncAlertsAfterEdit("s", "RSI", INSTANCE);
  expect(confirm).not.toHaveBeenCalled();
});
```

(`INSTANCE = { type: "RSI", calcParams: [21], extendData: {} }`; `alertA`/`alertB` are new-shape `IndicatorAlert`s.)

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd frontend && npx vitest run src/lib/indicatorAlertSync.test.ts`
Expected: FAIL.

- [ ] **Step 3: Rewrite `syncAlertsAfterEdit`**

In `indicatorAlertSync.ts` delete `sameIdentity` and `planSync`, drop the `alertableIndicators` and `supportsStreaming` imports, import `repointIndicatorAlert` from `./alertsApi` and `type AlertInstance` from `./indicatorAlertInstance`, and replace `syncAlertsAfterEdit` with:

```ts
// Each linked alert is re-pointed at the pane's new settings; the server
// re-validates every one against its own timeframe and refuses the ones the
// new settings can't serve (an output that no longer exists, a volume line
// intrabar on a quote-only broker), and those get the delete-or-keep prompt.
// Line alerts are frozen: linkedAlerts returns indicator alerts only.
export async function syncAlertsAfterEdit(scope: string, instanceId: string, instance: AlertInstance): Promise<void> {
  const alerts = linkedAlerts(scope, instanceId);
  if (alerts.length === 0) return;
  const results = await Promise.all(alerts.map(async (a) => ({ a, r: await repointIndicatorAlert(a.id, instance) })));
  const conflicted = results.filter((x) => x.r === "refused").map((x) => x.a);
  if (conflicted.length === 0) return;
  requestConfirm({
    title: "Indicator alerts",
    message: `These settings can't be alerted on. Delete its ${plural(conflicted.length)}, or keep ${pronoun(conflicted.length)} on the old settings?`,
    confirmLabel: "Delete",
    cancelLabel: "Keep",
    onConfirm: () => conflicted.forEach((a) => deleteIndicatorAlert(a.id)),
    onCancel: () => unlink(conflicted),
  });
}
```

- [ ] **Step 4: Update the callers and chart surfaces**

- `IndicatorSettings.tsx`: drop the `checkAlertable` import; import `alertInstanceOf` from `./lib/indicatorAlertInstance`; the call becomes `void syncAlertsAfterEdit(scope, name, alertInstanceOf(type, cfg.calcParams, cfg.extendData));` and the comment above it says each linked alert is re-validated by the server on its own timeframe.
- `agent/actions/indicators.ts`: same swap; `void syncAlertsAfterEdit(scope, id, alertInstanceOf(type, finalCalcParams, ext));`. Update `agent/actions/indicators.test.ts` assertions that expected the old `checkFor` callback to expect the instance argument.
- `chart/useChartPaint.ts`: import `alertTimeframeOf, chartValueOf` from `../lib/indicatorAlertInstance` (drop the `alertableIndicators` import) and replace the value read with `const v = chartValueOf(res[res.length - 1], p.output);` then `if (v == null) continue;`.
- `lib/overlays/indicatorAlerts.ts` and `chart/lineAlertDraft.ts`: import `alertTimeframeOf` from the new module.

- [ ] **Step 5: Delete the mirror and fix every remaining reference**

```bash
git rm frontend/src/lib/alertableIndicators.ts frontend/src/lib/alertableIndicators.test.ts \
  frontend/src/lib/alertableParity.test.ts backend/tests/fixtures/indicator_parity/alertable.json
cd frontend && grep -rln "alertableIndicators\|IndicatorIdentity\b\|params.identity\|identity: {" src | grep -v templateSignatures
```

For every file the grep lists (expect `AlertsSidebar.test.tsx`, `mobile/MobileAlertsView.test.tsx`, `lib/overlays/indicatorAlerts.test.ts`, `lib/indicators.test.ts`, and possibly `components/PresetsTab.test.tsx`, `lib/strategyOverlays.test.ts`, `lib/renameInstance.test.ts`, `lib/indicators/trendlines.test.ts`, `lib/indicators/hiddenCalc.test.ts`): if it builds an indicator alert, convert `params: { identity: {...}, line: "value", ... }` to `params: { type, config: {}, output, ... }` and add `label` where a test asserts displayed text. `templates.ts`/`templateSignatures.ts` have an unrelated `IndicatorIdentity`; leave them alone.

- [ ] **Step 6: Run the tests, typecheck and lint**

Run: `cd frontend && npx vitest run src/lib/indicatorAlertSync.test.ts src/agent/actions/indicators.test.ts src/AlertsSidebar.test.tsx src/mobile/MobileAlertsView.test.tsx src/lib/overlays/indicatorAlerts.test.ts src/lib/indicators.test.ts <every other file you touched in Step 5>`
Expected: PASS.

Run: `cd frontend && npx tsc -b`
Expected: no errors.

Run: `cd frontend && npx eslint <every frontend file changed in Tasks 7 to 9>`
Expected: no errors.

Run: `cd backend && .venv/bin/python -m pytest tests/test_indicator_parity.py tests/test_alert_registry_migration.py -q`
Expected: PASS (nothing reads `alertable.json` any more).

- [ ] **Step 7: Check it in the browser**

Ask the user before starting servers if none are running (`lsof -i :5173 -i :8000`). With the app open on a chart: add an RSI pane and open "Add alert" from its legend bell. Confirm the dialog shows "RSI 14 (1H)", a Line picker with the divergence outputs, a prefilled value, and that picking "RSI 14 bullish divergence" reads "... happens" with "As it happens" disabled. Create one; it appears in the alerts panel with the server label. Repeat on an SR levels pane (price-scale output: Compare shows Price, "the curve"). Edit the RSI length in settings; the alert's label follows. Turn MA smoothing off on an MA whose alert watches its smoothing line; the delete-or-keep prompt appears. Do not drive these gestures through Playwright (it is the user's real Chrome); ask the user to click through, or report that the browser check is pending.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/indicatorAlertSync.ts frontend/src/lib/indicatorAlertSync.test.ts \
  frontend/src/IndicatorSettings.tsx frontend/src/agent/actions/indicators.ts frontend/src/agent/actions/indicators.test.ts \
  frontend/src/chart/useChartPaint.ts frontend/src/lib/overlays/indicatorAlerts.ts frontend/src/chart/lineAlertDraft.ts \
  <every test file converted in Step 5>
git commit -m "feat(alerts): indicator alerts follow their pane through the server; drop the frontend mirror"
```
