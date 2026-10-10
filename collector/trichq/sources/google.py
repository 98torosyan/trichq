"""Live round-trip prices from Google Flights.

Primary: the open-source ``fast-flights`` parser (no key, unofficial, may break when Google changes its page).
Fallback: SerpApi's Google Flights engine (official JSON, 250 free searches a month) when ``SERPAPI_KEY`` is set.
Both are slow and rate-sensitive, so they only re-price a short list of candidates instead of sweeping.
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx
import structlog

from trichq.models import Fare

log = structlog.get_logger(__name__)


def _fare(
    origin: str,
    dest: str,
    dep: str,
    ret: str,
    price: float,
    airline: str | None,
    stops: int | None,
    link: str | None,
    source: str,
) -> Fare:
    return Fare(
        origin=origin,
        dest=dest,
        dep_date=dep,
        ret_date=ret,
        price_usd=round(float(price), 2),
        airline=airline,
        flight_number=None,
        transfers=stops,
        return_transfers=None,
        duration_min=None,
        link=link,
        source=source,
        market=None,
        found_at=None,
    )


def _fast_flights_sync(origin: str, dest: str, dep: str, ret: str) -> Fare | None:
    from fast_flights import FlightQuery, Passengers, create_query, get_flights

    q = create_query(
        flights=[
            FlightQuery(date=dep, from_airport=origin, to_airport=dest),
            FlightQuery(date=ret, from_airport=dest, to_airport=origin),
        ],
        trip="round-trip",
        passengers=Passengers(adults=1),
        currency="USD",
        language="en-US",
    )
    best = None
    for f in get_flights(q):
        if f.price and (best is None or f.price < best.price):
            best = f
    if best is None:
        return None
    airline = best.airlines[0] if best.airlines else None
    stops = max(len(best.flights) - 1, 0) if best.flights else None
    return _fare(origin, dest, dep, ret, best.price, airline, stops, q.url(), "google")


class GoogleFlights:
    def __init__(self, serpapi_key: str = "", *, serpapi_budget: int = 8, delay_s: float = 4.0) -> None:
        self._serp_key = serpapi_key
        self._serp_left = serpapi_budget  # per run; the free plan is 250 a month
        self._delay = delay_s
        self.ok = 0
        self.failed = 0

    async def round_trip(self, origin: str, dest: str, dep: str, ret: str) -> Fare | None:
        await asyncio.sleep(self._delay)  # be gentle: one query every few seconds
        try:
            fare = await asyncio.to_thread(_fast_flights_sync, origin, dest, dep, ret)
            self.ok += 1
            return fare
        except Exception as exc:
            self.failed += 1
            log.warning("google.fast_flights_failed", route=f"{origin}-{dest}", dep=dep, error=str(exc)[:200])
        if self._serp_key and self._serp_left > 0:
            self._serp_left -= 1
            return await self._serpapi(origin, dest, dep, ret)
        return None

    async def _serpapi(self, origin: str, dest: str, dep: str, ret: str) -> Fare | None:
        params = {
            "engine": "google_flights",
            "departure_id": origin,
            "arrival_id": dest,
            "outbound_date": dep,
            "return_date": ret,
            "currency": "USD",
            "hl": "en",
            "api_key": self._serp_key,
        }
        try:
            async with httpx.AsyncClient(timeout=40) as client:
                resp = await client.get("https://serpapi.com/search.json", params=params)
                resp.raise_for_status()
                body: dict[str, Any] = resp.json()
        except Exception as exc:
            log.warning("google.serpapi_failed", route=f"{origin}-{dest}", error=str(exc)[:200])
            return None
        options = (body.get("best_flights") or []) + (body.get("other_flights") or [])
        priced = [o for o in options if isinstance(o.get("price"), (int, float))]
        if not priced:
            return None
        best = min(priced, key=lambda o: o["price"])
        legs = best.get("flights") or []
        airline = legs[0].get("airline") if legs else None
        link = (body.get("search_metadata") or {}).get("google_flights_url")
        return _fare(origin, dest, dep, ret, best["price"], airline, max(len(legs) - 1, 0), link, "google")
