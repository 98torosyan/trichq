"""Minimal Telegram Bot API client for sending alerts."""

from __future__ import annotations

import asyncio
from typing import Any

import httpx
import structlog

log = structlog.get_logger(__name__)


class TelegramError(RuntimeError):
    pass


class Telegram:
    def __init__(self, token: str, *, client: httpx.AsyncClient | None = None) -> None:
        if not token:
            raise TelegramError("TELEGRAM_BOT_TOKEN is not set")
        self._base = f"https://api.telegram.org/bot{token}"
        self._client = client or httpx.AsyncClient(timeout=20.0)

    async def close(self) -> None:
        await self._client.aclose()

    async def call(self, method: str, payload: dict[str, Any]) -> dict[str, Any]:
        for attempt in range(4):
            try:
                resp = await self._client.post(f"{self._base}/{method}", json=payload)
                data = resp.json()
            except httpx.TransportError as exc:
                if attempt < 3:
                    await asyncio.sleep(2 * (attempt + 1))
                    continue
                raise TelegramError(f"{method}: network error {exc}") from exc
            except ValueError as exc:  # HTML error page instead of JSON
                raise TelegramError(f"{method}: bad response {resp.status_code}") from exc
            if data.get("ok"):
                return data["result"]
            retry_after = (data.get("parameters") or {}).get("retry_after")
            if resp.status_code == 429 and retry_after and attempt < 3:
                log.warning("telegram.flood_wait", seconds=retry_after)
                await asyncio.sleep(float(retry_after) + 0.5)
                continue
            raise TelegramError(f"{method}: {data.get('description', data)}")
        raise TelegramError(f"{method}: too many retries")

    async def send_message(
        self,
        chat_id: int,
        text: str,
        *,
        button_text: str | None = None,
        webapp_url: str | None = None,
        url: str | None = None,
    ) -> int:
        payload: dict[str, Any] = {
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "HTML",
            "link_preview_options": {"is_disabled": True},
        }
        row: list[dict[str, Any]] = []
        if button_text and webapp_url:
            row.append({"text": button_text, "web_app": {"url": webapp_url}})
        if url:
            row.append({"text": "Ամրագրել ↗", "url": url})
        if row:
            payload["reply_markup"] = {"inline_keyboard": [row]}
        result = await self.call("sendMessage", payload)
        return int(result["message_id"])
