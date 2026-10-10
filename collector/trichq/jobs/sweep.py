"""Nightly sweep: cheapest round trips from every origin to everywhere, for the next N months."""

from __future__ import annotations

import asyncio
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

# Destinations always swept one by one, even if the "anywhere" query missed them (IATA city or airport codes).
CORE_DESTS: tuple[str, ...] = (
    "MOW",
    "LED",
    "KZN",
    "AER",
    "KRR",
    "SVX",
    "OVB",
    "ROV",
    "MRV",
    "KUF",
    "UFA",
    "IST",
    "SAW",
    "AYT",
    "ESB",
    "ADB",
    "DLM",
    "BJV",
    "TZX",
    "DXB",
    "SHJ",
    "AUH",
    "DOH",
    "BAH",
    "KWI",
    "MCT",
    "RUH",
    "JED",
    "DMM",
    "AMM",
    "BEY",
    "TLV",
    "CAI",
    "HRG",
    "SSH",
    "PAR",
    "BER",
    "MUC",
    "FRA",
    "DUS",
    "HAM",
    "VIE",
    "PRG",
    "WAW",
    "KRK",
    "BUD",
    "ROM",
    "MIL",
    "VCE",
    "NAP",
    "BCN",
    "MAD",
    "VLC",
    "AGP",
    "LIS",
    "OPO",
    "AMS",
    "BRU",
    "ZRH",
    "GVA",
    "LON",
    "MAN",
    "DUB",
    "ATH",
    "SKG",
    "LCA",
    "PFO",
    "SOF",
    "VAR",
    "BUH",
    "CLJ",
    "BEG",
    "TIV",
    "TGD",
    "RIX",
    "VNO",
    "TLL",
    "HEL",
    "ARN",
    "CPH",
    "OSL",
    "MLA",
    "NCE",
    "MRS",
    "LYS",
    "BLQ",
    "FLR",
    "PSA",
    "CTA",
    "PMO",
    "TBS",
    "BUS",
    "KUT",
    "GYD",
    "NQZ",
    "ALA",
    "TAS",
    "SKD",
    "FRU",
    "DYU",
    "MHD",
    "THR",
    "KIV",
    "MSQ",
    "DEL",
    "BOM",
    "BKK",
    "HKT",
    "DPS",
    "SIN",
    "KUL",
    "HAN",
    "SGN",
    "PEK",
    "PVG",
    "HKG",
    "TYO",
    "SEL",
    "MLE",
    "CMB",
    "NYC",
    "LAX",
    "MIA",
    "YTO",
)


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
                    if getattr(tp, "last_page_size", len(fares)) < MAX_LIMIT:
                        break
    return collected


async def sweep_destinations(
    tp: TravelpayoutsClient,
    settings: Settings,
    origin: str,
    dests: list[str],
    today: date,
    stats: SweepStats,
    *,
    legs: bool,
) -> list[Fare]:
    """Ask route by route. With ``legs`` also fetch one-way tickets both ways, so the API can pair them
    into round trips even when nobody searched that exact round trip (e.g. Yerevan to Warsaw on Wizz Air)."""
    sem = asyncio.Semaphore(settings.sweep_concurrency)
    market = settings.tp_markets[0] if settings.tp_markets else None
    months = months_ahead(today, settings.sweep_months)

    async def call(o: str, d: str, month: str, one_way: bool) -> list[Fare]:
        async with sem:
            try:
                fares = await tp.prices_for_dates(o, destination=d, departure_at=month, one_way=one_way, market=market)
            except Exception as exc:
                stats.errors += 1
                log.warning("sweep.dest_failed", origin=o, dest=d, month=month, one_way=one_way, error=str(exc))
                return []
        return [f for f in fares if keep_fare(f, today, settings.max_trip_nights)]

    tasks = []
    for d in dests:
        for month in months:
            tasks.append(call(origin, d, month, False))
            if legs:
                tasks.append(call(origin, d, month, True))
                tasks.append(call(d, origin, month, True))
    out: list[Fare] = []
    for chunk in await asyncio.gather(*tasks):
        out.extend(chunk)
    return out


async def run(db: Database, settings: Settings, tp: TravelpayoutsClient) -> SweepStats:
    today = local_today(settings.tz)
    run_id = await repo.start_run(db, JOB, SOURCE)
    start_requests = tp.requests_made
    stats = SweepStats()
    status, notes = "failed", ""
    try:
        for origin in settings.origins:
            fares = await sweep_origin(tp, settings, origin, today, stats)
            if settings.sweep_per_dest:
                seen = {f.dest for f in fares}
                dests = sorted((seen | set(CORE_DESTS)) - {origin, *settings.origins})
                # One-way legs for the home airport; alternatives only need round trips for comparison.
                legs = origin == settings.origins[0]
                fares += await sweep_destinations(tp, settings, origin, dests, today, stats, legs=legs)
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
