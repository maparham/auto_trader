from datetime import datetime, timezone

from auto_trader.core.candle_aggregate import DERIVED, fold
from auto_trader.core.models import Candle


def _day(y, m, d, o, h, l, c, v=1.0):
    return Candle(datetime(y, m, d, tzinfo=timezone.utc), o, h, l, c, v)


def test_fold_matches_handler_contract():
    # The /api/candles derived branch returns exactly fold(base_bars, rule); this
    # anchors that contract independent of the HTTP layer / live broker creds.
    days = [_day(2026, 3, i, 10 + i, 20, 5, 10 + i) for i in range(1, 6)]
    out = fold(days, DERIVED["MONTH"])
    assert len(out) == 1
    assert out[0].open == 11 and out[0].high == 20 and out[0].low == 5
