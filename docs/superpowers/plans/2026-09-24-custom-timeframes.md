# Custom Timeframes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Users define their own candle timeframes (7m, 90m, 6H, 2D, 5W, 4M) and use them on charts, indicators, backtests, sweeps, rule pins, alerts and the agent bridge.

**Architecture:** A stateless `UNIT_N` naming grammar parsed identically by `backend/auto_trader/core/timeframe.py` and `frontend/src/lib/timeframe.ts`, pinned together by one shared JSON corpus. The backend's hard-coded `DERIVED` table becomes a computed mapping over that grammar, so every existing fold/cache/stream path serves any valid timeframe. The frontend's `RESOLUTION_SECONDS` becomes a grammar-backed lookup and `periodByResolution` synthesizes a `Period` for any valid timeframe, so the ~40 existing call sites work unchanged. A per-user saved list feeds a "Custom" dropdown group.

**Tech Stack:** Python 3 / FastAPI / numpy / pytest (backend), React + TypeScript / vitest (frontend).

**Spec:** `docs/superpowers/specs/2026-09-24-custom-timeframes-design.md`

## Global Constraints

- Limits: minutes 1–1439, hours 1–24, days 1–365, weeks 1–52, months 1–12; whole numbers only; no custom seconds timeframes.
- Canonical rewrites: minutes divisible by 60 → hours; `HOUR_24` → `DAY`; `MONTH_12` → `YEAR`; N = 1 drops the suffix. Days/weeks/months never convert into each other.
- Labels: `<n>m`, `<n>H`, `<n>D`, `<n>W`, `<n>M`, `1Y`, `<n>s` for the fixed seconds keys. Lowercase `m` = minutes, uppercase `M` = months.
- Intraday (minute/hour) buckets reset daily at 00:00 UTC; the last bar of a day may be short. Hours always fold from `HOUR`, never `HOUR_4`.
- Month groups are January-anchored; a group that does not divide 12 has a short last group in the year (5M: Jan–May, Jun–Oct, Nov–Dec).
- Invalid timeframes produce HTTP 422 with a user-facing reason, never 500.
- No em dashes ("—" or "--") in any UI text or error message.
- Tooltips via the shared `Tooltip`/`InfoTip` only; tip text is short lines (`string[]`).
- Frontend: run only the affected test files, never the full suite. Typecheck with `npx tsc -b` and judge by per-file parity against the pre-feature baseline commit `56e61de8` (every task commits to `main`, so "main" is a moving target): `git worktree`-free check is `git show 56e61de8:<file>` for reference; record the baseline error list for the touched files once before Task 5 with `npx tsc -b 2>&1 | tee /tmp/claude-tsc-baseline.txt` run on the untouched tree.
- Commit to the current branch (`main`); stage files by explicit path; never stash/clean/restore.

## Review Focus

1. A saved/favorited custom timeframe whose string is non-canonical (e.g. hand-edited `MINUTE_120` in localStorage) must still render as `2H` and not duplicate `HOUR_2` in the quick bar. Pinned by Task 5 `quickBarPeriods` test.
2. Scroll-back window snapping on a short final bar of the day (5H 20:00–24:00) must not create a partial bucket that collides on prepend. Pinned by Task 2 `bucket_end` short-bar test.
3. `fold_arrays` (pattern scan) and `bucket_open` (chart) must agree for non-divisor month groups (5M) and daily-reset minutes (7m across midnight). Pinned by Task 2 parity test.
4. An expression pin `close@6H` must evaluate with its higher-timeframe bars keyed `HOUR_6`. `htfCandles` is keyed backend-side only (`sweep_apply.py:187` and `evaluate.py` both go through `tf_resolution(tf) or tf`; the frontend never builds it), so the Task 3 `tf_resolution` test plus the Task 7 sweep step pin it.
5. A garbage `resolution` query param (`HOUR_99`, `FOO`) on `/api/candles` and `/ws/candles` must give a 422 / fatal frame with the reason, not a 500 or a reconnect loop. Pinned by Task 3 tests (`/api/candles` end to end; `/ws/candles` through its `_stream_resolution` helper).

---

### Task 1: Backend timeframe grammar + shared corpus

**Files:**
- Create: `backend/auto_trader/core/timeframe.py`
- Create: `frontend/src/lib/timeframes.corpus.json`
- Test: `backend/tests/test_timeframe.py`

**Interfaces:**
- Produces:
  - `class TimeframeError(ValueError)` — `str(e)` is user-facing.
  - `@dataclass(frozen=True) class Timeframe: unit: str; n: int` — unit in `SECOND|MINUTE|HOUR|DAY|WEEK|MONTH|YEAR`.
  - `parse(res: str) -> Timeframe` (canonical strings, labels `7m`/`6H`/`2D`/`3W`/`4M`/`1Y`, aliases `D`/`W`; raises `TimeframeError`).
  - `canonicalize(res: str) -> str`
  - `seconds(res: str) -> int` (nominal; month 30d, year 365d)
  - `label(res: str) -> str`
  - `is_native(res: str) -> bool` (canonical form is one of the 8 `Resolution` values)
  - `SECONDS_KEYS: dict[str, int]` (mirror of `capital_stream.SECONDS_INTERVALS`)

- [ ] **Step 1: Write the shared corpus** `frontend/src/lib/timeframes.corpus.json` (lives beside the frontend like `lib/expr/corpus.json`; the backend reads it by path). `base` is backend-only (the frontend ignores it); `null` means native / not folded.

```json
[
  {"input": "MINUTE", "canonical": "MINUTE", "label": "1m", "seconds": 60, "base": null},
  {"input": "MINUTE_1", "canonical": "MINUTE", "label": "1m", "seconds": 60, "base": null},
  {"input": "1m", "canonical": "MINUTE", "label": "1m", "seconds": 60, "base": null},
  {"input": "MINUTE_3", "canonical": "MINUTE_3", "label": "3m", "seconds": 180, "base": "MINUTE"},
  {"input": "7m", "canonical": "MINUTE_7", "label": "7m", "seconds": 420, "base": "MINUTE"},
  {"input": "MINUTE_20", "canonical": "MINUTE_20", "label": "20m", "seconds": 1200, "base": "MINUTE_5"},
  {"input": "MINUTE_45", "canonical": "MINUTE_45", "label": "45m", "seconds": 2700, "base": "MINUTE_15"},
  {"input": "90m", "canonical": "MINUTE_90", "label": "90m", "seconds": 5400, "base": "MINUTE_30"},
  {"input": "MINUTE_60", "canonical": "HOUR", "label": "1H", "seconds": 3600, "base": null},
  {"input": "MINUTE_120", "canonical": "HOUR_2", "label": "2H", "seconds": 7200, "base": "HOUR"},
  {"input": "MINUTE_1439", "canonical": "MINUTE_1439", "label": "1439m", "seconds": 86340, "base": "MINUTE"},
  {"input": "HOUR_4", "canonical": "HOUR_4", "label": "4H", "seconds": 14400, "base": null},
  {"input": "4H", "canonical": "HOUR_4", "label": "4H", "seconds": 14400, "base": null},
  {"input": "HOUR_06", "canonical": "HOUR_6", "label": "6H", "seconds": 21600, "base": "HOUR"},
  {"input": "6H", "canonical": "HOUR_6", "label": "6H", "seconds": 21600, "base": "HOUR"},
  {"input": "HOUR_8", "canonical": "HOUR_8", "label": "8H", "seconds": 28800, "base": "HOUR"},
  {"input": "HOUR_24", "canonical": "DAY", "label": "1D", "seconds": 86400, "base": null},
  {"input": "D", "canonical": "DAY", "label": "1D", "seconds": 86400, "base": null},
  {"input": "1D", "canonical": "DAY", "label": "1D", "seconds": 86400, "base": null},
  {"input": "DAY_2", "canonical": "DAY_2", "label": "2D", "seconds": 172800, "base": "DAY"},
  {"input": "DAY_365", "canonical": "DAY_365", "label": "365D", "seconds": 31536000, "base": "DAY"},
  {"input": "W", "canonical": "WEEK", "label": "1W", "seconds": 604800, "base": null},
  {"input": "WEEK_2", "canonical": "WEEK_2", "label": "2W", "seconds": 1209600, "base": "WEEK"},
  {"input": "5W", "canonical": "WEEK_5", "label": "5W", "seconds": 3024000, "base": "WEEK"},
  {"input": "MONTH", "canonical": "MONTH", "label": "1M", "seconds": 2592000, "base": "DAY"},
  {"input": "1M", "canonical": "MONTH", "label": "1M", "seconds": 2592000, "base": "DAY"},
  {"input": "4M", "canonical": "MONTH_4", "label": "4M", "seconds": 10368000, "base": "DAY"},
  {"input": "MONTH_12", "canonical": "YEAR", "label": "1Y", "seconds": 31536000, "base": "DAY"},
  {"input": "YEAR", "canonical": "YEAR", "label": "1Y", "seconds": 31536000, "base": "DAY"},
  {"input": "1Y", "canonical": "YEAR", "label": "1Y", "seconds": 31536000, "base": "DAY"},
  {"input": "SECOND", "canonical": "SECOND", "label": "1s", "seconds": 1, "base": null},
  {"input": "SECOND_5", "canonical": "SECOND_5", "label": "5s", "seconds": 5, "base": null},
  {"input": "MINUTE_0", "error": true},
  {"input": "MINUTE_1440", "error": true},
  {"input": "HOUR_25", "error": true},
  {"input": "DAY_366", "error": true},
  {"input": "WEEK_53", "error": true},
  {"input": "MONTH_13", "error": true},
  {"input": "2Y", "error": true},
  {"input": "6h", "error": true},
  {"input": "M", "error": true},
  {"input": "5s", "error": true},
  {"input": "SECOND_7", "error": true},
  {"input": "HOUR_", "error": true},
  {"input": "HOUR_1.5", "error": true},
  {"input": "FOO", "error": true},
  {"input": "", "error": true}
]
```

- [ ] **Step 2: Write the failing test** `backend/tests/test_timeframe.py`

