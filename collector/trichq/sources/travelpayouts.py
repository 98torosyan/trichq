"""Client for the Travelpayouts / Aviasales Data API.

Docs: https://support.travelpayouts.com/hc/en-us/articles/203956163
Limits: https://support.travelpayouts.com/hc/en-us/articles/4402565416594 (600 req/min for v3 endpoints)
Prices are cached from real user searches of the last 48 hours, so they must be verified before alerting.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

import httpx
import structlog
from tenacity import AsyncRetrying, retry_if_exception, stop_after_attempt, wait_exponential_jitter

from trichq.models import Fare, fare_from_tp

log = structlog.get_logger(__name__)

BASE_URL = "https://api.travelpayouts.com"
MAX_LIMIT = 1000


class RateLimiter:
    """Simple async token bucket: at most ``rate`` requests per second, shared by all calls."""

    def __init__(self, rate: float) -> None:
        self._interval = 1.0 / rate if rate > 0 else 0.0
        self._next = 0.0
        self._lock = asyncio.Lock()

    async def wait(self) -> None:
        async with self._lock:
            now = time.monotonic()
            delay = self._next - now
            self._next = max(now, self._next) + self._interval
        if delay > 0:
            await asyncio.sleep(delay)


class TravelpayoutsError(RuntimeError):
    pass


def _retryable(exc: BaseException) -> bool:
    if isinstance(exc, httpx.TransportError):
        return True
    return isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code in (429, 500, 502, 503, 504)


class TravelpayoutsClient:
    def __init__(
        self,
        token: str,
        *,
        marker: str = "",
        rps: float = 4.0,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        if not token:
            raise TravelpayoutsError("TRAVELPAYOUTS_TOKEN is not set")
        self._marker = marker
        self._limiter = RateLimiter(rps)
        self._client = client or httpx.AsyncClient(
            base_url=BASE_URL,
            timeout=httpx.Timeout(20.0, connect=10.0),
            headers={"X-Access-Token": token, "Accept-Encoding": "gzip, deflate"},
        )
        self.requests_made = 0

    async def close(self) -> None:
        await self._client.aclose()

    async def _get(self, path: str, params: dict[str, Any]) -> dict[str, Any]:
        clean = {k: _fmt(v) for k, v in params.items() if v is not None}
        async for attempt in AsyncRetrying(
            stop=stop_after_attempt(5),
            wait=wait_exponential_jitter(initial=2, max=60),
            retry=retry_if_exception(_retryable),
            reraise=True,
        ):
            with attempt:
                await self._limiter.wait()
                self.requests_made += 1
                resp = await self._client.get(path, params=clean)
                if resp.status_code == 429:
                    log.warning("tp.rate_limited", path=path, reset=resp.headers.get("X-Rate-Limit-Reset"))
                resp.raise_for_status()
        body = resp.json()
        if isinstance(body, dict) and body.get("success") is False:
            raise TravelpayoutsError(f"{path}: {body.get('error') or body}")
        return body

    async def prices_for_dates(
        self,
        origin: str,
        *,
        destination: str | None = None,
        departure_at: str | None = None,
        return_at: str | None = None,
        one_way: bool = False,
        direct: bool = False,
        market: str | None = None,
        limit: int = MAX_LIMIT,
        page: int = 1,
        sorting: str = "price",
        unique: bool = False,
    ) -> list[Fare]:
        """Cheapest tickets for dates (YYYY-MM or YYYY-MM-DD). Without ``destination`` it covers every route."""
        body = await self._get(
            "/aviasales/v3/prices_for_dates",
            {
                "origin": origin,
                "destination": destination,
                "departure_at": departure_at,
                "return_at": return_at,
                "one_way": one_way,
                "direct": direct,
                "market": market,
                "limit": min(limit, MAX_LIMIT),
                "page": page,
                "sorting": sorting,
                "unique": unique or None,
                "currency": "usd",
            },
        )
        items = body.get("data") or []
        fares = [fare_from_tp(it, market=market, marker=self._marker) for it in items]
        return [f for f in fares if f is not None]

    async def special_offers(self, origin: str, *, market: str | None = None) -> list[dict[str, Any]]:
        body = await self._get(
            "/aviasales/v3/get_special_offers",
            {"origin": origin, "market": market, "currency": "usd", "locale": "en"},
        )
        data = body.get("data") or []
        return data if isinstance(data, list) else []


def _fmt(v: Any) -> Any:
    if isinstance(v, bool):
        return "true" if v else "false"
    return v
