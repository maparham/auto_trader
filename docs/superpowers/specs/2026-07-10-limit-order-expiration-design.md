# Limit order expiration time — design

**Date:** 2026-07-10
**Status:** Approved, ready for implementation plan

## Problem

Limit orders have no expiration. A resting limit order sits until it fills or is
manually cancelled — there is no way to say "cancel this if it hasn't filled by
X". No expiration/time-in-force concept exists anywhere today: the frontend
`DraftOrder`, the backend `Order`/`WorkingOrder` models, and the `OrderRequest`
API schema all lack it, and IG's broker adapter hardcodes
`timeInForce=GOOD_TILL_CANCELLED`.

We want an "Expires" control on the order ticket (limit only) offering
Good-Till-Cancelled (default), Good-Till-Date presets, and a Custom option that
accepts a quick relative duration ("in 30 minutes") **or** an absolute date-time.
Expiration must be actually enforced, not just recorded.

## Decisions (locked during brainstorming)

- **Enforcement:** full — UI + API + models; the paper executor cancels resting
  orders when they expire; IG, Capital.com, and MT5 all pass the good-till-date
  through natively (each verified against its docs/SDK). No degradation branch.
- **Presets:** Good-Till-Cancelled + Good-Till-Date presets + Custom.
- **Custom input:** amount+unit ("In 30 minutes") with a date-time fallback.
- **Placement:** order ticket only (`OrderTicket.tsx`). Right-click quick-place
  keeps its fast default (GTC).
- **Editable:** the expiry of an already-placed resting order can be changed
  (including cleared back to GTC) via the same edit form used for its levels.

## Data model — one nullable field, no TIF enum

A single `expires_at: datetime | None` (UTC), threaded through the whole stack:

```
DraftOrder.expiresAt   (frontend, number | null — epoch ms)
  → OrderRequest.expires_at   (API schema, datetime | None)
  → Order.expires_at          (core model)
  → WorkingOrder.expires_at   (core model)
  → WorkingOrderDTO.expires_at (API schema, for display)
```

- `None` = Good-Till-Cancelled = today's behavior.
- Any preset / relative duration / custom date resolves to an absolute UTC
  timestamp.

**No `time_in_force` enum.** Every case the user chose collapses to this one
field. A TIF enum plus a separate date can drift into contradictory states
(`DAY` with a date, `GTD` with no date); one nullable field cannot. The
GTC-vs-GTD distinction reappears in exactly one place: the broker adapter.

**Relative durations resolve on the frontend at submit time.** "In 30 minutes"
becomes `now + 30min` as an absolute timestamp before it leaves the browser. The
backend never sees a duration — only `None` or an absolute instant. (Tradeoff:
client clock skew, negligible for short horizons; the alternative — send a
duration and anchor it backend-side — reintroduces two representations.)

## Frontend UI (`OrderTicket.tsx`, limit only)

A new "Expires" field, rendered only when `orderType === "limit"`, below the
Price field:

```
Expires  [ Good-Till-Cancelled ▾ ]
```

Dropdown options:
- **Good-Till-Cancelled** (default)
- End of day
- End of week
- 30 days
- 60 days
- 90 days
- **Custom…**

Selecting **Custom…** reveals an inline control:

```
◉ In [ 30 ] [ minutes ▾ ]      units: minutes / hours / days
○ On [ 2026-07-11 16:00 ]      native date-time input
```

- The radio toggles between relative-duration entry and an absolute date-time.
- Presets and Custom both compute a concrete `expiresAt` (epoch ms) stored on
  `draftOrderSignal` — the single source of truth, like price/SL/TP. It is NOT
  mirrored into separate local state.
- **Validation:** the resolved `expiresAt` must be `> now`. If not (empty custom
  field, past date-time, zero/negative amount), block submit with an inline
  message. A far-future preset is always valid.
- `submit()` passes `expires_at` (resolved absolute) into `placeOrder(...)`.
- Follow existing ticket conventions: `.ot-field-block` / `.ot-flabel` /
  `.ot-input-row`, shared `Tooltip` for any hint, light theme first, no shadows.

### Editing an existing order's expiry (`EditTicket`)

The same Expires control appears in `EditTicket` (the edit form shown when a
resting order's row is clicked) — but only for a working order (`isOrder`), not a
position. It is seeded from the order's current `expires_at` (a matching preset
if one fits, else the "On <date-time>" custom form; GTC when null). The user can
change it, clear it back to Good-Till-Cancelled, or leave it. Its value flows
into `applyEditedLevels` alongside the level edits.

