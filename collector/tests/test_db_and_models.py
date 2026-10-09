from __future__ import annotations

from datetime import UTC, datetime, timedelta

from trichq import repo
from trichq.db import _from_value, _to_value, split_sql
from trichq.models import booking_link, fare_from_tp, fare_key

from .conftest import make_fare

# Shared vector: worker/test/fares.test.ts asserts the very same key.
FARE_KEY_VECTOR = ("EVN", "AYT", "2026-11-13", "2026-11-17", "PC", "781")
FARE_KEY_DIGEST = "EVN|AYT|2026-11-13|2026-11-17|PC|781"


def test_fare_key_is_stable_and_matches_worker() -> None:
    k = fare_key(*FARE_KEY_VECTOR)
    assert k == FARE_KEY_DIGEST
    assert fare_key("EVN", "AYT", "2026-11-13", None, None, None) != k


def test_split_sql_keeps_triggers_whole() -> None:
    script = """
    CREATE TABLE a (x INT); -- comment
    CREATE TRIGGER t AFTER INSERT ON a
    BEGIN
      INSERT INTO a VALUES (1);
    END;
    CREATE INDEX i ON a (x);
    """
    parts = split_sql(script)
    assert len(parts) == 3
    assert parts[1].startswith("CREATE TRIGGER") and parts[1].endswith("END")


def test_turso_value_roundtrip() -> None:
    for v in (None, 1, 2.5, "Երևան"):
        assert _from_value(_to_value(v)) == v
    assert _to_value(True) == {"type": "integer", "value": "1"}


def test_fare_from_tp_parses_and_rejects() -> None:
    item = {
        "origin": "EVN",
        "destination": "AYT",
        "price": 138,
        "airline": "PC",
        "flight_number": 781,
        "departure_at": "2026-11-13T06:40:00+04:00",
        "return_at": "2026-11-17T21:10:00+03:00",
        "transfers": 1,
        "return_transfers": 1,
        "duration": 340,
        "link": "/search/EVN1311AYT17111?t=abc",
    }
    f = fare_from_tp(item, market="ru", marker="12345")
    assert f is not None
    assert (f.dep_date, f.ret_date, f.price_usd, f.flight_number) == ("2026-11-13", "2026-11-17", 138.0, "781")
    assert f.link == "https://www.aviasales.com/search/EVN1311AYT17111?t=abc&marker=12345"
    assert f.nights == 4
    assert fare_from_tp({**item, "price": 0}, market=None) is None
    assert fare_from_tp({**item, "destination": "EVN"}, market=None) is None
    assert fare_from_tp({"origin": "EVN"}, market=None) is None
    assert fare_from_tp({**item, "departure_at": "garbage"}, market=None) is None


def test_booking_link_variants() -> None:
    assert booking_link(None) is None
    assert booking_link("/search/X") == "https://www.aviasales.com/search/X"
    assert booking_link("/search/X?marker=1", "2") == "https://www.aviasales.com/search/X?marker=1"


async def test_history_is_change_only(db) -> None:
    t0 = datetime(2030, 1, 1, tzinfo=UTC)
    f = make_fare(price_usd=150)
    await repo.upsert_fares(db, [f], now=t0)
    await repo.upsert_fares(db, [f], now=t0 + timedelta(hours=1))  # same price: no new row
    await repo.upsert_fares(db, [make_fare(price_usd=120)], now=t0 + timedelta(hours=2))
    obs = await db.query("SELECT price_usd, observed_at FROM fare_observations ORDER BY id")
    assert [o["price_usd"] for o in obs] == [150, 120]
    cur = await db.query("SELECT price_usd, first_seen_at, updated_at FROM fares_current")
    assert cur == [{"price_usd": 120, "first_seen_at": "2030-01-01T00:00:00Z", "updated_at": "2030-01-01T02:00:00Z"}]


async def test_upsert_keeps_cheapest_duplicate(db) -> None:
    n = await repo.upsert_fares(db, [make_fare(price_usd=200, market="ru"), make_fare(price_usd=180, market="ge")])
    assert n == 1
    rows = await db.query("SELECT price_usd, market FROM fares_current")
    assert rows == [{"price_usd": 180, "market": "ge"}]


async def test_migrations_are_idempotent(db) -> None:
    from trichq import migrate

    from .conftest import MIGRATIONS

    assert await migrate.run(db, MIGRATIONS) == []
