from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

from auto_trader.core.candle_aggregate import resolution_seconds
from auto_trader.core.models import Candle
from auto_trader.indicators.core import (
    atr_series, avwap_series, ema_series, rsi_series, sma_series,
)
from auto_trader.indicators.mtf import align_htf_to_base, slope_of
from auto_trader.strategy.expr import nodes as N
from auto_trader.strategy.expr.warmup import warmup_bars


def candle_field(c: Candle, field: str) -> float | None:
    if field == "open":
        return c.open
    if field == "high":
        return c.high
    if field == "low":
        return c.low
    if field == "close":
        return c.close
    if field == "volume":
        return c.volume
    if field == "body":
        return abs(c.close - c.open)
    if field == "range":
        return c.high - c.low
    if field == "wickTop":
        return c.high - max(c.open, c.close)
    if field == "wickBottom":
        return min(c.open, c.close) - c.low
    return None


def _tf_hours(resolution: str) -> float:
    return resolution_seconds(resolution) / 3600


def _window(raw: Sequence[float | None], n: int, kind: str) -> list[float | None]:
    """highest/lowest/avg over the last n bars INCLUDING the current bar."""
    out: list[float | None] = [None] * len(raw)
    for i in range(len(raw)):
        if i + 1 < n:
            continue
        window = raw[i - n + 1 : i + 1]
        # A None or NaN anywhere in the window poisons the whole bar. NaN must be
        # screened explicitly: max/min over a list containing NaN is order-
        # dependent, so highest/lowest could otherwise return a finite value and
        # defeat the spec's NaN-poisoning rule.
        if any(v is None or (isinstance(v, float) and math.isnan(v)) for v in window):
            continue
        vals = [float(v) for v in window]  # type: ignore[arg-type]
        out[i] = max(vals) if kind == "highest" else min(vals) if kind == "lowest" else sum(vals) / n
    return out


def _indicator_raw(name: str, args_vals: list[float], candles: Sequence[Candle]) -> list[float | None]:
    closes = [c.close for c in candles]
    if name == "EMA":
        return ema_series(closes, int(args_vals[0]))
    if name == "SMA":
        return sma_series(closes, int(args_vals[0]))
    if name == "RSI":
        return rsi_series(closes, int(args_vals[0]))
    if name == "ATR":
        return atr_series(candles, int(args_vals[0]))
    if name == "VOLMA":
        return sma_series([c.volume for c in candles], int(args_vals[0]))
    if name == "VOL":
        return [c.volume for c in candles]
    if name == "AVWAP":
        return avwap_series(candles, int(args_vals[0]))
    return [None] * len(candles)


def series_of(node: N.Node, candles: Sequence[Candle], resolution: str,
              htf: dict[str, list[Candle]]) -> list[float | None]:
    """Evaluate an `entry`-free node to a per-bar array over `candles`."""
    n = len(candles)
    if isinstance(node, N.Num):
        return [node.value] * n
    if isinstance(node, N.Candle):
        assert node.field is not None
        return [candle_field(c, node.field) for c in candles]
    if isinstance(node, N.Entry):
        raise ValueError("entry is not a series")
    if isinstance(node, N.Field):
        # Only reachable for candle.field (validated); a Field over a Candle base.
        base = node.base
        if isinstance(base, (N.Candle,)):
            return [candle_field(c, node.name) for c in candles]
        # candle-with-postfix, e.g. candle@TF.high or candle[-1].open: the field
        # lives on the base candle expression -> rebuild a Candle at that field.
        return series_of(_apply_field_to_candle(base, node.name), candles, resolution, htf)
    if isinstance(node, N.Offset):
        base = series_of(node.base, candles, resolution, htf)
        return [base[i - node.n] if i >= node.n else None for i in range(n)]
    if isinstance(node, N.Tf):
        tf_candles = htf.get(node.tf, [])
        tf_vals = series_of(node.base, tf_candles, node.tf, htf)
        base_ms = [int(c.time.timestamp() * 1000) for c in candles]
        tf_ms = resolution_seconds(node.tf) * 1000
        return align_htf_to_base(base_ms, tf_candles, tf_vals, tf_ms)
    if isinstance(node, N.Unary):
        inner = series_of(node.operand, candles, resolution, htf)
        return [None if v is None else -v for v in inner]
    if isinstance(node, N.Binary):
        left = series_of(node.left, candles, resolution, htf)
        right = series_of(node.right, candles, resolution, htf)
        return [_binop(node.op, left[i], right[i]) for i in range(n)]
    if isinstance(node, N.Call):
        if node.name in WRAPPER_KINDS:
            inner = series_of(node.args[0], candles, resolution, htf)
            length = int(series_of(node.args[1], candles, resolution, htf)[0] or 0)
            if node.name == "slope":
                return slope_of(inner, length, _tf_hours(resolution))
            return _window(inner, length, node.name)
        arg_vals = [float(series_of(a, candles, resolution, htf)[0] or 0) for a in node.args]
        return _indicator_raw(node.name, arg_vals, candles)
    raise ValueError(f"cannot evaluate {type(node).__name__} as a series")


WRAPPER_KINDS = ("slope", "highest", "lowest", "avg")


