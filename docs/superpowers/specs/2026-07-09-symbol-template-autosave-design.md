# Symbol-template auto-save + selectable default-template save

**Date:** 2026-07-09
**Status:** Design approved, ready for planning

## Goal

Stop making users click "Save GOLD template" after every chart edit. Instead,
per-symbol templates **auto-save** in the background, on by default. As a
consequence the Template menu is trimmed, and the deliberate "Save as default
template" action gets a selection modal so the user picks exactly which
indicators become the global default.

## Background (current behavior)

- Per-symbol templates are keyed by epic (per broker): `SymbolTemplate`
  = `{ epic, indicators, indicatorConfigs, drawings, avwapAnchors, savedAt }`,
  stored at `auto-trader.b.<broker>.template.<epic>`
  (`frontend/src/lib/persist/defaults.ts:220`).
- The global default template is symbol-agnostic:
  `DefaultTemplate = { indicators, indicatorConfigs, savedAt }` at
  `auto-trader.defaultTemplate` — **no drawings, no AVWAP anchors**
  (`defaults.ts:259`).
- Capture/apply live in `frontend/src/lib/templates.ts`:
  `captureSymbolTemplate` / `captureDefaultTemplate` read the **persisted**
  per-cell stores (authoritative); `applySymbolTemplate` is an **additive
  merge** onto the target cell (adds what's missing by identity signature, never
  modifies/removes existing). `applyDefaultTemplate` wraps the default in a
  drawings-less shell.
- `maybeAutoApplyTemplate` (`templates.ts:227`) auto-applies to **fresh cells
  only** (cell has zero saved indicators AND zero saved drawings for the epic),
  per-symbol taking precedence over the global default. Called from
  `ChartCore.tsx:3658` after symbol-change hydration.
- The Template dropdown is in `Toolbar.tsx:679`; handlers `saveTemplate` /
  `applyTemplate` / `deleteTemplate` / `saveDefault` / `applyDefault` /
  `clearDefault` at `Toolbar.tsx:308`.
- Drawings persist through `OverlayManager.persist()` (`overlays.ts:2151`, bails
  while `hydrating` / mid symbol-change). Indicators persist through
  `saveIndicators` (`persist/artifacts.ts:101`), called from ~6 sites in
  `Toolbar.tsx` / `ChartCore.tsx` / `templates.ts`. AVWAP anchors via
  `saveAvwapAnchor`; per-id configs via `saveIndicatorConfig`.
- Shared confirmation: `requestConfirm({ title, message, confirmLabel, details,
  onConfirm })` (`lib/signals.ts:66`) drives one `ConfirmDialog` rendered in
  `App.tsx:1841`. `details` is a list of `{ label, value, tone? }` rows.

## Design

### 1. Per-symbol auto-save

**Trigger — one persist-layer change emitter.** Add a lightweight module-level
emitter (e.g. `onLayoutChanged(scope)` / `emitLayoutChanged(scope)`) in the
persist layer. The four authoritative per-cell writes fire it **after** writing:

- `saveIndicators(scope, …)`
- `saveIndicatorConfig(scope, …)`
- `saveDrawings(scope, epic, …)`
- `saveAvwapAnchor(scope, epic, …)`

The emitter only needs `scope` — subscribers own their epic. Do **not** wire the
~6 `saveIndicators` call sites individually; the persist function is the single
chokepoint.

**Subscriber — per cell, in ChartCore.** ChartCore already knows `controller.scope`,
`symbol.epic`, and can read the global enabled flag. It subscribes to
`layoutChanged` for its scope. On a matching change:

1. If auto-save is off → return.
2. Debounce ~800ms (coalesces drags and multi-step edits into one write).
3. `captureSymbolTemplate(scope, epic)`.
4. Signature-compare the capture against the stored template; write via
   `saveSymbolTemplate` **only if it differs** (avoids `savedAt` churn and
   pointless cross-tab echoes). Reuse the existing signature helpers
   (`indicatorSignature` / `drawingSignature`, `lib/templateSignatures.ts`) to
   compare content, ignoring styling-only differences? — No: auto-save must
   persist styling too, so compare the **full serialized payload** (indicators +
   configs + drawings + anchors), not the identity signature. A plain
   deep-equal of the captured vs stored blobs (excluding `savedAt`) is the
   comparison.

**Loop-guard (critical).** The emitter must be **hard-suppressed** during:

- Mount/reload hydration of indicators and drawings.
- `maybeAutoApplyTemplate` and any `applySymbolTemplate` / `applyDefaultTemplate`
  run.

Rationale: indicator hydration and auto-apply both write through
`saveIndicators`; without suppression a transient/empty set during hydration
could overwrite a good template (see empty-save rule below). `overlays.persist()`
already bails on `hydrating`, so drawings are covered there, but the indicator
path is not. Implement suppression with a counter/flag toggled around the
hydrate + auto-apply block (mirror the existing `hydrating` gate). The
deep-equal compare is the backstop, **not** the primary guard.

**Backend persistence (unchanged path).** Auto-save reuses `saveSymbolTemplate`
→ `save()` (`lib/persist/core.ts:243`), which writes localStorage **and**
fire-and-forget mirrors to the backend (`PUT /api/state/<key>`, `core.ts:192`).
No new endpoint. This is exactly why the debounce (~800ms) and the deep-equal
skip are load-bearing, not just polish: without them a single drag or a burst of
edits would spray redundant backend PUTs. Writes never block on the network
(offline → localStorage still holds it; the backend copy syncs back on load) and
`mirrorSet`'s echo-guard already suppresses the round-trip when a value equals
what another tab just pushed.

