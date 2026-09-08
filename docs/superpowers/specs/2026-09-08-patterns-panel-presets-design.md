# Patterns panel extension: preset pattern search — design

Status: design approved section-by-section in session (backend, panel
restructure, result interaction, testing). Next step: implementation plan
(writing-plans).

## Summary

The Patterns feature grows from one function (similarity search over a
selected range) to two. The toolbar button opens a panel instead of arming
the range selector; the panel hosts the existing similarity search plus a
new preset-pattern search: a library of common chart patterns (head &
shoulders, double top/bottom, broadening/megaphone, triangles/wedges)
scanned across all open charts, each at its own timeframe, reporting both
forming and completed instances with literature-derived stats.

Approach C (user-approved): a rule-based pivot grammar DETECTS (structural
correctness, forming/completed classification), the shipped similarity
machinery (multires + envelope-divergence vs a family archetype) RANKS the
survivors. One engine vocabulary across both panel functions.

## Decisions (user-approved)

- Toolbar "Patterns" button opens the side panel; the range selector is
  armed by an explicit control inside the panel — two clicks is fine.
- Preset scan finds BOTH forming (in-progress, at the live edge) and
  completed instances from day one; each result badged.
- Each open chart is scanned at its own timeframe only.
- v1 preset families (each one pivot grammar covering variants/directions):
  Head & Shoulders (+inverse), double top/bottom, broadening/megaphone
  family, triangles & wedges.
- Per-family tunable parameters, schema-driven; UI shows a simple
  strictness control by default with the full set under a collapsed
  "Advanced" expander.
- "Save selection as preset" in v1: a chart range selection can be saved as
  a named user preset that appears in the preset list alongside the
  built-in families and scans across open charts like they do.

## Backend design

New core module `auto_trader/core/pattern_presets.py`:

- Scale-aware pivots: one zigzag pass per series via the `_zigzag_pivots`
  engine in pattern_shape.py, reversal threshold = k * ATR at 2-3 k values
  (catches 40-bar and 200-bar instances).
- Grammar per family over the pivot sequence (fast: hundreds of pivots, not
  thousands of bars). Emits instance = {region, family, variant,
  forming|completed}. Completed = final pivot confirmed + defining line
  broken; forming = grammar prefix satisfied, last leg open at right edge.
- Ranking: multires + envelope-divergence distance vs family archetype
  (knot-path archetypes, as in scripts/pattern_bench/planting.py).
- Stats per instance from a static Bulkowski table: breakout-direction
  prior, measure-rule target; partial-rise/decline status for forming
  broadening instances (80%-reliable breakout tell per thepatternsite.com
  rabfa page).
- Detector callable headless (no UI dependency) so the alert engine can
  drive it later.

User presets (saved selections): stored server-side so scans work headless
— CRUD at `/api/patterns/presets` (create with name + the selection's OHLC
bars + source epic/resolution, list, rename, delete), persisted in the
backend's sqlite alongside the candle/pattern stores. A user preset has no
grammar: scanning it runs the existing similarity machinery per chart with
the saved bars as the query (the all-charts similarity scope, driven from
the scan endpoint). Its tunable schema is just the shared strictness knob.
Forming/completed badge: a hit whose window touches a chart's live edge is
badged forming, else completed — no prefix grammar in v1. `families` in
the scan body accepts `user:<preset-id>` entries next to built-in family
names.

