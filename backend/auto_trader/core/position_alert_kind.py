"""The `position` alert kind: a warning when the price nears a position's stop
loss or take profit, measured in ATR units. Pure logic only; the watcher that
feeds ticks and candles lives elsewhere. Like `account`, deliberately NOT
registered in `alert_kinds.KINDS`: the price engine has no bars for it."""
from __future__ import annotations

import json
import math

from auto_trader.core.models import Candle
from auto_trader.indicators.core import atr_series

SIDES = ("sl", "tp")
ATR_MIN = 0.05
ATR_MAX = 5.0
ATR_DEFAULT = 0.5
DEAL_ID_MAX = 128
REARM_FACTOR = 1.5


def _finite(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


class PositionAlertKind:
    def validate(self, params: dict) -> None:
        deal = params.get("dealId")
        if not isinstance(deal, str) or not 1 <= len(deal) <= DEAL_ID_MAX:
            raise ValueError(f"dealId must be a string of 1 to {DEAL_ID_MAX} characters")
        if params.get("side") not in SIDES:
            raise ValueError("side must be sl or tp")
        mult = params.get("atrMult")
        if not _finite(mult) or not ATR_MIN <= mult <= ATR_MAX:
            raise ValueError(f"atrMult must be a finite number from {ATR_MIN} to {ATR_MAX}")

    def sig(self, params: dict) -> str:
        # atrMult is excluded: the same position and side is a duplicate.
        return json.dumps([params["dealId"], params["side"]])


POSITION_KIND = PositionAlertKind()


def data_broker_of(account: str) -> str:
    """The data broker id behind an exec key: `capital-live:live` -> `capital-live`."""
    return account.split(":", 1)[0]


def is_watchable(account: str) -> bool:
    """MetaApi (`mt5` prefix) is never touched, so its positions cannot be watched."""
    return data_broker_of(account) != "mt5"


def watched_price(pos_side: str, bid: float | None, ask: float | None) -> float | None:
    """A long is judged on the bid, a short on the offer. A missing side falls
    back to the other one."""
    preferred, other = (bid, ask) if pos_side == "BUY" else (ask, bid)
    return preferred if preferred is not None else other


def step(level: float, price: float, threshold: float, fired: bool) -> tuple[bool, bool]:
    """Advance one alert's state. Returns (fired_after, fire_now). Fires once
    when the price first comes within `threshold` of the level, and re-arms
    only once it is beyond REARM_FACTOR times the threshold."""
    if threshold <= 0:
        return fired, False
    dist = abs(price - level)
    if not fired and dist <= threshold:
        return True, True
    if fired and dist > REARM_FACTOR * threshold:
        return False, False
    return fired, False


def atr(candles: list[Candle], length: int = 14) -> float | None:
    """Latest ATR from the shared indicator (`indicators.core.atr_series`):
    the first ATR is the mean of the first `length` true ranges, then Wilder.
    None when there are fewer than `length + 1` candles."""
    if len(candles) < length + 1:
        return None
    return atr_series(candles, length)[-1]


def headline(
    epic: str, pos_side: str, alert_side: str, level: float, price: float,
    atr_value: float, upnl: float | None, currency: str | None, precision: int,
) -> str:
    if atr_value <= 0:
        raise ValueError(f"atr_value must be positive, got {atr_value}")
    dist = abs(price - level)
    direction = "long" if pos_side == "BUY" else "short"
    side = alert_side.upper()
    parts = [
        f"{epic} {direction}",
        f"near {side}",
        f"{dist:.{precision}f} pts ({dist / atr_value:.2f} ATR) away",
        f"{side} {level:.{precision}f}",
    ]
    if upnl is not None:
        pnl = f"P&L {upnl:.2f}"
        parts.append(f"{pnl} {currency}" if currency else pnl)
    return " · ".join(parts)
