"""SPIKE instances (`SPIKE#id.spikeHigh` / `.spikeLow` / `.barsSinceSpike` /
`.consolOk` / `.retracePct` / `.maxRetracePct`): a causal spike -> flat
consolidation -> retrace state machine, mirrored operation-for-operation in
frontend lib/indicators/spike.ts per the parity contract in indicators/core.py.
Chart-timeframe only (no MTF pin).

Per bar, in IDLE state a spike arms when the current high is at least
`min_spike_pct` percent above the NEAREST base in the trailing `spike_bars`
window (window includes the current bar): walking back, the running low
absorbs bars whose lows stay within the flat band's tolerance of it (the
basing region) and stops at the first bar that pulled away above it — so a
stale deep low beyond a real pullback never anchors the pattern. That base
becomes `spikeLow` and the bar's high `spikeHigh`. While armed:

- low below `spikeLow` invalidates the pattern (reset to IDLE, then the same
  bar may re-arm through the normal IDLE check);
- a new high above `spikeHigh` extends the spike ONLY if it re-passes the arm
  condition against its own trailing window (the move is still steep):
  `spikeHigh` steps up, `barsSinceSpike` and the consolidation clock restart,
  `consolOk` unlatches. A non-steep new high ends the pattern instead — a
  grind must not inflate a spike;
- before `consolOk`: a bar whose low holds the flat band
  [spikeHigh - max_flat_range_pct% of spike height, spikeHigh] counts toward
  consolidation; `flat_bars` such bars in a row latch `consolOk` to 1. A dip
  below the band first voids the pattern (reset, same-bar re-arm allowed);
- after `consolOk` (latched): dips below the flat band are the tradeable
  retrace (`maxRetracePct` tracks the deepest low since the latch), down to
  the `max_retrace_pct` hard floor — a low below THAT invalidates, because a
  retrace so deep no longer reads as a high-probability continuation. Entry
  rules must use retrace bounds inside `max_retrace_pct`;
- `barsSinceSpike` reaching `max_pattern_bars` expires the pattern back to
  IDLE (same-bar re-arm allowed), so a stale armed pattern cannot absorb a
  later genuine spike as a mere extension.

`retracePct` is the CURRENT bar's dip, (spikeHigh - low) / height * 100 —
large on the spike bar itself (its low sits near the base); gate entries on
`consolOk` and `maxRetracePct`, not on `retracePct` alone. All outputs are
None while IDLE."""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

from auto_trader.core.models import Candle

# Forward-filled operand values, in pane order. `spikeHigh` first — the chart
# click-to-insert token emits outputs[0].
SPIKE_OUTPUTS: tuple[str, ...] = (
    "spikeHigh", "spikeLow", "barsSinceSpike", "consolOk", "retracePct", "maxRetracePct",
)

_OUTPUT_INDEX = {name: i for i, name in enumerate(SPIKE_OUTPUTS)}

_DEFAULT_SPIKE_BARS = 5.0
_DEFAULT_MIN_SPIKE_PCT = 2.0
_DEFAULT_FLAT_BARS = 5.0
_DEFAULT_MAX_FLAT_RANGE_PCT = 15.0
_DEFAULT_MAX_PATTERN_BARS = 60.0
_DEFAULT_MAX_RETRACE_PCT = 70.0


@dataclass(frozen=True, slots=True)
class SpikeConfig:
    spike_bars: int  # max spike-leg length: rise measured over this window
    min_spike_pct: float  # min rise % from window low to current high
    flat_bars: int  # consecutive in-band bars that latch consolOk
    max_flat_range_pct: float  # flat band depth, % of spike height
    # Pattern lifetime: barsSinceSpike reaching this expires the pattern back
    # to IDLE (same-bar re-arm allowed). Without it, an armed pattern that
    # neither breaks spikeLow nor makes a new high can sit for hundreds of
    # bars, and — because a higher high merely EXTENDS it — a later genuine
    # spike inherits the stale anchors instead of arming fresh.
    max_pattern_bars: int = 60
    # Post-latch hard floor: a dip deeper than this percent of the spike's
    # height (measured from the high) invalidates the pattern — a retrace that
    # deep no longer reads as a high-probability continuation. Distinct from
    # max_flat_range_pct, which polices only the PRE-latch consolidation:
    # tight flag, deeper allowed dip.
    max_retrace_pct: float = 70.0


def parse_spike_config(calc_params: object, extend_data: object) -> SpikeConfig:
    """Mirrors frontend SPIKE_TEMPLATE.calc: lengths fall back to their default
    on anything non-finite or falsy (Math.max(1, Math.floor(Number(x) || d))),
    percents fall back on anything non-finite or <= 0. calcParams order:
    [spikeBars, minSpikePct, flatBars, maxFlatRangePct, maxPatternBars,
    maxRetracePct].
    `extend_data` is accepted (not read) to match the
    IndicatorSeriesSpec.parse_config signature."""
    del extend_data
    p = calc_params if isinstance(calc_params, (list, tuple)) else []

    def num_at(i: int) -> float:
        try:
            v = float(p[i])
        except (IndexError, TypeError, ValueError):
            return float("nan")
        return v

    def len_at(i: int, default: float) -> int:
        v = num_at(i)
        if not math.isfinite(v) or v == 0:
            v = default
        return max(1, math.floor(v))

    def pct_at(i: int, default: float) -> float:
        v = num_at(i)
        if not math.isfinite(v) or v <= 0:
            v = default
        return v

    return SpikeConfig(
        spike_bars=len_at(0, _DEFAULT_SPIKE_BARS),
        min_spike_pct=pct_at(1, _DEFAULT_MIN_SPIKE_PCT),
        flat_bars=len_at(2, _DEFAULT_FLAT_BARS),
        max_flat_range_pct=pct_at(3, _DEFAULT_MAX_FLAT_RANGE_PCT),
        max_pattern_bars=len_at(4, _DEFAULT_MAX_PATTERN_BARS),
        max_retrace_pct=pct_at(5, _DEFAULT_MAX_RETRACE_PCT),
    )