```python
import json
import pathlib

import pytest

from auto_trader.brokers.capital_stream import SECONDS_INTERVALS
from auto_trader.core import timeframe as tf

CORPUS = json.loads(
    (pathlib.Path(__file__).parents[2] / "frontend/src/lib/timeframes.corpus.json").read_text()
)


@pytest.mark.parametrize("row", CORPUS, ids=lambda r: r["input"] or "<empty>")
def test_corpus(row):
    if row.get("error"):
        with pytest.raises(tf.TimeframeError):
            tf.canonicalize(row["input"])
        return
    assert tf.canonicalize(row["input"]) == row["canonical"]
    assert tf.label(row["input"]) == row["label"]
    assert tf.seconds(row["input"]) == row["seconds"]


def test_seconds_keys_match_stream():
    assert tf.SECONDS_KEYS == SECONDS_INTERVALS


def test_error_names_the_limit():
    with pytest.raises(tf.TimeframeError, match="between 1 and 1439"):
        tf.canonicalize("MINUTE_1440")


def test_error_is_a_value_error():
    # Existing callers catch ValueError around resolution_seconds().
    assert issubclass(tf.TimeframeError, ValueError)


def test_is_native():
    assert tf.is_native("HOUR_4") and tf.is_native("4H") and tf.is_native("MINUTE_60")
    assert not tf.is_native("HOUR_6") and not tf.is_native("MONTH")
    assert not tf.is_native("SECOND_5")
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd backend && .venv/bin/pytest tests/test_timeframe.py -q`
Expected: FAIL, `ModuleNotFoundError: auto_trader.core.timeframe`.

- [ ] **Step 4: Implement** `backend/auto_trader/core/timeframe.py`

```python
"""Timeframe grammar: parse, canonicalize, size and label any candle resolution.

A resolution is a native Capital name (MINUTE, HOUR_4, DAY, ...), a fixed
seconds key (SECOND_5, live only), YEAR, or UNIT_N with UNIT in
MINUTE|HOUR|DAY|WEEK|MONTH. Labels (7m, 6H, 2D, 3W, 4M, 1Y) and the D/W pin
aliases parse too. Every timeframe has ONE canonical string, and everything
that keys by resolution (cache keys, htfCandles, run records) uses it.

Mirrored by frontend/src/lib/timeframe.ts; both are pinned by
frontend/src/lib/timeframes.corpus.json.
"""

from __future__ import annotations

import re
from dataclasses import dataclass


class TimeframeError(ValueError):
    """An unparsable or out-of-limit timeframe. str(e) is user-facing."""


# Mirror of brokers.capital_stream.SECONDS_INTERVALS (core must not import
# brokers); test_timeframe asserts they agree.
SECONDS_KEYS: dict[str, int] = {
    "SECOND": 1, "SECOND_5": 5, "SECOND_10": 10,
    "SECOND_15": 15, "SECOND_30": 30, "SECOND_45": 45,
}

_UNIT_SECONDS = {"MINUTE": 60, "HOUR": 3600, "DAY": 86400, "WEEK": 604800, "MONTH": 30 * 86400}
_YEAR_SECONDS = 365 * 86400
_LIMITS = {"MINUTE": 1439, "HOUR": 24, "DAY": 365, "WEEK": 52, "MONTH": 12}
_UNIT_WORD = {"MINUTE": "minutes", "HOUR": "hours", "DAY": "days", "WEEK": "weeks", "MONTH": "months"}
_SUFFIX = {"MINUTE": "m", "HOUR": "H", "DAY": "D", "WEEK": "W", "MONTH": "M"}
_SUFFIX_UNIT = {v: k for k, v in _SUFFIX.items()}
_NATIVE = frozenset(
    {"MINUTE", "MINUTE_5", "MINUTE_15", "MINUTE_30", "HOUR", "HOUR_4", "DAY", "WEEK"}
)

_CANON_RE = re.compile(r"^(MINUTE|HOUR|DAY|WEEK|MONTH)(?:_(\d{1,5}))?$")
_LABEL_RE = re.compile(r"^(\d{1,5})([mHDWM])$")


@dataclass(frozen=True, slots=True)
class Timeframe:
    unit: str  # SECOND | MINUTE | HOUR | DAY | WEEK | MONTH | YEAR
    n: int


def _normalize(unit: str, n: int) -> Timeframe:
    if not 1 <= n <= _LIMITS[unit]:
        raise TimeframeError(f"{_UNIT_WORD[unit]} must be between 1 and {_LIMITS[unit]}")
    if unit == "MINUTE" and n % 60 == 0:
        return Timeframe("HOUR", n // 60)
    if unit == "HOUR" and n == 24:
        return Timeframe("DAY", 1)
    if unit == "MONTH" and n == 12:
        return Timeframe("YEAR", 1)
    return Timeframe(unit, n)


def parse(res: str) -> Timeframe:
    if not isinstance(res, str):
        raise TimeframeError("timeframe must be a string")
    if res in SECONDS_KEYS:
        return Timeframe("SECOND", SECONDS_KEYS[res])
    if res in ("YEAR", "1Y"):
        return Timeframe("YEAR", 1)
    if res == "D":
        return Timeframe("DAY", 1)
    if res == "W":
        return Timeframe("WEEK", 1)
    m = _CANON_RE.match(res)
    if m:
        return _normalize(m.group(1), int(m.group(2) or 1))
    m = _LABEL_RE.match(res)
    if m:
        return _normalize(_SUFFIX_UNIT[m.group(2)], int(m.group(1)))
    raise TimeframeError(
        f"unknown timeframe '{res[:40]}'. Use a number and a unit, like 7m, 6H, 2D, 3W or 2M"
    )


def _to_str(t: Timeframe) -> str:
    if t.unit == "YEAR":
        return "YEAR"
    if t.unit == "SECOND":
        return "SECOND" if t.n == 1 else f"SECOND_{t.n}"
    return t.unit if t.n == 1 else f"{t.unit}_{t.n}"


def canonicalize(res: str) -> str:
    return _to_str(parse(res))


def seconds(res: str) -> int:
    t = parse(res)
    if t.unit == "SECOND":
        return t.n
    if t.unit == "YEAR":
        return _YEAR_SECONDS
    return t.n * _UNIT_SECONDS[t.unit]


def label(res: str) -> str:
    t = parse(res)
    if t.unit == "SECOND":
        return f"{t.n}s"
    if t.unit == "YEAR":
        return "1Y"
    return f"{t.n}{_SUFFIX[t.unit]}"


def is_native(res: str) -> bool:
    return canonicalize(res) in _NATIVE
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend && .venv/bin/pytest tests/test_timeframe.py -q`
Expected: PASS (all corpus rows).

- [ ] **Step 6: Commit**

```bash
git add backend/auto_trader/core/timeframe.py backend/tests/test_timeframe.py frontend/src/lib/timeframes.corpus.json
git commit -m "feat(timeframes): shared timeframe grammar and corpus"
```

---

### Task 2: Generalize folding (candle_aggregate + pattern_series)

**Files:**
- Modify: `backend/auto_trader/core/candle_aggregate.py` (module docstring, `DERIVED`/`is_derived`/`resolution_seconds` at :40-80, `bucket_open`/`bucket_end` at :84-122, `base_count_for` at :150)
- Modify: `backend/auto_trader/core/pattern_series.py:31-60` (`fold_arrays`)
- Test: `backend/tests/test_candle_aggregate.py`, `backend/tests/test_api_patterns.py` (parity)

**Interfaces:**
- Consumes: `timeframe.parse`, `timeframe.is_native`, `timeframe.seconds`, `TimeframeError` (Task 1).
- Produces:
  - `rule_for(res: str) -> BucketRule | None` — None for natives, seconds keys and invalid strings.
  - `DERIVED` — a read-only `Mapping[str, BucketRule]` computed by `rule_for`; `in`, `[]`, `.get` work for ANY valid derived timeframe; iteration yields only the eight built-ins (`MINUTE_3, WEEK_2, WEEK_3, WEEK_6, MONTH, MONTH_2, MONTH_3, YEAR`).
  - `BucketRule.kind` in `"minute" | "day" | "week" | "month" | "year"`. `"minute"` now means daily-reset intraday with `group` = bucket span in MINUTES (HOUR_6 → group 360), `base` = the native it folds from.
  - `resolution_seconds(res)` delegates to `timeframe.seconds` and raises `TimeframeError` (a `ValueError`) on garbage.

- [ ] **Step 1: Write the failing tests** (append to `backend/tests/test_candle_aggregate.py`; the existing tests stay and must keep passing)

