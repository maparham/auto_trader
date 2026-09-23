"""AvaTrade MT5 symbol vocabulary, shared by the MT5 adapters.

A copy of the SDK-free helpers in `mt5.py` (which imports the MetaApi SDK at
module level), so the local-terminal adapter `mt5_mcp.py` can use them without
pulling MetaApi in. Once MetaApi is removed and `mt5.py` goes, this is the
canonical version. Keep the two in step until then.
"""

from __future__ import annotations

import re

# Symbol-search chips over the `type` values _classify_symbol stamps.
MT5_CATEGORIES = [
    {"key": "SHARES", "label": "Stocks", "types": ["SHARES"], "row": "stock"},
    {"key": "CURRENCIES", "label": "Forex", "types": ["CURRENCIES"], "row": "forex"},
    {"key": "CRYPTOCURRENCIES", "label": "Crypto", "types": ["CRYPTOCURRENCIES"], "row": "crypto"},
    {"key": "INDICES", "label": "Indices", "types": ["INDICES"], "row": "index"},
    {"key": "COMMODITIES", "label": "Commodities", "types": ["COMMODITIES"], "row": "commodity"},
]


# --- symbol-search categorisation -------------------------------------------
# MT5 symbol lists return bare symbol strings with no category metadata
# (unlike Capital's instrumentType), so the symbol-search modal's chips (Stocks/
# Forex/Crypto/Indices/Commodities) have nothing to filter on. We infer the
# category from AvaTrade's naming conventions. This is a best-effort classifier
# tuned to AvaTrade's actual symbol list; unrecognised symbols return None and
# stay browsable under "All" + free-text search rather than being mislabelled.

# ISO-4217 fiat codes AvaTrade quotes forex in. Deliberately excludes the metal
# codes (XAU/XAG/XPT/XPD) so "XAUUSD"-style symbols don't read as a forex pair.
_FIAT_CODES = frozenset(
    "USD EUR GBP JPY CHF CAD AUD NZD SEK NOK DKK SGD HKD MXN ZAR TRY PLN CZK "
    "HUF ILS RUB CNY CNH CLP".split()
)
# Crypto base tickers; a symbol whose alnum form starts with one (e.g. BTCUSD,
# MATICUSD, PEPEUSD) is crypto. "CRYPTO" also catches AvaTrade's CRYPTO10 basket.
_CRYPTO_BASES = (
    "BTC", "ETH", "LTC", "BCH", "XRP", "XLM", "DOGE", "SOL", "LINK", "UNI",
    "MATIC", "PEPE", "BTG", "ADA", "DOT", "AVAX", "TRX", "EOS", "DASH", "SHIB",
)
_METAL_CODES = ("XAU", "XAG", "XPT", "XPD")
# AvaTrade names commodities in words (GOLD, BRENT_OIL, NATURAL_GAS), not tickers.
_COMMODITY_KW = (
    "GOLD", "SILVER", "PLATINUM", "PALLADIUM", "COPPER", "ALUMINIUM", "ALUMINUM",
    "NICKEL", "OIL", "CRUDE", "BRENT", "GASOLINE", "GAS", "HEATING", "COCOA",
    "COFFEE", "CORN", "COTTON", "SOYBEAN", "SUGAR", "WHEAT",
)
_COMMODITY_EXACT = frozenset({"SI_FUTURE"})  # silver future, named off-pattern
# Region-benchmark indices (US_30, GERMANY_40, JAPAN_225) + AvaTrade's thematic
# baskets (FAANG, AIRLINES, AI_INDX), which it groups under indices.
_INDEX_KW = (
    "INDX", "INDEX", "FAANG", "AIRLINES", "GIANTS", "INTERNET", "VACCINE",
    "CANNABIS", "GREEN_ENERGY", "BATTERY", "STRATEGIC_METALS", "RACING",
)
_INDEX_REGION = (
    "US_", "UK_", "GERMANY", "FRANCE", "ITALY", "JAPAN", "AUS_", "HK_",
    "CHINA_", "EUROPE", "NED_", "SWISS", "TAIWAN", "CANADA", "SPAIN", "SPA_",
)


def _classify_symbol(sym: str) -> str | None:
    """AvaTrade MT5 symbol -> symbol-search category, matching the frontend chip
    types (SHARES/CURRENCIES/CRYPTOCURRENCIES/INDICES/COMMODITIES). None means
    "no chip": the symbol still appears under All and in search. First match wins;
    order matters (bonds before indices so JAPAN_BOND isn't read as a JAPAN index;
    metals before forex so XAUUSD isn't read as a currency pair)."""
    if sym.startswith(("#", "_")):
        return "SHARES"  # AvaTrade prefixes equities with # (US) or _ (EU)
    s = sym.upper()
    if "BOND" in s or "BUND" in s:
        return None  # no bonds chip; keep out of the region-index bucket
    alnum = re.sub(r"[^A-Z0-9]", "", s)
    if "CRYPTO" in s or any(
        alnum.startswith(b) and len(alnum) > len(b) for b in _CRYPTO_BASES
    ):
        return "CRYPTOCURRENCIES"
    if (
        sym in _COMMODITY_EXACT
        or alnum[:3] in _METAL_CODES
        or any(kw in s for kw in _COMMODITY_KW)
    ):
        return "COMMODITIES"
    if any(kw in s for kw in _INDEX_KW) or s.startswith(_INDEX_REGION):
        return "INDICES"
    if len(alnum) == 6 and alnum[:3] in _FIAT_CODES and alnum[3:] in _FIAT_CODES:
        return "CURRENCIES"
    return None
