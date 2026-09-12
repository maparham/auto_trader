"""Impersonation: resolve_impersonation plus the HTTP middleware call site."""
from __future__ import annotations

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from auto_trader.api.auth import (
    ADMIN_EMAILS_ENV,
    IMPERSONATE_HEADER,
    ImpersonationError,
    install_auth,
    resolve_impersonation,
)
from tests import clerk_fake

ADMIN_EMAIL = "boss@example.com"
ADMIN_CLAIMS = {"sub": "user_admin", "email": ADMIN_EMAIL}
PLAIN_CLAIMS = {"sub": "user_plain", "email": "nobody@example.com"}


@pytest.fixture
def clerk(monkeypatch):
    clerk_fake.install(monkeypatch)
    monkeypatch.setenv(ADMIN_EMAILS_ENV, ADMIN_EMAIL)


def test_no_target_is_unchanged(clerk):
    assert resolve_impersonation(ADMIN_CLAIMS, "", "GET") == ("user_admin", True, None)


def test_admin_with_target_swaps_and_drops_admin(clerk):
    assert resolve_impersonation(ADMIN_CLAIMS, "user_target", "GET") == (
        "user_target",
        False,
        "user_admin",
    )


def test_non_admin_with_target_raises(clerk):
    with pytest.raises(ImpersonationError) as exc:
        resolve_impersonation(PLAIN_CLAIMS, "user_target", "GET")
    assert exc.value.message == "impersonation requires admin access"


def test_write_method_raises(clerk):
    with pytest.raises(ImpersonationError) as exc:
        resolve_impersonation(ADMIN_CLAIMS, "user_target", "POST")
    assert exc.value.message == "impersonation is read-only"


def test_head_is_allowed(clerk):
    assert resolve_impersonation(ADMIN_CLAIMS, "user_target", "HEAD")[0] == "user_target"


def probe_app() -> TestClient:
    app = FastAPI()
    install_auth(app)

    @app.get("/api/whoami")
    def whoami(request: Request) -> dict:
        return {
            "user_id": request.state.user_id,
            "is_admin": request.state.is_admin,
            "impersonator": request.state.impersonator,
        }

    @app.post("/api/write")
    def write(request: Request) -> dict:
        return {"user_id": request.state.user_id}

    # On the demo allowlist (see demo_access.py's _EXACT), so a signed-out
    # request can reach it without a bearer token.
    @app.get("/api/candles")
    def candles(request: Request) -> dict:
        return {
            "user_id": request.state.user_id,
            "is_admin": request.state.is_admin,
            "impersonator": request.state.impersonator,
        }

    return TestClient(app)


def admin_token() -> str:
    return clerk_fake.make_token(sub="user_admin", extra={"email": ADMIN_EMAIL})


def plain_token() -> str:
    return clerk_fake.make_token(sub="user_plain")


def test_admin_router_refuses_an_impersonating_session(clerk):
    # probe_app() mounts a bare FastAPI app with no admin router, so it can
    # never exercise deps.require_admin_console. This is the backstop the
    # spec names: is_admin is forced False while impersonating, which is why
    # the exit control had to be pure client state, and it's what stops an
    # impersonating session from enumerating users via /api/admin/*. Run it
    # against the real app so the router is actually in the graph.
    from fastapi.testclient import TestClient

    from auto_trader.api.app import app

    r = TestClient(app).get(
        "/api/admin/whoami",
        headers={
            "Authorization": f"Bearer {admin_token()}",
            IMPERSONATE_HEADER: "user_target",
        },
    )
    assert r.status_code == 403
    assert r.json()["detail"] == "admin access required"


def test_middleware_admin_impersonates(clerk):
    r = probe_app().get(
        "/api/whoami",
        headers={
            "Authorization": f"Bearer {admin_token()}",
            IMPERSONATE_HEADER: "user_target",
        },
    )
    assert r.status_code == 200
    assert r.json() == {
        "user_id": "user_target",
        "is_admin": False,
        "impersonator": "user_admin",
    }


