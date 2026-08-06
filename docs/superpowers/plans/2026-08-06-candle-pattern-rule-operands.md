# Candle Pattern Rule Operands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose all 24 candlestick patterns (plus `bullPattern`/`bearPattern` aggregates) as predicates usable in backtest rule expressions, e.g. a `bullEngulfing(candle)` row alongside an `RSI(14) < 30` row (the language has no `and`/`or`; rows are ANDed by the group).

**Architecture:** Pattern predicates ride the existing `Predicate(fn, candle_expr)` AST node — no new node type, no grammar change. All detection math lives in the indicator modules (`auto_trader/indicators/candle_patterns.py`, `frontend/src/lib/indicators/candlePatterns.ts`); the expression layer imports a three-name interface and holds no pattern logic. TS↔Python parity is enforced by a golden fixture.

**Tech Stack:** Python 3.14 (backend, pytest), TypeScript + React (frontend, vitest), CodeMirror/Lezer for the expression editor.

## Global Constraints

- **Detection logic never enters `strategy/expr/`.** The expr layer may import only `CANDLE_PATTERN_DEFS`, `PATTERN_FNS`, and `pattern_series` from `auto_trader.indicators.candle_patterns`. This mirrors `evaluate.py:9-12`, which imports EMA/RSI/ATR from `auto_trader.indicators.core`.
- **Predicate names are camelCase**, exactly the 26 in the spec's table. Frontend and backend name sets must be identical.
- **Detection ignores the chart indicator's `disabled` toggles.** Those are a display filter; a rule means the same thing regardless of what the user has drawn.
- **Epsilon is `0.05 × SMA14(true range)`**, falling back to `1e-4 × close` before 14 true ranges exist. Both stacks must use this identically or parity fails.
- Spec: `docs/superpowers/specs/2026-08-06-candle-pattern-rule-operands-design.md`
- Backend test command: `cd backend && .venv/bin/pytest`. Frontend: `cd frontend && npx vitest run`.
- Commit style: conventional commits, `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` footer.

---

### Task 1: Backend pattern detector

Port `detectAllPatterns` (`frontend/src/lib/indicators/candlePatterns.ts:138-252`) to Python, plus the interface the expr layer will call.

**Files:**
- Create: `backend/auto_trader/indicators/candle_patterns.py`
- Test: `backend/tests/test_candle_patterns.py`

**Interfaces:**
- Consumes: `auto_trader.core.models.Candle` (frozen dataclass with `time, open, high, low, close, volume`).
- Produces:
  - `CANDLE_PATTERN_DEFS: tuple[CandlePatternDef, ...]` — `CandlePatternDef` is a frozen dataclass with `id: str`, `fn: str`, `polarity: str` (`"bull" | "bear" | "neutral"`).
  - `PATTERN_FNS: dict[str, str]` — predicate name → pattern id, plus `"bullPattern"`/`"bearPattern"` → the sentinels `"@bull"`/`"@bear"`.
  - `detect_all_patterns(bars: Sequence[Candle]) -> list[frozenset[str]]`
  - `pattern_series(bars: Sequence[Candle], fn: str) -> list[float]` — 1.0/0.0 per bar.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_candle_patterns.py`:

```python
from datetime import UTC, datetime

from auto_trader.core.models import Candle
from auto_trader.indicators.candle_patterns import (
    CANDLE_PATTERN_DEFS,
    PATTERN_FNS,
    detect_all_patterns,
    pattern_series,
)

T0 = datetime(2026, 1, 1, tzinfo=UTC)


def c(o: float, h: float, lo: float, cl: float, i: int = 0) -> Candle:
    """A bar. `i` only advances `time`; detection never reads it."""
    return Candle(time=T0.replace(minute=i % 60), open=o, high=h, low=lo, close=cl)


def pad(n: int = 20) -> list[Candle]:
    """Warm-up bars so eps is the real ATR-based value, not the fallback."""
    return [c(100, 101, 99, 100, i) for i in range(n)]


def test_registry_has_24_defs_and_26_predicate_names():
    assert len(CANDLE_PATTERN_DEFS) == 24
    assert len(PATTERN_FNS) == 26
    assert PATTERN_FNS["bullEngulfing"] == "bull_engulfing"
    assert PATTERN_FNS["bullPattern"] == "@bull"
    assert PATTERN_FNS["bearPattern"] == "@bear"


def test_bull_engulfing_fires_on_engulfing_bar():
    bars = [*pad(), c(100, 101, 97, 98), c(97, 102, 96, 101)]
    assert "bull_engulfing" in detect_all_patterns(bars)[-1]


def test_bull_engulfing_does_not_fire_when_prev_bar_is_up():
    bars = [*pad(), c(98, 101, 97, 100), c(97, 102, 96, 101)]
    assert "bull_engulfing" not in detect_all_patterns(bars)[-1]


def test_every_matching_pattern_reports_not_just_the_first():
    """Unlike classify_candle, detection is not first-match: a flat bar is both
    a doji and an inside bar."""
    bars = [*pad(), c(100, 105, 95, 100), c(100, 101, 99, 100)]
    hits = detect_all_patterns(bars)[-1]
    assert "doji" in hits
    assert "inside" in hits


def test_pattern_series_is_one_and_zero_floats():
    bars = [*pad(), c(100, 101, 97, 98), c(97, 102, 96, 101)]
    series = pattern_series(bars, "bullEngulfing")
    assert len(series) == len(bars)
    assert series[-1] == 1.0
    assert series[-2] == 0.0


def test_bull_pattern_aggregate_ors_the_bull_polarity_group():
    bars = [*pad(), c(100, 101, 97, 98), c(97, 102, 96, 101)]
    assert pattern_series(bars, "bullPattern")[-1] == 1.0
    assert pattern_series(bars, "bearPattern")[-1] == 0.0


def test_doji_is_in_neither_aggregate():
    bars = [*pad(), c(100, 105, 95, 100)]
    assert "doji" in detect_all_patterns(bars)[-1]
    assert pattern_series(bars, "bullPattern")[-1] == 0.0
    assert pattern_series(bars, "bearPattern")[-1] == 0.0


def test_short_arrays_do_not_crash_and_do_not_over_report():
    bars = [c(100, 101, 99, 100, i) for i in range(3)]
    hits = detect_all_patterns(bars)
    assert len(hits) == 3
    for s in hits:
        assert "morning_star" not in s   # needs 4 bars
        assert "ladder_bottom" not in s  # needs 5 bars


def test_empty_input_returns_empty():
    assert detect_all_patterns([]) == []
    assert pattern_series([], "doji") == []


