# Realism Costs Implementation Plan

> **Simplified 2026-07-17:** Overnight financing is kept but simplified to static
> manual per-night rates. The triple-swap-day and rollover-hour knobs were removed
> (rollover is fixed at 21:00 UTC); broker fee prefill was dropped because broker
> sign conventions are inconsistent (Capital reports negative when it charges you).
> Financing is displayed as its P&L impact (negative = paid). Spread and slippage
> are unchanged; spread broker-prefill stays.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Backtest fills and P&L account for per-instrument spread, optionally ATR-scaled slippage, and overnight financing, with broker-prefilled per-instrument cost profiles snapshotted into each run.

**Architecture:** The engine (`BacktestEngine`) gains three cost inputs (spread, slippage model, financing) that default to today's behavior when zeroed. A backend sqlite cost-profile store (same pattern as `sweep_store.py`) holds per-epic settings prefilled from broker data; the frontend Costs tab displays/edits the profile and stamps resolved values into every run request, so archived runs are reproducible.

**Tech Stack:** Python 3.12 / FastAPI / pydantic v2 / sqlite (backend); React + TypeScript / vitest (frontend).

**Spec:** `docs/superpowers/specs/2026-07-17-realism-costs-design.md` — binding. Read it before starting any task.

## Global Constraints

- Zeroed new costs reproduce today's results exactly: `spread = 0`, slippage `{kind:"fixed", value:X, atrMult:0}`, financing rates `0` must be byte-identical to the current engine (existing fixtures must pass unchanged apart from mechanical DTO-shape updates).
- No legacy/back-compat shims. The DTO replaces `slippage: float` outright with a model object. The ONE exception (spec-mandated): the frontend config loader coerces a previously persisted numeric `slippage` into `{kind:"fixed", value:n, atrMult:0}` so stored panels don't break.
- UI: no new panel sections. All new controls live inside the existing Costs tab as one "Instrument costs" group. Use shared `Tooltip`/`InfoTip` components, never native `title=`.
- No em dashes ("—"/"--") in any end-user copy (tooltips, labels, notes).
- Financing sign convention: positive daily pct is a cost (subtracted), negative is a credit (added).
- Rollover default: `rolloverHourUtc = 21`; `tripleSwapWeekday` uses Python weekday numbering 0=Mon..6=Sun, default None.
- Backend store pattern: copy `backend/auto_trader/core/sweep_store.py` (sqlite WAL, schema on connect, fresh connection per op, `asyncio.to_thread`, module singleton, path from `config.py`).
- Backend tests: `cd backend && uv run pytest tests/ -q`. Frontend: `cd frontend && npx vitest run <file>` and `npx tsc --noEmit`.
- Work on a worktree branch; commit per task.

---

### Task 1: Engine spread + slippage model

**Files:**
- Modify: `backend/auto_trader/engine/backtest.py`
- Test: `backend/tests/test_engine_costs.py` (create)

**Interfaces:**
- Consumes: existing `BacktestEngine.__init__`, `_fill_price`, `_intrabar_exit`.
- Produces: `BacktestEngine(..., spread: float = 0.0, slippage: float = 0.0, slippage_atr_mult: float = 0.0)`; `_fill_price(self, open_price, side, i)` (bar index added for ATR lookup). Task 3 wires DTO values into these exact parameter names.

- [ ] **Step 1: Write failing tests**

Create `backend/tests/test_engine_costs.py`. Reuse the candle/strategy helpers pattern from the existing engine tests (see `backend/tests/test_engine*.py` for the local `mk_candles` / scripted-strategy helpers; if a shared helper exists, import it instead of copying).

```python
"""Spread and slippage-model fills. A scripted strategy opens long on bar 0
(fills at bar 1's open) and the engine closes at range end."""
from datetime import datetime, timedelta, timezone

from auto_trader.core.models import Candle, Side, Signal
from auto_trader.engine.backtest import BacktestEngine
from auto_trader.strategy.base import Context, Strategy


def bars(prices: list[float], start=datetime(2026, 1, 5, tzinfo=timezone.utc)) -> list[Candle]:
    # Flat candles: open=high=low=close=price, 1h apart, so fills are exact.
    return [
        Candle(start + timedelta(hours=i), p, p, p, p, 0.0)
        for i, p in enumerate(prices)
    ]


class OpenLongOnce(Strategy):
    def __init__(self) -> None:
        self.done = False

    def on_bar(self, ctx: Context):
        if not self.done:
            self.done = True
            return [Signal(side=Side.BUY, quantity=1.0, reason="test", leg="long")]
        return []


def test_spread_widens_entry_and_exit():
    # Entry at bar1 open 100 -> BUY fills at 100 + spread/2 = 100.5.
    # Range end closes at last close 110 as SELL -> 110 - 0.5 = 109.5.
    res = BacktestEngine(OpenLongOnce(), spread=1.0).run(bars([100, 100, 110]))
    t = res.trades[0]
    assert t.entry_price == 100.5
    assert t.exit_price == 109.5
    assert res.net_pnl == 9.0  # 10 raw minus a full spread round trip


def test_zero_spread_is_todays_behavior():
    res = BacktestEngine(OpenLongOnce()).run(bars([100, 100, 110]))
    assert res.trades[0].entry_price == 100.0
    assert res.net_pnl == 10.0


def test_long_stop_triggers_on_bid_side():
    # Long from 100 (bar1 open), stop at 95. Bar2 low is 95.4: mid never
    # touches 95, but the bid (low - spread/2 = 95.4 - 0.5 = 94.9) does.
    candles = bars([100, 100, 100])
    candles[2] = Candle(candles[2].time, 100, 100, 95.4, 100, 0.0)
    sig_engine = BacktestEngine(OpenLongOnce(), spread=1.0)
    # Per-signal bracket: stop 95 via signal stop_level.
    class WithStop(OpenLongOnce):
        def on_bar(self, ctx):
            out = super().on_bar(ctx)
            for s in out:
                s.stop_level = 95.0
            return out
    res = BacktestEngine(WithStop(), spread=1.0).run(candles)
    assert res.trades[0].reason_out == "stop"
    # Fill: raw = min(open=100, stop=95) = 95, SELL side -> 95 - 0.5 = 94.5.
    assert res.trades[0].exit_price == 94.5


def test_atr_slippage_adds_per_fill():
    # atr mult 2 with a known ATR: candles with range 2 -> ATR14 warm-up is
    # None early, so the first fills fall back to base alone.
    candles = [
        Candle(datetime(2026, 1, 5, tzinfo=timezone.utc) + timedelta(hours=i),
               100, 101, 99, 100, 0.0)
        for i in range(20)
    ]
    res = BacktestEngine(OpenLongOnce(), slippage=0.1, slippage_atr_mult=2.0).run(candles)
    # Entry on bar 1: ATR14 undefined (needs 14 bars) -> slip = base 0.1 only.
    assert res.trades[0].entry_price == 100.1
    # Exit at range end (bar 19): ATR14 = 2.0 -> slip = 0.1 + 2*2 = 4.1.
    assert res.trades[0].exit_price == 100 - 4.1
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && uv run pytest tests/test_engine_costs.py -q`
Expected: FAIL (`__init__` has no `spread` parameter).

