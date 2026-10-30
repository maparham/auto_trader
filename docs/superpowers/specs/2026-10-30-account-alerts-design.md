# Account alerts (margin level, P/L, equity, drawdown)

## Goal

Warn the user before the broker force-closes positions. Margin level can fall
fast and unnoticed; at a broker-specific level (Capital closes around 50%)
positions are liquidated at a loss. Account alerts watch account-wide figures
server-side, for every monitorable broker account, whether or not the app (or
any browser tab) has that account selected.

## Decisions (from brainstorming and review)

- Metrics: margin level %, open P/L (amount or % of balance), equity,
  available, drawdown from peak.
- Firing: tiers + re-arm. One alert holds up to 3 tiers (warn, danger,
  critical); each fires once when crossed and re-arms after recovering past a
  hysteresis band.
- Polling: adaptive, 30 s normally, 5 s when near the next tier.
- Watchdog: notify when an account with active alerts cannot be polled.
- UI: bell on each dock stat opens a pre-filled create dialog; alerts panel
  lists them under an "Account" group.
- Accounts: Capital (demo, live) and IG. MT5 is excluded: polling would keep
  the MetaApi account deployed and billed (every RPC defers auto-undeploy,
  `mt5.py:616`), and a paused account cannot be polled at all. Paper is
  excluded (its figures live in the browser).
