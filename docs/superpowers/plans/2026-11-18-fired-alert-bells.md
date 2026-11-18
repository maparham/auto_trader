# Fired Alert Bells Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "once" alert that fired keeps a gray bell on the chart while its History entry exists, with Re-arm (double click / menu) and Hide (menu).

**Architecture:** The History entries already hold each fired alert's full row (`alert_json`). The frontend derives "fired" alerts from the triggered cache with the same row mappers it uses for live alerts, and the chart paints them next to the live ones with a `fired` flag. The backend adds one re-arm endpoint that reuses the Telegram re-arm hook plus create's own checks. No change to the `fired` event: the engine deletes a fired once alert and broadcasts `changed`, whose resync refetches History (which carries `alert`).

**Tech Stack:** FastAPI + pytest (backend), React + TypeScript + klinecharts + vitest (frontend).

**Spec:** docs/superpowers/specs/2026-11-18-fired-alert-bells-design.md

## Global Constraints

- Only `once` alerts (`params.trigger == "once"`) of kind `price_level`, `indicator`, `line`; never `account` or `position`.
- A fired alert shows only when no live alert has its id, it is on the chart's broker and epic, and it is not hidden.
- Re-arm re-creates the alert with the SAME id and settings.
- Hide is per browser: localStorage key `auto-trader.alerts.hiddenFired` (use `PREFIX` from `lib/workspaceKeys.ts`), a JSON array of alert ids, pruned to ids still in History on hydrate.
- UI text: tooltip `Fired <ago>` on a second line under the existing label (tooltips take `string[]`); menu items exactly `Re-arm` and `Hide`. No em dashes in any UI text.
- Muted look, for bells, the axis tag border and bell, and the fired trendline stroke: gray `var(--text-dim)` (index.css) at opacity 0.7. The canvas stroke cannot read a CSS variable, so it uses the dark-theme value `#8a93a0`.
- Use the shared `Tooltip` component; no `title=`.
- Run only the affected test files, never the full frontend suite. Typecheck is `npx tsc -b` in `frontend/`.
- Commit to the current branch (`main`), staging files by explicit path. Never stash, clean or restore.

## Review Focus

1. A fired price tag sits on the live-price row (it fired there): it must still show (Task 4 test `fired tag on the price row shows`).
2. Same alert fired several times (re-armed, fired again): one gray bell, newest entry wins (Task 2 test `newest entry per id`).
3. Re-armed alert is live again before the History refetch: live wins, no gray duplicate (Task 2 test `live id hides fired`).
4. Re-arm of an expired alert: 422 `expired`, toast shows the reason, bell stays (Task 1 test, Task 4 step).
5. History row from an older backend with no `alert` (or `alert_json` null): no gray bell, no crash (Task 2 test `entry without alert`).
6. A fired trendline alert re-armed: its ray changes from gray to amber in place (Task 3 test `fired to live restyles`).
7. The user made an identical alert after the fire: re-arm answers 409 like create would (Task 1 test `test_rearm_duplicate_signature_409`).

---

### Task 1: Backend: re-arm endpoint

**Files:**
- Modify: `backend/auto_trader/core/alert_store.py` (new lookup)
- Modify: `backend/auto_trader/api/routers/alerts.py` (new route, next to `clear_triggered`)
- Modify: `backend/auto_trader/api/alert_hooks.py` (public `rearm_alert_row(user_id, row, origin="telegram")`, the existing `_rearm` with an `origin` argument passed to `_changed_broadcast`; Telegram keeps its default)
- Test: `backend/tests/test_alerts_api.py`

