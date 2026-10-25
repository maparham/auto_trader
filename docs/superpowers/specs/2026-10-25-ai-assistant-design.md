# AI assistant: plain-English chart configuration

Date: 2026-10-25. Revised the same day after an independent review.

## Problem

Chartkar's tools are deep. Trendlines alone has 33 numeric slots plus render
flags; the rule language has its own grammar; drawings and backtest config each
have their own shapes. A beginner who wants "rising trendlines on the daily and
an RSI" has to learn all of that first. The assistant lets them say it in plain
English, answers a clarifying question or two by picking from options, and then
applies the result to the focused chart.

## Decisions already taken

- Deployment: local dev first, hosted-ready. The key is read from
  `~/.config/claude-gateway/client.json` (field `key`) with an environment
  override for a server. The feature is hidden when no key is configured.
  Hosted gating beyond admin-only is a later step.
- Apply model: the assistant acts directly on the chart as it goes. Every
  assistant turn lists what it changed and offers one "Undo this turn" button.
- Architecture (approach A): the browser runs the tool loop and owns all the
  knowledge (action registry, indicator metadata, rule catalog). The backend
  is a key-holding proxy with the retry policy. Rejected: running the loop in
  the backend over the BridgeHub (needs the agent bridge, WebSocket routing,
  and the knowledge would still come from the frontend), and a backend-only
  knowledge base (the backend has no UI labels, drawings or chart state).

## Upstream API contract

Anthropic-compatible gateway, as specified by the owner:

- `POST https://claude.rahkar.pro/v1/messages`
- Headers: `x-api-key: <key>`, `content-type: application/json`,
  `anthropic-version: 2023-06-01`
- Model: `claude-opus-5-5`
- Never `/v1/messages/batches`.
- 429: honor `retry-after`, retry once. 401, 403, 503: stop and report the
  response body.

## Backend

### Settings (`backend/auto_trader/config.py`)

`AssistantSettings(BaseSettings)` with `env_prefix="ASSISTANT_"`, following
`TelegramSettings`:

| Field | Env | Default |
|---|---|---|
| `api_key` | `ASSISTANT_API_KEY` | `key` from `~/.config/claude-gateway/client.json` |
| `base_url` | `ASSISTANT_BASE_URL` | `url` from that file, else `https://claude.rahkar.pro` |
| `key_file` | `ASSISTANT_KEY_FILE` | `~/.config/claude-gateway/client.json` |
| `disabled` | `ASSISTANT_DISABLED` | false (any non-empty value disables) |
| `model` | `ASSISTANT_MODEL` | `claude-opus-5-5` |

The key file is read once at startup. A missing or unreadable file is not an
error: the assistant is simply not configured. `configured` is
`not disabled and api_key is set`.

### Client (`backend/auto_trader/core/assistant_client.py`)

A singleton `AssistantClient` modelled on `core/telegram_notify.py`:
`configure(settings)` builds an `httpx.AsyncClient(base_url, timeout=120)`
only when configured; `enabled` property; `_scrub(text)` replaces the key with
`***` in any error text before it leaves the module.

`async def create_message(req: AssistantRequest) -> UpstreamResult`:

1. Builds the upstream body explicitly and only from these fields:
   `{"model": settings.model, "max_tokens": min(req.max_tokens or 4096, 4096),
   "system": req.system, "messages": req.messages, "tools": req.tools}`.
   Nothing the browser sent outside those fields reaches upstream, so
   `stream`, `betas`, `metadata`, `tool_choice` and anything unknown are
   dropped by construction.
2. POSTs `/v1/messages` with the three headers.
3. On 429: reads `retry-after` (seconds; an HTTP date is converted; missing or
   unparsable means 2 s), sleeps `min(value, 30)`, retries exactly once. A
   second 429 is returned as an error result.
4. On 401, 403, 503: no retry, returned as an error result carrying the status
   and the raw body text.
5. On any other non-2xx: no retry, same error shape.
6. On 2xx: returns the parsed JSON unchanged.

`UpstreamResult` is `{"ok": True, "message": dict}` or
`{"ok": False, "status": int, "body": str}`. The key is scrubbed from `body`
and from any exception message.

