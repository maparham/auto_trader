from auto_trader.api.schemas import RecurrenceMaskDTO


def test_exclude_dates_round_trips_through_to_mask():
    dto = RecurrenceMaskDTO(enabled=True, excludeDates=["2024-01-02", "2024-12-25"])
    mask = dto.to_mask()
    assert mask.exclude_dates == frozenset({"2024-01-02", "2024-12-25"})


def test_exclude_dates_defaults_empty():
    assert RecurrenceMaskDTO(enabled=True).to_mask().exclude_dates == frozenset()
