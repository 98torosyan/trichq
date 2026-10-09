import { Hono } from "hono";
import { type AppEnv, csv } from "../env";
import { daysBetween, isIsoDay, yerevanToday } from "../lib/dates";
import { getDb } from "../lib/db";
import { bad, parseIata } from "../lib/http";

const MAX_ACTIVE = 20;

interface WatchInput {
  origin?: string;
  dest?: string;
  dep_date?: string;
  ret_date?: string | null;
  flex_days?: number;
  target_usd?: number;
}

export const watchRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const user = c.get("user");
    const rs = await getDb(c.env).execute({
      sql: `SELECT id, origin, dest, dep_date, ret_date, flex_days, target_usd, last_price_usd, last_checked_at,
                   last_alert_price_usd, last_alert_at, created_at
            FROM watches WHERE tg_id = ? AND active = 1 ORDER BY dep_date`,
      args: [user.id],
    });
    return c.json({ watches: rs.rows });
  })

  .post("/", async (c) => {
    const user = c.get("user");
    const body = (await c.req.json().catch(() => ({}))) as WatchInput;
    const origin = parseIata(body.origin, csv(c.env.ORIGINS), "origin");
    const dest = parseIata(body.dest, [], "dest");
    const dep = body.dep_date;
    const ret = body.ret_date ?? null;
    if (!isIsoDay(dep) || dep < yerevanToday()) bad("Մեկնման օրը սխալ է");
    if (ret !== null && (!isIsoDay(ret) || daysBetween(dep, ret) < 1)) bad("Վերադարձի օրը սխալ է");
    const flex = Number(body.flex_days ?? 0);
    if (!Number.isInteger(flex) || flex < 0 || flex > 3) bad("Ճկունությունը՝ 0-ից 3 օր");
    const target = Number(body.target_usd);
    if (!Number.isFinite(target) || target < 10 || target > 20000) bad("Թիրախային գինը սխալ է");

    const db = getDb(c.env);
    const count = await db.execute({ sql: "SELECT COUNT(*) AS n FROM watches WHERE tg_id = ? AND active = 1", args: [user.id] });
    if (Number(count.rows[0]?.n ?? 0) >= MAX_ACTIVE) bad(`Կարող ես հետևել առավելագույնը ${MAX_ACTIVE} ուղղության`);

    const existing = await db.execute({
      sql: `SELECT id FROM watches WHERE tg_id = ? AND active = 1 AND origin = ? AND dest = ? AND dep_date = ?
              AND COALESCE(ret_date, '') = COALESCE(?, '')`,
      args: [user.id, origin, dest, dep, ret],
    });
    const found = existing.rows[0];
    if (found) {
      await db.execute({
        sql: "UPDATE watches SET target_usd = ?, flex_days = ? WHERE id = ?",
        args: [Math.round(target), flex, Number(found.id)],
      });
      return c.json({ id: Number(found.id), updated: true });
    }
    const ins = await db.execute({
      sql: `INSERT INTO watches (tg_id, origin, dest, dep_date, ret_date, flex_days, target_usd)
            VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      args: [user.id, origin, dest, dep, ret, flex, Math.round(target)],
    });
    return c.json({ id: Number(ins.rows[0]?.id), updated: false }, 201);
  })

  .delete("/:id", async (c) => {
    const user = c.get("user");
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) bad("Սխալ id");
    const rs = await getDb(c.env).execute({
      sql: "UPDATE watches SET active = 0 WHERE id = ? AND tg_id = ? AND active = 1",
      args: [id, user.id],
    });
    if (rs.rowsAffected === 0) return c.json({ error: "Չգտնվեց" }, 404);
    return c.json({ ok: true });
  });
