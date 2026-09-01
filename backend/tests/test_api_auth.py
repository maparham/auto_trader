"""auth.verify_token against a locally-generated RSA keypair and fake JWKS."""
from __future__ import annotations

import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

from auto_trader.api import auth
from tests import clerk_fake


@pytest.fixture
def clerk(monkeypatch):
    clerk_fake.install(monkeypatch)


def test_valid_token_returns_sub(clerk):
    assert auth.verify_token(clerk_fake.make_token()) == "user_123"


def test_expired_token_rejected(clerk):
    with pytest.raises(auth.AuthError):
        auth.verify_token(clerk_fake.make_token(exp_delta=-60))


def test_wrong_signature_rejected(clerk):
    other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    with pytest.raises(auth.AuthError):
        auth.verify_token(clerk_fake.make_token(key=other))


def test_unknown_kid_rejected(clerk):
    with pytest.raises(auth.AuthError):
        auth.verify_token(clerk_fake.make_token(kid="other-kid"))


def test_wrong_azp_rejected(clerk):
    with pytest.raises(auth.AuthError):
        auth.verify_token(clerk_fake.make_token(azp="https://evil.example"))


def test_azp_unchecked_when_parties_unset(clerk, monkeypatch):
    monkeypatch.delenv(auth.AUTHORIZED_PARTIES_ENV)
    assert auth.verify_token(clerk_fake.make_token(azp=None)) == "user_123"


def test_missing_sub_rejected(clerk):
    with pytest.raises(auth.AuthError):
        auth.verify_token(clerk_fake.make_token(sub=None))


def test_garbage_token_rejected(clerk):
    with pytest.raises(auth.AuthError):
        auth.verify_token("not-a-jwt")


def test_auth_enabled_tracks_env(clerk, monkeypatch):
    assert auth.auth_enabled() is True
    monkeypatch.delenv(auth.JWKS_URL_ENV)
    assert auth.auth_enabled() is False
