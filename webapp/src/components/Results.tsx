import { motion } from "framer-motion";
import { useEffect, useMemo, useState } from "react";
import type { SearchItem } from "../lib/api";
import { artGradient, duration, shortDate, stops, usd } from "../lib/format";
import { airlineName, cityName, countryName, visaFor } from "../lib/ref";
import { haptic } from "../lib/tg";
import { Flap } from "./Flap";

export type SortKey = "price" | "deal" | "fast";
export type FilterKey = "all" | "direct" | "novisa" | "u150" | "georgia";

const FILTERS: [FilterKey, string][] = [
  ["all", "Բոլորը"],
  ["direct", "Միայն ուղիղ"],
  ["novisa", "Առանց վիզայի"],
  ["u150", "Մինչև 150$"],
  ["georgia", "Վրաստանով էժան"],
];

const effective = (it: SearchItem) => Math.min(it.best?.price_usd ?? Infinity, it.alt?.effective_usd ?? Infinity);

export function applyView(items: SearchItem[], filter: FilterKey, sort: SortKey): SearchItem[] {
  const out = items.filter((it) => {
    switch (filter) {
      case "direct":
        return it.best?.transfers === 0 && (it.best.return_transfers ?? 0) === 0;
      case "novisa": {
        const k = visaFor(it.dest).kind;
        return k === "free" || k === "arrival" || k === "evisa" || k === "home";
      }
      case "u150":
        return effective(it) <= 150;
      case "georgia":
        return it.alt !== null && (it.alt.origin === "TBS" || it.alt.origin === "KUT");
      default:
        return true;
    }
  });
  const by: Record<SortKey, (a: SearchItem, b: SearchItem) => number> = {
    price: (a, b) => effective(a) - effective(b),
    deal: (a, b) => (b.deal_pct ?? -999) - (a.deal_pct ?? -999),
    fast: (a, b) => (a.best?.duration_min ?? 1e9) - (b.best?.duration_min ?? 1e9),
  };
  return [...out].sort(by[sort]);
}

