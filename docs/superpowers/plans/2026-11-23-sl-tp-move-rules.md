# SL/TP Move Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An alert trigger (price level, indicator output, or frozen line) can carry an action that moves one open position's SL or TP, once, server-side.

**Architecture:** A move rule is an ordinary alert row (`price_level` / `indicator` / `line`) with a new nullable `action` column. The alert engine evaluates it like any alert; on fire it hands the row to a new `MoveRules` executor instead of notifying. `MoveRules` reads the position fresh, applies the tighten-only rule, calls `modify_position`, records History and notifies. It also polls accounts with rules and deletes a rule when its deal closes. The frontend keeps these rows in their own cache, edits them from the order ticket (price trigger, draggable lines) and from the indicator and line alert modals (indicator / Trendlines triggers).

**Tech Stack:** Python 3 / FastAPI / sqlite (backend), React + TypeScript + klinecharts (frontend), pytest, vitest.

**Spec:** `docs/superpowers/specs/2026-11-23-sl-tp-move-rules-design.md`

## Global Constraints

- Only the one `action.dealId` on the one `action.account` is ever modified.
- A rule acts at most once: `params.trigger` is always `"once"`; a rule is never re-armable (`rearm` 422 `not_rearmable`).
- Tighten only. SL: long moves only up, short only down. TP: long moves only down, short only up. No current level: add it. Equal or tighter: skip.
- Breakeven = position `open_level` at fire time, plus `offset` (price units, `>= 0`) in the trade's favor.
- A failed move notifies on toast, push and Telegram regardless of the rule's `notify`.
- Create and patch of a move rule are admin-only (`deps.require_admin`).
- At most one move rule per (account, dealId, field): 409 otherwise. Move rules are checked ONLY by this rule, never by the plain alert `sig` check.
- Move rules have no expiry (`expires_at` must be null, 422 `move_no_expiry`).
- Move rule notify default: `{toast, push, telegram: true; browser, sound: false}`.
- Never report "moved" without reading the position back and seeing the new level.
- Price trigger uses the side price: bid for a long, offer for a short (`position_alert_kind.watched_price`). Indicator and line triggers keep the engine's usual price.
- No em dashes ("—" or "--") in UI text, notifications, or docs prose.
- Tooltips use `Tooltip` / `InfoTip`, never `title=`.
- Frontend checks: run only the affected vitest files (never the whole suite); typecheck with `npx tsc -b` and `npx eslint <files>`.
- Commit to the current branch (`main`), staging files by explicit path.

## Review Focus

1. **Deal closes between trigger and fire:** the executor's fresh read finds no deal; the rule is deleted silently, no `modify_position` call. Test in Task 5.
2. **Broker unreachable at fire time:** transient exceptions retry 3 times, then a failed notification goes out on all channels. Test in Task 5.
3. **User tightened the SL by hand past the target:** skip, notify "already at", no modify call. Test in Task 5.
4. **A plain alert and a move rule at the same level on the same epic:** they must not 409 against each other, and the move rule must never show as a plain alert line or a gray fired bell. Tests in Tasks 3 and 7.
5. **Backend restart with a rule saved:** the rule loads into the engine and the close sweep, and still acts once. A stop during a running move waits for it. Tests in Task 5.
6. **SL and TP rules fire on the same tick (or a manual Apply runs at the same time):** Capital's PUT replaces both levels, so the moves are serialized per deal and each one verified. Test in Task 5.

---

## File Structure

Backend (`backend/auto_trader/`):
- Create `core/move_rule.py`: pure logic (validate action, target level, tighten decision, headline text).
- Create `core/move_rules.py`: `MoveRules` executor + close sweep (`MOVE_RULES` singleton).
- Modify `core/alert_store.py`: `action` column, migration, row (de)serialization, updatable.
- Modify `api/routers/alerts.py`: create / patch / rearm / duplicate rules for move rules.
- Modify `core/alert_engine.py`: side price for move rows; route fire to an action handler.
- Modify `api/app.py`: configure / start / stop `MOVE_RULES`, wire it to the engine.
- Modify `core/telegram_notify.py`, `core/fcm_notify.py`, `core/push_notify.py`: `kind: "move"` text.
- Modify `scripts/alert_probe.py`: `--move` mode.
- Tests: `backend/tests/test_move_rule.py`, `test_move_rules.py`, `test_move_rules_api.py`, plus additions to `test_alert_store.py`, `test_alert_engine.py`, `test_telegram_rich_alerts.py`.

Frontend (`frontend/`):
- Modify `src/lib/alertsApi.ts`: `MoveRule` type, `moveCache`, CRUD, fired-bell exclusion, labels.
- Modify `src/app/useAlertFiredNotices.ts`, `public/alert-sw.js`: `kind: "move"` notices.
- Create `src/lib/moveRuleDraft.ts`: ticket draft signal and default trigger levels.
- Create `src/components/MoveRuleControl.tsx`: the ticket's Move SL / Move TP control.
- Modify `src/OrderTicket.tsx`: mount the controls; create rules after a market fill; edit mode.
- Create `src/lib/moveRuleLines.ts`: line specs and drag routing for move lines.
- Modify `src/ChartCore.tsx`, `src/chart/useLineDrag.ts`: draw and drag move lines.
- Create `src/components/MoveActionPicker.tsx`: the "Then" row in the alert modals.
- Modify `src/IndicatorAlertModal.tsx`, `src/LineAlertModal.tsx`, `src/chart/useTrendlineMenu.tsx`.
- Modify `src/PositionsPanel.tsx`, `src/AlertsSidebar.tsx`: row marker and sidebar listing.
- Docs: `docs/features/alerts.md` "Move rules" section.

