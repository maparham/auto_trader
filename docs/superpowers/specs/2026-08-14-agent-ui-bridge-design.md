# Agent UI Bridge — Design

**Date:** 2026-08-14
**Status:** Approved (design); implementation plan to follow

## Goal

Let AI agents (Claude Code and other MCP clients) see everything the user
sees in the running auto_trader UI and drive it — configure and run
backtests, sweeps, and walk-forwards, read results, manage tabs and
indicators — without screen-scraping a browser through Chrome automation.

The agent operates on the user's **live browser session**: every action an
agent takes executes through the real UI handlers, so the user can watch it
happen in their open tab, and all results land in the normal panels,
persisted state, and archives.

## Non-goals

- Headless operation. If no app tab is connected, agent calls fail with a
  clear error ("no UI session connected — open the app"). No headless
  Chromium fallback, no command queueing.
- A parallel server-side backtest facade. The browser-side assembly code
  (window resolution, candle fetch, ATR series, cost profiles in
  `BacktestButton.tsx` + `lib/`) stays where it is; the bridge reuses it.
- Unattended live trading. Dealing actions require an in-browser
  confirmation click (see Safety).

## Architecture

```
Agent (Claude Code / any MCP client)
   │  MCP over streamable HTTP
   ▼
Backend relay — FastMCP mounted on the existing FastAPI app at /mcp
   │  WebSocket /ws/agent-ui (new)
   ▼
Frontend bridge — WS client + action registry, running in the live tab
```

Three components:

### 1. Frontend action registry + bridge (`frontend/src/agent/`)

- `registry.ts` — `registerAction({ name, description, paramsSchema,
  kind: "read" | "write" | "confirm", handler })`. `paramsSchema` is a JSON
  Schema fragment used both for client-side validation and for the manifest
  served to agents. Modules register actions next to the real handlers
  (e.g. `BacktestButton.tsx` registers `backtest.run`, reusing its exact
  request-assembly code; the market picker registers `market.select`).
- `bridge.ts` — WebSocket client to `/ws/agent-ui`. Connects on app load
  when the bridge is enabled (see Safety). Handles frames:
  - inbound `{ id, action, args }` → validate args against the schema →
    run handler → reply `{ id, ok: true, result }` or
    `{ id, ok: false, error, expectedSchema? }`.
  - long-running actions reply immediately with
    `{ id, ok: true, handle }` and later push
    `{ handle, event: "progress" | "done" | "error", payload }` frames.
- `confirm.tsx` — modal shown for `kind: "confirm"` actions:
  "Agent requests: <description + args summary>" with Approve / Reject.
  The invoke resolves only after the click; no click within the timeout
  (default 120 s) resolves as rejected.

### 2. Backend relay (`backend/auto_trader/api/routers/agent.py`)

- `WS /ws/agent-ui` — frontend tabs connect here. Each connection gets a
  session id; the relay tracks last-activity per session.
- Relay logic: forward an MCP tool call to the target tab, await the reply
  frame with a timeout, surface errors verbatim. No tab connected → the
  clear error above. Multiple tabs → most-recently-active by default;
  explicit `session` parameter overrides.
- Handle store: long-running invocations keep a per-handle record
  (latest progress, terminal result) so `ui_wait` can be called repeatedly
  and after completion. Records are in-memory with a TTL, same pattern as
  `sweep_jobs.py`.

### 3. MCP server (mounted in the backend)

Official Python MCP SDK (FastMCP), streamable HTTP mounted at `/mcp` on the
existing app — no extra process to run. Tools:

| Tool | Purpose |
| --- | --- |
| `ui_sessions()` | List connected tabs (session id, URL/tab title, last activity). |
| `ui_actions()` | The manifest: every registered action with name, description, kind, and JSON schema. Agents self-discover the surface; the manifest is fetched live from the connected tab so it always matches the running build. |
| `ui_invoke(action, args, session?)` | Execute an action. Fast actions return the result directly; long-running ones (`backtest.run`, `sweep.start`, `walkforward.start`) return `{ handle }` immediately. |
| `ui_wait(handle, timeoutSec?)` | Block until the handle completes or the timeout elapses; returns latest progress or the terminal result. |
| `ui_read_state(key, session?)` | Shorthand for invoking `kind: "read"` actions (result, progress, config, positions, …). |