/** Departure-board loader shown while the search runs. */
export function Board({ origin, alts }: { origin: string; alts: string[] }) {
  const [progress, setProgress] = useState(0);
  const [codes] = useState(() => ["AYT", "DXB", "LCA", "BCN", "MXP", "TLV"].sort(() => Math.random() - 0.5));
  useEffect(() => {
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      setProgress(Math.min(0.95, (now - t0) / 4000));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className="board" role="status" aria-live="polite">
      <div className="board-h">
        <span>ՄԵԿՆՈՒՄՆԵՐ · {[origin, ...alts].join(" + ")}</span>
        <span>ՈՐՈՆՈՒՄ</span>
      </div>
      {codes.map((c, i) => (
        <div className="brow" key={c}>
          <Flap text={origin} />
          <span className="arrow">→</span>
          <Flap text={c} delay={i * 140} />
          <span className={`st ${progress > 0.15 * (i + 1) ? "ok" : ""}`}>{progress > 0.15 * (i + 1) ? "ՍՏՈՒԳՎԱԾ" : "ՍՏՈՒԳՈՒՄ"}</span>
        </div>
      ))}
      <div className="bar"><i style={{ width: `${progress * 100}%` }} /></div>
      <div className="board-f"><span>Ստուգում ենք բոլոր ուղղությունները</span><span>{Math.round(progress * 100)}%</span></div>
    </div>
  );
}

export function PassCard({ item, pax, rank, onOpen }: { item: SearchItem; pax: number; rank: number; onOpen: () => void }) {
  const offer = item.best ?? item.alt;
  if (!offer) return null;
  const visa = visaFor(item.dest);
  // Alternative-airport-only results show the full cost, ground transport included.
  const price = Math.round((item.best ? offer.price_usd : item.alt!.effective_usd) * pax);
  const country = countryName(item.dest);
  const deal = item.deal_pct;
  return (
    <motion.button
      className="pass"
      layout
      initial={{ opacity: 0, y: 16, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.5, delay: Math.min(rank, 10) * 0.05, ease: [0.2, 0.8, 0.2, 1] }}
      whileTap={{ scale: 0.985 }}
      onClick={() => {
        haptic.tap();
        onOpen();
      }}
    >
      <div className="art" style={{ background: artGradient(item.dest) }}>
        <span className="cc">{country}</span>
        <span className="code">{item.dest}</span>
      </div>
      <div className="pinfo">
        <div className="prow">
          <div style={{ minWidth: 0 }}>
            <div className="city">{cityName(item.dest)}</div>
            <div className="meta">
              {[airlineName(offer.airline), item.best ? null : `${cityName(offer.origin)}ից, ճանապարհով միասին`].filter(Boolean).join(" · ")}
            </div>
          </div>
          <div className="price">
            <Flap text={`${price}$`} delay={150 + rank * 50} />
            <small>{pax > 1 ? `${pax} ուղևոր · ` : ""}գնալ-գալ</small>
          </div>
        </div>
        <div className="badges">
          {rank === 0 && <span className="b hot">Ամենաէժան</span>}
          {deal !== null && deal >= 12 && <span className="b hot">−{deal}% սովորականից</span>}
          {deal !== null && deal > 0 && deal < 12 && <span className="b good">−{deal}% սովորականից</span>}
          <span className="b">
            {[stops(offer.transfers), duration(offer.duration_min)].filter(Boolean).join(" · ")}
          </span>
          {visa.label && <span className={`b ${visa.kind === "free" ? "good" : visa.kind === "required" ? "bad" : "warn"}`}>{visa.label}</span>}
          {!item.exact && item.best && <span className="b warn">{shortDate(item.best.dep_date)}–{item.best.ret_date ? shortDate(item.best.ret_date) : ""}</span>}
        </div>
        {item.alt && item.best && (
          <div className="tip">
            <b>{cityName(item.alt.origin)}ից {usd(item.alt.effective_usd * pax)}</b> · ճանապարհով միասին {usd((item.best.price_usd - item.alt.effective_usd) * pax)} էժան
          </div>
        )}
        {item.flex_better && item.best && (
          <div className="tip">
            <b>{shortDate(item.flex_better.dep_date)}–{item.flex_better.ret_date ? shortDate(item.flex_better.ret_date) : ""}</b> թռչելու դեպքում{" "}
            {usd((item.best.price_usd - item.flex_better.price_usd) * pax)} էժան
          </div>
        )}
      </div>
    </motion.button>
  );
}

export function ResultsView({
  items,
  pax,
  onOpen,
}: {
  items: SearchItem[];
  pax: number;
  onOpen: (it: SearchItem) => void;
}) {
  const [filter, setFilter] = useState<FilterKey>("all");
  const [sort, setSort] = useState<SortKey>("price");
  const view = useMemo(() => applyView(items, filter, sort), [items, filter, sort]);
  return (
    <>
      <div className="chips" role="group" aria-label="Ֆիլտրեր">
        {FILTERS.map(([k, label]) => (
          <button key={k} className="chip" aria-pressed={filter === k} onClick={() => { haptic.select(); setFilter(k); }}>
            {label}
          </button>
        ))}
      </div>
      <div className="rhead">
        <div>
          <h2>{view.length} ուղղություն</h2>
          <p>Գները մեկ ուղևորի գնալ-գալն են, եթե այլ բան նշված չէ</p>
        </div>
        <div className="seg" role="group" aria-label="Դասավորել">
          {(
            [
              ["price", "Գին"],
              ["deal", "Զեղչ"],
              ["fast", "Արագ"],
            ] as [SortKey, string][]
          ).map(([k, l]) => (
            <button key={k} aria-pressed={sort === k} onClick={() => { haptic.select(); setSort(k); }}>
              {l}
            </button>
          ))}
        </div>
      </div>
      <div className="list">
        {view.length === 0 ? (
          <div className="empty">Այս ֆիլտրով տարբերակ չկա։ Փորձիր «Բոլորը» կամ միացրու ±2 օրը։</div>
        ) : (
          view.map((it, i) => <PassCard key={it.dest} item={it} pax={pax} rank={sort === "price" ? i : i + 1} onOpen={() => onOpen(it)} />)
        )}
      </div>
    </>
  );
}
