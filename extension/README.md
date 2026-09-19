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
| `screenshot` | `clip?: {x, y, width, height}` (CSS px, page coords), `scale?` extra multiplier on top of the device pixel ratio, default 1; the capture is already at device resolution, `format?: "png" \| "jpeg"`, `quality?: 0..100` | `{ mime, image_base64, width, height }` |
| `focus` | none | `{ focused: true }` |

`screenshot`'s `width`/`height` are the CSS clip dimensions passed in (or
`null` when no clip is given), not the pixel dimensions of the returned
image: the image is `scale` times the device pixel ratio times that size.

| code | source | meaning |
|------|--------|---------|
| `UNKNOWN_OP` | worker | the requested op isn't one of the ops above |
| `INVALID_ARGS` | worker | malformed args (bad clip, format, quality, scale) |
| `DEBUGGER_BUSY` | worker | `chrome.debugger.attach` failed, usually DevTools already open on the tab |
| `CAPTURE_FAILED` | worker | `Page.captureScreenshot` itself failed |
| `NO_TAB` | worker | the message didn't come from a tab (`sender.tab` missing) |
| `EXTENSION_ERROR` | worker or content script | any other failure, including a `chrome.runtime.sendMessage` throw from an orphaned content script (the extension was reloaded after the page loaded) |
| `NO_WINDOW` | client (`tabBridge.ts`) | called outside a browser (no `window`) |
| `EXTENSION_TIMEOUT` | client (`tabBridge.ts`) | no reply within the op's timeout; the client treats this as the extension having gone away and re-probes on the next call |

Only the requesting tab is ever targeted. No cross-tab operations exist. The
capture is the tab's composited surface, so it includes any cross-origin
iframes the page embeds; that is intended, since the extension is meant to
work with any app, but the reader should know.

## Tests

    node --test extension/*.test.js
