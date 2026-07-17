"""Event-driven backtest engine.

Design guarantees that make a backtest trustworthy:

1. No lookahead. The strategy is called at bar t with history up to and
   including t only. It never sees future bars.
2. Honest fills. A signal produced on bar t is filled at bar t+1's OPEN, not at
   bar t's close. This avoids the classic "trade at a price you couldn't have
   known" bug. A signal on the final bar is dropped (no next bar to fill on).
3. Same interface as live. The strategy receives the exact same Context it would
   get in paper/live trading; only the executor (here: simulated) differs.

Costs are modelled as a per-side commission plus optional slippage on the fill
price. Keep it explicit so results aren't accidentally optimistic.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta

from auto_trader.core.models import BarStats, BarTrace, Candle, Fill, Side, Signal, Trade
from auto_trader.engine.risk import RiskConfig, is_trailing, stop_level, target_level
from auto_trader.engine.scaling import ScalingConfig, spacing_ok
from auto_trader.engine.schedule import RecurrenceMask, is_active
from auto_trader.strategy.base import Context, Strategy

# UTC hour a held position rolls over and is charged one night of financing.
# Fixed (no per-run knob): brokers roll at a fixed daily instant and we model it
# as a static 21:00 UTC crossing.
ROLLOVER_HOUR_UTC = 21


@dataclass(slots=True)
class EquityPoint:
    time: datetime
    equity: float


@dataclass(slots=True)
class Position:
    """One open position on a side. For independent mode each entry is its own
    Position; for the current (single-bucket) behaviour a side holds at most one.
    `stop`/`target` are absolute levels (None = none); `extreme` is the favorable
    high/low water mark since entry (for trailing); `breakeven_armed` is reserved
    for a later phase and unused here."""
    qty: float
    entry: float
    open_time: datetime
    open_reason: str
    stop: float | None = None
    target: float | None = None
    extreme: float = 0.0
    breakeven_armed: bool = False
    stop_initial: float | None = None
    # Per-signal bracket fully overrides side-level risk for THIS position: it's
    # a static level, never ratcheted, and always reports "stop" (not "trail")
    # even if the side-level RiskConfig happens to be trailing.
    bracket_from_signal: bool = False
    # Excursion watermarks since entry (seeded at the fill price): the most
    # adverse and most favorable prices seen while open. Separate from
    # `extreme`, which only tracks the trailing-stop ratchet.
    adv_extreme: float = 0.0
    fav_extreme: float = 0.0
    # Per-bar dynamics accumulator, advanced once per held bar in _track_excursion.
    bar_stats: BarStats = field(default_factory=BarStats)
    # Overnight financing accrued while this position was open (positive = cost),
    # drawn down proportionally into each Trade as the position is reduced.
    financing: float = 0.0


@dataclass(slots=True)
class BacktestResult:
    fills: list[Fill] = field(default_factory=list)
    trades: list[Trade] = field(default_factory=list)
    equity: list[EquityPoint] = field(default_factory=list)
    # Per-bar inspector trace (empty unless the engine ran with inspect=True).
    bar_traces: list[BarTrace] = field(default_factory=list)

    # summary stats
    net_pnl: float = 0.0
    n_trades: int = 0
    win_rate: float = 0.0
    max_drawdown: float = 0.0
    # Total overnight financing charged across all trades (positive = net cost).
    financing_total: float = 0.0

    def summary(self) -> dict:
        return {
            "net_pnl": round(self.net_pnl, 5),
            "n_trades": self.n_trades,
            "win_rate": round(self.win_rate, 4),
            "max_drawdown": round(self.max_drawdown, 5),
            "financing_total": round(self.financing_total, 5),
        }


class BacktestEngine:
    def __init__(
        self,
        strategy: Strategy,
        starting_cash: float = 10_000.0,
        commission_per_side: float = 0.0,
        slippage: float = 0.0,
        spread: float = 0.0,
        slippage_atr_mult: float = 0.0,
        fin_long_daily_pct: float = 0.0,
        fin_short_daily_pct: float = 0.0,
        long_risk: RiskConfig | None = None,
        short_risk: RiskConfig | None = None,
        series: dict[str, list[float | None]] | None = None,
        long_scaling: ScalingConfig | None = None,
        short_scaling: ScalingConfig | None = None,
        mask: RecurrenceMask | None = None,
        inspect: bool = False,
    ) -> None:
        self.strategy = strategy
        self.mask = mask
        self.inspect = inspect
        self.starting_cash = starting_cash
        self.commission = commission_per_side
        self.slippage = slippage
        self.half_spread = spread / 2.0
        self.slippage_atr_mult = slippage_atr_mult
        self.fin_long_daily_pct = fin_long_daily_pct
        self.fin_short_daily_pct = fin_short_daily_pct
        self._slip_atr: list[float | None] = []
        self.long_risk = long_risk
        self.short_risk = short_risk
        self.series = series or {}
        self.long_scaling = long_scaling or ScalingConfig()
        self.short_scaling = short_scaling or ScalingConfig()

    def run(self, candles: list[Candle]) -> BacktestResult:
        result = BacktestResult()
        ctx = Context()

        self._slip_atr = self._wilder_atr14(candles) if self.slippage_atr_mult > 0 else []

        longs: list[Position] = []
        shorts: list[Position] = []
        realized = 0.0
        pending: list[Signal] = []  # signals from the previous bar, filled at this open

        peak_equity = self.starting_cash
        last_long_open: float | None = None
        last_short_open: float | None = None

        # Per-bar inspector snapshots (only when inspect is on). Each holds the bar's
        # group evaluations plus position/window state; action/reason are resolved
        # after the loop from the fills (cross-bar: a bar's signal fills at bar+1).
        inspect = self.inspect and hasattr(self.strategy, "inspect_groups")
        snapshots: list[dict] = []

        for i, bar in enumerate(candles):
            # 0) Overnight financing: charge every rollover instant crossed since
            # the previous bar, BEFORE any fill/close on this bar. A position that
            # closes on this bar still held through the night that just ended, so
            # it must be charged before it can leave longs/shorts. Accruing into
            # `realized` here makes the equity curve reflect financing at rollover
            # time (not at close). Positive daily pct is a cost; negative a credit.
            if i > 0 and (self.fin_long_daily_pct or self.fin_short_daily_pct):
                for _ in self._rollover_crossings(candles[i - 1].time, bar.time):
                    for p in longs:
                        charge = p.qty * p.entry * self.fin_long_daily_pct / 100.0
                        p.financing += charge
                        realized -= charge
                    for p in shorts:
                        charge = p.qty * p.entry * self.fin_short_daily_pct / 100.0
                        p.financing += charge
                        realized -= charge

            active = is_active(self.mask, bar.time)
            # Force-flat at the first inactive bar's open: close every open
            # position via the normal exit path with a "session close" reason.
            # Opt-in via mask.flatten_at_close (default off); is_active already
            # guarantees `active` is only False when a mask is enabled, so the
            # self.mask guard is belt-and-suspenders.
            if not active and (longs or shorts) and self.mask and self.mask.flatten_at_close:
                realized = self._close_all(
                    longs, "long", result, realized, Side.SELL,
                    self._fill_price(bar.open, Side.SELL, i), bar.time, "session close"
                )
                realized = self._close_all(
                    shorts, "short", result, realized, Side.BUY,
                    self._fill_price(bar.open, Side.BUY, i), bar.time, "session close"
                )
                last_long_open = None
                last_short_open = None

            # 1) Fill everything queued on the previous bar at THIS bar's open.
            # A signal queued here was generated on bar i-1 (its captured term
            # values are as-of that bar), so stamp the fill with that signal time.
            signal_time = candles[i - 1].time if i > 0 else None
            for sig in pending:
                fill_price = self._fill_price(bar.open, sig.side, i)
                if sig.leg == "long":
                    positions, side, risk, scaling = longs, "long", self.long_risk, self.long_scaling
                    opening = sig.side is Side.BUY
                    last_open = last_long_open
                    close_side = Side.SELL
                else:
                    positions, side, risk, scaling = shorts, "short", self.short_risk, self.short_scaling
                    opening = sig.side is Side.SELL
                    last_open = last_short_open
                    close_side = Side.BUY

                if opening:
                    if not active:
                        continue  # mask inactive: no new entries on this bar
                    atr = self._atr_at(scaling.spacing.length if scaling.spacing else None, i)
                    if len(positions) >= scaling.max_concurrent or not spacing_ok(
                        scaling.spacing, last_open, fill_price, side, atr
                    ):
                        continue  # cap/spacing rejected: no fill, no commission
                    result.fills.append(
                        Fill(bar.time, sig.side, fill_price, sig.quantity, sig.reason, sig.leg,
                             signal_time=signal_time, terms=sig.terms, combine=sig.combine)
                    )
                    realized -= self.commission
                    self._open(positions, side, risk, fill_price, bar.time, sig.reason, sig.quantity, i,
                               stop=sig.stop_level, target=sig.target_level)
                    if side == "long":
                        last_long_open = fill_price
                    else:
                        last_short_open = fill_price
                else:
                    realized = self._close_all(
                        positions, side, result, realized, close_side, fill_price, bar.time, sig.reason,
                        terms=sig.terms, signal_time=signal_time, combine=sig.combine,
                    )
                    if side == "long":
                        last_long_open = None
                    else:
                        last_short_open = None
            pending = []

            # 1b) Track excursion before intra-bar exits so the exit bar's range counts.
            self._track_excursion(longs, "long", bar)
            self._track_excursion(shorts, "short", bar)

            # 1c) Intra-bar stop/target, then 1d) trailing ratchet — per side.
            realized = self._intrabar_exit(longs, "long", self.long_risk, result, realized, bar, i)
            realized = self._intrabar_exit(shorts, "short", self.short_risk, result, realized, bar, i)
            # An intrabar stop/target that empties a side clears its spacing
            # anchor, so the next entry isn't wrongly blocked by a stale last-open.
            if not longs:
                last_long_open = None
            if not shorts:
                last_short_open = None
            self._ratchet_trailing(longs, "long", self.long_risk, bar, i)
            self._ratchet_trailing(shorts, "short", self.short_risk, bar, i)

            # 2) Mark-to-market on the close.
            equity = (
                self.starting_cash + realized
                + self._unrealized(longs, "long", bar.close)
                + self._unrealized(shorts, "short", bar.close)
            )
            result.equity.append(EquityPoint(bar.time, equity))
            peak_equity = max(peak_equity, equity)
            result.max_drawdown = max(result.max_drawdown, peak_equity - equity)

            # 3) Let the strategy decide for the NEXT bar (no lookahead).
            ctx.history.append(bar)
            ctx.position_long = sum(p.qty for p in longs)
            ctx.position_short = sum(p.qty for p in shorts)
            # Entry price/time of the held position per side (single-position
            # netting), or None when flat — feeds the `entry` operand + counts.
            ctx.long_entry_price = longs[0].entry if longs else None
            ctx.short_entry_price = shorts[0].entry if shorts else None
            ctx.long_entry_time = longs[0].open_time if longs else None
            ctx.short_entry_time = shorts[0].open_time if shorts else None
            snap: dict | None = None
            if inspect:
                snap = {
                    "i": i,
                    "time": bar.time,
                    "groups": self.strategy.inspect_groups(ctx, i),
                    "in_long": ctx.position_long > 0,
                    "in_short": ctx.position_short > 0,
                    "window": active,
                    "emitted_open": set(),  # opening legs the strategy actually emitted
                }
                snapshots.append(snap)
            if i < len(candles) - 1:  # last bar has no next-open to fill on
                pending = list(self.strategy.on_bar(ctx))
                if snap is not None:
                    # Classify suppression from an actually-EMITTED opening signal,
                    # not merely a passing group: a disabled side or the last bar
                    # produces no signal, so a passing rule there is "none", not
                    # "suppressed" (which would attach a bogus gate reason).
                    snap["emitted_open"] = {
                        sig.leg
                        for sig in pending
                        if (sig.leg == "long" and sig.side is Side.BUY)
                        or (sig.leg == "short" and sig.side is Side.SELL)
                    }

        # Book any still-open positions at the last close via the normal exit path
        # (reason "range end") so every position produces a Trade row rather than a
        # silent mark-to-market. This charges an exit commission per open position,
        # matching how every other exit is treated.
        if candles:
            last_bar = candles[-1]
            last_i = len(candles) - 1
            realized = self._close_all(
                longs, "long", result, realized, Side.SELL,
                self._fill_price(last_bar.close, Side.SELL, last_i), last_bar.time, "range end"
            )
            realized = self._close_all(
                shorts, "short", result, realized, Side.BUY,
                self._fill_price(last_bar.close, Side.BUY, last_i), last_bar.time, "range end"
            )
        if inspect:
            result.bar_traces = self._build_bar_traces(snapshots, result.fills, candles)
        result.net_pnl = realized
        result.n_trades = len(result.trades)
        round_trip_cost = 2 * self.commission
        wins = sum(1 for t in result.trades if t.pnl > round_trip_cost)
        result.win_rate = wins / result.n_trades if result.n_trades else 0.0
        return result

    # --- helpers ----------------------------------------------------------

    def _build_bar_traces(
        self, snapshots: list[dict], fills: list[Fill], candles: list[Candle]
    ) -> list[BarTrace]:
        """Resolve each per-bar snapshot into a BarTrace. A bar's entry signal fills
        at the NEXT bar's open, so `action` is read from the fills (which carry the
        signal bar's time); a passing entry with no opening fill was suppressed, and
        the reason follows the engine's own gate precedence (mask, then position/cap)."""
        opened_signal_times = {
            f.signal_time
            for f in fills
            if f.signal_time is not None
            and ((f.leg == "long" and f.side is Side.BUY)
                 or (f.leg == "short" and f.side is Side.SELL))
        }
        n = len(candles)
        out: list[BarTrace] = []
        for s in snapshots:
            i = s["i"]
            groups = s["groups"]
            emitted: set = s["emitted_open"]

            if s["time"] in opened_signal_times:
                action, reason, spacing_ok = "opened", None, None
            elif emitted:
                # A signal was emitted but nothing opened -> the engine gated it.
                # Reason follows the engine's own precedence at the fill bar (i+1,
                # which always exists here since a signal was emitted): mask, then
                # already-in-position, then spacing/cap. Prefer the long leg's story
                # when both sides emitted (rare).
                action = "suppressed"
                emit_long = "long" in emitted
                next_active = is_active(self.mask, candles[i + 1].time)
                if not next_active:
                    reason, spacing_ok = "outside session window", None
                elif (emit_long and s["in_long"]) or (not emit_long and s["in_short"]):
                    reason, spacing_ok = "already in position", None
                else:
                    reason, spacing_ok = "spacing or position cap", False
            else:
                action, reason, spacing_ok = "none", None, None

            # Warmed up when every operand of a relevant group (passing, or an entry
            # group we always show) had a value at this bar — a None means cold.
            relevant = [g for g in groups if g.passed or g.group in ("longEntry", "shortEntry")]
            warmed = all(
                t.left_val is not None and t.right_val is not None
                for g in relevant for t in g.terms
            )
            out.append(BarTrace(
                bar_index=i,
                time=int(s["time"].timestamp()),
                groups=tuple(groups),
                action=action,
                reason=reason,
                in_position_long=s["in_long"],
                in_position_short=s["in_short"],
                window_active=s["window"],
                warmed_up=warmed,
                spacing_ok=spacing_ok,
            ))
        return out

    @staticmethod
    def _wilder_atr14(candles: list[Candle]) -> list[float | None]:
        # Deliberate self-contained slippage basis: a fixed Wilder ATR(14) over
        # the run's own candles, independent of any rule/operand ATR series the
        # frontend may post (those key off ATR_{length}). Keeps ATR-scaled
        # slippage well-defined even when no rule references ATR.
        out: list[float | None] = [None] * len(candles)
        trs: list[float] = []
        prev_close: float | None = None
        atr: float | None = None
        for i, c in enumerate(candles):
            tr = c.high - c.low if prev_close is None else max(
                c.high - c.low, abs(c.high - prev_close), abs(c.low - prev_close))
            prev_close = c.close
            if atr is None:
                trs.append(tr)
                if len(trs) == 14:
                    atr = sum(trs) / 14
            else:
                atr = (atr * 13 + tr) / 14
            out[i] = atr
        return out

    def _rollover_crossings(self, prev: datetime, cur: datetime) -> list[datetime]:
        """Every financing-rollover instant in (prev, cur]. Walks day by day and
        is bounded by the bar span (a handful of iterations even for weekly bars)."""
        out: list[datetime] = []
        candidate = prev.replace(
            hour=ROLLOVER_HOUR_UTC, minute=0, second=0, microsecond=0)
        if candidate <= prev:
            candidate += timedelta(days=1)
        while candidate <= cur:
            out.append(candidate)
            candidate += timedelta(days=1)
        return out

    def _slip_at(self, i: int) -> float:
        extra = 0.0
        if self.slippage_atr_mult > 0 and i < len(self._slip_atr):
            atr = self._slip_atr[i]
            if atr is not None:
                extra = self.slippage_atr_mult * atr
        return self.slippage + extra

    def _fill_price(self, open_price: float, side: Side, i: int) -> float:
        # Costs push the price against us: buy at ask plus slippage, sell at
        # bid minus slippage.
        adj = self.half_spread + self._slip_at(i)
        return open_price + (adj if side is Side.BUY else -adj)

    def _atr_at(self, length: int | None, i: int) -> float | None:
        if length is None:
            return None
        arr = self.series.get(f"ATR_{length}", [])
        return arr[i] if i < len(arr) else None

    def _open(self, positions, side, risk, fill_price, bar_time, reason, qty, i,
              stop=None, target=None):
        """Open a NEW independent position; seed its stop/target/extreme from the
        fill price. Per-signal `stop`/`target` (coded strategies) override the
        side-level risk config for THIS position. (Pyramiding/merge is a later
        phase.)"""
        p = Position(qty=qty, entry=fill_price, open_time=bar_time, open_reason=reason)
        p.adv_extreme = fill_price
        p.fav_extreme = fill_price
        if stop is not None or target is not None:
            p.extreme = fill_price
            p.stop = stop
            p.stop_initial = stop
            p.target = target
            p.bracket_from_signal = True
        elif risk:
            p.extreme = fill_price
            p.stop = stop_level(risk.stop, fill_price, side, self._atr_at(risk.stop.length, i), p.extreme)
            p.stop_initial = p.stop
            p.target = target_level(risk.target, fill_price, side, self._atr_at(risk.target.length, i))
        positions.append(p)

    def _close_all(
        self, positions, side, result, realized, close_side, fill_price, bar_time, reason,
        *, terms=(), signal_time=None, combine=None,
    ):
        """Close EVERY open position on the side (P2 exit scope). One fill +
        commission + Trade per position. Returns updated realized. `terms`/
        `signal_time`/`combine` are set only for a rule-based exit; mechanical closes
        (session/range-end) leave the defaults (empty/None)."""
        while positions:
            result.fills.append(
                Fill(bar_time, close_side, fill_price, positions[0].qty, reason, side,
                     signal_time=signal_time, terms=terms, combine=combine)
            )
            realized -= self.commission
            realized = self._reduce(positions, side, result, realized, fill_price, bar_time, reason, positions[0].qty)
        return realized

    def _reduce(self, positions, side, result, realized, fill_price, bar_time, reason, qty, pos=None):
        """A closing fill (SELL for long, BUY for short) of `qty` units against the
        side's open position (`pos`, defaulting to the oldest); books a Trade and
        drops the position if flat. Returns the updated realized pnl."""
        if not positions:
            return realized
        p = pos if pos is not None else positions[0]
        closing = min(qty, p.qty)
        if closing <= 0:
            return realized
        if side == "long":
            pnl = closing * (fill_price - p.entry)
            trade_side = Side.BUY
            mae = max(0.0, p.entry - min(p.adv_extreme, fill_price))
            mfe = max(0.0, max(p.fav_extreme, fill_price) - p.entry)
        else:
            pnl = closing * (p.entry - fill_price)
            trade_side = Side.SELL
            mae = max(0.0, max(p.adv_extreme, fill_price) - p.entry)
            mfe = max(0.0, p.entry - min(p.fav_extreme, fill_price))
        risk_dist = abs(p.entry - p.stop_initial) if p.stop_initial is not None else 0.0
        mae_r = mae / risk_dist if risk_dist > 0 else None
        mfe_r = mfe / risk_dist if risk_dist > 0 else None
        realized += pnl
        # Allocate the position's accrued financing to this Trade by the share of
        # quantity being closed. Compute the share against the PRE-decrement qty,
        # then draw it down so a partial close leaves the remainder on the position.
        share = p.financing * (closing / p.qty) if p.qty else 0.0
        p.financing -= share
        result.financing_total += share
        result.trades.append(
            Trade(
                side=trade_side, quantity=closing,
                entry_time=p.open_time, entry_price=p.entry,
                exit_time=bar_time, exit_price=fill_price, pnl=pnl,
                financing=share,
                leg=side, reason_in=p.open_reason, reason_out=reason,
                stop_initial=p.stop_initial, stop_final=p.stop, target=p.target,
                mae=mae, mfe=mfe, mae_r=mae_r, mfe_r=mfe_r,
                bars_held=p.bar_stats.bars_held,
                bars_in_profit=p.bar_stats.bars_in_profit,
                bars_in_loss=p.bar_stats.bars_in_loss,
                body_through=p.bar_stats.body_through,
                wick_from_profit=p.bar_stats.wick_from_profit,
                wick_from_loss=p.bar_stats.wick_from_loss,
                longest_profit_streak=p.bar_stats.longest_profit_streak,
                longest_loss_streak=p.bar_stats.longest_loss_streak,
                bars_to_mfe=p.bar_stats.bars_to_mfe,
                bars_to_mae=p.bar_stats.bars_to_mae,
                entry_crossings=p.bar_stats.entry_crossings,
            )
        )
        p.qty -= closing
        if p.qty == 0:
            positions.remove(p)
        return realized

    def _intrabar_exit(self, positions, side, risk, result, realized, bar, i):
        """Pessimistic intra-bar stop/target for EVERY open position on the side
        (the open resolves the order when it gaps through the target). Each
        position carries its own levels, so all are checked — not just the
        oldest. Books the exits and returns updated realized pnl. See the
        stops-feature design."""
        close_side = Side.SELL if side == "long" else Side.BUY
        for p in list(positions):
            # Exit only if position has a stop/target (from risk config or per-signal) and risk is set.
            # Per-signal brackets (no risk config) also get exits if they have stop/target.
            if p.stop is None and p.target is None:
                continue
            # A per-signal bracket is a static level: always "stop", never "trail",
            # regardless of what the side-level RiskConfig's stop kind is.
            is_trail = not p.bracket_from_signal and risk and is_trailing(risk.stop)
            if side == "long":
                # Exits are SELLs executing at the bid: shift the candle down
                # by half the spread before comparing to the levels.
                b_open, b_high, b_low = (bar.open - self.half_spread,
                                         bar.high - self.half_spread,
                                         bar.low - self.half_spread)
                if p.target is not None and b_open >= p.target:
                    hit = (self._fill_price(p.target, Side.SELL, i), "target")
                elif p.stop is not None and b_low <= p.stop:
                    raw = min(bar.open, p.stop)
                    hit = (self._fill_price(raw, Side.SELL, i), "trail" if is_trail else "stop")
                elif p.target is not None and b_high >= p.target:
                    hit = (self._fill_price(p.target, Side.SELL, i), "target")
                else:
                    hit = None
            else:
                # Exits are BUYs executing at the ask: shift the candle up by
                # half the spread before comparing to the levels.
                b_open, b_high, b_low = (bar.open + self.half_spread,
                                         bar.high + self.half_spread,
                                         bar.low + self.half_spread)
                if p.target is not None and b_open <= p.target:
                    hit = (self._fill_price(p.target, Side.BUY, i), "target")
                elif p.stop is not None and b_high >= p.stop:
                    raw = max(bar.open, p.stop)
                    hit = (self._fill_price(raw, Side.BUY, i), "trail" if is_trail else "stop")
                elif p.target is not None and b_low <= p.target:
                    hit = (self._fill_price(p.target, Side.BUY, i), "target")
                else:
                    hit = None
            if hit:
                px, reason = hit
                result.fills.append(Fill(bar.time, close_side, px, p.qty, reason, side))
                realized -= self.commission
                realized = self._reduce(positions, side, result, realized, px, bar.time, reason, p.qty, pos=p)
        return realized

    @staticmethod
    def _track_excursion(positions, side, bar):
        """Extend each open position's adverse/favorable watermarks with this
        bar's range and advance its per-bar dynamics. Called before intra-bar
        exits so the exit bar counts."""
        for p in positions:
            p.bar_stats.update(p.entry, side, bar)
            if side == "long":
                p.adv_extreme = min(p.adv_extreme, bar.low)
                p.fav_extreme = max(p.fav_extreme, bar.high)
            else:
                p.adv_extreme = max(p.adv_extreme, bar.high)
                p.fav_extreme = min(p.fav_extreme, bar.low)

    def _ratchet_trailing(self, positions, side, risk, bar, i):
        """Extend the trailing extreme with THIS bar's high/low and recompute the
        stop for the NEXT bar — clamped so a trailing stop never loosens (and a
        cold ATR never wipes it)."""
        if not positions or not risk or not is_trailing(risk.stop):
            return
        for p in positions:
            # A per-signal bracket fully overrides side-level risk for this position:
            # its stop is a static level, never ratcheted by the side's trailing config.
            if p.bracket_from_signal:
                continue
            if side == "long":
                p.extreme = max(p.extreme, bar.high)
            else:
                p.extreme = min(p.extreme, bar.low)
            new_stop = stop_level(risk.stop, p.entry, side, self._atr_at(risk.stop.length, i), p.extreme)
            if new_stop is not None:
                if p.stop is None:
                    p.stop = new_stop
                else:
                    p.stop = max(p.stop, new_stop) if side == "long" else min(p.stop, new_stop)

    @staticmethod
    def _unrealized(positions, side, close):
        total = 0.0
        for p in positions:
            total += p.qty * (close - p.entry) if side == "long" else p.qty * (p.entry - close)
        return total
