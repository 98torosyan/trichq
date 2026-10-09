from __future__ import annotations

import random
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

import httpx
import respx

from trichq import repo
from trichq.dates import add_months, months_covering
from trichq.db import TursoDB
from trichq.jobs import deals, stats, sweep, watches
from trichq.refdata import CityNames
from trichq.scheduler import Slot, next_runs
from trichq.sources.travelpayouts import TravelpayoutsClient

from .conftest import FakeTP, make_fare

FAR = (date.today() + timedelta(days=40)).isoformat()
FAR_RET = (date.today() + timedelta(days=44)).isoformat()


# --------------------------------------------------------------------------- dates


def test_month_helpers() -> None:
    assert add_months(date(2026, 11, 20), 2) == date(2027, 1, 1)
    assert months_covering(date(2026, 11, 29), date(2026, 12, 2)) == ["2026-11", "2026-12"]


# --------------------------------------------------------------------------- sweep


async def test_sweep_writes_fares_and_records_run(db, settings) -> None:
    tp = FakeTP([make_fare(dep_date=FAR, ret_date=FAR_RET), make_fare(dest="DXB", dep_date=FAR, ret_date=FAR_RET)])
    result = await sweep.run(db, settings, tp)  # type: ignore[arg-type]
    assert result.fares == 2
    # 2 months x 2 return months x 1 market, one page each (fewer than 1000 results)
    assert len(tp.calls) == 4
    assert all(c["one_way"] is False for c in tp.calls)
    run = await repo.last_ok_run(db, "sweep")
    assert run is not None and run["rows_seen"] == 2 and run["status"] == "ok"


async def test_sweep_drops_past_and_overlong_trips(db, settings) -> None:
    past = (date.today() - timedelta(days=1)).isoformat()
    long_ret = (date.today() + timedelta(days=40 + 45)).isoformat()
    tp = FakeTP([make_fare(dep_date=past, ret_date=FAR_RET), make_fare(dep_date=FAR, ret_date=long_ret)])
    result = await sweep.run(db, settings, tp)  # type: ignore[arg-type]
    assert result.fares == 0
    run = await repo.last_ok_run(db, "sweep")
    assert run is not None and run["status"] == "degraded"


# --------------------------------------------------------------------------- stats + deals


async def test_stats_and_cheapest_deals(db, settings) -> None:
    await repo.upsert_fares(
        db,
        [
            make_fare(dest="AYT", price_usd=150, dep_date=FAR, ret_date=FAR_RET),
            make_fare(dest="AYT", price_usd=130, flight_number="9", dep_date=FAR, ret_date=FAR_RET),
            make_fare(dest="DXB", price_usd=210, dep_date=FAR, ret_date=FAR_RET),
        ],
    )
    s = await stats.run(db, settings)
    assert s["routes"] == 2
    row = (await db.query("SELECT * FROM route_daily_stats WHERE dest = 'AYT'"))[0]
    assert (row["min_usd"], row["median_usd"], row["n_fares"]) == (130, 140, 2)

    d = await deals.run(db, settings, tp=None)
    assert d["cheapest"] == 2 and d["drops"] == 0
    feed = await db.query("SELECT dest, price_usd FROM deals WHERE kind = 'cheapest' ORDER BY price_usd")
    assert feed == [{"dest": "AYT", "price_usd": 130}, {"dest": "DXB", "price_usd": 210}]


async def test_drop_needs_a_week_of_history(db, settings) -> None:
    month = FAR[:7]
    for i in range(8):
        day = (date.today() - timedelta(days=i + 1)).isoformat()
        await db.execute("INSERT INTO route_daily_stats VALUES ('EVN', 'AYT', ?, ?, 200, 230, 5)", (month, day))
    await repo.upsert_fares(db, [make_fare(price_usd=150, dep_date=FAR, ret_date=FAR_RET)])
    d = await deals.run(db, settings, tp=None)
    assert d["drops"] == 1
    drop = (await db.query("SELECT * FROM deals WHERE kind = 'drop'"))[0]
    assert drop["ref_usd"] == 200 and drop["pct_below"] == 25


