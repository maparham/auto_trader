# Indicator Value Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Server-side alerts on indicator values (price vs an MA line, RSI/ATR/MA vs a number), evaluated on bar close or intrabar, plus "Once per bar" replacing the 5 bps re-arm for every "every" alert.

**Architecture:** The engine stops hard-coding price levels: each alert kind implements an `AlertKind` protocol (`core/alert_kinds.py`) that validates params and resolves a `(subject, level)` pair per sample; one evaluator (`core/alert_eval.py`) decides crossings and once-per-bar for every kind. Indicator alerts read bars from `core/alert_indicators.py` (`IndicatorHub`), which keeps one `BarSeries` (`core/alert_bars.py`) per (broker, epic, timeframe, price side), seeded and tail-refreshed through the same `CANDLE_CACHE` the charts read, and computes values with the existing batch functions in `indicators/core.py` via the alertable registry `indicators/alertable.py`. The frontend mirrors the alertable registry, adds an indicator mode to `AlertModal`, entry points on the indicator, sync on indicator edit/remove, and pane rendering.

**Tech Stack:** Python 3 / FastAPI / SQLite (backend), React + TypeScript + klinecharts + vitest (frontend).

**Spec:** `docs/superpowers/specs/2026-10-10-indicator-value-alerts-design.md`. Read it before starting; this plan argues from it.

## Global Constraints