---

### Task 1: Pure move-rule logic

**Files:**
- Create: `backend/auto_trader/core/move_rule.py`
- Test: `backend/tests/test_move_rule.py`

**Interfaces:**
- Produces:
  - `FIELDS = ("sl", "tp")`, `DIRECTIONS = ("BUY", "SELL")`
  - `validate_action(action: dict) -> None` (raises `ValueError`; checks `account` non-empty str, `dealId` str 1..128, `field` in FIELDS, `target` is `{"type": "price", "value": finite}` or `{"type": "breakeven", "offset": finite >= 0}`; `direction` NOT required here, the router sets it)
  - `target_level(target: dict, direction: str, open_level: float) -> float`
  - `decide(field: str, direction: str, current: float | None, target: float) -> str` returning `"move"` or `"skip"`
  - `headline(outcome: str, epic: str, direction: str, field: str, *, new: float | None, old: float | None, reason: str = "", precision: int) -> str` with `outcome` in `"moved" | "skipped" | "failed"`
  - `action_sig(action: dict) -> str` = json of `[account, dealId, field]`

- [ ] **Step 1: Write the failing tests**

```python
from auto_trader.core.move_rule import validate_action, target_level, decide, headline, action_sig
import pytest

def test_validate_ok_price_and_breakeven():
    validate_action({"account": "capital:demo", "dealId": "D1", "field": "sl", "target": {"type": "price", "value": 1.1}})
    validate_action({"account": "capital:demo", "dealId": "D1", "field": "tp", "target": {"type": "breakeven", "offset": 0}})

@pytest.mark.parametrize("bad", [
    {"account": "", "dealId": "D1", "field": "sl", "target": {"type": "price", "value": 1.1}},
    {"account": "a:b", "dealId": "D1", "field": "x", "target": {"type": "price", "value": 1.1}},
    {"account": "a:b", "dealId": "D1", "field": "sl", "target": {"type": "price", "value": "1.1"}},
    {"account": "a:b", "dealId": "D1", "field": "sl", "target": {"type": "breakeven", "offset": -1}},
    {"account": "a:b", "dealId": "D1", "field": "sl", "target": {"type": "other"}},
])
def test_validate_rejects(bad):
    with pytest.raises(ValueError):
        validate_action(bad)

def test_target_level():
    assert target_level({"type": "price", "value": 1.2}, "BUY", 1.0) == 1.2
    assert target_level({"type": "breakeven", "offset": 0.001}, "BUY", 1.0) == pytest.approx(1.001)
    assert target_level({"type": "breakeven", "offset": 0.001}, "SELL", 1.0) == pytest.approx(0.999)

@pytest.mark.parametrize("field,direction,current,target,want", [
    ("sl", "BUY", 0.95, 1.00, "move"), ("sl", "BUY", 1.00, 1.00, "skip"), ("sl", "BUY", 1.01, 1.00, "skip"),
    ("sl", "SELL", 1.05, 1.00, "move"), ("sl", "SELL", 0.99, 1.00, "skip"),
    ("tp", "BUY", 1.10, 1.05, "move"), ("tp", "BUY", 1.04, 1.05, "skip"),
    ("tp", "SELL", 0.90, 0.95, "move"), ("tp", "SELL", 0.96, 0.95, "skip"),
    ("sl", "BUY", None, 1.00, "move"), ("tp", "SELL", None, 0.95, "move"),
])
def test_decide(field, direction, current, target, want):
    assert decide(field, direction, current, target) == want

def test_headlines_have_no_em_dash():
    a = headline("moved", "EURUSD", "BUY", "sl", new=1.1, old=1.05, precision=4)
    b = headline("skipped", "EURUSD", "SELL", "tp", new=1.1, old=1.0, precision=4)
    c = headline("failed", "EURUSD", "BUY", "sl", new=1.1, old=None, reason="level too close", precision=4)
    assert a == "Moved SL of EURUSD long to 1.1000 (was 1.0500)"
    assert b == "TP of EURUSD short already at 1.0000, not moved to 1.1000"
    assert c == "Could not move SL of EURUSD long to 1.1000: level too close"
    assert headline("moved", "X", "BUY", "tp", new=2.0, old=None, precision=1) == "Moved TP of X long to 2.0 (was none)"
    for s in (a, b, c):
        assert "—" not in s and "--" not in s

def test_action_sig_ignores_target():
    a = {"account": "a:b", "dealId": "D", "field": "sl", "target": {"type": "price", "value": 1}}
    assert action_sig(a) == action_sig({**a, "target": {"type": "breakeven", "offset": 0}})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && python3 -m pytest tests/test_move_rule.py -q`
Expected: FAIL, `ModuleNotFoundError: auto_trader.core.move_rule`

- [ ] **Step 3: Implement `core/move_rule.py`** with the signatures above. Reuse `_finite` style from `position_alert_kind.py`. "long"/"short" come from BUY/SELL; "none" when `old` is None.

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && python3 -m pytest tests/test_move_rule.py -q`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add backend/auto_trader/core/move_rule.py backend/tests/test_move_rule.py
git commit -m "feat(move-rules): pure target, tighten and headline logic"
```

---

### Task 2: Store the `action` column

