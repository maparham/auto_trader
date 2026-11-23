# SL/TP move rules: design

## Intent

Let the user say, ahead of time, "when price does X, move this position's
stop loss (or take profit) to Y", and have the server do it without a browser
tab open.

The user's two cases:

- **Winning trade:** once price has moved far enough in the trade's favor,
  raise the SL (for a long; lower it for a short), often to breakeven, so the
  trade can no longer lose.
- **Losing trade:** once price has moved against the trade, pull the TP closer
  so the trade exits sooner at a smaller profit, at breakeven, or at a smaller
  loss.

The "when" part should not be limited to a fixed price. The user wants the same
triggers alerts already have, including a cross of a Trendlines line.

## Goals

- A move rule = an alert trigger (any of the existing price alert kinds) plus
  an action: set the SL or TP of one open position to a number or to
  Breakeven.
- Turned on from the order ticket ("Move SL" / "Move TP"), for a new market
  order and for an open position being edited.
- With a price trigger, a draggable trigger line on the chart, styled like the
  SL/TP lines. When the target is a number, a second, faint, draggable line
  shows the new level.
- Runs server-side in the alert engine, on the live tick feed.
- The user is told when the move happens, and told with the broker's reason
  when it fails.
- Listed and manageable like other alerts (Alerts sidebar, edit, delete).

## Non-goals

- Several steps per position (a ladder of moves). One rule per position per
  side (one for SL, one for TP). A ladder can come later.
- AND/OR conditions or the backtest expression language.
- Trailing stops. A position with a broker trailing stop refuses an SL rule
  (same rule as SL proximity alerts).
- Pending (limit/stop) orders. As with the proximity switches, the ticket
  offers it for market orders; a filled order gets it from the position.
- Moving from Telegram or push. The rule is set in the app.
- Paper accounts are in only because they cost nothing extra (they implement
  `modify_position`).

## Anti-goals (a failure even if it technically works)

- **Wrong position or account.** The action only ever touches the one deal id
  on the one execution account stored in the rule.
- **Silent failure.** A refused or failed move is reported, with the broker's
  reason, on every channel the rule notifies.
- **Moving twice.** A rule acts once and is then gone.
- **A late move.** The trigger is evaluated on the live feed, like alerts, not
  on a slow poll.
- **Acting on a closed position.** If the deal is gone, the rule is deleted
  without acting.

## Approaches

1. **Alert triggers plus an action (chosen).** Any existing price alert kind
   (`price_level`, `indicator`, including the Trendlines `tl_nearest` output,
   and `line`) can carry an `action`. Live tick evaluation, conditions,
   dialogs, the store, the sidebar and Telegram already exist. Limit: one
   condition per rule.
2. Backtest expression rules. Full language with AND/OR, but nothing runs them
   live today, and they act only on bar close. Much more work.
3. Price level only. Simplest, but no indicator or Trendlines triggers.

The user picked 1.

## The rule

An alert row as today (`broker` = data broker, `epic`, `kind`, `params` with
`condition`), plus a new `action`:

```json
{
  "account": "capital:demo",
  "dealId": "DIAAAA...",
  "field": "sl" | "tp",
  "target": {"type": "price", "value": 1.1000}
           | {"type": "breakeven", "offset": 0}
}
```

- `account` is the execution account; its prefix before `:` must equal the
  row's data `broker` (same mapping as position alerts).
- Breakeven = the position's open level, read from the broker when the rule
  fires, plus `offset` in price units in the trade's favor (positive offset
  locks in a small profit, for example to cover the spread). Default offset 0.
- `trigger` is forced to `once`.
- Conditions are the alert ones: Crossing, Crossing Up, Crossing Down,
  Greater Than, Less Than. Default for a price trigger is the natural
  direction: a long's Move SL uses Crossing Up, a long's Move TP uses Crossing
  Down; mirrored for a short.
- Duplicate check: at most one active rule per (account, dealId, field). A
  second one is a 409.

## What happens on fire

1. The engine's fire path sees `action` and hands it to a new executor
   (`core/move_rule.py` or similar), which gets the exec adapter by account.
2. The executor reads the position fresh from `get_positions`. Deal gone: delete
   the rule silently. Trailing stop on an SL rule: fail (see below).
