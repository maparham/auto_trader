"""Pydantic request/response models for the API surface.

Lightweight-charts friendly: unix-second timestamps. The `to_*` methods convert
DTOs into the engine/strategy domain objects; the `_candle_dto`/`_candle_from_dto`
converters live with the routers that own their direction of translation.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, Field, field_validator, model_validator

from auto_trader.engine.schedule import RecurrenceMask
from auto_trader.engine.risk import RiskConfig, StopSpec, TargetSpec
from auto_trader.engine.scaling import ScalingConfig, SpacingSpec


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


class BackfillProgressDTO(BaseModel):
    """One in-flight candle-cache backfill, for the backtest progress UI."""
    label: str
    doneChunks: int
    totalChunks: int
    bars: int
    elapsedS: float
    etaS: float | None
    at: str


class CandleCacheGlobalStatsDTO(BaseModel):
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


class TradeZoneDTO(BaseModel):
    """A time×price rectangle a strategy attached to the entry (core TradeZone):
    the structure that justified the trade, shaded on the chart when the trade
    is highlighted. Times are unix seconds (bar times)."""

    from_time: int
    to_time: int
    top: float
    bottom: float
    label: str = ""


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
    exit_time_exact: int | None = None
    # Excursion + entry context (see engine.context_features): mae/mfe are raw
    # price distance from entry; *_r are R-multiples of the initial stop.
    mae: float = 0.0
    mfe: float = 0.0
    mae_r: float | None = None
    mfe_r: float | None = None
    # Per-trade bar-count dynamics (see engine BarStats). Default 0 so older
    # stored runs and hand-built DTOs remain valid.
    bars_held: int = 0
    bars_in_profit: int = 0
    bars_in_loss: int = 0
    body_through: int = 0
    wick_from_profit: int = 0
    wick_from_loss: int = 0
    longest_profit_streak: int = 0
    longest_loss_streak: int = 0
    bars_to_mfe: int = 0
    bars_to_mae: int = 0
    entry_crossings: int = 0
    context: dict | None = None
    # Per-trade counterfactuals (see engine.whatif); None when not computed.
    whatif: dict | None = None
    # Overnight financing allocated to this trade (positive = cost). Default 0.0
    # so zeroed financing and older stored runs stay valid.
    financing: float = 0.0
    # Chart zones from the opening signal (empty for strategies that attach none).
    zones: list[TradeZoneDTO] = []


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
    # Per-direction trade-list breakdown: {"long": {...}, "short": {...}}, each a
    # leg_metrics() dict. Powers the LONG/SHORT rows of the TRADES panel table.
    by_leg: dict | None = None
    fileBracketsOverridden: bool = False
    # Persisted-run id (None if the store write failed) + aggregate analytics.
    run_id: str | None = None
    analysis: dict | None = None
    # Cost-sensitivity summary (single runs that opted in). Shaped
    # {"multiples": [0, 1, 2, 3], "net_pnl": [...], "breakeven_multiple": float | None}.
    cost_sensitivity: dict | None = None
    # {"null_long": metrics|None, "null_short": ..., "hold_long": ...,
    # "hold_short": ..., "reversed": ...} when the request asked for
    # baselines; None otherwise. Each blob is a compute_metrics dict MERGED with
    # the run's summary(), so net_pnl/n_trades/win_rate ARE present here —
    # unlike the main run's `metrics` field above, which is compute_metrics
    # alone and carries no net_pnl (that one lives on `summary`).
    baselines: dict | None = None
    # Strategy-declared viz regions (a coded module's chart_regions hook —
    # e.g. BB Regime's squeeze windows, resolved or not), run-scoped rather
    # than per-trade. Empty for strategies without the hook.
    regions: list[TradeZoneDTO] = []


class SlippageDTO(BaseModel):
    kind: Literal["fixed", "atr"]
    value: float = Field(ge=0)          # fixed value, or the ATR mode's base
    atrMult: float = Field(default=0.0, ge=0)


class CostsDTO(BaseModel):
    quantity: float = Field(gt=0)
    commissionPerSide: float = Field(ge=0)
    slippage: SlippageDTO
    spread: float = Field(default=0.0, ge=0)
    finLongDailyPct: float = 0.0
    finShortDailyPct: float = 0.0
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

    def is_configured(self) -> bool:
        """A leg only counts as panel-configured when at least one of its
        stop/target specs is a real kind. A none/none config (RiskSection
        touched then reset back to None) must be indistinguishable from no
        panel risk at all — otherwise it silently strips the coded file's own
        sl=/tp= brackets while applying no engine-side stop either (C1)."""
        return self.stop.kind != "none" or self.target.kind != "none"


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
    # Coded runs carry panel exit rules as EXPRESSIONS here. Entries are always
    # the coded module's, so no expr entry fields are needed.
    exprLongExit: list[ExprRowDTO] = []
    exprShortExit: list[ExprRowDTO] = []
    # how this group's rows combine: "AND" (default) | "OR"
    exprLongExitCombine: Literal["AND", "OR"] = "AND"
    exprShortExitCombine: Literal["AND", "OR"] = "AND"
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
    # Cost-sensitivity opt-in: when True (single runs only) the handler re-runs
    # the engine at 0x/2x/3x costs and returns the per-multiple net P&L plus the
    # breakeven cost multiple in `cost_sensitivity`.
    costSensitivity: bool = False
    # Coded strategy (a backend/strategies/*.py filename). When set, the rule
    # groups above are ignored and the file's on_bar drives the run; series stays
    # empty (Python computes indicators ad hoc — the frontend posts none).
    codedStrategy: str | None = None
    # Panel-tuned values for the coded strategy's declared meta["params"];
    # unset/omitted params fall back to their declared defaults.
    codedParams: dict[str, int | float | bool | str] | None = None
    # Broker/price side for backend-side HTF fetches (coded strategies' tf= calls).
    broker: str = ""  # empty = server default broker (deps.default_broker_id)
    priceSide: str = "mid"
    # Parameter/risk sweep: when set, POST /api/backtest/sweep/jobs runs one
    # combo per entry instead of the single codedParams/longRisk/shortRisk on
    # this request. Ignored by POST /api/backtest.
    sweep: SweepDTO | None = None
    # Walk-forward optimization: when set, POST /api/backtest/walkforward/jobs
    # runs a multi-fold job. Ignored by POST /api/backtest.
    walkforward: "WalkForwardDTO | None" = None
    # Pre-fetched higher-timeframe bars, keyed by timeframe ("HOUR_4", ...). The
    # local backend fills this from ITS cache before forwarding a sweep to the
    # remote compute host, so the remote runs purely on shipped data and never
    # calls a broker (a COMPUTE_ONLY host refuses broker fetches — see
    # deps._fetch_symbol_candles). None on a normal local run: the handler fetches
    # the set itself, as before.
    htfCandles: dict[str, list[CandleDTO]] | None = None
    # Chart indicator instance settings, keyed by instance id. A rule names an
    # OUTPUT (SLOPE.9) and never restates the pane's parameters, so they
    # travel here. Unregistered pane types are skipped, not rejected.
    indicators: dict[str, IndicatorInstanceDTO] = {}
    # Optional client-generated id for GET /api/backtest/progress/{id} polling.
    # Cosmetic: absent means no progress reporting for this run.
    progressId: str | None = None
    # Baseline companion runs (coded single runs only on this route): "null" =
    # 1==1 entries + the PANEL's exits/risk (code-internal logic not
    # mirrored); "hold" = enter-and-hold. Rules-mode requests and
    # sweep/walkforward jobs ignore the field.
    baselines: list[Literal["null", "hold", "reversed", "oracle_entries"]] | None = None
    # Internal (never set by the UI): run the coded strategy mirror-imaged —
    # every signal's leg/side flipped, side-level risk/scaling swapped at the
    # engine. Synthesized by the "reversed" baseline passes; riding the request
    # lets the single-run route and the WFO worker share one code path
    # (run_coded_sync honors it).
    reverse: bool = False


class SweepDTO(BaseModel):
    """Explicit combo list: the frontend enumerates the grid and submits it
    whole as one job (POST /api/backtest/sweep/jobs).
    Keys: "param:<name>" (codedParams override),
    "risk:<long|short>.<stop|target>.<value|mult>",
    "op:<long|short>.<entry|exit>.<idx>" (operator patch, one of the 7 Rule ops), or
    "rule:<long|short>.<entry|exit>.<idx>.<left|right>.<length|value>" /
    "rule:<long|short>.<entry|exit>.<idx>.count" (rule-tree operand/count patch),
    "period:from" + "period:to" (unix-second walk-forward window: entries gate
    at from, candles truncate at to),
    "timeWindow:startMin" + "timeWindow:endMin" + "timeWindow:tz" (intraday
    mask window patch; a mask is synthesized when the request has none)."""
    combos: list[dict[str, float | int | bool | str]]
    # Sub-window robustness bounds: ascending epoch-second boundaries (N+1 for
    # N windows). When set, each row gets per-window pnl/trades plus aggregate
    # robustness metrics sliced from its ONE continuous run (no extra engine
    # runs). Combos that patch their own period: are skipped (their effective
    # range differs from these bounds).
    windows: list[int] | None = None


class SweepRowDTO(BaseModel):
    combo: dict[str, float | int | bool | str]
    metrics: dict | None = None
    # Per-window slice of this combo's run (sweep.windows bounds): pnl and
    # trade count per window, entry-time attribution. None when no windows
    # were requested or the combo patches its own period.
    windows: list[dict] | None = None
    error: str | None = None


class WfoAxisDTO(BaseModel):
    kind: Literal["range", "list"]
    targets: list[str]
    values: list[float] | None = None   # ordered swept values, range axes only


class WfoScheduleDTO(BaseModel):
    mode: Literal["rolling", "anchored"] = "rolling"
    trainSpan: str
    testSpan: str
    step: str | None = None             # default = testSpan
    minTrainTrades: int = 30
    minTestTrades: int = 5


class WfoObjectiveDTO(BaseModel):
    metric: str = "sharpe"
    selection: Literal["best", "plateau"] = "plateau"
    composite: dict[str, float] | None = None


class WalkForwardDTO(BaseModel):
    """Walk-forward optimization job spec (POST /api/backtest/walkforward/jobs).
    combos/targets use the sweep grammar (see SweepDTO); axes describe the grid
    structure so the backend can do plateau selection and stability. Spans use
    the wfo_plan token grammar: 10d, 2w, 3m, 500b."""
    combos: list[dict[str, float | int | bool | str]]
    axes: list[WfoAxisDTO]
    schedule: WfoScheduleDTO
    objective: WfoObjectiveDTO = Field(default_factory=WfoObjectiveDTO)
    matrixTrainSpans: list[str] = []
    # Exact scores each train window as a real flat-start run (default); fast is
    # the one-run-sliced-N-ways approximation. Legacy "auto"/"sliced" normalize
    # to fast so older clients keep working.
    evalMode: Literal["exact", "fast"] = "exact"
    # Baseline companion runs per fold test window (expr and coded WFO):
    # "null" = 1==1 entries, same structure; "hold" = enter-and-hold. Coded
    # jobs synthesize the expr baseline on the sides each fold's winner
    # actually traded. Display-only.
    baselines: list[Literal["null", "hold", "reversed", "oracle_entries"]] | None = None

    @field_validator("evalMode", mode="before")
    @classmethod
    def _normalize_eval_mode(cls, v):
        return "fast" if v in ("auto", "sliced") else v


class WfoJobSubmitResponse(BaseModel):
    jobId: str
    total: int
    schemes: list[dict]                 # per scheme: trainSpan + fold windows


class WfoJobStatusResponse(BaseModel):
    phase: str                          # "grid" | "test" | "aggregate" | "done"
    done: int
    total: int
    running: bool
    cancelled: bool
    error: str | None = None
    etaSeconds: float | None = None
    foldRows: list[dict]                # streamed winner rows from cursor
    result: dict | None = None          # final WfoResult once finished


def axis_dicts(axes: list[WfoAxisDTO]) -> list[dict]:
    """Convert WfoAxisDTO list to plain dicts with values coerced to float."""
    result = []
    for axis in axes:
        d = {
            "kind": axis.kind,
            "targets": axis.targets,
        }
        if axis.values is not None:
            d["values"] = [float(v) for v in axis.values]
        result.append(d)
    return result


class SweepJobSubmitResponse(BaseModel):
    """POST /api/backtest/sweep/jobs: the job handle the frontend polls."""
    jobId: str
    total: int


class SweepJobStatusResponse(BaseModel):
    """GET /api/backtest/sweep/jobs/{job_id}?cursor=N: rows are the job's
    completion-order rows from `cursor` on (the poller passes how many it
    already has), plus live progress/ETA and terminal flags."""
    rows: list[SweepRowDTO]
    done: int
    total: int
    running: bool
    cancelled: bool
    error: str | None = None
    etaSeconds: float | None = None


class SweepJobInfoDTO(BaseModel):
    """GET /api/backtest/sweep/jobs: one job's summary line."""
    jobId: str
    epic: str
    timeframe: str
    done: int
    total: int
    running: bool
    createdAt: float


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
    expires_at: datetime | None = None  # good-till-date (UTC); None = GTC
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
    expires_at: datetime | None = None  # None = keep the order's current expiry
    clear_expiry: bool = False  # True = reset to Good-Till-Cancelled


