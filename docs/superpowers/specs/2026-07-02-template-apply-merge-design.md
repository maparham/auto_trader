# Template Apply = additive merge

## Problem

Applying a chart template today **replaces** the cell's layout instead of merging into
it, which destroys the user's existing work.

- `applySymbolTemplate` (`frontend/src/lib/templates.ts`) calls `saveIndicators(scope, t.indicators)`
  (whole-list replace) and, with `clearFirst`, removes every current indicator first.
- It also calls `saveDrawings(scope, epic, t.drawings)` unconditionally, then `overlays.rehydrate()`.

Because the code overwrites drawings with `t.drawings` regardless of what the template
holds, two manual paths silently delete the chart's drawings (persisted **and** mirrored
to the backend — irreversible):

1. **"Apply default template"** always — `applyDefaultTemplate` wraps the default in a
   `SymbolTemplate` shell with `drawings: []`, so apply runs `saveDrawings(scope, epic, [])`.
2. **"Apply <symbol> template"** whenever that template was captured while the chart had no
   drawings (`captureSymbolTemplate` stored `drawings: []`).

There is also no existence check anywhere: applying the same template twice, or applying a
template whose indicator/drawing already exists on the chart, duplicates it. Indicator
instance ids are random (`mintInstanceId`) or the bare type name, and drawing ids are
re-minted on every rehydrate, so there is no stored identity to dedup on.

## Goal

Apply must **only ever add what is missing**. It never modifies and never removes an item
that is already on the chart. Applying is idempotent: applying the same template twice adds
nothing the second time.

## Decisions (confirmed with user)

- **Merge, never replace.** `clearFirst` is removed entirely; no apply path wipes.
- **Indicators — additive, existing wins.** For each template indicator, if an equivalent
  one (same type + key params) is already on the chart, **skip it** and leave the existing
  instance completely untouched (its styling wins). Only genuinely-missing indicators are added.
- **Drawings — additive, geometry identity.** A template drawing is a duplicate iff a drawing
  of the same tool type at the same points already exists. Style is ignored for identity.
- **AVWAP** is an indicator whose **anchor timestamp is a key param**: two AVWAPs match only
  if their anchors match. A template AVWAP anchored at a different bar is added as a new one.

## Signatures (computed at apply-time, not stored)

The "dynamic identifier" is a signature computed on the fly from the persisted, authoritative
state (`loadIndicators` / `loadIndicatorConfigs` / `loadDrawings` / `loadAvwapAnchor`). No new
persisted field, no schema change.

### Indicator signature
`type` + normalized identifying inputs:
- `calcParams` normalized to the **effective** value: `cfg.calcParams ?? DEFAULT_CALC_PARAMS[type] ?? []`
  (so a default-length EMA matches another default-length EMA).
- `extendData` **minus the non-identifying keys** `userVisible`, `visibility`, `indType`.
  Everything left is an input (source, offset, MTF timeframe, custom-indicator modes such as
  AVWAP band mode) and counts toward identity. Denylist, not allowlist, so a future input
  field is identity-relevant by default.
- for `type === "AVWAP"`: the anchor timestamp (`loadAvwapAnchor` for existing; `t.avwapAnchors[id]`
  for the template).
- **Excludes** all styling — `styles`/color/width and the `visible` flag are not identity.

### Drawing signature
`name` (tool type) + `points`, with each point's numeric fields rounded to a fixed precision to
absorb float noise. Both the template and the existing drawings come from stored `SavedOverlay`,
so the point encoding is directly comparable. Style, `lock`, `zLevel`, `visible` are excluded.

## Algorithm — `applySymbolTemplate`

1. Build a `Set<string>` of existing indicator signatures from `loadIndicators(scope)` +
   `loadIndicatorConfigs(scope)` (+ `loadAvwapAnchor` for AVWAP instances), and a
   `Set<string>` of existing drawing signatures from `loadDrawings(scope, epic)`.
2. **Indicators:** for each `t.indicators` instance whose signature is NOT in the existing set:
   - mint a **fresh instance id** in the target cell (never reuse the template's id — it may
     collide with an existing instance or the bare type name),
   - write its config under the new id (`saveIndicatorConfig`), and its AVWAP anchor under the
     new id if present (`saveAvwapAnchor`),
   - `applyIndicator(chart, scope, epic, {id:newId, type}, { rehydrate:true, config, forceHidden })`.
   - Matches are skipped (existing instance untouched).
3. Recompute the full indicator list = existing ∪ added → `saveIndicators` + `controller.indicators.set`.
4. **Drawings:** append template drawings whose signature is absent to the existing list (union),
   `saveDrawings(scope, epic, union)`, then `controller.overlays.rehydrate()`.

`applyDefaultTemplate` needs no special-casing: it merges its indicators and, with an empty
drawings list, contributes no drawings — so it never touches existing drawings.

## What does NOT change

- **Capture** (`captureSymbolTemplate`, `captureDefaultTemplate`) — unchanged.
- **Auto-apply** (`maybeAutoApplyTemplate`) — keep the empty-cell gate as-is. On an empty cell
  merge adds everything, identical to today's result. Relaxing the gate would let auto-apply
  re-add staples the user deliberately deleted, so it stays gated.

## Incidentally fixed

- The AVWAP-anchor orphan-leak (removing indicators via `clearFirst` left `avwap.<epic>.<id>`
  keys behind) disappears, because nothing is removed anymore.

## Testing

- Draw a trendline + add EMA(20); Apply a template containing EMA(20) + RSI → the line
  survives, EMA(20) is **not** duplicated, RSI is added.
- Apply the same template twice → the second Apply adds nothing (no duplicate indicators or
  drawings).
- Apply the **default** template onto a chart that has drawings → the drawings survive.
- Template EMA(20) blue applied over an existing EMA(20) red → still one EMA, still red
  (existing styling wins).
- Template AVWAP anchored at bar B applied over an AVWAP anchored at bar A → two AVWAPs.

## Out of scope

- Capturing/persisting the currently-omitted view settings (price-axis log/percent,
  `scalePriceOnly`, `legendCollapsed`). Tracked separately; this spec is purely about making
  Apply non-destructive and duplicate-free.
