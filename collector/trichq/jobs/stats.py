"""Daily snapshot of every route's price level, plus cleanup of stale current fares.

route_daily_stats is our own price history: no free API offers "the last 60 days", so we build it.
"""

from __future__ import annotations

import statistics
from collections import defaultdict
from datetime import timedelta

import structlog

from trichq import repo
from trichq.config import Settings
from trichq.dates import local_today
from trichq.db import Database, Statement

log = structlog.get_logger(__name__)

STALE_AFTER_DAYS = 7  # cached prices older than this are no longer trusted
FRESH_FOR_STATS_H = 48  # only prices seen in the last 48h feed today's snapshot
KEEP_STATS_DAYS = 400


async def run(db: Database, settings: Settings) -> dict[str, int]:
    today = local_today(settings.tz)
    now = repo.utcnow()

    removed = await db.execute(
        "DELETE FROM fares_current WHERE dep_date < ? OR updated_at < ?",
        (today.isoformat(), repo.iso(now - timedelta(days=STALE_AFTER_DAYS))),
    )

    rows = await db.query(
        "SELECT origin, dest, substr(dep_date, 1, 7) AS dep_month, price_usd FROM fares_current"
        " WHERE ret_date IS NOT NULL AND updated_at >= ?",
        (repo.iso(now - timedelta(hours=FRESH_FOR_STATS_H)),),
    )
    groups: dict[tuple[str, str, str], list[float]] = defaultdict(list)
    for r in rows:
        groups[(r["origin"], r["dest"], r["dep_month"])].append(float(r["price_usd"]))

    day = today.isoformat()
    stmts: list[Statement] = [
        (
            "INSERT OR REPLACE INTO route_daily_stats (origin, dest, dep_month, day, min_usd, median_usd, n_fares)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (o, d, m, day, round(min(p), 2), round(statistics.median(p), 2), len(p)),
        )
        for (o, d, m), p in groups.items()
    ]
    for part in repo.chunked(stmts, repo.UPSERT_CHUNK):
        await db.batch(part)

    pruned = await db.execute(
        "DELETE FROM route_daily_stats WHERE day < ?", ((today - timedelta(days=KEEP_STATS_DAYS)).isoformat(),)
    )
    result = {"routes": len(groups), "removed_stale": removed, "pruned_stats": pruned}
    log.info("stats.done", **result)
    return result
