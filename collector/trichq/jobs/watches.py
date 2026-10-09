"""Re-check every active price watch and send a Telegram alert when a verified price hits the target."""

from __future__ import annotations

import html
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any
from urllib.parse import urlencode

import structlog

from trichq import repo
from trichq.config import Settings
from trichq.dates import date_window, local_today, months_covering
from trichq.db import Database
from trichq.models import Fare
from trichq.refdata import CityNames
from trichq.sources.travelpayouts import TravelpayoutsClient
from trichq.telegram import Telegram, TelegramError

log = structlog.get_logger(__name__)

REALERT_CHEAPER_BY = 0.03  # alert again only if the price fell at least 3% below the last alert
REALERT_COOLDOWN_H = 6  # ...and not more than once every 6 hours unless it fell 10%+
BIG_DROP = 0.10
FRESH_DB_HOURS = 12  # fares in our DB this recent count as live
MONTHS_HY = ["հունվ", "փետ", "մարտ", "ապր", "մայ", "հունիս", "հուլ", "օգոս", "սեպտ", "հոկտ", "նոյ", "դեկ"]


@dataclass(slots=True, frozen=True)
class Best:
    price_usd: float
    dep_date: str
    ret_date: str | None
    airline: str | None
    transfers: int | None
    link: str | None


def fmt_day(iso_day: str) -> str:
    d = date.fromisoformat(iso_day)
    return f"{MONTHS_HY[d.month - 1]} {d.day}"


def should_alert(watch: dict[str, Any], price: float, now: datetime) -> bool:
    if price > float(watch["target_usd"]):
        return False
    last_price = watch.get("last_alert_price_usd")
    if last_price is None:
        return True
    last_price = float(last_price)
    if price > last_price * (1 - REALERT_CHEAPER_BY):
        return False
    if price <= last_price * (1 - BIG_DROP):
        return True
    last_at = watch.get("last_alert_at")
    if not last_at:
        return True
    last_dt = datetime.fromisoformat(str(last_at).replace("Z", "+00:00"))
    return now - last_dt >= timedelta(hours=REALERT_COOLDOWN_H)


def in_window(f: Fare | dict[str, Any], dep_lo: str, dep_hi: str, ret_lo: str | None, ret_hi: str | None) -> bool:
    dep = f.dep_date if isinstance(f, Fare) else f["dep_date"]
    ret = f.ret_date if isinstance(f, Fare) else f["ret_date"]
    if not (dep_lo <= dep <= dep_hi):
        return False
    if ret_lo is None:
        return ret is None
    return ret is not None and ret_lo <= ret <= ret_hi  # type: ignore[operator]


async def best_price(db: Database, tp: TravelpayoutsClient, settings: Settings, w: dict[str, Any]) -> Best | None:
    flex = int(w["flex_days"])
    dep = date.fromisoformat(w["dep_date"])
    ret = date.fromisoformat(w["ret_date"]) if w["ret_date"] else None
    dep_lo, dep_hi = (d.isoformat() for d in date_window(dep, flex))
    ret_lo, ret_hi = (d.isoformat() for d in date_window(ret, flex)) if ret else (None, None)

    candidates: list[Best] = []
    # 1) Live from Aviasales: exact dates when flex is 0, otherwise the month(s) covering the window.
    if flex == 0:
        queries = [(w["dep_date"], w["ret_date"])]
    else:
        dep_months = months_covering(*date_window(dep, flex))
        ret_months = months_covering(*date_window(ret, flex)) if ret else [None]
        queries = [(dm, rm) for dm in dep_months for rm in ret_months]
    for dep_q, ret_q in queries:
        for market in settings.tp_markets:
            try:
                fares = await tp.prices_for_dates(
                    w["origin"],
                    destination=w["dest"],
                    departure_at=dep_q,
                    return_at=ret_q,
                    one_way=ret is None,
                    market=market,
                )
            except Exception as exc:
                log.warning("watch.fetch_failed", watch_id=w["id"], error=str(exc))
                continue
            await repo.upsert_fares(db, fares)
            candidates += [
                Best(f.price_usd, f.dep_date, f.ret_date, f.airline, f.transfers, f.link)
                for f in fares
                if in_window(f, dep_lo, dep_hi, ret_lo, ret_hi)
            ]
    # 2) Anything fresh in our own DB (e.g. found by a search in the mini app an hour ago).
    since = repo.iso(repo.utcnow() - timedelta(hours=FRESH_DB_HOURS))
    rows = await db.query(
        "SELECT * FROM fares_current WHERE origin = ? AND dest = ? AND dep_date BETWEEN ? AND ?" " AND updated_at >= ?",
        (w["origin"], w["dest"], dep_lo, dep_hi, since),
    )
    candidates += [
        Best(r["price_usd"], r["dep_date"], r["ret_date"], r["airline"], r["transfers"], r["link"])
        for r in rows
        if in_window(r, dep_lo, dep_hi, ret_lo, ret_hi)
    ]
    return min(candidates, key=lambda b: b.price_usd) if candidates else None


