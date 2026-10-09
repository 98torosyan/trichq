// Points the bot at the Worker and adds the "Թռիչք" menu button. Safe to run on every deploy.
// Usage: TELEGRAM_BOT_TOKEN=... BOT_WEBHOOK_SECRET=... WEBAPP_URL=https://... node scripts/setup-telegram.mjs
const { TELEGRAM_BOT_TOKEN: token, BOT_WEBHOOK_SECRET: secret, WEBAPP_URL: url } = process.env;
if (!token || !secret || !url) {
  console.error("TELEGRAM_BOT_TOKEN, BOT_WEBHOOK_SECRET and WEBAPP_URL are required");
  process.exit(1);
}
const base = url.replace(/\/$/, "");

async function call(method, payload) {
  const resp = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await resp.json();
  if (!data.ok) throw new Error(`${method}: ${data.description}`);
  console.log(`✓ ${method}`);
}

await call("setWebhook", {
  url: `${base}/telegram/webhook`,
  secret_token: secret,
  allowed_updates: ["message"],
  drop_pending_updates: true,
});
await call("setChatMenuButton", { menu_button: { type: "web_app", text: "Թռիչք", web_app: { url: base } } });
await call("setMyCommands", {
  commands: [
    { command: "start", description: "Բացել Թռիչքը" },
    { command: "watches", description: "Իմ հետևումները" },
  ],
});
await call("setMyDescription", { description: "Ամենաէժան տոմսերը Հայաստանից դեպի ամեն տեղ։ Նշիր օրերը, մնացածը մենք կանենք։" });
