# Backtest Period Scheduling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users pick a backtest period by calendar anchor (suggestion chips) and overlay a phone-alarm-style recurrence mask that gates when the strategy may trade.

**Architecture:** Two layers over the existing backtest flow. Layer 1 (calendar chips) is frontend-only — chips compute an absolute `custom` `fromMs`/`toMs` that `resolveWindow` already handles. Layer 2 (recurrence mask) adds a per-bar activity predicate: indicators still compute over the full contiguous candle stream, but the engine only opens positions on active bars and force-flats at the first inactive bar's open. Session presets resolve to a primitive `{timeOfDay, tz}` on the frontend, so the backend only ever sees primitive filters.

**Tech Stack:** Backend — Python 3, FastAPI, Pydantic, `zoneinfo`, pytest. Frontend — TypeScript, React, Vitest.

## Global Constraints

- **The mask NEVER filters the candle feed.** Indicators (EMA/SMA/RSI/AVWAP/ATR/VOL) compute over the full contiguous candle stream, exactly as today. The mask is only a per-bar activity predicate consulted inside the simulation loop. Never build a filtered candle array and compute indicators over it.
- **Weekday wire convention is JS `getDay`: 0=Sun … 6=Sat.** Backend maps Python `datetime.weekday()` (0=Mon) to this with `(dt.weekday() + 1) % 7`. Frontend uses `Date.getDay()` directly.
- **Month wire convention: 1=Jan … 12=Dec.** Frontend must `+1` JS `getMonth()` (0-based) when building/reading the wire value.
- **Time-of-day is minutes from midnight** in the mask's evaluation timezone. Clock windows are half-open `[start, end)` and support wrap (`end < start`) for overnight sessions.
- **`Candle.time` is a UTC-aware `datetime`** in the engine; `is_active` converts it to `mask.tz` via `astimezone(ZoneInfo(tz))`.
- **Old presets without a mask load as no-mask** (mask optional everywhere; absent/`enabled=False` ⇒ every bar active).
- **No `Date.now()` / `Math.random()` inside pure helpers** — pass `now` in (matches `backtestWindow.ts` style).
- Follow existing test styles: `backend/tests/test_backtest*.py`, `frontend/src/lib/backtest*.test.ts`, `frontend/src/BacktestSettingsModal.test.tsx`.
- Commit directly to `main` (no feature branch). No backward-compat/migration code beyond the optional-field default.

---

## File Structure

**Backend (new):**
- `backend/auto_trader/engine/schedule.py` — `RecurrenceMask` dataclass + `is_active(mask, dt)` pure predicate.
- `backend/tests/test_schedule.py` — predicate unit tests.

**Backend (modify):**
- `backend/auto_trader/engine/backtest.py` — `BacktestEngine.__init__` gains `mask`; `run` adds entry-gate + force-flat.
- `backend/auto_trader/api/app.py` — `RecurrenceMaskDTO`, `BacktestRequest.mask`, wire into engine, tz validation.
- `backend/tests/test_backtest.py` (or new `test_backtest_mask.py`) — engine mask behavior.
- `backend/tests/test_api_backtest.py` — DTO round-trip + validation.

**Frontend (new):**
- `frontend/src/lib/backtestSchedule.ts` — `SESSION_PRESETS`, `resolveMask`, `isActive`, `buildRangeChips`, `coverage`.
- `frontend/src/lib/backtestSchedule.test.ts` — pure-logic tests.

**Frontend (modify):**
- `frontend/src/lib/backtestConfig.ts` — `RecurrenceMask`, `DayTimeWindow`, `SessionPreset`, `RangeMode` (+`year`), `RangeConfig.mask`.
- `frontend/src/lib/backtestWindow.ts` — `RANGE_SPAN_MS` gains `lastYear` (for the relative chip).
- `frontend/src/BacktestButton.tsx` — send `resolveMask(cfg.range.mask)` in the POST payload.
- `frontend/src/BacktestSettingsModal.tsx` — Year tab, suggestion chips, mask Section, coverage readout, heat-strip.
- `frontend/src/BacktestSettingsModal.test.tsx` — UI smoke tests.

---

## Task 1: Backend `is_active` predicate (`schedule.py`)

**Files:**
- Create: `backend/auto_trader/engine/schedule.py`
- Test: `backend/tests/test_schedule.py`

**Interfaces:**
- Produces: `RecurrenceMask` dataclass and `is_active(mask: RecurrenceMask | None, dt: datetime) -> bool`.
  - `RecurrenceMask(enabled: bool = False, days_of_week: tuple[int, ...] = (), months_of_year: tuple[int, ...] = (), days_of_month: tuple[int, ...] = (), time_start_min: int | None = None, time_end_min: int | None = None, tz: str = "UTC")`
  - `is_active(None, dt) == True`; `is_active(mask, dt) == True` when `mask.enabled` is False.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_schedule.py
from datetime import datetime, timezone

from auto_trader.engine.schedule import RecurrenceMask, is_active


def _utc(y, mo, d, h=0, mi=0):
    return datetime(y, mo, d, h, mi, tzinfo=timezone.utc)


def test_no_mask_is_always_active():
    assert is_active(None, _utc(2024, 1, 1)) is True


def test_disabled_mask_is_always_active():
    m = RecurrenceMask(enabled=False, days_of_week=(1,))  # Monday only, but disabled
    assert is_active(m, _utc(2024, 1, 6)) is True  # a Saturday


def test_days_of_week_js_convention():
    # 2024-01-01 is a Monday. JS getDay Monday == 1.
    mon = RecurrenceMask(enabled=True, days_of_week=(1,))
    assert is_active(mon, _utc(2024, 1, 1)) is True   # Monday
    assert is_active(mon, _utc(2024, 1, 2)) is False  # Tuesday


def test_days_of_week_uses_tz():
    # 2024-01-01 23:00 UTC is Tuesday 08:00 in Tokyo. JS getDay Tue == 2.
    tue_tokyo = RecurrenceMask(enabled=True, days_of_week=(2,), tz="Asia/Tokyo")
    assert is_active(tue_tokyo, _utc(2024, 1, 1, 23, 0)) is True


def test_months_and_days_of_month():
    m = RecurrenceMask(enabled=True, months_of_year=(1,), days_of_month=(1, 15))
    assert is_active(m, _utc(2024, 1, 15)) is True
    assert is_active(m, _utc(2024, 1, 16)) is False
    assert is_active(m, _utc(2024, 2, 1)) is False  # wrong month


