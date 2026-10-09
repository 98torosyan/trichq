import { HTTPException } from "hono/http-exception";

/** Throw a 400 with a message the mini app can show as-is (Armenian). */
export function bad(message: string): never {
  throw new HTTPException(400, { message });
}

export function parseIata(v: string | undefined, allowed: string[], field: string): string {
  const code = (v ?? "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) bad(`«${field}» դաշտը պետք է լինի 3 տառանոց IATA կոդ`);
  if (allowed.length && !allowed.includes(code)) bad(`«${code}» օդանավակայանը չի աջակցվում`);
  return code;
}

export function parseInt0(v: string | undefined, min: number, max: number, fallback: number): number {
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) bad(`թիվը պետք է լինի ${min}-ից ${max}`);
  return n;
}
