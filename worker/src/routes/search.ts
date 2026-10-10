import { Hono } from "hono";
import { type AppEnv, type Env, csv } from "../env";
import { addDays, daysBetween, isIsoDay, monthOf, yerevanToday } from "../lib/dates";
import { getDb, persistFares } from "../lib/db";
import { type Fare, type SearchItem, type SearchQuery, aggregate, bookingLink } from "../lib/fares";
import { bad, parseIata, parseInt0 } from "../lib/http";
import { pricesForDates } from "../lib/tp";

const MAX_NIGHTS = 30;
const MAX_AHEAD_DAYS = 330;
const CACHE_SECONDS = 600;
const DB_FRESH_DAYS = 3;
const MEMO_MAX = 50;

/**
 * Per-isolate memory cache. The Cache API has no effect on *.workers.dev, so this keeps repeated
 * searches cheap there; on a custom domain the edge cache below also applies.
 */
const memo = new Map<string, { at: number; body: unknown }>();
const memoGet = (k: string) => {
  const hit = memo.get(k);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_SECONDS * 1000) {
    memo.delete(k);
    return null;
  }
  return hit.body;
};
const memoPut = (k: string, body: unknown) => {
  if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value as string);
  memo.set(k, { at: Date.now(), body });
};

export const groundCosts = (env: Env): Record<string, number> => {
  try {
    return JSON.parse(env.GROUND_COST_USD || "{}");
  } catch {
    return {};
  }
};

export function parseSearch(params: Record<string, string | undefined>, env: Env, today = yerevanToday()): SearchQuery {
  const allowed = csv(env.ORIGINS);
  const origin = parseIata(params.origin ?? "EVN", allowed, "origin");
  const alts = csv(params.alt)
    .map((a) => parseIata(a, allowed, "alt"))
    .filter((a, i, all) => a !== origin && all.indexOf(a) === i);
  const dep = params.dep;
  const ret = params.ret;
  if (!isIsoDay(dep) || !isIsoDay(ret)) bad("Ամսաթվերը պետք է լինեն YYYY-MM-DD ձևաչափով");
  if (dep < today) bad("Մեկնման օրը չի կարող լինել անցյալում");
  if (daysBetween(today, dep) > MAX_AHEAD_DAYS) bad("Կարելի է որոնել մինչև 11 ամիս առաջ");
  const nights = daysBetween(dep, ret);
  if (nights < 1 || nights > MAX_NIGHTS) bad(`Ճամփորդությունը պետք է լինի 1-ից ${MAX_NIGHTS} գիշեր`);
  const flex = parseInt0(params.flex, 0, 3, 0);
  return { origin, alts, dep, ret, flex };
}

/**
 * Cheapest fare per origin and destination already in our DB inside the ±flex window.
 * The nightly sweep's month-level data does the heavy lifting, so the edge stays within its tiny CPU budget.
 */
