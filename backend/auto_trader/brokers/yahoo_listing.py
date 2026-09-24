"""Yahoo Finance ticker for a share a broker names its own way.

IG and MT5 epics are not tickers (IG's Booking Holdings is UC.D.PCLN.CASH.IP,
AvaTrade's is #BOOKING.COM), so their get_market_meta names the Yahoo ticker
for the split markers (brokers/yahoo_splits.py) from the listing's local code
and country. Pure, no yfinance import, so the MT5 symbol helpers can use it.
"""

from __future__ import annotations

# Listing country -> Yahoo exchange suffix. A country missing here answers
# None: no markers beats markers from another company with the same code.
_SUFFIX = {
    "US": "", "GB": ".L", "DE": ".DE", "FR": ".PA", "NL": ".AS", "BE": ".BR",
    "ES": ".MC", "IT": ".MI", "PT": ".LS", "IE": ".IR", "CH": ".SW", "AT": ".VI",
    "SE": ".ST", "DK": ".CO", "NO": ".OL", "FI": ".HE", "CA": ".TO", "AU": ".AX",
    "HK": ".HK", "JP": ".T", "SG": ".SI",
}


def listing_ticker(code: str | None, country: str | None) -> str | None:
    """Yahoo ticker for local code `code` listed in `country` (ISO 3166
    alpha-2), or None when either is unknown."""
    if not code or not country:
        return None
    suffix = _SUFFIX.get(country.upper())
    if suffix is None:
        return None
    code = code.strip().upper()
    if suffix == "":
        return code.replace(".", "-")  # BRK.B is BRK-B on Yahoo
    return code + suffix