def test_unknown_fn_raises():
    import pytest
    with pytest.raises(KeyError):
        pattern_series(pad(), "notAPattern")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/pytest tests/test_candle_patterns.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'auto_trader.indicators.candle_patterns'`

- [ ] **Step 3: Write the implementation**

Create `backend/auto_trader/indicators/candle_patterns.py`. This is a direct transcription of the TS detector — keep the guard nesting and comparison order identical, because the golden fixture in Task 2 compares bar-for-bar.

```python
"""Candlestick pattern detection. The Python side of
frontend/src/lib/indicators/candlePatterns.ts — bar-for-bar identical, enforced
by tests/test_candle_patterns_parity.py against a golden fixture generated from
the TypeScript detector.

This module owns ALL pattern math. strategy/expr/ imports only CANDLE_PATTERN_DEFS,
PATTERN_FNS, and pattern_series from here (same arrangement as indicators/core.py
for EMA/RSI/ATR).
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from auto_trader.core.models import Candle


@dataclass(frozen=True, slots=True)
class CandlePatternDef:
    id: str
    fn: str            # camelCase predicate name used in rule expressions
    polarity: str      # "bull" | "bear" | "neutral"


# Order mirrors CANDLE_PATTERN_DEFS in candlePatterns.ts. The TS side keys
# operands by array index; here the id is the key, so order is documentation
# only — but keep it aligned to make diffs against the TS file readable.
CANDLE_PATTERN_DEFS: tuple[CandlePatternDef, ...] = (
    CandlePatternDef("bull_engulfing", "bullEngulfing", "bull"),
    CandlePatternDef("bear_engulfing", "bearEngulfing", "bear"),
    CandlePatternDef("pin_top", "pinTop", "bear"),
    CandlePatternDef("pin_bottom", "pinBottom", "bull"),
    CandlePatternDef("doji", "doji", "neutral"),
    CandlePatternDef("inside", "insideBar", "neutral"),
    CandlePatternDef("outside", "outsideBar", "neutral"),
    CandlePatternDef("bull_harami", "bullHarami", "bull"),
    CandlePatternDef("bear_harami", "bearHarami", "bear"),
    CandlePatternDef("piercing_line", "piercingLine", "bull"),
    CandlePatternDef("dark_cloud_cover", "darkCloudCover", "bear"),
    CandlePatternDef("morning_star", "morningStar", "bull"),
    CandlePatternDef("evening_star", "eveningStar", "bear"),
    CandlePatternDef("bull_belt_hold", "bullBeltHold", "bull"),
    CandlePatternDef("bear_belt_hold", "bearBeltHold", "bear"),
    CandlePatternDef("three_white_soldiers", "threeWhiteSoldiers", "bull"),
    CandlePatternDef("three_black_crows", "threeBlackCrows", "bear"),
    CandlePatternDef("three_stars_south", "threeStarsSouth", "bull"),
    CandlePatternDef("stick_sandwich", "stickSandwich", "bull"),
    CandlePatternDef("bull_meeting_line", "bullMeetingLine", "bull"),
    CandlePatternDef("bear_meeting_line", "bearMeetingLine", "bear"),
    CandlePatternDef("bull_kicking", "bullKicking", "bull"),
    CandlePatternDef("bear_kicking", "bearKicking", "bear"),
    CandlePatternDef("ladder_bottom", "ladderBottom", "bull"),
)

# Sentinels for the two aggregate predicates (not real pattern ids).
ANY_BULL = "@bull"
ANY_BEAR = "@bear"

PATTERN_FNS: dict[str, str] = {
    **{d.fn: d.id for d in CANDLE_PATTERN_DEFS},
    "bullPattern": ANY_BULL,
    "bearPattern": ANY_BEAR,
}

_BULL_IDS = frozenset(d.id for d in CANDLE_PATTERN_DEFS if d.polarity == "bull")
_BEAR_IDS = frozenset(d.id for d in CANDLE_PATTERN_DEFS if d.polarity == "bear")


def eps_series(bars: Sequence[Candle]) -> list[float]:
    """eps[i] = 0.05 * SMA14 of true range up to and including bar i. Before 14
    true ranges exist, falls back to 1e-4 * close (index data has no fixed tick).
    """
    eps: list[float] = []
    trs: list[float] = []
    total = 0.0
    for i, b in enumerate(bars):
        pc = bars[i - 1].close if i > 0 else b.close
        tr = max(b.high - b.low, abs(b.high - pc), abs(b.low - pc))
        trs.append(tr)
        total += tr
        if len(trs) > 14:
            total -= trs[-15]
        eps.append(0.05 * (total / 14) if len(trs) >= 14 else 1e-4 * b.close)
    return eps


def _eq(a: float, b: float, e: float) -> bool:
    return abs(a - b) <= e


def detect_all_patterns(bars: Sequence[Candle]) -> list[frozenset[str]]:
    """hits[i] = every pattern id matching at bar i, with no enable filtering.
    Unlike engine.context_features.classify_candle (first-match, single label),
    every matching pattern is reported — rule operands are independent.
    """
    n = len(bars)
    eps = eps_series(bars)
    out: list[frozenset[str]] = []

    for i in range(n):
        s: set[str] = set()
        e = eps[i]

        # Pine-style back-indexers: k=0 is bar i, k=1 is i-1. Each block below
        # is guarded by the lookback it needs.
        def o(k: int, _i: int = i) -> float:
            return bars[_i - k].open

        def h(k: int, _i: int = i) -> float:
            return bars[_i - k].high

        def lo(k: int, _i: int = i) -> float:
            return bars[_i - k].low

        def cl(k: int, _i: int = i) -> float:
            return bars[_i - k].close

        bar = bars[i]
        body = abs(bar.close - bar.open)
        rng = bar.high - bar.low

        if i >= 1:
            prev = bars[i - 1]
            p_hi = max(prev.open, prev.close)
            p_lo = min(prev.open, prev.close)
            b_hi = max(bar.open, bar.close)
            b_lo = min(bar.open, bar.close)
            prev_down = prev.close < prev.open
            prev_up = prev.close > prev.open

            if bar.close > bar.open and prev_down and b_lo <= p_lo and b_hi >= p_hi:
                s.add("bull_engulfing")
            if bar.close < bar.open and prev_up and b_lo <= p_lo and b_hi >= p_hi:
                s.add("bear_engulfing")

            # pin_top / pin_bottom keep the TS guard nesting (inside `i >= 1`).
            if rng > 0:
                upper = bar.high - max(bar.open, bar.close)
                lower = min(bar.open, bar.close) - bar.low
                if upper >= 2 * body and min(bar.open, bar.close) <= bar.low + rng / 3:
                    s.add("pin_top")
                if lower >= 2 * body and max(bar.open, bar.close) >= bar.high - rng / 3:
                    s.add("pin_bottom")

            if bar.high < prev.high and bar.low > prev.low:
                s.add("inside")
            if bar.high > prev.high and bar.low < prev.low:
                s.add("outside")

        # doji sits outside the prev block, matching the TS source.
        if rng > 0 and body <= 0.1 * rng:
            s.add("doji")

        if i >= 2:
            if (o(1) > cl(1) and cl(1) < cl(2) and o(0) > cl(1) and o(0) < o(1)
                    and cl(0) > cl(1) and cl(0) < o(1) and h(0) < h(1) and lo(0) > lo(1)
                    and cl(0) >= o(0)):
                s.add("bull_harami")
            if (o(1) < cl(1) and cl(1) > cl(2) and o(0) < cl(1) and o(0) > o(1)
                    and cl(0) < cl(1) and cl(0) > o(1) and h(0) < h(1) and lo(0) > lo(1)
                    and cl(0) <= o(0)):
                s.add("bear_harami")
            if cl(2) > cl(1) and o(0) < lo(1) and cl(0) > (o(1) + cl(1)) / 2 and cl(0) < o(1):
                s.add("piercing_line")
            if cl(2) < cl(1) and o(0) > h(1) and cl(0) < (o(1) + cl(1)) / 2 and cl(0) > o(1):
                s.add("dark_cloud_cover")
            if (o(2) > cl(2) and o(1) > cl(2) and o(1) < cl(1) and o(0) > cl(1)
                    and o(0) > cl(0) and _eq(cl(0), cl(2), e)):
                s.add("stick_sandwich")
            if (o(2) > cl(2) and o(1) > cl(1) and _eq(cl(1), cl(0), e)
                    and o(0) < cl(0) and o(1) >= h(0)):
                s.add("bull_meeting_line")
            if (o(2) < cl(2) and o(1) < cl(1) and _eq(cl(1), cl(0), e)
                    and o(0) > cl(0) and o(1) <= lo(0)):
                s.add("bear_meeting_line")

        if i >= 1:
            if (cl(1) < o(1) and lo(1) > o(0) and cl(1) > o(0)
                    and _eq(o(0), lo(0), e) and cl(0) > o(0)):
                s.add("bull_belt_hold")
            if (cl(1) > o(1) and h(1) < o(0) and cl(1) < o(0)
                    and _eq(o(0), h(0), e) and cl(0) < o(0)):
                s.add("bear_belt_hold")
            if (o(1) > cl(1) and _eq(o(1), h(1), e) and _eq(cl(1), lo(1), e)
                    and o(0) > o(1) and _eq(o(0), lo(0), e) and _eq(cl(0), h(0), e)
                    and cl(0) - o(0) > o(1) - cl(1)):
                s.add("bull_kicking")
            if (o(1) < cl(1) and _eq(o(1), lo(1), e) and _eq(cl(1), h(1), e)
                    and o(0) < o(1) and _eq(o(0), h(0), e) and _eq(cl(0), lo(0), e)
                    and o(0) - cl(0) > cl(1) - o(1)):
                s.add("bear_kicking")

        if i >= 3:
            if (cl(3) > cl(2) and cl(2) < o(2) and o(1) < cl(2) and cl(1) < cl(2)
                    and o(0) > o(1) and o(0) > cl(1) and cl(0) > cl(2)
                    and o(2) - cl(2) > cl(0) - o(0)):
                s.add("morning_star")
            if (cl(3) < cl(2) and cl(2) > o(2) and o(1) > cl(2) and cl(1) > cl(2)
                    and o(0) < o(1) and o(0) < cl(1) and cl(0) < cl(2)
                    and cl(2) - o(2) > o(0) - cl(0)):
                s.add("evening_star")
            if (cl(3) < o(3) and o(2) < cl(3) and cl(2) > o(2) and o(1) > o(2)
                    and o(1) < cl(2) and cl(1) > o(1) and o(0) > o(1) and o(0) < cl(1)
                    and cl(0) > o(0) and h(1) > h(2) and h(0) > h(1)):
                s.add("three_white_soldiers")
            if (cl(3) > o(3) and o(2) > cl(3) and cl(2) < o(2) and o(1) < o(2)
                    and o(1) > cl(2) and cl(1) < o(1) and o(0) < o(1) and o(0) > cl(1)
                    and cl(0) < o(0) and lo(1) < lo(2) and lo(0) < lo(1)):
                s.add("three_black_crows")
            if (o(3) > cl(3) and o(2) > cl(2) and _eq(o(2), h(2), e) and o(1) > cl(1)
                    and o(1) < o(2) and o(1) > cl(2) and lo(1) > lo(2)
                    and _eq(o(1), h(1), e) and o(0) > cl(0) and o(0) < o(1)
                    and o(0) > cl(1) and _eq(o(0), h(0), e) and _eq(cl(0), lo(0), e)
                    and cl(0) >= lo(1)):
                s.add("three_stars_south")

        if i >= 4:
            if (o(4) > cl(4) and o(3) > cl(3) and o(3) < o(4) and o(2) > cl(2)
                    and o(2) < o(3) and o(1) > cl(1) and o(1) < o(2) and o(0) < cl(0)
                    and o(0) > o(1) and lo(4) > lo(3) and lo(3) > lo(2) and lo(2) > lo(1)):
                s.add("ladder_bottom")

        out.append(frozenset(s))

    return out


def pattern_series(bars: Sequence[Candle], fn: str) -> list[float]:
    """1.0 where `fn` matches, else 0.0. Float rather than bool so the result
    feeds indicators.mtf.align_htf_to_base unchanged for @tf-pinned rules.

    Raises KeyError for an unknown predicate name (validation should have caught
    it long before evaluation).

    Deliberately NOT memoized, unlike the TS side's detectCache WeakMap: a
    strategy with several pattern rows re-runs the 24-condition sweep once per
    row. evaluate.py caches per condition node where it matters (the per-bar
    path). Revisit if profiling shows the sweep is hot.
    """
    target = PATTERN_FNS[fn]
    hits = detect_all_patterns(bars)
    if target == ANY_BULL:
        return [1.0 if s & _BULL_IDS else 0.0 for s in hits]
    if target == ANY_BEAR:
        return [1.0 if s & _BEAR_IDS else 0.0 for s in hits]
    return [1.0 if target in s else 0.0 for s in hits]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && .venv/bin/pytest tests/test_candle_patterns.py -v`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/indicators/candle_patterns.py backend/tests/test_candle_patterns.py
git commit -m "feat(indicators): Python candlestick pattern detector"
```

---

### Task 2: Golden parity fixture

Prove the Task 1 port matches the TypeScript detector bar-for-bar. This is the task that catches transcription errors in the 24 conditions.

**Files:**
- Create: `frontend/src/lib/indicators/candlePatternsGolden.test.ts`
- Create: `backend/tests/fixtures/candle_patterns_golden.json` (generated, committed)
- Create: `backend/tests/test_candle_patterns_parity.py`

**Interfaces:**
- Consumes: `detectAllPatterns` (TS), `detect_all_patterns` (Python, Task 1).
- Produces: the fixture, shape `{"bars": [{"open","high","low","close"}...], "hits": [["bull_engulfing", ...], ...]}` — `hits[i]` is the sorted list of ids matching at bar `i`.

Model the generator on `frontend/src/lib/indicatorParityGolden.test.ts`, which does the same thing for EMA/RSI/ATR/VWAP.

- [ ] **Step 1: Write the fixture generator**

Create `frontend/src/lib/indicators/candlePatternsGolden.test.ts`:

```ts
// Golden-master generator for the Python pattern-parity suite. Runs the SAME TS
// detector the chart uses over a hand-built candle set that fires every one of
// the 24 patterns, and writes backend/tests/fixtures/candle_patterns_golden.json.
// backend/tests/test_candle_patterns_parity.py must reproduce every bar exactly.
// Re-run this test to regenerate the fixture after changing the TS detector.
/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { CANDLE_PATTERN_DEFS, detectAllPatterns, type PatternBar } from "./candlePatterns";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../../../../backend/tests/fixtures/candle_patterns_golden.json");

const B = (open: number, high: number, low: number, close: number): PatternBar =>
  ({ open, high, low, close });

// 20 flat-ish bars so eps is the real ATR-based value rather than the
// 1e-4*close fallback, then one construction per pattern. Bars are appended in
// runs; a run's trailing bar is the one meant to fire.
const WARMUP: PatternBar[] = Array.from({ length: 20 }, (_, i) =>
  B(100, 101 + (i % 3) * 0.1, 99 - (i % 2) * 0.1, 100 + (i % 5) * 0.05),
);

// Each entry is a run of bars whose LAST bar should fire `expect`. They are
// concatenated into one series; cross-run interactions are fine because the
// assertion below only requires each pattern to fire somewhere.
const RUNS: PatternBar[][] = [
  [B(100, 101, 97, 98), B(97, 102, 96, 101)],                            // bull_engulfing
  [B(98, 101, 97, 100), B(101, 102, 96, 97)],                            // bear_engulfing
  [B(100, 101, 99, 100), B(99, 110, 98.5, 99.2)],                        // pin_top
  [B(100, 101, 99, 100), B(100.5, 101, 90, 100.8)],                      // pin_bottom
  [B(100, 101, 99, 100), B(100, 105, 95, 100)],                          // doji, inside handled below
  [B(100, 110, 90, 100), B(100, 105, 95, 100)],                          // inside
  [B(100, 102, 98, 100), B(99, 106, 94, 103)],                           // outside
  [B(100, 101, 99, 100), B(110, 111, 99, 100), B(101, 105, 100.5, 104)], // bull_harami
  [B(100, 101, 99, 100), B(99, 111, 98, 110), B(104, 105, 100.5, 101)],  // bear_harami
  [B(100, 101, 99, 101), B(110, 111, 99, 100), B(98, 106, 97, 106)],     // piercing_line
  [B(100, 101, 99, 99), B(99, 111, 98, 110), B(112, 113, 103, 104)],     // dark_cloud_cover
  [B(100, 101, 99, 100), B(110, 111, 99, 100), B(98, 99, 96, 97),
   B(99, 106, 98, 105)],                                                 // morning_star
  [B(100, 101, 99, 99), B(99, 111, 98, 110), B(112, 114, 111, 113),
   B(111, 112, 104, 105)],                                               // evening_star
  [B(105, 106, 100, 101), B(99, 106, 99, 105)],                          // bull_belt_hold
  [B(100, 101, 99, 101), B(110, 110, 104, 105)],                         // bear_belt_hold
  [B(105, 106, 100, 101), B(99, 104, 98, 103), B(101, 107, 100, 106),
   B(104, 110, 103, 109)],                                               // three_white_soldiers
  [B(100, 106, 99, 105), B(107, 108, 102, 103), B(105, 106, 98, 99),
   B(102, 103, 94, 95)],                                                 // three_black_crows
  [B(110, 111, 100, 101), B(108, 108, 96, 99), B(105, 105, 97, 100),
   B(103, 103, 99, 99)],                                                 // three_stars_south
  [B(105, 106, 99, 100), B(101, 106, 100, 105), B(106, 107, 99, 100)],   // stick_sandwich
  [B(105, 106, 99, 100), B(104, 105, 98, 99), B(97, 99.2, 96, 99)],      // bull_meeting_line
  [B(100, 106, 99, 105), B(101, 107, 100, 106), B(109, 110, 105.8, 106)],// bear_meeting_line
  [B(105, 105, 100, 100), B(106, 112, 106, 112)],                        // bull_kicking
  [B(100, 105, 100, 105), B(99, 99, 92, 92)],                            // bear_kicking
  [B(110, 111, 105, 106), B(108, 109, 103, 104), B(106, 107, 101, 102),
   B(104, 105, 99, 100), B(101, 106, 100, 105)],                         // ladder_bottom
];

const BARS: PatternBar[] = [...WARMUP, ...RUNS.flat()];

describe("candle pattern golden fixture", () => {
  const hits = detectAllPatterns(BARS);

  it("fires every one of the 24 patterns at least once (non-vacuous)", () => {
    const fired = new Set<string>();
    for (const s of hits) for (const id of s) fired.add(id);
    const missing = CANDLE_PATTERN_DEFS.map((d) => d.id).filter((id) => !fired.has(id));
    expect(missing).toEqual([]);
  });

  it("writes the fixture the Python parity suite reads", () => {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(
      OUT,
      JSON.stringify(
        {
          bars: BARS,
          hits: hits.map((s) => [...s].sort()),
        },
        null,
        2,
      ) + "\n",
    );
    expect(hits.length).toBe(BARS.length);
  });
});
```

- [ ] **Step 2: Run the generator and check the non-vacuous assertion**

Run: `cd frontend && npx vitest run src/lib/indicators/candlePatternsGolden.test.ts`

Expected on the first run: likely FAIL on "fires every one of the 24 patterns" with a `missing` list. That is the point of the assertion — the hand-built bars above are a starting point, not verified truth.

For each id in `missing`, open the corresponding condition in `candlePatterns.ts:173-238` and adjust that run's bars until it satisfies every clause. Work one pattern at a time and re-run. Note that some conditions use `eq(a, b, e)` where `e ≈ 0.05 × ATR14` — for the warm-up above that is roughly `0.1`, so "equal" values must be within about a tenth of a point.

Two things keep this loop bounded — do both before starting to tune:

- **Isolate the runs.** They are concatenated, so a run's last bars are also `[1]`/`[2]`/`[3]` for the *next* run, and fixing one construction can silently break its neighbor. Separate every run with 3 neutral filler bars so each is independent:

  ```ts
  const FILLER: PatternBar[] = [B(100, 101, 99, 100), B(100, 101, 99, 100), B(100, 101, 99, 100)];
  const BARS: PatternBar[] = [...WARMUP, ...RUNS.flatMap((r) => [...FILLER, ...r])];
  ```

- **Solve, don't guess, for the long conditions.** `three_stars_south` and `ladder_bottom` have ~13 clauses each; guess-and-check will not converge. Read the condition and pick values clause by clause (e.g. `ladder_bottom` needs four successive down bars with descending opens and ascending lows, then an up bar opening above the fourth's open). Reserve trial-and-error for the 2-3 bar patterns.

Do not weaken the assertion to make it pass. A pattern that never fires in the fixture is a pattern with zero parity coverage.

- [ ] **Step 3: Write the Python parity test**

Create `backend/tests/test_candle_patterns_parity.py`:

```python
"""Bar-for-bar parity against the TypeScript detector.