def _compute_points(
    cfg: SpikeConfig, candles: Sequence[Candle]
) -> list[tuple[float | None, ...]]:
    """Per-bar (spikeHigh, spikeLow, barsSinceSpike, consolOk, retracePct,
    maxRetracePct); None-tuples while IDLE."""
    length = len(candles)
    highs = [c.high for c in candles]
    lows = [c.low for c in candles]

    armed = False
    spike_high = 0.0
    spike_low = 0.0
    spike_bar = 0
    consol_count = 0
    consol_ok = False
    max_retrace = 0.0

    out: list[tuple[float | None, ...]] = []
    for i in range(length):
        if armed and i - spike_bar >= cfg.max_pattern_bars:
            armed = False  # expired: too old to trade, free the machine to re-arm
        if armed:
            height = spike_high - spike_low
            flat_floor = spike_high - cfg.max_flat_range_pct / 100.0 * height
            if lows[i] < spike_low:
                armed = False  # invalidated: fell through the spike base
            elif highs[i] > spike_high:
                # A new high extends the spike ONLY if the move is still steep:
                # the arm condition re-checked against the bar's own trailing
                # window. Without this, a pattern that armed on a marginal rise
                # inflates through a slow grind — each small new high stepping
                # spikeHigh up — until a staircase rally reads as one big
                # "spike" that was never vertical at any point.
                base = min(lows[max(0, i - cfg.spike_bars + 1): i + 1])
                if base > 0 and (highs[i] - base) / base * 100.0 >= cfg.min_spike_pct:
                    # Steep extension: new anchor high, consolidation restarts.
                    spike_high = highs[i]
                    spike_bar = i
                    consol_count = 0
                    consol_ok = False
                    max_retrace = 0.0
                else:
                    # Grind, not a spike leg: the pattern ends here. The IDLE
                    # re-arm below re-runs the SAME check and fails the same
                    # way, so the bar goes idle rather than instantly re-arming.
                    armed = False
            elif not consol_ok:
                if lows[i] >= flat_floor:
                    consol_count += 1
                    if consol_count >= cfg.flat_bars:
                        consol_ok = True
                else:
                    armed = False  # dipped before consolidating: not this pattern
            elif lows[i] < spike_high - cfg.max_retrace_pct / 100.0 * height:
                # Post-latch hard floor: a retrace below max_retrace_pct went
                # too deep for a high-probability continuation.
                armed = False
            else:
                max_retrace = max(max_retrace, (spike_high - lows[i]) / height * 100.0)

        if not armed:
            # IDLE (possibly just reset this bar): arm on a sufficient rise
            # from the NEAREST base, not the deepest low the window happens to
            # hold. Walk back accumulating the running low, stopping at the
            # first bar whose low pulled away above the flat band's tolerance
            # of it — a stale deep low beyond a real pullback-up never anchors
            # spikeLow. The base is the swing low a fib drawn over the leg
            # would use, which is what retracePct and the break-invalidation
            # are measured against; a leg whose nearest base misses the rise
            # threshold simply arms later (or not at all), never deeper.
            run_min = lows[i]
            for j in range(i - 1, max(0, i - cfg.spike_bars + 1) - 1, -1):
                if lows[j] > run_min + cfg.max_flat_range_pct / 100.0 * (highs[i] - run_min):
                    break  # pulled away from the base: older lows are a different structure
                if lows[j] < run_min:
                    run_min = lows[j]
            if run_min > 0 and (highs[i] - run_min) / run_min * 100.0 >= cfg.min_spike_pct:
                armed = True
                spike_high = highs[i]
                spike_low = run_min
                spike_bar = i
                consol_count = 0
                consol_ok = False
                max_retrace = 0.0

        if not armed:
            out.append((None,) * len(SPIKE_OUTPUTS))
            continue
        height = spike_high - spike_low
        retrace = (spike_high - lows[i]) / height * 100.0 if height > 0 else 0.0
        out.append((
            spike_high,
            spike_low,
            float(i - spike_bar),
            1.0 if consol_ok else 0.0,
            max(0.0, retrace),
            max_retrace,
        ))
    return out


def spike_outputs(cfg: SpikeConfig) -> tuple[str, ...]:
    return SPIKE_OUTPUTS


def spike_series(
    cfg: SpikeConfig, output: str, candles: Sequence[Candle], bar_hours: float
) -> list[float | None]:
    points = _compute_points(cfg, candles)
    idx = _OUTPUT_INDEX.get(output, 0)
    return [p[idx] for p in points]


def spike_warmup(cfg: SpikeConfig, output: str) -> int:
    """Trailing spike window plus the pattern lifetime: the state at a bar can
    depend on a pattern that armed up to `max_pattern_bars` earlier, which
    itself read its trailing `spike_bars` window. Chained void/re-arm phase
    offsets can in principle reach further back, so this is the conservative
    convention, not a hard guarantee — same caveat as the other specs. 0 for
    an output this config does not expose (validation layer's error to
    report)."""
    return cfg.spike_bars + cfg.max_pattern_bars if output in _OUTPUT_INDEX else 0
