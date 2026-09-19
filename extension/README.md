# Tab Bridge

A tiny Chrome extension that lets a web page screenshot or focus **its own
tab**, even while the tab is in the background. Page JavaScript cannot do
either: Chrome pauses requestAnimationFrame in hidden tabs, so canvases stop
painting, and pages may not steal focus. The extension can, via
`chrome.debugger` and `chrome.tabs`.

It is generic. Any page that speaks the protocol below can use it. Chartkar
is the first consumer (`frontend/src/lib/tabBridge.ts`).

## Install (unpacked)

1. Open `chrome://extensions`, turn on **Developer mode** (top right).
2. **Load unpacked**, pick this `extension/` folder.
3. Reload the app's tab.

While a screenshot is being taken Chrome shows its yellow "Tab Bridge started
debugging this browser" bar on the tab. It disappears when the capture ends.
Launch Chrome with `--silent-debugger-extension-api` to suppress it. A tab
with DevTools open refuses the attach (`DEBUGGER_BUSY`); close DevTools.

## Protocol

Post to your own window, listen for the reply with the same `id`:

    window.postMessage({ ns: "tab-bridge", dir: "req", id, op, args }, "*")
    // reply: { ns: "tab-bridge", dir: "res", id, ok: true, result }
    //     or { ns: "tab-bridge", dir: "res", id, ok: false, error: { code, message } }

| op | args | result |
|----|------|--------|
| `hello` | none | `{ version, ops }` (use with a short timeout to detect the extension) |
| `screenshot` | `clip?: {x, y, width, height}` (CSS px, page coords), `scale?` (device pixel ratio), `format?: "png" \| "jpeg"`, `quality?: 0..100` | `{ mime, image_base64, width, height }` |
| `focus` | none | `{ focused: true }` |

Error codes: `UNKNOWN_OP`, `INVALID_ARGS`, `DEBUGGER_BUSY`, `CAPTURE_FAILED`,
`EXTENSION_ERROR`.

Only the requesting tab is ever targeted. No cross-tab operations exist.

## Tests

    node --test extension/
