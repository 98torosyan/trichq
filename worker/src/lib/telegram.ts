export async function tgCall<T = unknown>(token: string, method: string, payload: unknown): Promise<T> {
  const resp = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = (await resp.json()) as { ok: boolean; result?: T; description?: string };
  if (!data.ok) throw new Error(`telegram ${method}: ${data.description ?? resp.status}`);
  return data.result as T;
}

export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
