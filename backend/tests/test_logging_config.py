"""_configure_logging: third-party request-log noise is capped at WARNING."""
import logging

from auto_trader.api.app import _configure_logging


def test_httpx_request_lines_are_silenced():
    # httpx logs every outbound request at INFO ("HTTP Request: GET ..."), which
    # floods the console during backfills. Under uvicorn the root logger is at
    # INFO (mirrored here), so httpx INFO propagates unless _configure_logging
    # caps the httpx logger itself.
    root_level = logging.getLogger().level
    logging.getLogger().setLevel(logging.INFO)
    logging.getLogger("httpx").setLevel(logging.NOTSET)
    try:
        _configure_logging()
        assert not logging.getLogger("httpx").isEnabledFor(logging.INFO)
    finally:
        logging.getLogger().setLevel(root_level)
