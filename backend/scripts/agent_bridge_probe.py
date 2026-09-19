"""Thin wrapper: the probe lives in the agent_ui_bridge package now.

    cd backend && python3 -m agent_ui_bridge.probe --read-state backtest.config.get
"""
from agent_ui_bridge.probe import cli

if __name__ == "__main__":
    cli()