async function windowFromDb(env: Env, q: SearchQuery): Promise<Fare[]> {
  const origins = [q.origin, ...q.alts];
  const db = getDb(env);
  const placeholders = origins.map(() => "?").join(",");
  const freshSince = new Date(Date.now() - DB_FRESH_DAYS * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const rs = await db.execute({
    sql: `SELECT origin, dest, dep_date, ret_date, MIN(price_usd) AS price_usd, airline, flight_number, transfers,
                 return_transfers, duration_min, link, source, market
          FROM fares_current
          WHERE origin IN (${placeholders}) AND dep_date BETWEEN ? AND ? AND ret_date BETWEEN ? AND ?
            AND updated_at >= ?
          GROUP BY origin, dest`,
    args: [
      ...origins,
      addDays(q.dep, -q.flex),
      addDays(q.dep, q.flex),
      addDays(q.ret, -q.flex),
      addDays(q.ret, q.flex),
      freshSince,
    ],
  });
  // Pair one-way tickets (out from home, back to home) into round trips the API never quoted as one ticket.
  const legs = await db.execute({
    sql: `SELECT o.origin AS origin, o.dest AS dest, o.dep_date AS dep_date, b.dep_date AS ret_date,
                 MIN(o.price_usd + b.price_usd) AS price_usd, o.airline AS airline, o.flight_number AS flight_number,
                 o.transfers AS transfers, b.transfers AS return_transfers, o.duration_min AS duration_min,
                 o.link AS link, 'combo' AS source, o.market AS market
          FROM fares_current o
          JOIN fares_current b ON b.origin = o.dest AND b.dest = o.origin AND b.ret_date IS NULL
          WHERE o.origin = ? AND o.ret_date IS NULL AND o.dep_date BETWEEN ? AND ?
            AND b.dep_date BETWEEN ? AND ? AND o.updated_at >= ? AND b.updated_at >= ?
          GROUP BY o.dest`,
    args: [
      q.origin,
      addDays(q.dep, -q.flex),
      addDays(q.dep, q.flex),
      addDays(q.ret, -q.flex),
      addDays(q.ret, q.flex),
      freshSince,
      freshSince,
    ],
  });
  return [...rs.rows, ...legs.rows].map((r) => ({
    origin: String(r.origin),
    dest: String(r.dest),
    dep_date: String(r.dep_date),
    ret_date: r.ret_date === null ? null : String(r.ret_date),
    price_usd: Number(r.price_usd),
    airline: r.airline === null ? null : String(r.airline),
    flight_number: r.flight_number === null ? null : String(r.flight_number),
    transfers: r.transfers === null ? null : Number(r.transfers),
    return_transfers: r.return_transfers === null ? null : Number(r.return_transfers),
    duration_min: r.duration_min === null ? null : Number(r.duration_min),
    link: r.link === null ? null : String(r.link),
    source: String(r.source),
    market: r.market === null ? null : String(r.market),
  }));
}

/** Typical cheapest price per destination for this departure month, from our own daily snapshots. */
async function referencePrices(env: Env, origin: string, month: string): Promise<Map<string, number>> {
  const rs = await getDb(env).execute({
    sql: `SELECT dest, AVG(min_usd) AS ref FROM route_daily_stats
          WHERE origin = ? AND dep_month = ? AND day >= date('now', '-60 days')
          GROUP BY dest HAVING COUNT(*) >= 3`,
    args: [origin, month],
  });
  return new Map(rs.rows.map((r) => [String(r.dest), Number(r.ref)]));
}

export function applyReference(items: SearchItem[], refs: Map<string, number>): SearchItem[] {
  for (const it of items) {
    const ref = refs.get(it.dest);
    if (!ref || !it.best) continue;
    it.ref_usd = Math.round(ref);
    it.deal_pct = Math.round(((ref - it.best.price_usd) / ref) * 100);
  }
  return items;
}

export const searchRoute = new Hono<AppEnv>().get("/", async (c) => {
  const env = c.env;
  const q = parseSearch(c.req.query(), env);

  // Results do not depend on who asks, so share a short edge cache between users.
  const cacheKey = new Request(
    `https://cache.trichq/search?o=${q.origin}&a=${q.alts.join(",")}&d=${q.dep}&r=${q.ret}&f=${q.flex}`,
  );
  const memoHit = memoGet(cacheKey.url) as Record<string, unknown> | null;
  if (memoHit) return c.json({ ...memoHit, meta: { ...(memoHit.meta as object), cached: true } });
  const cache = (caches as unknown as { default: Cache }).default;
  const hit = await cache.match(cacheKey);
  if (hit) {
    const body = (await hit.json()) as Record<string, unknown>;
    memoPut(cacheKey.url, body);
    return c.json({ ...body, meta: { ...(body.meta as object), cached: true } });
  }

  const markets = csv(env.TP_MARKETS).slice(0, 2);
  const marker = env.TRAVELPAYOUTS_MARKER ?? "";
  const liveCalls = [q.origin, ...q.alts].flatMap((origin) =>
    markets.map((market) =>
      pricesForDates({ origin, departure_at: q.dep, return_at: q.ret, market }, env.TRAVELPAYOUTS_TOKEN, marker),
    ),
  );
  const [live, fromDb, refs] = await Promise.all([
    Promise.allSettled(liveCalls),
    // Always ask the DB too: it covers the ±flex window and keeps search working if the live API is down.
    windowFromDb(env, q).catch(() => [] as Fare[]),
    referencePrices(env, q.origin, monthOf(q.dep)).catch(() => new Map<string, number>()),
  ]);
  const liveFares = live.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  const errors = live.filter((r) => r.status === "rejected").length;
  if (errors === live.length && fromDb.length === 0) {
    return c.json({ error: "Գների աղբյուրը հիմա չի պատասխանում։ Փորձիր մի քանի րոպեից։" }, 502);
  }

  // DB rows may carry links without our affiliate marker; normalise.
  for (const f of fromDb) f.link = bookingLink(f.link, marker);
  const items = applyReference(aggregate([...liveFares, ...fromDb], q, groundCosts(env)), refs);

  const body = {
    query: q,
    results: items,
    meta: { fetched_at: new Date().toISOString(), live: liveFares.length, db: fromDb.length, errors, cached: false },
  };
  memoPut(cacheKey.url, body);
  c.executionCtx.waitUntil(
    Promise.all([
      cache.put(cacheKey, new Response(JSON.stringify(body), { headers: { "Cache-Control": `max-age=${CACHE_SECONDS}` } })),
      liveFares.length ? persistFares(getDb(env), liveFares).catch((e) => console.error("persist failed", e)) : null,
    ]),
  );
  return c.json(body);
});
