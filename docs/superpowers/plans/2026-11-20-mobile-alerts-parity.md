# Mobile Alerts Tab Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The mobile Alerts tab shows History and the Account/Positions groups the way the desktop AlertsSidebar does, and History rows jump to the chart.

**Architecture:** Row logic that is not layout moves out of `AlertsSidebar.tsx` into `lib/alertRows.ts` (pure functions plus one `useAlertTick` hook); desktop and mobile both render from it with their own markup. The jump reuses `showMobileEpic`; a cross-broker jump calls `setMobileAccount` first.

**Tech Stack:** React 18, TypeScript, Vitest + Testing Library (jsdom).

**Spec:** `docs/superpowers/specs/2026-11-20-mobile-alerts-parity-design.md`

## Global Constraints

- No change to the desktop's look or behaviour.
- Refresh tick: 30 s (`30_000`), and the tick calls `resyncAlerts()` only while account or position alerts exist.
- New tooltips use the shared `Tooltip`; no `title=` attributes.
- UI copy: plain English, no em dashes, no "--".
- Run only the affected test files, never the whole frontend suite. Typecheck with `npx tsc -b` from `frontend/`.
- Stage files by explicit path (shared worktree); never `git add -A`, stash or clean.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- A History row with `broker` absent (older backend): treat as the current broker, no badge, tap opens it. Test in Task 2.
- A History row whose broker has no registered account: toast, no confirm, account unchanged. Test in Task 3.
- A position firing (`broker: "capital:demo"`) while on Capital: no badge, and tapping it opens the epic with no confirm. Test in Tasks 1 and 3.
- A cross-broker jump confirmed, then the boot finishes: the chart ends on the alert's epic, not the broker's heartbeat symbol. Test in Task 3.
- An account alert with `current` null and `currency` null: row renders the metric without "now". Test in Task 1.
- Clear history while History is empty is not offered (button hidden on the empty state). Test in Task 2.

---

### Task 1: Shared row helpers, desktop moved onto them

**Files:**
- Create: `frontend/src/lib/alertRows.ts`
- Create: `frontend/src/lib/alertRows.test.ts`
- Modify: `frontend/src/AlertsSidebar.tsx` (`AccountAlertRow` ~234, `PositionAlertRow` ~295, the `now` effect ~476-489, History map ~954-1020)
- Test: `frontend/src/AlertsSidebar.test.tsx` (must stay green, unchanged)

**Interfaces:**
- Produces (all in `lib/alertRows.ts`):
  - `ALERT_TICK_MS = 30_000`
  - `useAlertTick(): number`: returns `Date.now()`, bumped on `alertsChanged` and every `ALERT_TICK_MS`; on each interval also `void resyncAlerts()` when `loadAccountAlerts().length + loadPositionAlerts().length > 0`.
  - `historyRowView(t: TriggeredAlert, activeBroker: string, fallbackPrecision: number): { title: string; foreignBroker: string | null; cond: string; precision: number; isAccount: boolean }`. `title` is `accountLabel(t.broker ?? "")` for `kind === "account"`, else `t.epic`. `foreignBroker` is `brokerOf(t.broker)` when `t.broker` is set, not an account row, and `brokerOf(t.broker) !== activeBroker`; else null. (`brokerOf` from `lib/trading.ts` maps both `capital` and `capital:demo` to `capital`; position firings store the account key.)
  - `decimalsOf(n: number): number`: fractional digit count of `String(n)`, capped at 8 (lifted from `AlertsSidebar.tsx` ~563). `cond` is `triggeredLabel(t, precision)`, `precision` is `t.precision ?? fallbackPrecision`.
  - `unseenCount(history: TriggeredAlert[], seen: number): number` (count of `t.time > seen`).
  - `accountRowView(a: AccountAlert): { title: string; metric: string; now: string | null; tiers: { level: number; text: string; label: string; fired: boolean }[]; unmonitored: string | null }`. `unmonitored` is `a.unmonitoredReason ?? "Not monitored"` when `a.monitored === false`, else null.
  - `positionRowView(a: PositionAlert, trades: { id: string; side: "buy" | "sell" }[]): { title: string; cond: string; fired: boolean; sideLabel: "SL" | "TP" }`. `title` is `epic` plus ` long`/` short` when the deal is in `trades`; `cond` is `` `${sideLabel} · ${a.atrMult}× ATR · ${now}` `` with `now` = `"now n/a"` or `` `now ${Number(d.toFixed(2))} ATR` ``.

