"""Runtime configuration, loaded from environment / .env."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass

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

    # Live (real-money) dealing account. The live host is promoted to its own data
    # broker, "capital-live" (its own session/quotes, independent of the demo
    # "capital" feed), carrying both an in-app paper sim ("capital-live:paper") and
    # the real-money dealing account ("capital-live:live"). Registered only when
    # fully credentialed (see has_live), so a half-configured account never shows a
    # dead tab. The login (identifier) is the same Capital account as demo, so
    # live_identifier falls back to `identifier`; only the API key + its custom
    # password are env-specific.
    live_api_key: str = ""
    live_password: str = ""
    live_identifier: str = ""

    def has(self) -> bool:
        """True only when the demo account is fully credentialed (gates
        registration of the whole capital feed, like IGSettings.has)."""
        return bool(self.api_key and self.identifier and self.password)

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

    # Where backtest runs (config + trades + metrics) are persisted for the
    # analysis loop. Capped at the most recent 200 runs. Set
    # CAPITAL_RUNS_DB_PATH to relocate.
    runs_db_path: str = "backtest_runs.db"

    # Where completed sweeps (axes + rows + windows) are archived so they can be
    # listed and reopened in the UI. Capped at the most recent 50 sweeps. Set
    # CAPITAL_SWEEPS_DB_PATH to relocate.
    sweeps_db_path: str = "backtest_sweeps.db"

    # Where completed walk-forward jobs (folds + winner combos + metrics) are
    # archived so they can be listed and reopened in the UI. Set
    # CAPITAL_WFO_DB_PATH to relocate.
    wfo_db_path: str = "backtest_wfo.db"

    # Where per-instrument cost profiles (spread, slippage, financing) are stored.
    # Set CAPITAL_COST_PROFILES_DB_PATH to relocate.
    cost_profiles_db_path: str = "cost_profiles.db"

    # Where price alerts (definitions, triggered history, push subs, telegram
    # links) are persisted. Set CAPITAL_ALERTS_DB_PATH to relocate.
    alerts_db_path: str = "alerts.db"

    # Where user-saved pattern presets are persisted. Set
    # CAPITAL_PATTERNS_DB_PATH to relocate.
    patterns_db_path: str = "patterns.db"

    # Where saved screener screens are persisted. Set CAPITAL_SCREENS_DB_PATH
    # to relocate.
    screens_db_path: str = "screens.db"

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


# MetaApi (metaapi.cloud) bridges an MT5 broker (AvaTrade) over a cloud API, so no
# local MT5 terminal is needed. One account registers as the "mt5" data broker
# with a paper sim ("mt5:paper") and the real-money dealing account ("mt5:live").
# Registered only when token + account_id are set (see `has`), so an absent MT5
# account never shows a dead entry in the broker selector.
class MTSettings(BaseSettings):
    """MetaApi credentials for one MT5 account (env-prefixed METAAPI_).

    `token` is a MetaApi access token scoped to this account (needs the
    trading-account-management + REST + RPC + streaming APIs). `account_id` is the
    MetaApi account UUID (not the MT5 login). `region` is the MetaApi hosting
    region the account was provisioned in ("london" | "new-york")."""

    model_config = SettingsConfigDict(
        env_prefix="METAAPI_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    token: str = ""
    account_id: str = ""
    region: str = "london"

    def has(self) -> bool:
        """True only when the account is fully credentialed (gates registration)."""
        return bool(self.token and self.account_id)


mt5_settings = MTSettings()


# The local MT5 terminal's built-in MCP server (Tools > Options > MCP), an
# alternative transport to MetaApi for the same AvaTrade account. Registers as
# "mt5-self" (+ paper + live) only when the key is set, so a machine without a
# running terminal never shows a dead entry.
class MT5MCPSettings(BaseSettings):
    """Env-prefixed MT5MCP_. `key` is the API key shown in the terminal's MCP
    options tab. `server_utc_offset_minutes` is the trade server's clock
    offset from UTC (0 for Ava-Real 1-MT5); MCP timestamps are server time."""

    model_config = SettingsConfigDict(
        env_prefix="MT5MCP_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    url: str = "http://127.0.0.1:22346/mcp"
    key: str = ""
    server_utc_offset_minutes: int = 0

    def has(self) -> bool:
        return bool(self.url and self.key)


mt5mcp_settings = MT5MCPSettings()


# Telegram bot delivery for price alerts (deep-link account linking + DM
# notifier). Registers only when a bot token is set (see TelegramNotify.enabled
# in core/telegram_notify.py) — an absent token just disables the feature
# (link endpoint 503s, poller returns immediately), same "half-configured
# never shows a dead entry" convention as the broker settings above.
class TelegramSettings(BaseSettings):
    """Telegram bot credentials (env-prefixed TELEGRAM_).

    `bot_token` comes from @BotFather (`/newbot`)."""

    model_config = SettingsConfigDict(
        env_prefix="TELEGRAM_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    bot_token: str = ""


telegram_settings = TelegramSettings()


# In-app AI assistant (api/routers/assistant.py). The key comes from the
# claude-gateway client file on a dev Mac, or ASSISTANT_API_KEY on a server.
# Absent key = feature hidden (status reports configured: false), same
# "half-configured never shows a dead entry" convention as Telegram above.
DEFAULT_ASSISTANT_BASE_URL = "https://claude.rahkar.pro"


@dataclass(frozen=True)
class AssistantConfig:
    api_key: str
    base_url: str
    model: str
    # ASSISTANT_DISABLED: also wins over a key saved from /admin.
    disabled: bool = False

    @property
    def configured(self) -> bool:
        return bool(self.api_key)


class AssistantSettings(BaseSettings):
    """Assistant proxy settings (env-prefixed ASSISTANT_)."""

    model_config = SettingsConfigDict(
        env_prefix="ASSISTANT_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    api_key: str = ""
    base_url: str = ""
    key_file: str = "~/.config/claude-gateway/client.json"
    disabled: str = ""
    model: str = "claude-opus-5-5"

    def resolved(self) -> AssistantConfig:
        file_key, file_url = "", ""
        try:
            with open(os.path.expanduser(self.key_file), encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data, dict):
                file_key = str(data.get("key") or "")
                file_url = str(data.get("url") or "")
        except (OSError, ValueError):
            pass
        key = "" if self.disabled else (self.api_key or file_key)
        url = (self.base_url or file_url or DEFAULT_ASSISTANT_BASE_URL).rstrip("/")
        return AssistantConfig(
            api_key=key, base_url=url, model=self.model, disabled=bool(self.disabled)
        )


assistant_settings = AssistantSettings()
