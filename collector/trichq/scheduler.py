"""A small, dependency-free scheduler for the long-running container.

Times are Asia/Yerevan. Each slot gets a few minutes of jitter so requests never start on the exact
minute, but the jitter is fixed per (slot, day): recomputing it after a run could otherwise move
today's slot into the future and fire it twice.
"""

from __future__ import annotations

import asyncio
import random
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
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


def fire_time(slot: Slot, day: date, tz: ZoneInfo) -> datetime:
    rng = random.Random(f"{slot.name}|{slot.at.isoformat()}|{day.isoformat()}")
    base = datetime.combine(day, slot.at, tzinfo=tz)
    return base + timedelta(seconds=rng.randint(0, slot.jitter_min * 60))


def next_runs(
    now: datetime, slots: tuple[Slot, ...], fired: set[datetime] | None = None
) -> list[tuple[datetime, Slot]]:
    """Upcoming (time, slot) pairs after ``now``, skipping any instant that already fired."""
    fired = fired or set()
    tz = now.tzinfo if isinstance(now.tzinfo, ZoneInfo) else ZoneInfo("UTC")
    out: list[tuple[datetime, Slot]] = []
    for s in slots:
        for offset in (0, 1):
            when = fire_time(s, now.date() + timedelta(days=offset), tz)
            if when > now and when not in fired:
                out.append((when, s))
                break
    return sorted(out, key=lambda x: x[0])


async def run_forever(
    jobs: dict[str, Callable[[], Awaitable[object]]],
    tz: ZoneInfo,
    on_error: Callable[[str, BaseException], Awaitable[None]],
    slots: tuple[Slot, ...] = DEFAULT_SLOTS,
) -> None:
    fired: set[datetime] = set()
    while True:
        now = datetime.now(tz)
        when, slot = next_runs(now, slots, fired)[0]
        wait_s = (when - now).total_seconds()
        log.info("scheduler.sleep", next_job=slot.name, at=when.isoformat(), seconds=int(wait_s))
        await asyncio.sleep(max(0.0, wait_s))
        fired.add(when)
        fired = {f for f in fired if f > datetime.now(tz) - timedelta(days=2)}
        log.info("scheduler.start", job=slot.name)
        try:
            await jobs[slot.name]()
            log.info("scheduler.finish", job=slot.name)
        except Exception as exc:
            log.exception("scheduler.job_failed", job=slot.name)
            await on_error(slot.name, exc)