```python
from auto_trader.core.candle_aggregate import rule_for


def _tsh(y, mo, d, h, mi=0):
    return int(datetime(y, mo, d, h, mi, tzinfo=timezone.utc).timestamp())


def test_rule_for_custom_bases():
    assert rule_for("MINUTE_7").base is Resolution.MINUTE
    assert rule_for("MINUTE_90").base is Resolution.MINUTE_30
    assert rule_for("MINUTE_20").base is Resolution.MINUTE_5
    assert rule_for("HOUR_6").base is Resolution.HOUR
    assert rule_for("HOUR_8").base is Resolution.HOUR  # never HOUR_4
    assert rule_for("HOUR_6").group == 360 and rule_for("HOUR_6").kind == "minute"
    assert rule_for("DAY_2").kind == "day" and rule_for("DAY_2").base is Resolution.DAY
    assert rule_for("MONTH_5").kind == "month"
    assert rule_for("HOUR_4") is None and rule_for("SECOND_5") is None
    assert rule_for("HOUR_99") is None and rule_for("FOO") is None


def test_derived_mapping_is_open_but_iterates_builtins():
    assert "HOUR_6" in DERIVED and DERIVED.get("DAY_2") is not None
    assert "HOUR_4" not in DERIVED and DERIVED.get("FOO") is None
    assert is_derived("MINUTE_7") and not is_derived("MINUTE_5")
    assert len(set(DERIVED)) == 8


def test_five_hour_resets_daily_with_short_last_bar():
    r = rule_for("HOUR_5")
    assert bucket_open(_tsh(2026, 7, 5, 21), r) == _tsh(2026, 7, 5, 20)
    assert bucket_open(_tsh(2026, 7, 6, 0), r) == _tsh(2026, 7, 6, 0)
    assert bucket_open(_tsh(2026, 7, 6, 4, 59), r) == _tsh(2026, 7, 6, 0)
    # The 20:00 bar is 4h: it ends at midnight, not at 01:00.
    assert bucket_end(_tsh(2026, 7, 5, 20), r) == _tsh(2026, 7, 6, 0)
    assert bucket_end(_tsh(2026, 7, 5, 16), r) == _tsh(2026, 7, 5, 20)


def test_seven_minute_resets_at_midnight():
    r = rule_for("MINUTE_7")
    # 1440 = 205*7 + 5: the last bar of the day starts 23:55 and lasts 5 minutes.
    assert bucket_open(_tsh(2026, 7, 5, 23, 57), r) == _tsh(2026, 7, 5, 23, 55)
    assert bucket_end(_tsh(2026, 7, 5, 23, 57), r) == _tsh(2026, 7, 6, 0)
    assert bucket_open(_tsh(2026, 7, 6, 0, 6), r) == _tsh(2026, 7, 6, 0)


def test_fold_seven_minute_across_midnight_splits_buckets():
    r = rule_for("MINUTE_7")
    bars = [
        Candle(datetime(2026, 7, 5, 23, 58, tzinfo=timezone.utc), 1, 2, 0.5, 1.5, 1),
        Candle(datetime(2026, 7, 5, 23, 59, tzinfo=timezone.utc), 1.5, 3, 1, 2, 1),
        Candle(datetime(2026, 7, 6, 0, 0, tzinfo=timezone.utc), 2, 2.5, 1.8, 2.2, 1),
    ]
    out = fold(bars, r)
    assert [c.time.hour for c in out] == [23, 0]
    assert out[0].high == 3 and out[0].close == 2 and out[1].open == 2


def test_ninety_minute_fold_from_thirty():
    r = rule_for("MINUTE_90")
    bars = [
        Candle(datetime(2026, 7, 5, h, m, tzinfo=timezone.utc), 1, 1 + i, 1, 1, 1)
        for i, (h, m) in enumerate([(0, 0), (0, 30), (1, 0), (1, 30)])
    ]
    out = fold(bars, r)
    assert [(c.time.hour, c.time.minute) for c in out] == [(0, 0), (1, 30)]
    assert out[0].high == 3


def test_day_two_groups_preserve_offset():
    r = rule_for("DAY_2")
    t = _ts(2026, 7, 5)
    o = bucket_open(t, r)
    assert o in (t, t - 86400)
    assert bucket_end(t, r) == o + 2 * 86400
    assert bucket_open(o + 86400, r) == o


def test_five_month_groups_are_january_anchored_with_short_tail():
    r = rule_for("MONTH_5")
    assert bucket_open(_ts(2026, 3, 10), r) == _ts(2026, 1, 1)
    assert bucket_open(_ts(2026, 7, 10), r) == _ts(2026, 6, 1)
    assert bucket_open(_ts(2026, 12, 10), r) == _ts(2026, 11, 1)
    assert bucket_end(_ts(2026, 12, 10), r) == _ts(2027, 1, 1)  # Nov–Dec, short
    assert bucket_end(_ts(2026, 7, 10), r) == _ts(2026, 11, 1)


def test_base_count_for_custom_kinds():
    assert base_count_for(rule_for("HOUR_6"), 10) == 60
    assert base_count_for(rule_for("MINUTE_90"), 10) == 30
    assert base_count_for(rule_for("DAY_2"), 10) == 20
    assert base_count_for(rule_for("HOUR_23"), 100) == 1000  # capped


def test_resolution_seconds_rejects_garbage():
    import pytest
    from auto_trader.core.timeframe import TimeframeError

    assert resolution_seconds("HOUR_6") == 21600
    with pytest.raises(TimeframeError):
        resolution_seconds("HOUR_99")
```

And the parity test, appended to `backend/tests/test_api_patterns.py` next to the existing `fold_arrays` MONTH test at :577:

```python
def test_fold_arrays_matches_bucket_open_for_custom_kinds():
    import numpy as np
    from auto_trader.core.candle_aggregate import bucket_open, rule_for
    from auto_trader.core.pattern_series import fold_arrays

    # 1m bars across two midnights, and daily bars across two years.
    minute_ts = np.arange(1_751_760_000 - 3600, 1_751_760_000 + 86400 + 3600, 60, dtype=np.int64)
    day_ts = np.arange(1_735_689_600, 1_735_689_600 + 800 * 86400, 86400, dtype=np.int64)
    for res, ts in (("MINUTE_7", minute_ts), ("HOUR_5", minute_ts),
                    ("DAY_3", day_ts), ("MONTH_5", day_ts), ("MONTH_4", day_ts)):
        rule = rule_for(res)
        ohlc = np.ones((len(ts), 4))
        got, _ = fold_arrays(ts, ohlc, rule)
        want = sorted({bucket_open(int(t), rule) for t in ts})
        assert got.tolist() == want, res
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && .venv/bin/pytest tests/test_candle_aggregate.py tests/test_api_patterns.py -q -k "custom or rule_for or derived_mapping or five or seven or ninety or day_two or garbage"`
Expected: FAIL, `ImportError: cannot import name 'rule_for'`.

- [ ] **Step 3: Implement in `candle_aggregate.py`**

Replace the `DERIVED` dict (:40-56), `is_derived` and `resolution_seconds` with:

```python
from collections.abc import Iterator, Mapping
from functools import lru_cache

from auto_trader.core import timeframe as _tf

_DAY = 86400

# Native minute bases, largest first: a MINUTE_N fold uses the largest one
# dividing N. All of them divide a day, so no base bar straddles the 00:00 reset.
_MINUTE_BASES = (
    (30, Resolution.MINUTE_30), (15, Resolution.MINUTE_15),
    (5, Resolution.MINUTE_5), (1, Resolution.MINUTE),
)
_BUILTIN_DERIVED = (
    "MINUTE_3", "WEEK_2", "WEEK_3", "WEEK_6", "MONTH", "MONTH_2", "MONTH_3", "YEAR",
)


@lru_cache(maxsize=512)
def rule_for(res: str) -> BucketRule | None:
    """The fold rule for a non-native timeframe; None for natives, seconds keys
    and anything the grammar rejects. Hours fold from HOUR, never HOUR_4: some
    brokers offset their 4H bars from UTC midnight, which would break the daily
    reset."""
    try:
        t = _tf.parse(res)
    except _tf.TimeframeError:
        return None
    if t.unit == "SECOND" or _tf.is_native(res):
        return None
    if t.unit == "MINUTE":
        base = next(r for step, r in _MINUTE_BASES if t.n % step == 0)
        return BucketRule(base, "minute", t.n)
    if t.unit == "HOUR":
        return BucketRule(Resolution.HOUR, "minute", t.n * 60)
    if t.unit == "DAY":
        return BucketRule(Resolution.DAY, "day", t.n)
    if t.unit == "WEEK":
        return BucketRule(Resolution.WEEK, "week", t.n)
    if t.unit == "MONTH":
        return BucketRule(Resolution.DAY, "month", t.n)
    return BucketRule(Resolution.DAY, "year", 1)


class _DerivedRules(Mapping[str, BucketRule]):
    """Every derived timeframe's rule, computed on demand from the grammar.
    Membership and lookup accept any valid derived timeframe; iteration lists
    only the built-in set (the grammar itself is unbounded)."""

    def __getitem__(self, res: str) -> BucketRule:
        rule = rule_for(res) if isinstance(res, str) else None
        if rule is None:
            raise KeyError(res)
        return rule

    def __contains__(self, res: object) -> bool:
        return isinstance(res, str) and rule_for(res) is not None

    def __iter__(self) -> Iterator[str]:
        return iter(_BUILTIN_DERIVED)

    def __len__(self) -> int:
        return len(_BUILTIN_DERIVED)


DERIVED: Mapping[str, BucketRule] = _DerivedRules()


def is_derived(res: str) -> bool:
    return res in DERIVED


def resolution_seconds(res: str) -> int:
    """Nominal bar width in seconds for any timeframe (months 30d, year 365d).
    For coarse math like annualization, never for bucketing. Raises
    TimeframeError (a ValueError) on an invalid timeframe."""
    return _tf.seconds(res)
```

Update the `BucketRule.kind` comment to `# "minute" (daily-reset intraday, group = span in minutes) | "day" | "week" | "month" | "year"` and the `group` comment to `# minute: span in minutes (6H -> 360); others: multiplier`. Drop the now-unused `_MONTH`/`_YEAR` constants only if nothing else imports them (`grep -rn "_MONTH\|_YEAR" backend/auto_trader`).

Replace the minute/week branches of `bucket_open` and all of `bucket_end`:

```python
def bucket_open(ts: int, rule: BucketRule) -> int:
    """UTC open timestamp of the bucket containing a base bar opening at `ts`."""
    if rule.kind == "minute":
        # Daily reset at 00:00 UTC: buckets tile each day from midnight, so a
        # span that doesn't divide the day ends the day on a short bar.
        span = rule.group * _MINUTE
        day = ts - ts % _DAY
        return day + ((ts - day) // span) * span
    if rule.kind == "day":
        # Like weeks: subtract whole days from `ts` so the broker's daily-bar
        # offset is preserved.
        return ts - ((ts // _DAY) % rule.group) * _DAY
    if rule.kind == "week":
        idx = ts // _WEEK
        return ts - (idx % rule.group) * _WEEK
    dt = datetime.fromtimestamp(ts, tz=timezone.utc)
    if rule.kind == "year":
        return _utc_ts(datetime(dt.year, 1, 1, tzinfo=timezone.utc))
    # month groups: January-anchored within the year (1-based months).
    g = rule.group
    start_month = ((dt.month - 1) // g) * g + 1
    return _utc_ts(datetime(dt.year, start_month, 1, tzinfo=timezone.utc))


def bucket_end(ts: int, rule: BucketRule) -> int:
    """UTC open timestamp of the bucket AFTER the one containing `ts` (exclusive
    upper edge). Used to snap a scroll-back window outward so every folded bucket
    is complete. Short buckets (the last intraday bar of a day, the last month
    group of a year) end at the reset, not a full span later."""
    start = bucket_open(ts, rule)
    if rule.kind == "minute":
        return min(start + rule.group * _MINUTE, start - start % _DAY + _DAY)
    if rule.kind == "day":
        return start + rule.group * _DAY
    if rule.kind == "week":
        return start + rule.group * _WEEK
    dt = datetime.fromtimestamp(start, tz=timezone.utc)
    if rule.kind == "year":
        return _utc_ts(datetime(dt.year + 1, 1, 1, tzinfo=timezone.utc))
    idx = dt.year * 12 + (dt.month - 1)
    nxt = min(idx + rule.group, (dt.year + 1) * 12)
    return _utc_ts(datetime(nxt // 12, nxt % 12 + 1, 1, tzinfo=timezone.utc))
```

Replace `base_count_for`:

