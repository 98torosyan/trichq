from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Any
from urllib.parse import urlencode

AVIASALES_BASE = "https://www.aviasales.com"


def fare_key(origin: str, dest: str, dep: str, ret: str | None, airline: str | None, flight: str | None) -> str:
    """Stable, readable id for one itinerary, e.g. ``EVN|AYT|2026-11-13|2026-11-17|PC|781``.

    Kept as plain text (no hashing) so the edge Worker can build it with zero CPU cost.
    Must match worker/src/lib/fares.ts::fareKey exactly.
    """
    return "|".join([origin, dest, dep, ret or "", airline or "", flight or ""])


@dataclass(slots=True, frozen=True)
class Fare:
    origin: str
    dest: str
    dep_date: str
    ret_date: str | None
    price_usd: float
    airline: str | None
    flight_number: str | None
    transfers: int | None
    return_transfers: int | None
    duration_min: int | None
    link: str | None
    source: str
    market: str | None
    found_at: str | None

    @property
    def key(self) -> str:
        return fare_key(self.origin, self.dest, self.dep_date, self.ret_date, self.airline, self.flight_number)

    @property
    def nights(self) -> int | None:
        if not self.ret_date:
            return None
        return (date.fromisoformat(self.ret_date) - date.fromisoformat(self.dep_date)).days


def booking_link(path: str | None, marker: str = "") -> str | None:
    if not path:
        return None
    url = path if path.startswith("http") else f"{AVIASALES_BASE}{path}"
    if marker and "marker=" not in url:
        url += ("&" if "?" in url else "?") + urlencode({"marker": marker})
    return url


def fare_from_tp(item: dict[str, Any], *, market: str | None, marker: str = "") -> Fare | None:
    """Normalise one Aviasales Data API (prices_for_dates) item. Returns None for unusable rows."""
    try:
        origin = str(item["origin"]).upper()
        dest = str(item["destination"]).upper()
        dep = str(item["departure_at"])[:10]
        ret_raw = item.get("return_at")
        ret = str(ret_raw)[:10] if ret_raw else None
        price = float(item["price"])
    except (KeyError, TypeError, ValueError):
        return None
    if price <= 0 or origin == dest:
        return None
    try:
        date.fromisoformat(dep)
        if ret:
            date.fromisoformat(ret)
    except ValueError:
        return None
    flight = item.get("flight_number")
    return Fare(
        origin=origin,
        dest=dest,
        dep_date=dep,
        ret_date=ret,
        price_usd=round(price, 2),
        airline=(item.get("airline") or None),
        flight_number=str(flight) if flight not in (None, "") else None,
        transfers=_int_or_none(item.get("transfers")),
        return_transfers=_int_or_none(item.get("return_transfers")),
        duration_min=_int_or_none(item.get("duration")),
        link=booking_link(item.get("link"), marker),
        source="aviasales",
        market=market,
        found_at=None,
    )


def _int_or_none(v: Any) -> int | None:
    try:
        return int(v) if v is not None else None
    except (TypeError, ValueError):
        return None
