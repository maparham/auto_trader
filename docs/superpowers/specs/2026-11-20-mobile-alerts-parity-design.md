# Mobile alerts tab: desktop parity

Step 1 of 3 for the Android app (then a native Kotlin shell, then FCM push).

## Why

The phone app should show alerts the way the desktop does. Today the mobile
Alerts tab (`mobile/MobileAlertsView.tsx`) shows fewer facts per row, has no way
back to the chart, and leaves out account and position alerts entirely. This is
web code, so it also reaches the current Tauri app and the mobile browser.

## Goals

History sub-tab, matching `AlertsSidebar.tsx`'s History:
- Relative times ("5m ago") with `ago()` from `lib/timeFormat.ts`, refreshed
  every 30 s, the desktop's tick (`AlertsSidebar.tsx`, the `now` effect).
- Account firings (`kind: "account"`) show `accountLabel(broker)` instead of a
  symbol and offer no chart jump.
- A firing on another broker than the mobile account's (`mobileBroker()`) shows
  the broker badge (`brokerLabel`). Position firings store the ACCOUNT key in
  `broker` (`capital:demo`, `core/position_watch.py` `add_triggered`), so the
  comparison and the badge use `brokerOf(t.broker)` for every row. This is
  fixed in the shared helper, so the desktop, which has the same bug today
  (every position firing reads as foreign and its jump toasts "not
  available"), gets the fix too.
- Each row uses the firing's own precision, as the desktop does.
- Tapping a row goes to the chart through the existing `showMobileEpic(epic,
  precision)` (`mobile/mobileChartState.ts`), which the Positions view already
  uses: Chart tab, catalogue lookup, stale-call guard. When a mirrored layout
  cell shows that epic it opens with that cell's timeframe and scope;
  otherwise on the timeframe last viewed for that symbol. The desktop jump
  passes no alert timeframe either (`App.tsx` `openAlert`). The jump selects
  nothing on the chart (my call: the mobile chart has no select hook for
  alert lines).
- A firing on another broker follows `openAlert`: when no registered account
  is on that broker, a toast says so and nothing else happens. Otherwise it
  asks first (`requestConfirm`, "Switch broker?"), then calls
  `setMobileAccount(...)` and right after it `showMobileEpic(epic, precision)`.
  The account is the row's own account key when `broker` holds one (position
  firings), else `mobileAccountFor(broker, accounts)` (last used on that
  broker, else paper). No pending slot is needed: `bootMobileMarket` stops
  when a symbol is already set, and `showMobileEpic` re-checks the broker
  after its await. The worst case is a short flash of the boot symbol.
- A "Clear history" button (`clearTriggered`).
- A "new" count on the History button, from `loadTriggeredSeen` /
  `pushTriggeredSeen`, the same marker as the desktop, so viewing History on
  either device clears it. While the count is above 0, the bottom Alerts tab
  shows a small dot. `MobileApp` computes that count itself (subscribing to
  `alertsChanged`, reading `loadTriggered` and `loadTriggeredSeen`), because
  it mounts `MobileAlertsView` only while the Alerts tab is open.

Active sub-tab, symbol alert rows (the facts the desktop shows and mobile
lacks):
- A trigger badge (Once / Every, `TRIGGER_LABELS`).
- Expired alerts are dropped and legacy rows normalized, as the desktop's
  all-symbols list does (`normalizeAlert`, `expiresAt` check).
- Precision: the open symbol's when it matches, else inferred from the level's
  decimals (capped at 8), the desktop's `decimalsOf`, not a flat 2. So an FX
  level of 1.08234 shows in full.

Active sub-tab, adding the desktop's two groups above the symbol alerts:
- **Account** (`loadAccountAlerts`): account name, metric, "now" value, the
  tier badges (fired tiers dimmed), an Unmonitored badge with its reason.
- **Positions** (`loadPositionAlerts`): `US100 long · SL · 0.5× ATR · now
  0.8 ATR`, and a Fired badge.
- Both groups list every account's alerts, as the desktop does. The
  long/short word on a position row shows only for the active account's deals
  (`tradesSignal` holds no others), again as on the desktop.
- While either group has rows, the 30 s tick also calls `resyncAlerts()`, as
  the desktop does. Without it the "now" values, fired tiers and the
  Unmonitored flag stay at their boot-time values.
- Tapping a row edits it (`accountAlertRequest` / `positionAlertRequest`); a
  Delete button confirms and deletes, as the existing mobile rows do.
- `MobileModals.tsx` mounts `AccountAlertModal` and `PositionAlertModal`, both
  behind `!isDemoMode()` as in `App.tsx`. Today
  it mounts neither, so the bell on the mobile Positions view sets
  `accountAlertRequest` and nothing opens. This fixes that too.

## Non-goals

- No hover or chart selection from a row (no hover on a phone).
- No way to CREATE a position alert on mobile (the order ticket's proximity
  switches and the bell on a position row). Rows made on the desktop can be
  seen, edited and deleted here. Creating them is its own later step.
- No sort menu or all-symbols toggle on mobile.
- No change to the desktop's look or behaviour.

## Approaches

1. Copy the desktop row logic into the mobile view. Quick, but the two drift
   again, which is how this gap started.
2. **Chosen:** move the row logic that is not layout (row label, account name,
   broker badge, go-to target, the account and position row text) out of
   `AlertsSidebar.tsx` into a shared helper, and have both screens use it. Each
   screen keeps its own markup and CSS (`ap-*` on desktop, `m-alerts-*` on
   mobile).
3. Render the desktop components on mobile. They depend on hover, double-click
   and the desktop's cell and overlay props, so they would need many mobile
   branches.

## Left to the builder

- Name and place of the shared helper (for example `lib/alertRows.ts`).
- How "go to chart" reaches the Chart tab: `mobileTabSignal` plus
  `setMobileSymbol`, resolving the epic to an `Instrument` the way the mobile
  symbol search does.
- Whether the 30 s tick lives in the shared helper as a hook or stays in each
  screen.
- Tests: extend `MobileAlertsView.test.tsx`; the desktop sidebar tests must stay
  green after the move.
