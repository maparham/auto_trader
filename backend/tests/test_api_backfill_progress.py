"""GET /api/candle-cache/backfill/active — registry snapshot over HTTP.

Direct-call convention per test_api_candles.py (no pytest-asyncio).
"""

from __future__ import annotations

import asyncio

from auto_trader.api.routers import charts
from auto_trader.core import candle_cache as cc


def test_active_backfills_endpoint_maps_registry_entries():
    cc._ACTIVE_BACKFILLS[("b", "E", "MINUTE_5", "bid")] = {
        "label": "b/E/MINUTE_5/bid", "done_chunks": 14, "total_chunks": 70,
        "bars": 27370, "elapsed_s": 49.8, "eta_s": 199.0,
        "at": "2023-08-01 20:45", "updated_at": cc.time.time(),
    }
    try:
        out = asyncio.run(charts.active_backfill_progress())
    finally:
        cc._ACTIVE_BACKFILLS.clear()
    assert len(out) == 1
    dto = out[0]
    assert dto.label == "b/E/MINUTE_5/bid"
    assert dto.doneChunks == 14 and dto.totalChunks == 70
    assert dto.etaS == 199.0 and dto.at == "2023-08-01 20:45"


def test_active_backfills_endpoint_empty():
    assert asyncio.run(charts.active_backfill_progress()) == []
