# Favorite Timeframes — Design

**Date:** 2026-07-04
**Status:** Approved (design), pending implementation plan

## Goal

Let the user add any timeframe to the chart's quick-access timeframe bar, TradingView-style
— but without a star toggle. The quick bar shows the fixed default set **merged** with the
user's favorites, sorted by duration.

## Current behavior (for reference)

- `frontend/src/lib/feed.ts` defines the timeframe model:
  - `PERIODS` — the 8 native quick-bar resolutions (`1m 5m 15m 30m 1H 4H 1D 1W`).
  - `DERIVED_PERIODS` (module-private) — `2W 3W 6W 1M 2M 3M 1Y`.
  - `SECONDS_PERIODS` (module-private) — `1s 5s 10s 15s 30s 45s`, all `liveOnly`.
  - `PERIOD_GROUPS` — the grouped dropdown (Seconds/Minutes/Hours/Days/Weeks/Months/Years).
  - `RESOLUTION_SECONDS` — every resolution → seconds (already covers all of the above).
- `frontend/src/Toolbar.tsx`:
  - Quick bar renders a **fixed** `PERIODS.map(...)` (lines ~438–447).
  - An "extra-period chip" surfaces the active TF when it isn't on the quick bar (~450–458).
  - The chevron opens the grouped `PERIOD_GROUPS` dropdown (~460–492).
- Selected resolution is per-cell (`period: Period` on each cell), persisted inside the
  tabs blob. **Unchanged by this feature.**

## Design

### Two sets of timeframes

- **Defaults (fixed):** the existing `PERIODS` (`1m 5m 15m 30m 1H 4H 1D 1W`). Always present,
  never removable.
- **Favorites (additive):** any other resolution the user pins — seconds, derived, or in
  principle any resolution in the model. Stored **globally** (same as indicator/drawing
  favorites), so every chart cell and tab shows the same quick bar.

### The quick bar

Renders the **union** of defaults + favorites, **sorted ascending by `RESOLUTION_SECONDS`**.
A pinned `30s` lands before `1m`; a pinned `2W` lands after `1W`. Active-TF highlight and
click-to-select behavior are unchanged.

The existing "extra-period chip" stays for the transient case where the *active* TF is
neither a default nor a favorite (e.g. the user picked `5s` from the dropdown without pinning
it) — it keeps that selection visible next to the chevron.

### Add / remove — right-click (no stars, no extra chrome)

- **Right-click a timeframe row in the dropdown** →
  - "Add to quick bar" if not a favorite, or
  - "Remove from quick bar" if it is a favorite.
  - Default resolutions (`PERIODS`) show no such item — they're always on the bar.
- **Right-click a favorite's button in the quick bar** → "Remove from quick bar".
  - Default buttons (`1m`–`1W`) have no context action.

Left-click behavior everywhere is unchanged (selects the interval). The context menu is a
small, dismiss-on-outside-click popover consistent with the app's existing menu styling
(no shadows, content-sized, TV-flat — per the app's UX conventions).

### Persistence

Add to `frontend/src/lib/persist.ts`, mirroring `loadFavoriteIndicators`/`saveFavoriteDrawings`:

```ts
const FAVORITE_RESOLUTIONS_KEY = `${PREFIX}.favoriteResolutions`;
export function loadFavoriteResolutions(): string[] {
  return load<string[]>(FAVORITE_RESOLUTIONS_KEY, []);
}
export function saveFavoriteResolutions(list: string[]): void {
  save(FAVORITE_RESOLUTIONS_KEY, list);
}
```

Stored as an ordered list of resolution keys (e.g. `["SECOND_30", "WEEK_2"]`). Empty by
default → no visible change until the user pins something. Display order does **not** depend
on this list's order (the bar always sorts by duration); the list is just the set of pins.

### feed.ts helper

Export a lookup so the Toolbar can resolve a favorite resolution key → `Period` and build the
sorted bar. Add (and export where needed):

```ts
export const ALL_PERIODS: Period[] = [...SECONDS_PERIODS, ...PERIODS, ...DERIVED_PERIODS];
const PERIOD_BY_RESOLUTION = new Map(ALL_PERIODS.map((p) => [p.resolution, p]));
export function periodByResolution(resolution: string): Period | undefined {
  return PERIOD_BY_RESOLUTION.get(resolution);
}
// Build the merged, duration-sorted quick bar from the default set + favorite keys.
export function quickBarPeriods(favoriteResolutions: string[]): Period[] {
  const set = new Map(PERIODS.map((p) => [p.resolution, p]));
  for (const r of favoriteResolutions) {
    const p = periodByResolution(r);
    if (p) set.set(r, p);
  }
  return [...set.values()].sort(
    (a, b) => (RESOLUTION_SECONDS[a.resolution] ?? 0) - (RESOLUTION_SECONDS[b.resolution] ?? 0),
  );
}
```

(`SECONDS_PERIODS`/`DERIVED_PERIODS` become part of the exported `ALL_PERIODS`; they can stay
otherwise module-private.)

### Toolbar.tsx wiring

- Hold `favoriteResolutions` state, seeded from `loadFavoriteResolutions()`; every mutation
  calls `saveFavoriteResolutions(next)` and updates state.
- Replace the fixed `PERIODS.map(...)` with `quickBarPeriods(favoriteResolutions).map(...)`.
  The extra-period chip's guard must key off this merged bar (`quickBar.every(...)`), not the
  raw `PERIODS`, so a pinned-and-active TF shows as a bar button rather than the chip.
- A default resolution is one in `PERIODS` — used to decide whether a bar button / dropdown row
  offers "Remove"/"Add".
- Add the right-click context menu: track the target resolution + anchor position; render a
  small popover; add/remove toggles the favorites list. Dismiss on outside click / Esc.

## Scope

Frontend only. No backend changes — every favoritable resolution is already a resolution the
chart and backend support. Touched files:

- `frontend/src/lib/feed.ts` — exports + `quickBarPeriods`/`periodByResolution` helpers.
- `frontend/src/lib/persist.ts` — `load/saveFavoriteResolutions`.
- `frontend/src/Toolbar.tsx` — merged sorted bar + right-click context menu.

## Non-goals (YAGNI)

- No drag-to-reorder of the bar (order is always by duration).
- No per-cell or per-symbol favorites (global only).
- No import/export or presets of favorite sets.
- No removing the default `1m`–`1W` set.

## Testing

- Unit: `quickBarPeriods` — empty favorites returns `PERIODS` unchanged; adding `SECOND_30`
  places it first; adding `WEEK_2` places it after `WEEK`; unknown/duplicate keys are ignored;
  a favorite equal to a default doesn't duplicate.
- Component/e2e (if the repo's chart e2e setup covers the toolbar): pin via right-click →
  button appears in sorted position and persists across reload; remove → button disappears;
  default buttons offer no remove.