- Drawdown baseline: selectable per alert, `daily` (peak since midnight in
  the SERVER's local time zone) or `sinceCreated`.
- Notify only. Alerts never touch positions.

## Data model

A new alert kind `account`, stored in the existing `alerts` table so CRUD,
duplicate detection, triggered history and notify channel settings are
reused.

- `broker` column: the account key (`capital-live:live`); `epic` column: `""`.
- `params`:

```json
{
  "metric": "marginLevel" | "openPnl" | "openPnlPct" | "equity" | "available" | "drawdown",
  "tiers": [{"level": 150, "label": "warn"}, {"level": 120, "label": "danger"}, {"level": 100, "label": "critical"}],
  "baseline": "daily" | "sinceCreated"    // drawdown only
}
```

- Direction is implied by the metric: `marginLevel`, `equity`, `available`,
  `openPnl`, `openPnlPct` fire on falling BELOW a tier; `drawdown` (a positive
  percentage) fires on rising ABOVE one. Tiers are validated as strictly
  ordered in the firing direction, 1 to 3 entries, finite numbers, labels from
  `{warn, danger, critical}`.
- Validation and `sig` live in a separate `core/account_alert_kind.py`
  (`ACCOUNT_KIND` with `validate(params, account_key)` and `sig(params)`),
  NOT in `alert_kinds.KINDS`: the price engine calls `bar_resolution`,
  `indicator_key` etc. on every kind it holds, and an account kind has none
  of them. The router dispatches `kind == "account"` to it in
  `_validate_kind`, `_validate_params` and `_check_duplicate`, so an identical
  alert on the same account 409s like the others.
- `validate` refuses an account key that is not a registered executor of a
  monitorable broker (Capital, IG): 422 `account_not_monitorable`.
- Runtime state per alert in `alert_meta` under key `account:<alert_id>`:
  JSON `{fired: [levels], peak, peakDay}`. Deleted with the alert. Patching
  `tiers` keeps the state but drops fired levels no longer present; patching
  `baseline` (the router compares old and new params) clears `peak`.

### Keeping account rows out of the price engine

`AlertEngine` must never see `account` rows. Today it buckets every row by
`(broker, epic)` in `start()` (`alert_engine.py:199`), `on_alert_changed`
(`:476`) and `feeds_needed()` (`:526`), which would spawn a feed loop for
`("capital-live:live", "")` that 404s forever. So:

- `start()` filters `kind == "account"` out of the rows it loads.
- The router sends account-row changes to `AccountMonitor.on_alert_changed`
  instead of the engine.
- Expiry of account rows is owned by the monitor (it checks `expires_at` each
  cycle and runs the same expire path the engine's `_sweep_expired` uses:
  deactivate, broadcast).

## Metric computation: `core/account_metrics.py`

A pure function `account_metrics(summary, positions) -> AccountMetrics`
using broker figures only. The browser's fallbacks in `accountStats.ts` that
depend on browser-only settings (working-order margin from
`trading.defaultLeverage`, `trading.accountBalance`) are NOT ported:

- `openPnl`: `summary.profitLoss` when present (Capital), else the sum of
  position `upl`.
- Margin in use: sum of per-position `margin` when every position reports it
  (Capital), else `balance (+ openPnl for cash-balance brokers, IG) -
  available`.
- Equity: `available + margin` when per-position margin is known, else
  Capital's `balance`, else `balance + openPnl` (IG).
- `marginLevel = equity / margin * 100`.
- `openPnlPct = openPnl / balance * 100`.

Outcomes:

- No open positions: `marginLevel` is `None` legitimately (nothing to
  liquidate) and the row stays "monitored". While flat, a `marginLevel`
  alert CLEARS its fired tiers (ruling R9): nothing stays armed through a
  flat stretch, so a position opened later past a tier notifies instead of
  staying silent from before the account went flat. The other metrics hold
  their fired set, since their values keep existing while flat.
- Positions open but a required figure missing (e.g. no `available`): the
  metric is `None` and the account is reported UNMONITORED with reason
  `missing <field>`, going through the watchdog, never holding silently.

The backend value can differ slightly from the dock's when resting orders
reserve margin (the dock adds an estimate the server cannot make). The
create dialog shows the SERVER's current value, so tiers are set against the
figure that is actually judged.

## Monitor: `core/account_monitor.py`

`AccountMonitor`, started and stopped by the app lifespan beside
`AlertEngine`. It loads active `account` rows at start, and keeps one asyncio
task per account key that has at least one active `account` alert,
created/cancelled from `on_alert_changed` and its own expiry.

Each poll cycle for an account:

1. `get_account_summary()` + `get_positions()` through the account's
   `ExecutionBroker` (which already goes through the broker's shared rate
   limiter: Capital 8 req/s, IG 5 req/s).
2. `account_metrics(...)`.
3. For each active alert on the account: expire if due, evaluate tiers,
   update drawdown peak, fire / re-arm, persist state.
4. Choose the next delay: 5 s if any alert's value is within 20% of its next
   unfired tier (relative to the tier level, e.g. margin level under 180% for
   a 150% tier), else 30 s.

### Tier evaluation

- Fire tier T when the value crosses T in the firing direction and T is not
  already fired. Several tiers crossed in one poll fire as ONE notification
  naming the most severe one.
- Re-arm T when the value recovers past T by the hysteresis band: 3 points
  for `marginLevel`, `openPnlPct` and `drawdown`; 2% of the level for amount
  metrics (`equity`, `available`, `openPnl`).
- An alert created while already past a tier marks it fired WITHOUT
  notifying on its first poll, so creation never fires instantly; the create
  dialog shows the current value so this is visible.
- Notify BEFORE persisting. A cycle sends the notification first and only
  then writes the new fired set to `alert_meta`; a failed history-row write
  inside the fire is logged and skipped, never raised. Persisting first would
  let a one-off store error leave the tier marked fired with no notification
  ever sent, and the next cycle would then hold it silently for good. A
  repeated notification after a failed save is the lesser evil.

### Drawdown

`drawdown = (peak - equity) / peak * 100`. The peak is seeded from the first
successful poll after creation (there is no summary at create time).
`daily`: the peak resets at server-local midnight to the first equity seen
that day. `sinceCreated`: the peak only ever rises.

### Watchdog

The monitor tracks the last successful poll per account. When it is older
than 120 s, or a poll yields a required figure as missing (above), send ONE
"Account X is not being monitored: <reason>" notification to every user with
active alerts on it, on push, Telegram and `/ws/state` regardless of each
alert's channel choice, and mark the account unmonitored. On the next good
poll send "monitoring resumed" and clear the mark. An account dropped from
the registry (credentials removed) is reported once and then stays marked
unmonitored without repeating.

Each cycle body is wrapped in try/except with logging, so a bug in one cycle
never kills the task and monitoring cannot silently stop.

## Delivery

Firing writes a `triggered` row (`kind = "account"`, `price` = metric value,
`level` = tier level, `condition` = `below`/`above`, `alert_json` = the row)
and fans out through the existing push, Telegram and `/ws/state` paths,
honouring the alert's `notify` settings. The current paths assume an
epic and a price, so each gets an `account` branch:

- Telegram (`telegram_notify.py`): `_headline` builds
  `MARGIN LEVEL 118.4% < 120% (danger) · Capital live · equity 4,210 EUR`;
  skip `_position_lines` and `_render_snapshot` (no chart). Critical tier
  messages get a siren prefix line. No action buttons.
- Web push: same text; critical sets `requireInteraction`.
- Frontend `alertsApi.ts` (`:430`): account rows go to their own cache, not
  `alertsCache[broker][epic]` as price alerts.
- `useAlertFiredNotices.ts`: the toast prints the metric text and does not
  navigate to a chart; clicking it opens the positions dock on that account.
- Triggered-history list: account entries render the metric text.

## API

- `POST/PATCH/DELETE /api/alerts` accept `kind: "account"` with
  `broker = <account key>`, `epic = ""`. Create and patch for this kind
  require admin (exec accounts are global and admin-only in hosted mode);
  demo and impersonating sessions are refused by the existing gates.
- `GET /api/alerts` decorates account rows with `current` (latest metric
  value or null), `firedTiers` and `monitored: bool` (+ `unmonitoredReason`),
  from `AccountMonitor.statuses()`.
- `GET /api/alerts/account-metrics?account=KEY` returns the latest computed
  metrics (polling once if the monitor has none), for the create dialog.
  Registered before the `{alert_id}` routes.

## Frontend

- `PositionsPanel.tsx` / `MobilePositionsView.tsx`: Margin level, P/L,
  Equity and Available stats show a bell on hover (always visible on mobile,
  filled when an alert exists for that metric and account), with a
  `Tooltip`. Only on Capital and IG accounts. Click opens
  `AccountAlertDialog`.
- `AccountAlertDialog.tsx`: metric (pre-selected), account (read-only), the
  server's current value, 1 to 3 tier rows pre-filled with defaults (margin
  level 150/120/100; others: one tier 10% worse than now), drawdown baseline
  toggle, notify channels (reusing the existing alert notify controls),
  message.