def test_middleware_without_header_is_untouched(clerk):
    r = probe_app().get(
        "/api/whoami", headers={"Authorization": f"Bearer {admin_token()}"}
    )
    assert r.json() == {
        "user_id": "user_admin",
        "is_admin": True,
        "impersonator": None,
    }


def test_middleware_non_admin_403(clerk):
    r = probe_app().get(
        "/api/whoami",
        headers={
            "Authorization": f"Bearer {plain_token()}",
            IMPERSONATE_HEADER: "user_target",
        },
    )
    assert r.status_code == 403
    assert r.json()["detail"] == "impersonation requires admin access"


def test_middleware_write_403(clerk):
    r = probe_app().post(
        "/api/write",
        headers={
            "Authorization": f"Bearer {admin_token()}",
            IMPERSONATE_HEADER: "user_target",
        },
    )
    assert r.status_code == 403
    assert r.json()["detail"] == "impersonation is read-only"


def test_dev_mode_ignores_the_header(monkeypatch):
    from auto_trader.api.auth import JWKS_URL_ENV

    monkeypatch.delenv(JWKS_URL_ENV, raising=False)
    r = probe_app().get("/api/whoami", headers={IMPERSONATE_HEADER: "user_target"})
    assert r.json() == {"user_id": "dev", "is_admin": True, "impersonator": None}


def test_render_token_rejects_the_header(clerk):
    from auto_trader.api.auth import mint_render_token

    tok = mint_render_token("user_rendered")
    r = probe_app().get(
        "/api/whoami",
        headers={
            "Authorization": f"Bearer {tok}",
            IMPERSONATE_HEADER: "user_target",
        },
    )
    assert r.status_code == 403
    assert r.json()["detail"] == "impersonation requires admin access"


def test_render_token_without_the_header_still_works(clerk):
    from auto_trader.api.auth import mint_render_token

    tok = mint_render_token("user_rendered")
    r = probe_app().get("/api/whoami", headers={"Authorization": f"Bearer {tok}"})
    assert r.json() == {
        "user_id": "user_rendered",
        "is_admin": False,
        "impersonator": None,
    }


def test_demo_without_the_header_still_works(clerk):
    r = probe_app().get("/api/candles")
    assert r.status_code == 200
    assert r.json() == {
        "user_id": "demo",
        "is_admin": False,
        "impersonator": None,
    }


def test_demo_rejects_the_header(clerk):
    r = probe_app().get("/api/candles", headers={IMPERSONATE_HEADER: "user_target"})
    assert r.status_code == 403
    assert r.json()["detail"] == "impersonation requires admin access"


def test_middleware_logs_the_session(clerk, caplog):
    import logging

    from auto_trader.core import impersonation_audit

    impersonation_audit.reset()
    with caplog.at_level(logging.INFO, logger="auto_trader.impersonation"):
        probe_app().get(
            "/api/whoami",
            headers={
                "Authorization": f"Bearer {admin_token()}",
                IMPERSONATE_HEADER: "user_target",
            },
        )
    assert "impersonation active" in caplog.text
    impersonation_audit.reset()


def test_middleware_logs_a_refusal(clerk, caplog):
    import logging

    with caplog.at_level(logging.WARNING, logger="auto_trader.impersonation"):
        probe_app().get(
            "/api/whoami",
            headers={
                "Authorization": f"Bearer {plain_token()}",
                IMPERSONATE_HEADER: "user_target",
            },
        )
    assert "impersonation refused" in caplog.text


def test_a_long_header_value_is_truncated_in_the_logged_refusal(clerk, caplog):
    # The demo branch is reachable with no credential at all, ahead of the
    # rate limiter: an anonymous caller must not be able to flood stdout by
    # sending an arbitrarily long X-Impersonate-User value.
    import logging

    from auto_trader.core.impersonation_audit import MAX_LOGGED_VALUE_LEN

    long_value = "x" * 10_000
    with caplog.at_level(logging.WARNING, logger="auto_trader.impersonation"):
        probe_app().get("/api/candles", headers={IMPERSONATE_HEADER: long_value})
    assert "impersonation refused" in caplog.text
    for record in caplog.records:
        assert len(record.message) < MAX_LOGGED_VALUE_LEN + 200