def test_time_of_day_half_open_window():
    m = RecurrenceMask(enabled=True, time_start_min=9 * 60 + 30, time_end_min=11 * 60)
    assert is_active(m, _utc(2024, 1, 1, 9, 30)) is True   # inclusive start
    assert is_active(m, _utc(2024, 1, 1, 10, 59)) is True
    assert is_active(m, _utc(2024, 1, 1, 11, 0)) is False  # exclusive end
    assert is_active(m, _utc(2024, 1, 1, 9, 29)) is False


def test_time_of_day_wraps_overnight():
    # Sydney-style overnight window 22:00 -> 02:00 (evaluated in UTC here).
    m = RecurrenceMask(enabled=True, time_start_min=22 * 60, time_end_min=2 * 60)
    assert is_active(m, _utc(2024, 1, 1, 23, 0)) is True
    assert is_active(m, _utc(2024, 1, 1, 1, 0)) is True
    assert is_active(m, _utc(2024, 1, 1, 12, 0)) is False


def test_filters_are_anded():
    m = RecurrenceMask(enabled=True, days_of_week=(1,), time_start_min=9 * 60, time_end_min=17 * 60)
    assert is_active(m, _utc(2024, 1, 1, 10, 0)) is True    # Monday, in window
    assert is_active(m, _utc(2024, 1, 1, 18, 0)) is False   # Monday, out of window
    assert is_active(m, _utc(2024, 1, 2, 10, 0)) is False   # Tuesday, in window
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_schedule.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'auto_trader.engine.schedule'`.

- [ ] **Step 3: Write minimal implementation**

```python
# backend/auto_trader/engine/schedule.py
"""Recurrence mask: a per-bar activity predicate for the backtest engine.

The mask NEVER filters candles — indicators compute over the full stream. This
only decides, per bar, whether the strategy may open a position (and, in the
engine, when to force-flat). A bar is active iff it passes EVERY enabled filter.

Wire conventions (shared with the frontend, do not diverge):
- days_of_week uses JS getDay: 0=Sun..6=Sat.
- months_of_year is 1=Jan..12=Dec.
- time_*_min are minutes from midnight in `tz`; window is half-open [start, end)
  and wraps when end < start (overnight sessions).
"""

from dataclasses import dataclass, field
from datetime import datetime
from zoneinfo import ZoneInfo


@dataclass(frozen=True)
class RecurrenceMask:
    enabled: bool = False
    days_of_week: tuple[int, ...] = ()        # JS getDay: 0=Sun..6=Sat; empty = all
    months_of_year: tuple[int, ...] = ()      # 1=Jan..12=Dec; empty = all
    days_of_month: tuple[int, ...] = ()       # 1..31 calendar day; empty = all
    time_start_min: int | None = None         # minutes from midnight, local to tz
    time_end_min: int | None = None
    tz: str = "UTC"


def _js_weekday(dt: datetime) -> int:
    # Python weekday(): 0=Mon..6=Sun. JS getDay(): 0=Sun..6=Sat.
    return (dt.weekday() + 1) % 7


def _in_window(minute: int, start: int, end: int) -> bool:
    if start == end:
        return True
    if start < end:
        return start <= minute < end
    return minute >= start or minute < end  # wraps past midnight


def is_active(mask: RecurrenceMask | None, dt: datetime) -> bool:
    if mask is None or not mask.enabled:
        return True
    local = dt.astimezone(ZoneInfo(mask.tz))
    if mask.days_of_week and _js_weekday(local) not in mask.days_of_week:
        return False
    if mask.months_of_year and local.month not in mask.months_of_year:
        return False
    if mask.days_of_month and local.day not in mask.days_of_month:
        return False
    if mask.time_start_min is not None and mask.time_end_min is not None:
        minute = local.hour * 60 + local.minute
        if not _in_window(minute, mask.time_start_min, mask.time_end_min):
            return False
    return True
