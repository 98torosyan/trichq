export interface Env {
  ASSETS: Fetcher;

  TELEGRAM_BOT_TOKEN: string;
  BOT_WEBHOOK_SECRET: string;
  TRAVELPAYOUTS_TOKEN: string;
  TRAVELPAYOUTS_MARKER?: string;
  TURSO_URL: string;
  TURSO_TOKEN: string;
  /** Comma-separated Telegram user ids allowed to use the app. Empty = nobody. */
  ALLOWED_USER_IDS: string;
  ADMIN_CHAT_ID?: string;
  WEBAPP_URL?: string;

  TP_MARKETS: string;
  ORIGINS: string;
  GROUND_COST_USD: string;
  /** "1" only for local development: skips Telegram auth and acts as user 1. */
  DEV_AUTH_BYPASS?: string;
}

export interface TgUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export type AppEnv = { Bindings: Env; Variables: { user: TgUser } };

export const csv = (v: string | undefined): string[] =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
