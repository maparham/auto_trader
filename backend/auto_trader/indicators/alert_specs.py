"""What an alert may watch on each registry indicator, and how to name it.
The values themselves always come from SERIES_INDICATORS; this table only
says which outputs are alertable, which sit on the price axis, which are 0/1
events, the alert label, and the per-indicator refusals."""
from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any, Literal

from auto_trader.core.alert_bars import candle_ms
from auto_trader.core.models import Candle
from auto_trader.indicators.registry import SERIES_INDICATORS
from auto_trader.indicators.trendlines import TL_NEAREST, TrendLine, compute_trendlines, project_at

EVENT_LEVEL = 0.5  # a 0/1 event crosses up through this on the bar it fires


@dataclass(frozen=True, slots=True)
class AlertOutput:
    kind: Literal["level", "event"] = "level"
    price_scale: bool = False
    price_only: bool = False


LEVEL = AlertOutput()
PRICE = AlertOutput(price_scale=True)
EVENT = AlertOutput(kind="event")


def _no_volume(cfg: Any) -> bool:
    return False


def _no_refusal(cfg: Any, timeframe: str) -> str | None:
    return None


@dataclass(frozen=True, slots=True)
class AlertSpec:
    outputs: Callable[[Any], dict[str, AlertOutput]]
    label: Callable[[Any, str], str]
    heavy: bool = False   # closed values compute off the event loop; intrabar reads the last close
    sparse: bool = False  # a ready series may hold None (no level right now)
    needs_volume: Callable[[Any], bool] = _no_volume
    refusal: Callable[[Any, str], str | None] = _no_refusal
    # Replaces `series` for one output that needs more than its value (the
    # Trendlines held line): returns {"value": [...], <side>: [...]}.
    side_series: Callable[[Any, str, Sequence[Candle]], dict[str, list[float | None]]] | None = None


def _src(source: str) -> str:
    return "" if source == "close" else f" {source}"


# ---- MA / EMA ----

_MA_SUFFIX = {"ma": "", "smoothingMa": " smoothing", "bandHi": " upper band", "bandLo": " lower band"}


def _ma_label(cfg: Any, output: str) -> str:
    off = f" offset {cfg.offset}" if cfg.offset else ""
    return f"{cfg.ma_type.upper()} {cfg.length}{_src(cfg.source)}{off}{_MA_SUFFIX[output]}"


def _ma_outputs(cfg: Any) -> dict[str, AlertOutput]:
    return {name: PRICE for name in SERIES_INDICATORS["MA"].outputs(cfg)}


def _ma_refusal(cfg: Any, timeframe: str) -> str | None:
    if cfg.length < 1:
        return "Alerts need a length of at least 1"
    # A negative offset shifts the line earlier and leaves its newest bars
    # empty, so the alert would never become ready.
    if cfg.offset < 0:
        return "Alerts need an offset of 0 or more"
    return None


_MA = AlertSpec(
    outputs=_ma_outputs, label=_ma_label,
    needs_volume=lambda cfg: cfg.ma_type in ("vwma", "evwma"), refusal=_ma_refusal,
)

# ---- RSI ----

_RSI_EVENTS = {
    "bullDiv": "bullish divergence", "bearDiv": "bearish divergence",
    "hBullDiv": "hidden bullish divergence", "hBearDiv": "hidden bearish divergence",
}


def _rsi_label(cfg: Any, output: str) -> str:
    base = f"RSI {cfg.length}{_src(cfg.source)}"
    return base if output == "value" else f"{base} {_RSI_EVENTS[output]}"


_RSI = AlertSpec(
    outputs=lambda cfg: {"value": LEVEL, **{k: EVENT for k in _RSI_EVENTS}},
    label=_rsi_label,
)

# ---- ATR ----


def _atr_label(cfg: Any, output: str) -> str:
    sm = "" if cfg.smoothing == "rma" else f" {cfg.smoothing}"
    return f"ATR {cfg.length}{sm}" + (" %" if output.endswith(".to%") else "")


_ATR = AlertSpec(
    outputs=lambda cfg: {name: LEVEL for name in SERIES_INDICATORS["ATR"].outputs(cfg)},
    label=_atr_label,
)

# ---- TRENDLINES (nearest line only, see plan ruling 7) ----