### Router (`backend/auto_trader/api/routers/assistant.py`)

Registered in the `app.py` router tuple. Both routes use `deps.current_user`
and refuse the demo principal (`is_demo_request`) with 403
`assistant unavailable in demo`. In hosted mode (`CLERK_JWKS_URL` set) both
routes additionally require `deps.request_is_admin(request)`; local dev is
always admin, so nothing changes there.

- `GET /api/assistant/status` returns `{"configured": bool, "model": str}`.
  `model` is omitted when not configured.
- `POST /api/assistant/messages`:
  - The raw body is read with `request.stream()` and a running length check;
    past 256 KB the handler stops reading and answers 413. Content-Length is
    not trusted.
  - Pydantic `AssistantRequest`: `system: list[dict] | str`,
    `messages: list[dict]` (1 to 48), `tools: list[dict]` (at most 32),
    `max_tokens: int | None`. Every tool must be a client tool: a `type` key
    on a tool entry (server tools such as web search or code execution would
    bill against the key) is a 422 `client tools only`.
  - 503 `assistant not configured` when `configured` is false.
  - Concurrency: no per-user lock (the browser loop is sequential by
    construction). A process-wide `asyncio.Semaphore(4)` bounds upstream
    calls; when it is full the route answers 429 `assistant busy` at once
    rather than queueing.
  - Disconnect: the upstream call runs as a task; the handler polls
    `request.is_disconnected()` every 0.5 s and cancels the task when the
    browser has gone (Stop in the panel aborts the fetch). Nothing is
    returned in that case.
  - On `ok` returns the upstream message JSON with status 200.
  - On an upstream error returns 502 with
    `{"detail": {"upstream_status": int, "body": str}}`. The panel shows
    `body` verbatim for 401/403/503, as the contract requires.

No conversation state is stored server-side. Nothing is logged beyond the
usual request line; message bodies never reach the log.

## Frontend

All new code lives in `frontend/src/assistant/` except the panel component,
which sits beside the other panels as `frontend/src/AssistantPanel.tsx`.

### Tool surface (`assistant/tools.ts`)

`buildTools(): AnthropicTool[]` maps `listActions()` through an allowlist and
appends the assistant-only tools.

Allowed registry actions: `chart.state`, `chart.timeframe.set`,
`chart.range.set`, `market.select`, `tab.list`, `indicator.list`,
`indicator.add`, `indicator.set`, `indicator.remove`, `drawing.list`,
`drawing.add`, `drawing.remove`, `backtest.config.get`, `backtest.config.set`,
`backtest.run`, `backtest.result`.

Excluded on purpose: `order.*`, `position.*` (dealing), `sweep.*`,
`drawing.clear` (destructive, no per-item undo), `chart.screenshot` (no
images in v1), `tab.focus`, `tab.title.set`, `panel.backtest.open`,
`backtest.cancel`, `backtest.progress`. The allowlist is checked again at
execution time, so a tool name the model invents is refused with an
`is_error` tool result rather than executed.

Naming: an explicit two-way table `TOOL_NAMES: {[toolName]: actionName}`
(`indicator_add` ↔ `indicator.add`, and so on), since the API restricts tool
names to `[a-zA-Z0-9_-]{1,64}` and a blind `_`→`.` replace would mangle
`ask_user`. Unknown tool names are refused.

