"""Shared Clerk-JWT test doubles: a local RSA keypair, a fake JWKS client,
and a token mint. Used by the auth unit tests and the WS auth tests."""
from __future__ import annotations

import time

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa

KID = "test-kid"
JWKS_URL = "https://clerk.example/.well-known/jwks.json"
PARTY = "http://localhost:5173"

_PRIVATE = rsa.generate_private_key(public_exponent=65537, key_size=2048)


class _FakeKey:
    def __init__(self, key):
        self.key = key


class FakeJWKClient:
    """Stands in for auth._jwk_client: serves the local public key for KID,
    raises like PyJWKClient for any other kid."""

    def get_signing_key_from_jwt(self, token: str):
        kid = jwt.get_unverified_header(token).get("kid")
        if kid != KID:
            raise jwt.exceptions.PyJWKClientError(f"unknown kid: {kid}")
        return _FakeKey(_PRIVATE.public_key())


def make_token(
    *,
    sub: str | None = "user_123",
    azp: str | None = PARTY,
    exp_delta: int = 60,
    kid: str = KID,
    key=None,
) -> str:
    claims: dict = {"exp": int(time.time()) + exp_delta}
    if sub is not None:
        claims["sub"] = sub
    if azp is not None:
        claims["azp"] = azp
    return jwt.encode(claims, key or _PRIVATE, algorithm="RS256", headers={"kid": kid})


def install(monkeypatch) -> None:
    """Point auth at the fake: hosted mode ON, fake JWKS client wired in."""
    from auto_trader.api import auth

    monkeypatch.setenv(auth.JWKS_URL_ENV, JWKS_URL)
    monkeypatch.setenv(auth.AUTHORIZED_PARTIES_ENV, PARTY)
    monkeypatch.setattr(auth, "_jwk_client", FakeJWKClient())
    monkeypatch.setattr(auth, "_jwk_client_url", JWKS_URL)
