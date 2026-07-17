# Alert attribution: know which symbol/tab an alert came from

Date: 2026-07-17. Status: approved.

## Problem

When a price alert fires, the sound (and often the toast/banner) gives no clue
which symbol or chart tab triggered it. With a custom alert message the symbol
may not appear anywhere; the native banner title is a generic "Price alert".

## Design

### 1. Attributed toast + banner

- Toast always leads with the epic: `🔔 EURUSD · <message> (now <price>)`; when
  the alert has no custom message it stays `🔔 EURUSD @ <level> (now <price>)`.
- Native banner title becomes the epic (was "Price alert").
- Toast remains a corner toast, non-intrusive, auto-dismisses (6s for alert
  toasts, since they're clickable; default stays 4s elsewhere).

### 2. Click → chart

- Clicking the toast or the native banner navigates to the chart for that epic,
  reusing App's existing `openAlert(epic, {savedId}, precision)` path (focuses an
  existing cell across tabs or opens a fresh tab, then selects the alert line).
- The alert engine lives outside React, so App registers a navigation handler in
  a tiny module (`lib/alertNav.ts`); the engine calls it from the click handlers.

### 3. Tab bell badge

- On fire, every tab (other than the active one) containing a cell with the
  fired epic gets a small dot badge on its chip, styled like the closed-market
  crescent (top-right, monochrome-compatible, amber).
- The badge clears when the tab is activated. Session-only state in App
  (`Set<tabId>`), not persisted.
- Engine → App signalling via a new `alertFired` signal carrying the epic.

## Out of scope

Distinct sounds per symbol/alert (user declined). Persistence of badges.
