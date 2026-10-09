"""Apply db/migrations/*.sql in order, once each. Safe to run on every deploy."""

from __future__ import annotations

import os
from pathlib import Path

import structlog

from trichq import repo
from trichq.db import Database, split_sql

log = structlog.get_logger(__name__)


def migrations_dir() -> Path:
    env = os.environ.get("MIGRATIONS_DIR")
    candidates = [Path(env)] if env else []
    here = Path(__file__).resolve()
    candidates += [here.parents[2] / "db" / "migrations", Path("/app/migrations")]
    for c in candidates:
        if c.is_dir():
            return c
    raise FileNotFoundError(f"no migrations directory among {candidates}")


async def run(db: Database, directory: Path | None = None) -> list[str]:
    directory = directory or migrations_dir()
    await db.execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)"
    )
    done = {r["version"] for r in await db.query("SELECT version FROM schema_migrations")}
    applied: list[str] = []
    for path in sorted(directory.glob("*.sql")):
        version = path.stem
        if version in done:
            continue
        statements = [(s, ()) for s in split_sql(path.read_text(encoding="utf-8"))]
        statements.append(
            (
                "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)",
                (version, repo.iso(repo.utcnow())),
            )
        )
        await db.batch(statements)
        applied.append(version)
        log.info("migrate.applied", version=version, statements=len(statements) - 1)
    if not applied:
        log.info("migrate.up_to_date")
    return applied