class WorkingOrderDTO(BaseModel):
    epic: str
    side: str
    quantity: float
    limit_level: float
    order_id: str
    stop_level: float | None = None
    take_profit_level: float | None = None
    created_at: datetime | None = None
    expires_at: datetime | None = None


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
    # Author-specified size from a coded strategy's ctx.buy(qty=)/ctx.sell(qty=).
    # None = caller's default sizing (the live panel's configured quantity).
    # Only ever set on "open" actions — closes are always whole-position.
    quantity: float | None = None


class EvaluateRequest(BaseModel):
    epic: str
    resolution: str
    candles: list[CandleDTO]
    series: dict[str, list[float | None]] = {}
    longEnabled: bool = True
    shortEnabled: bool = True
    longRisk: RiskConfigDTO | None = None
    shortRisk: RiskConfigDTO | None = None
    position: PositionStateDTO | None = None
    # Coded strategy filename (backend/strategies/*.py). When set the rule groups
    # are ignored; a meta["hedged"] strategy is refused (backtest-only).
    codedStrategy: str | None = None
    # Panel-tuned values for the coded strategy's declared meta["params"];
    # unset/omitted params fall back to their declared defaults.
    codedParams: dict[str, int | float | bool | str] | None = None
    # Broker/price side for backend-side HTF fetches (coded strategies' tf= calls).
    broker: str = ""  # empty = server default broker (deps.default_broker_id)
    priceSide: str = "mid"
    # Expression mode: when True the structured rule groups are ignored and the
    # expr* groups below drive the live decision (parallel to /api/expr/backtest).
    # All optional so structured/coded callers are unaffected.
    exprMode: bool = False
    exprLongEntry: list[ExprRowDTO] = []
    exprLongExit: list[ExprRowDTO] = []
    exprShortEntry: list[ExprRowDTO] = []
    exprShortExit: list[ExprRowDTO] = []
    # how this group's rows combine: "AND" (default) | "OR"
    exprLongEntryCombine: Literal["AND", "OR"] = "AND"
    exprLongExitCombine: Literal["AND", "OR"] = "AND"
    exprShortEntryCombine: Literal["AND", "OR"] = "AND"
    exprShortExitCombine: Literal["AND", "OR"] = "AND"
    htfCandles: dict[str, list[CandleDTO]] | None = None
    # Chart indicator instance settings, keyed by instance id. A rule names an
    # OUTPUT (SLOPE.9) and never restates the pane's parameters, so they
    # travel here. Unregistered pane types are skipped, not rejected.
    indicators: dict[str, IndicatorInstanceDTO] = {}