```python
def base_count_for(rule: BucketRule, n: int) -> int:
    """Base bars to fetch to cover `n` aggregate bars (over-fetch, then slice)."""
    if rule.kind == "minute":
        per = rule.group * _MINUTE // rule.base.seconds
    elif rule.kind in ("day", "week"):
        per = rule.group
    elif rule.kind == "month":
        per = 31 * rule.group
    else:  # year
        per = 366
    return min(_MAX_BASE, n * per)
```

Update the module docstring's first paragraph to: derived resolutions are any non-native timeframe the grammar in `core/timeframe.py` accepts (the eight built-ins plus user-defined ones), folded on read, never cached as their own series; intraday ones reset daily at 00:00 UTC.

- [ ] **Step 4: Update `fold_arrays` in `pattern_series.py`** (:43-58) to the same edges:

```python
    if rule.kind == "minute":
        span = rule.group * 60
        day = ts - ts % 86400
        buckets = day + ((ts - day) // span) * span
    elif rule.kind == "day":
        buckets = ts - ((ts // 86400) % rule.group) * 86400
    elif rule.kind == "week":
        buckets = ts - ((ts // _WEEK) % rule.group) * _WEEK
    else:
        # Calendar buckets on a flat months-since-1970 index. 1970 starts in
        # January, so idx % 12 is the month of the year and month groups
        # re-anchor to January every year, exactly like bucket_open.
        months = ts.astype("datetime64[s]").astype("datetime64[M]")
        if rule.kind == "year":
            starts = months.astype("datetime64[Y]").astype("datetime64[M]")
        else:
            idx = months.astype(np.int64)
            year0 = idx - idx % 12
            starts = (year0 + ((idx - year0) // rule.group) * rule.group).astype("datetime64[M]")
        buckets = starts.astype("datetime64[s]").astype(np.int64)
```

- [ ] **Step 5: Run the fold tests plus every existing derived test**

Run: `cd backend && .venv/bin/pytest tests/test_candle_aggregate.py tests/test_candles_derived.py tests/test_api_patterns.py tests/test_whatif_aggregate.py -q`
Expected: PASS. If `test_registry_covers_eight_tokens` or any existing minute test fails, the daily-reset formula is wrong (3 divides 1440, so 3m must be unchanged): fix the code, not the test.

- [ ] **Step 6: Commit**

```bash
git add backend/auto_trader/core/candle_aggregate.py backend/auto_trader/core/pattern_series.py backend/tests/test_candle_aggregate.py backend/tests/test_api_patterns.py
git commit -m "feat(timeframes): fold any grammar timeframe with daily-reset intraday buckets"
```

---

### Task 3: Backend boundaries (canonicalize, 422s, pins, labels)

**Files:**
- Modify: `backend/auto_trader/api/app.py` (after `app = FastAPI(...)` at :197)
- Modify: `backend/auto_trader/api/deps.py:316-323` (`_parse_resolution`) and `:375-386` (`_fetch_symbol_candles` entry)
- Modify: `backend/auto_trader/api/routers/charts.py:198-206` (`_base_resolution`)
- Modify: `backend/auto_trader/api/routers/stream.py:72` (read of `res_raw`) and after `_fatal` is defined (:112)
- Modify: `backend/auto_trader/strategy/expr/tfs.py`
- Modify: `backend/auto_trader/strategy/expr/validate.py:45-49` and `:188-192`
- Modify: `backend/auto_trader/core/telegram_notify.py:74-77, 339`
- Test: `backend/tests/test_timeframe_api.py` (new)

**Interfaces:**
- Consumes: `timeframe.canonicalize`, `timeframe.label`, `TimeframeError` (Task 1); `DERIVED`/`is_derived` (Task 2).
- Produces:
  - Any `TimeframeError` escaping a route handler becomes HTTP 422 `{"detail": str(e)}`.
  - `tf_resolution(alias) -> str | None` returns the CANONICAL resolution for any valid pin (`"6H"` → `"HOUR_6"`, `"D"` → `"DAY"`, `"HOUR_4"` → `"HOUR_4"`), None when invalid or a seconds key.
  - `TF_RESOLUTIONS` stays (suggested aliases for messages/completions), unchanged.

- [ ] **Step 1: Write the failing tests** `backend/tests/test_timeframe_api.py`

```python
from auto_trader.api.deps import _parse_resolution
from auto_trader.core.telegram_notify import _timeframe_label
from auto_trader.strategy.expr.tfs import tf_resolution
from auto_trader.strategy.expr.parser import parse
from auto_trader.strategy.expr.validate import validate


def test_tf_resolution_accepts_grammar():
    assert tf_resolution("6H") == "HOUR_6"
    assert tf_resolution("90m") == "MINUTE_90"
    assert tf_resolution("D") == "DAY"
    assert tf_resolution("4H") == "HOUR_4"
    assert tf_resolution("HOUR_4") == "HOUR_4"
    assert tf_resolution("MINUTE_120") == "HOUR_2"
    assert tf_resolution("7h") is None
    assert tf_resolution("SECOND_5") is None


def test_pin_on_custom_timeframe_validates():
    validate(parse("close@6H > close"), is_exit=False)


def test_bad_pin_message_names_the_grammar():
    import pytest
    from auto_trader.strategy.expr.errors import ExprError

    with pytest.raises(ExprError, match="7m, 6H, 2D"):
        validate(parse("close@6h > close"), is_exit=False)


def test_parse_resolution_still_rejects_non_native():
    import pytest
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as e:
        _parse_resolution("HOUR_99")
    assert e.value.status_code == 422


def test_invalid_candles_resolution_raises_timeframe_error():
    # Direct-call convention of tests/test_api_candles.py (no lifespan, no
    # pytest-asyncio): the route raises; the app handler below maps it to 422.
    import asyncio

    import pytest

    import auto_trader.api.app as app_module
    from auto_trader.core.timeframe import TimeframeError

    async def scenario():
        return await app_module.candles(
            epic="US100", resolution="HOUR_99", bars=500, from_ts=None,
            to_ts=None, price_side="mid", broker_id="capital",
        )

    with pytest.raises(TimeframeError, match="between 1 and 24"):
        asyncio.run(scenario())


def test_timeframe_error_handler_is_422():
    import asyncio
    import json

    from auto_trader.api.app import _timeframe_error
    from auto_trader.core.timeframe import TimeframeError

    resp = asyncio.run(_timeframe_error(None, TimeframeError("hours must be between 1 and 24")))
    assert resp.status_code == 422
    assert json.loads(resp.body) == {"detail": "hours must be between 1 and 24"}


def test_stream_resolution_canonicalizes_or_explains():
    from auto_trader.api.routers.stream import _stream_resolution

    assert _stream_resolution("MINUTE_120") == ("HOUR_2", None)
    assert _stream_resolution("SECOND_5") == ("SECOND_5", None)
    res, err = _stream_resolution("HOUR_99")
    assert res is None and "between 1 and 24" in err


def test_telegram_label_falls_back_to_grammar():
    assert _timeframe_label("HOUR_4") == "4h"   # existing native wording kept
    assert _timeframe_label("HOUR_6") == "6H"
    assert _timeframe_label("garbage") == "garbage"
```

`validate(node, *, is_exit, ...)` and `parse(src)` are the real entry points (validate.py:14, parser.py:297). Check the `candles` keyword names against `routers/charts.py:83` (tests/test_api_candles.py calls it the same way) and match them; do not rename production functions.

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && .venv/bin/pytest tests/test_timeframe_api.py -q`
Expected: FAIL (`_timeframe_label` missing, `tf_resolution("6H")` is None, candles returns 404/422 without the reason).

- [ ] **Step 3: Implement**

`app.py`, right after `app = FastAPI(...)`:

```python
from fastapi.responses import JSONResponse

from auto_trader.core.timeframe import TimeframeError


@app.exception_handler(TimeframeError)
async def _timeframe_error(_request, exc: TimeframeError) -> JSONResponse:
    # Any resolution the grammar rejects is the caller's input error: 422 with
    # the reason ("hours must be between 1 and 24"), never a 500.
    return JSONResponse({"detail": str(exc)}, status_code=422)
```

`deps.py` `_fetch_symbol_candles`: first line after `broker_id = broker_id or default_broker_id()`:

```python
    # One canonical key per timeframe (MINUTE_120 and HOUR_2 share a cache);
    # raises TimeframeError -> 422 for anything the grammar rejects.
    resolution = canonicalize(resolution)
```

with `from auto_trader.core.timeframe import canonicalize` at the top. Update the derived-branch comment "3m, 2W/3W/6W, 1M/2M/3M, 1Y aren't native..." to "Non-native timeframes (3m, 6H, 2D, 2W, 4M, 1Y, ...) fold the cached base series on read". Leave `_parse_resolution` as is (natives only).

`charts.py` `_base_resolution`: first line `resolution = canonicalize(resolution)` (same import).

`stream.py`: add a module-level helper next to `_accum_params`:

```python
def _stream_resolution(res_raw: str) -> tuple[str | None, str | None]:
    """(canonical resolution, None) or (None, reason) for a /ws/candles param."""
    try:
        return canonicalize(res_raw), None
    except TimeframeError as e:
        return None, str(e)
```

and right after `_fatal` is defined (:112), before `is_ig`:

```python
    canon, bad = _stream_resolution(res_raw)
    if canon is None:
        # A malformed resolution can never succeed on retry.
        return await _fatal(bad)
    res_raw = canon
```

with `from auto_trader.core.timeframe import TimeframeError, canonicalize`. `_accum_params` is called later with the canonical `res_raw`; confirm with `grep -n "_accum_params(" backend/auto_trader/api/routers/stream.py` that its call site is below this point, and if not, move the canonicalize block above it.

`tfs.py`: replace `tf_resolution`:

```python
from auto_trader.core.timeframe import TimeframeError, canonicalize


def tf_resolution(alias: str) -> str | None:
    """Canonical resolution for a pin: any timeframe the grammar accepts, as a
    label (6H, 90m, D) or a canonical name (HOUR_6). None when invalid, and for
    the live-only seconds keys, which have no history to pin to."""
    try:
        res = canonicalize(alias)
    except TimeframeError:
        return None
    return None if res.startswith("SECOND") else res
