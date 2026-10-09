from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import pytest

from trichq import migrate
from trichq.config import Settings
from trichq.db import SqliteDB
from trichq.models import Fare

MIGRATIONS = Path(__file__).resolve().parents[2] / "db" / "migrations"


@pytest.fixture
async def db(tmp_path: Path) -> AsyncIterator[SqliteDB]:
    d = SqliteDB(tmp_path / "t.db")
    await migrate.run(d, MIGRATIONS)
    yield d
    await d.close()


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(
        TRAVELPAYOUTS_TOKEN="x",
        ORIGINS="EVN",
        TP_MARKETS="ru",
        SWEEP_MONTHS=2,
        DATA_DIR=str(tmp_path),
        TELEGRAM_BOT_TOKEN="",
        LOG_JSON=False,
    )


def make_fare(**kw: Any) -> Fare:
    base: dict[str, Any] = {
        "origin": "EVN",
        "dest": "AYT",
        "dep_date": "2030-11-13",
        "ret_date": "2030-11-17",
        "price_usd": 150.0,
        "airline": "PC",
        "flight_number": "781",
        "transfers": 1,
        "return_transfers": 1,
        "duration_min": 340,
        "link": "https://www.aviasales.com/search/x",
        "source": "aviasales",
        "market": "ru",
        "found_at": None,
    }
    base.update(kw)
    return Fare(**base)


class FakeTP:
    """Stands in for TravelpayoutsClient: returns canned fares and records every call."""

    def __init__(self, fares: list[Fare] | None = None, specials: list[dict[str, Any]] | None = None) -> None:
        self.fares = fares or []
        self.specials = specials or []
        self.calls: list[dict[str, Any]] = []
        self.requests_made = 0

    async def prices_for_dates(self, origin: str, **kw: Any) -> list[Fare]:
        self.requests_made += 1
        self.calls.append({"origin": origin, **kw})
        dest = kw.get("destination")
        return [f for f in self.fares if f.origin == origin and (dest is None or f.dest == dest)]

    async def special_offers(self, origin: str, **kw: Any) -> list[dict[str, Any]]:
        self.requests_made += 1
        return self.specials

    async def close(self) -> None:
        pass
