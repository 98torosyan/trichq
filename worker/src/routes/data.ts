/** Read-only data for the mini app: price calendar, deals feed, route detail. */
import { Hono } from "hono";
import { type AppEnv, csv } from "../env";
import { addDays, daysBetween, isIsoDay, monthsCovering, yerevanToday } from "../lib/dates";
import { getDb, persistFares } from "../lib/db";
import { type Fare } from "../lib/fares";
import { bad, parseIata, parseInt0 } from "../lib/http";
import { pricesForDates } from "../lib/tp";

const GRID = 3; // route detail shows departure and return ±3 days

export const dataRoutes = new Hono<AppEnv>()
  /** Cheapest round trip per departure day for a month: colours the date picker. */
  .get("/calendar", async (c) => {
    const origin = parseIata(c.req.query("origin") ?? "EVN", csv(c.env.ORIGINS), "origin");
    const month = c.req.query("month") ?? "";
    if (!/^\d{4}-\d{2}$/.test(month)) bad("«month» պետք է լինի YYYY-MM");
    const nights = parseInt0(c.req.query("nights"), 1, 30, 4);
    const rs = await getDb(c.env).execute({
      sql: `SELECT dep_date, MIN(price_usd) AS price FROM fares_current
            WHERE origin = ? AND dep_date LIKE ? AND ret_date IS NOT NULL AND dep_date >= ?
              AND julianday(ret_date) - julianday(dep_date) BETWEEN ? AND ?
            GROUP BY dep_date`,
      args: [origin, `${month}-%`, yerevanToday(), Math.max(1, nights - 2), nights + 2],
    });
    const days: Record<string, number> = {};
    for (const r of rs.rows) days[String(r.dep_date)] = Math.round(Number(r.price));
    c.header("Cache-Control", "private, max-age=600");
    return c.json({ origin, month, nights, days });
  })

  /** Deals feed: drops against our own history first, then special offers, then cheapest per destination. */
  .get("/deals", async (c) => {
    const origins = csv(c.req.query("origins") ?? c.env.ORIGINS).map((o) => parseIata(o, csv(c.env.ORIGINS), "origins"));
    const placeholders = origins.map(() => "?").join(",");
    const rs = await getDb(c.env).execute({
      sql: `SELECT kind, origin, dest, dep_date, NULLIF(ret_date, '') AS ret_date, price_usd, ref_usd, pct_below,
                   airline, transfers, link, created_at
            FROM deals WHERE origin IN (${placeholders}) AND expires_at > ? AND dep_date >= ?
            ORDER BY CASE kind WHEN 'drop' THEN 0 WHEN 'special' THEN 1 ELSE 2 END,
                     COALESCE(pct_below, 0) DESC, price_usd ASC
            LIMIT 80`,
      args: [...origins, new Date().toISOString(), yerevanToday()],
    });
    c.header("Cache-Control", "private, max-age=300");
    return c.json({ deals: rs.rows });
  })

  /** One destination in depth: a ±3 day price grid (live) and our price history for that month. */
  .get("/route", async (c) => {
    const allowed = csv(c.env.ORIGINS);
    const origin = parseIata(c.req.query("origin"), allowed, "origin");
    const dest = parseIata(c.req.query("dest"), [], "dest");
    const dep = c.req.query("dep");
    const ret = c.req.query("ret");
    if (!isIsoDay(dep) || !isIsoDay(ret) || daysBetween(dep, ret) < 1) bad("Սխալ ամսաթվեր");

    const depMonths = monthsCovering(addDays(dep, -GRID), addDays(dep, GRID));
    const retMonths = monthsCovering(addDays(ret, -GRID), addDays(ret, GRID));
    const market = csv(c.env.TP_MARKETS)[0] ?? "ru";
    const marker = c.env.TRAVELPAYOUTS_MARKER ?? "";
    const calls = depMonths.flatMap((dm) =>
      retMonths.map((rm) =>
        pricesForDates({ origin, destination: dest, departure_at: dm, return_at: rm, market }, c.env.TRAVELPAYOUTS_TOKEN, marker),
      ),
    );
    const db = getDb(c.env);
    const [live, history, changes] = await Promise.all([
      Promise.allSettled(calls),
      db.execute({
        sql: `SELECT day, min_usd, median_usd FROM route_daily_stats
              WHERE origin = ? AND dest = ? AND dep_month = ? AND day >= date('now', '-90 days') ORDER BY day`,
        args: [origin, dest, dep.slice(0, 7)],
      }),
      db.execute({
        sql: `SELECT observed_at, MIN(price_usd) AS price_usd FROM fare_observations
              WHERE origin = ? AND dest = ? AND dep_date = ? AND ret_date = ?
              GROUP BY substr(observed_at, 1, 10) ORDER BY observed_at`,
        args: [origin, dest, dep, ret],
      }),
    ]);
    const fares: Fare[] = live.flatMap((r) => (r.status === "fulfilled" ? r.value : []));

    // grid[d][r] = cheapest price departing dep+d and returning ret+r
    const grid: (number | null)[][] = [];
    for (let d = -GRID; d <= GRID; d++) {
      const row: (number | null)[] = [];
      for (let r = -GRID; r <= GRID; r++) {
        const dd = addDays(dep, d);
        const rr = addDays(ret, r);
        let best: number | null = null;
        if (daysBetween(dd, rr) >= 1) {
          for (const f of fares) if (f.dep_date === dd && f.ret_date === rr && (best === null || f.price_usd < best)) best = f.price_usd;
        }
        row.push(best === null ? null : Math.round(best));
      }
      grid.push(row);
    }
    const exact = fares
      .filter((f) => f.dep_date === dep && f.ret_date === ret)
      .sort((a, b) => a.price_usd - b.price_usd)
      .slice(0, 5);
    if (fares.length) c.executionCtx.waitUntil(persistFares(db, fares).catch((e) => console.error("persist failed", e)));
    return c.json({
      origin,
      dest,
      dep,
      ret,
      grid: { offset: GRID, cells: grid },
      offers: exact,
      history: history.rows,
      changes: changes.rows,
    });
  });
