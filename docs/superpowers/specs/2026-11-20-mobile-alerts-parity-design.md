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
  every minute.
- Account firings (`kind: "account"`) show `accountLabel(broker)` instead of a
  symbol and offer no chart jump.
- A firing on another broker than the mobile account's (`mobileBroker()`) shows
  the broker badge (`brokerLabel`).
- Each row uses the firing's own precision, as the desktop does.
- Tapping a row goes to the chart: Chart tab, that epic, at the alert's
  timeframe when the row has one. A firing on another broker asks first
  (`requestConfirm`) and then switches the mobile account to that broker, the way
  the desktop asks before switching broker.
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
- Tapping a row edits it (`accountAlertRequest` / `positionAlertRequest`); a
  Delete button confirms and deletes, as the existing mobile rows do.
- `MobileModals.tsx` mounts `AccountAlertModal` and `PositionAlertModal`. Today
  it mounts neither, so the bell on the mobile Positions view sets
  `accountAlertRequest` and nothing opens. This fixes that too.

## Non-goals

- No hover or chart selection from a row (no hover on a phone).
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
- Tests: extend `MobileAlertsView.test.tsx`; the desktop sidebar tests must stay
  green after the move.
