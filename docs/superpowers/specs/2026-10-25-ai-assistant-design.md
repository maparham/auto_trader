# AI assistant: plain-English chart configuration

Date: 2026-10-25

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

`async def create_message(body: dict) -> UpstreamResult`:

1. Forces `body["model"] = settings.model`, caps `body["max_tokens"]` at 4096
   (sets it when absent), and deletes `stream`, `betas`, `metadata` if the
   browser sent them. Nothing else in the body is rewritten.
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
routes additionally require `request.state.is_admin`; local dev is always
admin, so nothing changes there.

- `GET /api/assistant/status` returns `{"configured": bool, "model": str}`.
  `model` is omitted when not configured.
- `POST /api/assistant/messages` body (pydantic):
  - `system: list[dict] | str` (content blocks, so `cache_control` can ride on
    the last one)
  - `messages: list[dict]` (1 to 48 entries, roles alternate as the API
    requires; the server does not re-validate the alternation, upstream does)
  - `tools: list[dict]` (at most 32)
  - `max_tokens: int | None`
  - Request body limit 256 KB, enforced before parsing (413).
  - 503 `assistant not configured` when `configured` is false.
  - 409 `assistant busy` when the same user already has a request in flight
    (an `asyncio.Lock` per user id, held for the upstream call).
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

Conversion: the registry's flat `ParamSchema` becomes the tool's
`input_schema` (`type: object`, `properties`, `required`,
`additionalProperties: false`). Tool names replace `.` with `_`
(`indicator_add`), since the API restricts tool names to `[a-zA-Z0-9_-]`; the
executor maps back. The action's `description` is used as the tool
description, with `indicator_add`'s `type` property given an `enum` of the
valid types.

Assistant-only tools, executed locally without touching the registry:

| Tool | Input | Result |
|---|---|---|
| `ask_user` | `question: string`, `options: [{label, description?}]` (2 to 5) | Ends the turn. The chosen label, or the free text the user typed, is returned as this tool's `tool_result` when the loop resumes. |
| `describe_indicator` | `type: string` | `indicatorInfo(type)`, `resolveInputs(type, undefined)` serialized as `[{key, label, source, index|field, default, min, max, step, options, tip, group}]`, `presetsFor(type)`, `directionFor(type)`. Unknown type: `is_error`. |
| `describe_rules` | none | The `expr/catalog.ts` groups (indicators, wrappers, funcs, crosses, cross ops, logic, candle fields with details, timeframes, conditions, pattern names) plus `exprInstancesFor(live)` for the focused chart: `[{id, type, outputs, timeframe, detail}]`. |
| `validate_rule` | `expr: string`, `isExit?: boolean` | `analyze(expr, {isExit, instances, lines})`: `{ok, errors: [{message, from, to}], warmup}`. |

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
4. Indicators: call `describe_indicator` before setting a parameter you have
   not seen described in this conversation. Prefer presets and directions
   over raw numbers. Trendlines: `indicator_add` seeds the Balanced preset;
   adjust with `indicator_set` (calcParams by slot order from the
   description, extendData for render flags, `timeframe` to pin).
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

The last `system` block and the last tool definition carry
`cache_control: {type: "ephemeral"}`.

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
      error?: { kind: "upstream" | "network" | "refusal" | "max_tokens" | "rounds";
                status?: number; body?: string } };