The edit path uses the existing `pendingEditsSignal` merge convention; expiry is
one more optional field on `PendingEdit`. Reuse the same dropdown/custom
component built for the new-order ticket — do not fork it (extract it to a small
shared `ExpirySelect` if that's cleaner than passing it both signals).

## Paper enforcement (`paper_exec.py`)

`WorkingOrder` gains `expires_at: datetime | None`.

In `check_triggers`, **before** the per-epic tick loop, sweep *all* working
orders and drop any with `expires_at is not None and expires_at <= now`, setting
`changed=True` so the frontend refetches once via the existing trades-dirty push.

This works because `_run_paper_triggers` (`deps.py`) drives `check_triggers` on a
**0.5s wall-clock timer** (`_TRIGGER_INTERVAL`), independent of tick arrival — so
a time-based expiry fires within ~0.5s even for an epic that is not being
streamed (the per-epic fill loop, by contrast, only runs for epics with a live
tick). The expiry sweep must therefore iterate the full `self._working` map, not
just epics with a tick.

**Thread `expires_at` through every `WorkingOrder(...)` reconstruction** or it
silently drops:
- `place_order` — set it from `order.expires_at` when resting the order.
- `modify_working_order` — extend it to accept the expiry edit and follow the
  same three-way convention as SL/TP: `expires_at=None` keeps the existing
  `wo.expires_at` (a level-only edit must NOT wipe the expiry), a supplied
  datetime sets it, and a new `clear_expiry=True` flag resets it to GTC (None).
- the fill path in `check_triggers` — the synthesized fill `Order` doesn't need
  it (the order is leaving the book), but the `WorkingOrder` must retain it while
  resting.

Expiry cancellation is a silent drop (no position, no fill) — the row simply
disappears from the working-orders list, same as a manual cancel.

### Edit path plumbing (all layers)

Making expiry editable extends the level-edit flow, which today carries only
price + SL/TP:
- `LevelsRequest` (`schemas.py`) gains `expires_at: datetime | None` and
  `clear_expiry: bool = False` (mirrors `clear_stop`/`clear_take_profit`).
- The abstract `ExecutionBroker.modify_working_order` (`brokers/base.py`) gains
  `expires_at` + `clear_expiry` params; the `PUT /orders/working/{id}` route
  (`routers/trading.py`) passes them through.
- Frontend `applyEditedLevels` + `PendingEdit` (`lib/trading.ts`, `lib/signals.ts`)
  gain the resolved `expires_at` (and the clear case).

## Live brokers — native pass-through (create + amend)

All three brokers support good-till-date on both their create and amend
resting-order endpoints, so each adapter passes `expires_at` through natively.
When `expires_at is None`, every adapter keeps today's Good-Till-Cancelled
behavior (the field is simply omitted / left as GTC). API shapes verified against
each broker's docs / SDK:

- **IG (`ig.py`, LIMIT branch → `POST /workingorders/otc`, already the correct
  endpoint):** replace the hardcoded `"timeInForce": "GOOD_TILL_CANCELLED"` with:
  - `expires_at is None` → `GOOD_TILL_CANCELLED` (unchanged).
  - set → `"timeInForce": "GOOD_TILL_DATE"` **and**
    `"goodTillDate": expires_at.strftime("%Y/%m/%d %H:%M:%S")` in **UTC**.
    IG's format is slash-separated, space, 24h — **not** ISO-8601 (`-`/`T` are
    rejected). `_clean(...)` already drops `goodTillDate` when None, so GTC stays
    the default.
  - **Amend** (`ig.py` ~647-680, `PUT /workingorders/otc/{id}`): the v2 amend body
    accepts the same `timeInForce` + `goodTillDate` pair. Replace the hardcoded
    `GOOD_TILL_CANCELLED` with the resolved value so an edit sets/clears/keeps the
    expiry. **Carry-forward:** the PUT replaces the order, so a level-only edit
    must re-send the order's existing `goodTillDate` (resolved from its current
    `expires_at`) — otherwise it silently reverts to GTC.
- **Capital.com (`capital.py`):** both `POST /api/v1/workingorders` (create) and
  `PUT /api/v1/workingorders/{id}` (amend) take a single optional key
  `"goodTillDate": expires_at` formatted `"%Y-%m-%dT%H:%M:%S"` (ISO-like, **no
  milliseconds**, UTC). Capital has **no** `timeInForce` field — presence of
  `goodTillDate` implies GOOD_TILL_DATE, absence implies GTC. Omit when
  `expires_at is None`. **Carry-forward** applies to the amend PUT exactly as for
  IG: re-send the existing `goodTillDate` on a level-only edit, or it reverts to
  GTC.