class EvaluateResponse(BaseModel):
    actions: list[ActionDTO]


# --- coded strategies: /api/strategies discovery ------------------------------


class ParamSpecDTO(BaseModel):
    """One tunable knob a coded strategy declares in meta['params']."""
    name: str
    label: str
    type: Literal["int", "float", "bool", "choice"]
    default: int | float | bool | str
    min: float | None = None
    max: float | None = None
    step: float | None = None
    options: list[str] | None = None
    help: str | None = None


class StrategyInfoDTO(BaseModel):
    """One discovered backend/strategies/*.py file. A file that fails to load is
    still listed with `error` set, so the picker can show it as broken."""

    filename: str
    name: str
    description: str
    hedged: bool
    params: list[ParamSpecDTO] = []
    # Chart indicators the UI keeps in sync with the strategy's params:
    # {"indicator": <chart indicator name>, "calc_params": [<param name>, ...]}.
    chart_overlays: list[dict] = []
    error: str | None = None


class StrategySourceDTO(BaseModel):
    filename: str
    source: str


# --- expression surface (/api/expr/*) ----------------------------------------
# Parallel to the structured BacktestRequest: each rule group is a list of raw
# expression strings the backend parses/validates/compiles. The structured DTOs
# above stay untouched.


class ExprRowDTO(BaseModel):
    expr: str
    enabled: bool = True


