# Explicit Backtest / Sweep mode — design

Date: 2026-07-16
Status: approved

## Problem

Backtest and sweep share one results region in `BacktestSettingsModal.tsx`, selected by
`sweepState ? <SweepResults/> : <BacktestPanel/>`. There is no mode concept: the mere
existence of sweep results is the mode. Running a plain backtest after a sweep writes to
`backtestResultSignal` but stays hidden behind the still-non-null `sweepStateSignal`, so
the user must "Clear results" to get back to the backtest view. The Run button also
silently becomes a sweep whenever any axis toggle is on.

## Decision (user-approved)

Add an explicit Backtest / Sweep mode. Keep sweep axis setup inline where it is.
Results view follows the mode.

## Design

**Mode state.** New `backtestModeSignal: "backtest" | "sweep"` in `lib/signals.ts`,
persisted device-local. Replaces the implicit `sweepState !== null` view rule.
On modal open, if a running sweep job re-attaches, mode initializes to `sweep`;
otherwise restore last-used mode (default `backtest`).

**Mode switch UI.** Segmented control `[ Backtest | Sweep ]` in the footer, next to
Inspect. The Sweep segment carries a small badge: progress while a sweep runs (visible
even in Backtest mode), else the configured combo count when in Backtest mode.

**Stable footer (added during implementation).** The footer layout is pinned so mode
flips never reflow it: Inspect + mode switch on the left, Close / Go live / Run on the
right, and the variable sweep info (combo counter, estimate, compute toggle) in an
always-present flexible middle slot that ellipsizes the counter when space runs out.
The Run button has a min-width so its label swap doesn't shift its neighbours. The
"Sweep off" footer button was removed as redundant with the mode switch.

**Run behavior.** `BacktestButton` branches on the mode signal instead of "axes exist":
- Backtest mode: always a single backtest; axes ignored.
- Sweep mode: sweeps the configured axes; Run disabled with a hint when no axes are on.

**Config area.** Axis toggles stay inline. In Backtest mode the config renders as if no
axes exist: swept fields show their plain inputs again (the value a single run actually
uses), the inline from/to/step editors hide, and the sweep glyphs render dimmed with
their clicks no-oped (the mode-switch tooltips explain the two modes; no per-glyph
tooltip). Axes and ranges survive mode flips untouched (sweepMemory unchanged).

**Results region.** Ternary becomes `mode === "sweep" ? <SweepResults/> : <BacktestPanel/>`.
Both result signals stay populated independently; flipping the switch flips the view with
nothing cleared. Sweep "Clear results" remains, but is purely "reset the sweep table" —
never a prerequisite for seeing backtest results.

**Apply combo.** Applying a combo from the sweep table copies the params, flips mode to
`backtest`, and runs the backtest; the sweep table stays intact under the Sweep segment.

**Testing.** Unit tests for mode-gated run branching and the apply-combo mode flip;
a render check that the results region honors the mode signal with both result sets
populated.

No backend changes; sweep job / remote-compute plumbing untouched.