**Files:**
- Modify: `backend/auto_trader/core/alert_store.py` (`_SCHEMA`, `_UPDATABLE_FIELDS`, `_row_to_dict`, `_create_sync`, `_update_sync`, migrations list)
- Test: `backend/tests/test_alert_store.py`

**Interfaces:**
- Produces: every row dict carries `"action": dict | None`. `create(user, row)` stores `row.get("action")` as JSON (NULL when absent). `update(user, id, {"action": {...}})` replaces it. `alerts` table gains `action TEXT` (nullable).

- [ ] **Step 1: Write the failing tests** in `test_alert_store.py`:

```python
async def test_action_round_trip(tmp_path):
    store = AlertStore(str(tmp_path / "a.db"))
    act = {"account": "capital:demo", "dealId": "D1", "field": "sl", "direction": "BUY",
           "target": {"type": "breakeven", "offset": 0}}
    await store.create("u", _row(id="al-1", action=act))   # _row = this file's existing row helper
    await store.create("u", _row(id="al-2"))
    rows = {r["id"]: r for r in await store.list_user("u")}
    assert rows["al-1"]["action"] == act
    assert rows["al-2"]["action"] is None
    saved = await store.update("u", "al-1", {"action": {**act, "target": {"type": "price", "value": 1.2}}})
    assert saved["action"]["target"] == {"type": "price", "value": 1.2}

def test_action_migration_on_old_db(tmp_path):
    # an alerts table created without the column gains it, old rows read action=None
```