class IndicatorInstanceDTO(BaseModel):
    """A chart indicator instance's settings, keyed by its instance id. Rules
    reference an instance's OUTPUT (SLOPE.9) and never restate its
    parameters, so this map is how the backend learns them.

    The chart ships EVERY pane it carries, including types the backend has no
    series spec for (MACD/BOLL/KDJ): resolve_instances skips those rather than
    erroring, so no rule can reference them but shipping them is harmless."""
    type: str | None = None          # inferred from the id when absent
    calcParams: list[float] | None = None
    extendData: dict | None = None


class ExprBacktestRequest(BaseModel):
    epic: str
    resolution: str
    candles: list[CandleDTO]
    # @tf rows need higher-timeframe candles. When absent the route fetches the
    # referenced set itself over broker/priceSide (which must match the base
    # candles' source, like the structured request's fields); shipped bars win
    # so a compute-only host never reaches a broker.
    htfCandles: dict[str, list[CandleDTO]] | None = None
    broker: str = ""  # empty = server default broker (deps.default_broker_id)
    priceSide: str = "mid"
    longEntry: list[ExprRowDTO] = []
    longExit: list[ExprRowDTO] = []
    shortEntry: list[ExprRowDTO] = []
    shortExit: list[ExprRowDTO] = []
    # how this group's rows combine: "AND" (default) | "OR"
    longEntryCombine: Literal["AND", "OR"] = "AND"
    longExitCombine: Literal["AND", "OR"] = "AND"
    shortEntryCombine: Literal["AND", "OR"] = "AND"
    shortExitCombine: Literal["AND", "OR"] = "AND"
    longEnabled: bool = True
    shortEnabled: bool = True
    longRisk: RiskConfigDTO | None = None
    shortRisk: RiskConfigDTO | None = None
    longScaling: ScalingConfigDTO | None = None
    shortScaling: ScalingConfigDTO | None = None
    costs: CostsDTO
    tradeFromTime: int
    mask: RecurrenceMaskDTO | None = None
    # Parameter/literal sweep: when set, POST /api/expr/sweep/jobs runs one combo
    # per entry (lit:/risk:/period:/timeWindow: targets). Ignored by POST
    # /api/expr/backtest.
    sweep: SweepDTO | None = None
    # Walk-forward optimization: when set, POST /api/expr/walkforward/jobs runs the
    # grid + test schedule as one job (same WalkForwardDTO grammar as the structured
    # request; combos use lit:/risk: targets, never rule:/param:).
    walkforward: "WalkForwardDTO | None" = None
    # Chart indicator instance settings, keyed by instance id. A rule names an
    # OUTPUT (SLOPE.9) and never restates the pane's parameters, so they
    # travel here. Unregistered pane types are skipped, not rejected.
    indicators: dict[str, IndicatorInstanceDTO] = {}
    # Optional client-generated id for GET /api/backtest/progress/{id} polling.
    # Cosmetic: absent means no progress reporting for this run.
    progressId: str | None = None
    # Baseline companion runs (expr runs only). "null" = entries replaced by
    # 1==1, everything else identical; "hold" = 1==1 entries with exits, risk,
    # scaling, and mask stripped (enter once, hold to window end). The response
    # carries each requested baseline's metrics in `baselines`.
    baselines: list[Literal["null", "hold", "reversed", "oracle_entries"]] | None = None


