from auto_trader.api.demo_access import DEMO_USER_ID, demo_path_allowed


def test_allowed_get_paths():
    for path in [
        "/api/candles",
        "/api/candles/synthetic",
        "/api/markets",
        "/api/markets/all",
        "/api/market/US100",
        "/api/market/US100/details",
        "/api/brokers",
        "/api/demo/snapshot",
    ]:
        assert demo_path_allowed("GET", path), path


def test_writes_never_allowed():
    assert not demo_path_allowed("POST", "/api/candles")
    assert not demo_path_allowed("PUT", "/api/state/auto-trader.tabs")
    assert not demo_path_allowed("POST", "/api/demo/snapshot")


def test_pattern_search_posts_allowed():
    assert demo_path_allowed("POST", "/api/patterns/search")
    assert demo_path_allowed("POST", "/api/patterns/scan")
    assert demo_path_allowed("GET", "/api/patterns/families")
    assert demo_path_allowed("GET", "/api/patterns/presets")


def test_preset_writes_never_allowed():
    assert not demo_path_allowed("POST", "/api/patterns/presets")
    assert not demo_path_allowed("PATCH", "/api/patterns/presets/p1")
    assert not demo_path_allowed("DELETE", "/api/patterns/presets/p1")


def test_sensitive_paths_never_allowed():
    for path in [
        "/api/state",
        "/api/alerts",
        "/api/backtest",
        "/api/admin/usage",
        "/api/admin/demo/publish",
        "/api/favorites",
        "/api/positions",
    ]:
        assert not demo_path_allowed("GET", path), path


def test_demo_user_id():
    assert DEMO_USER_ID == "demo"
