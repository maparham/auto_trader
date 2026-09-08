# Patterns Panel Preset Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the Patterns feature with a preset-pattern search: a library of classic chart patterns (H&S, double top/bottom, broadening/megaphone, triangles/wedges) plus user-saved selections, detected by a pivot grammar and ranked by the shipped similarity machinery, scanned across all open charts from a restructured panel.

**Architecture:** A new core module `pattern_presets.py` detects instances via a k×ATR zigzag pivot pass + per-family grammars (structural rules over the pivot sequence), classifies forming vs completed, and ranks survivors against knot-path archetypes with `multires_distance` + `envelope_divergence_distance`. A new router exposes `POST /api/patterns/scan` (frontend supplies the open-chart list) and user-preset CRUD backed by a small sqlite store. The frontend turns the toolbar Patterns button into a panel toggle; the panel gets a Similar/Presets segmented switcher, schema-driven parameter controls, and preset results that reuse the existing jump/band machinery.

**Tech Stack:** Python 3 + numpy + FastAPI + stdlib sqlite3 (backend); React + TypeScript + vitest (frontend). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-08-patterns-panel-presets-design.md`

## Global Constraints

- Backend tests run with `cd backend && .venv/bin/python -m pytest <file> -q` (system python lacks deps).
- Frontend tests run with `cd frontend && npx vitest run <file>`.
- Commit to the CURRENT branch (main). NEVER create a branch. NEVER push. Stage by EXPLICIT path only (`git add <paths>` — never `git add -A`/`.`): other sessions share this worktree. Never stash/clean/restore.
- Follow existing code style: comment density like `pattern_shape.py` (comments state constraints, not narration); frontend uses the shared `Tooltip`/`InfoTip` components, never `title=`.
- Muted/persistent toggle buttons are gray, not solid accent blue (existing `seg-on` class handles this — reuse it).
- End commit messages with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01ALbwW6MWRrWhg6YzauXswh`
- The backend dev server runs `uvicorn --reload`; edits hot-reload, never restart it.

## Interface Cheat-Sheet (existing code you build on)

- `auto_trader/core/pattern_shape.py`: `_zigzag_pivots(z: np.ndarray, rev_frac: float) -> list[tuple[float, float, int]]` — zigzag over any 1-D path; returns `(fractional_position, level, +1 high / -1 low)` for interior confirmed pivots; threshold is `rev_frac * (z.max() - z.min())`. Also `multires_distance(query_close, window_close) -> float` and `envelope_divergence_distance(query_close, window_close) -> float` (both take 1-D or (n,1) float arrays, z-normalize internally, raise nothing on normal input).
- `auto_trader/core/pattern_series.py`: `PATTERN_SERIES.get(broker, epic, resolution, side) -> Series | None` (async); `Series` has `.ohlc` (n,4 centred float64), `.ts` (n int64 unix-seconds), `.offset` (float to add back to prices), `.bars`, `.oldest_ts`, `.newest_ts`; `PATTERN_SERIES.is_cached(...)`.
- `auto_trader/api/routers/patterns.py`: `_search_mode(matcher, series, query, *, query_span, top_k, forward_bars) -> tuple[list[Match], int]` — one similarity pipeline run; `MATCHERS["shape"]` from `pattern_matchers`. `Match` has `.start`, `.length`, `.distance`, `.forward_len`.
- `auto_trader/api/deps.py`: `resolve_broker(request, broker_id) -> str`, `current_user(request) -> str`.
- `auto_trader/api/app.py` line ~218: routers registered in a tuple of modules — add the new module there.
- `auto_trader/config.py`: settings has one `*_db_path` per store (e.g. `alerts_db_path: str = "alerts.db"`).
- `auto_trader/core/alert_store.py`: the store idiom to copy — module docstring style, `_SCHEMA` string, fresh sqlite3 connection per op, async wrappers via `asyncio.to_thread`, JSON columns parsed at the read boundary.
- Frontend `lib/patternPanelStore.ts`: module-level store, `subscribePatternPanel`, `getPatternPanelState`, `setPatternSeriesProvider(fn)` (returns unregister), `runPatternSearch(args)`, `dismissPatternPanel()`, `resetPatternPanel()` (test hook). `MatchSource = {cellId, tabId?, epic, resolution, label}`-shaped (see `lib/patternSearch.ts`).
- Frontend `lib/patternTargets.ts`: `getPatternTarget(cellId)`, `listPatternTargets()` (targets have `.epic`, `.resolution`, `.cellId`, `.showMatch(m)`, `.clearMatchBands()`, `.clearSelectionBand()`), `setPendingPatternJump(cellId, m)`, `takePendingPatternJump(cellId)`.
- Frontend `Toolbar.tsx` ~810–830: the Patterns button currently sets `controller.patternRangeMode.set("search"); controller.patternRangeArmed.set(...)`. `controller` is the active chart's controller with signal objects (`.value`, `.set(v)`, `.subscribe(cb)`), plus `patternSearchAvailable`.

---

### Task 1: k×ATR pivot pass (`pattern_presets.py` is born)

**Files:**
- Create: `backend/auto_trader/core/pattern_presets.py`
- Create: `backend/tests/test_pattern_presets_pivots.py`

**Interfaces:**
- Produces: `Pivot` (frozen dataclass: `i: int`, `price: float`, `d: int` (+1 high / -1 low)); `atr(ohlc: np.ndarray) -> float` (median true range, > 0 always); `series_pivots(ohlc: np.ndarray, k: float) -> list[Pivot]` (interior confirmed zigzag pivots of the close path, reversal threshold k×ATR, sorted by `i`, strictly alternating in `d`).

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_pattern_presets_pivots.py
"""The preset detector's pivot pass: a zigzag over the raw close with an
absolute k*ATR reversal threshold, built on pattern_shape's engine."""
import numpy as np
import pytest

from auto_trader.core.pattern_presets import Pivot, atr, series_pivots


def bars_from_close(c):
    """Minimal OHLC around a close path: open = previous close, high/low hug
    the segment, so ATR reflects the per-bar moves and nothing else."""
    c = np.asarray(c, dtype=np.float64)
    o = np.concatenate([[c[0]], c[:-1]])
    h = np.maximum(o, c) + 0.1
    l = np.minimum(o, c) - 0.1
    return np.stack([o, h, l, c], axis=1)


class TestAtr:
    def test_positive_on_flat_series(self):
        assert atr(bars_from_close(np.full(50, 100.0))) > 0

    def test_scales_with_move_size(self):
        small = bars_from_close(100 + 0.5 * np.sin(np.arange(50)))
        big = bars_from_close(100 + 5.0 * np.sin(np.arange(50)))
        assert atr(big) > atr(small)


class TestSeriesPivots:
    def test_three_swings_found(self):
        # 0 -> 10 -> 2 -> 12 -> 1: interior pivots at the 10-high, 2-low, 12-high.
        c = np.concatenate([
            np.linspace(0, 10, 20), np.linspace(10, 2, 20),
            np.linspace(2, 12, 20), np.linspace(12, 1, 20),
        ])
        piv = series_pivots(bars_from_close(c), k=2.0)
        assert [p.d for p in piv] == [1, -1, 1]
        assert piv[0].price == pytest.approx(10, abs=0.5)
        assert piv[1].price == pytest.approx(2, abs=0.5)

    def test_alternates_and_sorted(self):
        rng = np.random.default_rng(7)
        c = np.cumsum(rng.normal(0, 1, 500)) + 100
        piv = series_pivots(bars_from_close(c), k=3.0)
        assert all(a.i < b.i for a, b in zip(piv, piv[1:]))
        assert all(a.d == -b.d for a, b in zip(piv, piv[1:]))

    def test_higher_k_fewer_pivots(self):
        rng = np.random.default_rng(7)
        c = np.cumsum(rng.normal(0, 1, 500)) + 100
        b = bars_from_close(c)
        assert len(series_pivots(b, k=1.0)) >= len(series_pivots(b, k=4.0))

    def test_flat_series_no_pivots(self):
        assert series_pivots(bars_from_close(np.full(50, 100.0)), k=2.0) == []

    def test_prices_are_raw_not_normalized(self):
        c = np.concatenate([np.linspace(5000, 5100, 30), np.linspace(5100, 5010, 30)])
        piv = series_pivots(bars_from_close(c), k=2.0)
        assert piv and piv[0].price == pytest.approx(5100, abs=5)
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && .venv/bin/python -m pytest tests/test_pattern_presets_pivots.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'auto_trader.core.pattern_presets'`

- [ ] **Step 3: Implement**

```python
# backend/auto_trader/core/pattern_presets.py
"""Preset chart-pattern detection: classic formations (head & shoulders,
double tops/bottoms, broadening formations, triangles and wedges) found by a
grammar over zigzag pivots, then ranked by the similarity machinery against
per-family archetypes.

Detection is scale-aware through the pivot pass alone: the zigzag's reversal
threshold is k * ATR, so "a swing" means the same thing on a 3-minute oil
chart and a weekly index chart. Grammars then reason over pivots (hundreds),
never bars (hundreds of thousands)."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from auto_trader.core.pattern_shape import _zigzag_pivots


@dataclass(frozen=True)
class Pivot:
    i: int  # bar index into the series
    price: float
    d: int  # +1 swing high, -1 swing low


def atr(ohlc: np.ndarray) -> float:
    """Median true range over the whole array: the per-bar move unit every
    threshold in this module is expressed in. Median, not mean, so one
    flash-crash bar cannot loosen every grammar; floored above zero so a
    dead-flat synthetic series cannot divide by it."""
    h, l, c = ohlc[:, 1], ohlc[:, 2], ohlc[:, 3]
    prev_c = np.concatenate([[c[0]], c[:-1]])
    tr = np.maximum(h, prev_c) - np.minimum(l, prev_c)
    v = float(np.median(tr))
    return v if v > 0 else 1e-9


def series_pivots(ohlc: np.ndarray, k: float) -> list[Pivot]:
    """Interior confirmed swing pivots of the close path, zigzag reversal
    threshold k * ATR. Reuses pattern_shape's engine: its threshold is a
    fraction of the path's total range, so the absolute threshold converts to
    rev_frac = (k * ATR) / range."""
    close = np.ascontiguousarray(ohlc[:, 3], dtype=np.float64)
    rng = float(close.max() - close.min())
    if rng <= 0:
        return []
    piv = _zigzag_pivots(close, (k * atr(ohlc)) / rng)
    n = len(close)
    return [Pivot(i=int(round(p * (n - 1))), price=float(lv), d=d) for p, lv, d in piv]
```

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && .venv/bin/python -m pytest tests/test_pattern_presets_pivots.py -q`
Expected: PASS (8 tests). Also run `.venv/bin/python -m pytest tests/test_pattern_shape.py -q` — must stay green (no core change was made, this is a canary).

- [ ] **Step 5: Commit**

```bash
cd /Users/mahmoudparham/projects/auto_trader
git add backend/auto_trader/core/pattern_presets.py backend/tests/test_pattern_presets_pivots.py
git commit -m "feat(patterns): k*ATR pivot pass for preset pattern detection"
```

---

### Task 2: Envelope-family grammar (broadening, triangles, wedges)

**Files:**
- Modify: `backend/auto_trader/core/pattern_presets.py`
- Create: `backend/tests/test_pattern_presets_envelope.py`

**Interfaces:**
- Consumes: `Pivot`, `atr` from Task 1.
- Produces: `Instance` (frozen dataclass: `start: int`, `end: int`, `family: str`, `variant: str`, `forming: bool`, `pivots: tuple[Pivot, ...]`, `direction: int` (+1 expected/actual up breakout, -1 down, 0 unknown), `break_i: int | None`, `tell: str | None`); `find_envelope(piv: list[Pivot], close: np.ndarray, a: float, p: dict) -> list[Instance]` where `a` is the series ATR and `p` a fully-resolved param dict (defaults in Task 5; until then tests pass explicit dicts). Families emitted: `"broadening"` (variants `megaphone`, `ascending`, `descending`) and `"triangle"` (variants `symmetric`, `ascending`, `descending`, `rising-wedge`, `falling-wedge`).

**Params used by this grammar** (tests pass these explicitly):
`{"min_pivots": 5, "max_pivots": 12, "fit_tol": 1.2, "flat_slope": 0.04, "min_slope_gap": 0.06, "min_height": 3.0, "break_tol": 0.5, "partial_frac": 0.25}`
Slopes are in ATR per bar (`slope / a`). `fit_tol`, `min_height`, `break_tol` are in ATRs.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_pattern_presets_envelope.py
"""The envelope grammar: two fitted trendlines over an alternating pivot run,
classified by slope signs into broadening/triangle/wedge variants."""
import numpy as np

from auto_trader.core.pattern_presets import Instance, atr, find_envelope, series_pivots

P = {"min_pivots": 5, "max_pivots": 12, "fit_tol": 1.2, "flat_slope": 0.04,
     "min_slope_gap": 0.06, "min_height": 3.0, "break_tol": 0.5, "partial_frac": 0.25}


def bars_from_close(c):
    c = np.asarray(c, dtype=np.float64)
    o = np.concatenate([[c[0]], c[:-1]])
    h = np.maximum(o, c) + 0.05
    l = np.minimum(o, c) - 0.05
    return np.stack([o, h, l, c], axis=1)


def path(knots, n=240, lead=60, level=100.0, span=20.0):
    """A flat lead, then the knot path scaled to `span` price units: the lead
    gives the zigzag room to confirm the first pattern pivot as interior."""
    t = np.array([k[0] for k in knots]); v = np.array([k[1] for k in knots])
    body = np.interp(np.linspace(0, 1, n), t, v) * span + level
    return np.concatenate([np.full(lead, body[0]), body])


# Alternating knots: swing highs walk up, swing lows walk down -> megaphone.
MEGAPHONE = ((0.0, 0.5), (0.12, 0.65), (0.25, 0.35), (0.4, 0.78),
             (0.55, 0.22), (0.72, 0.9), (0.88, 0.1), (1.0, 0.6))
# Tops rising on a line, floor flat -> ascending broadening (RABFA).
ASC_BROAD = ((0.0, 0.2), (0.12, 0.5), (0.25, 0.2), (0.4, 0.65),
             (0.55, 0.2), (0.72, 0.8), (0.88, 0.2), (1.0, 0.55))
# Highs descending, lows ascending -> symmetric triangle.
SYM_TRI = ((0.0, 0.1), (0.12, 0.9), (0.28, 0.2), (0.45, 0.75),
           (0.62, 0.32), (0.8, 0.62), (1.0, 0.45))
# Parallel channel: both lines rise at the same rate -> NOT an instance.
CHANNEL = ((0.0, 0.0), (0.12, 0.3), (0.25, 0.1), (0.4, 0.42),
           (0.55, 0.22), (0.72, 0.55), (0.88, 0.35), (1.0, 0.65))


def scan(knots, tail=None, **kw):
    c = path(knots, **kw)
    if tail is not None:
        c = np.concatenate([c, tail(c[-1])])
    b = bars_from_close(c)
    return find_envelope(series_pivots(b, k=2.0), b[:, 3], atr(b), P), b


class TestClassification:
    def test_megaphone_found_forming(self):
        inst, _ = scan(MEGAPHONE)
        hits = [i for i in inst if i.variant == "megaphone"]
        assert hits and hits[0].family == "broadening" and hits[0].forming

    def test_ascending_broadening_found(self):
        inst, _ = scan(ASC_BROAD)
        assert any(i.variant == "ascending" and i.family == "broadening" for i in inst)

    def test_symmetric_triangle_found(self):
        inst, _ = scan(SYM_TRI)
        assert any(i.variant == "symmetric" and i.family == "triangle" for i in inst)

    def test_parallel_channel_rejected(self):
        inst, _ = scan(CHANNEL)
        assert inst == []

    def test_shallow_pattern_rejected_by_min_height(self):
        # Same megaphone at 1/20th the price span: swings shrink below
        # min_height ATRs of the (lead-dominated) series and nothing fires.
        inst, _ = scan(MEGAPHONE, span=1.0)
        assert inst == []


class TestCompletion:
    def test_upward_break_completes(self):
        # The megaphone, then a strong rally clear of the upper line.
        inst, b = scan(MEGAPHONE, tail=lambda last: np.linspace(last, last + 40, 40))
        hits = [i for i in inst if i.variant == "megaphone"]
        assert hits and not hits[0].forming
        assert hits[0].direction == 1 and hits[0].break_i is not None
        assert hits[0].end == hits[0].break_i

    def test_no_break_at_live_edge_is_forming(self):
        inst, b = scan(MEGAPHONE)
        hits = [i for i in inst if i.variant == "megaphone"]
        assert hits[0].forming and hits[0].end == len(b) - 1


class TestPartialTell:
    def test_partial_decline_detected(self):
        # Last swing low reverses well ABOVE the lower line: partial decline.
        knots = MEGAPHONE[:-2] + ((0.88, 0.45), (1.0, 0.8))
        inst, _ = scan(knots)
        hits = [i for i in inst if i.family == "broadening" and i.forming]
        assert hits and hits[0].tell == "partial-decline"

    def test_full_swing_no_tell(self):
        inst, _ = scan(MEGAPHONE)
        hits = [i for i in inst if i.variant == "megaphone"]
        assert hits[0].tell is None
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && .venv/bin/python -m pytest tests/test_pattern_presets_envelope.py -q`
Expected: FAIL with `ImportError: cannot import name 'find_envelope'`

- [ ] **Step 3: Implement**

Append to `pattern_presets.py`:

```python
@dataclass(frozen=True)
class Instance:
    start: int  # bar index of the first pattern pivot
    end: int  # break bar when completed, last series bar when forming
    family: str
    variant: str
    forming: bool
    pivots: tuple[Pivot, ...]
    direction: int  # +1 up / -1 down; actual break when completed, prior else
    break_i: int | None
    tell: str | None  # "partial-rise" | "partial-decline" on forming broadening


def _fit(pts: list[Pivot]) -> tuple[float, float]:
    """Least-squares (slope, intercept) through pivots' (bar index, price)."""
    xs = np.array([p.i for p in pts], dtype=np.float64)
    ys = np.array([p.price for p in pts], dtype=np.float64)
    denom = float(((xs - xs.mean()) ** 2).sum()) or 1e-9
    slope = float(((xs - xs.mean()) * (ys - ys.mean())).sum() / denom)
    return slope, float(ys.mean() - slope * xs.mean())


