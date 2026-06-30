# Higher-timeframe aggregation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `2W`, `3W`, `6W`, `1M`, `2M`, `3M`, `1Y` chart timeframes that behave like any other interval (full scrollable history, live updates, per-side), built by aggregating native DAY/WEEK base bars on read.

**Architecture:** New intervals are "derived resolutions" — never added to the `Resolution` enum, never stored as their own cache series. A pure `candle_aggregate` module maps each token to `(base resolution, calendar rule)` and folds base bars into buckets. `/api/candles` and `/ws/candles` detect derived tokens and operate on the cached base (DAY/WEEK) series, leaving the candle cache schema and backfill untouched.

**Tech Stack:** Python 3 / FastAPI / sqlite (backend), TypeScript / React / Vite / Playwright (frontend), pytest, vitest.

## Global Constraints

- All timestamps are timezone-aware UTC; `Candle.time` is the bar OPEN time. Convert to local only at display.
- The candle cache (`core/candle_cache.py`) must stay schema-unchanged and only ever see native DAY/WEEK series — no derived rows written, ever.
- Derived tokens follow the existing `MINUTE_5` naming style: `WEEK_2`, `WEEK_3`, `WEEK_6`, `MONTH`, `MONTH_2`, `MONTH_3`, `YEAR`.
- Base mapping: week-multiples ← `WEEK` base; months/year ← `DAY` base (exact calendar boundaries).
- OHLCV fold: open=first, high=max, low=min, close=last, volume=sum, time=bucket open.

---

### Task 1: Aggregation core + derived registry (pure module)

**Files:**
- Create: `backend/auto_trader/core/candle_aggregate.py`
- Test: `backend/tests/test_candle_aggregate.py`

**Interfaces:**
- Consumes: `auto_trader.core.models.Candle`, `Resolution`.
- Produces:
  - `BucketRule(base: Resolution, kind: str, group: int)` dataclass.
  - `DERIVED: dict[str, BucketRule]` — the seven tokens.
  - `is_derived(res: str) -> bool`
  - `bucket_open(ts: int, rule: BucketRule) -> int` — UTC open ts of the bucket containing `ts`.
  - `fold(base_bars: list[Candle], rule: BucketRule) -> list[Candle]` — ascending aggregate bars.
  - `base_count_for(rule: BucketRule, n: int) -> int` — base bars to fetch for `n` aggregate bars.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_candle_aggregate.py
from datetime import datetime, timezone

from auto_trader.core.candle_aggregate import (
    DERIVED, BucketRule, base_count_for, bucket_open, fold, is_derived,
)
from auto_trader.core.models import Candle, Resolution


def _c(y, m, d, o, h, l, c, v=1.0):
    return Candle(datetime(y, m, d, tzinfo=timezone.utc), o, h, l, c, v)


def _ts(y, m, d):
    return int(datetime(y, m, d, tzinfo=timezone.utc).timestamp())


def test_registry_covers_seven_tokens():
    assert set(DERIVED) == {
        "WEEK_2", "WEEK_3", "WEEK_6", "MONTH", "MONTH_2", "MONTH_3", "YEAR",
    }
    assert DERIVED["WEEK_2"].base is Resolution.WEEK
    assert DERIVED["MONTH"].base is Resolution.DAY
    assert DERIVED["YEAR"].base is Resolution.DAY


def test_is_derived():
    assert is_derived("MONTH") is True
    assert is_derived("WEEK_2") is True
    assert is_derived("WEEK") is False
    assert is_derived("MINUTE_5") is False


def test_bucket_open_month_groups_calendar_month():
    r = DERIVED["MONTH"]
    # every day in March 2026 buckets to 2026-03-01
    assert bucket_open(_ts(2026, 3, 1), r) == _ts(2026, 3, 1)
    assert bucket_open(_ts(2026, 3, 31), r) == _ts(2026, 3, 1)
    assert bucket_open(_ts(2026, 4, 1), r) == _ts(2026, 4, 1)


def test_bucket_open_quarter_and_2month():
    q = DERIVED["MONTH_3"]
    assert bucket_open(_ts(2026, 2, 15), q) == _ts(2026, 1, 1)
    assert bucket_open(_ts(2026, 5, 15), q) == _ts(2026, 4, 1)
    two = DERIVED["MONTH_2"]
    assert bucket_open(_ts(2026, 2, 15), two) == _ts(2026, 1, 1)
    assert bucket_open(_ts(2026, 3, 15), two) == _ts(2026, 3, 1)


