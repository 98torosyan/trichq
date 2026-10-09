from __future__ import annotations

from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo


def local_today(tz: ZoneInfo) -> date:
    return datetime.now(tz).date()


def month_str(d: date) -> str:
    return f"{d.year:04d}-{d.month:02d}"


def add_months(d: date, n: int) -> date:
    """First day of the month ``n`` months after ``d``'s month."""
    total = d.year * 12 + (d.month - 1) + n
    return date(total // 12, total % 12 + 1, 1)


def months_ahead(start: date, count: int) -> list[str]:
    return [month_str(add_months(start, i)) for i in range(count)]


def months_covering(start: date, end: date) -> list[str]:
    """All YYYY-MM strings touched by the closed interval [start, end]."""
    out: list[str] = []
    cur = date(start.year, start.month, 1)
    while cur <= end:
        out.append(month_str(cur))
        cur = add_months(cur, 1)
    return out


def date_window(center: date, flex: int) -> tuple[date, date]:
    return center - timedelta(days=flex), center + timedelta(days=flex)