def _first_break(close, start_i, hi_line, lo_line, tol):
    """First bar after start_i whose close clears a line by tol: (bar, +1/-1),
    or None while price stays inside both."""
    hs, hb = hi_line
    ls, lb = lo_line
    for i in range(start_i + 1, len(close)):
        if close[i] > hs * i + hb + tol:
            return i, 1
        if close[i] < ls * i + lb - tol:
            return i, -1
    return None


def _envelope_variant(hs: float, ls: float, p: dict) -> tuple[str, str] | None:
    """(family, variant) from the two line slopes in ATR-per-bar units, or
    None when the lines neither diverge nor converge enough (a channel)."""
    flat = p["flat_slope"]
    if hs - ls >= p["min_slope_gap"]:  # diverging
        if hs > flat and ls < -flat:
            return "broadening", "megaphone"
        if hs > flat and abs(ls) <= flat:
            return "broadening", "ascending"
        if abs(hs) <= flat and ls < -flat:
            return "broadening", "descending"
        return None
    if ls - hs >= p["min_slope_gap"]:  # converging
        if hs < -flat and ls > flat:
            return "triangle", "symmetric"
        if abs(hs) <= flat and ls > flat:
            return "triangle", "ascending"
        if hs < -flat and abs(ls) <= flat:
            return "triangle", "descending"
        if hs > flat and ls > flat:
            return "triangle", "rising-wedge"
        if hs < -flat and ls < -flat:
            return "triangle", "falling-wedge"
    return None


def find_envelope(piv: list[Pivot], close: np.ndarray, a: float, p: dict) -> list[Instance]:
    """Broadening formations, triangles and wedges: for each run of
    min_pivots..max_pivots consecutive pivots, fit a line through the highs
    and one through the lows; the slope pair classifies the variant. Longest
    qualifying run per end pivot wins, and runs contained in an already-kept
    instance are dropped, so one formation reports once."""
    out: list[Instance] = []
    n = len(close)
    for e in range(len(piv) - 1, -1, -1):
        found = None
        for npv in range(min(p["max_pivots"], e + 1), p["min_pivots"] - 1, -1):
            run = piv[e - npv + 1 : e + 1]
            highs = [q for q in run if q.d > 0]
            lows = [q for q in run if q.d < 0]
            if len(highs) < 2 or len(lows) < 2:
                continue
            hi, lo = _fit(highs), _fit(lows)
            # Both lines must actually describe their pivots: a run whose
            # extremes wander off the fit is texture, not a formation.
            if max(abs(q.price - (hi[0] * q.i + hi[1])) for q in highs) > p["fit_tol"] * a:
                continue
            if max(abs(q.price - (lo[0] * q.i + lo[1])) for q in lows) > p["fit_tol"] * a:
                continue
            fam = _envelope_variant(hi[0] / a, lo[0] / a, p)
            if fam is None:
                continue
            last = run[-1].i
            if (hi[0] * last + hi[1]) - (lo[0] * last + lo[1]) < p["min_height"] * a:
                continue
            brk = _first_break(close, last, hi, lo, p["break_tol"] * a)
            if brk is not None:
                found = Instance(run[0].i, brk[0], fam[0], fam[1], False,
                                 tuple(run), brk[1], brk[0], None)
                break
            if e == len(piv) - 1:
                # No break and the run ends at the series' final confirmed
                # pivot: the formation is open at the live edge.
                tell = None
                if fam[0] == "broadening":
                    width = (hi[0] * last + hi[1]) - (lo[0] * last + lo[1])
                    q = run[-1]
                    if q.d < 0 and q.price - (lo[0] * q.i + lo[1]) >= p["partial_frac"] * width:
                        tell = "partial-decline"
                    elif q.d > 0 and (hi[0] * q.i + hi[1]) - q.price >= p["partial_frac"] * width:
                        tell = "partial-rise"
                found = Instance(run[0].i, n - 1, fam[0], fam[1], True,
                                 tuple(run), 0, None, tell)
                break
            # Unbroken but stale (pivots continued past it without a break):
            # the formation dissolved rather than resolving; not an instance.
        if found is not None and not any(
            o.start <= found.start and found.end <= o.end for o in out
        ):
            out.append(found)
    out.sort(key=lambda i: i.start)
    return out
```

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && .venv/bin/python -m pytest tests/test_pattern_presets_envelope.py tests/test_pattern_presets_pivots.py -q`
Expected: PASS. If a classification test fails, print the pivots and fitted slopes for the failing knot path and adjust the KNOTS in the test (not the thresholds) so the intended geometry is unambiguous — the knot paths encode ground truth, the params are the contract.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/core/pattern_presets.py backend/tests/test_pattern_presets_envelope.py
git commit -m "feat(patterns): envelope grammar - broadening, triangles, wedges"
```

---

### Task 3: Head & Shoulders grammar

**Files:**
- Modify: `backend/auto_trader/core/pattern_presets.py`
- Create: `backend/tests/test_pattern_presets_hns.py`

**Interfaces:**
- Consumes: `Pivot`, `Instance`, `_first_break` (reused for the neckline via a degenerate pair of identical lines).
- Produces: `find_hns(piv, close, a, p) -> list[Instance]` — family `"hns"`, variants `"top"` / `"inverse"`. Completed = close crosses the neckline (line through the two valleys, extrapolated) after the right shoulder; forming = five pivots confirmed as the series' last, no break yet. `direction` is -1 for a completed/forming top, +1 for inverse.

**Params:** `{"shoulder_tol": 0.35, "head_prominence": 0.25, "neck_tilt": 0.4, "break_tol": 0.5, "min_height": 3.0}` — `shoulder_tol`, `head_prominence`, `neck_tilt` are fractions of pattern height (head above mean valley); `break_tol`/`min_height` in ATRs.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_pattern_presets_hns.py
"""The head-and-shoulders grammar: five alternating pivots, head above both
shoulders, shoulders level-ish, neckline near-horizontal."""
import numpy as np

from auto_trader.core.pattern_presets import atr, find_hns, series_pivots

P = {"shoulder_tol": 0.35, "head_prominence": 0.25, "neck_tilt": 0.4,
     "break_tol": 0.5, "min_height": 3.0}


def bars_from_close(c):
    c = np.asarray(c, dtype=np.float64)
    o = np.concatenate([[c[0]], c[:-1]])
    return np.stack([o, np.maximum(o, c) + 0.05, np.minimum(o, c) - 0.05, c], axis=1)


def path(knots, n=300, lead=60, level=100.0, span=20.0):
    t = np.array([k[0] for k in knots]); v = np.array([k[1] for k in knots])
    body = np.interp(np.linspace(0, 1, n), t, v) * span + level
    return np.concatenate([np.full(lead, body[0]), body])


# LS 0.6, valleys 0.2/0.22, head 1.0, RS 0.58, then the neckline break.
HNS = ((0.0, 0.0), (0.12, 0.6), (0.25, 0.2), (0.42, 1.0),
       (0.58, 0.22), (0.72, 0.58), (0.9, 0.15), (1.0, -0.2))
# Same shape, head only just above the shoulders: prominence gate rejects.
FLAT_HEAD = ((0.0, 0.0), (0.12, 0.6), (0.25, 0.2), (0.42, 0.66),
             (0.58, 0.22), (0.72, 0.58), (0.9, 0.15), (1.0, -0.2))
# Right shoulder far above the left: symmetry gate rejects.
LOPSIDED = ((0.0, 0.0), (0.12, 0.4), (0.25, 0.2), (0.42, 1.0),
            (0.58, 0.22), (0.72, 0.9), (0.9, 0.15), (1.0, -0.2))


def run(knots, **kw):
    b = bars_from_close(path(knots, **kw))
    return find_hns(series_pivots(b, k=2.0), b[:, 3], atr(b), P), b


class TestHns:
    def test_completed_top_found(self):
        inst, _ = run(HNS)
        tops = [i for i in inst if i.variant == "top"]
        assert tops and not tops[0].forming and tops[0].direction == -1
        assert tops[0].break_i is not None

    def test_inverse_found(self):
        b = bars_from_close(2 * 100.0 - path(HNS))  # mirror about the level
        inst = find_hns(series_pivots(b, k=2.0), b[:, 3], atr(b), P)
        invs = [i for i in inst if i.variant == "inverse"]
        assert invs and invs[0].direction == 1

    def test_forming_before_break(self):
        # Stop right after the right shoulder confirms (one shallow dip).
        knots = HNS[:6] + ((0.9, 0.35),)
        inst, b = run(knots)
        tops = [i for i in inst if i.variant == "top"]
        assert tops and tops[0].forming and tops[0].end == len(b) - 1

    def test_flat_head_rejected(self):
        inst, _ = run(FLAT_HEAD)
        assert [i for i in inst if i.family == "hns"] == []

    def test_lopsided_shoulders_rejected(self):
        inst, _ = run(LOPSIDED)
        assert [i for i in inst if i.family == "hns"] == []
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && .venv/bin/python -m pytest tests/test_pattern_presets_hns.py -q`
Expected: FAIL with `ImportError: cannot import name 'find_hns'`