class ExprSeriesRequest(BaseModel):
    epic: str
    resolution: str
    expr: str
    fromTime: int
    toTime: int
    broker: str = ""  # empty = server default broker (deps.default_broker_id)
    priceSide: str = "mid"
    # Chart indicator instance settings, keyed by instance id. A rule names an
    # OUTPUT (SLOPE.9) and never restates the pane's parameters, so they
    # travel here. Unregistered pane types are skipped, not rejected.
    indicators: dict[str, IndicatorInstanceDTO] = {}


class NormSpec(BaseModel):
    basis: str = "volatility"   # "volatility" | "atr"
    width: float = 2.0
    window: int = 50
    atrLength: int = 14


class ExprClosenessRequest(BaseModel):
    epic: str
    broker: str = ""  # empty = server default broker (deps.default_broker_id)
    priceSide: str = "mid"
    rows: list[str]
    combine: Literal["AND", "OR"] = "AND"
    baseResolution: str
    displayResolution: str
    fromTime: int
    toTime: int
    norm: NormSpec = NormSpec()
    agg: str = "max"            # "max" | "avg" | "last"
    # Chart indicator instance settings, keyed by instance id. A rule names an
    # OUTPUT (SLOPE.9) and never restates the pane's parameters, so they
    # travel here. Unregistered pane types are skipped, not rejected.
    indicators: dict[str, IndicatorInstanceDTO] = {}


