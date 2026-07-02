# Forming (transient) RSI divergences + Divergence settings section

**Date:** 2026-07-02
**Status:** Approved design, pre-implementation

## Problem

The RSI divergence detector only marks a divergence once its right-hand pivot is
**confirmed** — which requires `lookbackRight` (default 5) bars *after* the pivot.
So the most recent 5 bars can never form a pivot, and a divergence that is
currently forming at the latest swing is invisible until it's already 5 bars old.

Users want to also see the **latest, still-forming divergence** — the one "in the
making" that could still be invalidated — as an early warning.

Separately, the divergence tuning constants already exist in the config
(`RsiDivergenceConfig`) but are **not exposed in the UI**; the modal has only a
single "Calculate Divergence" checkbox. They should be editable in a dedicated
section, each field with a short tooltip.

## How divergence works today (reference)

- `detectDivergences` (`frontend/src/lib/customIndicators.ts:1185`) compares RSI
  **pivots**, not every bar.
- A bar is a **pivot low/high** if its RSI is ≤/≥ all RSI over `lookbackLeft`
  (def 5) bars before and `lookbackRight` (def 5) bars after (ties allowed) —
  mirrors TradingView `ta.pivotlow/high`.
- The `lookbackRight` requirement is the confirmation lag: the last 5 bars can't
  be a pivot yet.
- On each new confirmed pivot, it's compared to the previous same-side pivot when
  they're `[rangeMin, rangeMax]` (def 5–60) bars apart:
  - **Regular bullish:** price lower low + RSI higher low
  - **Regular bearish:** price higher high + RSI lower high
  - **Hidden bullish / bearish:** the inverse (off by default)
- Segments are stashed on the right-pivot bar's result point (`divs`) and drawn in
  the `draw` callback (`:1607`): solid line (regular) / dashed `[4,3]` (hidden),
  bull/bear color, with a label (`Bull`/`Bear`/`H Bull`/`H Bear`) at the pivot.

## Chosen approach: B2 — partial confirmation

A **forming pivot** is detected with the *same* `isPivot` algorithm but a smaller
right-lookback (`formingLookbackRight`, default 2). This reuses the confirmed code
path (consistent, testable) and surfaces the signal ~2–3 bars earlier than the
current 5, while the tentative pivot is still a real local extreme (not just "the
last bar," which B1/zero-right would give — too noisy).

## Design

### 1. Detection — `detectDivergences`

Keep the confirmed pass unchanged. After it, run a **forming pass**:

- The confirmed pass already leaves `lastLow` / `lastHigh` = most recent
  **confirmed** pivots (each carrying index, rsi, price).
- For each side, scan backward from the end for the most recent bar `i` that:
  1. is in the **not-yet-confirmable tail** (`i + lookbackRight >= n`), so it is
     genuinely a forming swing the confirmed pass cannot see — not an older swing
     that simply failed full confirmation,
  2. is **newer** than the last confirmed pivot of that side (`i > lastX.index`),
  3. qualifies as a pivot using `lookbackLeft` on the left and
     `formingLookbackRight` on the right (requires `i + formingLookbackRight < n`
     bars to exist), and
  4. is within `[rangeMin, rangeMax]` bars of the last confirmed pivot.
- If it's divergent per the enabled kinds, emit **one** segment for that side with
  `forming: true`. If there is no last confirmed pivot of that side, nothing is
  emitted (no baseline to compare against).

Yields at most one tentative bull line and one tentative bear line — always the
latest swing. It naturally disappears/replaces when the swing becomes a confirmed
pivot (confirmed pass now draws the solid/dashed line) or when later price/RSI
action means it no longer qualifies.

Guarded by `cfg.showForming`; when off, the forming pass is skipped entirely.

### 2. Data model

- `DivSegment` gains `forming?: boolean`.
- `RsiDivergenceConfig` gains:
  - `showForming: boolean`
  - `formingLookbackRight: number`
- `RSI_DIVERGENCE_DEFAULTS` gains `showForming: false`, `formingLookbackRight: 2`.
  (New keys automatically participate in the modal's "persist only when
  non-default" check.)

### 3. Rendering (`draw` block, `customIndicators.ts:1607`)

Three distinct visual states, same bull/bear color:
- **Confirmed regular** → solid line (unchanged)
- **Confirmed hidden** → dashed `[4,3]` (unchanged)
- **Forming** → **dotted `[2,3]` at reduced opacity**, label gets a **`?` suffix**
  (`Bull?`, `Bear?`, `H Bull?`, `H Bear?`).

Forming segments respect the same `style.hidden.bull` / `style.hidden.bear`
visibility toggles as confirmed ones.

### 4. Modal — new "Divergence" section (`IndicatorSettings.tsx:~1392`)

Replace the lone checkbox with a titled group (styled like the existing
"Smoothing" group). "Calculate Divergence" remains the master toggle; the fields
below enable only when it is on (greyed via the existing `is-off` pattern).

Fields (each with an `InfoTip` icon + short text):

| Field | Control | Default | Tooltip (short) |
|---|---|---|---|
| Calculate Divergence | checkbox (master) | off | Marks RSI divergences: price makes a new high/low but RSI does not. |
| Pivot lookback — Left | number ≥1 | 5 | Bars required to the left of a swing for it to count as a pivot. |
| Pivot lookback — Right | number ≥1 | 5 | Bars required to the right to confirm a pivot (the detection lag). |
| Range — Min | number ≥1 | 5 | Fewest bars allowed between the two pivots being compared. |
| Range — Max | number ≥Min | 60 | Most bars allowed between the two pivots being compared. |
| Regular Bullish | checkbox | on | Price lower low + RSI higher low. |
| Regular Bearish | checkbox | on | Price higher high + RSI lower high. |
| Hidden Bullish | checkbox | off | Price higher low + RSI lower low. |
| Hidden Bearish | checkbox | off | Price lower high + RSI higher high. |
| Show forming divergence | checkbox | off | Also show the latest still-forming divergence (may be invalidated). |
| Forming lookback right | number ≥1 | 2 | Right-side bars for a tentative pivot; lower = earlier but jumpier. Enabled only when "Show forming" is on. |

Inputs clamp like the existing modal (`Math.max(1, Math.floor(n) || default)`),
and Max clamps to `≥ Min`.

## Non-goals / YAGNI

- No per-kind color for forming vs confirmed (reuse bull/bear colors).
- No alerts on forming divergences in this change.
- No change to price-source, smoothing, or any other RSI behavior.

## Testing

- **Unit** (`detectDivergences`): synthetic RSI/price series producing (a) a
  confirmed bear divergence, (b) a forming bear divergence at 2 right bars that is
  absent at the confirmed 5-bar setting, (c) a forming divergence that flips to
  confirmed as bars are appended, (d) `showForming:false` emits no forming segs.
- **e2e/visual**: enable divergence + forming on an RSI pane; confirm dotted `?`
  line renders for the latest swing and the RSI single-line figure assertion still
  holds (forming is drawn in the `draw` callback, not as a figure).
