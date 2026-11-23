"""SL/TP move rules: the executor that watches alert fires and moves a level.
Stub for now: the router already calls `on_alert_changed`, the real executor
replaces this class."""
from __future__ import annotations


class MoveRules:
    def on_alert_changed(self, user_id: str, row: dict | None, alert_id: str) -> None:
        return None


MOVE_RULES = MoveRules()
