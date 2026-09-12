"""The impersonation audit trail: a start line, a throttled summary, and an
unthrottled warning for every refused attempt."""
from __future__ import annotations

import logging

import pytest

from auto_trader.core import impersonation_audit as audit


@pytest.fixture(autouse=True)
def clean():
    audit.reset()
    yield
    audit.reset()


def test_start_logs_at_info(caplog):
    with caplog.at_level(logging.INFO, logger="auto_trader.impersonation"):
        audit.log_start("user_admin", "user_target")
    assert "impersonation start" in caplog.text
    assert "user_admin" in caplog.text
    assert "user_target" in caplog.text


def test_rejection_logs_at_warning(caplog):
    with caplog.at_level(logging.WARNING, logger="auto_trader.impersonation"):
        audit.log_rejected("not admin", "user_plain", "user_target")
    assert caplog.records[0].levelno == logging.WARNING
    assert "user_plain" in caplog.text


def test_requests_are_throttled_to_one_line_per_window(caplog):
    with caplog.at_level(logging.INFO, logger="auto_trader.impersonation"):
        for i in range(50):
            audit.log_request("user_admin", "user_target", f"/api/alerts?{i}", now=1000.0)
    assert len(caplog.records) == 1


def test_a_new_window_logs_again_with_the_count(caplog):
    with caplog.at_level(logging.INFO, logger="auto_trader.impersonation"):
        for i in range(5):
            audit.log_request("user_admin", "user_target", "/api/alerts", now=1000.0)
        audit.log_request("user_admin", "user_target", "/api/alerts", now=1000.0 + 61)
    assert len(caplog.records) == 2
    assert "6 requests" in caplog.records[1].message


def test_separate_pairs_throttle_separately(caplog):
    with caplog.at_level(logging.INFO, logger="auto_trader.impersonation"):
        audit.log_request("user_admin", "user_a", "/api/alerts", now=1000.0)
        audit.log_request("user_admin", "user_b", "/api/alerts", now=1000.0)
    assert len(caplog.records) == 2


def test_a_long_target_id_is_truncated_in_the_active_line(caplog):
    # target_id here is resolve_impersonation's resolved user id, which
    # ultimately comes from an admin-supplied X-Impersonate-User header/
    # impersonate param with no length limit of its own. Every other call
    # site in this module truncates untrusted input to MAX_LOGGED_VALUE_LEN;
    # this asserts log_request holds the same invariant.
    long_target = "x" * 10_000
    with caplog.at_level(logging.INFO, logger="auto_trader.impersonation"):
        audit.log_request("user_admin", long_target, "/api/alerts", now=1000.0)
    assert len(caplog.records) == 1
    for record in caplog.records:
        assert len(record.message) < audit.MAX_LOGGED_VALUE_LEN + 200
