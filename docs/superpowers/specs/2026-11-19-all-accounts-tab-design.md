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
- View-only: no close, edit or alert buttons.
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

**Tab label.** "All accounts (N)", N = open positions in accounts other than
the active one, not counting hidden accounts. To keep N current while the tab
is closed, the other visible accounts' positions are polled every 2 min. No
count until the first poll lands.

**Sections.** Header: account name (`brokerLabel` + env, e.g. "IG · Live"),
equity, open P&L, margin level, currency, from `GET /api/account?account=`.
When the summary 404s (accounts without one), the header shows the sum of the
positions' `upnl` and leaves the other figures out. Sections with open
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
- Active account: open the symbol's chart like a normal row click.
- Any other account: confirm dialog, e.g. "This position is on IG (Live).
  Switch from Capital (Demo) to open US100?", plus the unsaved-changes
  warning when the layout is dirty. On Switch, the app sets that exact
  account active (not the broker's remembered account) and opens the symbol,
  reusing the cross-broker alert jump in `App.tsx` (`pendingBrokerNavRef`).
  Another env of the same broker switches the account without a workspace
  swap, then opens the symbol.

## Constraints

- No backend change: `/api/positions` and `/api/account` already take
  `account`.
- No polling of accounts the user hid; nothing at 30 s while the tab is closed.
- Plain UI text, no em dashes; tooltips through `Tooltip`/`InfoTip`.

## Left to the builder

Component split, where the polling hook lives, exact column widths, and the
localStorage key name.
