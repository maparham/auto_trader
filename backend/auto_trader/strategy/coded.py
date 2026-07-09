"""CodedStrategy: run a user-authored Python module (on_bar(ctx)) through the
same Strategy seam RuleStrategy uses, in backtest AND live.

Contract (see the coded-strategies spec):
- STATELESS: a fresh StrategyContext per bar; everything derives from history +
  position. Backtest loops one CodedStrategy instance, live re-instantiates per
  request — module/global state would silently diverge, so none is offered.
- NETTED by construction: while any side is held, entry actions are dropped;
  exits are dropped when their side is flat. meta["hedged"]=True opts into the
  engine's hedged buckets (backtest-only — the live route refuses it).
- MEMOIZED indicators: each (indicator, params) series is computed ONCE over the
  full candle list and indexed per bar. Values at index i depend only on bars
  0..i (the formulas are causal), so precomputing over the full list leaks
  nothing — while naive per-bar recompute would be O(n²).
"""

from __future__ import annotations

import traceback
from dataclasses import dataclass
from datetime import datetime
from types import ModuleType
from typing import TYPE_CHECKING

import numpy as np

from auto_trader.core.candle_aggregate import resolution_seconds
from auto_trader.core.models import Candle, RuleTerm, Side, Signal
from auto_trader.indicators.core import (
    atr_series,
    avwap_series,
    ema_series,
    rsi_series,
    sma_series,
)
from auto_trader.indicators.mtf import align_htf_to_base, slope_of
from auto_trader.strategy.base import Context, Strategy
from auto_trader.strategy.params import resolve_params

if TYPE_CHECKING:
    from auto_trader.strategy.rule import RuleStrategy


class StrategyRuntimeError(Exception):
    """User strategy code failed (bad return value or an exception at a bar)."""


class NeedTimeframe(Exception):
    """An indicator was asked for a timeframe whose candles aren't loaded yet.
    The route catches this, fetches that TF, and re-runs (runs are stateless)."""

    def __init__(self, timeframe: str) -> None:
        super().__init__(f"need candles for timeframe '{timeframe}'")
        self.timeframe = timeframe


@dataclass(frozen=True, slots=True)
class Action:
    """What ctx.buy()/sell()/close_*()/exit() return; the strategy returns a
    list of these from on_bar. `leg` is "long"/"short", or "any" for ctx.exit()."""

    kind: str  # "open" | "close"
    leg: str  # "long" | "short" | "any"
    qty: float | None = None
    stop: float | None = None
    target: float | None = None
    reason: str = ""
    note: dict | None = None


class PositionView:
    """Netted read-only position facts for the strategy author."""

    def __init__(self, ctx: Context) -> None:
        self._long = ctx.position_long
        self._short = ctx.position_short
        self.entry_price = ctx.long_entry_price if self._long > 0 else (
            ctx.short_entry_price if self._short > 0 else None
        )
        self.entry_time = ctx.long_entry_time if self._long > 0 else (
            ctx.short_entry_time if self._short > 0 else None
        )

    @property
    def is_long(self) -> bool:
        return self._long > 0

    @property
    def is_short(self) -> bool:
        return self._short > 0

    @property
    def is_flat(self) -> bool:
        return self._long <= 0 and self._short <= 0

    @property
    def qty(self) -> float:
        return self._long if self._long > 0 else self._short