- [ ] **Step 1: Write the failing tests** in `alertRows.test.ts`:
  - `historyRowView` on `{kind:"account", broker:"capital-live:live"}` gives `title === accountLabel("capital-live:live")`, `isAccount: true`, `foreignBroker: null`.
  - `historyRowView` on `{epic:"US100", broker:"ig"}` with active `"capital"` gives `foreignBroker: "ig"`; with `broker` absent gives `null`; on `{kind:"position", broker:"capital:demo"}` with active `"capital"` gives `null`.
  - `decimalsOf(1.08234) === 5`, `decimalsOf(18000) === 0`, `decimalsOf(0.123456789012) === 8`.
  - `historyRowView` uses `t.precision` when set, else the fallback.
  - `unseenCount([{time:5},{time:3},{time:1}], 3) === 1`.
  - `accountRowView` with `current: null, currency: null` gives `now: null`; with `firedTiers:[50]` marks that tier `fired: true`; `monitored:false, unmonitoredReason:null` gives `"Not monitored"`.
  - `positionRowView` with the deal in trades as `buy` gives title `"US100 long"`, `distanceAtr: 0.8123` gives cond `"SL · 0.5× ATR · now 0.81 ATR"`, `distanceAtr: null` gives `"... · now n/a"`.
  - `useAlertTick` (renderHook, fake timers): after 30 s it calls the mocked `resyncAlerts` once when `loadAccountAlerts` returns one row, and not at all when both loaders return `[]`.

- [ ] **Step 2: Run, expect FAIL** (module not found)
  Run: `cd frontend && npx vitest run src/lib/alertRows.test.ts`

- [ ] **Step 3: Implement `lib/alertRows.ts`** with the signatures above, lifting the text logic from `AccountAlertRow`/`PositionAlertRow`/the History map as-is.

- [ ] **Step 4: Move the desktop onto it.** `AlertsSidebar` replaces its `now` effect with `const now = useAlertTick()`, its local `decimalsOf` with the shared one, and its three row renderers read from the view functions. Markup, class names and handlers stay identical. The History row's `foreign` becomes `view.foreignBroker != null`, and its Go to chart passes `view.foreignBroker ?? undefined` as `broker` to `onOpenAlert` (fixes position firings reading as foreign). Add an `AlertsSidebar.test.tsx` case: a `kind:"position"` row with `broker:"capital:demo"` and `brokerId:"capital"` shows no `.ap-broker` badge.

- [ ] **Step 5: Run both, expect PASS**
  Run: `cd frontend && npx vitest run src/lib/alertRows.test.ts src/AlertsSidebar.test.tsx`

- [ ] **Step 6: Commit** `refactor(alerts): share alert row logic in lib/alertRows`

### Task 2: Mobile History like the desktop

**Files:**
- Modify: `frontend/src/mobile/MobileAlertsView.tsx` (History branch ~198-215, sub-tab buttons ~118-127)
- Modify: `frontend/src/mobile/MobileApp.tsx` (tab bar ~158-167)
- Modify: `frontend/src/mobile/mobile.css`
- Test: `frontend/src/mobile/MobileAlertsView.test.tsx`, `frontend/src/mobile/MobileApp.test.tsx`

**Interfaces:**
- Consumes: `useAlertTick`, `historyRowView`, `unseenCount` (Task 1); `ago`, `clearTriggered`, `loadTriggeredSeen`, `pushTriggeredSeen`, `brokerLabel`.
- Produces: `MobileAlertsView` renders each History row as `.m-alerts-row.m-alerts-hist` with `.m-alerts-epic` (title), `.m-alerts-broker` (badge text `brokerLabel(foreignBroker)`), `.m-alerts-time` (`ago(t.time, now)`). Rows get no tap handler in this task; Task 3 adds it.

