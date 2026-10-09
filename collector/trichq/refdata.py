"""Reference data: Armenian city/country names, airlines, visa rules for Armenian passports.

Downloaded from free public sources and cached on disk. ``build_webapp_reference`` writes the
compact JSON the mini app loads; ``CityNames`` is used by the collector for alert texts.

Sources:
* Travelpayouts data JSON (has an ``hy`` locale):
  https://support.travelpayouts.com/hc/en-us/articles/360018907280-Data-in-json-format
* Passport Index data (MIT): https://github.com/imorte/passport-index-data
"""

from __future__ import annotations

import csv
import io
import json
import time
from pathlib import Path
from typing import Any

import httpx
import structlog

log = structlog.get_logger(__name__)

TP_DATA = "https://api.travelpayouts.com/data/{lang}/{name}.json"
PASSPORT_CSV = "https://raw.githubusercontent.com/imorte/passport-index-data/main/passport-index-tidy-iso2.csv"
CACHE_TTL_S = 7 * 24 * 3600


async def _get_json(client: httpx.AsyncClient, url: str) -> Any:
    resp = await client.get(url)
    resp.raise_for_status()
    return resp.json()


def _name(rec: dict[str, Any], lang: str) -> str | None:
    if lang == "en":
        return rec.get("name") or (rec.get("name_translations") or {}).get("en")
    return (rec.get("name_translations") or {}).get(lang) or None


async def fetch_cities(client: httpx.AsyncClient) -> dict[str, dict[str, Any]]:
    """IATA city code -> {hy, en, cc, lat, lon}. Armenian falls back to English when missing."""
    en = await _get_json(client, TP_DATA.format(lang="en", name="cities"))
    try:
        hy = await _get_json(client, TP_DATA.format(lang="hy", name="cities"))
    except httpx.HTTPError:
        log.warning("refdata.hy_missing", file="cities")
        hy = []
    hy_by_code = {c["code"]: c.get("name") for c in hy if c.get("code")}
    out: dict[str, dict[str, Any]] = {}
    for c in en:
        code = c.get("code")
        if not code or not c.get("has_flightable_airport", True):
            continue
        coords = c.get("coordinates") or {}
        name_en = _name(c, "en") or code
        out[code] = {
            "hy": hy_by_code.get(code) or _name(c, "hy") or name_en,
            "en": name_en,
            "cc": c.get("country_code"),
            "lat": coords.get("lat"),
            "lon": coords.get("lon"),
        }
    return out


async def fetch_countries(client: httpx.AsyncClient) -> dict[str, dict[str, str]]:
    en = await _get_json(client, TP_DATA.format(lang="en", name="countries"))
    try:
        hy = await _get_json(client, TP_DATA.format(lang="hy", name="countries"))
    except httpx.HTTPError:
        hy = []
    hy_by_code = {c["code"]: c.get("name") for c in hy if c.get("code")}
    return {
        c["code"]: {"hy": hy_by_code.get(c["code"]) or c.get("name") or c["code"], "en": c.get("name") or c["code"]}
        for c in en
        if c.get("code")
    }


async def fetch_airlines(client: httpx.AsyncClient) -> dict[str, str]:
    data = await _get_json(client, TP_DATA.format(lang="en", name="airlines"))
    out: dict[str, str] = {}
    for a in data:
        code, name = a.get("code"), a.get("name") or (a.get("name_translations") or {}).get("en")
        if code and name:
            out[code] = name
    return out


async def fetch_visa_for(client: httpx.AsyncClient, passport: str = "AM") -> dict[str, str]:
    """Destination ISO2 -> requirement ('visa free', '90', 'visa on arrival', 'e-visa', 'eta', 'visa required')."""
    resp = await client.get(PASSPORT_CSV)
    resp.raise_for_status()
    reader = csv.DictReader(io.StringIO(resp.text))
    out: dict[str, str] = {}
    for row in reader:
        if (row.get("Passport") or "").upper() == passport and row.get("Destination"):
            out[row["Destination"].upper()] = (row.get("Requirement") or "").strip()
    return out


async def build_webapp_reference(out_dir: Path) -> dict[str, int]:
    """Write ``places.json`` for the mini app: compact arrays to keep the download small."""
    async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
        cities = await fetch_cities(client)
        countries = await fetch_countries(client)
        airlines = await fetch_airlines(client)
        try:
            visa = await fetch_visa_for(client)
        except httpx.HTTPError as exc:
            log.warning("refdata.visa_failed", error=str(exc))
            visa = {}
    payload = {
        "v": 1,
        "generated_at": int(time.time()),
        # code: [hy, en, country, lat, lon]
        "cities": {k: [v["hy"], v["en"], v["cc"], _r(v["lat"]), _r(v["lon"])] for k, v in sorted(cities.items())},
        "countries": {k: [v["hy"], v["en"]] for k, v in sorted(countries.items())},
        "airlines": dict(sorted(airlines.items())),
        "visa": dict(sorted(visa.items())),
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "places.json").write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    return {"cities": len(cities), "countries": len(countries), "airlines": len(airlines), "visa": len(visa)}


def _r(v: Any) -> float | None:
    return round(float(v), 3) if isinstance(v, int | float) else None


class CityNames:
    """Armenian city names for alert messages, cached on disk for a week."""

    def __init__(self, data_dir: Path) -> None:
        self._path = data_dir / "cities.json"
        self._names: dict[str, str] = {}

    async def load(self) -> None:
        if self._path.exists() and time.time() - self._path.stat().st_mtime < CACHE_TTL_S:
            self._names = json.loads(self._path.read_text(encoding="utf-8"))
            return
        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                cities = await fetch_cities(client)
            self._names = {k: v["hy"] for k, v in cities.items()}
            self._path.parent.mkdir(parents=True, exist_ok=True)
            self._path.write_text(json.dumps(self._names, ensure_ascii=False), encoding="utf-8")
        except httpx.HTTPError as exc:
            log.warning("refdata.cities_unavailable", error=str(exc))
            if self._path.exists():
                self._names = json.loads(self._path.read_text(encoding="utf-8"))

    def __call__(self, code: str) -> str:
        return self._names.get(code, code)
