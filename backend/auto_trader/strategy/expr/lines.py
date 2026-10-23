"""Picked trendlines: a line the user froze off the chart, referenced in a rule
as a bare L<n>. Geometry is the line alert's (alertLineOf in the frontend's
trendlineMarks.ts): slope is price per bar of the line's OWN timeframe, so the
value is counted in bars, never in wall-clock time."""
from __future__ import annotations

import bisect
import math
import re
from dataclasses import dataclass
from typing import Sequence

from auto_trader.core.candle_aggregate import resolution_seconds

LINE_ID_RE = re.compile(r"L\d+")
MAX_LINES = 16
LINE_KEY_PREFIX = "line:"


def line_key(lid: str) -> str:
    return LINE_KEY_PREFIX + lid


class LineSpecError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code, self.message = code, message


@dataclass(frozen=True, slots=True)
class PickedLine:
    epic: str
    broker: str
    timeframe: str
    t1: int
    p1: float
    t2: int
    p2: float
    slope: float
    tRef: int
    pRef: float


def _native(tf: str) -> bool:
    if tf.startswith("SECOND"):
        return False
    try:
        resolution_seconds(tf)
    except ValueError:
        return False
    return True


def parse_lines(raw: dict[str, dict] | None) -> dict[str, PickedLine]:
    raw = raw or {}
    if len(raw) > MAX_LINES:
        raise LineSpecError("too_many_lines", f"A rule set can hold at most {MAX_LINES} picked lines.")
    out: dict[str, PickedLine] = {}
    for lid, d in raw.items():
        if not LINE_ID_RE.fullmatch(lid):
            raise LineSpecError("bad_line_id", f"{lid} is not a picked line id.")
        try:
            line = PickedLine(
                epic=str(d["epic"]), broker=str(d["broker"]), timeframe=str(d["timeframe"]),
                t1=int(d["t1"]), p1=float(d["p1"]), t2=int(d["t2"]), p2=float(d["p2"]),
                slope=float(d["slope"]), tRef=int(d["tRef"]), pRef=float(d["pRef"]),
            )
        except (KeyError, TypeError, ValueError):
            raise LineSpecError("bad_line", f"{lid} is missing part of its geometry.") from None
        if not all(math.isfinite(v) for v in (line.p1, line.p2, line.slope, line.pRef)):
            raise LineSpecError("bad_line", f"{lid} has a non-finite price or slope.")
        if line.t2 <= line.t1:
            raise LineSpecError("bad_line", f"{lid} has its anchors out of order.")
        if not _native(line.timeframe):
            raise LineSpecError("bad_line", f"{lid} is on an unsupported timeframe.")
        out[lid] = line
    return out


def _ms(c) -> int:
    return int(c.time.timestamp() * 1000)


def line_series(line: PickedLine | None, candles: Sequence) -> list[float | None]:
    n = len(candles)
    if line is None or n == 0:
        return [None] * n
    times = [_ms(c) for c in candles]
    start = bisect.bisect_left(times, line.t2)  # first bar at or after t2
    if start >= n:
        return [None] * n                       # range ends before the line exists
    if times[0] <= line.t2:
        j, q = start, line.p2
    else:
        jr = bisect.bisect_left(times, line.tRef)
        if jr >= n or line.tRef < times[0]:
            return [None] * n                   # no anchor inside: the rebase pre-pass failed
        j, q = jr, line.pRef
    return [None if k < start else q + line.slope * (k - j) for k in range(n)]


class _NoPinSpec:
    """Stands in for a ResolvedInstance's spec so `_pin_owner` and any
    `inst.spec.timeframe(inst.config)` call stay safe for a LineInstance: a
    picked line is never "pinned" the way a chart pane is (its own timeframe
    is handled by evaluate.py's LineRef branch and sweep_apply.referenced_tfs,
    not by the generic pin machinery)."""

    @staticmethod
    def timeframe(_cfg) -> None:
        return None

    @staticmethod
    def outputs(_cfg) -> list[str]:
        return []


_NO_PIN_SPEC = _NoPinSpec()


class LineInstance:
    """A picked line riding in the `instances` dict under line:L<n>. `active`
    is False when the line belongs to another symbol: the operand is then
    absent on every bar, which is not an error (a global backtest config run
    elsewhere). The geometry stays either way, so a screen compiled before it
    knows its symbols still fetches the line's timeframe."""
    type = "LINE"
    config = None
    spec = _NO_PIN_SPEC

    def __init__(self, line: PickedLine, active: bool = True):
        self.line = line
        self.active = active


def line_instances(lines: dict[str, PickedLine], *, epic: str, broker: str,
                   resolution: str) -> dict[str, "LineInstance"]:
    rule_s = resolution_seconds(resolution)
    out: dict[str, LineInstance] = {}
    for lid, line in lines.items():
        if resolution_seconds(line.timeframe) < rule_s:
            raise LineSpecError(
                "line_tf_finer",
                f"{lid} was picked on {line.timeframe}; run this rule on {line.timeframe} or a finer timeframe.")
        same = line.epic == epic and (not broker or not line.broker or line.broker == broker)
        out[line_key(lid)] = LineInstance(line, active=same)
    return out
