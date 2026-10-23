"""RSI pane instances (`RSI.value`, `RSI.bullDiv`, `RSI.bearDiv`,
`RSI.hBullDiv`, `RSI.hBearDiv`, and a `...Forming` twin of each divergence
output). Mirrors the frontend pane
(lib/indicators/rsi.ts computeRsi / detectDivergences, lib/indicators/
rsiOutputs.ts parse/outputs/warm-up). Chart-timeframe only (no MTF pin).

The divergence outputs are per-bar 0/1 event series. A divergence fires 1.0 on
the bar it becomes KNOWN: its right pivot plus `lookbackRight` bars, the bar
that confirms the pivot. The chart draws the line back to the pivot bar, but a
backtest acting there would read `lookbackRight` bars of the future.

Each output force-detects its own kind, whatever the pane's `on` switch and
per-kind display toggles say: the toggles decide what the chart DRAWS, not
what a rule may read. Kinds are detected independently in the TS emit loop,
so forcing one kind gives exactly the segments the chart draws for it.

The `...Forming` outputs are 0/1 STATES, not events: 1 on every bar where the
chart, drawn with only the bars up to that one, would show a still-forming
(dotted) divergence of that kind, the forming pass of detectDivergences with
`formingLookbackRight` right bars. A forming divergence can vanish on the next
bar, so these repaint by design; they never read a later bar. With
`formingScanBack` the scan stops, as the chart's does, at the first tail swing
that diverges for any kind of the side the pane draws (plus the forced kind),
so the display toggles shape where a forming output stops looking."""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

from auto_trader.core.models import Candle
from auto_trader.indicators.core import PRICE_SOURCES, price_of, rsi_series

# Value line first, then the four divergence kinds in the chart's order.
RSI_OUTPUTS: tuple[str, ...] = (
    "value", "bullDiv", "bearDiv", "hBullDiv", "hBearDiv",
    "bullDivForming", "bearDivForming", "hBullDivForming", "hBearDivForming",
)

_KIND_OF = {
    "bullDiv": "bullish",
    "bearDiv": "bearish",
    "hBullDiv": "hiddenBullish",
    "hBearDiv": "hiddenBearish",
}
FORMING_KIND_OF = {f"{k}Forming": v for k, v in _KIND_OF.items()}


@dataclass(frozen=True, slots=True)
class RsiConfig:
    length: int = 14
    source: str = "close"
    lookback_left: int = 5
    lookback_right: int = 5
    range_min: int = 5
    range_max: int = 60
    pivot_depth: int = 3
    forming_lookback_right: int = 2
    forming_scan_back: bool = False
    # The pane's per-kind display toggles. They decide only where the forming
    # scan stops; every output still force-detects its own kind.
    bullish: bool = True
    bearish: bool = True
    hidden_bullish: bool = False
    hidden_bearish: bool = False


def _floor_or(v: object, default: int) -> int:
    """JS `Math.floor(Number(v)) || default`: NaN, ±inf and 0 take the default."""
    try:
        f = float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default
    if not math.isfinite(f):
        return default
    return math.floor(f) or default