3. It resolves the target (number, or open level plus offset) and calls
   `modify_position(deal_id, stop_level=...)` or `take_profit_level=...`.
4. Success: the rule is deleted; a fired entry goes to History; notification
   on the rule's channels: "Moved SL of <epic> <side> to <level> (was <old>)".
5. Failure (broker refusal, level on the wrong side of price, network): retry a
   transient network failure up to 3 times within about 30 s; a broker refusal
   is not retried. Then the rule is deleted and the user is notified with the
   reason. The History entry records the failure.

**Tighten only (the user's choice).** At fire time the executor compares the
target with the position's current level:

- SL: move only if the target is in the trade's favor of the current SL
  (higher for a long, lower for a short).
- TP: move only if the target is closer to the current price than the current
  TP (lower for a long, higher for a short).
- No current level: the rule adds one.
- Already as tight or tighter (for example the user moved it by hand): skip,
  delete the rule, and notify "SL already at <level>, not moved".

So a manual edit never cancels the rule, and the rule never loosens a level.
A clearing of the SL/TP does not delete the rule either; it then adds the
level when it fires. The broker still refuses a level on the wrong side of
the price, which is reported as a failure.

## Builder calls (from the review)

- **No re-arm.** A move rule that acted is left out of the fired bells
  (`firedPriceAlerts`/`firedLineAlerts`/`firedIndicatorAlerts`), and
  `POST /api/alerts/{id}/rearm` refuses it (422 `not_rearmable`).
- **Notify channels.** A ticket-made rule notifies on toast, push and
  Telegram. A failed move always goes to all three, whatever the rule says.
- **Which price.** A price trigger compares the position's side price, as
  position alerts do: the bid for a long, the offer for a short (a missing
  side falls back to the other). Indicator and line triggers keep the
  alert engine's usual price.
- **Line menu.** With no open position on that epic, the "Move SL/TP when
  crossed" items are hidden.

## Lifecycle

- The rule is deleted silently when the position closes, by its own 10 s
  poll of each account that has rules (modelled on `core/position_watch.py`).
  A failed poll deletes nothing.
- Partial close keeps the rule (same deal id).
- Restart: rules are stored rows, so they survive. `once` plus delete-on-act
  means a restart cannot act twice.

## Order ticket and chart

- In `OrderTicket.tsx`, under the TP and SL fields, a "Move SL" and a "Move TP"
  switch, next to the existing "Warn near" switches. Turning one on shows:
  target (number field, or a Breakeven preset with an offset field), trigger
  and the condition. The ticket's trigger is always a price level.
- Indicator and Trendlines triggers are set from the existing alert dialogs
  (`IndicatorAlertModal`, `LineAlertModal`), which get a "Then: Notify / Move
  SL / Move TP" row with a position picker. They already own the indicator
  picker and the line checks, so the ticket does not copy them. (Changed during
  planning.)
- Price trigger: a draggable dashed line appears on the chart, labelled like
  `Move SL → BE  when ↑`, using the existing horizontal line drag
  (`chart/useLineDrag.ts`, `lib/positionLines.ts`). A numeric target adds a
  faint second line for the new level, also draggable. Dragging updates the
  ticket fields and the reverse.
- For a new market order, the rule is created after the fill with the new
  deal id, like the proximity switches (failure toast: "Order filled. Move SL
  not set: <reason>").
- The `line` kind (a frozen Trendlines line) is set from the line's right-click
  menu: "Move SL when crossed…" / "Move TP when crossed…", which open the line
  alert dialog with that action chosen; the position is picked there.
- Open positions with a rule show it on the position row (like the proximity
  bell) and as the chart lines above; clicking opens the ticket in edit mode.
- Alerts sidebar: rules appear in the "Positions" group with their own icon.

## Permissions

Admin-only, like position alerts, because it is a dealing action
(`deps.require_admin`).

## Left to the builder

- Store migration for the `action` column (JSON), and how `GET /api/alerts`
  returns it.
- Exact module split between the alert engine fire path and the executor.
- Line colors and label text, within the app's existing SL/TP line style.
- Probe script (`scripts.alert_probe --move ...`) on `capital:demo`.
- Feature notes: a "Move rules" section in `docs/features/alerts.md`.