The fixture is generated by
frontend/src/lib/indicators/candlePatternsGolden.test.ts — re-run that test to
regenerate it after changing the TS detector, then make this suite pass again.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

from auto_trader.core.models import Candle
from auto_trader.indicators.candle_patterns import CANDLE_PATTERN_DEFS, detect_all_patterns

FIXTURE = Path(__file__).parent / "fixtures" / "candle_patterns_golden.json"
T0 = datetime(2026, 1, 1, tzinfo=UTC)


def _load() -> tuple[list[Candle], list[list[str]]]:
    data = json.loads(FIXTURE.read_text())
    bars = [
        Candle(
            time=T0 + timedelta(minutes=i),
            open=b["open"], high=b["high"], low=b["low"], close=b["close"],
        )
        for i, b in enumerate(data["bars"])
    ]
    return bars, data["hits"]


def test_fixture_is_non_vacuous():
    """Guards against a fixture that silently stops exercising patterns."""
    _, expected = _load()
    fired = {pid for row in expected for pid in row}
    missing = sorted({d.id for d in CANDLE_PATTERN_DEFS} - fired)
    assert missing == [], f"fixture never fires: {missing}"


def test_every_bar_matches_the_typescript_detector():
    bars, expected = _load()
    actual = [sorted(s) for s in detect_all_patterns(bars)]
    assert len(actual) == len(expected)
    for i, (got, want) in enumerate(zip(actual, expected, strict=True)):
        assert got == want, f"bar {i}: python={got} typescript={want}"