async def test_special_offers_are_stored_once(db, settings) -> None:
    offer = {
        "origin": "EVN",
        "destination": "LCA",
        "departure_at": f"{FAR}T08:00:00+04:00",
        "price": 59,
        "airline": "W6",
        "link": "/search/x",
    }
    tp = FakeTP(specials=[offer])
    await deals.run(db, settings, tp)  # type: ignore[arg-type]
    await deals.run(db, settings, tp)  # type: ignore[arg-type]
    rows = await db.query("SELECT dest, ret_date FROM deals WHERE kind = 'special'")
    assert rows == [{"dest": "LCA", "ret_date": ""}]


# --------------------------------------------------------------------------- watches


def test_should_alert_rules() -> None:
    now = datetime(2030, 1, 1, 12, tzinfo=UTC)
    w = {"target_usd": 150, "last_alert_price_usd": None, "last_alert_at": None}
    assert watches.should_alert(w, 150, now)
    assert not watches.should_alert(w, 151, now)
    w2 = {**w, "last_alert_price_usd": 140, "last_alert_at": "2030-01-01T10:00:00Z"}
    assert not watches.should_alert(w2, 139, now)  # less than 3% cheaper
    assert not watches.should_alert(w2, 133, now)  # 5% cheaper but inside the 6h cooldown
    assert watches.should_alert(w2, 125, now)  # 10%+ cheaper: alert right away
    later = now + timedelta(hours=7)
    assert watches.should_alert(w2, 133, later)


class FakeTG:
    def __init__(self) -> None:
        self.sent: list[tuple[int, str, str | None]] = []

    async def send_message(self, chat_id: int, text: str, **kw) -> int:
        self.sent.append((chat_id, text, kw.get("webapp_url")))
        return len(self.sent)


async def _add_watch(db, target: float, flex: int = 0) -> None:
    await db.execute("INSERT INTO users (tg_id, first_name) VALUES (42, 'Karen')")
    await db.execute(
        "INSERT INTO watches (tg_id, origin, dest, dep_date, ret_date, flex_days, target_usd)"
        " VALUES (42, 'EVN', 'AYT', ?, ?, ?, ?)",
        (FAR, FAR_RET, flex, target),
    )


async def test_watch_alerts_once_then_respects_cooldown(db, settings, tmp_path) -> None:
    await _add_watch(db, target=160)
    tp = FakeTP([make_fare(price_usd=140, dep_date=FAR, ret_date=FAR_RET)])
    tg = FakeTG()
    settings.webapp_url = "https://trichq.example"
    city = CityNames(tmp_path)  # not loaded: falls back to IATA codes
    r1 = await watches.run(db, settings, tp, tg, city)  # type: ignore[arg-type]
    r2 = await watches.run(db, settings, tp, tg, city)  # type: ignore[arg-type]
    assert (r1["alerted"], r2["alerted"]) == (1, 0)
    chat, text, link = tg.sent[0]
    assert chat == 42 and "140 USD" in text and "EVN → AYT" in text
    assert link == f"https://trichq.example/?o=EVN&d=AYT&dep={FAR}&ret={FAR_RET}"
    w = (await db.query("SELECT * FROM watches"))[0]
    assert w["last_price_usd"] == 140 and w["last_alert_price_usd"] == 140
    assert len(await db.query("SELECT * FROM alerts_sent")) == 1


async def test_watch_flex_window_and_month_queries(db, settings, tmp_path) -> None:
    await _add_watch(db, target=100, flex=2)
    shifted_dep = (date.fromisoformat(FAR) + timedelta(days=2)).isoformat()
    shifted_ret = (date.fromisoformat(FAR_RET) + timedelta(days=2)).isoformat()
    outside = (date.fromisoformat(FAR) + timedelta(days=3)).isoformat()
    tp = FakeTP(
        [
            make_fare(price_usd=95, dep_date=shifted_dep, ret_date=shifted_ret),
            make_fare(price_usd=50, flight_number="1", dep_date=outside, ret_date=shifted_ret),
        ]
    )
    tg = FakeTG()
    r = await watches.run(db, settings, tp, tg, CityNames(tmp_path))  # type: ignore[arg-type]
    assert r["alerted"] == 1 and "95 USD" in tg.sent[0][1]
    assert all(len(c["departure_at"]) == 7 for c in tp.calls)  # month-level queries for a flexible watch