- [ ] **Step 3: Implement**

Append to `pattern_presets.py`:

```python
def find_hns(piv: list[Pivot], close: np.ndarray, a: float, p: dict) -> list[Instance]:
    """Head & shoulders: five alternating pivots LS-v1-H-v2-RS (tops; the
    mirror for inverses), head clear of both shoulders, shoulders within
    tolerance of each other, neckline (v1-v2) near-horizontal relative to the
    pattern's own height. Completed when a close crosses the extrapolated
    neckline beyond RS; forming when RS is the series' last confirmed pivot."""
    out: list[Instance] = []
    n = len(close)
    for j in range(len(piv) - 4):
        run = piv[j : j + 5]
        sign = run[0].d
        if [q.d for q in run] != [sign, -sign, sign, -sign, sign]:
            continue
        ls, v1, head, v2, rs = run
        # Work in "top" orientation: flip prices for an inverse so one set of
        # comparisons serves both.
        f = 1.0 if sign > 0 else -1.0
        height = f * head.price - f * (v1.price + v2.price) / 2.0
        if height < p["min_height"] * a:
            continue
        if f * head.price - max(f * ls.price, f * rs.price) < p["head_prominence"] * height:
            continue
        if abs(ls.price - rs.price) > p["shoulder_tol"] * height:
            continue
        if abs(v1.price - v2.price) > p["neck_tilt"] * height:
            continue
        neck = _fit([v1, v2])
        brk = None
        for i in range(rs.i + 1, n):
            if f * close[i] < f * (neck[0] * i + neck[1]) - p["break_tol"] * a:
                brk = i
                break
        variant = "top" if sign > 0 else "inverse"
        direction = -1 if sign > 0 else 1
        if brk is not None:
            out.append(Instance(ls.i, brk, "hns", variant, False,
                                tuple(run), direction, brk, None))
        elif j + 5 == len(piv):
            out.append(Instance(ls.i, n - 1, "hns", variant, True,
                                tuple(run), direction, None, None))
    return out
```

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && .venv/bin/python -m pytest tests/test_pattern_presets_hns.py -q`
Expected: PASS. Same rule as Task 2 on failures: adjust knot geometry, not params.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/core/pattern_presets.py backend/tests/test_pattern_presets_hns.py
git commit -m "feat(patterns): head-and-shoulders grammar"
```

---

### Task 4: Double top / bottom grammar

**Files:**
- Modify: `backend/auto_trader/core/pattern_presets.py`
- Create: `backend/tests/test_pattern_presets_double.py`

**Interfaces:**
- Produces: `find_double(piv, close, a, p) -> list[Instance]` — family `"double"`, variants `"top"` / `"bottom"`. Three pivots P1-V-P2 (high-low-high for tops), peaks within `peak_tol` fraction of pattern height, completed on close crossing the valley level beyond P2.

**Params:** `{"peak_tol": 0.15, "min_height": 3.0, "break_tol": 0.5}`

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_pattern_presets_double.py
"""The double top/bottom grammar: twin extremes around one valley/peak."""
import numpy as np

from auto_trader.core.pattern_presets import atr, find_double, series_pivots

P = {"peak_tol": 0.15, "min_height": 3.0, "break_tol": 0.5}


def bars_from_close(c):
    c = np.asarray(c, dtype=np.float64)
    o = np.concatenate([[c[0]], c[:-1]])
    return np.stack([o, np.maximum(o, c) + 0.05, np.minimum(o, c) - 0.05, c], axis=1)


def path(knots, n=240, lead=60, level=100.0, span=20.0):
    t = np.array([k[0] for k in knots]); v = np.array([k[1] for k in knots])
    body = np.interp(np.linspace(0, 1, n), t, v) * span + level
    return np.concatenate([np.full(lead, body[0]), body])


DOUBLE_TOP = ((0.0, 0.0), (0.25, 1.0), (0.5, 0.45), (0.75, 0.97), (1.0, 0.1))
LOWER_HIGH = ((0.0, 0.0), (0.25, 1.0), (0.5, 0.45), (0.75, 0.6), (1.0, 0.1))


def run(knots, **kw):
    b = bars_from_close(path(knots, **kw))
    return find_double(series_pivots(b, k=2.0), b[:, 3], atr(b), P), b


class TestDouble:
    def test_completed_top(self):
        inst, _ = run(DOUBLE_TOP)
        tops = [i for i in inst if i.variant == "top"]
        assert tops and not tops[0].forming and tops[0].direction == -1

    def test_bottom_found_on_mirror(self):
        b = bars_from_close(2 * 100.0 - path(DOUBLE_TOP))
        inst = find_double(series_pivots(b, k=2.0), b[:, 3], atr(b), P)
        assert any(i.variant == "bottom" and i.direction == 1 for i in inst)

    def test_lower_second_peak_rejected(self):
        inst, _ = run(LOWER_HIGH)
        assert [i for i in inst if i.family == "double"] == []

    def test_forming_before_valley_break(self):
        # Stop after the second peak confirms with a shallow pullback.
        knots = DOUBLE_TOP[:4] + ((1.0, 0.7),)
        inst, b = run(knots)
        tops = [i for i in inst if i.variant == "top"]
        assert tops and tops[0].forming and tops[0].end == len(b) - 1
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && .venv/bin/python -m pytest tests/test_pattern_presets_double.py -q`
Expected: FAIL with ImportError on `find_double`.

- [ ] **Step 3: Implement**

Append to `pattern_presets.py`:

```python
def find_double(piv: list[Pivot], close: np.ndarray, a: float, p: dict) -> list[Instance]:
    """Double top/bottom: P1-V-P2 with near-equal extremes around one valley
    (peak, for bottoms). Completed when a close crosses the valley level
    beyond P2 — the classic confirmation, without which twin peaks are just a
    range."""
    out: list[Instance] = []
    n = len(close)
    for j in range(len(piv) - 2):
        run = piv[j : j + 3]
        sign = run[0].d
        if [q.d for q in run] != [sign, -sign, sign]:
            continue
        p1, v, p2 = run
        f = 1.0 if sign > 0 else -1.0
        height = max(f * p1.price, f * p2.price) - f * v.price
        if height < p["min_height"] * a:
            continue
        if abs(p1.price - p2.price) > p["peak_tol"] * height:
            continue
        brk = None
        for i in range(p2.i + 1, n):
            if f * close[i] < f * v.price - p["break_tol"] * a:
                brk = i
                break
        variant = "top" if sign > 0 else "bottom"
        direction = -1 if sign > 0 else 1
        if brk is not None:
            out.append(Instance(p1.i, brk, "double", variant, False,
                                tuple(run), direction, brk, None))
        elif j + 3 == len(piv):
            out.append(Instance(p1.i, n - 1, "double", variant, True,
                                tuple(run), direction, None, None))
    return out
```

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && .venv/bin/python -m pytest tests/test_pattern_presets_double.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/core/pattern_presets.py backend/tests/test_pattern_presets_double.py
git commit -m "feat(patterns): double top/bottom grammar"
```

---

### Task 5: Param schemas, archetype ranking, stats, `scan_series`

**Files:**
- Modify: `backend/auto_trader/core/pattern_presets.py`
- Create: `backend/tests/test_pattern_presets_scan.py`

**Interfaces:**
- Produces:
  - `PARAM_SCHEMAS: dict[str, list[dict]]` — keys `"hns"`, `"double"`, `"broadening"`, `"triangle"`; each param descriptor `{"name", "type" ("float"|"int"), "min", "max", "default", "help"}`. Every family carries the shared knobs `k`, `min_bars`, `max_bars`, `strictness` plus its own (values in the code below).
  - `resolve_params(family: str, overrides: dict) -> dict` — defaults filled, `ValueError` naming an unknown param or out-of-range value.
  - `FAMILIES: list[str]` — the four keys, panel display order.
  - `STATS: dict[tuple[str, str], dict]` — per (family, variant): `{"breakout_up_pct": int | None, "source": str}`.
  - `Hit` (frozen dataclass: `instance: Instance`, `distance: float`, `breakout_up_pct: int | None`, `target: float | None`, `source: str`).
  - `scan_series(ohlc: np.ndarray, families: list[tuple[str, dict]]) -> list[Hit]` — full pipeline for one series: pivots per family `k`, grammar dispatch, length gate, dedup (drop a `double` ≥80 %-contained in an `hns` span), archetype ranking, strictness cut, measure-rule target; sorted forming-first then by `instance.start`.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_pattern_presets_scan.py
"""The one-series pipeline: params, ranking, stats, dedup."""
import numpy as np
import pytest

from auto_trader.core.pattern_presets import (
    FAMILIES, PARAM_SCHEMAS, STATS, resolve_params, scan_series,
)


def bars_from_close(c):
    c = np.asarray(c, dtype=np.float64)
    o = np.concatenate([[c[0]], c[:-1]])
    return np.stack([o, np.maximum(o, c) + 0.05, np.minimum(o, c) - 0.05, c], axis=1)


def path(knots, n=240, lead=60, level=100.0, span=20.0):
    t = np.array([k[0] for k in knots]); v = np.array([k[1] for k in knots])
    body = np.interp(np.linspace(0, 1, n), t, v) * span + level
    return np.concatenate([np.full(lead, body[0]), body])


DOUBLE_TOP = ((0.0, 0.0), (0.25, 1.0), (0.5, 0.45), (0.75, 0.97), (1.0, 0.1))
HNS = ((0.0, 0.0), (0.12, 0.6), (0.25, 0.2), (0.42, 1.0),
       (0.58, 0.22), (0.72, 0.58), (0.9, 0.15), (1.0, -0.2))


class TestParams:
    def test_every_family_has_schema_with_shared_knobs(self):
        for fam in FAMILIES:
            names = {d["name"] for d in PARAM_SCHEMAS[fam]}
            assert {"k", "min_bars", "max_bars", "strictness"} <= names

    def test_defaults_fill(self):
        p = resolve_params("hns", {})
        assert p["k"] == 2.0 and p["shoulder_tol"] == 0.35

    def test_unknown_param_rejected(self):
        with pytest.raises(ValueError, match="nope"):
            resolve_params("hns", {"nope": 1})

    def test_out_of_range_rejected(self):
        with pytest.raises(ValueError, match="k"):
            resolve_params("hns", {"k": 99.0})