**Interfaces:**
- Produces: `AlertStore.latest_triggered_alert(user_id: str, alert_id: str) -> dict | None` (parsed `alert_json` of the newest `triggered` row with that `alert_id`, or None).
- Produces: `POST /api/alerts/{alert_id}/rearm?origin=<client id>` -> 200 with the created alert (same shape as create, via `_decorate`). Errors: 404 `not_in_history`; 422 `not_rearmable` for kind `account`/`position` or `trigger != "once"`; 422 `expired` when `expires_at <= now`; 422 `cannot_upgrade` when params cannot be upgraded; then create's own checks (`_validate_params`, `_check_duplicate` 409, `_check_line_ref` for `line`); 409 when the id is live (create's `ValueError`).

- [ ] **Step 1: Write the failing tests**

In `test_alerts_api.py` (create the alert through the API, delete it, then `add_triggered` a row whose `alert_json` is the created row, through the event loop the file already uses for store calls):
- `test_rearm_recreates_with_same_id`: POST rearm -> 200, `body["id"] == "al-1"`, GET `/api/alerts` lists it, `params` equal to the fired row's.
- `test_rearm_live_id_409`: alert still live -> 409.
- `test_rearm_duplicate_signature_409`: after the fire, a new alert `al-2` with the same params exists -> 409.
- `test_rearm_unknown_404`: no history row -> 404.
- `test_rearm_expired_422`: `expires_at` in the past -> 422 with `expired` in `detail`.
- `test_rearm_every_trigger_422`: `trigger: "every"` -> 422 `not_rearmable`.
- `test_rearm_other_user_404`: history of user A, POST as user B -> 404.

- [ ] **Step 2: Run them, expect FAIL**

Run: `cd backend && python3 -m pytest tests/test_alerts_api.py -k rearm -q`
Expected: 404/405 failures.

- [ ] **Step 3: Implement**

The route: `current_user`, the store lookup, then the checks in the order listed above, `upgrade_params` for `indicator` before create's checks, then `rearm_alert_row(user, row, origin)`. Do not import anything from the Telegram notifier.

- [ ] **Step 4: Run, expect PASS**, plus `python3 -m pytest tests/test_alerts_api.py tests/test_telegram_rich_alerts.py -q`.

- [ ] **Step 5: Commit** `feat(alerts): re-arm a fired once alert from history`

---

### Task 2: Frontend data: fired alerts, hide, re-arm

**Files:**
- Modify: `frontend/src/lib/alertsApi.ts`
- Create: `frontend/src/lib/alertsApi.fired.test.ts`

