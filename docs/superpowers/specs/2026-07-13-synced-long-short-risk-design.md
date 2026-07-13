# Synced long/short stop & take profit

**Date:** 2026-07-13
**Status:** Design approved

## Goal

The strategy config keeps a separate `RiskConfig` per side (`longRisk` /
`shortRisk`), edited one side at a time, so the two silently drift apart. Add a
**"Same for long & short"** option — **on by default** — that keeps the SL/TP
block identical on both sides.

## Data model

One new optional flag on each config that owns per-side risk:

- `BacktestConfig.riskSynced?: boolean` (rule mode; also the Live panel's
  rule-mode draft, which is a `BacktestConfig`)
- `CodedStrategyConfig.riskSynced?: boolean` (coded overrides, backtest and
  live sets)

Absent means **true** (synced) — on by default for new and existing configs;
presets and saved strategies carry the flag. Same `!== false` read-guard
convention as `longEnabled`. The flag is frontend-only: `BacktestRequest` is
built field-by-field, so nothing changes on the wire.

## Behavior

- While synced, any edit in a "Stop & take profit" block (kind, %, ATR
  mult/length, price level) writes the whole `RiskConfig` to **both**
  `longRisk` and `shortRisk`.
- **Copy immediately:** when the backtest modal loads a config (open, preset
  apply, coded-file select) with sync on and the sides differing, the currently
  viewed side (rule mode) / long (coded mode, both visible) is copied across
  right away. Turning sync on later copies the side you toggled it from.
- Equality treats `undefined` and a `none/none` risk as the same
  (via `sendableRisk`), so a never-touched side doesn't count as "differing".
- Turning sync **off** changes nothing — sides keep their values and drift
  independently from then on.
- Scaling & management is **not** synced; this is strictly the SL/TP block.
- **Live panel exception:** the live draft / live coded set is never rewritten
  on open (that would surface phantom "pending edits" against an armed
  strategy). Sync there applies on edit and on toggle-on only.

## UI

A compact labeled checkbox — `Same for long & short` — right-aligned in the
"Stop & take profit" section header. `RiskSection` gets an optional
`sync?: { on: boolean; onToggle(): void }` prop; `SectionTitle` gets an
optional `extra` slot to host it. In coded mode both side blocks render the
toggle (shared state) and visibly mirror as you type.

## Sweep interplay (coded mode)

Sweep axes target one side (`risk:long.stop.value`). While synced:

- The sweep toggle canonicalizes risk axes to the **long** side; both sides'
  toggle buttons light for the same axis, and the axis row renders once (under
  the long block). A kind change on either side drops the axis for both sides.
- `SweepAxis` gains `mirrorTarget?: string`; `enumerateCombos` writes the
  mirrored key with the same value into every combo. The modal attaches
  `mirrorTarget` (`risk:short.…`) to risk axes at `sweepAxesSignal.set` time
  when synced, so both sides move together through the sweep — frontend-only,
  the backend just sees two targets per combo.
- Applying a sweep combo back onto the config re-syncs both sides afterwards.

## Testing

- Unit: `riskSync.ts` helpers (default-on, mirror patch, copy-on-load rule,
  none/none ≡ undefined equality); `enumerateCombos` mirror emission.
- Component: `BacktestSettingsModal.test.tsx` — toggle present + editing while
  synced writes both sides.
