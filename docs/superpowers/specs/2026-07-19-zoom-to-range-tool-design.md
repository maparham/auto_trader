# Zoom-to-range tool — design

Date: 2026-07-19
Status: approved (chat), pending spec review

## Purpose

A toolbar tool that lets the user marquee a time range on the chart and, on
release, drop one timeframe lower centered on that range. The drawn band stays
visible as a marker until the user clicks away. Use case: spot an interesting
stretch on 4H, sweep across it, and land on 1H centered there to inspect the
detail — without manually changing the timeframe and scrolling.

## Interaction

- **Arm**: a "Zoom to range" button in the left `DrawSidebar`, next to
  Measure/Slope. Backed by a `zoomRangeArmed` Signal on the controller, mirroring
  the existing `measureArmed`/`slopeArmed` arming pattern (optional-chain
  HMR-safe subscribe, focus the chart wrap on arm).
- **Single-shot**: arm → one drag → auto-disarm. Esc disarms and cancels an
  in-progress drag. (No sticky mode, matching Measure.)
- **Draw**: while armed, mousedown + drag on the candle pane draws a live
  full-height translucent vertical band between the start and current cursor
  time. Visual reuse of the existing `rangeBand` painter (polygon over
  `bounding.height`, y ignored).
- **Release**: completes the gesture (see below).
- **Dismiss the band**: next chart click-away, Esc, a manual timeframe/epic
  change, or a page reload. Not persisted.

## Zoom semantics (the key decision)

**Keep center; the drag width picks the midpoint only.** On release:

1. Compute the drag's time interval `[startTs, endTs)` from the two bar
   boundaries at the current TF; normalize left-drags so `start < end`.
2. `midTs = round((startTs + endTs) / 2)`.
3. Target TF = one step **lower** on the user's *enabled* quick-bar ladder.
4. Switch to the target TF and center the view on `midTs`, using the target
   TF's **natural bar spacing** — the drawn range is NOT fit to the viewport
   width. The band therefore appears as a marked sliver near screen center at
   the new, finer TF.

This deliberately reuses the existing keep-centered-across-TF-change flow rather
than a fit-to-range zoom. Width is used only to derive the midpoint. (Confirmed
in chat over the fit-range alternative.)

**At the TF floor** (already on the lowest enabled TF): no TF change; just
recenter the current view on `midTs`. The band is still drawn.

## Implementation

Model: `ChartCore.onBacktestDrillIn` (`ChartCore.tsx:498`) already does the
sibling operation — change resolution, park a pending view target, call
`onPeriod`, and let the data-load effect apply the target once the new-TF bars
land. The zoom tool is a **keep-center twin** of it: a pending *center* instead
of a pending *range fit*.

### Trigger — `onZoomToRange(startTs, endTs)` in ChartCore

- `onFocus(cellId)`.
- Normalize; `midTs = (start+end)/2`.
- `target = oneTfLower(period.resolution, enabledResolutions)`.
- If `target == null` (at floor) **or** `target.resolution === period.resolution`:
  `scrollTsToCenter(chart, midTs)` immediately (no reload). Redraw the band from
  `[startTs, endTs]`. Return.
- Else: set `pendingCenterRef.current = { resolution: target.resolution,
  centerTs: midTs, epic: symbol.epic, broker: brokerId, side: priceSide,
  bandStartTs: startTs, bandEndTs: endTs }`, then `onPeriod(cellId, target)`.

`pendingCenterRef` is a new ref alongside the existing `pendingRangeRef`, carried
into `useLiveMarketData` the same way.

### Consume — `useLiveMarketData`

The center flow (`useLiveMarketData.ts:206`) computes
`centerTargetTs = keepCenter && priorCenterTs != null ? priorCenterTs :
(restoreView?.centerTs ?? null)`. Extend it: **if `pendingCenterRef` is set and
its `resolution` matches the loaded `period.resolution`, use
`centerTargetTs = pendingCenterRef.centerTs` unconditionally** — independent of
`keepCenter` and of `loadSettings().resetViewOnTimeframeChange` (the pending
center is an explicit user intent that must win even when reset-on-TF is on).

- The existing pre-paint `scrollTsToCenter(chart, centerTargetTs)` (line 220)
  and the post-load re-center (lines 399 / 610) then land the view on `midTs`
  with no extra code.
- After the load settles, **redraw the transient band** from
  `pendingCenterRef.bandStartTs/bandEndTs`, then clear `pendingCenterRef`.
- Guard against a stale ref: an epic change or a resolution mismatch clears it
  without applying (same shape as the `pendingRangeRef` staleness bail at
  `useLiveMarketData.ts:297`).

### The band — transient, timestamp-anchored

- A transient overlay kind (a `zoomBand`, or the existing transient-band
  machinery) driven in `OverlayManager` next to the `rangeBand` drive logic
  (`overlays.ts:1277`). Two points stored as **timestamps** (not bar indices),
  full-height, y ignored.
- `startZoomBand` / `updateZoomBand` on drag, `finalizeZoomBand` on mouseup.
- `drawZoomBandFromTs(startTs, endTs)` — recreates the band from timestamps
  after a reload. Because the tool only ever moves to a **finer** TF (or stays),
  both edges fall on bar boundaries at the new TF, so no off-grid fractional-x
  decode is required (unlike the coarser-direction case in the time-range
  highlight design).
- `clearZoomBand()` — called on dismiss triggers.
- Excluded from persistence and from the selectable-drawings set, exactly like
  `measure`/`rangeBand`/`slope` (`overlays.ts:748`, `:2274`).

### Armed mousedown wiring

Reuse the site where Measure's armed drag is handled (the measure/rangeBand
pointer path, `chart/useLineDrag.ts` / `ChartCore`): when `zoomRangeArmed`, the
next mousedown starts the band drag instead of a normal chart interaction, and
mouseup calls `onZoomToRange`. Auto-disarm the signal on completion.

### TF ladder helper

`oneTfLower(currentResolution, enabledResolutions)`: from the ordered list of
the user's *enabled* quick-bar periods, return the entry immediately finer than
`currentResolution`, or `null` at the floor. Pure function, unit-testable.

## Error handling / edge cases

- **Pure click, negligible drag (<~3px)**: cancel — no zoom, no band, disarm.
  A range needs a width. (Matches `rangeBand` min-drag.)
- **Left drag** (`end < start`): normalize before computing midpoint.
- **TF floor**: recenter only, no TF change; band still drawn.
- **Manual TF/epic change while band showing**: band cleared (transient).
- **`resetViewOnTimeframeChange` on**: pending center still wins (explicit
  intent).
- **Reload**: band gone (session-only); no persistence, no migration.

## Testing

- **Unit (vitest, node env, existing klinecharts-enum mock)**:
  - `oneTfLower`: steps down the enabled ladder; returns `null` at the floor;
    ignores disabled periods.
  - Midpoint math: normalize left-drag; `mid = (start+end)/2`.
  - Min-drag threshold: sub-threshold drag → cancel.
- **Manual**:
  - Draw a range on 4H → lands on 1H centered on the band midpoint; band visible
    as a sliver.
  - Click away → band gone. Esc mid-drag → cancels.
  - On the lowest enabled TF → stays on it, recenters; band drawn.
  - `resetViewOnTimeframeChange` on → still centers on the range.
  - Reload → band gone.

## Out of scope (YAGNI)

- Fit-the-range-to-viewport zoom (the rejected alternative).
- Multi-step drop (more than one TF lower).
- Persisting the band or making it selectable/editable (that is the separate
  Time-range highlight drawing tool).
- Price/vertical zoom (time range only).
