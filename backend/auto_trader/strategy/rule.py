"""Rule-based strategy driven by a frontend-built rule set.

The engine does no indicator math: the frontend computes each indicator series
from the exact candles being backtested and posts them alongside the rules.
This module only evaluates rules against those series (plus bar price and
constants).
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace

from auto_trader.core.models import Side, Signal
from auto_trader.strategy.base import Context, Strategy


@dataclass(frozen=True, slots=True)
class Operand:
    """One side of a Rule. Exactly one of the kind-specific fields is used:
    kind="indicator" -> indicator/length (+ anchor for AVWAP); kind="price" -> field; kind="const" -> value.
    """

    kind: str  # "indicator" | "price" | "const" | "entry"
    indicator: str | None = None
    length: int | None = None
    field: str | None = None
    value: float | None = None
    anchor: int | None = None  # AVWAP only: anchor epoch-ms; keys the series
    timeframe: str | None = None  # higher timeframe this indicator runs on; keys the series (None ⇒ base)
    # Slope lookback (bars): when set, the operand's value is the %/hr tangent rate
    # of change of its underlying curve (÷ elapsed time), computed frontend-side and
    # posted as its own series. Keys the series (series_name). indicator/price only.
    slope_len: int | None = None


@dataclass(frozen=True, slots=True)
class Rule:
    left: Operand
    op: str  # "crossesAbove" | "crossesBelow" | "crosses" | "gt" | "lt" | "gte" | "lte"
    right: Operand
    # Optional "Nth time" modifier, applied only when the rule is evaluated as an
    # EXIT: the rule is satisfied on the Nth bar since entry on which its base
    # comparison is true (cumulative — non-consecutive bars count). None/≤1 keeps
    # the default fire-on-first-occurrence behaviour.
    count: int | None = None


@dataclass(frozen=True, slots=True)
class RuleGroup:
    combine: str  # "AND" | "OR"
    rules: list[Rule] = field(default_factory=list)


def series_name(op: Operand) -> str | None:
    """The payload key this operand's series lives under, or None if it has no
    series (a plain price/const is read straight off the candle). AVWAP is keyed by
    its anchor (epoch-ms) so distinct anchors are distinct series; VOL has no param;
    the rest are keyed by length. A SLOPED operand always keys a series (even price,
    which normally has none): the slope suffix `~len` is appended BEFORE any `@tf`."""
    if op.kind == "indicator":
        if op.indicator == "VOL":
            base = "VOL"
        elif op.indicator == "AVWAP":
            base = f"AVWAP_{op.anchor or 0}"
        else:
            base = f"{op.indicator}_{op.length}"
    elif op.kind == "price" and op.slope_len is not None:
        # A plain price has no series; a sloped price does — it needs v[i−N].
        base = op.field or "price"
    else:
        return None
    if op.slope_len is not None:
        base = f"{base}~{op.slope_len}"
    # A per-operand timeframe qualifies the key so a base-timeframe indicator and
    # the same indicator on a higher timeframe are distinct series. None ⇒ base ⇒
    # the bare key. Must match the frontend's seriesName (backtestConfig.ts),
    # slope-suffix-before-timeframe ordering included.
    return f"{base}@{op.timeframe}" if op.timeframe else base


def _operand_name(op: Operand) -> str:
    if op.slope_len is not None:
        # Render sloped operands legibly in exit reasons: slope(EMA_9,3), not the
        # raw series key EMA_9~3. Keep the timeframe (slope(EMA_9@HOUR,3)) so a
        # sloped MTF operand is distinguishable from the base-timeframe one.
        inner = _operand_name(replace(op, slope_len=None))
        return f"slope({inner},{op.slope_len})"
    name = series_name(op)
    if name is not None:
        return name
    if op.kind == "price":
        return op.field or "price"
    if op.kind == "entry":
        return "entryPrice"
    return str(op.value)


CROSS_OPS = {"crossesAbove", "crossesBelow", "crosses"}


class RuleStrategy(Strategy):
    """Hedging rule strategy: four independent rule groups drive two buckets.

    Long: `long_entry` emits a BUY (leg=long) whenever the entry rule passes —
    the ENGINE decides whether that opens a new position or is rejected by the
    cap/spacing — and `long_exit` emits a SELL (leg=long) while the side holds.
    Short mirrors it (SELL to open, BUY to close). Long and short are
    independent — the strategy can hold both at once.

    `long_enabled` / `short_enabled` turn a whole side off: when a side is
    disabled its bucket is skipped entirely — no entries AND no exits — so it
    never trades even if its rule groups are populated. This is an explicit
    switch, distinct from an empty rule group: the user keeps their rules while
    the side is parked. A disabled side never opens a position, so skipping its
    exit is moot (nothing to close). Both default on.

    `trade_from_time` (unix seconds, optional) gates BOTH entry legs (D6): bars
    before it are history loaded purely to warm the series up. Exits are never
    gated — no bucket can hold anything there, since no entry could have fired.
    """

    def __init__(
        self,
        long_entry: RuleGroup,
        long_exit: RuleGroup,
        short_entry: RuleGroup,
        short_exit: RuleGroup,
        series: dict[str, list[float | None]],
        quantity: float,
        trade_from_time: int | None = None,
        *,
        long_enabled: bool = True,
        short_enabled: bool = True,
    ) -> None:
        self.long_entry = long_entry
        self.long_exit = long_exit
        self.short_entry = short_entry
        self.short_exit = short_exit
        self.series = series
        self.quantity = quantity
        self.trade_from_time = trade_from_time
        self.long_enabled = long_enabled
        self.short_enabled = short_enabled

    def on_bar(self, ctx: Context) -> list[Signal]:
        i = len(ctx.history) - 1
        gated = (
            self.trade_from_time is not None
            and ctx.bar.time.timestamp() < self.trade_from_time
        )
        signals: list[Signal] = []

        # Long: entry fires whenever the rule passes (the ENGINE caps how many
        # positions open); exit fires only while the side is holding.
        if self.long_enabled:
            if not gated:
                passed, results = self._eval_group(self.long_entry, ctx, i, "long", is_exit=False)
                if passed:
                    signals.append(
                        Signal(Side.BUY, self.quantity, self._reason(self.long_entry, results), leg="long")
                    )
            if ctx.position_long > 0:
                passed, results = self._eval_group(self.long_exit, ctx, i, "long", is_exit=True)
                if passed:
                    signals.append(
                        Signal(Side.SELL, self.quantity, self._reason(self.long_exit, results), leg="long")
                    )

        if self.short_enabled:
            if not gated:
                passed, results = self._eval_group(self.short_entry, ctx, i, "short", is_exit=False)
                if passed:
                    signals.append(
                        Signal(Side.SELL, self.quantity, self._reason(self.short_entry, results), leg="short")
                    )
            if ctx.position_short > 0:
                passed, results = self._eval_group(self.short_exit, ctx, i, "short", is_exit=True)
                if passed:
                    signals.append(
                        Signal(Side.BUY, self.quantity, self._reason(self.short_exit, results), leg="short")
                    )

        return signals

    # --- evaluation ---------------------------------------------------------

    def _eval_group(
        self, group: RuleGroup, ctx: Context, i: int, side: str, *, is_exit: bool
    ) -> tuple[bool, list[bool]]:
        if not group.rules:
            return False, []
        results = [self._eval_rule(r, ctx, i, side, is_exit) for r in group.rules]
        passed = all(results) if group.combine == "AND" else any(results)
        return passed, results

    def _eval_rule(self, rule: Rule, ctx: Context, i: int, side: str, is_exit: bool) -> bool:
        n = rule.count or 1
        # Count only applies to exits, and only once we can locate the entry bar.
        # Otherwise the rule keeps its default fire-on-first-occurrence behaviour.
        if is_exit and n > 1:
            entry_idx = self._entry_index(ctx, side)
            if entry_idx is None:
                return False
            # Count cumulative occurrences since entry; `cur` ends as the current
            # bar's truth. Fire only ON an occurrence bar (current true) once the
            # tally has reached N — so it triggers on the Nth occurrence rather
            # than latching true on every later bar.
            tally = 0
            cur = False
            for j in range(entry_idx, i + 1):
                cur = self._base_true_at(rule, ctx, j, side)
                if cur:
                    tally += 1
            return cur and tally >= n
        return self._base_true_at(rule, ctx, i, side)

    def _base_true_at(self, rule: Rule, ctx: Context, i: int, side: str) -> bool:
        """The rule's raw comparison at bar index `i`, ignoring any count."""
        lnow, lprev = self._operand_values(rule.left, ctx, i, side)
        rnow, rprev = self._operand_values(rule.right, ctx, i, side)

        if rule.op in CROSS_OPS:
            # D2: needs a previous bar and every value present, or it's False.
            if i == 0 or None in (lnow, lprev, rnow, rprev):
                return False
            if rule.op == "crossesAbove":
                return lprev <= rprev and lnow > rnow
            if rule.op == "crossesBelow":
                return lprev >= rprev and lnow < rnow
            # crosses: either direction.
            return (lprev <= rprev and lnow > rnow) or (lprev >= rprev and lnow < rnow)

        # D2: a non-cross comparison with a None operand is False, not omitted.
        if lnow is None or rnow is None:
            return False
        if rule.op == "gt":
            return lnow > rnow
        if rule.op == "lt":
            return lnow < rnow
        if rule.op == "gte":
            return lnow >= rnow
        if rule.op == "lte":
            return lnow <= rnow
        raise ValueError(f"unknown operator '{rule.op}'")

    def _entry_index(self, ctx: Context, side: str) -> int | None:
        """Index in `ctx.history` of the bar the position opened on — the bar whose
        interval CONTAINS the entry time (the last bar with `time <= entry_time`).

        In backtest the entry time is exactly a bar's open time, so this is that
        bar (fill-bar inclusive, matching the counted-exit semantics). In live a
        mid-bar broker fill lands inside a bar; using `>= t` would pick the bar
        *after* it and drop the entry bar's own close from the count.

        Degrades safely for the live rolling window (these never occur in
        backtest, where the entry bar is always present with an exact time):
        an unknown entry time, or an entry that predates the loaded window, counts
        over the whole window from index 0 — a best-effort tally so a counted exit
        still fires rather than silently never closing the position. Occurrences
        before the window are unavoidably invisible, so this can under-count and
        fire late; that is preferable to never firing. None only when there are no
        bars to count at all."""
        if not ctx.history:
            return None
        t = ctx.long_entry_time if side == "long" else ctx.short_entry_time
        if t is None or t <= ctx.history[0].time:
            return 0
        idx = 0
        for j, bar in enumerate(ctx.history):
            if bar.time <= t:
                idx = j
            else:
                break
        return idx

    def _operand_values(
        self, op: Operand, ctx: Context, i: int, side: str
    ) -> tuple[float | None, float | None]:
        if op.kind == "const":
            return op.value, op.value
        if op.kind == "entry":
            # The position's entry price is constant for the life of the trade, so
            # both "now" and "prev" equal it (a moving series can cross the flat
            # entry line naturally).
            ep = ctx.long_entry_price if side == "long" else ctx.short_entry_price
            return ep, ep
        # A plain price reads off the candle; a SLOPED price (op.slope_len set) is a
        # derived series like any indicator, so it falls through to the series read.
        if op.kind == "price" and op.slope_len is None:
            now = getattr(ctx.history[i], op.field)
            prev = getattr(ctx.history[i - 1], op.field) if i > 0 else None
            return now, prev
        # indicator, or any sloped operand
        name = series_name(op)
        arr = self.series.get(name, [])
        now = arr[i] if i < len(arr) else None
        prev = arr[i - 1] if 0 < i and i - 1 < len(arr) else None
        return now, prev

    def _reason(self, group: RuleGroup, results: list[bool]) -> str:
        joiner = " AND " if group.combine == "AND" else " OR "
        parts = [
            f"{_operand_name(r.left)} {r.op} {_operand_name(r.right)}"
            for r, passed in zip(group.rules, results)
            if passed
        ]
        return joiner.join(parts) if parts else ""