class TestScanSeries:
    def test_finds_double_top_with_stats(self):
        b = bars_from_close(path(DOUBLE_TOP, n=300))
        hits = scan_series(b, [("double", resolve_params("double", {}))])
        assert hits and hits[0].instance.family == "double"
        assert hits[0].breakout_up_pct is not None
        # Measure rule: target = valley level minus pattern height, below it.
        assert hits[0].target is not None and hits[0].target < 100.0

    def test_strictness_cuts(self):
        b = bars_from_close(path(DOUBLE_TOP, n=300))
        loose = scan_series(b, [("double", resolve_params("double", {}))])
        tight = scan_series(b, [("double", resolve_params("double", {"strictness": 0.01}))])
        assert len(tight) <= len(loose)

    def test_hns_suppresses_contained_double(self):
        b = bars_from_close(path(HNS, n=300))
        fams = [("hns", resolve_params("hns", {})), ("double", resolve_params("double", {}))]
        hits = scan_series(b, fams)
        assert any(h.instance.family == "hns" for h in hits)
        for h in hits:
            if h.instance.family != "double":
                continue
            for g in hits:
                if g.instance.family == "hns":
                    ov = min(h.instance.end, g.instance.end) - max(h.instance.start, g.instance.start)
                    assert ov < 0.8 * (h.instance.end - h.instance.start)

    def test_length_gate(self):
        b = bars_from_close(path(DOUBLE_TOP, n=300))
        p = resolve_params("double", {"min_bars": 2000})
        assert scan_series(b, [("double", p)]) == []

    def test_stats_table_covers_every_variant(self):
        for key in [("hns", "top"), ("hns", "inverse"), ("double", "top"),
                    ("double", "bottom"), ("broadening", "megaphone"),
                    ("broadening", "ascending"), ("broadening", "descending"),
                    ("triangle", "symmetric"), ("triangle", "ascending"),
                    ("triangle", "descending"), ("triangle", "rising-wedge"),
                    ("triangle", "falling-wedge")]:
            assert key in STATS and "source" in STATS[key]
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && .venv/bin/python -m pytest tests/test_pattern_presets_scan.py -q`
Expected: FAIL with ImportError.

- [ ] **Step 3: Implement**

Append to `pattern_presets.py` (imports at top gain `multires_distance, envelope_divergence_distance` from `pattern_shape`):

```python
# ------------------------------------------------------------------- params

_SHARED_PARAMS = [
    {"name": "k", "type": "float", "min": 0.5, "max": 6.0, "default": 2.0,
     "help": "pivot sensitivity: a swing must reverse by k x ATR to count"},
    {"name": "min_bars", "type": "int", "min": 10, "max": 5000, "default": 20,
     "help": "shortest instance reported, in bars"},
    {"name": "max_bars", "type": "int", "min": 20, "max": 5000, "default": 600,
     "help": "longest instance reported, in bars"},
    {"name": "strictness", "type": "float", "min": 0.2, "max": 3.0, "default": 1.6,
     "help": "max shape distance from the family archetype before a hit is dropped"},
]

PARAM_SCHEMAS: dict[str, list[dict]] = {
    "hns": _SHARED_PARAMS + [
        {"name": "shoulder_tol", "type": "float", "min": 0.05, "max": 0.8, "default": 0.35,
         "help": "max shoulder height difference, as a fraction of pattern height"},
        {"name": "head_prominence", "type": "float", "min": 0.05, "max": 1.0, "default": 0.25,
         "help": "head must top the higher shoulder by this fraction of height"},
        {"name": "neck_tilt", "type": "float", "min": 0.05, "max": 1.0, "default": 0.4,
         "help": "max neckline tilt across the pattern, as a fraction of height"},
        {"name": "break_tol", "type": "float", "min": 0.1, "max": 2.0, "default": 0.5,
         "help": "close must clear the neckline by this many ATRs to confirm"},
        {"name": "min_height", "type": "float", "min": 1.0, "max": 20.0, "default": 3.0,
         "help": "min pattern height in ATRs"},
    ],
    "double": _SHARED_PARAMS + [
        {"name": "peak_tol", "type": "float", "min": 0.02, "max": 0.5, "default": 0.15,
         "help": "max difference between the two peaks, as a fraction of height"},
        {"name": "break_tol", "type": "float", "min": 0.1, "max": 2.0, "default": 0.5,
         "help": "close must clear the valley by this many ATRs to confirm"},
        {"name": "min_height", "type": "float", "min": 1.0, "max": 20.0, "default": 3.0,
         "help": "min pattern height in ATRs"},
    ],
    "broadening": _SHARED_PARAMS + [
        {"name": "min_pivots", "type": "int", "min": 4, "max": 10, "default": 5,
         "help": "min trendline touches across both lines (Bulkowski: 3 + 2)"},
        {"name": "max_pivots", "type": "int", "min": 6, "max": 20, "default": 12,
         "help": "max pivots one instance may span"},
        {"name": "fit_tol", "type": "float", "min": 0.3, "max": 3.0, "default": 1.2,
         "help": "max pivot distance from its trendline, in ATRs"},
        {"name": "flat_slope", "type": "float", "min": 0.01, "max": 0.2, "default": 0.04,
         "help": "a line flatter than this (ATR/bar) counts as horizontal"},
        {"name": "min_slope_gap", "type": "float", "min": 0.02, "max": 0.5, "default": 0.06,
         "help": "min divergence between the lines, in ATR/bar"},
        {"name": "min_height", "type": "float", "min": 1.0, "max": 20.0, "default": 3.0,
         "help": "min height at the wide end, in ATRs"},
        {"name": "break_tol", "type": "float", "min": 0.1, "max": 2.0, "default": 0.5,
         "help": "close must clear a trendline by this many ATRs to confirm"},
        {"name": "partial_frac", "type": "float", "min": 0.1, "max": 0.5, "default": 0.25,
         "help": "how far short of the far line a swing may stop to count as a partial rise/decline"},
    ],
}
# Triangles share the envelope engine and its knobs; min_slope_gap reads as
# min convergence there.
PARAM_SCHEMAS["triangle"] = PARAM_SCHEMAS["broadening"]

FAMILIES = ["hns", "double", "broadening", "triangle"]


def resolve_params(family: str, overrides: dict) -> dict:
    if family not in PARAM_SCHEMAS:
        raise ValueError(f"unknown pattern family '{family}'")
    schema = {d["name"]: d for d in PARAM_SCHEMAS[family]}
    out = {name: d["default"] for name, d in schema.items()}
    for name, val in overrides.items():
        d = schema.get(name)
        if d is None:
            raise ValueError(f"unknown param '{name}' for family '{family}'")
        val = int(val) if d["type"] == "int" else float(val)
        if not d["min"] <= val <= d["max"]:
            raise ValueError(
                f"param '{name}' out of range [{d['min']}, {d['max']}]: {val}"
            )
        out[name] = val
    return out


# ---------------------------------------------------------- ranking + stats

# Idealized close paths per variant, (t, value) knots in the unit square —
# the same idiom as scripts/pattern_bench/planting.py (duplicated: core must
# not import from scripts). The ranked window is the pattern BODY (first
# pivot to break/last pivot), so paths end where the pattern does.
ARCHETYPES: dict[tuple[str, str], tuple[tuple[float, float], ...]] = {
    ("hns", "top"): ((0.0, 0.1), (0.15, 0.6), (0.3, 0.2), (0.5, 1.0),
                     (0.7, 0.22), (0.85, 0.58), (1.0, 0.05)),
    ("hns", "inverse"): ((0.0, 0.9), (0.15, 0.4), (0.3, 0.8), (0.5, 0.0),
                         (0.7, 0.78), (0.85, 0.42), (1.0, 0.95)),
    ("double", "top"): ((0.0, 0.0), (0.25, 1.0), (0.5, 0.5), (0.75, 0.97), (1.0, 0.1)),
    ("double", "bottom"): ((0.0, 1.0), (0.25, 0.0), (0.5, 0.5), (0.75, 0.03), (1.0, 0.9)),
    ("broadening", "megaphone"): ((0.0, 0.5), (0.12, 0.65), (0.25, 0.35), (0.4, 0.78),
                                  (0.55, 0.22), (0.72, 0.9), (0.88, 0.1), (1.0, 0.6)),
    ("broadening", "ascending"): ((0.0, 0.2), (0.12, 0.5), (0.25, 0.2), (0.4, 0.65),
                                  (0.55, 0.2), (0.72, 0.8), (0.88, 0.2), (1.0, 0.55)),
    ("broadening", "descending"): ((0.0, 0.8), (0.12, 0.5), (0.25, 0.8), (0.4, 0.35),
                                   (0.55, 0.8), (0.72, 0.2), (0.88, 0.8), (1.0, 0.45)),
    ("triangle", "symmetric"): ((0.0, 0.1), (0.12, 0.9), (0.28, 0.2), (0.45, 0.75),
                                (0.62, 0.32), (0.8, 0.62), (1.0, 0.45)),
    ("triangle", "ascending"): ((0.0, 0.1), (0.15, 0.8), (0.3, 0.3), (0.5, 0.8),
                                (0.65, 0.5), (0.82, 0.8), (1.0, 0.68)),
    ("triangle", "descending"): ((0.0, 0.9), (0.15, 0.2), (0.3, 0.7), (0.5, 0.2),
                                 (0.65, 0.5), (0.82, 0.2), (1.0, 0.32)),
    ("triangle", "rising-wedge"): ((0.0, 0.0), (0.15, 0.5), (0.3, 0.2), (0.5, 0.7),
                                   (0.65, 0.5), (0.82, 0.85), (1.0, 0.72)),
    ("triangle", "falling-wedge"): ((0.0, 1.0), (0.15, 0.5), (0.3, 0.8), (0.5, 0.3),
                                    (0.65, 0.5), (0.82, 0.15), (1.0, 0.28)),
}

# Breakout-direction priors. Sources: thepatternsite.com (Bulkowski) pages —
# rabfa.html, bt.html, abw.html and the pattern index. None where the
# direction is part of the definition (H&S, doubles: the break IS the
# pattern) — the panel shows the measure target instead of a coin-flip stat.
STATS: dict[tuple[str, str], dict] = {
    ("hns", "top"): {"breakout_up_pct": None, "source": "Bulkowski: breaks down by definition"},
    ("hns", "inverse"): {"breakout_up_pct": None, "source": "Bulkowski: breaks up by definition"},
    ("double", "top"): {"breakout_up_pct": None, "source": "Bulkowski: confirmed on the down break"},
    ("double", "bottom"): {"breakout_up_pct": None, "source": "Bulkowski: confirmed on the up break"},
    ("broadening", "megaphone"): {"breakout_up_pct": 53, "source": "Bulkowski, broadening tops"},
    ("broadening", "ascending"): {"breakout_up_pct": 55, "source": "Bulkowski, RABFA (thepatternsite.com/rabfa.html)"},
    ("broadening", "descending"): {"breakout_up_pct": 48, "source": "Bulkowski, right-angled descending"},
    ("triangle", "symmetric"): {"breakout_up_pct": 54, "source": "Bulkowski, symmetrical triangles"},
    ("triangle", "ascending"): {"breakout_up_pct": 63, "source": "Bulkowski, ascending triangles"},
    ("triangle", "descending"): {"breakout_up_pct": 45, "source": "Bulkowski, descending triangles"},
    ("triangle", "rising-wedge"): {"breakout_up_pct": 32, "source": "Bulkowski, rising wedges"},
    ("triangle", "falling-wedge"): {"breakout_up_pct": 68, "source": "Bulkowski, falling wedges"},
}


@dataclass(frozen=True)
class Hit:
    instance: Instance
    distance: float
    breakout_up_pct: int | None
    target: float | None
    source: str


def _archetype_path(key: tuple[str, str], m: int) -> np.ndarray:
    knots = ARCHETYPES[key]
    t = np.array([k[0] for k in knots])
    v = np.array([k[1] for k in knots])
    return np.interp(np.linspace(0.0, 1.0, m), t, v)


def _measure_target(inst: Instance, close: np.ndarray, a: float) -> float | None:
    """The measure rule: pattern height projected from the break level in the
    breakout direction. Forming instances have no break level yet."""
    if inst.break_i is None or inst.direction == 0:
        return None
    prices = [q.price for q in inst.pivots]
    height = max(prices) - min(prices)
    return float(close[inst.break_i] + inst.direction * height)


_GRAMMARS = {
    "hns": find_hns,
    "double": find_double,
    "broadening": find_envelope,
    "triangle": find_envelope,
}


