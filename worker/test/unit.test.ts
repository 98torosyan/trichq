import { describe, expect, it } from "vitest";
import { signInitData, validateInitData } from "../src/lib/auth";
import { addDays, daysBetween, isIsoDay, monthsCovering } from "../src/lib/dates";
import { type Fare, type SearchQuery, aggregate, bookingLink, fareFromTp, fareKey } from "../src/lib/fares";
import { applyReference, parseSearch } from "../src/routes/search";
import type { Env } from "../src/env";

const BOT = "123456:TEST-token";

describe("telegram initData", () => {
  const user = JSON.stringify({ id: 42, first_name: "Karen" });
  it("accepts correctly signed data", async () => {
    const now = 1_800_000_000;
    const init = await signInitData({ auth_date: String(now - 60), user, query_id: "AA" }, BOT);
    const res = await validateInitData(init, BOT, { now });
    expect(res.ok && res.user.id).toBe(42);
  });
  it("rejects tampering, wrong token and stale data", async () => {
    const now = 1_800_000_000;
    const init = await signInitData({ auth_date: String(now - 60), user }, BOT);
    const tampered = init.replace("Karen", "Admin");
    expect((await validateInitData(tampered, BOT, { now })).ok).toBe(false);
    expect((await validateInitData(init, "999:other", { now })).ok).toBe(false);
    const old = await signInitData({ auth_date: String(now - 2 * 86400), user }, BOT);
    expect(await validateInitData(old, BOT, { now })).toEqual({ ok: false, reason: "expired" });
    expect((await validateInitData("", BOT)).ok).toBe(false);
  });
});

describe("dates", () => {
  it("validates and shifts days", () => {
    expect(isIsoDay("2026-02-29")).toBe(false);
    expect(isIsoDay("2028-02-29")).toBe(true);
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(daysBetween("2026-11-13", "2026-11-17")).toBe(4);
    expect(monthsCovering("2026-11-29", "2027-01-02")).toEqual(["2026-11", "2026-12", "2027-01"]);
  });
});

describe("fares", () => {
  it("builds the same key as the Python collector", () => {
    const key = fareKey({ origin: "EVN", dest: "AYT", dep_date: "2026-11-13", ret_date: "2026-11-17", airline: "PC", flight_number: "781" });
    expect(key).toBe("EVN|AYT|2026-11-13|2026-11-17|PC|781"); // collector/tests/test_db_and_models.py::FARE_KEY_DIGEST
  });

  it("normalises Aviasales items and adds the affiliate marker", () => {
    const f = fareFromTp(
      { origin: "EVN", destination: "AYT", price: 138, departure_at: "2026-11-13T06:40:00+04:00", return_at: "2026-11-17T21:10:00+03:00", airline: "PC", flight_number: 781, transfers: 1, link: "/search/X?t=1" },
      "ru",
      "555",
    );
    expect(f).toMatchObject({ dep_date: "2026-11-13", ret_date: "2026-11-17", price_usd: 138, flight_number: "781", link: "https://www.aviasales.com/search/X?t=1&marker=555" });
    expect(fareFromTp({ origin: "EVN", destination: "EVN", price: 1, departure_at: "2026-11-13" }, null)).toBeNull();
    expect(fareFromTp({ origin: "EVN", destination: "AYT", price: 0, departure_at: "2026-11-13" }, null)).toBeNull();
    expect(bookingLink("/s?marker=1", "2")).toBe("https://www.aviasales.com/s?marker=1");
  });
});

const fare = (o: Partial<Fare>): Fare => ({
  origin: "EVN", dest: "AYT", dep_date: "2026-11-13", ret_date: "2026-11-17", price_usd: 150, airline: "PC",
  flight_number: "1", transfers: 1, return_transfers: 1, duration_min: 300, link: null, source: "aviasales", market: "ru",
  ...o,
});

describe("aggregate", () => {
  const q: SearchQuery = { origin: "EVN", alts: ["TBS"], dep: "2026-11-13", ret: "2026-11-17", flex: 2 };
  const ground = { TBS: 45 };

  it("prefers exact dates and flags a clearly cheaper flexible option", () => {
    const items = aggregate(
      [fare({ price_usd: 150 }), fare({ price_usd: 120, dep_date: "2026-11-12", ret_date: "2026-11-16" }), fare({ price_usd: 149, dep_date: "2026-11-14" })],
      q,
      ground,
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.exact).toBe(true);
    expect(items[0]!.best!.price_usd).toBe(150);
    expect(items[0]!.flex_better!.price_usd).toBe(120);
  });

  it("falls back to the window, ignores dates outside it and sorts by price", () => {
    const items = aggregate(
      [fare({ dest: "DXB", price_usd: 200, dep_date: "2026-11-15" }), fare({ dest: "AYT", price_usd: 90, dep_date: "2026-11-16" }), fare({ dest: "BUS", price_usd: 80 })],
      q,
      ground,
    );
    expect(items.map((i) => i.dest)).toEqual(["BUS", "DXB"]);
    expect(items[1]!.exact).toBe(false);
  });

  it("shows the Tbilisi option only when it beats Yerevan after ground cost", () => {
    const items = aggregate(
      [fare({ dest: "BCN", price_usd: 300 }), fare({ origin: "TBS", dest: "BCN", price_usd: 200 }), fare({ dest: "MXP", price_usd: 150 }), fare({ origin: "TBS", dest: "MXP", price_usd: 100 })],
      q,
      ground,
    );
    const bcn = items.find((i) => i.dest === "BCN")!;
    const mxp = items.find((i) => i.dest === "MXP")!;
    expect(bcn.alt).toMatchObject({ origin: "TBS", ground_usd: 45, effective_usd: 245 });
    expect(mxp.alt).toBeNull(); // 100 + 45 = 145 saves only 5 USD
    expect(items[0]!.dest).toBe("MXP");
  });

  it("scores deals against the reference price", () => {
    const items = applyReference(aggregate([fare({ price_usd: 150 })], q, ground), new Map([["AYT", 200]]));
    expect(items[0]).toMatchObject({ ref_usd: 200, deal_pct: 25 });
  });
});

describe("search validation", () => {
  const env = { ORIGINS: "EVN,LWN,TBS,KUT" } as Env;
  const today = "2026-10-09";
  it("parses a good query", () => {
    expect(parseSearch({ dep: "2026-11-13", ret: "2026-11-17", flex: "2", alt: "TBS,EVN,TBS" }, env, today)).toEqual({
      origin: "EVN", alts: ["TBS"], dep: "2026-11-13", ret: "2026-11-17", flex: 2,
    });
  });
  it.each([
    [{ dep: "2026-10-01", ret: "2026-10-05" }],
    [{ dep: "2026-11-13", ret: "2026-11-13" }],
    [{ dep: "2026-11-13", ret: "2027-01-13" }],
    [{ dep: "2026-11-13", ret: "2026-11-17", flex: "9" }],
    [{ dep: "2026-11-13", ret: "2026-11-17", origin: "JFK" }],
    [{ dep: "13.11.2026", ret: "2026-11-17" }],
  ])("rejects %j", (params) => {
    expect(() => parseSearch(params, env, today)).toThrow();
  });
});