**Empty capture is saved as an empty template** (NOT deleted). This is what makes
"start fresh" work: a user who manually removes all indicators/drawings from GOLD
auto-saves an empty GOLD template, so fresh GOLD cells open blank. In
`maybeAutoApplyTemplate`, an empty-but-present `SymbolTemplate` is truthy, so it
"applies" (adds nothing) and returns `true` — the global-default fallback is
correctly short-circuited. Consequence to document: once a symbol has any
auto-saved template (even empty), the **global default no longer auto-applies to
that symbol**; the user pulls it back with "Apply default template". This is
consistent (per-symbol overrides default).

**Multi-cell:** if two open cells show the same epic, the last-edited cell's
layout wins (each edit auto-saves that cell's snapshot). No live cross-open-cell
mirroring — removing an indicator does not retroactively strip it from another
already-open GOLD cell. Out of scope, matches the ask ("stop clicking Save").

**Toggle.** One **global** preference `autoSaveTemplates`, default `true` when
absent, persisted like other synced settings (localStorage + backend mirror).
Governs all symbols. Rendered as a checkbox item at the top of the Template
dropdown: `✓ Auto-save templates`.

### 2. Template menu, trimmed

Per-symbol section of the Template dropdown becomes:

```
✓ Auto-save templates       ← new global toggle, default ON
  Apply GOLD template       ← kept: manually merge the saved layout into this cell
```

- **Dropped:** "Save GOLD template" (redundant with auto-save) and "Delete GOLD
  template" (to start fresh, the user clears indicators/drawings on the chart,
  which auto-saves the now-empty template).
- "Apply GOLD template" is retained — still useful to pull the saved layout into
  a cell that has diverged, or into a same-epic cell.
- The **default-template section is unchanged in placement** (Save as / Apply /
  Clear default) but "Save as default" now opens the picker modal (§3).

Remove the now-unused `saveTemplate` / `deleteTemplate` Toolbar handlers and
their menu items.

### 3. "Save as default template" → selectable modal

Clicking **Save as default template** opens a small centered modal — reusing the
existing modal chrome (`modal-backdrop` / `modal` classes, `CloseButton`,
`useCloseOnEscape`), same primitives as `ConfirmDialog`. A checkbox list is
beyond what `ConfirmDialog` should carry, so this is a dedicated component
(e.g. `SaveDefaultTemplateModal.tsx`).

```
Save default template

New charts of any symbol inherit the checked indicators.
Drawings and AVWAP anchors are never included.

  ☑ EMA          length 20
  ☑ RSI          length 14
  ☑ Volume       —
  ☐ MACD         12, 26, 9

        [ Cancel ]   [ Save as default ]
```

- **Rows** = the current cell's **symbol-agnostic** indicators (AVWAP filtered
  out, same as `captureDefaultTemplate` today). Each row: checkbox + readable
  indicator name + key params, via the existing indicator display-name/param
  helper (locate during planning). If any indicators were excluded because they
  are AVWAP, show a small footnote noting so.
- **All checked by default.** "Save as default" disabled when nothing checked.
- On confirm: `captureDefaultTemplate` is scoped to the **selected instance
  ids** only (add an optional `includeIds?: Set<string>` param, or filter its
  result), then `saveDefaultTemplate` writes it.
- Selection is **not** remembered between opens — every save is a fresh pick,
  all-checked.
- **Empty cell** (no symbol-agnostic indicators): modal shows "This chart has no
  indicators to save" with only a Cancel button.

**Wiring.** Follow the existing modal-request-signal pattern: a
`saveDefaultTemplateRequest` signal carries the candidate indicator list + an
`onConfirm(selectedIds)` callback; `App.tsx` renders the modal once, mirroring
how it renders `ConfirmDialog`. (Local Toolbar state is an acceptable
alternative; both are in-repo patterns — planning picks.)

**Per-symbol auto-save stays silent** — no confirm, captures the full set
(indicators + configs + drawings + AVWAP anchors). Only this deliberate global
save is gated + selectable.

## Out of scope

- Additive-merge `applySymbolTemplate` and the fresh-cell auto-apply gate — kept
  as-is (tested, correct).
- Live cross-open-cell mirroring.
- Per-symbol auto-save toggle granularity (toggle is global, not per-epic).

## Testing

- **Auto-save unit tests** (extend `templates.test.ts` / a new
  `autosave.test.ts`): editing indicators/drawings triggers a debounced
  `saveSymbolTemplate`; identical content does not re-write; empty capture writes
  an empty template (not a delete); toggle off suppresses saves.
- **Loop-guard:** mount/reload hydration and `maybeAutoApplyTemplate` do NOT
  trigger a save (assert `saveSymbolTemplate` not called during a simulated
  hydrate + auto-apply).
- **Fresh-cell blank:** a symbol with an empty saved template opens fresh cells
  blank (global default not applied).
- **Default picker:** confirming with a subset writes only the selected
  indicators; deselect-all disables save; empty cell shows the no-indicators
  state.
- **E2E** (extend `symbol-template.spec.ts`): add an EMA → it auto-saves → open a
  fresh same-symbol cell → EMA auto-applies; remove it → fresh cell opens blank.
```
