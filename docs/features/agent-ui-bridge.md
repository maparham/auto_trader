# Agent UI Bridge

MCP agents can drive the running UI: connect to `http://localhost:8000/mcp`
(streamable HTTP). The endpoint only accepts requests whose Host header is
`localhost`, `127.0.0.1` or `[::1]` on any port (the MCP SDK's DNS-rebinding
protection), so it is local-only by design: any other Host gets a 421.

The generic half of this lives in github.com/maparham/agent-ui-bridge: the
npm package `agent-ui-bridge` (action registry, relay client, confirm gate,
confirm dialog, tab.title.set, the Tab Bridge client) and the python package
of the same name (`agent_ui_bridge`: BridgeHub, serve_tab, the ten ui_*
tools, the probe). Chartkar depends on both as git dependencies, in
`frontend/package.json` and `backend/pyproject.toml`, and keeps thin shims at
`frontend/src/agent/{registry,index}.ts`, `frontend/src/agent/AgentConfirmHost.tsx`,
`frontend/src/agent/actions/tab.ts`, `frontend/src/lib/tabBridge.ts` and
`backend/auto_trader/api/agent_bridge.py`, so the app's import paths did not
move. Chartkar's OWN actions (`chart.*`, `backtest.*`, `sweep.*`, dealing,
drawings, indicators, `market.select`, the tab helpers) and the direct
`ta_*`/`wf_*`/`runs_*` tools stay here. Editing the bridge itself means
editing that repo; `npm link` and
`uv pip install -e ../agent-ui-bridge/python` for local iteration.

