"""One symbol's verdict for a screen: compile the screen's condition and
columns once, then judge each symbol's candles on its last CLOSED bar.

Pure: no I/O. The runner (api/screen_jobs.py) fetches candles and hands them
here, which keeps this module testable with plain Candle lists.

Screens fetch no higher timeframes, so `@tf` pins and panes pinned to a
timeframe in their settings are refused at compile time rather than misjudged.
Pane references resolve against the screen's own `indicators` map."""

from __future__ import annotations

from dataclasses import dataclass

from auto_trader.api.sweep_apply import referenced_tfs
from auto_trader.core.models import Candle
from auto_trader.indicators.registry import ResolvedInstance, resolve_instances
from auto_trader.strategy.expr import nodes as N
from auto_trader.strategy.expr.errors import ExprError
from auto_trader.strategy.expr.evaluate import compile_row, series_of
from auto_trader.strategy.expr.parser import parse, parse_value
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


@dataclass(frozen=True, slots=True)
class Judgement:
    matched: bool
    bar_time_ms: int | None
    columns: dict[str, float | None]
    skip_reason: str | None


def _refuse_unsupported(node: N.Node, src: str, instances: dict[str, ResolvedInstance]) -> None:
    if referenced_tfs(node, None):
        raise ExprError("screen_tf_unsupported",
                        "Timeframe pins like @D are not available in screens yet.",
                        0, len(src))
    for iid, inst in instances.items():
        pin = referenced_tfs(node, {iid: inst})
        if pin:
            raise ExprError("screen_tf_unsupported",
                            f"{iid} is pinned to {next(iter(pin))} in its settings. "
                            "Screens run on one timeframe, so unpin it on the chart.",
                            0, len(src))


def _screen_wording(e: ExprError, src: str) -> ExprError:
    """validate() says 'on this chart'; a screen has no chart."""
    if e.code != "unknown_indicator_ref":
        return e
    iid = src[e.start:e.end].split(".", 1)[0]
    return ExprError(e.code, f"{iid} is not one of this screen's indicators. "
                     "Add it to a chart and pick it from there.", e.start, e.end)


def compile_screen(expression: str, columns: list[dict],
                   indicators: dict[str, dict] | None = None) -> CompiledScreen:
    instances = resolve_instances(indicators or {})
    try:
        row = parse(expression)
        validate(row, is_exit=False, instances=instances)
        _refuse_unsupported(row, expression, instances)
    except ExprError as e:
        raise ScreenSpecError("expression", 0, _screen_wording(e, expression)) from e
    cols: list[tuple[str, N.Node]] = []
    for idx, col in enumerate(columns):
        src = col["expression"]
        try:
            node = parse_value(src)
            validate_value(node, instances)
            _refuse_unsupported(node, src, instances)
        except ExprError as e:
            raise ScreenSpecError("columns", idx, _screen_wording(e, src)) from e
        cols.append((col["name"], node))
    warm = max([warmup_bars(row, None, instances)] + [warmup_bars(n, None, instances) for _, n in cols])
    return CompiledScreen(row, expression, cols, warm, instances)


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


def judge(cs: CompiledScreen, bars: list[Candle], resolution: str) -> Judgement:
    if len(bars) < cs.warmup + 1:
        return Judgement(False, None, {}, "not enough history")
    compiled = compile_row(cs.row, bars, resolution, {}, cs.instances, source=cs.source)
    last = len(bars) - 1
    matched = compiled.evaluate(last, None)
    bar_ms = int(bars[last].time.timestamp() * 1000)
    cols: dict[str, float | None] = {}
    if matched:
        for name, node in cs.columns:
            v = series_of(node, bars, resolution, {}, cs.instances)[last]
            cols[name] = None if v is None or v != v or v in (float("inf"), float("-inf")) else float(v)
    return Judgement(bool(matched), bar_ms, cols, None)