- Alerts panel: an "Account" group listing account alerts with current
  value, tier chips (fired tiers highlighted) and an "Unmonitored" badge with
  the reason in a tooltip. Edit opens the same dialog.

## Testing

- `test_account_metrics.py`: recorded Capital and IG summary/position
  payloads; no-positions; missing `available` reports unmonitored.
- `test_account_alert_kind.py`: validation, ordering, sig/duplicate 409,
  paper/MT5 refusal, admin gate.
- `test_account_monitor.py` (fake executor, fake clock): tier fire, multi-
  tier single notification, hysteresis re-arm, create-while-past suppressed,
  adaptive delay, drawdown daily reset and sinceCreated seeding, watchdog
  unmonitored/resumed/dropped-account, expiry, lifecycle on
  create/patch/delete, restart keeps fired state, a raising cycle does not
  kill the task.
- `test_alert_engine.py`: an account row in the store opens no feed.
- Telegram headline for an account fire.
- Frontend: `AccountAlertDialog.test.tsx`, alerts panel account group, the
  fired toast for an account entry.
- Probe: `python3 -m scripts.alert_probe --account capital:demo` creates a
  margin-level alert one tier above the current value, waits for the fire,
  deletes it.

## Out of scope

- MT5 accounts.
- Paper accounts.
- Auto-closing or one-tap close actions.
- Live-tick margin recomputation between polls.
- Working-order margin in the server's margin level.