(Use the file's existing helper for a minimal row; if there is none, build the dict inline with the `_SCHEMA` columns.)

- [ ] **Step 2: Run to verify it fails**: `cd backend && python3 -m pytest tests/test_alert_store.py -q -k action` → FAIL (`KeyError: 'action'`).
- [ ] **Step 3: Implement.** Add `action TEXT` to `_SCHEMA`; add a migration `_migrate_alerts_action` guarded by `table_columns` (same pattern as `_migrate_triggered_alert_json`), registered as key `3` in the `run_migrations(conn, {1: ..., 2: ...})` dict in `AlertStore.__init__`; `_row_to_dict` decodes it (`None` stays `None`); add `"action"` to `_UPDATABLE_FIELDS` and encode on write.
- [ ] **Step 4: Run**: same command → pass; also `python3 -m pytest tests/test_alert_store.py tests/test_alert_migrate.py -q` → pass.
- [ ] **Step 5: Commit** `feat(move-rules): store an action on alert rows`.

---

### Task 3: API create / patch / rearm / duplicates

**Files:**
- Modify: `backend/auto_trader/api/routers/alerts.py`
- Test: `backend/tests/test_move_rules_api.py` (model the client and admin setup on `tests/test_position_alerts_api.py`)

**Interfaces:**
- Consumes: Task 1 `validate_action`, `action_sig`; Task 2 `action` column; `POSITION_WATCH.snapshot(account, deal_id) -> Snap | None` (has `epic`, `side`, `sl`, `tp`, `trailing`).
- Produces:
  - `CreateAlertBody.action: dict | None = None`, `PatchAlertBody.action: dict | None = None`.
  - Create with `action`: `require_admin`; `kind` must be in `KINDS` (else 422 `move_kind`); `validate_action` (422 with its message); `action["account"].split(":")[0] == body.broker` (else 422 `account_broker_mismatch`); `params["trigger"] = "once"` before `_validate_params`; snapshot check: `None` or epic differs → 422 `position_not_found`, `field == "sl"` and trailing → 422 `trailing_stop`, broker error → 503; the server sets `action["direction"] = snap.side`; duplicate: any stored row whose `action` has the same `action_sig` → 409 `A move rule for this position's SL already exists` (TP for tp).
  - `_check_duplicate` skips every row that has an `action`, and is not called at all for a move rule (create or patch). Move rules use only the `action_sig` check (patch passes `skip_id`).
  - `expires_at` set on a move rule → 422 `move_no_expiry`. Missing `notify` on a move rule defaults to `{toast: true, browser: false, sound: false, push: true, telegram: true}`.
  - Patch of a move rule: `require_admin`; `params.trigger` forced `"once"`. The wire body is `{params?, action?: {target}}`: the server merges `target` into the stored action. Any other key in `action` that differs from the stored value → 422 `action_locked`. Validate the merged action.
  - `rearm` on a History entry whose `alert.action` is set → 422 `not_rearmable`. The same refusal in the Telegram re-arm paths: `api/alert_hooks.py` `_rearm` returns None and `core/telegram_notify.py` `_rearm_from_triggered` answers "This rule can't be re-armed" for a row with `action`.
  - `_notify` additionally calls `MOVE_RULES.on_alert_changed(user, row, alert_id)` for every write (Task 5 makes it exist; in this task add a stub module-level no-op `on_alert_changed` in `core/move_rules.py` so the import works).

- [ ] **Step 1: Write the failing tests**

```python
def test_create_move_rule_sets_direction_and_once(client, fake_positions): ...
    # POST kind price_level, params {level, condition: "crossing_up", trigger: "every"}, action {...sl, breakeven}
    # → 200; body["params"]["trigger"] == "once"; body["action"]["direction"] == "BUY"
def test_create_requires_admin(client_non_admin): ...            # 403
def test_create_rejects_position_kind_with_action(client): ...   # kind "position" + action → 422 move_kind
def test_create_position_not_found(client, fake_positions): ...  # unknown deal → 422 position_not_found
def test_create_trailing_sl_refused(client, fake_positions): ... # trailing deal, field sl → 422 trailing_stop
def test_create_account_broker_mismatch(client): ...             # broker "ig", account "capital:demo" → 422
def test_one_rule_per_deal_field(client, fake_positions): ...    # 2nd sl rule (different level) → 409; a tp rule → 200
def test_plain_alert_and_move_rule_same_level_coexist(client, fake_positions): ...  # both 200
def test_patch_target_only(client, fake_positions): ...          # change target → 200; change dealId → 422 action_locked
def test_rearm_move_rule_refused(client, store): ...             # History entry with alert.action → 422 not_rearmable
def test_telegram_rearm_move_rule_refused(store): ...           # alert_hooks._rearm on a row with action → None, nothing created
def test_two_deals_same_trigger_level_ok(client, fake_positions): ...  # same level+condition, different dealId → both 200
def test_move_rule_expiry_refused(client, fake_positions): ...   # expires_at set → 422 move_no_expiry
```

Fill each body with the request and the asserted status/detail in the comment.

- [ ] **Step 2: Run**: `cd backend && python3 -m pytest tests/test_move_rules_api.py -q` → FAIL.
- [ ] **Step 3: Implement** in `alerts.py` as listed in Interfaces. Store `action` in the created `row`.
- [ ] **Step 4: Run** the new file plus `tests/test_alerts_api.py tests/test_position_alerts_api.py tests/test_telegram_rich_alerts.py` → pass.
- [ ] **Step 5: Commit** `feat(move-rules): create, patch and refuse rearm for move rules`.

---

### Task 4: Engine routes move-rule fires

**Files:**
- Modify: `backend/auto_trader/core/alert_engine.py` (`__init__`, new `set_action_handler`, `_evaluate_one` price pick, `_fire`)
- Test: `backend/tests/test_alert_engine.py`

**Interfaces:**
- Produces: `AlertEngine.set_action_handler(fn: Callable[[str, dict, float, float], Awaitable[None]] | None) -> None`, called as `fn(user_id, row, price, level)`.
- Behavior:
  - In `_evaluate_one`, for a row with `action` and kind `price_level`, `price = watched_price(row["action"]["direction"], bid, ask)` (fallback mid when both are None).
  - In `_fire`, a row with `action`: do NOT write History, broadcast, or call notifiers. Spawn `fn(...)` with `asyncio.ensure_future`, keep the task in a set (discard on done, log exceptions). With no handler set, an action row is skipped in `_evaluate_one` before evaluation (no fire, no `result.remove`), so it waits until the handler is wired.
  - The existing `result.remove` path still deletes the row (trigger is `once`).

- [ ] **Step 1: Write the failing tests**

```python
async def test_move_row_fires_handler_not_notifiers(engine, store): ...
    # row price_level level 1.10 crossing_up, action direction BUY; ticks bid 1.09 → 1.11
    # handler called once with (user, row, 1.11, 1.10); notifiers list empty-called; store has no triggered rows; row deleted
async def test_move_row_long_uses_bid(engine): ...
    # long, level 1.10 crossing_up: tick1 mid 1.095 bid 1.094 ask 1.096; tick2 mid 1.105 bid 1.099 ask 1.111 → no fire (mid crossed, bid did not)
async def test_move_row_short_uses_ask(engine): ...
    # short, level 1.10 crossing_down: tick1 ask 1.106 bid 1.104; tick2 ask 1.101 bid 1.09 → no fire
async def test_move_row_waits_without_handler(engine): ...
    # no handler set; ticks cross → handler not called, row still in the store
```

- [ ] **Step 2: Run**: `cd backend && python3 -m pytest tests/test_alert_engine.py -q -k move` → FAIL.
- [ ] **Step 3: Implement** as above.
- [ ] **Step 4: Run** `python3 -m pytest tests/test_alert_engine.py tests/test_alert_engine_feeds.py -q` → pass.
- [ ] **Step 5: Commit** `feat(move-rules): engine hands move-rule fires to an action handler`.

---

### Task 5: `MoveRules` executor and close sweep, wired into the app

**Files:**
- Modify (replace Task 3's stub): `backend/auto_trader/core/move_rules.py`
- Modify: `backend/auto_trader/api/app.py` (configure after `POSITION_WATCH`, `start`/`stop` alongside it)
- Test: `backend/tests/test_move_rules.py` (fake exec adapter with `get_positions()` and `modify_position()`; model on `tests/test_position_watch.py`)

**Interfaces:**
- Consumes: Task 1 functions; Task 4 `set_action_handler`; `ExecBroker.get_positions() -> list[Position]`, `modify_position(deal_id, *, stop_level=None, take_profit_level=None) -> OrderResult` (`status`, `reason`).
- Produces: `MOVE_RULES = MoveRules()` with
  - `configure(store, get_exec, broadcast, notifiers, engine, *, sleep=asyncio.sleep, clock=time.time) -> None` (calls `engine.set_action_handler(self.execute)`)
  - `async start() / stop()`; `start` loads every stored row with `action` into its registry
  - `on_alert_changed(user_id, row | None, alert_id) -> None`
  - `async execute(user_id, row, price, level) -> str` returning `"moved" | "skipped" | "failed" | "gone"`
  - `async poll_once(account) -> None`
  - constants `POLL_S = 10.0`, `FETCH_TIMEOUT_S = 10.0`, `RETRY_WAIT_S = 5.0`, `BUDGET_S = 30.0`, `STOP_WAIT_S = 35.0`
- Execute flow:
  - First, drop the rule from the sweep registry (the engine already deleted the row).
  - Hold one `asyncio.Lock` per `(account, dealId)` for the whole read → decide → modify → verify, so an SL rule and a TP rule on one deal never overlap (Capital's PUT replaces both levels, `brokers/capital.py:827-857`).
  - Loop until done or `BUDGET_S` has passed since the fire: fresh `get_positions` (timeout `FETCH_TIMEOUT_S`); deal missing → `"gone"`, nothing written or sent. SL rule on a trailing position → failed (`reason "trailing stop"`). Compute the target (`target_level`). If an earlier try in this execute returned `UNKNOWN` or raised, and the current level already equals the target (within half a tick at `precision`), report moved. Otherwise `decide` against the current level; `"skip"` → skipped; `"move"` → `modify_position` with only the one level.
  - `FILLED` → read the position again; the level equals the target (within half a tick) → moved; otherwise failed with reason `"broker did not keep the new level"`.
  - `REJECTED` → failed with `result.reason`, no retry. `BrokerBlocked` → failed, no retry.
  - `UNKNOWN` or an exception (read or modify) → wait `RETRY_WAIT_S`, then loop again from the fresh read.
  - Budget spent → failed with the last reason. Every non-gone outcome: `store.add_triggered` (`kind: "move"`, `price`, `level` = new level, `condition` from params, `message`, `precision`, `alert_json` = row plus `headline` and `outcome`); broadcast `__alerts__:fired` with payload `{id, kind: "move", outcome, broker: data broker, account, epic, field, level, price, precision, headline, message, notify, time, triggered_id}`; `notify` is forced to all channels `True` when failed; then notifiers (each with a 30 s timeout, failures logged). Broadcast `__alerts__:changed` after.
- `stop()`: wait up to `STOP_WAIT_S` for running executes (`asyncio.shield`), then cancel the sweep loops.
- Close sweep: one loop per account that has active rules, `poll_once` every POLL_S. A successful poll that lacks a rule's deal deletes the row (`store.delete`, `engine.on_alert_changed(user, None, id)`, broadcast `__alerts__:changed`), silently. A failed poll deletes nothing.

- [ ] **Step 1: Write the failing tests**

```python
async def test_moves_sl_to_breakeven_with_offset(): ...   # long open 1.0, sl 0.95, BE offset 0.001 → modify(stop_level=1.001); "moved"; 1 triggered row kind move; payload headline "Moved SL of EURUSD long to 1.0010 (was 0.9500)"
async def test_adds_missing_tp(): ...                    # tp None, target price 1.05 → modify(take_profit_level=1.05)
async def test_skip_when_already_tighter(): ...          # sl 1.02, BE target 1.0 → no modify; "skipped"; headline "already at"
async def test_gone_deal_is_silent(): ...                # no deal → "gone"; no modify, no triggered, no broadcast
async def test_rejected_is_not_retried_and_notifies_all(): ...  # REJECTED reason "too close" → 1 modify call; payload notify all True; "failed"
async def test_transient_error_retries_then_fails(): ... # modify always raises; fake clock past BUDGET_S → "failed"; a read before each try
async def test_transient_error_then_success(): ...       # raises once, then FILLED and the read-back shows the level → "moved"
async def test_unknown_but_landed_reports_moved(): ...   # modify returns UNKNOWN; next read shows the target → "moved", one modify call
async def test_filled_but_not_kept_fails(): ...          # FILLED, read-back shows the old level → "failed" "broker did not keep the new level"
async def test_sl_and_tp_serialized_per_deal(): ...      # SL and TP rules fire together; the fake broker's PUT replaces both levels from its own read; both levels end at their targets
async def test_execute_drops_rule_from_sweep(): ...      # after execute, poll_once neither deletes nor tracks it
async def test_stop_waits_for_running_execute(): ...     # stop() during a slow modify → execute completes and notifies
async def test_trailing_sl_fails(): ...
async def test_sweep_deletes_rule_of_closed_deal(): ...  # poll without the deal → store.delete + engine.on_alert_changed(u, None, id)
async def test_sweep_failed_poll_deletes_nothing(): ...
async def test_start_loads_saved_rules(): ...            # rows with action in store → sweep task for that account
```

- [ ] **Step 2: Run**: `cd backend && python3 -m pytest tests/test_move_rules.py -q` → FAIL.
- [ ] **Step 3: Implement** `core/move_rules.py` and the `app.py` wiring.
- [ ] **Step 4: Run** `python3 -m pytest tests/test_move_rules.py tests/test_move_rules_api.py tests/test_position_watch.py -q` → pass.
- [ ] **Step 5: Commit** `feat(move-rules): executor with tighten-only moves and close sweep`.

---

### Task 6: Notifier text, probe and docs

**Files:**
- Modify: `backend/auto_trader/core/telegram_notify.py` (`notifier`), `core/fcm_notify.py` (`fcm_text`, `_data`), `core/push_notify.py` (payload body adds `outcome`, `field`)
- Modify: `frontend/public/alert-sw.js` (branch for `p.kind === "move"`)
- Modify: `backend/scripts/alert_probe.py` (`--move ACCOUNT --deal DEAL --field sl|tp`: creates a price_level rule one tick past the current side price with a BE target, waits for the `__alerts__:fired` move payload, prints outcome)
- Modify: `docs/features/alerts.md` ("## Move rules" section: row shape, executor, tighten rule, sweep, refusal codes, probe, spec link)
- Test: `backend/tests/test_telegram_rich_alerts.py`, a new `test_fcm_text_move` in the fcm test file

**Interfaces:**
- Telegram: `kind == "move"` sends text only, `"✅ "` + headline for moved, `"ℹ️ "` for skipped, `"⚠️ "` for failed, then the message line if any; no buttons, no photo.
- FCM `fcm_text`: title `"{icon} {epic}"` with the same icons, body = headline (+ `" · " + message`).
- SW: same title/body, `tag: move|${p.id}`.

- [ ] **Step 1: Failing tests** for the Telegram text per outcome and `fcm_text` per outcome (exact strings above).
- [ ] **Step 2: Run** `cd backend && python3 -m pytest tests/test_telegram_rich_alerts.py -q -k move` → FAIL.
- [ ] **Step 3: Implement**, probe and docs.
- [ ] **Step 4: Run** the notifier tests → pass; `python3 -m scripts.alert_probe --help` shows `--move`.
- [ ] **Step 5: Commit** `feat(move-rules): notifier text, probe and feature notes`.

---

### Task 7: Frontend data layer

**Files:**
- Modify: `frontend/src/lib/alertsApi.ts`, `frontend/src/app/useAlertFiredNotices.ts`
- Test: `frontend/src/lib/alertsApi.move.test.ts` (new), `frontend/src/app/useAlertFiredNotices.test.ts` (extend if present, else new)

**Interfaces:**
- Produces:

```ts
export type MoveTarget = { type: "price"; value: number } | { type: "breakeven"; offset: number };
export interface MoveAction { account: string; dealId: string; field: "sl" | "tp"; direction?: "BUY" | "SELL"; target: MoveTarget }
export interface MoveRule {
  id: string; broker: string; epic: string;
  triggerKind: "price_level" | "indicator" | "line";
  params: Record<string, unknown>;   // the trigger's params (level/condition/... as for that kind)
  action: MoveAction; precision: number; notify: AlertNotifyChannels; label?: string;
}
export function loadMoveRules(filter?: { account?: string; epic?: string; dealId?: string }): MoveRule[];
export function findMoveRule(dealId: string, field: "sl" | "tp"): MoveRule | undefined;
export async function addMoveRule(r: Omit<MoveRule, "id" | "notify"> & { id?: string }): Promise<string | null>;  // null = ok, else failure detail
export async function patchMoveRule(id: string, patch: { params?: Record<string, unknown>; target?: MoveTarget }): Promise<string | null>;
export async function deleteMoveRule(id: string): Promise<string | null>;
```

- Behavior:
  - `hydrateAlerts` sends any row with a non-null `action` to `moveCache` BEFORE the kind dispatch, so it never lands in the price / indicator / line caches (no plain alert line, no legend bell).
  - `firedRows` skips History entries whose `alert.action` is set (no gray bell).
  - `triggeredLabel`: `kind === "move"` → `headline ?? "Move rule"`.
  - `useAlertFiredNotices`: `kind === "move"` → toast with the headline; outcome `failed` uses the error toast tone; no chart bell.
  - `addMoveRule` posts `{id, broker, epic, kind: triggerKind, params: {...params, trigger: "once"}, action, precision}`.
  - `moveCache` follows the same `indWriteStart` / `indWriteSettled` / `indWriteGen` guard as `positionCache`, so a hydrate during a write never drops a new rule.
  - `patchMoveRule(id, {target})` sends `{action: {target}}`; the server merges it.

- [ ] **Step 1: Failing tests**

```ts
it("hydrate keeps move rules out of the price alert cache", ...)  // row kind price_level + action → loadAlerts(epic, broker) is [], loadMoveRules() has it
it("fired bells skip move rules", ...)                            // triggered entry alert.action set → firedPriceAlerts(...) is []
it("addMoveRule forces trigger once", ...)                        // fetch body params.trigger === "once"
it("findMoveRule finds by deal and field", ...)
it("move fire shows the headline toast", ...)                     // FiredPayload kind move → toast text === headline
```

- [ ] **Step 2: Run** `cd frontend && npx vitest run src/lib/alertsApi.move.test.ts src/app/useAlertFiredNotices.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same two files plus `src/lib/alertsApi.test.ts` if it exists → pass; `npx tsc -b` → 0 errors.
- [ ] **Step 5: Commit** `feat(move-rules): frontend cache, API and fired notices`.

---

### Task 8: Order ticket Move SL / Move TP controls

**Files:**
- Create: `frontend/src/lib/moveRuleDraft.ts`, `frontend/src/components/MoveRuleControl.tsx`
- Modify: `frontend/src/OrderTicket.tsx` (new-order form: state, controls under the existing `ProximityWarn` rows at `:720-760`, post-fill create; `EditTicket` at `:837`: the controls after its SL/TP fields)
- Test: `frontend/src/lib/moveRuleDraft.test.ts`, `frontend/src/OrderTicket.move.test.tsx` (model on `OrderTicket.proximity.test.tsx`)

**Interfaces:**
- Produces in `moveRuleDraft.ts`:

```ts
export interface MoveRuleDraft { on: boolean; level: number; condition: AlertCondition; target: MoveTarget }
export interface MoveDraftState { epic: string; dealId: string | null; side: "buy" | "sell"; sl: MoveRuleDraft | null; tp: MoveRuleDraft | null }
export const moveDraftSignal: Signal<MoveDraftState | null>;
export function defaultCondition(field: "sl" | "tp", side: "buy" | "sell"): AlertCondition;
  // long sl crossing_up, long tp crossing_down, short sl crossing_down, short tp crossing_up
export function defaultTriggerLevel(field: "sl" | "tp", side: "buy" | "sell", ref: number, sl: number | null, tp: number | null): number;
  // sl: ref + |ref - sl| in the trade's favor (1R); no sl: ref * 1.005 in favor.
  // tp: ref - |ref - sl| / 2 against the trade (halfway to SL); no sl: ref * 0.995 against.
export function setMoveLevel(field: "sl" | "tp", which: "trigger" | "target", level: number): void;
  // "target" sets target to {type: "price", value: level}
```

- `MoveRuleControl` props: `{ field: "sl" | "tp"; draft: MoveRuleDraft | null; precision: number; onChange(d: MoveRuleDraft | null): void; saved?: MoveRule; onSave?(): void; onRemove?(): void }`. Renders a switch labelled "Move SL" / "Move TP"; when on: a target select (`Breakeven` | `Price`), the offset field (Breakeven) or the price field, the condition select (`CONDITION_LABELS`), and the trigger price field. An `InfoTip` with lines: `["Moves the level once, when price meets the condition.", "Only tightens. Never loosens your SL or TP."]`. Edit mode shows `Save rule` / `Remove rule` buttons.
- New market order: on a fill with `deal_id`, call `addMoveRule` for each `on` draft (`triggerKind "price_level"`, `params {level, condition}`, broker = the data broker of `account`); a failure sets the message `Order filled. Move SL not set: <reason>` (TP for tp). Limit orders: controls disabled with the existing `LIMIT_WARN_TIP` text pattern: `"Available for market orders. Set it on the position once filled."`. Clear the draft after the order.
- Edit mode on a position: seed from `findMoveRule(dealId, field)` when it is a `price_level` rule; `Save rule` calls `addMoveRule` or `patchMoveRule`; `Remove rule` calls `deleteMoveRule`. An indicator / line rule shows its label plus `Edit` (opens the matching modal in edit mode, Task 10) and `Remove rule`.

- [ ] **Step 1: Failing tests** for `defaultCondition` (4 cases), `defaultTriggerLevel` (long sl with sl 0.95 ref 1.0 → 1.05; short tp with sl 1.05 ref 1.0 → 1.025; no-sl fallbacks), and the ticket: market fill with Move SL on posts a rule with `action.dealId` = the fill's deal id; a 409 shows `Order filled. Move SL not set: ...`; limit order disables the switch.
- [ ] **Step 2: Run** `npx vitest run src/lib/moveRuleDraft.test.ts src/OrderTicket.move.test.tsx` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** those two plus `src/OrderTicket.proximity.test.tsx src/OrderTicket.test.tsx` → pass; `npx tsc -b` → 0.
- [ ] **Step 5: Commit** `feat(move-rules): order ticket Move SL and Move TP controls`.

---

### Task 9: Draggable move lines on the chart

**Files:**
- Create: `frontend/src/lib/moveRuleLines.ts`
- Modify: `frontend/src/ChartCore.tsx` (append move specs both to the list passed to `PositionLines` AND inside `tradeLinePixels` at `:2346`), `frontend/src/chart/useLineDrag.ts` (route `move:` ids)
- Test: `frontend/src/lib/moveRuleLines.test.ts`

**Interfaces:**
- Produces:

```ts
export const MOVE_PREFIX = "move:";
// line id: `move:<ruleKey>:<field>:<which>`, ruleKey = "draft" or a saved rule id, which = "trigger" | "target"
export function moveLineSpecs(o: { epic: string; draft: MoveDraftState | null; saved: MoveRule[]; precision: number; labelX?: number }): LineSpec[];
export function applyMoveLineDrag(id: string, level: number): void;   // draft → setMoveLevel; saved → local override signal
export function endMoveLineDrag(id: string): Promise<void>;           // saved → patchMoveRule (trigger: params.level; target: {type:"price"}), then clear the override
export const moveLineOverrides: Signal<Record<string, number>>;
```

- Specs: one trigger line per on/saved `price_level` rule (dashed, `draggable: true`, `fullWidth: true`, label `Move SL → BE ↑` / `Move TP → 1.0950 ↓`; arrow `↑` for crossing_up / greater, `↓` for crossing_down / less, `↕` for crossing); one faint target line only when the target is a price (label `New SL` / `New TP`). Colors: the SL / TP line colors from `positionLines.ts` at reduced alpha. Saved rules only for positions on `epic`; indicator / line rules draw nothing here.
- Hit-test: `tradeLinePixels` splits keys at the last `:` (`ChartCore.tsx:2373-2377`). For a key starting with `MOVE_PREFIX`, set `id` to the FULL key and `field` to `"price"`. `tradeLineHitTest` (`:2422`) skips `move:` ids like `DRAFT_ID` (no click-select, no snap target, no DOM pill).
- Drag: in `useLineDrag` `onMove`, the `MOVE_PREFIX` check comes FIRST, before `draggingTradeRef.current = hit.id` (`useLineDrag.ts:357`): call `applyMoveLineDrag(hit.id, level)` and return (no trade clamp, no pending edit); on drop, `endMoveLineDrag(hit.id)`. The ticket fields update through `moveDraftSignal`, and typing in the ticket moves the line (ChartCore subscribes to `moveDraftSignal`, `moveLineOverrides` and the alerts bump).

- [ ] **Step 1: Failing tests**: `parseTradeLineKey(key)` (exported from `moveRuleLines.ts`, used by `tradeLinePixels`): `move:draft:sl:trigger` → `{id: "move:draft:sl:trigger", field: "price"}`, `D1:stop` → `{id: "D1", field: "stop"}`; specs for a long draft with BE target (one line, label `Move SL → BE ↑`); price target (two lines, second `New SL`); saved rule on another epic → none; `applyMoveLineDrag("move:draft:sl:trigger", 1.2)` sets `moveDraftSignal.value.sl.level === 1.2`; `endMoveLineDrag` on a saved id calls `patchMoveRule(id, {params: {...params, level}})`.
- [ ] **Step 2: Run** `npx vitest run src/lib/moveRuleLines.test.ts` → FAIL.
- [ ] **Step 3: Implement**, including the ChartCore and useLineDrag hookups.
- [ ] **Step 4: Run** that file plus `src/chart/TradePills.test.tsx` → pass; `npx tsc -b` → 0. Manual check in headed Chrome with `?demo=preview` on a paper position: lines appear, drag updates the ticket, typing moves the line.
- [ ] **Step 5: Commit** `feat(move-rules): draggable move lines on the chart`.

---

### Task 10: Indicator and Trendlines triggers in the alert modals

**Files:**
- Create: `frontend/src/components/MoveActionPicker.tsx`
- Modify: `frontend/src/IndicatorAlertModal.tsx`, `frontend/src/LineAlertModal.tsx`, `frontend/src/chart/useTrendlineMenu.tsx`, `frontend/src/lib/signals.ts` (`lineAlertRequest` value gains optional `move?: { field: "sl" | "tp" }`)
- Test: `frontend/src/components/MoveActionPicker.test.tsx`, extend `IndicatorAlertModal.test.tsx`, `LineAlertModal.test.tsx`

**Interfaces:**
- `MoveActionPicker` props: `{ epic: string; value: { field: "sl" | "tp"; dealId: string; account: string; target: MoveTarget } | null; onChange(v): void }`. A "Then" select: `Notify` | `Move SL` | `Move TP`. With a move chosen: a position select (open positions on `epic` from the shared `subscribeTrades` feed in `lib/trading.ts`, the active trading account, text `<account label> <Long|Short> <size> @ <entry>`; trailing-stop positions are disabled for Move SL with a Tooltip `"Trailing stop: SL can't be moved"`), and the target (Breakeven + offset, or Price). Hidden entirely for non-admin users.
- The modals in create mode render the picker; when a move is chosen, Save calls `addMoveRule({triggerKind, params, action, ...})` instead of the plain create, the trigger select is fixed to once (hidden), and notify toggles stay. Edit mode of an existing plain alert does not offer the picker. Edit mode of a move rule: both modals look the rule up with `loadMoveRules` when it is not in `indicatorCache` (today they return null, `LineAlertModal.tsx:31`), show the picker locked to its position and field (target editable), and save through `patchMoveRule`.
- Trendline menu: two items after "Add alert": `Move SL when crossed…` and `Move TP when crossed…`, shown only when an admin has at least one open position on the epic; they open `lineAlertRequest` with the same draft as "Add alert" plus `move: {field}`, which preselects the picker.

- [ ] **Step 1: Failing tests**: a move rule opens in the indicator modal's edit mode and saves with `patchMoveRule`; picker lists only positions on the epic; Move SL disables a trailing position; IndicatorAlertModal with Move SL saves through `addMoveRule` with `triggerKind "indicator"`; trendline menu items hidden with no positions.
- [ ] **Step 2: Run** `npx vitest run src/components/MoveActionPicker.test.tsx src/IndicatorAlertModal.test.tsx src/LineAlertModal.test.tsx` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same files → pass; `npx tsc -b` → 0.
- [ ] **Step 5: Commit** `feat(move-rules): indicator and Trendlines triggers from the alert modals`.

---

### Task 11: Position row marker and Alerts sidebar

**Files:**
- Modify: `frontend/src/PositionsPanel.tsx` (next to the "Warn near SL/TP" button at `:419`), `frontend/src/AlertsSidebar.tsx`
- Test: extend `frontend/src/AlertsSidebar.test.tsx`; new `frontend/src/PositionsPanel.move.test.tsx`

**Interfaces:**
- Position row: a small icon next to the existing "Warn near SL/TP" button when `loadMoveRules({dealId})` is non-empty, wrapped in `Tooltip` with one line per rule (`"Move SL to BE when ↑ 1.1050"`, indicator rules use their `label`). Click opens the ticket in edit mode (`openTradeEditor(dealId, "stop" | "tp")`).
- Sidebar "Positions" group lists move rules (same text) with a delete button calling `deleteMoveRule`.

- [ ] **Step 1: Failing tests**: row shows the icon only with a rule; sidebar lists the rule and delete calls `deleteMoveRule`.
- [ ] **Step 2: Run** the test files → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → pass; `npx tsc -b` → 0; `npx eslint` on changed files → 0.
- [ ] **Step 5: Commit** `feat(move-rules): position row marker and sidebar listing`.

---

## Final check

- [ ] Backend: `cd backend && python3 -m pytest tests/test_move_rule.py tests/test_move_rules.py tests/test_move_rules_api.py tests/test_alert_store.py tests/test_alert_engine.py tests/test_alerts_api.py tests/test_position_alerts_api.py tests/test_telegram_rich_alerts.py -q` (ask the user first: no high-CPU runs without asking).
- [ ] Probe on `capital:demo`: `cd backend && python3 -m scripts.alert_probe --move capital:demo --deal <DEAL> --field sl` → outcome `moved`.
