import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signInitData } from "../src/lib/auth";

// ---- fake Turso: records statements and answers by SQL prefix
const executed: { sql: string; args: unknown[] }[] = [];
const batches: unknown[][] = [];
vi.mock("../src/lib/db", async (orig) => {
  const real = await orig<typeof import("../src/lib/db")>();
  const client = {
    execute: async (stmt: string | { sql: string; args?: unknown[] }) => {
      const s = typeof stmt === "string" ? { sql: stmt, args: [] } : { sql: stmt.sql, args: stmt.args ?? [] };
      executed.push(s);
      if (s.sql.includes("FROM route_daily_stats")) return { rows: [{ dest: "AYT", ref: 200 }], rowsAffected: 0 };
      if (s.sql.includes("COUNT(*) AS n FROM watches")) return { rows: [{ n: 0 }], rowsAffected: 0 };
      if (s.sql.includes("RETURNING id")) return { rows: [{ id: 7 }], rowsAffected: 1 };
      return { rows: [], rowsAffected: 0 };
    },
    batch: async (stmts: unknown[]) => {
      batches.push(stmts);
      return [];
    },
  };
  return { ...real, getDb: () => client };
});

const { app } = await import("../src/index");

const BOT = "123456:TEST-token";
const env = {
  ASSETS: { fetch: async () => new Response("<html>app</html>", { headers: { "content-type": "text/html" } }) },
  TELEGRAM_BOT_TOKEN: BOT,
  BOT_WEBHOOK_SECRET: "hook-secret",
  TRAVELPAYOUTS_TOKEN: "tp",
  TRAVELPAYOUTS_MARKER: "555",
  TURSO_URL: "libsql://x",
  TURSO_TOKEN: "t",
  ALLOWED_USER_IDS: "42,43",
  TP_MARKETS: "ru",
  ORIGINS: "EVN,LWN,TBS,KUT",
  GROUND_COST_USD: '{"TBS":45}',
  WEBAPP_URL: "https://trichq.example",
};
const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {} } as unknown as ExecutionContext;

const store = new Map<string, Response>();
beforeEach(() => {
  executed.length = 0;
  batches.length = 0;
  pending.length = 0;
  store.clear();
  vi.stubGlobal("caches", {
    default: {
      match: async (r: Request) => store.get(r.url)?.clone(),
      put: async (r: Request, resp: Response) => void store.set(r.url, resp),
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

async function auth(id = 42) {
  const initData = await signInitData(
    { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, first_name: "K" }) },
    BOT,
  );
  return { Authorization: `tma ${initData}` };
}

const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

describe("api auth", () => {
  it("rejects requests without Telegram data", async () => {
    const res = await app.fetch(new Request("https://t/api/me"), env, ctx);
    expect(res.status).toBe(401);
  });
  it("rejects users outside the allow-list", async () => {
    const res = await app.fetch(new Request("https://t/api/me", { headers: await auth(99) }), env, ctx);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ user_id: 99 });
  });
  it("lets allowed users in and records them", async () => {
    const res = await app.fetch(new Request("https://t/api/me", { headers: await auth() }), env, ctx);
    expect(res.status).toBe(200);
    await Promise.all(pending);
    expect(executed.some((s) => s.sql.includes("INSERT INTO users"))).toBe(true);
  });
});

describe("search", () => {
  it("merges live results, scores deals, caches and persists", async () => {
    const dep = future(40);
    const ret = future(44);
    const fetchMock = vi.fn(async (url: URL | string) => {
      const u = new URL(String(url));
      expect(u.hostname).toBe("api.travelpayouts.com");
      expect(u.searchParams.get("one_way")).toBe("false");
      return Response.json({
        success: true,
        data: [
          { origin: "EVN", destination: "AYT", price: 150, departure_at: `${dep}T06:00:00+04:00`, return_at: `${ret}T20:00:00+03:00`, airline: "PC", flight_number: 1, link: "/s1" },
          { origin: "EVN", destination: "DXB", price: 190, departure_at: `${dep}T03:00:00+04:00`, return_at: `${ret}T22:00:00+04:00`, airline: "FZ", flight_number: 2, link: "/s2" },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const url = `https://t/api/search?origin=EVN&dep=${dep}&ret=${ret}`;
    const res = await app.fetch(new Request(url, { headers: await auth() }), env, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { dest: string; best: { price_usd: number; link: string }; deal_pct: number }[]; meta: { cached: boolean } };
    expect(body.results.map((r) => r.dest)).toEqual(["AYT", "DXB"]);
    expect(body.results[0]).toMatchObject({ deal_pct: 25, best: { price_usd: 150, link: "https://www.aviasales.com/s1?marker=555" } });
    await Promise.all(pending);
    expect(batches.flat()).toHaveLength(2); // both fares persisted

    const again = await app.fetch(new Request(url, { headers: await auth() }), env, ctx);
    expect(((await again.json()) as { meta: { cached: boolean } }).meta.cached).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns a readable error for bad dates", async () => {
    const res = await app.fetch(new Request("https://t/api/search?dep=2000-01-01&ret=2000-01-05", { headers: await auth() }), env, ctx);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/անցյալ/);
  });

  it("reports 502 when the price source is down and the DB has nothing", async () => {
    vi.stubGlobal("fetch", async () => new Response("down", { status: 503 }));
    const res = await app.fetch(new Request(`https://t/api/search?dep=${future(30)}&ret=${future(33)}`, { headers: await auth() }), env, ctx);
    expect(res.status).toBe(502);
  });
});

describe("watches", () => {
  it("creates a watch for the signed-in user", async () => {
    const res = await app.fetch(
      new Request("https://t/api/watches", {
        method: "POST",
        headers: { ...(await auth()), "content-type": "application/json" },
        body: JSON.stringify({ origin: "EVN", dest: "AYT", dep_date: future(40), ret_date: future(44), target_usd: 140 }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(201);
    const insert = executed.find((s) => s.sql.includes("INSERT INTO watches"))!;
    expect(insert.args[0]).toBe(42);
  });
});

describe("bot webhook and assets", () => {
  it("refuses calls without the webhook secret", async () => {
    const res = await app.fetch(new Request("https://t/telegram/webhook", { method: "POST", body: "{}" }), env, ctx);
    expect(res.status).toBe(403);
  });
  it("answers /start with a mini app button", async () => {
    const sent: unknown[] = [];
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return Response.json({ ok: true, result: {} });
    });
    const res = await app.fetch(
      new Request("https://t/telegram/webhook", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "hook-secret" },
        body: JSON.stringify({ message: { chat: { id: 42, type: "private" }, from: { id: 42, first_name: "Karen" }, text: "/start" } }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    await Promise.all(pending);
    expect(sent[0]).toMatchObject({ chat_id: 42, reply_markup: { inline_keyboard: [[{ web_app: { url: "https://trichq.example" } }]] } });
  });
  it("serves the mini app for non-API paths", async () => {
    const res = await app.fetch(new Request("https://t/"), env, ctx);
    expect(await res.text()).toContain("app");
  });
});
