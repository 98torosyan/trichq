"""Build the deals feed.

Three kinds:
* ``drop``     - a fresh fare at least 15% under that route's typical cheapest price (our own history).
* ``special``  - Aviasales "special offers" (unusually low fares they detected).
* ``cheapest`` - the cheapest round trip per destination in the next 90 days, 2 to 14 nights.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

import structlog

from trichq import repo
from trichq.config import Settings
from trichq.dates import local_today
from trichq.db import Database, Statement
from trichq.models import booking_link
from trichq.sources.travelpayouts import TravelpayoutsClient

log = structlog.get_logger(__name__)

DROP_THRESHOLD = 0.85  # price <= 85% of the typical cheapest price
MIN_HISTORY_DAYS = 7  # need at least a week of snapshots before calling something a drop
HISTORY_WINDOW_DAYS = 60
MIN_LEAD_DAYS = 2  # skip departures that are basically today
CHEAPEST_HORIZON_DAYS = 90
FRESH_HOURS = 36
TOP_N = 40

INSERT_DEAL_SQL = """
INSERT INTO deals (kind, origin, dest, dep_date, ret_date, price_usd, ref_usd, pct_below, airline, transfers,
                   link, source, created_at, expires_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (kind, origin, dest, dep_date, ret_date) DO UPDATE SET
  price_usd = excluded.price_usd, ref_usd = excluded.ref_usd, pct_below = excluded.pct_below,
  airline = excluded.airline, transfers = excluded.transfers, link = excluded.link,
  expires_at = excluded.expires_at
"""


def pct_below(price: float, ref: float | None) -> int | None:
    if not ref or ref <= 0:
        return None
    return round((ref - price) / ref * 100)


async def find_drops(db: Database, today: date, fresh_since: str) -> list[dict[str, Any]]:
    since = (today - timedelta(days=HISTORY_WINDOW_DAYS)).isoformat()
    min_dep = (today + timedelta(days=MIN_LEAD_DAYS)).isoformat()
    rows = await db.query(
        """
        WITH ref AS (
          SELECT origin, dest, dep_month, AVG(min_usd) AS ref_usd, COUNT(*) AS n
          FROM route_daily_stats WHERE day >= ? GROUP BY origin, dest, dep_month HAVING n >= ?
        )
        SELECT f.*, ref.ref_usd FROM fares_current f
        JOIN ref ON f.origin = ref.origin AND f.dest = ref.dest AND substr(f.dep_date, 1, 7) = ref.dep_month
        WHERE f.ret_date IS NOT NULL AND f.dep_date >= ? AND f.updated_at >= ?
          AND f.price_usd <= ref.ref_usd * ?
        ORDER BY f.price_usd / ref.ref_usd ASC
        """,
        (since, MIN_HISTORY_DAYS, min_dep, fresh_since, DROP_THRESHOLD),
    )
    best: dict[tuple[str, str], dict[str, Any]] = {}
    for r in rows:  # already ordered best-first: keep one per route
        best.setdefault((r["origin"], r["dest"]), r)
    return list(best.values())[:TOP_N]


async def find_cheapest(db: Database, origin: str, today: date, fresh_since: str) -> list[dict[str, Any]]:
    return await db.query(
        """
        SELECT * FROM (
          SELECT f.*, ROW_NUMBER() OVER (PARTITION BY dest ORDER BY price_usd) AS rn
          FROM fares_current f
          WHERE origin = ? AND ret_date IS NOT NULL AND dep_date BETWEEN ? AND ? AND updated_at >= ?
            AND julianday(ret_date) - julianday(dep_date) BETWEEN 2 AND 14
        ) WHERE rn = 1 ORDER BY price_usd LIMIT ?
        """,
        (
            origin,
            (today + timedelta(days=MIN_LEAD_DAYS)).isoformat(),
            (today + timedelta(days=CHEAPEST_HORIZON_DAYS)).isoformat(),
            fresh_since,
            TOP_N,
        ),
    )


async def run(db: Database, settings: Settings, tp: TravelpayoutsClient | None) -> dict[str, int]:
    today = local_today(settings.tz)
    now = repo.utcnow()
    stamp = repo.iso(now)
    fresh_since = repo.iso(now - timedelta(hours=FRESH_HOURS))
    nightly_expiry = repo.iso(now + timedelta(hours=30))

    await db.execute("DELETE FROM deals WHERE expires_at < ? OR dep_date < ?", (stamp, today.isoformat()))
    stmts: list[Statement] = []

    for r in await find_drops(db, today, fresh_since):
        stmts.append(
            (
                INSERT_DEAL_SQL,
                (
                    "drop",
                    r["origin"],
                    r["dest"],
                    r["dep_date"],
                    r["ret_date"],
                    r["price_usd"],
                    round(r["ref_usd"], 2),
                    pct_below(r["price_usd"], r["ref_usd"]),
                    r["airline"],
                    r["transfers"],
                    r["link"],
                    r["source"],
                    stamp,
                    nightly_expiry,
                ),
            )
        )
    n_drops = len(stmts)

    for origin in settings.origins:
        for r in await find_cheapest(db, origin, today, fresh_since):
            stmts.append(
                (
                    INSERT_DEAL_SQL,
                    (
                        "cheapest",
                        r["origin"],
                        r["dest"],
                        r["dep_date"],
                        r["ret_date"],
                        r["price_usd"],
                        None,
                        None,
                        r["airline"],
                        r["transfers"],
                        r["link"],
                        r["source"],
                        stamp,
                        nightly_expiry,
                    ),
                )
            )
    n_cheapest = len(stmts) - n_drops

    n_special = 0
    if tp is not None:
        for origin in settings.origins:
            for market in settings.tp_markets:
                try:
                    offers = await tp.special_offers(origin, market=market)
                except Exception as exc:
                    log.warning("deals.special_failed", origin=origin, market=market, error=str(exc))
                    continue
                for o in offers:
                    row = _special_row(o, origin, settings.travelpayouts_marker, stamp, today)
                    if row:
                        stmts.append((INSERT_DEAL_SQL, row))
                        n_special += 1

    for part in repo.chunked(stmts, repo.UPSERT_CHUNK):
        await db.batch(part)
    result = {"drops": n_drops, "cheapest": n_cheapest, "special": n_special}
    log.info("deals.done", **result)
    return result


def _special_row(o: dict[str, Any], origin: str, marker: str, stamp: str, today: date) -> tuple | None:
    try:
        dest = str(o["destination"]).upper()
        dep = str(o["departure_at"])[:10]
        price = float(o["price"])
    except (KeyError, TypeError, ValueError):
        return None
    if dep < (today + timedelta(days=MIN_LEAD_DAYS)).isoformat() or price <= 0:
        return None
    # "" instead of NULL so the UNIQUE (kind, origin, dest, dep_date, ret_date) key also dedupes one-way offers
    ret = str(o["return_at"])[:10] if o.get("return_at") else ""
    expires = f"{dep}T00:00:00Z"
    return (
        "special",
        str(o.get("origin") or origin).upper(),
        dest,
        dep,
        ret,
        round(price, 2),
        None,
        None,
        o.get("airline"),
        o.get("transfers"),
        booking_link(o.get("link"), marker),
        "aviasales",
        stamp,
        expires,
    )