- [ ] **Step 3: Implement**

In `backend/auto_trader/engine/backtest.py`:

a) Constructor (after `slippage: float = 0.0`):

```python
        spread: float = 0.0,
        slippage_atr_mult: float = 0.0,
```
and in the body:
```python
        self.half_spread = spread / 2.0
        self.slippage_atr_mult = slippage_atr_mult
        self._slip_atr: list[float | None] = []
```

b) ATR precompute at the top of `run()` (Wilder ATR14 over the run's candles; local static helper):

```python
    @staticmethod
    def _wilder_atr14(candles: list[Candle]) -> list[float | None]:
        out: list[float | None] = [None] * len(candles)
        trs: list[float] = []
        prev_close: float | None = None
        atr: float | None = None
        for i, c in enumerate(candles):
            tr = c.high - c.low if prev_close is None else max(
                c.high - c.low, abs(c.high - prev_close), abs(c.low - prev_close))
            prev_close = c.close
            if atr is None:
                trs.append(tr)
                if len(trs) == 14:
                    atr = sum(trs) / 14
            else:
                atr = (atr * 13 + tr) / 14
            out[i] = atr
        return out
```
In `run()`, before the loop:
```python
        self._slip_atr = self._wilder_atr14(candles) if self.slippage_atr_mult > 0 else []
```

c) Fill price gains the bar index and the spread/ATR terms (update EVERY caller: pending-fill loop passes `i`, `_intrabar_exit` gains an `i` parameter threaded from the run loop):

```python
    def _slip_at(self, i: int) -> float:
        extra = 0.0
        if self.slippage_atr_mult > 0 and i < len(self._slip_atr):
            atr = self._slip_atr[i]
            if atr is not None:
                extra = self.slippage_atr_mult * atr
        return self.slippage + extra

    def _fill_price(self, open_price: float, side: Side, i: int) -> float:
        # Costs push the price against us: buy at ask plus slippage, sell at
        # bid minus slippage.
        adj = self.half_spread + self._slip_at(i)
        return open_price + (adj if side is Side.BUY else -adj)
```

d) `_intrabar_exit(self, positions, side, risk, result, realized, bar, i)`: triggers evaluate on the execution side. For the long branch:

```python
            if side == "long":
                # Exits are SELLs executing at the bid: shift the candle down
                # by half the spread before comparing to the levels.
                b_open, b_high, b_low = (bar.open - self.half_spread,
                                         bar.high - self.half_spread,
                                         bar.low - self.half_spread)
                if p.target is not None and b_open >= p.target:
                    hit = (self._fill_price(p.target, Side.SELL, i), "target")
                elif p.stop is not None and b_low <= p.stop:
                    raw = min(bar.open, p.stop)
                    hit = (self._fill_price(raw, Side.SELL, i), "trail" if is_trail else "stop")
                elif p.target is not None and b_high >= p.target:
                    hit = (self._fill_price(p.target, Side.SELL, i), "target")
                else:
                    hit = None
```
Short branch mirrors with `+ self.half_spread` (exits are BUYs at the ask) and `Side.BUY`.

e) Range-end close and session-close paths call `_close_all` with `self._fill_price(last_bar.close, Side.SELL, len(candles) - 1)` (and `Side.BUY` for shorts) instead of the raw close, so spread applies there too. Trailing ratchet and `_unrealized` stay on mid prices (mark-to-market, not fills).

- [ ] **Step 4: Run tests**

