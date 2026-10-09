"""Command line entry point.

python -m trichq migrate          apply database migrations
python -m trichq sweep            collect fares from every origin to everywhere
python -m trichq stats            snapshot route price levels and clean stale fares
python -m trichq deals            rebuild the deals feed
python -m trichq watches          check price watches and send alerts
python -m trichq nightly          sweep -> stats -> deals -> watches
python -m trichq reference --out DIR   write places.json for the mini app
python -m trichq scheduler        run forever on the built-in schedule (container mode)
"""

from __future__ import annotations

import argparse
import asyncio
import html
import sys
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import structlog

from trichq import migrate as migrate_mod
from trichq import repo
from trichq.config import Settings, get_settings
from trichq.db import Database, open_db
from trichq.jobs import deals, stats, sweep, watches
from trichq.logs import setup_logging
from trichq.refdata import CityNames, build_webapp_reference
from trichq.scheduler import run_forever
from trichq.sources.travelpayouts import TravelpayoutsClient
from trichq.telegram import Telegram

log = structlog.get_logger("trichq")


@dataclass(slots=True)
class Ctx:
    settings: Settings
    db: Database
    tp: TravelpayoutsClient | None
    tg: Telegram | None
    city: CityNames


@asynccontextmanager
async def context(*, need_tp: bool = True) -> AsyncIterator[Ctx]:
    settings = get_settings()
    db = open_db(settings)
    tp = (
        TravelpayoutsClient(
            settings.travelpayouts_token, marker=settings.travelpayouts_marker, rps=settings.tp_requests_per_second
        )
        if need_tp
        else None
    )
    tg = Telegram(settings.telegram_bot_token) if settings.telegram_bot_token else None
    city = CityNames(settings.data_dir)
    try:
        yield Ctx(settings, db, tp, tg, city)
    finally:
        for closable in (tp, tg, db):
            if closable is not None:
                await closable.close()


async def cmd_nightly(c: Ctx) -> None:
    assert c.tp is not None
    await sweep.run(c.db, c.settings, c.tp)
    await stats.run(c.db, c.settings)
    await deals.run(c.db, c.settings, c.tp)
    await c.city.load()
    await watches.run(c.db, c.settings, c.tp, c.tg, c.city)


async def cmd_watches(c: Ctx) -> None:
    assert c.tp is not None
    await c.city.load()
    await watches.run(c.db, c.settings, c.tp, c.tg, c.city)


async def notify_admin(c: Ctx, job: str, exc: BaseException) -> None:
    if c.tg is None or c.settings.admin_chat_id is None:
        return
    detail = f"{html.escape(type(exc).__name__)}: {html.escape(str(exc))[:500]}"
    text = f"⚠️ <b>Թռիչք</b>: «{job}» աշխատանքը ձախողվեց\n<code>{detail}</code>"
    try:
        await c.tg.send_message(c.settings.admin_chat_id, text)
    except Exception:
        log.exception("admin.notify_failed")


async def cmd_scheduler(c: Ctx) -> None:
    jobs: dict[str, Callable[[], Awaitable[object]]] = {
        "nightly": lambda: cmd_nightly(c),
        "watches": lambda: cmd_watches(c),
    }
    await migrate_mod.run(c.db)
    await run_forever(jobs, c.settings.tz, lambda job, exc: notify_admin(c, job, exc))


async def main_async(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="trichq")
    sub = parser.add_subparsers(dest="cmd", required=True)
    for name in ("migrate", "sweep", "stats", "deals", "watches", "nightly", "scheduler"):
        sub.add_parser(name)
    backup = sub.add_parser("nightly-if-stale", help="run the nightly chain only if the server missed it")
    backup.add_argument("--max-age-hours", type=float, default=20.0)
    ref = sub.add_parser("reference")
    ref.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)

    settings = get_settings()
    setup_logging(json=settings.log_json)

    if args.cmd == "reference":
        counts = await build_webapp_reference(args.out)
        log.info("reference.done", **counts)
        return 0

    need_tp = args.cmd not in ("migrate", "stats")
    async with context(need_tp=need_tp) as c:
        if args.cmd == "migrate":
            await migrate_mod.run(c.db)
        elif args.cmd == "sweep":
            assert c.tp is not None
            await sweep.run(c.db, c.settings, c.tp)
        elif args.cmd == "stats":
            await stats.run(c.db, c.settings)
        elif args.cmd == "deals":
            await deals.run(c.db, c.settings, c.tp)
        elif args.cmd == "watches":
            await cmd_watches(c)
        elif args.cmd == "nightly":
            try:
                await cmd_nightly(c)
            except Exception as exc:
                await notify_admin(c, "nightly", exc)
                raise
        elif args.cmd == "nightly-if-stale":
            last = await repo.last_ok_run(c.db, "sweep")
            age_h = (
                (repo.utcnow() - datetime.fromisoformat(last["started_at"].replace("Z", "+00:00"))).total_seconds()
                / 3600
                if last
                else None
            )
            if age_h is not None and age_h < args.max_age_hours:
                log.info("backup.skip", last_sweep_hours_ago=round(age_h, 1))
            else:
                log.warning("backup.running", last_sweep_hours_ago=age_h)
                await cmd_nightly(c)
        elif args.cmd == "scheduler":
            await cmd_scheduler(c)
    return 0


def main() -> None:
    sys.exit(asyncio.run(main_async(sys.argv[1:])))


if __name__ == "__main__":
    main()
