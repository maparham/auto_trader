"""Runtime configuration, loaded from environment / .env."""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict

# Capital.com uses different hosts for demo and live. Demo is for development.
CAPITAL_HOSTS = {
    "demo": "https://demo-api-capital.backend-capital.com",
    "live": "https://api-capital.backend-capital.com",
}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="CAPITAL_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    env: str = "demo"
    api_key: str = ""
    identifier: str = ""
    password: str = ""

    # Where the tick recorder persists sub-minute history (Capital has no
    # sub-minute history endpoint, so we record live ticks ourselves). Set
    # CAPITAL_TICK_DB_PATH to relocate; defaults to a file in the backend cwd.
    tick_db_path: str = "tick_history.db"

    # Where chart workspace state (tabs/layouts, drawings, indicators, alerts) is
    # persisted so it survives across browsers/devices. A key-value mirror of the
    # frontend's localStorage. Set CAPITAL_STATE_DB_PATH to relocate.
    state_db_path: str = "app_state.db"

    # CAPITAL_STREAM_DEBUG=1 turns on a per-second latency summary for the live
    # candle streams (see capital_stream._StreamDebug): tick rate, tick->candle
    # yield ratio, and age_ms = now - tick_timestamp. Verifies that ticks reach
    # the live candle immediately; a growing age_ms means backpressure. Off by
    # default — it logs once per second per open stream.
    stream_debug: bool = False

    @property
    def base_url(self) -> str:
        return CAPITAL_HOSTS[self.env]


settings = Settings()
