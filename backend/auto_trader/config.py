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

    # Live (real-money) dealing account. Capital.com runs paper/demo/live as
    # ACCOUNTS of the one "capital" broker (the chart feed is shared — demo carries
    # real market quotes), so this is NOT a second data broker like IG's split: it's
    # an extra execution account that deals against the live host with its own
    # session. Registered as "capital:live" only when fully credentialed (see
    # has_live), so a half-configured account never shows a dead tab. The login
    # (identifier) is the same Capital account as demo, so live_identifier falls back
    # to `identifier`; only the API key + its custom password are env-specific.
    live_api_key: str = ""
    live_password: str = ""
    live_identifier: str = ""

    def has_live(self) -> bool:
        """True only when the live dealing account is fully credentialed."""
        return bool(self.live_api_key and self.live_password and (self.live_identifier or self.identifier))

    def live_creds(self) -> tuple[str, str, str]:
        """(api_key, identifier, password) for the live dealing session."""
        return (self.live_api_key, self.live_identifier or self.identifier, self.live_password)

    @property
    def live_base_url(self) -> str:
        return CAPITAL_HOSTS["live"]

    # Where the tick recorder persists sub-minute history (Capital has no
    # sub-minute history endpoint, so we record live ticks ourselves). Set
    # CAPITAL_TICK_DB_PATH to relocate; defaults to a file in the backend cwd.
    tick_db_path: str = "tick_history.db"
    candle_db_path: str = "candle_history.db"

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


# IG (labs.ig.com Web API) — the upstream API Capital.com forked. Demo and live
# are genuinely separate: different hosts, different API keys, different logins,
# different data. They register as two independent data brokers (ig-demo /
# ig-live), each carrying a paper executor + a real IG dealing executor.
IG_HOSTS = {
    "demo": "https://demo-api.ig.com/gateway/deal",
    "live": "https://api.ig.com/gateway/deal",
}


class IGSettings(BaseSettings):
    """IG credentials, demo + live in one block (env-prefixed IG_DEMO_/IG_LIVE_).

    A side (demo/live) registers only when its api_key + identifier + password are
    all present (see `has(side)`), so a half-configured or absent IG account never
    shows a dead entry in the broker selector. The dealing account id is derived
    from the login response, so it isn't required here."""

    model_config = SettingsConfigDict(
        env_prefix="IG_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    demo_api_key: str = ""
    demo_identifier: str = ""
    demo_password: str = ""
    live_api_key: str = ""
    live_identifier: str = ""
    live_password: str = ""

    def creds(self, side: str) -> tuple[str, str, str]:
        """(api_key, identifier, password) for "demo" | "live"."""
        return (
            getattr(self, f"{side}_api_key"),
            getattr(self, f"{side}_identifier"),
            getattr(self, f"{side}_password"),
        )

    def has(self, side: str) -> bool:
        """True only when every credential for `side` is set (gates registration)."""
        return all(self.creds(side))

    def base_url(self, side: str) -> str:
        return IG_HOSTS[side]


ig_settings = IGSettings()