UI tools (need a connected browser tab): `ui_sessions`, `ui_actions`
(self-describing manifest), `ui_set_title`, `ui_invoke`, `ui_wait`, `ui_read_state`,
`ui_screenshot` (returns the focused chart as an image plus a text line
naming epic/resolution/cell; pairs with `chart.state` for the numbers behind
the pixels). No tab connected gives a clear error ("no UI session connected:
open the app in a browser"). Every driven tab must be named first:
`ui_invoke`, `ui_read_state` and `ui_screenshot` refuse with UNTITLED_TAB
until `ui_set_title("US100 4H backtest")` has run on that session. The
title survives a reload and a backend restart (the tab keeps it in
sessionStorage and announces it on reconnect); only a fresh tab needs naming. The tab's `tab.title.set` action stamps a
✻ in front of the title so the owner can tell agent tabs from their own.
The 29 registered actions today, by group:
`backtest.*` (config.get, config.set, run, cancel, result, progress),
`sweep.*` (start, cancel, rows), dealing (`order.place`, `position.close`,
`order.cancel`), `drawing.*` (list, add, remove, clear), `chart.*` (state,
screenshot, timeframe.set, range.set), `indicator.*` (list, add, set,
remove), and app shell (`market.select`, `tab.list`, `tab.focus`,
`tab.title.set`, `panel.backtest.open`). The dealing actions require an in-browser Approve
click. The frontend bridge is on in dev builds and off in production unless
`VITE_AGENT_BRIDGE=1`.

Browser tab control (macOS local dev only; AppleScript drives Chrome from
the backend): `ui_open_tab` opens the app (or focuses an existing tab),
`ui_focus_tab` raises the Chartkar tab, `ui_close_tab` closes it (refuses
when several are open). Recovery chain for a hidden tab: TAB_HIDDEN from
`ui_screenshot`, then `ui_focus_tab`, then retry. First use needs the macOS
automation permission for whatever app hosts the backend process; a pending
permission dialog surfaces as a 15 s osascript timeout with a hint. Hosted
mode refuses these tools.

Tab Bridge extension (`extension/` in the agent-ui-bridge repo, generic,
unpacked install per that repo's `extension/README.md`): a page can
screenshot or focus its own tab through `chrome.debugger` / `chrome.tabs`,
which works while the tab is backgrounded. The `chart.screenshot` action
descriptions and its TAB_HIDDEN message name that repo; `ui_focus_tab`'s
own text still says "extension/README.md", meaning the one in that repo.
`chart.screenshot` uses it when its `hello` probe answers
(result carries `via: "extension"`), clipped to the chart container, and
falls back to the canvas composite otherwise (`via: "canvas"`, TAB_HIDDEN
when hidden). `ui_focus_tab` tries the in-page `tab.focus` action first, so
it works on any OS with the extension, and only then AppleScript. The
extension is not Chartkar-specific: it answers a namespaced `postMessage`
protocol on any http(s) origin and never targets a tab other than the
requester's.

Direct tools (no tab needed; call the app in-process): `ta_candles`,
`ta_indicator_series`, `ta_pattern_search`, `ta_pattern_scan`,
`ta_pattern_families`, `wf_run`, `wf_status`, `wf_cancel`, `wf_fold`,
`runs_list`, `run_get`. These hit the FastAPI app directly over an ASGI
transport, attaching the API token when one is configured, so they work
without a browser at all.

End-to-end probe: `cd backend && python3 -m agent_ui_bridge.probe
[--url URL] [--read-state KEY] [--invoke ACTION --args JSON]
[--screenshot [PATH]]`. `--screenshot` (default path `screenshot.png`) calls
`ui_screenshot`, decodes the image block, and writes it to PATH. The old
`--run` shorthand is gone; use `--invoke backtest.run`.

## How to run a backtest through the bridge (agent recipe)

1. `ui_sessions` to confirm a tab is connected (empty list: `ui_open_tab`
   opens one on macOS local dev, then poll `ui_sessions` until the bridge
   connects; elsewhere ask the user to open http://localhost:5173).
2. `ui_set_title("US100 4H backtest")`: name the tab for what you are about
   to do. Nothing else works on the session until this has run.
3. `ui_actions` for the live manifest; every action carries its JSON schema.
   Invalid args come back with the expected schema, so self-correct from the
   error rather than guessing.
4. `ui_invoke("market.select", {"epic": "US100"})` to focus (or open) the
   chart, then `ui_read_state("backtest.config.get")` and
   `ui_invoke("backtest.config.set", {"patch": {...}})` to shape the run
   (strategy, range, costs; the patch is a shallow merge).
5. `ui_invoke("backtest.run", {})` returns `{"handle": ...}` immediately.
   Poll `ui_wait(handle, timeout_s=30)`: status `running` carries progress
   (phase, pct, eta); `done` carries the full result (metrics, trades,
   analysis); `error` carries the reason (for example "no candles in the
   selected range"). The run renders live on the user's chart.
6. Sweeps: `ui_invoke("sweep.start", {"axes": [...]})` (same handle flow),
   `ui_read_state("sweep.rows")` afterwards.
7. Dealing (`order.place`, `position.close`, `order.cancel`) also returns a
   handle; it resolves only after the user clicks Approve in the browser
   (Reject or 120 s timeout gives error code REJECTED). Never assume an
   order went through without a `done` status.
8. One backtest or sweep at a time: a second `run`/`sweep.start` while one
   is in flight is rejected. `ui_read_state` only works for read-kind
   actions (NOT_READ_ACTION otherwise); use `ui_invoke` for writes.

## How to analyse a chart visually (agent recipe)

1. `ui_set_title("US100 4H review")`, then
   `ui_invoke("market.select", {"epic": "US100"})` to focus the chart, then
   `ui_invoke("chart.timeframe.set", {"resolution": "HOUR_4"})` for the
   timeframe under review.
2. `ui_invoke("indicator.add", {"type": "RSI", "calcParams": [14]})` to add
   the indicator pane needed for the read.
3. `ui_read_state("chart.state")` for the numbers (candles, indicator
   values, visible range) and `ui_screenshot` for the picture; read both
   together rather than guessing the layout from one alone. `ui_screenshot`
   works with the tab backgrounded when the Tab Bridge extension is
   installed; without it, it fails with TAB_HIDDEN, so call `ui_focus_tab`
   and retry.
4. Iterate: adjust the timeframe, swap or remove indicators
   (`indicator.set`, `indicator.remove`), re-screenshot, until the view
   answers the question.
