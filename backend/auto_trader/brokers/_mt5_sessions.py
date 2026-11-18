"""Weekly trade sessions for the mt5-self broker.

The terminal's MCP server has no sessions tool, so the sessions come from an
MQL5 script (`mql5/ChartkarSessions.mq5`, compiled on the box by
scripts/deploy-demo.sh) that dumps every symbol's `SymbolInfoSessionTrade` to
MQL5/Files/chartkar_sessions.json. This module runs the script through MCP
(`chart_add_script` on any open chart), reads the file back, and turns each
symbol's sessions into the Capital-style `openingHours` dict (zone UTC) that
`_market_hours_state` already understands.

Sessions are a weekly schedule: they know nothing of holidays, so a holiday
still reads as open and the order is refused by the server as before.
Any failure (script missing, no chart, stale file) leaves the hours unknown,
which callers treat as open.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, Awaitable, Callable

log = logging.getLogger(__name__)

_MQL5 = r"C:\Program Files\MetaTrader 5\MQL5"
SCRIPT_PATH = _MQL5 + r"\Scripts\Chartkar\ChartkarSessions.ex5"
OUTPUT_PATH = _MQL5 + r"\Files\chartkar_sessions.json"

# Sessions change rarely (a broker schedule edit, a DST move of the server).
REFRESH_S = 6 * 3600.0
# After a failure, try again this much later rather than on every request.
RETRY_S = 600.0
# How long to wait for the script to write a fresh file.
WAIT_S = 20.0
_POLL_S = 1.0
# The file's own clock may lag ours a little (it is the box's clock either way).
_CLOCK_SLACK_S = 60.0

# Sunday-first, as MQL5's ENUM_DAY_OF_WEEK.
_DAYS = ("sun", "mon", "tue", "wed", "thu", "fri", "sat")

Call = Callable[..., Awaitable[Any]]


def _hhmm(sec: int) -> str:
    sec %= 86400
    return f"{sec // 3600:02d}:{sec % 3600 // 60:02d}"


def to_opening_hours(days: Any, server_offset_s: int) -> dict | None:
    """One symbol's script row ([[ [from, to], ... ] x 7, Sunday first, seconds
    into the day in SERVER time]) -> {"mon": ["HH:MM - HH:MM", ...], ...,
    "zone": "UTC"}. None when the row is malformed or has no session at all
    (a symbol with no sessions is not a market closed all week: unknown)."""
    if not isinstance(days, list) or len(days) != 7:
        return None
    out: dict[str, list[str]] = {d: [] for d in _DAYS}
    week = 7 * 86400
    any_session = False
    for di, sessions in enumerate(days):
        if not isinstance(sessions, list):
            return None
        for s in sessions:
            if not (isinstance(s, list) and len(s) == 2):
                return None
            start, end = int(s[0]), int(s[1])
            if end <= start:
                continue
            any_session = True
            # Absolute seconds into the week, in UTC, then split at each UTC
            # midnight so every stored window is same-day.
            a = (di * 86400 + start - server_offset_s) % week
            b = a + (end - start)
            while a < b:
                day_end = (a // 86400 + 1) * 86400
                cut = min(b, day_end)
                day = _DAYS[(a // 86400) % 7]
                # An end on midnight is written "00:00", which the parser
                # reads as end of day.
                out[day].append(f"{_hhmm(a)} - {_hhmm(cut)}")
                a = cut
    if not any_session:
        return None
    return {**out, "zone": "UTC"}


class MT5Sessions:
    def __init__(self, call: Call, *, clock: Callable[[], float] = time.monotonic,
                 wall: Callable[[], float] = time.time,
                 sleep: Callable[[float], Awaitable[None]] = asyncio.sleep) -> None:
        self._call = call
        self._clock = clock
        self._wall = wall
        self._sleep = sleep
        self._hours: dict[str, dict] | None = None
        self._next_at = 0.0
        self._task: asyncio.Task | None = None
        self._warned = False

    def opening_hours(self, epic: str) -> dict | None:
        """The symbol's opening hours (Capital shape, zone UTC), or None when
        unknown. Never waits: a due refresh runs in the background (running
        the script takes seconds), and this answers from the last good load."""
        self.ensure_fresh()
        return (self._hours or {}).get(epic)

    def ensure_fresh(self) -> None:
        if self._clock() < self._next_at or (self._task is not None and not self._task.done()):
            return
        try:
            self._task = asyncio.get_running_loop().create_task(self._refresh())
        except RuntimeError:
            pass  # no loop (sync caller in a test): stay unknown

    async def aclose(self) -> None:
        if self._task is not None:
            self._task.cancel()
            self._task = None

    async def _refresh(self) -> None:
        try:
            data = await self._run_script()
            symbols = data.get("symbols")
            offset = int(data.get("serverOffset") or 0)
            if not isinstance(symbols, dict):
                raise ValueError("no symbols in the sessions file")
            hours = {}
            for name, days in symbols.items():
                oh = to_opening_hours(days, offset)
                if oh is not None:
                    hours[name] = oh
            self._hours = hours
            self._next_at = self._clock() + REFRESH_S
            self._warned = False
            log.info("mt5-self: trade sessions loaded for %d symbols", len(hours))
        except Exception as exc:
            # Keep the last good hours; a failed refresh only delays the next.
            self._next_at = self._clock() + RETRY_S
            level = logging.DEBUG if self._warned else logging.WARNING
            self._warned = True
            log.log(level, "mt5-self: trade sessions unavailable (%s)", exc)

    async def _run_script(self) -> dict:
        started = self._wall()
        charts = await self._call("list_open_charts", {})
        rows = charts.get("charts") if isinstance(charts, dict) else None
        opened: str | None = None
        if rows:
            chart_id = str(rows[0]["chart_id"])
        else:
            # A script needs a chart to run on; open one and close it after.
            res = await self._call("chart_open", {"symbol": "EURUSD", "period": "D1"})
            chart_id = opened = str(res.get("chart_id"))
        try:
            await self._call("chart_add_script", {"chart_id": chart_id, "script_path": SCRIPT_PATH})
            deadline = self._clock() + WAIT_S
            while True:
                data = await self._read()
                if data is not None and float(data.get("generated") or 0) >= started - _CLOCK_SLACK_S:
                    return data
                if self._clock() >= deadline:
                    raise TimeoutError("the sessions script wrote no fresh file")
                await self._sleep(_POLL_S)
        finally:
            if opened is not None:
                try:
                    await self._call("chart_close", {"chart_id": opened})
                except Exception:
                    log.debug("mt5-self: closing the sessions chart failed", exc_info=True)

    async def _read(self) -> dict | None:
        try:
            data = await self._call("read_file", {"path": OUTPUT_PATH})
        except Exception:
            return None  # not written yet
        if isinstance(data, str):
            try:
                data = json.loads(data)
            except ValueError:
                return None
        return data if isinstance(data, dict) else None
