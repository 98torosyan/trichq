/** Telegram webhook: /start opens the mini app, /watches lists price watches. */
import { Hono } from "hono";
import { type Env, csv } from "../env";
import { getDb } from "../lib/db";
import { escapeHtml, tgCall } from "../lib/telegram";

interface Update {
  message?: { chat: { id: number; type: string }; from?: { id: number; first_name?: string }; text?: string };
}

const timingSafeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

export const botRoutes = new Hono<{ Bindings: Env }>().post("/webhook", async (c) => {
  const secret = c.req.header("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (!c.env.BOT_WEBHOOK_SECRET || !timingSafeEqual(secret, c.env.BOT_WEBHOOK_SECRET)) return c.text("forbidden", 403);

  const update = (await c.req.json().catch(() => ({}))) as Update;
  const msg = update.message;
  if (!msg?.from || msg.chat.type !== "private" || !msg.text) return c.json({ ok: true });

  const token = c.env.TELEGRAM_BOT_TOKEN;
  const allowed = csv(c.env.ALLOWED_USER_IDS).includes(String(msg.from.id));
  const reply = (text: string, extra: Record<string, unknown> = {}) =>
    tgCall(token, "sendMessage", { chat_id: msg.chat.id, text, parse_mode: "HTML", ...extra });

  // Telegram retries on non-200, so always answer 200 and do the work in the background.
  const work = async () => {
    if (!allowed) {
      await reply(`Այս բոտը մասնավոր է։\nՔո Telegram ID-ն՝ <code>${msg.from!.id}</code>`);
      return;
    }
    const cmd = msg.text!.trim().split(/\s+/)[0]?.split("@")[0];
    if (cmd === "/watches") {
      const rs = await getDb(c.env).execute({
        sql: `SELECT origin, dest, dep_date, ret_date, target_usd, last_price_usd FROM watches
              WHERE tg_id = ? AND active = 1 ORDER BY dep_date LIMIT 20`,
        args: [msg.from!.id],
      });
      if (!rs.rows.length) {
        await reply("Դեռ ոչ մի ուղղության չես հետևում։ Բացիր Թռիչքը ու սեղմիր «Հետևել» ցանկացած տոմսի վրա։");
        return;
      }
      const lines = rs.rows.map(
        (w) =>
          `• <b>${escapeHtml(String(w.origin))} → ${escapeHtml(String(w.dest))}</b> ${w.dep_date}${w.ret_date ? ` – ${w.ret_date}` : ""}` +
          ` · թիրախ ${Math.round(Number(w.target_usd))} USD` +
          (w.last_price_usd === null ? "" : ` · հիմա ${Math.round(Number(w.last_price_usd))} USD`),
      );
      await reply(`🔔 <b>Հետևում ես</b>\n\n${lines.join("\n")}`);
      return;
    }
    const name = escapeHtml(msg.from!.first_name ?? "");
    await reply(
      `Բարև${name ? `, ${name}` : ""} ✈️\n\n<b>Թռիչք</b>-ը գտնում է ամենաէժան տոմսերը Երևանից դեպի ամեն տեղ։\nՆշիր օրերը, մնացածը մենք կանենք։`,
      c.env.WEBAPP_URL
        ? { reply_markup: { inline_keyboard: [[{ text: "Բացել Թռիչքը", web_app: { url: c.env.WEBAPP_URL } }]] } }
        : {},
    );
  };
  c.executionCtx.waitUntil(work().catch((e) => console.error("bot reply failed", e)));
  return c.json({ ok: true });
});
