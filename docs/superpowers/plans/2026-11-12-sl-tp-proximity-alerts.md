# SL/TP Proximity Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Opt-in per-position warnings when price nears a position's SL or TP, sent to Telegram (with a confirmed "Remove SL/TP" button), push and the in-app toast.

**Architecture:** A new `position` alert kind, kept out of `alert_kinds.KINDS` the way `account` is, with its own evaluator `POSITION_WATCH` (`core/position_watch.py`). It polls `get_positions` per watched account every 10 s to follow levels and closes, and borrows the price engine's live feeds through two new seams on `AlertEngine` (`set_extra_feeds`, `add_tick_listener`). Rows store one side each (`sl` or `tp`). The frontend adds the switches to the order ticket, a bell on each position row, a Positions group in the Alerts sidebar and a toast branch.

**Tech Stack:** Python 3 / FastAPI / pytest (`cd backend && uv run pytest tests/<file> -q`); React + TypeScript / vitest (`cd frontend && npx vitest run <file>`); typecheck `cd frontend && npx tsc -b`.

**Spec:** `docs/superpowers/specs/2026-11-12-sl-tp-proximity-alerts-design.md`

## Global Constraints

- Threshold = `atrMult × ATR(14)` of `MINUTE_15` mid candles of the position's epic on the data broker. Default `atrMult` 0.5, valid range 0.05 to 5.
- Data broker id = the exec key's prefix before `:` (`capital-live:live` → `capital-live`).
- Covered accounts: any registered exec account whose prefix is not `mt5` (MetaApi is never touched). Paper is allowed because it costs nothing extra.
- Watched price: a long uses the bid, a short uses the offer. If one side is missing, use the other, then mid.
- Fires on the first tick if already inside the threshold. Re-arms when distance > 1.5 × threshold, or when the level moves.
- Level removed or position closed → that alert row is deleted, no notification.
- Positions with a trailing stop: SL side refused (422 `trailing_stop`), TP side allowed. "Remove TP" on a trailing-stop position is refused before any broker call.
- Telegram removal: tap, then a separate confirm message (Yes / Cancel). Refuse if the level changed since the fire, the position is gone, the confirm is older than 600 s, the chat is not the owner, or the user may not deal from Telegram.
- Telegram dealing gate: `not auth_enabled()` or the user id is in `ADMIN_USER_IDS`. Message when refused: `Removing a stop from Telegram needs your user id in ADMIN_USER_IDS`.
- Telegram callback data ≤ 64 bytes: buttons carry an 8-char token, never ids or levels.
- Create/patch of `position` alerts require `deps.require_admin` (dealing gate).
- Limit orders: the ticket's switches are disabled for limit orders in this version (tooltip: `Available for market orders. Turn it on from the position once filled.`).
- UI copy: no em dashes; tooltips via `Tooltip`/`InfoTip`, short lines; muted (gray) on-state for the bell, not accent blue.
- Notification text: `US100 long · near SL · 12.4 pts (0.38 ATR) away · SL 18210.0 · P&L -84.20 USD` (P&L part dropped when unknown).
- Never run the full frontend suite; run only the listed test files. Ask before running tsc/vitest batches (user's laptop).

## Review Focus

1. **A level moved between the fire and the "Yes" tap.** The removal must refuse with `SL has changed since this warning` (Task 5 test `test_confirm_refuses_changed_level`).
2. **The position closes while a confirm is pending.** "Yes" must answer `Position is already closed` and call no broker (Task 5 test `test_confirm_refuses_closed_position`).
3. **A double "Yes" tap.** The second tap must not issue a second modify; the token is consumed on first use (Task 5 test `test_confirm_token_single_use`).
4. **The broker poll fails for a while.** Tracked positions must not be treated as closed (no alert deletions) on a failed `get_positions`; only a successful poll that lacks the deal deletes (Task 3 test `test_failed_poll_deletes_nothing`).
5. **ATR not yet known** (bars still loading or fetch failed). No fire and no crash until an ATR exists; `GET /api/alerts` shows `distanceAtr: null` (Task 3 test `test_no_atr_no_fire`).

---

### Task 1: Position-alert kind (pure logic)

**Files:**
- Create: `backend/auto_trader/core/position_alert_kind.py`
- Test: `backend/tests/test_position_alert_kind.py`

**Interfaces:**
- Produces:
  - `POSITION_KIND.validate(params: dict) -> None` (raises `ValueError`). Params: `{"dealId": str (1..128 chars), "side": "sl"|"tp", "atrMult": float in [0.05, 5]}`.
  - `POSITION_KIND.sig(params) -> str` = `json.dumps([dealId, side])` (atrMult excluded: same position+side is a duplicate).
  - `data_broker_of(account: str) -> str`
  - `is_watchable(account: str) -> bool` (False when prefix is `mt5`).
  - `watched_price(pos_side: str, bid, ask) -> float | None` (`pos_side` is `"BUY"`/`"SELL"`).
  - `step(level: float, price: float, threshold: float, fired: bool) -> tuple[bool, bool]` returns `(fired_after, fire_now)`.
  - `atr(candles: list[Candle], length: int = 14) -> float | None` (Wilder; None when fewer than `length + 1` candles).
  - `headline(epic, pos_side, alert_side, level, price, threshold_atr_units, atr_value, upnl, currency, precision) -> str`.

- [ ] **Step 1: Write the failing tests**

```python
def test_validate_rejects_bad_side():  pytest.raises(ValueError, POSITION_KIND.validate, {"dealId": "D1", "side": "x", "atrMult": 0.5})
def test_validate_rejects_mult_out_of_range(): for m in (0, 0.04, 5.1, float("nan"), True): raises
def test_sig_ignores_mult(): sig({"dealId":"D1","side":"sl","atrMult":0.5}) == sig({...,"atrMult":2})
def test_is_watchable(): is_watchable("capital-live:live") and is_watchable("mt5-self:live") and is_watchable("capital:paper") and not is_watchable("mt5:live")
def test_watched_price(): watched_price("BUY", 9, 11) == 9; watched_price("SELL", 9, 11) == 11; watched_price("BUY", None, 11) == 11
def test_step_fires_inside_on_first_tick(): step(100, 104, 5, False) == (True, True)
def test_step_no_refire_while_inside(): step(100, 103, 5, True) == (True, False)
def test_step_hysteresis(): step(100, 107, 5, True) == (True, False); step(100, 107.6, 5, True) == (False, False)
def test_step_works_for_both_directions(): step(100, 96, 5, False) == (True, True)
def test_atr_wilder_known_series(): 15 candles with constant range 2 and no gaps → atr == pytest.approx(2.0)
def test_atr_none_when_short(): atr(candles[:14]) is None
def test_headline(): headline("US100","BUY","sl",18210.0,18222.4,0.38... ) == "US100 long · near SL · 12.4 pts (0.38 ATR) away · SL 18210.0 · P&L -84.20 USD"
```

Write these as real pytest functions with the exact values above.

- [ ] **Step 2: Run, expect FAIL (module missing).** `cd backend && uv run pytest tests/test_position_alert_kind.py -q`
- [ ] **Step 3: Implement** `position_alert_kind.py` with the interfaces above. `step`: `dist = abs(price - level)`; if not fired and `dist <= threshold` → `(True, True)`; if fired and `dist > 1.5 * threshold` → `(False, False)`; else `(fired, False)`.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(alerts): position alert kind logic`

### Task 2: Engine seams and trailing-stop flag

**Files:**
- Modify: `backend/auto_trader/core/alert_engine.py` (`feeds_needed`, `on_tick`, `start` row filter)
- Modify: `backend/auto_trader/core/models.py` (`Position.trailing_stop: bool = False`)
- Modify: `backend/auto_trader/brokers/capital.py`, `backend/auto_trader/brokers/ig.py` (fill `trailing_stop` from the positions payload: Capital `position.trailingStop`; IG a non-null `trailingStopDistance`), `backend/auto_trader/api/schemas.py` (`PositionDTO.trailing_stop: bool = False`) and its mapping in `api/routers/trading.py`.
- Test: `backend/tests/test_alert_engine_feeds.py` (append), `backend/tests/test_position_trailing.py`

**Interfaces:**
- Produces:
  - `AlertEngine.set_extra_feeds(owner: str, pairs: set[tuple[str, str]]) -> None`: stores per owner, unions into `feeds_needed()`, sets `_reconcile_event`.
  - `AlertEngine.add_tick_listener(fn: Callable[[str, str, float, float | None, float | None], Awaitable[None]]) -> None`: called as `fn(broker, epic, mid, bid, ask)` at the end of every `on_tick`, each in its own try/except (log a warning, never raise).
  - `AlertEngine.start` skips rows with `kind == "position"` (same as `account`).
  - `Position.trailing_stop`, `PositionDTO.trailing_stop`.

- [ ] **Step 1: Tests:** `test_extra_feeds_spawn_and_drop` (set `{("capital","US100")}` → in `feeds_needed()`; set `set()` → gone), `test_tick_listener_called_and_isolated` (a raising listener does not stop a second one; both see `(broker, epic, mid, bid, ask)`), `test_start_skips_position_rows`, `test_capital_position_trailing_flag` (parse a recorded Capital positions payload with `trailingStop: true` → `trailing_stop is True`), same for IG.
- [ ] **Step 2: Run, expect FAIL.** `uv run pytest tests/test_alert_engine_feeds.py tests/test_position_trailing.py -q`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS; also run `tests/test_alert_engine.py` for no regressions.**
- [ ] **Step 5: Commit** `feat(alerts): engine feed seams for position alerts`

### Task 3: POSITION_WATCH evaluator

**Files:**
- Create: `backend/auto_trader/core/position_watch.py`
- Modify: `backend/auto_trader/api/app.py` (configure + start/stop beside `ACCOUNT_MONITOR`)
- Test: `backend/tests/test_position_watch.py`

**Interfaces:**
- Consumes: Task 1 functions; Task 2 seams; `AlertStore` (`list_all`, `delete`, `add_triggered`); `deps.get_exec`; `deps.load_alert_bars(broker, epic, "MINUTE_15", "mid", 60)`.
- Produces:
  - `PositionWatch.configure(store, get_exec, broadcast, notifiers, load_bars, engine, clock=time.time, sleep=asyncio.sleep)`
  - `async start()`, `async stop()`, `on_alert_changed(user_id, row | None, alert_id)` (sync, like the monitor's).
  - `async poll_once(account: str) -> None`: on success, updates `_snap[(account, deal_id)] = Snap(epic, side, sl, tp, trailing, upnl, currency)`; deletes rows whose deal is gone or whose level is now None (store delete + `__alerts__:changed` broadcast); resets `fired` when the level differs from the last seen level. On exception: log, change nothing.
  - `async on_tick(broker, epic, mid, bid, ask)`: for each row whose account's data broker and snap epic match, with ATR known: `step(...)`; on `fire_now` call `_fire`.
  - `status(user_id, alert_id) -> dict` = `{"level": float|None, "distanceAtr": float|None, "fired": bool, "trailing": bool}` for `GET /api/alerts`.
  - `async snapshot(account, deal_id) -> Snap | None` (fresh `get_positions` call, for the confirm step).
  - Fire payload (broadcast `__alerts__:fired` + notifiers): `{"id","kind":"position","broker": data_broker,"account": account,"epic","side": "sl"|"tp","level","price","atr","precision","headline","message","notify","time","triggered_id","removeToken"}`. Triggered history row: `kind "position"`, `condition "near"`.
  - `mint_remove_token(user_id, alert_id, level) -> str` (8 chars, `secrets.token_urlsafe`), stored in memory with mint time; `take_remove_token(token) -> tuple[user_id, alert_id, account, deal_id, side, level, minted_at] | None` (single use).
- Cadence: position poll 10 s per account with ≥1 active row; ATR refresh per (data broker, epic) when a new 15m bar is due (`floor(now/900)` changed) and at first need. Feeds registered via `engine.set_extra_feeds("position", pairs)` after each reconcile, where pairs come from snaps.

- [ ] **Step 1: Tests** with a fake exec broker and fake engine: `test_fires_on_first_tick_inside`, `test_no_refire_until_hysteresis`, `test_level_move_rearms`, `test_close_deletes_rows`, `test_level_removed_deletes_row`, `test_failed_poll_deletes_nothing`, `test_no_atr_no_fire`, `test_long_uses_bid_short_uses_ask`, `test_fire_payload_shape` (exact keys above), `test_registers_extra_feeds_by_data_broker` (`capital-live:live` + US100 → `("capital-live","US100")`), `test_remove_token_single_use`.
- [ ] **Step 2: Run, expect FAIL.** `uv run pytest tests/test_position_watch.py -q`
- [ ] **Step 3: Implement** following `account_monitor.py`'s structure (per-account task dict, `_reconcile`, notifier timeout `NOTIFIER_TIMEOUT_S`, failures logged and never skipping other channels). Wire in `app.py` with `notifiers=[TELEGRAM.notifier, PUSH.notifier]`, `engine=ALERT_ENGINE`, and `ALERT_ENGINE.add_tick_listener(POSITION_WATCH.on_tick)`.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(alerts): position watch evaluator`

### Task 4: `/api/alerts` support

**Files:**
- Modify: `backend/auto_trader/api/routers/alerts.py`
- Test: `backend/tests/test_position_alerts_api.py`

**Interfaces:**
- Consumes: `POSITION_KIND`, `is_watchable`, `POSITION_WATCH`.
- Produces: `POST /api/alerts` with `kind: "position"`, `broker: <exec key>`, `epic`, `params {dealId, side, atrMult}`. Errors: 422 `account_not_watchable`, 422 `position_not_found`, 422 `no_level` (that side has no level), 422 `trailing_stop` (side `sl` on a trailing position), 409 duplicate (existing `_check_duplicate` via sig). PATCH accepts only `atrMult` changes in params (dealId/side change → 422). `GET /api/alerts` merges `POSITION_WATCH.status(...)` into position rows. `_notify` routes `position` rows to `POSITION_WATCH.on_alert_changed`.

- [ ] **Step 1: Tests:** each error above, `test_create_requires_admin` (auth on, non-admin → 403), `test_list_decorates_status`, `test_patch_mult_only`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** (`_validate_kind`, `_validate_params`, `_sig`, `_notify`, list decoration; position lookup through `POSITION_WATCH.snapshot`).
- [ ] **Step 4: Run, expect PASS; also `tests/test_alerts_api*.py` if present.**
- [ ] **Step 5: Commit** `feat(alerts): position alerts in /api/alerts`

### Task 5: Telegram message, Remove button and confirm

**Files:**
- Modify: `backend/auto_trader/core/telegram_notify.py`, `backend/auto_trader/api/alert_hooks.py`, `backend/auto_trader/api/auth.py`
- Test: `backend/tests/test_telegram_position_remove.py`

**Interfaces:**
- Consumes: Task 3 fire payload (`removeToken`), `take_remove_token`, `snapshot`.
- Produces:
  - `auth.can_deal_from_telegram(user_id: str) -> bool`.
  - `AlertHooks.describe_removal(user_id, token) -> str | None` (e.g. `Remove SL on US100 long (SL 18210.0)?`; None when the token is unknown/expired/not this user's).
  - `AlertHooks.remove_level(user_id, token) -> str` returning one of: `SL removed ✓` / `TP removed ✓`, `Couldn't remove SL: <broker reason>`, `SL has changed since this warning`, `Position is already closed`, `This warning is too old (over 10 minutes)`, `Removing a stop from Telegram needs your user id in ADMIN_USER_IDS`, `Trailing stop: remove it in the broker`. On success the hook also deletes the alert row (level removed → alert gone).
  - Callback data: `pr:<token>` (on the fired message, label `Remove SL` / `Remove TP`), `pry:<token>` and `prn:<token>` (on the confirm message, labels `Yes, remove SL` / `Cancel`).
  - Notifier branch for `kind == "position"`: caption = `🔔 ` + headline (+ message line); chart photo via the existing `_render_snapshot` (payload `broker` is the data broker, `timeframe` `MINUTE_15`); markup `pr:` button. `pr:` sends a NEW message with the question and Yes/Cancel; the token is only consumed on `pry:`. `prn:` clears the confirm buttons and answers `Cancelled`.

- [ ] **Step 1: Tests:** `test_position_fire_has_remove_button`, `test_pr_sends_confirm_message`, `test_confirm_removes_and_deletes_alert` (asserts `modify_position(deal_id, clear_stop=True)`), `test_confirm_refuses_changed_level`, `test_confirm_refuses_closed_position`, `test_confirm_token_single_use`, `test_confirm_refuses_stale_token` (clock + 601 s), `test_confirm_refuses_wrong_chat`, `test_confirm_refuses_non_admin_hosted` (JWKS env set, user not in `ADMIN_USER_IDS`), `test_remove_tp_on_trailing_refused_without_broker_call`, `test_broker_rejection_reported`.
- [ ] **Step 2: Run, expect FAIL.** `uv run pytest tests/test_telegram_position_remove.py -q`
- [ ] **Step 3: Implement.** Validation order in `remove_level`: token → chat owner → gate → age → fresh snapshot (closed?) → level equals fired level (compare with `math.isclose(rel_tol=0, abs_tol=10**-precision / 2)`) → trailing (TP side) → `modify_position`.
- [ ] **Step 4: Run, expect PASS; also `tests/test_telegram_notify.py tests/test_telegram_rich_alerts.py`.**
- [ ] **Step 5: Commit** `feat(alerts): Telegram remove SL/TP with confirm`

### Task 6: Push payload

**Files:**
- Modify: `backend/auto_trader/core/push_notify.py` (pass `account`, `side`), `frontend/public/alert-sw.js` (a `position` branch: title `epic`, body `headline`; click behaviour unchanged)
- Test: `backend/tests/test_push_notify.py` (append `test_position_payload_carries_headline`)

- [ ] **Step 1: Test** → **Step 2: FAIL** → **Step 3: Implement** → **Step 4: PASS** → **Step 5: Commit** `feat(alerts): push for position alerts`

### Task 7: Frontend data layer and Settings default

**Files:**
- Modify: `frontend/src/lib/alertsApi.ts`, `frontend/src/theme.ts` (`Settings.proximityAtrMult: number`, default `0.5`), `frontend/src/Settings.tsx` (number field, label `Warn near SL/TP`, unit `× ATR`, InfoTip lines: `Default distance for new SL/TP warnings.` / `Measured in ATR(14) of 15m candles.`)
- Test: `frontend/src/lib/alertsApi.position.test.ts`

**Interfaces:**
- Produces:
  - `interface PositionAlert { kind: "position"; id; account; epic; dealId; side: "sl"|"tp"; atrMult; notify; createdAt?; level?: number|null; distanceAtr?: number|null; fired?: boolean; trailing?: boolean }`
  - `loadPositionAlerts(account?: string): PositionAlert[]`, `findPositionAlert(dealId: string, side): PositionAlert | undefined`, `addPositionAlert(a): Promise<string | null>` (null = ok, else the server's detail), `patchPositionAlert(id, atrMult): Promise<string | null>`, `deletePositionAlert(id): void`. Hydrated in the same resync as account alerts.
  - `FiredPayload` gains `account?`, `side?`, `headline?` (already there), kind `"position"`.

- [ ] **Step 1: Tests:** hydrate maps a server row; add posts `kind:"position"` with `broker: account`; a 422 returns its detail.
- [ ] **Step 2: FAIL** `cd frontend && npx vitest run src/lib/alertsApi.position.test.ts`
- [ ] **Step 3: Implement** mirroring the account-alert functions.
- [ ] **Step 4: PASS.**
- [ ] **Step 5: Commit** `feat(alerts): position alerts data layer`

### Task 8: Order ticket switches

**Files:**
- Create: `frontend/src/components/ProximityWarn.tsx` (switch + `× ATR` number input; props `{label: "Warn near TP"|"Warn near SL", on, mult, disabled, disabledReason?, onToggle, onMult}`)
- Modify: `frontend/src/OrderTicket.tsx` (one `ProximityWarn` under each `ExitRow` in the new-order form; state seeded from `settings.proximityAtrMult`; disabled when that exit is off or `isLimit`; after a placed market order with `result.deal_id`, call `addPositionAlert` per enabled side; if `deal_id` is null or a create fails, show `Order filled. Warning not set: <reason>` and keep the done state)
- Test: `frontend/src/OrderTicket.proximity.test.tsx`

- [ ] **Step 1: Tests:** switch disabled while SL off; disabled for limit with the tooltip text; filled market order with SL warning on → `addPositionAlert` called with `{dealId, side:"sl", atrMult:0.5}`; null `deal_id` → message shown.
- [ ] **Step 2: FAIL** → **Step 3: Implement** → **Step 4: PASS** (`npx vitest run src/OrderTicket.proximity.test.tsx src/OrderTicket.test.tsx`)
- [ ] **Step 5: Commit** `feat(ticket): warn near SL/TP switches`

### Task 9: Position-row bell, dialog and sidebar group

**Files:**
- Create: `frontend/src/PositionAlertModal.tsx` (two `ProximityWarn` rows for one position; SL row disabled on trailing with tooltip `Trailing stop: not supported`; a side with no level is disabled with `No SL set` / `No TP set`; Save creates/patches/deletes per side)
- Modify: `frontend/src/PositionsPanel.tsx` (bell action cell per position row, gray when on), `frontend/src/lib/accountStats.ts` or wherever `EnrichedTrade` is built (`trailingStop`), `frontend/src/AlertsSidebar.tsx` (a "Positions" group: `US100 long · SL · 0.5× ATR · now 0.8 ATR`, edit opens the modal, delete), `frontend/src/app/useAlertFiredNotices.ts` (`kind === "position"`: toast `🔔 headline`, browser notification, ping, click → `alertNavHandler.current?.(p.epic, p.id, prec, p.broker)`).
- Test: `frontend/src/PositionAlertModal.test.tsx`, `frontend/src/AlertsSidebar.test.tsx` (append), `frontend/src/app/useAlertFiredNotices.test.ts` (append or create)

- [ ] **Step 1: Tests:** modal saves both sides; trailing disables SL; sidebar lists a position row and deletes it; fired payload of kind position toasts the headline.
- [ ] **Step 2: FAIL** → **Step 3: Implement** → **Step 4: PASS** (only the listed files) → `npx tsc -b` and eslint on touched files.
- [ ] **Step 5: Commit** `feat(alerts): position alert bell, dialog and sidebar`

### Task 10: Probe, docs, end-to-end check

**Files:**
- Modify: `backend/scripts/alert_probe.py` (`--position ACCOUNT --deal DEAL --side sl|tp`: creates an alert with `atrMult 5` so it fires at once, waits for `__alerts__:fired`, deletes it)
- Modify: `CLAUDE.md` (a short "Position alerts" subsection under Alerts: kind, `POSITION_WATCH`, engine seams, Telegram confirm flow and gate, trailing rule, probe command)

- [ ] **Step 1:** Run the probe against `capital:demo` with a demo position; expect a fired payload within 30 s.
- [ ] **Step 2:** Manually tap Remove → Yes on the demo Telegram message; confirm the SL is gone on the broker and the alert row deleted.
- [ ] **Step 3: Commit** `docs(alerts): position alerts notes and probe`
