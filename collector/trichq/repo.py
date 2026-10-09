"""All SQL lives here so jobs read like plain business logic."""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from datetime import UTC, datetime
from typing import Any

from trichq.db import Database, Row, Statement
from trichq.models import Fare

UPSERT_CHUNK = 200

UPSERT_FARE_SQL = """
INSERT INTO fares_current (fare_key, origin, dest, dep_date, ret_date, price_usd, airline, flight_number,
                           transfers, return_transfers, duration_min, link, source, market, found_at,
                           first_seen_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (fare_key) DO UPDATE SET
  price_usd        = excluded.price_usd,
  transfers        = COALESCE(excluded.transfers, fares_current.transfers),
  return_transfers = COALESCE(excluded.return_transfers, fares_current.return_transfers),
  duration_min     = COALESCE(excluded.duration_min, fares_current.duration_min),
  link             = COALESCE(excluded.link, fares_current.link),
  source           = excluded.source,
  market           = excluded.market,
  found_at         = excluded.found_at,
  updated_at       = excluded.updated_at
"""


def utcnow() -> datetime:
    return datetime.now(UTC)


def iso(dt: datetime) -> str:
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def chunked(items: Sequence[Any], size: int) -> Iterable[Sequence[Any]]:
    for i in range(0, len(items), size):
        yield items[i : i + size]


def dedupe_cheapest(fares: Iterable[Fare]) -> list[Fare]:
    """Keep the cheapest observation per itinerary (the same flight can come from several markets)."""
    best: dict[str, Fare] = {}
    for f in fares:
        cur = best.get(f.key)
        if cur is None or f.price_usd < cur.price_usd:
            best[f.key] = f
    return list(best.values())


async def upsert_fares(db: Database, fares: Iterable[Fare], *, now: datetime | None = None) -> int:
    rows = dedupe_cheapest(fares)
    stamp = iso(now or utcnow())
    for part in chunked(rows, UPSERT_CHUNK):
        stmts: list[Statement] = [
            (
                UPSERT_FARE_SQL,
                (
                    f.key,
                    f.origin,
                    f.dest,
                    f.dep_date,
                    f.ret_date,
                    f.price_usd,
                    f.airline,
                    f.flight_number,
                    f.transfers,
                    f.return_transfers,
                    f.duration_min,
                    f.link,
                    f.source,
                    f.market,
                    f.found_at,
                    stamp,
                    stamp,
                ),
            )
            for f in part
        ]
        await db.batch(stmts)
    return len(rows)


# --------------------------------------------------------------------------- runs / health


async def start_run(db: Database, job: str, source: str) -> int:
    await db.execute("INSERT INTO scrape_runs (job, source, started_at) VALUES (?, ?, ?)", (job, source, iso(utcnow())))
    rows = await db.query(
        "SELECT id FROM scrape_runs WHERE job = ? AND source = ? ORDER BY id DESC LIMIT 1", (job, source)
    )
    return int(rows[0]["id"])


async def finish_run(
    db: Database, run_id: int, *, status: str, requests: int, rows_seen: int, errors: int, notes: str = ""
) -> None:
    await db.execute(
        "UPDATE scrape_runs SET finished_at = ?, status = ?, requests = ?, rows_seen = ?, errors = ?, notes = ?"
        " WHERE id = ?",
        (iso(utcnow()), status, requests, rows_seen, errors, notes[:1000], run_id),
    )


async def last_ok_run(db: Database, job: str) -> Row | None:
    rows = await db.query(
        "SELECT * FROM scrape_runs WHERE job = ? AND status IN ('ok', 'degraded') ORDER BY id DESC LIMIT 1",
        (job,),
    )
    return rows[0] if rows else None


async def recent_rows_median(db: Database, job: str, days: int = 7) -> float | None:
    rows = await db.query(
        "SELECT rows_seen FROM scrape_runs WHERE job = ? AND status IN ('ok', 'degraded')"
        " AND started_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?) ORDER BY rows_seen",
        (job, f"-{days} days"),
    )
    if not rows:
        return None
    vals = [r["rows_seen"] for r in rows]
    return float(vals[len(vals) // 2])
