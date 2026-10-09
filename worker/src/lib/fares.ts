import { daysBetween } from "./dates";

export interface Fare {
  origin: string;
  dest: string;
  dep_date: string;
  ret_date: string | null;
  price_usd: number;
  airline: string | null;
  flight_number: string | null;
  transfers: number | null;
  return_transfers: number | null;
  duration_min: number | null;
  link: string | null;
  source: string;
  market: string | null;
}

const AVIASALES = "https://www.aviasales.com";

/** "origin|dest|dep|ret|airline|flight". Must match collector/trichq/models.py::fare_key exactly. */
export const fareKey = (f: Pick<Fare, "origin" | "dest" | "dep_date" | "ret_date" | "airline" | "flight_number">) =>
  [f.origin, f.dest, f.dep_date, f.ret_date ?? "", f.airline ?? "", f.flight_number ?? ""].join("|");

export function bookingLink(path: unknown, marker = ""): string | null {
  if (typeof path !== "string" || !path) return null;
  let url = path.startsWith("http") ? path : `${AVIASALES}${path}`;
  if (marker && !url.includes("marker=")) url += `${url.includes("?") ? "&" : "?"}marker=${encodeURIComponent(marker)}`;
  return url;
}

const intOrNull = (v: unknown): number | null => {
  const n = Number(v);
  return v === null || v === undefined || v === "" || !Number.isFinite(n) ? null : Math.trunc(n);
};

/** Normalise one Aviasales Data API item (prices_for_dates). Returns null for unusable rows. */
export function fareFromTp(item: Record<string, unknown>, market: string | null, marker = ""): Fare | null {
  const origin = String(item.origin ?? "").toUpperCase();
  const dest = String(item.destination ?? "").toUpperCase();
  const dep = String(item.departure_at ?? "").slice(0, 10);
  const ret = item.return_at ? String(item.return_at).slice(0, 10) : null;
  const price = Number(item.price);
  if (origin.length !== 3 || dest.length !== 3 || origin === dest) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dep) || (ret !== null && !/^\d{4}-\d{2}-\d{2}$/.test(ret))) return null;
  if (!Number.isFinite(price) || price <= 0) return null;
  const flight = item.flight_number;
  return {
    origin,
    dest,
    dep_date: dep,
    ret_date: ret,
    price_usd: Math.round(price * 100) / 100,
    airline: typeof item.airline === "string" && item.airline ? item.airline : null,
    flight_number: flight === null || flight === undefined || flight === "" ? null : String(flight),
    transfers: intOrNull(item.transfers),
    return_transfers: intOrNull(item.return_transfers),
    duration_min: intOrNull(item.duration),
    link: bookingLink(item.link, marker),
    source: "aviasales",
    market,
  };
}

// --------------------------------------------------------------------------- search aggregation

export interface Offer {
  origin: string;
  dep_date: string;
  ret_date: string | null;
  price_usd: number;
  airline: string | null;
  transfers: number | null;
  return_transfers: number | null;
  duration_min: number | null;
  link: string | null;
}

export interface AltOffer extends Offer {
  ground_usd: number;
  effective_usd: number;
}

export interface SearchItem {
  dest: string;
  /** Best offer from the chosen origin: exact dates when available, otherwise the best inside the flex window. */
  best: Offer | null;
  exact: boolean;
  /** A noticeably cheaper option within ±flex days, when the exact dates are not the cheapest. */
  flex_better: Offer | null;
  /** Cheaper once ground transport is added, from an alternative airport (Gyumri, Tbilisi, Kutaisi). */
  alt: AltOffer | null;
  ref_usd: number | null;
  deal_pct: number | null;
}

export interface SearchQuery {
  origin: string;
  alts: string[];
  dep: string;
  ret: string;
  flex: number;
}

const FLEX_BETTER_RATIO = 0.95;
const ALT_MIN_SAVING_USD = 10;

const toOffer = (f: Fare): Offer => ({
  origin: f.origin,
  dep_date: f.dep_date,
  ret_date: f.ret_date,
  price_usd: f.price_usd,
  airline: f.airline,
  transfers: f.transfers,
  return_transfers: f.return_transfers,
  duration_min: f.duration_min,
  link: f.link,
});

export function inWindow(f: Fare, q: SearchQuery): boolean {
  if (!f.ret_date) return false;
  const d = daysBetween(q.dep, f.dep_date);
  const r = daysBetween(q.ret, f.ret_date);
  return Math.abs(d) <= q.flex && Math.abs(r) <= q.flex && daysBetween(f.dep_date, f.ret_date) >= 1;
}

const cheaper = (a: Fare | undefined, b: Fare) => (!a || b.price_usd < a.price_usd ? b : a);

/** Turn raw fares from every origin into one row per destination, cheapest first. */
export function aggregate(fares: Fare[], q: SearchQuery, groundCost: Record<string, number>): SearchItem[] {
  type Acc = { exact?: Fare; window?: Fare; alt?: Fare; altEff?: number };
  const byDest = new Map<string, Acc>();
  for (const f of fares) {
    if (!inWindow(f, q)) continue;
    const acc = byDest.get(f.dest) ?? {};
    if (f.origin === q.origin) {
      if (f.dep_date === q.dep && f.ret_date === q.ret) acc.exact = cheaper(acc.exact, f);
      acc.window = cheaper(acc.window, f);
    } else if (q.alts.includes(f.origin)) {
      const eff = f.price_usd + (groundCost[f.origin] ?? 0);
      if (acc.altEff === undefined || eff < acc.altEff) {
        acc.alt = f;
        acc.altEff = eff;
      }
    }
    byDest.set(f.dest, acc);
  }

  const items: SearchItem[] = [];
  for (const [dest, acc] of byDest) {
    if (dest === q.origin) continue;
    const primary = acc.exact ?? acc.window;
    const flexBetter =
      acc.exact && acc.window && acc.window !== acc.exact && acc.window.price_usd <= acc.exact.price_usd * FLEX_BETTER_RATIO
        ? toOffer(acc.window)
        : null;
    let alt: AltOffer | null = null;
    if (acc.alt && acc.altEff !== undefined) {
      const reference = primary?.price_usd ?? Infinity;
      if (acc.altEff <= reference - ALT_MIN_SAVING_USD) {
        alt = { ...toOffer(acc.alt), ground_usd: groundCost[acc.alt.origin] ?? 0, effective_usd: acc.altEff };
      }
    }
    if (!primary && !alt) continue;
    items.push({
      dest,
      best: primary ? toOffer(primary) : null,
      exact: Boolean(acc.exact),
      flex_better: flexBetter,
      alt,
      ref_usd: null,
      deal_pct: null,
    });
  }
  const sortPrice = (i: SearchItem) => Math.min(i.best?.price_usd ?? Infinity, i.alt?.effective_usd ?? Infinity);
  return items.sort((a, b) => sortPrice(a) - sortPrice(b));
}