```

Update its module docstring: aliases are now any grammar label; `TF_RESOLUTIONS` is the suggested set shown in messages.

`validate.py` both messages become:

```python
f"Unknown timeframe {base.tf}. Use a number and a unit, like 7m, 6H, 2D, 3W or 2M.",
```

(and `node.tf` in the second). Remove the `TF_RESOLUTIONS` import if now unused. Then check the shared expr corpus still agrees on codes: `grep -n "unknown_tf" frontend/src/lib/expr/corpus.json | head`; the frontend message changes in Task 5 to the identical string.

`routers/alerts.py:87-91`: after the existing length check, canonicalize so a stored alert timeframe is always canonical (seconds keys pass the grammar):

```python
    if timeframe is not None:
        try:
            params["timeframe"] = canonicalize(timeframe)
        except TimeframeError as e:
            raise HTTPException(422, f"params.timeframe: {e}") from None
```

(check the local name holding the params dict at that point and use it; import `TimeframeError, canonicalize` from `auto_trader.core.timeframe`). Add to `test_timeframe_api.py` a direct test of that validator if it is a standalone function, else of the route per the file's existing alerts tests (`grep -ln "params.timeframe" backend/tests`).

`telegram_notify.py`: keep the dict, add:

```python
def _timeframe_label(timeframe: str) -> str:
    """Caption label: the historical wording for natives, the grammar label for
    anything else, the raw string when neither applies."""
    if timeframe in _TIMEFRAME_LABELS:
        return _TIMEFRAME_LABELS[timeframe]
    try:
        return label(timeframe)
    except TimeframeError:
        return timeframe
```

and at :339 use `tf_label = _timeframe_label(timeframe)`.

- [ ] **Step 4: Run the new tests plus the suites these files feed**

Run: `cd backend && .venv/bin/pytest tests/test_timeframe_api.py tests/test_timeframe.py tests/test_candle_aggregate.py tests/test_candles_derived.py -q && .venv/bin/pytest tests -q -k "expr or stream or telegram or candles or backtest" -x`
Expected: PASS. An expr test that asserted the old "Try one of" message text must be updated to the new message (message only; codes stay).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/app.py backend/auto_trader/api/deps.py backend/auto_trader/api/routers/charts.py backend/auto_trader/api/routers/stream.py backend/auto_trader/api/routers/alerts.py backend/auto_trader/strategy/expr/tfs.py backend/auto_trader/strategy/expr/validate.py backend/auto_trader/core/telegram_notify.py backend/tests/test_timeframe_api.py
git commit -m "feat(timeframes): canonicalize at API boundaries, 422 on bad timeframes, grammar pins"
```

(Add any updated existing test file to the `git add` by explicit path.)

---

### Task 4: Frontend timeframe grammar

**Files:**
- Create: `frontend/src/lib/timeframe.ts`
- Test: `frontend/src/lib/timeframe.test.ts`

**Interfaces:**
- Consumes: `frontend/src/lib/timeframes.corpus.json` (Task 1).
- Produces (all pure, no imports):
  - `class TimeframeError extends Error`
  - `parseTf(res: string): { unit: TfUnit; n: number }` (throws `TimeframeError`)
  - `canonicalTf(res: string): string` (throws)
  - `tryCanonicalTf(res: string): string | null`
  - `tfSecondsOf(res: string): number | null` (null when invalid)
  - `tfLabel(res: string): string` (raw string when invalid)
  - `isNativeTf(res: string): boolean`
  - `barEndMs(res: string, openMs: number): number | null` (short last intraday bar ends at 00:00 UTC)
  - `TF_LIMITS: Record<"MINUTE"|"HOUR"|"DAY"|"WEEK"|"MONTH", number>`
  - `TF_UNIT_SUFFIX: Record<same, "m"|"H"|"D"|"W"|"M">`

- [ ] **Step 1: Write the failing test** `frontend/src/lib/timeframe.test.ts`

```ts
import { describe, it, expect } from "vitest";
import corpus from "./timeframes.corpus.json";
import { barEndMs, canonicalTf, tfLabel, tfSecondsOf, TimeframeError, isNativeTf, tryCanonicalTf } from "./timeframe";

interface Row { input: string; canonical?: string; label?: string; seconds?: number; error?: boolean }

describe("timeframe corpus (shared with backend/tests/test_timeframe.py)", () => {
  for (const row of corpus as Row[]) {
    it(row.input || "<empty>", () => {
      if (row.error) {
        expect(() => canonicalTf(row.input)).toThrow(TimeframeError);
        expect(tryCanonicalTf(row.input)).toBeNull();
        expect(tfSecondsOf(row.input)).toBeNull();
        return;
      }
      expect(canonicalTf(row.input)).toBe(row.canonical);
      expect(tfLabel(row.input)).toBe(row.label);
      expect(tfSecondsOf(row.input)).toBe(row.seconds);
    });
  }
});

describe("timeframe helpers", () => {
  it("names the limit", () => {
    expect(() => canonicalTf("HOUR_25")).toThrow("hours must be between 1 and 24");
  });
  it("labels garbage as itself", () => {
    expect(tfLabel("FOO")).toBe("FOO");
  });
  it("ends the last intraday bar of the day at midnight", () => {
    const d = Date.UTC(2026, 6, 5);
    expect(barEndMs("HOUR_5", d + 20 * 3_600_000)).toBe(d + 24 * 3_600_000);
    expect(barEndMs("HOUR_5", d + 15 * 3_600_000)).toBe(d + 20 * 3_600_000);
    expect(barEndMs("MINUTE_7", d + (23 * 60 + 55) * 60_000)).toBe(d + 24 * 3_600_000);
    expect(barEndMs("HOUR_4", d + 20 * 3_600_000)).toBe(d + 24 * 3_600_000);
    expect(barEndMs("FOO", d)).toBeNull();
  });
  it("knows natives", () => {
    expect(isNativeTf("4H")).toBe(true);
    expect(isNativeTf("HOUR_6")).toBe(false);
    expect(isNativeTf("FOO")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/lib/timeframe.test.ts`
Expected: FAIL, cannot resolve `./timeframe`.

- [ ] **Step 3: Implement** `frontend/src/lib/timeframe.ts`

```ts
// Timeframe grammar: parse, canonicalize, size and label any candle resolution.
// Mirrors backend/auto_trader/core/timeframe.py; both are pinned by
// timeframes.corpus.json. A resolution is a native name (MINUTE, HOUR_4, DAY),
// a fixed seconds key (SECOND_5, live only), YEAR, or UNIT_N. Labels (7m, 6H,
// 2D, 3W, 4M, 1Y) and the D/W pin aliases parse too. Dependency-free on purpose:
// feed.ts and the expression catalog both import it.

export type TfUnit = "SECOND" | "MINUTE" | "HOUR" | "DAY" | "WEEK" | "MONTH" | "YEAR";
type SizedUnit = "MINUTE" | "HOUR" | "DAY" | "WEEK" | "MONTH";

export class TimeframeError extends Error {}

const SECONDS_KEYS: Record<string, number> = {
  SECOND: 1, SECOND_5: 5, SECOND_10: 10, SECOND_15: 15, SECOND_30: 30, SECOND_45: 45,
};
const UNIT_SECONDS: Record<SizedUnit, number> = {
  MINUTE: 60, HOUR: 3600, DAY: 86400, WEEK: 604800, MONTH: 30 * 86400,
};
const YEAR_SECONDS = 365 * 86400;
export const TF_LIMITS: Record<SizedUnit, number> = {
  MINUTE: 1439, HOUR: 24, DAY: 365, WEEK: 52, MONTH: 12,
};
const UNIT_WORD: Record<SizedUnit, string> = {
  MINUTE: "minutes", HOUR: "hours", DAY: "days", WEEK: "weeks", MONTH: "months",
};
export const TF_UNIT_SUFFIX: Record<SizedUnit, "m" | "H" | "D" | "W" | "M"> = {
  MINUTE: "m", HOUR: "H", DAY: "D", WEEK: "W", MONTH: "M",
};
const SUFFIX_UNIT: Record<string, SizedUnit> = { m: "MINUTE", H: "HOUR", D: "DAY", W: "WEEK", M: "MONTH" };
const NATIVE = new Set(["MINUTE", "MINUTE_5", "MINUTE_15", "MINUTE_30", "HOUR", "HOUR_4", "DAY", "WEEK"]);

const CANON_RE = /^(MINUTE|HOUR|DAY|WEEK|MONTH)(?:_(\d{1,5}))?$/;
const LABEL_RE = /^(\d{1,5})([mHDWM])$/;

interface Tf { unit: TfUnit; n: number }

function normalize(unit: SizedUnit, n: number): Tf {
  if (!(n >= 1 && n <= TF_LIMITS[unit])) {
    throw new TimeframeError(`${UNIT_WORD[unit]} must be between 1 and ${TF_LIMITS[unit]}`);
  }
  if (unit === "MINUTE" && n % 60 === 0) return { unit: "HOUR", n: n / 60 };
  if (unit === "HOUR" && n === 24) return { unit: "DAY", n: 1 };
  if (unit === "MONTH" && n === 12) return { unit: "YEAR", n: 1 };
  return { unit, n };
}

export function parseTf(res: string): Tf {
  if (typeof res !== "string") throw new TimeframeError("timeframe must be a string");
  if (Object.hasOwn(SECONDS_KEYS, res)) return { unit: "SECOND", n: SECONDS_KEYS[res] };
  if (res === "YEAR" || res === "1Y") return { unit: "YEAR", n: 1 };
  if (res === "D") return { unit: "DAY", n: 1 };
  if (res === "W") return { unit: "WEEK", n: 1 };
  let m = CANON_RE.exec(res);
  if (m) return normalize(m[1] as SizedUnit, m[2] ? parseInt(m[2], 10) : 1);
  m = LABEL_RE.exec(res);
  if (m) return normalize(SUFFIX_UNIT[m[2]], parseInt(m[1], 10));
  throw new TimeframeError(
    `unknown timeframe '${res.slice(0, 40)}'. Use a number and a unit, like 7m, 6H, 2D, 3W or 2M`,
  );
}

function toStr(t: Tf): string {
  if (t.unit === "YEAR") return "YEAR";
  return t.n === 1 ? t.unit : `${t.unit}_${t.n}`;
}

export function canonicalTf(res: string): string {
  return toStr(parseTf(res));
}

export function tryCanonicalTf(res: string): string | null {
  try {
    return canonicalTf(res);
  } catch {
    return null;
  }
}

// Memoized: RESOLUTION_SECONDS (feed.ts) falls through to this on every miss,
// and those lookups sit in paint/overlay loops. The key space is tiny.
const SECONDS_MEMO = new Map<string, number | null>();

export function tfSecondsOf(res: string): number | null {
  const hit = SECONDS_MEMO.get(res);
  if (hit !== undefined) return hit;
  let out: number | null;
  try {
    const t = parseTf(res);
    out = t.unit === "SECOND" ? t.n
      : t.unit === "YEAR" ? YEAR_SECONDS
      : t.n * UNIT_SECONDS[t.unit as SizedUnit];
  } catch {
    out = null;
  }
  if (SECONDS_MEMO.size < 1024) SECONDS_MEMO.set(res, out);
  return out;
}

const DAY_MS = 86_400_000;

/** When a bar opening at `openMs` closes, for the bars whose width is NOT the
 *  nominal one: non-native minute/hour timeframes reset at 00:00 UTC, so the
 *  day's last bar ends at midnight (5H: the 20:00 bar is 4h). Everything else
 *  returns `openMs + nominal` (calendar widths stay the caller's problem, as
 *  before). null for an invalid timeframe. */
export function barEndMs(res: string, openMs: number): number | null {
  const secs = tfSecondsOf(res);
  if (secs == null) return null;
  const end = openMs + secs * 1000;
  let t: Tf;
  try {
    t = parseTf(res);
  } catch {
    return null;
  }
  if ((t.unit === "MINUTE" || t.unit === "HOUR") && !isNativeTf(res)) {
    const nextMidnight = openMs - (((openMs % DAY_MS) + DAY_MS) % DAY_MS) + DAY_MS;
    return Math.min(end, nextMidnight);
  }
  return end;
}

export function tfLabel(res: string): string {
  let t: Tf;
  try {
    t = parseTf(res);
  } catch {
    return res;
  }
  if (t.unit === "SECOND") return `${t.n}s`;
  if (t.unit === "YEAR") return "1Y";
  return `${t.n}${TF_UNIT_SUFFIX[t.unit as SizedUnit]}`;
}

export function isNativeTf(res: string): boolean {
  const c = tryCanonicalTf(res);
  return c != null && NATIVE.has(c);
}
```