def parse_rsi_config(calc_params: object, extend_data: object) -> RsiConfig:
    """Length in calcParams[0], divergence tuning on extendData.divergence,
    merged over RSI_DIVERGENCE_DEFAULTS with detectDivergences' clamps.
    Mirrors rsiOutputs.ts parseRsiRefConfig; malformed input takes defaults."""
    length = 14
    if isinstance(calc_params, (list, tuple)) and calc_params:
        length = max(1, _floor_or(calc_params[0], 14))
    ext = extend_data if isinstance(extend_data, dict) else {}
    src = ext.get("source")
    div = ext.get("divergence")
    div = div if isinstance(div, dict) else {}
    lbl = max(1, _floor_or(div.get("lookbackLeft", 5), 1))
    lbr = max(1, _floor_or(div.get("lookbackRight", 5), 1))
    lo = max(1, _floor_or(div.get("rangeMin", 5), 1))
    hi = max(lo, _floor_or(div.get("rangeMax", 60), lo))
    depth = max(1, _floor_or(div.get("pivotDepth", 3), 1))
    # rsi.ts: floor, a non-finite value takes 1, then clamp to [0, lbR - 1].
    try:
        fbr = math.floor(float(div.get("formingLookbackRight", 2)))
    except (TypeError, ValueError, OverflowError):
        fbr = 1
    return RsiConfig(
        length=length,
        source=src if src in PRICE_SOURCES else "close",
        lookback_left=lbl,
        lookback_right=lbr,
        range_min=lo,
        range_max=hi,
        pivot_depth=depth,
        forming_lookback_right=max(0, min(lbr - 1, fbr)),
        forming_scan_back=div.get("formingScanBack") is True,
        bullish=div.get("bullish", True) is not False,
        bearish=div.get("bearish", True) is not False,
        hidden_bullish=div.get("hiddenBullish") is True,
        hidden_bearish=div.get("hiddenBearish") is True,
    )


def rsi_outputs(cfg: RsiConfig) -> tuple[str, ...]:
    return RSI_OUTPUTS


def _is_pivot(v: Sequence[float | None], i: int, lbl: int, lbr: int, want: str,
              n: int | None = None) -> bool:
    """pivots.ts isPivotAt with strict=false: ties allowed, an undefined
    neighbour rejects. `n` caps the series length, so a pivot is judged with
    only the first n bars."""
    x = v[i]
    if x is None or i - lbl < 0 or i + lbr >= (len(v) if n is None else n):
        return False
    for j in range(i - lbl, i + lbr + 1):
        if j == i:
            continue
        w = v[j]
        if w is None:
            return False
        if want == "low" and w < x:
            return False
        if want == "high" and w > x:
            return False
    return True


def _side(kind: str) -> str:
    return "low" if kind in ("bullish", "hiddenBullish") else "high"


def _match(prev: list[tuple[int, float, float]], cur: tuple[int, float, float],
           cfg: RsiConfig, kind: str) -> int | None:
    """detectDivergences' emit for one kind: the index of the nearest earlier
    pivot (at most pivotDepth back, in range, unpierced) that diverges from
    `cur`, else None."""
    side = _side(kind)

    def test(p: tuple[int, float, float]) -> bool:
        if kind == "bullish":
            return cur[1] > p[1] and cur[2] < p[2]
        if kind == "hiddenBullish":
            return cur[1] < p[1] and cur[2] > p[2]
        if kind == "bearish":
            return cur[1] < p[1] and cur[2] > p[2]
        return cur[1] > p[1] and cur[2] < p[2]  # hiddenBearish

    def pierced(k: int) -> bool:
        a = prev[k]
        slope = (cur[1] - a[1]) / (cur[0] - a[0])
        for q in prev[k + 1:]:
            if q[0] >= cur[0]:
                break
            line = a[1] + slope * (q[0] - a[0])
            if (q[1] < line) if side == "low" else (q[1] > line):
                return True
        return False

    k, tried = len(prev) - 1, 0
    while k >= 0 and tried < cfg.pivot_depth:
        dist = cur[0] - prev[k][0]
        if dist > cfg.range_max:
            break
        if dist >= cfg.range_min and test(prev[k]) and not pierced(k):
            return prev[k][0]
        k -= 1
        tried += 1
    return None


def _point(candles: Sequence[Candle], rsi: Sequence[float | None], i: int, side: str) -> tuple[int, float, float]:
    c = candles[i]
    return (i, float(rsi[i]), c.low if side == "low" else c.high)  # type: ignore[arg-type]


def divergence_pivots(
    candles: Sequence[Candle], rsi: Sequence[float | None], cfg: RsiConfig, kind: str
) -> list[tuple[int, int]]:
    """(from pivot index, to pivot index) per confirmed divergence of `kind`,
    exactly the confirmed segments detectDivergences emits for that kind."""
    side = _side(kind)
    out: list[tuple[int, int]] = []
    prev: list[tuple[int, float, float]] = []  # (index, rsi, price)
    for i in range(len(rsi)):
        if not _is_pivot(rsi, i, cfg.lookback_left, cfg.lookback_right, side):
            continue
        cur = _point(candles, rsi, i, side)
        frm = _match(prev, cur, cfg, kind)
        if frm is not None:
            out.append((frm, i))
        prev.append(cur)
    return out


