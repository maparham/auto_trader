from auto_trader.brokers.capital import CapitalComBroker, CapitalExecutionBroker


def _exec(base_url: str) -> CapitalExecutionBroker:
    broker = CapitalComBroker(
        api_key="k", identifier="i", password="p", base_url=base_url
    )
    return CapitalExecutionBroker(broker)


def test_demo_host_executor_is_demo_and_not_real_money():
    ex = _exec("https://demo-api-capital.backend-capital.com")
    assert ex.env == "demo"
    assert ex.is_real_money is False


def test_live_host_executor_is_live_and_real_money():
    ex = _exec("https://api-capital.backend-capital.com")
    assert ex.env == "live"
    assert ex.is_real_money is True