def _tl_side(cfg: Any, output: str, candles: Sequence[Candle]) -> dict[str, list[float | None]]:
    """value: the nearest line at bar i. held: the line nearest at bar i-1,
    projected to bar i (a close-mode cross is judged against it). slope /
    a1 / a2: that line's slope per bar and anchor open times, so intrabar can
    project it and the engine can tell a switch."""
    n = len(candles)
    nearest: list[TrendLine | None] = [None] * n
    points, _ = compute_trendlines(candles, cfg, nearest_out=nearest)
    held: list[float | None] = [None] * n
    for i in range(1, n):
        prev = nearest[i - 1]
        if prev is not None:
            held[i] = project_at(prev, i)
    return {
        "value": [p.get(TL_NEAREST) for p in points],
        "held": held,
        "slope": [None if ln is None else (ln.p2 - ln.p1) / (ln.i2 - ln.i1) for ln in nearest],
        "a1": [None if ln is None else float(candle_ms(candles[ln.i1])) for ln in nearest],
        "a2": [None if ln is None else float(candle_ms(candles[ln.i2])) for ln in nearest],
    }


_TL = AlertSpec(
    outputs=lambda cfg: {TL_NEAREST: AlertOutput(price_scale=True, price_only=True)},
    label=lambda cfg, output: "Trendlines nearest",
    heavy=True, sparse=True,
    refusal=lambda cfg, tf: "Nearest-line alerts need 5m or longer" if tf == "MINUTE" else None,
    side_series=_tl_side,
)

# ---- the rest: fixed output vocabularies ----


def _fixed(prefix: str, names: dict[str, tuple[str, AlertOutput]], type_: str) -> AlertSpec:
    return AlertSpec(
        outputs=lambda cfg: {k: names[k][1] for k in SERIES_INDICATORS[type_].outputs(cfg) if k in names},
        label=lambda cfg, output: f"{prefix} {names[output][0]}",
        heavy=True, sparse=True,
    )


_FVG = _fixed("FVG", {
    "bull_top": ("bull top", PRICE), "bull_bottom": ("bull bottom", PRICE),
    "bear_top": ("bear top", PRICE), "bear_bottom": ("bear bottom", PRICE),
}, "FVG")
_SR = _fixed("S/R", {"support": ("support", PRICE), "resistance": ("resistance", PRICE)}, "SR_LEVELS")
_PB = _fixed("Pivot bands", {
    "pivotHigh": ("high", PRICE), "pivotLow": ("low", PRICE),
    "barsSinceHigh": ("bars since high", LEVEL), "barsSinceLow": ("bars since low", LEVEL),
}, "PIVOT_BANDS")
_PA = _fixed("Pivot analysis", {
    "pivotHigh": ("high", PRICE), "pivotLow": ("low", PRICE),
    "deltaPct": ("change %", LEVEL), "deltaT": ("bars between", LEVEL),
}, "PIVOT_ANALYSIS")
_SPIKE = _fixed("Spike", {
    "spikeHigh": ("high", PRICE), "spikeLow": ("low", PRICE), "barsSinceSpike": ("bars since", LEVEL),
    "consolOk": ("consolidation", EVENT), "retracePct": ("retrace %", LEVEL),
    "maxRetracePct": ("max retrace %", LEVEL),
}, "SPIKE")


def _slope_label(cfg: Any, output: str) -> str:
    return f"Slope accel {output[len('accel'):]}" if output.startswith("accel") else f"Slope {output}"


_SLOPE = AlertSpec(
    outputs=lambda cfg: {name: LEVEL for name in SERIES_INDICATORS["SLOPE"].outputs(cfg)},
    label=_slope_label,
)


def _fib_label(cfg: Any, output: str) -> str:
    if output in ("high", "low"):
        return f"Auto fib {output}"
    # fib_output_name: "f", then "m" when negative, then |ratio| with "." as "_"
    # (f0_618, fm0_236).
    body = output[1:]
    neg = body.startswith("m")
    return f"Auto fib {'-' if neg else ''}{(body[1:] if neg else body).replace('_', '.')}"


_FIB = AlertSpec(
    outputs=lambda cfg: {k: PRICE for k in SERIES_INDICATORS["AUTO_FIB"].outputs(cfg) if k != "dir"},
    label=_fib_label,
    heavy=True, sparse=True,
)

# ---- LR (rolling regression endpoint and its channel) ----

_LR_SUFFIX = {"lr": "", "up": " upper", "dn": " lower"}

_LR = AlertSpec(
    outputs=lambda cfg: {"lr": PRICE, "up": PRICE, "dn": PRICE},
    label=lambda cfg, output: f"LR {cfg.length}{_src(cfg.source)}{_LR_SUFFIX[output]}",
)

ALERT_SPECS: dict[str, AlertSpec] = {
    "MA": _MA, "EMA": _MA, "RSI": _RSI, "ATR": _ATR, "TRENDLINES": _TL, "SLOPE": _SLOPE,
    "FVG": _FVG, "PIVOT_BANDS": _PB, "PIVOT_ANALYSIS": _PA, "SR_LEVELS": _SR, "SPIKE": _SPIKE,
    "AUTO_FIB": _FIB, "LR": _LR,
}
