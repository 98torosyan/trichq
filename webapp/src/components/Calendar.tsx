import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { MONTHS, WEEKDAYS_SHORT, addDays, iso, nightsBetween, todayYerevan } from "../lib/format";
import { haptic } from "../lib/tg";
import { Chevron } from "./Icons";

interface Props {
  origin: string;
  dep: string;
  ret: string | null;
  picking: "dep" | "ret";
  onPick: (day: string) => void;
}

const firstOfMonth = (day: string) => `${day.slice(0, 7)}-01`;
const shiftMonth = (first: string, n: number) => {
  const d = new Date(`${first}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return iso(d);
};

/** Month grid; each day shows the cheapest known round trip so cheap days stand out. */
export function Calendar({ origin, dep, ret, picking, onPick }: Props) {
  const today = todayYerevan();
  const [month, setMonth] = useState(firstOfMonth(picking === "ret" && ret ? ret : dep));
  const [prices, setPrices] = useState<Record<string, number>>({});
  const nights = ret ? Math.max(1, nightsBetween(dep, ret)) : 4;

  useEffect(() => {
    let alive = true;
    setPrices({});
    api
      .calendar(origin, month.slice(0, 7), nights)
      .then((r) => alive && setPrices(r.days))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [origin, month, nights]);

  const levels = useMemo(() => {
    const vals = Object.values(prices).sort((a, b) => a - b);
    if (vals.length < 3) return (_: number) => 2;
    const lo = vals[Math.floor(vals.length / 3)]!;
    const hi = vals[Math.floor((vals.length * 2) / 3)]!;
    return (p: number) => (p <= lo ? 1 : p <= hi ? 2 : 3);
  }, [prices]);

  const first = new Date(`${month}T00:00:00Z`);
  const offset = (first.getUTCDay() + 6) % 7; // Monday first
  const daysInMonth = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const canGoBack = month > firstOfMonth(today);

  return (
    <div>
      <div className="cal-h">
        <button className="icon-btn" aria-label="Նախորդ ամիս" disabled={!canGoBack} onClick={() => setMonth(shiftMonth(month, -1))}>
          <Chevron dir="left" />
        </button>
        <b>
          {MONTHS[first.getUTCMonth()]} {first.getUTCFullYear()}
        </b>
        <button className="icon-btn" aria-label="Հաջորդ ամիս" onClick={() => setMonth(shiftMonth(month, 1))}>
          <Chevron dir="right" />
        </button>
      </div>
      <p className="cal-hint">{picking === "ret" ? "Հիմա ընտրիր վերադարձի օրը" : "Ընտրիր մեկնելու օրը"}</p>
      <div className="grid7">
        {WEEKDAYS_SHORT.map((w) => (
          <div key={w} className="wd">
            {w}
          </div>
        ))}
        {Array.from({ length: offset }, (_, i) => (
          <span key={`pad-${i}`} />
        ))}
        {Array.from({ length: daysInMonth }, (_, i) => {
          const day = addDays(month, i);
          const tooFar = day > addDays(today, 330) || (picking === "ret" && day > dep && nightsBetween(dep, day) > 30);
          const past = day < today || tooFar;
          const price = prices[day];
          const cls = ["day"];
          if (price !== undefined) cls.push(`lv${levels(price)}`);
          if (day === dep) cls.push("s");
          if (ret && day === ret) cls.push("e");
          if (ret && day > dep && day < ret) cls.push("in");
          return (
            <button
              key={day}
              className={cls.join(" ")}
              disabled={past}
              aria-label={day}
              onClick={() => {
                haptic.select();
                onPick(day);
              }}
            >
              {i + 1}
              <small>{price !== undefined && !past ? price : ""}</small>
            </button>
          );
        })}
      </div>
      <div className="legend">
        <span><i style={{ background: "var(--good)" }} />էժան</span>
        <span><i style={{ background: "var(--muted)" }} />միջին</span>
        <span><i style={{ background: "var(--bad)" }} />թանկ</span>
        <span>թիվը՝ ամենաէժան տոմսը, $</span>
      </div>
    </div>
  );
}
