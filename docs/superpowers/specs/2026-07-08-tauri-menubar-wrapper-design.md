# Tauri menu-bar wrapper for the auto_trader UI

**Date:** 2026-07-08
**Status:** Design — pending implementation plan

## Problem

The live-trading engine is browser-driven: the app's tab must stay open for the
live engine to keep running. Keeping it in the everyday Chrome window is fragile
— the tab (or the whole browser) gets closed by accident, killing the engine.

We want a dedicated, always-alive Mac app that:

- Is **permanently available** and cannot be closed by accident.
- Opens instantly from an **icon in the macOS menu bar** (the top status bar).
- Loads the **existing** UI — no changes to the app itself.

## Scope

**In scope:** a thin native shell that loads the already-running localhost UI.

**Out of scope (decided):**
- The shell does **not** start or manage the Python backend or the Vite server —
  those are started separately, as today. The shell only loads the URL.
- No auto-update, code signing, notarization, or distribution — this is a
  personal single-machine tool.

The URL is **user-settable** (see Settings), defaulting to localhost but able to
point anywhere — including a future hosted URL — without a rebuild.

**No proxy handling.** The web view loads localhost, so it needs none; broker
traffic goes through the backend (which already honors `HTTPS_PROXY`). If the
URL is ever pointed at a hosted app, WKWebView uses the macOS system proxy
automatically. An app-specific proxy field is explicitly deferred.

## Approach

A minimal **Tauri v2** app. Tauri was chosen over Electron and over Chrome's
"Install as app" because:

- It renders in macOS's built-in **WKWebView** (no bundled Chromium) →
  ~3–10 MB app, ~50–100 MB idle RAM, vs. Electron's ~150–200 MB / ~300 MB.
- It supports a real **menu-bar tray icon** (Chrome "Install as app" gives only
  a dock icon — the disqualifier).

**Known risk — rendering engine:** the UI is developed/tested in Chrome (Blink);
WKWebView is WebKit. For plain React this is a non-issue. The one thing to
verify is **klinecharts** (canvas-heavy). Mitigation: the very first
implementation step loads the app and eyeballs the charts. If anything renders
wrong in WebKit, the fallback is an Electron shell with the *same* window/tray
design — no design change, only a heavier runtime. This fallback is documented,
not built.

## Configuration

| Setting | Value |
| --- | --- |
| UI URL loaded | **user-set**, default `http://localhost:5173` (Vite dev server) |
| Backend | `http://localhost:8000` — reached by the UI itself, not the shell |
| Menu-bar hotkey | `⌘⌥T` (global; configurable in one constant) |

The UI URL is stored in a small settings file in the app's data dir and edited
from an in-app **Settings** window (see below). On first run it seeds to the
default above. The shell reloads the new URL immediately on save — no rebuild.

## Behavior

### Window
- A single main window loading the UI URL at launch.
- Sized to a sensible default (e.g. 1440×900), remembers last size/position.
- Standard title-bar with the app name so the automation/live tab is
  identifiable.

### "Never accidentally closed"
- **Close (red button / ⌘W) hides the window instead of quitting.** The process
  and its WKWebView keep running, so the live engine stays alive.
- **⌘Q also hides**, not quits — nothing routed through a keystroke can kill the
  engine.
- The app only truly quits via the tray menu's **Quit** item.

### Menu-bar tray icon (the core ask)
- An `NSStatusItem`-backed tray icon always present in the top status bar.
- **Left-click the icon → toggle** the window (show + focus if hidden, hide if
  frontmost).
- **Right-click (or click) → menu** with:
  - **Show / Hide** window
  - **Reload** (re-navigate the web view, for recovering a wedged UI)
  - **Quit** (the only real exit)

### Global hotkey
- `⌘⌥T` from anywhere shows + focuses the window (same as tray left-click show).

### Settings
- A small **Settings** item in the tray menu opens a settings window.
- Fields: the **UI URL** (text input, validated as a URL) and the **launch-at-
  login** toggle (mirrors the tray toggle).
- Saved to a JSON settings file in the Tauri app-data dir; read at launch,
  seeded to defaults on first run.
- On **Save**, the main window re-navigates to the new URL immediately (no
  restart, no rebuild).

### Launch at login
- Registered via Tauri's autostart plugin, toggleable from both the tray menu
  and the Settings window; the current state is persisted in the settings file.
  Default: **on** — so after a reboot the app comes back on its own and the
  menu-bar icon is there without any manual step.

### Native notifications (alert toasts)
- Alerts fire inside the web app and already route through a single seam,
  `frontend/src/lib/notify.ts` (`notify(title, body)`), which today does a Web
  `Notification` + in-page toast + audible ping.
- The Web `Notification` API is unreliable inside WKWebView. So `notify()` gains
  a branch: **when running inside Tauri** (detect `window.__TAURI__`), post the
  banner through the Tauri notification plugin instead; otherwise keep the
  existing Web-Notification path unchanged for plain-browser use.
- Result: real macOS notifications (Notification Center) that fire **even when
  the window is hidden** — which is the normal state for this app. The in-page
  toast and ping stay as-is.
- The Tauri shell adds `tauri-plugin-notification` and requests notification
  permission on launch.