```

- [ ] **Step 4: Run the parity test**

Run: `cd backend && .venv/bin/pytest tests/test_candle_patterns_parity.py -v`
Expected: PASS. A failure names the exact bar and the id sets that differ — fix the Python condition to match the TS source (the TS side is the reference; do not edit the TS detector to match Python).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/indicators/candlePatternsGolden.test.ts \
        backend/tests/fixtures/candle_patterns_golden.json \
        backend/tests/test_candle_patterns_parity.py
git commit -m "test(indicators): golden TS/Python candle pattern parity fixture"
```

---

### Task 3: Frontend indicator interface

Add the two exports the expression catalog will consume, so the name set cannot drift from the detector.

**Files:**
- Modify: `frontend/src/lib/indicators/candlePatterns.ts`
- Test: `frontend/src/lib/indicators/candlePatterns.test.ts`

**Interfaces:**
- Consumes: `CANDLE_PATTERN_DEFS`, `patternLineSeries`, `ANY_BULL_LINE`, `ANY_BEAR_LINE` (all already exported).
- Produces:
  - `PATTERN_PREDICATE_FNS: Record<string, number>` — predicate name → canonical line index (0-23 for individual patterns, 24 / 25 for the aggregates).
  - `patternSeriesByFn(bars: readonly PatternBar[], fn: string): number[]`

