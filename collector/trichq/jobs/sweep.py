"""Nightly sweep: cheapest round trips from every origin to everywhere, for the next N months."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date

import structlog

from trichq import repo
from trichq.config import Settings
from trichq.dates import add_months, local_today, month_str, months_ahead
from trichq.db import Database
from trichq.models import Fare
from trichq.sources.travelpayouts import MAX_LIMIT, TravelpayoutsClient

log = structlog.get_logger(__name__)

JOB = "sweep"
SOURCE = "aviasales"
DEGRADED_RATIO = 0.5  # fewer than half the usual rows means something is off upstream


@dataclass(slots=True)
class SweepStats:
    requests: int = 0
    fares: int = 0
    errors: int = 0
    per_origin: dict[str, int] = field(default_factory=dict)


def keep_fare(f: Fare, today: date, max_nights: int) -> bool:
    if f.dep_date < today.isoformat():
        return False
    if f.ret_date is None:
        return True
    nights = f.nights
    return nights is not None and 1 <= nights <= max_nights


async def sweep_origin(
    tp: TravelpayoutsClient, settings: Settings, origin: str, today: date, stats: SweepStats
) -> list[Fare]:
    collected: list[Fare] = []
    for dep_month in months_ahead(today, settings.sweep_months):
        y, m = map(int, dep_month.split("-"))
        ret_months = [dep_month, month_str(add_months(date(y, m, 1), 1))]
        for ret_month in ret_months:
            for market in settings.tp_markets:
                for page in range(1, settings.sweep_max_pages + 1):
                    try:
                        fares = await tp.prices_for_dates(
                            origin,
                            departure_at=dep_month,
                            return_at=ret_month,
                            one_way=False,
                            market=market,
                            page=page,
                        )
                    except Exception as exc:  # one failed call must not kill the whole sweep
                        stats.errors += 1
                        log.warning(
                            "sweep.call_failed",
                            origin=origin,
                            dep=dep_month,
                            ret=ret_month,
                            market=market,
                            page=page,
                            error=str(exc),
                        )
                        break
                    collected.extend(f for f in fares if keep_fare(f, today, settings.max_trip_nights))
                    if len(fares) < MAX_LIMIT:
                        break
    return collected


async def run(db: Database, settings: Settings, tp: TravelpayoutsClient) -> SweepStats:
    today = local_today(settings.tz)
    run_id = await repo.start_run(db, JOB, SOURCE)
    start_requests = tp.requests_made
    stats = SweepStats()
    status, notes = "failed", ""
    try:
        for origin in settings.origins:
            fares = await sweep_origin(tp, settings, origin, today, stats)
            written = await repo.upsert_fares(db, fares)
            stats.per_origin[origin] = written
            stats.fares += written
            log.info("sweep.origin_done", origin=origin, fares=written)
        usual = await repo.recent_rows_median(db, JOB)
        degraded = stats.fares == 0 or (usual is not None and stats.fares < usual * DEGRADED_RATIO)
        status = "degraded" if degraded else "ok"
        notes = ", ".join(f"{k}={v}" for k, v in stats.per_origin.items())
        if usual is not None:
            notes += f"; usual={int(usual)}"
        return stats
    except Exception as exc:
        notes = f"{type(exc).__name__}: {exc}"
        raise
    finally:
        stats.requests = tp.requests_made - start_requests
        await repo.finish_run(
            db,
            run_id,
            status=status,
            requests=stats.requests,
            rows_seen=stats.fares,
            errors=stats.errors,
            notes=notes,
        )
        log.info("sweep.done", status=status, fares=stats.fares, requests=stats.requests, errors=stats.errors)
