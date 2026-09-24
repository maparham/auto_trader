# Trendlines debug mode

Date: 2026-09-24

## Goal

A user has a trendline they care about that the current Trendlines settings do
not produce, and cannot tell which settings would. Debug mode shows every
candidate line with the reason it is not drawn, and answers "what is the
smallest settings change that makes the indicator draw my line (or one that
looks the same)?".

## Decisions (from the user)

- Include all of: dimmed candidates with reasons, reverse lookup from the
  user's own line, rejected pivots, failed-a-gate vs outranked, smallest
  verified fix with side-effect count, reason counts, live-window timing,
  cheap on the normal path.
- **No color coding anywhere.** Assume a near color-blind user. Every
  distinction is carried by dash pattern, weight, opacity, glyphs and text.
- **Covered** means the indicator draws a line visually very close to the
  target in both price and time, not necessarily the same anchors (see
  Similarity).
- Works under a timeframe pin in v1.

## Non-negotiables

- The normal calculation path is unchanged. Debug never runs inside the cached
  main session (`createTrendlinesSession`), adds no `calcParams` slot, and
  never touches emitted points. The Python port
  (`backend/auto_trader/indicators/trendlines.py`) is not modified.
- The toggle lives in `extendData` (render-only, like `showPivotDepth`), so it
  does not change the cfg JSON and does not invalidate the main cache.
- No refactor of the seed loop's arithmetic or order. Instrumentation is an
  optional `sink` argument to `stepTrendlinesBar`, `undefined` on the normal
  path; every recording site is guarded by `if (sink)`.

## Architecture

### 1. Reject sink (`lib/indicators/trendlinesDebug.ts`, new)

```ts
type Gate =
  | "fractal" | "size" | "reach" | "window"        // pivot / pairing stage
  | "lookback" | "slopeMax" | "slopeMin" | "backClearance" | "sameBar"
  | "stale" | "liveCap"                            // deleted later
  | "ceiling" | "minTouches" | "minSpan" | "minCrossings" | "distance"
  | "merged" | "perPivot" | "maxLines";            // per bar, at the eval bar

interface Verdict {
  gate: Gate;
  field: keyof TrendlinesConfig | null;  // setting that controls it
  measured: number | null;               // line's value (slope, touches...)
  limit: number | null;                  // current setting
  atBar: number;                         // bar the verdict was taken
}

interface Candidate {
  key: string;            // anchor timestamps, same as lineKey
  line: TrendLine;        // frozen at deletion, or live
  verdicts: Verdict[];    // all failing gates, first one = primary reason
  outrankedBy?: string;   // key of the winning line (merged / perPivot / maxLines)
  liveFrom: number; liveTo: number | null; endedBy?: Gate;
  forced?: boolean;       // came from reverse lookup, not the natural seeder
}

interface TlDebugSink {
  visible: [number, number];      // only record candidates overlapping this
  candidates: Map<string, Candidate>;
  rejectedPivots: { idx: number; kind: PivotKind; gate: "size"|"reach" }[];
  forcedPairs: ForcedPair[];      // reverse lookup input
}
```

Recording sites in `trendlines.ts` (all behind `if (sink)`):

- Size / reach rejects at the pivot stage push to `rejectedPivots`.
- Seed loop: the lookback, slope, back-clearance and same-bar skips record a
  frozen candidate with its verdict instead of silently `continue`-ing.
- Liveness filter and `MAX_LIVE` eviction record `endedBy` and `liveTo`.
- The per-bar gates are NOT recorded per bar. They are evaluated once at the
  evaluation bar (see 2) by calling the existing pure predicates
  (`overCeilings`, `isMajor`, `trendlineGate`, `withinDistance`) on each
  recorded or live line, and `selectLevels` with `depthsOut` to learn
  merged / perPivot / maxLines losers and their winners.

A gate that fails for one reason is also evaluated for all other gates, so
the popup can list every blocker, not just the first.

### 2. Debug run (`runTrendlinesDebug`)

- Input: bars, cfg, visible index range, evaluation bar, forced pairs. The
  evaluation bar is the last bar the draw path reads (the last loaded bar;
  in replay the data list ends at the replay bar, so that is it; under a pin,
  the aligned `lineIdx`).