Note: `CandlePatternDef` has no `fn` field today. Add one — it is the single source for the predicate name, mirroring the backend def.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/lib/indicators/candlePatterns.test.ts`:

```ts
describe("PATTERN_PREDICATE_FNS: the rule-operand interface", () => {
  it("names all 24 patterns plus the two aggregates", () => {
    expect(Object.keys(PATTERN_PREDICATE_FNS).length).toBe(26);
    expect(PATTERN_PREDICATE_FNS.bullEngulfing).toBe(0);
    expect(PATTERN_PREDICATE_FNS.bullPattern).toBe(ANY_BULL_LINE);
    expect(PATTERN_PREDICATE_FNS.bearPattern).toBe(ANY_BEAR_LINE);
  });

  it("maps every def's fn to that def's canonical index", () => {
    CANDLE_PATTERN_DEFS.forEach((def, i) => {
      expect(PATTERN_PREDICATE_FNS[def.fn]).toBe(i);
    });
  });

  it("patternSeriesByFn matches patternLineSeries for the same line", () => {
    const bars = withPad(
      B(100, 101, 97, 98), B(97, 102, 96, 101),
    );
    expect(patternSeriesByFn(bars, "bullEngulfing")).toEqual(patternLineSeries(bars, 0));
    expect(patternSeriesByFn(bars, "bullPattern")).toEqual(
      patternLineSeries(bars, ANY_BULL_LINE),
    );
  });

  it("returns an all-zero series for an unknown name rather than throwing", () => {
    const bars = withPad(B(100, 101, 97, 98));
    expect(patternSeriesByFn(bars, "notAPattern").every((v) => v === 0)).toBe(true);
  });
});
```

Add `PATTERN_PREDICATE_FNS` and `patternSeriesByFn` to the file's existing import block from `./candlePatterns`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/indicators/candlePatterns.test.ts`
Expected: FAIL — `PATTERN_PREDICATE_FNS is not defined`.

- [ ] **Step 3: Implement**

In `frontend/src/lib/indicators/candlePatterns.ts`, add `fn` to the interface:

```ts
export interface CandlePatternDef {
  id: string;
  label: string;
  short: string;
  fn: string; // camelCase predicate name used in rule expressions
  polarity: PatternPolarity;
  toggle: string;
}
```

Add the `fn` value to each of the 24 entries in `CANDLE_PATTERN_DEFS`, per the spec's table (`bull_engulfing` → `bullEngulfing`, `inside` → `insideBar`, `outside` → `outsideBar`, and so on).

Then, after `defaultMembers`, add:

```ts
// --- Rule-operand interface -------------------------------------------------
// The expression catalog builds its predicate entries from this map, so the
// names it offers can never drift from the detector. Detection logic stays in
// this module; lib/expr/ only calls through these two exports.

export const PATTERN_PREDICATE_FNS: Record<string, number> = (() => {
  const out: Record<string, number> = {};
  CANDLE_PATTERN_DEFS.forEach((def, i) => {
    out[def.fn] = i;
  });
  out.bullPattern = ANY_BULL_LINE;
  out.bearPattern = ANY_BEAR_LINE;
  return out;
})();

/** 0/1 series for a predicate name; all-zero for an unknown name. */
export function patternSeriesByFn(bars: readonly PatternBar[], fn: string): number[] {
  const line = PATTERN_PREDICATE_FNS[fn];
  if (line === undefined) return bars.map(() => 0);
  return patternLineSeries(bars, line);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/indicators/candlePatterns.test.ts`
Expected: PASS — the existing suite plus 4 new tests. The `registry shape` test asserting 24 defs must still pass.

- [ ] **Step 5: Regenerate the golden fixture and re-check parity**

Adding `fn` does not change detection, but re-run both to confirm:

```bash
cd frontend && npx vitest run src/lib/indicators/candlePatternsGolden.test.ts
cd ../backend && .venv/bin/pytest tests/test_candle_patterns_parity.py
```
Expected: both PASS, fixture unchanged (`git diff --stat` shows no fixture change).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/indicators/candlePatterns.ts frontend/src/lib/indicators/candlePatterns.test.ts
git commit -m "feat(indicators): expose pattern predicate names as a rule-operand interface"
```

---

### Task 4: Frontend catalog, parser, and editor surface

Make the editor accept, complete, highlight, and warm-up the 26 names.

**Files:**
- Modify: `frontend/src/lib/expr/catalog.ts`
- Modify: `frontend/src/lib/expr/parser.ts` (`warmupOf`)
- Modify: `frontend/src/lib/expr/complete.ts:65-68`
- Modify: `frontend/src/components/RulePalette.tsx:36-38`
- Test: `frontend/src/lib/expr/parser.test.ts`

**Interfaces:**
- Consumes: `PATTERN_PREDICATE_FNS` (Task 3).
- Produces: `PATTERNS: CatalogEntry[]` and an extended `PREDICATE_FNS` from `catalog.ts`.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/lib/expr/parser.test.ts`. Extend its imports first — `warmupOf` from `./parser`, `PATTERNS` and `PREDICATE_FNS` from `./catalog`, and `PATTERN_PREDICATE_FNS` from `../indicators/candlePatterns`:

