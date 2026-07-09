# Coded Strategies (Python) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user write strategies as Python files (`backend/strategies/*.py`) that run through the existing backtest engine AND the live evaluate path, with an ad-hoc indicator API (`ctx.ema(9)`) that matches the chart's TS indicator math exactly.

**Architecture:** A new Python indicator layer (`backend/auto_trader/indicators/`) ports the exact formulas from the frontend's TS (`mtf.ts`, `atr.ts`, `rsi.ts`, `vwap.ts`), verified by a golden-master fixture generated FROM the TS code. A `CodedStrategy(Strategy)` adapter loads a user `.py` file (discovered from `backend/strategies/`), builds a `StrategyContext` per bar (memoized indicator cache, netted-position gating), and translates user `Action`s into the existing `Signal` shape — so `BacktestEngine` and `/api/strategy/evaluate` consume it unchanged. The frontend gains a `Rules | Strategy` switch in the backtest panel plus a strategy picker (dropdown, description, read-only source).

**Tech Stack:** Python 3.12 / FastAPI / pydantic v2 / pytest (backend, run via `uv run`), React 19 + TypeScript / vitest (frontend). numpy added as a backend dependency for the ctx history arrays only — indicator internals are plain loops mirroring the TS for bit-parity.

**Spec:** `docs/superpowers/specs/2026-07-09-coded-strategies-design.md`

## Global Constraints