Run: `cd backend && uv run pytest tests/test_engine_costs.py tests/ -q`
Expected: new tests PASS and the whole backend suite stays green (zero-cost paths unchanged).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/engine/backtest.py backend/tests/test_engine_costs.py
git commit -m "feat(engine): per-instrument spread and ATR-scaled slippage on fills"
```

---

### Task 2: Engine overnight financing

**Files:**
- Modify: `backend/auto_trader/engine/backtest.py`, `backend/auto_trader/core/models.py` (Trade), `backend/auto_trader/engine/metrics.py`
- Test: `backend/tests/test_engine_financing.py` (create)

**Interfaces:**
- Consumes: Task 1's engine shape.
- Produces: `BacktestEngine(..., fin_long_daily_pct: float = 0.0, fin_short_daily_pct: float = 0.0, rollover_hour_utc: int = 21, triple_swap_weekday: int | None = None)`; `Trade.financing: float = 0.0`; `BacktestResult.financing_total: float = 0.0` (also in `summary()`); `compute_metrics` output gains `"financing_total"`.

- [ ] **Step 1: Write failing tests**

`backend/tests/test_engine_financing.py` (reuse `bars`/`OpenLongOnce` from Task 1's test module via import):

```python
from datetime import datetime, timedelta, timezone

from auto_trader.core.models import Candle
from auto_trader.engine.backtest import BacktestEngine
from tests.test_engine_costs import OpenLongOnce, bars


def hourly(n: int, price=100.0, start=datetime(2026, 1, 5, 18, tzinfo=timezone.utc)):
    return [Candle(start + timedelta(hours=i), price, price, price, price, 0.0)
            for i in range(n)]


def test_one_night_charged_at_rollover():
    # Bars 18:00..23:00 Mon. Entry fills at bar1 (19:00). Rollover 21:00 UTC
    # crossed once (20:00 -> 21:00 bar boundary). qty 1 x entry 100 x 0.01%/night.
    res = BacktestEngine(OpenLongOnce(), fin_long_daily_pct=0.01).run(hourly(6))
    assert res.financing_total == 0.01  # 100 * 0.01 / 100
    assert res.trades[0].financing == 0.01
    assert res.net_pnl == -0.01        # flat price, one night's charge


def test_negative_rate_is_a_credit():
    res = BacktestEngine(OpenLongOnce(), fin_long_daily_pct=-0.01).run(hourly(6))
    assert res.net_pnl == 0.01


def test_triple_swap_weekday():
    # Start Wed 2026-01-07 18:00; the 21:00 crossing lands on Wednesday(2).
    start = datetime(2026, 1, 7, 18, tzinfo=timezone.utc)
    res = BacktestEngine(
        OpenLongOnce(), fin_long_daily_pct=0.01, triple_swap_weekday=2
    ).run(hourly(6, start=start))
    assert res.financing_total == 0.03


def test_daily_bars_charge_each_night():
    # 1D bars: each bar boundary spans exactly one 21:00 crossing.
    start = datetime(2026, 1, 5, tzinfo=timezone.utc)
    candles = [Candle(start + timedelta(days=i), 100, 100, 100, 100, 0.0)
               for i in range(5)]
    res = BacktestEngine(OpenLongOnce(), fin_long_daily_pct=0.01).run(candles)
    # Held from bar1 fill to range end at bar4: crossings during bars 2,3,4.
    assert res.financing_total == 0.03


def test_flat_positions_accrue_nothing():
    class Never(OpenLongOnce):
        def on_bar(self, ctx):
            return []
    res = BacktestEngine(Never(), fin_long_daily_pct=0.5).run(hourly(6))
    assert res.financing_total == 0.0
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && uv run pytest tests/test_engine_financing.py -q`
Expected: FAIL (`fin_long_daily_pct` unknown).

- [ ] **Step 3: Implement**

a) `Position` gains `financing: float = 0.0`. `Trade` (`core/models.py`) gains `financing: float = 0.0` after `pnl`. `BacktestResult` gains `financing_total: float = 0.0` and includes it in `summary()`.

b) Constructor additions:

```python
        fin_long_daily_pct: float = 0.0,
        fin_short_daily_pct: float = 0.0,
        rollover_hour_utc: int = 21,
        triple_swap_weekday: int | None = None,
```

c) Crossing counter (module-level or staticmethod):

```python
    def _rollover_crossings(self, prev: datetime, cur: datetime) -> list[datetime]:
        """Every rollover instant in (prev, cur]. Walk day by day; bounded by
        the bar span (a few iterations even for weekly bars)."""
        out: list[datetime] = []
        candidate = prev.replace(hour=self.rollover_hour_utc, minute=0, second=0, microsecond=0)
        if candidate <= prev:
            candidate += timedelta(days=1)
        while candidate <= cur:
            out.append(candidate)
            candidate += timedelta(days=1)
        return out
```

d) In the run loop, at the TOP of the bar iteration (before step 1 fills/closes and before intrabar exits), accrue for both sides. Ordering matters: a position that closes on this bar (pending close at the open, or intrabar stop) still held through the night that just ended, so it must be charged before it leaves `longs`/`shorts`:

```python
            if i > 0 and (self.fin_long_daily_pct or self.fin_short_daily_pct):
                crossings = self._rollover_crossings(candles[i - 1].time, bar.time)
                for c in crossings:
                    mult = 3 if c.weekday() == self.triple_swap_weekday else 1
                    for p in longs:
                        charge = p.qty * p.entry * self.fin_long_daily_pct / 100.0 * mult
                        p.financing += charge
                        realized -= charge
                    for p in shorts:
                        charge = p.qty * p.entry * self.fin_short_daily_pct / 100.0 * mult
                        p.financing += charge
                        realized -= charge