- [ ] **Step 1: Write the failing tests** in `MobileAlertsView.test.tsx`:
  - History row shows `"5m ago"` for `time = Date.now() - 5*60_000`.
  - An account row shows the account label.
  - A row with `broker:"ig"` while the mobile broker is `capital` shows the badge `brokerLabel("ig")`; a row with no `broker` shows none.
  - "Clear history" calls `clearTriggered` and the list shows "No alerts have triggered yet."; the button is absent when History is empty.
  - With `loadTriggeredSeen` returning 0 and two rows, the History button shows `2`; opening History calls `pushTriggeredSeen(newestTime)`.
  - In `MobileApp.test.tsx`: the Alerts tab button has `.m-tabbar-dot` while unseen firings exist and none when 0, while the Chart tab is the open one (MobileAlertsView is not mounted then).

- [ ] **Step 2: Run, expect FAIL**
  Run: `cd frontend && npx vitest run src/mobile/MobileAlertsView.test.tsx src/mobile/MobileApp.test.tsx`

- [ ] **Step 3: Implement.** History uses `useAlertTick()` for `now`. The count badge sits in the History button as `.m-seg-count`. Opening History (and each render while it is shown) advances the marker the way the desktop effect at `AlertsSidebar.tsx` ~611-615 does. The tab bar dot is computed in `MobileApp` itself: `useSyncExternalStore` on `alertsChanged`, then `unseenCount(loadTriggered(), loadTriggeredSeen()) > 0`.

- [ ] **Step 4: Run, expect PASS** (same command)

- [ ] **Step 5: Commit** `feat(mobile): alert History like the desktop`

### Task 3: Go to chart from a History row, across brokers

**Files:**
- Modify: `frontend/src/mobile/mobileChartState.ts` (after `showMobileEpic` ~170)
- Test: `frontend/src/mobile/mobileChartState.test.ts` (create if absent) and `MobileAlertsView.test.tsx`

