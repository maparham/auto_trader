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

The hosted API (`api.chartkar.app`) runs on the Iran VPS 95.38.187.63, not
AWS (moved 2026-11-18). The frontend stays on Cloudflare Pages. Caddy on the
box terminates TLS for a DNS-only A record. A Cloudflare Tunnel was tried and
rejected: traffic from Iran to Cloudflare stalls after a few KB. Deploy with
`scripts/deploy-demo.sh` (root@95.38.187.63, service user `chartkar`, same
unit names as before).

Foreign brokers (Capital, IG, AvaTrade via MT5) must NEVER be reached
from the Iranian IP: they geo-block it and may flag the accounts. This is
enforced, not just configured. `auto-trader-demo` may only reach loopback
(`IPAddressDeny=any` in the box-only drop-in `no-direct-egress.conf`), and
`demo.env` points HTTP(S)_PROXY at Xray on 127.0.0.1:18483. Xray sends `.ir`
domains (Nobitex) out directly and everything else to the `claude-gateway`
Lightsail box, whose Xray passes only an allowlist of domains. A new
external host the backend needs goes in that allowlist; never add a
`NO_PROXY` exception. The snapshot renderer's Chromium uses the same proxy
(chartkar.app is allowlisted) and reaches `api.chartkar.app` directly via
`/etc/auto-trader/renderer.env`.

The MT5 Wine terminal stays on the AWS box (3.139.146.5). The box-only unit
`mt5-forward` forwards 127.0.0.1:22346 to it over SSH, with a key limited to
that one port. Iran filters direct SSH to that IP (since 2026-11-21), so a
`via-xray.conf` drop-in on `mt5-forward` and `aws-relay` sends it through Xray (`nc -X connect` to
127.0.0.1:18483), and the gateway allowlist has an IP rule for 3.139.146.5:22. The API on AWS is disabled by the drop-in `moved-to-iran.conf`.
Delete it to roll back.

The AWS box stays up. Besides MT5 it runs a WireGuard VPN exit outside Iran
(`wg-noniran-exit` over `wstunnel-wg`, plus `wg-intranet`/`wg-aws-iran`) with
live peers, and the `aws-vps` Cloudflare tunnel (ssh, vnc, wgeasy, grafana).
`iran-vps.rahkar.pro` is a DNS-only A record to the Iran box (since
2026-11-19); the box's `aws-relay` reverse SSH to AWS still runs as a backup
way in. The stopped API and its 2.2 GB data dir are the rollback copy.

Monitoring: the Iran box's `egress-check` timer (every 2 min) reaches Telegram
and Capital through the proxy, checks the `mt5-forward` port, and writes the result, which Caddy serves at
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
