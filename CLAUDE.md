# CLAUDE.md

## Frontend conventions

### Tooltips

Use the shared `Tooltip` component (`frontend/src/components/Tooltip.tsx`) instead
of a native `title=` attribute or a hand-rolled tooltip. It's portaled, flat
(no shadow), collision-aware (default `top`, flips/shifts to stay on screen),
shows on hover (~100ms delay + instant grace group between nearby triggers) and
keyboard focus, with a fade + slide animation.

```tsx
<Tooltip content={string | string[] | ReactNode} title?={string} placement?={"top"|"bottom"|"left"|"right"} delay?={number} asChild?>
  {trigger}
</Tooltip>
```

For the common ⓘ info-icon pattern, use `InfoTip`
(`frontend/src/components/InfoTip.tsx`) instead — it wraps `Tooltip` for you:

```tsx
<InfoTip title={string} text={string | string[]} />
```

Where a wrapper span would break layout (a `tr`, an `li`, an absolutely
positioned button, a flex child that code finds with `:scope > .x`), pass
`asChild`. The handlers and the anchor ref then go on the child itself, and
the child's own handlers and ref still run. Keep the wrapper for a disabled
button, since it may not fire mouse events. When triggers are nested (a row
hint around buttons that have their own tooltips), only the innermost open
tooltip shows. The app has no native `title=` tooltips left; don't add new ones.

### Side panels

Only one right-docked side panel is open at a time (patterns, trade list,
alerts, order ticket, backtest config, live trading, screener, assistant).
Each one registers a closer with `frontend/src/lib/sidePanels.ts` and calls
`claimSidePanel(id)` on the way open, so a new panel closes whichever was open.
Use `toggleSidePanel(id)` from `lib/signals.ts` for the six signal-backed panels
rather than flipping their signals directly. Claims are inert until App calls
`endSidePanelRestore()`, because the backtest and live panels persist their
open-state and a boot-time cross-close would overwrite the saved flag; when
both are saved open, live wins and backtest just starts closed.

## Hosting

The hosted API (`api.chartkar.app`) runs on the Lightsail box `chartkar-api`
(3.129.38.165, us-east-2, micro 1 GB + 2 GB swap, Debian 13), since
2026-11-23. The frontend stays on Cloudflare Pages. Caddy on the box
terminates TLS for a DNS-only A record. Deploy with `scripts/deploy-demo.sh`
(root@3.129.38.165, service user `chartkar`, same unit names as before). The
box is outside Iran, so it reaches brokers and Telegram directly: no proxy,
no egress drop-in. It runs with `SNAPSHOT_DISABLED=1` (1 GB is too small for
Chromium next to the API), so alert photos use matplotlib.

Why it moved: from 2026-11-18 the API ran on the Iran VPS 95.38.187.63,
sending all foreign traffic through Xray to the `claude-gateway` box
(REALITY, cover site www.microsoft.com). On 2026-11-23 about 19:30 UTC Iran
began dropping the gateway's replies on 443 (TCP connects, data never comes
back), so Capital, Telegram and MT5 all failed. Foreign brokers must NEVER be
reached from the Iranian IP. The Iran box keeps the old API stopped and
disabled (`auto-trader-demo`, renderer, watchdog) with its data as the
rollback copy; its `no-direct-egress.conf` drop-in still blocks direct
egress there.

The MT5 Wine terminal stays on the AWS box (3.139.146.5). The unit
`mt5-forward` on `chartkar-api` forwards 127.0.0.1:22346 to it over plain SSH,
with a key limited to that one port. The API on AWS is disabled by the
drop-in `moved-to-iran.conf`.

The AWS box stays up. Besides MT5 it runs a WireGuard VPN exit outside Iran
(`wg-noniran-exit` over `wstunnel-wg`, plus `wg-intranet`/`wg-aws-iran`) with
live peers, and the `aws-vps` Cloudflare tunnel (ssh, vnc, wgeasy, grafana).
`iran-vps.rahkar.pro` is a DNS-only A record to the Iran box (since
2026-11-19); the box's `aws-relay` reverse SSH to AWS still runs as a backup
way in. The stopped API and its 2.2 GB data dir are the rollback copy.

Monitoring: the `chartkar-api` box's `egress-check` timer (every 2 min) reaches Telegram
and Capital directly, checks the `mt5-forward` port, and writes the result, which Caddy serves at
`https://api.chartkar.app/egress-status`. The AWS box's `chartkar-watch` timer
(every 5 min, outside Iran so Telegram works when the gateway does not) reads
`/health` and that status and messages the admin through @ChartkarBot after
two failed runs, every 6 h while failing, and on recovery. Config:
`/etc/chartkar-watch.env` (CHAT_ID, TELEGRAM_BOT_TOKEN). To
retire the box, MT5 and the VPN exit need a non-Iran host with about 1 GB of
RAM (the claude-gateway box is too small).

## Feature notes

Detailed notes per feature live in `docs/features/`. Read the matching file
before working on that feature; it is not loaded automatically.

- `agent-ui-bridge.md`: MCP bridge at localhost:8000/mcp, ui_*/ta_*/wf_* tools,
  recipes for driving backtests and chart reviews. Read before using the
  `chartkar` MCP tools.
- `alerts.md`: backend alert engine, alert kinds, trendline alerts, Telegram
  snapshots, fired and legend bells, account and position alerts.
- `screener.md`: screener panel, chart indicators in screens, picked lines.
- `ai-assistant.md`: in-app assistant loop, tool allowlist, undo/redo/edit.
- `equal-width-days.md`: "Time gaps" mode and the klinecharts slot patch.
- `symbol-search-categories.md`: broker-declared category chips.
- `account-history.md`: Capital history tab and chart trade markers.
- `all-accounts-tab.md`: dock tab with every dealing account.
- `admin-console.md`: /admin, impersonation and its cross-tab seam.
- `public-demo.md`: signed-out demo, publishing, `?demo=preview`.
