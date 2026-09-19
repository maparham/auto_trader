# Tab Bridge extension: screenshots and focus for a backgrounded tab

Date: 2026-09-19.

## Summary

`ui_screenshot` fails with TAB_HIDDEN whenever the Chartkar tab is not in the
foreground. The cause is structural: klinecharts paints every pane inside
`requestAnimationFrame`, Chrome pauses rAF in a backgrounded tab, and any
pane re-layout assigns `canvas.width`, which wipes the canvas synchronously.
Page JavaScript can only copy pixels the chart already painted, so a hidden
tab reads as transparent.

A browser extension sits outside the page. Through `chrome.debugger` it can
ask the renderer for a fresh frame (`Page.captureScreenshot`), which forces a
BeginFrame and runs the pending rAF callbacks regardless of visibility. That
is how Claude in Chrome screenshots background tabs.

This spec adds a small, generic Chrome extension, **Tab Bridge**, that any
web page can ask for two things about its own tab: a screenshot and focus.
Chartkar's agent bridge becomes its first consumer: `chart.screenshot` routes
through the extension when it is installed and falls back to today's canvas
composite otherwise. The extension is not Chartkar-specific: it carries no
Chartkar code, matches every http(s) origin, and answers only a namespaced
`postMessage` protocol, so any app can adopt it.

## Goals

- `ui_screenshot` works while the Chartkar tab is backgrounded.
- `ui_focus_tab` works without AppleScript when the extension is present, so
  it stops being macOS-only.
- The extension is reusable by any web app with no code changes to the
  extension.
- No backend changes for screenshots; the page's existing authenticated
  bridge carries the pixels as it does today.

## Non-goals

- Cross-tab operations. A page can only act on its own tab.
- Opening a tab from nothing. `ui_open_tab` stays AppleScript; there is no
  page to talk to before a tab exists.
- Web Store distribution. Unpacked install for now.
- Replacing the in-page bridge. Actions, state, confirm dialogs stay in-page.

## Architecture

```
MCP ui_screenshot
  -> backend HUB (unchanged)
    -> page bridge: chart.screenshot (chart.ts)
        -> lib/tabBridge.ts: window.postMessage({ns, op: "screenshot", clip})
            -> content script (extension) -> chrome.runtime.sendMessage
                -> background worker: chrome.debugger attach,
                   Page.captureScreenshot(clip), detach
            <- {ok, result: {mime, image_base64}}
        <- falls back to compositeChartPng when the extension is absent
```

Three parts:

1. **`extension/`** (repo root, plain ES modules, no bundler, Manifest V3).
   - `manifest.json`: permissions `debugger`, `tabs`; content script on
     `http://*/*` and `https://*/*`; module service worker.
   - `content.js`: listens for `window` messages with `ns === "tab-bridge"`
     and `dir === "req"`, forwards `{id, op, args}` to the background worker,
     posts the reply back with `dir === "res"` and the same `id`. Ignores
     everything else. Never injects anything into the page.
   - `background.js`: `chrome.runtime.onMessage` dispatcher over
     `handlers.js`. Always targets `sender.tab.id`.
   - `handlers.js`: pure functions `(chromeApi, tabId, args) -> result`, one
     per op, so they test with a fake `chrome`.
   - `README.md`: install (chrome://extensions, Developer mode, Load
     unpacked), the protocol, the debugger banner note.

2. **`frontend/src/lib/tabBridge.ts`**: the page-side client. `probe()`
   sends `hello` and resolves to the extension's version or `null` after a
   300 ms timeout; the result is cached for the page's lifetime except that a
   `null` is re-probed on the next call (the extension can be installed
   later). `screenshot({clip, format})` and `focus()` send a request with a
   fresh id and resolve on the matching reply; 10 s timeout.

3. **Chartkar consumers**:
   - `chart.screenshot` in `frontend/src/agent/actions/chart.ts`: if the
     extension is present, clip to the focused chart's container rect
     (`chart.getDom().getBoundingClientRect()`) and return its PNG (JPEG when
     over `MAX_B64`, as today). Otherwise the existing path, including the
     TAB_HIDDEN guard, whose message now says "install the Tab Bridge
     extension or focus the tab".
   - New UI action `tab.focus` (kind `write`, no args): calls the extension's
     `focus`; errors `NO_EXTENSION` when absent.
   - `ui_focus_tab` (backend `mcp_server.py`): try `tab.focus` on the
     connected session first; on `NoTabError`/`NO_EXTENSION` fall through to
     the AppleScript path on macOS, else raise with the install hint.