```ts
describe("candle pattern predicates", () => {
  it("parses every catalog pattern name as a predicate row", () => {
    for (const name of Object.keys(PATTERN_PREDICATE_FNS)) {
      expect(() => parse(`${name}(candle)`)).not.toThrow();
    }
  });

  it("accepts an offset and a timeframe pin on the candle base", () => {
    expect(() => parse("bullEngulfing(candle[-1])")).not.toThrow();
    expect(() => parse("bearPattern(candle@4H)")).not.toThrow();
  });

  it("rejects a non-candle base", () => {
    expect(() => parse("doji(candle.close)")).toThrow(/takes a candle/);
  });

  it("rejects an unknown pattern name", () => {
    expect(() => parse("notAPattern(candle)")).toThrow();
  });

  it("wraps in count() like any other predicate", () => {
    expect(() => parse("count(doji(candle), 5) >= 2")).not.toThrow();
  });

  it("warms up 18 bars, plus the offset", () => {
    expect(warmupOf(parse("bullEngulfing(candle)"))).toBe(18);
    expect(warmupOf(parse("bullEngulfing(candle[-3])"))).toBe(21);
  });

  it("leaves bullish/bearish warm-up at zero", () => {
    expect(warmupOf(parse("bullish(candle)"))).toBe(0);
  });

  it("catalog entries and the detector's name map agree", () => {
    expect(PATTERNS.map((e) => e.name).sort()).toEqual(
      Object.keys(PATTERN_PREDICATE_FNS).sort(),
    );
    for (const name of Object.keys(PATTERN_PREDICATE_FNS)) {
      expect((PREDICATE_FNS as readonly string[]).includes(name)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/expr/parser.test.ts`
Expected: FAIL — `PATTERNS is not exported` / `bullEngulfing` rejected as an unknown function.

- [ ] **Step 3: Implement the catalog**

In `frontend/src/lib/expr/catalog.ts`, import the map and build the group. Add a comment noting the new import direction (this file was previously dependency-free):

```ts
// Pattern predicates are DERIVED from the detector's name map rather than
// listed here, so the editor can never offer a name the detector doesn't know.
// This is the file's only import; candlePatterns.ts pulls klinecharts as
// TYPE-ONLY, so the catalog stays runtime-dependency-free.
import { PATTERN_PREDICATE_FNS } from "../indicators/candlePatterns";

const PATTERN_DETAIL: Record<string, string> = {
  bullPattern: "Any bullish candlestick pattern",
  bearPattern: "Any bearish candlestick pattern",
};

export const PATTERNS: CatalogEntry[] = Object.keys(PATTERN_PREDICATE_FNS).map((name) => ({
  name,
  insert: `${name}(candle)`,
  signature: `${name}(candle)`,
  detail: PATTERN_DETAIL[name] ?? `${name} candlestick pattern`,
}));

export const PREDICATE_FNS = [
  "bullish",
  "bearish",
  ...Object.keys(PATTERN_PREDICATE_FNS),
] as const;
```

Replace the existing `export const PREDICATE_FNS = ["bullish", "bearish"] as const;` with the above.

Add the pattern warm-up constant, used by both `parser.ts` and mirrored in `warmup.py`:

```ts
// 14 bars for the epsilon series (0.05 * SMA14 of true range) + 4 for the
// deepest lookback (ladderBottom needs i >= 4). Mirrored by the backend's
// warmup.py PATTERN_WARMUP.
export const PATTERN_WARMUP = 18;

export const PATTERN_FN_SET: ReadonlySet<string> = new Set(Object.keys(PATTERN_PREDICATE_FNS));
```

- [ ] **Step 4: Implement the parser warm-up**

In `frontend/src/lib/expr/parser.ts`, import `PATTERN_FN_SET` and `PATTERN_WARMUP` from `./catalog`, then in `warmupOf`'s `Predicate` branch return the pattern warm-up on top of the base:

```ts
case "Predicate":
  return (
    (PATTERN_FN_SET.has(node.fn) ? PATTERN_WARMUP : 0) + warmupOf(node.base, resolution)
  );
```

(Locate the existing `case "Predicate":` in `warmupOf` and replace its body; `checkPredicate` needs no change — it already validates the candle base, and `PREDICATE_SET` at `parser.ts:70` picks up the new names automatically.)

- [ ] **Step 5: Add the editor surface**

In `frontend/src/lib/expr/complete.ts`, add `PATTERNS` to the catalog import at line 17-25 and one line to the candidate list near line 68:

```ts
  ...PATTERNS.map((e) => fnCandidate(e, "cross")),
```

In `frontend/src/components/RulePalette.tsx`, add `PATTERNS` to the catalog import at line 9 and one entry to the `GROUPS` tuple list at lines 36-38:

```ts
    ["Patterns", PATTERNS],
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd frontend && npx vitest run src/lib/expr/ src/lib/indicators/
npx tsc --noEmit -p tsconfig.app.json 2>&1 | grep -E "expr/|candlePatterns|RulePalette"
```
Expected: all vitest tests PASS; the tsc grep prints nothing (the repo has pre-existing errors in unrelated files — only new ones in these paths matter).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/expr/catalog.ts frontend/src/lib/expr/parser.ts \
        frontend/src/lib/expr/complete.ts frontend/src/components/RulePalette.tsx \
        frontend/src/lib/expr/parser.test.ts
git commit -m "feat(expr): candle pattern predicates in the frontend catalog and parser"
```

---

### Task 5: Backend name wiring and validation

Teach the backend expression layer the 26 names — without teaching it what a pattern is.

**Files:**
- Modify: `backend/auto_trader/strategy/expr/registry.py`
- Modify: `backend/auto_trader/strategy/expr/nodes.py:130`
- Test: `backend/tests/test_expr_validate.py` (append; match the module's existing import and helper style)

**Interfaces:**
- Consumes: `PATTERN_FNS` (Task 1).
- Produces: `registry.PATTERN_FN_NAMES: tuple[str, ...]` and an extended `nodes.PREDICATE_FNS`.

- [ ] **Step 1: Write the failing test**

```python
def test_pattern_predicate_parses_and_validates():
    row = parse("bullEngulfing(candle)")
    validate(row, is_exit=False)  # must not raise


def test_pattern_predicate_accepts_offset_and_tf_pin():
    validate(parse("bullEngulfing(candle[-1])"), is_exit=False)
    validate(parse("bearPattern(candle@4H)"), is_exit=False)


def test_pattern_predicate_rejects_a_non_candle_base():
    with pytest.raises(ExprError) as exc:
        validate(parse("doji(candle.close)"), is_exit=False)
    assert exc.value.code == "bad_predicate_arg"


