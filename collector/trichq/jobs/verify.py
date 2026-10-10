"""Re-price the cheapest known round trips on Google Flights.

Aviasales prices are a 48h cache; airlines' own sites are often cheaper (or sold out). Each night we take the
cheapest itinerary per destination from the home airport and ask Google for the live price of the same dates.
Results are stored as their own fares (source ``google``), so the app simply shows whichever is cheaper.
"""

from __future__ import annotations

import structlog

from trichq import repo
from trichq.config import Settings
from trichq.dates import local_today
from trichq.db import Database
from trichq.sources.google import GoogleFlights

log = structlog.get_logger(__name__)

JOB = "verify"


async def candidates(db: Database, origin: str, today: str, limit: int) -> list[tuple[str, str, str]]:
    rows = await db.query(
        """SELECT dest, dep_date, ret_date, MIN(price_usd) AS p FROM fares_current
           WHERE origin = ? AND ret_date IS NOT NULL AND dep_date > ? AND source <> 'google'
           GROUP BY dest ORDER BY p LIMIT ?""",
        (origin, today, limit),
    )
    return [(str(r["dest"]), str(r["dep_date"]), str(r["ret_date"])) for r in rows]


async def run(db: Database, settings: Settings, google: GoogleFlights | None = None) -> int:
    google = google or GoogleFlights(settings.serpapi_key, serpapi_budget=settings.serpapi_per_run)
    origin = settings.origins[0]
    today = local_today(settings.tz).isoformat()
    run_id = await repo.start_run(db, JOB, "google")
    found = []
    try:
        for dest, dep, ret in await candidates(db, origin, today, settings.google_routes_per_run):
            fare = await google.round_trip(origin, dest, dep, ret)
            if fare is not None:
                found.append(fare)
        written = await repo.upsert_fares(db, found)
        status = "ok" if found else "degraded"
        return written
    except Exception:
        status = "failed"
        raise
    finally:
        await repo.finish_run(
            db,
            run_id,
            status=status,
            requests=google.ok + google.failed,
            rows_seen=len(found),
            errors=google.failed,
            notes=f"google ok={google.ok} failed={google.failed}",
        )
        log.info("verify.done", found=len(found), ok=google.ok, failed=google.failed)
