from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Annotated
from zoneinfo import ZoneInfo

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

IATA_LEN = 3
CsvList = Annotated[list[str], NoDecode]  # "EVN,LWN" in the environment, not JSON


class Settings(BaseSettings):
    """All runtime configuration comes from environment variables (or a local .env file)."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore", str_strip_whitespace=True)

    # Travelpayouts / Aviasales Data API
    travelpayouts_token: str = Field(default="", alias="TRAVELPAYOUTS_TOKEN")
    travelpayouts_marker: str = Field(default="", alias="TRAVELPAYOUTS_MARKER")
    tp_markets: CsvList = Field(default=["ru"], alias="TP_MARKETS")
    tp_requests_per_second: float = Field(default=4.0, alias="TP_RPS")

    # What we scan
    origins: CsvList = Field(default=["EVN", "LWN", "TBS", "KUT"], alias="ORIGINS")
    sweep_months: int = Field(default=6, ge=1, le=12, alias="SWEEP_MONTHS")
    sweep_max_pages: int = Field(default=3, ge=1, le=10, alias="SWEEP_MAX_PAGES")
    max_trip_nights: int = Field(default=30, alias="MAX_TRIP_NIGHTS")

    # Database: Turso in production, a local SQLite file for development and tests
    turso_url: str = Field(default="", alias="TURSO_URL")
    turso_token: str = Field(default="", alias="TURSO_TOKEN")
    sqlite_path: str = Field(default="data/trichq.db", alias="SQLITE_PATH")

    # Telegram
    telegram_bot_token: str = Field(default="", alias="TELEGRAM_BOT_TOKEN")
    webapp_url: str = Field(default="", alias="WEBAPP_URL")
    admin_chat_id: int | None = Field(default=None, alias="ADMIN_CHAT_ID")

    # Misc
    timezone: str = Field(default="Asia/Yerevan", alias="TZ")
    data_dir: Path = Field(default=Path("data"), alias="DATA_DIR")
    log_json: bool = Field(default=True, alias="LOG_JSON")

    @field_validator("tp_markets", "origins", mode="before")
    @classmethod
    def _split_csv(cls, v: object) -> object:
        if isinstance(v, str):
            return [p.strip() for p in v.split(",") if p.strip()]
        return v

    @field_validator("origins")
    @classmethod
    def _upper_iata(cls, v: list[str]) -> list[str]:
        out = [c.upper() for c in v]
        bad = [c for c in out if len(c) != IATA_LEN or not c.isalpha()]
        if bad:
            raise ValueError(f"not IATA codes: {bad}")
        return out

    @property
    def tz(self) -> ZoneInfo:
        return ZoneInfo(self.timezone)

    @property
    def uses_turso(self) -> bool:
        return bool(self.turso_url)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