## Initial action surface

First-class coverage of the backtest loop, then full-UI breadth via the
same registry. Initial set:

- **Setup**: `market.select` (epic, resolution), `window.set` (from/to or
  preset), `strategy.set` (coded filename + params, or expr rules + combine),
  `risk.set`, `costs.set`, `mask.set`, `indicator.add` / `indicator.remove` /
  `indicator.list`.
- **Run**: `backtest.run`, `backtest.cancel`, `sweep.start` / `sweep.cancel` /
  `sweep.archive`, `walkforward.start` / `walkforward.cancel`,
  `holdout.evaluate`.
- **Read** (`kind: "read"`): `backtest.result` (metrics, trades, analysis —
  the same data BacktestPanel renders), `backtest.progress`, `sweep.rows`
  (including client-only derived analytics: plateau scores, robustness
  labels, holdout evaluation), `config.get` (the full current backtest
  config), `runs.list`, `watchlist.get`, `positions.get`, `orders.get`.
- **UI chrome**: `tab.open` / `tab.close` / `tab.list`, `layout.set`,
  `panel.focus`.
- **Dealing (`kind: "confirm"`)**: `order.place`, `order.cancel`,
  `position.close`, `position.edit`, `mt5.deploy.enable` /
  `mt5.deploy.disable`.

Registry growth rule: any new UI capability that should be agent-reachable
is exposed by registering an action beside its handler — no relay or MCP
changes needed.

## Safety

- **Enablement**: the frontend bridge only connects when
  `VITE_AGENT_BRIDGE=1` (on by default for local dev builds, **off** in the
  public rahkar.pro demo build). Backend: `/mcp` and `/ws/agent-ui` sit
  behind the existing `guard.py` token gate when `REQUIRE_API_TOKEN=1`.
- **Dealing confirm gate**: `kind: "confirm"` actions never execute without
  an explicit Approve click in the browser. Timeout defaults to 120 s and
  resolves as rejected. The confirm modal shows the action name, a
  human-readable args summary, and which agent session asked.
- **No dealing bypass**: the confirm gate lives in the frontend bridge, but
  dealing endpoints on the backend remain additionally guardable by the
  existing `COMPUTE_ONLY=1` flag, unchanged.

## Error handling

- Schema-validation failures return the expected JSON schema alongside the
  error so agents can self-correct.
- Every invoke carries an id; relay-level timeouts (default 30 s for fast
  actions) return a timeout error naming the action.
- `backtest.cancel` wires to the existing `progressId` cancel path
  (HTTP 499 semantics preserved in the handle's terminal event).
- Tab disconnect mid-invocation → in-flight handles resolve as
  `error: "UI session disconnected"`.

## Testing

- **Unit (frontend)**: registry validation — schema rejection, unknown
  action, confirm-kind flagging; bridge frame handling with a mock WS.
- **Backend**: relay tests modeled on `test_api_compute_proxy.py` — a fake
  WS tab fixture; no-tab error, multi-tab routing, timeout, handle
  progress/wait, token gating (per `test_api_guard.py`).
- **E2E (Playwright)**: one end-to-end test — real browser tab with the
  bridge enabled, scripted MCP client selects a market, runs a small
  backtest, waits on the handle, reads `backtest.result`, and exercises one
  confirm-gated action (reject path).

## Alternatives considered

- **Headless agent API (server-side run facade)** — rejected by product
  choice: the point is agents operating the same live session the user
  watches. Revisit if unattended runs become a need.
- **Raw signal read/write** — rejected: unvalidated browser-shaped JSON,
  and the important logic (request assembly) lives in handlers, not
  signals, so triggers would be needed anyway.
- **Custom Chrome extension** — rejected: extensions are for pages you
  can't modify. We own this frontend, so the bridge compiles into the app
  bundle — no install/permissions, no content-script hops, plain-Playwright
  testable. The one case an extension would win: driving the deployed demo
  site without shipping bridge code in the public build. Not a current need.
- **Generic CDP/accessibility-tree driving** (claude-in-chrome style) —
  rejected: that is the status quo this project replaces.
