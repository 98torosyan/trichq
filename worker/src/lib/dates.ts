const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export const isIsoDay = (s: unknown): s is string =>
  typeof s === "string" && ISO_DAY.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) &&
  new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

export const toMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);
export const fromMs = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export const addDays = (day: string, n: number): string => fromMs(toMs(day) + n * DAY_MS);
export const daysBetween = (a: string, b: string): number => Math.round((toMs(b) - toMs(a)) / DAY_MS);
export const monthOf = (day: string): string => day.slice(0, 7);

/** Today's date in Yerevan (UTC+4, no DST). */
export const yerevanToday = (now = Date.now()): string => fromMs(now + 4 * 3600_000);

/** Every YYYY-MM touched by [from, to]. */
export function monthsCovering(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const endKey = to.slice(0, 7);
  for (let guard = 0; guard < 24; guard++) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    out.push(key);
    if (key >= endKey) break;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}
