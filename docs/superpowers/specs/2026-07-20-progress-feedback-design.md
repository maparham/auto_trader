# Progress feedback for backtest, sweep, and walk-forward

**Date:** 2026-07-20
**Status:** Approved design, pending implementation plan

## Goal

Backtest, sweep, and WFO should show a short label saying what they are doing,
**but only where a run can visibly stall with no moving progress bar**. Fast
steps are never labeled. The user only needs to know what is happening when a
run takes a while and nothing else is moving.

## Guiding principle (from the user)

> Progress reports don't have to include steps that are always fast. Keep it
> simple. The user only needs to know what's going on when the run takes too long
> and the progress bar is not moving.

So we label exactly the stall windows that have no other movement indicator, and
nothing else.

## The stall windows (the only labels)

| stage key     | label                       | when it shows | which ops |
|---------------|-----------------------------|---------------|-----------|
| `downloading` | Downloading candles         | frontend candle + HTF fetch (no bar) | all three |
| `submitting`  | Submitting                  | the submit POST (hides sweep/WFO HTF prefetch + probe) | sweep, WFO (local) |
| `uploading`   | Uploading to compute host   | the submit POST on a remote run | sweep, WFO (remote) |
| `engine`      | Running backtest            | the synchronous backtest POST (single run has no bar) | backtest |

Everything else is dropped: no `indicators`, `htf`, `cost`, `enrich`, `saving`,
no per-fold "Testing fold N/M". The sweep/WFO **compute** phases already show a
moving count bar (and WFO its coarse phase), so they need no added label. Once
that moving bar takes over, the stall label is cleared.

## Approved decisions

1. **Frontend only. No backend changes.** No new job, no `stage` fields on the
   job models, no route changes. The synchronous `POST /api/backtest` and the
   existing sweep/WFO submit + poll are untouched.
2. **Backtest is NOT converted to a polled job.** A single frontend-set
   "Running backtest" label around the existing synchronous POST covers that
   stall. (No backtest Cancel button — it would only have existed with a job.)
3. **One status line, driven by one signal.** A `progressStageSignal`
   (`string | null`) is set in `BacktestButton`'s run handler at the stall
   windows and cleared when a moving bar takes over (sweep/WFO first poll) or on
   completion. It renders as a single status line by the Run button, so all
   three operations show the same "Downloading candles" / "Submitting" opening in
   one place.
4. **Remote runs get a distinct label** ("Uploading to compute host"); local
   runs say "Submitting".

## Flow per operation

- **Backtest:** `downloading` (fetch) → `engine` ("Running backtest", around the
  POST) → cleared when the result renders.
- **Sweep:** `downloading` (fetch) → `submitting`/`uploading` (submit POST) →
  cleared on the first poll; the existing count bar (done/total + ETA) takes over.
- **WFO:** `downloading` (fetch) → `submitting`/`uploading` (submit POST) →
  cleared on the first poll; the existing phase label + count bar take over.

## Frontend changes

- **New `lib/progressLabels.ts`**: `stageLabel(stage) => string` for the four
  keys above; unknown/null → "".
- **`lib/signals.ts`**: add `progressStageSignal: Signal<string | null>` (null
  when idle).
- **`BacktestButton.tsx`**: in the shared prep region set `downloading` before
  the candle fetch; in the single-run branch set `engine` before `runAndRender`;
  in the sweep and WFO branches set `submitting`/`uploading` (per
  `sweepTargetSignal`) before the submit, and clear the signal on the first
  poll callback (`onRows` / `onState`) so the moving bar takes over. Clear to
  `null` in the shared `finally`. **No change to `runAndRender`/`runBacktest`** —
  the backtest POST stays synchronous.
- **Status line**: render `stageLabel(progressStageSignal.value)` near the Run
  button whenever it is non-null (a small line, no spinner needed beyond the
  existing running indicator). Reuse existing styles; no new component.

Follow `CLAUDE.md`: any info affordance uses the shared `Tooltip`/`InfoTip`. No
em dashes in end-user copy. Plain, direct labels.

## Testing

- **Frontend unit**: `progressLabels` maps the four keys and returns "" for
  null/unknown.
- **Frontend behavior**: a small test that the run handler sets the expected
  stage sequence for a single backtest (`downloading` → `engine` → cleared),
  mocking the fetch + `runBacktest`. Reuse the existing `BacktestButton`/`lib`
  test harness if one exists; otherwise assert on `progressStageSignal`
  transitions around a mocked run. Sweep/WFO: assert the label clears once the
  first poll returns (mocked).
- **End-to-end**: drive each flow and confirm the label appears during
  download/submit and disappears when the bar starts moving (or the backtest
  result renders).

## Risks / notes

- The label lives in one place (by the Run button). Confirm it is visible while
  the sweep/WFO modal is open (the Run trigger is inside the modal, so it is).
- Clearing the stall label on the first poll is what hands off to the moving bar;
  make sure an aborted/failed submit also clears it (the shared `finally` does).
- No backend work at all keeps this change small and reversible.
