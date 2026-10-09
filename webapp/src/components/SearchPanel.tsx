import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";
import { addDays, longDate, nightsBetween, shortDate, weekday } from "../lib/format";
import { haptic } from "../lib/tg";
import { Calendar } from "./Calendar";
import { Check, SearchIcon } from "./Icons";

export interface SearchParams {
  origin: string;
  alts: string[];
  dep: string;
  ret: string;
  flex: number;
  pax: number;
}

const ALT_ORIGINS = [
  { code: "TBS", name: "Թբիլիսի" },
  { code: "KUT", name: "Քութայիսի" },
  { code: "LWN", name: "Գյումրի" },
];

export function SearchPanel({
  value,
  onChange,
  onSearch,
  busy,
}: {
  value: SearchParams;
  onChange: (v: SearchParams) => void;
  onSearch: () => void;
  busy: boolean;
}) {
  const [picking, setPicking] = useState<"dep" | "ret" | null>(null);
  const [pendingRet, setPendingRet] = useState<string | null>(null);
  const ret = picking === "ret" ? pendingRet : value.ret;

  const pick = (day: string) => {
    if (picking === "dep" || (picking === "ret" && day <= value.dep)) {
      // Keep a valid range even if the user closes the calendar before choosing the return day.
      onChange({ ...value, dep: day, ret: value.ret > day ? value.ret : addDays(day, 4) });
      setPendingRet(null);
      setPicking("ret");
      return;
    }
    if (picking === "ret") {
      onChange({ ...value, ret: day });
      setPicking(null);
    }
  };
  const toggleAlt = (code: string) => {
    haptic.select();
    const alts = value.alts.includes(code) ? value.alts.filter((a) => a !== code) : [...value.alts, code];
    onChange({ ...value, alts });
  };
  const nights = nightsBetween(value.dep, value.ret);

  return (
    <div className="ticket">
      <div className="origins" role="group" aria-label="Մեկնման օդանավակայաններ">
        <button className="org" aria-pressed="true" disabled>
          <span className="ck"><Check /></span>Երևան <span className="mono">EVN</span>
        </button>
        {ALT_ORIGINS.map((o) => (
          <button key={o.code} className="org" aria-pressed={value.alts.includes(o.code)} onClick={() => toggleAlt(o.code)}>
            <span className="ck"><Check /></span>+ {o.name} <span className="mono">{o.code}</span>
          </button>
        ))}
      </div>

      <div className="dates">
        <button className={picking === "dep" ? "on" : ""} onClick={() => setPicking(picking === "dep" ? null : "dep")} aria-label={`Մեկնում ${longDate(value.dep)}`}>
          <span className="k">ՄԵԿՆՈՒՄ</span>
          <span className="v">{shortDate(value.dep)}</span>
          <span className="w">{weekday(value.dep)}</span>
        </button>
        <div className="nights"><span><b>{picking === "ret" ? "–" : nights}</b>գիշեր</span></div>
        <button
          className={picking === "ret" ? "on" : ""}
          onClick={() => {
            setPendingRet(null);
            setPicking(picking === "ret" ? null : "ret");
          }}
          aria-label={`Վերադարձ ${longDate(value.ret)}`}
        >
          <span className="k">ՎԵՐԱԴԱՐՁ</span>
          <span className="v">{ret ? shortDate(ret) : "—"}</span>
          <span className="w">{ret ? weekday(ret) : "ընտրիր"}</span>
        </button>
      </div>

      <AnimatePresence initial={false}>
        {picking && (
          <motion.div
            key="cal"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.32, ease: [0.2, 0.9, 0.2, 1] }}
            style={{ overflow: "hidden" }}
          >
            <Calendar origin={value.origin} dep={value.dep} ret={ret} picking={picking} onPick={pick} />
          </motion.div>
        )}
      </AnimatePresence>

      <div className="opts">
        <button
          className="switch"
          aria-pressed={value.flex > 0}
          onClick={() => {
            haptic.select();
            onChange({ ...value, flex: value.flex > 0 ? 0 : 2 });
          }}
        >
          <span className="tr" />±2 օր ճկունություն
        </button>
        <div className="stepper">
          <button aria-label="Պակասեցնել" onClick={() => onChange({ ...value, pax: Math.max(1, value.pax - 1) })}>−</button>
          <b>{value.pax}</b>
          <button aria-label="Ավելացնել" onClick={() => onChange({ ...value, pax: Math.min(6, value.pax + 1) })}>+</button>
          <span>ուղևոր</span>
        </div>
      </div>

      <motion.button
        className="go"
        whileTap={{ scale: 0.97 }}
        disabled={busy || picking === "ret"}
        onClick={() => {
          haptic.tap();
          setPicking(null);
          onSearch();
        }}
      >
        <SearchIcon />
        {busy ? "Որոնում ենք…" : "Գտնել ամենաէժանը"}
      </motion.button>
    </div>
  );
}