- Runs a fresh `computeTrendlines`-equivalent loop with the sink on, from the
  same floor the main session uses. Output: `TlDebugResult` (candidates,
  rejected pivots, drawn keys at the eval bar, reason counts).
- Cached per (bars identity, cfg JSON, eval bar, visible range bucketed to
  avoid recompute on every pan pixel, forced pairs). Recompute is scheduled
  off the draw (idle callback), the draw reads the last result.
- Visible cap: candidates whose [i1, liveTo ?? evalBar] does not overlap the
  visible range are not recorded. Hard ceiling of 2000 recorded candidates;
  over it, the most recent win and a "showing 2000 of N" note appears.

### 3. Forced pairs (reverse lookup)

The user's line is usually never tried by the seeder (anchor outside the last
`pairPivots` pool entries and not major, or not a pivot at the current
`pivotLen`). A forced pair bypasses the pivot and pairing-window gates but
records each one it would have failed:

- `fractal`: not a strict fractal at the current Min Length. Also reports the
  largest `pivotLen` at which it IS a fractal (so "Min Length 5 to 3" can be
  offered).
- `size` / `reach`: anchor fails Min Size / Min Reach (measured vs limit).
- `window`: anchor not among the last Max Pairs pivots at the second anchor's
  confirm bar and not in the major tier.

It is then injected at the second anchor's confirm bar and runs through every
later gate like a natural candidate (touch scoring, slope, lookback, back
clearance, liveness, per-bar gates, selection).

### 4. Similarity ("covered")

Target T from two points (t1,p1)-(t2,p2). Candidate L covers T when:

- **Price:** over the bars of T's span where L is defined, max
  |L(x) - T(x)| <= `simPriceAtr` x ATR(14) at x. Default 0.5.
- **Time:** L is defined (between its first anchor and its drawn end) on at
  least `simSpanPct` of T's span. Default 80%.

Both editable in the lookup popup, persisted per indicator in extendData.
Distance score for ordering = max price deviation in ATR, tiebreak span
coverage.

Reverse lookup flow:

1. User arms lookup (popup button, or context menu on a user drawing
   "Debug against Trendlines"), then picks two candles or a trend line drawing.
2. Each point snaps to the nearest bar's high or low (whichever is closer in
   price). The exact pair becomes a forced pair.
3. The debug run returns every candidate (natural or forced) within the
   similarity limits, sorted closest first. If any is drawn at the eval bar:
   "Covered by <line>". Otherwise the list shows each near match with its
   primary blocker.
4. Near-match search also forces pairs between pivots within +/- `pivotLen`
   bars of each snapped anchor (at most 9 extra pairs), so a line one bar off
   the user's click is considered.

### 5. Smallest fix

For a selected candidate, per failing gate, compute the setting value that
lets it pass:

- **Exact (single threshold, pool unchanged):** Max/Min Slope, Min/Max Span,
  Min/Max Touches, touch spacing, Min/Max Crossings, Max Distance, Back
  Clearance, Lookback, Max Projection, Max Trendlines, Max lines per pivot,
  Merge. The needed value is derived from `measured` (e.g. Max Slope >= 1.3),
  rounded to the setting's step in the permissive direction.
- **Pool-changing (verified):** Min Length, Min Size, Min Reach, Max Pairs,
  Major Limit/Length/Size. Candidate values are tried in order of smallest
  change; each is verified by a debug re-run with the proposed cfg, accepted
  only when the target (by similarity, since touches and pairing change) is
  drawn at the eval bar.
- Combined fix: gates are applied cumulatively (exact first, then pool
  changes), and the final combined cfg is verified by one re-run. If
  verification fails the popup says "No settings change found" and shows what
  still blocks after the attempted changes.
- For a target with several near matches, the fix is computed for the top 3
  and the one with the fewest changed settings (then the smallest relative
  change) is offered, naming which near match it draws.
- **Side effect** ("+7 lines, -2 lines" at the eval bar, over the whole
  series): computed on demand by a button, never on popup open.
- **Apply** writes the settings to the indicator (same path the settings form
  uses) and keeps an Undo link in the popup until it closes.

