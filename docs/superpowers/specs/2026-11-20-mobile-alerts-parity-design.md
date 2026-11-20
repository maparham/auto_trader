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
  the broker badge (`brokerLabel`).
- Each row uses the firing's own precision, as the desktop does.
- Tapping a row goes to the chart: Chart tab, that epic. The timeframe is the
  one `setMobileSymbol` restores for that symbol; the desktop jump passes no
  timeframe either (`App.tsx` `openAlert`). The jump selects nothing on the
  chart (my call: the mobile chart has no select hook for alert lines).
- A firing on another broker follows `openAlert`: when no registered account
  is on that broker, a toast says so and nothing else happens. Otherwise it
  asks first (`requestConfirm`, "Switch broker?") and then switches to
  `mobileAccountFor(broker, accounts)` (last used on that broker, else paper).
  `setMobileAccount` clears the symbol and boots that broker's market
  asynchronously, so the wanted epic must be handed to that boot as a pending
  target (the mobile twin of desktop's `pendingBrokerNavRef`), not set right
  after the call, where the boot would overwrite it.
- A "Clear history" button (`clearTriggered`).
- A "new" count on the History button, from `loadTriggeredSeen` /
  `pushTriggeredSeen`, the same marker as the desktop, so viewing History on
  either device clears it. While the count is above 0, the bottom Alerts tab
  shows a small dot.

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
