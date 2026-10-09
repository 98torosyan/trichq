"""Tiny database layer with two interchangeable backends.

* ``SqliteDB`` - a local file, used in development and tests.
* ``TursoDB`` - Turso / libSQL over its HTTP "pipeline" API (no native driver needed).

Both speak plain SQLite SQL with ``?`` placeholders and return rows as dicts.
"""

from __future__ import annotations

import asyncio
import sqlite3
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import Any, Protocol

import httpx
from tenacity import AsyncRetrying, retry_if_exception, stop_after_attempt, wait_exponential_jitter

Row = dict[str, Any]
Params = Sequence[Any]
Statement = tuple[str, Params]


class Database(Protocol):
    async def query(self, sql: str, params: Params = ()) -> list[Row]: ...
    async def execute(self, sql: str, params: Params = ()) -> int: ...
    async def batch(self, statements: Iterable[Statement]) -> None: ...
    async def executescript(self, script: str) -> None: ...
    async def close(self) -> None: ...


# --------------------------------------------------------------------------- SQLite


class SqliteDB:
    def __init__(self, path: str | Path) -> None:
        path = Path(path)
        if str(path) != ":memory:":
            path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._lock = asyncio.Lock()

    async def query(self, sql: str, params: Params = ()) -> list[Row]:
        async with self._lock:
            return [dict(r) for r in self._conn.execute(sql, tuple(params)).fetchall()]

    async def execute(self, sql: str, params: Params = ()) -> int:
        async with self._lock:
            return self._conn.execute(sql, tuple(params)).rowcount

    async def batch(self, statements: Iterable[Statement]) -> None:
        async with self._lock:
            cur = self._conn.cursor()
            cur.execute("BEGIN")
            try:
                for sql, params in statements:
                    cur.execute(sql, tuple(params))
                cur.execute("COMMIT")
            except Exception:
                cur.execute("ROLLBACK")
                raise

    async def executescript(self, script: str) -> None:
        async with self._lock:
            self._conn.executescript(script)

    async def close(self) -> None:
        self._conn.close()


# --------------------------------------------------------------------------- Turso


class TursoError(RuntimeError):
    pass


def _to_value(v: Any) -> dict[str, Any]:
    if v is None:
        return {"type": "null"}
    if isinstance(v, bool):
        return {"type": "integer", "value": str(int(v))}
    if isinstance(v, int):
        return {"type": "integer", "value": str(v)}
    if isinstance(v, float):
        return {"type": "float", "value": v}
    return {"type": "text", "value": str(v)}


def _from_value(v: dict[str, Any]) -> Any:
    t = v.get("type")
    if t == "null":
        return None
    if t == "integer":
        return int(v["value"])
    if t == "float":
        return float(v["value"])
    return v.get("value")


def _retryable(exc: BaseException) -> bool:
    if isinstance(exc, httpx.TransportError):
        return True
    return isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code in (429, 500, 502, 503, 504)


