# Alerts

Price alerts are backend-owned: every alert is evaluated server-side in
`backend/auto_trader/core/alert_engine.py` off one live feed per (broker,
epic), independent of any open browser tab. CRUD is `/api/alerts` (create,
list, patch, delete) plus `/api/alerts/triggered` for fired history; delivery
fans out to `/ws/state`, web push, and Telegram. `TELEGRAM_BOT_TOKEN` in the
environment enables the Telegram channel. End-to-end probe:
`cd backend && python3 -m scripts.alert_probe [--epic EPIC --broker BROKER
--timeout SECONDS]`.

Create and patch both 409 on a duplicate: same (broker, epic, kind) and the
same `kind.sig(params)` another of the user's alerts already has (message,
notify, and expiry don't count, since they don't change what fires). The
check lives in `api/routers/alerts.py`'s `_check_duplicate`, reusing each
kind's own `sig()`.

Alert kinds live in `core/alert_kinds.py` (`price_level`, `indicator`,
`line`): each validates its params and resolves a `(subject, level)` pair;
`core/alert_eval.py` is the one evaluator. Indicator alerts run on the
backtest series registry: params are `{type, config, output}` where `config`
is the registry's parsed config as JSON (`indicators/alert_series.py`), and
`indicators/alert_specs.py` says which outputs of each type are alertable
(level or 0/1 event, price axis or not), the label and the refusals. Create
and patch take the raw pane as `params.instance` and the server parses it;
old `{indicator, calcParams, config}` params are upgraded by
`alert_kinds.upgrade_params` (store migration 2, re-arm, triggered history).
The frontend mirrors none of this: `GET /api/alerts/indicators` lists the
alertable types and `POST /api/alerts/describe` returns a pane's outputs,
labels, refusal and current values from the alert hub. Event outputs are
stored as a close-mode cross up through 0.5. "Every" alerts fire at most once
per bar of their timeframe. Probe an indicator alert with
`python3 -m scripts.alert_probe --indicator`.

Trendline alerts come in two forms. The `line` kind is a frozen straight line
in bars of its timeframe (`tRef`, `pRef`, `slope`), made from a right-clicked
Trendlines line; the engine rolls `tRef` forward every 1000 bars
(`LINE_REBASE_BARS`) so it stays inside the 2000-bar seed, and create 422s
when the chart's reference bar is not one the server holds. Nearest-line
alerts are `indicator` alerts on `TRENDLINES`, output `tl_nearest` (the only
alertable Trendlines output); the hub runs the full Trendlines compute once
per close, in a worker thread (the series is not ready for it until the
result lands, and close mode evaluates on the first sample after), and keeps
the held line, so close mode judges a cross against one line
(`resolve_close`) and intrabar only projects it. Nearest-line alerts refuse
the 1m timeframe.

Telegram alert photos are live chart screenshots: `core/chart_snapshot.py`
drives a headless Chromium over the frontend's `/?snapshot=1` boot mode,
reconstructing the user's last-seen view (mirrored `view.<epic>` heartbeat)
with live data; matplotlib (`core/alert_chart.py`) and text remain fallbacks.
Needs `FRONTEND_URL` (default `http://localhost:5173`) and Playwright
Chromium; `SNAPSHOT_DISABLED=1` turns it off. Probe:
`cd backend && python3 -m scripts.snapshot_probe --epic EPIC`.
`SNAPSHOT_DISABLED` with any non-empty value disables the feature.

## Fired alert bells

A fired `once` alert deletes itself, but while its History entry exists the
chart keeps a gray bell for it: an axis tag for `price_level`, a bell on the
curve for `indicator`, a bell plus a faint gray dashed line for `line`
(`firedPriceAlerts`/`firedIndicatorAlerts`/`firedLineAlerts` in
`lib/alertsApi.ts`, built from the History rows' `alert` with the live row
mappers; newest entry per id, never when the id is live again). Double click
re-arms through `POST /api/alerts/{id}/rearm` (same id and settings, create's
own checks, 422 `expired`/`not_rearmable`, 409 on a duplicate); right click
offers Re-arm and Hide. Hide is per browser (`<PREFIX>.alerts.hiddenFired`,
`{id: hiddenAt}`, pruned to ids still in History): it covers entries up to
that time, so a later fire shows again. Deleting an alert hides it the same
way, so a re-armed alert the user deletes does not come back gray. Spec:
docs/superpowers/specs/2026-11-18-fired-alert-bells-design.md.

## Legend alert bell

Every indicator alert linked to a cell also puts a bell on its indicator's
legend row, on the alert's timeframe (the pin's, when pinned), live alerts
and fired ones still in History alike (`indicatorAlertBells` in
`chart/legendAlertBells.ts`; ChartCore reads it through
`useSyncExternalStore` on `alertsChanged` and keeps the old map while
`bellsSig` is unchanged, so an alert-line drag does not re-render every
cell). The server stamps `whole: true` on indicator rows (live and History)
whose output is an event or price-only (`IndicatorKind.whole`): divergences,
candle patterns, sweeps, Trendlines' `tl_nearest`. Those have no curve bell
and no dashed level line, so the legend bell is their only mark; other
alerts keep their curve bell or dashed line as well.