def forming_pivots(
    candles: Sequence[Candle], rsi: Sequence[float | None], cfg: RsiConfig, kind: str
) -> list[int | None]:
    """Per bar t, the tentative right pivot of the forming divergence of `kind`
    the chart would draw on bars[0..t] (detectDivergences' forming pass), else
    None. Only pivots confirmed by bar t are compared against, and the
    tentative one needs only `forming_lookback_right` right bars, all <= t."""
    side = _side(kind)
    lbl, lbr, fbr = cfg.lookback_left, cfg.lookback_right, cfg.forming_lookback_right
    drawn = {"bullish": cfg.bullish, "hiddenBullish": cfg.hidden_bullish,
             "bearish": cfg.bearish, "hiddenBearish": cfg.hidden_bearish}
    # The chart stops at a swing that diverges for any kind it draws on this side.
    stoppers = [k for k, on in drawn.items() if on and k != kind and _side(k) == side]
    n = len(rsi)
    confirmed = [i for i in range(n) if _is_pivot(rsi, i, lbl, lbr, side)]
    out: list[int | None] = [None] * n
    prev: list[tuple[int, float, float]] = []
    ci = 0
    for t in range(n):
        while ci < len(confirmed) and confirmed[ci] + lbr <= t:
            prev.append(_point(candles, rsi, confirmed[ci], side))
            ci += 1
        if not prev:
            continue
        # The not-yet-confirmable tail (i + lbR > t), newest swing first.
        for i in range(t - fbr, max(prev[-1][0], t - lbr), -1):
            if not _is_pivot(rsi, i, lbl, fbr, side, n=t + 1):
                continue
            cur = _point(candles, rsi, i, side)
            if _match(prev, cur, cfg, kind) is not None:
                out[t] = i
                break
            if not cfg.forming_scan_back or any(_match(prev, cur, cfg, k) is not None for k in stoppers):
                break
    return out


def forming_pivot_at(candles: Sequence[Candle], cfg: RsiConfig, output: str, t: int) -> int | None:
    """The tentative pivot a `...Forming` output holds at bar t, else None."""
    return forming_pivots(candles, rsi_series_for(cfg, candles), cfg, FORMING_KIND_OF[output])[t]


def rsi_series_for(cfg: RsiConfig, candles: Sequence[Candle]) -> list[float | None]:
    return rsi_series([price_of(c, cfg.source) for c in candles], cfg.length)


def rsi_pane_series(
    cfg: RsiConfig, output: str, candles: Sequence[Candle], bar_hours: float
) -> list[float | None]:
    rsi = rsi_series_for(cfg, candles)
    if output == "value":
        return rsi
    n = len(candles)
    if output in FORMING_KIND_OF:
        held = forming_pivots(candles, rsi, cfg, FORMING_KIND_OF[output])
        return [None if v is None else (1.0 if held[i] is not None else 0.0) for i, v in enumerate(rsi)]
    kind = _KIND_OF.get(output)
    if kind is None:
        return [None] * n
    out: list[float | None] = [None if v is None else 0.0 for v in rsi]
    for _, to in divergence_pivots(candles, rsi, cfg, kind):
        at = to + cfg.lookback_right  # the confirming bar; always < n
        out[at] = 1.0
    return out


def rsi_warmup(cfg: RsiConfig, output: str) -> int:
    """value: the RSI length. Divergences: the RSI length plus the farthest
    earlier pivot (range_max) plus both pivot windows. 0 for an unknown output."""
    if output == "value":
        return cfg.length
    if output in _KIND_OF or output in FORMING_KIND_OF:
        return cfg.length + cfg.range_max + cfg.lookback_left + cfg.lookback_right
    return 0
