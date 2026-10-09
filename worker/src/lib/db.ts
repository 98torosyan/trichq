import { type Client, type InStatement, createClient } from "@libsql/client/web";
import type { Env } from "../env";
import { type Fare, fareKey } from "./fares";

export const getDb = (env: Env): Client => createClient({ url: env.TURSO_URL, authToken: env.TURSO_TOKEN });

const UPSERT = `
INSERT INTO fares_current (fare_key, origin, dest, dep_date, ret_date, price_usd, airline, flight_number,
                           transfers, return_transfers, duration_min, link, source, market, found_at,
                           first_seen_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
ON CONFLICT (fare_key) DO UPDATE SET
  price_usd = excluded.price_usd,
  transfers = COALESCE(excluded.transfers, fares_current.transfers),
  return_transfers = COALESCE(excluded.return_transfers, fares_current.return_transfers),
  duration_min = COALESCE(excluded.duration_min, fares_current.duration_min),
  link = COALESCE(excluded.link, fares_current.link),
  source = excluded.source, market = excluded.market, updated_at = excluded.updated_at`;

export const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

/** Store what a live search saw, so every search also grows our price history. */
export async function persistFares(db: Client, fares: Fare[], max = 600): Promise<number> {
  const best = new Map<string, Fare & { key: string }>();
  for (const f of fares) {
    const key = fareKey(f);
    const cur = best.get(key);
    if (!cur || f.price_usd < cur.price_usd) best.set(key, { ...f, key });
  }
  const rows = [...best.values()].sort((a, b) => a.price_usd - b.price_usd).slice(0, max);
  const stamp = nowIso();
  const stmts: InStatement[] = rows.map((f) => ({
    sql: UPSERT,
    args: [
      f.key, f.origin, f.dest, f.dep_date, f.ret_date, f.price_usd, f.airline, f.flight_number,
      f.transfers, f.return_transfers, f.duration_min, f.link, f.source, f.market, stamp, stamp,
    ],
  }));
  for (let i = 0; i < stmts.length; i += 200) await db.batch(stmts.slice(i, i + 200), "write");
  return rows.length;
}
