"""is_admin_claims env matching + middleware/verify_ws is_admin stamping."""
import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from auto_trader.api import auth
from auto_trader.api.auth import (
    ADMIN_EMAILS_ENV, ADMIN_USER_IDS_ENV, install_auth, is_admin_claims,
)
from tests import clerk_fake


@pytest.fixture
def clerk(monkeypatch):
    clerk_fake.install(monkeypatch)
    return monkeypatch


def test_no_admin_env_means_not_admin(monkeypatch):
    monkeypatch.delenv(ADMIN_EMAILS_ENV, raising=False)
    monkeypatch.delenv(ADMIN_USER_IDS_ENV, raising=False)
    assert not is_admin_claims({"sub": "user_1", "email": "a@b.c"})


def test_email_match_case_insensitive(monkeypatch):
    monkeypatch.setenv(ADMIN_EMAILS_ENV, "Admin@Example.COM, other@x.y")
    assert is_admin_claims({"sub": "u", "email": "admin@example.com"})
    assert not is_admin_claims({"sub": "u", "email": "someone@example.com"})
    assert not is_admin_claims({"sub": "u"})  # missing claim -> not admin


def test_user_id_match(monkeypatch):
    monkeypatch.setenv(ADMIN_USER_IDS_ENV, "user_abc,user_def")
    assert is_admin_claims({"sub": "user_abc"})
    assert not is_admin_claims({"sub": "user_zzz"})


def _app():
    app = FastAPI()
    install_auth(app)

    @app.get("/whoami")
    async def whoami(request: Request):
        return {"user": request.state.user_id, "admin": request.state.is_admin}

    return app


def test_dev_mode_is_admin(monkeypatch):
    monkeypatch.delenv(auth.JWKS_URL_ENV, raising=False)
    r = TestClient(_app()).get("/whoami")
    assert r.json() == {"user": "dev", "admin": True}


def test_hosted_non_admin_stamped_false(clerk):
    tok = clerk_fake.make_token(sub="user_1", extra={"email": "x@y.z"})
    r = TestClient(_app()).get("/whoami", headers={"Authorization": f"Bearer {tok}"})
    assert r.json() == {"user": "user_1", "admin": False}


def test_hosted_admin_by_email(clerk):
    clerk.setenv(ADMIN_EMAILS_ENV, "boss@example.com")
    tok = clerk_fake.make_token(sub="user_1", extra={"email": "Boss@Example.com"})
    r = TestClient(_app()).get("/whoami", headers={"Authorization": f"Bearer {tok}"})
    assert r.json() == {"user": "user_1", "admin": True}


def test_hosted_admin_by_user_id(clerk):
    clerk.setenv(ADMIN_USER_IDS_ENV, "user_1")
    tok = clerk_fake.make_token(sub="user_1")
    r = TestClient(_app()).get("/whoami", headers={"Authorization": f"Bearer {tok}"})
    assert r.json()["admin"] is True
