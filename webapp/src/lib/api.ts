import { tg } from "./tg";

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

export interface SearchItem {
  dest: string;
  best: Offer | null;
  exact: boolean;
  flex_better: Offer | null;
  alt: (Offer & { ground_usd: number; effective_usd: number }) | null;
  ref_usd: number | null;
  deal_pct: number | null;
}

export interface SearchResponse {
  query: { origin: string; alts: string[]; dep: string; ret: string; flex: number };
  results: SearchItem[];
  meta: { fetched_at: string; live: number; db: number; errors: number; cached: boolean };
}

export interface Deal {
  kind: "drop" | "special" | "cheapest";
  origin: string;
  dest: string;
  dep_date: string;
  ret_date: string | null;
  price_usd: number;
  ref_usd: number | null;
  pct_below: number | null;
  airline: string | null;
  transfers: number | null;
  link: string | null;
  created_at: string;
}

export interface Watch {
  id: number;
  origin: string;
  dest: string;
  dep_date: string;
  ret_date: string | null;
  flex_days: number;
  target_usd: number;
  last_price_usd: number | null;
  last_checked_at: string | null;
  last_alert_price_usd: number | null;
}

export interface RouteDetail {
  origin: string;
  dest: string;
  dep: string;
  ret: string;
  grid: { offset: number; cells: (number | null)[][] };
  offers: (Offer & { dest: string })[];
  history: { day: string; min_usd: number; median_usd: number }[];
  changes: { observed_at: string; price_usd: number }[];
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (tg?.initData) headers.set("Authorization", `tma ${tg.initData}`);
  if (init.body) headers.set("content-type", "application/json");
  let resp: Response;
  try {
    resp = await fetch(path, { ...init, headers });
  } catch {
    throw new ApiError("Կապ չկա։ Ստուգիր ինտերնետը ու փորձիր նորից։", 0);
  }
  const data = (await resp.json().catch(() => ({}))) as { error?: string };
  if (!resp.ok) throw new ApiError(data.error ?? `Սխալ ${resp.status}`, resp.status);
  return data as T;
}

export const api = {
  search: (p: { origin: string; alts: string[]; dep: string; ret: string; flex: number }) =>
    request<SearchResponse>(
      `/api/search?${new URLSearchParams({ origin: p.origin, alt: p.alts.join(","), dep: p.dep, ret: p.ret, flex: String(p.flex) })}`,
    ),
  calendar: (origin: string, month: string, nights: number) =>
    request<{ days: Record<string, number> }>(`/api/calendar?${new URLSearchParams({ origin, month, nights: String(nights) })}`),
  deals: () => request<{ deals: Deal[] }>("/api/deals"),
  route: (origin: string, dest: string, dep: string, ret: string) =>
    request<RouteDetail>(`/api/route?${new URLSearchParams({ origin, dest, dep, ret })}`),
  watches: () => request<{ watches: Watch[] }>("/api/watches"),
  addWatch: (w: { origin: string; dest: string; dep_date: string; ret_date: string | null; flex_days: number; target_usd: number }) =>
    request<{ id: number; updated: boolean }>("/api/watches", { method: "POST", body: JSON.stringify(w) }),
  removeWatch: (id: number) => request<{ ok: true }>(`/api/watches/${id}`, { method: "DELETE" }),
};