def test_all_26_names_are_legal_predicates():
    from auto_trader.indicators.candle_patterns import PATTERN_FNS
    from auto_trader.strategy.expr.nodes import PREDICATE_FNS
    for name in PATTERN_FNS:
        assert name in PREDICATE_FNS
    assert len(PREDICATE_FNS) == 28  # bullish, bearish, + 26
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/pytest tests/test_expr_validate.py -v -k pattern`
Expected: FAIL — the parser rejects `bullEngulfing` as an unknown function.

- [ ] **Step 3: Implement**

In `backend/auto_trader/strategy/expr/registry.py`, append:

```python
from auto_trader.indicators.candle_patterns import PATTERN_FNS as _PATTERN_FNS

# The expr layer knows pattern NAMES only; all detection lives in
# auto_trader.indicators.candle_patterns (same arrangement as INDICATORS above,
# whose math lives in indicators/core.py).
PATTERN_FN_NAMES: tuple[str, ...] = tuple(_PATTERN_FNS)
```

In `backend/auto_trader/strategy/expr/nodes.py`, replace line 130:

```python
from auto_trader.strategy.expr.registry import PATTERN_FN_NAMES

PREDICATE_FNS = ("bullish", "bearish", *PATTERN_FN_NAMES)
```

If that import creates a cycle (`registry` importing `nodes`), instead import `PATTERN_FNS` directly from `auto_trader.indicators.candle_patterns` in `nodes.py` — the indicator module imports nothing from `strategy/`, so it cannot cycle. Verify with `cd backend && .venv/bin/python -c "import auto_trader.strategy.expr.nodes"`.

Also update the `Predicate.fn` docstring comment at `nodes.py:101` from `# "bullish" | "bearish"` to `# "bullish" | "bearish" | a candle pattern name`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && .venv/bin/pytest tests/ -v -k "expr or pattern"`
Expected: PASS, including the pre-existing expr suites.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/strategy/expr/registry.py backend/auto_trader/strategy/expr/nodes.py backend/tests/
git commit -m "feat(expr): accept candle pattern names as predicates"
```

---

### Task 6: Backend evaluation

Make pattern predicates actually produce signals. This is the task with the real design content.

**Files:**
- Modify: `backend/auto_trader/strategy/expr/evaluate.py`
- Test: `backend/tests/test_expr_evaluate.py` (append to the repo's existing evaluator test module)

**Interfaces:**
- Consumes: `pattern_series` (Task 1), `PATTERN_FNS` (Task 1), `align_htf_to_base` (`indicators/mtf.py:13`).
- Produces: no new public names — three internal branches.

**Key insight:** `series_of` already recurses through `Tf` (`evaluate.py:147-160`) and `Offset` (`:144-146`). A pattern predicate wraps those *inside* itself — `Predicate("bullEngulfing", Tf(Candle, "4H"))` — so they are unreachable by that recursion. Hoisting the postfix wrappers outward turns the problem into one the existing machinery already solves:

```
Predicate(fn, Tf(Candle, "4H"))     ->  Tf(Predicate(fn, Candle), "4H")
Predicate(fn, Offset(Candle, 1))    ->  Offset(Predicate(fn, Candle), 1)
```

After hoisting, `series_of`'s `Tf` branch evaluates the bare `Predicate(fn, Candle)` over the HTF candles and runs `align_htf_to_base` on the 1.0/0.0 result — no new alignment code.

- [ ] **Step 1: Write the failing test**

```python
def test_pattern_predicate_fires_on_the_engulfing_bar():
    candles = [*pad(20), c(100, 101, 97, 98), c(97, 102, 96, 101)]
    matches = _cond_matches(parse("bullEngulfing(candle)"), candles, "MINUTE_5", {})
    assert matches[-1] is True
    assert matches[-2] is False


def test_pattern_predicate_respects_an_offset():
    candles = [*pad(20), c(100, 101, 97, 98), c(97, 102, 96, 101), c(101, 102, 100, 101)]
    matches = _cond_matches(parse("bullEngulfing(candle[-1])"), candles, "MINUTE_5", {})
    assert matches[-1] is True   # fired one bar ago


def test_pattern_predicate_under_a_tf_pin_aligns_from_htf_candles():
    """The pattern is detected on the 4H series, then held across the base bars
    that follow each 4H close."""
    base = five_min_bars(count=200)          # helper in this module
    htf = {"HOUR_4": [*pad(20), c(100, 101, 97, 98), c(97, 102, 96, 101)]}
    matches = _cond_matches(parse("bullEngulfing(candle@4H)"), base, "MINUTE_5", htf)
    assert any(matches)


def test_bull_pattern_aggregate_fires_for_a_bull_member():
    candles = [*pad(20), c(100, 101, 97, 98), c(97, 102, 96, 101)]
    assert _cond_matches(parse("bullPattern(candle)"), candles, "MINUTE_5", {})[-1] is True
    assert _cond_matches(parse("bearPattern(candle)"), candles, "MINUTE_5", {})[-1] is False


def test_count_over_a_pattern_predicate():
    candles = [*pad(20), c(100, 105, 95, 100), c(100, 105, 95, 100)]
    series = series_of(parse("count(doji(candle), 5)").left, candles, "MINUTE_5", {})
    assert series[-1] == 2.0


def test_bullish_and_bearish_still_work():
    candles = [*pad(20), c(100, 102, 99, 101)]
    assert _cond_matches(parse("bullish(candle)"), candles, "MINUTE_5", {})[-1] is True
    assert _cond_matches(parse("bearish(candle)"), candles, "MINUTE_5", {})[-1] is False
