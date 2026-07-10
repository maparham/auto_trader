# Limit Order Expiration Time Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "Expires" (good-till-date) control to limit orders — presets, a relative "in N minutes/hours/days" custom entry, and an absolute date-time — enforced end-to-end across the paper executor and all three real brokers, and editable on a resting order.

**Architecture:** One nullable field, `expires_at: datetime | None` (UTC), threaded through the whole stack: frontend `DraftOrder`/`PendingEdit` → `OrderRequest`/`LevelsRequest` → `Order`/`WorkingOrder` → broker adapter. No time-in-force enum; `None` = Good-Till-Cancelled (today's behavior). The dropdown is pure UI that resolves to `None` or an epoch-ms timestamp; relative durations resolve to an absolute instant in the browser at submit time. The paper executor enforces expiry with a wall-clock sweep in its existing 0.5s trigger driver; each real broker passes the date to its native good-till-date API field on both create and amend.

**Tech Stack:** Backend — Python 3.14, FastAPI, pydantic, dataclasses; tests via `asyncio.run` + hand-rolled fakes (no pytest fixtures/plugins). Frontend — React + TypeScript, signals, vitest + @testing-library/react.

## Global Constraints

- `expires_at` is always **UTC**. Backend compares against `datetime.now(timezone.utc)`; adapters format from a UTC-normalized datetime.
- `None`/absent `expires_at` MUST preserve today's Good-Till-Cancelled behavior byte-for-byte (no new keys sent to brokers when unset).
- Broker good-till-date string formats (exact, verified):
  - **IG:** `timeInForce="GOOD_TILL_DATE"` + `goodTillDate` as `%Y/%m/%d %H:%M:%S` (slash-separated, space, 24h, UTC — **not** ISO-8601).
  - **Capital.com:** `goodTillDate` as `%Y-%m-%dT%H:%M:%S` (ISO-like, **no** milliseconds, UTC). No `timeInForce` field exists.
  - **MT5/MetaApi:** `options={"expiration": {"type": "ORDER_TIME_SPECIFIED", "time": <tz-aware UTC datetime>}}`; pass a `datetime` object (SDK serializes it) — do NOT pre-format.
- Frontend field is `expiresAt: number | null` (epoch **ms**). Sent to the API as an ISO string via `new Date(ms).toISOString()`; `null` omits the field.
- Edit convention (mirrors SL/TP): in `modify_working_order`, `expires_at=None` **keeps** the order's current expiry, a datetime **sets** it, and `clear_expiry=True` **resets** to GTC. IG/Capital amend endpoints replace the order, so a kept expiry is re-sent by the caller (the frontend sends the resolved value on apply).
- Follow existing UI conventions: shared `Tooltip`/`InfoTip`, `.ot-field-block`/`.ot-flabel`/`.ot-input-row` classes, light theme first, no shadows. Reuse the shared `ExpirySelect` component in both the new-order and edit forms — never fork it.
- Run backend tests from `backend/` with `.venv` active: `python -m pytest <path> -v`. Run frontend tests from `frontend/`: `npx vitest run <path>`.

---

### Task 1: Data model + API schema fields

Add the `expires_at` field to the core models and the API DTOs. Pure data contract that every later task consumes. No behavior yet.

**Files:**
- Modify: `backend/auto_trader/core/models.py:185-200` (`Order`), `:251-263` (`WorkingOrder`)
- Modify: `backend/auto_trader/api/schemas.py:369-380` (`OrderRequest`), `:383-392` (`LevelsRequest`), `:395-403` (`WorkingOrderDTO`)
- Test: `backend/tests/test_models_expiry.py` (new)

**Interfaces:**
- Produces:
  - `Order(..., expires_at: datetime | None = None)`
  - `WorkingOrder(..., expires_at: datetime | None = None)`
  - `OrderRequest.expires_at: datetime | None = None`
  - `LevelsRequest.expires_at: datetime | None = None`, `LevelsRequest.clear_expiry: bool = False`
  - `WorkingOrderDTO.expires_at: datetime | None = None`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_models_expiry.py`:

```python
"""expires_at threads through the core models and API schemas as an optional
UTC field defaulting to None (= Good-Till-Cancelled)."""

from __future__ import annotations

from datetime import datetime, timezone

from auto_trader.api.schemas import LevelsRequest, OrderRequest, WorkingOrderDTO
from auto_trader.core.models import Order, Side, WorkingOrder


def test_order_expires_at_defaults_none() -> None:
    o = Order(epic="EURUSD", side=Side.BUY, quantity=1, client_order_id="c1")
    assert o.expires_at is None


def test_order_carries_expires_at() -> None:
    when = datetime(2026, 7, 11, 16, 0, tzinfo=timezone.utc)
    o = Order(epic="EURUSD", side=Side.BUY, quantity=1, client_order_id="c1", expires_at=when)
    assert o.expires_at == when


def test_working_order_expires_at_defaults_none() -> None:
    w = WorkingOrder(epic="EURUSD", side=Side.BUY, quantity=1, limit_level=1.1, order_id="WO-1")
    assert w.expires_at is None


def test_schemas_have_expiry_fields() -> None:
    assert OrderRequest.model_fields["expires_at"].default is None
    assert LevelsRequest.model_fields["expires_at"].default is None
    assert LevelsRequest.model_fields["clear_expiry"].default is False
    assert WorkingOrderDTO.model_fields["expires_at"].default is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_models_expiry.py -v`
Expected: FAIL — `TypeError: ... unexpected keyword argument 'expires_at'` / `KeyError: 'expires_at'`.

- [ ] **Step 3: Add the model fields**

In `backend/auto_trader/core/models.py`, add to `Order` (after `take_profit_level`, before `source`):

```python
    # Good-till-date expiry for a resting LIMIT order (UTC). None = Good-Till-
    # Cancelled (rests until filled or cancelled). Ignored for MARKET.
    expires_at: datetime | None = None
```

And to `WorkingOrder` (after `created_at`):

```python
    # Good-till-date expiry (UTC). None = Good-Till-Cancelled. The paper executor
    # cancels the order once now >= expires_at; real brokers enforce server-side.
    expires_at: datetime | None = None
```

(`datetime` is already imported in this module.)

- [ ] **Step 4: Add the schema fields**

In `backend/auto_trader/api/schemas.py`, add to `OrderRequest` (after `take_profit_level`):

```python
    expires_at: datetime | None = None  # good-till-date (UTC); None = GTC
```

Add to `LevelsRequest` (after `clear_take_profit`):

```python
    expires_at: datetime | None = None  # None = keep the order's current expiry
    clear_expiry: bool = False  # True = reset to Good-Till-Cancelled
```

Add to `WorkingOrderDTO` (after `created_at`):

```python
    expires_at: datetime | None = None
```

(`datetime` is already imported at the top of `schemas.py`; verify with `grep -n "from datetime" backend/auto_trader/api/schemas.py` and add `from datetime import datetime` if missing.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_models_expiry.py -v`
Expected: PASS (4 passed).

- [ ] **Step 6: Commit**

```bash
git add backend/auto_trader/core/models.py backend/auto_trader/api/schemas.py backend/tests/test_models_expiry.py
git commit -m "feat(orders): add expires_at field to order models + API schemas"
```

---

### Task 2: Paper executor — store + enforce expiry on place

Store `expires_at` on the resting order at placement, expose it on the DTO, wire the place route, and enforce expiry with a wall-clock sweep in the 0.5s trigger driver.

**Files:**
- Modify: `backend/auto_trader/brokers/paper_exec.py:218-228` (place → `WorkingOrder`), `:593-642` (`check_triggers`)
- Modify: `backend/auto_trader/api/routers/trading.py:59-69` (`_working_order_dto`), `:99-109` (`Order(...)` in place route)
- Test: `backend/tests/test_paper_exec_expiry.py` (new)

**Interfaces:**
- Consumes: `Order.expires_at`, `WorkingOrder.expires_at` (Task 1).
- Produces:
  - `paper_exec.expired_order_ids(now: datetime, working: list[WorkingOrder]) -> list[str]` (pure helper).
  - `PaperExecutionBroker.check_triggers()` cancels expired working orders (returns `changed=True`).
  - Place route passes `req.expires_at` into `Order`; `_working_order_dto` includes `expires_at`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_paper_exec_expiry.py`:

```python
"""Paper executor stores a limit order's expiry and cancels it once expired."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

from auto_trader.brokers.paper_exec import PaperExecutionBroker, expired_order_ids
from auto_trader.core.models import Order, OrderType, Side, WorkingOrder


class _FakeTicks:
    def __init__(self, tick: float | None = None) -> None:
        self.tick = tick

    def latest(self, broker: str | None, epic: str):
        return (1, self.tick) if self.tick is not None else None


class _FakeMarket:
    broker_id: str | None = "capital"

    def __init__(self, bid=100.0, ask=100.2) -> None:
        self.bid, self.ask = bid, ask

    async def get_quote(self, epic: str):
        return (self.bid, self.ask)


def _broker(tick: float | None = None) -> PaperExecutionBroker:
    return PaperExecutionBroker(_FakeMarket(), tick_store=_FakeTicks(tick))


def _limit(coid: str, level: float, expires_at) -> Order:
    return Order(
        epic="EURUSD", side=Side.BUY, quantity=1, client_order_id=coid,
        type=OrderType.LIMIT, limit_level=level, expires_at=expires_at,
    )


def test_expired_order_ids_selects_only_past() -> None:
    now = datetime(2026, 7, 11, 12, 0, tzinfo=timezone.utc)
    past = WorkingOrder(epic="E", side=Side.BUY, quantity=1, limit_level=1, order_id="a",
                        expires_at=now - timedelta(minutes=1))
    future = WorkingOrder(epic="E", side=Side.BUY, quantity=1, limit_level=1, order_id="b",
                          expires_at=now + timedelta(minutes=1))
    gtc = WorkingOrder(epic="E", side=Side.BUY, quantity=1, limit_level=1, order_id="c",
                       expires_at=None)
    assert expired_order_ids(now, [past, future, gtc]) == ["a"]


def test_place_stores_expiry_and_sweep_cancels_it() -> None:
    broker = _broker(tick=100.0)  # far from the limit (90) so it never fills
    past = datetime.now(timezone.utc) - timedelta(seconds=1)
    asyncio.run(broker.place_order(_limit("c1", 90.0, past)))

    orders = asyncio.run(broker.get_working_orders("EURUSD"))
    assert len(orders) == 1 and orders[0].expires_at == past

    changed = asyncio.run(broker.check_triggers())
    assert changed is True
    assert asyncio.run(broker.get_working_orders("EURUSD")) == []


def test_sweep_keeps_unexpired_and_gtc() -> None:
    broker = _broker(tick=100.0)
    future = datetime.now(timezone.utc) + timedelta(hours=1)
    asyncio.run(broker.place_order(_limit("c1", 90.0, future)))
    asyncio.run(broker.place_order(_limit("c2", 90.0, None)))

    asyncio.run(broker.check_triggers())
    assert len(asyncio.run(broker.get_working_orders("EURUSD"))) == 2
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_paper_exec_expiry.py -v`
Expected: FAIL — `ImportError: cannot import name 'expired_order_ids'`.

- [ ] **Step 3: Add the pure helper**

In `backend/auto_trader/brokers/paper_exec.py`, add after `validate_levels` (around line 111):

```python
def expired_order_ids(now: datetime, working: list[WorkingOrder]) -> list[str]:
    """PURE: order_ids whose good-till-date has passed. A None expiry (GTC) never
    expires. Kept separate from evaluate_triggers because expiry is time-driven,
    not price-driven — it must fire even for an epic with no live tick."""
    return [w.order_id for w in working if w.expires_at is not None and w.expires_at <= now]
```

- [ ] **Step 4: Store the expiry on place**

In `place_order`, the `WorkingOrder(...)` construction (around line 219) — add `expires_at`:

```python
                self._working[order_id] = WorkingOrder(
                    epic=order.epic,
                    side=order.side,
                    quantity=order.quantity,
                    limit_level=order.limit_level,
                    order_id=order_id,
                    stop_level=order.stop_level,
                    take_profit_level=order.take_profit_level,
                    created_at=submitted,
                    expires_at=order.expires_at,
                )
```

- [ ] **Step 5: Add the sweep to check_triggers**

In `check_triggers`, immediately inside `async with self._lock:` (before `epics = {...}`, around line 605):

```python
            now = datetime.now(timezone.utc)
            for oid in expired_order_ids(now, list(self._working.values())):
                self._working.pop(oid, None)
                changed = True
```

- [ ] **Step 6: Wire the route + DTO**

In `backend/auto_trader/api/routers/trading.py`, add to `_working_order_dto` (after `created_at=w.created_at,`):

```python
        expires_at=w.expires_at,
```

And in the place route's `Order(...)` (after `source=source,`):

```python
        expires_at=req.expires_at,
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_paper_exec_expiry.py tests/test_paper_exec.py -v`
Expected: PASS (new expiry tests + existing paper tests unchanged).

- [ ] **Step 8: Commit**

```bash
git add backend/auto_trader/brokers/paper_exec.py backend/auto_trader/api/routers/trading.py backend/tests/test_paper_exec_expiry.py
git commit -m "feat(paper): store limit expiry + cancel expired orders in trigger sweep"
```

---

### Task 3: Paper executor — edit expiry (modify_working_order) + base signature + route

Extend the modify path so an edit can set / keep / clear the expiry.

**Files:**
- Modify: `backend/auto_trader/brokers/base.py:184-196` (abstract `modify_working_order`)
- Modify: `backend/auto_trader/brokers/paper_exec.py:528-577` (`modify_working_order`)
- Modify: `backend/auto_trader/api/routers/trading.py:213-225` (modify route)
- Test: `backend/tests/test_paper_exec_expiry.py` (extend)

**Interfaces:**
- Consumes: `LevelsRequest.expires_at`, `LevelsRequest.clear_expiry` (Task 1).
- Produces: `ExecutionBroker.modify_working_order(..., expires_at: datetime | None = None, clear_expiry: bool = False)` — the new keyword-only params every executor now accepts.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_paper_exec_expiry.py`:

```python
def test_modify_keeps_expiry_by_default() -> None:
    broker = _broker(tick=100.0)
    future = datetime.now(timezone.utc) + timedelta(hours=1)
    r = asyncio.run(broker.place_order(_limit("c1", 90.0, future)))
    oid = r.deal_id

    asyncio.run(broker.modify_working_order(oid, limit_level=91.0))  # level-only edit
    wo = asyncio.run(broker.get_working_orders("EURUSD"))[0]
    assert wo.limit_level == 91.0
    assert wo.expires_at == future  # untouched


def test_modify_sets_and_clears_expiry() -> None:
    broker = _broker(tick=100.0)
    r = asyncio.run(broker.place_order(_limit("c1", 90.0, None)))
    oid = r.deal_id

    new = datetime.now(timezone.utc) + timedelta(hours=2)
    asyncio.run(broker.modify_working_order(oid, expires_at=new))
    assert asyncio.run(broker.get_working_orders("EURUSD"))[0].expires_at == new

    asyncio.run(broker.modify_working_order(oid, clear_expiry=True))
    assert asyncio.run(broker.get_working_orders("EURUSD"))[0].expires_at is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_paper_exec_expiry.py -k modify -v`
Expected: FAIL — `TypeError: modify_working_order() got an unexpected keyword argument 'expires_at'`.

- [ ] **Step 3: Extend the abstract signature**

In `backend/auto_trader/brokers/base.py`, `modify_working_order` — add the two params after `clear_take_profit: bool = False,`:

```python
        expires_at: datetime | None = None,
        clear_expiry: bool = False,
```

Update the docstring's last line to:

```python
        """Change a resting order's price and/or its attached SL/TP and expiry. A
        None level/expiry leaves it unchanged; clear_stop / clear_take_profit /
        clear_expiry remove it."""
```

(Verify `datetime` is imported in `base.py`; add `from datetime import datetime` under `from __future__ import annotations` if missing.)

- [ ] **Step 4: Implement in the paper executor**

In `backend/auto_trader/brokers/paper_exec.py`, `modify_working_order` — add the two params to the signature (after `clear_take_profit: bool = False,`):

```python
        expires_at: datetime | None = None,
        clear_expiry: bool = False,
```

Compute the new expiry (after the `new_tp = ...` line, around line 559):

```python
            new_expiry = (
                None if clear_expiry
                else (expires_at if expires_at is not None else wo.expires_at)
            )
```

And add `expires_at=new_expiry,` to the `WorkingOrder(...)` reconstruction (after `created_at=wo.created_at,`).

- [ ] **Step 5: Wire the route**

In `backend/auto_trader/api/routers/trading.py`, the `modify_working_order` route's broker call — add after `clear_take_profit=req.clear_take_profit,`:

```python
            expires_at=req.expires_at,
            clear_expiry=req.clear_expiry,
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_paper_exec_expiry.py -v`
Expected: PASS (all expiry tests).

- [ ] **Step 7: Commit**

```bash
git add backend/auto_trader/brokers/base.py backend/auto_trader/brokers/paper_exec.py backend/auto_trader/api/routers/trading.py backend/tests/test_paper_exec_expiry.py
git commit -m "feat(paper): edit a resting order's expiry (set/keep/clear)"
```

---

### Task 4: IG broker — good-till-date on create + amend

**Files:**
- Modify: `backend/auto_trader/brokers/ig.py:481-490` (LIMIT create body), `:647-680` (amend body)
- Test: `backend/tests/test_ig_expiry.py` (new)

**Interfaces:**
- Consumes: `Order.expires_at`; `modify_working_order(..., expires_at, clear_expiry)`.
- Produces: `ig._ig_gtd(expires_at: datetime) -> str` (module helper), used by both branches.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_ig_expiry.py`:

```python
"""IG maps expires_at to timeInForce=GOOD_TILL_DATE + goodTillDate (UTC,
yyyy/MM/dd HH:mm:ss). None keeps GOOD_TILL_CANCELLED."""

from __future__ import annotations

from datetime import datetime, timezone

from auto_trader.brokers.ig import _ig_gtd


def test_ig_gtd_format_utc() -> None:
    when = datetime(2026, 7, 11, 16, 30, 0, tzinfo=timezone.utc)
    assert _ig_gtd(when) == "2026/07/11 16:30:00"


def test_ig_gtd_normalizes_to_utc() -> None:
    # A tz-aware non-UTC instant is converted to UTC before formatting.
    from datetime import timedelta
    est = timezone(timedelta(hours=-5))
    when = datetime(2026, 7, 11, 11, 30, 0, tzinfo=est)  # 16:30 UTC
    assert _ig_gtd(when) == "2026/07/11 16:30:00"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_ig_expiry.py -v`
Expected: FAIL — `ImportError: cannot import name '_ig_gtd'`.

- [ ] **Step 3: Add the format helper**

In `backend/auto_trader/brokers/ig.py`, near the other module helpers (e.g. below `_currency_from_raw`), add:

```python
def _ig_gtd(expires_at: datetime) -> str:
    """IG good-till-date string: UTC, 'yyyy/MM/dd HH:mm:ss' (NOT ISO-8601)."""
    return expires_at.astimezone(timezone.utc).strftime("%Y/%m/%d %H:%M:%S")
```

(Verify `from datetime import datetime, timezone` is imported at the top of `ig.py`; add what's missing.)

- [ ] **Step 4: Run helper test to verify it passes**

Run: `cd backend && python -m pytest tests/test_ig_expiry.py -v`
Expected: PASS (2 passed).

- [ ] **Step 5: Write the failing body-shape tests**

Append to `backend/tests/test_ig_expiry.py`:

```python
def _tif(order_expires):
    """Reproduce the create-body time-in-force fields the LIMIT branch builds."""
    tif = "GOOD_TILL_DATE" if order_expires is not None else "GOOD_TILL_CANCELLED"
    body = {"timeInForce": tif}
    if order_expires is not None:
        body["goodTillDate"] = _ig_gtd(order_expires)
    return body


def test_create_body_gtc_when_no_expiry() -> None:
    b = _tif(None)
    assert b == {"timeInForce": "GOOD_TILL_CANCELLED"}


def test_create_body_gtd_when_expiry_set() -> None:
    when = datetime(2026, 7, 11, 16, 30, tzinfo=timezone.utc)
    b = _tif(when)
    assert b["timeInForce"] == "GOOD_TILL_DATE"
    assert b["goodTillDate"] == "2026/07/11 16:30:00"
```

(These assert the exact mapping logic; Step 6 makes the real broker bodies use the same rule.)

- [ ] **Step 6: Update the create body**

In `backend/auto_trader/brokers/ig.py`, the LIMIT create branch (around line 484) — replace the hardcoded `timeInForce`:

```python
            if order.type is OrderType.LIMIT:
                if order.limit_level is None:
                    return self._reject(order, "limit order requires a level", submitted)
                gtd = order.expires_at is not None
                body = _clean({
                    "epic": order.epic, "expiry": "-", "direction": direction,
                    "size": order.quantity, "level": order.limit_level, "type": "LIMIT",
                    "timeInForce": "GOOD_TILL_DATE" if gtd else "GOOD_TILL_CANCELLED",
                    "goodTillDate": _ig_gtd(order.expires_at) if gtd else None,
                    "guaranteedStop": False,
                    "forceOpen": True, "currencyCode": ccy,
                    "stopLevel": order.stop_level, "limitLevel": order.take_profit_level,
                })
```

(`_clean` drops the `None` `goodTillDate`, so the GTC path is unchanged.)

- [ ] **Step 7: Update the amend body**

In `modify_working_order` (around line 647) — add the params and compute the expiry. Add to the signature after `clear_take_profit: bool = False,`:

```python
        expires_at: datetime | None = None,
        clear_expiry: bool = False,
```

After `new_tp = ...` (around line 662), add:

```python
        new_expiry = None if clear_expiry else (expires_at if expires_at is not None else wo.expires_at)
```

Replace the `body = {...}` (around line 670-673). Because IG's PUT replaces and this body is sent raw (not `_clean`'d), send both time-in-force fields explicitly:

```python
        gtd = new_expiry is not None
        body = {
            "level": new_level, "type": "LIMIT",
            "timeInForce": "GOOD_TILL_DATE" if gtd else "GOOD_TILL_CANCELLED",
            "goodTillDate": _ig_gtd(new_expiry) if gtd else None,
            "guaranteedStop": False, "stopLevel": new_stop, "limitLevel": new_tp,
        }
```

Note: `wo.expires_at` requires IG's `get_working_orders` to populate `expires_at` on the `WorkingOrder` it returns. Check `get_working_orders` in `ig.py` — if it doesn't parse IG's returned `goodTillDate`, the carry-forward on a level-only edit relies on the frontend re-sending the resolved value (which Task 9 does). Leave `wo.expires_at` as the fallback; do not add IG response parsing in this task.

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_ig_expiry.py tests/test_ig.py -v`
Expected: PASS (new expiry tests + existing IG tests unchanged).

- [ ] **Step 9: Commit**

```bash
git add backend/auto_trader/brokers/ig.py backend/tests/test_ig_expiry.py
git commit -m "feat(ig): pass good-till-date on limit create + amend"
```

---

### Task 5: Capital.com broker — good-till-date on create + amend

**Files:**
- Modify: `backend/auto_trader/brokers/capital.py:605-612` (LIMIT create body), `:818-857` (amend)
- Test: `backend/tests/test_capital_expiry.py` (new)

**Interfaces:**
- Consumes: `Order.expires_at`; `modify_working_order(..., expires_at, clear_expiry)`.
- Produces: `capital._capital_gtd(expires_at: datetime) -> str` (module helper).

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_capital_expiry.py`:

```python
"""Capital.com maps expires_at to goodTillDate (UTC, YYYY-MM-DDTHH:MM:SS, no ms).
There is no timeInForce field — presence of goodTillDate implies GTD."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from auto_trader.brokers.capital import _capital_gtd


def test_capital_gtd_format_no_millis_utc() -> None:
    when = datetime(2022, 6, 9, 1, 1, 0, tzinfo=timezone.utc)
    assert _capital_gtd(when) == "2022-06-09T01:01:00"


def test_capital_gtd_normalizes_to_utc() -> None:
    est = timezone(timedelta(hours=-5))
    when = datetime(2022, 6, 8, 20, 1, 0, tzinfo=est)  # 01:01 UTC next day
    assert _capital_gtd(when) == "2022-06-09T01:01:00"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_capital_expiry.py -v`
Expected: FAIL — `ImportError: cannot import name '_capital_gtd'`.

- [ ] **Step 3: Add the format helper**

In `backend/auto_trader/brokers/capital.py`, near the other module helpers, add:

```python
def _capital_gtd(expires_at: datetime) -> str:
    """Capital.com good-till-date: UTC, 'YYYY-MM-DDTHH:MM:SS' (no milliseconds)."""
    return expires_at.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
```

(Verify `from datetime import datetime, timezone` at the top; add what's missing.)

- [ ] **Step 4: Run helper test to verify it passes**

Run: `cd backend && python -m pytest tests/test_capital_expiry.py -v`
Expected: PASS (2 passed).

- [ ] **Step 5: Update the create body**

In `backend/auto_trader/brokers/capital.py`, the LIMIT create branch (around line 608):

```python
                body = _clean({
                    "epic": order.epic, "direction": direction, "size": order.quantity,
                    "level": order.limit_level, "type": "LIMIT", "guaranteedStop": False,
                    "goodTillDate": _capital_gtd(order.expires_at) if order.expires_at is not None else None,
                    "stopLevel": order.stop_level, "profitLevel": order.take_profit_level,
                })
```

(`_clean` drops the `None` `goodTillDate` → GTC unchanged.)

- [ ] **Step 6: Update the amend body**

In `modify_working_order` (around line 818) — add to the signature after `clear_take_profit: bool = False,`:

```python
        expires_at: datetime | None = None,
        clear_expiry: bool = False,
```

Carry-forward from the fetched row (Capital returns `goodTillDate` on the working order). After `new_tp = ...` (around line 846):

```python
        # Capital's PUT replaces the order, so a kept expiry must be re-sent. Prefer
        # the caller's resolved value; fall back to the order's current goodTillDate.
        if clear_expiry:
            new_gtd = None
        elif expires_at is not None:
            new_gtd = _capital_gtd(expires_at)
        else:
            new_gtd = wod.get("goodTillDate")  # echo the current value verbatim
```

Then update the raw body (around line 850) to include it only when set:

```python
        body = {"level": new_level, "stopLevel": new_stop, "profitLevel": new_tp,
                "guaranteedStop": False, "trailingStop": False}
        if new_gtd is not None:
            body["goodTillDate"] = new_gtd
```

Note on `wod.get("goodTillDate")`: Capital echoes the good-till-date in responses (possibly with `.000` ms). If a demo test shows the echoed format is rejected on re-send, switch the fallback to reformat via `_capital_gtd(datetime.fromisoformat(...))`. The frontend (Task 9) sends the resolved `expires_at` on apply, so this fallback only matters for a level-only edit that doesn't touch expiry.

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_capital_expiry.py tests/test_capital.py tests/test_capital_exec.py -v`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/auto_trader/brokers/capital.py backend/tests/test_capital_expiry.py
git commit -m "feat(capital): pass goodTillDate on limit create + amend"
```

---

### Task 6: MT5 broker — expiration on create (+ amend pass-through)

**Files:**
- Modify: `backend/auto_trader/brokers/mt5.py:1029-1044` (LIMIT create), `:1191-1227` (modify)
- Test: `backend/tests/test_mt5_expiry.py` (new)

**Interfaces:**
- Consumes: `Order.expires_at`; `modify_working_order(..., expires_at, clear_expiry)`.
- Produces: `mt5._mt5_expiration(expires_at: datetime | None) -> dict | None` — the `options` payload (or `None` when GTC).

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_mt5_expiry.py`:

```python
"""MT5/MetaApi expiration options: ORDER_TIME_SPECIFIED + a tz-aware datetime
passed through untouched (the SDK serializes it). None = no options (GTC)."""

from __future__ import annotations

from datetime import datetime, timezone

from auto_trader.brokers.mt5 import _mt5_expiration


def test_none_gives_no_options() -> None:
    assert _mt5_expiration(None) is None


def test_datetime_builds_specified_option() -> None:
    when = datetime(2026, 7, 11, 16, 0, tzinfo=timezone.utc)
    opts = _mt5_expiration(when)
    assert opts == {"expiration": {"type": "ORDER_TIME_SPECIFIED", "time": when}}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_mt5_expiry.py -v`
Expected: FAIL — `ImportError: cannot import name '_mt5_expiration'`.

- [ ] **Step 3: Add the options helper**

In `backend/auto_trader/brokers/mt5.py`, near the top-level helpers, add:

```python
def _mt5_expiration(expires_at: datetime | None) -> dict | None:
    """MetaApi PendingTradeOptions payload for a good-till-date, or None for GTC.
    Passes the datetime object through — the SDK serializes it to UTC ISO itself."""
    if expires_at is None:
        return None
    return {"expiration": {"type": "ORDER_TIME_SPECIFIED", "time": expires_at}}
```

(Verify `datetime` is imported in `mt5.py`.)

- [ ] **Step 4: Run helper test to verify it passes**

Run: `cd backend && python -m pytest tests/test_mt5_expiry.py -v`
Expected: PASS (2 passed).

- [ ] **Step 5: Wire the create calls**

In `backend/auto_trader/brokers/mt5.py`, the LIMIT create branch (around line 1037), pass `options` when set:

```python
                opts = _mt5_expiration(order.expires_at)
                if order.side is Side.BUY:
                    resp = await self._data._bounded(
                        lambda c: c.create_limit_buy_order(
                            order.epic, lots, order.limit_level, sl, tp,
                            *( (opts,) if opts else () ),
                        )
                    )
                else:
                    resp = await self._data._bounded(
                        lambda c: c.create_limit_sell_order(
                            order.epic, lots, order.limit_level, sl, tp,
                            *( (opts,) if opts else () ),
                        )
                    )
```

(The `*((opts,) if opts else ())` spread keeps the GTC call identical to today — no trailing `options` arg — so existing MT5 behavior/tests are unchanged.)

- [ ] **Step 6: Wire the amend call (pass-through, needs demo test)**

In `modify_working_order` (around line 1191) — add to the signature after `clear_take_profit: bool = False,`:

```python
        expires_at: datetime | None = None,
        clear_expiry: bool = False,
```

Before the `modify_order` call (around line 1215), build the options and pass them through the SDK's untyped `options` slot:

```python
        # CAVEAT: the SDK's typed ModifyOrderOptions does NOT declare `expiration`;
        # this rides the untyped options pass-through and is UNVERIFIED against a
        # live MT5 account. clear_expiry falls back to GTC. Needs a demo test before
        # relying on it (MT5 dealing is untested end-to-end in this project).
        opts = None
        if not clear_expiry and expires_at is not None:
            opts = _mt5_expiration(expires_at)
        elif clear_expiry:
            opts = {"expiration": {"type": "ORDER_TIME_GTC"}}
        try:
            resp = await self._data._bounded(
                lambda c: c.modify_order(order_id, new_price, new_sl, new_tp,
                                         *((opts,) if opts else ()))
            )
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_mt5_expiry.py tests/test_mt5.py -v`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/auto_trader/brokers/mt5.py backend/tests/test_mt5_expiry.py
git commit -m "feat(mt5): expiration on limit create + amend pass-through (demo-test pending)"
```

---

### Task 7: Frontend — expiry resolution helper (pure)

A pure module that turns a dropdown choice into an epoch-ms timestamp (or null), formats it for the API, and validates it. No React — fully unit-testable.

**Files:**
- Create: `frontend/src/lib/expiry.ts`
- Test: `frontend/src/lib/expiry.test.ts` (new)

**Interfaces:**
- Produces:
  - `type ExpiryUnit = "minutes" | "hours" | "days"`
  - `type ExpiryChoice = { kind: "gtc" } | { kind: "preset"; preset: ExpiryPreset } | { kind: "relative"; amount: number; unit: ExpiryUnit } | { kind: "absolute"; atMs: number }`
  - `type ExpiryPreset = "endOfDay" | "endOfWeek" | "d30" | "d60" | "d90"`
  - `EXPIRY_PRESETS: { value: ExpiryPreset; label: string }[]`
  - `resolveExpiry(choice: ExpiryChoice, nowMs: number): number | null`
  - `expiryToApi(ms: number | null): string | null`
  - `isValidExpiry(ms: number | null, nowMs: number): boolean`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/expiry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveExpiry, expiryToApi, isValidExpiry } from "./expiry";

const NOW = Date.UTC(2026, 6, 11, 12, 0, 0); // 2026-07-11 12:00:00 UTC

describe("resolveExpiry", () => {
  it("gtc → null", () => {
    expect(resolveExpiry({ kind: "gtc" }, NOW)).toBeNull();
  });

  it("relative minutes → now + N*60_000", () => {
    expect(resolveExpiry({ kind: "relative", amount: 30, unit: "minutes" }, NOW)).toBe(NOW + 30 * 60_000);
  });

  it("relative hours", () => {
    expect(resolveExpiry({ kind: "relative", amount: 2, unit: "hours" }, NOW)).toBe(NOW + 2 * 3_600_000);
  });

  it("relative days", () => {
    expect(resolveExpiry({ kind: "relative", amount: 3, unit: "days" }, NOW)).toBe(NOW + 3 * 86_400_000);
  });

  it("absolute passes through", () => {
    expect(resolveExpiry({ kind: "absolute", atMs: NOW + 5000 }, NOW)).toBe(NOW + 5000);
  });

  it("preset d30 → now + 30 days", () => {
    expect(resolveExpiry({ kind: "preset", preset: "d30" }, NOW)).toBe(NOW + 30 * 86_400_000);
  });

  it("preset endOfDay → next UTC midnight is after now", () => {
    const eod = resolveExpiry({ kind: "preset", preset: "endOfDay" }, NOW)!;
    expect(eod).toBeGreaterThan(NOW);
    expect(new Date(eod).getUTCHours()).toBe(0);
  });
});

describe("expiryToApi", () => {
  it("null → null", () => expect(expiryToApi(null)).toBeNull());
  it("ms → ISO string", () => expect(expiryToApi(NOW)).toBe("2026-07-11T12:00:00.000Z"));
});

describe("isValidExpiry", () => {
  it("null (gtc) is valid", () => expect(isValidExpiry(null, NOW)).toBe(true));
  it("future is valid", () => expect(isValidExpiry(NOW + 1000, NOW)).toBe(true));
  it("past is invalid", () => expect(isValidExpiry(NOW - 1000, NOW)).toBe(false));
  it("now is invalid", () => expect(isValidExpiry(NOW, NOW)).toBe(false));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/expiry.test.ts`
Expected: FAIL — cannot resolve `./expiry`.

- [ ] **Step 3: Implement the helper**

Create `frontend/src/lib/expiry.ts`:

```ts
// Pure resolution of an "Expires" dropdown choice into an epoch-ms timestamp
// (or null = Good-Till-Cancelled). Relative durations resolve against a passed-in
// `nowMs` so this stays deterministic and testable; the caller passes Date.now().

export type ExpiryUnit = "minutes" | "hours" | "days";
export type ExpiryPreset = "endOfDay" | "endOfWeek" | "d30" | "d60" | "d90";

export type ExpiryChoice =
  | { kind: "gtc" }
  | { kind: "preset"; preset: ExpiryPreset }
  | { kind: "relative"; amount: number; unit: ExpiryUnit }
  | { kind: "absolute"; atMs: number };

export const EXPIRY_PRESETS: { value: ExpiryPreset; label: string }[] = [
  { value: "endOfDay", label: "End of day" },
  { value: "endOfWeek", label: "End of week" },
  { value: "d30", label: "30 days" },
  { value: "d60", label: "60 days" },
  { value: "d90", label: "90 days" },
];

const UNIT_MS: Record<ExpiryUnit, number> = {
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};

function presetMs(preset: ExpiryPreset, nowMs: number): number {
  const d = new Date(nowMs);
  switch (preset) {
    case "endOfDay": {
      // Next UTC midnight after now.
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
    }
    case "endOfWeek": {
      // Next UTC Monday 00:00 (getUTCDay: 0=Sun..6=Sat).
      const dow = d.getUTCDay();
      const daysToMon = ((8 - dow) % 7) || 7;
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + daysToMon);
    }
    case "d30":
      return nowMs + 30 * UNIT_MS.days;
    case "d60":
      return nowMs + 60 * UNIT_MS.days;
    case "d90":
      return nowMs + 90 * UNIT_MS.days;
  }
}

export function resolveExpiry(choice: ExpiryChoice, nowMs: number): number | null {
  switch (choice.kind) {
    case "gtc":
      return null;
    case "preset":
      return presetMs(choice.preset, nowMs);
    case "relative":
      return nowMs + choice.amount * UNIT_MS[choice.unit];
    case "absolute":
      return choice.atMs;
  }
}

/** Epoch ms → UTC ISO string for the API, or null to omit the field. */
export function expiryToApi(ms: number | null): string | null {
  return ms == null ? null : new Date(ms).toISOString();
}

/** null (GTC) is valid; a concrete expiry must be strictly in the future. */
export function isValidExpiry(ms: number | null, nowMs: number): boolean {
  return ms == null || ms > nowMs;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/expiry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/expiry.ts frontend/src/lib/expiry.test.ts
git commit -m "feat(frontend): pure expiry-resolution helper (presets/relative/absolute)"
```

---

### Task 8: Frontend — ExpirySelect component + new-order ticket wiring

Build the shared control and wire it into the new-order limit ticket, threading `expiresAt` through `DraftOrder` → `placeOrder` → `OrderRequest`.

**Files:**
- Create: `frontend/src/components/ExpirySelect.tsx`
- Modify: `frontend/src/lib/signals.ts:333-341` (`DraftOrder`)
- Modify: `frontend/src/lib/trading.ts:124-136` (`OrderRequest`), `:307-321` (`placeOrder` — no change needed if it spreads `req`; verify)
- Modify: `frontend/src/OrderTicket.tsx` (new-order draft build + submit + render)
- Test: `frontend/src/components/ExpirySelect.test.tsx` (new)

**Interfaces:**
- Consumes: `resolveExpiry`, `expiryToApi`, `isValidExpiry`, `EXPIRY_PRESETS`, `ExpiryChoice` (Task 7).
- Produces:
  - `DraftOrder.expiresAt: number | null`
  - `OrderRequest.expires_at?: string | null`
  - `<ExpirySelect value={number | null} onChange={(ms: number | null) => void} />` — resolves choices to epoch ms internally and calls `onChange`.

- [ ] **Step 1: Write the failing component test**

Create `frontend/src/components/ExpirySelect.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ExpirySelect from "./ExpirySelect";

describe("ExpirySelect", () => {
  it("defaults to Good-Till-Cancelled and reports null", () => {
    const onChange = vi.fn();
    render(<ExpirySelect value={null} onChange={onChange} />);
    expect(screen.getByRole("combobox")).toHaveValue("gtc");
  });

  it("selecting a preset reports a future timestamp", () => {
    const onChange = vi.fn();
    render(<ExpirySelect value={null} onChange={onChange} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "d30" } });
    const ms = onChange.mock.calls.at(-1)![0];
    expect(ms).toBeGreaterThan(Date.now());
  });

  it("custom relative entry reports now + duration", () => {
    const onChange = vi.fn();
    render(<ExpirySelect value={null} onChange={onChange} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "custom" } });
    // relative radio is the default custom mode; set amount to 45 minutes
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: "45" } });
    const ms = onChange.mock.calls.at(-1)![0];
    expect(ms).toBeGreaterThan(Date.now() + 44 * 60_000);
    expect(ms).toBeLessThan(Date.now() + 46 * 60_000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/ExpirySelect.test.tsx`
Expected: FAIL — cannot resolve `./ExpirySelect`.

- [ ] **Step 3: Implement ExpirySelect**

Create `frontend/src/components/ExpirySelect.tsx`:

```tsx
import { useState } from "react";
import {
  EXPIRY_PRESETS,
  resolveExpiry,
  type ExpiryPreset,
  type ExpiryUnit,
} from "../lib/expiry";

// A dropdown of GTC + good-till-date presets + Custom. Custom reveals an inline
// "In [n] [unit]" relative entry with a date-time fallback. Emits the resolved
// epoch-ms timestamp (or null = GTC) via onChange — the parent stores that.
type Mode = "relative" | "absolute";

interface Props {
  value: number | null; // resolved epoch ms, or null = GTC (for display seeding)
  onChange: (ms: number | null) => void;
}

export default function ExpirySelect({ value, onChange }: Props) {
  const [sel, setSel] = useState<string>(value == null ? "gtc" : "custom");
  const [mode, setMode] = useState<Mode>("relative");
  const [amount, setAmount] = useState("30");
  const [unit, setUnit] = useState<ExpiryUnit>("minutes");
  const [atLocal, setAtLocal] = useState(""); // <input type=datetime-local> value

  function emitPreset(preset: ExpiryPreset) {
    onChange(resolveExpiry({ kind: "preset", preset }, Date.now()));
  }
  function emitRelative(a: string, u: ExpiryUnit) {
    const n = Number(a);
    onChange(Number.isFinite(n) && n > 0 ? resolveExpiry({ kind: "relative", amount: n, unit: u }, Date.now()) : null);
  }
  function emitAbsolute(local: string) {
    const ms = local ? new Date(local).getTime() : NaN;
    onChange(Number.isFinite(ms) ? ms : null);
  }

  function onSelect(v: string) {
    setSel(v);
    if (v === "gtc") onChange(null);
    else if (v === "custom") {
      if (mode === "relative") emitRelative(amount, unit);
      else emitAbsolute(atLocal);
    } else emitPreset(v as ExpiryPreset);
  }

  return (
    <label className="ot-field-block">
      <span className="ot-flabel">Expires</span>
      <div className="ot-input-row">
        <select className="ot-input" value={sel} onChange={(e) => onSelect(e.target.value)}>
          <option value="gtc">Good-Till-Cancelled</option>
          {EXPIRY_PRESETS.map((p) => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
          <option value="custom">Custom…</option>
        </select>
      </div>

      {sel === "custom" && (
        <div className="ot-expiry-custom">
          <label>
            <input
              type="radio"
              name="expiry-mode"
              checked={mode === "relative"}
              onChange={() => { setMode("relative"); emitRelative(amount, unit); }}
            />
            In
            <input
              aria-label="amount"
              className="ot-input num"
              type="number"
              min="1"
              step="1"
              value={amount}
              onChange={(e) => { setAmount(e.target.value); if (mode === "relative") emitRelative(e.target.value, unit); }}
            />
            <select
              aria-label="unit"
              className="ot-input"
              value={unit}
              onChange={(e) => { const u = e.target.value as ExpiryUnit; setUnit(u); if (mode === "relative") emitRelative(amount, u); }}
            >
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
              <option value="days">days</option>
            </select>
          </label>
          <label>
            <input
              type="radio"
              name="expiry-mode"
              checked={mode === "absolute"}
              onChange={() => { setMode("absolute"); emitAbsolute(atLocal); }}
            />
            On
            <input
              aria-label="date-time"
              className="ot-input"
              type="datetime-local"
              value={atLocal}
              onChange={(e) => { setAtLocal(e.target.value); if (mode === "absolute") emitAbsolute(e.target.value); }}
            />
          </label>
        </div>
      )}
    </label>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/ExpirySelect.test.tsx`
Expected: PASS.

- [ ] **Step 5: Thread the field through signals + API types**

In `frontend/src/lib/signals.ts`, add to `DraftOrder` (after `takeProfit: number | null;`):

```ts
  expiresAt: number | null; // good-till-date, epoch ms; null = Good-Till-Cancelled
```

In `frontend/src/lib/trading.ts`, add to `OrderRequest` (after `take_profit_level?: number | null;`):

```ts
  expires_at?: string | null; // UTC ISO good-till-date; null/absent = GTC
```

(`placeOrder` already spreads `...req` into the POST body, so no change is needed there — verify at `trading.ts:307-321`.)

- [ ] **Step 6: Wire into the new-order ticket**

In `frontend/src/OrderTicket.tsx`:

Add `expiresAt: null` to the maintenance-effect `draftOrderSignal.set({...})` (the block around line 204-212, after `takeProfit: ...`):

```tsx
      expiresAt: myDraft?.expiresAt ?? null,
```

Import the helpers and component at the top:

```tsx
import ExpirySelect from "./components/ExpirySelect";
import { expiryToApi, isValidExpiry } from "./lib/expiry";
```

Render the control right after the Price `</label>` block (after line 400), still inside `{isLimit && ...}` — wrap so it only shows for limit:

```tsx
      {isLimit && (
        <ExpirySelect
          value={myDraft?.expiresAt ?? null}
          onChange={(ms) => patchDraft({ expiresAt: ms })}
        />
      )}
```

In `submit()`, block invalid expiries before placing (after the `qty` check, around line 283):

```tsx
    const expMs = isLimit ? myDraft?.expiresAt ?? null : null;
    if (!isValidExpiry(expMs, Date.now())) {
      setMsg("Expiration must be in the future.");
      return;
    }
```

And pass it into `placeOrder` (in the `placeOrder({...})` call, after `take_profit_level: tpVal,`):

```tsx
        expires_at: expiryToApi(expMs),
```

- [ ] **Step 7: Run tests + typecheck**

Run: `cd frontend && npx vitest run src/components/ExpirySelect.test.tsx src/lib/expiry.test.ts && npx tsc --noEmit`
Expected: PASS + no type errors.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/ExpirySelect.tsx frontend/src/components/ExpirySelect.test.tsx frontend/src/lib/signals.ts frontend/src/lib/trading.ts frontend/src/OrderTicket.tsx
git commit -m "feat(frontend): Expires control on the new-order limit ticket"
```

---

### Task 9: Frontend — edit an existing order's expiry + show it on the row

Seed the edit form from the order's current expiry, let the user change/clear it, send it on apply, and display the set expiry on the working-order.

**Files:**
- Modify: `frontend/src/lib/signals.ts:184-188` (`PendingEdit`)
- Modify: `frontend/src/lib/trading.ts:235-249` (`TradeView`), `:533-561` (`LevelEdit` + `applyEditedLevels`), and the working-order → `TradeView` mapping (find it: `grep -n "kind: \"order\"" trading.ts`)
- Modify: `frontend/src/OrderTicket.tsx` (`EditTicket` — render + apply)
- Test: `frontend/src/lib/trading.test.ts` (extend, if it covers `applyEditedLevels`; else add a focused test)

**Interfaces:**
- Consumes: `ExpirySelect`, `expiryToApi`, `isValidExpiry` (Tasks 7-8); backend `LevelsRequest.expires_at`/`clear_expiry` (Task 1); `WorkingOrderDTO.expires_at` (Task 2).
- Produces:
  - `PendingEdit.expiresAt?: number | null`
  - `TradeView.expiresAt: number | null` (working orders)
  - `LevelEdit.expires_at?: string | null`, `LevelEdit.clear_expiry?: boolean`
  - `applyEditedLevels(..., merged: { ...; expiresAt: number | null })` sends the resolved expiry + clear flag.

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/lib/trading.test.ts` (mock `fetch` per the file's existing pattern; if the file has no fetch-mock helper, mirror one from `trading.liveplumbing.test.ts`):

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import { applyEditedLevels } from "./trading";

describe("applyEditedLevels expiry", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sends expires_at ISO for a working order and clear_expiry when null", async () => {
    const calls: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: any) => {
      calls.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ status: "pending" }) } as Response;
    }));

    const at = Date.UTC(2026, 6, 11, 16, 0, 0);
    await applyEditedLevels(
      { kind: "order", id: "WO-1" },
      { price: 1.1, stop: null, takeProfit: null, expiresAt: at },
      "capital:paper",
    );
    expect(calls[0].expires_at).toBe("2026-07-11T16:00:00.000Z");
    expect(calls[0].clear_expiry).toBe(false);

    await applyEditedLevels(
      { kind: "order", id: "WO-1" },
      { price: 1.1, stop: null, takeProfit: null, expiresAt: null },
      "capital:paper",
    );
    expect(calls[1].expires_at).toBeNull();
    expect(calls[1].clear_expiry).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/trading.test.ts -t "applyEditedLevels expiry"`
Expected: FAIL — `applyEditedLevels` doesn't accept `expiresAt` / doesn't send `expires_at`.

- [ ] **Step 3: Extend the types + mapping**

In `frontend/src/lib/signals.ts`, add to `PendingEdit`:

```ts
  expiresAt?: number | null;
