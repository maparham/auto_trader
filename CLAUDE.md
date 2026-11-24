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

The hosted API (`api.chartkar.app`) runs on the Lightsail box `aws-vps-2`
(3.139.146.5, us-east-2, small 2 GB + 2 GB swap, Amazon Linux 2023), since
2026-11-23. The frontend stays on Cloudflare Pages. The same box runs the MT5
Wine terminal, the WireGuard VPN exit (`wg-noniran-exit` over `wstunnel-wg`,
plus `wg-intranet`/`wg-aws-iran`), the `aws-vps` Cloudflare tunnel (ssh, vnc,
wgeasy, grafana) and `chartkar-watch`. It was made from a snapshot of the old
box (`aws-vps-2026-11-23`), so those kept their keys and settings. The old
instance `Amazon_Linux_2023-1` is stopped, as a rollback copy.

nginx terminates TLS for the DNS-only A record. `api.chartkar.app` is its own
site chosen by SNI (`conf.d/zz-chartkar-api.conf`, certbot cert, renewed by
`certbot-renew.timer`). The default 443 site is `cvlator-api.conf` (wstunnel
for WireGuard); keep the `zz-` prefix so the API site never becomes the
default. Deploy with `scripts/deploy-demo.sh` (ec2-user@3.139.146.5 with sudo:
root SSH is off by the box's sshd hardening; service user `chartkar`). The
box is outside Iran, so the API reaches brokers, Telegram and MT5
(127.0.0.1:22346) directly: no proxy, no egress drop-in. It runs with
`SNAPSHOT_DISABLED=1`, so alert photos use matplotlib.

Why it moved: from 2026-11-18 the API ran on the Iran VPS 95.38.187.63,
sending all foreign traffic through Xray to the `claude-gateway` box
(REALITY, cover site www.microsoft.com). On 2026-11-23 about 19:30 UTC Iran
began dropping the gateway's replies on 443 (TCP connects, data never comes
back), so Capital, Telegram and MT5 all failed. Foreign brokers must NEVER be
reached from the Iranian IP. The Iran box keeps the old API stopped and
disabled (`auto-trader-demo`, renderer, watchdog) with its data as a rollback
copy. The ArvanCloud box also gets no TLS reply from AWS IPs, but Iranian
home connections reach the API fine.

Monitoring: `egress-check` (every 2 min) reaches Telegram and Capital
directly, checks the MT5 port, and writes the result, which nginx serves at
`https://api.chartkar.app/egress-status`. `chartkar-watch` (every 5 min)
reads `/health` and that status and messages the admin through @ChartkarBot
after two failed runs, every 6 h while failing, and on recovery. Config:
`/etc/chartkar-watch.env` (CHAT_ID, TELEGRAM_BOT_TOKEN). It now runs on the
same box as the API, so it does not catch the whole box going down.

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