### App Nap / background throttling prevention (correctness, not polish)
- macOS "App Nap" and timer coalescing throttle hidden/background apps — for a
  browser-driven live engine that runs its loop *while the window is hidden*,
  that risks slowed timers and a stalled WebSocket.
- The shell disables this: set `NSAppSleepDisabled` in the app's Info.plist and
  hold a `NSProcessInfo` "background activity" assertion
  (`.userInitiated | .idleSystemSleepDisabled` semantics via a Tauri/Rust call)
  for the app's lifetime, so the hidden window keeps running at full speed.
- Shell-only; no frontend change.

### Menu-bar status glyph
- The tray icon reflects live-engine health at a glance: **green** = engine
  running/connected, **grey** = idle/stopped, **red** = disconnected/error.
- Driven by the frontend: on each engine state transition it calls a tiny Tauri
  command (`set_status(state)`), guarded by `window.__TAURI__` so plain-browser
  runs are unaffected. The shell swaps the tray icon/template accordingly.

### Unread alert badge
- Alerts firing while the window is hidden accumulate an **unread count** shown
  as a badge on the dock (and reflected in the tray). Piggybacks on the same
  `notify()` bridge — the shell increments the badge when it posts a
  notification while hidden.
- **Cleared to zero** when the window is shown/focused.

### Connection splash + retry
- When the configured UI URL isn't reachable yet (backend/Vite not started),
  the window shows a local **"Waiting for <url>…"** splash instead of a raw
  browser error, and **auto-retries** on an interval.
- As soon as the URL responds, it navigates to the real app. A manual **Retry**
  button and the tray **Reload** also trigger it.

### Frontend changes (summary)
Only two small, isolated seams in `frontend/`, both guarded by `window.__TAURI__`
so plain-browser behavior is unchanged:
1. `lib/notify.ts` — route alert banners through the Tauri notification plugin.
2. Engine-state emit — call `set_status(state)` where the live engine's
   running/connected state changes. `backend/` does not change.

## Components

```
tauri-shell/                    (new; lives alongside frontend/ and backend/)
  src-tauri/
    tauri.conf.json             window + bundle config
    src/main.rs                 tray, hotkey, close-to-hide, autostart, settings,
                                app-nap assertion, status glyph, badge, set_status cmd
    icons/                      menu-bar (green/grey/red) + dock/app icons
  settings.html                 the small Settings window UI (URL + autostart)
  splash.html                   "waiting for <url>…" + retry, shown until reachable
  README.md                     how to build + run
```

Plugins: `tauri-plugin-global-shortcut`, `tauri-plugin-autostart`,
`tauri-plugin-window-state` (remember size/position), `tauri-plugin-store`
(persist the settings JSON), `tauri-plugin-notification`.

Everything is contained in `tauri-shell/`, with **two small, deliberate seams**
in the frontend (native notifications + engine-state emit — see "Frontend
changes"), both guarded by `window.__TAURI__`. `backend/` does not change.

## Data flow

The shell is a dumb container. The WKWebView loads the configured UI URL
(default `http://localhost:5173`), and from there the existing app talks to
`http://localhost:8000` exactly as it does in Chrome today. The shell's only
persisted state is the settings JSON (URL + autostart flag); it does no
networking of its own.

## Error handling

- **UI URL not up yet** (backend/Vite not started): the shell shows the
  **splash** ("waiting for <url>…") and auto-retries until the URL responds,
  then navigates to the app (see Connection splash).
- **Wedged / blank UI:** tray **Reload** re-navigates.
- **Charts render wrong in WebKit:** caught in the first verification step →
  Electron fallback (see Approach).

## Testing / verification

Manual, since it's a personal shell:

1. **Build & launch** — app starts, tray icon appears, window loads the UI.
2. **Charts sanity check (gating)** — klinecharts renders clean in WKWebView:
   candles, indicators, overlays, drag interactions. This gates the whole
   Tauri-vs-Electron decision.
3. **Close-to-hide** — red button / ⌘W hides, window reappears via tray with the
   session intact (live engine still running — verify the tab wasn't reloaded).
4. **Tray toggle** — left-click shows/hides; menu items work.
5. **Global hotkey** — ⌘⌥T summons the window from another app.
6. **Settings** — open Settings, change the URL, Save → main window re-navigates
   immediately; value survives a relaunch.
7. **Launch at login** — enable, reboot (or log out/in), app returns on its own
   with the menu-bar icon present.
8. **Native notification** — fire an alert while the window is hidden; a macOS
   banner appears and clicking it shows the window.
9. **Status glyph** — start/stop/disconnect the engine; tray icon turns
   green/grey/red accordingly.
10. **Unread badge** — fire alerts while hidden → dock badge counts them; opening
    the window clears it.
11. **Connection splash** — launch with servers down → splash + retry; start the
    servers → it navigates to the app on its own.
12. **App Nap** — with the window hidden and the machine otherwise idle, the
    engine's timers/WebSocket keep ticking at full rate (spot-check timestamps).

## Resolved decisions

1. **⌘Q behavior** — ⌘Q **hides** (does not quit), same as the red button and
   ⌘W. The only true quit is the tray menu's **Quit** item, so no reflexive
   keystroke can kill the live engine.
2. **Load target** — the window loads **Vite dev `http://localhost:5173`** (hot
   reload), matching how the backend + frontend are started manually today.
