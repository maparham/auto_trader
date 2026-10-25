"""One symbol's verdict for a screen: compile the screen's condition and
columns once, then judge each symbol's candles on its last CLOSED bar.

Pure: no I/O. The runner (api/screen_jobs.py) fetches candles and hands them
here, which keeps this module testable with plain Candle lists.

Screens accept pins at their own timeframe or coarser (`EMA(50)@W` on a daily
screen, or a pane pinned in its settings); finer pins and a fourth timeframe
are refused at compile time. The runner fetches the pinned candles per symbol
(api/htf_source.py) and hands them to `judge`. Pane references resolve against
the screen's own `indicators` map."""

from __future__ import annotations

from dataclasses import dataclass, field
from dataclasses import fields as _dc_fields

from auto_trader.api.htf_source import HtfNeed, _pin_owner, htf_needs
from auto_trader.api.sweep_apply import referenced_tfs
from auto_trader.core.candle_aggregate import resolution_seconds
from auto_trader.core.models import Candle
from auto_trader.indicators.mtf import _close_fn
from auto_trader.indicators.registry import ResolvedInstance, instance_type_of, resolve_instances
from auto_trader.indicators.rsi import _KIND_OF as _DIV_KINDS
from auto_trader.indicators.rsi import FORMING_KIND_OF, divergence_pivots, forming_pivots, rsi_series_for
from auto_trader.strategy.expr import nodes as N
from auto_trader.strategy.expr.errors import ExprError
from auto_trader.strategy.expr.evaluate import compile_row, series_of
from auto_trader.strategy.expr.parser import parse, parse_value
from auto_trader.strategy.expr.tfs import TF_RESOLUTIONS, tf_resolution
from auto_trader.strategy.expr.validate import validate, validate_value
from auto_trader.strategy.expr.warmup import warmup_bars

# Extra closed bars beyond the warm-up, so an EMA is not judged on the very
# first bar it becomes defined.
_SLACK = 20
_MAX_BARS = 2000
# Recursive indicators (EMA, RSI's Wilder smoothing) keep converging long
# after their warm-up: EMA(200) on 221 bars is visibly off the chart's value.
# Ask for several warm-ups' worth, and never fewer than _MIN_BARS.
_WARMUP_MULT = 5
_MIN_BARS = 300
# Each pinned timeframe is one more fetch per symbol.
_MAX_TFS = 3
_TF_LABELS = {v: k for k, v in TF_RESOLUTIONS.items()}  # "DAY" -> "D"
# Pane types whose output only means something on their own chart.
_CHART_ONLY = {"TRENDLINES"}


class ScreenSpecError(Exception):
    """A screen's expression or one of its columns failed to parse/validate.
    `field` is "expression" or "columns"; `index` the column's position (0
    for the expression)."""

    def __init__(self, field: str, index: int, err: ExprError):
        super().__init__(err.message)
        self.field = field
        self.index = index
        self.err = err


@dataclass(frozen=True, slots=True)
class CompiledScreen:
    row: N.Row
    source: str
    columns: list[tuple[str, N.Node]]
    warmup: int
    instances: dict[str, ResolvedInstance]
    htf: list[HtfNeed]
    # (label, instance id, output, pin or None) per RSI divergence ref in the
    # condition, so a match can say where its divergence's pivot is.
    divs: list[tuple[str, str, str, str | None]] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class Judgement:
    matched: bool
    bar_time_ms: int | None
    columns: dict[str, float | None]
    skip_reason: str | None
    # {"ref", "pivot" (epoch ms), "barsAgo"} per divergence ref, matches only.
    divergences: list[dict] = field(default_factory=list)


def _label(res: str) -> str:
    """The screen's timeframe as the panel shows it: 1D, 4H, 15m."""
    alias = _TF_LABELS.get(res, res)
    return f"1{alias}" if alias in ("D", "W") else alias


def _walk(node):
    """Every node in the tree, parents first."""
    yield node
    for f in _dc_fields(node):
        v = getattr(node, f.name)
        for child in (v if isinstance(v, (list, tuple)) else (v,)):
            if hasattr(child, "__dataclass_fields__"):
                yield from _walk(child)