- Work directly on `main` (no branches — user rule).
- No backward-compat/migration code (single user, no old data).
- No third-party TA library (TA-Lib, pandas-ta): indicator formulas are ported verbatim from the frontend TS; the TS file is the spec (see spec §"No third-party TA library").
- FP parity: port TS arithmetic **operation-for-operation** (e.g. the SMA's running add/subtract accumulator, NOT `sum(window)/n`) — both runtimes are IEEE-754 float64, so identical operation order gives identical bits.
- Stateless strategies: no cross-bar user state; everything derives from ctx (spec Trap 1).
- Netted by construction: entries suppressed while any side is held; exits suppressed when the side is flat. `meta["hedged"] = True` opts out and marks the strategy backtest-only (spec Trap 2).
- Memoized indicators: each (indicator, params) series is computed once per run and indexed per bar — no O(n²) (spec Trap 3).
- Backend tests: `cd backend && uv run pytest tests/<file> -v`. Frontend tests: `cd frontend && npx vitest run <file>`.
- Commit after every task, message style matching the repo (`feat(...)`, `test(...)`, etc.).
- Frontend UI: shared `Tooltip`/`InfoTip` components, no native `title=`, no shadows, light theme first, plain concise copy for educated traders.

---

## Phase 1 — Python indicator layer + parity suite

### Task 1: Golden-master fixture generated from the TS indicators

**Files:**
- Create: `frontend/src/lib/indicatorParityGolden.test.ts`
- Create (generated, committed): `backend/tests/fixtures/indicator_golden.json`

**Interfaces:**
- Produces: `backend/tests/fixtures/indicator_golden.json` with shape
  `{ "candles": [{time,open,high,low,close,volume}...  (time = unix SECONDS)],
     "anchorMs": <number>,
     "series": { "EMA_9": [...], "EMA_21": [...], "SMA_14": [...], "RSI_14": [...], "ATR_14": [...], "VOLMA_20": [...], "VOL": [...], "AVWAP": [...] } }`
  where each series array is `number | null`, same length as candles.
- Regeneration mechanism: re-running this vitest test rewrites the fixture (deterministic — seeded PRNG, no Date.now).

- [ ] **Step 1: Write the generator test**

This test both *generates* and *sanity-checks* the fixture. It is deterministic (seeded LCG), so re-running it always produces the identical file.

```typescript
// frontend/src/lib/indicatorParityGolden.test.ts
//
// Golden-master generator for the Python indicator parity suite. Runs the SAME
// TS functions the chart/backtest use (maSeries, computeRsi, atrSeries,
// vwapFrom) over a deterministic synthetic candle set and writes the results to
// backend/tests/fixtures/indicator_golden.json. The Python side
// (backend/tests/test_indicator_parity.py) must reproduce every value exactly.
// Re-run this test to regenerate the fixture after changing TS indicator math.
import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { KLineData } from "klinecharts";
import { maSeries, sma } from "./mtf";
import { atrSeries } from "./atr";
import { computeRsi } from "./indicators/rsi";
import { vwapFrom } from "./indicators/vwap";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../../../backend/tests/fixtures/indicator_golden.json");

/** Deterministic LCG (Numerical Recipes constants) — NO Math.random/Date.now. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function makeCandles(n: number): KLineData[] {
  const rnd = lcg(42);
  const out: KLineData[] = [];
  let close = 100;
  const startMs = 1700000000000; // fixed epoch, hourly bars
  for (let i = 0; i < n; i++) {
    const open = close;
    const drift = (rnd() - 0.5) * 2; // ±1
    close = Math.max(1, open + drift);
    const high = Math.max(open, close) + rnd() * 0.5;
    const low = Math.min(open, close) - rnd() * 0.5;
    // First 3 bars volume 0 to exercise the AVWAP cumV<=0 blank path.
    const volume = i < 3 ? 0 : Math.floor(rnd() * 1000) + 1;
    out.push({ timestamp: startMs + i * 3600_000, open, high, low, close, volume });
  }
  return out;
}

const toNull = (a: Array<number | undefined | null>) => a.map((v) => (v == null ? null : v));

describe("indicator parity golden fixture", () => {
  it("generates the fixture the Python suite verifies against", () => {
    const candles = makeCandles(500);
    const anchorMs = candles[50].timestamp;
    // AVWAP: mirror backtestSeries.computeRaw — first bar at/after anchor.
    const idx = candles.findIndex((k) => k.timestamp >= anchorMs);
    const start = idx < 0 ? candles.length : idx;

    const series: Record<string, Array<number | null>> = {
      EMA_9: toNull(maSeries(candles, "ema", 9, {}).base),
      EMA_21: toNull(maSeries(candles, "ema", 21, {}).base),
      SMA_14: toNull(maSeries(candles, "sma", 14, {}).base),
      RSI_14: toNull(computeRsi(candles, 14, {}).map((p) => p.val ?? null)),
      ATR_14: toNull(atrSeries(candles, 14)),
      VOLMA_20: toNull(sma(candles.map((k) => k.volume ?? 0), 20)),
      VOL: toNull(candles.map((k) => k.volume ?? null)),
      AVWAP: toNull(vwapFrom(candles, start, {}).map((p) => p.vwap ?? null)),
    };

    const fixture = {
      candles: candles.map((k) => ({
        time: Math.round(k.timestamp / 1000),
        open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume ?? 0,
      })),
      anchorMs,
      series,
    };

    for (const [name, arr] of Object.entries(series)) {
      expect(arr, name).toHaveLength(candles.length);
    }
    // Sanity: RSI in [0,100] wherever defined; ATR positive.
    for (const v of series.RSI_14) if (v !== null) expect(v).toBeGreaterThanOrEqual(0);
    for (const v of series.ATR_14) if (v !== null) expect(v).toBeGreaterThan(0);

    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(fixture));
  });
});
```

- [ ] **Step 2: Run it — generates the fixture**

Run: `cd frontend && npx vitest run src/lib/indicatorParityGolden.test.ts`
Expected: PASS, and `backend/tests/fixtures/indicator_golden.json` now exists (verify with `ls -la ../backend/tests/fixtures/`).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/indicatorParityGolden.test.ts backend/tests/fixtures/indicator_golden.json
git commit -m "test(parity): golden-master fixture generated from the TS indicators"
```

---

### Task 2: Python indicator layer (base timeframe)

**Files:**
- Create: `backend/auto_trader/indicators/__init__.py`
- Create: `backend/auto_trader/indicators/core.py`
- Test: `backend/tests/test_indicator_parity.py`
- Modify: `backend/pyproject.toml` (add numpy dependency)

**Interfaces:**
- Produces (all in `auto_trader.indicators.core`; every function returns `list[float | None]` of the same length as its input):
  - `ema_series(values: Sequence[float], length: int) -> list[float | None]`
  - `sma_series(values: Sequence[float], length: int) -> list[float | None]`
  - `rsi_series(values: Sequence[float], length: int) -> list[float | None]`
  - `atr_series(candles: Sequence[Candle], length: int) -> list[float | None]`
  - `avwap_series(candles: Sequence[Candle], anchor_ms: int) -> list[float | None]`
  - `hlc3(candle: Candle) -> float`
- Consumed by: Task 5 (`StrategyContext`), Task 16 (MTF).

- [ ] **Step 1: Add numpy to backend deps**

In `backend/pyproject.toml`, `dependencies` list, add after `"metaapi-cloud-sdk>=29.1.1",`:

```toml
    "numpy>=2.0",
```

Run: `cd backend && uv sync --extra dev`
Expected: numpy installs.

- [ ] **Step 2: Write the failing parity test**

```python
# backend/tests/test_indicator_parity.py
"""Golden-master parity: the Python indicator layer must reproduce the TS
indicator math (frontend/src/lib/{mtf.ts,atr.ts,indicators/rsi.ts,indicators/vwap.ts})
exactly. The fixture is generated by frontend/src/lib/indicatorParityGolden.test.ts
— regenerate it there whenever the TS math changes."""

import json
import math
from datetime import datetime, timezone
from pathlib import Path

import pytest

from auto_trader.core.models import Candle
from auto_trader.indicators.core import (
    atr_series,
    avwap_series,
    ema_series,
    rsi_series,
    sma_series,
)

FIXTURE = Path(__file__).parent / "fixtures" / "indicator_golden.json"


@pytest.fixture(scope="module")
def golden():
    data = json.loads(FIXTURE.read_text())
    candles = [
        Candle(
            time=datetime.fromtimestamp(c["time"], tz=timezone.utc),
            open=c["open"], high=c["high"], low=c["low"], close=c["close"],
            volume=c["volume"],
        )
        for c in data["candles"]
    ]
    return candles, data["anchorMs"], data["series"]


def assert_series_equal(actual, expected, name):
    assert len(actual) == len(expected), f"{name}: length {len(actual)} != {len(expected)}"
    for i, (a, e) in enumerate(zip(actual, expected)):
        if e is None:
            assert a is None, f"{name}[{i}]: expected None, got {a}"
        else:
            assert a is not None, f"{name}[{i}]: expected {e}, got None"
            # Same float64 ops in the same order -> effectively identical;
            # rel=1e-12 only absorbs the JSON round-trip.
            assert a == pytest.approx(e, rel=1e-12, abs=1e-12), f"{name}[{i}]"


def test_ema(golden):
    candles, _, series = golden
    closes = [c.close for c in candles]
    assert_series_equal(ema_series(closes, 9), series["EMA_9"], "EMA_9")
    assert_series_equal(ema_series(closes, 21), series["EMA_21"], "EMA_21")


def test_sma(golden):
    candles, _, series = golden
    closes = [c.close for c in candles]
    assert_series_equal(sma_series(closes, 14), series["SMA_14"], "SMA_14")


def test_rsi(golden):
    candles, _, series = golden
    closes = [c.close for c in candles]
    assert_series_equal(rsi_series(closes, 14), series["RSI_14"], "RSI_14")


def test_atr(golden):
    candles, _, series = golden
    assert_series_equal(atr_series(candles, 14), series["ATR_14"], "ATR_14")


def test_volma(golden):
    candles, _, series = golden
    vols = [c.volume for c in candles]
    assert_series_equal(sma_series(vols, 20), series["VOLMA_20"], "VOLMA_20")


def test_avwap(golden):
    candles, anchor_ms, series = golden
    assert_series_equal(avwap_series(candles, anchor_ms), series["AVWAP"], "AVWAP")


def test_avwap_unplaced_anchor_is_blank(golden):
    candles, _, _ = golden
    assert avwap_series(candles, 0) == [None] * len(candles)
    # Anchor past the last bar -> all blank too.
    last_ms = int(candles[-1].time.timestamp() * 1000)
    assert avwap_series(candles, last_ms + 1) == [None] * len(candles)


def test_edge_cases():
    assert ema_series([], 9) == []
    assert sma_series([1.0, 2.0], 0) == [None, None]
    assert rsi_series([1.0] * 5, 14) == [None] * 5  # n <= period -> all None
    assert atr_series([], 14) == []
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd backend && uv run pytest tests/test_indicator_parity.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'auto_trader.indicators'`

- [ ] **Step 4: Implement the indicator layer**

```python
# backend/auto_trader/indicators/__init__.py
```
(empty file)

```python
# backend/auto_trader/indicators/core.py
"""Base-timeframe indicator math, ported operation-for-operation from the
frontend TS so `ctx.ema(9)` in a coded strategy equals the EMA drawn on the
chart. Sources of truth:

  ema/sma  -> frontend/src/lib/mtf.ts (ema, sma)
  rsi      -> frontend/src/lib/indicators/rsi.ts (computeRsi, Wilder, SMA seed)
  atr      -> frontend/src/lib/atr.ts (Wilder's ATR)
  avwap    -> frontend/src/lib/indicators/vwap.ts (vwapFrom, hlc3 source) with
              the anchor rule of backtestSeries.ts computeRaw (first bar at/after
              the epoch-ms anchor; anchor <= 0 or past the last bar => blank)

Do NOT "improve" the arithmetic (e.g. replace the SMA's running accumulator with
sum(window)/n): both runtimes are IEEE-754 float64, and identical operation
order is what makes the parity suite exact. Every function returns a list the
same length as its input, None where the TS emits undefined. Values at index i
depend only on inputs [0..i] — no lookahead by construction."""

from __future__ import annotations

from collections.abc import Sequence

from auto_trader.core.models import Candle


def hlc3(c: Candle) -> float:
    """The chart AVWAP's default price source (priceOf(k, "hlc3"))."""
    return (c.high + c.low + c.close) / 3


def ema_series(values: Sequence[float], length: int) -> list[float | None]:
    """mtf.ts `ema`: first value seeds, k = 2/(length+1). Defined from bar 0."""
    out: list[float | None] = [None] * len(values)
    if length < 1:
        return out
    k = 2 / (length + 1)
    prev: float | None = None
    for i, v in enumerate(values):
        prev = v if prev is None else v * k + prev * (1 - k)
        out[i] = prev
    return out


def sma_series(values: Sequence[float], length: int) -> list[float | None]:
    """mtf.ts `sma`: running add/subtract accumulator (kept for FP parity)."""
    out: list[float | None] = [None] * len(values)
    if length < 1:
        return out
    s = 0.0
    for i, v in enumerate(values):
        s += v
        if i >= length:
            s -= values[i - length]
        if i >= length - 1:
            out[i] = s / length
    return out


def rsi_series(values: Sequence[float], length: int) -> list[float | None]:
    """rsi.ts `computeRsi` value line: Wilder's RMA of gains/losses, seeded with
    the SMA of the first `period` changes (TradingView ta.rsi). None until bar
    index `period`; avg_loss == 0 -> 100."""
    n = len(values)
    out: list[float | None] = [None] * n
    period = max(1, int(length) or 14)
    if n <= period:
        return out
    avg_gain = 0.0
    avg_loss = 0.0
    for i in range(1, n):
        change = values[i] - values[i - 1]
        gain = change if change > 0 else 0.0
        loss = -change if change < 0 else 0.0
        if i <= period:
            avg_gain += gain
            avg_loss += loss
            if i == period:
                avg_gain /= period
                avg_loss /= period
                out[i] = 100.0 if avg_loss == 0 else 100 - 100 / (1 + avg_gain / avg_loss)
        else:
            avg_gain = (avg_gain * (period - 1) + gain) / period
            avg_loss = (avg_loss * (period - 1) + loss) / period
            out[i] = 100.0 if avg_loss == 0 else 100 - 100 / (1 + avg_gain / avg_loss)
    return out


def atr_series(candles: Sequence[Candle], length: int) -> list[float | None]:
    """atr.ts: TR[0] = high-low; first ATR = mean of first `length` TRs at index
    length-1; then Wilder-smoothed."""
    n = len(candles)
    out: list[float | None] = [None] * n
    if length < 1 or n == 0:
        return out
    tr = [0.0] * n
    for i, k in enumerate(candles):
        hl = k.high - k.low
        if i == 0:
            tr[i] = hl
        else:
            pc = candles[i - 1].close
            tr[i] = max(hl, abs(k.high - pc), abs(k.low - pc))
    if n < length:
        return out
    s = 0.0
    for i in range(length):
        s += tr[i]
    atr = s / length
    out[length - 1] = atr
    for i in range(length, n):
        atr = (atr * (length - 1) + tr[i]) / length
        out[i] = atr
    return out


def avwap_series(candles: Sequence[Candle], anchor_ms: int) -> list[float | None]:
    """vwap.ts `vwapFrom` main line (hlc3 source), anchored per backtestSeries's
    computeRaw: accumulate from the first bar whose open time (epoch-ms) is at or
    after `anchor_ms`; anchor <= 0 means unplaced (all None); zero cumulative
    volume emits None (many CFD/forex epics report volume 0)."""
    n = len(candles)
    out: list[float | None] = [None] * n
    if anchor_ms <= 0:
        return out
    start = n
    for i, c in enumerate(candles):
        if int(c.time.timestamp() * 1000) >= anchor_ms:
            start = i
            break
    cum_pv = 0.0
    cum_v = 0.0
    for i in range(start, n):
        c = candles[i]
        price = hlc3(c)
        vol = c.volume
        cum_pv += price * vol
        cum_v += vol
        if cum_v <= 0:
            continue
        out[i] = cum_pv / cum_v
    return out
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd backend && uv run pytest tests/test_indicator_parity.py -v`
Expected: PASS (8 tests)

- [ ] **Step 6: Commit**

```bash
git add backend/auto_trader/indicators backend/tests/test_indicator_parity.py backend/pyproject.toml backend/uv.lock
git commit -m "feat(indicators): Python indicator layer with golden-master TS parity"
```

---

## Phase 2 — Loader, ctx, CodedStrategy, backtest wiring

### Task 3: Strategy file discovery + loader

**Files:**
- Create: `backend/auto_trader/strategy/loader.py`
- Create: `backend/strategies/ema_cross.py` (example strategy, also used by tests)
- Test: `backend/tests/test_strategy_loader.py`

**Interfaces:**
- Produces (`auto_trader.strategy.loader`):
  - `STRATEGIES_DIR: Path` — `backend/strategies/`
  - `@dataclass StrategyInfo: filename: str; name: str; description: str; hedged: bool; error: str | None`
  - `class StrategyLoadError(Exception)` — message includes filename + cause
  - `list_strategies(directory: Path | None = None) -> list[StrategyInfo]` — never raises; per-file errors land in `info.error`
  - `load_strategy(filename: str, directory: Path | None = None) -> ModuleType` — fresh exec every call (the user edits files between runs); raises `StrategyLoadError` on bad filename / syntax error / missing `on_bar`
- A strategy module exposes: `on_bar(ctx)` (required), optional module docstring, optional `meta: dict` with `name`, `description`, `hedged` keys. Description precedence: `meta["description"]` → module docstring → `""`.

- [ ] **Step 1: Write the example strategy file**

```python
# backend/strategies/ema_cross.py
"""EMA(9)/EMA(21) crossover with an RSI(14) < 70 filter. Longs only.
Attaches a 2% stop and 4% target; exits early when RSI tops 70."""

meta = {"name": "EMA Cross + RSI"}


def on_bar(ctx):
    if ctx.position.is_flat and ctx.ema(9) is not None and ctx.ema(21) is not None:
        if ctx.ema(9) > ctx.ema(21) and (ctx.rsi(14) or 0) < 70:
            return [ctx.buy(
                sl=ctx.close * 0.98, tp=ctx.close * 1.04,
                reason="EMA9>EMA21 & RSI<70",
                note={"ema9": ctx.ema(9), "ema21": ctx.ema(21), "rsi": ctx.rsi(14)},
            )]
    if ctx.position.is_long and (ctx.rsi(14) or 0) > 70:
        return [ctx.close_long(reason="RSI>70")]
    return []
```

- [ ] **Step 2: Write the failing loader test**

```python
# backend/tests/test_strategy_loader.py
"""Discovery + loading of user strategy files (backend/strategies/*.py)."""

from pathlib import Path

import pytest

from auto_trader.strategy.loader import (
    STRATEGIES_DIR,
    StrategyLoadError,
    list_strategies,
    load_strategy,
)


def write(tmp_path: Path, name: str, body: str) -> Path:
    p = tmp_path / name
    p.write_text(body)
    return p


GOOD = '''"""Docstring description."""
meta = {"name": "My Strat"}
def on_bar(ctx):
    return []
'''

HEDGED = '''meta = {"name": "Hedger", "description": "meta wins", "hedged": True}
def on_bar(ctx):
    return []
'''

BROKEN = "def on_bar(ctx:\n"  # syntax error

NO_ON_BAR = '"""Has no on_bar."""\nx = 1\n'


def test_list_strategies(tmp_path):
    write(tmp_path, "good.py", GOOD)
    write(tmp_path, "hedged.py", HEDGED)
    write(tmp_path, "broken.py", BROKEN)
    write(tmp_path, "no_on_bar.py", NO_ON_BAR)
    infos = {i.filename: i for i in list_strategies(tmp_path)}
    assert set(infos) == {"good.py", "hedged.py", "broken.py", "no_on_bar.py"}

    good = infos["good.py"]
    assert good.name == "My Strat"
    assert good.description == "Docstring description."  # docstring fallback
    assert good.hedged is False and good.error is None

    hedged = infos["hedged.py"]
    assert hedged.description == "meta wins"  # meta beats docstring
    assert hedged.hedged is True

    assert infos["broken.py"].error is not None  # syntax error captured, not raised
    assert "on_bar" in (infos["no_on_bar.py"].error or "")


def test_list_missing_dir_is_empty(tmp_path):
    assert list_strategies(tmp_path / "nope") == []


def test_load_strategy(tmp_path):
    write(tmp_path, "good.py", GOOD)
    mod = load_strategy("good.py", tmp_path)
    assert callable(mod.on_bar)
    # Fresh exec each call: two loads are distinct module objects.
    assert load_strategy("good.py", tmp_path) is not mod


def test_load_rejects_bad_names(tmp_path):
    write(tmp_path, "good.py", GOOD)
    for bad in ("../evil.py", "good", "missing.py"):
        with pytest.raises(StrategyLoadError):
            load_strategy(bad, tmp_path)


def test_load_syntax_error_raises(tmp_path):
    write(tmp_path, "broken.py", BROKEN)
    with pytest.raises(StrategyLoadError, match="broken.py"):
        load_strategy("broken.py", tmp_path)


def test_default_dir_has_the_example():
    assert STRATEGIES_DIR.name == "strategies"
    names = [i.filename for i in list_strategies()]
    assert "ema_cross.py" in names
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd backend && uv run pytest tests/test_strategy_loader.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'auto_trader.strategy.loader'`

- [ ] **Step 4: Implement the loader**

```python
# backend/auto_trader/strategy/loader.py
"""Discovery + loading of user-coded strategy files.

Strategies are plain .py files in backend/strategies/, edited in the user's own
IDE — the app only discovers, describes, and loads them. Loading is a fresh
exec every time (the file changes between runs); nothing is cached, matching
the stateless-strategy contract (state on the module would die between live
bars anyway). No sandboxing: this is a single-user local tool and the files
carry the same trust as the rest of the backend."""

from __future__ import annotations

import importlib.util
import traceback
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType

# backend/auto_trader/strategy/loader.py -> backend/strategies/
STRATEGIES_DIR = Path(__file__).resolve().parents[2] / "strategies"


class StrategyLoadError(Exception):
    """A strategy file failed to load (bad name, syntax error, no on_bar)."""


@dataclass(frozen=True, slots=True)
class StrategyInfo:
    filename: str
    name: str
    description: str
    hedged: bool
    error: str | None = None


def _describe(module: ModuleType, filename: str) -> StrategyInfo:
    meta = getattr(module, "meta", None)
    meta = meta if isinstance(meta, dict) else {}
    doc = (module.__doc__ or "").strip()
    return StrategyInfo(
        filename=filename,
        name=str(meta.get("name") or Path(filename).stem),
        description=str(meta.get("description") or doc),
        hedged=bool(meta.get("hedged", False)),
    )


def load_strategy(filename: str, directory: Path | None = None) -> ModuleType:
    """Load `filename` from the strategies dir, fresh each call. The filename
    must be a plain `*.py` basename (no path separators — the API exposes these
    names verbatim, so reject traversal outright)."""
    directory = directory or STRATEGIES_DIR
    if Path(filename).name != filename or not filename.endswith(".py"):
        raise StrategyLoadError(f"invalid strategy filename '{filename}'")
    path = directory / filename
    if not path.is_file():
        raise StrategyLoadError(f"strategy file not found: '{filename}'")
    spec = importlib.util.spec_from_file_location(f"user_strategy_{path.stem}", path)
    assert spec and spec.loader  # spec_from_file_location on an existing .py
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception as e:
        tb = traceback.format_exc(limit=-1)
        raise StrategyLoadError(f"{filename}: failed to load — {e}\n{tb}") from e
    if not callable(getattr(module, "on_bar", None)):
        raise StrategyLoadError(f"{filename}: no on_bar(ctx) function defined")
    return module


def list_strategies(directory: Path | None = None) -> list[StrategyInfo]:
    """Every *.py in the strategies dir, described. A file that fails to load is
    still listed, with the failure in `error`, so the UI can show it (the user
    is mid-edit in their IDE — a broken file must be visible, not vanish)."""
    directory = directory or STRATEGIES_DIR
    if not directory.is_dir():
        return []
    out: list[StrategyInfo] = []
    for path in sorted(directory.glob("*.py")):
        try:
            module = load_strategy(path.name, directory)
            out.append(_describe(module, path.name))
        except StrategyLoadError as e:
            out.append(StrategyInfo(
                filename=path.name, name=path.stem, description="",
                hedged=False, error=str(e),
            ))
    return out
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd backend && uv run pytest tests/test_strategy_loader.py -v`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add backend/auto_trader/strategy/loader.py backend/strategies/ema_cross.py backend/tests/test_strategy_loader.py
git commit -m "feat(strategy): coded-strategy file discovery + loader"
```

---

### Task 4: Per-signal bracket levels on Signal + engine

The rule builder's stops come from a per-side `RiskConfig`; a coded strategy attaches levels per entry (`ctx.buy(sl=..., tp=...)`). Carry them on `Signal` and honor them in `BacktestEngine._open`.

**Files:**
- Modify: `backend/auto_trader/core/models.py` (Signal dataclass, ~line 92)
- Modify: `backend/auto_trader/engine/backtest.py` (`_open`, ~line 241, and its call site ~line 159)
- Test: `backend/tests/test_backtest_signal_brackets.py`

**Interfaces:**
- Produces: `Signal` gains `stop_level: float | None = None` and `target_level: float | None = None`. When either is set on an opening signal, the engine seeds the new `Position`'s `stop`/`stop_initial`/`target` from them (overriding any side-level RiskConfig for that position). Intra-bar stop/target exits then work unchanged (`_intrabar_exit` reads `p.stop`/`p.target`).
- Consumed by: Task 5 (CodedStrategy emits them), Task 8 (live route reads them).

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_backtest_signal_brackets.py
"""Per-signal stop/target levels (coded strategies): a Signal carrying
stop_level/target_level seeds the opened position's bracket, and the engine's
existing intra-bar exit machinery closes on them."""

from datetime import datetime, timedelta, timezone

from auto_trader.core.models import Candle, Side, Signal
from auto_trader.engine.backtest import BacktestEngine
from auto_trader.strategy.base import Context, Strategy


def bars(prices: list[tuple[float, float, float, float]]) -> list[Candle]:
    t0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return [
        Candle(time=t0 + timedelta(hours=i), open=o, high=h, low=l, close=c)
        for i, (o, h, l, c) in enumerate(prices)
    ]


class OneBuyWithBracket(Strategy):
    """BUY once on the first bar, with an absolute stop at 95 and target 110."""

    def __init__(self) -> None:
        self.fired = False

    def on_bar(self, ctx: Context) -> list[Signal]:
        if self.fired:
            return []
        self.fired = True
        return [Signal(Side.BUY, 1.0, "entry", leg="long", stop_level=95.0, target_level=110.0)]


def test_signal_stop_level_exits_intrabar():
    # Bar 0 signals; fills at bar 1 open (100). Bar 2 dips low to 94 -> stop 95 hits.
    candles = bars([
        (100, 101, 99, 100),
        (100, 102, 98, 101),
        (101, 102, 94, 96),
        (96, 97, 95, 96),
    ])
    result = BacktestEngine(OneBuyWithBracket()).run(candles)
    assert len(result.trades) == 1
    t = result.trades[0]
    assert t.reason_out == "stop"
    assert t.exit_price == 95.0
    assert t.stop_initial == 95.0 and t.target == 110.0


def test_signal_target_level_exits_intrabar():
    candles = bars([
        (100, 101, 99, 100),
        (100, 102, 98, 101),
        (101, 111, 100, 108),  # high 111 >= target 110
        (108, 109, 107, 108),
    ])
    result = BacktestEngine(OneBuyWithBracket()).run(candles)
    assert len(result.trades) == 1
    assert result.trades[0].reason_out == "target"
    assert result.trades[0].exit_price == 110.0


def test_signal_without_levels_unchanged():
    class PlainBuy(OneBuyWithBracket):
        def on_bar(self, ctx):
            sigs = super().on_bar(ctx)
            return [Signal(s.side, s.quantity, s.reason, leg=s.leg) for s in sigs]

    candles = bars([
        (100, 101, 99, 100),
        (100, 102, 98, 101),
        (101, 102, 94, 96),
        (96, 97, 95, 96),
    ])
    result = BacktestEngine(PlainBuy()).run(candles)
    # No bracket, no risk config -> held to range end.
    assert len(result.trades) == 1
    assert result.trades[0].reason_out == "range end"
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && uv run pytest tests/test_backtest_signal_brackets.py -v`
Expected: FAIL — `TypeError: Signal.__init__() got an unexpected keyword argument 'stop_level'`

- [ ] **Step 3: Implement**

In `backend/auto_trader/core/models.py`, add two fields to `Signal` (after `combine: str = "AND"`):

```python
    # Per-signal bracket levels (coded strategies): absolute stop/target prices
    # attached to an OPENING signal. When set, the engine seeds the new position's
    # bracket from them instead of the side-level RiskConfig. None = not set.
    stop_level: float | None = None
    target_level: float | None = None
```

In `backend/auto_trader/engine/backtest.py`, change `_open` to accept and prefer signal levels:

```python
    def _open(self, positions, side, risk, fill_price, bar_time, reason, qty, i,
              stop=None, target=None):
        """Open a NEW independent position; seed its stop/target/extreme from the
        fill price. Per-signal `stop`/`target` (coded strategies) override the
        side-level risk config for THIS position. (Pyramiding/merge is a later
        phase.)"""
        p = Position(qty=qty, entry=fill_price, open_time=bar_time, open_reason=reason)
        if stop is not None or target is not None:
            p.extreme = fill_price
            p.stop = stop
            p.stop_initial = stop
            p.target = target
        elif risk:
            p.extreme = fill_price
            p.stop = stop_level(risk.stop, fill_price, side, self._atr_at(risk.stop.length, i), p.extreme)
            p.stop_initial = p.stop
            p.target = target_level(risk.target, fill_price, side, self._atr_at(risk.target.length, i))
        positions.append(p)
```

And its call site (in `run`, the `if opening:` branch):

```python
                    self._open(positions, side, risk, fill_price, bar.time, sig.reason, sig.quantity, i,
                               stop=sig.stop_level, target=sig.target_level)
```

- [ ] **Step 4: Run tests — new file plus the full engine suite (regression)**

Run: `cd backend && uv run pytest tests/test_backtest_signal_brackets.py tests/test_backtest.py tests/test_backtest_stops.py tests/test_backtest_hedging.py tests/test_backtest_multi.py tests/test_backtest_mask.py -v`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/core/models.py backend/auto_trader/engine/backtest.py backend/tests/test_backtest_signal_brackets.py
git commit -m "feat(engine): per-signal stop/target bracket levels on Signal"
```

---

### Task 5: StrategyContext (ctx) + CodedStrategy adapter

**Files:**
- Create: `backend/auto_trader/strategy/coded.py`
- Test: `backend/tests/test_coded_strategy.py`

**Interfaces:**
- Consumes: `auto_trader.indicators.core` (Task 2), `Signal.stop_level/target_level` (Task 4), `Strategy`/`Context` (base.py).
- Produces (`auto_trader.strategy.coded`):
  - `@dataclass(frozen=True) Action(kind: str, leg: str, qty: float | None, stop: float | None, target: float | None, reason: str, note: dict | None)` — `kind` is `"open" | "close"`, `leg` is `"long" | "short" | "any"` (`"any"` only from `ctx.exit()`).
  - `class PositionView` — `.is_long .is_short .is_flat .entry_price .entry_time .qty`
  - `class StrategyContext` — full user-facing API (below)
  - `class StrategyRuntimeError(Exception)` — user code raised at bar N; message carries file/line/bar time
  - `class CodedStrategy(Strategy)` — `__init__(module, candles: list[Candle], quantity: float, trade_from_time: int | None = None)`; `.hedged: bool` mirrors `meta["hedged"]`
- `StrategyContext` API (all indicator methods return the CURRENT closed-bar value, `float | None`):
  - price: `.open .high .low .close .volume` (floats), `.time` (aware UTC datetime)
  - indicators: `.ema(length)`, `.sma(length)`, `.rsi(length)`, `.atr(length)`, `.avwap(anchor_ms)`, `.vol()`, `.volma(length)`
  - history (numpy float64 arrays over bars `0..i`, no lookahead): `.opens .highs .lows .closes .volumes`, plus `.bars_since_entry` (`int | None`, None when flat)
  - position: `.position` → `PositionView` (netted: the held side, long wins if somehow both)
  - actions: `.buy(qty=None, sl=None, tp=None, reason="", note=None)`, `.sell(...)` (short entry), `.close_long(reason="", note=None)`, `.close_short(...)`, `.close(...)` (whichever held)
- Consumed by: Tasks 7 (backtest route), 8 (live route).

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_coded_strategy.py
"""StrategyContext + CodedStrategy: indicator memoization, netted gating,
stateless per-bar evaluation, and Action -> Signal translation."""

import types
from datetime import datetime, timedelta, timezone

import numpy as np
import pytest

from auto_trader.core.models import Candle, Side
from auto_trader.engine.backtest import BacktestEngine
from auto_trader.indicators.core import ema_series, rsi_series
from auto_trader.strategy.base import Context
from auto_trader.strategy.coded import CodedStrategy, StrategyRuntimeError


def make_candles(n: int = 60) -> list[Candle]:
    t0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
    out = []
    px = 100.0
    for i in range(n):
        px += (1 if i % 3 else -1) * 0.5
        out.append(Candle(
            time=t0 + timedelta(hours=i),
            open=px, high=px + 1, low=px - 1, close=px + 0.3, volume=100 + i,
        ))
    return out


def module_from(fn, hedged=False) -> types.ModuleType:
    mod = types.ModuleType("user_strategy_test")
    mod.on_bar = fn
    if hedged:
        mod.meta = {"hedged": True}
    return mod


def run_engine(fn, candles, hedged=False, quantity=1.0):
    strat = CodedStrategy(module_from(fn, hedged), candles, quantity=quantity)
    return BacktestEngine(strat).run(candles)


def test_ctx_price_history_and_indicators():
    candles = make_candles()
    seen = {}

    def on_bar(ctx):
        i = len(ctx.closes) - 1
        if i == 30:
            seen["close"] = ctx.close
            seen["ema9"] = ctx.ema(9)
            seen["rsi14"] = ctx.rsi(14)
            seen["closes_len"] = len(ctx.closes)
            seen["closes_type"] = type(ctx.closes)
        return []

    run_engine(on_bar, candles)
    assert seen["close"] == candles[30].close
    closes = [c.close for c in candles]
    assert seen["ema9"] == ema_series(closes, 9)[30]      # matches the layer at bar i
    assert seen["rsi14"] == rsi_series(closes, 14)[30]
    assert seen["closes_len"] == 31                        # bars 0..30 only — no lookahead
    assert seen["closes_type"] is np.ndarray


def test_indicator_memoization():
    """ctx.ema(9) computes the full series ONCE per run, not once per bar."""
    candles = make_candles()
    calls = {"n": 0}
    import auto_trader.strategy.coded as coded
    real = coded.ema_series

    def counting(values, length):
        calls["n"] += 1
        return real(values, length)

    coded.ema_series = counting
    try:
        run_engine(lambda ctx: [] if ctx.ema(9) else [], candles)
    finally:
        coded.ema_series = real
    assert calls["n"] == 1


def test_buy_close_round_trip_and_netted_gating():
    candles = make_candles()

    def on_bar(ctx):
        if ctx.position.is_flat:
            return [ctx.buy(reason="in")]     # fires EVERY flat bar; scale-in must be suppressed
        if ctx.bars_since_entry is not None and ctx.bars_since_entry >= 3:
            return [ctx.close_long(reason="out")]
        return []

    result = run_engine(on_bar, candles)
    assert result.n_trades >= 2
    for t in result.trades:
        assert t.reason_in == "in" and t.reason_out == "out"
    # Netted: never more than one position open -> no overlapping trades.
    for a, b in zip(result.trades, result.trades[1:]):
        assert a.exit_time <= b.entry_time


def test_entries_suppressed_while_opposite_side_held():
    """Netted: a short entry while long is held is dropped (not hedged)."""
    candles = make_candles()

    def on_bar(ctx):
        out = []
        if ctx.position.is_flat:
            out.append(ctx.buy(reason="long in"))
        out.append(ctx.sell(reason="short in"))  # always tries; must be gated while held
        return out

    result = run_engine(on_bar, candles)
    legs = {t.leg for t in result.trades}
    assert "short" not in legs or all(
        # any short trade must not overlap a long one
        not (s.entry_time < l.exit_time and l.entry_time < s.exit_time)
        for s in result.trades if s.leg == "short"
        for l in result.trades if l.leg == "long"
    )


def test_hedged_meta_allows_both_sides():
    candles = make_candles()

    def on_bar(ctx):
        out = []
        if ctx.position_long_qty == 0:
            out.append(ctx.buy(reason="l"))
        if ctx.position_short_qty == 0:
            out.append(ctx.sell(reason="s"))
        return out

    strat = CodedStrategy(module_from(on_bar, hedged=True), candles, quantity=1.0)
    assert strat.hedged is True
    result = BacktestEngine(strat).run(candles)
    assert {t.leg for t in result.trades} == {"long", "short"}


def test_bracket_and_note_flow_to_signal():
    candles = make_candles()
    captured = []

    def on_bar(ctx):
        if ctx.position.is_flat and not captured:
            a = ctx.buy(sl=ctx.close * 0.9, tp=ctx.close * 1.1, reason="r", note={"x": 1.5})
            captured.append(a)
            return [a]
        return []

    strat = CodedStrategy(module_from(on_bar), candles, quantity=2.0)
    ctx = Context()
    ctx.history = candles[:10]
    signals = strat.on_bar(ctx)
    assert len(signals) == 1
    s = signals[0]
    assert s.side is Side.BUY and s.leg == "long" and s.quantity == 2.0
    assert s.stop_level == pytest.approx(candles[9].close * 0.9)
    assert s.target_level == pytest.approx(candles[9].close * 1.1)
    assert s.reason == "r"
    assert len(s.terms) == 1 and s.terms[0].left_label == "x" and s.terms[0].left_val == 1.5


def test_close_any_expands_to_held_side():
    candles = make_candles()
    strat = CodedStrategy(module_from(lambda ctx: [ctx.exit(reason="bail")]), candles, quantity=1.0)
    ctx = Context()
    ctx.history = candles[:10]
    ctx.position_short = 1.0
    ctx.short_entry_price = 100.0
    ctx.short_entry_time = candles[5].time
    signals = strat.on_bar(ctx)
    assert len(signals) == 1
    assert signals[0].leg == "short" and signals[0].side is Side.BUY


def test_exit_when_flat_is_dropped():
    candles = make_candles()
    strat = CodedStrategy(module_from(lambda ctx: [ctx.close_long()]), candles, quantity=1.0)
    ctx = Context()
    ctx.history = candles[:10]
    assert strat.on_bar(ctx) == []


def test_trade_from_time_gates_entries():
    candles = make_candles()
    gate = int(candles[30].time.timestamp())
    result_all = run_engine(lambda ctx: [ctx.buy()] if ctx.position.is_flat else [], candles)
    strat = CodedStrategy(
        module_from(lambda ctx: [ctx.buy()] if ctx.position.is_flat else []),
        candles, quantity=1.0, trade_from_time=gate,
    )
    result_gated = BacktestEngine(strat).run(candles)
    assert result_gated.trades[0].entry_time >= candles[30].time
    assert result_all.trades[0].entry_time < result_gated.trades[0].entry_time


def test_user_exception_wrapped_with_bar_info():
    candles = make_candles()

    def on_bar(ctx):
        if len(ctx.closes) - 1 == 5:
            raise ValueError("boom")
        return []

    with pytest.raises(StrategyRuntimeError) as ei:
        run_engine(on_bar, candles)
    assert "boom" in str(ei.value) and "bar 5" in str(ei.value)


def test_bad_return_type_is_an_error():
    candles = make_candles()
    with pytest.raises(StrategyRuntimeError, match="Action"):
        run_engine(lambda ctx: ["not an action"], candles)
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && uv run pytest tests/test_coded_strategy.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'auto_trader.strategy.coded'`

- [ ] **Step 3: Implement**

```python
# backend/auto_trader/strategy/coded.py
"""CodedStrategy: run a user-authored Python module (on_bar(ctx)) through the
same Strategy seam RuleStrategy uses, in backtest AND live.

Contract (see the coded-strategies spec):
- STATELESS: a fresh StrategyContext per bar; everything derives from history +
  position. Backtest loops one CodedStrategy instance, live re-instantiates per
  request — module/global state would silently diverge, so none is offered.
- NETTED by construction: while any side is held, entry actions are dropped;
  exits are dropped when their side is flat. meta["hedged"]=True opts into the
  engine's hedged buckets (backtest-only — the live route refuses it).
- MEMOIZED indicators: each (indicator, params) series is computed ONCE over the
  full candle list and indexed per bar. Values at index i depend only on bars
  0..i (the formulas are causal), so precomputing over the full list leaks
  nothing — while naive per-bar recompute would be O(n²).
"""

from __future__ import annotations

import traceback
from dataclasses import dataclass
from datetime import datetime
from types import ModuleType

import numpy as np

from auto_trader.core.models import Candle, RuleTerm, Side, Signal
from auto_trader.indicators.core import (
    atr_series,
    avwap_series,
    ema_series,
    rsi_series,
    sma_series,
)
from auto_trader.strategy.base import Context, Strategy


class StrategyRuntimeError(Exception):
    """User strategy code failed (bad return value or an exception at a bar)."""


@dataclass(frozen=True, slots=True)
class Action:
    """What ctx.buy()/sell()/close_*() return; the strategy returns a list of
    these from on_bar. `leg` is "long"/"short", or "any" for ctx.exit()."""

    kind: str  # "open" | "close"
    leg: str  # "long" | "short" | "any"
    qty: float | None = None
    stop: float | None = None
    target: float | None = None
    reason: str = ""
    note: dict | None = None


class PositionView:
    """Netted read-only position facts for the strategy author."""

    def __init__(self, ctx: Context) -> None:
        self._long = ctx.position_long
        self._short = ctx.position_short
        self.entry_price = ctx.long_entry_price if self._long > 0 else (
            ctx.short_entry_price if self._short > 0 else None
        )
        self.entry_time = ctx.long_entry_time if self._long > 0 else (
            ctx.short_entry_time if self._short > 0 else None
        )

    @property
    def is_long(self) -> bool:
        return self._long > 0

    @property
    def is_short(self) -> bool:
        return self._short > 0

    @property
    def is_flat(self) -> bool:
        return self._long <= 0 and self._short <= 0

    @property
    def qty(self) -> float:
        return self._long if self._long > 0 else self._short


class StrategyContext:
    """The façade user code talks to at each bar. Indicator methods return the
    current CLOSED bar's value (None during warm-up); history arrays cover bars
    0..current only — no future bars are reachable."""

    def __init__(
        self,
        ctx: Context,
        candles: list[Candle],
        arrays: dict[str, np.ndarray],
        i: int,
        cache: dict[str, list[float | None]],
    ) -> None:
        self._ctx = ctx
        self._candles = candles
        self._arrays = arrays
        self._i = i
        self._cache = cache
        self.position = PositionView(ctx)
        # Raw per-side sizes for hedged strategies (netted authors use .position).
        self.position_long_qty = ctx.position_long
        self.position_short_qty = ctx.position_short

    # --- current bar ------------------------------------------------------
    @property
    def time(self) -> datetime:
        return self._candles[self._i].time

    @property
    def open(self) -> float:
        return self._candles[self._i].open

    @property
    def high(self) -> float:
        return self._candles[self._i].high

    @property
    def low(self) -> float:
        return self._candles[self._i].low

    @property
    def close(self) -> float:
        return self._candles[self._i].close

    @property
    def volume(self) -> float:
        return self._candles[self._i].volume

    # --- history (numpy views over bars 0..i, no lookahead) ----------------
    @property
    def opens(self) -> np.ndarray:
        return self._arrays["open"][: self._i + 1]

    @property
    def highs(self) -> np.ndarray:
        return self._arrays["high"][: self._i + 1]

    @property
    def lows(self) -> np.ndarray:
        return self._arrays["low"][: self._i + 1]

    @property
    def closes(self) -> np.ndarray:
        return self._arrays["close"][: self._i + 1]

    @property
    def volumes(self) -> np.ndarray:
        return self._arrays["volume"][: self._i + 1]

    @property
    def bars_since_entry(self) -> int | None:
        """Bars since the held position's entry bar (0 on the fill bar), or None
        when flat. The entry bar is the last bar with time <= entry_time,
        mirroring RuleStrategy._entry_index."""
        t = self.position.entry_time
        if t is None:
            return None
        hist = self._ctx.history
        if not hist:
            return None
        if t <= hist[0].time:
            return self._i
        idx = 0
        for j, bar in enumerate(hist):
            if bar.time <= t:
                idx = j
            else:
                break
        return self._i - idx

    # --- indicators (memoized full-series compute, current-bar read) -------
    def _series(self, key: str, compute) -> float | None:
        arr = self._cache.get(key)
        if arr is None:
            arr = compute()
            self._cache[key] = arr
        return arr[self._i]

    def ema(self, length: int) -> float | None:
        closes = self._arrays["close"].tolist()
        return self._series(f"EMA_{length}", lambda: ema_series(closes, length))

    def sma(self, length: int) -> float | None:
        closes = self._arrays["close"].tolist()
        return self._series(f"SMA_{length}", lambda: sma_series(closes, length))

    def rsi(self, length: int) -> float | None:
        closes = self._arrays["close"].tolist()
        return self._series(f"RSI_{length}", lambda: rsi_series(closes, length))

    def atr(self, length: int) -> float | None:
        return self._series(f"ATR_{length}", lambda: atr_series(self._candles, length))

    def avwap(self, anchor_ms: int) -> float | None:
        return self._series(f"AVWAP_{anchor_ms}", lambda: avwap_series(self._candles, anchor_ms))

    def vol(self) -> float | None:
        return self._candles[self._i].volume

    def volma(self, length: int) -> float | None:
        vols = self._arrays["volume"].tolist()
        return self._series(f"VOLMA_{length}", lambda: sma_series(vols, length))

    # --- actions ------------------------------------------------------------
    def buy(self, qty: float | None = None, sl: float | None = None,
            tp: float | None = None, reason: str = "", note: dict | None = None) -> Action:
        return Action("open", "long", qty=qty, stop=sl, target=tp, reason=reason, note=note)

    def sell(self, qty: float | None = None, sl: float | None = None,
             tp: float | None = None, reason: str = "", note: dict | None = None) -> Action:
        return Action("open", "short", qty=qty, stop=sl, target=tp, reason=reason, note=note)

    def close_long(self, reason: str = "", note: dict | None = None) -> Action:
        return Action("close", "long", reason=reason, note=note)

    def close_short(self, reason: str = "", note: dict | None = None) -> Action:
        return Action("close", "short", reason=reason, note=note)

    def close(self, reason: str = "", note: dict | None = None) -> Action:
        return Action("close", "any", reason=reason, note=note)


def _note_terms(note: dict | None) -> tuple[RuleTerm, ...]:
    """An author's note={"rsi": 71.2, ...} rendered through the same terms
    channel the rule popover uses: one term per entry, value on the left, no
    operator/right side."""
    if not note:
        return ()
    out = []
    for k, v in note.items():
        try:
            val = float(v)
        except (TypeError, ValueError):
            val = None
        out.append(RuleTerm(left_label=str(k), left_val=val, op="",
                            right_label="", right_val=None))
    return tuple(out)


class CodedStrategy(Strategy):
    """Adapts a loaded user module to the Strategy interface. `candles` is the
    FULL bar list of the run (backtest: the posted candles; live: the rolling
    window) — the indicator cache computes each series once over it."""

    def __init__(self, module: ModuleType, candles: list[Candle], quantity: float,
                 trade_from_time: int | None = None) -> None:
        self.module = module
        self.candles = candles
        self.quantity = quantity
        self.trade_from_time = trade_from_time
        meta = getattr(module, "meta", None)
        self.hedged = bool(meta.get("hedged", False)) if isinstance(meta, dict) else False
        self._cache: dict[str, list[float | None]] = {}
        self._arrays: dict[str, np.ndarray] = {
            "open": np.array([c.open for c in candles], dtype=np.float64),
            "high": np.array([c.high for c in candles], dtype=np.float64),
            "low": np.array([c.low for c in candles], dtype=np.float64),
            "close": np.array([c.close for c in candles], dtype=np.float64),
            "volume": np.array([c.volume for c in candles], dtype=np.float64),
        }

    def on_bar(self, ctx: Context) -> list[Signal]:
        i = len(ctx.history) - 1
        sctx = StrategyContext(ctx, self.candles, self._arrays, i, self._cache)
        try:
            actions = self.module.on_bar(sctx) or []
        except Exception as e:
            file = getattr(self.module, "__file__", "<strategy>")
            tb = traceback.format_exc(limit=-1)
            raise StrategyRuntimeError(
                f"{file} raised at bar {i} ({ctx.bar.time.isoformat()}): {e}\n{tb}"
            ) from e
        if not isinstance(actions, (list, tuple)):
            actions = [actions]

        gated = (
            self.trade_from_time is not None
            and ctx.bar.time.timestamp() < self.trade_from_time
        )
        held = ctx.position_long > 0 or ctx.position_short > 0
        signals: list[Signal] = []
        opened_this_bar = False
        for a in actions:
            if not isinstance(a, Action):
                raise StrategyRuntimeError(
                    f"on_bar must return ctx.buy()/sell()/close_*() Action objects, got {a!r}"
                )
            if a.kind == "open":
                if gated:
                    continue
                if not self.hedged and (held or opened_this_bar):
                    continue  # netted: no scale-in, no hedge, one entry per bar
                if a.leg == "long" and ctx.position_long > 0:
                    continue  # hedged mode still never scales into a held side
                if a.leg == "short" and ctx.position_short > 0:
                    continue
                side = Side.BUY if a.leg == "long" else Side.SELL
                signals.append(Signal(
                    side, a.qty or self.quantity, a.reason, leg=a.leg,
                    terms=_note_terms(a.note),
                    stop_level=a.stop, target_level=a.target,
                ))
                opened_this_bar = True
            else:  # close
                legs = ("long", "short") if a.leg == "any" else (a.leg,)
                for leg in legs:
                    size = ctx.position_long if leg == "long" else ctx.position_short
                    if size <= 0:
                        continue
                    side = Side.SELL if leg == "long" else Side.BUY
                    signals.append(Signal(
                        side, size, a.reason, leg=leg, terms=_note_terms(a.note),
                    ))
        return signals
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && uv run pytest tests/test_coded_strategy.py -v`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/strategy/coded.py backend/tests/test_coded_strategy.py
git commit -m "feat(strategy): StrategyContext + CodedStrategy adapter (netted, memoized, stateless)"
```

---

### Task 6: /api/strategies discovery routes

**Files:**
- Create: `backend/auto_trader/api/routers/strategies.py`
- Modify: `backend/auto_trader/api/app.py` (router include loop, ~line 97, and its import line)
- Modify: `backend/auto_trader/api/schemas.py` (add `StrategyInfoDTO`, `StrategySourceDTO`)
- Test: `backend/tests/test_api_strategies.py`

**Interfaces:**
- Produces:
  - `GET /api/strategies` → `list[StrategyInfoDTO]` where `StrategyInfoDTO = {filename: str, name: str, description: str, hedged: bool, error: str | None}`
  - `GET /api/strategies/{filename}/source` → `{filename: str, source: str}`; 404 for unknown/invalid filename
- Consumed by: frontend Task 9 (`fetchStrategies`, `fetchStrategySource`).

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_api_strategies.py
"""GET /api/strategies (+ /source): discovery surface for the frontend picker."""

import pytest
from fastapi.testclient import TestClient

import auto_trader.strategy.loader as loader
from auto_trader.api.app import app


@pytest.fixture
def client(tmp_path, monkeypatch):
    (tmp_path / "alpha.py").write_text(
        '"""Alpha strat."""\nmeta = {"name": "Alpha"}\ndef on_bar(ctx):\n    return []\n'
    )
    (tmp_path / "broken.py").write_text("def on_bar(ctx:\n")
    monkeypatch.setattr(loader, "STRATEGIES_DIR", tmp_path)
    with TestClient(app) as c:
        yield c


def test_list(client):
    res = client.get("/api/strategies")
    assert res.status_code == 200
    by_name = {s["filename"]: s for s in res.json()}
    assert by_name["alpha.py"]["name"] == "Alpha"
    assert by_name["alpha.py"]["description"] == "Alpha strat."
    assert by_name["alpha.py"]["hedged"] is False
    assert by_name["alpha.py"]["error"] is None
    assert by_name["broken.py"]["error"]  # broken file listed with its error


def test_source(client):
    res = client.get("/api/strategies/alpha.py/source")
    assert res.status_code == 200
    body = res.json()
    assert body["filename"] == "alpha.py"
    assert "def on_bar" in body["source"]


def test_source_unknown_404(client):
    assert client.get("/api/strategies/nope.py/source").status_code == 404
    assert client.get("/api/strategies/..%2Fevil.py/source").status_code == 404
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && uv run pytest tests/test_api_strategies.py -v`
Expected: FAIL — 404 on `/api/strategies` (route doesn't exist)

- [ ] **Step 3: Implement**

Add to `backend/auto_trader/api/schemas.py` (near the live-trading section at the bottom):

```python
# --- coded strategies: /api/strategies discovery ------------------------------


class StrategyInfoDTO(BaseModel):
    """One discovered backend/strategies/*.py file. A file that fails to load is
    still listed with `error` set, so the picker can show it as broken."""

    filename: str
    name: str
    description: str
    hedged: bool
    error: str | None = None


class StrategySourceDTO(BaseModel):
    filename: str
    source: str
```

Create the router:

```python
# backend/auto_trader/api/routers/strategies.py
"""Coded-strategy discovery: list backend/strategies/*.py and serve their
source read-only. Files are authored in the user's IDE; the app never writes
them. The loader module attribute (not a from-import) is read at call time so
tests can monkeypatch STRATEGIES_DIR."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from auto_trader.strategy import loader

from ..schemas import StrategyInfoDTO, StrategySourceDTO

router = APIRouter()


@router.get("/api/strategies", response_model=list[StrategyInfoDTO])
async def strategies() -> list[StrategyInfoDTO]:
    return [
        StrategyInfoDTO(
            filename=i.filename, name=i.name, description=i.description,
            hedged=i.hedged, error=i.error,
        )
        for i in loader.list_strategies(loader.STRATEGIES_DIR)
    ]


@router.get("/api/strategies/{filename}/source", response_model=StrategySourceDTO)
async def strategy_source(filename: str) -> StrategySourceDTO:
    from pathlib import Path

    if Path(filename).name != filename or not filename.endswith(".py"):
        raise HTTPException(404, f"unknown strategy '{filename}'")
    path = loader.STRATEGIES_DIR / filename
    if not path.is_file():
        raise HTTPException(404, f"unknown strategy '{filename}'")
    return StrategySourceDTO(filename=filename, source=path.read_text())
```

In `backend/auto_trader/api/app.py`: add `strategies` to the routers import (same line that imports `markets, trading, state, charts, backtest, strategy, stream` — find it with grep and append `strategies`), and extend the include loop:

```python
for _module in (markets, trading, state, charts, backtest, strategy, stream, strategies):
    app.include_router(_module.router)
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && uv run pytest tests/test_api_strategies.py -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/routers/strategies.py backend/auto_trader/api/app.py backend/auto_trader/api/schemas.py backend/tests/test_api_strategies.py
git commit -m "feat(api): /api/strategies discovery + read-only source routes"
```

---

### Task 7: Backtest route runs a coded strategy

**Files:**
- Modify: `backend/auto_trader/api/schemas.py` (`BacktestRequest`, ~line 303)
- Modify: `backend/auto_trader/api/routers/backtest.py`
- Test: `backend/tests/test_api_backtest_coded.py`

**Interfaces:**
- Produces: `BacktestRequest` gains `codedStrategy: str | None = None` (a filename from `/api/strategies`). When set: rule groups/series/risk validation is skipped, `CodedStrategy` replaces `RuleStrategy`, response shape unchanged. Errors: 422 with a `detail` string carrying file/line for load failures (`StrategyLoadError`) and runtime failures (`StrategyRuntimeError`).
- Consumed by: frontend Task 11.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_api_backtest_coded.py
"""POST /api/backtest with codedStrategy: runs the .py file through the engine,
skips rule/series validation, surfaces load/runtime errors as structured 422s."""

import pytest
from fastapi.testclient import TestClient

import auto_trader.strategy.loader as loader
from auto_trader.api.app import app

STRAT = '''"""Test strat."""
def on_bar(ctx):
    if ctx.position.is_flat and len(ctx.closes) % 10 == 0:
        return [ctx.buy(sl=ctx.close * 0.9, tp=ctx.close * 1.2, reason="in", note={"c": ctx.close})]
    if ctx.position.is_long and ctx.bars_since_entry >= 3:
        return [ctx.close_long(reason="out")]
    return []
'''

RAISING = 'def on_bar(ctx):\n    raise RuntimeError("kaboom")\n'


def make_candles(n=60):
    t0 = 1_700_000_000
    out = []
    px = 100.0
    for i in range(n):
        px += 0.5 if i % 3 else -0.5
        out.append({
            "time": t0 + i * 3600, "open": px, "high": px + 1,
            "low": px - 1, "close": px + 0.3, "volume": 10,
        })
    return out


def base_request(strategy: str, candles):
    empty = {"combine": "AND", "rules": []}
    return {
        "epic": "TEST", "resolution": "HOUR", "candles": candles, "series": {},
        "longEntry": empty, "longExit": empty, "shortEntry": empty, "shortExit": empty,
        "costs": {"quantity": 1, "commissionPerSide": 0, "slippage": 0, "startingCash": 10000},
        "tradeFromTime": candles[0]["time"],
        "codedStrategy": strategy,
    }


@pytest.fixture
def client(tmp_path, monkeypatch):
    (tmp_path / "test.py").write_text(STRAT)
    (tmp_path / "raising.py").write_text(RAISING)
    monkeypatch.setattr(loader, "STRATEGIES_DIR", tmp_path)
    with TestClient(app) as c:
        yield c


def test_coded_backtest_produces_trades(client):
    res = client.post("/api/backtest", json=base_request("test.py", make_candles()))
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["summary"]["n_trades"] >= 1
    entries = [m for m in body["markers"] if m["reason"] == "in"]
    assert entries, "entry markers present"
    # The note dict rides the terms channel for the signal popover.
    assert entries[0]["terms"] and entries[0]["terms"][0]["left"] == "c"
    # Brackets landed: some exit must be a stop or target OR the rule exit fired.
    assert all(t["reason"] in ("out", "stop", "target", "range end") for t in body["trades"])


def test_unknown_strategy_422(client):
    res = client.post("/api/backtest", json=base_request("missing.py", make_candles()))
    assert res.status_code == 422
    assert "missing.py" in res.json()["detail"]


def test_runtime_error_422_with_bar_info(client):
    res = client.post("/api/backtest", json=base_request("raising.py", make_candles()))
    assert res.status_code == 422
    detail = res.json()["detail"]
    assert "kaboom" in detail and "bar" in detail


def test_rule_path_unaffected(client):
    """Without codedStrategy the request behaves exactly as before (series/rule
    validation still runs)."""
    req = base_request(None, make_candles())
    del req["codedStrategy"]
    req["longEntry"] = {"combine": "AND", "rules": [{
        "left": {"kind": "indicator", "indicator": "EMA", "length": 9},
        "op": "gt",
        "right": {"kind": "price", "field": "close"},
    }]}
    res = client.post("/api/backtest", json=req)
    assert res.status_code == 422
    assert "missing series 'EMA_9'" in res.json()["detail"]
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && uv run pytest tests/test_api_backtest_coded.py -v`
Expected: `test_coded_backtest_produces_trades` FAILs (codedStrategy ignored → no trades); rule-path test may already pass.

- [ ] **Step 3: Implement**

In `backend/auto_trader/api/schemas.py`, add to `BacktestRequest` (after `mask: RecurrenceMaskDTO | None = None`):

```python
    # Coded strategy (a backend/strategies/*.py filename). When set, the rule
    # groups above are ignored and the file's on_bar drives the run; series stays
    # empty (Python computes indicators ad hoc — the frontend posts none).
    codedStrategy: str | None = None
```

In `backend/auto_trader/api/routers/backtest.py`:

Add imports:

```python
from auto_trader.strategy import loader
from auto_trader.strategy.coded import CodedStrategy, StrategyRuntimeError
from auto_trader.strategy.loader import StrategyLoadError
```

Restructure the handler: wrap the series/rule/risk/scaling validation blocks (everything from `for name, arr in req.series.items():` through the scaling loop) in `if req.codedStrategy is None:`, then build the strategy conditionally and guard the run:

```python
    candles = [_candle_from_dto(c) for c in req.candles]
    if req.codedStrategy is not None:
        try:
            module = loader.load_strategy(req.codedStrategy, loader.STRATEGIES_DIR)
        except StrategyLoadError as e:
            raise HTTPException(422, str(e))
        strategy = CodedStrategy(
            module, candles, quantity=req.costs.quantity, trade_from_time=req.tradeFromTime,
        )
    else:
        strategy = RuleStrategy(
            req.longEntry.to_group(), req.longExit.to_group(),
            req.shortEntry.to_group(), req.shortExit.to_group(),
            req.series, quantity=req.costs.quantity, trade_from_time=req.tradeFromTime,
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
        series=req.series,
        mask=req.mask.to_mask() if req.mask else None,
    )
    try:
        result = engine.run(candles)
    except StrategyRuntimeError as e:
        raise HTTPException(422, str(e))
```

(The response-building tail is unchanged.)

- [ ] **Step 4: Run — new tests plus the existing backtest API suite**

Run: `cd backend && uv run pytest tests/test_api_backtest_coded.py tests/test_api_backtest.py -v`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/schemas.py backend/auto_trader/api/routers/backtest.py backend/tests/test_api_backtest_coded.py
git commit -m "feat(backtest): run coded strategies through /api/backtest"
```

---

### Task 8: Live evaluate route runs a coded strategy (hedged refused)

**Files:**
- Modify: `backend/auto_trader/api/schemas.py` (`EvaluateRequest`, ~line 444)
- Modify: `backend/auto_trader/api/routers/strategy.py`
- Test: `backend/tests/test_api_evaluate_coded.py`

**Interfaces:**
- Produces: `EvaluateRequest` gains `codedStrategy: str | None = None`. When set: series/rule validation skipped, `CodedStrategy` (quantity 1.0 — live sizing is the caller's) replaces `RuleStrategy`; a `meta["hedged"]` strategy → 422 "backtest-only". An open action's `stop_level`/`take_profit_level` come from the signal's per-signal bracket (`sig.stop_level`/`sig.target_level`) instead of the risk config.
- Consumed by: frontend Task 12 (liveEngine passthrough).

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_api_evaluate_coded.py
"""POST /api/strategy/evaluate with codedStrategy: same file as backtest drives
the one-bar live decision; hedged strategies are refused; per-signal brackets
land on the ActionDTO."""

import pytest
from fastapi.testclient import TestClient

import auto_trader.strategy.loader as loader
from auto_trader.api.app import app

ALWAYS_IN = '''def on_bar(ctx):
    if ctx.position.is_flat:
        return [ctx.buy(sl=ctx.close * 0.98, tp=ctx.close * 1.04, reason="go")]
    return [ctx.close_long(reason="bail")]
'''

HEDGED = 'meta = {"hedged": True}\ndef on_bar(ctx):\n    return []\n'


def make_candles(n=30):
    t0 = 1_700_000_000
    return [
        {"time": t0 + i * 3600, "open": 100 + i, "high": 101 + i,
         "low": 99 + i, "close": 100.5 + i, "volume": 10}
        for i in range(n)
    ]


def base_request(strategy, position=None):
    empty = {"combine": "AND", "rules": []}
    req = {
        "epic": "TEST", "resolution": "HOUR", "candles": make_candles(), "series": {},
        "longEntry": empty, "longExit": empty, "shortEntry": empty, "shortExit": empty,
        "codedStrategy": strategy,
    }
    if position:
        req["position"] = position
    return req


@pytest.fixture
def client(tmp_path, monkeypatch):
    (tmp_path / "always_in.py").write_text(ALWAYS_IN)
    (tmp_path / "hedged.py").write_text(HEDGED)
    monkeypatch.setattr(loader, "STRATEGIES_DIR", tmp_path)
    with TestClient(app) as c:
        yield c


def test_flat_opens_with_signal_bracket(client):
    res = client.post("/api/strategy/evaluate", json=base_request("always_in.py"))
    assert res.status_code == 200, res.text
    actions = res.json()["actions"]
    assert len(actions) == 1
    a = actions[0]
    assert a["kind"] == "open" and a["leg"] == "long" and a["side"] == "buy"
    last_close = make_candles()[-1]["close"]
    assert a["stop_level"] == pytest.approx(last_close * 0.98)
    assert a["take_profit_level"] == pytest.approx(last_close * 1.04)


def test_held_closes(client):
    pos = {"side": "buy", "quantity": 1, "open_level": 100,
           "open_time": make_candles()[5]["time"]}
    res = client.post("/api/strategy/evaluate", json=base_request("always_in.py", pos))
    actions = res.json()["actions"]
    assert len(actions) == 1
    assert actions[0]["kind"] == "close" and actions[0]["reason"] == "bail"


def test_hedged_refused(client):
    res = client.post("/api/strategy/evaluate", json=base_request("hedged.py"))
    assert res.status_code == 422
    assert "backtest-only" in res.json()["detail"]


def test_unknown_strategy_422(client):
    res = client.post("/api/strategy/evaluate", json=base_request("missing.py"))
    assert res.status_code == 422
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && uv run pytest tests/test_api_evaluate_coded.py -v`
Expected: FAIL (codedStrategy unknown field / no actions)

- [ ] **Step 3: Implement**

In `backend/auto_trader/api/schemas.py`, add to `EvaluateRequest` (after `position: PositionStateDTO | None = None`):

```python
    # Coded strategy filename (backend/strategies/*.py). When set the rule groups
    # are ignored; a meta["hedged"] strategy is refused (backtest-only).
    codedStrategy: str | None = None
```

In `backend/auto_trader/api/routers/strategy.py`:

Add imports:

```python
from auto_trader.strategy import loader
from auto_trader.strategy.coded import CodedStrategy, StrategyRuntimeError
from auto_trader.strategy.loader import StrategyLoadError
```

Wrap the series/rule validation in `if req.codedStrategy is None:`, build the strategy conditionally (replacing the existing `strategy = RuleStrategy(...)` assignment):

```python
    if req.codedStrategy is not None:
        try:
            module = loader.load_strategy(req.codedStrategy, loader.STRATEGIES_DIR)
        except StrategyLoadError as e:
            raise HTTPException(422, str(e))
        meta = getattr(module, "meta", None)
        if isinstance(meta, dict) and meta.get("hedged"):
            raise HTTPException(
                422, f"'{req.codedStrategy}' is hedged — backtest-only, refused for live"
            )
        strategy = CodedStrategy(module, candles, quantity=1.0)
    else:
        strategy = RuleStrategy(
            req.longEntry.to_group(), req.longExit.to_group(),
            req.shortEntry.to_group(), req.shortExit.to_group(),
            req.series, quantity=1.0, trade_from_time=None,
            long_enabled=req.longEnabled, short_enabled=req.shortEnabled,
        )
```

Guard the on_bar call:

```python
    try:
        signals = strategy.on_bar(ctx)
    except StrategyRuntimeError as e:
        raise HTTPException(422, str(e))
```

In the action loop's `if is_open:` branch, prefer per-signal brackets over risk-config levels:

```python
            risk = req.longRisk if sig.leg == "long" else req.shortRisk
            stop = tp = None
            if sig.stop_level is not None or sig.target_level is not None:
                stop, tp = sig.stop_level, sig.target_level
            elif risk is not None:
                stop = stop_level(
                    risk.stop.to_spec(), close, sig.leg, _atr(risk.stop, req.series, i), close
                )
                tp = target_level(
                    risk.target.to_spec(), close, sig.leg, _atr(risk.target, req.series, i)
                )
```

- [ ] **Step 4: Run — new tests plus the existing evaluate suite**

Run: `cd backend && uv run pytest tests/test_api_evaluate_coded.py tests/test_api_strategy_evaluate.py -v`
Expected: ALL PASS

- [ ] **Step 5: Run the full backend suite (phase gate)**

Run: `cd backend && uv run pytest -q`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add backend/auto_trader/api/schemas.py backend/auto_trader/api/routers/strategy.py backend/tests/test_api_evaluate_coded.py
git commit -m "feat(live): coded strategies on /api/strategy/evaluate (hedged refused)"
```

---

## Phase 3 — Frontend: Strategy tab, picker, run + live wiring

### Task 9: API client + config fields

**Files:**
- Modify: `frontend/src/api.ts` (`BacktestRequest` ~line 93, `EvaluateRequest`, new fetchers)
- Modify: `frontend/src/lib/backtestConfig.ts` (`BacktestConfig` interface)
- Test: `frontend/src/lib/strategiesApi.test.ts`

**Interfaces:**
- Produces (in `api.ts`):
  - `export interface StrategyInfo { filename: string; name: string; description: string; hedged: boolean; error: string | null }`
  - `export async function fetchStrategies(): Promise<StrategyInfo[]>` — GET `/api/strategies`
  - `export async function fetchStrategySource(filename: string): Promise<string>` — GET `/api/strategies/{filename}/source`, returns `.source`
  - `BacktestRequest` and `EvaluateRequest` gain `codedStrategy?: string`
- Produces (in `backtestConfig.ts`): `BacktestConfig` gains `mode?: "rules" | "coded"` and `codedStrategy?: string` (persisted with the rest of the config — no migration needed, absent = rules).
- Consumed by: Tasks 10, 11, 12.

- [ ] **Step 1: Write the failing test**

```typescript
// frontend/src/lib/strategiesApi.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchStrategies, fetchStrategySource } from "../api";

afterEach(() => vi.restoreAllMocks());

function mockFetch(body: unknown, ok = true) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok,
    status: ok ? 200 : 404,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response);
}

describe("strategies api", () => {
  it("fetchStrategies GETs /api/strategies", async () => {
    const spy = mockFetch([
      { filename: "a.py", name: "A", description: "d", hedged: false, error: null },
    ]);
    const list = await fetchStrategies();
    expect(String(spy.mock.calls[0][0])).toContain("/api/strategies");
    expect(list[0].name).toBe("A");
  });

  it("fetchStrategySource returns the source text", async () => {
    const spy = mockFetch({ filename: "a.py", source: "def on_bar(ctx): ..." });
    const src = await fetchStrategySource("a.py");
    expect(String(spy.mock.calls[0][0])).toContain("/api/strategies/a.py/source");
    expect(src).toContain("def on_bar");
  });

  it("fetchStrategies throws on error responses", async () => {
    mockFetch({ detail: "boom" }, false);
    await expect(fetchStrategies()).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run src/lib/strategiesApi.test.ts`
Expected: FAIL — `fetchStrategies` is not exported

- [ ] **Step 3: Implement**

In `frontend/src/api.ts`:

Add `codedStrategy?: string;` to `BacktestRequest` (after `mask?: RecurrenceMask;`) with the comment `// coded strategy filename — when set, rule groups are ignored (Strategy tab)`. Add the same field to `EvaluateRequest`.

Add below `evaluateStrategy`:

```typescript
// --- coded strategies (backend/strategies/*.py) ------------------------------

export interface StrategyInfo {
  filename: string;
  name: string;
  description: string;
  hedged: boolean;
  error: string | null;
}

export async function fetchStrategies(): Promise<StrategyInfo[]> {
  const res = await fetch(`${BASE}/api/strategies`);
  if (!res.ok) throw new Error(await errorDetail(res, `strategies failed (${res.status})`));
  return res.json();
}

export async function fetchStrategySource(filename: string): Promise<string> {
  const res = await fetch(`${BASE}/api/strategies/${encodeURIComponent(filename)}/source`);
  if (!res.ok) throw new Error(await errorDetail(res, `source failed (${res.status})`));
  const body = await res.json();
  return body.source;
}
```

In `frontend/src/lib/backtestConfig.ts`, add to the `BacktestConfig` interface (next to `longEnabled?`):

```typescript
  // Strategy source: point-and-click rules (default) or a coded backend/strategies
  // .py file. `codedStrategy` is that file's name; only read when mode === "coded".
  mode?: "rules" | "coded";
  codedStrategy?: string;
```

- [ ] **Step 4: Run to verify it passes (+ typecheck)**

Run: `cd frontend && npx vitest run src/lib/strategiesApi.test.ts && npx tsc -b`
Expected: PASS, no type errors

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api.ts frontend/src/lib/backtestConfig.ts frontend/src/lib/strategiesApi.test.ts
git commit -m "feat(frontend): strategies API client + coded-mode config fields"
```

---

### Task 10: StrategyPicker component + modal integration

**Files:**
- Create: `frontend/src/StrategyPicker.tsx`
- Test: `frontend/src/StrategyPicker.test.tsx`
- Modify: `frontend/src/BacktestSettingsModal.tsx` (strategy section, ~line 942)
- Modify: `frontend/src/index.css` (picker styles; follow the existing `bt-` classes)

**Interfaces:**
- Consumes: `fetchStrategies`, `fetchStrategySource` (Task 9); shared `Tooltip` component.
- Produces: `<StrategyPicker value={string | undefined} onChange={(filename: string) => void} />` — dropdown of discovered strategies (name + one-line description; broken files disabled with the error as tooltip), ⟳ reload button (re-fetches the list), always-visible description under the name (meta → docstring → "No description" hint), collapsible read-only "View source" `<pre>`, "hedged — backtest only" badge when `info.hedged`.
- Modal behavior: the strategy section gains a `Rules | Strategy` segmented switch bound to `cfg.mode` (default `"rules"`). `"coded"` renders `StrategyPicker` (bound to `cfg.codedStrategy`) and **hides** the Long/Short side tabs + `SidePanel` (rules AND risk/scaling — code owns risk).

- [ ] **Step 1: Write the failing component test**

```tsx
// frontend/src/StrategyPicker.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import StrategyPicker from "./StrategyPicker";
import * as api from "./api";

const LIST: api.StrategyInfo[] = [
  { filename: "ema_cross.py", name: "EMA Cross + RSI", description: "EMA9/21 crossover.", hedged: false, error: null },
  { filename: "hedger.py", name: "Hedger", description: "", hedged: true, error: null },
  { filename: "broken.py", name: "broken", description: "", hedged: false, error: "SyntaxError: ..." },
];

beforeEach(() => {
  vi.spyOn(api, "fetchStrategies").mockResolvedValue(LIST);
  vi.spyOn(api, "fetchStrategySource").mockResolvedValue("def on_bar(ctx):\n    return []");
});
afterEach(() => vi.restoreAllMocks());

describe("StrategyPicker", () => {
  it("lists strategies and shows the selected one's description", async () => {
    render(<StrategyPicker value="ema_cross.py" onChange={() => {}} />);
    await waitFor(() => expect(screen.getByText("EMA9/21 crossover.")).toBeTruthy());
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("ema_cross.py");
  });

  it("disables broken files and marks hedged ones backtest-only", async () => {
    render(<StrategyPicker value="hedger.py" onChange={() => {}} />);
    await waitFor(() => expect(screen.getByRole("combobox")).toBeTruthy());
    const broken = screen.getByRole("option", { name: /broken/ }) as HTMLOptionElement;
    expect(broken.disabled).toBe(true);
    expect(screen.getByText(/backtest only/i)).toBeTruthy();
  });

  it("shows a hint when the strategy has no description", async () => {
    render(<StrategyPicker value="hedger.py" onChange={() => {}} />);
    await waitFor(() => expect(screen.getByText(/no description/i)).toBeTruthy());
  });

  it("reload re-fetches the list", async () => {
    render(<StrategyPicker value={undefined} onChange={() => {}} />);
    await waitFor(() => expect(api.fetchStrategies).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: /reload/i }));
    await waitFor(() => expect(api.fetchStrategies).toHaveBeenCalledTimes(2));
  });

  it("view source fetches and renders the file read-only", async () => {
    render(<StrategyPicker value="ema_cross.py" onChange={() => {}} />);
    await waitFor(() => expect(screen.getByRole("combobox")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /view source/i }));
    await waitFor(() => expect(screen.getByText(/def on_bar/)).toBeTruthy());
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run src/StrategyPicker.test.tsx`
Expected: FAIL — module `./StrategyPicker` not found

- [ ] **Step 3: Implement the component**

```tsx
// frontend/src/StrategyPicker.tsx
// Picker for coded strategies (backend/strategies/*.py, authored in the user's
// IDE): dropdown of discovered files, always-visible description, ⟳ reload
// (the file list changes on disk between runs), and a collapsed read-only
// source view so you can confirm WHICH version you're about to run.

import { useEffect, useState } from "react";
import { fetchStrategies, fetchStrategySource, type StrategyInfo } from "./api";
import Tooltip from "./components/Tooltip";

interface Props {
  value: string | undefined;
  onChange: (filename: string) => void;
}

export default function StrategyPicker({ value, onChange }: Props) {
  const [list, setList] = useState<StrategyInfo[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);

  async function reload() {
    try {
      setList(await fetchStrategies());
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "failed to load strategies");
    }
  }
  useEffect(() => void reload(), []);

  // Source view follows the selection; refetch on toggle so it's never stale.
  async function toggleSource() {
    const next = !showSource;
    setShowSource(next);
    if (next && value) {
      try {
        setSource(await fetchStrategySource(value));
      } catch (e) {
        setSource(e instanceof Error ? e.message : "failed to load source");
      }
    }
  }
  useEffect(() => {
    setShowSource(false);
    setSource(null);
  }, [value]);

  const selected = list.find((s) => s.filename === value);

  return (
    <div className="strat-picker">
      <div className="strat-picker-row">
        <select
          className="strat-picker-select"
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="" disabled>
            Pick a strategy…
          </option>
          {list.map((s) => (
            <option key={s.filename} value={s.filename} disabled={s.error !== null}>
              {s.error ? `${s.name} (broken)` : s.name}
            </option>
          ))}
        </select>
        <Tooltip content="Re-scan backend/strategies/ for new or edited files">
          <button className="anchor-btn" aria-label="Reload strategies" onClick={() => void reload()}>
            ⟳
          </button>
        </Tooltip>
      </div>
      {loadError && <div className="strat-picker-error">{loadError}</div>}
      {selected && (
        <>
          <div className="strat-picker-meta">
            <span className="strat-picker-name">{selected.name}</span>
            <span className="strat-picker-file">{selected.filename}</span>
            {selected.hedged && <span className="strat-picker-badge">hedged — backtest only</span>}
          </div>
          {selected.error ? (
            <div className="strat-picker-error">{selected.error}</div>
          ) : selected.description ? (
            <p className="strat-picker-desc">{selected.description}</p>
          ) : (
            <p className="strat-picker-desc strat-picker-desc-empty">
              No description — add a docstring or meta[&quot;description&quot;] to the file.
            </p>
          )}
          <button className="strat-picker-src-toggle" onClick={() => void toggleSource()}>
            {showSource ? "▾" : "▸"} View source
          </button>
          {showSource && source !== null && (
            <pre className="strat-picker-src">{source}</pre>
          )}
        </>
      )}
    </div>
  );
}
```

Add styles to `frontend/src/index.css` (near the other `bt-` blocks; flat, no shadows, content-sized per UX conventions):

```css
/* Coded-strategy picker (backtest panel Strategy mode) */
.strat-picker { display: flex; flex-direction: column; gap: 6px; }
.strat-picker-row { display: flex; gap: 6px; align-items: center; }
.strat-picker-select { flex: 1; min-width: 0; }
.strat-picker-meta { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.strat-picker-name { font-weight: 600; }
.strat-picker-file { color: var(--muted, #888); font-size: 12px; }
.strat-picker-badge { font-size: 11px; padding: 1px 6px; border: 1px solid currentColor; border-radius: 3px; color: var(--neg, #c33); }
.strat-picker-desc { margin: 0; font-size: 13px; }
.strat-picker-desc-empty { color: var(--muted, #888); font-style: italic; }
.strat-picker-error { color: var(--neg, #c33); font-size: 12px; white-space: pre-wrap; }
.strat-picker-src-toggle { align-self: flex-start; background: none; border: none; cursor: pointer; padding: 0; font: inherit; color: inherit; }
.strat-picker-src { max-height: 320px; overflow: auto; font-size: 12px; border: 1px solid var(--border, #ddd); padding: 8px; margin: 0; }
```

- [ ] **Step 4: Run to verify the component tests pass**

Run: `cd frontend && npx vitest run src/StrategyPicker.test.tsx`
Expected: PASS (5 tests)

- [ ] **Step 5: Integrate into the modal**

In `frontend/src/BacktestSettingsModal.tsx`, inside the strategy `<section>` (~line 942), wrap the existing side-tabs + `SidePanel` in a mode check. Add at the top of the file: `import StrategyPicker from "./StrategyPicker";`.

Right after `<div className="bt-strategy" ...>` opens, insert the mode switch (reusing the existing `seg` segmented-control classes used by the side tabs):

```tsx
          <div className="bt-side-tabs seg bt-mode-tabs">
            <button
              className={(cfg.mode ?? "rules") === "rules" ? "seg-on" : ""}
              onClick={() => setCfg({ ...cfg, mode: "rules" })}
            >
              Rules
            </button>
            <button
              className={cfg.mode === "coded" ? "seg-on" : ""}
              onClick={() => setCfg({ ...cfg, mode: "coded" })}
            >
              Strategy
            </button>
          </div>
          {cfg.mode === "coded" ? (
            <StrategyPicker
              value={cfg.codedStrategy}
              onChange={(filename) => setCfg({ ...cfg, codedStrategy: filename })}
            />
          ) : (
            <>
              {/* existing side tabs + SidePanel + usesVolume note, unchanged */}
            </>
          )}
```

Move the existing side-tabs `<div className="bt-side-tabs seg">…</div>`, the `<SidePanel …/>` element, and the `usesVolume` note inside the `<>…</>` branch verbatim.

- [ ] **Step 6: Run the modal's existing tests + typecheck**

Run: `cd frontend && npx vitest run src/BacktestSettingsModal.test.tsx && npx tsc -b`
Expected: PASS, no type errors

- [ ] **Step 7: Commit**

```bash
git add frontend/src/StrategyPicker.tsx frontend/src/StrategyPicker.test.tsx frontend/src/BacktestSettingsModal.tsx frontend/src/index.css
git commit -m "feat(frontend): Strategy tab with coded-strategy picker in the backtest panel"
```

---

### Task 11: BacktestButton runs coded strategies

**Files:**
- Modify: `frontend/src/BacktestButton.tsx` (`run()`, ~lines 108–207)

**Interfaces:**
- Consumes: `cfg.mode` / `cfg.codedStrategy` (Task 9), `BacktestRequest.codedStrategy` (Task 9), backend Task 7.
- Behavior: when `cfg.mode === "coded"` — no `buildSeries` call (`series: {}`), empty rule groups, no risk/scaling in the request, `codedStrategy: cfg.codedStrategy`; error "no coded strategy selected" if unset. Candles are still fetched exactly as today (same window/warm-up logic), so the run uses the chart's own bars.

- [ ] **Step 1: Implement**

In `run()` in `frontend/src/BacktestButton.tsx`, after `const cfg = ...` add:

```typescript
      const coded = cfg.mode === "coded";
      if (coded && !cfg.codedStrategy) {
        setError("no coded strategy selected — pick one in the backtest panel");
        return;
      }
```

Replace the `const series = await buildSeries(...)` line with:

```typescript
      // Coded strategies compute indicators in Python — nothing to precompute.
      const series = coded ? {} : await buildSeries(bars, cfg, runResolution, fetchTimeframe);
```

In the `runAndRender` request object, make the rule/risk fields conditional and add the strategy name:

```typescript
          codedStrategy: coded ? cfg.codedStrategy : undefined,
          longEntry: coded ? { combine: "AND", rules: [] } : activeGroup(cfg.longEntry),
          longExit: coded ? { combine: "AND", rules: [] } : activeGroup(cfg.longExit),
          shortEntry: coded ? { combine: "AND", rules: [] } : activeGroup(cfg.shortEntry),
          shortExit: coded ? { combine: "AND", rules: [] } : activeGroup(cfg.shortExit),
          longEnabled: cfg.longEnabled !== false,
          shortEnabled: cfg.shortEnabled !== false,
          longRisk: coded ? undefined : cfg.longRisk,
          shortRisk: coded ? undefined : cfg.shortRisk,
          longScaling: coded ? undefined : cfg.longScaling,
          shortScaling: coded ? undefined : cfg.shortScaling,
```

(The `setError` path already surfaces backend 422 details via `errorDetail`, so strategy load/runtime errors show in the results pane with file/line — no extra work.)

- [ ] **Step 2: Typecheck + full frontend suite**

Run: `cd frontend && npx tsc -b && npx vitest run`
Expected: no type errors; all tests pass

- [ ] **Step 3: End-to-end smoke test (manual, real app)**

With the user's dev servers running (do NOT restart them): open the app, open the backtest panel, switch to **Strategy**, pick **EMA Cross + RSI**, Run backtest. Expected: markers + trades render like a rules run; hovering an entry caret shows the `note` values; the trades dock lists `stop`/`target`/`out` exits. Then break `backend/strategies/ema_cross.py` (add `raise ValueError("x")` in `on_bar`), rerun — the results pane must show the 422 detail with file + bar info. Revert the file.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/BacktestButton.tsx
git commit -m "feat(frontend): run coded strategies from the backtest button"
```

---

### Task 12: Live engine + live panel support

**Files:**
- Modify: `frontend/src/lib/liveEngine.ts` (cycle: series build + request, ~lines 78–108)
- Modify: `frontend/src/LiveTradingPanel.tsx` (strategy summary, ~lines 75–165)
- Test: extend `frontend/src/lib/liveEngine.test.ts`

**Interfaces:**
- Consumes: `EvaluateRequest.codedStrategy` (Task 9), backend Task 8.
- Behavior: when the frozen live cfg has `mode === "coded"` — `buildSeries` is skipped (`series: {}`), rule groups sent empty, `codedStrategy` set. The panel shows the strategy name instead of rule summaries. A hedged strategy surfaces the backend's 422 as the cycle error (no special frontend handling).

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/lib/liveEngine.test.ts` (follow the file's existing harness — it injects `deps` with mocked `buildSeries`/`evaluateStrategy`; copy the setup of an existing "cycle" test):

```typescript
  it("coded mode skips buildSeries and posts codedStrategy", async () => {
    // Clone an existing passing cycle-test setup, then:
    const cfg = { ...baseCfg, mode: "coded" as const, codedStrategy: "ema_cross.py" };
    // ... run the cycle with the mocked deps as the neighboring tests do ...
    expect(deps.buildSeries).not.toHaveBeenCalled();
    const req = (deps.evaluateStrategy as Mock).mock.calls[0][0];
    expect(req.codedStrategy).toBe("ema_cross.py");
    expect(req.series).toEqual({});
    expect(req.longEntry.rules).toEqual([]);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run src/lib/liveEngine.test.ts`
Expected: the new test FAILs (buildSeries called, codedStrategy undefined)

- [ ] **Step 3: Implement**

In `frontend/src/lib/liveEngine.ts` cycle function: branch around the `deps.buildSeries(...)` call —

```typescript
  const coded = cfg.mode === "coded" && !!cfg.codedStrategy;
  const series = coded
    ? {}
    : await deps.buildSeries(/* existing args unchanged */);
```

And in the `EvaluateRequest` object construction:

```typescript
    codedStrategy: coded ? cfg.codedStrategy : undefined,
    longEntry: coded ? { combine: "AND", rules: [] } : activeGroup(cfg.longEntry),
    longExit: coded ? { combine: "AND", rules: [] } : activeGroup(cfg.longExit),
    shortEntry: coded ? { combine: "AND", rules: [] } : activeGroup(cfg.shortEntry),
    shortExit: coded ? { combine: "AND", rules: [] } : activeGroup(cfg.shortExit),
    longRisk: coded ? undefined : cfg.longRisk,
    shortRisk: coded ? undefined : cfg.shortRisk,
```

In `frontend/src/LiveTradingPanel.tsx`, where the rule summaries render (the `entry`/`exit`/`risk` reads at ~lines 77–79): when `cfg.mode === "coded"`, render instead a compact summary block:

```tsx
  {cfg.mode === "coded" ? (
    <div className="live-strat-summary">
      <span className="strat-picker-name">{cfg.codedStrategy ?? "no strategy selected"}</span>
      <p className="strat-picker-desc">Coded strategy — entries, exits and risk are defined in the file.</p>
    </div>
  ) : (
    /* existing rule summaries, unchanged */
  )}
```

- [ ] **Step 4: Run the live suites + typecheck**

Run: `cd frontend && npx vitest run src/lib/liveEngine.test.ts src/lib/liveHelpers.test.ts src/lib/liveState.test.ts && npx tsc -b`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/liveEngine.ts frontend/src/LiveTradingPanel.tsx frontend/src/lib/liveEngine.test.ts
git commit -m "feat(live): run coded strategies through the live engine"
```

---

### Task 13: Signal popover renders note values

**Files:**
- Modify: `frontend/src/BacktestSignalPopover.tsx`
- Test: extend `frontend/src/BacktestSignalPopover.test.tsx`

**Interfaces:**
- Consumes: markers whose `terms` carry note-shaped entries (`op === ""` and `right === ""`, from Task 5's `_note_terms`).
- Behavior: a term with an empty `op` renders as `label value` (a plain key/value line) instead of `left op right`; everything else unchanged.

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/BacktestSignalPopover.test.tsx` (mirror the setup of an existing terms-rendering test in that file):

```tsx
  it("renders note-style terms (empty op) as plain key/value", () => {
    // Build a marker whose terms include {left: "rsi", lval: 71.23, op: "", right: "", rval: null}
    // using the same render harness as the surrounding tests.
    // Assert "rsi" and "71.23" are visible, and no dangling operator glyph renders.
  });
```

Write the actual assertion code following the file's existing patterns (it already renders term rows; copy one test and change the term fixture + expectations).

- [ ] **Step 2: Run to verify it fails (or exposes broken rendering)**

Run: `cd frontend && npx vitest run src/BacktestSignalPopover.test.tsx`
Expected: the new test FAILs (an empty-op term renders an empty operator cell or crashes)

- [ ] **Step 3: Implement**

In `frontend/src/BacktestSignalPopover.tsx`, in the term-row render, branch on `term.op === ""`:

```tsx
  {t.op === "" ? (
    <>
      <span className="bt-sig-term-label">{t.left}</span>
      <span className="bt-sig-term-val">{fmtVal(t.lval)}</span>
    </>
  ) : (
    /* existing left / op / right rendering, unchanged */
  )}
```

(Use the file's existing value formatter and class names — match whatever the current term row uses.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run src/BacktestSignalPopover.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/BacktestSignalPopover.tsx frontend/src/BacktestSignalPopover.test.tsx
git commit -m "feat(frontend): signal popover renders coded-strategy note values"
```

---

## Phase 4 — MTF ad-hoc (`ctx.ema(9, tf="HOUR_4")`) + slope

### Task 14: Python MTF alignment + slope, parity-verified

**Files:**
- Create: `backend/auto_trader/indicators/mtf.py`
- Modify: `frontend/src/lib/indicatorParityGolden.test.ts` (extend the fixture)
- Modify: `backend/tests/test_indicator_parity.py` (extend)

**Interfaces:**
- Produces (`auto_trader.indicators.mtf`):
  - `align_htf_to_base(base_times_ms: Sequence[int], htf_candles: Sequence[Candle], htf_values: Sequence[float | None], htf_ms: int) -> list[float | None]` — port of `alignHtfToChart` with `waitClose=true` (an HTF bar is usable only at/after its CLOSE — the no-lookahead crux).
  - `slope_of(raw: Sequence[float | None], n: int, bar_hours: float) -> list[float | None]` — port of `backtestSeries.ts slopeOf`: `(v[i] − v[i−n]) / |v[i−n]| / (n × barHours) × 100` (%/hr), None for the first n bars / missing values / zero denominator.
- Consumed by: Task 15.

- [ ] **Step 1: Extend the golden generator**

In `frontend/src/lib/indicatorParityGolden.test.ts`:
- Aggregate the 500 hourly candles into 4-hour HTF candles inside the test (group by `Math.floor(i/4)`: open = first open, close = last close, high = max, low = min, volume = sum, timestamp = group's first timestamp).
- Compute `EMA_9` on the HTF candles via `maSeries(htf, "ema", 9, {}).base`, then `alignHtfToChart(baseTimestamps, htf, htfEma, 4 * 3600_000, true)` (import `alignHtfToChart` from `./mtf`).
- Compute a slope series: port call `slopeOf` is not exported from `backtestSeries.ts` — inline the same formula in the generator over the base EMA_9 with `n=3, barHours=1`.
- Add to the fixture: `"htfCandles": [...]` (same candle shape), `"series"` gains `"EMA_9@HOUR_4": [...]` and `"EMA_9~3": [...]`.

Run: `cd frontend && npx vitest run src/lib/indicatorParityGolden.test.ts`
Expected: PASS, fixture regenerated with the two new arrays.

- [ ] **Step 2: Write the failing Python parity tests**

Add to `backend/tests/test_indicator_parity.py`:

```python
def test_mtf_alignment(golden_raw):  # add a golden_raw fixture returning the parsed JSON dict
    data = golden_raw
    base_times_ms = [c["time"] * 1000 for c in data["candles"]]
    htf = [
        Candle(
            time=datetime.fromtimestamp(c["time"], tz=timezone.utc),
            open=c["open"], high=c["high"], low=c["low"], close=c["close"], volume=c["volume"],
        )
        for c in data["htfCandles"]
    ]
    from auto_trader.indicators.mtf import align_htf_to_base
    htf_ema = ema_series([c.close for c in htf], 9)
    aligned = align_htf_to_base(base_times_ms, htf, htf_ema, 4 * 3600 * 1000)
    assert_series_equal(aligned, data["series"]["EMA_9@HOUR_4"], "EMA_9@HOUR_4")


def test_slope(golden):
    candles, _, series = golden
    from auto_trader.indicators.mtf import slope_of
    ema9 = ema_series([c.close for c in candles], 9)
    assert_series_equal(slope_of(ema9, 3, 1.0), series["EMA_9~3"], "EMA_9~3")
```

Run: `cd backend && uv run pytest tests/test_indicator_parity.py -v`
Expected: the two new tests FAIL (`No module named 'auto_trader.indicators.mtf'`)

- [ ] **Step 3: Implement**

```python
# backend/auto_trader/indicators/mtf.py
"""MTF alignment + slope, ported from the frontend (mtf.ts alignHtfToChart with
waitClose=true, backtestSeries.ts slopeOf). The closed-bar rule is the whole
point: a base bar must never see an HTF bar that closes in its future, or the
strategy gains hindsight."""

from __future__ import annotations

from collections.abc import Sequence

from auto_trader.core.models import Candle


def align_htf_to_base(
    base_times_ms: Sequence[int],
    htf_candles: Sequence[Candle],
    htf_values: Sequence[float | None],
    htf_ms: int,
) -> list[float | None]:
    """Each base bar at time t takes the value of the most recent HTF bar whose
    CLOSE (open timestamp + htf_ms) is at or before t. Inputs sorted ascending;
    htf_values[i] corresponds to htf_candles[i]."""
    out: list[float | None] = [None] * len(base_times_ms)
    j = -1
    for i, t in enumerate(base_times_ms):
        while j + 1 < len(htf_candles):
            usable_at = int(htf_candles[j + 1].time.timestamp() * 1000) + htf_ms
            if usable_at <= t:
                j += 1
            else:
                break
        if j >= 0:
            out[i] = htf_values[j]
    return out


def slope_of(
    raw: Sequence[float | None], n: int, bar_hours: float
) -> list[float | None]:
    """Tangent rate of change in percent per HOUR over n bars (time-normalized so
    slopes on different timeframes compare directly):
        (v[i] − v[i−n]) / |v[i−n]| / (n × bar_hours) × 100
    None for the first n bars, wherever raw is None, or a zero denominator."""
    out: list[float | None] = [None] * len(raw)
    for i, v in enumerate(raw):
        if i < n or v is None:
            continue
        prev = raw[i - n]
        if prev is None or prev == 0:
            continue
        out[i] = (v - prev) / abs(prev) / (n * bar_hours) * 100
    return out
```

Also add the `golden_raw` module fixture to the parity test file:

```python
@pytest.fixture(scope="module")
def golden_raw():
    return json.loads(FIXTURE.read_text())
```

- [ ] **Step 4: Run to verify all parity tests pass**

Run: `cd backend && uv run pytest tests/test_indicator_parity.py -v`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/indicators/mtf.py backend/tests/test_indicator_parity.py frontend/src/lib/indicatorParityGolden.test.ts backend/tests/fixtures/indicator_golden.json
git commit -m "feat(indicators): MTF alignment + slope in Python, parity-verified"
```

---

### Task 15: `tf=` on ctx indicators via a fetch-retry loop

Ad-hoc code means the needed timeframes aren't known until the code runs. `ctx.ema(9, tf="HOUR_4")` with no HTF data raises `NeedTimeframe`; the route catches it, fetches that timeframe's candles (same seam the chart uses: `deps._fetch_symbol_candles`), and re-runs. Runs are stateless, so re-running is safe; the loop converges in ≤ (number of distinct TFs) passes.

**Files:**
- Modify: `backend/auto_trader/strategy/coded.py` (ctx `tf=` support, `NeedTimeframe`, `htf_candles` param)
- Modify: `backend/auto_trader/api/schemas.py` (`BacktestRequest`/`EvaluateRequest` gain `broker: str = "capital"` and `priceSide: str = "mid"`)
- Modify: `backend/auto_trader/api/routers/backtest.py` (retry loop)
- Modify: `backend/auto_trader/api/routers/strategy.py` (retry loop)
- Modify: `frontend/src/BacktestButton.tsx` + `frontend/src/lib/liveEngine.ts` (send `broker`/`priceSide` when coded)
- Test: `backend/tests/test_coded_strategy_mtf.py`

**Interfaces:**
- Produces:
  - `class NeedTimeframe(Exception)` in `coded.py` with `.timeframe: str` — raised by an indicator call whose `tf` has no candles yet.
  - `CodedStrategy.__init__(..., htf_candles: dict[str, list[Candle]] | None = None)` — per-TF candle lists; ctx indicator methods gain `tf: str | None = None`. A `tf` call computes the indicator on that TF's candles and aligns via `align_htf_to_base` (memoized under `f"{key}@{tf}"`).
  - `ctx.slope(indicator: str, length: int | None, n: int, tf: str | None = None) -> float | None` — e.g. `ctx.slope("EMA", 9, 3)` or `ctx.slope("close", None, 1)`; %/hr per the app's slope contract; memoized under `f"{key}~{n}@{tf}"`.
  - Route loop (both routes): run; on `NeedTimeframe(tf)` fetch that TF over `[first_base_bar_time, last_base_bar_time]` via `deps._fetch_symbol_candles(req.broker, req.epic, tf, bars=1000, from_ts, to_ts, req.priceSide)`, add to `htf_candles`, rebuild the strategy, re-run; cap at 5 passes → 422 "too many timeframes".
- Test doubles: monkeypatch `deps._fetch_symbol_candles` to serve aggregated HTF candles from the posted base candles.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_coded_strategy_mtf.py
"""ctx indicator tf= support: NeedTimeframe raised when the TF's candles are
absent; values match align_htf_to_base when present; the backtest route's
fetch-retry loop feeds it."""

import types
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

import auto_trader.api.deps as deps
import auto_trader.strategy.loader as loader
from auto_trader.api.app import app
from auto_trader.core.models import Candle
from auto_trader.indicators.core import ema_series
from auto_trader.indicators.mtf import align_htf_to_base
from auto_trader.strategy.base import Context
from auto_trader.strategy.coded import CodedStrategy, NeedTimeframe


def hourly(n=64):
    t0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
    out = []
    px = 100.0
    for i in range(n):
        px += 0.5 if i % 3 else -0.5
        out.append(Candle(time=t0 + timedelta(hours=i), open=px, high=px + 1,
                          low=px - 1, close=px + 0.3, volume=10))
    return out


def aggregate_4h(base: list[Candle]) -> list[Candle]:
    out = []
    for g in range(0, len(base), 4):
        chunk = base[g:g + 4]
        out.append(Candle(
            time=chunk[0].time, open=chunk[0].open,
            high=max(c.high for c in chunk), low=min(c.low for c in chunk),
            close=chunk[-1].close, volume=sum(c.volume for c in chunk),
        ))
    return out


def module_from(fn):
    mod = types.ModuleType("user_strategy_test")
    mod.on_bar = fn
    return mod


def test_missing_tf_raises_need_timeframe():
    candles = hourly()
    strat = CodedStrategy(module_from(lambda ctx: [ctx.buy()] if ctx.ema(9, tf="HOUR_4") else []),
                          candles, quantity=1.0)
    ctx = Context()
    ctx.history = candles[:20]
    with pytest.raises(NeedTimeframe) as ei:
        strat.on_bar(ctx)
    assert ei.value.timeframe == "HOUR_4"


def test_tf_value_matches_alignment():
    candles = hourly()
    htf = aggregate_4h(candles)
    seen = {}

    def on_bar(ctx):
        i = len(ctx.closes) - 1
        if i == 40:
            seen["v"] = ctx.ema(9, tf="HOUR_4")
        return []

    strat = CodedStrategy(module_from(on_bar), candles, quantity=1.0,
                          htf_candles={"HOUR_4": htf})
    ctx = Context()
    for i in range(41):
        ctx.history = candles[: i + 1]
        strat.on_bar(ctx)
    base_ms = [int(c.time.timestamp() * 1000) for c in candles]
    expected = align_htf_to_base(base_ms, htf, ema_series([c.close for c in htf], 9),
                                 4 * 3600 * 1000)
    assert seen["v"] == expected[40]


def test_slope_matches_contract():
    candles = hourly()
    seen = {}

    def on_bar(ctx):
        i = len(ctx.closes) - 1
        if i == 40:
            seen["v"] = ctx.slope("EMA", 9, 3)
        return []

    strat = CodedStrategy(module_from(on_bar), candles, quantity=1.0)
    ctx = Context()
    for i in range(41):
        ctx.history = candles[: i + 1]
        strat.on_bar(ctx)
    from auto_trader.indicators.mtf import slope_of
    expected = slope_of(ema_series([c.close for c in candles], 9), 3, 1.0)
    assert seen["v"] == expected[40]


MTF_STRAT = '''def on_bar(ctx):
    fast = ctx.ema(9, tf="HOUR_4")
    if fast is None:
        return []
    if ctx.position.is_flat and ctx.close > fast:
        return [ctx.buy(reason="above 4h ema")]
    if ctx.position.is_long and ctx.close < fast:
        return [ctx.close_long(reason="below 4h ema")]
    return []
'''


def test_backtest_route_fetch_retry_loop(tmp_path, monkeypatch):
    (tmp_path / "mtf.py").write_text(MTF_STRAT)
    monkeypatch.setattr(loader, "STRATEGIES_DIR", tmp_path)
    base = hourly()

    async def fake_fetch(broker_id, epic, resolution, bars, from_ts, to_ts, price_side):
        assert resolution == "HOUR_4"
        return aggregate_4h(base)

    monkeypatch.setattr(deps, "_fetch_symbol_candles", fake_fetch)

    empty = {"combine": "AND", "rules": []}
    req = {
        "epic": "TEST", "resolution": "HOUR",
        "candles": [{"time": int(c.time.timestamp()), "open": c.open, "high": c.high,
                     "low": c.low, "close": c.close, "volume": c.volume} for c in base],
        "series": {},
        "longEntry": empty, "longExit": empty, "shortEntry": empty, "shortExit": empty,
        "costs": {"quantity": 1, "commissionPerSide": 0, "slippage": 0, "startingCash": 10000},
        "tradeFromTime": int(base[0].time.timestamp()),
        "codedStrategy": "mtf.py", "broker": "capital", "priceSide": "mid",
    }
    with TestClient(app) as client:
        res = client.post("/api/backtest", json=req)
    assert res.status_code == 200, res.text
    assert res.json()["summary"]["n_trades"] >= 1
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && uv run pytest tests/test_coded_strategy_mtf.py -v`
Expected: FAIL — `ImportError: cannot import name 'NeedTimeframe'`

- [ ] **Step 3: Implement `coded.py` changes**

Add near the top of `backend/auto_trader/strategy/coded.py`:

```python
from auto_trader.core.candle_aggregate import resolution_seconds
from auto_trader.indicators.mtf import align_htf_to_base, slope_of


class NeedTimeframe(Exception):
    """An indicator was asked for a timeframe whose candles aren't loaded yet.
    The route catches this, fetches that TF, and re-runs (runs are stateless)."""

    def __init__(self, timeframe: str) -> None:
        super().__init__(f"need candles for timeframe '{timeframe}'")
        self.timeframe = timeframe
```

`CodedStrategy.__init__` gains `htf_candles: dict[str, list[Candle]] | None = None`, stored as `self.htf_candles = htf_candles or {}`, and passes itself into each `StrategyContext` (add a `strategy` arg) so ctx can reach `htf_candles` + base times.

In `StrategyContext`, generalize `_series` and the indicator methods:

```python
    def _values_for(self, key: str, tf: str | None, values_fn) -> list[float | None]:
        """The full memoized series for `key` on `tf` (None = base). `values_fn`
        computes it over a given candle list (causal — index i sees 0..i only)."""
        cache_key = f"{key}@{tf}" if tf else key
        arr = self._cache.get(cache_key)
        if arr is not None:
            return arr
        if tf is None:
            arr = values_fn(self._candles)
        else:
            htf = self._strategy.htf_candles.get(tf)
            if htf is None:
                raise NeedTimeframe(tf)
            base_ms = self._strategy.base_times_ms  # precompute in CodedStrategy.__init__
            htf_ms = resolution_seconds(tf) * 1000
            arr = align_htf_to_base(base_ms, htf, values_fn(htf), htf_ms)
        self._cache[cache_key] = arr
        return arr

    def ema(self, length: int, tf: str | None = None) -> float | None:
        return self._values_for(
            f"EMA_{length}", tf,
            lambda cs: ema_series([c.close for c in cs], length),
        )[self._i]
```

Rewrite `sma`, `rsi`, `atr`, `avwap`, `volma` the same way (each takes `tf: str | None = None`; `atr`/`avwap` pass the candle list straight through; `volma` maps volumes). Add `base_times_ms` to `CodedStrategy.__init__`:

```python
        self.base_times_ms = [int(c.time.timestamp() * 1000) for c in candles]
```

Add `ctx.slope`:

```python
    _SLOPE_SOURCES = {"EMA": ema_series, "SMA": sma_series, "RSI": rsi_series}

    def slope(self, indicator: str, length: int | None, n: int,
              tf: str | None = None) -> float | None:
        """%/hr slope over n bars of an indicator ("EMA"/"SMA"/"RSI" + length) or
        a price field ("close"/"open"/"high"/"low", length=None) — same formula
        and time normalization as the rule builder's slope operands. The slope is
        taken on the operand's NATIVE timeframe before alignment (backtestSeries
        rule), so tf= slopes difference HTF values, not forward-filled ones."""
        tf_key = tf or self._strategy.base_timeframe
        bar_hours = (resolution_seconds(tf_key) if tf_key else 3600) / 3600
        if indicator in self._SLOPE_SOURCES and length is not None:
            fn = self._SLOPE_SOURCES[indicator]
            key = f"{indicator}_{length}~{n}"
            values_fn = lambda cs: slope_of(fn([c.close for c in cs], length), n, bar_hours)
        elif indicator in ("close", "open", "high", "low"):
            key = f"{indicator}~{n}"
            values_fn = lambda cs: slope_of([getattr(c, indicator) for c in cs], n, bar_hours)
        else:
            raise StrategyRuntimeError(f"unknown slope source '{indicator}'")
        return self._values_for(key, tf, values_fn)[self._i]
```

`CodedStrategy.__init__` also gains `base_timeframe: str | None = None` (the run's resolution string, passed by both routes) for the slope's bar-hours; `NeedTimeframe` must NOT be swallowed by the on_bar try/except — re-raise it before the generic handler:

```python
        except NeedTimeframe:
            raise
        except Exception as e:
            ...
```

- [ ] **Step 4: Implement the route loops + request fields**

`schemas.py`: add to BOTH `BacktestRequest` and `EvaluateRequest`:

```python
    # Broker/price side for backend-side HTF fetches (coded strategies' tf= calls).
    broker: str = "capital"
    priceSide: str = "mid"
```

`routers/backtest.py`: replace the single coded run with a retry loop (rule path untouched):

```python
    if req.codedStrategy is not None:
        htf_candles: dict[str, list[Candle]] = {}
        for _ in range(5):
            strategy = CodedStrategy(
                module, candles, quantity=req.costs.quantity,
                trade_from_time=req.tradeFromTime, htf_candles=htf_candles,
                base_timeframe=req.resolution,
            )
            engine = BacktestEngine(strategy, ...)  # same kwargs as before
            try:
                result = engine.run(candles)
                break
            except NeedTimeframe as need:
                fetched = await deps._fetch_symbol_candles(
                    req.broker, req.epic, need.timeframe, 1000,
                    req.candles[0].time, req.candles[-1].time, req.priceSide,
                )
                if not fetched:
                    raise HTTPException(422, f"no candles for timeframe '{need.timeframe}'")
                htf_candles[need.timeframe] = fetched
            except StrategyRuntimeError as e:
                raise HTTPException(422, str(e))
        else:
            raise HTTPException(422, "strategy needs too many timeframes (max 5)")
```

(Import `deps` and `NeedTimeframe`; hoist the module-load above the loop. `deps._fetch_symbol_candles` returns `list[Candle]` — verify its return type when implementing and convert if it returns DTOs.) Apply the same loop shape to `routers/strategy.py` around `strategy.on_bar(ctx)`.

Frontend: in `BacktestButton.tsx` and `liveEngine.ts`, add to the coded-mode request: `broker: brokerId, priceSide` (both already in scope in BacktestButton; in liveEngine use the cycle's broker/priceSide equivalents — grep the file for where `fetchRange`-style calls get them). Add `broker?: string; priceSide?: string;` to the `BacktestRequest`/`EvaluateRequest` interfaces in `api.ts`.

- [ ] **Step 5: Run everything**

Run: `cd backend && uv run pytest -q && cd ../frontend && npx tsc -b && npx vitest run`
Expected: ALL PASS

- [ ] **Step 6: Update the example strategy to show MTF (optional flourish, keeps docs honest)**

Append to `backend/strategies/ema_cross.py`'s docstring: `"Higher-timeframe values: ctx.ema(9, tf=\"HOUR_4\"); slopes: ctx.slope(\"EMA\", 9, 3)."`

- [ ] **Step 7: Commit**

```bash
git add backend/auto_trader/strategy/coded.py backend/auto_trader/api/schemas.py backend/auto_trader/api/routers/backtest.py backend/auto_trader/api/routers/strategy.py backend/tests/test_coded_strategy_mtf.py backend/strategies/ema_cross.py frontend/src/api.ts frontend/src/BacktestButton.tsx frontend/src/lib/liveEngine.ts
git commit -m "feat(strategy): ad-hoc MTF (tf=) + slope on ctx via fetch-retry loop"
```

---

### Task 16: Final verification + memory

- [ ] **Step 1: Full suites**

Run: `cd backend && uv run pytest -q`
Expected: ALL PASS
Run: `cd frontend && npx tsc -b && npx vitest run && npm run lint`
Expected: ALL PASS, no lint errors

- [ ] **Step 2: Manual end-to-end (real app, user's dev servers)**

1. Backtest panel → Strategy → EMA Cross + RSI → Run: markers/trades/equity render; entry popover shows note values.
2. Edit the file in the IDE (change the RSI threshold), ⟳ reload, rerun: results change.
3. Live panel: pick the coded strategy on a paper/demo account, start, confirm one evaluate cycle passes (or errors legibly).
4. A hedged test file: confirm the badge in the picker and the live 422.

- [ ] **Step 3: Save a memory**

Write a `coded-strategies` memory file (type: project) covering: files-on-disk model, the parity fixture regeneration flow (frontend vitest test writes the golden JSON), the NeedTimeframe retry loop, and the netted/stateless contract. Add the MEMORY.md pointer line.

- [ ] **Step 4: Commit anything outstanding**

```bash
git status --short   # should be clean except the memory (which lives outside the repo)
```

---

## Self-Review (completed)

- **Spec coverage:** indicator layer (T2), no-TA-lib (T2 docstring + plan constraint), parity suite incl. MTF+slope (T1, T14), loader/discovery (T3), ctx API + actions + brackets (T4, T5), stateless/netted/memoized traps (T5 + constraints), /api/strategies + source (T6), backtest wiring + errors (T7), live wiring + hedged refusal (T8), frontend switch/picker/description/view-source (T9, T10), run path (T11), live engine + panel (T12), note popover (T13), MTF ad-hoc (T14, T15). Description precedence (meta → docstring → hint): T3 + T10.
- **Type consistency:** `Action(kind, leg, qty, stop, target, reason, note)` used identically in T5 tests and implementation; `Signal.stop_level/target_level` defined T4, consumed T5/T8; `StrategyInfo` DTO shape identical in T6 (backend) and T9 (frontend); `codedStrategy` field name identical across schemas/routes/frontend.
- **Placeholders:** T12 step 1 and T13 step 1 intentionally say "mirror the file's existing harness" for test *setup* (those harnesses are bespoke; cloning a neighboring test is the correct instruction) — the *assertions* are fully specified.