If `tsconfig` lacks `resolveJsonModule` for the test import, it already works for `lib/expr/corpus.json`, so no config change is expected.

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run src/lib/timeframe.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/timeframe.ts frontend/src/lib/timeframe.test.ts
git commit -m "feat(timeframes): frontend timeframe grammar pinned to the shared corpus"
```

---

### Task 5: Frontend plumbing (feed, expression pins, agent actions)

**Files:**
- Modify: `frontend/src/lib/persist/artifacts.ts:417-427` (+ the persist barrel if it re-exports by name: `grep -n "FavoriteResolutions" frontend/src/lib/persist/*.ts`)
- Modify: `frontend/src/chart/useChartPaint.ts:704-709` (bar countdown)
- Modify: `frontend/src/lib/replayBars.ts:15-26` (newest-bar close)
- Modify: `frontend/src/lib/replayReveal.ts:45-90` (`revealBarMs` calendar max)
- Modify: `frontend/src/lib/feed.ts` (`RESOLUTION_SECONDS` :937, `periodByResolution` :120, `PERIOD_GROUPS` :73, `pinnableTimeframes` :127, `pinBelowChart` :140, `nominalBarHours` :978, `quickBarPeriods` :993, `oneTfLower` :1011)
- Modify: `frontend/src/lib/expr/catalog.ts:83-98` (`tfSeconds`)
- Modify: `frontend/src/lib/expr/parser.ts:697-701, 771-775` (messages)
- Modify: `frontend/src/lib/expr/highlight.ts:21, 94`
- Modify: `frontend/src/agent/actions/chart.ts:215-240`, `frontend/src/agent/actions/indicators.ts:126-137`
- Test: `frontend/src/lib/feed.test.ts`, `frontend/src/lib/expr/parser.test.ts`, `frontend/src/lib/expr/complete.test.ts`

**Interfaces:**
- Consumes: Task 4 exports (incl. `barEndMs`).
- Produces:
  - `loadCustomResolutions(): string[]`, `saveCustomResolutions(list: string[]): void` (key `${PREFIX}.customResolutions`, mirrored via `save()`); Task 6 and `complete.ts` use them.
  - `RESOLUTION_SECONDS[res]` returns the nominal seconds for ANY valid timeframe (canonical or not), `undefined` otherwise; `Object.entries(RESOLUTION_SECONDS)` still lists exactly the built-in keys (App.tsx:235 relies on it).
  - `periodByResolution(res): Period | undefined` — built-in Period when known, else a synthesized `{ resolution: canonical, label }` for any valid non-seconds timeframe; `undefined` for invalid strings and non-listed seconds keys.
  - `periodGroups(custom: string[]): PeriodGroup[]` — `PERIOD_GROUPS` plus a trailing `{ label: "Custom", periods }` group (omitted when empty), custom entries canonicalized, de-duplicated, excluding built-ins, sorted by seconds.
  - `PERIOD_GROUPS` stays exported (built-ins only).
  - `tfSeconds(tf)` in the catalog accepts any valid timeframe except seconds keys.

- [ ] **Step 0: Persist functions** in `artifacts.ts` after the favorites block (no test of their own: two-line load/save wrappers identical in shape to `loadFavoriteResolutions`):

```ts
// Custom timeframes (GLOBAL preference): canonical resolution strings the user
// defined in the interval dropdown ("Add custom"). The grammar needs no
// registry, so this list only drives what the menus offer; a chart already on
// a deleted custom timeframe keeps working.
const CUSTOM_RESOLUTIONS_KEY = `${PREFIX}.customResolutions`;
export function loadCustomResolutions(): string[] {
  return load<string[]>(CUSTOM_RESOLUTIONS_KEY, []);
}
export function saveCustomResolutions(list: string[]): void {
  save(CUSTOM_RESOLUTIONS_KEY, list);
}
```

Re-export from the persist barrel the same way `loadFavoriteResolutions` is.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/feed.test.ts`:

```ts
import { RESOLUTION_SECONDS, periodByResolution, periodGroups, quickBarPeriods, nominalBarHours, oneTfLower, pinnableTimeframes } from "./feed";

describe("custom timeframes in feed", () => {
  it("sizes any grammar timeframe", () => {
    expect(RESOLUTION_SECONDS["HOUR_6"]).toBe(21600);
    expect(RESOLUTION_SECONDS["MINUTE_120"]).toBe(7200);
    expect(RESOLUTION_SECONDS["FOO"]).toBeUndefined();
    expect(Object.keys(RESOLUTION_SECONDS)).toContain("HOUR_4");
    expect(Object.keys(RESOLUTION_SECONDS)).not.toContain("HOUR_6");
  });
  it("synthesizes periods", () => {
    expect(periodByResolution("HOUR_6")).toEqual({ resolution: "HOUR_6", label: "6H" });
    expect(periodByResolution("MINUTE_120")).toEqual({ resolution: "HOUR_2", label: "2H" });
    expect(periodByResolution("HOUR_4")?.label).toBe("4H");
    expect(periodByResolution("FOO")).toBeUndefined();
  });
  it("groups the custom list after the built-ins", () => {
    const groups = periodGroups(["DAY_2", "MINUTE_120", "HOUR_2", "HOUR_4", "junk"]);
    const custom = groups[groups.length - 1];
    expect(custom.label).toBe("Custom");
    expect(custom.periods.map((p) => p.label)).toEqual(["2H", "2D"]);
    expect(periodGroups([]).some((g) => g.label === "Custom")).toBe(false);
  });
  it("quick bar dedupes non-canonical favorites", () => {
    const bar = quickBarPeriods(["MINUTE_120", "HOUR_2"]);
    expect(bar.filter((p) => p.resolution === "HOUR_2")).toHaveLength(1);
  });
  it("nominal hours and zoom ladder accept custom", () => {
    expect(nominalBarHours("6H")).toBe(6);
    expect(oneTfLower("HOUR_6", [])?.resolution).toBe("HOUR_4");
  });
  it("pinnable includes custom favorites at or above the chart", () => {
    expect(pinnableTimeframes("HOUR", ["HOUR_6", "MINUTE_7"]).map((p) => p.resolution)).toContain("HOUR_6");
    expect(pinnableTimeframes("HOUR", ["HOUR_6", "MINUTE_7"]).map((p) => p.resolution)).not.toContain("MINUTE_7");
  });
});
```

Append to `frontend/src/lib/expr/parser.test.ts` (use the file's existing `analyze` import and result shape; check one existing `unknown_tf` test for how errors are read):

```ts
describe("custom timeframe pins", () => {
  it("accepts grammar pins", () => {
    for (const tf of ["6H", "90m", "2D", "3W", "4M", "D", "1Y"]) {
      expect(analyze(`close@${tf} > close`, { isExit: false }).error ?? null).toBeNull();
    }
  });
  it("rejects bad pins with the grammar hint", () => {
    const r = analyze("close@6h > close", { isExit: false });
    expect(r.error?.code).toBe("unknown_tf");
    expect(r.error?.message).toContain("7m, 6H, 2D");
  });
});
```

Adjust the `analyze` call signature and error field names to match the existing tests in that file before running.

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/lib/feed.test.ts src/lib/expr/parser.test.ts`
Expected: FAIL (`periodGroups` not exported, `HOUR_6` undefined, `6H` pin rejected).

- [ ] **Step 3: Implement `feed.ts`**

Import at top: `import { canonicalTf, tfLabel, tfSecondsOf, tryCanonicalTf } from "./timeframe";`

Rename the literal table to `const BUILTIN_RESOLUTION_SECONDS: Record<string, number> = { ...existing entries... };` and export a grammar-backed view with the same name existing callers use:

```ts
// Seconds per resolution bucket for ANY timeframe the grammar accepts (see
// lib/timeframe.ts), so custom timeframes flow through every existing
// `RESOLUTION_SECONDS[res] ?? 60` lookup. Enumeration still lists only the
// built-ins (App's RESOLUTION_MS map iterates it).
export const RESOLUTION_SECONDS: Record<string, number> = new Proxy(BUILTIN_RESOLUTION_SECONDS, {
  get(target, key) {
    if (typeof key !== "string") return undefined;
    return target[key] ?? tfSecondsOf(key) ?? undefined;
  },
  has(target, key) {
    return typeof key === "string" && (key in target || tfSecondsOf(key) != null);
  },
});
```

Replace `periodByResolution`:

```ts
export function periodByResolution(resolution: string): Period | undefined {
  const hit = PERIOD_BY_RESOLUTION.get(resolution);
  if (hit) return hit;
  const canon = tryCanonicalTf(resolution);
  if (canon == null || canon.startsWith("SECOND")) return undefined;
  return PERIOD_BY_RESOLUTION.get(canon) ?? { resolution: canon, label: tfLabel(canon) };
}
```

Add after `PERIOD_GROUPS`:

```ts
// The saved custom timeframes as Periods: canonical, de-duplicated, built-ins
// and invalid entries dropped, ascending by duration.
export function customPeriods(custom: string[]): Period[] {
  const seen = new Map<string, Period>();
  for (const raw of custom) {
    const canon = tryCanonicalTf(raw);
    if (canon == null || canon.startsWith("SECOND") || PERIOD_BY_RESOLUTION.has(canon)) continue;
    seen.set(canon, { resolution: canon, label: tfLabel(canon) });
  }
  return [...seen.values()].sort(
    (a, b) => (RESOLUTION_SECONDS[a.resolution] ?? 0) - (RESOLUTION_SECONDS[b.resolution] ?? 0),
  );
}

// PERIOD_GROUPS plus the user's "Custom" group (omitted when empty).
export function periodGroups(custom: string[]): PeriodGroup[] {
  const periods = customPeriods(custom);
  return periods.length ? [...PERIOD_GROUPS, { label: "Custom", periods }] : PERIOD_GROUPS;
}
```

`quickBarPeriods`: key the map by the Period's own (canonical) resolution: replace the loop body with `const p = periodByResolution(r); if (p) byRes.set(p.resolution, p);`.

`pinnableTimeframes(chartResolution: string, custom: string[] = [])`: return `[...PERIODS, ...customPeriods(custom)].filter(...)` with the same seconds comparison, sorted by seconds.

`nominalBarHours`: `const secs = RESOLUTION_SECONDS[resolution] ?? tfSeconds(resolution);` already works through the proxy; leave it.

`oneTfLower`: unchanged (the proxy makes `RESOLUTION_SECONDS[currentResolution]` defined for custom).

Update the file's comment above `RESOLUTION_SECONDS` users as needed; do not touch the other ~40 call sites.

- [ ] **Step 4: Implement the expression side**

`catalog.ts`: import `{ tfSecondsOf }` from `"../timeframe"` and replace `tfSeconds`:

```ts
/** Nominal bar width for a pin: any grammar timeframe (label or canonical),
 *  except the live-only seconds keys, which have no history to pin to. */
