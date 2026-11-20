# AI assistant

The in-app Assistant (right-docked panel, toolbar sparkle icon, hidden unless
`assistantConfigured`) is a browser-side agent loop that edits the focused
chart from a plain-English request. It never places orders.

The backend is a thin proxy, not a second implementation of the loop:
`api/routers/assistant.py` (`POST /api/assistant/messages`, `GET
/api/assistant/status`) only adds the gateway key, forces the model and
applies the retry contract, via `core/assistant_client.py` (raw httpx, not
the Anthropic SDK, since the gateway's exact headers and one-retry-on-429
policy need a contract the SDK's own retry loop wouldn't honour). Nothing is
stored and message bodies are never logged. `_gate` 403s in demo mode and,
when auth is on, outside admin.

The loop itself runs in the browser: `frontend/src/assistant/session.ts`
(`createSession`, one conversation per chart cell via `sessionFor(cellId)`,
mirrored to sessionStorage under `assistant.session.<cellId>`) drives rounds of `assistant/api.ts` (`postMessages`,
`assistantConfigured`/`fetchAssistantStatus`) against the tool set built by
`assistant/tools.ts` and executed by `assistant/undo.ts`. `assistant/prompt.ts`
builds the system prompt and request; `assistant/describe.ts` backs the
local `describe_indicator`/`describe_rules`/`validate_rule` tools.

Chats are locked to their chart: every tool acts on the focused chart, so
the loop checks before each tool that its own cell is still focused and
otherwise waits (polling, Stop still ends it) until it is again, so a switch
leaves that chat untouched while the panel shows the newly focused cell's
chat. (`cause: "switch"` survives only on turns saved before this.) The one exception
is the assistant's own `market_select`, which focuses or opens another cell:
the session rebinds to that cell and keeps going, and the panel's
`sessionToShow` follows it meanwhile. Changes are stamped with the cell a
call STARTED on (market_select alone stamps the cell it landed on), and
`redoTurn` re-checks focus before every step. The panel drops saved chats of
cells that no longer exist (`pruneSessions`), stopping any still waiting.

Tool allowlist: the assistant can only call what `tools.ts`'s `TOOL_TO_ACTION`
maps to an agent-registry action (the same handlers the MCP bridge drives).
A new registry action is NOT exposed to the model until it is added there.
`LOCAL_TOOLS` (`ask_user`, `describe_indicator`, `indicator_configure`,
`describe_rules`, `validate_rule`, `indicator_values`, `symbol_search`,
`trendlines_explain_line`) run locally instead of through the registry; `ask_user` ends the turn with chips.
`market_select` only opens an epic the broker's own search returns
(`symbol_search` finds it), so a guessed epic never opens an empty tab.

Undo capture: `undo.ts`'s `executeTool` captures what "Undo this turn" needs
BEFORE the forward call, keyed by `(cellId, epic)` so a later `market.select`
on the same cell can't make a stale undo revert the wrong symbol. A `Change`
with `undoable: false` legitimately has nothing to revert (a read, or a
market.select with no prior epic); one with no `undo` and `undoable` left
unset means capture failed on something that SHOULD have been undoable, and
`undoTurn` treats that as an error rather than skipping it silently.
`undoableIndex(turns)` is the one place that decides which turn (if any) gets
an Undo button: the newest not-undone assistant turn with at least one still-
live change. A turn restored from sessionStorage has no undo functions (they
don't survive `JSON.stringify`), so it never offers Undo.

Redo: the session stamps each revertible change with `replay` (the tool
call and its input, plain JSON) and `undo.ts`'s `redoTurn` replays an undone
turn's calls through `executeTool`, so the model is not asked again and each
step captures a fresh undo. `redoableIndex` offers it on the newest undone
turn until the user sends again, also after a reload. Ids are remapped: an
add that comes back under a new id (`createdId`) renames later calls, and a
remove whose undo re-created its target (`restoredId`) removes that one.

Edit an earlier message: each user turn records `rewind` (its start index in
`messages` and the `pending` state just before it). `editFrom(idx, text)`
reverts every later live turn newest first, cuts `turns` and `messages` back
to that point, restores `pending` (so an edited ask answer becomes the new
answer) and sends `text`. A later change with no live undo (after a reload)
or a refused undo returns "blocked" with nothing cut; the panel then offers
"Continue without reverting", which calls again with `force`. Messages sent
before `rewind` existed show no edit pencil.

Spec: docs/superpowers/specs/2026-10-25-ai-assistant-design.md.
