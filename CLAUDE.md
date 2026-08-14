# CLAUDE.md

## Frontend conventions

### Tooltips

Use the shared `Tooltip` component (`frontend/src/components/Tooltip.tsx`) instead
of a native `title=` attribute or a hand-rolled tooltip. It's portaled, flat
(no shadow), collision-aware (default `top`, flips/shifts to stay on screen),
shows on hover (~100ms delay + instant grace group between nearby triggers) and
keyboard focus, with a fade + slide animation.

```tsx
<Tooltip content={string | string[] | ReactNode} title?={string} placement?={"top"|"bottom"|"left"|"right"} delay?={number}>
  {trigger}
</Tooltip>
```

For the common ⓘ info-icon pattern, use `InfoTip`
(`frontend/src/components/InfoTip.tsx`) instead — it wraps `Tooltip` for you:

```tsx
<InfoTip title={string} text={string | string[]} />
```

Note: `~126` standalone native `title=` sites elsewhere in the app have not yet
been migrated onto `Tooltip` — that's tracked follow-up work, not a pattern to
copy in new code.

## Agent UI Bridge

MCP agents can drive the running UI: connect to `http://localhost:8000/mcp`
(streamable HTTP). The endpoint only accepts requests whose Host header is
`localhost`, `127.0.0.1` or `[::1]` on any port (the MCP SDK's DNS-rebinding
protection), so it is local-only by design: any other Host gets a 421. Tools:
`ui_sessions`,
`ui_actions` (self-describing manifest), `ui_invoke`, `ui_wait`,
`ui_read_state`. Requires the app open in a browser (the bridge executes
actions in the live tab); no tab connected gives a clear error ("no UI session
connected: open the app in a browser"). The 15 registered actions today:
`backtest.*` (config.get, config.set, run, cancel, result, progress), `sweep.*`
(start, cancel, rows), dealing (`order.place`, `position.close`,
`order.cancel`), `market.select`, `tab.list`, `panel.backtest.open`. The dealing
actions require an in-browser Approve click. The
frontend bridge is on in dev builds and off in production unless
`VITE_AGENT_BRIDGE=1`. End-to-end probe:
`cd backend && python3 -m scripts.agent_bridge_probe [--url URL] [--run]
[--invoke ACTION --args JSON]`.

### How to run a backtest through the bridge (agent recipe)

1. `ui_sessions` to confirm a tab is connected (empty list: ask the user to
   open http://localhost:5173).
2. `ui_actions` for the live manifest; every action carries its JSON schema.
   Invalid args come back with the expected schema, so self-correct from the
   error rather than guessing.
3. `ui_invoke("market.select", {"epic": "US100"})` to focus (or open) the
   chart, then `ui_read_state("backtest.config.get")` and
   `ui_invoke("backtest.config.set", {"patch": {...}})` to shape the run
   (strategy, range, costs; the patch is a shallow merge).
4. `ui_invoke("backtest.run", {})` returns `{"handle": ...}` immediately.
   Poll `ui_wait(handle, timeout_s=30)`: status `running` carries progress
   (phase, pct, eta); `done` carries the full result (metrics, trades,
   analysis); `error` carries the reason (for example "no candles in the
   selected range"). The run renders live on the user's chart.
5. Sweeps: `ui_invoke("sweep.start", {"axes": [...]})` (same handle flow),
   `ui_read_state("sweep.rows")` afterwards.
6. Dealing (`order.place`, `position.close`, `order.cancel`) also returns a
   handle; it resolves only after the user clicks Approve in the browser
   (Reject or 120 s timeout gives error code REJECTED). Never assume an
   order went through without a `done` status.
7. One backtest or sweep at a time: a second `run`/`sweep.start` while one
   is in flight is rejected. `ui_read_state` only works for read-kind
   actions (NOT_READ_ACTION otherwise); use `ui_invoke` for writes.
