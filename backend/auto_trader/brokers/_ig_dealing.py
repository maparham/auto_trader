"""IG-only marketable-limit dealing helpers.

IG only accepts a plain `orderType: MARKET` when the epic's dealing rules allow
it; many epics (e.g. weekend indices) reject it. These helpers build a
marketable-LIMIT fallback (priced a small buffer through the current quote,
EXECUTE_AND_ELIMINATE) for opening and closing positions. IG-specific — not
shared with Capital.com, which doesn't need this fallback.
"""

from __future__ import annotations

import math

from auto_trader.brokers._dealing import clean as _clean
from auto_trader.core.models import Order, Side


def _currency_from_raw(raw: dict | None) -> str | None:
    """Dealable currency code from a market-detail payload (default, else first)."""
    currencies = ((raw or {}).get("instrument") or {}).get("currencies") or []
    if not currencies:
        return None
    default = next((c for c in currencies if c.get("isDefault")), currencies[0])
    return default.get("code")


def _market_open_body(
    order: Order, direction: str, ccy: str | None, raw: dict | None
) -> tuple[dict, str | None]:
    """Build the /positions/otc body for an immediate ('market') fill, returning
    (body, error). IG only accepts a plain `orderType: MARKET` when the epic's
    `dealingRules.marketOrderPreference` allows it; many epics (e.g. weekend
    indices) reject it with `market-orders.not-supported-for-epic`. For those we
    send a *marketable limit* instead — orderType LIMIT at the current dealing
    price (offer to buy, bid to sell) with EXECUTE_AND_ELIMINATE, which fills
    immediately at that price or better and kills any unfilled remainder. The
    attached stop/take-profit ride along identically either way."""
    rules = (raw or {}).get("dealingRules") or {}
    snapshot = (raw or {}).get("snapshot") or {}
    pref = str(rules.get("marketOrderPreference") or "").upper()
    common = {
        "epic": order.epic, "expiry": "-", "direction": direction,
        "size": order.quantity, "guaranteedStop": False, "forceOpen": True,
        "currencyCode": ccy, "stopLevel": order.stop_level,
        "limitLevel": order.take_profit_level,
    }
    if pref.startswith("AVAILABLE"):
        return _clean({**common, "orderType": "MARKET"}), None
    # Marketable limit fallback: price a buffer THROUGH the market.
    level = _marketable_level(order.side is Side.BUY, snapshot)
    if level is None:
        return {}, "no quote available to price a market order"
    return _clean({
        **common, "orderType": "LIMIT", "level": level,
        "timeInForce": "EXECUTE_AND_ELIMINATE",
    }), None


def _close_body(
    deal_id: str, opposite: str, size: float, raw: dict | None
) -> tuple[dict, str | None]:
    """Body for closing a position, MARKET when the epic allows it, else a
    marketable LIMIT at the crossing quote (the close direction `opposite` sells
    at bid / buys at offer). Returns (body, error)."""
    rules = (raw or {}).get("dealingRules") or {}
    snapshot = (raw or {}).get("snapshot") or {}
    common = {"dealId": deal_id, "direction": opposite, "size": size}
    if str(rules.get("marketOrderPreference") or "").upper().startswith("AVAILABLE"):
        return {**common, "orderType": "MARKET"}, None
    level = _marketable_level(opposite == "BUY", snapshot)
    if level is None:
        return {}, "no quote available to price the close"
    return {
        **common, "orderType": "LIMIT", "level": level,
        "timeInForce": "EXECUTE_AND_ELIMINATE",
    }, None


def _marketable_level(is_buy: bool, snapshot: dict) -> float | None:
    """A limit level priced a buffer THROUGH the current quote so the order is
    reliably marketable (a BUY a touch above the offer, a SELL a touch below the
    bid). With EXECUTE_AND_ELIMINATE the actual fill is the best available price up
    to this level, so the buffer guarantees an immediate fill without ever
    worsening it — and absorbs the tick of movement between quoting and dealing
    that otherwise trips IG's LIMIT_ORDER_WRONG_SIDE_OF_MARKET. Returns None when
    the needed side of the quote is missing."""
    bid = snapshot.get("bid")
    offer = snapshot.get("offer")
    anchor = offer if is_buy else bid
    if anchor is None:
        return None
    # Buffer = the spread (a natural, instrument-scaled distance), with a small
    # price-relative floor for zero/te spreads.
    spread = (offer - bid) if (bid is not None and offer is not None) else 0.0
    buffer = max(spread, abs(anchor) * 0.0005)
    level = anchor + buffer if is_buy else anchor - buffer
    # Quantize to the instrument's price precision: an over-precise dealing level
    # (e.g. 6dp on a 5dp FX epic) can be rejected by IG — exactly on the epics that
    # already refuse plain MARKET, the reason this fallback exists. Round in the
    # marketable direction (buy up, sell down) so quantizing can only push further
    # through the market, never pull the level back across it.
    return _quantize_level(level, _snapshot_precision(snapshot), up=is_buy)


def _snapshot_precision(snapshot: dict) -> int | None:
    """Decimal places from IG's snapshot.decimalPlacesFactor (an integer count), or
    None when it's absent/non-integer (then the level is left unrounded)."""
    dpf = snapshot.get("decimalPlacesFactor")
    if isinstance(dpf, (int, float)) and not isinstance(dpf, bool) and dpf == int(dpf):
        return int(dpf)
    return None


def _quantize_level(level: float, precision: int | None, *, up: bool) -> float:
    """Round `level` to `precision` dp, ceiling for a buy and floor for a sell so the
    result stays at-or-through the market. No-op when precision is unknown."""
    if precision is None:
        return level
    factor = 10**precision
    rounded = math.ceil(level * factor) if up else math.floor(level * factor)
    return rounded / factor


def _first_affected(confirm: dict) -> str | None:
    affected = confirm.get("affectedDeals") or []
    return affected[0].get("dealId") if affected else None