```
Accruing into `realized` here means the equity curve reflects financing at rollover time, not at close.

e) In `_reduce`, allocate the position's accrued financing to the Trade proportionally and decrement:

```python
        share = p.financing * (closing / p.qty) if p.qty else 0.0
        p.financing -= share
```
Pass `financing=share` into the `Trade(...)` constructor and add `result.financing_total += share`. Note `p.qty` here is the pre-decrement quantity (compute `share` before `p.qty -= closing`).

f) `compute_metrics` (`engine/metrics.py`): thread `financing_total` through into the returned dict (the router passes `result.financing_total`; if `compute_metrics` only receives trades, sum `t.financing` instead; pick whichever the current call shape makes cleaner and keep it consistent with the equity-accrual number).

- [ ] **Step 4: Run tests**

Run: `cd backend && uv run pytest tests/test_engine_financing.py tests/ -q
`
Expected: PASS, full suite green (financing defaults to 0 everywhere else).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/engine/backtest.py backend/auto_trader/core/models.py backend/auto_trader/engine/metrics.py backend/tests/test_engine_financing.py
git commit -m "feat(engine): overnight financing accrual with triple-swap handling"
```

---

### Task 3: CostsDTO model, wiring, cost sensitivity

**Files:**
- Modify: `backend/auto_trader/api/schemas.py` (CostsDTO, new SlippageDTO, TradeDTO, BacktestResponse metrics), `backend/auto_trader/api/sweep_apply.py` (both `BacktestEngine(` sites), `backend/auto_trader/api/routers/backtest.py` (cost-sensitivity block, TradeDTO construction)
- Test: `backend/tests/test_api_costs_wiring.py` (create); update any fixtures that construct `CostsDTO`/request JSON with `"slippage": 0`

**Interfaces:**
- Consumes: engine params from Tasks 1-2.
- Produces (wire shape used verbatim by frontend Task 5):

```python
class SlippageDTO(BaseModel):
    kind: Literal["fixed", "atr"]
    value: float = Field(ge=0)          # fixed value, or the ATR mode's base
    atrMult: float = Field(default=0.0, ge=0)

class CostsDTO(BaseModel):
    quantity: float = Field(gt=0)
    commissionPerSide: float = Field(ge=0)
    slippage: SlippageDTO
    spread: float = Field(default=0.0, ge=0)
    finLongDailyPct: float = 0.0
    finShortDailyPct: float = 0.0
    tripleSwapWeekday: int | None = Field(default=None, ge=0, le=6)
    rolloverHourUtc: int = Field(default=21, ge=0, le=23)
    startingCash: float = Field(gt=0)
```

- [ ] **Step 1: Write failing tests**

```python
"""CostsDTO -> engine wiring and cost-sensitivity scaling."""
import pytest
from pydantic import ValidationError

from auto_trader.api.schemas import CostsDTO, SlippageDTO


def test_slippage_is_a_model_object():
    c = CostsDTO(quantity=1, commissionPerSide=0,
                 slippage={"kind": "atr", "value": 0.1, "atrMult": 2.0},
                 startingCash=1000)
    assert c.slippage.kind == "atr"
    assert c.spread == 0.0 and c.finLongDailyPct == 0.0


def test_numeric_slippage_rejected():
    with pytest.raises(ValidationError):
        CostsDTO(quantity=1, commissionPerSide=0, slippage=0.5, startingCash=1000)


def test_triple_swap_weekday_bounds():
    with pytest.raises(ValidationError):
        CostsDTO(quantity=1, commissionPerSide=0,
                 slippage={"kind": "fixed", "value": 0}, startingCash=1000,
                 tripleSwapWeekday=7)
```

Plus an integration test through `run_rule_sync` asserting a request with `spread=1.0` produces the spread-adjusted entry price from Task 1 (build the minimal `BacktestRequest` the existing sweep_apply tests use as a template).

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && uv run pytest tests/test_api_costs_wiring.py -q`
Expected: FAIL (SlippageDTO missing).

- [ ] **Step 3: Implement**

a) Add `SlippageDTO`, reshape `CostsDTO` exactly as above.

b) Both engine constructions in `sweep_apply.py` (rule + coded) pass:

```python
        commission_per_side=req.costs.commissionPerSide,
        slippage=req.costs.slippage.value,
        slippage_atr_mult=req.costs.slippage.atrMult if req.costs.slippage.kind == "atr" else 0.0,
        spread=req.costs.spread,
        fin_long_daily_pct=req.costs.finLongDailyPct,
        fin_short_daily_pct=req.costs.finShortDailyPct,
        rollover_hour_utc=req.costs.rolloverHourUtc,
        triple_swap_weekday=req.costs.tripleSwapWeekday,
```

c) Cost-sensitivity block in `routers/backtest.py`: the zero-check becomes (KEEP the existing `or result.n_trades == 0` clause when substituting)

```python
        zero_costs = (
            req.costs.slippage.value == 0 and req.costs.slippage.atrMult == 0
            and req.costs.commissionPerSide == 0 and req.costs.spread == 0
            and req.costs.finLongDailyPct == 0 and req.costs.finShortDailyPct == 0
        )
```
and the scaled copy multiplies every component:

```python
                scaled = req.model_copy(update={
                    "inspect": False,
                    "costs": req.costs.model_copy(update={
                        "slippage": req.costs.slippage.model_copy(update={
                            "value": req.costs.slippage.value * m,
                            "atrMult": req.costs.slippage.atrMult * m,
                        }),
                        "commissionPerSide": req.costs.commissionPerSide * m,
                        "spread": req.costs.spread * m,
                        "finLongDailyPct": req.costs.finLongDailyPct * m,
                        "finShortDailyPct": req.costs.finShortDailyPct * m,
                    }),
                })
