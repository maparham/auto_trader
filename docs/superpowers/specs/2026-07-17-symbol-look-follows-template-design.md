# Symbol look follows template (replace-on-open)

**Date:** 2026-07-17
**Status:** Approved

## Requirement

When a user has done technical analysis (drawings + indicators) on a symbol, the
exact same look must reappear whenever that symbol is opened anywhere else — a
new chart tab, another cell, a symbol switch. Analysis done on a chart is
preserved no matter what.

## Problem today

`maybeAutoApplyTemplate` only fires on a FRESH cell (zero saved indicators and
zero drawings for the epic). A new chart tab is born on a default symbol whose
template (or the global default) immediately populates the cell's cell-scoped
indicators; by the time the user picks the symbol they actually wanted, the gate
blocks its template forever. Verified live: GOLD's template (EMA, VOL, 4 AVWAPs,
3 segments, fib) never applies in a new tab; only the birth-symbol's indicators
show.

## Behavior (symbol-follows-template, TradingView model)

- A symbol's saved per-symbol template IS its "exact look": indicators +
  configs, drawings, AVWAP anchors. Template autosave keeps it current.
- Opening a symbol in any cell applies its template as a **replace**: the cell
  ends up looking exactly like the template.
- Before the replace, the **outgoing** symbol's current look is captured to its
  own template **synchronously** — flush any pending debounced autosave and
  capture directly, regardless of the `autoSaveTemplates` setting. Analysis
  travels with its symbol; switching back restores it. Nothing is ever lost.
- A symbol with **no saved template** keeps the cell's current indicators
  (nothing to apply); autosave then creates its template from that look.
- An **empty template** (user cleared the chart) still means "open blank"
  (empty-saved-as-empty semantics unchanged).
- Restored **snapshot tabs** keep their existing skip (markerMeta non-null).
- The manual "Apply template" menu action stays **additive-merge** (unchanged).
  Only the on-open path replaces.

## Mechanism

- New `replaceSymbolTemplate(chart, controller, scope, epic, t)` in
  `lib/templates.ts` alongside the additive `applySymbolTemplate`:
  - Indicators: diff by the existing identity-signature matching. Instances
    whose signature matches a template entry are kept untouched (no churn);
    unmatched existing instances are removed; missing template entries are
    added (same per-add ordering rules as merge: AVWAP anchor written before
    `applyIndicator`, config written after success).
  - Drawings: the epic's drawings become exactly the template's drawings
    (write template list, rehydrate overlays, cover anchors). Signature-equal
    drawings are preserved rather than re-minted where practical.
  - Layout events suppressed for the whole operation (same as merge-apply).
- `maybeAutoApplyTemplate` is replaced by `applyLookOnOpen(chart, controller,
  scope, epic)`: fires on every epic change/mount (not just empty cells).
  Per-symbol template exists → replace-apply. No per-symbol template AND cell
  is fresh → fall back to the global default (unchanged precedence).
- Capture-on-switch: in `useLiveMarketData`, where the epic changes, capture
  the outgoing epic's look into its template BEFORE tearing down / applying the
  incoming symbol. Cell/tab close: flush a capture first, then `cancelAutoSave`
  (also fixes the existing lose-last-800ms-of-edits window on close).

## Edge cases

- Two cells showing the same symbol: last edit wins the template; the other
  cell re-syncs the next time it opens the symbol. No live cross-cell push.
- `autoSaveTemplates` off: passive autosave stays off, but the synchronous
  capture-on-switch still runs — preservation is non-negotiable.
- Indicator instances are compared by identity signature, so a default-length
  EMA in the cell matches a default-length EMA in the template and is kept
  as-is (id, styling, config untouched).

## Testing

- Unit (vitest): replaceSymbolTemplate add/remove/keep matrix; empty template →
  blank; no template → no-op + fallback precedence; capture-on-switch flushes
  pending debounce; close-flush ordering vs purgeScope.
- Live check: new tab → pick GOLD → full GOLD look (AVWAPs, segments, fib);
  switch away and back → look restored; leftover birth-symbol indicators gone.