```

Add the `pad`/`c`/`five_min_bars` helpers if the module lacks them, matching `test_candle_patterns.py`'s versions (bars need ascending `time` at the module's resolution).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/pytest tests/test_expr_evaluate.py -v -k pattern`
Expected: FAIL — `_cond_matches` falls into the `bullish`/`bearish` branch and compares open vs close, so `bullEngulfing` returns the wrong truth (likely all-False or bullish's answer).

- [ ] **Step 3: Implement the hoist and the series branch**

In `backend/auto_trader/strategy/expr/evaluate.py`, add the import and two helpers near `_cond_matches`:

```python
from auto_trader.indicators.candle_patterns import PATTERN_FNS, pattern_series


def _hoist_predicate(node: N.Predicate) -> N.Node:
    """Move the candle base's postfix wrappers OUTSIDE the predicate:

        Predicate(fn, Tf(Candle, "4H"))  ->  Tf(Predicate(fn, Candle), "4H")
        Predicate(fn, Offset(Candle, 1)) ->  Offset(Predicate(fn, Candle), 1)

    A pattern is a property of a BAR SERIES, not of one bar, so it must be
    detected on whichever series the pin selects and only then shifted/aligned.
    Hoisting hands both jobs to series_of's existing Tf and Offset branches
    instead of duplicating alignment here. Validation has already guaranteed the
    base bottoms out in a bare Candle through Offset/Tf wrappers only.
    """
    wrappers: list[N.Offset | N.Tf] = []
    base = node.base
    while isinstance(base, (N.Offset, N.Tf)):
        wrappers.append(base)
        base = base.base
    out: N.Node = N.Predicate(node.fn, base, node.start, node.end)
    for w in reversed(wrappers):
        if isinstance(w, N.Offset):
            out = N.Offset(out, w.n, w.start, w.end)
        else:
            out = N.Tf(out, w.tf, w.start, w.end)
    return out


def _pattern_bool_series(node: N.Predicate, candles: Sequence[Candle],
                         resolution: str, htf: dict[str, list[Candle]]) -> list[bool]:
    """Per-bar truth of a PATTERN predicate. Undefined (warm-up, or a base bar
    before the first aligned HTF close) is a non-match, matching the
    bullish/bearish convention."""
    vals = series_of(_hoist_predicate(node), candles, resolution, htf)
    return [_defined(v) and v >= 0.5 for v in vals]
```

(Constructor field order is confirmed: `N.Offset(base, n, start, end)` at `nodes.py:43-47`, `N.Tf(base, tf, start, end)` at `nodes.py:51-55`.)

In `series_of`, add a branch **before** the final fallthrough so a bare `Predicate(fn, Candle)` becomes a series:

```python
    if isinstance(node, N.Predicate):
        # Only a PATTERN predicate is a series; bullish/bearish are handled
        # pointwise by _cond_matches and never reach here.
        if node.fn in PATTERN_FNS:
            return [float(v) for v in pattern_series(candles, node.fn)]
        raise ValueError(f"{node.fn} is not a series")
```

In `_cond_matches` (`evaluate.py:97`), route pattern predicates to the new helper by replacing the opening of the `N.Predicate` branch:

```python
    if isinstance(cond, N.Predicate):
        if cond.fn in PATTERN_FNS:
            return _pattern_bool_series(cond, candles, resolution, htf)
        opens = series_of(_apply_field_to_candle(cond.base, "open"), candles, resolution, htf)
        ...  # unchanged bullish/bearish path below
```

In `_match_at` (`evaluate.py:283`), the per-bar path, add the same routing at the top of its `N.Predicate` branch. Without a cache the detector would re-run for every bar, making this path O(n²) — so memoize per condition node.

`self._cache` is annotated `dict[int, list[float | None]]` (`evaluate.py:238`) and is keyed by a different scheme, so add a **separate** dict beside the existing `_pred_nodes` rather than widening it. Declare it with the other instance attributes:

```python
    _pattern_cache: dict[int, list[bool]]
```

initialize it to `{}` wherever `_pred_nodes` is initialized, and branch:

```python
        if isinstance(cond, N.Predicate):
            if cond.fn in PATTERN_FNS:
                key = id(cond)
                if key not in self._pattern_cache:
                    self._pattern_cache[key] = _pattern_bool_series(
                        cond, self.candles, self.resolution, self.htf
                    )
                arr = self._pattern_cache[key]
                return 0 <= j < len(arr) and arr[j]
            ...  # unchanged bullish/bearish path below
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && .venv/bin/pytest tests/ -v -k "expr or pattern"`
Expected: PASS, all six new tests plus every pre-existing expr test.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/strategy/expr/evaluate.py backend/tests/
git commit -m "feat(expr): evaluate candle pattern predicates, including @tf pins"
```

---

### Task 7: Backend warm-up

Mirror the frontend's 18-bar warm-up so rows request enough history.

**Files:**
- Modify: `backend/auto_trader/strategy/expr/warmup.py:44-45`
- Test: `backend/tests/test_expr_warmup.py` (the repo's existing warm-up test module)

**Interfaces:**
- Consumes: `PATTERN_FNS` (Task 1).
- Produces: `warmup.PATTERN_WARMUP = 18`.

- [ ] **Step 1: Write the failing test**

```python
def test_pattern_predicate_warms_up_18_bars():
    assert warmup_bars(parse("bullEngulfing(candle)"), "MINUTE_5") == 18


def test_pattern_warm_up_adds_the_offset():
    assert warmup_bars(parse("bullEngulfing(candle[-3])"), "MINUTE_5") == 21


def test_a_tf_pinned_pattern_costs_no_base_bars_beyond_the_pattern_itself():
    """An @tf pin contributes zero BASE bars (the pinned series has its own
    history), so only the pattern's own 18 remain."""
    assert warmup_bars(parse("bullEngulfing(candle@4H)"), "MINUTE_5") == 18


def test_bullish_predicate_still_warms_up_zero():
    assert warmup_bars(parse("bullish(candle)"), "MINUTE_5") == 0
```

Note the third test: `warmup.py:37-39` returns 0 for a `Tf` node when a resolution is given, so the pattern's 18 is the whole answer. Confirm this matches the implementation you write — if the pattern warm-up is added at the `Predicate` level (outside the `Tf`), it survives the pin, which is correct: the base series still needs 18 bars of its own before the aligned value is honest.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/pytest tests/test_expr_warmup.py -v -k pattern`
Expected: FAIL — got 0, expected 18.

- [ ] **Step 3: Implement**

In `backend/auto_trader/strategy/expr/warmup.py`, add the constant and change the `Predicate` branch (lines 44-45):

```python
from auto_trader.indicators.candle_patterns import PATTERN_FNS

# 14 bars for the epsilon series (0.05 * SMA14 of true range) + 4 for the
# deepest lookback (ladder_bottom needs i >= 4). Mirrored by the frontend's
# catalog.ts PATTERN_WARMUP.
PATTERN_WARMUP = 18
```

```python
    if isinstance(node, N.Predicate):
        extra = PATTERN_WARMUP if node.fn in PATTERN_FNS else 0
        return extra + warmup_bars(node.base, resolution)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && .venv/bin/pytest tests/ -v -k "warmup or expr or pattern"`
Expected: PASS.

- [ ] **Step 5: Run the whole suite on both stacks**

```bash
cd backend && .venv/bin/pytest
cd ../frontend && npx vitest run
```

Expected: PASS, except these **pre-existing** frontend failures unrelated to this work — confirm the list has not grown:
- `src/ComputeHostButton.test.tsx` (4 tests)
- `src/lib/drawTools.test.ts` (1 test)

- [ ] **Step 6: Commit**

```bash
git add backend/auto_trader/strategy/expr/warmup.py backend/tests/
git commit -m "feat(expr): 18-bar warm-up for candle pattern predicates"
```

---

## Manual verification

After Task 7, confirm the feature end to end rather than trusting unit tests alone:

1. Start the app, open a chart with enough history, and open the rule editor.
2. Type `bull` in a rule row — completion should offer `bullEngulfing`, `bullHarami`, `bullBeltHold`, `bullKicking`, `bullMeetingLine`, `bullPattern`.
3. Open the `+` palette — a **Patterns** group should list 26 entries.
4. Enter `bullEngulfing(candle)` as the only entry rule and run a backtest.
5. Add the CANDLE_PATTERNS indicator to the chart with only the Engulfing toggle enabled. **Every** signal the backtest marks should sit on a bar carrying an engulfing triangle, and vice versa. A mismatch means the evaluator and the chart disagree — the golden fixture only proves the detectors agree, not that the wiring feeds them the same bars.
6. Change the rule to `bullEngulfing(candle@4H)` and confirm signals now cluster at 4H boundaries.
