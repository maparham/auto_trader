# SL/TP proximity alerts: design

## Intent

Warn the user, early enough to act, when an open position's price is getting
close to its stop-loss or take-profit.

Two moments drive this (the user's words, paraphrased):

- **Near TP:** price stopped a hair short of the TP and reversed. Knowing in
  time, the user would have closed the position by hand.
- **Near SL:** price drives hard into the SL, takes it out and reverses. The user
  can often spot these likely reversals early and would pause (remove) or move
  the SL.

The warning has to reach the user away from the desk: Telegram and web push.

## Goals

- Opt-in per position, with separate SL and TP switches.
- "Close" scales with the instrument's volatility (a multiple of ATR).
- Delivery through Telegram and web push, plus the in-app toast every alert gets.
- Telegram buttons that remove the SL or TP after a confirm step.
- Managed like other alerts: listed in the Alerts sidebar, editable, deletable.

## Non-goals

- Paper accounts. Cover them only if it costs nothing extra.
- MetaApi `mt5`. The user trades MT5 through `mt5-self`. Leave the MetaApi
  adapter alone, and never make it poll.
- Moving the SL from Telegram. Only remove is in scope.
- Dealing buttons on push notifications or toasts.
- Auto-enabling the alert on every position.

## Anti-goals (a failure even if it technically works)

- **A late warning.** A 30 s poll cadence for the price check is too slow when
  price is hammering an SL. The price check runs on the live feed.
- **Spam.** Price that hovers around the threshold must not fire again and
  again.
- **A dealing action by accident.** No SL/TP is removed without an explicit
  second tap. The action must never land on the wrong position or account.
- **Silent failure.** If the broker refuses the removal, the user is told,
  with the broker's reason.

## Scope: accounts

Real-money and demo dealing accounts on Capital (`capital:demo`,
`capital-live:live`), IG (`<ig-id>:<side>`) and self-hosted MT5
(`mt5-self:live`, whatever `BROKER_ID` in `brokers/mt5_mcp.py` is). The
execution-account key's prefix before the `:` is the data broker id
(`brokers/capital.py`, `ig.py`, `mt5_mcp.py` all register them that way), and
that data broker is the one whose live feed watches the price.

## What the user sees

### Order ticket

In `OrderTicket.tsx`, next to each of the SL and TP fields:

- A switch: "Warn near SL" / "Warn near TP".
- A distance field in ATR multiples, prefilled from Settings (see below), shown
  only while its switch is on.

Each switch is disabled while its level (SL or TP) is empty. When the order
fills, the alert(s) attach to the resulting position. For a resting limit
order, they attach when it fills (see "Pending orders" below).

### Existing positions

Each row of the positions table (`PositionsPanel.tsx` / `lib/positionsTable.tsx`)
gets a bell that opens a small dialog with the same two switches and distances.
This works on ANY open position on a covered account, wherever it was opened
(Chartkar, the broker's own platform, the MT5 terminal). A bell that's on looks
different from one that's off. Follow the muted-toggle convention: gray, not
solid accent blue.

The mobile positions view (`mobile/MobilePositionsView.tsx`) gets the same
entry point if it is cheap. Builder's call.

### Settings

One new Settings entry: a default distance in ATR multiples, used to prefill
both the SL and TP fields. Default value: 0.5 (my call). A separate SL and TP
default is the builder's call if it is free; the user asked for one default.

### Alerts sidebar

A new group, or rows inside the existing "Account" group (builder's call), one
row per position alert. Each row shows symbol, side, which level (SL/TP), the
distance setting and the current distance in ATR. Editing changes the distance
or turns a side off. Deleting removes it.

### The notification

Text (all channels):
`US100 long · near SL · 12.4 pts (0.38 ATR) away · SL 18 210.0 · P&L −84.20 USD`

- **Telegram:** the text plus a chart photo (the existing snapshot path,
  `core/chart_snapshot.py`, with its fallbacks). One button: "Remove SL" (or
  "Remove TP", for whichever side fired). No "Open chart" button: the app has
  no public deep link to a symbol, and the user did not ask for one.
- **Web push / in-app toast:** the same text, no dealing buttons. A push click
  keeps today's behaviour (`frontend/public/alert-sw.js`: focus an open window
  or open `/`). A toast click focuses or opens that symbol's chart in the app.

### Telegram remove flow

1. The user taps "Remove SL".
2. The bot edits the message's buttons to "Remove SL on US100 long? Yes /
   Cancel". The text names the symbol, side and level, so the user knows
   exactly which position is affected.
3. **Yes** calls `modify_position(deal_id, clear_stop=True)` (or
   `clear_take_profit=True`) on that position's execution account. The bot
   answers "SL removed ✓" or "Couldn't remove SL: <broker reason>", and clears
   the buttons on success.
4. **Cancel** restores the original buttons.

Safety checks before the Yes call:

- The pressing chat maps to the alert's owner (the existing
  `telegram_links` check in `_run_callback`).
- The alert still exists and belongs to that user.
- The position (`deal_id`) is still open on that account.
- The level being removed is still the one the alert fired on. If the user
  has since moved it, refuse with "SL has changed since this warning" rather
  than removing a stop the user just set.
- The user may deal. A Telegram callback carries no Clerk JWT, so the in-app
  gate (`deps.require_admin`, which can match on the email claim) cannot run
  as is. Rule (my call): in local dev (auth off) the dev user may deal; in
  hosted mode the linked `user_id` must be in `ADMIN_USER_IDS`. An admin
  listed only by email gets "Removing a stop from Telegram needs your user id
  in ADMIN_USER_IDS" and nothing is changed. No Clerk lookup on this path.
- A confirm that is older than a short window (my call: 10 minutes) is refused
  as stale.

Callback data is capped at 64 bytes (`_CALLBACK_DATA_MAX`). Put a short
server-side token in the button, not the deal id, account and level.

## Behaviour

### Distance

`threshold = N × ATR(14)` on 15-minute candles of the position's epic, from the
data broker. My call: the user said "tied to volatility" and accepted the 15m
ATR(14) guess in playback. N is per side, per position. The ATR updates on each
15m close. The indicator hub (`core/alert_indicators.py`) or the
backtest series registry probably already serves ATR. Reuse it rather than
writing a new ATR.

### Firing

Fire when the price that would trigger the level is within the threshold:

- Long SL / long TP: the bid (a long closes at the bid).
- Short SL / short TP: the offer.

If the feed only gives one price, use it and note the gap. The builder checks
what the live feed delivers per broker.

If price is already inside the threshold when the alert is switched on (or
when the position opens with it on), it fires on the first tick. The user
decided this: a tight stop that starts inside the zone still warns at once.

Each side fires once. When the level sits closer to entry than 1.5 × the
threshold, price may never back off far enough to re-arm, so in practice it
warns once unless the level moves. That is accepted, not a bug. It re-arms when price backs away beyond
`1.5 × threshold` from the level (hysteresis of half the threshold, my call).
Moving that SL/TP re-arms it.

### Lifecycle

- **Position closed** (gone from `get_positions`): its alerts are deleted
  automatically, with no notification.
- **Level removed** (SL or TP cleared, from anywhere, including the Telegram
  button): that side's alert is deleted, with no notification. The user
  decided this. Setting a new level later does not bring it back; the user
  switches it on again from the position's bell.
- **Level moved:** the new level is watched, and the fired state resets.
- **Partial close:** same `deal_id` on Capital, so the alert follows it.
  Brokers that mint a new id on partial close: builder checks and handles.

### Trailing and guaranteed stops

Positions with a trailing stop are excluded: the SL switch and the bell's SL
side are disabled with a tooltip saying why (the level moves every tick, so
"moved re-arms" would spam and "refuse if changed" would refuse every
Remove). The TP side stays available. Do not send a modify that would turn a
trailing stop off: IG's `modify_position` always sends `trailingStop: False`,
so "Remove TP" on an IG position with a trailing stop is refused before the
broker call. Guaranteed stops are allowed. If the broker refuses the removal
(Capital does, `brokers/capital.py:843`), the user sees its reason.

### Pending orders

A switch set in the ticket on a resting limit order must survive until the
order fills. The order's id is not the position's deal id, so the system needs
a pending record keyed by the order id that becomes a position alert once the
fill is seen. If this gets complicated for a broker, it is acceptable to
support only market orders at first and grey the switch out for limit orders,
saying so in a tooltip. Builder's call, and say which in the plan.

## How it fits the existing code

### Two loops

1. **Position tracking (slow):** poll `get_positions` per covered account that
   has at least one position alert, to learn each watched position's current
   SL, TP, side and mark, and to spot closes. `core/account_monitor.py`
   already polls `get_positions` for account alerts: extend or share that loop
   rather than adding a second poller for the same account. A cadence of about
   10 s is my call. It only has to catch moved levels and closes, not price.
2. **Price check (fast):** on the live feed of `(data broker, epic)`, the same
   feed `core/alert_engine.py` already spawns for price alerts. Each tick is
   compared against the tracked levels.

The price engine's existing kinds are bound to (broker, epic) with fixed
params. A position alert's level comes from the broker and changes. Whether it
becomes a new kind in `core/alert_kinds.py` with the level resolved from the
tracker, or a separate evaluator subscribed to the engine's feeds, is the
builder's call. Constraint: it must not get the price engine's per-bar
"every" semantics wrong, and must not change behaviour of existing kinds.

### Storage and API

Position alerts are stored in the alert store with a new `kind` (for example
`position`), keyed by user, execution account and `deal_id`, with params
`{side: "sl"|"tp", atrMult}` or one row holding both sides (builder's call).
Create/patch/delete go through `/api/alerts`. Duplicates (same account,
deal_id, side) 409, as other kinds do.

### Paper

If the tracker and the feed cover paper for free (the paper executor implements
`get_positions` and `modify_position`), allow it. Otherwise, exclude it.

## Constraints

- Telegram callback data ≤ 64 bytes.
- MetaApi `mt5` must never be polled by this feature.
- Backend tests (pytest) for: threshold and side-correct prices, hysteresis,
  re-arm on level move, auto-delete on close, the confirm flow (including stale,
  wrong-owner, level-changed, and already-closed), and the 409 duplicate.
  Frontend tests only for the files touched. Never the full suite.
- UI text: no em dashes. Tooltips through `Tooltip`/`InfoTip`, short lines.
- Add a short "Position alerts" section to `CLAUDE.md` once built.

## Left to the builder

- New kind versus separate evaluator, and the row shape.
- Sidebar placement (new group or inside "Account").
- Mobile entry point.
- Pending-order support at first or later.
- Exact tracker cadence and how it shares `ACCOUNT_MONITOR`'s polling.
- Where the ATR comes from.

## Calls I made (the user did not decide these)

- ATR(14) on 15m, default multiple 0.5.
- Re-arm after price backs away to 1.5 × the threshold. Moving the level re-arms.
- Push and toast: no dealing buttons, click opens the chart.
- No "Open chart" Telegram button; push click unchanged.
- Telegram dealing gate: `ADMIN_USER_IDS` only in hosted mode.
- Trailing-stop positions: SL side excluded, TP side allowed without touching the trail.
- Confirm window of 10 minutes; refuse if the level has changed.
- Position tracker at about 10 s.
