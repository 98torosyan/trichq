export const MONTHS = ["Հունվար", "Փետրվար", "Մարտ", "Ապրիլ", "Մայիս", "Հունիս", "Հուլիս", "Օգոստոս", "Սեպտեմբեր", "Հոկտեմբեր", "Նոյեմբեր", "Դեկտեմբեր"];
const MONTHS_GEN = ["հունվարի", "փետրվարի", "մարտի", "ապրիլի", "մայիսի", "հունիսի", "հուլիսի", "օգոստոսի", "սեպտեմբերի", "հոկտեմբերի", "նոյեմբերի", "դեկտեմբերի"];
const MONTHS_SHORT = ["հունվ", "փետ", "մարտ", "ապր", "մայ", "հունիս", "հուլ", "օգոս", "սեպտ", "հոկտ", "նոյ", "դեկ"];
export const WEEKDAYS = ["Կիրակի", "Երկուշաբթի", "Երեքշաբթի", "Չորեքշաբթի", "Հինգշաբթի", "Ուրբաթ", "Շաբաթ"];
export const WEEKDAYS_SHORT = ["Երկ", "Երք", "Չրք", "Հնգ", "Ուրբ", "Շբթ", "Կիր"]; // Monday first

const DAY = 86_400_000;
const parse = (iso: string) => new Date(`${iso}T00:00:00Z`);

export const iso = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (isoDay: string, n: number) => iso(new Date(parse(isoDay).getTime() + n * DAY));
export const nightsBetween = (a: string, b: string) => Math.round((parse(b).getTime() - parse(a).getTime()) / DAY);
export const todayYerevan = () => iso(new Date(Date.now() + 4 * 3600_000));

export const shortDate = (isoDay: string) => {
  const d = parse(isoDay);
  return `${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCDate()}`;
};
export const longDate = (isoDay: string) => {
  const d = parse(isoDay);
  return `${MONTHS_GEN[d.getUTCMonth()]} ${d.getUTCDate()}`;
};
export const weekday = (isoDay: string) => WEEKDAYS[parse(isoDay).getUTCDay()] ?? "";

export const usd = (n: number) => `${Math.round(n).toLocaleString("en-US")}$`;

export const duration = (min: number | null) => {
  if (!min) return "";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}ժ ${String(m).padStart(2, "0")}ր`;
};

export const stops = (n: number | null) => (n === null ? "" : n === 0 ? "Ուղիղ" : `${n} կանգառ`);

export function timeAgo(isoTs: string): string {
  const mins = Math.max(1, Math.round((Date.now() - Date.parse(isoTs)) / 60_000));
  if (mins < 60) return `${mins} րոպե առաջ`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h} ժամ առաջ`;
  return `${Math.round(h / 24)} օր առաջ`;
}

/** Deterministic hue per destination, for the postcard gradient on each card. */
export function hueFor(code: string): number {
  let h = 0;
  for (const ch of code) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}
export const artGradient = (code: string) => {
  const h = hueFor(code);
  return `linear-gradient(150deg, hsl(${h} 74% 56%), hsl(${(h + 38) % 360} 68% 36%))`;
};