Conversion: the registry's flat `ParamSchema` becomes the tool's
`input_schema` (`type: object`, `properties`, `required`,
`additionalProperties: false`; `validateArgs` already rejects unknown keys,
so the two agree). Descriptions come from the action, except where
`DESCRIPTION_OVERRIDES` replaces text written for the MCP bridge:
`backtest_run` ("runs the backtest and returns a summary of metrics; it can
take a while"), `chart_state` (drop the screenshot reference), and any other
action whose description names `ui_wait`, a handle or a screenshot.
`indicator_add.type` gets an `enum` of the valid types (`VALID_TYPES` is
exported from `agent/actions/indicators.ts` for this).

Assistant-only tools, executed locally without touching the registry:

| Tool | Input | Result |
|---|---|---|
| `ask_user` | `question: string`, `options: [{label, description?}]` (2 to 5) | Ends the turn. The chosen label, or the free text the user typed, is returned as this tool's `tool_result` when the loop resumes. |
| `describe_indicator` | `type: string` | `indicatorInfo(type)`; the inputs from `resolveInputs(type, undefined)` serialized as `[{key, label, source, index or field, default, min, max, step, options, tip, group}]` where `default` is `presets.base[index]` when the type has presets, else the type's template `calcParams[index]` (`BASE_TEMPLATES`), else absent; `presetsFor(type)` as `[{name, values}]`; `directionFor(type)` as `[{name, values}]`; and `startsOn: "Balanced"` for Trendlines (a fresh pane seeds `TRENDLINES_SEED` unless the user saved a type default). Unknown type: `is_error`. |
| `indicator_configure` | `id: string`, `preset?: string`, `direction?: string`, `params?: {[key]: number}` | Merges onto the instance's LIVE calcParams: the preset first (`withPresetStep`), then the direction slots, then each `params` entry by the `key` returned by `describe_indicator`, and calls `indicator.set` with the full array once. This is how "rising only" or "pivot length 8" is done without rewriting 33 slots. Unknown key, preset or direction: `is_error` naming the valid ones. |
| `describe_rules` | none | The `expr/catalog.ts` groups (indicators, wrappers, funcs, crosses, cross ops, logic, candle fields with details, timeframes, conditions, pattern names) plus the focused chart's expression instances: `exprInstancesFor(live)` joined with the live indicator list for `type`, as `[{id, type, outputs, timeframe, detail}]`. |
| `validate_rule` | `expr: string`, `isExit?: boolean` | `analyze(expr, {isExit, instances, lines})` reduced to `{ok: errors.length === 0, errors: [{message, from, to}]}` plus `warmupBars` from `warmupOf(expr, baseSeconds, instances)`. |

Result budget: every tool result is capped at 8 KB of JSON. Two tools get
summarisers instead of truncation: `backtest_run` and `backtest_result`
return `{metrics, tradeCount, firstTradeAt, lastTradeAt, analysisKeys}` (the
full result stays on the chart, where the user sees it); `chart_state`
defaults `bars` to 60 and caps it at 200. Anything else over the cap is cut
at 8 KB with a trailing `…[truncated]` marker.

### System prompt (`assistant/prompt.ts`)

A fixed string (no timestamps, no per-chart data) so the `system` + `tools`
prefix caches. Contents, in order:

1. Role: Chartkar's in-app assistant; the user is a trader who may be new to
   the tools; be brief and concrete.
2. Flow: read before writing (`indicator_list`, `chart_state`,
   `backtest_config_get`) when the request depends on what is already there;
   act; end with one or two lines saying what changed and why it matches the
   request.
3. Asking: use `ask_user` only when two readings would produce materially
   different charts (direction, timeframe, which indicator, how many lines).
   One question per turn, 2 to 5 options, each in plain words. Never ask
   about a parameter the user would not recognise; pick a sensible default
   and mention it.
4. Indicators: call `describe_indicator` before configuring a type you have
   not seen described in this conversation. Use `indicator_configure` for
   presets, directions and named parameters; use `indicator_set` only for
   render flags (`extendData`) and the Trendlines timeframe pin. A fresh
   Trendlines pane starts on Balanced.
5. Rules: call `describe_rules` once before writing rules, `validate_rule`
   on every expression before `backtest_config_set`; fix and re-validate on
   errors. `backtest_config_set` shallow-merges at the top level, so send a
   whole rule group.
6. Drawings: points are `{timestamp (ms), value}`; use `chart_state` for
   candle times and prices; colors are `#rrggbb`.
7. Hard rules: never place, close or cancel orders; never remove something
   the user did not ask to remove; do not invent indicator types, parameters
   or rule functions; if the request cannot be done with the available tools,
   say so.

The volatile context (focused epic, resolution, open indicator ids and types,
chart tab count) is prepended to the user's text in each new user turn as a
short `[context]` line, after the cached prefix.

Cache breakpoints (`cache_control: {type: "ephemeral"}`): the last `system`
block, the last tool definition, and the last content block of the last
message in every request, so each round reads the growing history from
cache instead of re-billing it.

### Session (`assistant/session.ts`)

A plain TS module with a Signal-backed store (same pattern as
`lib/signals.ts`), one session per browser tab, mirrored to
`sessionStorage` under `${PREFIX}.assistant.session` so a reload keeps the
transcript. "New chat" clears it.

State:

```ts
type Turn =
  | { role: "user"; text: string; pickedFrom?: string }        // chip pick or typed
  | { role: "assistant"; text: string; changes: Change[]; undone: boolean;
      ask?: { question: string; options: {label; description?}[] };
      error?: { kind: "upstream" | "network" | "refusal" | "max_tokens" | "rounds" | "stopped";
                status?: number; body?: string } };
type Change = { label: string; cellId: string; undoable: boolean; undo?: () => Promise<void> };
```

Persisted alongside the turns: `messages: MessageParam[]` (the API
transcript) and `pending: {toolUseIds: string[], heldResults: ToolResultBlock[]}`
(the unanswered `tool_use` blocks of an interrupted round and the results
already produced in it). Undo closures live in memory only; after a reload
the Undo buttons for earlier turns are disabled with a tooltip ("undo is
lost on reload").

**Transcript invariant.** Before any new user content is appended (a sent
message, an ask answer, an undo note, a retry), every `tool_use` in the last
assistant message that has no result yet gets a synthesized
`{type: "tool_result", is_error: true, content: "<reason>"}`, where reason
is "not run: the assistant stopped to ask the user", "stopped by the user"
or "turn ended before this ran". Those go in the SAME user message as the new
content, tool results first. The transcript therefore never carries a
dangling `tool_use`, whatever interrupted the round.

**Transcript budget.** Before each POST, while `messages.length > 40` or the
serialized body exceeds 200 KB, drop the oldest complete exchange: the
oldest user message and everything up to (not including) the next
user message that carries no `tool_result` blocks, so tool pairs are never
split. The display turns are untouched; a muted "earlier messages were
trimmed from the model's view" line marks the point in the transcript.

`send(text)`:

1. Build the user message: synthesized results for `pending.toolUseIds`
   (if any), then `pending.heldResults`, then, if an ask is pending, the
   `ask_user` result with `content: text`; otherwise a text block
   `[context] ...\n\n<text>`. Clear `pending`.
2. Loop, at most 12 rounds:
   - Trim the transcript, place the three cache breakpoints, POST
     `/api/assistant/messages` with `{system, messages, tools}`.
   - Append `response.content` as the assistant message (whole array, so
     any thinking blocks round-trip).
   - `stop_reason === "tool_use"`: run every `tool_use` block in order,
     sequentially (write actions must not interleave), collecting one
     `tool_result` per block (`is_error: true` with the `ActionError`
     message on failure). If a block is `ask_user`: stop executing, record
     the remaining ids as `pending.toolUseIds`, the produced results as
     `pending.heldResults`, render the chips, return. Otherwise append the
     results as one user message and continue.
   - `end_turn`: done.
   - `max_tokens`, `refusal`: done with the matching error badge; any
     `tool_use` blocks in that message become `pending.toolUseIds`.
   - 12 rounds reached after a `tool_use` response: the results of that
     round are appended normally, then the loop ends with error `rounds`.
   - Stop (abort): the in-flight action is aborted, the ids not yet answered
     become `pending.toolUseIds`, error `stopped`.
3. Any text blocks in the final assistant message become the turn's `text`.
   Text blocks from intermediate rounds are concatenated above it so
   progress notes are not lost.

Execution of registry tools goes through `invokeAction(name, args, ctx)`
with `ctx = {progress, signal}`, the signal from an `AbortController` the
panel's Stop button fires. After `market.select` and `chart.timeframe.set`
the session waits (polling every 50 ms, at most 2 s) until
`focusedChart()` reports the requested epic or resolution before running the
next tool, because the focused-chart provider is re-set on React render.

Before each write action the session captures what undo needs, together
with the focused `cellId`:

| Action | Captured before | Undo |
|---|---|---|
| `indicator.add` | nothing | `indicator.remove {id}` with the returned id |
| `indicator.set` / `indicator_configure` | the instance's full `calcParams`, `extendData` and Trendlines `timeframe`, read from the live instance list plus `loadIndicatorConfigs(scope)` (not from `indicator.list`, which omits extendData and the pin) | `indicator.set` with the captured calcParams, the captured timeframe, and an extendData patch holding the OLD value of every key the forward call touched (`undefined` for keys that did not exist, since the patch is a shallow merge) |
| `indicator.remove` | type, calcParams, extendData, inset, timeframe | `indicator.add` then `indicator.set`. The pane comes back under a new id, and alerts or rule references that pointed at the old id stay orphaned; the change label says "Removed RSI (undo re-adds it under a new id; alerts and rules on the old id are not restored)" |
| `drawing.add` | nothing | `drawing.remove {id}` |
| `drawing.remove` | the full overlay snapshot through the `OverlayManager` lookup funnel (`name, points, styles, lock, visible, zLevel, extendData`), not `drawing.list`, which drops widths, dashes, fills and fib levels | `OverlayManager.placeDrawing(snapshot)` |
| `backtest.config.set` | `backtest.config.get` | `backtest.config.set` with the captured values of the patched keys |
| `chart.timeframe.set` | current resolution | `chart.timeframe.set` to it |
| `market.select` | current epic | `market.select` to it (a tab the forward call opened stays open; the label says so) |
| `chart.range.set` | nothing | none (view-only, listed without undo) |
| `backtest.run` | nothing | none (listed; the previous result is gone) |

Undo rules:

- Only the newest turn that is not yet undone offers Undo; older turns show
  their changes without a button, since later turns may have built on them.
- Undo runs the turn's changes in reverse. Before each one it checks that
  the focused `cellId` matches the captured one; on a mismatch it stops with
  a toast "focus the chart this change was made on, then undo" and leaves
  the turn not undone.
- On success the turn is marked `undone` and a user message
  `[the user undid these changes: <labels>]` is appended (after the
  transcript invariant has closed any pending tool uses), so the model's
  picture of the chart stays right.
- An undo step that fails surfaces a toast and leaves the turn not undone.

Labels for the Changed list come from a small formatter in
`assistant/changeLabels.ts` keyed by action name, for example
`indicator.add` → "Added Trendlines (TRENDLINES)",
`indicator_configure` → "Trendlines: Balanced, rising only",
`backtest.config.set` → "Updated backtest rules: long entry",
`drawing.add` → "Drew trend line". Unknown shapes fall back to the action
name.

### Panel (`AssistantPanel.tsx`)

- Side panel id `assistant`: added to the `SidePanelId` union, its own
  `assistantPanelOpen` signal, a `registerSidePanel` call, a branch in
  `toggleSidePanel`, a `usePanelSignals` entry, a lazy chunk in `App.tsx`
  rendered only when open, not in demo mode, and only when
  `GET /api/assistant/status` reported `configured` (fetched once at boot,
  cached in a signal; a 403 or network failure counts as not configured; the
  toolbar button is absent otherwise).
- Toolbar: one button with a sparkle icon in the `panels` array of
  `ToolbarControls.tsx`, tip "Assistant: describe what you want on the chart".
- Layout: `<aside className="assistant-panel">` with the same head as the
  screener (icon, title, InfoTip explaining what it can do and that it changes
  the focused chart, close button). Body is a scrolling transcript; footer is
  a composer (textarea, Enter sends, Shift+Enter newline), a Send/Stop button
  and a "New chat" link.
- Transcript items: user bubble (chip picks show the question above the
  pick in muted text); assistant text rendered as plain paragraphs and simple
  bullet lines (no markdown library); a "Changed" block listing labels with
  one Undo button at its foot (gray, muted style, "Undone" state once used);
  an options row of chips for `ask_user` plus a "Something else…" chip that
  focuses the composer; an error card for upstream errors showing status and
  body in a monospace block, with a Retry button.
- Retry re-POSTs the current transcript unchanged (it does not re-send the
  user's text), so a failure in the middle of a tool round resumes where it
  stopped.
- A working state ("Working…" with the running tool's label) while a round
  is in flight. Stop aborts the in-flight action and the fetch and stops the
  loop; the partial turn is kept with the "stopped" badge.
- Empty state: three example prompts as chips ("Add rising trendlines on
  the daily", "Show me where RSI was oversold last month", "Build a simple
  EMA crossover backtest").

### Error handling summary

| Situation | Where | User sees |
|---|---|---|
| No key / disabled | status endpoint | No button at all |
| Demo visitor | 403 | Not reachable (button hidden in demo mode too) |
| Upstream 401/403/503 | 502 with body | Error card with the status and the raw body |
| Upstream 429 twice | 502 with body | Error card "rate limited, try again" plus body |
| Proxy busy (semaphore full) | 429 | Error card "assistant busy, try again", Retry |
| Network failure | fetch rejects | Error card, Retry |
| `refusal` stop | session | "The model declined this request" |
| `max_tokens` | session | "The answer was cut short" with the partial text |
| Tool arg invalid | `ActionError` | Returned to the model as `is_error`; the model corrects itself |
| 12 rounds | session | "Stopped after too many steps" with what was done, Undo available |
| Stop pressed | session | "Stopped" badge, changes so far listed, Undo available |

## Testing

Backend (`backend/tests/test_assistant.py`, `httpx.MockTransport`):

- 200 passes the upstream JSON through unchanged; the upstream body holds
  exactly `model, max_tokens, system, messages, tools` with the model forced
  and `max_tokens` capped; a client-sent `stream`/`tool_choice` never
  reaches upstream.
- A tool with a `type` key → 422.
- 429 with `retry-after: 1` then 200: exactly two upstream calls, the sleep
  is patched and observed with 1 s.
- 429 twice: two calls, 502 with the second body.
- 401, 403, 503: one call each, 502 carrying the body verbatim.
- 500: one call, 502.
- Key never appears in the 502 detail even when upstream echoes it.
- Body over 256 KB without Content-Length → 413.
- No key file and no env: `configured: false`, POST 503.
- Demo principal: 403 on both routes.
- Semaphore full → 429 immediately.

Frontend (vitest, run only these files):

- `tools.test.ts`: allowlist excludes dealing/sweep/clear; the name table
  round-trips and `ask_user` survives; `indicator_add.type` has the enum;
  the five assistant tools are present; overridden descriptions contain no
  `ui_wait`/handle/screenshot text; `describe_indicator("TRENDLINES")` lists
  33 calcParam slots with labels and `default` for `pivotLen` equal to the
  Balanced base value; `indicator_configure` with `direction: "Rising"`
  changes only the direction slots.
- `session.test.ts` with a fake `fetch` and a fake registry: tool_use →
  action invoked → results batched in one user message → end_turn;
  `ask_user` in the middle of `[A, ask, C]` holds A's result, leaves C
  pending, and the resume message carries A's result, C's synthesized error
  and the answer, in that order; abort mid-round synthesizes "stopped by the
  user"; round cap at 12 still answers the last round's tool uses;
  `refusal` and `max_tokens` badges; trimming drops whole exchanges and
  never splits a tool pair; the three cache breakpoints land on the right
  blocks; backtest results are summarised and oversized results truncated.
- `undo.test.ts`: changes undone in reverse; `indicator.set` undo restores
  calcParams and sends the old value of each patched extendData key; a
  cellId mismatch stops the undo and leaves the turn not undone; only the
  newest non-undone turn is undoable; a failing undo leaves the turn not
  undone.

Manual check on a fresh tab with a throwaway symbol (`?demo=preview` is not
usable since the panel is hidden in demo mode): "Add rising trendlines on
the daily" yields a Trendlines pane pinned to 1D with the Rising direction,
one summary line and a working Undo.

## Out of scope (follow-ups)

- Streaming responses.
- Sending chart screenshots to the model.
- Per-user quotas, cost display and non-admin access in hosted mode.
- Server-side fallbacks / beta headers through the gateway.
- Persisting conversations to the backend.
- Dealing, sweeps and screener actions.
