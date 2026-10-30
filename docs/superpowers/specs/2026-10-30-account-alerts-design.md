# Account alerts (margin level, P/L, equity, drawdown)

## Goal

Warn the user before the broker force-closes positions. Margin level can fall
fast and unnoticed; at a broker-specific level (Capital closes around 50%)
positions are liquidated at a loss. Account alerts watch account-wide figures
server-side, for every real broker account, whether or not the app (or any
browser tab) has that account selected.

## Decisions (from brainstorming)

- Metrics: margin level %, open P/L (amount or % of balance), equity,
  available, drawdown from peak.
- Firing: tiers + re-arm. One alert holds up to 3 tiers (warn, danger,
  critical); each fires once when crossed and re-arms after recovering past a
  hysteresis band.
- Polling: adaptive, 30 s normally, 5 s when near the next tier.
- Watchdog: notify when an account with active alerts cannot be polled.
- UI: bell on each dock stat opens a pre-filled create dialog; alerts panel
  lists them under an "Account" group.
- Accounts: real broker accounts only (Capital demo/live, MT5, IG). Paper is
  excluded (its figures live in the browser).
- Drawdown baseline: selectable per alert, `daily` (peak since local
  midnight) or `sinceCreated`.
- Notify only. Alerts never touch positions.

## Data model

A new alert kind `account` in `core/alert_kinds.py`, stored in the existing
`alerts` table so CRUD, duplicate detection, triggered history, notify
channels and delivery are reused unchanged.

- `broker` column: the account key (`capital-live:live`); `epic` column: `""`.
- `params`:

```json
{
  "metric": "marginLevel" | "openPnl" | "openPnlPct" | "equity" | "available" | "drawdown",
  "tiers": [{"level": 150, "label": "warn"}, {"level": 120, "label": "danger"}, {"level": 100, "label": "critical"}],
  "baseline": "daily" | "sinceCreated",   // drawdown only
  "tz": "Europe/Berlin"                   // drawdown daily only, from the browser
}
```

- Direction is implied by the metric: `marginLevel`, `equity`, `available`,
  `openPnl`, `openPnlPct` fire on falling BELOW a tier; `drawdown` (a positive
  percentage) fires on rising ABOVE one. Tiers are validated as strictly
  ordered in the firing direction, 1 to 3 entries, finite numbers, labels from
  `{warn, danger, critical}`.
- `sig(params)` = metric + baseline + sorted tier levels, so the existing
  `_check_duplicate` 409s an identical alert on the same account.
- `validate` refuses an account key that is not a registered executor with a
  real `get_account_summary` (paper accounts, unknown keys): 422
  `account_not_monitorable`.
- Runtime state (per alert, in `alert_meta`): which tiers are currently
  fired, and for drawdown the peak equity plus the day it belongs to. Kept in
  the store so a restart neither re-fires a held tier nor forgets the peak.

`AlertEngine` skips `account` rows entirely (no price feed is opened for
them); it already dispatches by `kind_of(row)`, so this is one guard where it
groups rows into feeds.

## Metric computation: `core/account_metrics.py`

A pure function `account_metrics(summary, positions, orders) -> AccountMetrics`
ported from `frontend/src/lib/accountStats.ts`, so the backend's margin level
is the dock's margin level:

- Broker-authoritative `equity`/`margin` (MT5) used verbatim when present.
- Else per-position margin summed when every position reports it (Capital),
  plus working-order margin.
- Else `balance (+ pnl for cash-balance brokers) - available`.
- `marginLevel = equity / margin * 100`, `None` when no margin is in use (no
  open positions: nothing to liquidate, tiers neither fire nor re-arm).
- `openPnlPct = openPnl / balance * 100`.

Parity is enforced by a shared fixture file
(`backend/tests/fixtures/account_metrics_cases.json`) read by both the Python
tests and `accountStats.test.ts`.

## Monitor: `core/account_monitor.py`

`AccountMonitor`, started and stopped by the app lifespan beside
`AlertEngine`. It keeps one asyncio task per account key that has at least
one active `account` alert (any user), created and cancelled as alerts are
created, patched, deleted or expire (the router calls `monitor.refresh(key)`
next to its existing engine notification).

Each poll cycle for an account:

1. `get_account_summary()` + `get_positions()` (+ working orders when the
   broker reports their margin) through the account's `ExecutionBroker`,
   which already shares the dealing session's rate limiter.
2. `account_metrics(...)`.
3. For each active alert on the account: evaluate tiers, update drawdown
   peak, fire / re-arm, persist state.
4. Choose the next delay: 5 s if any alert's value is within 20% of the
   distance to its next unfired tier (relative to the tier level, e.g. margin
   level under 180% for a 150% tier), else 30 s.