class StrategyContext:
    """The façade user code talks to at each bar. Indicator methods return the
    current CLOSED bar's value (None during warm-up); history arrays cover bars
    0..current only — no future bars are reachable."""

    def __init__(
        self,
        ctx: Context,
        candles: list[Candle],
        arrays: dict[str, np.ndarray],
        i: int,
        cache: dict[str, list[float | None]],
        strategy: "CodedStrategy",
    ) -> None:
        self._ctx = ctx
        self._candles = candles
        self._arrays = arrays
        self._i = i
        self._cache = cache
        self._strategy = strategy
        self.position = PositionView(ctx)
        # Raw per-side sizes for hedged strategies (netted authors use .position).
        self.position_long_qty = ctx.position_long
        self.position_short_qty = ctx.position_short

    # --- current bar ------------------------------------------------------
    @property
    def time(self) -> datetime:
        return self._candles[self._i].time

    @property
    def open(self) -> float:
        return self._candles[self._i].open

    @property
    def high(self) -> float:
        return self._candles[self._i].high

    @property
    def low(self) -> float:
        return self._candles[self._i].low

    @property
    def close(self) -> float:
        return self._candles[self._i].close

    @property
    def volume(self) -> float:
        return self._candles[self._i].volume

    # --- history (numpy views over bars 0..i, no lookahead) ----------------
    @property
    def opens(self) -> np.ndarray:
        return self._arrays["open"][: self._i + 1]

    @property
    def highs(self) -> np.ndarray:
        return self._arrays["high"][: self._i + 1]

    @property
    def lows(self) -> np.ndarray:
        return self._arrays["low"][: self._i + 1]

    @property
    def closes(self) -> np.ndarray:
        return self._arrays["close"][: self._i + 1]

    @property
    def volumes(self) -> np.ndarray:
        return self._arrays["volume"][: self._i + 1]

    @property
    def bars_since_entry(self) -> int | None:
        """Bars since the held position's entry bar (0 on the fill bar), or None
        when flat. The entry bar is the last bar with time <= entry_time,
        mirroring RuleStrategy._entry_index."""
        t = self.position.entry_time
        if t is None:
            return None
        hist = self._ctx.history
        if not hist:
            return None
        if t <= hist[0].time:
            return self._i
        idx = 0
        for j, bar in enumerate(hist):
            if bar.time <= t:
                idx = j
            else:
                break
        return self._i - idx

    # --- indicators (memoized full-series compute, current-bar read) -------
    def _values_for(self, key: str, tf: str | None, values_fn) -> list[float | None]:
        """The full memoized series for `key` on `tf` (None = base). `values_fn`
        computes it over a given candle list (causal — index i sees 0..i only)."""
        cache_key = f"{key}@{tf}" if tf else key
        arr = self._cache.get(cache_key)
        if arr is not None:
            return arr
        if tf is None:
            arr = values_fn(self._candles)
        else:
            htf = self._strategy.htf_candles.get(tf)
            if htf is None:
                raise NeedTimeframe(tf)
            base_ms = self._strategy.base_times_ms
            htf_ms = resolution_seconds(tf) * 1000
            arr = align_htf_to_base(base_ms, htf, values_fn(htf), htf_ms)
        self._cache[cache_key] = arr
        return arr

    def ema(self, length: int, tf: str | None = None) -> float | None:
        return self._values_for(
            f"EMA_{length}", tf,
            lambda cs: ema_series([c.close for c in cs], length),
        )[self._i]

    def sma(self, length: int, tf: str | None = None) -> float | None:
        return self._values_for(
            f"SMA_{length}", tf,
            lambda cs: sma_series([c.close for c in cs], length),
        )[self._i]

    def rsi(self, length: int, tf: str | None = None) -> float | None:
        return self._values_for(
            f"RSI_{length}", tf,
            lambda cs: rsi_series([c.close for c in cs], length),
        )[self._i]

    def atr(self, length: int, tf: str | None = None) -> float | None:
        return self._values_for(f"ATR_{length}", tf, lambda cs: atr_series(cs, length))[self._i]

    def avwap(self, anchor_ms: int, tf: str | None = None) -> float | None:
        return self._values_for(
            f"AVWAP_{anchor_ms}", tf, lambda cs: avwap_series(cs, anchor_ms)
        )[self._i]

    def vol(self) -> float | None:
        return self._candles[self._i].volume

    def volma(self, length: int, tf: str | None = None) -> float | None:
        return self._values_for(
            f"VOLMA_{length}", tf,
            lambda cs: sma_series([c.volume for c in cs], length),
        )[self._i]

    _SLOPE_SOURCES = {"EMA": ema_series, "SMA": sma_series, "RSI": rsi_series}

    def slope(self, indicator: str, length: int | None, n: int,
              tf: str | None = None) -> float | None:
        """%/hr slope over n bars of an indicator ("EMA"/"SMA"/"RSI" + length) or
        a price field ("close"/"open"/"high"/"low", length=None) — same formula
        and time normalization as the rule builder's slope operands. The slope is
        taken on the operand's NATIVE timeframe before alignment (backtestSeries
        rule), so tf= slopes difference HTF values, not forward-filled ones.

        Note on tf=: the HTF fetch (route's NeedTimeframe retry) only spans the
        base request's window, with no extra warm-up lookback — so early bars can
        have too few HTF samples for `length`/`n` and this (like other tf= reads)
        returns None there. Guard for None before using the result."""
        tf_key = tf or self._strategy.base_timeframe
        bar_hours = (resolution_seconds(tf_key) if tf_key else 3600) / 3600
        if indicator in self._SLOPE_SOURCES and length is not None:
            fn = self._SLOPE_SOURCES[indicator]
            key = f"{indicator}_{length}~{n}"

            def values_fn(cs: list[Candle]) -> list[float | None]:
                return slope_of(fn([c.close for c in cs], length), n, bar_hours)
        elif indicator in ("close", "open", "high", "low"):
            key = f"{indicator}~{n}"

            def values_fn(cs: list[Candle]) -> list[float | None]:
                return slope_of([getattr(c, indicator) for c in cs], n, bar_hours)
        else:
            raise StrategyRuntimeError(f"unknown slope source '{indicator}'")
        return self._values_for(key, tf, values_fn)[self._i]

    def param(self, name: str):
        """A panel-tunable value declared in meta["params"] (panel value if
        set, else the declared default)."""
        try:
            return self._strategy.params[name]
        except KeyError:
            declared = sorted(self._strategy.params) or ["<none declared>"]
            raise StrategyRuntimeError(
                f"unknown param '{name}' — declared params: {declared}"
            ) from None

    # --- actions ------------------------------------------------------------
    def buy(self, qty: float | None = None, sl: float | None = None,
            tp: float | None = None, reason: str = "", note: dict | None = None) -> Action:
        return Action("open", "long", qty=qty, stop=sl, target=tp, reason=reason, note=note)

    def sell(self, qty: float | None = None, sl: float | None = None,
             tp: float | None = None, reason: str = "", note: dict | None = None) -> Action:
        return Action("open", "short", qty=qty, stop=sl, target=tp, reason=reason, note=note)

    def close_long(self, reason: str = "", note: dict | None = None) -> Action:
        return Action("close", "long", reason=reason, note=note)

    def close_short(self, reason: str = "", note: dict | None = None) -> Action:
        return Action("close", "short", reason=reason, note=note)

    def exit(self, reason: str = "", note: dict | None = None) -> Action:
        """Close whichever side is held (long or short) — for netted strategies
        that don't need to name the side. Expands to both legs; the engine
        drops the leg that isn't actually held."""
        return Action("close", "any", reason=reason, note=note)