**Interfaces:**
- Consumes: `POST /api/alerts/{id}/rearm` (Task 1); `GET /api/alerts/triggered` entries already carry `alert` (the fired row).
- Produces:
  - `TriggeredAlert.alert?: AlertRow | null` (the raw row, from `TriggeredRow.alert` in `triggeredRowToClient`; an entry added by the live `fired` event has none until the `changed` resync that follows refetches History). Widen `TriggeredRow.alert` to the full row.
  - `firedPriceAlerts(epic: string, broker?: string): Array<SavedAlert & { firedAt: number }>`
  - `firedIndicatorAlerts(epic: string, broker?: string): Array<IndicatorAlert & { firedAt: number }>`
  - `firedLineAlerts(epic: string, broker?: string): Array<LineAlert & { firedAt: number }>`
  - `hideFiredAlert(id: string): void` (adds to the set, `bumpAlerts()`)
  - `rearmAlert(id: string): Promise<string | null>` (null on success; otherwise the server's `detail` text or "Network error"). On success: drop the id from the hidden set and `await resyncAlerts()`.
- `broker` defaults to `getPersistBroker()`, like `loadAlerts`.

- [ ] **Step 1: Write the failing tests** (`alertsApi.fired.test.ts`, feeding the cache through a mocked `/api/alerts/triggered` hydrate as the existing alertsApi tests do):
  - `price fired once shows`: one `price_level` once entry on US100 -> `firedPriceAlerts("US100", "capital")` has one item with that `level` and `firedAt` = entry time.
  - `every trigger excluded`, `account and position excluded`, `other epic and broker excluded`.
  - `newest entry per id`: two entries same id -> one item, `firedAt` the newest.
  - `live id hides fired`: same id in the live cache -> empty.
  - `entry without alert`: `alert: null` -> empty, no throw.
  - `hidden id excluded`: after `hideFiredAlert(id)` -> empty, and localStorage holds `[id]`.
  - `line and indicator map through their row mappers`: `firedLineAlerts` item has `params.anchors`; `firedIndicatorAlerts` item has `params.output`.
  - `rearmAlert returns server detail on 422`; `rearmAlert sends origin=CLIENT_ID`.

- [ ] **Step 2: Run, expect FAIL**: `cd frontend && npx vitest run src/lib/alertsApi.fired.test.ts`

- [ ] **Step 3: Implement.** One private helper `firedRows(kind, epic, broker): Array<{ row: AlertRow; time: number }>` does the filtering (Global Constraints list, newest per id since the cache is newest first); the three exports map with `rowToSavedAlert` / `rowToIndicatorAlert` / `rowToLineAlert`. Prune the hidden set in `hydrateAlerts` after the triggered fetch. No extra bump is needed for firings: the `changed` resync bumps `alertsChanged`.

- [ ] **Step 4: Run, expect PASS**; also `npx vitest run src/AlertsSidebar.test.tsx src/app/useAlertFiredNotices.test.ts`.

- [ ] **Step 5: Commit** `feat(alerts): fired alerts from history, hide and re-arm`

---

### Task 3: Fired trendline ray (faint dashed line)

**Files:**
- Modify: `frontend/src/lib/overlays/indicatorAlerts.ts` (`wantedRays`, `reconcileRays`, new `rayFired`)
- Modify: `frontend/src/lib/overlays/alertLine.ts` (`alertLineStyles(selected: boolean, fired = false)`)
- Modify: `frontend/src/lib/overlays/shared.ts` (muted color constant `ALERT_LINE_FIRED_COLOR`)
- Test: existing indicatorAlerts test file if one exists (`ls src/lib/overlays/*indicatorAlerts*`), else create `src/lib/overlays/indicatorAlerts.fired.test.ts`

**Interfaces:**
- Consumes: `firedLineAlerts(epic, broker)` (Task 2).
- Produces: `IndicatorAlertLines.rayFired(alertId: string): boolean`; `rayPoints`/`rayStepped` work for fired ids too.

- [ ] **Step 1: Write the failing tests** (mock chart as the existing overlay tests do):
  - `fired line alert draws a muted ray`: `createOverlay` called with `styles.line.color === ALERT_LINE_FIRED_COLOR`.
  - `fired to live restyles`: same id moves from fired to live -> `overrideOverlay` with the amber style, no second `createOverlay`.
  - `hidden alert lines hide fired rays too`.

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** `wantedRays` iterates live then fired line alerts (skip ids already set), with `fired` on the `Ray`; the key gets a `|F` suffix when fired (first letter stays the overlay kind). On a key change, also `overrideOverlay` the styles.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(alerts): faint line for a fired trendline alert`

---

### Task 4: Gray bells on the chart, with Re-arm / Hide

**Files:**
- Create: `frontend/src/chart/FiredAlertMenu.tsx`
- Modify: `frontend/src/chart/AlertCurveBells.tsx`, `frontend/src/chart/AlertTags.tsx`
- Modify: `frontend/src/chart/useChartPaint.ts` (tags ~line 790-836, curve bells ~line 839-937, `AlertTag` type line 83)
- Modify: `frontend/src/ChartCore.tsx` (alertTags state type ~1216, props at ~6219 and ~6226)
- Modify: `frontend/src/App.css` (`.alert-tag.fired`, `.tl-alert-bell.fired`)
- Modify: `frontend/src/lib/timeFormat.ts`, `frontend/src/AlertsSidebar.tsx` (move `ago`)
- Test: `frontend/src/chart/AlertCurveBells.test.tsx`, create `frontend/src/chart/AlertTags.test.tsx`

**Interfaces:**
- Consumes: `firedPriceAlerts`, `firedIndicatorAlerts`, `firedLineAlerts`, `hideFiredAlert`, `rearmAlert` (Task 2); `rayPoints`/`rayStepped` for fired ids (Task 3).
- Produces:
  - `AlertCurveBellTag` gains `firedAt?: number`; `AlertTagItem` / `AlertTag` gain `firedAt?: number` (fired items have `hovered/active/selected` false).
  - `FiredAlertMenu({ x, y, onRearm, onHide, onClose })`: portaled compact `ContextMenu` with `Re-arm` (icon `MenuIcons.bell`) and `Hide` (icon `MenuIcons.remove`, not danger).
  - `AlertCurveBells` and `AlertTags` take `onRearm: (id: string) => void` and `onHide: (id: string) => void`.

- [ ] **Step 1: Write the failing tests**
  - AlertCurveBells: a bell with `firedAt` has class `fired`; double click calls `onRearm(id)`, not `onEdit`; right click shows `Re-arm` and `Hide`, and `Hide` calls `onHide(id)`; Enter on a focused fired bell calls `onRearm`.
  - AlertTags: a tag with `firedAt` renders with class `fired` and `pointer-events` enabled through the class (assert the class); double click calls `onRearm`; right click menu as above; a live tag still has no handlers.
  - AlertTags: `fired tag on the price row shows`: a fired tag within the price-row band (the rule at `AlertTags.tsx:42-48`) still renders; a live unselected tag there is still dropped.
  - Both: tooltip content includes `Fired` + the `ago` text. `ago` is private in `AlertsSidebar.tsx:366`: move it to `lib/timeFormat.ts` as an export and import it in both places.

- [ ] **Step 2: Run, expect FAIL**: `npx vitest run src/chart/AlertCurveBells.test.tsx src/chart/AlertTags.test.tsx`

- [ ] **Step 3: Implement**
  - useChartPaint: after the live price tags, push `firedPriceAlerts(epicRef.current, brokerIdRef.current)` tags (same `overlays.getAlertsHidden()` gate). In the indicator-bell loop and the line-bell loop, iterate live then fired, with `firedAt` on fired bells; same placement code (pull the per-alert body into a local function rather than copying it).
  - ChartCore: `onRearm = async (id) => { const err = await rearmAlert(id); if (err) toast(err) }` using the toast helper ChartCore already uses for alert errors; `onHide = hideFiredAlert`.
  - AlertTags: fired tags skip the price-row hide rule. If a fired tag then covers the live price pill, keep the pill on top (fired tag stays at z-index 45, below the pill's 50).
  - CSS: `.alert-tag.fired { border-color: <muted>; opacity: .7; pointer-events: auto; cursor: pointer }`, `.alert-tag.fired .at-bell, .tl-alert-bell.fired { color: <muted> }`, `.tl-alert-bell.fired { opacity: .7 }`.

- [ ] **Step 4: Run, expect PASS**; then `npx vitest run src/chart/useIndicatorCommands.alerts.test.tsx src/AlertsSidebar.test.tsx` and `npx tsc -b` (ask before running tsc, the user shares the laptop).

- [ ] **Step 5: Check in the real app** with the `run` skill in a dev tab the agent opens itself (never the user's own tab): create a once price alert near the price, let it fire, see the gray tag; double click re-arms (tag turns amber); Hide removes it; Clear history removes the rest. Also check that a price-axis drag that starts on a gray tag still scales the axis; if the tag blocks it, make only the bell span clickable (`pointer-events: auto` on `.at-bell` only).

- [ ] **Step 6: Commit** `feat(alerts): gray bells for fired once alerts`; then add one paragraph to CLAUDE.md under "## Alerts" (fired bells, `POST /api/alerts/{id}/rearm`, the `hiddenFired` key) and commit `docs: fired alert bells`.