```

d) `TradeDTO` gains `financing: float = 0.0`, populated in the trades_dto construction; the response metrics dict carries `financing_total` (from Task 2's metrics change).

e) Update every backend test fixture that builds `CostsDTO(slippage=0)` or posts `"slippage": 0` JSON to the object form `{"kind": "fixed", "value": 0}`. Mechanical; grep `slippage` under `backend/tests/`.

- [ ] **Step 4: Run tests**

Run: `cd backend && uv run pytest tests/ -q`
Expected: PASS (whole suite; fixture updates included).

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api backend/tests
git commit -m "feat(api): cost model DTOs (slippage model, spread, financing) wired to the engine"
```

---

### Task 4: Cost profile store

**Files:**
- Create: `backend/auto_trader/core/cost_profiles.py`
- Modify: `backend/auto_trader/config.py` (beside `sweeps_db_path`, line ~70)
- Test: `backend/tests/test_cost_profiles.py` (create)

**Interfaces:**
- Produces:

```python
class CostProfileStore:
    def __init__(self, db_path: str) -> None: ...
    async def get(self, epic: str) -> dict | None: ...
    async def upsert(self, epic: str, profile: dict) -> None: ...

COST_PROFILES = CostProfileStore(settings.cost_profiles_db_path)
```
Profile dict keys (the wire shape Task 5's routes return verbatim):
`{"epic", "spread", "slippage" (model object), "finLongDailyPct", "finShortDailyPct", "tripleSwapWeekday", "rolloverHourUtc", "source" ("broker"|"manual"), "updatedAt"}`.

- [ ] **Step 1: Write failing tests**

The repo has NO pytest-asyncio (no `asyncio_mode` in pyproject; API tests are sync `TestClient`). Bare `async def test_...` would silently not run. Wrap store calls in `asyncio.run(...)`:

```python
import asyncio

import pytest

from auto_trader.core.cost_profiles import CostProfileStore


@pytest.fixture
def store(tmp_path):
    return CostProfileStore(str(tmp_path / "costs.db"))


def test_roundtrip(store):
    profile = {"spread": 0.8, "slippage": {"kind": "fixed", "value": 0.1, "atrMult": 0},
               "finLongDailyPct": -0.0026, "finShortDailyPct": 0.001,
               "tripleSwapWeekday": 2, "rolloverHourUtc": 21, "source": "broker"}
    asyncio.run(store.upsert("US100", profile))
    got = asyncio.run(store.get("US100"))
    assert got["spread"] == 0.8 and got["source"] == "broker"
    assert got["slippage"]["kind"] == "fixed"
    assert got["epic"] == "US100" and got["updatedAt"] > 0


def test_missing_epic_is_none(store):
    assert asyncio.run(store.get("NOPE")) is None


def test_upsert_overwrites(store):
    asyncio.run(store.upsert("EURUSD", {"spread": 1.0, "source": "broker"}))
    asyncio.run(store.upsert("EURUSD", {"spread": 2.0, "source": "manual"}))
    got = asyncio.run(store.get("EURUSD"))
    assert got["spread"] == 2.0 and got["source"] == "manual"


def test_corrupt_slippage_json_returns_defaults(store):
    # Write a row with broken slippage_json directly, get() must not raise.
    import sqlite3
    asyncio.run(store.upsert("BAD", {"spread": 1.0, "source": "manual"}))
    with sqlite3.connect(store.db_path) as con:
        con.execute("UPDATE cost_profiles SET slippage_json='{oops' WHERE epic='BAD'")
    got = asyncio.run(store.get("BAD"))
    assert got["slippage"] == {"kind": "fixed", "value": 0.0, "atrMult": 0.0}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && uv run pytest tests/test_cost_profiles.py -q`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

Copy `sweep_store.py`'s skeleton (WAL pragma, `_connect`, schema on connect, `asyncio.to_thread` wrappers). Table:

```sql
CREATE TABLE IF NOT EXISTS cost_profiles (
  epic TEXT PRIMARY KEY,
  spread REAL NOT NULL DEFAULT 0,
  slippage_json TEXT NOT NULL DEFAULT '{"kind":"fixed","value":0.0,"atrMult":0.0}',
  fin_long_daily_pct REAL NOT NULL DEFAULT 0,
  fin_short_daily_pct REAL NOT NULL DEFAULT 0,
  triple_swap_weekday INTEGER,
  rollover_hour_utc INTEGER NOT NULL DEFAULT 21,
  source TEXT NOT NULL DEFAULT 'manual',
  updated_at INTEGER NOT NULL
)
```
`upsert` fills missing keys with the column defaults, stamps `updated_at = int(time.time())`, uses `INSERT ... ON CONFLICT(epic) DO UPDATE`. `get` json.loads `slippage_json` inside try/except (ValueError, TypeError) with the fixed-zero default. Config: `cost_profiles_db_path: str = "cost_profiles.db"`.

- [ ] **Step 4: Run tests**

Run: `cd backend && uv run pytest tests/test_cost_profiles.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/core/cost_profiles.py backend/auto_trader/config.py backend/tests/test_cost_profiles.py
git commit -m "feat(core): per-instrument cost profile store"
```

---

### Task 5: Cost profile API routes with broker prefill

**Files:**
- Create: `backend/auto_trader/api/routers/costs.py`
- Modify: the FastAPI app assembly (where routers register; grep `include_router` under `backend/auto_trader/api/`) to include the new router
- Test: `backend/tests/test_api_cost_profiles.py` (create)

**Interfaces:**
- Consumes: `COST_PROFILES` from Task 4; `get_data(broker_id)` + `guarded(...)` from `auto_trader/api/deps.py` (markets.py re-imports them from there; import from deps directly).
- Produces routes (frontend Task 5 calls these exactly):
  - `GET /api/costs/{epic}?broker=<id>`: profile dict; on a miss, attempts broker prefill, persists `source:"broker"`, returns it; if the broker has nothing, returns a zeroed profile with `source:"manual"` WITHOUT persisting. Never 404s.
  - `PUT /api/costs/{epic}`: body = profile fields (spread, slippage, fins, tripleSwapWeekday, rolloverHourUtc); persists with `source:"manual"`; returns the stored profile.
  - `POST /api/costs/{epic}/refetch?broker=<id>`: forces a broker prefill, overwrites, returns `{"old": <prev or null>, "new": <profile>}`.

- [ ] **Step 1: Write failing tests**

Stub the broker at the registry seam (pattern: how `backend/tests/` stub brokers for the markets routes; follow the existing monkeypatch idiom there):

Use the repo's sync `TestClient` idiom (`tests/test_api_sweep_archive.py` pattern); NO pytest-asyncio in this repo:

```python
"""GET prefill, PUT manual wins, refetch reports old vs new."""
import pytest
from fastapi.testclient import TestClient

from auto_trader.api.app import app


class StubBroker:
    async def get_market_detail(self, epic):
        return {
            "snapshot": {"bid": 100.0, "offer": 100.8},
            "instrument": {"overnightFee": {
                "longRate": -0.0026, "shortRate": 0.001,
                "swapChargeTimestamp": 1784241600000,
            }},
        }


@pytest.fixture
def client(monkeypatch, tmp_path):
    from auto_trader.core import cost_profiles
    fresh = cost_profiles.CostProfileStore(str(tmp_path / "c.db"))
    monkeypatch.setattr(cost_profiles, "COST_PROFILES", fresh)
    from auto_trader.api.routers import costs as costs_router
    monkeypatch.setattr(costs_router, "COST_PROFILES", fresh)
    monkeypatch.setattr(costs_router, "get_data", lambda broker_id: StubBroker())
    return TestClient(app)


def test_get_prefills_from_broker(client):
    r = client.get("/api/costs/US100?broker=capital")
    body = r.json()
    assert r.status_code == 200
    assert body["spread"] == pytest.approx(0.8)
    assert body["finLongDailyPct"] == pytest.approx(-0.0026)
    assert body["source"] == "broker"


def test_put_manual_wins_over_next_get(client):
    client.get("/api/costs/US100?broker=capital")
    client.put("/api/costs/US100", json={"spread": 2.5})
    r = client.get("/api/costs/US100?broker=capital")
    assert r.json()["spread"] == 2.5
    assert r.json()["source"] == "manual"


def test_refetch_reports_old_and_new(client):
    client.put("/api/costs/US100", json={"spread": 9.9})
    r = client.post("/api/costs/US100/refetch?broker=capital")
    assert r.json()["old"]["spread"] == 9.9
    assert r.json()["new"]["spread"] == pytest.approx(0.8)
```

Note the stub also patches `guarded` if the real `guarded` wraps broker errors in a way that swallows the stub; check `api/deps.py` and patch at the seam the route actually calls.

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && uv run pytest tests/test_api_cost_profiles.py -q`
Expected: FAIL (no such routes).

- [ ] **Step 3: Implement**

`api/routers/costs.py`:

```python
"""Per-instrument cost profiles: broker-prefilled, user-editable, snapshotted
into runs by the frontend at submit time."""
from __future__ import annotations

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field

from auto_trader.api.deps import get_data, guarded
from auto_trader.core.cost_profiles import COST_PROFILES

router = APIRouter()


class CostProfileIn(BaseModel):
    spread: float | None = Field(default=None, ge=0)
    slippage: dict | None = None
    finLongDailyPct: float | None = None
    finShortDailyPct: float | None = None
    tripleSwapWeekday: int | None = Field(default=None, ge=0, le=6)
    rolloverHourUtc: int | None = Field(default=None, ge=0, le=23)


def _zeroed(epic: str) -> dict:
    return {"epic": epic, "spread": 0.0,
            "slippage": {"kind": "fixed", "value": 0.0, "atrMult": 0.0},
            "finLongDailyPct": 0.0, "finShortDailyPct": 0.0,
            "tripleSwapWeekday": None, "rolloverHourUtc": 21,
            "source": "manual", "updatedAt": 0}


async def _broker_prefill(broker_id: str, epic: str) -> dict | None:
    """Spread from the snapshot quote, financing from the instrument's
    overnightFee where the broker publishes it (IG, Capital). Numeric rates
    are treated as daily percent, matching what the market-info popover
    already renders. Returns None when the broker has no detail."""
    broker = get_data(broker_id)
    detail = await guarded(broker_id, lambda: broker.get_market_detail(epic), "market lookup")
    if not detail:
        return None
    snap = detail.get("snapshot") or {}
    inst = detail.get("instrument") or {}
    bid, offer = snap.get("bid"), snap.get("offer")
    spread = round(offer - bid, 10) if isinstance(bid, (int, float)) and isinstance(offer, (int, float)) else 0.0
    fee = inst.get("overnightFee") or {}
    def rate(key):
        v = fee.get(key)
        return float(v) if isinstance(v, (int, float)) else 0.0
    return {"spread": max(spread, 0.0),
            "finLongDailyPct": rate("longRate"), "finShortDailyPct": rate("shortRate")}


@router.get("/api/costs/{epic}")
async def get_profile(epic: str, broker_id: str = Query("capital", alias="broker")) -> dict:
    existing = await COST_PROFILES.get(epic)
    if existing:
        return existing
    fetched = await _broker_prefill(broker_id, epic)
    if fetched is None:
        return _zeroed(epic)
    await COST_PROFILES.upsert(epic, {**fetched, "source": "broker"})
    return await COST_PROFILES.get(epic)


@router.put("/api/costs/{epic}")
async def put_profile(epic: str, body: CostProfileIn) -> dict:
    current = await COST_PROFILES.get(epic) or _zeroed(epic)
    patch = {k: v for k, v in body.model_dump().items() if v is not None}
    await COST_PROFILES.upsert(epic, {**current, **patch, "source": "manual"})
    return await COST_PROFILES.get(epic)


@router.post("/api/costs/{epic}/refetch")
async def refetch_profile(epic: str, broker_id: str = Query("capital", alias="broker")) -> dict:
    old = await COST_PROFILES.get(epic)
    fetched = await _broker_prefill(broker_id, epic) or {}
    await COST_PROFILES.upsert(epic, {**(old or _zeroed(epic)), **fetched, "source": "broker"})
    return {"old": old, "new": await COST_PROFILES.get(epic)}
```
Register the router where the others register. Adjust the test's app import to the real module.

- [ ] **Step 4: Run tests**

Run: `cd backend && uv run pytest tests/test_api_cost_profiles.py tests/ -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/api/routers/costs.py backend/tests/test_api_cost_profiles.py
git commit -m "feat(api): cost profile routes with broker prefill"
```

---

### Task 6: Frontend cost model, profile client, Costs tab UI

**Files:**
- Modify: `frontend/src/lib/backtestConfig.ts` (Costs type ~line 268, default ~line 493, and the config normalizer/loader in the same file), `frontend/src/api.ts` (profile client + request type), `frontend/src/BacktestSettingsModal.tsx` (Costs section ~line 2220)
- Test: `frontend/src/lib/backtestConfig.test.ts` (extend), `frontend/src/BacktestSettingsModal.test.tsx` (extend)

**Interfaces:**
- Consumes: routes from Task 5, DTO shape from Task 3.
- Produces:

```ts
export type SlippageModel = { kind: "fixed" | "atr"; value: number; atrMult: number };
export type Costs = {
  quantity: number;
  commissionPerSide: number;
  slippage: SlippageModel;
  spread: number;
  finLongDailyPct: number;
  finShortDailyPct: number;
  tripleSwapWeekday: number | null;
  rolloverHourUtc: number;
  startingCash: number;
};
// api.ts
export type CostProfile = { epic: string; spread: number; slippage: SlippageModel;
  finLongDailyPct: number; finShortDailyPct: number; tripleSwapWeekday: number | null;
  rolloverHourUtc: number; source: "broker" | "manual"; updatedAt: number };
export async function getCostProfile(epic: string, broker: string): Promise<CostProfile>
export async function putCostProfile(epic: string, patch: Partial<CostProfile>): Promise<CostProfile>
export async function refetchCostProfile(epic: string, broker: string): Promise<{ old: CostProfile | null; new: CostProfile }>
```

- [ ] **Step 1: Write failing tests**

In `backtestConfig.test.ts`: the loader coerces a legacy numeric slippage (the ONE permitted coercion, spec-mandated):

```ts
it("coerces a persisted numeric slippage into the fixed model", () => {
  const stored = { ...defaultBacktestConfig(), costs: { quantity: 1, commissionPerSide: 0, slippage: 0.4, startingCash: 1000 } };
  const cfg = normalizeBacktestConfig(stored as unknown as BacktestConfig);
  expect(cfg.costs.slippage).toEqual({ kind: "fixed", value: 0.4, atrMult: 0 });
  expect(cfg.costs.spread).toBe(0);
  expect(cfg.costs.rolloverHourUtc).toBe(21);
});
```
(Use the file's actual normalizer name; if none exists, add `normalizeBacktestConfig` and call it wherever stored configs load.)

In `BacktestSettingsModal.test.tsx` (mock `getCostProfile` in the existing `vi.mock("./api", ...)` block to resolve `{ epic: "TEST", spread: 0.8, ... source: "broker" }`):

```ts
it("Costs tab shows the instrument profile and edits PUT back", async () => {
  renderModal();
  const nav = document.querySelector(".bt-htabs") as HTMLElement;
  fireEvent.click(within(nav).getByRole("button", { name: "Costs" }));
  await waitFor(() => expect((screen.getByLabelText("Spread") as HTMLInputElement).value).toBe("0.8"));
  expect(screen.getByText(/from broker/i)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Spread"), { target: { value: "1.2" } });
  await waitFor(() => expect(mockPutCostProfile).toHaveBeenCalledWith("TEST", expect.objectContaining({ spread: 1.2 })));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/lib/backtestConfig.test.ts src/BacktestSettingsModal.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

a) `backtestConfig.ts`: new types as above; default costs

```ts
costs: { quantity: 1, commissionPerSide: 0,
  slippage: { kind: "fixed", value: 0, atrMult: 0 },
  spread: 0, finLongDailyPct: 0, finShortDailyPct: 0,
  tripleSwapWeekday: null, rolloverHourUtc: 21, startingCash: 10_000 },
```
Normalizer: `typeof costs.slippage === "number"` becomes the fixed model; missing new fields fill from defaults.

b) `api.ts`: the three client functions following the file's existing fetch helpers, plus the request payload type change (`slippage` object and the five new fields ride `costs` into `/api/backtest` and sweeps automatically since the whole `costs` object is posted).

c) Costs tab: keep the four existing fields; replace the Slippage field with the model-aware version and append the "Instrument costs" group inside the same `bt-costs-grid`:

- Slippage row: keep the numeric input bound to `cfg.costs.slippage.value`; add a compact `<select>` (Fixed | ATR-scaled) bound to `kind`; when `kind === "atr"` render one more input for `atrMult` (label "x ATR", InfoTip: "Per-fill slippage is base + multiplier x ATR(14) of the bar, so fast markets cost more.").
- Spread field (`aria-label="Spread"`), InfoTip: "Full bid/ask spread in price units. Buys fill half a spread above the mid, sells half below."
- Financing fields Long %/night and Short %/night, InfoTip: "Charged per night a position is held, as a percent of entry notional. Negative values are a credit. Current broker rates approximate the past; brokers do not archive historical rates."
- One row with Triple-swap day select (None, Mon..Sun) and Rollover hour select (0..23, default 21).
- Source note under the group: muted text "from broker quote" or "manual" plus a refetch icon button wrapped in the shared `Tooltip` ("Refetch spread and financing from the broker").

Behavior: when the Costs section first renders for an epic, call `getCostProfile(epic, broker)` once (session cache keyed by epic) and write the profile values into `cfg.costs` (spread, slippage, fins, tripleSwapWeekday, rolloverHourUtc). Edits to any Instrument-costs field update `cfg.costs` AND fire a debounced `putCostProfile(epic, patch)`. Refetch calls `refetchCostProfile` and applies `new`.

Submitting a run posts `cfg.costs` as-is: that IS the snapshot (existing run persistence already stores the config).

d) Update any frontend fixtures/tests posting `slippage: number` in request bodies (grep `slippage` under `frontend/src`); if the coded-strategy TS-parity fixture asserts cost fields, update it to the object shape.

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run && npx tsc --noEmit`
Expected: full suite PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src
git commit -m "feat(backtest-ui): instrument costs group (spread, slippage model, financing) with broker prefill"
```

