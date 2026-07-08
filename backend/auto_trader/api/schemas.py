"""Pydantic request/response models for the API surface.

Lightweight-charts friendly: unix-second timestamps. The `to_*` methods convert
DTOs into the engine/strategy domain objects; the `_candle_dto`/`_candle_from_dto`
converters live with the routers that own their direction of translation.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, Field, model_validator

from auto_trader.engine.schedule import RecurrenceMask
from auto_trader.engine.risk import RiskConfig, StopSpec, TargetSpec
from auto_trader.engine.scaling import ScalingConfig, SpacingSpec
from auto_trader.strategy.rule import Operand, Rule, RuleGroup


# --- response models (lightweight-charts friendly: unix-second timestamps) ---


class CandleDTO(BaseModel):
    time: int
    open: float
    high: float
    low: float
    close: float
    volume: float


class CandleCacheStatsDTO(BaseModel):
    oldest_ts: int | None
    newest_ts: int | None
    cached_bar_count: int
    hits: int
    misses: int
    last_fetch_ts: float | None


class CandleCacheGlobalStatsDTO(BaseModel):
    total_bars: int
    total_hits: int
    total_misses: int
    db_size_bytes: int


class TermDTO(BaseModel):
    """One passing rule's comparison at the signal bar (see RuleTerm). `left`/
    `right` are human labels WITHOUT the timeframe; `leftTf`/`rightTf` are the
    operand's effective Resolution string (None for a timeframe-less operand), which
    the frontend prettifies to `@15m`. Values are backend-authoritative."""

    left: str
    lval: float | None
    op: str
    right: str
    rval: float | None
    leftTf: str | None
    rightTf: str | None


class MarkerDTO(BaseModel):
    time: int
    side: str
    price: float
    reason: str
    leg: str
    # Signal-candle provenance (rule-based fills only; None/empty for a mechanical
    # stop/target/session/range-end fill). `signal_time` is the bar the signal fired
    # on (unix seconds), `terms` the passing rules' captured values, `combine` the
    # firing group's AND/OR (how to read the passing-only terms).
    signal_time: int | None = None
    terms: list[TermDTO] = []
    combine: str | None = None


class TradeDTO(BaseModel):
    side: str
    quantity: float
    entry_time: int
    entry_price: float
    exit_time: int
    exit_price: float
    pnl: float
    leg: str
    reason: str = ""
    stop_initial: float | None = None
    stop_final: float | None = None
    target: float | None = None


class EquityDTO(BaseModel):
    time: int
    value: float


class MarketDTO(BaseModel):
    epic: str
    name: str | None
    status: str | None
    type: str | None = None
    pricePrecision: int | None = None


class BacktestResponse(BaseModel):
    epic: str
    resolution: str
    candles: list[CandleDTO]
    markers: list[MarkerDTO]
    trades: list[TradeDTO]
    equity: list[EquityDTO]
    summary: dict
    metrics: dict = {}


# --- rule-based backtest request (D1/D4/D6: frontend computes series, posts
# candles + series + rules; engine does no indicator math and no re-fetch) ---


class SlopeDTO(BaseModel):
    len: int = Field(ge=1)


class OperandDTO(BaseModel):
    kind: Literal["indicator", "price", "const", "entry", "series"]
    indicator: Literal["EMA", "SMA", "AVWAP", "RSI", "VOL", "VOLMA"] | None = None
    length: int | None = None
    field: Literal["close", "open", "high", "low"] | None = None
    value: float | None = None
    anchor: int | None = None
    # A `series` operand (a chart indicator/drawing copied into a rule): the frontend
    # already computed the array and posts it under `seriesKey`; the engine reads it
    # verbatim and never recomputes. `label` is only for exit-reason rendering.
    seriesKey: str | None = None
    label: str | None = None
    # Higher timeframe an indicator runs on (None ⇒ the run's base timeframe). The
    # frontend aligns it onto the base bars, so the engine never reads this — it
    # only rides along to key the series (series_name); see OperandDTO.to_operand.
    timeframe: str | None = None
    # Slope transform (indicator/price only): the frontend computes the %/hr slope
    # as its own series; this only keys it (series_name), like `timeframe`.
    slope: SlopeDTO | None = None

    @model_validator(mode="after")
    def _kind_matches_fields(self) -> "OperandDTO":
        if self.kind == "indicator" and self.indicator is None:
            raise ValueError("indicator operand requires 'indicator'")
        if self.kind == "price" and self.field is None:
            raise ValueError("price operand requires 'field'")
        if self.kind == "const" and self.value is None:
            raise ValueError("const operand requires 'value'")
        if self.kind == "series" and not (self.seriesKey and self.seriesKey.strip()):
            raise ValueError("series operand requires a non-empty 'seriesKey'")
        if self.slope is not None and self.kind not in ("indicator", "price", "series"):
            raise ValueError("slope is only valid on an indicator, price, or series operand")
        return self

    def to_operand(self) -> Operand:
        return Operand(
            kind=self.kind, indicator=self.indicator, length=self.length,
            field=self.field, value=self.value, anchor=self.anchor,
            timeframe=self.timeframe,
            slope_len=self.slope.len if self.slope else None,
            series_key=self.seriesKey, label=self.label,
        )


class RuleDTO(BaseModel):
    left: OperandDTO
    op: Literal["crossesAbove", "crossesBelow", "crosses", "gt", "lt", "gte", "lte"]
    right: OperandDTO
    # "Nth time" modifier (exit-only; None ⇒ fire on first occurrence).
    count: int | None = Field(default=None, ge=1)

    def to_rule(self) -> Rule:
        return Rule(self.left.to_operand(), self.op, self.right.to_operand(), count=self.count)


class RuleGroupDTO(BaseModel):
    combine: Literal["AND", "OR"]
    rules: list[RuleDTO] = []

    def to_group(self) -> RuleGroup:
        return RuleGroup(self.combine, [r.to_rule() for r in self.rules])

    def operands(self) -> list[OperandDTO]:
        result = []
        for r in self.rules:
            result.append(r.left)
            result.append(r.right)
        return result


class CostsDTO(BaseModel):
    quantity: float = Field(gt=0)
    commissionPerSide: float = Field(ge=0)
    slippage: float = Field(ge=0)
    startingCash: float = Field(gt=0)


class StopSpecDTO(BaseModel):
    kind: Literal["none", "pct", "price", "atr", "trailPct", "trailAtr"]
    value: float | None = None
    mult: float | None = None
    length: int | None = None

    def to_spec(self) -> StopSpec:
        return StopSpec(self.kind, self.value, self.mult, self.length)


class TargetSpecDTO(BaseModel):
    kind: Literal["none", "pct", "price", "atr"]
    value: float | None = None
    mult: float | None = None
    length: int | None = None

    def to_spec(self) -> TargetSpec:
        return TargetSpec(self.kind, self.value, self.mult, self.length)


class RiskConfigDTO(BaseModel):
    stop: StopSpecDTO
    target: TargetSpecDTO

    def to_risk(self) -> RiskConfig:
        return RiskConfig(self.stop.to_spec(), self.target.to_spec())

    def atr_series_names(self) -> list[str]:
        names = []
        for spec in (self.stop, self.target):
            if spec.kind in ("atr", "trailAtr") and spec.length is not None:
                names.append(f"ATR_{spec.length}")
        return names


class SpacingSpecDTO(BaseModel):
    kind: Literal["pct", "atr"]
    value: float | None = None
    mult: float | None = None
    length: int | None = None

    def to_spec(self) -> SpacingSpec:
        return SpacingSpec(self.kind, self.value, self.mult, self.length)


class ScalingConfigDTO(BaseModel):
    maxConcurrent: int = Field(default=1, ge=1)
    spacing: SpacingSpecDTO | None = None

    def to_scaling(self) -> ScalingConfig:
        return ScalingConfig(self.maxConcurrent, self.spacing.to_spec() if self.spacing else None)

    def atr_series_names(self) -> list[str]:
        if self.spacing and self.spacing.kind == "atr" and self.spacing.length is not None:
            return [f"ATR_{self.spacing.length}"]
        return []


class DayTimeWindowDTO(BaseModel):
    # Minutes from midnight in the mask's tz; matches the frontend's nested
    # `timeOfDay: { startMin, endMin }` shape exactly (do not flatten — the
    # frontend never sends flat time*Min fields, so a mismatch silently drops
    # the clock filter).
    startMin: int
    endMin: int


class RecurrenceMaskDTO(BaseModel):
    enabled: bool = False
    daysOfWeek: list[int] = []       # JS getDay 0=Sun..6=Sat
    monthsOfYear: list[int] = []     # 1=Jan..12=Dec
    daysOfMonth: list[int] = []      # 1..31
    timeOfDay: DayTimeWindowDTO | None = None
    tz: str = "UTC"
    # camelCase to match the wire (this DTO uses camelCase attr names, no aliases).
    # Force-flat open positions at each session close; default off (see RecurrenceMask).
    flattenAtClose: bool = False

    @model_validator(mode="after")
    def _valid_tz(self) -> "RecurrenceMaskDTO":
        try:
            ZoneInfo(self.tz)
        except Exception as e:
            raise ValueError(f"unknown timezone '{self.tz}'") from e
        return self

    def to_mask(self) -> RecurrenceMask:
        return RecurrenceMask(
            enabled=self.enabled,
            days_of_week=tuple(self.daysOfWeek),
            months_of_year=tuple(self.monthsOfYear),
            days_of_month=tuple(self.daysOfMonth),
            time_start_min=self.timeOfDay.startMin if self.timeOfDay else None,
            time_end_min=self.timeOfDay.endMin if self.timeOfDay else None,
            tz=self.tz,
            flatten_at_close=self.flattenAtClose,
        )


class BacktestRequest(BaseModel):
    epic: str
    resolution: str
    candles: list[CandleDTO]
    series: dict[str, list[float | None]]
    longEntry: RuleGroupDTO
    longExit: RuleGroupDTO
    shortEntry: RuleGroupDTO
    shortExit: RuleGroupDTO
    # Per-side master switches: a disabled side never trades even if its rule
    # groups are populated (the user keeps the rules while the side is parked).
    # Default on so an omitted flag means "trade this side" (backward-safe).
    longEnabled: bool = True
    shortEnabled: bool = True
    longRisk: RiskConfigDTO | None = None
    shortRisk: RiskConfigDTO | None = None
    longScaling: ScalingConfigDTO | None = None
    shortScaling: ScalingConfigDTO | None = None
    costs: CostsDTO
    tradeFromTime: int
    mask: RecurrenceMaskDTO | None = None


# --- order execution (paper now; demo/live later) ----------------------------


class OrderRequest(BaseModel):
    epic: str
    side: str  # "buy" | "sell"
    quantity: float
    client_order_id: str  # caller-generated idempotency key (UUID)
    account: str = "capital:paper"  # registry key "{broker_id}:{env}"
    source: str = "manual"  # "manual" | "strategy"
    type: str = "market"  # "market" | "limit"
    limit_level: float | None = None  # required when type == "limit"
    stop_level: float | None = None
    take_profit_level: float | None = None
    confirm: bool = False  # required for real-money (live) orders


class LevelsRequest(BaseModel):
    # Body for editing an open position's or resting order's levels. None = leave
    # unchanged (a combined Apply sends whichever lines the user dragged). To
    # REMOVE a level (the edit form's toggle-off), set its clear_* flag — None
    # alone can't mean "clear" without breaking partial drag updates.
    limit_level: float | None = None
    stop_level: float | None = None
    take_profit_level: float | None = None
    clear_stop: bool = False
    clear_take_profit: bool = False


class WorkingOrderDTO(BaseModel):
    epic: str
    side: str
    quantity: float
    limit_level: float
    order_id: str
    stop_level: float | None = None
    take_profit_level: float | None = None
    created_at: datetime | None = None


class OrderResultDTO(BaseModel):
    client_order_id: str
    status: str
    deal_reference: str | None = None
    deal_id: str | None = None
    filled_quantity: float = 0.0
    fill_price: float | None = None
    reason: str = ""


class PositionDTO(BaseModel):
    epic: str
    side: str
    quantity: float
    open_level: float
    deal_id: str
    stop_level: float | None = None
    take_profit_level: float | None = None
    upnl: float | None = None
    created_at: datetime | None = None
    leverage: float | None = None
    margin: float | None = None


class QuoteDTO(BaseModel):
    bid: float | None = None
    ask: float | None = None
    mid: float | None = None


class AccountSummaryDTO(BaseModel):
    # Real per-account figures from the broker (live dealing accounts only). Paper/IG
    # accounts have no summary → 404, and the dock falls back to its configured paper
    # balance. All optional so a partial broker payload still renders.
    balance: float | None = None
    available: float | None = None
    deposit: float | None = None
    profitLoss: float | None = None
    currency: str | None = None
    # Broker-authoritative account value + margin-in-use (MT5 reports these directly).
    # When present the dock uses them verbatim instead of re-deriving margin/equity from
    # balance − available (which drifts by swap/commission and leverage estimates); left
    # None by Capital/IG so their existing derivation is unchanged.
    equity: float | None = None
    margin: float | None = None


# --- chart workspace state (localStorage mirror, backend-wins-on-load sync) --


class StateValue(BaseModel):
    # The PUT body. `value` is any JSON the frontend stored under this key — we
    # persist it opaquely (never inspect it), exactly like a localStorage value.
    value: Any


# --- live trading: /api/strategy/evaluate (one-bar decision layer) -----------


class PositionStateDTO(BaseModel):
    """The reconciled broker position for one epic, or the request omits it (flat)."""
    side: Literal["buy", "sell"]
    quantity: float
    open_level: float
    # Epoch seconds the position opened. Optional (older callers omit it), but
    # required for counted exits ("Nth time since entry") to locate the entry bar.
    open_time: int | None = None


class ActionDTO(BaseModel):
    kind: Literal["open", "close"]
    leg: Literal["long", "short"]
    side: Literal["buy", "sell"]
    reason: str
    stop_level: float | None = None
    take_profit_level: float | None = None


class EvaluateRequest(BaseModel):
    epic: str
    resolution: str
    candles: list[CandleDTO]
    series: dict[str, list[float | None]] = {}
    longEntry: RuleGroupDTO
    longExit: RuleGroupDTO
    shortEntry: RuleGroupDTO
    shortExit: RuleGroupDTO
    longEnabled: bool = True
    shortEnabled: bool = True
    longRisk: RiskConfigDTO | None = None
    shortRisk: RiskConfigDTO | None = None
    position: PositionStateDTO | None = None


class EvaluateResponse(BaseModel):
    actions: list[ActionDTO]
