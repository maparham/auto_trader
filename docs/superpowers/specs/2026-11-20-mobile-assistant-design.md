# Mobile AI assistant and chart extras (short design)

**Why:** bring the Android app close to the desktop app (backtesting excluded).

## Chart extras

- AVWAP is already on the phone (Indicators sheet) and the Trendlines line
  menu already opens on a hold after a tap on the line. Nothing to build.
- Time gaps: a "Time gaps" switch in the phone's Settings sheet
  (`Settings.equalWidthDays`), bumping `mobileSettingsVersion` so the chart
  re-reads it. Inside the Android app the push row says alerts come as app
  notifications (FCM) instead of "not supported".

## Assistant

**Approaches:** (A, picked) a half-height panel over the lower part of the
chart, opened by a sparkle button above the pencil; the chart stays visible
above it. (B) a fifth bottom tab: more room, but the chart is hidden while
typing.

**Design**
- `mobile/assistantSetup.ts` `installMobileAssistant()` (idempotent):
  registers the drawing, chart and indicator actions plus a phone
  `market.select`; no backtest, sweep, dealing or tab actions, so the
  assistant's tool list (built from registered actions) has none of them.
  Sets the focused chart and drawings providers from `mobileChartCtx`,
  `mobileSymbol`, `mobileChartScope` and `mobilePeriod`, and only while the
  mounted chart is the one for the symbol shown (`mobileChartCtx.epic`).
  The cell id names the chart (`mobileCellId(scope, epic)`): each chart has
  its own chat and undo, and a chip tap mid-turn makes the chat wait, as a
  cell switch does on desktop. Chats are not pruned.
  Fetches the assistant status.
- Phone `market.select`: `showMobileEpic`, then waits (up to 10 s, or until
  Stop) for the new chart to mount, so the next tool acts on it.
- `mobile/MobileAssistant.tsx`: the sparkle button (only when
  `assistantConfigured`, never in demo) and the desktop `AssistantPanel`
  in a `.m-assistant` box over the lower part of the chart body. Back closes
  it.
- Server side unchanged: admin only, as on desktop.

**Non-goals:** backtest tools on the phone.