type Change = { label: string; undo: () => Promise<void> };  // undo not serialized
```

`messages: MessageParam[]` is the API transcript, kept alongside the display
turns. Undo closures live in memory only; after a reload the Undo buttons
for earlier turns are disabled with a tooltip ("undo is lost on reload").

`send(text)`:

1. If the previous assistant turn ended in `ask_user`, append a user message
   holding the held `tool_result` blocks from that round plus that tool's
   `tool_result` with `content: text`. Otherwise append a user message
   `[context] ...\n\n<text>`.
2. Loop, at most 12 rounds:
   - `POST /api/assistant/messages` with `{system, messages, tools}`.
   - Append `response.content` as the assistant message (whole array, so
     any thinking blocks round-trip).
   - `stop_reason === "tool_use"`: run every `tool_use` block (sequentially,
     in order; write actions must not interleave), collect one
     `tool_result` per block (`is_error: true` with the `ActionError`
     message on failure), append them as one user message, continue. If one
     of the blocks is `ask_user`, do not execute the rest after it, do not
     send results yet: store the pending `tool_use_id`, render the chips,
     stop. (The results for blocks before it are held and sent together
     with the answer.)
   - `end_turn`: done.
   - `max_tokens`, `refusal`: done, with the matching error badge.
   - 12 rounds reached: done, error `rounds`, no further request.
3. Any text blocks in the final assistant message become the turn's `text`.
   Text blocks from intermediate rounds are concatenated above it so
   progress notes are not lost.

Execution of registry tools goes through `invokeAction(name, args, ctx)`
with an `AbortController` the panel's Stop button fires. Before each write
action the session captures what undo needs:

| Action | Captured before | Undo |
|---|---|---|
| `indicator.add` | nothing | `indicator.remove {id}` with the returned id |
| `indicator.set` | the instance's `calcParams`, `extendData`, Trendlines `timeframe` from `indicator.list` + live config | `indicator.set` with the captured values |
| `indicator.remove` | the instance's type, calcParams, extendData, inset | `indicator.add` then `indicator.set` to restore config (new id; the label says so) |
| `drawing.add` | nothing | `drawing.remove {id}` |
| `drawing.remove` | the drawing from `drawing.list` | `drawing.add` with its tool, points, text, color |
| `backtest.config.set` | `backtest.config.get` | `backtest.config.set` with the captured keys |
| `chart.timeframe.set` | current resolution | `chart.timeframe.set` to it |
| `market.select` | current epic | `market.select` to it |
| `chart.range.set` | nothing | none (view-only, listed without undo) |
| `backtest.run` | nothing | none (listed; the previous result is gone) |

"Undo this turn" runs the turn's changes in reverse, marks the turn `undone`,
and appends a user message `[the user undid the changes from your last turn]`
so the model's picture of the chart stays right. Undo failures surface as a
toast and leave the turn not undone.

Labels for the Changed list come from a small formatter in
`assistant/changeLabels.ts` keyed by action name, for example
`indicator.add` → "Added Trendlines (TRENDLINES)",
`indicator.set` with a Trendlines preset match → "Trendlines: Balanced,
rising only", `backtest.config.set` → "Updated backtest rules: long entry",
`drawing.add` → "Drew trend line". Unknown shapes fall back to the action
name.

### Panel (`AssistantPanel.tsx`)

- Side panel id `assistant`: added to the `SidePanelId` union, its own
  `assistantPanelOpen` signal, a `registerSidePanel` call, a branch in
  `toggleSidePanel`, a `usePanelSignals` entry, a lazy chunk in `App.tsx`
  rendered only when open, not in demo mode, and only when
  `GET /api/assistant/status` reported `configured` (fetched once at boot,
  cached in a signal; the toolbar button is absent otherwise).
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
  body in a monospace block, with a Retry button that re-sends the last
  user message.
- A thinking state ("Working…" with the running tool's label) while a round
  is in flight. Stop aborts the in-flight action and stops the loop; the
  partial turn is kept with an error badge "stopped".
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
| Network failure | fetch rejects | Error card, Retry |
| `refusal` stop | session | "The model declined this request" |
| `max_tokens` | session | "The answer was cut short" with the partial text |
| Tool arg invalid | `ActionError` | Returned to the model as `is_error`; the model corrects itself |
| 12 rounds | session | "Stopped after too many steps" with what was done, Undo available |

## Testing

Backend (`backend/tests/test_assistant.py`, `httpx.MockTransport`):

- 200 passes the upstream JSON through unchanged, model forced, `stream`
  stripped, `max_tokens` capped.
- 429 with `retry-after: 1` then 200: exactly two upstream calls, the sleep
  is patched and observed with 1 s.
- 429 twice: two calls, 502 with the second body.
- 401, 403, 503: one call each, 502 carrying the body verbatim.
- 500: one call, 502.
- Key never appears in the 502 detail even when upstream echoes it.
- No key file and no env: `configured: false`, POST 503.
- Demo principal: 403 on both routes.
- Second concurrent request for the same user: 409.

Frontend (vitest, run only these files):

- `tools.test.ts`: allowlist excludes dealing/sweep/clear; names are
  API-safe and round-trip; `indicator_add.type` has the enum; the four
  assistant tools are present; `describe_indicator("TRENDLINES")` lists 33
  calcParam slots with labels and `pivotLen` default 5.
- `session.test.ts` with a fake `fetch` and a fake registry: tool_use →
  action invoked → results batched in one user message → end_turn;
  `ask_user` pauses, the pick is sent as that tool's result; round cap at
  12; `refusal` and `max_tokens` badges; abort stops the loop.
- `undo.test.ts`: changes undone in reverse; `indicator.set` restores the
  captured config; a failing undo leaves the turn not undone.

Manual check on a scratch tab (`?demo=preview` is not usable since the
panel is hidden in demo mode; use a fresh tab with a throwaway symbol):
"Add rising trendlines on the daily" yields a Trendlines pane pinned to 1D
with the Rising direction, one summary line and a working Undo.

## Out of scope (follow-ups)

- Streaming responses.
- Sending chart screenshots to the model.
- Per-user quotas, cost display and non-admin access in hosted mode.
- Server-side fallbacks / beta headers through the gateway.
- Persisting conversations to the backend.
- Dealing, sweeps and screener actions.