class ExprLiteralsRequest(BaseModel):
    expr: str
    # Chart indicator instance settings, keyed by instance id. A rule names an
    # OUTPUT (SLOPE.9) and never restates the pane's parameters, so they
    # travel here. Unregistered pane types are skipped, not rejected.
    indicators: dict[str, IndicatorInstanceDTO] = {}


# --- pattern search -----------------------------------------------------------


class PatternBarDTO(BaseModel):
    """One candle in a pattern query or result. Short keys: a 64-bar query plus
    20 matches of 6+20 bars each rides on every request and response."""

    ts: int = 0
    o: float
    h: float
    l: float  # noqa: E741
    c: float


class PatternSearchRequest(BaseModel):
    epic: str
    resolution: str
    price_side: str = Field("bid", alias="priceSide", pattern="^(bid|mid|ask)$")
    broker: str = ""  # empty = server default broker (deps.default_broker_id)
    query: list[PatternBarDTO] = Field(min_length=3, max_length=64)
    query_from_ts: int = Field(alias="queryFromTs")
    query_to_ts: int = Field(alias="queryToTs")
    top_k: int = Field(20, alias="topK", ge=1, le=100)
    forward_bars: int = Field(20, alias="forwardBars", ge=0, le=500)
    # What the distance is measured over: whole candles (open, high, low, close)
    # or the close alone. Not a correctness knob: the two rank real history
    # differently enough that the top 20 overlap by about half, and neither is
    # the right answer for every question.
    mode: Literal["ohlc", "close"] = "ohlc"

    model_config = {"populate_by_name": True}


class PatternMatchDTO(BaseModel):
    ts: int
    end_ts: int = Field(serialization_alias="endTs")
    distance: float
    bars: list[PatternBarDTO]
    forward: list[PatternBarDTO]
    forward_complete: bool = Field(serialization_alias="forwardComplete")
    forward_pct: float | None = Field(serialization_alias="forwardPct")
    # True on the one window that IS the user's selection. It is scanned like
    # any other and comes back at distance ~0; the panel labels it so the row
    # reads as the reference point rather than an uncanny coincidence.
    is_selection: bool = Field(default=False, serialization_alias="isSelection")


class PatternSeriesDTO(BaseModel):
    oldest_ts: int = Field(serialization_alias="oldestTs")
    newest_ts: int = Field(serialization_alias="newestTs")
    bars: int


class PatternSearchResponse(BaseModel):
    matches: list[PatternMatchDTO]
    scanned: int
    series: PatternSeriesDTO
    elapsed_ms: int = Field(serialization_alias="elapsedMs")
    cold: bool

    model_config = {"populate_by_name": True}