def _check_pins(node: N.Node, src: str, instances: dict[str, ResolvedInstance],
                resolution: str) -> None:
    """Every referenced timeframe must resolve and be the base or coarser."""
    base_s = resolution_seconds(resolution)
    tokens = [n for n in _walk(node) if isinstance(n, N.Tf)]
    for n in tokens:
        res = tf_resolution(n.tf)
        if res is None:
            raise ExprError("unsupported_timeframe",
                            f"Timeframe '{n.tf}' is not supported.", n.start, n.end)
        if resolution_seconds(res) < base_s:
            raise ExprError("screen_tf_lower",
                            f"@{n.tf} is a lower timeframe than this screen's {_label(resolution)}. "
                            f"Run the screen on {n.tf} and pin the higher timeframe instead.",
                            n.start, n.end)
    # Panes pinned in their own settings carry no token, so they get the
    # whole field's span.
    for tf in sorted(referenced_tfs(node, instances) - {n.tf for n in tokens}):
        owner = _pin_owner(tf, instances) or "An indicator"
        res = tf_resolution(tf)
        if res is None:
            raise ExprError("unsupported_timeframe",
                            f"{owner} is pinned to timeframe '{tf}', which screens cannot compute. "
                            "Change that indicator's timeframe or unpin it.", 0, len(src))
        if resolution_seconds(res) < base_s:
            raise ExprError("screen_tf_lower",
                            f"{owner} is pinned to {tf} in its settings, lower than this screen's "
                            f"{_label(resolution)}. Run the screen on {tf}, or unpin it on the chart.",
                            0, len(src))


def _div_refs(node, instances: dict[str, ResolvedInstance], tf: str | None = None):
    """(label, id, output, pin) for every RSI divergence ref, with the @tf
    that encloses it. RSI panes carry no pin of their own."""
    if isinstance(node, N.Tf):
        tf = node.tf
    if isinstance(node, N.IndicatorRef):
        inst = instances.get(node.instance)
        if inst is not None and inst.type == "RSI" and (node.output in _DIV_KINDS or node.output in FORMING_KIND_OF):
            yield (f"{node.instance}.{node.output}{f'@{tf}' if tf else ''}", node.instance, node.output, tf)
        return
    for f in _dc_fields(node):
        v = getattr(node, f.name)
        for child in (v if isinstance(v, (list, tuple)) else (v,)):
            if hasattr(child, "__dataclass_fields__"):
                yield from _div_refs(child, instances, tf)


def _latest_pivot(cs: CompiledScreen, ref: tuple[str, str, str, str | None],
                  bars: list[Candle], htf: dict[str, list[Candle]], resolution: str) -> dict | None:
    """The newest divergence of this ref already confirmed on the judged bar
    (a forming ref: the one it holds on that bar):
    its right pivot's open time and how many of the ref's own bars ago it is
    (the chart labels the pivot, `lookbackRight` bars before the event)."""
    label, iid, output, tf = ref
    if tf is not None:
        res = tf_resolution(tf)
        tf_ms = resolution_seconds(res) * 1000
        cutoff = int(bars[-1].time.timestamp() * 1000)
        # Only the pinned bars the alignment lets the judged bar read: a
        # same-timeframe pin at its open, any other at its true close.
        same_tf = resolution_seconds(resolution) * 1000 == tf_ms
        close_of = _close_fn(res, tf_ms)
        bars = [c for c in htf.get(res, [])
                if (o := int(c.time.timestamp() * 1000)) <= cutoff and (same_tf or close_of(o) <= cutoff)]
    if not bars:
        return None
    cfg = cs.instances[iid].config
    last = len(bars) - 1
    if output in FORMING_KIND_OF:
        # A forming divergence only exists while it holds on the judged bar.
        held = forming_pivots(bars, rsi_series_for(cfg, bars), cfg, FORMING_KIND_OF[output])[last]
        if held is None:
            return None
        return {"ref": label, "pivot": int(bars[held].time.timestamp() * 1000), "barsAgo": last - held}
    pivots = [to for _, to in divergence_pivots(bars, rsi_series_for(cfg, bars), cfg, _DIV_KINDS[output])
              if to + cfg.lookback_right <= last]
    if not pivots:
        return None
    return {"ref": label, "pivot": int(bars[pivots[-1]].time.timestamp() * 1000), "barsAgo": last - pivots[-1]}


def _cap_tfs(seen: set[str], node: N.Node, src: str,
             instances: dict[str, ResolvedInstance]) -> set[str]:
    """Add this field's canonical pinned resolutions; the field that takes
    the screen past the cap is the one blamed."""
    out = seen | {n.res for n in htf_needs([node], instances)}
    if len(out) > _MAX_TFS:
        raise ExprError("screen_tf_too_many",
                        f"A screen can pin at most {_MAX_TFS} timeframes.", 0, len(src))
    return out