def _apply_field_to_candle(base: N.Node, field: str) -> N.Node:
    """Rewrite `candle`-rooted postfix so the field is on the candle leaf:
    Tf(Candle(None), tf).field -> Tf(Candle(field), tf); Offset likewise."""
    import dataclasses
    if isinstance(base, N.Candle):
        return dataclasses.replace(base, field=field)
    if isinstance(base, N.Offset):
        return dataclasses.replace(base, base=_apply_field_to_candle(base.base, field))
    if isinstance(base, N.Tf):
        return dataclasses.replace(base, base=_apply_field_to_candle(base.base, field))
    raise ValueError("field base is not candle-rooted")


def _binop(op: str, a: float | None, b: float | None) -> float | None:
    if a is None or b is None:
        return None
    if op == "+":
        return a + b
    if op == "-":
        return a - b
    if op == "*":
        return a * b
    if op == "/":
        return a / b if b != 0 else math.nan
    raise ValueError(op)


def _defined(v: float | None) -> bool:
    return v is not None and not (isinstance(v, float) and math.isnan(v))


@dataclass(slots=True)
class CompiledRow:
    node: N.Compare | N.Cross | N.Chain
    candles: Sequence[Candle]
    resolution: str
    htf: dict[str, list[Candle]]
    warmup: int
    _cache: dict[int, list[float | None]]

    def _val(self, sub: N.Node, i: int, entry: float | None) -> float | None:
        # entry-free sub-expressions are precomputed to arrays; entry-bearing ones
        # recurse per bar (entry is a scalar constant across the trade).
        key = id(sub)
        if key in self._cache:
            return self._cache[key][i] if 0 <= i < len(self._cache[key]) else None
        if isinstance(sub, N.Entry):
            return entry
        if isinstance(sub, N.Num):
            return sub.value
        if isinstance(sub, N.Candle):
            assert sub.field is not None
            return candle_field(self.candles[i], sub.field) if 0 <= i < len(self.candles) else None
        if isinstance(sub, N.Unary):
            v = self._val(sub.operand, i, entry)
            return None if v is None else -v
        if isinstance(sub, N.Binary):
            return _binop(sub.op, self._val(sub.left, i, entry), self._val(sub.right, i, entry))
        # Any remaining node is entry-free -> it was precomputed; guard defensively.
        arr = series_of(sub, self.candles, self.resolution, self.htf)
        self._cache[key] = arr
        return arr[i] if 0 <= i < len(arr) else None

    def _cmp(self, part: N.Compare, i: int, entry: float | None) -> bool:
        l = self._val(part.left, i, entry)
        r = self._val(part.right, i, entry)
        if not (_defined(l) and _defined(r)):
            return False
        if part.op == ">":
            return l > r
        if part.op == "<":
            return l < r
        if part.op == ">=":
            return l >= r
        return l <= r

    def evaluate(self, i: int, entry_price: float | None) -> bool:
        node = self.node
        if isinstance(node, N.Compare):
            return self._cmp(node, i, entry_price)
        if isinstance(node, N.Chain):
            return all(self._cmp(p, i, entry_price) for p in node.parts)
        # Cross
        if i == 0:
            return False
        lnow = self._val(node.a, i, entry_price)
        lprev = self._val(node.a, i - 1, entry_price)
        rnow = self._val(node.b, i, entry_price)
        rprev = self._val(node.b, i - 1, entry_price)
        if not all(_defined(v) for v in (lnow, lprev, rnow, rprev)):
            return False
        if node.fn == "crossAbove":
            return lprev <= rprev and lnow > rnow
        return lprev >= rprev and lnow < rnow


def _entry_free(node: N.Node) -> bool:
    if isinstance(node, N.Entry):
        return False
    if isinstance(node, N.Num) or isinstance(node, N.Candle):
        return True
    if isinstance(node, (N.Offset, N.Tf)):
        return _entry_free(node.base)
    if isinstance(node, N.Field):
        return _entry_free(node.base)
    if isinstance(node, N.Unary):
        return _entry_free(node.operand)
    if isinstance(node, N.Binary):
        return _entry_free(node.left) and _entry_free(node.right)
    if isinstance(node, N.Call):
        return all(_entry_free(a) for a in node.args)
    return True


def _precompute(node: N.Node, candles, resolution, htf, cache: dict[int, list[float | None]]) -> None:
    """Precompute arrays for maximal entry-free sub-nodes (skip pure Num/Candle:
    those are cheap per bar and keep the per-bar cross path simple)."""
    if _entry_free(node) and not isinstance(node, (N.Num, N.Candle)):
        cache[id(node)] = series_of(node, candles, resolution, htf)
        return
    if isinstance(node, N.Unary):
        _precompute(node.operand, candles, resolution, htf, cache)
    elif isinstance(node, N.Binary):
        _precompute(node.left, candles, resolution, htf, cache)
        _precompute(node.right, candles, resolution, htf, cache)


def compile_row(node: N.Compare | N.Cross | N.Chain, candles, resolution, htf) -> CompiledRow:
    cache: dict[int, list[float | None]] = {}
    if isinstance(node, N.Chain):
        subs = [operand for p in node.parts for operand in (p.left, p.right)]
    elif isinstance(node, N.Compare):
        subs = [node.left, node.right]
    else:
        subs = [node.a, node.b]
    for sub in subs:
        _precompute(sub, candles, resolution, htf, cache)
    return CompiledRow(node, candles, resolution, htf, warmup_bars(node), cache)