```

In `frontend/src/lib/trading.ts`, add to `TradeView` (after `openedAt: number | null;`):

```ts
  expiresAt: number | null; // working orders: good-till-date epoch ms; null = GTC
```

Add to `LevelEdit` (after `clear_take_profit?: boolean;`):

```ts
  expires_at?: string | null;
  clear_expiry?: boolean;
```

In the working-order → `TradeView` mapping (found via grep in Step's Files), set:

```ts
    expiresAt: w.expires_at != null ? Date.parse(w.expires_at) : null,
```

For the position → `TradeView` mapping, set `expiresAt: null` (positions have no expiry).

- [ ] **Step 4: Send expiry from applyEditedLevels**

In `frontend/src/lib/trading.ts`, change `applyEditedLevels`'s `merged` param type and body:

```ts
export async function applyEditedLevels(
  trade: { kind: "position" | "order"; id: string },
  merged: { price: number | null; stop: number | null; takeProfit: number | null; expiresAt?: number | null },
  account: TradeAccount = DEFAULT_ACCOUNT,
): Promise<OrderResult> {
  const exp = merged.expiresAt ?? null;
  return applyLevels(
    trade,
    {
      limit_level: trade.kind === "order" ? merged.price : null,
      stop_level: merged.stop,
      take_profit_level: merged.takeProfit,
      clear_stop: merged.stop == null,
      clear_take_profit: merged.takeProfit == null,
      // Expiry only applies to a resting order; a position ignores it.
      ...(trade.kind === "order"
        ? { expires_at: exp == null ? null : new Date(exp).toISOString(), clear_expiry: exp == null }
        : {}),
    },
    account,
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/trading.test.ts -t "applyEditedLevels expiry"`
Expected: PASS.

- [ ] **Step 6: Wire ExpirySelect into EditTicket + send on Update**

In `frontend/src/OrderTicket.tsx`, `EditTicket`:

Render the control for a working order only, after the entry-price `</label>` (around line 676), inside the form:

```tsx
      {isOrder && (
        <ExpirySelect
          value={pending.expiresAt !== undefined ? pending.expiresAt : (trade.expiresAt ?? null)}
          onChange={(ms) => patch({ expiresAt: ms })}
        />
      )}
```

In `update()`, pass the merged expiry into `applyEditedLevels`. Compute it from the pending edit falling back to the trade, and block a past value (around line 633):

```tsx
    const mergedExpiry = pending.expiresAt !== undefined ? pending.expiresAt : (trade.expiresAt ?? null);
    if (isOrder && !isValidExpiry(mergedExpiry, Date.now())) {
      setMsg("Expiration must be in the future.");
      return;
    }
```

And update the `applyEditedLevels` call to include it:

```tsx
      await applyEditedLevels(trade, { price, stop, takeProfit: tp, expiresAt: mergedExpiry }, account);
```

(`isValidExpiry` is already imported from Task 8's edit to the file's imports — verify the import line includes it.)

- [ ] **Step 7: Show the expiry on the working-order row**

Find where a working-order row renders its levels in the positions panel (`grep -rn "takeProfit\|priceLevel" frontend/src/PositionsPanel.tsx` or the dock component). Add a concise local-time expiry next to the order's other info, shown only when `trade.kind === "order" && trade.expiresAt != null`:

```tsx
{trade.kind === "order" && trade.expiresAt != null && (
  <span className="pos-expiry">
    exp {new Date(trade.expiresAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}
  </span>
)}
```

(Place it following the pattern used for the row's existing SL/TP text; keep copy concise per the audience conventions.)

- [ ] **Step 8: Run the full frontend suite + typecheck**

Run: `cd frontend && npx vitest run src/lib/expiry.test.ts src/components/ExpirySelect.test.tsx src/lib/trading.test.ts && npx tsc --noEmit`
Expected: PASS + no type errors.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/lib/signals.ts frontend/src/lib/trading.ts frontend/src/OrderTicket.tsx frontend/src/lib/trading.test.ts
git commit -m "feat(frontend): edit + display a resting order's expiry"
```

---

### Task 10: End-to-end verification

Manual + full-suite confirmation that the field flows through and enforces.

**Files:** none (verification only).

- [ ] **Step 1: Full backend suite**

Run: `cd backend && python -m pytest tests/test_models_expiry.py tests/test_paper_exec.py tests/test_paper_exec_expiry.py tests/test_ig_expiry.py tests/test_ig.py tests/test_capital_expiry.py tests/test_capital.py tests/test_mt5_expiry.py tests/test_mt5.py -v`
Expected: all PASS.

- [ ] **Step 2: Full frontend suite**

Run: `cd frontend && npx vitest run && npx tsc --noEmit`
Expected: all PASS, no type errors.

- [ ] **Step 3: Manual paper smoke test (use the /verify or /run skill to launch the app)**

  1. Open a chart, order ticket → Limit.
  2. Set a price away from the market, Expires → Custom → In 1 minutes → Buy.
  3. Confirm the order appears in the dock with an "exp …" time ~1 min out.
  4. Wait ~1 minute; confirm the order disappears (expiry sweep cancelled it) without filling.
  5. Place another limit, click its row, change Expires to 30 days, Update; confirm the row's exp time updates. Change it back to Good-Till-Cancelled, Update; confirm the exp text disappears.

- [ ] **Step 4: Note the MT5 caveat**

MT5 amend-expiry rides the SDK's untyped `options` pass-through and is unverified. If an MT5 demo account is available, place + amend a limit with an expiry and confirm it lands in the terminal; otherwise leave a note that MT5 edit-expiry needs a demo test (create-expiry is the supported path).

- [ ] **Step 5: Final commit (if any verification tweaks were needed)**

```bash
git add -A
git commit -m "test: end-to-end verification of limit-order expiration"
```

---

## Self-Review

**Spec coverage:**
- Data model (one nullable `expires_at`, no TIF enum) → Task 1. ✓
- Frontend presets + relative/absolute custom + validation → Tasks 7, 8. ✓
- Edit form control → Task 9. ✓
- Paper enforcement (wall-clock sweep, thread through every `WorkingOrder`) → Tasks 2, 3. ✓
- IG create + amend (`%Y/%m/%d %H:%M:%S`) → Task 4. ✓
- Capital create + amend (`%Y-%m-%dT%H:%M:%S`, no timeInForce, carry-forward) → Task 5. ✓
- MT5 create + amend pass-through (demo-test caveat) → Task 6. ✓
- Display on the working-order row → Task 9 Step 7. ✓
- Carry-forward on level-only edits → handled by the frontend re-sending the resolved expiry (Task 9 Step 6) + broker fallbacks (Tasks 4-5). ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. Two spots intentionally instruct a `grep` to locate an exact insertion point (working-order→TradeView mapping in Task 9; row-render site in Task 9 Step 7) because those line numbers weren't captured during planning — the surrounding code and the exact snippet to insert are both given.

**Type consistency:** `expires_at` (backend, `datetime | None`) / `expiresAt` (frontend, `number | null`) used consistently; `_ig_gtd`/`_capital_gtd`/`_mt5_expiration` helper names match between their defining task and the broker bodies; `resolveExpiry`/`expiryToApi`/`isValidExpiry` signatures match across Tasks 7-9.