export function tfSeconds(tf: string): number | null {
  if (tf.startsWith("SECOND")) return null;
  return tfSecondsOf(tf);
}
```

Keep `TIMEFRAMES` as the suggestion list (palette and completion) and update its comment: suggestions only; validity is the grammar.

`parser.ts` both messages: `` `Unknown timeframe ${base.tf}. Use a number and a unit, like 7m, 6H, 2D, 3W or 2M.` `` (and `node.tf`), byte-identical to the backend message from Task 3. Drop the `TIMEFRAMES` import if unused.

`highlight.ts:94`: `if (prev?.type === "AT") return tfSeconds(value) != null ? "timeframe" : "variable";`, import `tfSeconds` from `./catalog`, delete `TF_ALIASES`.

`complete.ts:205`: after the `TIMEFRAMES` suggestions, append the saved custom list:

```ts
    const custom = loadCustomResolutions().map((r) => ({ alias: tfLabel(r), resolution: r }));
    return [...TIMEFRAMES, ...custom]
      .filter((t) => t.alias.toLowerCase().startsWith(prefix))
      .map((t) => ({ label: t.alias, type: "keyword", detail: t.resolution }));
```

(`loadCustomResolutions` comes from Step 0; import it from `../persist`.)

- [ ] **Step 5: Agent actions**

`agent/actions/chart.ts` handler: replace the lookup with

```ts
      const period =
        periodByResolution(wanted) ??
        ALL_PERIODS.find((p) => p.label === wanted);
      if (!period) {
        throw new ActionError(
          "INVALID_ARGS",
          `unknown timeframe: ${wanted}. Use a resolution (HOUR_4, HOUR_6) or a label (4H, 6H, 90m, 2D, 3W, 2M); m is minutes, M is months. Limits: minutes 1 to 1439, hours 1 to 24, days 1 to 365, weeks 1 to 52, months 1 to 12.`,
        );
      }
```

(`periodByResolution` now parses labels too; the exact-case `find` only keeps seconds labels like `5s` working.) Update the action `description` to: "Switch the focused chart's timeframe. Accepts any resolution (HOUR_4, HOUR_6, MINUTE_90) or label (4H, 6H, 90m, 2D, 3W, 2M; m = minutes, M = months)." Same change in `agent/actions/indicators.ts:126-137` for the indicator pin, keeping its `"chart"` special case.

Note the behavior change: `"1m"` vs `"1M"` are now case-sensitive (minute vs month); the old lowercase compare made `1M` pick the minute. That is the fix, not a regression.

- [ ] **Step 5b: Non-uniform bar widths.** The proxy gives every custom timeframe a nominal width, which is wrong for the day's last intraday bar (5H 20:00 is 4h; 7m 23:55 is 5m). Only three places turn a width into a bar END (grep of `chart/`, `lib/`, `*.tsx` for `timestamp + ...Ms` / `Math.floor(.../resSec)`); fix each through `barEndMs`, test first.

Test, appended to the existing `frontend/src/lib/replayBars.test.ts` (create it if absent) and `frontend/src/lib/replayReveal.test.ts`:

```ts
import { barCloseMs, nominalMsFor } from "./replayBars";
import { revealBarMs } from "./replayReveal";

it("newest 5H bar of the day closes at midnight, not 01:00", () => {
  const d = Date.UTC(2026, 6, 5);
  const bars = [{ timestamp: d + 20 * 3_600_000 }] as never[];
  expect(barCloseMs(bars, 0, nominalMsFor("HOUR_5"), "HOUR_5")).toBe(d + 24 * 3_600_000);
});

it("reveal width for custom months is padded to 31 days a month", () => {
  expect(revealBarMs("MONTH_4")).toBe(4 * 31 * 86_400_000 + 3_600_000);
  expect(revealBarMs("HOUR_6")).toBe(6 * 3_600_000);
});
```

Implementation:
- `replayBars.ts`: `barCloseMs(bars, i, nominalMs, resolution?: string)`: when there is no next bar and `resolution` is given, return `barEndMs(resolution, bars[i].timestamp) ?? bars[i].timestamp + nominalMs`. Thread `resolution` through `revealedCount` and its callers in `chart/useReplay.ts` and `lib/mtfCoordinator.ts` (`grep -n "barCloseMs\|revealedCount" frontend/src/chart/useReplay.ts frontend/src/lib/mtfCoordinator.ts`); each call site already has the resolution in scope next to its `nominalMsFor(...)` call.
- `replayReveal.ts` `revealBarMs`: after the `CALENDAR_MAX_MS` lookup, fall back for grammar months: `const t = tryCanonicalTf(resolution); const m = t && /^MONTH_(\d+)$/.exec(t); const calendarMax = CALENDAR_MAX_MS[resolution] ?? (m ? 31 * Number(m[1]) * DAY_MS : undefined);` (the short intraday tail is narrower than nominal, so nominal already errs wide there, which is the safe direction).
- `useChartPaint.ts:705-708`: `const endMs = barEndMs(resRef.current, last.timestamp) ?? last.timestamp + (RESOLUTION_SECONDS[resRef.current] ?? 60) * 1000;` and compute `rem` from `endMs - Date.now()`.

- [ ] **Step 6: Run the affected tests**

Run: `cd frontend && npx vitest run src/lib/feed.test.ts src/lib/expr/parser.test.ts src/lib/expr/complete.test.ts src/lib/expr/corpus.test.ts src/lib/timeframe.test.ts src/lib/replayBars.test.ts src/lib/replayReveal.test.ts`
Expected: PASS. Then the backend expr corpus: `cd backend && .venv/bin/pytest tests/test_expr_parser_corpus.py -q` (PASS).

- [ ] **Step 7: Typecheck parity**

Run: `cd frontend && npx tsc -b 2>&1 | grep -E "feed.ts|timeframe.ts|catalog.ts|parser.ts|highlight.ts|complete.ts|actions/chart.ts|actions/indicators.ts" ; echo done`
Expected: no lines for these files beyond those already in the baseline list recorded before Task 5 (see Global Constraints; never stash).

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/persist/artifacts.ts frontend/src/lib/replayBars.ts frontend/src/lib/replayBars.test.ts frontend/src/lib/replayReveal.ts frontend/src/lib/replayReveal.test.ts frontend/src/chart/useChartPaint.ts frontend/src/chart/useReplay.ts frontend/src/lib/mtfCoordinator.ts frontend/src/lib/feed.ts frontend/src/lib/feed.test.ts frontend/src/lib/expr/catalog.ts frontend/src/lib/expr/parser.ts frontend/src/lib/expr/parser.test.ts frontend/src/lib/expr/highlight.ts frontend/src/lib/expr/complete.ts frontend/src/agent/actions/chart.ts frontend/src/agent/actions/indicators.ts
git commit -m "feat(timeframes): grammar-backed feed lookups, pins and agent timeframe args"
```

---

### Task 6: Saved custom list + dropdown UI + pickers

**Files:**
- Modify: `frontend/src/ToolbarControls.tsx:90-215`
- Create: `frontend/src/components/CustomTimeframeForm.tsx`
- Modify: `frontend/src/BacktestSettingsModal.tsx:2039, 2400` (`PERIOD_GROUPS.map`)
- Modify: `frontend/src/VisibilityTab.tsx:26`
- Modify: `frontend/src/IndicatorSettings.tsx` (`pinnableTimeframes(...)` call)
- Modify: the stylesheet holding `.interval-dropdown` (`grep -rn "interval-dropdown" frontend/src --include=*.css`)
- Test: `frontend/src/components/CustomTimeframeForm.test.tsx`

**Interfaces:**
- Consumes: `periodGroups`, `customPeriods`, `periodByResolution`, `loadCustomResolutions`, `saveCustomResolutions` (Task 5); `canonicalTf`, `TimeframeError`, `isNativeTf`, `TF_LIMITS`, `TF_UNIT_SUFFIX` (Task 4).
- Produces:
  - `<CustomTimeframeForm onAdd={(resolution: string) => void} />`: validates, calls `onAdd(canonical)`.