def scan_series(ohlc: np.ndarray, families: list[tuple[str, dict]]) -> list[Hit]:
    """One series through the whole preset pipeline. Grammars detect,
    archetype similarity ranks, strictness cuts; an hns instance suppresses a
    double it contains (three of the same five pivots — the more specific
    reading wins)."""
    close = np.ascontiguousarray(ohlc[:, 3], dtype=np.float64)
    a = atr(ohlc)
    raw: list[tuple[Instance, dict]] = []
    piv_cache: dict[float, list[Pivot]] = {}
    for family, p in families:
        piv = piv_cache.setdefault(p["k"], series_pivots(ohlc, p["k"]))
        for inst in _GRAMMARS[family](piv, close, a, p):
            if inst.family != family:
                continue  # the shared envelope engine emits both; keep asked-for
            body_end = inst.break_i if inst.break_i is not None else inst.pivots[-1].i
            if not p["min_bars"] <= body_end - inst.start + 1 <= p["max_bars"]:
                continue
            raw.append((inst, p))
    hits: list[Hit] = []
    hns_spans = [(i.start, i.end) for i, _ in raw if i.family == "hns"]
    for inst, p in raw:
        if inst.family == "double":
            length = inst.end - inst.start or 1
            if any(min(inst.end, e) - max(inst.start, s) >= 0.8 * length
                   for s, e in hns_spans):
                continue
        body_end = inst.break_i if inst.break_i is not None else inst.pivots[-1].i
        win = close[inst.start : body_end + 1]
        arch = _archetype_path((inst.family, inst.variant), len(win))
        dist = multires_distance(arch, win) + 0.2 * envelope_divergence_distance(arch, win)
        if dist > p["strictness"]:
            continue
        st = STATS[(inst.family, inst.variant)]
        hits.append(Hit(inst, float(dist), st["breakout_up_pct"],
                        _measure_target(inst, close, a), st["source"]))
    hits.sort(key=lambda h: (not h.instance.forming, h.instance.start))
    return hits
```

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && .venv/bin/python -m pytest tests/test_pattern_presets_scan.py tests/test_pattern_presets_hns.py tests/test_pattern_presets_double.py tests/test_pattern_presets_envelope.py -q`
Expected: PASS. Note `envelope_divergence_distance` needs ≥16 bars and ≥2 pivots per side on the archetype — it gates to 0.0 otherwise, which is correct behavior, not a bug.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/core/pattern_presets.py backend/tests/test_pattern_presets_scan.py
git commit -m "feat(patterns): preset param schemas, archetype ranking, scan_series"
```

---

### Task 6: Planted integration test (find the pattern, reject the lookalikes)

**Files:**
- Create: `backend/tests/test_pattern_presets_planted.py`

**Interfaces:**
- Consumes: `scan_series`, `resolve_params` from Task 5. No production code changes — this task is pure verification: patterns dressed in realistic noise inside a long random walk must be found; structural lookalikes must not.

- [ ] **Step 1: Write the test**

```python
# backend/tests/test_pattern_presets_planted.py
"""Bench-style planted case: archetype instances dressed in bar noise inside
a long random walk. The grammar must find what was planted and stay quiet on
a planted lookalike (parallel channel) and on the raw walk itself."""
import numpy as np

from auto_trader.core.pattern_presets import resolve_params, scan_series


def bars_from_close(c, rng):
    c = np.asarray(c, dtype=np.float64)
    o = np.concatenate([[c[0]], c[:-1]])
    wick = np.abs(rng.normal(0, 0.15, len(c)))
    return np.stack([o, np.maximum(o, c) + wick, np.minimum(o, c) - wick, c], axis=1)


def knot_path(knots, m):
    t = np.array([k[0] for k in knots]); v = np.array([k[1] for k in knots])
    return np.interp(np.linspace(0, 1, m), t, v)


MEGAPHONE = ((0.0, 0.5), (0.12, 0.65), (0.25, 0.35), (0.4, 0.78),
             (0.55, 0.22), (0.72, 0.9), (0.88, 0.1), (1.0, 0.6))
CHANNEL = ((0.0, 0.0), (0.12, 0.3), (0.25, 0.1), (0.4, 0.42),
           (0.55, 0.22), (0.72, 0.55), (0.88, 0.35), (1.0, 0.65))


def build_series():
    rng = np.random.default_rng(42)
    # A calm random walk: sigma 0.3 keeps organic swings well under the
    # planted patterns' 15-unit span, so ground truth stays by-construction.
    walk = np.cumsum(rng.normal(0, 0.3, 3000)) + 500
    span = 15.0
    mega = knot_path(MEGAPHONE, 90) * span
    chan = knot_path(CHANNEL, 90) * span
    for site, body in ((600, mega), (1800, chan)):
        base = walk[site]
        walk[site : site + len(body)] = base + body - body[0]
        # Reconnect the tail so the plant doesn't create a phantom cliff.
        walk[site + len(body):] += (base + body[-1] - body[0]) - walk[site + len(body)]
    return bars_from_close(walk + rng.normal(0, 0.1, len(walk)), rng), 600, 90


class TestPlanted:
    def test_planted_megaphone_found_channel_ignored(self):
        ohlc, site, m = build_series()
        hits = scan_series(ohlc, [("broadening", resolve_params("broadening", {}))])
        # The planted megaphone: some hit overlapping the planted site.
        assert any(h.instance.start < site + m and h.instance.end > site
                   for h in hits), "planted megaphone not found"
        # The planted channel at 1800 must NOT report as broadening.
        assert not any(1800 < h.instance.start < 1890 for h in hits), \
            "parallel channel misread as broadening"

    def test_bare_walk_is_mostly_quiet(self):
        rng = np.random.default_rng(7)
        walk = np.cumsum(rng.normal(0, 0.3, 3000)) + 500
        ohlc = bars_from_close(walk, rng)
        fams = [(f, resolve_params(f, {})) for f in ("hns", "double", "broadening", "triangle")]
        hits = scan_series(ohlc, fams)
        # Random walks do produce occasional real-looking formations; the
        # gate is against noise-level spam, not perfection.
        assert len(hits) < 25
```

- [ ] **Step 2: Run**

Run: `cd backend && .venv/bin/python -m pytest tests/test_pattern_presets_planted.py -q`
Expected: PASS. If the megaphone is missed, debug with a scratch script that prints `series_pivots` around the site at k=2.0 — the usual cause is the plant's amplitude vs the walk's ATR; raise `span` in the test to 20.0 before touching any default.

- [ ] **Step 3: Commit**

```bash
git add backend/tests/test_pattern_presets_planted.py
git commit -m "test(patterns): planted integration case for preset detection"
```

---

### Task 7: User-preset store (sqlite)

**Files:**
- Create: `backend/auto_trader/core/pattern_preset_store.py`
- Modify: `backend/auto_trader/config.py` (one line: add `patterns_db_path: str = "patterns.db"` next to `alerts_db_path`)
- Create: `backend/tests/test_pattern_preset_store.py`

**Interfaces:**
- Produces: `PatternPresetStore(db_path: str)` with async methods `create(user_id, name, epic, resolution, bars: list[dict]) -> dict` (returns the row, id generated as `uuid4().hex[:12]`), `list(user_id) -> list[dict]` (newest first, bars included), `get(user_id, preset_id) -> dict | None`, `rename(user_id, preset_id, name) -> bool`, `delete(user_id, preset_id) -> bool`. Rows: `{"id", "name", "epic", "resolution", "bars" (list of {ts,o,h,l,c} dicts), "created_at"}`. Module-level singleton `PRESET_STORE = PatternPresetStore(settings.patterns_db_path)`.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_pattern_preset_store.py
"""User pattern presets: saved selections, one sqlite home per user."""
import pytest

from auto_trader.core.pattern_preset_store import PatternPresetStore

BARS = [{"ts": 1000 + i * 60, "o": 1.0, "h": 2.0, "l": 0.5, "c": 1.5} for i in range(20)]


@pytest.fixture
def store(tmp_path):
    return PatternPresetStore(str(tmp_path / "presets.db"))


@pytest.mark.asyncio
async def test_create_and_list_roundtrip(store):
    row = await store.create("u1", "my flag", "US100", "MINUTE_5", BARS)
    assert row["id"] and row["name"] == "my flag"
    rows = await store.list("u1")
    assert len(rows) == 1 and rows[0]["bars"] == BARS
    assert rows[0]["epic"] == "US100"


@pytest.mark.asyncio
async def test_user_isolation(store):
    await store.create("u1", "a", "US100", "DAY", BARS)
    assert await store.list("u2") == []


@pytest.mark.asyncio
async def test_rename_and_delete(store):
    row = await store.create("u1", "a", "US100", "DAY", BARS)
    assert await store.rename("u1", row["id"], "b")
    assert (await store.get("u1", row["id"]))["name"] == "b"
    assert await store.delete("u1", row["id"])
    assert await store.get("u1", row["id"]) is None
    assert not await store.delete("u1", "missing")
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && .venv/bin/python -m pytest tests/test_pattern_preset_store.py -q`
Expected: FAIL with ModuleNotFoundError. (If `pytest.mark.asyncio` errors instead, check how `tests/test_alert_store.py` marks async tests and mirror it exactly.)

- [ ] **Step 3: Implement**

```python
# backend/auto_trader/core/pattern_preset_store.py
"""User pattern presets: chart selections saved as named query patterns, so
the preset scan can search for them server-side with no browser open.

Same storage idiom as alert_store: stdlib sqlite3, a fresh connection per
operation, writes via asyncio.to_thread, JSON columns parsed at the read
boundary so callers never see a JSON string."""

from __future__ import annotations

import asyncio
import json
import sqlite3
import time
import uuid

from auto_trader.config import settings

_SCHEMA = """
CREATE TABLE IF NOT EXISTS presets (
  user_id TEXT NOT NULL, id TEXT NOT NULL,
  name TEXT NOT NULL,
  epic TEXT NOT NULL, resolution TEXT NOT NULL,
  bars TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id));
"""


class PatternPresetStore:
    def __init__(self, db_path: str) -> None:
        self._db_path = db_path

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path)
        conn.executescript(_SCHEMA)
        return conn

    def _row(self, r: tuple) -> dict:
        return {"id": r[0], "name": r[1], "epic": r[2], "resolution": r[3],
                "bars": json.loads(r[4]), "created_at": r[5]}

    async def create(self, user_id: str, name: str, epic: str,
                     resolution: str, bars: list[dict]) -> dict:
        def op() -> dict:
            pid = uuid.uuid4().hex[:12]
            now = int(time.time())
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO presets VALUES (?,?,?,?,?,?)",
                    (user_id, pid, name, epic, resolution, json.dumps(bars), now),
                )
            return {"id": pid, "name": name, "epic": epic,
                    "resolution": resolution, "bars": bars, "created_at": now}
        return await asyncio.to_thread(op)

    async def list(self, user_id: str) -> list[dict]:
        def op() -> list[dict]:
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT id,name,epic,resolution,bars,created_at FROM presets"
                    " WHERE user_id=? ORDER BY created_at DESC",
                    (user_id,),
                ).fetchall()
            return [self._row(r) for r in rows]
        return await asyncio.to_thread(op)

    async def get(self, user_id: str, preset_id: str) -> dict | None:
        def op() -> dict | None:
            with self._connect() as conn:
                r = conn.execute(
                    "SELECT id,name,epic,resolution,bars,created_at FROM presets"
                    " WHERE user_id=? AND id=?",
                    (user_id, preset_id),
                ).fetchone()
            return self._row(r) if r else None
        return await asyncio.to_thread(op)

    async def rename(self, user_id: str, preset_id: str, name: str) -> bool:
        def op() -> bool:
            with self._connect() as conn:
                cur = conn.execute(
                    "UPDATE presets SET name=? WHERE user_id=? AND id=?",
                    (name, user_id, preset_id),
                )
            return cur.rowcount > 0
        return await asyncio.to_thread(op)

    async def delete(self, user_id: str, preset_id: str) -> bool:
        def op() -> bool:
            with self._connect() as conn:
                cur = conn.execute(
                    "DELETE FROM presets WHERE user_id=? AND id=?",
                    (user_id, preset_id),
                )
            return cur.rowcount > 0
        return await asyncio.to_thread(op)


PRESET_STORE = PatternPresetStore(settings.patterns_db_path)
```

And in `config.py`, next to `alerts_db_path` (~line 88), add with the same comment style as its neighbors:

```python
    patterns_db_path: str = "patterns.db"
```

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && .venv/bin/python -m pytest tests/test_pattern_preset_store.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/core/pattern_preset_store.py backend/auto_trader/config.py backend/tests/test_pattern_preset_store.py
git commit -m "feat(patterns): sqlite store for user pattern presets"
```

---

### Task 8: API — scan endpoint, families manifest, preset CRUD

**Files:**
- Modify: `backend/auto_trader/api/schemas.py` (append after `PatternSearchResponse`)
- Create: `backend/auto_trader/api/routers/pattern_presets.py`
- Modify: `backend/auto_trader/api/app.py` (add `pattern_presets` to the router-module tuple ~line 218 and its import)
- Create: `backend/tests/test_api_pattern_presets.py`

**Interfaces:**
- Consumes: `scan_series`, `resolve_params`, `PARAM_SCHEMAS`, `FAMILIES` (Task 5); `PRESET_STORE` (Task 7); `PATTERN_SERIES`, `_search_mode`, `MATCHERS` (existing); `deps.resolve_broker`, `deps.current_user`.
- Produces endpoints:
  - `GET /api/patterns/families` → `{"families": [{"family", "title", "params": [schema dicts]}]}` (titles: hns → "Head & Shoulders", double → "Double Top / Bottom", broadening → "Broadening / Megaphone", triangle → "Triangles & Wedges").
  - `POST /api/patterns/scan` → per-chart grouped results; families list accepts `"user:<id>"`; 409 while another scan runs.
  - `GET/POST /api/patterns/presets`, `PATCH/DELETE /api/patterns/presets/{preset_id}`.
- DTOs (schemas.py): as in the code below; all camelCase aliases with `populate_by_name`.

- [ ] **Step 1: Write the failing tests**

Follow the client-construction idiom at the top of `tests/test_api_patterns.py` (read it first; it shows how the app/TestClient and any auth fixtures are set up — reuse that verbatim). Point `PRESET_STORE` at a temp db via monkeypatch of its `_db_path`.

```python
# backend/tests/test_api_pattern_presets.py
"""The preset-scan API: families manifest, scan across charts, preset CRUD."""
import numpy as np
import pytest
from fastapi.testclient import TestClient

from auto_trader.api.app import app
from auto_trader.core import pattern_preset_store
from auto_trader.core.pattern_series import PATTERN_SERIES, Series

client = TestClient(app)

BARS = [{"ts": 1000 + i * 60, "o": 1.0, "h": 2.0, "l": 0.5, "c": 1.5} for i in range(20)]


@pytest.fixture(autouse=True)
def preset_db(tmp_path, monkeypatch):
    monkeypatch.setattr(pattern_preset_store.PRESET_STORE, "_db_path",
                        str(tmp_path / "presets.db"))


def fake_series(close):
    """A Series the scan can use without candle_history.db. Mirror the real
    Series construction in pattern_series.py (centred ohlc, prefix sums may
    be None-safe for this path since scan_series never touches them)."""
    close = np.asarray(close, dtype=np.float64)
    o = np.concatenate([[close[0]], close[:-1]])
    ohlc = np.stack([o, np.maximum(o, close) + 0.05,
                     np.minimum(o, close) - 0.05, close], axis=1)
    ts = np.arange(len(close), dtype=np.int64) * 300 + 1_700_000_000
    off = float(ohlc[:, 3].mean())
    # Construct exactly as pattern_series.Series is constructed — read that
    # dataclass and fill every field it requires (offset=off, centred ohlc).
    return Series(ohlc=ohlc - off, ts=ts, offset=off,
                  s1=None, s2=None)  # adjust fields to the real dataclass


def install_series(monkeypatch, mapping):
    async def get(broker, epic, resolution, side):
        return mapping.get((epic, resolution))
    monkeypatch.setattr(PATTERN_SERIES, "get", get)
    monkeypatch.setattr(PATTERN_SERIES, "is_cached", lambda *a: True)


DOUBLE_TOP = np.concatenate([
    np.full(60, 100.0), np.linspace(100, 120, 40), np.linspace(120, 110, 30),
    np.linspace(110, 119.5, 40), np.linspace(119.5, 98, 40),
])


class TestFamilies:
    def test_manifest_lists_four_families_with_schemas(self):
        r = client.get("/api/patterns/families")
        assert r.status_code == 200
        fams = {f["family"]: f for f in r.json()["families"]}
        assert set(fams) == {"hns", "double", "broadening", "triangle"}
        assert any(p["name"] == "strictness" for p in fams["hns"]["params"])


class TestScan:
    def test_scan_finds_planted_double_top(self, monkeypatch):
        install_series(monkeypatch, {("US100", "MINUTE_5"): fake_series(DOUBLE_TOP)})
        r = client.post("/api/patterns/scan", json={
            "charts": [{"epic": "US100", "resolution": "MINUTE_5"}],
            "families": [{"family": "double", "params": {}}],
        })
        assert r.status_code == 200
        chart = r.json()["charts"][0]
        assert chart["status"] == "ok"
        assert any(h["family"] == "double" for h in chart["hits"])
        hit = chart["hits"][0]
        assert {"family", "variant", "forming", "ts", "endTs", "bars"} <= set(hit)

    def test_missing_history_reported_per_chart(self, monkeypatch):
        install_series(monkeypatch, {})
        r = client.post("/api/patterns/scan", json={
            "charts": [{"epic": "GHOST", "resolution": "DAY"}],
            "families": [{"family": "double", "params": {}}],
        })
        assert r.status_code == 200
        assert r.json()["charts"][0]["status"] == "no-history"

    def test_bad_param_is_400_with_schema_hint(self, monkeypatch):
        install_series(monkeypatch, {})
        r = client.post("/api/patterns/scan", json={
            "charts": [{"epic": "US100", "resolution": "DAY"}],
            "families": [{"family": "double", "params": {"bogus": 1}}],
        })
        assert r.status_code == 400 and "bogus" in r.json()["detail"]

    def test_user_preset_scanned_via_similarity(self, monkeypatch):
        install_series(monkeypatch, {("US100", "MINUTE_5"): fake_series(DOUBLE_TOP)})
        created = client.post("/api/patterns/presets", json={
            "name": "twin peaks", "epic": "EURUSD", "resolution": "WEEK",
            "bars": [{"ts": i * 60, "o": v, "h": v + 1, "l": v - 1, "c": v}
                     for i, v in enumerate(np.concatenate([
                         np.linspace(0, 20, 8), np.linspace(20, 10, 6),
                         np.linspace(10, 19.5, 8), np.linspace(19.5, 0, 8)]))],
        }).json()
        r = client.post("/api/patterns/scan", json={
            "charts": [{"epic": "US100", "resolution": "MINUTE_5"}],
            "families": [{"family": f"user:{created['id']}", "params": {}}],
        })
        assert r.status_code == 200
        assert r.json()["charts"][0]["status"] == "ok"

    def test_unknown_user_preset_is_404(self):
        r = client.post("/api/patterns/scan", json={
            "charts": [{"epic": "US100", "resolution": "DAY"}],
            "families": [{"family": "user:nope", "params": {}}],
        })
        assert r.status_code == 404


class TestPresetCrud:
    def test_roundtrip(self):
        r = client.post("/api/patterns/presets", json={
            "name": "flag", "epic": "US100", "resolution": "DAY", "bars": BARS})
        assert r.status_code == 200
        pid = r.json()["id"]
        assert any(p["id"] == pid for p in client.get("/api/patterns/presets").json()["presets"])
        assert client.patch(f"/api/patterns/presets/{pid}", json={"name": "flag2"}).status_code == 204
        assert client.delete(f"/api/patterns/presets/{pid}").status_code == 204
        assert client.delete(f"/api/patterns/presets/{pid}").status_code == 404
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && .venv/bin/python -m pytest tests/test_api_pattern_presets.py -q`
Expected: FAIL (404s — no routes). First fix the `fake_series` helper against the real `Series` dataclass fields (read `pattern_series.py:75`) — the comment in the test marks this as the one spot written blind.

- [ ] **Step 3: Implement**

Append to `schemas.py`:

```python
class PatternScanChartDTO(BaseModel):
    epic: str
    resolution: str


class PatternScanFamilyDTO(BaseModel):
    # A built-in family key or "user:<preset-id>" for a saved selection.
    family: str
    params: dict[str, float] = {}


class PatternScanRequest(BaseModel):
    charts: list[PatternScanChartDTO] = Field(min_length=1, max_length=64)
    families: list[PatternScanFamilyDTO] = Field(min_length=1, max_length=20)
    broker: str = ""
    price_side: str = Field("bid", alias="priceSide", pattern="^(bid|mid|ask)$")

    model_config = {"populate_by_name": True}


class PatternHitDTO(BaseModel):
    family: str  # "user:<id>" for user-preset hits
    variant: str  # preset name for user-preset hits
    forming: bool
    ts: int
    end_ts: int = Field(serialization_alias="endTs")
    distance: float
    direction: int  # +1 up / -1 down / 0 unknown
    breakout_up_pct: int | None = Field(None, serialization_alias="breakoutUpPct")
    target: float | None = None
    tell: str | None = None
    source: str = ""
    bars: list[PatternBarDTO]


class PatternScanChartResultDTO(BaseModel):
    epic: str
    resolution: str
    status: Literal["ok", "no-history", "too-few-bars", "error"]
    error: str | None = None
    hits: list[PatternHitDTO] = []


class PatternScanResponse(BaseModel):
    charts: list[PatternScanChartResultDTO]
    elapsed_ms: int = Field(serialization_alias="elapsedMs")

    model_config = {"populate_by_name": True}