def _screen_wording(e: ExprError, src: str, refused: set[str]) -> ExprError:
    """validate() says 'on this chart'; a screen has no chart."""
    if e.code == "unknown_line_ref":
        return ExprError("screen_no_lines", "Picked lines can't be used in a screen. "
                         "A line belongs to the chart it was picked on.", e.start, e.end)
    if e.code != "unknown_indicator_ref":
        return e
    iid = src[e.start:e.end].split(".", 1)[0]
    if iid in refused or iid.rstrip("0123456789") in _CHART_ONLY:
        return ExprError("screen_no_trendlines", "Trendlines can't be used in a screen. "
                         "Its lines belong to the chart they were drawn on.", e.start, e.end)
    return ExprError(e.code, f"{iid} is not one of this screen's indicators. "
                     "Add it to a chart and pick it from there.", e.start, e.end)


def compile_screen(expression: str, columns: list[dict],
                   indicators: dict[str, dict] | None = None,
                   resolution: str = "DAY") -> CompiledScreen:
    # Trendlines are fitted to the chart they are drawn on, so a screen drops
    # them; a ref to one then fails validation and is worded as a refusal.
    refused = {k for k, d in (indicators or {}).items()
               if (d.get("type") or instance_type_of(k)) in _CHART_ONLY}
    instances = resolve_instances({k: d for k, d in (indicators or {}).items() if k not in refused})
    try:
        row = parse(expression)
        validate(row, is_exit=False, instances=instances)
        _check_pins(row, expression, instances, resolution)
        seen = _cap_tfs(set(), row, expression, instances)
    except ExprError as e:
        raise ScreenSpecError("expression", 0, _screen_wording(e, expression, refused)) from e
    cols: list[tuple[str, N.Node]] = []
    for idx, col in enumerate(columns):
        src = col["expression"]
        try:
            node = parse_value(src)
            validate_value(node, instances)
            _check_pins(node, src, instances, resolution)
            seen = _cap_tfs(seen, node, src, instances)
        except ExprError as e:
            raise ScreenSpecError("columns", idx, _screen_wording(e, src, refused)) from e
        cols.append((col["name"], node))
    nodes = [row] + [n for _, n in cols]
    # _check_pins already refused every timeframe htf_needs would 422 on.
    htf = htf_needs(nodes, instances, resolution=resolution)
    # With the base resolution a pinned term costs 0 base bars: it is computed
    # from its own candles, which the runner fetches separately.
    warm = max(warmup_bars(n, resolution, instances) for n in nodes)
    divs = list(dict.fromkeys(_div_refs(row, instances)))
    return CompiledScreen(row, expression, cols, warm, instances, htf, divs)


def bars_needed(cs: CompiledScreen) -> int:
    """How many closed bars to fetch. judge() still accepts anything from
    warmup + 1 bars up, so a young symbol with less history is judged."""
    return min(_MAX_BARS, max(cs.warmup * _WARMUP_MULT, cs.warmup + 1 + _SLACK, _MIN_BARS))


def closed_bars(bars: list[Candle], res_seconds: int, now: float) -> list[Candle]:
    """Drop the forming bar: a bar is closed once its open plus one interval
    has passed."""
    if bars and bars[-1].time.timestamp() + res_seconds > now:
        return bars[:-1]
    return bars


def judge(cs: CompiledScreen, bars: list[Candle], resolution: str,
          htf: dict[str, list[Candle]] | None = None, also_prev: bool = False) -> Judgement:
    """Judge the last bar. `also_prev`: the last bar is the open one and the
    screen includes it, so the bar before (the last CLOSED one) is judged too
    and either matching is a match; the open bar wins when both hold. Every
    series is causal, so index last-1 reads what a closed-only run would."""
    htf = htf or {}
    if len(bars) < cs.warmup + 1:
        return Judgement(False, None, {}, "not enough history")
    compiled = compile_row(cs.row, bars, resolution, htf, cs.instances, source=cs.source)
    last = len(bars) - 1
    tries = [last] + ([last - 1] if also_prev and last - 1 >= cs.warmup else [])
    at = next((i for i in tries if compiled.evaluate(i, None)), None)
    if at is None:
        return Judgement(False, int(bars[last].time.timestamp() * 1000), {}, None)
    cols: dict[str, float | None] = {}
    for name, node in cs.columns:
        v = series_of(node, bars, resolution, htf, cs.instances)[at]
        cols[name] = None if v is None or v != v or v in (float("inf"), float("-inf")) else float(v)
    seen = bars[:at + 1]
    divs = [p for ref in cs.divs if (p := _latest_pivot(cs, ref, seen, htf, resolution))]
    return Judgement(True, int(bars[at].time.timestamp() * 1000), cols, None, divs)