The app has no Web Worker for indicator calcs, so verification and
side-effect runs happen on the main thread in idle chunks (yielding between
chunks of bars), with a spinner in the popup and a cancel when it closes.

### 6. Timeframe pin

`buildTrendlinesMtf` (`lib/mtfCoordinator.ts`) stashes the HTF bars it
computed on (`mtf.htfBars`, session-only like the rest of the stash), and the
debug run replays them with the sink on. Candidates are keyed by
anchor timestamps; the draw maps HTF indices with the existing
`trendlineIdxMap` / `htfExtremeSnap`. Reverse lookup snaps chart-TF clicks to
the HTF bar containing them, then to that bar's high or low.

## Rendering (no color)

All strokes use the indicator's own line color; distinctions are pattern,
weight, opacity and text:

| Thing | Look |
|---|---|
| Drawn line | unchanged |
| Failed a gate | dotted [1,3], width 1, opacity 0.45 |
| Passed all gates, outranked (merged / per pivot / Max Trendlines) | dashed [5,4], width 1, opacity 0.45 |
| Forced (reverse-lookup) candidate | long dash [10,4], width 1.5, opacity 0.7 |
| Selected candidate | solid, width 2, full opacity, existing select glow, end tag with primary reason ("touches 1/2") |
| Winner of a selected outranked candidate | existing select glow + end tag "winner" |
| Rejected pivot | small x glyph with a letter below: S (size), R (reach) |
| Target (user's line) | double stroke (two 1px lines 3px apart) |

Hover on a dimmed candidate uses the existing hover glow. Hit testing reuses
`setTrendlineSegments` / `hitTrendline` with debug segments tagged so a click
selects the candidate, not the drawn line under it (drawn lines win ties).

Reason counts: a small DOM strip at the bottom-left of the chart (the
top-left belongs to the legend), e.g. "Debug: 3 drawn · 41 slope · 112
touches · 9 outranked". Each entry is a toggle button (click hides that
group); hidden groups show their entry struck through. The strip also holds
the "Check a line" button that arms reverse lookup.

## Popup (`TrendlineDebugPopup.tsx`, new)

Anchored popover at the click point (not a side panel, does not claim the
side-panel slot). Short lines, no em dashes, ✓/✗ glyphs, no red/green text.

```
Line  Mar 3 to Apr 18  (natural)
✗ Min Touches      1.5 / 2       → 1.5   [Apply]
✗ Max Slope        1.30 / 1.00   → 1.30  [Apply]
✓ Min Span         45 / 20
Live  Mar 20 to May 2, ended by Max Projection
Apply all  [Apply]    What else changes? [Check]
```

Outranked variant: "Merged into <winner date range>, score 4.5 vs 3" with the
winner glowing on the chart. Lookup variant: list of near matches
("0.2 ATR off, 95% span: blocked by Min Touches") each selectable.

## Settings UI

`indicatorMeta.ts`, Trendlines style tab, next to Show pivot depth:

- "Debug mode" boolean (`extendData.debug`), tip: short lines per the tooltip
  memory rule. SESSION-ONLY: stripped on apply like `selectedLine`, so it
  never reaches alert snapshots, the public demo, templates or pastes, and
  it turns off on reload.
- Similarity limits live in the lookup popup only.

## Testing

- **Parity guard:** emitted points of `computeTrendlines` and the session path
  are deep-equal with the sink on and off on the existing fixtures; the
  Python parity golden still passes untouched.
- Unit tests per recording site: a fixture where a line is rejected by each
  gate records that gate with correct measured/limit.
- Forced pair: a pair outside the Max Pairs window records `window` and still
  gets scored; a non-fractal anchor reports the largest working Min Length.
- Similarity: offset/shortened lines on either side of the limits.
- Fix: exact fixes make the target drawn; a pool-changing fix is only offered
  when the verification re-run draws it.
- MTF: a pinned fixture records candidates keyed by timestamp and maps them
  onto chart bars.
- Visual check through the agent bridge screenshot (dimmed, dashed, selected,
  popup), judged in grayscale.

## Out of scope

- Persisting debug candidates or exporting them.
- Any backend or Python change.
- Debug for indicators other than Trendlines.