### Tier evaluation

- Fire tier T when the value crosses T in the firing direction and T is not
  already fired. Several tiers crossed in one poll fire as ONE notification
  naming the most severe one.
- Re-arm T when the value recovers past T by the hysteresis band: 3 points
  for `marginLevel`, `openPnlPct` and `drawdown`; 2% of the level for amount
  metrics (`equity`, `available`, `openPnl`).
- A value of `None` (no positions) keeps the current fired set unchanged.
- An alert created while already past a tier marks it fired WITHOUT
  notifying, so creation never fires instantly; the create dialog shows the
  current value so this is visible.

### Drawdown

`drawdown = (peak - equity) / peak * 100`. `daily`: peak resets at local
midnight in the alert's `tz` to the first equity seen that day.
`sinceCreated`: peak starts at equity at creation and only ever rises.
Patching the tiers keeps the peak; patching the baseline resets it.

### Watchdog

Poll failures are counted per account. When the last successful poll is
older than 120 s, send ONE "Account X is not being monitored: <reason>"
notification to every user with active alerts on it, on all of push,
Telegram and `/ws/state` regardless of each alert's channel choice, and mark
the account unmonitored. On the next successful poll send "monitoring
resumed" and clear the mark. A broker that is paused (the engine's
`_is_broker_paused` rule) counts as a failure with that reason.

## Delivery

Firing writes a `triggered` row (price = metric value, level = tier level,
condition = `below`/`above`) and fans out through the existing channels,
honouring the alert's `notify` settings. Message text:
`MARGIN LEVEL 118.4% < 120% (danger) · Capital live · equity 4,210 EUR`.
Critical tier Telegram messages are prefixed with a siren line and push
notifications set `requireInteraction`. No chart snapshot for account alerts
(there is no chart); Telegram sends text only.

## API

- `POST/PATCH/DELETE /api/alerts` accept `kind: "account"` with
  `broker = <account key>`, `epic = ""`.
- `GET /api/alerts` decorates account rows with `current` (latest metric
  value), `firedTiers` and `monitored: bool` (+ `unmonitoredReason`).
- `GET /api/alerts/account-metrics?account=KEY` returns the latest computed
  metrics (polling once if the monitor has none), for the create dialog's
  current value and tier pre-fill.
- Creating/patching an `account` alert requires the same dealing gate as
  account summary access; demo and impersonating sessions are refused (the
  latter by the existing GET-only rule).

## Frontend

- `PositionsPanel.tsx` / `MobilePositionsView.tsx`: Margin level, P/L,
  Equity and Available stats show a bell icon on hover (always visible on
  mobile, filled when an alert exists for that metric+account) with a
  `Tooltip`. Click opens `AccountAlertDialog`.
- `AccountAlertDialog.tsx`: metric (pre-selected), account (pre-selected,
  read-only), current value, 1 to 3 tier rows pre-filled with defaults
  (margin level 150/120/100; others: one tier at 10% worse than now), drawdown
  baseline toggle, notify channels (reusing the existing alert notify
  controls), message. Paper accounts show no bell.
- Alerts panel: an "Account" group listing account alerts with current value,
  tier chips (fired tiers highlighted), and an "Unmonitored" badge with the
  reason in a tooltip. Edit opens the same dialog.
- `lib/alerts` client gains the `account` kind type; no metric math in the
  frontend beyond what `accountStats.ts` already does.

## Error handling

- Broker summary missing fields: metrics needing them are `None`; tiers on
  those metrics hold state; the decorated row shows `current: null`.
- Account removed from the registry (credentials dropped): the monitor
  treats it as permanently failing and the watchdog notifies once.
- Monitor task crash: caught and logged per cycle; the task never dies, so
  monitoring cannot silently stop.

## Testing

- `test_account_metrics.py`: parity fixture cases (Capital, MT5, IG,
  no-positions).
- `test_account_kind.py`: validation, ordering, sig/duplicate 409, paper
  refusal.
- `test_account_monitor.py` (fake executor, fake clock): tier fire, multi-
  tier single notification, hysteresis re-arm, create-while-past suppressed,
  adaptive delay, drawdown daily reset and sinceCreated, watchdog
  unmonitored/resumed, task lifecycle on create/delete/expiry, restart keeps
  fired state.
- Frontend: `AccountAlertDialog.test.tsx`, alerts panel group rendering,
  `accountStats.test.ts` reading the parity fixture.
- Probe: `python3 -m scripts.alert_probe --account capital:demo` creates a
  margin-level alert one tier above the current value, waits for the fire,
  deletes it.

## Out of scope

- Auto-closing or one-tap close actions.
- Paper accounts.
- Live-tick margin recomputation between polls.