- **MT5 (`mt5.py`, MetaApi):**
  - Create (`create_limit_buy_order`/`create_limit_sell_order`): append
    `options={"expiration": {"type": "ORDER_TIME_SPECIFIED", "time": expires_at}}`
    where `expires_at` is a **timezone-aware UTC `datetime`** (the SDK serializes
    it — do not pre-format). When `None`, omit `options` (or `ORDER_TIME_GTC`).
  - Amend (`modify_order`): **caveat — the SDK's typed `ModifyOrderOptions` does
    NOT include an `expiration` field** (only `PendingTradeOptions` does, on
    create). The `expiration` key may still reach the underlying `ORDER_MODIFY`
    via the SDK's untyped `options` pass-through, but this is unverified. MT5
    dealing is already untested end-to-end in this project, so: wire it via the
    pass-through, and mark editing an MT5 order's expiry as **needs a demo test**
    rather than claiming it works. Create-time expiry for MT5 is the supported
    path.

Because all three enforce server-side, no per-account gating or UI degradation is
needed — the Expires control is available for every account.

## Display

Show the set expiry on the resting-order row so the feature is not write-only:
the `WorkingOrderDTO.expires_at` flows to the frontend `TradeView` for a working
order and is shown (row text or tooltip) wherever the order's other levels are
shown. Formatting: local time, concise.

## Scope

**In (v1):**
- The Expires control (presets + Custom relative/absolute) on the limit ticket
  AND in the edit form for an existing resting order.
- Full frontend → API → model → broker threading of `expires_at`, for both place
  and amend.
- Paper executor expiry enforcement.
- Native good-till-date pass-through (create + amend) for IG, Capital.com, and
  MT5 — with MT5 amend-expiry flagged as needs-demo-test (see Live brokers).
- Showing the set expiry on the working-order row.

**Out (v1):**
- A live countdown timer on the row.

## Files touched (anticipated)

- `frontend/src/OrderTicket.tsx` — Expires control (shared `ExpirySelect`) in
  both the new-order ticket and `EditTicket`; validation, submit + apply wiring.
- `frontend/src/lib/signals.ts` — `DraftOrder.expiresAt`, `PendingEdit.expiresAt`.
- `frontend/src/lib/trading.ts` — `placeOrder` param; `applyEditedLevels` expiry
  (+ clear); `TradeView` expiry for working orders.
- `backend/auto_trader/api/schemas.py` — `OrderRequest.expires_at`,
  `LevelsRequest.expires_at` + `clear_expiry`, `WorkingOrderDTO.expires_at`.
- `backend/auto_trader/api/routers/trading.py` — pass `expires_at` into `Order`
  (place) and into `modify_working_order` (amend).
- `backend/auto_trader/core/models.py` — `Order.expires_at`,
  `WorkingOrder.expires_at`.
- `backend/auto_trader/brokers/base.py` — `modify_working_order` gains
  `expires_at` + `clear_expiry`.
- `backend/auto_trader/brokers/paper_exec.py` — expiry sweep + `WorkingOrder`
  reconstructions (place + modify) + modify honoring set/keep/clear.
- `backend/auto_trader/brokers/ig.py` — `timeInForce=GOOD_TILL_DATE` +
  `goodTillDate` (`%Y/%m/%d %H:%M:%S` UTC) in the LIMIT create AND amend branches.
- `backend/auto_trader/brokers/capital.py` — optional `goodTillDate`
  (`%Y-%m-%dT%H:%M:%S` UTC) in the create AND amend working-order bodies.
- `backend/auto_trader/brokers/mt5.py` — `options.expiration` on the limit
  create calls; `modify_order` pass-through on amend (needs demo test).

## Testing

- Pure unit test: an expiry sweep helper (given now + working orders → which
  expire), mirroring how `evaluate_triggers`/`validate_levels` are tested pure.
- Paper `place_order` with a past/near-future `expires_at` → order drops on the
  next `check_triggers` sweep.
- `modify_working_order`: level-only edit **preserves** `expires_at`; a supplied
  datetime **sets** it; `clear_expiry=True` **resets** to GTC (None).
- Frontend: relative-duration and date resolution → correct absolute `expiresAt`;
  past value blocks submit; edit form seeds from an order's current `expires_at`.
- Broker adapters (IG / Capital / MT5), create AND amend: `expires_at=None` →
  today's GTC body/call unchanged; set → the broker's good-till-date carried with
  the correct format (IG `%Y/%m/%d %H:%M:%S`; Capital `%Y-%m-%dT%H:%M:%S`; MT5
  `ORDER_TIME_SPECIFIED` + aware-UTC datetime). Assert the exact serialized shape
  per broker. For IG/Capital amend, assert a level-only edit re-sends the
  existing `goodTillDate` (carry-forward, no silent revert to GTC).
