# Backtest presets — known limitations and follow-ups

**Date:** 2026-08-06
**Branch:** `feat/backtest-presets`
**Spec:** `2026-08-06-backtest-presets-design.md`

Everything here was found during implementation review, triaged, and
deliberately deferred. None of it blocks the feature. Recorded so the decisions
are not rediscovered from scratch.

## Design-level

**A run that starts on one config can attach to another.** The capture effect
gates on `dirty` at completion time. If a run starts on config A, the user edits
to B and *Saves* before it finishes, A's numbers attach to B. Detecting it needs
a config snapshot taken when the run is submitted, not just the clean check at
publish. Requires the user to edit and save inside a single run's duration.

**Load is only guarded when a preset is active.** With no active preset, Load
still replaces a hand-built config instantly, no confirm and no undo — and
`saveBacktestLastUsed` overwrites the only copy. The spec's problem statement
lists destructive Load as a motivating defect; the fix covers only the
active-preset case.

## Accessibility

The library table is a `div` grid. The malformed `role="table"`/`role="row"`
attributes were removed (announcing a table with zero columns is worse than
plain text), but real table semantics were not built. The `⋯` row menu has no
`role="menu"`, no focus management, no Escape, and no outside-click dismissal.
The native `<select>` this replaced was keyboard-complete, so this is a genuine
regression in that one dimension.

## Styling

`.ghost` is defined only as `.toolbar button.ghost` and `.modal-foot .ghost`,
and there is no base `button {}` rule. Every `className="ghost"` button in the
backtest config panel — including the whole Presets tab — therefore renders with
UA-default chrome. **Pre-existing, not introduced by this branch** (the old
presets UI had the same problem), but now more visible given how many buttons
the tab has.

A menu opened on the bottom-most table row extends into `.bt-body`'s scroll
region rather than escaping the panel, because `.bt-body` sets `overflow-y:
auto` (which computes `overflow-x` to `auto` too). It stays reachable — the
go-live row and footer sit below the table — but a flip-up placement would be
better.

## Robustness

- `loadPresets()` does not sanitize. The invariant is "cleaned on entry" (via
  `parsePresets`), not "cleaned on read", so pre-existing garbage hand-written
  into localStorage bypasses the guards. v3 is a new key whose only writer is
  this app, so this is reachable only by hand-editing storage.
- `isConfigShaped` is structural, not exhaustive: it rejects `{}`, arrays and
  truncated files, but does not re-validate optional fields that already have
  guarded reads.
- The publish/bump pairing in `BacktestButton.tsx` is **positional**: the
  capture effect reads `backtestResultSignal.value` at flush time, so the bump
  and the payload are paired only by the two statements being adjacent with
  nothing awaiting between them. Inserting an `await` there would silently
  mispair. There is no `BacktestButton.test.tsx` to catch it, so the audit that
  sweeps and walk-forward never bump the counter is inspection-verified only.
- `RecurrenceMask.daysOfWeek` / `monthsOfYear` / `daysOfMonth` are semantically
  sets but compare order-sensitively in `backtestConfigEquals` (arrays are
  deliberately not sorted, because rule order *is* meaningful). A pure reorder
  would read as "edited". Not reachable through the UI.
- `NaN` in a cost field would strand the dirty flag on permanently — `canonical`
  maps it to `"null"` while the storage round-trip maps it to JSON `null`, which
  `normalizeBacktestConfig` then replaces with the default. Traced unreachable:
  every `??`-defaulted cost field is gated by `cleanNumInput` or `NumberField`'s
  `Number.isFinite` check. The guard, if ever wanted, belongs in
  `normalizeBacktestConfig`.

## Consistency

Three confirmation mechanisms coexist: `window.confirm` for the destructive
operations, an inline three-way row for load-while-dirty, and the inline naming
row. `PresetsTab`'s own comment argues that a browser dialog "cannot be styled,
tested, or cancelled predictably" — an objection that applies equally to the
`window.confirm` calls. Revert and Discard-&-load ask the same "you'll lose your
edits" question two different ways.

## Not done

The final review's CSS fix (`overflow: visible` on `.bt-preset-cell.actions`,
which unclips the row action menu) is reasoned from the cascade only. **No
browser has rendered this UI.** jsdom does no layout, so no test in the stack
can observe paint. Confirm the `⋯` menu is visible and its items clickable
before trusting the row actions.