def alert_text(w: dict[str, Any], b: Best, city: CityNames) -> str:
    route = f"{html.escape(city(w['origin']))} → {html.escape(city(w['dest']))}"
    dates = fmt_day(b.dep_date) + (f" – {fmt_day(b.ret_date)}" if b.ret_date else "")
    stops = "ուղիղ" if (b.transfers or 0) == 0 else f"{b.transfers} կանգառ"
    parts = [
        "🔔 <b>Գինն իջավ</b>",
        f"<b>{route}</b>",
        f"{dates} · {stops}" + (f" · {html.escape(b.airline)}" if b.airline else ""),
        "",
        f"<b>{b.price_usd:.0f} USD</b> · թիրախդ՝ {float(w['target_usd']):.0f} USD",
    ]
    if w.get("last_alert_price_usd"):
        parts.append(f"Նախորդ ծանուցումը՝ {float(w['last_alert_price_usd']):.0f} USD")
    return "\n".join(parts)


def webapp_link(base: str, w: dict[str, Any], b: Best) -> str | None:
    if not base:
        return None
    q = {"o": w["origin"], "d": w["dest"], "dep": b.dep_date}
    if b.ret_date:
        q["ret"] = b.ret_date
    return f"{base.rstrip('/')}/?{urlencode(q)}"


async def run(
    db: Database, settings: Settings, tp: TravelpayoutsClient, tg: Telegram | None, city: CityNames
) -> dict[str, int]:
    today = local_today(settings.tz)
    await db.execute("UPDATE watches SET active = 0 WHERE active = 1 AND dep_date < ?", (today.isoformat(),))
    watches = await db.query("SELECT * FROM watches WHERE active = 1 ORDER BY id")
    checked = alerted = 0
    for w in watches:
        best = await best_price(db, tp, settings, w)
        now = repo.utcnow()
        checked += 1
        await db.execute(
            "UPDATE watches SET last_price_usd = ?, last_checked_at = ? WHERE id = ?",
            (best.price_usd if best else None, repo.iso(now), w["id"]),
        )
        if best is None or not should_alert(w, best.price_usd, now):
            continue
        if tg is None:
            log.info("watch.would_alert", watch_id=w["id"], price=best.price_usd)
            continue
        try:
            msg_id = await tg.send_message(
                int(w["tg_id"]),
                alert_text(w, best, city),
                button_text="Բացել Թռիչքում",
                webapp_url=webapp_link(settings.webapp_url, w, best),
                url=best.link,
            )
        except TelegramError as exc:
            log.warning("watch.alert_failed", watch_id=w["id"], error=str(exc))
            continue
        await db.batch(
            [
                (
                    "UPDATE watches SET last_alert_price_usd = ?, last_alert_at = ? WHERE id = ?",
                    (best.price_usd, repo.iso(now), w["id"]),
                ),
                (
                    "INSERT INTO alerts_sent (watch_id, price_usd, sent_at, tg_message_id) VALUES (?, ?, ?, ?)",
                    (w["id"], best.price_usd, repo.iso(now), msg_id),
                ),
            ]
        )
        alerted += 1
    result = {"checked": checked, "alerted": alerted}
    log.info("watches.done", **result)
    return result
