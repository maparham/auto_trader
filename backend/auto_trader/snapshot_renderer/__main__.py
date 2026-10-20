"""Entry point: `python -m auto_trader.snapshot_renderer`. Binds loopback
only — this renderer is never meant to be reachable off-box."""

import uvicorn

if __name__ == "__main__":
    uvicorn.run(
        "auto_trader.snapshot_renderer.app:app",
        host="127.0.0.1",
        port=9223,
        log_level="info",
    )