- [ ] **Step 1: Write the failing component test** `frontend/src/components/CustomTimeframeForm.test.tsx`

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import CustomTimeframeForm from "./CustomTimeframeForm";

function fill(n: string, unit: string) {
  fireEvent.change(screen.getByLabelText("Custom timeframe size"), { target: { value: n } });
  fireEvent.change(screen.getByLabelText("Custom timeframe unit"), { target: { value: unit } });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
}

describe("CustomTimeframeForm", () => {
  it("adds a canonical timeframe", () => {
    const onAdd = vi.fn();
    render(<CustomTimeframeForm onAdd={onAdd} />);
    fill("120", "MINUTE");
    expect(onAdd).toHaveBeenCalledWith("HOUR_2");
  });
  it("shows the reason for an out-of-limit size and does not add", () => {
    const onAdd = vi.fn();
    render(<CustomTimeframeForm onAdd={onAdd} />);
    fill("25", "HOUR");
    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("hours must be between 1 and 24");
  });
  it("rejects a fractional size", () => {
    const onAdd = vi.fn();
    render(<CustomTimeframeForm onAdd={onAdd} />);
    fill("1.5", "HOUR");
    expect(onAdd).not.toHaveBeenCalled();
  });
});
```

(Check `grep -rn "@testing-library/react" frontend/src | head -1` for the repo's render import style and match it.)

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/components/CustomTimeframeForm.test.tsx`
Expected: FAIL, module not found.

- [ ] **Step 3: Confirm the persist functions from Task 5 Step 0 exist** (`grep -n "CustomResolutions" frontend/src/lib/persist/artifacts.ts`).

- [ ] **Step 4: Implement** `frontend/src/components/CustomTimeframeForm.tsx`

```tsx
import { useState } from "react";
import { canonicalTf, TimeframeError, TF_LIMITS, TF_UNIT_SUFFIX } from "../lib/timeframe";
import InfoTip from "./InfoTip";

type Unit = keyof typeof TF_LIMITS;
const UNITS: Unit[] = ["MINUTE", "HOUR", "DAY", "WEEK", "MONTH"];

export default function CustomTimeframeForm({ onAdd }: { onAdd: (resolution: string) => void }) {
  const [n, setN] = useState("");
  const [unit, setUnit] = useState<Unit>("MINUTE");
  const [error, setError] = useState<string | null>(null);

  function submit() {
    if (!/^\d+$/.test(n.trim())) {
      setError("Use a whole number");
      return;
    }
    try {
      onAdd(canonicalTf(`${unit}_${parseInt(n, 10)}`));
      setN("");
      setError(null);
    } catch (e) {
      setError(e instanceof TimeframeError ? e.message : String(e));
    }
  }

  return (
    <form
      className="custom-tf-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <input
        aria-label="Custom timeframe size"
        inputMode="numeric"
        placeholder={`1 to ${TF_LIMITS[unit]}`}
        value={n}
        onChange={(e) => setN(e.target.value)}
      />
      <select
        aria-label="Custom timeframe unit"
        value={unit}
        onChange={(e) => setUnit(e.target.value as Unit)}
      >
        {UNITS.map((u) => (
          <option key={u} value={u}>
            {TF_UNIT_SUFFIX[u]}
          </option>
        ))}
      </select>
      <button type="submit">Add</button>
      <InfoTip
        title="Custom timeframe"
        text={[
          "Bars reset daily at 00:00 UTC.",
          "The last bar of a day can be shorter.",
          "Minute sizes not divisible by 5 fold 1m bars: about 10 days of history.",
        ]}
      />
      {error && (
        <div className="custom-tf-error" role="alert">
          {error}
        </div>
      )}
    </form>
  );
}
```

- [ ] **Step 5: Run the component test**

Run: `cd frontend && npx vitest run src/components/CustomTimeframeForm.test.tsx`
Expected: PASS.

- [ ] **Step 6: Wire the dropdown** in `ToolbarControls.tsx`

- Import `periodGroups`, `periodByResolution` from `./lib/feed`; `loadCustomResolutions`, `saveCustomResolutions` from `./lib/persist`; `CustomTimeframeForm` from `./components/CustomTimeframeForm`.
- State next to `favResolutions`: `const [customResolutions, setCustomResolutions] = useState<string[]>(loadCustomResolutions);`
- Handlers:

```tsx
  function addCustomResolution(resolution: string) {
    const period = periodByResolution(resolution);
    if (!period) return;
    // A built-in (4H) or an already-saved one just gets selected, not re-added.
    if (!DEFAULT_RESOLUTIONS.has(resolution) && !ALL_PERIODS.some((p) => p.resolution === resolution)) {
      setCustomResolutions((prev) => {
        if (prev.includes(resolution)) return prev;
        const next = [...prev, resolution];
        saveCustomResolutions(next);
        return next;
      });
    }
    onPeriod(period);
    setIntervalOpen(false);
  }

  function removeCustomResolution(resolution: string) {
    setCustomResolutions((prev) => {
      const next = prev.filter((r) => r !== resolution);
      saveCustomResolutions(next);
      return next;
    });
    setFavResolutions((prev) => {
      if (!prev.includes(resolution)) return prev;
      const next = prev.filter((r) => r !== resolution);
      saveFavoriteResolutions(next);
      return next;
    });
  }
```

(import `ALL_PERIODS` from `./lib/feed` too.)
- Render `periodGroups(customResolutions).map(...)` instead of `PERIOD_GROUPS.map(...)`. Inside the row, after the star `Tooltip`, when `g.label === "Custom"` render:

```tsx
                      {g.label === "Custom" && (
                        <Tooltip content="Delete custom timeframe">
                          <button
                            className="tf-delete"
                            aria-label={`Delete ${p.label}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              removeCustomResolution(p.resolution);
                            }}
                          >
                            ✕
                          </button>
                        </Tooltip>
                      )}
```

- After the groups `map`, inside `.interval-dropdown`:

```tsx
            <div className="interval-group">
              <div className="interval-group-label">Add custom</div>
              <CustomTimeframeForm onAdd={addCustomResolution} />
            </div>
```

- Mousedown-outside already uses `intervalMenuRef.contains`, so typing in the form keeps the menu open.

CSS (next to `.interval-dropdown` rules): `.custom-tf-form { display: flex; gap: 6px; align-items: center; padding: 4px 8px; flex-wrap: wrap; } .custom-tf-form input { width: 64px; } .custom-tf-error { flex-basis: 100%; color: var(--danger, #e5534b); font-size: 12px; } .tf-delete { opacity: .6; } .tf-delete:hover { opacity: 1; }`. Use existing color tokens if the stylesheet defines them (`grep -n "\-\-danger\|--red" frontend/src/*.css | head`).

- [ ] **Step 7: Pickers**

- `BacktestSettingsModal.tsx` both `PERIOD_GROUPS.map(` → `periodGroups(loadCustomResolutions()).map(`; import both. The existing `!p.liveOnly` filter stays.
- `VisibilityTab.tsx:26`: build the label map from `periodGroups(loadCustomResolutions())`.
- `IndicatorSettings.tsx`: pass `loadCustomResolutions()` as the new second argument to `pinnableTimeframes(...)`.

- [ ] **Step 8: Run affected tests and typecheck**

Run: `cd frontend && npx vitest run src/components/CustomTimeframeForm.test.tsx src/Toolbar.demo.test.tsx src/Toolbar.studyModes.test.tsx src/lib/feed.test.ts`
Expected: PASS.
Run: `cd frontend && npx tsc -b 2>&1 | grep -E "ToolbarControls|CustomTimeframeForm|BacktestSettingsModal|VisibilityTab|IndicatorSettings|persist/artifacts" ; echo done`
Expected: no new errors in these files.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/components/CustomTimeframeForm.tsx frontend/src/components/CustomTimeframeForm.test.tsx frontend/src/ToolbarControls.tsx frontend/src/BacktestSettingsModal.tsx frontend/src/VisibilityTab.tsx frontend/src/IndicatorSettings.tsx <the css file>
git commit -m "feat(timeframes): saved custom timeframes in the interval dropdown and pickers"
```



---

### Task 7: End-to-end verification in the running app

**Files:** none (verification only; fix-forward commits if something breaks, each with its own failing test first).

- [ ] **Step 1:** Ask the user before starting any heavy process. With the backend (`:8000`) and frontend (`:5173`) running, use the chartkar MCP bridge: `ui_sessions` → `ui_set_title("custom timeframes check")` → `ui_invoke("market.select", {"epic": "US100"})`.
- [ ] **Step 2:** `ui_invoke("chart.timeframe.set", {"resolution": "6H"})`, then `ui_read_state("chart.state")`: consecutive candle opens are 6h apart within a day and every day starts at 00:00 UTC. `ui_screenshot` to confirm the chart renders.
- [ ] **Step 3:** Repeat with `"5H"` (expect a 4h 20:00 bar), `"90m"`, `"2D"`, `"4M"`. For each, scroll back once in the UI (or `chart.range.set` to an older range) and confirm no duplicate/overlapping bar at the seam.
- [ ] **Step 4:** Leave the chart on `6H` for a minute and confirm the forming bar updates (live fold).
- [ ] **Step 5:** Backtest: `ui_invoke("backtest.config.set", {"patch": {"range": {"resolution": "HOUR_6"}}})` (shape per `backtest.config.get`), `backtest.run`, `ui_wait` until `done`; metrics present, no error.
- [ ] **Step 5b:** Sweep with a `@6H` pin (`sweep.start` with one small axis): expect `done`. If a remote compute target is configured, run it there too; that path ships `htfCandles` and 503s on any missing key.
- [ ] **Step 5c:** Replay on 5H across 00:00 UTC in the UI: step through the 20:00 bar and confirm it closes at 00:00 (the next bar opens at 00:00, not 01:00) and the countdown pill on a live 5H chart counts to midnight on the day's last bar.
- [ ] **Step 6:** Rule pin: set an expression strategy entry like `close@6H > EMA(20)@6H` via the config and run once; expect `done`.
- [ ] **Step 7:** In the browser UI: open the interval dropdown, add `7` + `m`, confirm it appears under "Custom", star it (quick bar shows 7m), delete it (gone from both). Add `4` + `H` and confirm it just selects 4H without a Custom entry.
- [ ] **Step 8:** `curl -s "localhost:8000/api/candles?epic=US100&resolution=HOUR_99"` returns 422 with "hours must be between 1 and 24".
- [ ] **Step 9:** Report results to the user with screenshots of 6H and the dropdown.