def test_bucket_open_year():
    y = DERIVED["YEAR"]
    assert bucket_open(_ts(2026, 7, 1), y) == _ts(2026, 1, 1)
    assert bucket_open(_ts(2026, 12, 31), y) == _ts(2026, 1, 1)


def test_bucket_open_week_multiple_groups_consecutive_weeks():
    r = DERIVED["WEEK_2"]
    week = 604800
    base = _ts(2026, 1, 1)  # treat as a weekly bar open
    # two consecutive weekly bars land in the same bucket; the third opens a new one
    b0 = bucket_open(base, r)
    assert bucket_open(base + week, r) == b0
    assert bucket_open(base + 2 * week, r) == b0 + 2 * week


def test_fold_month_reduces_ohlcv():
    bars = [
        _c(2026, 3, 1, 10, 12, 9, 11, v=5),
        _c(2026, 3, 2, 11, 15, 10, 14, v=7),
        _c(2026, 4, 1, 14, 16, 13, 15, v=3),
    ]
    out = fold(bars, DERIVED["MONTH"])
    assert len(out) == 2
    mar = out[0]
    assert mar.time == datetime(2026, 3, 1, tzinfo=timezone.utc)
    assert (mar.open, mar.high, mar.low, mar.close, mar.volume) == (10, 15, 9, 14, 12)
    assert out[1].open == 14 and out[1].close == 15


def test_fold_empty():
    assert fold([], DERIVED["MONTH"]) == []