**Interfaces:**
- Consumes: `showMobileEpic`, `mobileAccountFor`, `setMobileAccount`, `brokerOf`, `cachedBrokers()?.exec`, `brokerLabel`, `requestConfirm`, `toast` (the desktop's toast import).
- Produces: `openMobileAlert(epic: string, broker: string | undefined, precision: number): void`.
  - `broker` undefined or `brokerOf(broker) === mobileBroker()`: `void showMobileEpic(epic, precision)`.
  - Otherwise, with `b = brokerOf(broker)`: no registered account on `b` (`accounts.length > 0 && !accounts.some(a => a.broker === b)`) gives `toast(\`${brokerLabel(b)} is not available, so ${epic} cannot be opened.\`)` and returns.
  - Otherwise `requestConfirm({ title: "Switch broker?", message: \`This alert is on ${brokerLabel(b)}. Switch from ${brokerLabel(mobileBroker())} to open ${epic}?\`, confirmLabel: "Switch", onConfirm })`. `onConfirm` calls `setMobileAccount(target)` then `void showMobileEpic(epic, precision)`, where `target` is `broker` itself when it is a registered account key (contains `:` and is in `accounts`), else `mobileAccountFor(b, accounts)`.

- [ ] **Step 1: Write the failing tests:**
  - Same broker: `showMobileEpic` (spied) called with `("US100", 2)`; no confirm.
  - `broker: "capital:demo"` while on `capital`: same as above, no confirm.
  - Unknown broker with accounts cached: `toast` called with the exact text, `confirmRequest` stays null, `mobileAccount` unchanged.
  - Other broker: confirm shown with title "Switch broker?"; its `onConfirm` sets `mobileAccount` to that broker's account, and after `bootMobileMarket` (mocked `initialMarket` returning another symbol) and `resolveInstrument` settle, `mobileSymbol.value.epic` is the alert's epic.
  - In `MobileAlertsView.test.tsx`: tapping a symbol row calls `openMobileAlert(t.epic, t.broker, precision)`; tapping an account row calls nothing.

- [ ] **Step 2: Run, expect FAIL**
  Run: `cd frontend && npx vitest run src/mobile/mobileChartState.test.ts src/mobile/MobileAlertsView.test.tsx`

- [ ] **Step 3: Implement** `openMobileAlert`.

- [ ] **Step 4: Run, expect PASS** (same command)

- [ ] **Step 5: Commit** `feat(mobile): History rows open their chart, switching broker when asked`

### Task 4: Active list: symbol row facts, Account and Positions groups, modals mounted

**Files:**
- Modify: `frontend/src/mobile/MobileAlertsView.tsx` (Active branch)
- Modify: `frontend/src/mobile/MobileModals.tsx`
- Modify: `frontend/src/mobile/mobile.css`
- Test: `frontend/src/mobile/MobileAlertsView.test.tsx`, `frontend/src/mobile/MobileModals.test.tsx`

**Interfaces:**
- Consumes: `accountRowView`, `positionRowView`, `useAlertTick`, `decimalsOf` (Task 1); `normalizeAlert`, `TRIGGER_LABELS` (both already exported from `lib/alertsApi.ts`); `loadAccountAlerts()`, `loadPositionAlerts()` (every account), `deleteAccountAlert`, `deletePositionAlert`, `METRIC_LABELS`, `accountLabel`, `tradesSignal`, `accountAlertRequest`, `positionAlertRequest`, `AccountAlertModal`, `PositionAlertModal`, `isDemoMode`.

- [ ] **Step 1: Write the failing tests:**
  - A price row shows its trigger badge (`TRIGGER_LABELS[a.trigger]`, class `m-alerts-trigger`).
  - A price alert with `expiresAt` in the past is not listed.
  - A price alert on `EURUSD` at level `1.08234` while the open symbol is `US100` shows `1.08234` (precision from `decimalsOf`), not `1.08`.
  - With one account alert and one position alert, Active shows headers "Account" and "Positions" above the symbol rows, in that order.
  - The account row shows tier badges, the fired one with class `fired`, and "Unmonitored" when `monitored:false`.
  - Tapping the account row sets `accountAlertRequest` to `{mode:"edit", id}`; tapping the position row sets `positionAlertRequest` to `{account, epic, dealId, precision: a.precision ?? 2}`.
  - Delete on each confirms with the desktop's text (`Delete this ${METRIC_LABELS[metric]} alert on ${accountLabel(account)}?`, `Delete this ${SL|TP} warning on ${epic}?`) and calls the delete function on confirm.
  - "No active alerts." shows only when all three groups are empty.
  - `MobileModals.test.tsx`: setting `accountAlertRequest` renders `AccountAlertModal` (mocked); setting `positionAlertRequest` renders `PositionAlertModal` (mocked); neither renders in demo mode.

- [ ] **Step 2: Run, expect FAIL**
  Run: `cd frontend && npx vitest run src/mobile/MobileAlertsView.test.tsx src/mobile/MobileModals.test.tsx`

- [ ] **Step 3: Implement.** Price rows go through `normalizeAlert(r, i)` and the expiry check, and `precisionFor(epic, level)` uses the open symbol's precision when it matches, else `decimalsOf(level)`. Groups reuse `.m-alerts-row` and add `.m-alerts-group` headers and `.m-alerts-tier` badges. `MobileModals` mounts both modals like `App.tsx` ~1333-1338 (`now={Date.now()}` for the account one).

- [ ] **Step 4: Run, expect PASS** (same command), then `cd frontend && npx tsc -b && npx eslint src/lib/alertRows.ts src/AlertsSidebar.tsx src/mobile`

- [ ] **Step 5: Commit** `feat(mobile): Account and Positions alert groups, account/position alert dialogs`