## Protocol

All frames go over `window.postMessage(frame, "*")` on the page's own
window. The content script accepts requests only from the same window
(`event.source === window`), so an iframe cannot drive its parent's tab.

Request: `{ns: "tab-bridge", dir: "req", id: string, op: string, args?: object}`
Reply:   `{ns: "tab-bridge", dir: "res", id, ok: true, result}` or
         `{ns, dir: "res", id, ok: false, error: {code, message}}`

Ops (v1):

| op | args | result |
|----|------|--------|
| `hello` | none | `{version, ops: ["screenshot", "focus"]}` |
| `screenshot` | `clip?: {x, y, width, height}` (CSS px, page coordinates: the viewport rect plus scroll offsets), `format?: "png" \| "jpeg"`, `quality?: 0..100` | `{mime, image_base64, width, height}` |
| `focus` | none | `{focused: true}` |

Error codes: `UNKNOWN_OP`, `DEBUGGER_BUSY` (DevTools already attached to the
tab), `CAPTURE_FAILED`, `INVALID_ARGS`.

`screenshot` implementation: `chrome.debugger.attach({tabId}, "1.3")`,
`Page.captureScreenshot({format, quality, clip: {...clip, scale: 1},
fromSurface: true})`, `chrome.debugger.detach`. CDP's capture surface is
already at device resolution, so passing `devicePixelRatio` again as scale
would double it; `scale: 1` is correct. Attach
and detach per call, so the yellow "is being debugged" banner appears only
for the duration of a capture. Detach is in a `finally`. Concurrent requests
for the same tab are serialised in the worker; a second attach would fail.

`focus`: `chrome.tabs.update(tabId, {active: true})` then
`chrome.windows.update(windowId, {focused: true})`.

## Security

- Only the requesting tab is ever targeted; `tabId` comes from
  `sender.tab.id`, never from the message.
- A page can screenshot only itself, which it can already do in weaker form
  via canvas; nothing new is exposed across origins.
- The `debugger` permission is powerful. The worker exposes exactly two CDP
  calls, and `handlers.js` has no dynamic method dispatch into CDP.
- The Chartkar side keeps its own gate: `chart.screenshot` still runs only
  when the agent bridge is on (dev builds or `VITE_AGENT_BRIDGE=1`).

## Error handling

- Extension absent: Chartkar behaves exactly as today. The only visible
  change is the TAB_HIDDEN message naming the extension.
- Extension present but capture fails (`DEBUGGER_BUSY`, `CAPTURE_FAILED`):
  `chart.screenshot` surfaces the code and message as `SCREENSHOT_FAILED`.
  It does not fall back to the canvas path, because a blank composite would
  be worse than a clear error.
- Reply timeout in `tabBridge.ts` (10 s): rejects with `EXTENSION_TIMEOUT`.

## Testing

- `extension/handlers.test.js` (node's built-in test runner, no deps): each
  op against a fake `chrome`, including detach-on-failure, DevTools-busy,
  and that `tabId` always comes from the sender.
- `frontend/src/lib/tabBridge.test.ts` (vitest): probe caching, timeout,
  id matching, ignoring frames with the wrong `ns`/`dir`/`source`.
- `frontend/src/agent/actions/chart.test.ts`: extension-present path clips
  to the container rect; hidden-tab guard still fires when absent; new
  `tab.focus` action.
- Backend `tests/test_mcp_tools.py` (or the existing mcp test file):
  `ui_focus_tab` prefers the session action and falls back to AppleScript.
- Manual: background the tab, run
  `python3 -m scripts.agent_bridge_probe --screenshot` and confirm a
  non-blank PNG.

## Docs

- `extension/README.md` as above.
- CLAUDE.md, Agent UI Bridge section: one paragraph on the extension, that
  `ui_screenshot` no longer needs a visible tab with it installed, and that
  `ui_focus_tab` uses it when present.