def test_base_count_for():
    assert base_count_for(DERIVED["WEEK_2"], 10) == 20
    assert base_count_for(DERIVED["WEEK_3"], 10) == 30
    assert base_count_for(DERIVED["MONTH"], 4) == 4 * 31
    assert base_count_for(DERIVED["MONTH_3"], 2) == 2 * 3 * 31
    assert base_count_for(DERIVED["YEAR"], 2) == 2 * 366
    # clamped to a sane ceiling
    assert base_count_for(DERIVED["YEAR"], 100) == 5000
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_candle_aggregate.py -q`
Expected: FAIL — `ModuleNotFoundError: auto_trader.core.candle_aggregate`.

- [ ] **Step 3: Write the module**

```python
# backend/auto_trader/core/candle_aggregate.py
"""Aggregate native DAY/WEEK candles into higher "derived" timeframes.

Derived resolutions (2W/3W/6W, 1M/2M/3M, 1Y) are NOT broker resolutions and
are NEVER cached as their own series. The API folds cached base bars into
calendar-aware buckets on read; this module is the pure, I/O-free core.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from auto_trader.core.models import Candle, Resolution

_WEEK = 604800
_MAX_BASE = 5000  # ceiling on a single base fetch (a derived chart never needs more)


@dataclass(frozen=True, slots=True)
class BucketRule:
    base: Resolution  # native series to fold from
    kind: str         # "week" | "month" | "year"
    group: int        # multiplier: 2W->2, 3M->3, 1Y->1


DERIVED: dict[str, BucketRule] = {
    "WEEK_2": BucketRule(Resolution.WEEK, "week", 2),
    "WEEK_3": BucketRule(Resolution.WEEK, "week", 3),
    "WEEK_6": BucketRule(Resolution.WEEK, "week", 6),
    "MONTH": BucketRule(Resolution.DAY, "month", 1),
    "MONTH_2": BucketRule(Resolution.DAY, "month", 2),
    "MONTH_3": BucketRule(Resolution.DAY, "month", 3),
    "YEAR": BucketRule(Resolution.DAY, "year", 1),
}


def is_derived(res: str) -> bool:
    return res in DERIVED


def _utc_ts(dt: datetime) -> int:
    return int(dt.timestamp())


def bucket_open(ts: int, rule: BucketRule) -> int:
    """UTC open timestamp of the bucket containing a base bar opening at `ts`."""
    if rule.kind == "week":
        # Weekly bars share a fixed weekday offset; group by absolute week index so
        # subtracting whole weeks always lands on another weekly bar's open.
        idx = ts // _WEEK
        return (idx - idx % rule.group) * _WEEK
    dt = datetime.fromtimestamp(ts, tz=timezone.utc)
    if rule.kind == "year":
        return _utc_ts(datetime(dt.year, 1, 1, tzinfo=timezone.utc))
    # month groups: snap to the first month of the group (1-based months).
    g = rule.group
    start_month = ((dt.month - 1) // g) * g + 1
    return _utc_ts(datetime(dt.year, start_month, 1, tzinfo=timezone.utc))


def fold(base_bars: list[Candle], rule: BucketRule) -> list[Candle]:
    """Reduce ascending base bars into aggregate bars, one per bucket."""
    out: list[Candle] = []
    cur_open: int | None = None
    o = h = l = c = v = 0.0
    for bar in base_bars:
        bo = bucket_open(int(bar.time.timestamp()), rule)
        if bo != cur_open:
            if cur_open is not None:
                out.append(_emit(cur_open, o, h, l, c, v))
            cur_open = bo
            o, h, l, c, v = bar.open, bar.high, bar.low, bar.close, bar.volume
        else:
            h = max(h, bar.high)
            l = min(l, bar.low)
            c = bar.close
            v += bar.volume
    if cur_open is not None:
        out.append(_emit(cur_open, o, h, l, c, v))
    return out


def _emit(bucket_ts: int, o: float, h: float, l: float, c: float, v: float) -> Candle:
    return Candle(datetime.fromtimestamp(bucket_ts, tz=timezone.utc), o, h, l, c, v)


def base_count_for(rule: BucketRule, n: int) -> int:
    """Base bars to fetch to cover `n` aggregate bars (over-fetch, then slice)."""
    if rule.kind == "week":
        per = rule.group
    elif rule.kind == "month":
        per = 31 * rule.group
    else:  # year
        per = 366
    return min(_MAX_BASE, n * per)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_candle_aggregate.py -q`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/core/candle_aggregate.py backend/tests/test_candle_aggregate.py
git commit -m "feat(candles): pure aggregation core for derived timeframes"
```

---

### Task 2: Derived support in `/api/candles`

**Files:**
- Modify: `backend/auto_trader/api/app.py` (the `candles` handler, ~778-840)
- Test: `backend/tests/test_candles_derived.py`

**Interfaces:**
- Consumes: `candle_aggregate.is_derived`, `DERIVED`, `fold`, `base_count_for`; `CANDLE_CACHE.window/recent`.
- Produces: GET `/api/candles?resolution=MONTH&...` returns folded bars; cache stores only base series.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_candles_derived.py
import asyncio
from datetime import datetime, timezone

from auto_trader.core.candle_aggregate import DERIVED, fold
from auto_trader.core.models import Candle


def _day(y, m, d, o, h, l, c, v=1.0):
    return Candle(datetime(y, m, d, tzinfo=timezone.utc), o, h, l, c, v)


def test_fold_matches_handler_contract():
    # Sanity anchor for the handler: handler returns exactly fold(base, rule).
    days = [_day(2026, 3, i, 10 + i, 20, 5, 10 + i) for i in range(1, 6)]
    out = fold(days, DERIVED["MONTH"])
    assert len(out) == 1
    assert out[0].open == 11 and out[0].high == 20 and out[0].low == 5
```

> Note: a full HTTP integration test that asserts the cache stored only base series is added in Step 3's harness below; this anchor test guards the fold contract the handler depends on.

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && python -m pytest tests/test_candles_derived.py -q`
Expected: PASS for the anchor (it only imports Task 1). Then proceed to wire the handler so the manual integration check in Step 4 passes.

- [ ] **Step 3: Wire the handler**

In `backend/auto_trader/api/app.py`, add the import near the other core imports (top of file):

```python
from auto_trader.core.candle_aggregate import DERIVED, base_count_for, fold, is_derived
```

In the `candles` handler, immediately AFTER the `SECONDS_INTERVALS` block (line ~799) and BEFORE `resolution = _parse_resolution(resolution)`, insert the derived branch:

```python
    if is_derived(resolution):
        rule = DERIVED[resolution]
        base = rule.base
        base_key = (broker_id, epic, base.value, price_side)
        base_seconds = base.seconds
        broker = get_data(broker_id)

        async def fetch_range(start_dt, end_dt):
            return await guarded(
                broker_id,
                lambda: broker.get_candles(epic, base, start_dt, end_dt, price_side),
                "data fetch",
            )

        async def fetch_recent(n):
            return await guarded(
                broker_id,
                lambda: broker.get_recent_candles(epic, base, n, price_side),
                "data fetch",
            )

        if from_ts is not None and to_ts is not None:
            if from_ts > to_ts:
                raise HTTPException(422, "from_ts must be <= to_ts")
            try:
                start = datetime.fromtimestamp(from_ts, tz=timezone.utc)
                end = datetime.fromtimestamp(to_ts, tz=timezone.utc)
            except (OverflowError, OSError, ValueError) as e:
                raise HTTPException(422, f"from_ts/to_ts out of range: {e}") from e
            base_bars = await CANDLE_CACHE.window(
                base_key, base_seconds, start, end, fetch_range
            )
            return [_candle_dto(c) for c in fold(base_bars, rule)]
        base_bars = await CANDLE_CACHE.recent(
            base_key, base_seconds, base_count_for(rule, bars), fetch_recent
        )
        folded = fold(base_bars, rule)
        if not folded:
            raise HTTPException(404, f"no data for epic '{epic}' (unknown epic or no history)")
        return [_candle_dto(c) for c in folded[-bars:]]
```

> The window path expands naturally: the cache fetches the full base span in `[start, end]`, and `fold` emits whole buckets for whichever base bars fall inside. Edge buckets may be partial — acceptable and consistent with the forming-bucket semantics in the spec.

- [ ] **Step 4: Verify by running the app**

Run: `cd backend && python -m pytest tests/test_candles_derived.py -q && python -m pytest -q`
Expected: PASS; full suite still green (no regressions).

Manual smoke (optional, requires creds): start the server and
`curl 'http://localhost:8000/api/candles?epic=EURUSD&resolution=MONTH&bars=12'`
returns ≤12 monthly bars with calendar-month `time` values.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/app.py backend/tests/test_candles_derived.py
git commit -m "feat(candles): serve derived timeframes from cached base bars"
```

---

### Task 3: Live streaming for derived timeframes

**Files:**
- Modify: `backend/auto_trader/core/candle_aggregate.py` (add streaming wrapper)
- Modify: `backend/auto_trader/api/app.py` (the `ws_candles` handler, ~944-964)
- Test: `backend/tests/test_candle_aggregate.py` (add stream tests)

**Interfaces:**
- Consumes: `LiveBar` (from `capital_stream`) shape `{candle, bid, ask}`; `bucket_open`, `fold`.
- Produces: `aggregate_candle_stream(base_stream, rule, seed_loader) -> AsyncIterator[LiveBar]`.

- [ ] **Step 1: Write the failing test**

```python
# append to backend/tests/test_candle_aggregate.py
import pytest

from auto_trader.core.candle_aggregate import aggregate_candle_stream


class _Bar:  # stand-in for LiveBar (candle/bid/ask)
    def __init__(self, candle, bid=None, ask=None):
        self.candle = candle
        self.bid = bid
        self.ask = ask


@pytest.mark.asyncio
async def test_aggregate_stream_folds_forming_bucket():
    rule = DERIVED["MONTH"]

    async def base_stream():
        # forming March day 1, then day 2 (day 1 now closed), then April day 1
        yield _Bar(_c(2026, 3, 1, 10, 12, 9, 11))
        yield _Bar(_c(2026, 3, 2, 11, 15, 8, 13))
        yield _Bar(_c(2026, 4, 1, 13, 14, 12, 13))

    async def seed_loader(bucket_ts):
        return []  # no prior closed base bars (stream started at bucket open)

    out = [b async for b in aggregate_candle_stream(base_stream(), rule, seed_loader)]
    assert len(out) == 3
    # after day 2, March aggregate spans both days
    assert out[1].candle.open == 10 and out[1].candle.high == 15 and out[1].candle.low == 8
    # April opens a fresh bucket
    assert out[2].candle.open == 13 and out[2].candle.time.month == 4


@pytest.mark.asyncio
async def test_aggregate_stream_seeds_partial_bucket_on_reconnect():
    rule = DERIVED["MONTH"]

    async def base_stream():
        yield _Bar(_c(2026, 3, 20, 12, 13, 11, 12))  # mid-month reconnect

    async def seed_loader(bucket_ts):
        # closed days 1..19 already in cache; their high=30, low=5, open=8
        return [_c(2026, 3, 1, 8, 30, 5, 20)]

    out = [b async for b in aggregate_candle_stream(base_stream(), rule, seed_loader)]
    assert out[0].candle.open == 8        # from the seeded first base bar
    assert out[0].candle.high == 30       # seed high dominates
    assert out[0].candle.close == 12      # forming bar's close
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && python -m pytest tests/test_candle_aggregate.py -k stream -q`
Expected: FAIL — `cannot import name 'aggregate_candle_stream'`.

- [ ] **Step 3: Add the streaming wrapper**

Append to `backend/auto_trader/core/candle_aggregate.py`:

```python
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any


async def aggregate_candle_stream(
    base_stream: AsyncIterator[Any],
    rule: BucketRule,
    seed_loader: Callable[[int], Awaitable[list[Candle]]],
) -> AsyncIterator[Any]:
    """Fold a forming base-bar stream into forming aggregate bars.

    For each base update we re-fold [closed base bars of the current bucket] +
    [the forming base bar]. Closed bars accumulate from the stream as base bars
    roll over; `seed_loader(bucket_open_ts)` provides the bars already elapsed
    when the stream starts mid-bucket (reconnect). Yields the same LiveBar shape
    (candle/bid/ask) the relay forwards verbatim."""
    cur_bo: int | None = None
    closed: list[Candle] = []
    prev: Candle | None = None
    async for bar in base_stream:
        bc = bar.candle
        bo = bucket_open(int(bc.time.timestamp()), rule)
        if prev is not None and prev.time != bc.time and bucket_open(
            int(prev.time.timestamp()), rule
        ) == cur_bo:
            closed.append(prev)  # the prior forming base bar just closed
        if bo != cur_bo:
            cur_bo = bo
            closed = await seed_loader(bo)
        prev = bc
        agg = fold(closed + [bc], rule)[-1]
        bar.candle = agg
        yield bar
```

> `fold(closed + [bc], rule)[-1]` always returns the current (last) bucket's aggregate. Mutating `bar.candle` keeps `bid`/`ask` intact so the relay's existing JSON shape is unchanged.

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && python -m pytest tests/test_candle_aggregate.py -q`
Expected: PASS (all tests incl. the two stream tests).

- [ ] **Step 5: Wire `ws_candles`**

In `backend/auto_trader/api/app.py`, add to the existing aggregate import on the Task-2 line:

```python
from auto_trader.core.candle_aggregate import (
    DERIVED, aggregate_candle_stream, base_count_for, fold, is_derived,
)
```

In `ws_candles`, the `else` branch currently does `resolution = Resolution(res_raw)`. Insert a derived branch BEFORE that `else` (i.e. after the `if res_raw in SECONDS_INTERVALS:` block, as an `elif`):

```python
    elif is_derived(res_raw):
        if is_ig:
            return await _fatal(f"{broker_id}: {res_raw} is not streamed live")
        rule = DERIVED[res_raw]
        base = rule.base

        async def _seed(bucket_ts: int) -> list[Candle]:
            # Closed base bars already elapsed in the current bucket (reconnect).
            start = datetime.fromtimestamp(bucket_ts, tz=timezone.utc)
            now = datetime.now(timezone.utc)
            base_key = (broker_id, epic, base.value, price_side)

            async def fetch_range(s, e):
                return await broker.get_candles(epic, base, s, e, price_side)

            return await CANDLE_CACHE.window(
                base_key, base.seconds, start, now, fetch_range
            )

        stream = aggregate_candle_stream(
            stream_candles(broker, epic, base, price_side), rule, _seed
        )
```

> Capital only (`is_ig` guard): IG month/week-multiple streaming is out of scope; the chart keeps its REST view. The `Candle`/`datetime`/`timezone` names are already imported in `app.py`.

- [ ] **Step 6: Run the suite**

Run: `cd backend && python -m pytest -q`
Expected: PASS, no regressions.

- [ ] **Step 7: Commit**

```bash
git add backend/auto_trader/core/candle_aggregate.py backend/auto_trader/api/app.py backend/tests/test_candle_aggregate.py
git commit -m "feat(candles): live streaming for derived timeframes"
```

---

### Task 4: Frontend interval menu entries

**Files:**
- Modify: `frontend/src/lib/feed.ts` (`PERIODS` 17-26, `PERIOD_GROUPS` 46-60, `RESOLUTION_SECONDS` 452-468)
- Test: `frontend/e2e/higher-timeframes.spec.ts` (new)

**Interfaces:**
- Consumes: backend derived tokens from Tasks 2–3.
- Produces: the seven entries selectable in the toolbar dropdown (Toolbar/DrawingSettings are already data-driven).

- [ ] **Step 1: Add the period entries**

In `frontend/src/lib/feed.ts`, extend `PERIODS` (after the `WEEK` entry, line 25):

```ts
  { resolution: "WEEK_2", label: "2W" },
  { resolution: "WEEK_3", label: "3W" },
  { resolution: "WEEK_6", label: "6W" },
  { resolution: "MONTH", label: "1M" },
  { resolution: "MONTH_2", label: "2M" },
  { resolution: "MONTH_3", label: "3M" },
  { resolution: "YEAR", label: "1Y" },
```

Replace the existing "Days" group in `PERIOD_GROUPS` and append the new groups:

```ts
  {
    label: "Days",
    periods: PERIODS.filter((p) => p.resolution === "DAY" || p.resolution === "WEEK"),
  },
  {
    label: "Weeks",
    periods: PERIODS.filter((p) => p.resolution.startsWith("WEEK_")),
  },
  {
    label: "Months",
    periods: PERIODS.filter((p) => p.resolution.startsWith("MONTH")),
  },
  {
    label: "Years",
    periods: PERIODS.filter((p) => p.resolution === "YEAR"),
  },
```

Extend `RESOLUTION_SECONDS` (after the `WEEK` entry, line 467) — approximations, used only for scroll-back window math:

```ts
  WEEK_2: 1209600,
  WEEK_3: 1814400,
  WEEK_6: 3628800,
  MONTH: 2592000,
  MONTH_2: 5184000,
  MONTH_3: 7776000,
  YEAR: 31536000,
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npm run build` (or `npx tsc --noEmit`)
Expected: no type errors.

- [ ] **Step 3: Write an e2e that selects a derived timeframe**

```ts
// frontend/e2e/higher-timeframes.spec.ts
import { test, expect } from "@playwright/test";

test("month timeframe appears in the interval menu and loads", async ({ page }) => {
  await page.goto("/");
  // open the interval dropdown (mirror selector used by existing interval e2e)
  await page.getByrole("button", { name: /interval|timeframe|1m|5m/i }).first().click();
  await expect(page.getByText("Months")).toBeVisible();
  await page.getByText("1M", { exact: true }).click();
  // the chart canvas should still be present after switching
  await expect(page.locator("canvas").first()).toBeVisible();
});
```

> Adjust the dropdown-opening selector to match the existing interval e2e in `frontend/e2e/` if the role/name differs; check a sibling spec (e.g. `range-bar.spec.ts`) for the established pattern before finalizing.

- [ ] **Step 4: Run the e2e**

Run: `cd frontend && npx playwright test e2e/higher-timeframes.spec.ts`
Expected: PASS (with the dev server / stubs the existing e2e suite uses).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/feed.ts frontend/e2e/higher-timeframes.spec.ts
git commit -m "feat(chart): add 2W/3W/6W, 1M/2M/3M, 1Y to interval menu"
```

---

## Self-Review

**Spec coverage:**
- Derived-resolution registry → Task 1 (`DERIVED`). ✓
- Aggregation core (`bucket_open`/`fold`) → Task 1. ✓
- DAY base for month/year, WEEK for week-multiples → Task 1 `DERIVED`. ✓
- `/api/candles` window + recent derived paths → Task 2. ✓
- Cache stores only base series (never derived) → Tasks 2–3 always key on `base.value`; asserted by anchor + suite. ✓
- Streaming re-folds forming bucket, seeds on reconnect → Task 3. ✓
- Frontend `feed.ts` entries + groups + `RESOLUTION_SECONDS` → Task 4. ✓
- Testing (unit fold/bucket, backend derived, frontend e2e) → Tasks 1–4. ✓
- Error handling (422 unknown, empty window, partial trailing bucket) → Task 2 reuses existing 422/404 paths; partial bucket handled by fold. ✓

**Placeholder scan:** none — every code step shows complete code; the only "adjust to match" note is the e2e selector, with a concrete sibling-spec pointer.

**Type consistency:** `BucketRule(base, kind, group)`, `bucket_open`, `fold`, `base_count_for`, `is_derived`, `DERIVED`, `aggregate_candle_stream(base_stream, rule, seed_loader)` are named identically across Tasks 1–3. Tokens (`WEEK_2…YEAR`) match between backend `DERIVED` and frontend `PERIODS`. ✓