---

### Task 7: Results surface (financing line + per-trade financing)

**Files:**
- Modify: `frontend/src/api.ts` (response types: `financing_total` in metrics, `financing` on trades), `frontend/src/lib/backtestPanelData.ts` (METRIC_INFO entry), the Overview stats component (grep `PERFORMANCE` / where `net_pnl` stat cards render), and the trade detail/inspector component (grep where per-trade `mae`/`mfe` render)
- Test: extend the existing panel-data / overview test file (grep `METRIC_INFO` under `frontend/src` for its test)

**Interfaces:**
- Consumes: `financing_total` (metrics) and `financing` (TradeDTO) from Tasks 2-3.
- Produces: an Overview line "Financing" rendered only when `financing_total !== 0`; per-trade financing in the trade detail popover/inspector; both formatted with the app's existing pnl formatter.

- [ ] **Step 1: Write failing test**

In the panel-data test:

```ts
it("financing metric appears only when nonzero", () => {
  expect(overviewStats({ ...baseMetrics, financing_total: 0 }).some(s => s.label === "Financing")).toBe(false);
  const row = overviewStats({ ...baseMetrics, financing_total: -12.5 }).find(s => s.label === "Financing");
  expect(row?.value).toBe(fmtPnl(-12.5));
});
```
(Adapt to the real helper names in `backtestPanelData.ts`; if stats are assembled inline in the Overview component, test through render instead: metrics with `financing_total: -12.5` shows the "Financing" label, `0` does not.)

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run <that test file>`
Expected: FAIL.

- [ ] **Step 3: Implement**

- Response types: `financing_total?: number` on the metrics type, `financing?: number` on the trade type.
- METRIC_INFO gains `financing_total`: label "Financing", info "Total overnight financing paid (negative) or received across the run. Already included in net P&L."
- Overview: render the Financing stat only when the value is nonzero (Global Constraint: no new sections; it is one more stat card in the existing PERFORMANCE grid).
- Trade detail/inspector: add a "Financing" row when `trade.financing` is nonzero, same formatter as the pnl fields.

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src
git commit -m "feat(backtest-ui): financing line in run summary and trade detail"
```

---

## Self-review notes (already applied)

- Spec coverage: engine spread/slippage/financing (Tasks 1-2), R0 integration (Task 3c), store (Task 4), routes + prefill (Task 5), Costs tab + snapshot semantics (Task 6), results surface (Task 7). Out-of-scope items from the spec are not planned.
- The `_fill_price` signature change in Task 1 touches every caller including session-close and range-end paths; Task 1 step 3e lists them explicitly.
- Financing proportional allocation in `_reduce` computes the share BEFORE `p.qty` decrements (noted in Task 2 step 3e).
- Wire shapes are defined once (Task 3 for JSON, Task 6 mirrors them) and copied verbatim.
