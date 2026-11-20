# Symbol search categories

The category chips in the symbol-search modal are declared by the broker, not by
the frontend: each data broker sets `CATEGORIES` (`brokers/base.py`) as
`[{key, label, types, row}]` over the `type` values IT stamps on its own market
rows, and `registry.describe()` ships them to the frontend under `categories` in
`GET /api/brokers`. Capital/IG/MT5 use Capital's instrumentType words
(`SHARES`, `CURRENCIES`, ...); yfinance and dukascopy use their own
(`stock`, `etf`, `fx`, `metal`, ...). `row` is the muted phrase on each result
row, so Yahoo rows read "etf" rather than "etf cfd". A broker that
declares nothing shows Recent/Favorites/All only, never a dead chip. `tests/test_market_categories.py` asserts every type an
offline catalogue emits is claimed by one of that broker's own chips.
