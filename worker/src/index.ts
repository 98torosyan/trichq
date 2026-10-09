import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { type AppEnv, type Env, csv } from "./env";
import { validateInitData } from "./lib/auth";
import { getDb, nowIso } from "./lib/db";
import { tgCall } from "./lib/telegram";
import { botRoutes } from "./routes/bot";
import { dataRoutes } from "./routes/data";
import { searchRoute } from "./routes/search";
import { watchRoutes } from "./routes/watches";

const app = new Hono<AppEnv>();

app.use("*", secureHeaders({ xFrameOptions: false, contentSecurityPolicy: undefined }));

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  console.error("unhandled", err);
  return c.json({ error: "Ներքին սխալ։ Փորձիր նորից։" }, 500);
});

app.get("/api/health", (c) => c.json({ ok: true, time: new Date().toISOString() }));

app.route("/telegram", botRoutes);

// ---------------------------------------------------------------- authenticated API
app.use("/api/*", async (c, next) => {
  if (c.env.DEV_AUTH_BYPASS === "1") {
    c.set("user", { id: 1, first_name: "Dev" });
    return next();
  }
  const header = c.req.header("Authorization") ?? "";
  const initData = header.startsWith("tma ") ? header.slice(4) : "";
  const auth = await validateInitData(initData, c.env.TELEGRAM_BOT_TOKEN);
  if (!auth.ok) return c.json({ error: "Բացիր հավելվածը Telegram-ի միջոցով", reason: auth.reason }, 401);
  if (!csv(c.env.ALLOWED_USER_IDS).includes(String(auth.user.id))) {
    return c.json({ error: "Այս հավելվածը մասնավոր է", user_id: auth.user.id }, 403);
  }
  c.set("user", auth.user);
  // Keep the users table current without slowing the request down.
  c.executionCtx.waitUntil(
    getDb(c.env)
      .execute({
        sql: `INSERT INTO users (tg_id, first_name, username, lang, last_seen_at) VALUES (?, ?, ?, 'hy', ?)
              ON CONFLICT (tg_id) DO UPDATE SET first_name = excluded.first_name, username = excluded.username,
                                                last_seen_at = excluded.last_seen_at`,
        args: [auth.user.id, auth.user.first_name ?? null, auth.user.username ?? null, nowIso()],
      })
      .catch((e) => console.error("user upsert failed", e)),
  );
  return next();
});

app.get("/api/me", (c) => c.json({ user: c.get("user") }));
app.route("/api/search", searchRoute);
app.route("/api/watches", watchRoutes);
app.route("/api", dataRoutes);
app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

// ---------------------------------------------------------------- the mini app itself
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

// ---------------------------------------------------------------- daily health check (cron)
const SWEEP_MAX_AGE_H = 26;

async function healthCheck(env: Env): Promise<void> {
  if (!env.ADMIN_CHAT_ID || !env.TELEGRAM_BOT_TOKEN) return;
  const rs = await getDb(env).execute(
    "SELECT status, started_at, rows_seen, notes FROM scrape_runs WHERE job = 'sweep' ORDER BY id DESC LIMIT 1",
  );
  const last = rs.rows[0];
  const ageH = last ? (Date.now() - Date.parse(String(last.started_at))) / 3_600_000 : Infinity;
  let problem: string | null = null;
  if (!last) problem = "Գիշերային հավաքումը դեռ երբեք չի աշխատել։";
  else if (ageH > SWEEP_MAX_AGE_H) problem = `Վերջին հավաքումը եղել է ${Math.round(ageH)} ժամ առաջ։ Սերվերը կարող է անջատված լինել։`;
  else if (last.status !== "ok") problem = `Վերջին հավաքման կարգավիճակը՝ ${last.status} (${last.rows_seen} գին)։ ${last.notes ?? ""}`;
  if (problem) {
    await tgCall(env.TELEGRAM_BOT_TOKEN, "sendMessage", {
      chat_id: Number(env.ADMIN_CHAT_ID),
      text: `⚠️ Թռիչք · առողջության ստուգում\n${problem}`,
    });
  }
}

export default {
  fetch: app.fetch,
  scheduled: (_event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(healthCheck(env).catch((e) => console.error("health check failed", e)));
  },
} satisfies ExportedHandler<Env>;

export { app };
