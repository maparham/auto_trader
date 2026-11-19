# All accounts tab (positions at other brokers)

## Why

The user sometimes switches the whole workspace to a broker they rarely use
only to see how its open positions are going. They want to see every
account's open positions from wherever they are, and jump to one only when
they choose to.

## Goals

- A 4th dock tab, "All accounts", next to Positions / Orders / History.
- One section per dealing account (all brokers, demo and live; paper and
  data-only accounts are left out). The active account is included and marked
  "current".
- View-only rows: no close, edit or alert buttons. Managing a trade happens
  through the normal dock after the row click selects it.
- A row click opens that position's chart, switching broker/account after a
  confirmation when needed.

## Non-goals

- Orders and history of other accounts.
- A total across accounts (currencies differ).
- Creating alerts from this view.

## Approaches

1. Dock tab (picked): full detail where the user already looks at positions.
2. Header strip of per-account chips: always visible but takes space; can be
   added later on top of this tab's data.
3. Account alerts only: exists today, no code, but no way to just glance.

## Design

**When the tab exists.** Only when at least one dealing (non-paper,
non-data) account is registered; hosted non-admin users and demo mode have
none, so they see no tab. A data-only active broker (Dukascopy, Yahoo) keeps
its read-only dock with no tab. When the active account is paper, there is no
"current" section and every row click goes through the switch confirm. The
current section reads the dock's own trades feed and summary; it is never
polled by this tab.

**Tab label.** "All accounts (N)", N = open positions in accounts other than
the active one, not counting hidden accounts. To keep N current while the tab
is closed, the other visible accounts' positions are polled every 2 min. No
count until the first poll lands. Both polls pause while the browser tab is
hidden, like the dock's own polls, and run once per app tab. Failures stay
inside this tab: they never raise the app-wide broker outage or blocked
banners.

**Sections.** Header: account name (`brokerLabel` as is, e.g. "IG (live)"),
equity, open P&L, margin level, currency. `GET /api/account` has no margin
level and fills equity only for MT5, so the figures are derived client-side
with `lib/accountStats.ts` from the summary plus the positions, the same rules
the dock uses, but without margin held by working orders (this tab does not
fetch orders). So a figure can differ slightly from the dock strip when
resting orders hold margin. When the summary 404s, the header shows the sum
of the positions' `upnl` and leaves the other figures out. Sections with open
positions start expanded, empty ones collapsed. Order: accounts with
positions first, then the rest; the current account first within its group.

**Rows.** Symbol, side, size, entry, current price (`mark`), P&L, SL, TP, and
the distance from the current price to SL and to TP in percent ("SL 0.4%").
No mark or no level: "-".

**Refresh.** While the tab is open: fetch on open, then every 30 s. A refresh
button and "updated 20 s ago" sit at the top. Each account loads on its own;
a failed account (down, reconnecting, blocked) shows its error in its own
section and the others still load.

**Hide accounts.** An eye toggle on each section header hides it. Hidden
accounts are not fetched, not counted in N, and are listed in a "Hidden (2)"
line at the bottom where they can be shown again. Saved per browser in
localStorage (not per broker workspace).

**Row click.**
- What a click does: open the symbol's chart AND select the position, like
  the dock's own row click (`edit()` in `PositionsPanel.tsx`: jump to the
  epic, then select the trade, which opens the order ticket in edit mode).
  After a switch, the selection waits until the new account's trades feed
  holds that deal id; if it never shows up (closed meanwhile), only the chart
  opens.
- Active account: no dialog.
- Any other account: confirm dialog, e.g. "This position is on IG (Live).
  Switch from Capital (Demo) to open US100?", plus the unsaved-changes
  warning when the layout is dirty. On Switch, the app sets that exact
  account active (not the broker's remembered account) and opens the symbol,
  reusing the cross-broker alert jump in `App.tsx` (`pendingBrokerNavRef`).
  Each broker id has one dealing account (`capital:demo`,
  `capital-live:live`, `ig-demo:demo`, `ig-live:live`, `mt5-self:live`), so
  this is almost always a workspace swap. The only no-swap case is from that
  broker's paper account (e.g. `capital:paper` to `capital:demo`): the
  account changes, the layout stays, and the dialog has no unsaved-changes
  warning.

## Constraints

- No backend change: `/api/positions` and `/api/account` already take
  `account`.
- No polling of accounts the user hid; nothing at 30 s while the tab is closed.
- Plain UI text, no em dashes; tooltips through `Tooltip`/`InfoTip`.

## Left to the builder

Component split, where the polling hook lives, exact column widths, and the
localStorage key name.
