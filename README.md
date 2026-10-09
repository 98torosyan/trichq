# Թռիչք · Trichq

Telegram mini app that finds the cheapest round-trip flights from Armenia (Yerevan, Gyumri, and via Tbilisi / Kutaisi) to everywhere, for the dates you pick. It keeps its own price history, flags real deals and sends Telegram alerts when a watched price drops.

Budget: **0 USD** — Oracle Cloud Always Free, Cloudflare Workers free, Turso free, GitHub Actions.

## Architecture

```
 Oracle VM (Docker, 24/7)                        Cloudflare Worker (free)                 Telegram
 ┌───────────────────────────────┐               ┌──────────────────────────────┐         ┌──────────┐
 │ collector/  (Python 3.12)     │   Turso DB    │ worker/  (TypeScript, Hono)  │  HTTPS  │ Mini app │
 │  00:40 sweep → stats → deals  │ ───────────►  │  /api/search  live + DB      │ ◄─────► │ (React)  │
 │  5×/day price-watch alerts ───┼──── Bot API ──┼─ /telegram/webhook  bot      │         │  + bot   │
 └───────────────────────────────┘               │  static webapp/dist          │         └──────────┘
        ▲ backup if the VM misses a night        │  07:00 cron health check     │
 GitHub Actions (backup-collector.yml)           └──────────────────────────────┘
```

| Part | What it does |
| --- | --- |
| `db/migrations` | SQLite/libSQL schema. Price history is change-only: a trigger records a row only when a price is new or changes. |
| `collector/` | Nightly sweep of every origin × next 6 months (Aviasales Data API), daily route snapshots, deals feed (drops vs our own history, special offers, cheapest per destination), price-watch alerts. |
| `worker/` | Authenticated API for the mini app (Telegram `initData` HMAC + allow-list), Telegram webhook, serves the mini app. Heavy work stays in the DB so the edge stays inside the free CPU budget. |
| `webapp/` | React + Framer Motion mini app: animated route map, departure-board search, boarding-pass results, ±3-day price grid, price history, deals, watches. Follows Telegram's light/dark theme. |

## Data sources (all free)

- **Aviasales Data API** (Travelpayouts) — prices, cached from real searches (48 h). Main source.
- **Travelpayouts data JSON** — Armenian city and country names (`/data/hy/`), airlines.
- **Passport Index data** (`imorte/passport-index-data`, MIT) — visa rules for Armenian passports.
- Planned (phases 2–4, see the plan doc): Google Flights verification, Wizz Air fare charts, Telegram deal channels + Gemini/Groq parsing.

## Setup

GitHub → Settings → Secrets and variables → Actions → add:

| Secret | Where to get it |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | [@BotFather](https://t.me/BotFather) → `/newbot` |
| `BOT_WEBHOOK_SECRET` | any long random string (letters/digits) |
| `ALLOWED_USER_IDS` | comma-separated Telegram ids, from [@userinfobot](https://t.me/userinfobot) |
| `ADMIN_CHAT_ID` | your own Telegram id (gets failure alerts) |
| `TRAVELPAYOUTS_TOKEN` | [app.travelpayouts.com](https://app.travelpayouts.com/) → Profile → API token |
| `TRAVELPAYOUTS_MARKER` | optional, your affiliate marker |
| `TURSO_URL`, `TURSO_TOKEN` | [app.turso.tech](https://app.turso.tech/) → database → URL / Create token |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | [API tokens](https://dash.cloudflare.com/profile/api-tokens) → "Edit Cloudflare Workers" template |
| `ORACLE_HOST`, `ORACLE_SSH_KEY` | VM public IP and the private key file saved when creating it |
| `ORACLE_HOST_KEY` | optional: the VM's SSH host key (`ssh-ed25519 AAAA…`) to pin it |

Also add a repository **variable** `WEBAPP_URL` = your Worker address (e.g. `https://trichq.<name>.workers.dev`) after the first deploy; the backup collector uses it for alert buttons.

Before the first deploy, open **Workers & Pages** in the Cloudflare dashboard once so your free `*.workers.dev` subdomain exists. Then push to `main` (or run **Deploy** manually): migrations run, the mini app and Worker deploy, the bot gets its webhook and menu button, and the collector starts on the VM.

## Local development

```bash
# collector
cd collector && python -m venv .venv && . .venv/bin/activate && pip install -e ".[dev]"
pytest && ruff check .
python -m trichq migrate && python -m trichq nightly       # uses data/trichq.db unless TURSO_URL is set

# worker + mini app
cd worker && npm ci && npm test && cp .dev.vars.example .dev.vars && npx wrangler dev
cd webapp && npm ci && npm run dev                          # proxies /api to wrangler dev
```

## Honest limits

- Aviasales prices are cached from other people's searches: rare dates can be missing or stale. Every card links to the live booking page; check the price there.
- Phase 1 alerts use Aviasales + our own DB. Independent verification (Google Flights) arrives in phase 2.
- Electricity-free does not mean risk-free: Oracle may reclaim idle Always Free VMs; the GitHub backup sweep and the 07:00 health alert cover that.