def _note_terms(note: dict | None) -> tuple[RuleTerm, ...]:
    """An author's note={"rsi": 71.2, ...} rendered through the same terms
    channel the rule popover uses: one term per entry, value on the left, no
    operator/right side."""
    if not note:
        return ()
    out = []
    for k, v in note.items():
        try:
            val = float(v)
        except (TypeError, ValueError):
            val = None
        out.append(RuleTerm(left_label=str(k), left_val=val, op="",
                            right_label="", right_val=None))
    return tuple(out)


class CodedStrategy(Strategy):
    """Adapts a loaded user module to the Strategy interface. `candles` is the
    FULL bar list of the run (backtest: the posted candles; live: the rolling
    window) — the indicator cache computes each series once over it."""

    def __init__(self, module: ModuleType, candles: list[Candle], quantity: float,
                 trade_from_time: int | None = None,
                 htf_candles: dict[str, list[Candle]] | None = None,
                 base_timeframe: str | None = None,
                 params: dict | None = None,
                 panel_risk_legs: frozenset[str] = frozenset()) -> None:
        self.module = module
        self.candles = candles
        self.quantity = quantity
        self.trade_from_time = trade_from_time
        self.htf_candles = htf_candles or {}
        self.base_timeframe = base_timeframe
        self.base_times_ms = [int(c.time.timestamp() * 1000) for c in candles]
        meta = getattr(module, "meta", None)
        self.hedged = bool(meta.get("hedged", False)) if isinstance(meta, dict) else False
        # Resolved panel params (defaults when none sent). Direct instantiation
        # (tests) may omit them; routes resolve first so a bad value 422s
        # before any bars run.
        self.params = params if params is not None else resolve_params(module, None)
        # Legs ("long"/"short") for which the panel configured risk: on those
        # sides the file's per-signal sl=/tp= are stripped so the engine's
        # side-level RiskConfig applies instead (never silently — see
        # file_brackets_overridden below).
        self.panel_risk_legs = panel_risk_legs
        self.file_brackets_overridden = False
        self._cache: dict[str, list[float | None]] = {}
        self._arrays: dict[str, np.ndarray] = {
            "open": np.array([c.open for c in candles], dtype=np.float64),
            "high": np.array([c.high for c in candles], dtype=np.float64),
            "low": np.array([c.low for c in candles], dtype=np.float64),
            "close": np.array([c.close for c in candles], dtype=np.float64),
            "volume": np.array([c.volume for c in candles], dtype=np.float64),
        }

    def on_bar(self, ctx: Context) -> list[Signal]:
        i = len(ctx.history) - 1
        sctx = StrategyContext(ctx, self.candles, self._arrays, i, self._cache, self)
        try:
            actions = self.module.on_bar(sctx) or []
        except NeedTimeframe:
            raise
        except Exception as e:
            file = getattr(self.module, "__file__", "<strategy>")
            tb = traceback.format_exc(limit=-1)
            raise StrategyRuntimeError(
                f"{file} raised at bar {i} ({ctx.bar.time.isoformat()}): {e}\n{tb}"
            ) from e
        if not isinstance(actions, (list, tuple)):
            actions = [actions]

        gated = (
            self.trade_from_time is not None
            and ctx.bar.time.timestamp() < self.trade_from_time
        )
        held = ctx.position_long > 0 or ctx.position_short > 0
        signals: list[Signal] = []
        opened_this_bar = False
        # Per-leg open flags, consulted/set on EVERY open (hedged or not) so a
        # hedged module can't emit two same-side opens in one bar; the netted
        # path additionally gates on `held or opened_this_bar` below.
        opened = {"long": False, "short": False}
        for a in actions:
            if not isinstance(a, Action):
                raise StrategyRuntimeError(
                    f"on_bar must return ctx.buy()/sell()/close_*() Action objects, got {a!r}"
                )
            if a.kind == "open":
                if gated:
                    continue
                if not self.hedged and (held or opened_this_bar):
                    continue  # netted: no scale-in, no hedge, one entry per bar
                if a.leg == "long" and (ctx.position_long > 0 or opened["long"]):
                    continue  # hedged mode still never scales into a held/just-opened side
                if a.leg == "short" and (ctx.position_short > 0 or opened["short"]):
                    continue
                side = Side.BUY if a.leg == "long" else Side.SELL
                qty = a.qty if a.qty is not None else self.quantity
                stop, target = a.stop, a.target
                if a.leg in self.panel_risk_legs:
                    # Panel risk owns this side's exits: the file's sl=/tp= are
                    # dropped so the engine's side-level RiskConfig applies.
                    if stop is not None or target is not None:
                        self.file_brackets_overridden = True
                    stop = target = None
                signals.append(Signal(
                    side, qty, a.reason, leg=a.leg,
                    terms=_note_terms(a.note),
                    stop_level=stop, target_level=target,
                    quantity_explicit=a.qty is not None,
                ))
                opened_this_bar = True
                opened[a.leg] = True
            else:  # close
                legs = ("long", "short") if a.leg == "any" else (a.leg,)
                for leg in legs:
                    size = ctx.position_long if leg == "long" else ctx.position_short
                    if size <= 0:
                        continue
                    side = Side.SELL if leg == "long" else Side.BUY
                    signals.append(Signal(
                        side, size, a.reason, leg=leg, terms=_note_terms(a.note),
                    ))
        return signals


