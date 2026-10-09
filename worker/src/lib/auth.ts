/**
 * Telegram Mini App authentication.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * secret_key = HMAC_SHA256(key = "WebAppData", msg = bot_token)
 * hash       = hex(HMAC_SHA256(key = secret_key, msg = data_check_string))
 * where data_check_string is every field except `hash`, sorted by key, as "key=value" joined by "\n".
 */
import type { TgUser } from "../env";

const enc = new TextEncoder();

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}

const toHex = (buf: ArrayBuffer): string =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Constant-time comparison so the check does not leak how many characters matched. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type AuthResult = { ok: true; user: TgUser; authDate: number } | { ok: false; reason: string };

export async function validateInitData(
  initData: string,
  botToken: string,
  { maxAgeSeconds = 24 * 3600, now = Date.now() / 1000 } = {},
): Promise<AuthResult> {
  if (!initData || !botToken) return { ok: false, reason: "missing" };
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "no-hash" };
  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secret = await hmac(enc.encode("WebAppData"), botToken);
  const expected = toHex(await hmac(secret, dataCheckString));
  if (!safeEqual(expected, hash.toLowerCase())) return { ok: false, reason: "bad-hash" };

  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || now - authDate > maxAgeSeconds) return { ok: false, reason: "expired" };

  let user: TgUser;
  try {
    user = JSON.parse(params.get("user") ?? "null");
  } catch {
    return { ok: false, reason: "bad-user" };
  }
  if (!user || typeof user.id !== "number") return { ok: false, reason: "no-user" };
  return { ok: true, user, authDate };
}

/** Test helper / local tooling: produce a correctly signed initData string. */
export async function signInitData(fields: Record<string, string>, botToken: string): Promise<string> {
  const params = new URLSearchParams(fields);
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = await hmac(enc.encode("WebAppData"), botToken);
  params.set("hash", toHex(await hmac(secret, dataCheckString)));
  return params.toString();
}