class PatternPresetCreateBody(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    epic: str
    resolution: str
    bars: list[PatternBarDTO] = Field(min_length=3, max_length=1024)


class PatternPresetRenameBody(BaseModel):
    name: str = Field(min_length=1, max_length=80)
```

Create `routers/pattern_presets.py`:

```python
"""Preset pattern scan and user-preset CRUD. The scan walks the charts the
FRONTEND enumerates (it knows the open tabs; the server does not), reporting
per-chart status so an empty chart is never silent. Built-in families run
the pivot-grammar detector; "user:<id>" families run the shipped similarity
pipeline with the saved selection as the query."""

from __future__ import annotations

import asyncio
import time

import numpy as np
from fastapi import APIRouter, HTTPException, Request

from auto_trader.core.pattern_matchers import MATCHERS
from auto_trader.core.pattern_presets import (
    FAMILIES, PARAM_SCHEMAS, Hit, resolve_params, scan_series,
)
from auto_trader.core.pattern_preset_store import PRESET_STORE
from auto_trader.core.pattern_series import PATTERN_SERIES

from .. import deps
from ..schemas import (
    PatternBarDTO, PatternHitDTO, PatternPresetCreateBody,
    PatternPresetRenameBody, PatternScanChartResultDTO, PatternScanRequest,
    PatternScanResponse,
)
from .patterns import _bars, _search_mode

router = APIRouter()

_TITLES = {"hns": "Head & Shoulders", "double": "Double Top / Bottom",
           "broadening": "Broadening / Megaphone", "triangle": "Triangles & Wedges"}
# One scan at a time, like backtests and sweeps: a second request while one
# runs is a client bug or an impatient double-click, not a queueing need.
_scan_lock = asyncio.Lock()

# How near the live edge a similarity hit must end to badge as forming, and
# how many matches per chart a user preset reports.
_EDGE_BARS = 2
_USER_TOP_K = 3
_USER_MAX_DISTANCE = 1.6


@router.get("/api/patterns/families")
async def list_families() -> dict:
    return {"families": [
        {"family": f, "title": _TITLES[f], "params": PARAM_SCHEMAS[f]}
        for f in FAMILIES
    ]}


def _hit_dto(h: Hit, series, offset: float) -> PatternHitDTO:
    inst = h.instance
    rows = _bars(series, inst.start, inst.end - inst.start + 1, offset)
    return PatternHitDTO(
        family=inst.family, variant=inst.variant, forming=inst.forming,
        ts=rows[0].ts, end_ts=rows[-1].ts, distance=h.distance,
        direction=inst.direction, breakout_up_pct=h.breakout_up_pct,
        # scan_series ran on UN-centred prices, so the target is already at
        # real price level — do not add the offset again.
        target=h.target,
        tell=inst.tell, source=h.source, bars=rows,
    )


async def _scan_chart(broker: str, side: str, epic: str, resolution: str,
                      builtins: list[tuple[str, dict]],
                      presets: list[dict]) -> PatternScanChartResultDTO:
    series = await PATTERN_SERIES.get(broker, epic, resolution, side)
    if series is None:
        return PatternScanChartResultDTO(epic=epic, resolution=resolution,
                                         status="no-history")
    if series.bars < 30:
        return PatternScanChartResultDTO(epic=epic, resolution=resolution,
                                         status="too-few-bars")
    hits: list[PatternHitDTO] = []
    if builtins:
        raw = await asyncio.to_thread(scan_series, series.ohlc + series.offset, builtins)
        hits += [_hit_dto(h, series, series.offset) for h in raw]
    for preset in presets:
        query = np.array([[b["o"], b["h"], b["l"], b["c"]] for b in preset["bars"]],
                         dtype=np.float64)
        if len(query) > series.bars or query[:, 3].std() <= 1e-12:
            continue
        span = float(preset["bars"][-1]["ts"] - preset["bars"][0]["ts"])
        found, _ = await asyncio.to_thread(
            _search_mode, MATCHERS["shape"], series, query,
            query_span=span, top_k=_USER_TOP_K, forward_bars=0,
        )
        for m in found:
            if m.distance > _USER_MAX_DISTANCE:
                continue
            rows = _bars(series, m.start, m.length, series.offset)
            forming = m.start + m.length >= series.bars - _EDGE_BARS
            hits.append(PatternHitDTO(
                family=f"user:{preset['id']}", variant=preset["name"],
                forming=forming, ts=rows[0].ts, end_ts=rows[-1].ts,
                distance=m.distance, direction=0, bars=rows,
            ))
    hits.sort(key=lambda h: (not h.forming, h.ts))
    return PatternScanChartResultDTO(epic=epic, resolution=resolution,
                                     status="ok", hits=hits)


@router.post("/api/patterns/scan", response_model=PatternScanResponse)
async def scan_patterns(req: PatternScanRequest, request: Request) -> PatternScanResponse:
    t0 = time.perf_counter()
    broker = deps.resolve_broker(request, req.broker)
    user = deps.current_user(request)

    builtins: list[tuple[str, dict]] = []
    presets: list[dict] = []
    for fam in req.families:
        if fam.family.startswith("user:"):
            preset = await PRESET_STORE.get(user, fam.family[5:])
            if preset is None:
                raise HTTPException(404, f"no saved preset '{fam.family[5:]}'")
            presets.append(preset)
        else:
            try:
                builtins.append((fam.family, resolve_params(fam.family, fam.params)))
            except ValueError as e:
                raise HTTPException(400, str(e))

    if _scan_lock.locked():
        raise HTTPException(409, "a pattern scan is already running")
    async with _scan_lock:
        # Bounded concurrency: cold series loads hit sqlite; four at a time
        # matches the frontend's own similarity fan-out pool.
        sem = asyncio.Semaphore(4)

        async def one(c) -> PatternScanChartResultDTO:
            async with sem:
                try:
                    return await _scan_chart(broker, req.price_side,
                                             c.epic, c.resolution, builtins, presets)
                except Exception as e:  # one bad chart must not kill the sweep
                    return PatternScanChartResultDTO(
                        epic=c.epic, resolution=c.resolution,
                        status="error", error=str(e))

        charts = await asyncio.gather(*(one(c) for c in req.charts))
    return PatternScanResponse(charts=list(charts),
                               elapsed_ms=int((time.perf_counter() - t0) * 1000))


@router.get("/api/patterns/presets")
async def list_presets(request: Request) -> dict:
    return {"presets": await PRESET_STORE.list(deps.current_user(request))}


@router.post("/api/patterns/presets")
async def create_preset(request: Request, body: PatternPresetCreateBody) -> dict:
    return await PRESET_STORE.create(
        deps.current_user(request), body.name, body.epic, body.resolution,
        [b.model_dump() for b in body.bars],
    )


@router.patch("/api/patterns/presets/{preset_id}", status_code=204)
async def rename_preset(request: Request, preset_id: str,
                        body: PatternPresetRenameBody) -> None:
    if not await PRESET_STORE.rename(deps.current_user(request), preset_id, body.name):
        raise HTTPException(404, "no such preset")


@router.delete("/api/patterns/presets/{preset_id}", status_code=204)
async def delete_preset(request: Request, preset_id: str) -> None:
    if not await PRESET_STORE.delete(deps.current_user(request), preset_id):
        raise HTTPException(404, "no such preset")
```

In `app.py`: add `pattern_presets` to the routers import and to the module tuple at ~line 218.

Note: `scan_series` expects RAW prices for its ATR math, hence `series.ohlc + series.offset` (the cache stores centred prices). `_search_mode` expects the centred series, which is what it gets.

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && .venv/bin/python -m pytest tests/test_api_pattern_presets.py tests/test_api_patterns.py -q`
Expected: PASS, including the pre-existing patterns API tests (import of `_bars`/`_search_mode` must not break them).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/schemas.py backend/auto_trader/api/routers/pattern_presets.py backend/auto_trader/api/app.py backend/tests/test_api_pattern_presets.py
git commit -m "feat(patterns): /api/patterns/scan, families manifest, preset CRUD"
```

---

### Task 9: Probe script

**Files:**
- Create: `backend/scripts/pattern_scan_probe.py`

**Interfaces:**
- Consumes: the HTTP endpoints from Task 8 (over the running server — this is an end-to-end probe, styled after `scripts/alert_probe.py`; read that file's argparse/output idiom first).

- [ ] **Step 1: Implement** (probes have no unit tests; the running server is the test)

```python
# backend/scripts/pattern_scan_probe.py
"""End-to-end probe for the preset pattern scan: fetch the families
manifest, scan the given charts, print per-chart results.

Usage: cd backend && python3 -m scripts.pattern_scan_probe \
  --chart US100:DAY --chart EURUSD:WEEK [--family broadening] [--url URL]
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request


def req(url: str, payload: dict | None = None) -> dict:
    data = json.dumps(payload).encode() if payload is not None else None
    r = urllib.request.Request(url, data=data,
                               headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(r, timeout=120) as resp:
        return json.loads(resp.read())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:8000")
    ap.add_argument("--chart", action="append", required=True,
                    help="EPIC:RESOLUTION, repeatable")
    ap.add_argument("--family", action="append", default=None,
                    help="family key (default: all built-ins)")
    args = ap.parse_args()

    manifest = req(f"{args.url}/api/patterns/families")["families"]
    fams = args.family or [f["family"] for f in manifest]
    print(f"families: {', '.join(fams)}")

    charts = []
    for c in args.chart:
        epic, _, resolution = c.partition(":")
        charts.append({"epic": epic, "resolution": resolution})
    out = req(f"{args.url}/api/patterns/scan", {
        "charts": charts, "families": [{"family": f, "params": {}} for f in fams],
    })
    for chart in out["charts"]:
        head = f"{chart['epic']} {chart['resolution']}: {chart['status']}"
        print(head if chart["status"] == "ok" else head + f" {chart.get('error') or ''}")
        for h in chart.get("hits", []):
            state = "forming" if h["forming"] else "completed"
            print(f"  {h['family']}/{h['variant']} [{state}] "
                  f"ts={h['ts']}..{h['endTs']} dist={h['distance']:.3f}")
    print(f"elapsed {out['elapsedMs']} ms")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Verify against the live server**

Run: `cd backend && python3 -m scripts.pattern_scan_probe --chart US100:DAY`
Expected: a families line, then per-chart output (status `ok` with hits, or a clean `no-history`). If the dev server isn't running, note that in the report and verify with `.venv/bin/python -m pytest tests/test_api_pattern_presets.py -q` instead.

- [ ] **Step 3: Commit**

```bash
git add backend/scripts/pattern_scan_probe.py
git commit -m "feat(patterns): pattern scan end-to-end probe"
```

---

### Task 10: Frontend API layer (`lib/presetScan.ts`)

**Files:**
- Create: `frontend/src/lib/presetScan.ts`
- Create: `frontend/src/lib/presetScan.test.ts`

**Interfaces:**
- Consumes: whatever HTTP helper `lib/patternSearch.ts` uses (read its `searchPatterns` — reuse the same fetch/error idiom and base-URL handling exactly).
- Produces (types mirror the Task 8 DTOs, camelCase):

```ts
export interface PresetParamSchema { name: string; type: "float" | "int"; min: number; max: number; default: number; help: string; }
export interface PresetFamily { family: string; title: string; params: PresetParamSchema[]; }
export interface PresetHit { family: string; variant: string; forming: boolean; ts: number; endTs: number; distance: number; direction: number; breakoutUpPct: number | null; target: number | null; tell: string | null; source: string; bars: PatternBar[]; }
export interface PresetChartResult { epic: string; resolution: string; status: "ok" | "no-history" | "too-few-bars" | "error"; error: string | null; hits: PresetHit[]; }
export interface PresetScanResult { charts: PresetChartResult[]; elapsedMs: number; }
export interface UserPreset { id: string; name: string; epic: string; resolution: string; bars: PatternBar[]; created_at: number; }
export async function fetchFamilies(): Promise<PresetFamily[]>
export async function runPresetScan(req: { charts: {epic: string; resolution: string}[]; families: {family: string; params: Record<string, number>}[]; broker: string; priceSide: string }): Promise<PresetScanResult>
export async function listUserPresets(): Promise<UserPreset[]>
export async function createUserPreset(p: { name: string; epic: string; resolution: string; bars: PatternBar[] }): Promise<UserPreset>
export async function renameUserPreset(id: string, name: string): Promise<void>
export async function deleteUserPreset(id: string): Promise<void>
```

- [ ] **Step 1: Write failing tests** — follow `lib/patternSearch.test.ts`'s fetch-mocking idiom (read it first; mirror how it stubs `fetch` and asserts request bodies). Cover: `fetchFamilies` parses the manifest; `runPresetScan` POSTs the exact body and surfaces a non-OK response as a thrown Error with the server's detail; CRUD helpers hit the right method/URL.

- [ ] **Step 2: Run** `cd frontend && npx vitest run src/lib/presetScan.test.ts` — expected FAIL (module missing).

- [ ] **Step 3: Implement** `presetScan.ts` with the interface above, copying `patternSearch.ts`'s fetch/error-handling pattern function-for-function.

- [ ] **Step 4: Run to verify pass** — same command, PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/presetScan.ts frontend/src/lib/presetScan.test.ts
git commit -m "feat(patterns): frontend API layer for preset scan"
```

---

### Task 11: Store — panel open/view state, preset scan state, arm bridge

**Files:**
- Modify: `frontend/src/lib/patternPanelStore.ts`
- Modify: `frontend/src/lib/patternPanelStore.test.ts` (extend)

**Interfaces:**
- Consumes: Task 10's `runPresetScan`, `fetchFamilies`, `listUserPresets`, `createUserPreset`, `renameUserPreset`, `deleteUserPreset`.
- Produces (added to the store; existing exports unchanged):

```ts
export type PatternView = "similar" | "presets";
// PatternPanelState gains:
//   open: boolean; view: PatternView;
//   families: PresetFamily[] | null;      // manifest, fetched once on open
//   userPresets: UserPreset[] | null;
//   selectedFamilies: string[];           // family keys + "user:<id>"
//   paramsByFamily: Record<string, Record<string, number>>;  // overrides only
//   presetResult: PresetScanResult | null; presetLoading: boolean; presetError: string | null;
//   selectArmed: boolean;                 // mirrored from the active controller
export function openPatternPanel(): void   // sets open, lazily fetches families+presets
export function closePatternPanel(): void  // open=false; results SURVIVE (dismiss still clears)
export function togglePatternPanel(): void
export function setPatternView(v: PatternView): void
export function toggleFamily(key: string): void
export function setFamilyParam(family: string, name: string, value: number): void
export function runPresetScanNow(broker: string, priceSide: string): void
  // charts from the existing seriesProvider() deduped by epic|resolution;
  // one in flight: ignore while presetLoading
export function savePresetFromLastRun(name: string): Promise<UserPreset | null>
  // null (with presetError set) when there is no lastRun to save
export function refreshUserPresets(): Promise<void>
export function setPatternArmProvider(fn: (() => void) | null): void
export function armPatternSelect(): void   // calls the provider if registered
export function setPatternSelectArmed(v: boolean): void  // Toolbar mirrors the signal
```

- `dismissPatternPanel` keeps its meaning (clears the SIMILAR result); it must NOT clear preset state. `resetPatternPanel` resets everything new too.

- [ ] **Step 1: Write failing tests** (append to `patternPanelStore.test.ts`, using its existing setup/reset idiom and mocking `./presetScan` with `vi.mock`). Cover: open/close/toggle; openPatternPanel fetches families once (second open does not refetch); toggleFamily round-trip; setFamilyParam stores overrides; runPresetScanNow builds `charts` from the registered provider deduped, passes selected families with overrides, lands result/loading/error correctly; a second runPresetScanNow while loading is ignored; savePresetFromLastRun with no lastRun resolves null and sets presetError; dismissPatternPanel leaves presetResult intact.

- [ ] **Step 2: Run** `cd frontend && npx vitest run src/lib/patternPanelStore.test.ts` — new tests FAIL.

- [ ] **Step 3: Implement** in `patternPanelStore.ts`, following the file's existing `set(patch)` + module-level pattern. `runPresetScanNow` mirrors `doRun`'s reqId-guard idiom with its own `presetReqId`. `savePresetFromLastRun` reads the module-level `lastRun` (bars + origin epic/resolution) and calls `createUserPreset`, then `refreshUserPresets`.

- [ ] **Step 4: Run to verify pass** — full file: `npx vitest run src/lib/patternPanelStore.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/patternPanelStore.ts frontend/src/lib/patternPanelStore.test.ts
git commit -m "feat(patterns): panel store gains open/view/preset-scan state"
```

---

### Task 12: Toolbar toggle + panel host restructure

**Files:**
- Modify: `frontend/src/Toolbar.tsx` (~lines 160–175 and 810–830)
- Modify: `frontend/src/WorkspacePatternPanel.tsx`
- Create: `frontend/src/PatternPanel.tsx`
- Modify: `frontend/src/App.tsx` (pass-through only if needed — WorkspacePatternPanel's props stay the same)
- Modify: `frontend/src/Toolbar.studyModes.test.tsx` or the Toolbar test covering the patterns button (find it: `grep -rln "pattern-range-toggle" frontend/src`)
- Create: `frontend/src/PatternPanel.test.tsx`

**Interfaces:**
- Consumes: Task 11's store API.
- Produces: `PatternPanel` component `({ timezone, onReveal, onJump, onCopy, onDismiss, ...similarProps })` — renders the segmented switcher (`Similar` / `Presets`), the Similar view (a "Select range on chart" button + the existing `PatternMatchesPanel` + a "Save as preset" control enabled when a similarity result exists), and mounts `PresetScanView` (Task 13 — until then a `null` placeholder component defined in `PatternPanel.tsx` and replaced in Task 13).

**Changes:**

1. **Toolbar** (~line 820): the onClick becomes `togglePatternPanel()`; the lit condition becomes the store's `open` (subscribe via `useSyncExternalStore(subscribePatternPanel, () => getPatternPanelState().open)`). Keep `disabled={!controller || !patternAvailable}` off — the panel must open even with no eligible chart (Presets view still works); instead disable only the arm action. Add a `useEffect` that registers the arm bridge and mirrors the armed signal:

```tsx
useEffect(() => {
  if (!controller) return;
  setPatternArmProvider(() => {
    controller.patternRangeMode.set("search");
    controller.patternRangeArmed.set(true);
  });
  const sync = () =>
    setPatternSelectArmed(
      controller.patternRangeArmed.value && controller.patternRangeMode.value === "search",
    );
  sync();
  const un = controller.patternRangeArmed.subscribe(sync);
  return () => { un(); setPatternArmProvider(null); };
}, [controller]);
```

2. **WorkspacePatternPanel**: render gate becomes `if (hidden) return null; if (!st.open && !st.result && !st.loading && !st.error) return null;` (legacy behavior: an in-flight drag-search still shows the panel even if the user never clicked the toolbar). It renders `<PatternPanel …/>` passing everything it passed to `PatternMatchesPanel` before, plus `timezone`/`onReveal` context it already has. The ✕ inside the Similar view keeps calling `onDismiss` (result-clearing); a new panel-level ✕ calls `closePatternPanel()`.

3. **PatternPanel.tsx**: segmented switcher at top (two gray `seg` buttons, `seg-on` for the active view — same classes the mode chips use; find them with `grep -n "seg-on" frontend/src/PatternMatchesPanel.tsx` and reuse); view === "similar" renders the select-range header + `PatternMatchesPanel`; view === "presets" renders `PresetScanView`. Select-range header:

```tsx
<button className={`anchor-btn${st.selectArmed ? " seg-on" : ""}`}
        onClick={armPatternSelect}>
  {st.selectArmed ? "drag over the pattern on the chart…" : "Select range on chart"}
</button>
```

Save-as-preset: a small button next to it, disabled unless `st.result`, opening an inline name input (local component state; Enter confirms → `savePresetFromLastRun(name)`, toast on success via `lib/notify`'s `toast`).

- [ ] **Step 1: Write failing tests** — `PatternPanel.test.tsx` (render with store preloaded via its setters: switcher switches views without dropping either result; select-range button calls the registered arm provider; save-as-preset disabled without a result) and update the Toolbar test that exercises the old arm-on-click behavior to assert the new toggle-open behavior.
- [ ] **Step 2: Run** the two test files — FAIL.
- [ ] **Step 3: Implement** as specified above.
- [ ] **Step 4: Run to verify pass**, plus the full existing pattern-panel suites: `npx vitest run src/PatternMatchesPanel.test.tsx src/WorkspacePatternPanel.test.tsx src/PatternPanel.test.tsx src/lib/patternPanelStore.test.ts` and the Toolbar test file.
- [ ] **Step 5: Commit**

```bash
git add frontend/src/Toolbar.tsx frontend/src/WorkspacePatternPanel.tsx frontend/src/PatternPanel.tsx frontend/src/PatternPanel.test.tsx frontend/src/App.tsx
# plus the modified Toolbar test file
git commit -m "feat(patterns): toolbar toggles panel; Similar/Presets switcher"
```

---

### Task 13: Presets view — cards, params, scan, results

**Files:**
- Create: `frontend/src/PresetScanView.tsx` (replaces the Task 12 placeholder; `PatternPanel.tsx` imports it)
- Create: `frontend/src/PresetScanView.test.tsx`
- Modify: the stylesheet holding the existing pattern-panel rules (find it: `grep -rln "pattern-panel\|patternPanel" frontend/src/*.css frontend/src/**/*.css` — add the new classes beside them, matching the file's variable/token usage)

**Interfaces:**
- Consumes: full store API (Task 11), `PresetHit` (Task 10), `getPatternTarget`/`listPatternTargets`/`setPendingPatternJump` (existing), `runPatternSearch` (existing, for find-similar), `InfoTip`/`Tooltip` components, `toast`.
- Produces: `PresetScanView({ timezone, onReveal })`:

1. **Family cards**: one per manifest family + a "Your presets" group from `userPresets`. Card = glyph + title, click toggles selection (`toggleFamily`), selected cards get the gray `seg-on` treatment. Built-in glyphs: tiny inline `<svg>` polylines of the archetype knot paths — define a `GLYPHS: Record<string, [number, number][]>` in the file with the same knots as the backend's ARCHETYPES (hns/top, double/top, broadening/megaphone, triangle/symmetric — one representative per family). User-preset glyphs: polyline of the saved bars' closes normalized to the viewbox. User-preset cards get rename (inline input) and delete (✕ with `toast` undo NOT required — plain delete) actions wired to `renameUserPreset`/`deleteUserPreset` + `refreshUserPresets`.
2. **Params**: for each SELECTED built-in family, a `strictness` slider always visible; a collapsed `<details className="preset-advanced">` ("Advanced") rendering every other schema param as a labeled number input (min/max/step from the schema, `help` via `InfoTip`). Values write through `setFamilyParam`.
3. **Scan button**: "Scan open charts" → `runPresetScanNow(broker, priceSide)` (broker/priceSide come from props passed down from WorkspacePatternPanel — same values the Similar view already receives). While `presetLoading` it reads "Scanning…" and is disabled (v1: no cancel — the backend scan is seconds, not minutes; note this deviation from the spec's Cancel in the final report).
4. **Results**: grouped by chart. Group header `EPIC · resolution (n)`; non-ok charts render one muted line (`no stored history`, `too few bars`, or the error). Hit rows: forming/completed badge (forming first — backend pre-sorts; keep order), `variant` title + family label, date range (reuse the `stamp`/`day` helpers' approach from `PatternMatchesPanel.tsx` — extract or duplicate the two tiny functions), stats line (`breakoutUpPct != null` → "NN% up"; `target != null` → "→ NNNN.N"; `tell` → "partial decline → up 80%" with an `InfoTip` citing `source`), distance to 2 decimals.
5. **Row actions**: click → jump: adapt the hit to the `PatternMatch` shape (`{ts, endTs: hit.endTs, distance: hit.distance, bars: hit.bars, forward: [], forwardComplete: false, forwardPct: null, source: {cellId: "", epic, resolution, label: resolution}}`) and reuse the exact jump logic from `WorkspacePatternPanel.onJump` — refactor that function out of the component into an exported `jumpToMatch(m: PatternMatch, onReveal)` in `WorkspacePatternPanel.tsx` and call it from both places. "Find similar" button → `runPatternSearch({origin: {cellId: "", epic, resolution, label: resolution}, broker, priceSide, bars: hit.bars, range: {fromMs: hit.ts * 1000, toMs: hit.endTs * 1000}})` then `setPatternView("similar")`.

- [ ] **Step 1: Write failing tests** — `PresetScanView.test.tsx`: family card toggle updates store; advanced expander renders schema params with defaults; scan button disabled while loading; results render grouped with forming badge first and no-history warning lines; find-similar switches view and calls `runPatternSearch` (mock it); jump path calls `jumpToMatch` (mock).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** as specified. CSS: badge (`preset-badge-forming` amber text on transparent, `preset-badge-done` muted gray), card grid, glyph sizing — all colors from the stylesheet's existing tokens/variables, both themes (check how the file handles dark mode and follow it).
- [ ] **Step 4: Run to verify pass** plus every pattern test file: `npx vitest run src/PresetScanView.test.tsx src/PatternPanel.test.tsx src/PatternMatchesPanel.test.tsx src/WorkspacePatternPanel.test.tsx src/lib/patternPanelStore.test.ts src/lib/presetScan.test.ts`.
- [ ] **Step 5: Commit**

```bash
git add frontend/src/PresetScanView.tsx frontend/src/PresetScanView.test.tsx frontend/src/PatternPanel.tsx frontend/src/WorkspacePatternPanel.tsx
# plus the modified CSS file
git commit -m "feat(patterns): preset scan view - cards, params, results"
```

---

### Task 14: Full-suite validation and live check

**Files:** none created; fixes only if suites fail.

- [ ] **Step 1: Backend full suite**

Run: `cd backend && .venv/bin/python -m pytest -q`
Expected: everything green, including all pre-existing pattern tests (`test_pattern_shape.py`, `test_api_patterns.py`, `scripts/pattern_bench` untouched).

- [ ] **Step 2: Bench regression canary**

Run: `cd backend && python3 -m scripts.pattern_bench` (needs `candle_history.db`; skip with a note if absent).
Expected: identical numbers to the last committed run — this feature adds code, it must not touch similarity ranking.

- [ ] **Step 3: Frontend full suite + typecheck**

Run: `cd frontend && npx vitest run && npx tsc --noEmit`
Expected: green.

- [ ] **Step 4: Live smoke via probe**

With the dev server running: `cd backend && python3 -m scripts.pattern_scan_probe --chart US100:DAY --chart EURUSD:WEEK`
Expected: per-chart hits or clean statuses. Then (reported to the user, not automated): open http://localhost:5173, click Patterns — panel opens; run a preset scan over the open charts.

- [ ] **Step 5: Commit any fixes; final commit if working tree has plan-related strays**

```bash
git add <explicit paths of any fixes>
git commit -m "fix(patterns): full-suite fixes for preset scan"
```

---

## Deviations & judgment calls encoded above

- No scan Cancel button in v1 (spec said the button becomes Cancel): the backend scan is bounded (≤64 charts, grammar over pivots) and finishes in seconds; a cancel path would add an abort protocol for no real wait. Report this to the user at the end.
- Per-chart progress line dropped for the same reason: one response, seconds of latency.
- A pattern that neither breaks out nor sits at the live edge (it dissolved) is not reported — completed means resolved-by-break, forming means open-at-edge. This is in the spec's spirit (forming/completed badges) and keeps result quality high.
- `PARAM_SCHEMAS["triangle"]` aliases the broadening schema (same engine, same knobs).
- Forming = ALL defining pivots confirmed + no break yet, not the spec's looser "grammar prefix satisfied" (e.g. an H&S with the right shoulder still unconfirmed is not reported). Prefix matching multiplies false positives at the live edge; tightening is the safer v1 default, and the spec's forming/completed badge semantics still hold. Report this to the user.
