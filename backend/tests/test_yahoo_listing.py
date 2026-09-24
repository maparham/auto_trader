# backend/tests/test_yahoo_listing.py
from __future__ import annotations

from auto_trader.brokers._mt5_symbols import avatrade_ticker
from auto_trader.brokers.yahoo_listing import listing_ticker


def test_listing_ticker_adds_the_exchange_suffix_by_country():
    assert listing_ticker("BKNG", "US") == "BKNG"
    assert listing_ticker("0R2V", "GB") == "0R2V.L"
    assert listing_ticker("APC", "DE") == "APC.DE"
    assert listing_ticker("MC", "FR") == "MC.PA"


def test_listing_ticker_uses_yahoo_share_class_dashes_in_the_us():
    assert listing_ticker("BRK.B", "US") == "BRK-B"


def test_listing_ticker_refuses_unknown_listings():
    assert listing_ticker("XYZ", "ZZ") is None
    assert listing_ticker("", "US") is None
    assert listing_ticker(None, "US") is None
    assert listing_ticker("BKNG", None) is None


def test_avatrade_ticker_reads_the_description():
    # AvaTrade names shares by company (#BOOKING.COM); the ticker only shows
    # in the description. # is a US listing whatever the issuer's ISIN says.
    assert avatrade_ticker("#BOOKING.COM", "1 Lot= 10 Shares (BKNG)", "US09857L1089") == "BKNG"
    assert avatrade_ticker("#SPOTIFY", "1 Lot= 10 Shares (SPOT)", "LU1778762911") == "SPOT"
    # _ is a European listing: the ISIN country picks the exchange.
    assert avatrade_ticker("_SAP", "1 Lot= 10 Shares (SAP)", "DE0007164600") == "SAP.DE"


def test_avatrade_ticker_is_none_without_a_ticker_or_for_non_shares():
    assert avatrade_ticker("#APPLE", "Apple Inc", "US0378331005") is None
    assert avatrade_ticker("EURUSD", "1 Lot= 100,000 EUR", None) is None
    assert avatrade_ticker("_SAP", "1 Lot= 10 Shares (SAP)", None) is None
