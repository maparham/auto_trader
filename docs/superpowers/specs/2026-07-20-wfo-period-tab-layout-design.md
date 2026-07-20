# Walk-forward Period tab layout redesign

Date: 2026-07-20
Scope: `frontend/src/BacktestSettingsModal.tsx` (Period tab, walk-forward branch),
`frontend/src/WfoConfig.tsx`, `frontend/src/App.css`.

## Problem

In walk-forward (WFO) mode the Period tab stacks three loosely-related blocks
in one scroll section:

1. The shared Time-range row: mode seg (`Bars/Day/Week/Month/Year/Custom`),
   Timeframe, Windows, Holdout.
2. `WfoConfig` (Train / Test + Rolling·Anchored / Objective + Best·Plateau /
   Advanced).
3. The calendar preset chips (`YTD/2025/2024…`) + resolved date label.

Issues:

- **Stranded chips.** The calendar chips render *after* `WfoConfig` in source
  order, so in WFO mode the schedule block wedges between the range-mode row and
  the chips, pushing the chips to the bottom, away from the range controls they
  belong to. (In normal mode they sit directly under the range row.)
- **Dead control.** The **Windows** input (`cfg.robustWindows`) is never read by
  the WFO payload builder (`frontend/src/lib/wfo.ts` does not reference it) — it
  is inert in walk-forward mode.
- **No grouping.** Train/Test/Objective read as disconnected rows rather than a
  named schedule group.
- **Buried range.** The editable from/to range only appears in `custom` mode;
  in relative/preset modes the user sees chips + a text label but cannot see or
  hand-edit the actual window.

## Goals

Restructure the WFO Period tab into two named sections and make the from/to
range the always-visible source of truth. Normal and sweep modes are unchanged.

## Design

The WFO branch of the Period `<section>` renders two flat `Section`-style groups
(house pattern: uppercase title + info tooltip, hairline top-border divider, no
shadow — matches existing `Section` component and UX conventions).

### Section 1 — "Data window"

Always-visible controls (top row):

- **From/To range picker** — the two `datetime-local` inputs plus the
  "pick range on chart" button that today only render under
  `cfg.range.mode === "custom"`. Always shown and editable in WFO mode. This is
  the source of truth for the window.
  - When the active fill is a relative preset, the inputs display the *resolved*
    rolling values from `resolveWindow(cfg, resSeconds, Date.now())`.
  - Hand-editing either input sets `mode: "custom"` with a fixed `fromMs`/`toMs`
    (existing `setRange` behavior).
- **Timeframe** select — kept alongside From/To (existing `bt-tf-select`).
- **Holdout** select — kept, unchanged in behavior and wiring. (Corrected from an
  earlier draft: Holdout is the out-of-sample lockbox, not part of the range
  picker; it simply stays.)

Quick-fill chips (fill From/To above):

- Relative row: `1D · 1W · 1M · 1Y` — **rolling**. Selecting one sets the
  corresponding relative `mode` (`lastDay/lastWeek/lastMonth/lastYear`) so the
  window tracks *now*, exactly as today.
- Calendar row: `YTD · 2025 · 2024 · 2023 · 2022 · 2021` — **fixed**. Selecting
  one writes an absolute `fromMs`/`toMs` via `buildRangeChips("year", …)`
  (mode becomes/stays `custom` for the fixed anchor), exactly as today.
- A chip is shown active when its resolved range equals the current window
  (relative modes) or its `fromMs`/`toMs` equal the current window (calendar).

Removed in WFO mode only:

- The `Bars/Day/Week/Month/Year/Custom` **mode seg** — the always-on From/To
  plus the two chip rows replace it.
- The **Windows** input — inert in WFO (see Problem).
- **Bars** count-mode — a bar-count window is an awkward fit for calendar-based
  folds. Kept intact in normal/sweep.

The standalone resolved-date label (`rangeDateLabel`) is redundant once the
From/To inputs are always visible; it is dropped from the WFO Data window
section. (Any holdout-clamp detail already surfaces through existing
holdout UI.)

### Section 2 — "Schedule"

The existing `WfoConfig` block under its own section header:

- Train `[2w][1m][3m][6m]`
- Test `[1w][2w][1m]` + `[Rolling][Anchored]`
- Objective `[Sharpe▾]` + `[Best][Plateau]`
- `▸ Advanced` (Step)
- Footer `N combos × M scheme(s)` and the dropped-axes note at the bottom of the
  section (already rendered by `WfoConfig`; they move down with it).

`WfoConfig`'s internals are unchanged; it is simply wrapped in the named Schedule
section by the modal.

## Behavioral semantics (rolling vs fixed)

Preserve today's split so saved presets/configs reused later keep their meaning:

- Relative fills (`1D/1W/1M/1Y`) → rolling window, recomputed against
  `Date.now()`.
- Calendar fills (`YTD/2025/…`) → fixed absolute `fromMs`/`toMs`.
- Manual From/To edit → fixed `custom` range.

No silent rolling→frozen conversion.

## Non-goals

- No change to WFO payload construction or backend logic
  (`buildWalkForwardPayload`, `frontend/src/lib/wfo.ts`).
- No change to the normal or sweep Period tab — the shared Time-range block
  keeps its mode seg, Bars mode, Windows, and Holdout there.
- No restyle of chip/segment visuals beyond what the two-section grouping and
  the always-on From/To require.

## Implementation notes

- The Period `<section>` currently renders one `bt-range-mode-row` plus a
  trailing chip row shared by all modes. Split the JSX so:
  - `btMode === "walkforward"` renders the two new sections (Data window,
    Schedule).
  - Otherwise renders today's block unchanged.
  Keep the shared pieces (Timeframe select, Holdout select, From/To inputs,
  chip builders) factored so both branches reuse them rather than duplicating.
- Reuse the existing `Section` component (or its flat CSS) for the two headers.
- New/adjusted CSS in `App.css` under the existing `wfo-*` / `bt-range-*`
  blocks; no shadows, content-sized, per house conventions.
- Tests: extend `WfoConfig.test.tsx` / the modal's period-tab coverage to assert
  (a) From/To inputs render in WFO mode without selecting Custom, (b) a relative
  chip yields a rolling window and a calendar chip a fixed one, (c) Windows and
  the mode seg are absent in WFO mode.
