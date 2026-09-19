"""Chartkar's relay hub instance for the Agent UI Bridge.

The hub itself (request/reply futures, handle store, session routing) lives in
the agent_ui_bridge package. This module keeps the import path the routers and
mcp_server already use, and owns the single process-wide instance. Tests that
want a clean hub monkeypatch the consumer's reference, not this one.
"""
from __future__ import annotations

from agent_ui_bridge.hub import (
    ActionFailedError,
    BridgeHub,
    NoTabError,
    TabTimeoutError,
)

__all__ = ["HUB", "BridgeHub", "NoTabError", "TabTimeoutError", "ActionFailedError"]

HUB = BridgeHub()
