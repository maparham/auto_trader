"""Unit tests for the oanor IRR data-only broker. All network calls are mocked."""

import asyncio
from datetime import datetime, timezone

import httpx
import pytest

from auto_trader.core.models import Resolution


def test_oanor_settings_gate():
    from auto_trader.config import OanorSettings

    assert OanorSettings(api_key="", _env_file=None).has() is False
    s = OanorSettings(api_key="oanor_live_xyz", _env_file=None)
    assert s.has() is True
    assert s.base_url == "https://api.oanor.com/irr-api"
