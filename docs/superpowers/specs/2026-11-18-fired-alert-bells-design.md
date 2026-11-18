# Fired alert bells

## Intent

A "once" alert deletes itself on the server when it fires, so its bell
leaves the chart at that moment. The user wants to still see where it was,
in a muted style, for as long as its entry stays in the Alerts History tab,
and to re-arm it from the chart.

## Goals

- A gray "fired" bell for every History entry whose alert:
  - was a `once` alert (`alert_json.params.trigger == "once"`),
  - is a chart alert (`price_level`, `indicator`, `line`; not `account` or
    `position`),
  - is not live any more (no live alert with that id),
  - is on this chart's broker and epic,
  - was not hidden by the user.
- Where it shows:
  - price alert: gray bell + level pill on the price axis, no dashed line;
  - indicator alert: gray bell at the end of the indicator curve, placed as
    the live one is (needs the linked pane still on the chart; otherwise none);
  - trendline alert: gray bell plus a faint dashed line.
- Tooltip: "Fired 2h ago" (plus the kind, as the live bell's label).
- Double click: re-arm. Right click: "Re-arm" and "Hide".
- Re-arm re-creates the alert with the same id and settings, so the
  live bell replaces the gray one and History still links to it.
- The bell goes when History is cleared or the entry drops off the
  200-entry cap.

## Non-goals

- No per-entry delete in History (History is still cleared all at once).
- No gray bell for "every" alerts or for alerts the user deleted by hand.
- No gray bell for expired alerts (expiry writes no History entry).

## Approaches

1. Gray bell only marks the spot (no clicks). Rejected by the user.
2. **Chosen:** gray bell with Re-arm (double click / menu) and Hide.
3. Same as 2, with Hide also removing that History entry. Needs a
   per-entry delete endpoint; not chosen.

## How

- Backend: `POST /api/alerts/{id}/rearm`. It takes the newest `triggered`
  row with that `alert_id`, refuses an expired alert (422 `expired`) or one
  it cannot upgrade (422), answers 409 when the id is live already, and
  otherwise calls the same `_rearm` hook the Telegram button uses (store
  create, engine, `__alerts__:changed` broadcast).
- Frontend `alertsApi.ts`: keep `alert_json`'s params and kind on each
  `TriggeredAlert`; add `firedAlertsFor(broker, epic)` (newest entry per
  alert id, filtered by the goals list) and `rearmAlert(id)`.
- Hide is per browser: a localStorage set of alert ids, pruned to ids still
  in History. (My call: no backend state for a cosmetic choice.)
- Chart: `useChartPaint` adds fired items to the axis tags and curve bells
  with a `fired` flag; `AlertTags` / `AlertCurveBells` render them gray
  (muted color, lower opacity) with the new tooltip and menu. The dashed
  line of a fired trendline alert uses the same muted color.

## Left to the builder

Exact gray and opacity values, test layout, and how the faint trendline is
drawn (reuse the line alert overlay with a muted style if possible).
