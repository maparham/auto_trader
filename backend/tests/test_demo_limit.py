from auto_trader.api import demo_limit
from auto_trader.api.demo_limit import client_key, demo_rate_ok


def setup_function(_):
    demo_limit._buckets.clear()


class _FakeClient:
    def __init__(self, host):
        self.host = host


class _FakeRequest:
    def __init__(self, peer_host, headers=None):
        self.client = _FakeClient(peer_host) if peer_host else None
        self.headers = headers or {}


def test_client_key_ignores_header_when_flag_unset(monkeypatch):
    monkeypatch.delenv(demo_limit.TRUST_PROXY_IP_ENV, raising=False)
    req = _FakeRequest("10.0.0.1", {"CF-Connecting-IP": "1.2.3.4"})
    assert client_key(req) == "10.0.0.1"


def test_client_key_uses_header_when_flag_set(monkeypatch):
    monkeypatch.setenv(demo_limit.TRUST_PROXY_IP_ENV, "1")
    req = _FakeRequest("10.0.0.1", {"CF-Connecting-IP": "1.2.3.4"})
    assert client_key(req) == "1.2.3.4"


def test_client_key_falls_back_when_flag_set_and_header_missing(monkeypatch):
    monkeypatch.setenv(demo_limit.TRUST_PROXY_IP_ENV, "1")
    req = _FakeRequest("10.0.0.1", {})
    assert client_key(req) == "10.0.0.1"


def test_cfg_clamps_garbage_env(monkeypatch):
    monkeypatch.setenv("DEMO_RATE_PER_MIN", "not-a-number")
    monkeypatch.setenv("DEMO_RATE_BURST", "also-garbage")
    rate, burst = demo_limit._cfg()
    assert rate == demo_limit._DEFAULT_PER_MIN / 60.0
    assert burst == demo_limit._DEFAULT_BURST


def test_burst_then_throttle(monkeypatch):
    monkeypatch.setenv("DEMO_RATE_PER_MIN", "60")
    monkeypatch.setenv("DEMO_RATE_BURST", "5")
    t = 1000.0
    assert all(demo_rate_ok("1.2.3.4", now=t) for _ in range(5))
    assert not demo_rate_ok("1.2.3.4", now=t)


def test_refills_over_time(monkeypatch):
    monkeypatch.setenv("DEMO_RATE_PER_MIN", "60")  # 1 token/sec
    monkeypatch.setenv("DEMO_RATE_BURST", "1")
    assert demo_rate_ok("5.6.7.8", now=1000.0)
    assert not demo_rate_ok("5.6.7.8", now=1000.1)
    assert demo_rate_ok("5.6.7.8", now=1001.5)


def test_ips_are_independent(monkeypatch):
    monkeypatch.setenv("DEMO_RATE_BURST", "1")
    assert demo_rate_ok("a", now=0.0)
    assert demo_rate_ok("b", now=0.0)