class CodedWithRuleExits(Strategy):
    """A coded strategy plus panel-authored exit rule groups: the coded module
    supplies entries (and any exits of its own); a RuleStrategy configured with
    EMPTY entry groups contributes rule-based exits. One close per leg per bar
    — the coded module's own close wins when both fire."""

    _CLOSES = {("long", Side.SELL), ("short", Side.BUY)}

    def __init__(self, coded: CodedStrategy, rule_exits: "RuleStrategy") -> None:
        self.coded = coded
        self.rule_exits = rule_exits
        self.hedged = coded.hedged

    @property
    def file_brackets_overridden(self) -> bool:
        return self.coded.file_brackets_overridden

    def on_bar(self, ctx: Context) -> list[Signal]:
        out = self.coded.on_bar(ctx)
        closed = {s.leg for s in out if (s.leg, s.side) in self._CLOSES}
        for s in self.rule_exits.on_bar(ctx):
            if (s.leg, s.side) in self._CLOSES and s.leg not in closed:
                # Rule exits close the WHOLE held side, like coded ctx.exit().
                # size can be 0 on the coded entry's own signal bar (the buy
                # hasn't filled yet) — a zero-size close must not be emitted.
                size = ctx.position_long if s.leg == "long" else ctx.position_short
                if size <= 0:
                    continue
                out.append(Signal(s.side, size, s.reason, leg=s.leg,
                                  terms=s.terms, combine=s.combine))
                closed.add(s.leg)
        return out