async def test_past_watches_are_deactivated(db, settings, tmp_path) -> None:
    await db.execute("INSERT INTO users (tg_id) VALUES (1)")
    await db.execute(
        "INSERT INTO watches (tg_id, origin, dest, dep_date, target_usd) VALUES (1, 'EVN', 'AYT', '2000-01-01', 10)"
    )
    await watches.run(db, settings, FakeTP(), None, CityNames(tmp_path))  # type: ignore[arg-type]
    assert (await db.query("SELECT active FROM watches"))[0]["active"] == 0


# --------------------------------------------------------------------------- HTTP clients


@respx.mock
async def test_travelpayouts_client_retries_and_parses() -> None:
    route = respx.get("https://api.travelpayouts.com/aviasales/v3/prices_for_dates")
    route.side_effect = [
        httpx.Response(429, json={"success": False}),
        httpx.Response(
            200,
            json={
                "success": True,
                "data": [
                    {
                        "origin": "EVN",
                        "destination": "DXB",
                        "price": 189,
                        "departure_at": "2026-12-04T03:00:00+04:00",
                        "return_at": "2026-12-08T22:00:00+04:00",
                        "airline": "FZ",
                        "flight_number": "716",
                        "link": "/s",
                    },
                ],
            },
        ),
    ]
    tp = TravelpayoutsClient("tok", rps=100)
    fares = await tp.prices_for_dates("EVN", departure_at="2026-12", return_at="2026-12", market="ru")
    await tp.close()
    assert [f.dest for f in fares] == ["DXB"]
    req = route.calls.last.request
    assert req.headers["X-Access-Token"] == "tok"
    assert req.url.params["one_way"] == "false" and req.url.params["currency"] == "usd"
    assert "destination" not in req.url.params


@respx.mock
async def test_turso_batch_is_atomic_and_reports_errors() -> None:
    route = respx.post("https://db.example.turso.io/v2/pipeline").mock(
        return_value=httpx.Response(
            200,
            json={
                "results": [
                    {
                        "type": "ok",
                        "response": {
                            "type": "batch",
                            "result": {
                                "step_results": [{}, None, None, None],
                                "step_errors": [None, {"message": "boom"}, None, None],
                            },
                        },
                    },
                    {"type": "ok", "response": {"type": "close"}},
                ]
            },
        )
    )
    db = TursoDB("libsql://db.example.turso.io", "t")
    try:
        await db.batch([("INSERT INTO x VALUES (?)", (1,))])
    except Exception as exc:
        assert "boom" in str(exc)
    else:
        raise AssertionError("expected TursoError")
    finally:
        await db.close()
    steps = route.calls.last.request.read().decode()
    assert '"BEGIN"' in steps and '"COMMIT"' in steps and '"ROLLBACK"' in steps


@respx.mock
async def test_turso_query_decodes_rows() -> None:
    respx.post("https://db.example.turso.io/v2/pipeline").mock(
        return_value=httpx.Response(
            200,
            json={
                "results": [
                    {
                        "type": "ok",
                        "response": {
                            "type": "execute",
                            "result": {
                                "cols": [{"name": "dest"}, {"name": "price_usd"}],
                                "rows": [[{"type": "text", "value": "AYT"}, {"type": "float", "value": 130.5}]],
                            },
                        },
                    },
                    {"type": "ok", "response": {"type": "close"}},
                ]
            },
        )
    )
    db = TursoDB("libsql://db.example.turso.io", "t")
    rows = await db.query("SELECT dest, price_usd FROM fares_current")
    await db.close()
    assert rows == [{"dest": "AYT", "price_usd": 130.5}]


# --------------------------------------------------------------------------- scheduler


def test_scheduler_picks_next_slot_in_yerevan() -> None:
    tz = ZoneInfo("Asia/Yerevan")
    now = datetime(2026, 10, 9, 23, 0, tzinfo=tz)
    runs = next_runs(now, (Slot("nightly", time(0, 40), 0), Slot("watches", time(8, 10), 0)), random.Random(1))
    when, slot = runs[0]
    assert slot.name == "nightly" and when == datetime(2026, 10, 10, 0, 40, tzinfo=tz)