Per-family tunable parameters: each grammar declares its tunables as a
self-describing schema (name, type, min/max, default, one-line help — same
idiom as the agent-bridge action manifest). Defaults come from the
literature (e.g. Bulkowski's 3+2 touches for broadening). Families share
three generic knobs: pivot sensitivity (k in k×ATR), min/max instance
length in bars, match strictness (max similarity distance vs the archetype
before a hit is dropped). Family-specific knobs: H&S shoulder symmetry /
head prominence / neckline slope tolerance; double top/bottom peak-equality
tolerance / min valley depth; broadening min touches per line / min
divergence rate; triangles min convergence rate / min touches per side /
apex proximity for "forming". The frontend renders controls generically
from the schema, so new knobs never touch panel code.

Endpoint `POST /api/patterns/scan`: body {charts: [{epic, resolution,
broker}], families: [{family, params: {...}}]} — the FRONTEND supplies the
open-tab list; params are validated against the family schema, defaults
fill anything omitted. Response grouped per chart with per-chart status
(ok / no stored history / too few bars) so silence is never ambiguous. One
scan in flight at a time (backtest/sweep convention). Series via the
existing PATTERN_SERIES sqlite cache, bounded concurrency.

## Panel restructure

Toolbar: the Patterns button becomes a panel toggle — it flips an `open`
flag in `patternPanelStore` instead of arming the range selector. Lit state
means "panel open". The pattern-copy tool in the draw sidebar is untouched.
The panel can now be open with no results (drops the render-only-with-
results gate); ✕ and the toolbar toggle both close it; the
replay-hides-panel rule stays as is.

Two functions, one panel — a segmented switcher at the top: **Similar** and
**Presets**.

- **Similar**: today's panel plus a "Select range on chart" button at the
  top that arms `patternRangeArmed` (the signal the toolbar used to set).
  While armed the button shows an active state and a hint; completing the
  selection runs the search and fills the results below, unchanged (mode
  chips, forward-bars, scope, jump/copy rows).
- **Presets**: family list as cards with a tiny archetype glyph (pick by
  eye, not name), multi-selectable; user presets listed in their own group
  below the built-ins (glyph drawn from the saved bars' close path), with
  rename/delete on the card; per selected family a strictness control plus
  the collapsed Advanced expander rendered from the backend's parameter
  schema; a **Scan open charts** button collecting the same chart
  enumeration the all-charts similarity scope uses (`getPatternSeries` in
  App) and posting to `/api/patterns/scan`. One scan in flight; the button
  becomes Cancel while running, with a per-chart progress line.

Saving a preset: in the Similar view, a "Save as preset" action next to the
selection (available once a range is selected or a search has run) prompts
for a name and POSTs the selection's bars to `/api/patterns/presets`; the
new preset appears in the Presets view immediately.

State: both functions live in `patternPanelStore` side by side — a preset
scan doesn't discard similarity results or vice versa; the segment just
switches which result set is displayed. Preset results survive tab switches
like similarity results do.

Components: `WorkspacePatternPanel.tsx` stays the host/dock layer; the
segment switcher and Presets view go in the panel component layer —
`PatternMatchesPanel` refactored into a `PatternPanel` with two subviews
rather than growing the 571-line file.

## Preset results and interaction

Rows grouped by chart: group header (EPIC · resolution, hit count); charts
with no stored history or too few bars get a muted one-line warning, never
silence. Each hit row shows:

- **forming / completed** badge — forming rows amber-ish and sorted first
  within their chart, completed below.
- Family + variant name ("H&S inverse", "megaphone, ascending").
- Date range and bar count of the instance.
- Compact stats line from the Bulkowski table: breakout-direction prior
  ("55% up"), measure-rule target computed from the instance's own
  geometry; for forming broadening instances the partial-rise/decline tell
  when present ("partial decline → 80% up"). An InfoTip cites the source.
- Match-quality score (similarity distance vs the archetype, same 0–100
  style as similarity results — one vocabulary).

Click-through reuses the existing jump machinery (`patternTargets` registry
+ `setPendingPatternJump` for cross-tab): activate tab, focus cell, scroll
the window into view, flash an ephemeral highlight band (same band
mechanism as similarity matches, not a persistent drawing). Dismissing the
panel clears bands everywhere.

Bridging: each preset row gets "find similar" — the hit's bars become the
query for the existing similarity search (origin credited to the found
chart). Rows keep the copy-as-ghost action via the shared row component.

Deferred, designed-for: alert hooks ("notify when a megaphone forms") —
the headless detector means the alert engine can call it later without
rework.

## Testing

- Backend: per-grammar unit tests on constructed pivot sequences —
  canonical accepts, near-miss rejects (H&S with head below shoulders,
  broadening with parallel lines), forming/completed boundary cases. One
  planted bench-style case per family (archetype instances + lookalike
  decoys planted into a real series, asserting found/not-found and rank —
  same discipline as pattern_bench). Param-schema validation tests
  (out-of-range rejected, defaults filled). Preset CRUD round-trip tests
  plus a scan test with a `user:<id>` entry (forming badge at the live
  edge, unknown id rejected cleanly).
- Frontend: extend the existing PatternMatchesPanel/WorkspacePatternPanel
  test pattern — segment switch preserves both result sets, toolbar toggles
  open (not arm), select-range button arms the signal, preset rows badge
  and sort forming first, jump and find-similar wire through, no-history
  warnings render, save-as-preset posts and the new card appears.
- End-to-end probe: `scripts/pattern_scan_probe.py` in the style of
  alert_probe/snapshot_probe — posts a scan for fixture charts, prints
  per-chart results, verifiable headless.

## Context from the same arc (already shipped, committed)

- `envelope_divergence_distance` in pattern_shape.py (weight 0.2), light
  3-bar kernel pivots; commits cb221c97, fc6af4be, e6889ef9.
- Bench case `expanding-tops` (human-labelled) in scripts/pattern_bench.
- Known open gap: stage-one scan suppresses a full-length match when a
  shorter sub-window scores better (INTC case unfindable).
- Research notes: thepatternsite.com/rabfa.html (RABFA: 55% up breakouts,
  partial decline 80% predictive), bt.html, abw.html; Lo-Mamaysky-Wang 2000
  (kernel-smoothed extrema grammar, academically validated).
