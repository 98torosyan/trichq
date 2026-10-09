"""A small, dependency-free scheduler for the long-running container.

Times are Asia/Yerevan. Each slot gets a few minutes of random jitter so requests never
start on the exact minute every day.
"""

from __future__ import annotations

import asyncio
import random
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

import structlog

log = structlog.get_logger(__name__)


@dataclass(frozen=True, slots=True)
class Slot:
    name: str
    at: time
    jitter_min: int = 5


DEFAULT_SLOTS: tuple[Slot, ...] = (
    Slot("nightly", time(0, 40)),
    Slot("watches", time(8, 10)),
    Slot("watches", time(12, 10)),
    Slot("watches", time(16, 10)),
    Slot("watches", time(20, 10)),
)


def next_runs(now: datetime, slots: tuple[Slot, ...], rng: random.Random) -> list[tuple[datetime, Slot]]:
    out: list[tuple[datetime, Slot]] = []
    for s in slots:
        when = now.replace(hour=s.at.hour, minute=s.at.minute, second=0, microsecond=0)
        when += timedelta(seconds=rng.randint(0, s.jitter_min * 60))
        if when <= now:
            when += timedelta(days=1)
        out.append((when, s))
    return sorted(out, key=lambda x: x[0])


async def run_forever(
    jobs: dict[str, Callable[[], Awaitable[object]]],
    tz: ZoneInfo,
    on_error: Callable[[str, BaseException], Awaitable[None]],
    slots: tuple[Slot, ...] = DEFAULT_SLOTS,
) -> None:
    rng = random.Random()
    while True:
        now = datetime.now(tz)
        when, slot = next_runs(now, slots, rng)[0]
        wait_s = (when - now).total_seconds()
        log.info("scheduler.sleep", next_job=slot.name, at=when.isoformat(), seconds=int(wait_s))
        await asyncio.sleep(max(1.0, wait_s))
        log.info("scheduler.start", job=slot.name)
        try:
            await jobs[slot.name]()
            log.info("scheduler.finish", job=slot.name)
        except Exception as exc:
            log.exception("scheduler.job_failed", job=slot.name)
            await on_error(slot.name, exc)
        await asyncio.sleep(61)  # never fire the same slot twice within one minute
