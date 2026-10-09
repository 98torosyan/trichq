import { motion } from "framer-motion";
import { useEffect, useMemo, useState } from "react";
import { type Deal, type Watch, api } from "../lib/api";
import { artGradient, shortDate, stops, timeAgo } from "../lib/format";
import { cityName } from "../lib/ref";
import { haptic } from "../lib/tg";
import { Cross } from "./Icons";

const KIND_LABEL: Record<Deal["kind"], string> = { drop: "Գնանկում", special: "Հատուկ առաջարկ", cheapest: "Ամենաէժան" };

export function DealsView({ onOpen }: { onOpen: (d: Deal) => void }) {
  const [deals, setDeals] = useState<Deal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<"all" | Deal["kind"]>("all");
  useEffect(() => {
    api.deals().then((r) => setDeals(r.deals)).catch((e: Error) => setError(e.message));
  }, []);
  const view = useMemo(() => (deals ?? []).filter((d) => kind === "all" || d.kind === kind), [deals, kind]);

  return (
    <>
      <div>
        <h2 className="sec-h">Այսօրվա որսը</h2>
        <p className="sec-p">Գնանկումներ մեր պատմության համեմատ, հատուկ առաջարկներ ու ամենաէժան տոմսերը յուրաքանչյուր ուղղությամբ։</p>
      </div>
      <div className="chips" role="group" aria-label="Տեսակ">
        {(["all", "drop", "special", "cheapest"] as const).map((k) => (
          <button key={k} className="chip" aria-pressed={kind === k} onClick={() => { haptic.select(); setKind(k); }}>
            {k === "all" ? "Բոլորը" : KIND_LABEL[k]}
          </button>
        ))}
      </div>
      {error && <div className="error">{error}</div>}
      <div className="list">
        {deals === null && !error && [0, 1, 2, 3].map((i) => <div key={i} className="skel" style={{ height: 68 }} />)}
        {deals !== null && view.length === 0 && (
          <div className="empty">Դեռ գործարքներ չկան։ Առաջին գիշերային հավաքումից հետո այստեղ կհայտնվեն ամենալավ գները։</div>
        )}
        {view.map((d, i) => (
          <motion.button
            key={`${d.kind}-${d.origin}-${d.dest}-${d.dep_date}-${d.ret_date}`}
            className="deal"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: Math.min(i, 12) * 0.04 }}
            whileTap={{ scale: 0.985 }}
            onClick={() => {
              haptic.tap();
              onOpen(d);
            }}
          >
            <div className="ic" style={{ background: artGradient(d.dest) }}>{d.dest}</div>
            <div style={{ minWidth: 0 }}>
              <div className="t">
                {cityName(d.origin)} → {cityName(d.dest)}
                {d.pct_below ? ` · −${d.pct_below}%` : ""}
              </div>
              <div className="meta">
                {KIND_LABEL[d.kind]} · {shortDate(d.dep_date)}
                {d.ret_date ? `–${shortDate(d.ret_date)}` : ", մեկ ուղղությամբ"}
                {d.transfers !== null ? ` · ${stops(d.transfers)}` : ""} · {timeAgo(d.created_at)}
              </div>
            </div>
            <div className="p">
              <b>{Math.round(d.price_usd)}$</b>
              {d.ref_usd ? <s>{Math.round(d.ref_usd)}$</s> : null}
            </div>
          </motion.button>
        ))}
      </div>
    </>
  );
}

export function WatchesView({
  watches,
  onRemove,
  onOpen,
}: {
  watches: Watch[] | null;
  onRemove: (id: number) => void;
  onOpen: (w: Watch) => void;
}) {
  return (
    <>
      <div>
        <h2 className="sec-h">Հետևում եմ</h2>
        <p className="sec-p">Օրը 5 անգամ ստուգում ենք ու Telegram-ով գրում, երբ գինը իջնում է քո նշածից։</p>
      </div>
      <div className="list">
        {watches === null && [0, 1].map((i) => <div key={i} className="skel" style={{ height: 96 }} />)}
        {watches?.length === 0 && (
          <div className="empty">Դեռ ոչնչի չես հետևում։ Բացիր ցանկացած ուղղություն ու սեղմիր «Հետևել»։</div>
        )}
        {watches?.map((w, i) => {
          const hit = w.last_price_usd !== null && w.last_price_usd <= w.target_usd;
          const pct = w.last_price_usd ? Math.min(100, Math.round((w.target_usd / w.last_price_usd) * 100)) : 0;
          return (
            <motion.div key={w.id} className="watch" layout initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
              <div className="row">
                <button style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 0, textAlign: "left" }} onClick={() => onOpen(w)}>
                  <div className="ic" style={{ width: 40, height: 40, borderRadius: 11, display: "grid", placeItems: "center", color: "#fff", font: "800 11px var(--f-mono)", background: artGradient(w.dest) }}>
                    {w.dest}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700 }}>{cityName(w.origin)} → {cityName(w.dest)}</div>
                    <div className="meta">
                      {shortDate(w.dep_date)}
                      {w.ret_date ? ` – ${shortDate(w.ret_date)}` : ""}
                      {w.flex_days ? ` · ±${w.flex_days} օր` : ""}
                    </div>
                  </div>
                </button>
                <button className="icon-btn" aria-label="Դադարեցնել հետևումը" onClick={() => { haptic.soft(); onRemove(w.id); }}>
                  <Cross />
                </button>
              </div>
              <div className="row">
                <span className="meta">
                  Հիմա <b className="mono" style={{ color: "var(--ink)" }}>{w.last_price_usd === null ? "—" : `${Math.round(w.last_price_usd)}$`}</b> · թիրախ{" "}
                  <b className="mono" style={{ color: "var(--ink)" }}>{Math.round(w.target_usd)}$</b>
                </span>
                <span className={`b ${hit ? "good" : "warn"}`}>{w.last_price_usd === null ? "Ստուգվում է" : hit ? "Գինը իջավ" : "Սպասում ենք"}</span>
              </div>
              <div className="prog"><i style={{ width: `${hit ? 100 : Math.max(4, pct)}%`, background: hit ? "var(--good)" : undefined }} /></div>
            </motion.div>
          );
        })}
      </div>
      <div className="how">
        <b>Ինչպես է աշխատում</b>
        <ol>
          <li>Որոնման արդյունքներում բացիր ուղղությունը։</li>
          <li>Ընտրիր թիրախային գինը ու սեղմիր «Հետևել»։</li>
          <li>Երբ գինը իջնի, կստանաս հաղորդագրություն՝ ամրագրման հղումով։</li>
        </ol>
      </div>
    </>
  );
}