class TursoDB:
    def __init__(self, url: str, token: str, *, timeout: float = 30.0) -> None:
        base = url.replace("libsql://", "https://").rstrip("/")
        self._endpoint = f"{base}/v2/pipeline"
        self._client = httpx.AsyncClient(timeout=timeout, headers={"Authorization": f"Bearer {token}"}, http2=False)

    async def _pipeline(self, statements: Sequence[Statement]) -> list[dict[str, Any]]:
        requests: list[dict[str, Any]] = [
            {"type": "execute", "stmt": {"sql": sql, "args": [_to_value(p) for p in params]}}
            for sql, params in statements
        ]
        requests.append({"type": "close"})
        async for attempt in AsyncRetrying(
            stop=stop_after_attempt(4),
            wait=wait_exponential_jitter(initial=1, max=15),
            retry=retry_if_exception(_retryable),
            reraise=True,
        ):
            with attempt:
                resp = await self._client.post(self._endpoint, json={"requests": requests})
                resp.raise_for_status()
        results = resp.json()["results"]
        out: list[dict[str, Any]] = []
        for i, res in enumerate(results[: len(statements)]):
            if res.get("type") != "ok":
                err = res.get("error", {}).get("message", res)
                raise TursoError(f"statement {i} failed: {err} :: {statements[i][0][:120]}")
            out.append(res["response"]["result"])
        return out

    async def query(self, sql: str, params: Params = ()) -> list[Row]:
        (result,) = await self._pipeline([(sql, params)])
        cols = [c["name"] for c in result["cols"]]
        return [dict(zip(cols, (_from_value(v) for v in row), strict=True)) for row in result["rows"]]

    async def execute(self, sql: str, params: Params = ()) -> int:
        (result,) = await self._pipeline([(sql, params)])
        return int(result.get("affected_row_count", 0))

    async def batch(self, statements: Iterable[Statement]) -> None:
        """Run statements atomically in one round-trip using a Hrana conditional batch.

        Each step only runs if the previous one succeeded; if anything fails the
        transaction is rolled back, so a failure never leaves half-written data.
        """
        stmts = [("BEGIN", ()), *statements, ("COMMIT", ())]
        if len(stmts) == 2:
            return
        steps: list[dict[str, Any]] = []
        for i, (sql, params) in enumerate(stmts):
            step: dict[str, Any] = {"stmt": {"sql": sql, "args": [_to_value(p) for p in params]}}
            if i > 0:
                step["condition"] = {"type": "ok", "step": i - 1}
            steps.append(step)
        commit_idx = len(stmts) - 1
        steps.append(
            {
                "stmt": {"sql": "ROLLBACK", "args": []},
                "condition": {"type": "not", "cond": {"type": "ok", "step": commit_idx}},
            }
        )
        body = {"requests": [{"type": "batch", "batch": {"steps": steps}}, {"type": "close"}]}
        async for attempt in AsyncRetrying(
            stop=stop_after_attempt(4),
            wait=wait_exponential_jitter(initial=1, max=15),
            retry=retry_if_exception(_retryable),
            reraise=True,
        ):
            with attempt:
                resp = await self._client.post(self._endpoint, json=body)
                resp.raise_for_status()
        res = resp.json()["results"][0]
        if res.get("type") != "ok":
            raise TursoError(f"batch failed: {res.get('error', res)}")
        errors = res["response"]["result"].get("step_errors", [])
        for i, err in enumerate(errors[: commit_idx + 1]):
            if err:
                sql = stmts[i][0][:120]
                raise TursoError(f"batch step {i} failed: {err.get('message', err)} :: {sql}")

    async def executescript(self, script: str) -> None:
        await self.batch((s, ()) for s in split_sql(script))

    async def close(self) -> None:
        await self._client.aclose()


def split_sql(script: str) -> list[str]:
    """Split a migration file into statements, keeping CREATE TRIGGER ... END; blocks intact."""
    statements: list[str] = []
    buf: list[str] = []
    in_trigger = False
    for raw in script.splitlines():
        line = raw.split("--", 1)[0].rstrip() if not in_trigger else raw.rstrip()
        if not line.strip():
            continue
        buf.append(line)
        upper = line.strip().upper()
        if upper.startswith("CREATE TRIGGER"):
            in_trigger = True
        if in_trigger:
            if upper == "END;":
                statements.append("\n".join(buf).rstrip(";"))
                buf, in_trigger = [], False
        elif line.rstrip().endswith(";"):
            statements.append("\n".join(buf).rstrip(";"))
            buf = []
    if buf:
        statements.append("\n".join(buf))
    return [s for s in (st.strip() for st in statements) if s]


def open_db(settings: Any) -> Database:
    if settings.uses_turso:
        return TursoDB(settings.turso_url, settings.turso_token)
    return SqliteDB(settings.sqlite_path)