- Work on the current branch (`main`). Never create a branch, never `git stash`/`clean`/`restore`; other sessions share this worktree. Stage files by explicit path only.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Never push.
- No em dashes ("—") or "--" in any UI text or user-facing strings.
- Tooltips use `Tooltip` (`frontend/src/components/Tooltip.tsx`) or `InfoTip` (`frontend/src/components/InfoTip.tsx`); never a native `title=`. Tooltip text is short scannable lines (`string[]`), not paragraphs.
- Frontend tests: run ONLY the affected test files (`cd frontend && npx vitest run <file>`), never the whole suite. Type check is `cd frontend && npx tsc -b` (not `--noEmit`); lint is `npx eslint <files>`. Batch heavy commands (tsc, eslint, pytest) into one run per task; the user works on the same laptop.
- Backend tests: `cd backend && .venv/bin/python -m pytest <files> -q`.
- v1 alertable indicators: `MA` (from the chart's EMA and MA templates), `RSI`, `ATR`. `AVWAP`, `BOLL`, `MACD` and plain VWAP are refused (422) and shown disabled with "coming later".
- v1 indicator alert timeframes: native only (`MINUTE, MINUTE_5, MINUTE_15, MINUTE_30, HOUR, HOUR_4, DAY, WEEK`). `SECOND_*` and derived timeframes are 422.
- Seed cap 2000 bars; max warm-up 1950 bars (422 "length too long for alerts" above it).
- Validation matrix (spec "Validation matrix"):
  - MA: calcParams `[length]` int 1..1000; config `maType` in `ema, sma, vwma, evwma`, `source` in `close, open, high, low, hl2, hlc3, ohlc4`; lines `value`; target=price allowed.
  - RSI: `[length]` int 2..1000; config `source` (as MA, default `close`); lines `value`; value target only.
  - ATR: `[length]` int 1..1000; config `smoothing` in `rma, sma, ema, wma` (default `rma`); lines `value`; value target only.
- `trigger = every` means at most once per bar of the alert's timeframe, for price and indicator alerts. `greater`/`less` fire again on each new bar while true. Price alerts without a timeframe, or with a sub-minute one, use 1 minute.
- `waiting_for_data` status broadcasts only after holding 10 s.
- Intrabar indicator values recompute at most once per second per (series, indicator).
- VWMA/EVWMA (volume-weighted MA kinds) on quote-only (non-streaming) brokers: `evalOn = intrabar` is a 422 and the dialog disables "As it happens".

## Review Focus

1. A price alert set to "every" on a 1m chart that chops around the level: must fire at most once per minute, and a backend restart inside that minute must not fire it again. Pinned in Task 6 (`test_every_fires_once_per_bar_and_restart_does_not_refire`).
2. An EMA line rising through a flat price (price unchanged between samples): "crossing" must fire. Pinned in Task 1 (`test_moving_line_crosses_stationary_subject`).
3. A broker fetch failing at bar close (`degraded`): no close-mode alert may evaluate on a bar built from samples, and the alert reports waiting. Pinned in Task 4 (`test_close_refresh_degraded_holds_previous_close`).
4. Two chart cells each showing an EMA (both instance ids "EMA"): editing one cell's EMA must only touch that cell's alerts. Pinned in Task 11 (`linkedAlerts matches scope and instanceId`).
5. An indicator alert created on a non-native or seconds chart: the UI must not offer it and the API must refuse it. Pinned in Task 3 (`test_indicator_non_native_timeframe_422`) and Task 10 (`non-native timeframe gives a coming-later reason; seconds hide the entry`).

---

## File map

Backend (`backend/auto_trader/`):
- `core/alert_eval.py` (rewrite): pair-based crossing + once-per-bar decision. Pure.
- `core/alert_bars.py` (new): `period_start`, `Sample`, `BarSeries` (forming bar, close/gap detection, tail replace). Pure, no I/O.
- `indicators/alertable.py` (new): the alertable-indicator registry: validation, warm-up, compute (calls `indicators/core.py`), labels.
- `core/alert_kinds.py` (new): `AlertKind` protocol, `PriceLevelKind`, `IndicatorKind`, `KINDS`.
- `core/alert_indicators.py` (new): `IndicatorHub`: series registry, seeding/refresh via an injected loader, cached values, readiness, intrabar throttle.
- `core/alert_engine.py` (modify): use kinds + hub, pair baselines, close baselines, once-per-bar, restart rebuild, status + debounced broadcast, `on_tick` keyword args.
- `core/alert_store.py` (modify): `list_triggered` returns `alert_json`; `last_fired_times()`.
- `api/routers/alerts.py` (modify): validation through `KINDS`, merged-params PATCH validation, `status` and `alert` in responses.
- `api/deps.py` (modify): `load_alert_bars` loader over `CANDLE_CACHE.recent`.
- `api/app.py` (modify): pass the loader to `ALERT_ENGINE.configure`.
- `core/telegram_notify.py`, `core/push_notify.py`, `core/alert_chart.py` (modify): use `label`; no level line for value targets.
- `scripts/alert_probe.py` (modify): `--indicator`.

Frontend (`frontend/`): see Tasks 10 to 16.

Tests: `backend/tests/test_alert_eval.py` (rewrite), `test_alert_bars.py` (new), `test_alertable.py` (new), `test_alert_kinds.py` (new), `test_alert_indicators.py` (new), `test_alert_engine.py` (modify), `test_alert_engine_feeds.py` (modify), `test_alerts_api.py` (modify), `test_alert_store.py` (modify), `test_indicator_parity.py` (new), fixtures under `backend/tests/fixtures/indicator_parity/`.

---

### Task 1: Pair-based evaluator with once-per-bar

Replaces the 5 bps re-arm. Spec: "Evaluation", "Once per bar".

**Files:**
- Modify (rewrite): `backend/auto_trader/core/alert_eval.py`
- Modify (minimal adapter only; fully rewritten in Task 6): `backend/auto_trader/core/alert_engine.py` (`on_tick`'s `evaluate_alert` call site)
- Test (rewrite): `backend/tests/test_alert_eval.py`

**Interfaces:**
- Produces:
  - `Pair = tuple[float, float]` (subject, level)
  - `condition_hit(prev: Pair | None, cur: Pair, condition: str) -> bool`
  - `evaluate_alert(prev: Pair | None, cur: Pair, condition: str, trigger: str, bar_open: int, last_fired_bar: int | None) -> EvalResult`
  - `EvalResult(fired: bool, remove: bool)` (frozen dataclass; `next_armed` is gone)

- [ ] **Step 1: Write the failing tests** (replace the whole file)

```python
"""Pins the pair-based evaluator: crossings compare the SIGN of
(subject - level) before and after, so either side may move; "every" fires at
most once per bar (bar_open vs last_fired_bar)."""
import math

from auto_trader.core.alert_eval import EvalResult, condition_hit, evaluate_alert

BAR = 1_000_000  # an arbitrary bar open (ms)


def ev(prev, cur, condition="crossing", trigger="every", bar_open=BAR, last=None):
    return evaluate_alert(prev, cur, condition, trigger, bar_open, last)


def test_first_sample_never_fires_crossing():
    assert ev(None, (101, 100)).fired is False

def test_crossing_up_fires():
    r = ev((99, 100), (101, 100))
    assert r == EvalResult(True, False)

def test_crossing_down_fires():
    assert ev((101, 100), (99, 100)).fired

def test_crossing_up_only():
    assert ev((99, 100), (101, 100), "crossing_up").fired
    assert not ev((101, 100), (99, 100), "crossing_up").fired

def test_crossing_down_only():
    assert ev((101, 100), (99, 100), "crossing_down").fired
    assert not ev((99, 100), (101, 100), "crossing_down").fired

def test_touch_without_cross_does_not_fire():
    assert not ev((99, 100), (100, 100)).fired

def test_moving_line_crosses_stationary_subject():
    # Price flat at 100; the line rises from 99 to 101 -> subject goes from
    # above the line to below it: a crossing down.
    assert ev((100, 99), (100, 101), "crossing_down").fired
    assert ev((100, 101), (100, 99), "crossing_up").fired

def test_touch_without_cross_both_sides_moving():
    # gap goes -1 -> 0: a touch, not a cross
    assert not ev((99, 100), (100.5, 100.5)).fired

def test_greater_fires_with_no_prev():
    assert ev(None, (101, 100), "greater").fired

def test_less_fires_with_no_prev():
    assert ev(None, (99, 100), "less").fired

def test_greater_not_satisfied():
    assert not ev(None, (99, 100), "greater").fired

def test_once_fire_requests_removal():
    assert ev((99, 100), (101, 100), trigger="once") == EvalResult(True, True)

def test_every_blocked_within_the_fired_bar():
    assert not ev((99, 100), (101, 100), bar_open=BAR, last=BAR).fired

def test_every_fires_again_next_bar_on_fresh_cross():
    assert ev((101, 100), (99, 100), bar_open=BAR + 60_000, last=BAR).fired

def test_greater_fires_once_per_bar_while_true():
    assert ev((101, 100), (102, 100), "greater", bar_open=BAR + 60_000, last=BAR).fired
    assert not ev((101, 100), (102, 100), "greater", bar_open=BAR, last=BAR).fired

def test_nonfinite_inputs_never_fire():
    assert ev((99, 100), (math.nan, 100)) == EvalResult(False, False)
    assert ev((99, 100), (101, math.inf)) == EvalResult(False, False)
    assert not condition_hit((math.nan, 100), (101, 100), "crossing")
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && .venv/bin/python -m pytest tests/test_alert_eval.py -q`
Expected: FAIL (ImportError: cannot import name 'condition_hit').

- [ ] **Step 3: Implement** (replace the whole file)

```python
"""Pure alert evaluation: one decision for every alert kind.

Each sample is a `(subject, level)` pair: price vs a fixed level for
price-level alerts, price vs an indicator line, or an indicator line vs a
number. A crossing compares the sign of `subject - level` before and after,
so it holds whichever side moved. `trigger = every` fires at most once per bar
of the alert's timeframe: the caller passes the current bar's open and the bar
the alert last fired in. This module is the single implementation (the old
frontend twin is gone).
"""
from __future__ import annotations

import math
from dataclasses import dataclass

Pair = tuple[float, float]


@dataclass(frozen=True)
class EvalResult:
    fired: bool
    remove: bool


def _finite(p: Pair) -> bool:
    return math.isfinite(p[0]) and math.isfinite(p[1])


def condition_hit(prev: Pair | None, cur: Pair, condition: str) -> bool:
    """`greater`/`less` read the current pair alone (may fire on the first
    sample); crossings need a previous pair. `<=`/`>=` on the BEFORE gap keep
    the touch-then-cross semantics: a gap of 0 then >0 is a cross up, but a
    gap going to exactly 0 is only a touch."""
    if not _finite(cur):
        return False
    now = cur[0] - cur[1]
    if condition == "greater":
        return now > 0
    if condition == "less":
        return now < 0
    if prev is None or not _finite(prev):
        return False
    before = prev[0] - prev[1]
    up = before <= 0 < now
    down = before >= 0 > now
    if condition == "crossing":
        return up or down
    if condition == "crossing_up":
        return up
    if condition == "crossing_down":
        return down
    return False


def evaluate_alert(
    prev: Pair | None,
    cur: Pair,
    condition: str,
    trigger: str,
    bar_open: int,
    last_fired_bar: int | None,
) -> EvalResult:
    if last_fired_bar is not None and bar_open <= last_fired_bar:
        return EvalResult(False, False)
    if not condition_hit(prev, cur, condition):
        return EvalResult(False, False)
    return EvalResult(True, trigger == "once")
```

- [ ] **Step 4: Patch the engine's call site (minimal adapter, so main keeps working)**

`alert_eval.py`'s signature just changed from the old 6-arg
`evaluate_alert(prev_price, price, level, condition, trigger, armed) ->
EvalResult(fired, remove, next_armed)` to the pair-based one above; the engine
(`core/alert_engine.py`, `on_tick`) still calls the old shape, so EVERY tick
raises until Task 6 rewrites the engine properly. Patch just the call site
(not the surrounding `armed`/`_armed` bookkeeping, which Task 6 removes) so
the dev backend (running under `--reload`) does not go dark for price alerts
between this commit and Task 6's:

```python
            result = evaluate_alert(
                (prev, params.get("level")) if prev is not None else None,
                (price, params.get("level")),
                params.get("condition"), params.get("trigger"),
                0, None,  # temporary: no once-per-bar gate until Task 6
            )

            if result.fired and not self._is_snoozed(state_key, now_ms):
```

(Delete the two lines that read `result.next_armed` - that field is gone.
`bar_open=0, last_fired_bar=None` means the once-per-bar gate never blocks
yet, so "every" alerts keep their OLD re-fire-on-every-tick behavior for the
few minutes until Task 6 lands; they do not raise, and no price alert goes
silent. Task 6 replaces this whole block.)

- [ ] **Step 5: Run to verify pass**

Run: `cd backend && .venv/bin/python -m pytest tests/test_alert_eval.py -q`
Expected: all pass. (`test_alert_engine.py` still has its old every-rearm
test against the old engine behavior; Task 6 replaces that test. Do not run
`test_alert_engine.py` yet.)

- [ ] **Step 6: Commit**

```bash
git add backend/auto_trader/core/alert_eval.py backend/auto_trader/core/alert_engine.py \
  backend/tests/test_alert_eval.py
git commit -m "feat(alerts): pair-based evaluator with once-per-bar

Every-time alerts now fire at most once per candle of their timeframe
instead of re-arming after a 5 bps move.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Bar clock and BarSeries

Spec: "Feed data", "One bar clock".

**Files:**
- Create: `backend/auto_trader/core/alert_bars.py`
- Test: `backend/tests/test_alert_bars.py`

**Interfaces:**
- Consumes: `core.candle_aggregate.rule_for(res) -> BucketRule | None`, `bucket_open(ts_seconds, rule) -> int`; `core.timeframe.canonicalize`, `parse`, `is_native`; `core.models.Candle`, `Resolution`.
- Produces:
  - `alert_resolution(timeframe: str | None) -> str`: canonical timeframe, `"MINUTE"` when missing, invalid or sub-minute.
  - `period_start(t_ms: int, resolution: str) -> int` (ms)
  - `candle_ms(c: Candle) -> int`
  - `@dataclass(frozen=True) Sample(t_ms: int, mid: float, bid: float | None, ask: float | None, bar: Candle | None = None)`
  - `class Roll(Enum): NONE, CLOSED, GAP`
  - `class BarSeries(resolution: str, side: str, cap: int = 2000)` with `closed: list[Candle]`, `forming: Candle | None`, `forming_open_ms: int | None`, `seed(bars, now_ms)`, `replace_tail(bars, now_ms)`, `on_sample(s: Sample) -> Roll`, `with_forming() -> list[Candle]`.

- [ ] **Step 1: Write the failing tests**

```python
from datetime import datetime, timezone

from auto_trader.core.alert_bars import (
    BarSeries, Roll, Sample, alert_resolution, candle_ms, period_start,
)
from auto_trader.core.models import Candle

H = 3_600_000
M = 60_000


def c(ms, o, h, l, cl, v=0.0):
    return Candle(datetime.fromtimestamp(ms / 1000, tz=timezone.utc), o, h, l, cl, v)


def test_alert_resolution_defaults_and_sub_minute():
    assert alert_resolution(None) == "MINUTE"
    assert alert_resolution("SECOND_5") == "MINUTE"
    assert alert_resolution("garbage") == "MINUTE"
    assert alert_resolution("HOUR") == "HOUR"
    assert alert_resolution("1H") == "HOUR"


def test_period_start_native():
    t = 10 * H + 17 * M + 5_000
    assert period_start(t, "HOUR") == 10 * H
    assert period_start(t, "MINUTE_15") == 10 * H + 15 * M
    assert period_start(t, "DAY") == 0


def test_period_start_derived_folds_like_the_candles_api():
    # 2023-11-14 22:50:20 UTC, hardcoded independently (not restated via
    # period_start/rule_for, which would make this tautological): HOUR_2
    # buckets every even hour, MINUTE_3 every 3 minutes, HOUR_6 resets at
    # 00:00 UTC (buckets at 00/06/12/18).
    t = 1_700_000_000_000 + 37 * M
    assert period_start(t, "HOUR_2") == 1_699_999_200_000    # 2023-11-14 22:00 UTC
    assert period_start(t, "MINUTE_3") == 1_700_002_080_000  # 2023-11-14 22:48 UTC
    assert period_start(t, "HOUR_6") == 1_699_984_800_000    # 2023-11-14 18:00 UTC


def test_keep_closed_is_broker_offset_safe():
    # Some brokers offset their 4H/daily bars from UTC midnight
    # (candle_aggregate.py's HOUR rule_for comment), so a broker bar need not
    # align to our own epoch grid. A bar that opened at 05:00 and runs 4h is
    # still forming at 08:30 even though our epoch-aligned HOUR_4 grid point
    # (08:00) already lies after its open: "closed" must mean a full
    # resolution has elapsed since the bar's OWN open, not "before our grid's
    # current boundary".
    s = BarSeries("HOUR_4", "mid", cap=10)
    bars = [c(1 * H, 1, 1, 1, 1), c(5 * H, 1, 1, 1, 2)]  # opens 01:00, 05:00
    now = 8 * H + 30 * M  # 08:30: the 05:00-09:00 bar has 30 minutes left
    s.seed(bars, now)
    assert [candle_ms(b) for b in s.closed] == [1 * H]


def test_on_sample_builds_forming_then_closes_on_roll():
    s = BarSeries("HOUR", "mid")
    assert s.on_sample(Sample(10 * H + 1_000, 100.0, None, None)) is Roll.NONE
    s.on_sample(Sample(10 * H + 2_000, 103.0, None, None))
    s.on_sample(Sample(10 * H + 3_000, 98.0, None, None))
    f = s.forming
    assert (f.open, f.high, f.low, f.close) == (100.0, 103.0, 98.0, 98.0)
    assert s.on_sample(Sample(11 * H + 1_000, 99.0, None, None)) is Roll.CLOSED
    assert s.forming_open_ms == 11 * H


def test_skipped_period_is_a_gap():
    s = BarSeries("HOUR", "mid")
    s.on_sample(Sample(10 * H, 100.0, None, None))
    assert s.on_sample(Sample(12 * H + 5, 100.0, None, None)) is Roll.GAP


def test_bid_side_shifts_forming_by_half_spread():
    s = BarSeries("HOUR", "bid")
    s.on_sample(Sample(10 * H, 100.0, 99.5, 100.5))
    assert s.forming.close == 99.5


def test_stream_bar_volume_sums_per_minute_not_per_update():
    s = BarSeries("HOUR", "mid")
    s.on_sample(Sample(10 * H + 1, 100.0, None, None, bar=c(10 * H, 100, 101, 99, 100, 5)))
    s.on_sample(Sample(10 * H + 2, 100.0, None, None, bar=c(10 * H, 100, 102, 99, 101, 7)))
    s.on_sample(Sample(10 * H + M, 101.0, None, None, bar=c(10 * H + M, 101, 101, 100, 100, 3)))
    assert s.forming.volume == 10  # 7 (last update of minute 0) + 3
    assert s.forming.high == 102


def test_seed_and_replace_tail_keep_only_closed_bars():
    s = BarSeries("HOUR", "mid", cap=3)
    now = 13 * H + 5
    bars = [c(i * H, 1, 1, 1, i) for i in range(9, 14)]  # 13h is still forming
    s.seed(bars, now)
    assert [candle_ms(b) for b in s.closed] == [10 * H, 11 * H, 12 * H]
    s.replace_tail([c(12 * H, 1, 1, 1, 99), c(13 * H, 1, 1, 1, 5)], now)
    assert s.closed[-1].close == 99 and len(s.closed) == 3
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && .venv/bin/python -m pytest tests/test_alert_bars.py -q`
Expected: FAIL (ModuleNotFoundError: auto_trader.core.alert_bars).

- [ ] **Step 3: Implement**

```python
"""Bars for alerts: the one bar clock and a per-series forming bar.

`period_start` is the only definition of "which bar is this sample in", used
by the once-per-bar rule for every alert and by `BarSeries` to detect a bar
close. Derived timeframes bucket exactly like the candles API
(`candle_aggregate.bucket_open`). `BarSeries` never invents closed bars: the
forming bar is built from live samples for intrabar use only, and closed bars
arrive through `seed`/`replace_tail` from the candle cache.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum

from auto_trader.core import timeframe as _tf
from auto_trader.core.candle_aggregate import bucket_open, rule_for
from auto_trader.core.models import Candle, Resolution

_DAY = 86_400
_WEEK = 7 * _DAY
_MONDAY_OFFSET = 4 * _DAY  # the epoch was a Thursday


def alert_resolution(timeframe: str | None) -> str:
    """Canonical bar timeframe for an alert; 1 minute when missing, invalid or
    finer than a minute."""
    if not timeframe:
        return "MINUTE"
    try:
        res = _tf.canonicalize(timeframe)
        if _tf.parse(res).unit == "SECOND":
            return "MINUTE"
        return res
    except _tf.TimeframeError:
        return "MINUTE"


def _native_open(ts: int, res: str) -> int:
    if res == "WEEK":
        return ((ts - _MONDAY_OFFSET) // _WEEK) * _WEEK + _MONDAY_OFFSET
    secs = Resolution(res).seconds
    return ts - ts % secs


def period_start(t_ms: int, resolution: str) -> int:
    res = alert_resolution(resolution)
    ts = t_ms // 1000
    rule = rule_for(res)
    if rule is None:
        return _native_open(ts, res) * 1000
    return bucket_open(_native_open(ts, rule.base.value), rule) * 1000


def candle_ms(c: Candle) -> int:
    return int(c.time.timestamp() * 1000)


@dataclass(frozen=True)
class Sample:
    t_ms: int
    mid: float
    bid: float | None
    ask: float | None
    bar: Candle | None = None  # the stream's 1-minute mid bar, when streaming


class Roll(Enum):
    NONE = "none"
    CLOSED = "closed"
    GAP = "gap"


class BarSeries:
    def __init__(self, resolution: str, side: str, cap: int = 2000) -> None:
        self.resolution = alert_resolution(resolution)
        self.side = side
        self.cap = cap
        self.closed: list[Candle] = []
        self.forming: Candle | None = None
        self.forming_open_ms: int | None = None
        self._minute_vol: dict[int, float] = {}

    def _keep_closed(self, bars: list[Candle], now_ms: int) -> list[Candle]:
        # A full resolution must have elapsed since the bar's OWN open, not
        # merely "before our epoch grid's current boundary": some brokers
        # offset their 4H/daily bars from UTC midnight (candle_aggregate.py's
        # HOUR rule_for comment), so a broker bar need not sit on our grid at
        # all. Comparing elapsed time instead of grid position is safe either
        # way (see test_keep_closed_is_broker_offset_safe).
        span_ms = _tf.seconds(self.resolution) * 1000
        return [b for b in bars if candle_ms(b) + span_ms <= now_ms]

    def seed(self, bars: list[Candle], now_ms: int) -> None:
        self.closed = self._keep_closed(bars, now_ms)[-self.cap:]

    def replace_tail(self, bars: list[Candle], now_ms: int) -> None:
        fresh = self._keep_closed(bars, now_ms)
        if not fresh:
            return
        first = candle_ms(fresh[0])
        kept = [b for b in self.closed if candle_ms(b) < first]
        self.closed = (kept + fresh)[-self.cap:]

    def _shift(self, s: Sample) -> float:
        if self.side == "bid" and s.bid is not None:
            return s.bid - s.mid
        if self.side == "ask" and s.ask is not None:
            return s.ask - s.mid
        return 0.0

    def on_sample(self, s: Sample) -> Roll:
        open_ms = period_start(s.t_ms, self.resolution)
        roll = Roll.NONE
        if self.forming_open_ms is not None and open_ms > self.forming_open_ms:
            nxt = period_start(
                self.forming_open_ms + _tf.seconds(self.resolution) * 1000, self.resolution
            )
            roll = Roll.GAP if open_ms > nxt else Roll.CLOSED
            self.forming = None
            self._minute_vol = {}
        self.forming_open_ms = open_ms

        shift = self._shift(s)
        if s.bar is not None:
            b = s.bar
            o, h, l, c = b.open + shift, b.high + shift, b.low + shift, b.close + shift
            self._minute_vol[candle_ms(b)] = b.volume or 0.0
        else:
            o = h = l = c = s.mid + shift
        vol = sum(self._minute_vol.values())
        f = self.forming
        t = datetime.fromtimestamp(open_ms / 1000, tz=timezone.utc)
        if f is None:
            self.forming = Candle(t, o, h, l, c, vol)
        else:
            self.forming = Candle(t, f.open, max(f.high, h), min(f.low, l), c, vol)
        return roll

    def with_forming(self) -> list[Candle]:
        return self.closed + ([self.forming] if self.forming is not None else [])
```

Note: `Candle` is a dataclass; if it is frozen with `slots`, the constructor call above still works (positional fields `time, open, high, low, close, volume`).

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && .venv/bin/python -m pytest tests/test_alert_bars.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/core/alert_bars.py backend/tests/test_alert_bars.py
git commit -m "feat(alerts): bar clock and forming-bar series for alerts

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Alertable registry, alert kinds, API validation

Spec: "Data model", "Validation matrix", "Design principles" (open/closed kinds). One task because the router's tests are the deliverable that proves both.

**Files:**
- Create: `backend/auto_trader/indicators/alertable.py`
- Create: `backend/auto_trader/core/alert_kinds.py`
- Modify: `backend/auto_trader/api/routers/alerts.py` (`_KINDS`, `_CONDITIONS`, `_TRIGGERS`, `_validate_kind`, `_validate_params`, `create_alert`, `patch_alert`)
- Test: `backend/tests/test_alertable.py`, `backend/tests/test_alert_kinds.py`, `backend/tests/test_alerts_api.py` (append)

**Interfaces:**
- Consumes: `indicators.slope.ma_base(candles, ma_type, length, source)`, `indicators.core.rsi_series, atr_smoothed_series, price_of`; `core.alert_bars.alert_resolution`; `core.timeframe.is_native, label, canonicalize`.
- Produces (`indicators/alertable.py`):
  - `SEED_CAP = 2000`, `MAX_WARMUP = 1950`
  - `@dataclass(frozen=True) IndicatorKey(indicator: str, calc: tuple[float, ...], config: tuple[tuple[str, str], ...])` with `IndicatorKey.of(params) -> IndicatorKey`
  - `validate_indicator(indicator, calc_params, config, line, target) -> dict` (returns config with defaults filled; raises `ValueError(msg)`)
  - `warmup(key: IndicatorKey) -> int`
  - `compute(key: IndicatorKey, candles: Sequence[Candle]) -> dict[str, list[float | None]]`
  - `volume_weighted(key: IndicatorKey) -> bool`
  - `indicator_label(key: IndicatorKey) -> str` (e.g. `"EMA 50"`, `"RSI 14"`, `"ATR 14"`)
  - `ALERTABLE: dict[str, dict]` (the JSON-able shape used for the cross-side parity test: per indicator `{"lines", "priceTarget", "params", "config"}`)
- Produces (`core/alert_kinds.py`):
  - `class AlertKind(Protocol)`: `validate(params: dict, streams: Callable[[], bool]) -> None` (mutates params to canonical form, raises `ValueError`), `bar_resolution(params) -> str`, `eval_on(params) -> str`, `indicator_key(params) -> IndicatorKey | None`, `resolve(params, price: float, values: dict[str, float | None] | None) -> Pair | None`, `label(params) -> str | None`, `sig(params) -> str`, `payload_extras(params, pair) -> dict`
  - `PRICE_LEVEL: PriceLevelKind`, `INDICATOR: IndicatorKind`, `KINDS: dict[str, AlertKind] = {"price_level": ..., "indicator": ...}`, `kind_of(row: dict) -> AlertKind | None`
  - `CONDITIONS`, `TRIGGERS` frozensets.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_alertable.py`:

```python
import pytest

from auto_trader.indicators import alertable as A


def key(ind, calc, **cfg):
    return A.IndicatorKey(ind, tuple(calc), tuple(sorted(cfg.items())))


def test_validate_fills_defaults():
    assert A.validate_indicator("MA", [50], {"maType": "ema"}, "value", "price") == {
        "maType": "ema", "source": "close",
    }
    assert A.validate_indicator("ATR", [14], {}, "value", "value") == {"smoothing": "rma"}


@pytest.mark.parametrize("args,msg", [
    (("BOLL", [20, 2], {}, "upper", "price"), "not alertable"),
    (("MA", [0], {"maType": "ema"}, "value", "price"), "calcParams"),
    (("MA", [50.5], {"maType": "ema"}, "value", "price"), "calcParams"),
    (("MA", [50], {"maType": "hull"}, "value", "price"), "maType"),
    (("MA", [50], {"maType": "ema", "bogus": "x"}, "value", "price"), "config.bogus"),
    (("MA", [50], {"maType": "ema"}, "upper", "price"), "line"),
    (("RSI", [14], {}, "value", "price"), "target"),
    (("RSI", [1], {}, "value", "value"), "calcParams"),
    (("MA", [50, 1], {"maType": "ema"}, "value", "price"), "calcParams"),
    (("MA", [True], {"maType": "ema"}, "value", "price"), "calcParams"),
])
def test_validate_rejects(args, msg):
    with pytest.raises(ValueError, match=msg):
        A.validate_indicator(*args)


def test_warmup_rejects_too_long():
    with pytest.raises(ValueError, match="too long"):
        A.validate_indicator("RSI", [400], {}, "value", "value")


def test_warmup_figures():
    assert A.warmup(key("MA", [20], maType="sma", source="close")) == 20
    assert 170 <= A.warmup(key("MA", [50], maType="ema", source="close")) <= 180
    assert A.warmup(key("RSI", [14], source="close")) > A.warmup(key("MA", [14], maType="ema", source="close"))


def test_compute_and_label():
    from datetime import datetime, timedelta, timezone
    from auto_trader.core.models import Candle
    t0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
    bars = [Candle(t0 + timedelta(hours=i), 1, 2, 0.5, float(i), 10) for i in range(30)]
    out = A.compute(key("MA", [3], maType="sma", source="close"), bars)
    assert out["value"][-1] == pytest.approx((27 + 28 + 29) / 3)
    assert A.indicator_label(key("MA", [50], maType="ema", source="close")) == "EMA 50"
    assert A.indicator_label(key("MA", [50], maType="sma", source="hl2")) == "SMA 50 hl2"
    assert A.indicator_label(key("RSI", [14], source="close")) == "RSI 14"
    assert A.volume_weighted(key("MA", [5], maType="vwma", source="close"))
```

`backend/tests/test_alert_kinds.py`:

```python
import pytest

from auto_trader.core.alert_kinds import INDICATOR, KINDS, PRICE_LEVEL, kind_of

STREAMS = lambda: True  # noqa: E731
POLLS = lambda: False  # noqa: E731


def ind_params(**kw):
    p = {
        "indicator": "MA", "calcParams": [50], "config": {"maType": "ema"},
        "line": "value", "timeframe": "HOUR", "target": "price", "value": None,
        "condition": "crossing_up", "trigger": "every", "evalOn": "close",
        "link": {"scope": "tab.t1.cell.c2", "instanceId": "EMA"},
    }
    p.update(kw)
    return p


def test_registry_has_both_kinds():
    assert set(KINDS) == {"price_level", "indicator"}
    assert kind_of({"kind": "nope"}) is None
    assert kind_of({}) is PRICE_LEVEL


def test_price_level_resolution_and_resolve():
    p = {"level": 100.0, "condition": "crossing", "trigger": "every"}
    PRICE_LEVEL.validate(p, STREAMS)
    assert PRICE_LEVEL.bar_resolution(p) == "MINUTE"
    assert PRICE_LEVEL.resolve(p, 101.0, None) == (101.0, 100.0)
    assert PRICE_LEVEL.label(p) is None


def test_indicator_validate_canonicalizes():
    p = ind_params(timeframe="1H")
    INDICATOR.validate(p, STREAMS)
    assert p["timeframe"] == "HOUR"
    assert p["config"] == {"maType": "ema", "source": "close"}


@pytest.mark.parametrize("override,msg", [
    ({"timeframe": "HOUR_2"}, "timeframe"),
    ({"timeframe": "SECOND_5"}, "timeframe"),
    ({"evalOn": "sometimes"}, "evalOn"),
    ({"target": "value", "value": None}, "value"),
    ({"target": "value", "value": "70"}, "value"),
    ({"condition": "near"}, "condition"),
    ({"link": {"scope": 3}}, "link"),
])
def test_indicator_validate_rejects(override, msg):
    with pytest.raises(ValueError, match=msg):
        INDICATOR.validate(ind_params(**override), STREAMS)


def test_volume_weighted_intrabar_refused_on_quote_only():
    p = ind_params(config={"maType": "vwma"}, evalOn="intrabar")
    with pytest.raises(ValueError, match="intrabar"):
        INDICATOR.validate(p, POLLS)
    INDICATOR.validate(ind_params(config={"maType": "vwma"}, evalOn="intrabar"), STREAMS)


def test_indicator_resolve_targets():
    price = ind_params()
    assert INDICATOR.resolve(price, 101.0, {"value": 100.0}) == (101.0, 100.0)
    val = ind_params(indicator="RSI", calcParams=[14], config={}, target="value", value=70)
    assert INDICATOR.resolve(val, 101.0, {"value": 72.0}) == (72.0, 70)
    assert INDICATOR.resolve(price, 101.0, {"value": None}) is None


def test_indicator_label_and_sig():
    p = ind_params()
    INDICATOR.validate(p, STREAMS)
    assert INDICATOR.label(p) == "EMA 50 (1H)"
    q = dict(p, calcParams=[100])
    assert INDICATOR.sig(p) != INDICATOR.sig(q)
```

Append to `backend/tests/test_alerts_api.py`:

```python
def _ind_body(**params):
    p = {
        "indicator": "MA", "calcParams": [50], "config": {"maType": "ema"},
        "line": "value", "timeframe": "HOUR", "target": "price", "value": None,
        "condition": "crossing_up", "trigger": "once", "evalOn": "close",
        "link": {"scope": "tab.t1.cell.c2", "instanceId": "EMA"},
    }
    p.update(params)
    return _body(id="al-ind", kind="indicator", params=p)


def test_indicator_create_round_trip(clerk):
    r = client.post("/api/alerts", json=_ind_body(), headers=_auth("alice"))
    assert r.status_code == 200, r.text
    assert r.json()["params"]["config"] == {"maType": "ema", "source": "close"}


def test_indicator_non_native_timeframe_422(clerk):
    r = client.post("/api/alerts", json=_ind_body(timeframe="HOUR_2"), headers=_auth("alice"))
    assert r.status_code == 422 and "timeframe" in r.text
    r = client.post("/api/alerts", json=_ind_body(timeframe="SECOND_5"), headers=_auth("alice"))
    assert r.status_code == 422


def test_deferred_indicator_422(clerk):
    r = client.post("/api/alerts", json=_ind_body(indicator="BOLL", calcParams=[20, 2]), headers=_auth("alice"))
    assert r.status_code == 422 and "not alertable" in r.text


def test_indicator_patch_validates_merged_params(clerk):
    client.post("/api/alerts", json=_ind_body(), headers=_auth("alice"))
    r = client.patch("/api/alerts/al-ind", json={"params": {"calcParams": [100]}}, headers=_auth("alice"))
    assert r.status_code == 200 and r.json()["params"]["calcParams"] == [100]
    r = client.patch("/api/alerts/al-ind", json={"params": {"calcParams": [0]}}, headers=_auth("alice"))
    assert r.status_code == 422


def test_unknown_config_key_422(clerk):
    body = _ind_body(config={"maType": "ema", "bogus": "x"})
    r = client.post("/api/alerts", json=body, headers=_auth("alice"))
    assert r.status_code == 422 and "config.bogus" in r.text


def test_vwma_intrabar_422_on_quote_only_broker(clerk):
    # dukascopy is a real registered data-only broker with no credentials
    # needed in tests (supports_streaming=False); capital (the default body
    # broker) streams, so this is the one case that actually exercises
    # `_streams`/`supports_streaming` end to end through the router.
    body = _ind_body(config={"maType": "vwma"}, evalOn="intrabar")
    body["broker"] = "dukascopy"
    r = client.post("/api/alerts", json=body, headers=_auth("alice"))
    assert r.status_code == 422 and "intrabar" in r.text
```

(The broker in `_body` is `capital`, which streams; `streams` is only consulted for VWMA/EVWMA intrabar, so most of these tests never touch a broker - `test_vwma_intrabar_422_on_quote_only_broker` is the exception, and is the one that actually proves the 422 path works end to end.)

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && .venv/bin/python -m pytest tests/test_alertable.py tests/test_alert_kinds.py tests/test_alerts_api.py -q`
Expected: FAIL (ModuleNotFoundError for the two new modules; new API tests 422 on `unknown alert kind`).

- [ ] **Step 3: Implement `indicators/alertable.py`**

```python
"""Indicators an alert may watch: validation, warm-up, computation, labels.

The single backend definition. The frontend mirror is
frontend/src/lib/alertableIndicators.ts; tests/test_indicator_parity.py
asserts both export the same `ALERTABLE` shape. Values come from the batch
functions in indicators/core.py (the same ones backtests use), so there is
no second implementation of any indicator.
"""
from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from auto_trader.core.models import Candle
from auto_trader.indicators.core import atr_smoothed_series, price_of, rsi_series
from auto_trader.indicators.slope import ma_base

SEED_CAP = 2000
MAX_WARMUP = SEED_CAP - 50

_SOURCES = ("close", "open", "high", "low", "hl2", "hlc3", "ohlc4")

# indicator -> lines, price-target allowed, calcParams int ranges, config
# options (first option is the default).
ALERTABLE: dict[str, dict[str, Any]] = {
    "MA": {
        "lines": ["value"], "priceTarget": True, "params": [[1, 1000]],
        "config": {"maType": ["ema", "sma", "vwma", "evwma"], "source": list(_SOURCES)},
    },
    "RSI": {
        "lines": ["value"], "priceTarget": False, "params": [[2, 1000]],
        "config": {"source": list(_SOURCES)},
    },
    "ATR": {
        "lines": ["value"], "priceTarget": False, "params": [[1, 1000]],
        "config": {"smoothing": ["rma", "sma", "ema", "wma"]},
    },
}


@dataclass(frozen=True)
class IndicatorKey:
    indicator: str
    calc: tuple[float, ...]
    config: tuple[tuple[str, str], ...]

    @classmethod
    def of(cls, params: dict) -> IndicatorKey:
        return cls(
            params["indicator"],
            tuple(params["calcParams"]),
            tuple(sorted(params["config"].items())),
        )

    def cfg(self, name: str) -> str:
        return dict(self.config)[name]


def _bars_to_decay(alpha: float) -> int:
    """Bars until a recursive average's starting value weighs < 0.1%."""
    if alpha >= 1:
        return 1
    return math.ceil(math.log(1e-3) / math.log(1 - alpha))


def warmup(key: IndicatorKey) -> int:
    n = int(key.calc[0])
    if key.indicator == "MA":
        kind = key.cfg("maType")
        if kind in ("sma", "vwma"):
            return n
        if kind == "ema":
            return _bars_to_decay(2 / (n + 1))
        return n + _bars_to_decay(1 / n)  # evwma: ~1/n weight per bar
    if key.indicator == "RSI":
        return n + 1 + _bars_to_decay(1 / n)
    smoothing = key.cfg("smoothing")
    if smoothing == "rma":
        return n + 1 + _bars_to_decay(1 / n)
    if smoothing == "ema":
        return n + 1 + _bars_to_decay(2 / (n + 1))
    return n + 1


def validate_indicator(
    indicator: Any, calc_params: Any, config: Any, line: Any, target: Any
) -> dict[str, str]:
    spec = ALERTABLE.get(indicator) if isinstance(indicator, str) else None
    if spec is None:
        raise ValueError(f"params.indicator {indicator!r} is not alertable")
    ranges = spec["params"]
    if (
        not isinstance(calc_params, list) or len(calc_params) != len(ranges)
        or any(isinstance(v, bool) or not isinstance(v, int) for v in calc_params)
        or any(not (lo <= v <= hi) for v, (lo, hi) in zip(calc_params, ranges))
    ):
        raise ValueError(f"params.calcParams must be {len(ranges)} integer(s) in {ranges}")
    if not isinstance(config, dict):
        raise ValueError("params.config must be an object")
    unknown = set(config) - set(spec["config"])
    if unknown:
        bad = sorted(unknown)[0]
        raise ValueError(f"params.config.{bad} is not a known option for {indicator}")
    out: dict[str, str] = {}
    for name, options in spec["config"].items():
        value = config.get(name, options[0])
        if value not in options:
            raise ValueError(f"params.config.{name} must be one of {options}")
        out[name] = value
    if line not in spec["lines"]:
        raise ValueError(f"params.line must be one of {spec['lines']}")
    if target not in ("price", "value"):
        raise ValueError("params.target must be 'price' or 'value'")
    if target == "price" and not spec["priceTarget"]:
        raise ValueError(f"params.target 'price' is not allowed for {indicator}")
    key = IndicatorKey(indicator, tuple(calc_params), tuple(sorted(out.items())))
    if warmup(key) > MAX_WARMUP:
        raise ValueError("params.calcParams: length too long for alerts")
    return out


def volume_weighted(key: IndicatorKey) -> bool:
    return key.indicator == "MA" and key.cfg("maType") in ("vwma", "evwma")


def compute(key: IndicatorKey, candles: Sequence[Candle]) -> dict[str, list[float | None]]:
    """Reuses the existing ports: `slope.ma_base` is mtf.ts `maSeries` with a
    source (exactly what an MA with no offset/smoothing/MTF draws),
    `rsi_series` over the source, and `atr_smoothed_series` (which already
    routes rma to Wilder's `atr_series`)."""
    n = int(key.calc[0])
    if key.indicator == "MA":
        return {"value": ma_base(candles, key.cfg("maType"), n, key.cfg("source"))}
    if key.indicator == "RSI":
        return {"value": rsi_series([price_of(c, key.cfg("source")) for c in candles], n)}
    return {"value": atr_smoothed_series(candles, n, key.cfg("smoothing"))}


def indicator_label(key: IndicatorKey) -> str:
    n = int(key.calc[0])
    if key.indicator == "MA":
        src = key.cfg("source")
        base = f"{key.cfg('maType').upper()} {n}"
        return base if src == "close" else f"{base} {src}"
    if key.indicator == "RSI":
        src = key.cfg("source")
        return f"RSI {n}" if src == "close" else f"RSI {n} {src}"
    sm = key.cfg("smoothing")
    return f"ATR {n}" if sm == "rma" else f"ATR {n} {sm}"
```

- [ ] **Step 4: Implement `core/alert_kinds.py`**

```python
"""Alert kinds: everything that differs between price-level and indicator
alerts lives here, behind one protocol. The engine, the evaluator and the
fire path only see `(subject, level)` pairs, so a new kind (events, drawings)
is a new class in this module, not an engine change."""
from __future__ import annotations

import json
import math
from collections.abc import Callable
from typing import Any, Protocol

from auto_trader.core import timeframe as _tf
from auto_trader.core.alert_bars import alert_resolution
from auto_trader.core.alert_eval import Pair
from auto_trader.indicators.alertable import (
    IndicatorKey, indicator_label, validate_indicator, volume_weighted,
)

CONDITIONS = frozenset({"crossing", "crossing_up", "crossing_down", "greater", "less"})
TRIGGERS = frozenset({"once", "every"})
_EVAL_ON = ("close", "intrabar")


def _finite_number(v: Any) -> bool:
    return not isinstance(v, bool) and isinstance(v, (int, float)) and math.isfinite(v)


def _validate_common(params: dict) -> None:
    if params.get("condition") not in CONDITIONS:
        raise ValueError(f"unknown condition: {params.get('condition')!r}")
    if params.get("trigger") not in TRIGGERS:
        raise ValueError(f"unknown trigger: {params.get('trigger')!r}")


class AlertKind(Protocol):
    def validate(self, params: dict, streams: Callable[[], bool]) -> None: ...
    def bar_resolution(self, params: dict) -> str: ...
    def eval_on(self, params: dict) -> str: ...
    def indicator_key(self, params: dict) -> IndicatorKey | None: ...
    def resolve(self, params: dict, price: float, values: dict[str, float | None] | None) -> Pair | None: ...
    def label(self, params: dict) -> str | None: ...
    def sig(self, params: dict) -> str: ...
    def payload_extras(self, params: dict, pair: Pair) -> dict: ...


class PriceLevelKind:
    def validate(self, params: dict, streams: Callable[[], bool]) -> None:
        # Strict type check (not just float()-coercible): a JSON string like
        # "100" would otherwise land in the row as a str and break evaluation.
        if not _finite_number(params.get("level")):
            raise ValueError("params.level must be a finite number")
        _validate_common(params)
        # Optional: the chart timeframe the alert was created from (drives the
        # Telegram snapshot and the once-per-bar clock).
        tf = params.get("timeframe")
        if tf is not None:
            if not isinstance(tf, str) or not (1 <= len(tf) <= 20):
                raise ValueError("params.timeframe must be a short string")
            try:
                params["timeframe"] = _tf.canonicalize(tf)
            except _tf.TimeframeError as e:
                raise ValueError(f"params.timeframe: {e}") from None

    def bar_resolution(self, params: dict) -> str:
        return alert_resolution(params.get("timeframe"))

    def eval_on(self, params: dict) -> str:
        return "intrabar"

    def indicator_key(self, params: dict) -> IndicatorKey | None:
        return None

    def resolve(self, params, price, values):
        return (price, params["level"])

    def label(self, params: dict) -> str | None:
        return None

    def sig(self, params: dict) -> str:
        return f"{params.get('level')}|{params.get('condition')}|{params.get('trigger')}"

    def payload_extras(self, params: dict, pair: Pair) -> dict:
        return {}


class IndicatorKind:
    def validate(self, params: dict, streams: Callable[[], bool]) -> None:
        params["config"] = validate_indicator(
            params.get("indicator"), params.get("calcParams"), params.get("config", {}),
            params.get("line"), params.get("target"),
        )
        _validate_common(params)
        tf = params.get("timeframe")
        try:
            canon = _tf.canonicalize(tf) if isinstance(tf, str) else None
        except _tf.TimeframeError:
            canon = None
        if canon is None or not _tf.is_native(canon):
            raise ValueError("params.timeframe must be a native timeframe (1m to 1W)")
        params["timeframe"] = canon
        if params.get("evalOn") not in _EVAL_ON:
            raise ValueError("params.evalOn must be 'close' or 'intrabar'")
        if params["target"] == "value":
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
        key = IndicatorKey.of(params)
        if params["evalOn"] == "intrabar" and volume_weighted(key) and not streams():
            raise ValueError(
                "params.evalOn 'intrabar' needs live volume; this broker only has quotes"
            )

    def bar_resolution(self, params: dict) -> str:
        return params["timeframe"]

    def eval_on(self, params: dict) -> str:
        return params["evalOn"]

    def indicator_key(self, params: dict) -> IndicatorKey:
        return IndicatorKey.of(params)

    def resolve(self, params, price, values):
        line = (values or {}).get(params["line"])
        if line is None or not math.isfinite(line):
            return None
        if params["target"] == "price":
            return (price, line)
        return (line, params["value"])

    def label(self, params: dict) -> str:
        return f"{indicator_label(IndicatorKey.of(params))} ({_tf.label(params['timeframe'])})"

    def sig(self, params: dict) -> str:
        keys = ("indicator", "calcParams", "config", "line", "target", "value",
                "timeframe", "evalOn", "condition", "trigger")
        return json.dumps({k: params.get(k) for k in keys}, sort_keys=True)

    def payload_extras(self, params: dict, pair: Pair) -> dict:
        return {
            "label": self.label(params),
            "target": params["target"],
            "subject": pair[0],
            "evalOn": params["evalOn"],
        }


PRICE_LEVEL = PriceLevelKind()
INDICATOR = IndicatorKind()
KINDS: dict[str, AlertKind] = {"price_level": PRICE_LEVEL, "indicator": INDICATOR}


def kind_of(row: dict) -> AlertKind | None:
    return KINDS.get(row.get("kind", "price_level"))
```

- [ ] **Step 5: Wire the router** (`backend/auto_trader/api/routers/alerts.py`)

Replace `_KINDS`, `_CONDITIONS`, `_TRIGGERS` and the whole `_validate_params` function, and update `_validate_kind`:

```python
from auto_trader.core.alert_kinds import KINDS
# (remove the now-unused `math` and `canonicalize`/`TimeframeError` imports
#  if nothing else in the file uses them)


def _validate_kind(kind: str) -> None:
    if kind not in KINDS:
        raise HTTPException(422, f"unknown alert kind: {kind!r}")


def _streams(broker: str) -> Callable[[], bool]:
    """Lazy: only VWMA/EVWMA intrabar alerts ask, so price alerts never touch
    the broker registry."""
    def check() -> bool:
        try:
            from ..deps import get_data
            return bool(getattr(get_data(broker), "supports_streaming", False))
        except Exception:
            return False
    return check


def _validate_params(kind: str, params: dict[str, Any], broker: str) -> None:
    try:
        KINDS[kind].validate(params, _streams(broker))
    except ValueError as e:
        raise HTTPException(422, str(e)) from None
```

Add `from collections.abc import Callable` to the imports. In `create_alert` call `_validate_params(body.kind, body.params, body.broker)`. In `patch_alert` validate the MERGED params (the store merges params sub-keys, so a partial patch must be checked as the row it will become) and keep only the validated sub-keys in the patch:

```python
    if "params" in patch:
        existing = await ALERT_STORE.list_user(user)
        current = next((r for r in existing if r["id"] == alert_id), None)
        if current is None:
            raise HTTPException(404, f"alert not found: {alert_id}")
        merged = {**current["params"], **patch["params"]}
        _validate_params(current["kind"], merged, current["broker"])
        patch["params"] = merged
```

- [ ] **Step 6: Run to verify pass**

Run: `cd backend && .venv/bin/python -m pytest tests/test_alertable.py tests/test_alert_kinds.py tests/test_alerts_api.py -q`
Expected: all pass, including every pre-existing API test (their 422 messages for `level`, `condition`, `trigger`, `timeframe` are unchanged).

- [ ] **Step 7: Commit**

```bash
git add backend/auto_trader/indicators/alertable.py backend/auto_trader/core/alert_kinds.py \
  backend/auto_trader/api/routers/alerts.py backend/tests/test_alertable.py \
  backend/tests/test_alert_kinds.py backend/tests/test_alerts_api.py
git commit -m "feat(alerts): alert kinds and the alertable indicator registry

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: IndicatorHub (series, seeding, refresh, values)

Spec: "Feed data", "Seeding", "Indicator computation", "Status reporting".

**Files:**
- Create: `backend/auto_trader/core/alert_indicators.py`
- Test: `backend/tests/test_alert_indicators.py`

**Interfaces:**
- Consumes: Task 2 (`BarSeries`, `Roll`, `Sample`), Task 3 (`IndicatorKey`, `warmup`, `compute`, `SEED_CAP`).
- Produces:
  - `SeriesKey = tuple[str, str, str, str]` (broker, epic, resolution, side)
  - `Loader = Callable[[str, str, str, str, int], Awaitable[tuple[list[Candle], bool]]]` returning `(bars, degraded)`
  - `class IndicatorHub(loader: Loader, clock: Callable[[], float] = time.monotonic, now_ms: Callable[[], int] = ...)`:
    - `set_needs(needs: dict[SeriesKey, set[IndicatorKey]]) -> None`
    - `has_feed(broker: str, epic: str) -> bool`
    - `async on_sample(broker: str, epic: str, s: Sample) -> set[SeriesKey]` (series whose bar closed AND refreshed OK on this sample; NEVER awaits a series's first/cold seed - that runs as a background task (F17) so `on_tick` can't stall on it)
    - `values(key: SeriesKey, ind: IndicatorKey, intrabar: bool) -> dict[str, float | None] | None` (None when not ready)
    - `prev_values(key: SeriesKey, ind: IndicatorKey) -> dict[str, float | None] | None` (the closed bar before the last; None when not ready)
    - `last_closed(key: SeriesKey) -> Candle | None`, `prev_closed(key: SeriesKey) -> Candle | None`
    - `forming_open_ms(key: SeriesKey) -> int | None`
    - `ready(key: SeriesKey, ind: IndicatorKey) -> bool`

- [ ] **Step 1: Write the failing tests**

```python
import asyncio
from datetime import datetime, timezone

from auto_trader.core.alert_bars import Sample
from auto_trader.core.alert_indicators import IndicatorHub
from auto_trader.core.models import Candle
from auto_trader.indicators.alertable import IndicatorKey

H = 3_600_000
SMA3 = IndicatorKey("MA", (3,), (("maType", "sma"), ("source", "close")))
KEY = ("capital", "US100", "HOUR", "mid")


def c(ms, close):
    return Candle(datetime.fromtimestamp(ms / 1000, tz=timezone.utc), close, close, close, close, 1.0)


class FakeLoader:
    def __init__(self, bars):
        self.bars = bars
        self.calls = []
        self.degraded = False

    async def __call__(self, broker, epic, res, side, count):
        self.calls.append(count)
        return [b for b in self.bars][-count:], self.degraded


def make(bars, now):
    loader = FakeLoader(bars)
    t = [0.0]
    hub = IndicatorHub(loader, clock=lambda: t[0], now_ms=lambda: now[0])
    return hub, loader, t


def test_seed_then_values_ready():
    async def main():
        now = [10 * H + 5]
        hub, loader, _ = make([c(i * H, float(i)) for i in range(5, 11)], now)
        hub.set_needs({KEY: {SMA3}})
        await hub.on_sample("capital", "US100", Sample(now[0], 10.0, None, None))
        await asyncio.sleep(0)  # let the backgrounded first seed (F17) run
        assert loader.calls[0] == 3 + 50  # warmup + margin
        assert hub.values(KEY, SMA3, intrabar=False) == {"value": (7 + 8 + 9) / 3}
        assert hub.ready(KEY, SMA3)
    asyncio.run(main())


def test_first_seed_does_not_block_on_sample():
    # F17: the first seed for a brand-new series can fetch up to SEED_CAP
    # bars (mt5's own budget allows up to ~90s) - on_sample must return
    # immediately regardless, so price alerts on the same feed never wait on
    # it. A loader that hangs until released proves on_sample didn't await it.
    async def main():
        now = [10 * H + 5]
        gate = asyncio.Event()

        class SlowLoader:
            async def __call__(self, broker, epic, res, side, count):
                await gate.wait()
                return [c(i * H, float(i)) for i in range(5, 11)], False

        hub = IndicatorHub(SlowLoader(), clock=lambda: 0.0, now_ms=lambda: now[0])
        hub.set_needs({KEY: {SMA3}})
        await asyncio.wait_for(
            hub.on_sample("capital", "US100", Sample(now[0], 10.0, None, None)), timeout=0.5,
        )
        assert not hub.ready(KEY, SMA3)  # the gated loader hasn't returned yet
        gate.set()
        await asyncio.sleep(0)
        assert hub.ready(KEY, SMA3)
    asyncio.run(main())


def test_not_ready_below_warmup():
    async def main():
        now = [10 * H + 5]
        hub, _, _ = make([c(9 * H, 9.0)], now)
        hub.set_needs({KEY: {SMA3}})
        await hub.on_sample("capital", "US100", Sample(now[0], 10.0, None, None))
        assert hub.values(KEY, SMA3, intrabar=False) is None
        assert not hub.ready(KEY, SMA3)
    asyncio.run(main())


def test_bar_close_refreshes_tail_and_reports_closed():
    async def main():
        now = [10 * H + 5]
        bars = [c(i * H, float(i)) for i in range(5, 11)]
        hub, loader, _ = make(bars, now)
        hub.set_needs({KEY: {SMA3}})
        await hub.on_sample("capital", "US100", Sample(now[0], 10.0, None, None))
        await asyncio.sleep(0)  # let the backgrounded first seed (F17) run
        loader.bars = bars + [c(11 * H, 11.0)]
        now[0] = 11 * H + 5
        closed = await hub.on_sample("capital", "US100", Sample(now[0], 11.0, None, None))
        assert closed == {KEY}
        assert hub.last_closed(KEY).close == 10.0
        assert hub.values(KEY, SMA3, intrabar=False) == {"value": (8 + 9 + 10) / 3}
        assert hub.prev_closed(KEY).close == 9.0
        assert hub.prev_values(KEY, SMA3) == {"value": (7 + 8 + 9) / 3}
    asyncio.run(main())


def test_close_refresh_degraded_holds_previous_close():
    async def main():
        now = [10 * H + 5]
        bars = [c(i * H, float(i)) for i in range(5, 11)]
        hub, loader, _ = make(bars, now)
        hub.set_needs({KEY: {SMA3}})
        await hub.on_sample("capital", "US100", Sample(now[0], 10.0, None, None))
        await asyncio.sleep(0)  # let the backgrounded first seed (F17) run
        loader.degraded = True
        now[0] = 11 * H + 5
        closed = await hub.on_sample("capital", "US100", Sample(now[0], 11.0, None, None))
        assert closed == set()
        assert not hub.ready(KEY, SMA3)
        assert hub.last_closed(KEY).close == 9.0  # never a sample-built bar
    asyncio.run(main())


def test_intrabar_values_include_forming_and_throttle():
    async def main():
        now = [10 * H + 5]
        hub, _, t = make([c(i * H, float(i)) for i in range(5, 10)], now)
        hub.set_needs({KEY: {SMA3}})
        await hub.on_sample("capital", "US100", Sample(now[0], 12.0, None, None))
        await asyncio.sleep(0)  # let the backgrounded first seed (F17) run
        assert hub.values(KEY, SMA3, intrabar=True) == {"value": (8 + 9 + 12) / 3}
        await hub.on_sample("capital", "US100", Sample(now[0] + 1, 15.0, None, None))
        assert hub.values(KEY, SMA3, intrabar=True) == {"value": (8 + 9 + 12) / 3}  # throttled
        t[0] = 1.5
        assert hub.values(KEY, SMA3, intrabar=True) == {"value": (8 + 9 + 15) / 3}
    asyncio.run(main())


def test_set_needs_drops_unused_series():
    async def main():
        now = [10 * H + 5]
        hub, _, _ = make([c(i * H, float(i)) for i in range(5, 10)], now)
        hub.set_needs({KEY: {SMA3}})
        assert hub.has_feed("capital", "US100")
        hub.set_needs({})
        assert not hub.has_feed("capital", "US100")
    asyncio.run(main())


def test_gap_reseed_closes_the_bar_that_just_closed():
    # A skipped period (Roll.GAP, e.g. a thin 1m market) still has to report
    # the bar that closed just before the gap as closed, once the reseed's
    # fresh history actually contains it - else close-mode alerts silently
    # never evaluate that bar.
    async def main():
        now = [10 * H + 5]
        bars = [c(i * H, float(i)) for i in range(5, 11)]  # ...9h,10h closed-ish
        hub, loader, _ = make(bars, now)
        hub.set_needs({KEY: {SMA3}})
        await hub.on_sample("capital", "US100", Sample(now[0], 10.0, None, None))
        await asyncio.sleep(0)  # let the backgrounded first seed (F17) run
        # Skip straight to 13h: 11h and 12h never got a sample (Roll.GAP).
        # The fresh history already has the 12h bar closed by the time the
        # reseed's loader call lands.
        loader.bars = bars + [c(11 * H, 11.0), c(12 * H, 12.0)]
        now[0] = 13 * H + 5
        closed = await hub.on_sample("capital", "US100", Sample(now[0], 13.0, None, None))
        assert closed == {KEY}
        assert hub.last_closed(KEY).close == 12.0
    asyncio.run(main())


def test_gap_reseed_without_the_closing_bar_reports_not_closed():
    # Same gap, but the reseed's fresh history still lags behind (the broker
    # fetch returned a stale tail): closed must stay empty rather than firing
    # a close-mode alert against the wrong bar.
    async def main():
        now = [10 * H + 5]
        bars = [c(i * H, float(i)) for i in range(5, 11)]
        hub, loader, _ = make(bars, now)
        hub.set_needs({KEY: {SMA3}})
        await hub.on_sample("capital", "US100", Sample(now[0], 10.0, None, None))
        await asyncio.sleep(0)  # let the backgrounded first seed (F17) run
        loader.bars = bars  # unchanged: the fetch has not caught up yet
        now[0] = 13 * H + 5
        closed = await hub.on_sample("capital", "US100", Sample(now[0], 13.0, None, None))
        assert closed == set()
    asyncio.run(main())


def test_compute_exception_marks_not_ok_instead_of_crashing():
    # A broken indicator computation (e.g. a pathological config that makes
    # the batch function raise) must not escape _recompute: that would blow
    # up on_tick and stall the whole feed, taking every OTHER alert on this
    # (broker, epic) down with it.
    async def main():
        now = [10 * H + 5]
        hub, _, _ = make([c(i * H, float(i)) for i in range(5, 11)], now)
        hub.set_needs({KEY: {SMA3}})

        import auto_trader.core.alert_indicators as alert_indicators_mod

        def boom(ind, bars):
            raise ValueError("boom")

        orig = alert_indicators_mod.compute
        alert_indicators_mod.compute = boom
        try:
            await hub.on_sample("capital", "US100", Sample(now[0], 10.0, None, None))
            await asyncio.sleep(0)  # let the backgrounded first seed (F17) run
        finally:
            alert_indicators_mod.compute = orig
        assert not hub.ready(KEY, SMA3)
        assert hub.values(KEY, SMA3, intrabar=False) is None
    asyncio.run(main())
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && .venv/bin/python -m pytest tests/test_alert_indicators.py -q`
Expected: FAIL (ModuleNotFoundError).

- [ ] **Step 3: Implement**

```python
"""Indicator values for alerts, per (broker, epic, timeframe, price side).

Closed bars only ever come from the injected loader (the app wires it to
CANDLE_CACHE.recent, the path the charts read), so the server sees the bars
the chart sees. A degraded or failed refresh leaves the previous close in
place and marks the series not ready; no alert evaluates a closed bar built
from live samples. Values are the existing batch functions (via
indicators.alertable.compute); intrabar recomputes with the forming bar
appended, at most once a second per (series, indicator).
"""
from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from auto_trader.core.alert_bars import BarSeries, Roll, Sample, candle_ms
from auto_trader.core.models import Candle
from auto_trader.indicators.alertable import SEED_CAP, IndicatorKey, compute, warmup

log = logging.getLogger(__name__)

SeriesKey = tuple[str, str, str, str]
Loader = Callable[[str, str, str, str, int], Awaitable[tuple[list[Candle], bool]]]

_TAIL = 5
_RETRY_SECONDS = 5.0
_INTRABAR_SECONDS = 1.0


def _at(values: dict[str, list[float | None]], back: int) -> dict[str, float | None]:
    return {line: (series[-1 - back] if len(series) > back else None) for line, series in values.items()}


def _last(values: dict[str, list[float | None]]) -> dict[str, float | None]:
    return _at(values, 0)


@dataclass
class _State:
    series: BarSeries
    needs: set[IndicatorKey] = field(default_factory=set)
    seeded_for: int = 0          # warm-up the current seed covers
    ok: bool = False             # last load/refresh succeeded
    pending_close: bool = False  # a close whose refresh failed, retry pending
    pending_bar_ms: int | None = None  # the closed-bar ms a pending refresh must land
    last_try: float = -1e9
    closed_vals: dict[IndicatorKey, dict[str, float | None]] = field(default_factory=dict)
    prev_vals: dict[IndicatorKey, dict[str, float | None]] = field(default_factory=dict)
    intrabar: dict[IndicatorKey, tuple[float, dict[str, float | None]]] = field(default_factory=dict)


class IndicatorHub:
    def __init__(
        self,
        loader: Loader,
        clock: Callable[[], float] = time.monotonic,
        now_ms: Callable[[], int] = lambda: int(time.time() * 1000),
    ) -> None:
        self._loader = loader
        self._clock = clock
        self._now_ms = now_ms
        self._states: dict[SeriesKey, _State] = {}
        self._seeding: set[SeriesKey] = set()  # keys with a background seed in flight

    # ---- registry ----

    def set_needs(self, needs: dict[SeriesKey, set[IndicatorKey]]) -> None:
        for key in list(self._states):
            if key not in needs:
                del self._states[key]
        for key, inds in needs.items():
            st = self._states.get(key)
            if st is None:
                st = self._states[key] = _State(BarSeries(key[2], key[3], cap=SEED_CAP))
            st.needs = set(inds)
            st.closed_vals = {k: v for k, v in st.closed_vals.items() if k in inds}
            st.intrabar = {k: v for k, v in st.intrabar.items() if k in inds}

    def has_feed(self, broker: str, epic: str) -> bool:
        return any(k[0] == broker and k[1] == epic for k in self._states)

    def _warmup(self, st: _State) -> int:
        return max((warmup(k) for k in st.needs), default=0)

    # ---- loading ----

    async def _load(self, key: SeriesKey, count: int) -> list[Candle] | None:
        try:
            bars, degraded = await self._loader(key[0], key[1], key[2], key[3], count)
        except Exception:
            log.warning("alert bars: load failed for %s", key, exc_info=True)
            return None
        return None if degraded or not bars else bars

    async def _seed(self, key: SeriesKey, st: _State) -> None:
        need = self._warmup(st)
        bars = await self._load(key, min(need + 50, SEED_CAP))
        st.last_try = self._clock()
        if bars is None:
            st.ok = False
            return
        st.series.seed(bars, self._now_ms())
        st.seeded_for = need
        st.pending_close = False
        self._recompute(key, st)

    def _spawn_first_seed(self, key: SeriesKey, st: _State) -> None:
        """A brand-new (or just-grown) series's first seed can fetch up to
        SEED_CAP bars (mt5's own fetch budget allows up to ~90s) - run it in
        the background so `on_sample`/`on_tick` never blocks on it. Price
        alerts share the same `on_tick` call for this (broker, epic), so a
        synchronous cold fetch here would stall them too. Idempotent per key:
        a sample that lands while a seed is already in flight is a no-op.
        Subsequent reseeds (a GAP, or a retry after a failed refresh) are on
        an already-warm series and stay inline - see `on_sample` below."""
        if key in self._seeding:
            return
        self._seeding.add(key)

        async def run() -> None:
            try:
                await self._seed(key, st)
            finally:
                self._seeding.discard(key)

        asyncio.ensure_future(run())

    async def _refresh(self, key: SeriesKey, st: _State, expect_closed_ms: int | None) -> bool:
        bars = await self._load(key, _TAIL)
        st.last_try = self._clock()
        if bars is None:
            st.ok, st.pending_close = False, True
            return False
        fresh = st.series._keep_closed(bars, self._now_ms())
        if expect_closed_ms is not None and (not fresh or candle_ms(fresh[-1]) != expect_closed_ms):
            # The cache served a tail that does not yet include the bar that
            # just closed (candle_cache.py can absorb/budget a stale read
            # without flagging `degraded`): hold the previous close rather
            # than let close-mode re-evaluate the same bar twice on the next
            # sample. Retry on the next sample past the retry interval.
            st.ok, st.pending_close = False, True
            return False
        st.series.replace_tail(bars, self._now_ms())
        st.ok, st.pending_close = True, False
        self._recompute(key, st)
        return True

    def _recompute(self, key: SeriesKey, st: _State) -> None:
        bars = st.series.closed
        closed_vals: dict[IndicatorKey, dict[str, float | None]] = {}
        prev_vals: dict[IndicatorKey, dict[str, float | None]] = {}
        try:
            for ind in st.needs:
                out = compute(ind, bars)
                closed_vals[ind], prev_vals[ind] = _at(out, 0), _at(out, 1)
        except Exception:
            # A broken compute must not escape to on_sample/on_tick: that
            # would back off the whole feed and stall every OTHER alert on
            # this (broker, epic), not just this one.
            log.warning("alert indicator compute failed for series %s", key, exc_info=True)
            st.ok = False
            return
        st.closed_vals, st.prev_vals = closed_vals, prev_vals
        st.ok = True
        st.intrabar = {}

    # ---- samples ----

    async def on_sample(self, broker: str, epic: str, s: Sample) -> set[SeriesKey]:
        closed: set[SeriesKey] = set()
        for key, st in list(self._states.items()):
            if key[0] != broker or key[1] != epic:
                continue
            prev_open_ms = st.series.forming_open_ms
            roll = st.series.on_sample(s)
            retry_due = self._clock() - st.last_try >= _RETRY_SECONDS
            if roll is Roll.CLOSED:
                st.pending_bar_ms = prev_open_ms
            if st.seeded_for < self._warmup(st):
                # Never warmed up (or just asked for a longer warm-up): the
                # ONE path that can be a genuinely cold, unbounded-latency
                # fetch (F17). Backgrounded - never awaited from on_sample.
                self._spawn_first_seed(key, st)
            elif roll is Roll.GAP or (not st.ok and not st.pending_close and retry_due):
                # A reseed of an ALREADY-warm series (GAP, or a retry after a
                # failed refresh): bounded the same way a refresh is in
                # practice, and GAP needs this awaited inline so the
                # closed-bar check below can run in the SAME call.
                await self._seed(key, st)
                if (
                    roll is Roll.GAP and st.ok and prev_open_ms is not None
                    and st.series.closed and candle_ms(st.series.closed[-1]) == prev_open_ms
                ):
                    closed.add(key)
            elif roll is Roll.CLOSED or (st.pending_close and retry_due):
                if await self._refresh(key, st, st.pending_bar_ms):
                    closed.add(key)
        return closed

    # ---- reads ----

    def ready(self, key: SeriesKey, ind: IndicatorKey) -> bool:
        st = self._states.get(key)
        if st is None or not st.ok or len(st.series.closed) < warmup(ind):
            return False
        vals = st.closed_vals.get(ind)
        return vals is not None and all(v is not None for v in vals.values())

    def values(self, key: SeriesKey, ind: IndicatorKey, intrabar: bool) -> dict[str, float | None] | None:
        if not self.ready(key, ind):
            return None
        st = self._states[key]
        if not intrabar:
            return st.closed_vals[ind]
        now = self._clock()
        hit = st.intrabar.get(ind)
        if hit is not None and now - hit[0] < _INTRABAR_SECONDS:
            return hit[1]
        try:
            vals = _last(compute(ind, st.series.with_forming()))
        except Exception:
            # Same guard as _recompute: never let a forming-bar compute
            # exception escape into on_tick. Fall back to the last closed
            # value rather than crash; the close-mode state (st.ok) is
            # unaffected, since the closed bars themselves are still fine.
            log.warning("alert indicator intrabar compute failed for series %s", key, exc_info=True)
            return st.closed_vals.get(ind)
        st.intrabar[ind] = (now, vals)
        return vals

    def prev_values(self, key: SeriesKey, ind: IndicatorKey) -> dict[str, float | None] | None:
        if not self.ready(key, ind):
            return None
        return self._states[key].prev_vals.get(ind)

    def last_closed(self, key: SeriesKey) -> Candle | None:
        st = self._states.get(key)
        return st.series.closed[-1] if st and st.series.closed else None

    def prev_closed(self, key: SeriesKey) -> Candle | None:
        st = self._states.get(key)
        return st.series.closed[-2] if st and len(st.series.closed) >= 2 else None

    def forming_open_ms(self, key: SeriesKey) -> int | None:
        st = self._states.get(key)
        return st.series.forming_open_ms if st else None
```

Note on `test_intrabar_values_include_forming_and_throttle`: the first `values(..., intrabar=True)` call happens at clock 0.0, the second at 0.0 (throttled), the third at 1.5. `_seed` sets `last_try` but the intrabar cache is keyed by its own timestamp. If the cached entry was created at `t=0.0` and `_INTRABAR_SECONDS = 1.0`, the call at `t=1.5` recomputes.

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && .venv/bin/python -m pytest tests/test_alert_indicators.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/core/alert_indicators.py backend/tests/test_alert_indicators.py
git commit -m "feat(alerts): indicator hub seeded and refreshed from the candle cache

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Store: fired alert definition and last fire times

Spec: "Types and contracts" (`list_triggered` returns `alert`), "Once per bar" (restarts).

**Files:**
- Modify: `backend/auto_trader/core/alert_store.py` (`_list_triggered_sync`; add `last_fired_times`)
- Modify: `backend/auto_trader/api/routers/alerts.py` (`get_triggered`)
- Test: `backend/tests/test_alert_store.py`, `backend/tests/test_alerts_api.py` (append)

**Interfaces:**
- Produces: `AlertStore.list_triggered(user_id)` rows now include `alert_json: str | None`; `async AlertStore.last_fired_times() -> list[tuple[str, str, int]]` (user_id, alert_id, max time ms); `GET /api/alerts/triggered` entries carry `alert: dict | None` instead of `alert_json`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_alert_store.py` (it already builds an `AlertStore` on `tmp_path`; follow the file's existing helper for constructing one and an `add_triggered` entry):

```python
def test_last_fired_times_and_alert_json(tmp_path):
    import asyncio, json
    from auto_trader.core.alert_store import AlertStore

    async def main():
        store = AlertStore(str(tmp_path / "a.db"))
        base = {"broker": "capital", "epic": "US100", "kind": "indicator",
                "price": 1.0, "level": 2.0, "condition": "crossing", "message": "", "precision": 2}
        await store.add_triggered("u1", {**base, "time": 10, "alert_id": "al-1", "alert_json": json.dumps({"id": "al-1"})})
        await store.add_triggered("u1", {**base, "time": 20, "alert_id": "al-1"})
        await store.add_triggered("u2", {**base, "time": 15, "alert_id": "al-2"})
        assert sorted(await store.last_fired_times()) == [("u1", "al-1", 20), ("u2", "al-2", 15)]
        rows = await store.list_triggered("u1")
        assert json.loads(rows[1]["alert_json"]) == {"id": "al-1"}
    asyncio.run(main())
```

Append to `backend/tests/test_alerts_api.py`:

```python
def test_triggered_entries_carry_parsed_alert(clerk, monkeypatch):
    import asyncio, json
    from auto_trader.api.routers import alerts as alerts_router
    store = alerts_router.ALERT_STORE
    asyncio.run(store.add_triggered("alice", {
        "time": 5, "alert_id": "al-x", "broker": "capital", "epic": "US100", "kind": "indicator",
        "price": 1.0, "level": 2.0, "condition": "crossing", "message": "", "precision": 2,
        "alert_json": json.dumps({"id": "al-x", "params": {"indicator": "RSI"}}),
    }))
    r = client.get("/api/alerts/triggered", headers=_auth("alice"))
    entry = r.json()["entries"][0]
    assert entry["alert"]["params"]["indicator"] == "RSI" and "alert_json" not in entry
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && .venv/bin/python -m pytest tests/test_alert_store.py tests/test_alerts_api.py -q`
Expected: FAIL (`last_fired_times` missing; `alert` key missing).

- [ ] **Step 3: Implement**

In `_list_triggered_sync`, change the SELECT to:

```python
                "SELECT time, alert_id, broker, epic, kind, price, level, condition, "
                "message, precision, alert_json FROM triggered WHERE user_id = ? "
                "ORDER BY time DESC, rowid DESC",
```

Add beside `list_triggered`:

```python
    async def last_fired_times(self) -> list[tuple[str, str, int]]:
        """(user_id, alert_id, latest fire ms) for every alert that ever fired.
        The engine rebuilds its once-per-bar state from this on start, so a
        restart inside a bar cannot fire the same alert twice."""
        return await asyncio.to_thread(self._last_fired_times_sync)

    def _last_fired_times_sync(self) -> list[tuple[str, str, int]]:
        conn = self._connect()
        try:
            rows = conn.execute(
                "SELECT user_id, alert_id, MAX(time) AS t FROM triggered "
                "GROUP BY user_id, alert_id"
            ).fetchall()
            return [(r["user_id"], r["alert_id"], int(r["t"])) for r in rows]
        finally:
            conn.close()
```

In the router's `get_triggered`, parse it before returning (add `import json` at the top):

```python
    entries = await ALERT_STORE.list_triggered(user)
    for e in entries:
        raw = e.pop("alert_json", None)
        try:
            e["alert"] = json.loads(raw) if raw else None
        except ValueError:
            e["alert"] = None
```

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && .venv/bin/python -m pytest tests/test_alert_store.py tests/test_alerts_api.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/core/alert_store.py backend/auto_trader/api/routers/alerts.py \
  backend/tests/test_alert_store.py backend/tests/test_alerts_api.py
git commit -m "feat(alerts): fired history carries the alert definition; last fire times

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Engine on kinds, hub and once-per-bar

Spec: "Evaluation", "Once per bar", "Status reporting", "Types and contracts" (`_fire`).

**Files:**
- Modify: `backend/auto_trader/core/alert_engine.py`
- Test: `backend/tests/test_alert_engine.py` (rewrite `test_disarm_rearm_refire_for_every`; add new tests), `backend/tests/test_alert_engine_feeds.py` (fakes accept keywords)

**Interfaces:**
- Consumes: Tasks 1 to 5.
- Produces:
  - `AlertEngine.configure(store, get_broker, broadcast, notifiers=None, load_bars: Loader | None = None)`
  - `async AlertEngine.on_tick(broker, epic, mid, bid, ask, *, t_ms: int | None = None, bar: Candle | None = None)`
  - `AlertEngine.status(user_id: str, alert_id: str) -> str | None` (`"ok"`, `"waiting_for_data"`, or None for price alerts / unknown)
  - `__alerts__:fired` payload: existing keys, plus for indicator alerts `label`, `target`, `subject`, `evalOn`.

- [ ] **Step 1: Write the failing tests** (in `backend/tests/test_alert_engine.py`)

Replace `test_disarm_rearm_refire_for_every` with:

```python
def test_every_fires_once_per_bar_and_restart_does_not_refire(tmp_path):
    M = 60_000
    t0 = 1_700_000_000_000 - (1_700_000_000_000 % M)

    async def main():
        eng, store, sent, notified = make_engine(tmp_path)
        created = await store.create("u1", row(level=100.0, trigger="every"))
        eng.on_alert_changed("u1", created, "al-1")
        fired = lambda: [m for _, m in sent if m["key"] == "__alerts__:fired"]  # noqa: E731
        await eng.on_tick("capital", "US100", 99.0, None, None, t_ms=t0 + 1)
        await eng.on_tick("capital", "US100", 101.0, None, None, t_ms=t0 + 2)   # fires
        await eng.on_tick("capital", "US100", 99.0, None, None, t_ms=t0 + 3)    # same bar: blocked
        await eng.on_tick("capital", "US100", 101.0, None, None, t_ms=t0 + 4)   # same bar: blocked
        assert len(fired()) == 1
        # Restart inside the same minute: state rebuilt from triggered history.
        eng2, _, sent2, _ = make_engine(tmp_path)
        await eng2.start()
        try:
            await eng2.on_tick("capital", "US100", 99.0, None, None, t_ms=t0 + 5)
            await eng2.on_tick("capital", "US100", 101.0, None, None, t_ms=t0 + 6)
            assert [m for _, m in sent2 if m["key"] == "__alerts__:fired"] == []
            await eng2.on_tick("capital", "US100", 99.0, None, None, t_ms=t0 + M + 1)  # next bar
            assert len([m for _, m in sent2 if m["key"] == "__alerts__:fired"]) == 1
        finally:
            await eng2.stop()
    asyncio.run(main())
```

(`make_engine` reuses the same `alerts.db` path when called twice with the same `tmp_path`, so the second engine sees the first one's triggered rows.)

Also add (only the pure `evaluate_alert` level was pinned for this in Task 1; this is the same rule wired through the real engine, where `bar_open` comes from `period_start(t_ms, ...)` rather than a hand-picked value):

```python
def test_greater_fires_once_per_bar_while_true_at_engine_level(tmp_path):
    M = 60_000
    t0 = 1_700_000_000_000 - (1_700_000_000_000 % M)

    async def main():
        eng, store, sent, notified = make_engine(tmp_path)
        created = await store.create("u1", row(level=100.0, condition="greater", trigger="every"))
        eng.on_alert_changed("u1", created, "al-1")
        fired = lambda: [m for _, m in sent if m["key"] == "__alerts__:fired"]  # noqa: E731
        await eng.on_tick("capital", "US100", 101.0, None, None, t_ms=t0 + 1)       # fires
        await eng.on_tick("capital", "US100", 102.0, None, None, t_ms=t0 + 2)       # still > 100, same bar: blocked
        assert len(fired()) == 1
        await eng.on_tick("capital", "US100", 103.0, None, None, t_ms=t0 + M + 1)   # next bar: fires again
        assert len(fired()) == 2
    asyncio.run(main())
```

Add:

```python
from datetime import datetime, timezone
from auto_trader.core.models import Candle

H = 3_600_000


def ind_row(id="al-i", **params):
    p = {"indicator": "MA", "calcParams": [3], "config": {"maType": "sma", "source": "close"},
         "line": "value", "timeframe": "HOUR", "target": "price", "value": None,
         "condition": "crossing_up", "trigger": "every", "evalOn": "close",
         "link": {"scope": "s", "instanceId": "MA"}}
    p.update(params)
    return {**row(id=id), "kind": "indicator", "params": p}


def hourly(closes, start_h):
    return [Candle(datetime.fromtimestamp((start_h + i) * H / 1000, tz=timezone.utc), x, x, x, x, 1.0)
            for i, x in enumerate(closes)]


def make_ind_engine(tmp_path, bars_ref):
    eng, store, sent, notified = make_engine(tmp_path)

    async def loader(broker, epic, res, side, count):
        return list(bars_ref[0])[-count:], False

    eng.configure(store=store, get_broker=lambda b: None,
                  broadcast=eng._broadcast, notifiers=eng._notifiers, load_bars=loader)
    return eng, store, sent


def test_close_mode_fires_on_closed_bar_cross(tmp_path):
    async def main():
        bars = [hourly([10, 10, 10, 9], 6)]          # SMA3 at 9h close = 9.67, close 9 below
        eng, store, sent = make_ind_engine(tmp_path, bars)
        created = await store.create("u1", ind_row())
        eng.on_alert_changed("u1", created, "al-i")
        await eng.on_tick("capital", "US100", 12.0, None, None, t_ms=10 * H + 5)   # seed
        await asyncio.sleep(0)  # let the backgrounded first seed (F17) run
        bars[0] = hourly([10, 10, 10, 9, 12], 6)    # 10h bar closes at 12 > SMA3 (10.33)
        await eng.on_tick("capital", "US100", 12.0, None, None, t_ms=11 * H + 5)
        fired = [m["value"] for _, m in sent if m["key"] == "__alerts__:fired"]
        assert len(fired) == 1
        assert fired[0]["label"] == "SMA 3 (1H)" and fired[0]["target"] == "price"
        assert fired[0]["level"] == pytest.approx((10 + 9 + 12) / 3)
        assert fired[0]["price"] == 12.0
    asyncio.run(main())


def test_fire_writes_the_resolved_level_into_triggered_history(tmp_path):
    # Only the broadcast payload was ever asserted before; `triggered.level`
    # (what GET /api/alerts/triggered and the Telegram caption read back) is
    # a SEPARATE write in `_fire` and must carry the same resolved level.
    async def main():
        bars = [hourly([10, 10, 10, 9], 6)]
        eng, store, sent = make_ind_engine(tmp_path, bars)
        created = await store.create("u1", ind_row())
        eng.on_alert_changed("u1", created, "al-i")
        await eng.on_tick("capital", "US100", 12.0, None, None, t_ms=10 * H + 5)
        await asyncio.sleep(0)
        bars[0] = hourly([10, 10, 10, 9, 12], 6)
        await eng.on_tick("capital", "US100", 12.0, None, None, t_ms=11 * H + 5)
        rows = await store.list_triggered("u1")
        assert rows[0]["level"] == pytest.approx((10 + 9 + 12) / 3)
    asyncio.run(main())


def test_indicator_alert_does_not_fire_during_warmup(tmp_path):
    # Not just the status: a close that would obviously "cross" any
    # reasonable level must still not fire while the series is below its
    # indicator's warm-up (hub.values() returns None -> kind.resolve() is
    # never even called).
    async def main():
        bars = [hourly([10], 9)]  # 1 bar; SMA3 needs 3 and is never ready here
        eng, store, sent = make_ind_engine(tmp_path, bars)
        created = await store.create("u1", ind_row(condition="crossing_up"))
        eng.on_alert_changed("u1", created, "al-i")
        await eng.on_tick("capital", "US100", 5.0, None, None, t_ms=10 * H + 5)
        await asyncio.sleep(0)
        bars[0] = hourly([10, 50], 9)  # 50 would cross almost anything
        await eng.on_tick("capital", "US100", 50.0, None, None, t_ms=11 * H + 5)
        assert [m for _, m in sent if m["key"] == "__alerts__:fired"] == []
        assert eng.status("u1", "al-i") == "waiting_for_data"
    asyncio.run(main())


def test_bid_side_user_resyncs_hub_needs_on_first_resolution(tmp_path, monkeypatch):
    # F2 regression: a user's FIRST price-side resolution (cache miss -> a
    # non-mid side) is not a "flip" (there is no previous cached side), but
    # the hub's needs were registered under "mid" (on_alert_changed's own
    # price_side_for call landed on the cache-miss default) and must still be
    # resynced to the bid SeriesKey, or this user's indicator alerts never
    # see a `closed` series and never fire.
    async def main():
        import json as _json

        import auto_trader.core.alert_engine as alert_engine_mod
        from auto_trader.core.state_store import StateStore

        state_store = StateStore(str(tmp_path / "state.db"))
        monkeypatch.setattr(alert_engine_mod, "STATE_STORE", state_store)
        await state_store.set("u1", "auto-trader.settings", _json.dumps({"priceSide": "bid"}))

        bars = [hourly([10, 10, 10, 9], 6)]
        eng, store, sent = make_ind_engine(tmp_path, bars)
        created = await store.create("u1", ind_row())
        eng.on_alert_changed("u1", created, "al-i")

        await eng.on_tick("capital", "US100", 12.0, 11.9, 12.1, t_ms=10 * H + 5)
        await asyncio.sleep(0)  # let the backgrounded first seed (F17) run
        bars[0] = hourly([10, 10, 10, 9, 12], 6)
        await eng.on_tick("capital", "US100", 12.0, 11.9, 12.1, t_ms=11 * H + 5)
        assert len([m for _, m in sent if m["key"] == "__alerts__:fired"]) == 1
    asyncio.run(main())


def test_close_mode_ignores_ticks_between_closes(tmp_path):
    async def main():
        bars = [hourly([10, 10, 10, 9], 6)]
        eng, store, sent = make_ind_engine(tmp_path, bars)
        created = await store.create("u1", ind_row())
        eng.on_alert_changed("u1", created, "al-i")
        for i, px in enumerate([8.0, 20.0, 8.0, 20.0]):   # wild intrabar ticks, same bar
            await eng.on_tick("capital", "US100", px, None, None, t_ms=10 * H + 5 + i)
        assert [m for _, m in sent if m["key"] == "__alerts__:fired"] == []
    asyncio.run(main())


def test_indicator_status_waiting_until_warm(tmp_path):
    async def main():
        bars = [hourly([10], 9)]
        eng, store, sent = make_ind_engine(tmp_path, bars)
        created = await store.create("u1", ind_row())
        eng.on_alert_changed("u1", created, "al-i")
        await eng.on_tick("capital", "US100", 12.0, None, None, t_ms=10 * H + 5)
        assert eng.status("u1", "al-i") == "waiting_for_data"
        assert eng.status("u1", "al-1") is None
    asyncio.run(main())
```

Add `import pytest` at the top if missing.

In `backend/tests/test_alert_engine_feeds.py`, every `fake_on_tick(broker_id, epic, mid, bid, ask)` becomes `fake_on_tick(broker_id, epic, mid, bid, ask, **kw)` (search the file for `def fake_on_tick`).

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && .venv/bin/python -m pytest tests/test_alert_engine.py tests/test_alert_engine_feeds.py -q`
Expected: FAIL (`on_tick() got an unexpected keyword argument 't_ms'`, `configure() got an unexpected keyword argument 'load_bars'`).

- [ ] **Step 3: Implement the engine changes** (`backend/auto_trader/core/alert_engine.py`)

1. Imports: replace `from auto_trader.core.alert_eval import evaluate_alert` with

```python
from auto_trader.core.alert_bars import Sample, period_start
from auto_trader.core.alert_eval import Pair, evaluate_alert
from auto_trader.core.alert_indicators import IndicatorHub, Loader, SeriesKey
from auto_trader.core.alert_kinds import AlertKind, kind_of
from auto_trader.core.models import Candle
from auto_trader.indicators.alertable import IndicatorKey
```

and delete the module-level `_alert_sig` function (kinds own `sig`). Update the module docstring's `armed`/`baseline` bullet to: per-alert state is `baseline` (previous intrabar `(subject, level)` pair; close-mode alerts read the previous closed bar from the hub instead), `last_fired_bar`, and `sig`; "every" fires at most once per bar (alert_eval.py).

2. `__init__`: replace `self._armed` with

```python
        self._last_fired_bar: dict[tuple[str, str], int] = {}
        self._hub: IndicatorHub | None = None
        # status debounce: key -> (status, since_monotonic); last broadcast status
        self._status_seen: dict[tuple[str, str], tuple[str, float]] = {}
        self._status_sent: dict[tuple[str, str], str] = {}
        self._status_task: asyncio.Task | None = None
```

and change `self._baseline` to `dict[tuple[str, str], Pair | None]`.

3. `configure(...)`: add the `load_bars: Loader | None = None` parameter and `self._hub = IndicatorHub(load_bars) if load_bars is not None else None`.

4. `start()`: replace `self._armed.clear()` with clears of `_last_fired_bar`, `_status_seen`, `_status_sent`; after building the registry add

```python
        await self._rebuild_last_fired()
        self._sync_needs()
        self._status_task = asyncio.create_task(self._status_loop())
```

and include `self._status_task` in `stop()`'s task list (set it to None like the others).

5. New helpers:

```python
    def _series_key(self, user_id: str, row: dict, kind: AlertKind) -> SeriesKey:
        return (row["broker"], row["epic"], kind.bar_resolution(row["params"]),
                self.price_side_for(user_id))

    def _sync_needs(self) -> None:
        """Tell the hub which series/indicators active indicator alerts need."""
        if self._hub is None:
            return
        needs: dict[SeriesKey, set[IndicatorKey]] = {}
        for entries in self._registry.values():
            for user_id, row in entries:
                kind = kind_of(row)
                ind = kind.indicator_key(row["params"]) if kind and row.get("active", 1) else None
                if ind is not None:
                    needs.setdefault(self._series_key(user_id, row, kind), set()).add(ind)
        self._hub.set_needs(needs)

    async def _rebuild_last_fired(self) -> None:
        assert self._store is not None
        rows = {(u, r["id"]): r for entries in self._registry.values() for u, r in entries}
        for user_id, alert_id, t in await self._store.last_fired_times():
            row = rows.get((user_id, alert_id))
            kind = kind_of(row) if row else None
            if kind is not None:
                self._last_fired_bar[(user_id, alert_id)] = period_start(
                    t, kind.bar_resolution(row["params"])
                )

    def status(self, user_id: str, alert_id: str) -> str | None:
        for entries in self._registry.values():
            for owner, row in entries:
                if owner != user_id or row["id"] != alert_id:
                    continue
                kind = kind_of(row)
                ind = kind.indicator_key(row["params"]) if kind else None
                if ind is None:
                    return None
                ok = self._hub is not None and self._hub.ready(
                    self._series_key(user_id, row, kind), ind
                )
                return "ok" if ok else "waiting_for_data"
        return None
```

6. `on_alert_changed`: call `self._sync_needs()` just before `self._reconcile_event.set()`. `_forget`: replace `self._armed.pop` with pops of `_last_fired_bar`, `_status_seen`, `_status_sent`.

   In `_refresh_price_side`, replace the trailing `if prev_side is not None and side != prev_side: self._clear_baselines_for_user(user_id)` block with:

   ```python
           # The hub's needs were registered under whatever price_side_for
           # returned BEFORE this resolution - "mid" on a cache miss, same as
           # price_side_for's own default. Resync whenever the side actually
           # differs from that, not only on a FLIP (prev_side is not None):
           # a user's very FIRST resolution to a non-mid side is not a flip,
           # but the hub is still on the wrong SeriesKey until this runs.
           if side != (prev_side or "mid"):
               self._sync_needs()
           # A side flip (e.g. mid -> bid) mid-session means every existing
           # baseline for this user was sampled on the OLD side; comparing it
           # against a price on the new side can misread as a crossing. Port
           # of alertEngine.ts's setPriceSide, which clears baselines for the
           # same reason. The first-ever resolution (prev_side is None) is
           # exempt: there is no stale baseline to clear.
           if prev_side is not None and side != prev_side:
               self._clear_baselines_for_user(user_id)
   ```

   (See `test_bid_side_user_resyncs_hub_needs_on_first_resolution` above -
   without the first condition, a bid/ask user's indicator alerts never fire
   because the hub keeps evaluating the mid-keyed series forever.)

   Close mode needs no baseline of its own: the previous pair is the closed bar before the last one, read from the hub (`prev_closed` / `prev_values`). That is restart-safe and cannot be moved by intrabar ticks.

7. Replace `on_tick` entirely:

```python
    async def on_tick(
        self, broker: str, epic: str, mid: float, bid: float | None, ask: float | None,
        *, t_ms: int | None = None, bar: Candle | None = None,
    ) -> None:
        # Callers must not invoke on_tick concurrently for the same (broker,
        # epic): one feed task per pair guarantees it (see _feed_tasks). The
        # awaits that touch storage or the candle cache (price-side refresh,
        # hub sample) run before the per-alert loop for that reason.
        assert self._store is not None, "configure() must be called before on_tick()"
        entries = list(self._registry.get((broker, epic), []))
        now_ms = int(time.time() * 1000)
        t_ms = now_ms if t_ms is None else t_ms

        for owner in {user_id for user_id, _ in entries}:
            await self._refresh_price_side(owner)

        closed: set[SeriesKey] = set()
        if self._hub is not None and self._hub.has_feed(broker, epic):
            closed = await self._hub.on_sample(broker, epic, Sample(t_ms, mid, bid, ask, bar))

        for user_id, row in entries:
            if not row.get("active", 1):
                continue
            state_key = (user_id, row["id"])
            expires_at = row.get("expires_at")
            if expires_at is not None and expires_at <= now_ms:
                await self._expire_one(user_id, row)
                continue
            kind = kind_of(row)
            if kind is None:
                continue
            params = row.get("params", {})

            sig = kind.sig(params)
            prev_sig = self._sig.get(state_key)
            if prev_sig is not None and prev_sig != sig:
                self._baseline[state_key] = None
                self._last_fired_bar.pop(state_key, None)
            self._sig[state_key] = sig

            side = self.price_side_for(user_id)
            price = bid if side == "bid" and bid is not None else ask if side == "ask" and ask is not None else mid

            ind = kind.indicator_key(params)
            # One bar clock for every alert: the period the sample falls in.
            # A close-mode fire happens in the bar AFTER the one that closed,
            # so its next chance is the following close; a restart rebuilds
            # this from the fire time with the same function.
            bar_open = period_start(t_ms, kind.bar_resolution(params))
            if kind.eval_on(params) == "close":
                skey = self._series_key(user_id, row, kind)
                if self._hub is None or skey not in closed:
                    continue
                last, before = self._hub.last_closed(skey), self._hub.prev_closed(skey)
                vals = self._hub.values(skey, ind, intrabar=False)
                pvals = self._hub.prev_values(skey, ind)
                cur = kind.resolve(params, last.close, vals) if last and vals else None
                prev = kind.resolve(params, before.close, pvals) if before and pvals else None
                if cur is None:
                    continue
                record_price = last.close
            else:
                vals = None
                if ind is not None:
                    skey = self._series_key(user_id, row, kind)
                    vals = self._hub.values(skey, ind, intrabar=True) if self._hub else None
                    if vals is None:
                        self._baseline[state_key] = None  # no stale pair across a gap
                        continue
                cur = kind.resolve(params, price, vals)
                if cur is None:
                    continue
                record_price = price
                prev = self._baseline.get(state_key)
                self._baseline[state_key] = cur

            result = evaluate_alert(
                prev, cur, params.get("condition"), params.get("trigger"),
                bar_open, self._last_fired_bar.get(state_key),
            )
            if result.fired and not self._is_snoozed(state_key, now_ms):
                # Record last_fired_bar ONLY when the fire actually happens:
                # a snoozed "fire" must not block the real one once the
                # snooze lapses (test_telegram_rich_alerts.py pins a second
                # crossing in the same minute, right after snooze, still
                # firing).
                self._last_fired_bar[state_key] = bar_open
                await self._fire(user_id, row, record_price, cur, kind, t_ms)
            if result.remove:
                await self._delete_and_forget(user_id, row)
```

8. `_fire(self, user_id, row, price, pair: Pair, kind: AlertKind, fired_at: int)`: replace `level = params.get("level")` with `level = pair[1]` and `now_ms = int(time.time() * 1000)` with `now_ms = fired_at` (the sample time: equal to now for live feeds, and the value the restart rebuild maps back through `period_start`); keep everything else, and after building `payload` add `payload.update(kind.payload_extras(params, pair))`.

9. Status debounce loop:

```python
    _STATUS_HOLD_SECONDS = 10.0

    async def _status_loop(self) -> None:
        while True:
            try:
                await asyncio.sleep(2)
                await self._broadcast_status_changes()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.warning("alert status loop failed", exc_info=True)

    async def _broadcast_status_changes(self) -> None:
        assert self._broadcast is not None
        now = time.monotonic()
        changed: dict[str, tuple[str, str]] = {}
        for entries in self._registry.values():
            for user_id, row in entries:
                key = (user_id, row["id"])
                st = self.status(user_id, row["id"])
                if st is None:
                    continue
                seen = self._status_seen.get(key)
                if seen is None or seen[0] != st:
                    self._status_seen[key] = (st, now)
                    continue
                if now - seen[1] >= self._STATUS_HOLD_SECONDS and self._status_sent.get(key) != st:
                    self._status_sent[key] = st
                    changed[user_id] = (row["broker"], row["epic"])
        for user_id, (broker, epic) in changed.items():
            await self._broadcast(user_id, {
                "key": "__alerts__:changed",
                "value": {"broker": broker, "epic": epic, "origin": "engine"},
            })
```

10. `_stream_feed`: pass the bar: `await self.on_tick(broker_id, epic, bar.candle.close, bar.bid, bar.ask, bar=bar.candle)`.

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && .venv/bin/python -m pytest tests/test_alert_engine.py tests/test_alert_engine_feeds.py tests/test_alert_eval.py tests/test_alerts_api.py tests/test_telegram_rich_alerts.py -q`
Expected: all pass. If a pre-existing engine test relied on two fires within one minute, give its second fire a `t_ms` in the next minute (that is the new rule, not a regression).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/core/alert_engine.py backend/tests/test_alert_engine.py \
  backend/tests/test_alert_engine_feeds.py
git commit -m "feat(alerts): engine evaluates kinds, indicator series and once per bar

'Every time' alerts are now 'Once per bar': they fire at most once per
candle of the timeframe they were created on (1 minute if none was
recorded). A restart inside a bar does not fire them again.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Wire the candle-cache loader and the alert status into the API

Spec: "Closed bars always come from the candle cache", "Status reporting".

**Files:**
- Modify: `backend/auto_trader/api/deps.py` (add `load_alert_bars`)
- Modify: `backend/auto_trader/api/app.py:149-154` (pass `load_bars`)
- Modify: `backend/auto_trader/api/routers/alerts.py` (`list_alerts` merges `status`)
- Test: `backend/tests/test_alerts_api.py` (append)

**Interfaces:**
- Consumes: `CANDLE_CACHE.recent(key, res_seconds, count, fetch_recent, *, degraded=dict)` (`core/candle_cache.py:790`), `get_data`, `guarded` (`api/deps.py`), `Resolution`.
- Produces: `async load_alert_bars(broker, epic, resolution, side, count) -> tuple[list[Candle], bool]`; `GET /api/alerts` rows gain `status` for indicator alerts.

- [ ] **Step 1: Write the failing test** (append to `test_alerts_api.py`)

```python
def test_list_includes_status_for_indicator_alerts(clerk, monkeypatch):
    from auto_trader.api.routers import alerts as alerts_router
    client.post("/api/alerts", json=_ind_body(), headers=_auth("alice"))
    client.post("/api/alerts", json=_body(id="al-p"), headers=_auth("alice"))
    monkeypatch.setattr(alerts_router.ALERT_ENGINE, "status",
                        lambda u, a: "waiting_for_data" if a == "al-ind" else None)
    rows = {r["id"]: r for r in client.get("/api/alerts", headers=_auth("alice")).json()["alerts"]}
    assert rows["al-ind"]["status"] == "waiting_for_data"
    assert "status" not in rows["al-p"]
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && .venv/bin/python -m pytest tests/test_alerts_api.py -q`
Expected: FAIL (KeyError 'status').

- [ ] **Step 3: Implement**

`list_alerts`:

```python
@router.get("/api/alerts")
async def list_alerts(request: Request) -> dict[str, Any]:
    user = current_user(request)
    rows = await ALERT_STORE.list_user(user)
    for r in rows:
        st = ALERT_ENGINE.status(user, r["id"])
        if st is None and r.get("kind") == "indicator":
            st = "waiting_for_data"  # not registered with the engine yet
        if st is not None:
            r["status"] = st
    return {"alerts": rows}
```

`api/deps.py`, near `guarded`:

```python
async def load_alert_bars(
    broker_id: str, epic: str, resolution: str, side: str, count: int
) -> tuple[list[Candle], bool]:
    """Alert-engine loader: the most recent `count` native bars through the
    same candle cache the charts read. Returns (bars, degraded); degraded
    means the broker fetch failed and cached bars were served, which the
    alert hub treats as a failure."""
    res = Resolution(resolution)
    broker = get_data(broker_id)

    async def fetch_recent(n: int):
        return await guarded(
            broker_id, lambda: broker.get_recent_candles(epic, res, n, side), "alert bars"
        )

    degraded: dict = {}
    bars = await CANDLE_CACHE.recent(
        (broker_id, epic, res.value, side), res.seconds, count, fetch_recent, degraded=degraded
    )
    return bars, bool(degraded)
```

(Check `CandleCache._recent` for the exact key it sets in `degraded`; `bool(degraded)` is true for any set key. Import `Candle`/`Resolution` from `auto_trader.core.models` if `deps.py` does not already.)

`api/app.py`: add `load_bars=deps.load_alert_bars,` to the `ALERT_ENGINE.configure(...)` call.

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && .venv/bin/python -m pytest tests/test_alerts_api.py tests/test_alert_engine.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/deps.py backend/auto_trader/api/app.py \
  backend/auto_trader/api/routers/alerts.py backend/tests/test_alerts_api.py
git commit -m "feat(alerts): feed indicator alerts from the candle cache; expose status

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Notifications use the indicator label

Spec: "Panel and notifications", "Types and contracts" (`label`), Non-goals (Telegram snapshot stays price only).

**Files:**
- Modify: `backend/auto_trader/core/telegram_notify.py` (`_build_caption` ~line 277; snapshot title ~line 353)
- Modify: `backend/auto_trader/core/alert_chart.py` (`render_alert_chart`: `level: float | None`)
- Modify: `backend/auto_trader/core/chart_snapshot.py` (`render_live_chart` ~line 83: skip the `level` query param for a value-target alert)
- Modify: `backend/auto_trader/core/push_notify.py` (`notifier` body)
- Modify: `frontend/public/alert-sw.js` (notification text)
- Test: `backend/tests/test_telegram_rich_alerts.py` (append), `backend/tests/test_alert_chart.py` (append)

**Interfaces:**
- Consumes: payload keys `label`, `target` from Task 6.
- Produces: one caption helper `_headline(payload, precision) -> str` used by both the text caption and the snapshot title.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_telegram_rich_alerts.py` (reuse that file's existing notifier construction; the assertion targets are the caption strings):

```python
from auto_trader.core.telegram_notify import _headline


def test_headline_price_and_indicator_forms():
    base = {"epic": "US100", "condition": "crossing_up", "level": 21400.0, "price": 21430.0}
    assert _headline(base, 1) == "🔔 US100 crossed up 21400.0"
    ind = {**base, "label": "EMA 50 (1H)", "target": "price"}
    assert _headline(ind, 1) == "🔔 US100 crossed up EMA 50 (1H) 21400.0"
    val = {**base, "label": "RSI 14 (1H)", "target": "value", "condition": "greater", "level": 70.0}
    assert _headline(val, 1) == "🔔 US100 RSI 14 (1H) above 70.00"
```

Append to `backend/tests/test_chart_snapshot.py` (reuses `HEARTBEAT`/`FakeStore` already at the top of the file):

```python
async def test_value_target_alert_skips_the_level_param(monkeypatch):
    # An RSI-70 alert's "level" is 70, not a price: the live snapshot must
    # not draw it as a horizontal price line (SnapshotApp.tsx's armReady
    # draws whatever `level` it's given, with no target-awareness).
    rows = {("u1", "auto-trader.b.capital.view.US100"): json.dumps(HEARTBEAT)}
    monkeypatch.setattr(cs, "_state_store", lambda: FakeStore(rows))
    seen = {}

    async def fake_drive(url, width, height, timeout_s):
        seen.update(url=url)
        return b"PNG"

    monkeypatch.setattr(cs, "_drive_browser", fake_drive)
    monkeypatch.setattr(cs, "_mint_token", lambda user_id: None)
    payload = {**PAYLOAD, "level": 70.0, "target": "value", "label": "RSI 14 (1H)"}
    await cs.render_live_chart("u1", payload)
    assert "level=" not in seen["url"]
```

Append to `backend/tests/test_alert_chart.py`:

```python
def test_render_without_level_line():
    from datetime import datetime, timedelta, timezone
    from auto_trader.core.alert_chart import render_alert_chart
    from auto_trader.core.models import Candle
    t0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
    bars = [Candle(t0 + timedelta(minutes=i), 1, 2, 0.5, 1.5) for i in range(10)]
    assert render_alert_chart(bars, None, 1.5, 2, "t")[:4] == b"\x89PNG"
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && .venv/bin/python -m pytest tests/test_telegram_rich_alerts.py tests/test_alert_chart.py tests/test_chart_snapshot.py -q`
Expected: FAIL (ImportError `_headline`; TypeError on `None` level; `test_value_target_alert_skips_the_level_param` sees `level=` in the URL).

- [ ] **Step 3: Implement**

`telegram_notify.py`, module level below `_CONDITION_LABELS`:

```python
def _headline(payload: dict, precision: int) -> str:
    """'🔔 EPIC <what> <level>': one wording for the caption and the snapshot
    title. Value-target indicator alerts compare the indicator to a number,
    so the number is shown with 2 decimals regardless of price precision."""
    epic = payload.get("epic")
    cond = _CONDITION_LABELS.get(payload.get("condition"), payload.get("condition") or "")
    level = payload.get("level")
    label = payload.get("label")
    if label and payload.get("target") == "value":
        return f"🔔 {epic} {label} {cond} {level:.2f}"
    parts = [f"🔔 {epic}", cond, label, f"{level:.{precision}f}"]
    return " ".join(p for p in parts if p)
```

In `_build_caption` replace the `level`/`epic`/`cond`/`head` lines with `head = _headline(payload, precision)` (keep `price` for the `· now` part). In the snapshot path replace the `title = (...)` expression with:

```python
            title = f"{_headline(payload, precision)[2:]} @ {payload['price']:.{precision}f} · {tf_label} · {_format_fired_time(payload)}"
            line = None if payload.get("target") == "value" else payload["level"]
            return await asyncio.to_thread(
                render_alert_chart, candles, line, payload["price"], precision, title,
            )
```

(`[2:]` drops the bell emoji and its space; the title reads "US100 crossed up EMA 50 (1H) 21400.0 @ 21430.0 · 1H · ...".)

`alert_chart.py`: signature `level: float | None`; guard the line and the range:

```python
    if level is not None:
        ax.axhline(level, color=_LEVEL, linewidth=1.1, linestyle=(0, (6, 3)), zorder=4)
    ...
    y_min = min(lows) if level is None else min(min(lows), level)
    y_max = max(highs) if level is None else max(max(highs), level)
```

`push_notify.py`: add `"label": payload.get("label"), "target": payload.get("target"),` to the JSON body.

`chart_snapshot.py` (`render_live_chart`): the LIVE snapshot (a headless-Chromium screenshot of the user's actual chart, separate from the matplotlib fallback above) draws its own level line client-side (`SnapshotApp.tsx`'s `armReady`, which overlays a `horizontalStraightLine` whenever the `level` URL param is present, with no target-awareness). For a value-target indicator alert, `payload["level"]` is the indicator's number (e.g. RSI 70), not a price - drawing it as a horizontal PRICE line would place it nonsensically on the price pane (an RSI-70 alert would draw a line at price 70). Only pass the query param for a price-comparable level:

```python
        q: dict[str, str] = {"snapshot": "1", "broker": broker, "epic": epic}
        if payload.get("level") is not None and payload.get("target") != "value":
            q["level"] = str(payload["level"])
```

(No frontend change needed: `SnapshotApp.tsx` only draws the overlay when the `level` param is present at all, so omitting it here is sufficient.)

`frontend/public/alert-sw.js`, replace the `detail` line:

```js
    const lvl = Number(p.level).toFixed(p.target === "value" ? 2 : prec);
    const detail = p.message || (p.label ? `${p.label} @ ${lvl}` : `@ ${lvl}`);
```

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && .venv/bin/python -m pytest tests/test_telegram_rich_alerts.py tests/test_alert_chart.py tests/test_chart_snapshot.py -q`
Expected: all pass (pre-existing caption tests still pass: price payloads have no `label`).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/core/telegram_notify.py backend/auto_trader/core/alert_chart.py \
  backend/auto_trader/core/chart_snapshot.py backend/auto_trader/core/push_notify.py frontend/public/alert-sw.js \
  backend/tests/test_telegram_rich_alerts.py backend/tests/test_alert_chart.py backend/tests/test_chart_snapshot.py
git commit -m "feat(alerts): indicator labels in Telegram and push notifications

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: alert_probe --indicator

Spec: "Testing" (probe).

**Files:**
- Modify: `backend/scripts/alert_probe.py`

- [ ] **Step 1: Implement**

The script's `main(url, epic, broker, timeout)` always builds a `greater` price-level body today. Add an `indicator: bool` parameter: when set, POST an indicator alert that fires on the next intrabar sample instead of fetching a quote at all (the quote fetch in `main` is only needed to compute the price-level alert's level, so skip it for `--indicator`):

```python
def main(url: str, epic: str, broker: str, timeout: float, indicator: bool = False) -> int:
    alert_id = f"al-probe-{uuid.uuid4()}"
    with httpx.Client(base_url=url, timeout=10.0) as client:
        print(f"connecting to {url}")

        if indicator:
            body = {
                "id": alert_id, "broker": broker, "epic": epic, "kind": "indicator",
                "params": {
                    "indicator": "MA", "calcParams": [2], "config": {"maType": "sma"},
                    "line": "value", "timeframe": "MINUTE", "target": "value", "value": -1e12,
                    "condition": "greater", "trigger": "once", "evalOn": "intrabar", "link": None,
                },
                "message": "alert_probe e2e check",
            }
            print(f"{broker}:{epic} SMA 2 value > -1e12 (fires once warm, intrabar)")
        else:
            try:
                bid = _quote(client, epic, broker)
            except (httpx.HTTPError, RuntimeError) as e:
                print(f"FAIL: could not fetch quote for {broker}:{epic}: {e}")
                return 1
            level = bid - 0.0001
            print(f"{broker}:{epic} bid={bid} -> alert level={level} condition=greater")
            body = {
                "id": alert_id, "broker": broker, "epic": epic, "kind": "price_level",
                "params": {"level": level, "condition": "greater", "trigger": "once"},
                "message": "alert_probe e2e check",
            }

        resp = client.post("/api/alerts", json=body)
```

(the rest of `main` - create, poll, cleanup - is unchanged; `value` target with `greater` than a huge negative number fires as soon as the SMA 2 is warm, which exercises seeding, the hub and the fire path without depending on price direction or a live quote.) Add the flag and thread it through, matching the file's own argparse variable name (`ap`, not `parser`):

```python
    ap.add_argument("--indicator", action="store_true",
                     help="probe an indicator alert (SMA 2 value greater than -1e12 on 1m, intrabar) "
                          "instead of a price-level alert")
    ns = ap.parse_args()
    sys.exit(main(ns.url, ns.epic, ns.broker, ns.timeout, ns.indicator))
```

Update the module docstring's usage block with `python3 -m scripts.alert_probe --indicator --epic BTCUSD --broker capital-live`.

- [ ] **Step 2: Smoke-check syntax**

Run: `cd backend && .venv/bin/python -m scripts.alert_probe --help`
Expected: help text lists `--indicator`.

- [ ] **Step 3: Commit**

```bash
git add backend/scripts/alert_probe.py
git commit -m "chore(alerts): alert probe can create an indicator alert

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 10: Frontend alertable registry and cross-side parity fixtures

Spec: "Alertable configurations", "Testing" (committed JSON fixtures), "Design principles" (deliberate duplicate).

**Files:**
- Create: `frontend/src/lib/alertableIndicators.ts`
- Create: `frontend/src/lib/alertableIndicators.test.ts`
- Create: `frontend/src/lib/alertableParity.test.ts` (writes/reads the fixtures)
- Create: `backend/tests/fixtures/indicator_parity/alertable.json`, `backend/tests/fixtures/indicator_parity/values.json` (generated)
- Create: `backend/tests/test_indicator_parity.py`

**Interfaces:**
- Consumes: `normalizeMaKind` (`lib/mtf.ts:172`), `templateMaKind` (`lib/indicators/ma.ts:73`), `computeMa` (`lib/indicators/ma.ts:112`), `computeRsi` (`lib/indicators/rsi.ts:206`), `computeAtr` (`lib/indicators/atr.ts:22`), `tfLabel`, `tryCanonicalTf`, `isNativeTf`, `parseTf` (`lib/timeframe.ts`).
- Produces:
  - `type AlertIndicator = "MA" | "RSI" | "ATR"`
  - `ALERTABLE` (same JSON shape as Python `ALERTABLE`)
  - `interface IndicatorIdentity { indicator: AlertIndicator; calcParams: number[]; config: Record<string, string>; priceTarget: boolean }`
  - `type AlertableCheck = { ok: true; identity: IndicatorIdentity } | { ok: false; reason: string } | { ok: false; hidden: true }`
  - `checkAlertable(type: string, calcParams: unknown[] | undefined, ext: Record<string, unknown> | undefined, resolution: string, hasVolume: boolean): AlertableCheck`
  - `indicatorLabel(id: IndicatorIdentity): string` (identical to Python `indicator_label`)
  - `indicatorAlertLabel(id: IndicatorIdentity, timeframe: string): string` (e.g. `"EMA 50 (1H)"`)
  - `MAIN_LINE_KEY: Record<AlertIndicator, string>` = `{ MA: "ma", RSI: "val", ATR: "atr" }` (the indicator result key holding the alertable line)

- [ ] **Step 1: Write the failing tests** (`frontend/src/lib/alertableIndicators.test.ts`)

```ts
import { describe, it, expect, vi } from "vitest";
vi.mock("klinecharts", () => ({
  registerIndicator: () => {}, registerOverlay: () => {}, registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));
import { checkAlertable, indicatorAlertLabel } from "./alertableIndicators";

describe("checkAlertable", () => {
  it("maps the EMA template to MA/ema with defaults", () => {
    const r = checkAlertable("EMA", [50], {}, "HOUR", true);
    expect(r).toEqual({
      ok: true,
      identity: { indicator: "MA", calcParams: [50], config: { maType: "ema", source: "close" }, priceTarget: true },
    });
  });
  it("keeps an MA template flipped to ema as ema", () => {
    const r = checkAlertable("MA", [20], { maType: "ema", source: "hl2" }, "HOUR", true);
    expect(r.ok && r.identity.config).toEqual({ maType: "ema", source: "hl2" });
  });
  it.each([
    [{ mtf: { timeframe: "HOUR_4" } }, "higher-timeframe"],
    [{ offset: 2 }, "offset"],
    [{ smoothing: { type: "ema", length: 9 } }, "smoothed"],
  ])("blocks unsupported MA config %j", (ext, word) => {
    const r = checkAlertable("EMA", [50], ext, "HOUR", true);
    expect(r.ok).toBe(false);
    expect(!r.ok && "reason" in r && r.reason).toContain(word);
  });
  it("blocks volume-weighted MAs on a market with no volume", () => {
    const r = checkAlertable("MA", [20], { maType: "vwma" }, "HOUR", false);
    expect(!r.ok && "reason" in r && r.reason).toBe("This market has no volume data.");
  });
  it("refuses a source the alertable registry doesn't support, for MA and RSI", () => {
    // hlcc4 is a real chart source (mtf.ts) that ALERTABLE's SOURCES doesn't
    // include: silently falling back to "close" would watch a different
    // line than the one on screen (preflight F7).
    const ma = checkAlertable("EMA", [50], { source: "hlcc4" }, "HOUR", true);
    expect(!ma.ok && "reason" in ma && ma.reason).toBe("Alerts on this source are coming later");
    const rsi = checkAlertable("RSI", [14], { source: "hlcc4" }, "HOUR", true);
    expect(!rsi.ok && "reason" in rsi && rsi.reason).toBe("Alerts on this source are coming later");
  });
  it("missing source still defaults to close (only an unrecognized one is refused)", () => {
    const r = checkAlertable("RSI", [14], {}, "HOUR", true);
    expect(r.ok && r.identity.config.source).toBe("close");
  });
  it("non-native timeframe gives a coming-later reason; seconds hide the entry", () => {
    const r = checkAlertable("RSI", [14], {}, "HOUR_2", true);
    expect(!r.ok && "reason" in r && r.reason).toBe("Alerts on this timeframe are coming later");
    expect(checkAlertable("RSI", [14], {}, "SECOND_5", true)).toEqual({ ok: false, hidden: true });
  });
  it("deferred types say coming later; unknown types hide", () => {
    const r = checkAlertable("BOLL", [20, 2], {}, "HOUR", true);
    expect(!r.ok && "reason" in r && r.reason).toBe("Alerts on BOLL are coming later");
    expect(checkAlertable("FVG", [], {}, "HOUR", true)).toEqual({ ok: false, hidden: true });
  });
  it("labels match the backend wording", () => {
    const r = checkAlertable("ATR", [14], { smoothing: "sma" }, "HOUR", true);
    expect(r.ok && indicatorAlertLabel(r.identity, "HOUR")).toBe("ATR 14 sma (1H)");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/lib/alertableIndicators.test.ts`
Expected: FAIL (cannot resolve `./alertableIndicators`).

- [ ] **Step 3: Implement `frontend/src/lib/alertableIndicators.ts`**

```ts
// Which chart indicators an alert may watch, and the identity an alert stores.
// Mirror of backend/auto_trader/indicators/alertable.py: the backend validates
// on its own (the two deploy separately), and alertableParity.test.ts plus
// backend/tests/test_indicator_parity.py keep the two definitions identical.
import { normalizeMaKind } from "./mtf";
import { isNativeTf, parseTf, tfLabel } from "./timeframe";

// The default MA kind for a template that hasn't flipped maType: EMA -> ema,
// MA -> sma. Deliberately NOT imported from lib/indicators/ma.ts's own
// templateMaKind: that module (and everything it imports) pulls klinecharts
// in at the VALUE level (`import { type Indicator, ... } from "klinecharts"`,
// which stays a runtime import under verbatimModuleSyntax), which crashes at
// import time in vitest's node environment - and this file is imported by
// alertsApi.ts (Task 11), which plain node-env tests import. Inlined rather
// than moved (the alternative would be relocating templateMaKind out of
// ma.ts into mtf.ts and re-exporting it from ma.ts for existing callers).
function templateMaKind(type: string): "ema" | "sma" {
  return type === "EMA" ? "ema" : "sma";
}

export type AlertIndicator = "MA" | "RSI" | "ATR";

const SOURCES = ["close", "open", "high", "low", "hl2", "hlc3", "ohlc4"];

export const ALERTABLE: Record<
  AlertIndicator,
  { lines: string[]; priceTarget: boolean; params: [number, number][]; config: Record<string, string[]> }
> = {
  MA: {
    lines: ["value"], priceTarget: true, params: [[1, 1000]],
    config: { maType: ["ema", "sma", "vwma", "evwma"], source: SOURCES },
  },
  RSI: { lines: ["value"], priceTarget: false, params: [[2, 1000]], config: { source: SOURCES } },
  ATR: { lines: ["value"], priceTarget: false, params: [[1, 1000]], config: { smoothing: ["rma", "sma", "ema", "wma"] } },
};

// The indicator result key that holds the alertable line, per indicator.
export const MAIN_LINE_KEY: Record<AlertIndicator, string> = { MA: "ma", RSI: "val", ATR: "atr" };

const DEFERRED = new Set(["AVWAP", "VWAP", "BOLL", "MACD"]);

export interface IndicatorIdentity {
  indicator: AlertIndicator;
  calcParams: number[];
  config: Record<string, string>;
  priceTarget: boolean;
}

export type AlertableCheck =
  | { ok: true; identity: IndicatorIdentity }
  | { ok: false; reason: string }
  | { ok: false; hidden: true };

const HIDDEN = { ok: false, hidden: true } as const;

function pick(options: string[], v: unknown): string {
  return typeof v === "string" && options.includes(v) ? v : options[0];
}

// `source` is unlike the other pick()-driven options (maType, smoothing): the
// chart offers sources the alertable registry does NOT support (e.g. hlcc4,
// mtf.ts:21 / indicatorMeta.ts:206). Silently falling back to "close" there
// would watch a different line than the one on screen without telling the
// user. Missing (undefined) still means "close", same as the chart's own
// default - only an explicit, UNRECOGNIZED source is refused.
function pickSource(v: unknown): string | undefined {
  if (v === undefined) return "close";
  return typeof v === "string" && SOURCES.includes(v) ? v : undefined;
}

export function checkAlertable(
  type: string,
  calcParams: unknown[] | undefined,
  ext: Record<string, unknown> | undefined,
  resolution: string,
  hasVolume: boolean,
): AlertableCheck {
  let seconds = false;
  try {
    seconds = parseTf(resolution).unit === "SECOND";
  } catch {
    return HIDDEN;
  }
  if (seconds) return HIDDEN;
  if (DEFERRED.has(type)) return { ok: false, reason: `Alerts on ${type} are coming later` };
  const e = ext ?? {};
  let indicator: AlertIndicator;
  let config: Record<string, string>;
  if (type === "EMA" || type === "MA") {
    const mtf = e.mtf as { timeframe?: string } | undefined;
    if (mtf?.timeframe) return { ok: false, reason: "Alerts on higher-timeframe lines are coming later" };
    if (Number(e.offset ?? 0) !== 0) return { ok: false, reason: "Alerts need the line offset at 0" };
    const sm = e.smoothing as { type?: string } | undefined;
    if (sm?.type && sm.type !== "none") return { ok: false, reason: "Alerts on smoothed lines are coming later" };
    indicator = "MA";
    const maSource = pickSource(e.source);
    if (maSource === undefined) return { ok: false, reason: "Alerts on this source are coming later" };
    config = { maType: normalizeMaKind(e.maType, templateMaKind(type)), source: maSource };
    if ((config.maType === "vwma" || config.maType === "evwma") && !hasVolume)
      return { ok: false, reason: "This market has no volume data." };
  } else if (type === "RSI") {
    const rsiSource = pickSource(e.source);
    if (rsiSource === undefined) return { ok: false, reason: "Alerts on this source are coming later" };
    indicator = "RSI";
    config = { source: rsiSource };
  } else if (type === "ATR") {
    indicator = "ATR";
    config = { smoothing: pick(ALERTABLE.ATR.config.smoothing, e.smoothing) };
  } else {
    return HIDDEN;
  }
  if (!isNativeTf(resolution)) return { ok: false, reason: "Alerts on this timeframe are coming later" };
  const spec = ALERTABLE[indicator];
  const fallback = indicator === "MA" ? (type === "EMA" ? 9 : 20) : 14;
  const n = Math.trunc(Number(calcParams?.[0]) || fallback);
  const [lo, hi] = spec.params[0];
  if (n < lo || n > hi) return { ok: false, reason: `Alerts need a length from ${lo} to ${hi}` };
  return { ok: true, identity: { indicator, calcParams: [n], config, priceTarget: spec.priceTarget } };
}

export function indicatorLabel(id: IndicatorIdentity): string {
  const n = id.calcParams[0];
  if (id.indicator === "MA") {
    const base = `${id.config.maType.toUpperCase()} ${n}`;
    return id.config.source === "close" ? base : `${base} ${id.config.source}`;
  }
  if (id.indicator === "RSI") return id.config.source === "close" ? `RSI ${n}` : `RSI ${n} ${id.config.source}`;
  return id.config.smoothing === "rma" ? `ATR ${n}` : `ATR ${n} ${id.config.smoothing}`;
}

export function indicatorAlertLabel(id: IndicatorIdentity, timeframe: string): string {
  return `${indicatorLabel(id)} (${tfLabel(timeframe)})`;
}
```

The backend warm-up cap (422 "length too long for alerts") is enforced server-side; the dialog shows that 422 message as a toast (Task 13), so it is not duplicated here.

- [ ] **Step 4: Write the parity fixture test** (`frontend/src/lib/alertableParity.test.ts`)

```ts
// Writes (UPDATE_PARITY=1) or checks the committed fixtures the backend's
// tests/test_indicator_parity.py reads: the alertable registry and the
// chart's own values for each alertable indicator over a fixed candle set.
import { describe, it, expect, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
vi.mock("klinecharts", () => ({
  registerIndicator: () => {}, registerOverlay: () => {}, registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));
import type { Indicator, KLineData } from "klinecharts";
import { ALERTABLE } from "./alertableIndicators";
import { computeMa } from "./indicators/ma";
import { computeRsi } from "./indicators/rsi";
import { computeAtr } from "./indicators/atr";

const DIR = new URL("../../../backend/tests/fixtures/indicator_parity/", import.meta.url);

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

const CASES = [
  { indicator: "MA", calcParams: [20], config: { maType: "sma", source: "close" } },
  { indicator: "MA", calcParams: [20], config: { maType: "ema", source: "hl2" } },
  { indicator: "MA", calcParams: [10], config: { maType: "vwma", source: "close" } },
  { indicator: "MA", calcParams: [10], config: { maType: "evwma", source: "close" } },
  { indicator: "RSI", calcParams: [14], config: { source: "close" } },
  { indicator: "ATR", calcParams: [14], config: { smoothing: "rma" } },
  { indicator: "ATR", calcParams: [14], config: { smoothing: "ema" } },
] as const;

function series(c: (typeof CASES)[number], data: KLineData[]): (number | null)[] {
  const n = c.calcParams[0];
  if (c.indicator === "MA")
    return computeMa(data, "ema", n, { maType: c.config.maType, source: c.config.source } as never).map((p) => p.ma ?? null);
  if (c.indicator === "RSI")
    return computeRsi(data, n, { source: c.config.source } as never).map((p) => p.val ?? null);
  const ind = { calcParams: [n], extendData: { smoothing: c.config.smoothing } } as unknown as Indicator;
  return computeAtr(data, ind).map((p) => p.atr ?? null);
}

describe("indicator parity fixtures", () => {
  const data = candles();
  const values = {
    candles: data.map((k) => [k.timestamp, k.open, k.high, k.low, k.close, k.volume]),
    cases: CASES.map((c) => ({ ...c, values: series(c, data) })),
  };
  const files: [string, unknown][] = [["alertable.json", ALERTABLE], ["values.json", values]];
  for (const [name, body] of files) {
    it(`${name} matches the committed fixture`, () => {
      const text = JSON.stringify(body, null, 1) + "\n";
      const path = new URL(name, DIR);
      if (process.env.UPDATE_PARITY) writeFileSync(path, text);
      expect(readFileSync(path, "utf8")).toBe(text);
    });
  }
});
```

Check the exact point-key names (`ma`, `val`, `atr`) against `MaPoint`, `RsiPoint`, `AtrPoint` before generating; if `computeMa`'s ext type rejects the literal, cast through `as never` as above.

- [ ] **Step 5: Generate the fixtures**

Run: `mkdir -p backend/tests/fixtures/indicator_parity && cd frontend && UPDATE_PARITY=1 npx vitest run src/lib/alertableParity.test.ts && npx vitest run src/lib/alertableParity.test.ts src/lib/alertableIndicators.test.ts`
Expected: both files written; second run PASS.

- [ ] **Step 6: Write the backend parity test** (`backend/tests/test_indicator_parity.py`)

```python
"""Python matches the chart: the alertable registry is identical on both
sides, and every alertable indicator's values equal the frontend's (written
by frontend/src/lib/alertableParity.test.ts with UPDATE_PARITY=1)."""
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from auto_trader.core.models import Candle
from auto_trader.indicators.alertable import ALERTABLE, IndicatorKey, compute

FIX = Path(__file__).parent / "fixtures" / "indicator_parity"


def test_alertable_registry_matches_frontend():
    assert json.loads((FIX / "alertable.json").read_text()) == ALERTABLE


VALUES = json.loads((FIX / "values.json").read_text())
CANDLES = [
    Candle(datetime.fromtimestamp(t / 1000, tz=timezone.utc), o, h, l, c, v)
    for t, o, h, l, c, v in VALUES["candles"]
]


@pytest.mark.parametrize("case", VALUES["cases"], ids=lambda c: f"{c['indicator']}-{c['config']}")
def test_values_match_frontend(case):
    key = IndicatorKey(case["indicator"], tuple(case["calcParams"]), tuple(sorted(case["config"].items())))
    got = compute(key, CANDLES)["value"]
    for i, (g, want) in enumerate(zip(got, case["values"])):
        if want is None:
            assert g is None, i
        else:
            assert g == pytest.approx(want, rel=1e-9, abs=1e-12), i
```

(`ALERTABLE` tuples vs JSON lists: the Python registry uses lists throughout so `==` holds. If the frontend emits `params` as nested arrays, so does Python.)

- [ ] **Step 7: Run backend parity**

Run: `cd backend && .venv/bin/python -m pytest tests/test_indicator_parity.py -q`
Expected: PASS. A value mismatch is a real parity bug: fix the backend port, never the fixture.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/alertableIndicators.ts frontend/src/lib/alertableIndicators.test.ts \
  frontend/src/lib/alertableParity.test.ts backend/tests/fixtures/indicator_parity/alertable.json \
  backend/tests/fixtures/indicator_parity/values.json backend/tests/test_indicator_parity.py
git commit -m "feat(alerts): frontend alertable registry with cross-side parity fixtures

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: alertsApi: indicator alerts, shared label, linked lookups

Spec: "Types and contracts", "Panel and notifications", "Design principles" (one label formatter).

Design choice: price alerts keep `SavedAlert` and its existing cache (every price-line consumer is untouched; `SavedAlert` gains `kind?: "price_level"`). Indicator alerts get their own type and cache, because none of the price-line code (overlays, axis tags, drag) applies to them. `AnyAlert = SavedAlert | IndicatorAlert` is what the panel and the label formatter take.

**Files:**
- Modify: `frontend/src/lib/alertsApi.ts`
- Test: `frontend/src/lib/alertsApi.test.ts` (append)

**Interfaces:**
- Consumes: Task 10 (`IndicatorIdentity`, `indicatorAlertLabel`).
- Produces (all exported from `lib/alertsApi.ts`, re-exported by `lib/persist`):
  - `type EvalOn = "close" | "intrabar"`; `type AlertTarget = "price" | "value"`
  - `interface IndicatorAlertParams { identity: IndicatorIdentity; line: "value"; timeframe: string; target: AlertTarget; value: number | null; evalOn: EvalOn; link: { scope: string; instanceId: string } | null }`
  - `interface IndicatorAlert { kind: "indicator"; id: string; epic: string; broker: string; condition: AlertCondition; trigger: AlertTrigger; message: string; expiresAt: number | null; notify: AlertNotifyChannels; createdAt?: number; precision: number; params: IndicatorAlertParams; status?: "ok" | "waiting_for_data" }`
  - `type AnyAlert = SavedAlert | IndicatorAlert`
  - `loadIndicatorAlerts(epic: string, broker?: string): IndicatorAlert[]`, `loadAllIndicatorAlerts(broker?: string): IndicatorAlert[]`
  - `linkedAlerts(scope: string, instanceId: string): IndicatorAlert[]` (all brokers)
  - `addIndicatorAlert(a: IndicatorAlert): Promise<boolean>`, `patchIndicatorAlert(id: string, patch: Partial<Pick<IndicatorAlert, "condition" | "trigger" | "message" | "expiresAt" | "notify">> & { params?: Partial<IndicatorAlertParams> }): Promise<boolean>`, `deleteIndicatorAlert(id: string): void`
  - `conditionPhrase(label: string | undefined, condition: AlertCondition, target: AlertTarget | undefined, levelText: string): string` (the one phrase shared by `alertLabel`, `triggeredLabel` and `firedDetail` in `app/useAlertFiredNotices.ts`, Task 16)
  - `alertLabel(a: AnyAlert, precision: number): string` (`"Crossing Up EMA 50 (1H)"`, `"RSI 14 (1H) Greater Than 70"`, `"Crossing 21,400.00"`)
  - `triggeredLabel(t: TriggeredAlert, hp: number): string` (`"Crossing Up EMA 50 (1H) 21,400.0 @ 21430.00"`; condition leads for a price target, so this is NOT simply `label` prepended to the old price-only wording)
  - `TriggeredAlert.label?: string`, `TriggeredAlert.target?: AlertTarget`; `FiredPayload.label?`, `target?`, `evalOn?`
  - `TRIGGER_LABELS: Record<AlertTrigger, string> = { once: "Once only", every: "Once per bar" }`

- [ ] **Step 1: Write the failing tests** (append to `lib/alertsApi.test.ts`, reusing `jsonResponse`, `alertRow`, `freshBroker` from the top of the file)

```ts
import {
  loadIndicatorAlerts, linkedAlerts, addIndicatorAlert, alertLabel, triggeredLabel, patchIndicatorAlert,
  type IndicatorAlert,
} from "./alertsApi";

function indRow(broker: string, overrides: Record<string, unknown> = {}) {
  return alertRow({
    id: "al-ind", broker, kind: "indicator",
    params: {
      indicator: "MA", calcParams: [50], config: { maType: "ema", source: "close" },
      line: "value", timeframe: "HOUR", target: "price", value: null,
      condition: "crossing_up", trigger: "every", evalOn: "close",
      link: { scope: "tab.t1.cell.c2", instanceId: "EMA" },
    },
    status: "waiting_for_data",
    ...overrides,
  });
}

describe("indicator alerts", () => {
  it("hydrate splits kinds: price lines never see indicator alerts", async () => {
    const broker = freshBroker();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) =>
      Promise.resolve(String(input).includes("triggered")
        ? jsonResponse({ entries: [], seen: 0 })
        : jsonResponse({ alerts: [alertRow({ broker }), indRow(broker)] }))));
    await hydrateAlerts();
    expect(loadAlerts("US100", broker).map((a) => a.id)).toEqual(["al-1"]);
    const ind = loadIndicatorAlerts("US100", broker);
    expect(ind).toHaveLength(1);
    expect(ind[0].params.identity.config).toEqual({ maType: "ema", source: "close" });
    expect(ind[0].status).toBe("waiting_for_data");
  });

  it("linkedAlerts matches scope and instanceId", async () => {
    const broker = freshBroker();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) =>
      Promise.resolve(String(input).includes("triggered")
        ? jsonResponse({ entries: [], seen: 0 })
        : jsonResponse({ alerts: [
            indRow(broker),
            indRow(broker, { id: "al-other", params: { ...indRow(broker).params, link: { scope: "tab.t1.cell.c9", instanceId: "EMA" } } }),
          ] }))));
    await hydrateAlerts();
    expect(linkedAlerts("tab.t1.cell.c2", "EMA").map((a) => a.id)).toEqual(["al-ind"]);
  });

  it("labels read the same everywhere", () => {
    const base = {
      kind: "indicator", id: "x", epic: "US100", broker: "b", condition: "crossing_up", trigger: "every",
      message: "", expiresAt: null, notify: { toast: true, browser: true, sound: true, push: true, telegram: true },
      precision: 2,
    } as const;
    const price: IndicatorAlert = { ...base, params: {
      identity: { indicator: "MA", calcParams: [50], config: { maType: "ema", source: "close" }, priceTarget: true },
      line: "value", timeframe: "HOUR", target: "price", value: null, evalOn: "close", link: null } };
    expect(alertLabel(price, 2)).toBe("Crossing Up EMA 50 (1H)");
    const val: IndicatorAlert = { ...base, condition: "greater", params: {
      identity: { indicator: "RSI", calcParams: [14], config: { source: "close" }, priceTarget: false },
      line: "value", timeframe: "HOUR", target: "value", value: 70, evalOn: "close", link: null } };
    expect(alertLabel(val, 2)).toBe("RSI 14 (1H) Greater Than 70");
  });

  it("triggeredLabel puts the condition first for a price target (F18)", () => {
    const priceTarget = {
      time: 1, epic: "US100", condition: "crossing_up" as const, level: 21400, price: 21430,
      message: "", precision: 1, alertId: "a", broker: "b",
      label: "EMA 50 (1H)", target: "price" as const,
    };
    expect(triggeredLabel(priceTarget, 2)).toBe("Crossing Up EMA 50 (1H) 21400.00 @ 21430.00");
    const valueTarget = { ...priceTarget, condition: "greater" as const, level: 70, label: "RSI 14 (1H)", target: "value" as const };
    expect(triggeredLabel(valueTarget, 2)).toBe("RSI 14 (1H) Greater Than 70.00 @ 21430.00");
  });

  it("addIndicatorAlert posts the wire shape and rolls back on failure", async () => {
    const broker = freshBroker();
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({}, false, 422)));
    vi.stubGlobal("fetch", fetchMock);
    const a: IndicatorAlert = {
      kind: "indicator", id: "al-z", epic: "US100", broker, condition: "greater", trigger: "once",
      message: "", expiresAt: null, notify: { toast: true, browser: true, sound: true, push: true, telegram: true },
      precision: 2, params: {
        identity: { indicator: "RSI", calcParams: [14], config: { source: "close" }, priceTarget: false },
        line: "value", timeframe: "HOUR", target: "value", value: 70, evalOn: "close", link: null },
    };
    expect(await addIndicatorAlert(a)).toBe(false);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.kind).toBe("indicator");
    expect(body.params).toMatchObject({ indicator: "RSI", calcParams: [14], target: "value", value: 70 });
    expect(loadIndicatorAlerts("US100", broker)).toEqual([]);
  });
});
```

(If `alertsApi.ts` uses `apiFetch` rather than global `fetch`, stub it the same way the existing tests in this file do; follow the pattern already at the top of the file.)

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/lib/alertsApi.test.ts`
Expected: FAIL (missing exports).

- [ ] **Step 3: Implement** (in `lib/alertsApi.ts`)

1. Types. Add `kind?: "price_level";` to `SavedAlert`. Add after `SavedAlert`:

```ts
export type EvalOn = "close" | "intrabar";
export type AlertTarget = "price" | "value";

export const TRIGGER_LABELS: Record<AlertTrigger, string> = {
  once: "Once only",
  every: "Once per bar",
};

export interface IndicatorAlertParams {
  identity: IndicatorIdentity;
  line: "value";
  timeframe: string;
  target: AlertTarget;
  value: number | null;
  evalOn: EvalOn;
  // The chart cell + instance the alert follows. null once the user kept the
  // alert after removing (or un-alertably editing) its indicator.
  link: { scope: string; instanceId: string } | null;
}

export interface IndicatorAlert {
  kind: "indicator";
  id: string;
  epic: string;
  broker: string;
  condition: AlertCondition;
  trigger: AlertTrigger;
  message: string;
  expiresAt: number | null;
  notify: AlertNotifyChannels;
  createdAt?: number;
  precision: number;
  params: IndicatorAlertParams;
  status?: "ok" | "waiting_for_data";
}

export type AnyAlert = SavedAlert | IndicatorAlert;
```

Import `ALERTABLE`, `type IndicatorIdentity` and `indicatorAlertLabel` from `./alertableIndicators`. Extend `TriggeredAlert` with `label?: string; target?: AlertTarget;` and `FiredPayload` with `label?: string; target?: AlertTarget; evalOn?: EvalOn; trigger?: AlertTrigger;`. Extend `TriggeredRow` with `alert?: { params?: Record<string, unknown> } | null`.

2. Wire mapping. `AlertRow.params` becomes `Record<string, unknown>` plus an optional `status?: "ok" | "waiting_for_data"` on `AlertRow`. Keep `rowToSavedAlert` reading its fields with casts. Add:

```ts
function rowToIndicatorAlert(row: AlertRow): IndicatorAlert {
  const p = row.params as Record<string, unknown>;
  return {
    kind: "indicator",
    id: row.id,
    epic: row.epic,
    broker: row.broker,
    condition: p.condition as AlertCondition,
    trigger: p.trigger as AlertTrigger,
    message: row.message,
    expiresAt: row.expires_at,
    notify: { ...ALL_CHANNELS, ...(row.notify ?? {}) },
    createdAt: row.created_at,
    precision: row.precision,
    status: row.status,
    params: {
      identity: {
        indicator: p.indicator as IndicatorIdentity["indicator"],
        calcParams: p.calcParams as number[],
        config: p.config as Record<string, string>,
        priceTarget: ALERTABLE[p.indicator as IndicatorIdentity["indicator"]]?.priceTarget ?? false,
      },
      line: "value",
      timeframe: p.timeframe as string,
      target: p.target as AlertTarget,
      value: (p.value as number | null) ?? null,
      evalOn: p.evalOn as EvalOn,
      link: (p.link as IndicatorAlertParams["link"]) ?? null,
    },
  };
}

function indicatorWireParams(a: { condition: AlertCondition; trigger: AlertTrigger; params: IndicatorAlertParams }) {
  const { identity, ...rest } = a.params;
  return {
    indicator: identity.indicator,
    calcParams: identity.calcParams,
    config: identity.config,
    ...rest,
    condition: a.condition,
    trigger: a.trigger,
  };
}
```

`triggeredRowToClient` adds the label from the stored definition:

```ts
    label: row.alert?.params && row.kind === "indicator"
      ? rowToIndicatorAlertLabel(row.alert.params)
      : undefined,
    target: (row.alert?.params?.target as AlertTarget | undefined) ?? undefined,
```

with

```ts
function rowToIndicatorAlertLabel(p: Record<string, unknown>): string | undefined {
  try {
    return indicatorAlertLabel(
      { indicator: p.indicator, calcParams: p.calcParams, config: p.config, priceTarget: true } as IndicatorIdentity,
      p.timeframe as string,
    );
  } catch {
    return undefined;
  }
}
```

3. Cache. Add `let indicatorCache = new Map<string, IndicatorAlert>();` (id -> alert, all brokers). In `hydrateAlerts`, route rows by kind: `row.kind === "indicator"` goes to a fresh `nextInd` map via `rowToIndicatorAlert`, everything else keeps the existing per-broker/epic path; assign `indicatorCache = nextInd` alongside `alertsCache = next`.

4. Reads and writes:

```ts
export function loadIndicatorAlerts(epic: string, broker: string = getPersistBroker()): IndicatorAlert[] {
  return [...indicatorCache.values()].filter((a) => a.epic === epic && a.broker === broker);
}

export function loadAllIndicatorAlerts(broker: string = getPersistBroker()): IndicatorAlert[] {
  return [...indicatorCache.values()].filter((a) => a.broker === broker);
}

export function linkedAlerts(scope: string, instanceId: string): IndicatorAlert[] {
  return [...indicatorCache.values()].filter(
    (a) => a.params.link?.scope === scope && a.params.link.instanceId === instanceId,
  );
}

async function sendJson(path: string, method: string, body: unknown): Promise<Response | null> {
  try {
    return await apiFetch(url(path, true), {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return null;
  }
}

async function reportFailure(res: Response | null, what: string): Promise<void> {
  let detail = "";
  try {
    detail = res ? ((await res.json()) as { detail?: string }).detail ?? "" : "";
  } catch { /* non-JSON error body */ }
  toast(detail ? `${what}: ${detail}` : what);
}

export async function addIndicatorAlert(a: IndicatorAlert): Promise<boolean> {
  indicatorCache.set(a.id, a);
  bumpAlerts();
  const res = await sendJson("/api/alerts", "POST", {
    id: a.id, broker: a.broker, epic: a.epic, kind: "indicator",
    params: indicatorWireParams(a), message: a.message, expires_at: a.expiresAt,
    notify: a.notify, precision: a.precision,
  });
  if (res?.ok) return true;
  indicatorCache.delete(a.id);
  bumpAlerts();
  await reportFailure(res, "Alert save failed");
  return false;
}

export async function patchIndicatorAlert(
  id: string,
  patch: Partial<Pick<IndicatorAlert, "condition" | "trigger" | "message" | "expiresAt" | "notify">> & {
    params?: Partial<IndicatorAlertParams>;
  },
): Promise<boolean> {
  const prev = indicatorCache.get(id);
  if (!prev) return false;
  const next: IndicatorAlert = { ...prev, ...patch, params: { ...prev.params, ...(patch.params ?? {}) } };
  indicatorCache.set(id, next);
  bumpAlerts();
  const res = await sendJson(`/api/alerts/${encodeURIComponent(id)}`, "PATCH", {
    params: indicatorWireParams(next),
    message: next.message,
    expires_at: next.expiresAt,
    notify: next.notify,
  });
  if (res?.ok) return true;
  indicatorCache.set(id, prev);
  bumpAlerts();
  await reportFailure(res, "Alert update failed");
  return false;
}

export function deleteIndicatorAlert(id: string): void {
  if (!indicatorCache.delete(id)) return;
  bumpAlerts();
  void apiFetch(url(`/api/alerts/${encodeURIComponent(id)}`, true), { method: "DELETE" }).catch(() => {});
}

// One phrase for "what this alert watches" (alertLabel, no concrete level)
// and "what fired/triggered" (firedDetail in useAlertFiredNotices.ts,
// triggeredLabel below): a value-target indicator alert reads
// "<indicator> <condition> <level>" (the indicator leads: the level is a
// plain number on its own scale, e.g. RSI vs 70), everything else reads
// "<condition> <indicator?> <level?>" (the condition leads: the level, when
// shown at all, is a point on the price line the user already sees on the
// chart). `levelText` is omitted entirely (filtered out, not an empty
// segment) when the caller has no concrete level to show (alertLabel for a
// price-target indicator alert names only the line, not a value).
export function conditionPhrase(
  label: string | undefined,
  condition: AlertCondition,
  target: AlertTarget | undefined,
  levelText: string,
): string {
  const cond = CONDITION_LABELS[condition];
  if (target === "value" && label) return `${label} ${cond} ${levelText}`;
  return [cond, label, levelText].filter(Boolean).join(" ");
}

export function alertLabel(a: AnyAlert, precision: number): string {
  if (a.kind !== "indicator") {
    return conditionPhrase(undefined, a.condition, undefined, fmtPrice(a.level, precision));
  }
  const what = indicatorAlertLabel(a.params.identity, a.params.timeframe);
  return a.params.target === "value"
    ? conditionPhrase(what, a.condition, "value", String(a.params.value))
    : conditionPhrase(what, a.condition, "price", "");
}

export function triggeredLabel(t: TriggeredAlert, hp: number): string {
  const levelText = t.target === "value" ? t.level.toFixed(2) : t.level.toFixed(hp);
  return `${conditionPhrase(t.label, t.condition, t.target, levelText)} @ ${t.price.toFixed(hp)}`;
}
```

Import `fmtPrice` from `./priceFormat`. In `applyAlertEvent`'s `fired` branch, copy `label: payload.label, target: payload.target` into the triggered entry.

(`triggeredLabel` is defined here, beside `alertLabel`, but used by `AlertsSidebar.tsx` and `MobileAlertsView.tsx` history rows - Task 16, which replaces their inline formatting.)

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run src/lib/alertsApi.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/alertsApi.ts frontend/src/lib/alertsApi.test.ts
git commit -m "feat(alerts): client for indicator alerts with one shared label

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Indicator edits and removal keep alerts in sync

Spec: "Sync with the indicator".

**Files:**
- Create: `frontend/src/lib/indicatorAlertSync.ts`
- Create: `frontend/src/lib/indicatorAlertSync.test.ts`
- Modify: `frontend/src/lib/signals.ts` (`ConfirmRequest.onCancel?`, `cancelLabel?`)
- Modify: `frontend/src/ConfirmDialog.tsx` (call `onCancel` on Cancel/Escape/backdrop/CloseButton; render `cancelLabel`)
- Create: `frontend/src/ConfirmDialog.test.tsx`
- Modify: `frontend/src/App.tsx` (~line 1364: pass `onCancel`/`cancelLabel` to the `ConfirmDialog` mount)
- Modify: `frontend/src/mobile/MobileModals.tsx` (~line 278: same `ConfirmDialog` props)
- Modify: `frontend/src/IndicatorSettings.tsx` (`ok()`, ~line 1921)
- Modify: `frontend/src/chart/useIndicatorCommands.ts` (`onLegendRemove` ~137, `removeOn` ~480)

**Interfaces:**
- Consumes: Task 10 `checkAlertable`, Task 11 `linkedAlerts`, `patchIndicatorAlert`, `deleteIndicatorAlert`.
- Produces:
  - `planSync(alerts: IndicatorAlert[], check: AlertableCheck): { patch: Array<{ id: string; identity: IndicatorIdentity }>; conflict: boolean }` (pure; a `hidden` check is NEVER a conflict - see F6 below)
  - `syncAlertsAfterEdit(scope: string, instanceId: string, checkFor: (timeframe: string) => AlertableCheck): void` (takes a resolver, not one precomputed check: linked alerts can have different native timeframes, and each must be checked against ITS OWN `params.timeframe` - never the chart's currently-displayed resolution, which can be a non-native or hidden view while the alert's own timeframe is perfectly fine; see F6)
  - `syncAlertsAfterRemove(scope: string, instanceId: string): void`

- [ ] **Step 1: Write the failing tests** (`indicatorAlertSync.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { planSync } from "./indicatorAlertSync";
import type { IndicatorAlert } from "./alertsApi";

const ema = (n: number) => ({ indicator: "MA" as const, calcParams: [n], config: { maType: "ema", source: "close" }, priceTarget: true });
const alert = (id: string, n: number): IndicatorAlert => ({
  kind: "indicator", id, epic: "US100", broker: "b", condition: "crossing", trigger: "every", message: "",
  expiresAt: null, notify: { toast: true, browser: true, sound: true, push: true, telegram: true }, precision: 2,
  params: { identity: ema(n), line: "value", timeframe: "HOUR", target: "price", value: null, evalOn: "close",
    link: { scope: "s", instanceId: "EMA" } },
});

describe("planSync", () => {
  it("patches only alerts whose identity changed", () => {
    const plan = planSync([alert("a", 50), alert("b", 100)], { ok: true, identity: ema(100) });
    expect(plan).toEqual({ patch: [{ id: "a", identity: ema(100) }], conflict: false });
  });
  it("flags a conflict when the new settings are not alertable", () => {
    expect(planSync([alert("a", 50)], { ok: false, reason: "x" })).toEqual({ patch: [], conflict: true });
  });
  it("a hidden check is never a conflict (F6)", () => {
    // `hidden` means the chart's CURRENTLY DISPLAYED resolution is a
    // non-native/seconds view, not that the linked alert's own timeframe
    // stopped being alertable. Browsing a 5s chart while editing an EMA
    // must not prompt to delete its hourly alert.
    expect(planSync([alert("a", 50)], { ok: false, hidden: true })).toEqual({ patch: [], conflict: false });
  });
  it("does nothing without linked alerts", () => {
    expect(planSync([], { ok: false, reason: "x" })).toEqual({ patch: [], conflict: false });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/lib/indicatorAlertSync.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `lib/indicatorAlertSync.ts`**

```ts
// Keeps an indicator's alerts in step with the indicator: settings edits
// re-point them, removal asks whether to delete them. Alerts are matched by
// {scope, instanceId} because instance ids repeat across chart cells.
import { requestConfirm } from "./signals";
import type { AlertableCheck, IndicatorIdentity } from "./alertableIndicators";
import {
  deleteIndicatorAlert, linkedAlerts, patchIndicatorAlert, type IndicatorAlert,
} from "./alertsApi";

const sameIdentity = (a: IndicatorIdentity, b: IndicatorIdentity) =>
  a.indicator === b.indicator &&
  JSON.stringify(a.calcParams) === JSON.stringify(b.calcParams) &&
  JSON.stringify(Object.entries(a.config).sort()) === JSON.stringify(Object.entries(b.config).sort());

export function planSync(
  alerts: IndicatorAlert[],
  check: AlertableCheck,
): { patch: Array<{ id: string; identity: IndicatorIdentity }>; conflict: boolean } {
  if (alerts.length === 0) return { patch: [], conflict: false };
  if (!check.ok) {
    // `hidden` means the CHART's current view can't show an alert entry
    // point right now (e.g. a seconds chart) - it says nothing about
    // whether the alert's own (native, already-validated) timeframe is
    // still alertable. Only a real reason (settings no longer alertable) is
    // a conflict.
    return { patch: [], conflict: !("hidden" in check) };
  }
  return {
    patch: alerts
      .filter((a) => !sameIdentity(a.params.identity, check.identity))
      .map((a) => ({ id: a.id, identity: check.identity })),
    conflict: false,
  };
}

const plural = (n: number) => (n === 1 ? "1 alert" : `${n} alerts`);

function unlink(alerts: IndicatorAlert[]): void {
  for (const a of alerts) void patchIndicatorAlert(a.id, { params: { link: null } });
}

export function syncAlertsAfterEdit(
  scope: string,
  instanceId: string,
  checkFor: (timeframe: string) => AlertableCheck,
): void {
  const alerts = linkedAlerts(scope, instanceId);
  if (alerts.length === 0) return;
  // Alerts on the SAME indicator instance can sit on different native
  // timeframes (one HOUR alert, one DAY alert); each is checked against ITS
  // OWN `params.timeframe`, never the chart's currently-displayed
  // resolution (F6) - the chart's view has nothing to do with whether an
  // individual alert's own timeframe is still valid.
  const byTimeframe = new Map<string, IndicatorAlert[]>();
  for (const a of alerts) {
    const group = byTimeframe.get(a.params.timeframe) ?? [];
    group.push(a);
    byTimeframe.set(a.params.timeframe, group);
  }
  const conflicted: IndicatorAlert[] = [];
  for (const [timeframe, group] of byTimeframe) {
    const plan = planSync(group, checkFor(timeframe));
    for (const p of plan.patch) void patchIndicatorAlert(p.id, { params: { identity: p.identity } });
    if (plan.conflict) conflicted.push(...group);
  }
  if (conflicted.length === 0) return;
  requestConfirm({
    title: "Indicator alerts",
    message: `These settings can't be alerted on. Delete its ${plural(conflicted.length)}, or keep them on the old settings?`,
    confirmLabel: "Delete",
    cancelLabel: "Keep",
    onConfirm: () => conflicted.forEach((a) => deleteIndicatorAlert(a.id)),
    onCancel: () => unlink(conflicted),
  });
}

export function syncAlertsAfterRemove(scope: string, instanceId: string): void {
  const alerts = linkedAlerts(scope, instanceId);
  if (alerts.length === 0) return;
  requestConfirm({
    title: "Indicator alerts",
    message: `Also delete its ${plural(alerts.length)}?`,
    confirmLabel: "Delete",
    cancelLabel: "Keep",
    onConfirm: () => alerts.forEach((a) => deleteIndicatorAlert(a.id)),
    onCancel: () => unlink(alerts),
  });
}
```

`patchIndicatorAlert`'s `params` patch is shallow over `IndicatorAlertParams`, so `{ identity }` and `{ link: null }` each replace one field.

- [ ] **Step 4: ConfirmRequest cancel support**

In `lib/signals.ts` `ConfirmRequest` add:

```ts
  cancelLabel?: string; // default "Cancel"
  // Runs when the dialog is dismissed without confirming (Cancel, Escape, backdrop, CloseButton).
  onCancel?: () => void;
```

`ConfirmDialog.tsx` is prop-driven (`onConfirm`, `onClose`), not signal-driven itself - App/MobileModals read the `confirm` signal and pass its fields down as props. Today EVERY dismissal path (backdrop `onMouseDown`, `CloseButton`, the Cancel button, `useCloseOnEscape`, AND the confirm button's own `onConfirm(); onClose();`) calls the SAME `onClose`, so there is no way to run something on cancel-only without this change. Add `onCancel` and `cancelLabel` props and a `handleCancel` that wraps `onClose`, used by every path EXCEPT the confirm button:

```tsx
interface Props {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  details?: Array<{ label: string; value: string; tone?: "pos" | "neg" }>;
  onConfirm: () => void;
  onClose: () => void;
  onCancel?: () => void;
}

export default function ConfirmDialog({
  title = "Confirm",
  message,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  details,
  onConfirm,
  onClose,
  onCancel,
}: Props) {
  const handleCancel = () => {
    onCancel?.();
    onClose();
  };
  useCloseOnEscape(handleCancel);
  return (
    <div className="modal-backdrop" onMouseDown={handleCancel}>
      <div className="modal confirm-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head confirm-head">
          <span>{title}</span>
          <CloseButton onClick={handleCancel} label={cancelLabel} />
        </div>
        <div className="confirm-body">
          {message}
          {details && details.length > 0 && (
            <dl className="confirm-details">
              {details.map((d) => (
                <div key={d.label} className="confirm-detail-row">
                  <dt>{d.label}</dt>
                  <dd className={d.tone ? `cd-${d.tone}` : undefined}>{d.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
        <div className="modal-foot">
          <button className="ghost" onClick={handleCancel}>
            {cancelLabel}
          </button>
          <button
            className="confirm-danger"
            autoFocus
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
```

(The confirm button deliberately keeps calling `onClose` directly, NOT `handleCancel` - confirming is not canceling.)

Add `frontend/src/ConfirmDialog.test.tsx` (there is no existing test file for this component):

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ConfirmDialog from "./ConfirmDialog";

describe("ConfirmDialog", () => {
  it("Cancel runs onCancel then onClose; Confirm runs onConfirm then onClose, never onCancel", () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    const onCancel = vi.fn();
    render(<ConfirmDialog message="Delete this?" onConfirm={onConfirm} onClose={onClose} onCancel={onCancel} />);
    fireEvent.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
  it("Confirm never calls onCancel", () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    const onCancel = vi.fn();
    render(<ConfirmDialog message="Delete this?" onConfirm={onConfirm} onClose={onClose} onCancel={onCancel} />);
    fireEvent.click(screen.getByText("Delete"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });
  it("renders a custom cancelLabel and calls onCancel from it", () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog message="x" cancelLabel="Keep" onConfirm={() => {}} onClose={() => {}} onCancel={onCancel} />);
    fireEvent.click(screen.getByText("Keep"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
```

Then thread the new props at BOTH `ConfirmDialog` mounts (App.tsx:1364, mobile/MobileModals.tsx:278 - both read the `confirm` field of the `confirm` signal and pass it through as-is already, so this is additive):

```tsx
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.confirmLabel}
          cancelLabel={confirm.cancelLabel}
          details={confirm.details}
          onConfirm={confirm.onConfirm}
          onCancel={confirm.onCancel}
          onClose={() => confirmRequest.set(null)}
        />
```

- [ ] **Step 5: Call sites**

`IndicatorSettings.tsx` `ok()`: after `saveIndicatorConfig(scope, name, cfg);` add

```ts
    syncAlertsAfterEdit(
      scope,
      name,
      (timeframe) => checkAlertable(indTypeOf(ind), cfg.calcParams, cfg.extendData as Record<string, unknown>, timeframe, true),
    );
```

(`hasVolume: true` here: the volume rule only gates CREATING a VWMA/EVWMA alert; an existing one follows its indicator. `ind` and `indTypeOf` are already in scope in this component; import `indTypeOf` from `./lib/indicators/shared` if not. NOTE this passes each linked alert's OWN `timeframe` - supplied by `syncAlertsAfterEdit` itself per F6 - not `chartResolution`: the chart's currently-displayed resolution is irrelevant to whether an EXISTING alert's own native timeframe is still alertable, and using it would wrongly flag a conflict whenever the chart happens to be showing a non-native or seconds view while the user edits the indicator.)

`useIndicatorCommands.ts`: in both `onLegendRemove` and `removeOn`, right after `removeIndicatorById(c, scope, name);` add `syncAlertsAfterRemove(scope, name);`. Do NOT add it to `setIndicatorInset` (that path keeps the instance).

- [ ] **Step 6: Run to verify pass**

Run: `cd frontend && npx vitest run src/lib/indicatorAlertSync.test.ts src/ConfirmDialog.test.tsx src/chart/useIndicatorCommands.clipboard.test.tsx && npx tsc -b`
Expected: PASS, tsc clean.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/indicatorAlertSync.ts frontend/src/lib/indicatorAlertSync.test.ts \
  frontend/src/lib/signals.ts frontend/src/ConfirmDialog.tsx frontend/src/ConfirmDialog.test.tsx \
  frontend/src/App.tsx frontend/src/mobile/MobileModals.tsx \
  frontend/src/IndicatorSettings.tsx frontend/src/chart/useIndicatorCommands.ts
git commit -m "feat(alerts): indicator alerts follow edits and ask on removal

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Indicator alert dialog (shared fields extracted)

Spec: "The dialog in indicator mode", "Design principles" (modal composition), "Once per bar" UI.

**Files:**
- Create: `frontend/src/components/AlertCommonFields.tsx` (trigger, expiry, message, notifications; moved out of `AlertModal.tsx` together with `ExpiryField`, `CHANNELS`, `ALL_ON`)
- Modify: `frontend/src/AlertModal.tsx` (use `AlertCommonFields`; behavior unchanged except the trigger label)
- Create: `frontend/src/IndicatorAlertModal.tsx`
- Create: `frontend/src/IndicatorAlertModal.test.tsx`
- Modify: `frontend/src/lib/signals.ts` (`indicatorAlertRequest`)
- Modify: `frontend/src/theme.ts` (export `DEFAULT_ALERT_DEFAULTS`, ~line 186 - it exists but isn't exported today)
- Modify: `frontend/src/app/usePanelSignals.ts` (`useModalRequests()` gains `indAlertReq`; App reads modal signals through this hook, not an inline `useSignal`)
- Modify: `frontend/src/App.tsx` (mount next to the AlertModal mounts, ~line 1211; read `indAlertReq` from `useModalRequests()`)
- Modify: `frontend/src/mobile/MobileModals.tsx` (same mount, so mobile edit works; this file already has its own local `useSignal` helper)

**Interfaces:**
- Consumes: Task 10 (`IndicatorIdentity`, `indicatorAlertLabel`), Task 11 (`IndicatorAlert`, `addIndicatorAlert`, `patchIndicatorAlert`, `deleteIndicatorAlert`, `TRIGGER_LABELS`).
- Produces:
  - `useAlertCommonState(initial, defaults, now, isEdit)` returning `{ trigger, setTrigger, expiresAt, setExpiresAt, message, setMessage, notify, setNotify }`, and `<AlertCommonFields state={...} now={now} autoMsg={string} />`
  - `indicatorAlertRequest: Signal<IndicatorAlertRequest | null>` with `type IndicatorAlertRequest = { mode: "create"; draft: IndicatorAlertDraft } | { mode: "edit"; id: string }` and `interface IndicatorAlertDraft { epic: string; broker: string; precision: number; identity: IndicatorIdentity; timeframe: string; link: { scope: string; instanceId: string }; lastValue: number | null; quoteOnly: boolean }`

- [ ] **Step 1: Write the failing test** (`IndicatorAlertModal.test.tsx`; follow the render helpers used by `mobile/MobileAlertsView.test.tsx` for React Testing Library setup and the `vi.mock("klinecharts", ...)` stub)

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// vi.mock factories are hoisted ABOVE const declarations: a plain
// `const add = vi.fn(...)` referenced inside the factory would throw (TDZ).
// vi.hoisted runs before that hoisting and is the documented escape hatch.
const { add } = vi.hoisted(() => ({ add: vi.fn(() => Promise.resolve(true)) }));
vi.mock("./lib/alertsApi", async (orig) => ({ ...(await orig<typeof import("./lib/alertsApi")>()), addIndicatorAlert: add }));

import IndicatorAlertModal from "./IndicatorAlertModal";
import { DEFAULT_ALERT_DEFAULTS } from "./theme";

const draft = (over = {}) => ({
  epic: "US100", broker: "b", precision: 2, timeframe: "HOUR",
  identity: { indicator: "RSI" as const, calcParams: [14], config: { source: "close" }, priceTarget: false },
  link: { scope: "s", instanceId: "RSI" }, lastValue: 55.5, quoteOnly: false, ...over,
});

describe("IndicatorAlertModal", () => {
  it("oscillators only offer value vs number, prefilled with the last value", () => {
    render(<IndicatorAlertModal request={{ mode: "create", draft: draft() }} defaults={DEFAULT_ALERT_DEFAULTS} now={0} onClose={() => {}} />);
    expect(screen.queryByLabelText("Price vs line")).toBeNull();
    expect((screen.getByLabelText("Alert value") as HTMLInputElement).value).toBe("55.5");
    expect(screen.getByText("RSI 14 (1H)")).toBeTruthy();
  });
  it("quote-only volume-weighted MAs disable As it happens", () => {
    const d = draft({ identity: { indicator: "MA", calcParams: [20], config: { maType: "vwma", source: "close" }, priceTarget: true }, quoteOnly: true });
    render(<IndicatorAlertModal request={{ mode: "create", draft: d }} defaults={DEFAULT_ALERT_DEFAULTS} now={0} onClose={() => {}} />);
    expect((screen.getByLabelText("As it happens") as HTMLInputElement).disabled).toBe(true);
  });
  it("creates with the wire params", async () => {
    render(<IndicatorAlertModal request={{ mode: "create", draft: draft() }} defaults={DEFAULT_ALERT_DEFAULTS} now={0} onClose={() => {}} />);
    fireEvent.click(screen.getByText("Create"));
    const a = add.mock.calls[0][0];
    expect(a.params).toMatchObject({ target: "value", value: 55.5, evalOn: "close", timeframe: "HOUR" });
  });
});
```

(`DEFAULT_ALERT_DEFAULTS` already exists in `theme.ts` (~line 186) but is not exported today - export it there as part of this task, rather than inlining a duplicate default object here.)

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/IndicatorAlertModal.test.tsx`
Expected: FAIL (module missing).

- [ ] **Step 3: Extract `components/AlertCommonFields.tsx`**

Move from `AlertModal.tsx`, unchanged: `ALL_ON`, `CHANNELS`, the `ExpiryField` function, the Trigger + Expiration row, the Message field and the Notifications field. Export:

```tsx
export interface AlertCommonState {
  trigger: AlertTrigger; setTrigger: (t: AlertTrigger) => void;
  expiresAt: number | null; setExpiresAt: (ms: number | null) => void;
  message: string; setMessage: (m: string) => void;
  notify: AlertNotifyChannels; setNotify: (n: AlertNotifyChannels) => void;
}

export function useAlertCommonState(
  initial: { trigger: AlertTrigger; message: string; expiresAt?: number | null; notify?: AlertNotifyChannels } | undefined,
  defaults: AlertDefaults,
  now: number,
  isEdit: boolean,
): AlertCommonState {
  const [trigger, setTrigger] = useState<AlertTrigger>(initial?.trigger ?? defaults.trigger);
  const [message, setMessage] = useState(initial?.message ?? "");
  const [expiresAt, setExpiresAt] = useState<number | null>(
    isEdit ? initial?.expiresAt ?? null : resolveExpiry(defaults.expiry, now),
  );
  const [notify, setNotify] = useState<AlertNotifyChannels>(initial?.notify ?? (isEdit ? ALL_ON : defaults.notify));
  return { trigger, setTrigger, expiresAt, setExpiresAt, message, setMessage, notify, setNotify };
}

export default function AlertCommonFields({ state, now, autoMsg }: { state: AlertCommonState; now: number; autoMsg: string }) {
  // The JSX moved verbatim from AlertModal (Trigger+Expiration row, Message,
  // Notifications), reading/writing through `state`. The trigger select now
  // reads from TRIGGER_LABELS and carries an InfoTip:
  //   <option value="once">{TRIGGER_LABELS.once}</option>
  //   <option value="every">{TRIGGER_LABELS.every}</option>
  //   <InfoTip title="Once per bar" text={["Fires at most once per candle", "Uses the alert's timeframe"]} />
}
```

In `AlertModal.tsx`, replace the moved state with `const common = useAlertCommonState(initial, defaults, now, isEdit);`, replace the moved JSX with `<AlertCommonFields state={common} now={now} autoMsg={autoMsg} />`, and read `common.trigger` etc. in `create()`. Condition + value row and the start-at-creation checkbox stay in `AlertModal`.

- [ ] **Step 4: Add the signal** (`lib/signals.ts`, next to `alertEditRequest`)

```ts
// Request to open the indicator alert modal: create (from an indicator's
// legend bell or menu) or edit (from the alerts panel). App renders it.
export interface IndicatorAlertDraft {
  epic: string;
  broker: string;
  precision: number;
  identity: IndicatorIdentity;
  timeframe: string;
  link: { scope: string; instanceId: string };
  lastValue: number | null;
  quoteOnly: boolean;
}
export type IndicatorAlertRequest =
  | { mode: "create"; draft: IndicatorAlertDraft }
  | { mode: "edit"; id: string };
export const indicatorAlertRequest = new Signal<IndicatorAlertRequest | null>(null);
```

(`import type { IndicatorIdentity } from "./alertableIndicators";`.)

- [ ] **Step 5: Implement `IndicatorAlertModal.tsx`**

```tsx
// Indicator alert dialog: the target section (what is compared, when) on top
// of the shared alert fields. Create comes from an indicator; edit from the
// alerts panel.
import { useEffect, useState } from "react";
import FloatingModal from "./components/FloatingModal";
import InfoTip from "./components/InfoTip";
import AlertCommonFields, { useAlertCommonState } from "./components/AlertCommonFields";
import { CONDITIONS } from "./lib/alertUi";
import { indicatorAlertLabel, MAIN_LINE_KEY } from "./lib/alertableIndicators";
import {
  addIndicatorAlert, deleteIndicatorAlert, loadAllIndicatorAlerts, patchIndicatorAlert,
  type AlertCondition, type AlertTarget, type EvalOn, type IndicatorAlert,
} from "./lib/alertsApi";
import { requestConfirm, type IndicatorAlertRequest } from "./lib/signals";
import type { AlertDefaults } from "./theme";

interface Props {
  request: IndicatorAlertRequest;
  defaults: AlertDefaults;
  now: number;
  onClose: () => void;
}

const newId = () => `al-${crypto.randomUUID()}`;

export default function IndicatorAlertModal({ request, defaults, now, onClose }: Props) {
  const existing = request.mode === "edit" ? findAlert(request.id) : undefined;
  useEffect(() => {
    if (request.mode === "edit" && !existing) onClose(); // deleted elsewhere
  }, [request, existing, onClose]);
  if (request.mode === "edit" && !existing) return null;
  const isEdit = request.mode === "edit";
  const base = isEdit
    ? {
        epic: existing!.epic, broker: existing!.broker, precision: existing!.precision,
        identity: existing!.params.identity, timeframe: existing!.params.timeframe,
        link: existing!.params.link, lastValue: existing!.params.value, quoteOnly: false,
      }
    : request.draft;
  return <Body {...{ base, existing, isEdit, defaults, now, onClose }} />;
}

function findAlert(id: string): IndicatorAlert | undefined {
  return loadAllIndicatorAlerts().find((a) => a.id === id);
}
```

`findAlert` scans the ACTIVE broker's indicator alerts; the panel only offers edit for alerts of the active broker, same as price alerts.

`Body` holds the target state and renders:

```tsx
function Body({ base, existing, isEdit, defaults, now, onClose }: {
  base: { epic: string; broker: string; precision: number; identity: IndicatorAlert["params"]["identity"];
    timeframe: string; link: IndicatorAlert["params"]["link"]; lastValue: number | null; quoteOnly: boolean };
  existing?: IndicatorAlert; isEdit: boolean; defaults: AlertDefaults; now: number; onClose: () => void;
}) {
  const common = useAlertCommonState(existing, defaults, now, isEdit);
  const [target, setTarget] = useState<AlertTarget>(
    existing?.params.target ?? (base.identity.priceTarget ? "price" : "value"),
  );
  const [condition, setCondition] = useState<AlertCondition>(existing?.condition ?? defaults.condition);
  const [value, setValue] = useState(
    existing?.params.value != null ? String(existing.params.value)
      : base.lastValue != null ? String(+base.lastValue.toFixed(4)) : "",
  );
  const volumeWeighted = base.identity.indicator === "MA" &&
    (base.identity.config.maType === "vwma" || base.identity.config.maType === "evwma");
  const intrabarBlocked = volumeWeighted && base.quoteOnly;
  const [evalOn, setEvalOn] = useState<EvalOn>(existing?.params.evalOn ?? "close");
  const label = indicatorAlertLabel(base.identity, base.timeframe);
  const num = Number(value);
  const valid = target === "price" || (value.trim() !== "" && Number.isFinite(num));
  const condLabel = CONDITIONS.find((c) => c.value === condition)?.label ?? "";
  const autoMsg = target === "price"
    ? `${base.epic} ${condLabel} ${label}`
    : `${base.epic} ${label} ${condLabel}${valid ? ` ${num}` : ""}`;

  async function save() {
    if (!valid) return;
    const params = {
      identity: base.identity, line: "value" as const, timeframe: base.timeframe, target,
      value: target === "value" ? num : null, evalOn, link: base.link,
    };
    const fields = {
      condition, trigger: common.trigger, message: common.message.trim() || autoMsg,
      expiresAt: common.expiresAt, notify: common.notify,
    };
    const ok = isEdit
      ? await patchIndicatorAlert(existing!.id, { ...fields, params })
      : await addIndicatorAlert({
          kind: "indicator", id: newId(), epic: base.epic, broker: base.broker,
          precision: base.precision, createdAt: Date.now(), params, ...fields,
        });
    if (ok) onClose();
  }

  return (
    <FloatingModal
      className="alert-modal"
      title={<span>{isEdit ? "Edit alert on " : "Create alert on "}<strong>{base.epic}</strong></span>}
      onClose={onClose}
      footer={
        <>
          {isEdit && (
            <button className="ghost" onClick={() => requestConfirm({
              message: `Delete this alert on ${base.epic}?`,
              onConfirm: () => { deleteIndicatorAlert(existing!.id); onClose(); },
            })}>Delete</button>
          )}
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button className="confirm-primary" onClick={() => void save()} disabled={!valid}>
            {isEdit ? "Save" : "Create"}
          </button>
        </>
      }
    >
      <div className="alert-body">
        <div className="al-field">
          <span>Indicator</span>
          <strong>{label}</strong>
        </div>
        {base.identity.priceTarget && (
          <div className="al-field" role="radiogroup" aria-label="Compare">
            <label><input type="radio" aria-label="Price vs line" checked={target === "price"} onChange={() => setTarget("price")} /> Price vs line</label>
            <label><input type="radio" aria-label="Value vs number" checked={target === "value"} onChange={() => setTarget("value")} /> Value vs number</label>
          </div>
        )}
        <div className="al-field">
          <span>Condition</span>
          <div className="al-cond">
            <select className="al-operator" aria-label="Alert condition" value={condition}
              onChange={(e) => setCondition(e.target.value as AlertCondition)}>
              {CONDITIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
            {target === "value" && (
              <input className="al-value" type="number" step="any" aria-label="Alert value"
                value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
            )}
          </div>
        </div>
        <div className="al-field" role="radiogroup" aria-label="Evaluate">
          <span>Evaluate</span>
          <label><input type="radio" aria-label="On bar close" checked={evalOn === "close"} onChange={() => setEvalOn("close")} /> On bar close</label>
          <label><input type="radio" aria-label="As it happens" disabled={intrabarBlocked}
            checked={evalOn === "intrabar"} onChange={() => setEvalOn("intrabar")} /> As it happens</label>
          <InfoTip title="Evaluate" text={
            intrabarBlocked
              ? ["This broker sends quotes only", "Volume-weighted lines need a closed bar"]
              : ["On bar close: no repaint", "As it happens: fires on the live candle"]
          } />
        </div>
        <AlertCommonFields state={common} now={now} autoMsg={autoMsg} />
      </div>
    </FloatingModal>
  );
}
```

`MAIN_LINE_KEY` is unused here; drop it from the import (Task 14 uses it). Reuse the existing `.al-field`, `.al-cond`, `.al-operator`, `.al-value` classes; add only minimal CSS beside the existing `.alert-modal` rules in `App.css` if the radio rows need spacing.

- [ ] **Step 6: Export the defaults constant**

`theme.ts`: change `const DEFAULT_ALERT_DEFAULTS: AlertDefaults = {` to `export const DEFAULT_ALERT_DEFAULTS: AlertDefaults = {`. Nothing else in the file changes; this constant already exists and is already correct, just private.

- [ ] **Step 7: Mount in App and mobile**

App does NOT read signals with a generic inline hook - every modal-request signal (`alertModalRequest`, `confirmRequest`, etc.) is read through `useModalRequests()` in `app/usePanelSignals.ts`, and App destructures its return value. Add `indicatorAlertRequest` to that hook rather than inventing a one-off `useSignal` in App.tsx (which does not exist there - `mobile/MobileModals.tsx` has its own LOCAL `useSignal` helper, a different file, and the direct form IS correct there).

In `app/usePanelSignals.ts`: import `indicatorAlertRequest` from `../lib/signals`, and in `useModalRequests()` add

```ts
  const [indAlertReq, setIndAlertReq] = useState(indicatorAlertRequest.value);
  useEffect(() => indicatorAlertRequest.subscribe(setIndAlertReq), []);
```

and add `indAlertReq` to the hook's returned object.

`App.tsx`: destructure `indAlertReq` from the existing `useModalRequests()` call (next to `alertReq`, `confirm`, etc. - do not add a second call), then mount after the AlertModal create mount:

```tsx
      {!isDemoMode() && indAlertReq && (
        <IndicatorAlertModal
          request={indAlertReq}
          defaults={settings.alertDefaults}
          now={Date.now()}
          onClose={() => indicatorAlertRequest.set(null)}
        />
      )}
```

`mobile/MobileModals.tsx` DOES have its own local `useSignal<T>(sig)` helper (defined in that file, not shared with App) - add `indicatorAlertRequest` to its imports from `../lib/signals` and `const indAlertReq = useSignal(indicatorAlertRequest);` next to its other `useSignal(...)` lines, then add the identical mount next to its other alert modal mounts.

- [ ] **Step 8: Run to verify pass**

Run: `cd frontend && npx vitest run src/IndicatorAlertModal.test.tsx src/lib/alertUi.test.ts && npx tsc -b && npx eslint src/AlertModal.tsx src/IndicatorAlertModal.tsx src/components/AlertCommonFields.tsx src/app/usePanelSignals.ts`
Expected: PASS, tsc and eslint clean.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/components/AlertCommonFields.tsx frontend/src/AlertModal.tsx \
  frontend/src/IndicatorAlertModal.tsx frontend/src/IndicatorAlertModal.test.tsx \
  frontend/src/lib/signals.ts frontend/src/theme.ts frontend/src/app/usePanelSignals.ts \
  frontend/src/App.tsx frontend/src/mobile/MobileModals.tsx frontend/src/App.css
git commit -m "feat(alerts): indicator alert dialog on shared alert fields

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: "Add alert" on the indicator (legend bell and menu)

Spec: "Creating".

**Files:**
- Create: `frontend/src/chart/indicatorAlertDraft.ts`
- Create: `frontend/src/chart/indicatorAlertDraft.test.ts`
- Modify: `backend/auto_trader/brokers/registry.py` (`describe()` gains a `streaming` field)
- Modify: `backend/tests/test_registry.py` (append)
- Modify: `frontend/src/lib/trading.ts` (`BrokerInfo.streaming?`, `noteStreamingBrokers`, `supportsStreaming`)
- Modify: `frontend/src/ChartLegend.tsx` (`IndicatorRow` icons ~line 783; `Props` ~110; pass-through in the row renderers at ~569, ~645, ~661, ~885, ~1012)
- Modify: `frontend/src/chart/useIndicatorCommands.ts` (`indicatorMenuItems` ~633; new `onLegendAddAlert`; return it)
- Modify: `frontend/src/ChartCore.tsx` (~5679-5725: pass `onAddAlert` and `alertCheck` to `ChartLegend`; fill `alertContext.quoteOnly` from `supportsStreaming`)

**Interfaces:**
- Consumes: Task 10 `checkAlertable`, `MAIN_LINE_KEY`; Task 13 `indicatorAlertRequest`, `IndicatorAlertDraft`; `getIndicator`, `indTypeOf`.
- Produces:
  - `buildIndicatorAlertDraft(args: { chart: Chart; paneId: string; name: string; scope: string; epic: string; broker: string; precision: number; resolution: string; quoteOnly: boolean }): { draft: IndicatorAlertDraft } | { reason: string } | null` (null = hide the entry)
  - `ChartLegend` props `onAddAlert?(name: string)` and `alertCheck?(name: string): { reason: string | null } | null` (null = no bell)
  - `GET /api/brokers` response gains `streaming: string[]` (broker ids with `supports_streaming=True`); frontend `supportsStreaming(brokerId: string): boolean` (see F11 below - without this, the dialog's "As it happens" toggle for a quote-only broker's VWMA/EVWMA alert can never disable, since nothing on the frontend knows which brokers stream)

- [ ] **Step 1: Write the failing test** (`chart/indicatorAlertDraft.test.ts`)

```ts
import { describe, it, expect, vi } from "vitest";
vi.mock("klinecharts", () => ({
  registerIndicator: () => {}, registerOverlay: () => {}, registerYAxis: () => {},
  getSupportedIndicators: () => [],
}));
import type { Chart } from "klinecharts";
import { buildIndicatorAlertDraft } from "./indicatorAlertDraft";

function chartWith(ind: Record<string, unknown>, volumes = [10, 10]): Chart {
  return {
    getIndicators: () => [ind],
    getDataList: () => volumes.map((v) => ({ volume: v })),
  } as unknown as Chart;
}
const args = (chart: Chart) => ({
  chart, paneId: "pane_rsi", name: "RSI", scope: "tab.t1.cell.c2", epic: "US100",
  broker: "b", precision: 2, resolution: "HOUR", quoteOnly: false,
});

describe("buildIndicatorAlertDraft", () => {
  it("builds a draft with the last value and the cell link", () => {
    const ind = { name: "RSI", calcParams: [14], extendData: {}, result: [{ val: 40 }, { val: 61.25 }] };
    const r = buildIndicatorAlertDraft(args(chartWith(ind)));
    expect(r && "draft" in r && r.draft).toMatchObject({
      lastValue: 61.25, timeframe: "HOUR", link: { scope: "tab.t1.cell.c2", instanceId: "RSI" },
      identity: { indicator: "RSI", calcParams: [14] },
    });
  });
  it("returns the reason for a non-alertable config", () => {
    const ind = { name: "EMA", calcParams: [50], extendData: { offset: 3 }, result: [] };
    const r = buildIndicatorAlertDraft({ ...args(chartWith(ind)), name: "EMA", paneId: "candle_pane" });
    expect(r && "reason" in r && r.reason).toContain("offset");
  });
});
```

(Adjust the fake chart to whatever `getIndicator(chart, paneId, name)` in `lib/indicators.ts:73` actually calls; read that function first and fake exactly those methods.)

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/chart/indicatorAlertDraft.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `chart/indicatorAlertDraft.ts`**

```ts
// Turns a live chart indicator into an alert draft (or the reason it cannot
// have one). Shared by the legend bell and the indicator menu.
import type { Chart } from "klinecharts";
import { checkAlertable, MAIN_LINE_KEY } from "../lib/alertableIndicators";
import { getIndicator } from "../lib/indicators";
import { indTypeOf } from "../lib/indicators/shared";
import type { IndicatorAlertDraft } from "../lib/signals";

export function buildIndicatorAlertDraft(args: {
  chart: Chart; paneId: string; name: string; scope: string; epic: string; broker: string;
  precision: number; resolution: string; quoteOnly: boolean;
}): { draft: IndicatorAlertDraft } | { reason: string } | null {
  const ind = getIndicator(args.chart, args.paneId, args.name);
  if (!ind) return null;
  const data = args.chart.getDataList();
  const hasVolume = data.slice(-50).some((k) => (k.volume ?? 0) > 0);
  const check = checkAlertable(
    indTypeOf(ind), ind.calcParams as unknown[], ind.extendData as Record<string, unknown>,
    args.resolution, hasVolume,
  );
  if (!check.ok) return "reason" in check ? { reason: check.reason } : null;
  const result = (ind.result ?? []) as Array<Record<string, number | undefined>>;
  const key = MAIN_LINE_KEY[check.identity.indicator];
  let lastValue: number | null = null;
  for (let i = result.length - 1; i >= 0; i--) {
    const v = result[i]?.[key];
    if (typeof v === "number" && Number.isFinite(v)) { lastValue = v; break; }
  }
  return {
    draft: {
      epic: args.epic, broker: args.broker, precision: args.precision, identity: check.identity,
      timeframe: args.resolution, link: { scope: args.scope, instanceId: args.name },
      lastValue, quoteOnly: args.quoteOnly,
    },
  };
}
```

- [ ] **Step 4: Backend streaming list + frontend consumer (F11)**

The dialog's "As it happens disabled on a quote-only broker" rule (Global Constraints, Task 13) needs the frontend to know WHICH brokers stream. Today it doesn't: `supports_streaming` (`brokers/base.py:46`) is a backend-only flag (`/api/brokers`'s `describe()` never ships it), so there is no `quoteOnly` source to fill `alertContext` from - falling back to a hardcoded `false` would mean the dialog's intrabar-disable rule never fires for a real broker. Add it the same way `categories`/`labels` are already shipped (`brokers/registry.py`, `describe()`):

```python
            "streaming": sorted(
                bid for bid in data_ids
                if (broker := self.data.get(bid)) and getattr(broker, "supports_streaming", False)
            ),
```

(Add this key beside `"categories"` in the dict `describe()` returns; `data_ids` is already computed above it in that function.)

Append to `backend/tests/test_registry.py`:

```python
def test_describe_streaming_lists_streaming_brokers() -> None:
    info = build_registry().describe()
    assert "capital" in info["streaming"]        # supports_streaming = True
    assert "dukascopy" not in info["streaming"]  # supports_streaming = False
```

(`build_registry()` is this file's own helper, already used by the neighboring tests - see `test_describe_labels_reflect_broker_reported_names`.)

Run: `cd backend && .venv/bin/python -m pytest tests/test_registry.py -q` - expect the new test to pass alongside the existing ones (no regression to `labels`/`categories`/`exec`).

Frontend consumer, `lib/trading.ts` (mirrors `noteBrokerCategories`/`brokerCategories` exactly):

```ts
// Streaming (supports_streaming) broker ids from /api/brokers. Fed by
// fetchBrokers / cachedBrokers, mirroring backendCategories. Needed so the
// indicator alert dialog can disable "As it happens" for a VWMA/EVWMA alert
// on a quote-only broker (Global Constraints) - without this, nothing on
// the frontend knows which brokers stream, and the dialog would never
// disable the toggle (F11).
let streamingBrokers: Set<string> = new Set();
export function noteStreamingBrokers(streaming: string[] | undefined): void {
  if (streaming) streamingBrokers = new Set(streaming);
}
export function supportsStreaming(brokerId: string): boolean {
  return streamingBrokers.has(brokerId);
}
```

Add `streaming?: string[];` to `BrokerInfo`, and call `noteStreamingBrokers(info.streaming)` in BOTH `cachedBrokers()` and `fetchBrokers()`, right beside the existing `noteBrokerCategories(info.categories)` calls.

- [ ] **Step 5: Wire the entry points**

In `useIndicatorCommands.ts`, add a dep `alertContext: React.MutableRefObject<{ epic: string; broker: string; precision: number; quoteOnly: boolean }>` to `IndicatorCommandsDeps` (ChartCore fills it from `symbol.epic`, `brokerId`, `precision`, and `!supportsStreaming(brokerId)` - see Step 4). Then:

```ts
  const alertDraftFor = useCallback((paneId: string, name: string) => {
    const c = chartRef.current;
    if (!c || snapViewRef.current) return null;
    return buildIndicatorAlertDraft({ chart: c, paneId, name, scope, resolution: period.resolution, ...alertContext.current });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- refs and stable props
  }, [scope, period.resolution]);

  const onLegendAddAlert = useCallback((name: string) => {
    const r = alertDraftFor(paneIdOf(name), name);
    if (r && "draft" in r) indicatorAlertRequest.set({ mode: "create", draft: r.draft });
  }, [alertDraftFor, paneIdOf]);

  const legendAlertCheck = useCallback((name: string) => {
    const r = alertDraftFor(paneIdOf(name), name);
    return r === null ? null : { reason: "reason" in r ? r.reason : null };
  }, [alertDraftFor, paneIdOf]);
```

In `indicatorMenuItems`, insert after "Settings":

```ts
        ...(() => {
          const r = alertDraftFor(paneId, name);
          if (r === null) return [];
          const label = "Add alert";
          return "draft" in r
            ? [{ label, icon: MenuIcons.bell, onClick: () => indicatorAlertRequest.set({ mode: "create", draft: r.draft }) }]
            : [{ label, icon: MenuIcons.bell, disabled: true, disabledReason: r.reason, onClick: () => {} }];
        })(),
```

Return `onLegendAddAlert` and `legendAlertCheck` from the hook.

In `ChartLegend.tsx`: add to `Props`

```ts
  // Bell: add an alert on this indicator. alertCheck returns null to hide the
  // bell (not an alertable type), or a reason string to show it disabled.
  onAddAlert?: (name: string) => void;
  alertCheck?: (name: string) => { reason: string | null } | null;
```

thread both through to every `IndicatorRow` render site, and in `IndicatorRow`'s `<span className="cl-icons">`, before the Settings button:

```tsx
            {(() => {
              const chk = alertCheck?.(row.name);
              if (!chk || !onAddAlert) return null;
              const disabled = chk.reason !== null;
              const btn = (
                <button
                  className="cl-icon"
                  aria-label="Add alert"
                  disabled={disabled}
                  onClick={(e) => { e.stopPropagation(); onAddAlert(row.name); }}
                >
                  <BellIcon size={12} />
                </button>
              );
              // A disabled button may not fire mouse events, so `asChild`
              // (which anchors the tooltip's handlers directly to the
              // child, no wrapper) would silently never show the reason.
              // Per CLAUDE.md: keep the wrapper only when disabled.
              return disabled
                ? <Tooltip content={chk.reason as string}>{btn}</Tooltip>
                : <Tooltip asChild content="Add alert">{btn}</Tooltip>;
            })()}
```

(Use the same button class the neighboring icon buttons use; `BellIcon` is exported from `lib/menuIcons`.)

In `ChartCore.tsx` pass `onAddAlert={onLegendAddAlert}` and `alertCheck={legendAlertCheck}` to `ChartLegend`, and fill the `alertContext` ref's `quoteOnly` from `!supportsStreaming(brokerId)` (imported from `lib/trading.ts`, Step 4).

- [ ] **Step 6: Run to verify pass**

Run: `cd backend && .venv/bin/python -m pytest tests/test_registry.py -q && cd ../frontend && npx vitest run src/chart/indicatorAlertDraft.test.ts src/ChartLegend.groups.test.tsx src/chart/useIndicatorCommands.clipboard.test.tsx src/lib/brokerDefaults.test.ts && npx tsc -b`
Expected: PASS, tsc clean.

- [ ] **Step 7: Commit**

```bash
git add backend/auto_trader/brokers/registry.py backend/tests/test_registry.py \
  frontend/src/lib/trading.ts frontend/src/chart/indicatorAlertDraft.ts frontend/src/chart/indicatorAlertDraft.test.ts \
  frontend/src/ChartLegend.tsx frontend/src/chart/useIndicatorCommands.ts frontend/src/ChartCore.tsx
git commit -m "feat(alerts): add an alert from the indicator legend and menu

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: Indicator alerts on the chart (pane line, drag, bell)

Spec: "On the chart", "Design principles" (shared alert-line helpers).

Scope note: `OverlayAlerts` is one layer of a mixin chain (`lib/overlays.ts`), so the shared part is extracted as plain helpers rather than a base class: the overlay template name, style and the create call live in one module both users import, and dragging reuses `makeLineDrag` like the slope-threshold lines already do.

**Files:**
- Create: `frontend/src/lib/overlays/alertLine.ts` (shared create/style helpers)
- Modify: `frontend/src/lib/overlays/alerts.ts` (`materializeSavedAlert` ~528 and `applyAlertLineWeight` ~110 use the helpers; the signature comment at ~286 now points at the backend `_alert_sig` in `core/alert_kinds.py`)
- Create: `frontend/src/lib/overlays/indicatorAlerts.ts` (`IndicatorAlertLines`)
- Create: `frontend/src/lib/overlays/indicatorAlerts.test.ts`
- Modify: `frontend/src/lib/chartController.ts` (own one `IndicatorAlertLines` per controller)
- Modify: `frontend/src/chart/useLineDrag.ts` (an `indAlertDrag` beside `slopeThDrag`, registered in `lineDrags`)
- Modify: `frontend/src/chart/useChartPaint.ts` (bells for "price vs line" alerts; gains a `scope` dep) and `frontend/src/chart/AlertTags.tsx` (render them)
- Modify: `frontend/src/ChartCore.tsx` (attach/reconcile `IndicatorAlertLines`, pass `scope` into `useChartPaint`'s deps, wire the drag dep, `indicatorBells` state)
- Modify: `frontend/src/chart/useLiveMarketData.ts` (~line 423-427: attach/reconcile `IndicatorAlertLines` alongside the existing overlay rebind on epic/resolution/broker change)

**Interfaces:**
- Produces:
  - `alertLine.ts`: `ALERT_OVERLAY = "alertPriceLine"`; `alertLineStyles(selected: boolean)`; `createAlertLine(chart: Chart, opts: { id: string; paneId?: string; value: number; visible: boolean; extendData?: unknown }): string | null`
  - `class IndicatorAlertLines { attach(chart: Chart, scope: string, broker: string, epic: string, resolution: string): void; reconcile(): void; lines(): Array<{ alertId: string; paneId: string; value: number }>; preview(alertId: string, value: number): void; commit(alertId: string, value: number): void }`
  - `IndicatorBellTag { id: string; y: number }` added to the paint output.

- [ ] **Step 1: Write the failing test** (`lib/overlays/indicatorAlerts.test.ts`)

```ts
import { describe, it, expect, vi } from "vitest";
vi.mock("klinecharts", () => ({ registerOverlay: () => {}, registerIndicator: () => {}, registerYAxis: () => {}, getSupportedIndicators: () => [] }));
const alerts: unknown[] = [];
vi.mock("../alertsApi", async (orig) => ({
  ...(await orig<typeof import("../alertsApi")>()),
  loadIndicatorAlerts: () => alerts,
  patchIndicatorAlert: vi.fn(() => Promise.resolve(true)),
}));
import { IndicatorAlertLines } from "./indicatorAlerts";

function fakeChart() {
  const created: Array<Record<string, unknown>> = [];
  return {
    created,
    chart: {
      createOverlay: (o: Record<string, unknown>) => { created.push(o); return o.id as string; },
      removeOverlay: vi.fn(),
      overrideOverlay: vi.fn(),
      getIndicators: () => [{ name: "RSI", paneId: "pane_rsi" }],
    },
  };
}
const valueAlert = (scope: string, tf = "HOUR") => ({
  kind: "indicator", id: "al-1", epic: "US100", broker: "b", condition: "greater", trigger: "every",
  message: "", expiresAt: null, notify: {}, precision: 2,
  params: { identity: { indicator: "RSI", calcParams: [14], config: { source: "close" }, priceTarget: false },
    line: "value", timeframe: tf, target: "value", value: 70, evalOn: "close",
    link: { scope, instanceId: "RSI" } },
});

describe("IndicatorAlertLines", () => {
  it("draws a value line in the linked indicator's pane, only for this cell and timeframe", () => {
    alerts.splice(0, alerts.length, valueAlert("s1"), { ...valueAlert("s2"), id: "al-2" }, { ...valueAlert("s1", "DAY"), id: "al-3" });
    const { chart, created } = fakeChart();
    const lines = new IndicatorAlertLines();
    lines.attach(chart as never, "s1", "b", "US100", "HOUR");
    lines.reconcile();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      paneId: "pane_rsi", points: [{ value: 70 }],
      lock: true, needDefaultXAxisFigure: false,
    });
    // v10 deletes an overlay on right-click unless the handler calls
    // preventDefault (F8) - prove createAlertLine's handler actually does.
    const pd = vi.fn();
    (created[0].onRightClick as (e: { preventDefault: () => void }) => boolean)({ preventDefault: pd });
    expect(pd).toHaveBeenCalled();
    expect(lines.lines()).toEqual([{ alertId: "al-1", paneId: "pane_rsi", value: 70 }]);
  });
});
```

(Fake whatever `getIndicatorsByPane` / `getIndicatorById` needs to resolve `instanceId -> paneId`; read `lib/indicators.ts:82` and `:1346` and fake those calls.)

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/lib/overlays/indicatorAlerts.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Extract `lib/overlays/alertLine.ts`**

Move `ALERT_LINE_STYLE` usage and the `this.create("alert", "alertPriceLine", ...)` call shape into:

```ts
// The one way an alert line is drawn, for price alerts (OverlayAlerts) and
// indicator value alerts (IndicatorAlertLines): same overlay template, same
// dashed amber style, same selected weight.
import type { Chart } from "klinecharts";
import { ALERT_LINE_STYLE, ALERT_LINE_SELECTED_SIZE, ALERT_LINE_SIZE } from "./shared";

export const ALERT_OVERLAY = "alertPriceLine";

export function alertLineStyles(selected: boolean) {
  return { ...ALERT_LINE_STYLE, line: { ...ALERT_LINE_STYLE.line, size: selected ? ALERT_LINE_SELECTED_SIZE : ALERT_LINE_SIZE } };
}

export function createAlertLine(
  chart: Chart,
  o: { id: string; paneId?: string; value: number; visible: boolean; extendData?: unknown },
): string | null {
  const id = chart.createOverlay({
    id: o.id, name: ALERT_OVERLAY, points: [{ value: o.value }], styles: alertLineStyles(false),
    visible: o.visible, extendData: o.extendData, mode: "normal", needDefaultYAxisFigure: false,
    // The alert template's OWN default is needDefaultXAxisFigure: true
    // (shared.ts); the shared `OverlayManager.create()` path suppresses it
    // for kind "alert" (same reasoning: klinecharts would stamp the
    // selected line's start timestamp under it). `createAlertLine` bypasses
    // that shared path, so it must repeat the suppression itself.
    needDefaultXAxisFigure: false,
    // Locked: this line's VALUE is moved by the app's own indAlertDrag (hit-
    // tested in pixel space, Step 5), not by klinecharts' native point-drag.
    lock: true,
    // v10 contract: returning a value from onRightClick no longer suppresses
    // the library's default "delete the overlay on right-click" - only
    // e.preventDefault() does (see lib/overlays.ts's own onRightClick for the
    // same fix on price alert lines). Without this, right-clicking an
    // indicator alert line deletes it instead of opening any context menu.
    onRightClick: (e: { preventDefault?: () => void }) => {
      e.preventDefault?.();
      return true;
    },
    ...(o.paneId ? { paneId: o.paneId } : {}),
  } as never);
  return typeof id === "string" ? id : null;
}
```

Export `ALERT_LINE_SIZE`, `ALERT_LINE_SELECTED_SIZE`, `ALERT_LINE_STYLE` from `shared.ts` if they are not already. Make `applyAlertLineWeight` and `materializeSavedAlert` in `alerts.ts` use `alertLineStyles` (keep going through `this.create(...)` there if it does bookkeeping the raw call does not; the shared part is the style and template name - `materializeSavedAlert` keeps its own `lock: undefined` via `this.create(...)`, unchanged; `createAlertLine`'s `lock: true` is new and applies only to indicator alert lines). Run `npx vitest run src/lib/overlays.test.ts` after this step: price alerts must be unchanged.

- [ ] **Step 4: Implement `lib/overlays/indicatorAlerts.ts`**

```ts
// Value-target indicator alerts drawn as dashed alert lines in their
// indicator's own pane (e.g. 70 in the RSI pane). Only the cell the alert is
// linked to, and only while it shows the alert's broker, epic and timeframe.
import type { Chart } from "klinecharts";
import { loadIndicatorAlerts, patchIndicatorAlert, type IndicatorAlert } from "../alertsApi";
import { getIndicatorsByPane } from "../indicators";
import { createAlertLine } from "./alertLine";

const ovId = (alertId: string) => `indalert:${alertId}`;

export class IndicatorAlertLines {
  private chart: Chart | null = null;
  private scope = "";
  private broker = "";
  private epic = "";
  private resolution = "";
  private drawn = new Map<string, { paneId: string; value: number }>();

  attach(chart: Chart, scope: string, broker: string, epic: string, resolution: string): void {
    this.chart = chart;
    this.scope = scope;
    this.broker = broker;
    this.epic = epic;
    this.resolution = resolution;
  }

  private paneOf(instanceId: string): string | null {
    const panes = this.chart ? getIndicatorsByPane(this.chart) : null;
    for (const [paneId, inds] of panes ?? []) if (inds.has(instanceId)) return paneId;
    return null;
  }

  private wanted(): Map<string, { paneId: string; value: number }> {
    const out = new Map<string, { paneId: string; value: number }>();
    for (const a of loadIndicatorAlerts(this.epic, this.broker) as IndicatorAlert[]) {
      const p = a.params;
      if (p.target !== "value" || p.value == null || !p.link) continue;
      if (p.link.scope !== this.scope || p.timeframe !== this.resolution) continue;
      const paneId = this.paneOf(p.link.instanceId);
      if (paneId) out.set(a.id, { paneId, value: p.value });
    }
    return out;
  }

  reconcile(): void {
    const c = this.chart;
    if (!c) return;
    const want = this.wanted();
    for (const [id, cur] of this.drawn) {
      const w = want.get(id);
      if (!w || w.paneId !== cur.paneId) {
        c.removeOverlay({ id: ovId(id) });
        this.drawn.delete(id);
      }
    }
    for (const [id, w] of want) {
      const cur = this.drawn.get(id);
      if (!cur) {
        createAlertLine(c, { id: ovId(id), paneId: w.paneId, value: w.value, visible: true });
      } else if (cur.value !== w.value) {
        c.overrideOverlay({ id: ovId(id), points: [{ value: w.value }] });
      }
      this.drawn.set(id, w);
    }
  }

  lines(): Array<{ alertId: string; paneId: string; value: number }> {
    return [...this.drawn].map(([alertId, w]) => ({ alertId, ...w }));
  }

  preview(alertId: string, value: number): void {
    const cur = this.drawn.get(alertId);
    if (!cur || !this.chart) return;
    this.chart.overrideOverlay({ id: ovId(alertId), points: [{ value }] });
    this.drawn.set(alertId, { ...cur, value });
  }

  commit(alertId: string, value: number): void {
    this.preview(alertId, value);
    const v = +value.toFixed(4);
    void patchIndicatorAlert(alertId, { params: { value: v } });
  }
}
```

In `lib/chartController.ts` add `readonly indicatorAlerts = new IndicatorAlertLines();`. In ChartCore, wherever `overlays.reconcileAlerts()` is driven by the alerts signal and wherever the chart/epic/broker/resolution are (re)bound to overlays (`chart/useLiveMarketData.ts:423-427` and the rehydrate path), also call `controller.indicatorAlerts.attach(chart, scope, brokerId, symbol.epic, period.resolution)` and `controller.indicatorAlerts.reconcile()`. Also reconcile after indicator add/remove (the `indicatorRemoved` signal and `controller.indicators` changes), since the pane can appear/disappear.

- [ ] **Step 5: Drag** (`chart/useLineDrag.ts`, beside `slopeThDrag`; add `indicatorAlerts: IndicatorAlertLines` to `LineDragDeps` and pass it from ChartCore)

```ts
    type IndAlertHit = { alertId: string; paneId: string; convertPaneId: string; d: number };
    const grabbableIndAlert = (yPix: number): IndAlertHit | null => {
      const c = chartRef.current;
      if (!c) return null;
      let best: IndAlertHit | null = null;
      for (const l of indicatorAlerts.lines()) {
        const py = first(c.convertToPixel([{ value: l.value }], { paneId: l.paneId, absolute: true })).y;
        if (py == null) continue;
        const d = Math.abs(py - yPix);
        if (d <= ALERT_SNAP_PX && (!best || d < best.d))
          best = { alertId: l.alertId, paneId: l.paneId, convertPaneId: l.paneId, d };
      }
      return best;
    };
    let indAlertPending: number | null = null;
    const indAlertDrag = makeLineDrag<IndAlertHit>({
      grab: grabbableIndAlert,
      onMove: (hit, value) => { indAlertPending = value; indicatorAlerts.preview(hit.alertId, value); },
      onCommit: (hit, moved) => {
        if (!moved) return false;
        if (indAlertPending != null) indicatorAlerts.commit(hit.alertId, indAlertPending);
        indAlertPending = null;
        return true;
      },
      onAbort: () => { indAlertPending = null; },
    });
```

and register it: `const lineDrags: LineDrag[] = [tradeDrag, alertDrag, slopeThDrag, indAlertDrag];`. (`makeLineDrag` converts the cursor through `hit.convertPaneId`, exactly as for `slopeThDrag`; check its signature at the top of the file and match it.)

- [ ] **Step 6: Bells for "price vs line" alerts** (`chart/useChartPaint.ts` `redraw`, beside the price alert tags)

There is no `brokerRef` or `scope` in `useChartPaint` today (F21): `ChartHandle` already has `brokerIdRef` (chartHandle.ts - the SAME ref `useRangeNavigation`/`useTrendlineDebug` already read), so destructure that from `handle` alongside `epicRef`/`resRef`; `scope` is a plain render-scope prop (not a ref - same as `useTrendlineDebug`'s own `scope` param), so add `scope: string` to `ChartPaintDeps` and destructure it from `deps` (beside `period`, which is passed the same un-reffed way):

```ts
    const bells: Array<{ id: string; y: number }> = [];
    for (const a of loadIndicatorAlerts(epicRef.current, brokerIdRef.current)) {
      const p = a.params;
      if (p.target !== "price" || !p.link || p.link.scope !== scope || p.timeframe !== resRef.current) continue;
      const ind = getIndicatorById(chart, p.link.instanceId);
      const res = (ind?.result ?? []) as Array<Record<string, number | undefined>>;
      const v = res[res.length - 1]?.[MAIN_LINE_KEY[p.identity.indicator]];
      if (typeof v !== "number") continue;
      const y = yOf(v);
      if (y != null) bells.push({ id: a.id, y });
    }
    setIndicatorBells((prev) => stableArray(prev, bells));
```

Add `brokerIdRef` to the list of fields destructured from `handle` at the top of `useChartPaint` (it is already declared on `ChartHandle`, nothing to add there - just read it), and add `scope: string;` to the `ChartPaintDeps` interface plus its destructure from `deps` (both next to the existing `epicRef`/`resRef`/`period` fields). The `yOf` helper is the same candle-pane converter the price tags use. Add `indicatorBells` state in ChartCore next to `alertTags`, pass the setter into `useChartPaint` the way `setAlertTags` is passed (`ChartCore.tsx:4743`), pass `scope` into `useChartPaint`'s deps object (ChartCore already has it as a prop - see Files list), and render in `AlertTags.tsx` a new optional prop `bells` as small `.alert-tag` pills holding only the `BellIcon` (no price text), wrapped in `<Tooltip asChild content="Indicator alert">`. Clicking a bell opens `indicatorAlertRequest.set({ mode: "edit", id })`.

- [ ] **Step 7: Run to verify pass**

Run: `cd frontend && npx vitest run src/lib/overlays/indicatorAlerts.test.ts src/lib/overlays.test.ts src/chart/renderStability.test.ts && npx tsc -b`
Expected: PASS, tsc clean.

- [ ] **Step 8: Manual check** (ask the user before running a dev server if one is not already up)

Add RSI 14 on a 1H chart, create "RSI 14 (1H) Greater Than 70": a dashed amber line appears at 70 in the RSI pane; dragging it to 65 and reloading keeps 65. Add EMA 50, create "Price vs line": a bell pill sits on the EMA at the right edge. Switch the chart to 4H: both disappear; back to 1H: both return.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/lib/overlays/alertLine.ts frontend/src/lib/overlays/alerts.ts \
  frontend/src/lib/overlays/shared.ts frontend/src/lib/overlays/indicatorAlerts.ts \
  frontend/src/lib/overlays/indicatorAlerts.test.ts frontend/src/lib/chartController.ts \
  frontend/src/chart/useLineDrag.ts frontend/src/chart/useChartPaint.ts frontend/src/chart/AlertTags.tsx \
  frontend/src/ChartCore.tsx frontend/src/chart/useLiveMarketData.ts
git commit -m "feat(alerts): draw and drag indicator alerts on the chart

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 16: Alerts panel, mobile, toasts: labels and waiting status

Spec: "Panel and notifications".

**Files:**
- Modify: `frontend/src/AlertsSidebar.tsx` (rows ~505, ~612; history ~714; delete confirms ~568, ~655)
- Modify: `frontend/src/mobile/MobileAlertsView.tsx` (~121, ~151; confirm ~67)
- Modify: `frontend/src/app/useAlertFiredNotices.ts` (`detail`)
- Modify: `frontend/src/AlertModal.tsx` `autoMsg` is untouched (price only)
- Test: `frontend/src/mobile/MobileAlertsView.test.tsx` (append), `frontend/src/app/useAlertFiredNotices.test.ts` (create if absent)

**Interfaces:**
- Consumes: Task 11 `alertLabel`, `triggeredLabel`, `conditionPhrase`, `loadIndicatorAlerts`, `loadAllIndicatorAlerts`, `deleteIndicatorAlert`, `TriggeredAlert.label/target`, `FiredPayload.label/target`; Task 13 `indicatorAlertRequest`.

- [ ] **Step 1: Write the failing tests**

`useAlertFiredNotices` detail (extract the string building into an exported pure function `firedDetail(p: FiredPayload, prec: number): string` in the same file so it can be tested):

```ts
import { describe, it, expect } from "vitest";
import { firedDetail } from "./useAlertFiredNotices";

describe("firedDetail", () => {
  it("price alerts keep the level", () => {
    expect(firedDetail({ level: 100, message: "", condition: "crossing" } as never, 2)).toBe("@ 100.00");
  });
  it("indicator alerts name the indicator", () => {
    expect(firedDetail({ level: 70, message: "", condition: "greater", label: "RSI 14 (1H)", target: "value" } as never, 2))
      .toBe("RSI 14 (1H) Greater Than 70.00");
    // fmtPrice groups thousands (priceFormat.ts), same as every other price
    // readout on the chart - "21400.0" (ungrouped) would be the one price
    // display in the app that doesn't match the axis/tags (F3).
    expect(firedDetail({ level: 21400, message: "", condition: "crossing_up", label: "EMA 50 (1H)", target: "price" } as never, 1))
      .toBe("Crossing Up EMA 50 (1H) 21,400.0");
  });
  it("a custom message wins", () => {
    expect(firedDetail({ level: 70, message: "rsi hot", label: "RSI 14 (1H)" } as never, 2)).toBe("rsi hot");
  });
});
```

`MobileAlertsView.test.tsx`: add a case that seeds one indicator alert (mock `loadIndicatorAlerts` / `loadAllIndicatorAlerts` the way the file mocks `loadAlerts`) and asserts the row text `"Crossing Up EMA 50 (1H)"` and a `waiting for data` badge when `status: "waiting_for_data"`.

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/app/useAlertFiredNotices.test.ts src/mobile/MobileAlertsView.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

`useAlertFiredNotices.ts`:

```ts
import { conditionPhrase } from "../lib/alertsApi"; // the one phrase helper (F18); adjust the path to this file's own relative import style

export function firedDetail(p: FiredPayload, prec: number): string {
  if (p.message) return p.message;
  if (!p.label) return `@ ${fmtPrice(p.level, prec)}`;
  const levelText = p.target === "value" ? p.level.toFixed(2) : fmtPrice(p.level, prec);
  return conditionPhrase(p.label, p.condition, p.target, levelText);
}
```

and use `const detail = firedDetail(p, prec);`.

`AlertsSidebar.tsx` and `MobileAlertsView.tsx`:
- Price rows (`AlertsSidebar.tsx` ~612, which already reads `fmtPrice`): replace the inline `{CONDITION_LABELS[a.condition]} {fmtPrice(a.level, precision)}` with `{alertLabel(a, precision)}` - same output, confirmed identical since `alertLabel`'s price-level branch is `fmtPrice`-based too.

  The OTHER price row (`AlertsSidebar.tsx` ~505, the all-symbols view) reads `a.level.toFixed(g.precision)` today - NOT `fmtPrice` - so switching it to `alertLabel(a, g.precision)` ALSO adds thousands grouping there (F20): a minor, deliberate formatting fix that brings the all-symbols view in line with the current-chart view and with `fmtPrice`'s grouping used everywhere else on the chart, not a regression to preserve. Same for `MobileAlertsView.tsx`'s active row (~121, `a.level.toFixed(precision)`, ungrouped today) - switch it to `alertLabel(a, precision)` too, same deliberate fix.
- After the price rows of each group (this-chart list and all-symbols list), render the indicator alerts of that epic (`loadIndicatorAlerts(epic, broker)`; for the all-symbols view group `loadAllIndicatorAlerts(broker)` by epic alongside the price groups) with the same row component/markup: text `alertLabel(a, precision)`, the message line, and when `a.status === "waiting_for_data"` a muted badge `waiting for data` wrapped in `<Tooltip content={["Not enough candles yet, or the feed is down", "It fires once data arrives"]}>`. Edit (row double-click / pencil) opens `indicatorAlertRequest.set({ mode: "edit", id: a.id })`; delete uses the same confirm text as price rows (`Delete this alert on ${epic}?`) and calls `deleteIndicatorAlert(a.id)`. Indicator rows have no "jump to line" price; clicking a row focuses the epic the same way price rows do.
- History rows (`AlertsSidebar.tsx` ~714 and `MobileAlertsView.tsx` ~151, both currently `{CONDITION_LABELS[t.condition]} {t.level.toFixed(hp)} @ {t.price.toFixed(hp)}`): replace with `{triggeredLabel(t, hp)}`. `triggeredLabel` already exists in `lib/alertsApi.ts` (Task 11, beside `alertLabel` and `conditionPhrase`) - this task only imports and USES it, it does not define it here. Its condition-first-for-a-price-target wording (F18) means `"Crossing Up EMA 50 (1H) 21400.00 @ 21430.00"`, not `"EMA 50 (1H) Crossing Up 21400.00 @ ..."`.

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run src/app/useAlertFiredNotices.test.ts src/mobile/MobileAlertsView.test.tsx src/lib/alertsApi.test.ts && npx tsc -b && npx eslint src/AlertsSidebar.tsx src/mobile/MobileAlertsView.tsx src/app/useAlertFiredNotices.ts`
Expected: PASS; tsc and eslint clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/AlertsSidebar.tsx frontend/src/mobile/MobileAlertsView.tsx \
  frontend/src/mobile/MobileAlertsView.test.tsx frontend/src/app/useAlertFiredNotices.ts \
  frontend/src/app/useAlertFiredNotices.test.ts
git commit -m "feat(alerts): indicator alerts in the panel, mobile and notices

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 17: End-to-end check and docs

**Files:**
- Modify: `CLAUDE.md` ("Alerts" section: indicator alerts exist, kinds live in `core/alert_kinds.py`, once-per-bar, the `--indicator` probe)
- Modify: `docs/superpowers/specs/2026-10-10-indicator-value-alerts-design.md` (Status line: implemented)

- [ ] **Step 1: Backend suite for alerts**

Run: `cd backend && .venv/bin/python -m pytest tests/test_alert_eval.py tests/test_alert_bars.py tests/test_alertable.py tests/test_alert_kinds.py tests/test_alert_indicators.py tests/test_alert_engine.py tests/test_alert_engine_feeds.py tests/test_alert_store.py tests/test_alerts_api.py tests/test_telegram_rich_alerts.py tests/test_alert_chart.py tests/test_chart_snapshot.py tests/test_indicator_parity.py tests/test_registry.py -q`
Expected: all pass.

- [ ] **Step 2: Frontend checks** (affected files only; ask the user before running if they are busy, it is CPU-heavy)

Run: `cd frontend && npx tsc -b && npx vitest run src/lib/alertableIndicators.test.ts src/lib/alertableParity.test.ts src/lib/alertsApi.test.ts src/lib/indicatorAlertSync.test.ts src/ConfirmDialog.test.tsx src/IndicatorAlertModal.test.tsx src/chart/indicatorAlertDraft.test.ts src/lib/overlays/indicatorAlerts.test.ts src/lib/overlays.test.ts src/app/useAlertFiredNotices.test.ts src/mobile/MobileAlertsView.test.tsx`
Expected: all pass.

- [ ] **Step 3: Live probe** (backend running locally)

Run: `cd backend && python3 -m scripts.alert_probe --indicator --epic BTCUSD --broker capital-live`
Expected: PASS within the timeout (TIMEOUT on a closed market is not a code failure).

- [ ] **Step 4: Docs**

In `CLAUDE.md` "Alerts", add after the first paragraph:

```markdown
Alert kinds live in `core/alert_kinds.py` (`price_level`, `indicator`): each
validates its params and resolves a `(subject, level)` pair; `core/alert_eval.py`
is the one evaluator. Indicator alerts (MA, RSI, ATR on native timeframes)
read closed bars through `CANDLE_CACHE` via `core/alert_indicators.py` and the
alertable registry `indicators/alertable.py` (mirrored by
`frontend/src/lib/alertableIndicators.ts`, pinned by committed fixtures under
`backend/tests/fixtures/indicator_parity/`; regenerate with
`UPDATE_PARITY=1 npx vitest run src/lib/alertableParity.test.ts`). "Every"
alerts fire at most once per bar of their timeframe. Probe an indicator alert
with `python3 -m scripts.alert_probe --indicator`.
```

Set the spec's Status line to `Status: implemented 2026-10-xx (sub-project 1 of 3).` with the real date.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-10-10-indicator-value-alerts-design.md
git commit -m "docs(alerts): indicator alerts in CLAUDE.md; spec marked implemented

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