```

(Remove the unused `field` import if your linter flags it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_schedule.py -v`
Expected: PASS (all 8 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/engine/schedule.py backend/tests/test_schedule.py
git commit -m "feat(backtest): recurrence mask is_active predicate"
```

---

## Task 2: Engine entry-gate + force-flat (`backtest.py`)

**Files:**
- Modify: `backend/auto_trader/engine/backtest.py` (`BacktestEngine.__init__` ~line 74; `run` ~line 96–185)
- Test: `backend/tests/test_backtest_mask.py` (new)

**Interfaces:**
- Consumes: `RecurrenceMask`, `is_active` from Task 1.
- Produces: `BacktestEngine(..., mask: RecurrenceMask | None = None)`. When a mask makes a bar inactive: no opening fill lands on that bar, and any open position is closed at that bar's open with `Fill.reason == "session close"` / `Trade.reason_out == "session close"`.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_backtest_mask.py
from datetime import datetime, timezone

from auto_trader.engine.backtest import BacktestEngine, Candle
from auto_trader.engine.schedule import RecurrenceMask


class _AlwaysBuyLong:
    """Signals a long entry every bar (fills next open); no exits.
    Mirrors the Strategy protocol the engine calls: on_bar(ctx) -> list[Signal]."""
    def __init__(self):
        from auto_trader.engine.backtest import Signal, Side
        self._Signal, self._Side = Signal, Side

    def on_bar(self, ctx):
        return [self._Signal(side=self._Side.BUY, quantity=1, reason="test-entry", leg="long")]


def _c(day, o):
    return Candle(time=datetime(2024, 1, day, tzinfo=timezone.utc), open=o, high=o + 1, low=o - 1, close=o, volume=0)


def test_no_entry_on_inactive_bar():
    # 2024-01-01 Mon, -02 Tue, -03 Wed. Mask: Mondays only (JS getDay Mon==1).
    candles = [_c(1, 100), _c(2, 101), _c(3, 102)]
    mask = RecurrenceMask(enabled=True, days_of_week=(1,))
    result = BacktestEngine(_AlwaysBuyLong(), starting_cash=10_000, mask=mask).run(candles)
    # Entry signalled on Mon(01) fills at Tue(02) open — but Tue is inactive, so no fill.
    entry_fills = [f for f in result.fills if f.reason == "test-entry"]
    assert entry_fills == []


def test_force_flat_at_first_inactive_bar_open():
    # Active Mon-Tue, inactive from Wed. Enter Mon, fill Tue open, force-flat Wed open.
    candles = [_c(1, 100), _c(2, 101), _c(3, 102), _c(4, 103)]
    mask = RecurrenceMask(enabled=True, days_of_week=(1, 2))  # Mon, Tue
    result = BacktestEngine(_AlwaysBuyLong(), starting_cash=10_000, mask=mask).run(candles)
    session_closes = [f for f in result.fills if f.reason == "session close"]
    assert len(session_closes) == 1
    assert session_closes[0].price == 102  # Wed (01-03) open
    assert result.trades[-1].reason_out == "session close"


def test_no_mask_unchanged():
    candles = [_c(1, 100), _c(2, 101), _c(3, 102)]
    result = BacktestEngine(_AlwaysBuyLong(), starting_cash=10_000).run(candles)
    assert any(f.reason == "test-entry" for f in result.fills)
    assert not any(f.reason == "session close" for f in result.fills)
```

(Confirm the exact `Signal`/`Side`/`Candle` constructor kwargs against `backtest.py` before running — adjust the tiny helper strategy to match the real `Signal` fields if they differ.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_backtest_mask.py -v`
Expected: FAIL — `BacktestEngine.__init__() got an unexpected keyword argument 'mask'`.

- [ ] **Step 3: Add `mask` to the constructor**

In `BacktestEngine.__init__` (around line 74), add a keyword parameter and store it:

```python
        mask: RecurrenceMask | None = None,
```
```python
        self.mask = mask
```

Add the import near the top of `backtest.py`:

```python
from auto_trader.engine.schedule import RecurrenceMask, is_active
```

- [ ] **Step 4: Add the entry-gate + force-flat to `run`**

At the very top of the `for i, bar in enumerate(candles):` loop body (before "1) Fill everything queued"), insert:

```python
            active = is_active(self.mask, bar.time)
            # Force-flat at the first inactive bar's open: close every open
            # position via the normal exit path with a "session close" reason.
            if not active and (longs or shorts):
                realized = self._close_all(longs, "long", result, realized, Side.SELL, bar.open, bar.time, "session close")
                realized = self._close_all(shorts, "short", result, realized, Side.BUY, bar.open, bar.time, "session close")
                last_long_open = None
                last_short_open = None
```

Then, inside the pending-fill loop, in the `if opening:` branch, add the gate as the first line (before the cap/spacing check):

```python
                if opening:
                    if not active:
                        continue  # mask inactive: no new entries on this bar
```

(Keep the existing cap/spacing/`_open` logic that follows.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_backtest_mask.py tests/test_backtest.py -v`
Expected: PASS (new mask tests pass; existing backtest tests unaffected).

- [ ] **Step 6: Commit**

```bash
git add backend/auto_trader/engine/backtest.py backend/tests/test_backtest_mask.py
git commit -m "feat(backtest): engine gates entries + force-flats on inactive bars"
```

---

## Task 3: Backend DTO + endpoint wiring (`app.py`)

**Files:**
- Modify: `backend/auto_trader/api/app.py` (DTOs ~394–435; endpoint ~1181–1239)
- Test: `backend/tests/test_api_backtest.py`

**Interfaces:**
- Consumes: `RecurrenceMask` from Task 1; `BacktestEngine(mask=...)` from Task 2.
- Produces: `BacktestRequest.mask: RecurrenceMaskDTO | None = None`; the endpoint validates `mask.tz` and passes `mask.to_mask()` to the engine.

- [ ] **Step 1: Write the failing test**

```python
# add to backend/tests/test_api_backtest.py — follow the existing request-building helper/fixtures in that file.
def test_backtest_accepts_recurrence_mask(client, minimal_backtest_body):
    body = {**minimal_backtest_body, "mask": {
        "enabled": True, "daysOfWeek": [1], "tz": "America/New_York",
    }}
    resp = client.post("/api/backtest", json=body)
    assert resp.status_code == 200


def test_backtest_rejects_bad_tz(client, minimal_backtest_body):
    body = {**minimal_backtest_body, "mask": {"enabled": True, "tz": "Not/AZone"}}
    resp = client.post("/api/backtest", json=body)
    assert resp.status_code == 422


def test_backtest_without_mask_still_works(client, minimal_backtest_body):
    resp = client.post("/api/backtest", json=minimal_backtest_body)
    assert resp.status_code == 200
```

(Use whatever request fixture the file already defines — reuse it; do not invent a new one if `test_api_backtest.py` already has a minimal-body helper.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_api_backtest.py -k recurrence -v`
Expected: FAIL — the mask field is ignored / `422` not raised for bad tz.

- [ ] **Step 3: Add the DTO and wire it in**

Add the DTO near the other config DTOs (after `ScalingConfigDTO`, ~line 415):

```python
class RecurrenceMaskDTO(BaseModel):
    enabled: bool = False
    daysOfWeek: list[int] = []       # JS getDay 0=Sun..6=Sat
    monthsOfYear: list[int] = []     # 1=Jan..12=Dec
    daysOfMonth: list[int] = []      # 1..31
    timeStartMin: int | None = None
    timeEndMin: int | None = None
    tz: str = "UTC"

    @model_validator(mode="after")
    def _valid_tz(self) -> "RecurrenceMaskDTO":
        try:
            ZoneInfo(self.tz)
        except Exception as e:
            raise ValueError(f"unknown timezone '{self.tz}'") from e
        return self

    def to_mask(self) -> RecurrenceMask:
        return RecurrenceMask(
            enabled=self.enabled,
            days_of_week=tuple(self.daysOfWeek),
            months_of_year=tuple(self.monthsOfYear),
            days_of_month=tuple(self.daysOfMonth),
            time_start_min=self.timeStartMin,
            time_end_min=self.timeEndMin,
            tz=self.tz,
        )
```

Add imports at the top of `app.py`:

```python
from zoneinfo import ZoneInfo
from auto_trader.engine.schedule import RecurrenceMask
```

Add the field to `BacktestRequest` (after `tradeFromTime`):

```python
    mask: RecurrenceMaskDTO | None = None
```

Pass it to the engine in the `backtest` handler (in the `BacktestEngine(...)` call, add):

```python
        mask=req.mask.to_mask() if req.mask else None,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_api_backtest.py -v`
Expected: PASS (new mask tests + existing tests).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/app.py backend/tests/test_api_backtest.py
git commit -m "feat(backtest): accept recurrence mask in the backtest request"
```

---

## Task 4: Frontend config types (`backtestConfig.ts`)

**Files:**
- Modify: `frontend/src/lib/backtestConfig.ts` (`RangeMode` line 51; `RangeConfig` lines 58–65)

**Interfaces:**
- Produces: `RangeMode` gains `"lastYear"`; `SessionPreset`, `DayTimeWindow`, `RecurrenceMask` types; `RangeConfig.mask?: RecurrenceMask`.

- [ ] **Step 1: Extend the types**

Replace the `RangeMode` line (51):

```ts
export type RangeMode = "bars" | "lastDay" | "lastWeek" | "lastMonth" | "lastYear" | "custom";
```

Add above `RangeConfig`:

```ts
export type SessionPreset = "NYSE" | "London" | "Frankfurt" | "Tokyo" | "Sydney" | "Crypto";

/** A clock window, minutes from midnight in the mask's tz. Half-open [start,end); wraps when end<start. */
export interface DayTimeWindow { startMin: number; endMin: number }

/** Phone-alarm-style activity mask. A bar is active iff it passes EVERY enabled
 * filter. `session`, when set, is a UI convenience that resolveMask() inlines
 * into timeOfDay+tz before the predicate runs and before POST — the backend
 * never sees `session`. Absent/`enabled:false` ⇒ every bar active. */
export interface RecurrenceMask {
  enabled: boolean;
  daysOfWeek?: number[];    // JS getDay 0=Sun..6=Sat; absent/empty = all
  monthsOfYear?: number[];  // 1=Jan..12=Dec; absent/empty = all
  daysOfMonth?: number[];   // 1..31; absent/empty = all
  timeOfDay?: DayTimeWindow;
  session?: SessionPreset;
  tz?: string;              // IANA; default "UTC"
}
```

Add to `RangeConfig` (after `historyBars?`):

```ts
  mask?: RecurrenceMask;
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: PASS (no usages yet).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/backtestConfig.ts
git commit -m "feat(backtest): RecurrenceMask + lastYear range types"
```

---

## Task 5: Frontend session presets + `resolveMask` + `isActive` (`backtestSchedule.ts`)

**Files:**
- Create: `frontend/src/lib/backtestSchedule.ts`
- Test: `frontend/src/lib/backtestSchedule.test.ts`

**Interfaces:**
- Consumes: `RecurrenceMask`, `SessionPreset`, `DayTimeWindow` from Task 4.
- Produces:
  - `SESSION_PRESETS: Record<SessionPreset, { label: string; window: DayTimeWindow | null; tz: string }>`
  - `resolveMask(m: RecurrenceMask): RecurrenceMask` — inlines `session` into `timeOfDay`+`tz`, drops `session`; idempotent.
  - `isActive(m: RecurrenceMask | undefined, tMs: number): boolean` — mirrors the backend predicate; consumes a resolved mask (call `resolveMask` first).

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/lib/backtestSchedule.test.ts
import { describe, it, expect } from "vitest";
import { SESSION_PRESETS, resolveMask, isActive } from "./backtestSchedule";

const utc = (y: number, mo: number, d: number, h = 0, mi = 0) =>
  Date.UTC(y, mo - 1, d, h, mi);

describe("resolveMask", () => {
  it("inlines a session into timeOfDay+tz and drops session", () => {
    const r = resolveMask({ enabled: true, session: "NYSE" });
    expect(r.session).toBeUndefined();
    expect(r.tz).toBe("America/New_York");
    expect(r.timeOfDay).toEqual({ startMin: 9 * 60 + 30, endMin: 16 * 60 });
  });
  it("is idempotent", () => {
    const once = resolveMask({ enabled: true, session: "Tokyo" });
    expect(resolveMask(once)).toEqual(once);
  });
  it("Crypto session applies no clock filter", () => {
    const r = resolveMask({ enabled: true, session: "Crypto" });
    expect(r.timeOfDay).toBeUndefined();
    expect(r.tz).toBe("UTC");
  });
});

describe("isActive", () => {
  it("undefined mask is always active", () => {
    expect(isActive(undefined, utc(2024, 1, 1))).toBe(true);
  });
  it("disabled mask is always active", () => {
    expect(isActive({ enabled: false, daysOfWeek: [1] }, utc(2024, 1, 6))).toBe(true);
  });
  it("day-of-week uses JS getDay in tz", () => {
    // 2024-01-01 23:00 UTC = Tue in Tokyo (getDay 2).
    const m = resolveMask({ enabled: true, daysOfWeek: [2], tz: "Asia/Tokyo" });
    expect(isActive(m, utc(2024, 1, 1, 23, 0))).toBe(true);
    expect(isActive(m, utc(2024, 1, 1, 12, 0))).toBe(false); // still Mon in Tokyo
  });
  it("half-open time window", () => {
    const m: any = { enabled: true, timeOfDay: { startMin: 570, endMin: 660 }, tz: "UTC" };
    expect(isActive(m, utc(2024, 1, 1, 9, 30))).toBe(true);
    expect(isActive(m, utc(2024, 1, 1, 11, 0))).toBe(false);
  });
  it("overnight wrap window", () => {
    const m: any = { enabled: true, timeOfDay: { startMin: 1320, endMin: 120 }, tz: "UTC" };
    expect(isActive(m, utc(2024, 1, 1, 23, 0))).toBe(true);
    expect(isActive(m, utc(2024, 1, 1, 1, 0))).toBe(true);
    expect(isActive(m, utc(2024, 1, 1, 12, 0))).toBe(false);
  });
  it("filters are ANDed", () => {
    const m = resolveMask({ enabled: true, daysOfWeek: [1], session: "NYSE" });
    expect(isActive(m, utc(2024, 1, 1, 15, 0))).toBe(true);  // Mon 10:00 NY
    expect(isActive(m, utc(2024, 1, 2, 15, 0))).toBe(false); // Tue
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/backtestSchedule.test.ts`
Expected: FAIL — cannot resolve `./backtestSchedule`.

- [ ] **Step 3: Write the implementation**

```ts
// frontend/src/lib/backtestSchedule.ts
// Mirror of the backend predicate (auto_trader/engine/schedule.py). Wire
// conventions MUST match: daysOfWeek = JS getDay 0=Sun..6=Sat, monthsOfYear
// 1=Jan..12=Dec, timeOfDay minutes-from-midnight in `tz`, half-open + wrap.
// tz evaluation uses Intl (no external deps). Keep pure — pass timestamps in.

import type { DayTimeWindow, RecurrenceMask, SessionPreset } from "./backtestConfig";

export const SESSION_PRESETS: Record<
  SessionPreset,
  { label: string; window: DayTimeWindow | null; tz: string }
> = {
  NYSE: { label: "NYSE", window: { startMin: 9 * 60 + 30, endMin: 16 * 60 }, tz: "America/New_York" },
  London: { label: "London", window: { startMin: 8 * 60, endMin: 16 * 60 + 30 }, tz: "Europe/London" },
  Frankfurt: { label: "Frankfurt", window: { startMin: 9 * 60, endMin: 17 * 60 + 30 }, tz: "Europe/Berlin" },
  Tokyo: { label: "Tokyo", window: { startMin: 9 * 60, endMin: 15 * 60 }, tz: "Asia/Tokyo" },
  Sydney: { label: "Sydney", window: { startMin: 10 * 60, endMin: 16 * 60 }, tz: "Australia/Sydney" },
  Crypto: { label: "Crypto (24/7)", window: null, tz: "UTC" },
};

/** Inline a session preset into timeOfDay+tz; drop `session`. Idempotent. */
export function resolveMask(m: RecurrenceMask): RecurrenceMask {
  if (!m.session) return m;
  const preset = SESSION_PRESETS[m.session];
  const { session: _session, ...rest } = m;
  return {
    ...rest,
    tz: preset.tz,
    timeOfDay: preset.window ?? undefined,
  };
}

// Wall-clock fields of `tMs` in `tz`, via Intl (DST-correct).
function localParts(tMs: number, tz: string): { dow: number; month: number; day: number; minute: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", month: "numeric", day: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(tMs).map((p) => [p.type, p.value]));
  const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0; // some engines emit "24" at midnight
  return {
    dow: DOW[parts.weekday],
    month: Number(parts.month),
    day: Number(parts.day),
    minute: hour * 60 + Number(parts.minute),
  };
}

function inWindow(minute: number, start: number, end: number): boolean {
  if (start === end) return true;
  if (start < end) return minute >= start && minute < end;
  return minute >= start || minute < end; // overnight wrap
}

/** Mirror of backend is_active. Pass a RESOLVED mask (call resolveMask first). */
export function isActive(m: RecurrenceMask | undefined, tMs: number): boolean {
  if (!m || !m.enabled) return true;
  const tz = m.tz ?? "UTC";
  const { dow, month, day, minute } = localParts(tMs, tz);
  if (m.daysOfWeek?.length && !m.daysOfWeek.includes(dow)) return false;
  if (m.monthsOfYear?.length && !m.monthsOfYear.includes(month)) return false;
  if (m.daysOfMonth?.length && !m.daysOfMonth.includes(day)) return false;
  if (m.timeOfDay && !inWindow(minute, m.timeOfDay.startMin, m.timeOfDay.endMin)) return false;
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/backtestSchedule.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/backtestSchedule.ts frontend/src/lib/backtestSchedule.test.ts
git commit -m "feat(backtest): session presets + resolveMask + isActive"
```

---

## Task 6: Suggestion chips + coverage helpers (`backtestSchedule.ts`)

**Files:**
- Modify: `frontend/src/lib/backtestSchedule.ts`
- Modify: `frontend/src/lib/backtestSchedule.test.ts`

**Interfaces:**
- Produces:
  - `type RangeChip = { label: string; fromMs: number; toMs: number }`
  - `buildRangeChips(unit: "day" | "week" | "month" | "year", now: number, tz: string): RangeChip[]`
  - `coverage(bars: number[], mask: RecurrenceMask | undefined): { active: number; total: number }` — `bars` = candle timestamps (ms) already limited to the window; `mask` should be resolved.

- [ ] **Step 1: Write the failing test**

```ts
// append to frontend/src/lib/backtestSchedule.test.ts
import { buildRangeChips, coverage } from "./backtestSchedule";

describe("buildRangeChips", () => {
  const now = Date.UTC(2026, 6, 5, 12, 0); // 2026-07-05 (July)
  it("month chips are recent whole calendar months, most-recent first", () => {
    const chips = buildRangeChips("month", now, "UTC");
    expect(chips[0].label).toMatch(/Jul|This month/);
    // Each chip spans a whole month: toMs - fromMs is 28..31 days.
    const span = chips[1].toMs - chips[1].fromMs;
    expect(span).toBeGreaterThan(27 * 86400_000);
    expect(span).toBeLessThan(32 * 86400_000);
  });
  it("year chips descend from the current year", () => {
    const chips = buildRangeChips("year", now, "UTC");
    expect(chips.map((c) => c.label)).toContain("2025");
    expect(chips.map((c) => c.label)).toContain("2024");
  });
});

describe("coverage", () => {
  it("counts active vs total bars", () => {
    // Two Mondays + two Tuesdays; mask = Mondays only.
    const bars = [
      Date.UTC(2024, 0, 1, 12), Date.UTC(2024, 0, 2, 12),
      Date.UTC(2024, 0, 8, 12), Date.UTC(2024, 0, 9, 12),
    ];
    const c = coverage(bars, { enabled: true, daysOfWeek: [1], tz: "UTC" });
    expect(c).toEqual({ active: 2, total: 4 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/backtestSchedule.test.ts -t "buildRangeChips|coverage"`
Expected: FAIL — `buildRangeChips`/`coverage` not exported.

- [ ] **Step 3: Implement**

Append to `backtestSchedule.ts`:

```ts
export type RangeChip = { label: string; fromMs: number; toMs: number };

// Whole-calendar-unit boundaries in `tz`. We build them from the tz-local
// Y/M/D of `now` and Date.UTC arithmetic; adequate for chip ranges (bar
// membership is decided by isActive, not these bounds). Emits: chip 0 = the
// current (partial) unit up to now, then N whole prior units, most-recent first.
export function buildRangeChips(
  unit: "day" | "week" | "month" | "year",
  now: number,
  tz: string,
): RangeChip[] {
  const p = localParts(now, tz); // reuse dow for week alignment
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(now);
  const get = (t: string) => Number(ymd.find((x) => x.type === t)!.value);
  const Y = get("year"), M = get("month"), D = get("day");
  const chips: RangeChip[] = [];

  if (unit === "year") {
    chips.push({ label: "YTD", fromMs: Date.UTC(Y, 0, 1), toMs: now });
    for (let i = 1; i <= 5; i++) chips.push({ label: `${Y - i}`, fromMs: Date.UTC(Y - i, 0, 1), toMs: Date.UTC(Y - i + 1, 0, 1) });
  } else if (unit === "month") {
    chips.push({ label: "This month", fromMs: Date.UTC(Y, M - 1, 1), toMs: now });
    for (let i = 1; i <= 12; i++) {
      const d = new Date(Date.UTC(Y, M - 1 - i, 1));
      const label = new Intl.DateTimeFormat("en-US", { month: "short", year: "2-digit", timeZone: "UTC" }).format(d);
      chips.push({ label, fromMs: d.getTime(), toMs: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) });
    }
  } else if (unit === "week") {
    // Week starts Monday. Days back to this week's Monday: (dow+6)%7.
    const mondayOffset = (p.dow + 6) % 7;
    const thisMon = Date.UTC(Y, M - 1, D - mondayOffset);
    chips.push({ label: "This week", fromMs: thisMon, toMs: now });
    for (let i = 1; i <= 8; i++) {
      const from = thisMon - i * 7 * 86400_000;
      chips.push({ label: i === 1 ? "Last week" : `${i} weeks ago`, fromMs: from, toMs: from + 7 * 86400_000 });
    }
  } else {
    const today = Date.UTC(Y, M - 1, D);
    chips.push({ label: "Today", fromMs: today, toMs: now });
    for (let i = 1; i <= 10; i++) {
      const from = today - i * 86400_000;
      const label = i === 1 ? "Yesterday" :
        new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(from));
      chips.push({ label, fromMs: from, toMs: from + 86400_000 });
    }
  }
  return chips;
}

export function coverage(bars: number[], mask: RecurrenceMask | undefined): { active: number; total: number } {
  let active = 0;
  for (const t of bars) if (isActive(mask, t)) active++;
  return { active, total: bars.length };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/backtestSchedule.test.ts`
Expected: PASS (all groups).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/backtestSchedule.ts frontend/src/lib/backtestSchedule.test.ts
git commit -m "feat(backtest): range suggestion chips + mask coverage helpers"
```

---

## Task 7: Send the mask in the POST payload (`BacktestButton.tsx`)

**Files:**
- Modify: `frontend/src/BacktestButton.tsx` (payload object ~lines 125–145)
- Modify: `frontend/src/lib/backtestWindow.ts` (`RANGE_SPAN_MS`, line 9–13)

**Interfaces:**
- Consumes: `resolveMask` (Task 5), `cfg.range.mask` (Task 4).
- Produces: the `/api/backtest` body includes `mask` (resolved) when `cfg.range.mask?.enabled`.

- [ ] **Step 1: Support the `lastYear` relative span**

In `backtestWindow.ts`, add to `RANGE_SPAN_MS`:

```ts
  lastYear: 365 * DAY_MS,
```

- [ ] **Step 2: Add `mask` to the request body**

In `BacktestButton.tsx`, import at top:

```ts
import { resolveMask } from "./lib/backtestSchedule";
```

In the object posted to `/api/backtest` (where `series`, `tradeFromTime`, etc. are set), add:

```ts
          mask: cfg.range.mask?.enabled ? resolveMask(cfg.range.mask) : undefined,
```

- [ ] **Step 3: Typecheck + run existing frontend tests**

Run: `cd frontend && npx tsc --noEmit && npx vitest run src/lib/backtestWindow.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/BacktestButton.tsx frontend/src/lib/backtestWindow.ts
git commit -m "feat(backtest): post resolved recurrence mask + lastYear span"
```

---

## Task 8: Range tabs — Year tab + suggestion chips (`BacktestSettingsModal.tsx`)

**Files:**
- Modify: `frontend/src/BacktestSettingsModal.tsx` (`RANGE_MODES` line 51–56; Time-range Section ~258–298)
- Test: `frontend/src/BacktestSettingsModal.test.tsx`

**Interfaces:**
- Consumes: `buildRangeChips` (Task 6); `setRange` (existing, line 215).
- Produces: a `Year` tab + a chip row under Day/Week/Month/Year tabs; clicking a chip sets `mode:"custom"` + `fromMs`/`toMs`.

- [ ] **Step 1: Add the Year mode + chip unit mapping**

In `RANGE_MODES` add:

```ts
  { value: "lastYear", label: "Year" },
```
(place before `custom`)

Add a helper mapping range mode → chip unit, near the top of the component file:

```ts
const CHIP_UNIT: Partial<Record<RangeMode, "day" | "week" | "month" | "year">> = {
  lastDay: "day", lastWeek: "week", lastMonth: "month", lastYear: "year",
};
```

- [ ] **Step 2: Render the chip row**

In the Time-range Section, right after the segmented mode buttons and before the `rangeDateLabel` note, add:

```tsx
{CHIP_UNIT[cfg.range.mode] && (
  <div className="bt-chip-row">
    {buildRangeChips(CHIP_UNIT[cfg.range.mode]!, Date.now(), maskTz(cfg)).map((chip) => {
      const on = cfg.range.mode === "custom" && cfg.range.fromMs === chip.fromMs && cfg.range.toMs === chip.toMs;
      return (
        <button
          key={chip.label}
          className={on ? "seg-on bt-chip" : "bt-chip"}
          onClick={() => setRange({ mode: "custom", fromMs: chip.fromMs, toMs: chip.toMs })}
        >
          {chip.label}
        </button>
      );
    })}
  </div>
)}
```

Add a small helper in the file for the evaluation tz (falls back to UTC — exchange-tz wiring is deferred, see spec Open Decision):

```ts
function maskTz(cfg: BacktestConfig): string {
  return cfg.range.mask?.tz ?? "UTC";
}
```

Import `buildRangeChips` at top:

```ts
import { buildRangeChips } from "./lib/backtestSchedule";
```

Add minimal CSS (co-locate with existing modal styles — find where `.seg-on`/range styles live and add):

```css
.bt-chip-row { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.bt-chip { padding: 2px 8px; font-size: 12px; border-radius: 4px; }
```

- [ ] **Step 3: Add a UI smoke test**

```tsx
// add to frontend/src/BacktestSettingsModal.test.tsx — follow the file's existing render/setup helper.
it("shows month suggestion chips when the Month tab is active", async () => {
  renderModal();               // reuse the file's existing helper
  fireEvent.click(screen.getByRole("button", { name: "Month" }));
  expect(screen.getByRole("button", { name: "This month" })).toBeInTheDocument();
});
```

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run src/BacktestSettingsModal.test.tsx && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/BacktestSettingsModal.tsx frontend/src/BacktestSettingsModal.test.tsx
git commit -m "feat(backtest): Year tab + calendar suggestion chips"
```

---

## Task 9: Recurrence mask Section UI (`BacktestSettingsModal.tsx`)

**Files:**
- Modify: `frontend/src/BacktestSettingsModal.tsx` (add a Section after Time-range; `setRange` at 215)
- Test: `frontend/src/BacktestSettingsModal.test.tsx`

**Interfaces:**
- Consumes: `RecurrenceMask`, `SESSION_PRESETS`, `setRange`; `resSeconds` (already in scope) for the timeframe guard.
- Produces: mask controls writing `cfg.range.mask`. A `setMask(patch)` helper merges into `cfg.range.mask`.

- [ ] **Step 1: Add a `setMask` helper**

Near `setRange` (line 215):

```ts
function setMask(patch: Partial<RecurrenceMask>) {
  const base: RecurrenceMask = cfg.range.mask ?? { enabled: false };
  setRange({ mask: { ...base, ...patch } });
}
```

- [ ] **Step 2: Render the mask Section**

After the Time-range `Section`, add (uses `resSeconds >= 86400` as the DAY+ guard — clock/session disabled there):

```tsx
<Section title="Repeat / active windows">
  <label className="al-row">
    <input
      type="checkbox"
      checked={cfg.range.mask?.enabled ?? false}
      onChange={(e) => setMask({ enabled: e.target.checked })}
    />
    <span>Only trade during selected windows (force-flat outside)</span>
  </label>

  {cfg.range.mask?.enabled && (
    <>
      {/* Days of week — JS getDay 0=Sun..6=Sat */}
      <div className="bt-chip-row">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => {
          const on = cfg.range.mask?.daysOfWeek?.includes(i) ?? false;
          return (
            <button key={d} className={on ? "seg-on bt-chip" : "bt-chip"}
              onClick={() => setMask({ daysOfWeek: toggle(cfg.range.mask?.daysOfWeek, i) })}>
              {d}
            </button>
          );
        })}
      </div>

      {/* Months of year — 1..12 */}
      <div className="bt-chip-row">
        {["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"].map((mo, idx) => {
          const m = idx + 1;
          const on = cfg.range.mask?.monthsOfYear?.includes(m) ?? false;
          return (
            <button key={mo} className={on ? "seg-on bt-chip" : "bt-chip"}
              onClick={() => setMask({ monthsOfYear: toggle(cfg.range.mask?.monthsOfYear, m) })}>
              {mo}
            </button>
          );
        })}
      </div>

      {/* Session preset + timezone (disabled on DAY+ timeframes) */}
      <div className="al-row bt-range-row">
        <label className="bt-range-field">
          <span>Session</span>
          <select
            disabled={resSeconds >= 86400}
            value={cfg.range.mask?.session ?? ""}
            onChange={(e) => setMask({ session: (e.target.value || undefined) as SessionPreset | undefined })}
          >
            <option value="">Custom / none</option>
            {Object.entries(SESSION_PRESETS).map(([k, v]) => (
              <option key={k} value={k}>{v.label}</option>
            ))}
          </select>
        </label>
        <label className="bt-range-field">
          <span>Timezone</span>
          <input
            type="text"
            disabled={!!cfg.range.mask?.session}
            value={cfg.range.mask?.tz ?? "UTC"}
            onChange={(e) => setMask({ tz: e.target.value })}
          />
        </label>
      </div>

      {/* Manual clock window when no session is chosen (disabled on DAY+) */}
      {!cfg.range.mask?.session && (
        <div className="al-row bt-range-row">
          <label className="bt-range-field">
            <span>From</span>
            <input type="time" disabled={resSeconds >= 86400}
              value={minToTime(cfg.range.mask?.timeOfDay?.startMin)}
              onChange={(e) => setMask({ timeOfDay: withStart(cfg.range.mask?.timeOfDay, timeToMin(e.target.value)) })} />
          </label>
          <label className="bt-range-field">
            <span>To</span>
            <input type="time" disabled={resSeconds >= 86400}
              value={minToTime(cfg.range.mask?.timeOfDay?.endMin)}
              onChange={(e) => setMask({ timeOfDay: withEnd(cfg.range.mask?.timeOfDay, timeToMin(e.target.value)) })} />
          </label>
        </div>
      )}
      {resSeconds >= 86400 && (
        <div className="al-note">Clock/session filters apply on intraday timeframes only.</div>
      )}
    </>
  )}
</Section>
```

Add the small pure helpers near the top of the file:

```ts
function toggle(list: number[] | undefined, v: number): number[] {
  const s = new Set(list ?? []);
  s.has(v) ? s.delete(v) : s.add(v);
  return [...s].sort((a, b) => a - b);
}
function minToTime(min: number | undefined): string {
  if (min == null) return "";
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}
function timeToMin(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
}
function withStart(w: DayTimeWindow | undefined, startMin: number): DayTimeWindow {
  return { startMin, endMin: w?.endMin ?? startMin };
}
function withEnd(w: DayTimeWindow | undefined, endMin: number): DayTimeWindow {
  return { startMin: w?.startMin ?? 0, endMin };
}
```

Import the new symbols at top:

```ts
import { SESSION_PRESETS } from "./lib/backtestSchedule";
import type { RecurrenceMask, SessionPreset, DayTimeWindow } from "./lib/backtestConfig";
```

- [ ] **Step 3: Add a UI smoke test**

```tsx
it("reveals mask controls when 'only trade during windows' is checked", () => {
  renderModal();
  fireEvent.click(screen.getByLabelText(/only trade during selected windows/i));
  expect(screen.getByRole("button", { name: "Mon" })).toBeInTheDocument();
  expect(screen.getByText("Session")).toBeInTheDocument();
});
```

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run src/BacktestSettingsModal.test.tsx && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/BacktestSettingsModal.tsx frontend/src/BacktestSettingsModal.test.tsx
git commit -m "feat(backtest): recurrence mask controls (days/months/session/clock)"
```

---

## Task 10: Coverage readout + calendar heat-strip (`BacktestSettingsModal.tsx`)

**Files:**
- Modify: `frontend/src/BacktestSettingsModal.tsx` (inside the mask Section)
- Test: `frontend/src/BacktestSettingsModal.test.tsx`

**Interfaces:**
- Consumes: `coverage`, `isActive`, `resolveMask` (Tasks 5–6); `resolveWindow` (existing import), `resSeconds`, `RESOLUTION_SECONDS`.
- Produces: a text readout + a thin heat-strip, both computed from a synthetic bar grid over the resolved window (no candle fetch needed).

- [ ] **Step 1: Build a synthetic bar grid + memoized coverage**

Inside the component, add (after `setMask`):

```ts
const maskPreview = useMemo(() => {
  const m = cfg.range.mask;
  if (!m?.enabled) return null;
  const { fromMs, toMs } = resolveWindow(cfg, resSeconds, Date.now());
  const stepMs = Math.max(resSeconds, 3600) * 1000; // >= 1h buckets keeps the grid small
  const grid: number[] = [];
  for (let t = fromMs; t < toMs && grid.length < 2000; t += stepMs) grid.push(t);
  const resolved = resolveMask(m);
  const cov = coverage(grid, resolved);
  return { grid, resolved, cov, stepMs };
}, [cfg, resSeconds]);
```

Import `useMemo` and the helpers:

```ts
import { coverage, isActive, resolveMask } from "./lib/backtestSchedule";
```

- [ ] **Step 2: Render the readout + strip inside the mask block**

After the clock controls, still within `cfg.range.mask?.enabled && (...)`:

```tsx
{maskPreview && (
  <>
    <div className="al-note">
      Active on {maskPreview.cov.active} of {maskPreview.cov.total} sampled slots
      {" "}({Math.round((maskPreview.cov.active / Math.max(1, maskPreview.cov.total)) * 100)}%)
    </div>
    <div className="bt-heatstrip" aria-hidden>
      {maskPreview.grid.map((t) => (
        <span key={t} className={isActive(maskPreview.resolved, t) ? "on" : "off"} />
      ))}
    </div>
  </>
)}
```

Add CSS near the chip styles:

```css
.bt-heatstrip { display: flex; height: 10px; margin-top: 6px; border-radius: 3px; overflow: hidden; }
.bt-heatstrip > span { flex: 1 1 0; min-width: 0; }
.bt-heatstrip > span.on { background: var(--accent, #2b7); }
.bt-heatstrip > span.off { background: var(--muted-bg, #e5e7eb); }
```

(If the grid can be large, the strip's many flex children are fine visually but cap rendering: `maskPreview.grid.slice(0, 400)` for the strip only — keep the full grid for the count.)

- [ ] **Step 3: Add a UI smoke test**

```tsx
it("shows a coverage readout when a mask is enabled", () => {
  renderModal();
  fireEvent.click(screen.getByLabelText(/only trade during selected windows/i));
  fireEvent.click(screen.getByRole("button", { name: "Mon" }));
  expect(screen.getByText(/Active on \d+ of \d+ sampled slots/)).toBeInTheDocument();
});
```

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run src/BacktestSettingsModal.test.tsx && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/BacktestSettingsModal.tsx frontend/src/BacktestSettingsModal.test.tsx
git commit -m "feat(backtest): mask coverage readout + calendar heat-strip"
```

---

## Task 11: Persistence round-trip verification

**Files:**
- Verify (likely no code): `frontend/src/lib/persist.ts` (backtest config save/load) + preset save/load path.
- Test: `frontend/src/lib/backtestSchedule.test.ts` or the persist test file.

**Interfaces:**
- Consumes: config save/load already serializes `cfg.range` as a whole. Since `mask` is a plain nested field on `RangeConfig`, a structural-clone / JSON round-trip carries it for free — this task confirms that and adds a guard test.

- [ ] **Step 1: Locate how the backtest config is persisted**

Run: `cd frontend && grep -rn "range\|BacktestConfig\|saveBacktest\|preset" src/lib/persist.ts src/BacktestSettingsModal.tsx | grep -i "config\|preset\|range" | head`
Expected: confirm the config is saved as a single object (no per-field allowlist that would drop `mask`).

- [ ] **Step 2: Add a round-trip guard test**

If save/load goes through a pure serializer, test it directly; otherwise assert JSON round-trip preserves the mask:

```ts
it("a config with a mask survives a JSON round-trip", () => {
  const cfg = { ...defaultBacktestConfig(),
    range: { mode: "custom", mask: { enabled: true, daysOfWeek: [1, 3], session: "NYSE" } } };
  const back = JSON.parse(JSON.stringify(cfg));
  expect(back.range.mask).toEqual({ enabled: true, daysOfWeek: [1, 3], session: "NYSE" });
});
```

Import `defaultBacktestConfig` from `./backtestConfig`.

- [ ] **Step 3: If a field allowlist drops `mask`, fix it**

Only if Step 1 revealed an explicit allowlist: add `mask` to whatever picks `range` fields so it isn't stripped. Otherwise no code change.

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run src/lib/backtestSchedule.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test(backtest): confirm recurrence mask persists with the config"
```

---

## Task 12: End-to-end verification

**Files:** none (manual + full suites).

- [ ] **Step 1: Backend suite**

Run: `cd backend && python -m pytest tests/test_schedule.py tests/test_backtest_mask.py tests/test_backtest.py tests/test_api_backtest.py -v`
Expected: PASS.

- [ ] **Step 2: Frontend suite + typecheck**

Run: `cd frontend && npx vitest run src/lib/backtestSchedule.test.ts src/lib/backtestWindow.test.ts src/BacktestSettingsModal.test.tsx && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Manual smoke (dev server already running — do NOT restart it)**

In the running app: open a backtest, pick the **Month** tab → click a month chip → confirm the date label updates. Enable **Only trade during selected windows**, choose **Mon** + **NYSE** session on an intraday timeframe, confirm the coverage readout + heat-strip appear. Run the backtest; confirm trades cluster on Mondays within NY hours and each active window ends with a `session close` exit in the trades panel.

- [ ] **Step 4: Final commit (if any manual fixes)**

```bash
git add -A
git commit -m "chore(backtest): period scheduling verification pass"
```

---

## Self-Review Notes

- **Spec coverage:** Layer 1 chips (T6, T8) + Year tab (T4, T8); mask filters days-of-week/months/days-of-month/time/session (T1, T5, T9); mask-never-filters-candles invariant (T2 Global Constraints + `test_no_mask`/indicator assertion); timezone model (T1, T5); force-flat "session close" (T2); timeframe guard (T9); days-of-month=calendar-number only (T1, no trading-calendar logic); coverage readout + heat-strip + preset persistence embellishments (T10, T11).
- **Weekday/month convention** is fixed once (Global Constraints) and reused identically in T1, T5, T9 — no `getDay`/`weekday()` drift.
- **Session table** exists only on the frontend (T5); backend sees resolved primitives (T3) — single source of truth.
- **Open decision (mask.tz default):** T8 `maskTz()` returns UTC; exchange-tz wiring is explicitly deferred per the spec, not blocking.