The bell (`chart/AlertBellList.tsx`) is drawn like the row's icons: an
outline in `--text-dim`, an 18px cell that joins the action icons' strip,
faint when every alert on it has fired, the count as a superscript. A click
(or right click, or Enter) opens a list under it, one row per alert, named
by `alertLabel` (an event by its name alone). Clicking a live row edits it,
and its pencil and trash edit and delete; a fired row shows when it fired
and has Re-arm and Hide. The list is portaled, so it stops its own events
from bubbling up the React tree to the legend row (select, settings, an
armed "Pick from chart"); it takes focus, and closes on an outside click,
Escape (consumed in the window's capture phase), resize or scroll.

## Account alerts

`kind: "account"` rows (`broker` = exec key such as `capital-live:live`,
`epic` = `""`) watch an account figure (`marginLevel`, `openPnl`,
`openPnlPct`, `equity`, `available`, `drawdown`) with 1 to 3 tiers
(warn/danger/critical) that fire once when crossed and re-arm after a
hysteresis band. They are NOT in `alert_kinds.KINDS` and the price engine
skips them: `core/account_alert_kind.py` validates and signs them,
`core/account_monitor.py` (`ACCOUNT_MONITOR`) polls each account's
`get_account_summary` + `get_positions` (30 s, 5 s within 20% of the next
tier), computes figures with `core/account_metrics.py` (broker figures
only, so the value can differ from the dock when resting orders reserve
margin), owns their expiry and fires through the same broadcast/notifiers.
Per-alert state (fired tiers, drawdown peak) lives in `alert_meta` under
`account:<id>`. The monitor seeds an alert on its first successful poll,
even when the value is None, and a tier already past at that poll is marked
fired silently. While the account is flat, `marginLevel` alerts clear their
fired tiers, so a position opened past a tier notifies. The drawdown peak
and its day are persisted whenever they change, and the `daily` baseline
resets at server-local midnight. Each notifier call is bounded by
`NOTIFIER_TIMEOUT_S` (30 s); broadcast and notifier failures are logged and
never skip the other channels.

Only Capital and IG non-paper accounts are monitorable. Create and patch are
admin-only. A poll failure older than 120 s or a missing figure reports the
account unmonitored once (push + Telegram + `__alerts__:monitor`) and
"resumed" once. `GET /api/alerts` decorates account rows with `current`,
`firedTiers`, `monitored`, `unmonitoredReason` and `currency`, and
`GET /api/alerts/account-metrics?account=` serves the dialog's current
value. The create dialog shows the server's value, except drawdown on
create, which reads "starts at 0% on the next check". Frontend: bell on the
dock stats (`PositionsPanel.Stat`), `AccountAlertModal.tsx`, the "Account"
group in `AlertsSidebar.tsx`, `loadAccountAlerts` and friends in
`lib/alertsApi.ts`. Clicking an account toast opens the trade list
(`openTradeListPanel`, open-only).

Probe: `python3 -m scripts.alert_probe --account capital:demo`. The timeout
defaults to 90 s with `--account`, and the probe waits 35 s for the seed
poll before raising the tier.

## Position alerts

`kind: "position"` rows (`broker` = exec key such as `capital:demo`, `epic` of
the position, `params` `{dealId, side: "sl"|"tp", atrMult}`, `atrMult` 0.05 to
5, default 0.5) warn when the price nears a position's stop loss or take
profit. Like `account` they are NOT in `alert_kinds.KINDS`:
`core/position_alert_kind.py` validates and signs them (the signature is
dealId + side, so `atrMult` does not make a duplicate) and
`core/position_watch.py` (`POSITION_WATCH`) runs them. It polls
`get_positions` every 10 s per watched account, and subscribes the (data
broker, epic) feeds through the engine seams `AlertEngine.set_extra_feeds`
and `add_tick_listener`. The threshold is `atrMult` x ATR(14) of 15m mid
candles (`atr_series`); a long watches the bid, a short the offer (a missing
side falls back to the other). It fires on the first tick if already inside,
re-arms once the distance passes 1.5x the threshold or the level moves, and
deletes the row, with no notification, when the position closes or the level
is removed. A failed poll deletes nothing; only a successful poll that lacks
the deal does. Fired state is in memory. No ATR yet means no fire.
Any registered account is watched, `mt5-self` and paper included
(`account_not_watchable` means the account is not registered). A
trailing-stop position refuses the SL side (`trailing_stop`), TP is fine.

The Telegram fire carries a `Remove SL`/`Remove TP` button (`pr:<token>`),
which opens a separate confirm message (`pry:`/`prn:`). Tokens are 8 chars
(callback data is capped at 64 bytes), single use and valid 600 s. The Yes tap
refuses when the level changed since the fire, the position is closed or has a
trailing stop (TP removal too), the chat is not the owner's, or the user may
not deal from Telegram (`can_deal_from_telegram`: dev mode or the id in
`ADMIN_USER_IDS`).

Create and patch are admin-only; 422 codes are `position_not_found`,
`no_level`, `trailing_stop` and `account_not_watchable`; a patch cannot change
the deal or side. Frontend: the order ticket's proximity switches (market
orders only), a bell on the position row, `PositionAlertModal.tsx`, the
"Positions" group in `AlertsSidebar.tsx`, and `Settings.proximityAtrMult` (the
default multiple). Probe: `python3 -m scripts.alert_probe --position
capital:demo --deal DEAL --side sl` (60 s default timeout; it never taps
Telegram). Spec: docs/superpowers/specs/2026-11-12-sl-tp-proximity-alerts-design.md.
