"""Chartkar's relay hub instance for the Agent UI Bridge.

The hub itself (request/reply futures, handle store, session routing) lives in
the agent_ui_bridge package. This module keeps the import path the routers and
mcp_server already use, and owns the single process-wide instance. The ui_*
MCP tools bind to this HUB at registration time (module import), so a test
that wants to see through them exercises this HUB directly (register/
unregister a fake session) rather than swapping out the module's reference.
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
