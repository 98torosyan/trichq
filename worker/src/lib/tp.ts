/** Travelpayouts / Aviasales Data API from the edge. Same endpoint and normalisation as the collector. */
import { type Fare, fareFromTp } from "./fares";

const BASE = "https://api.travelpayouts.com/aviasales/v3/prices_for_dates";

export interface TpQuery {
  origin: string;
  destination?: string;
  departure_at: string;
  return_at?: string;
  market: string;
}

export async function pricesForDates(q: TpQuery, token: string, marker = "", timeoutMs = 8000): Promise<Fare[]> {
  const url = new URL(BASE);
  url.searchParams.set("origin", q.origin);
  if (q.destination) url.searchParams.set("destination", q.destination);
  url.searchParams.set("departure_at", q.departure_at);
  if (q.return_at) url.searchParams.set("return_at", q.return_at);
  url.searchParams.set("one_way", q.return_at ? "false" : "true");
  url.searchParams.set("market", q.market);
  url.searchParams.set("currency", "usd");
  url.searchParams.set("sorting", "price");
  url.searchParams.set("limit", "1000");

  const resp = await fetch(url, {
    headers: { "X-Access-Token": token, "Accept-Encoding": "gzip" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) throw new Error(`travelpayouts ${resp.status}`);
  const body = (await resp.json()) as { success?: boolean; data?: unknown; error?: string };
  if (body.success === false) throw new Error(`travelpayouts: ${body.error ?? "error"}`);
  const items = Array.isArray(body.data) ? (body.data as Record<string, unknown>[]) : [];
  const fares: Fare[] = [];
  for (const it of items) {
    const f = fareFromTp(it, q.market, marker);
    if (f) fares.push(f);
  }
  return fares;
}
