import { motion, useDragControls } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { type Offer, type RouteDetail, api } from "../lib/api";
import { addDays, artGradient, duration, longDate, shortDate, stops } from "../lib/format";
import { airlineName, cityName, countryName, visaFor } from "../lib/ref";
import { haptic, onBackButton, openExternal } from "../lib/tg";
import { PlaneIcon } from "./Icons";
import { PriceChart } from "./PriceChart";

export interface SheetTarget {
  origin: string;
  dest: string;
  dep: string;
  ret: string;
  offer: Offer | null;
  refUsd: number | null;
}

interface Props {
  target: SheetTarget;
  pax: number;
  watching: boolean;
  onClose: () => void;
  onWatch: (targetUsd: number) => Promise<void>;
  onPickDates: (dep: string, ret: string) => void;
}

export function DetailSheet({ target, pax, watching, onClose, onWatch, onPickDates }: Props) {
  const { origin, dest, dep, ret } = target;
  const [detail, setDetail] = useState<RouteDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const dragControls = useDragControls();
  // Keep the Telegram back button subscribed once, even though onClose changes on every parent render.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => onBackButton(() => closeRef.current()), []);
  useEffect(() => {
    let alive = true;
    setDetail(null);
    setError(null);
    api
      .route(origin, dest, dep, ret)
      .then((d) => alive && setDetail(d))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [origin, dest, dep, ret]);

  const best: Offer | null = target.offer ?? (detail?.offers[0] as Offer | undefined) ?? null;
  const price = best?.price_usd ?? null;
  const [goal, setGoal] = useState<number>(() => Math.round((price ?? 200) * 0.9));
  useEffect(() => {
    if (price) setGoal(Math.round(price * 0.9));
  }, [price]);

  const history = useMemo(() => (detail?.history ?? []).map((h) => ({ day: h.day, price: h.min_usd })), [detail]);
  const refUsd = target.refUsd ?? (history.length >= 3 ? history.reduce((s, p) => s + p.price, 0) / history.length : null);
  const verdict = useMemo(() => {
    if (price === null || history.length < 3) return null;
    const minHist = Math.min(...history.map((h) => h.price));
    if (price <= minHist) return { cls: "good", text: "Ամենացածր գինը մեր ամբողջ պատմության մեջ։ Ամրագրիր հիմա։" };
    if (refUsd && price < refUsd) return { cls: "good", text: `Սովորականից ${Math.round(refUsd - price)}$ էժան է։ Լավ գին է։` };
    return { cls: "warn", text: "Գինը սովորականից բարձր է։ Ավելի լավ է հետևել ու սպասել։" };
  }, [price, history, refUsd]);

  const visa = visaFor(dest);
  const grid = detail?.grid;
  const gridValues = grid ? grid.cells.flat().filter((v): v is number => v !== null).sort((a, b) => a - b) : [];
  const level = (v: number) => {
    if (gridValues.length < 3) return 2;
    const lo = gridValues[Math.floor(gridValues.length / 3)]!;
    const hi = gridValues[Math.floor((gridValues.length * 2) / 3)]!;
    return v <= lo ? 1 : v <= hi ? 2 : 3;
  };

  return (
    <>
      <motion.div className="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
      <motion.div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={`${cityName(origin)} → ${cityName(dest)}`}
        initial={{ y: "100%" }}
        animate={{ y: 0 }}
        exit={{ y: "100%" }}
        transition={{ type: "spring", damping: 30, stiffness: 300 }}
        drag="y"
        dragListener={false}
        dragControls={dragControls}
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0, bottom: 0.6 }}
        onDragEnd={(_, info) => {
          if (info.offset.y > 120 || info.velocity.y > 600) onClose();
        }}
      >
        {/* Only the handle starts a drag, so the sheet itself scrolls normally on touch screens. */}
        <div className="grab" onPointerDown={(e) => dragControls.start(e)} style={{ touchAction: "none", cursor: "grab" }}>
          <i />
        </div>
        <div className="sh-hero" style={{ background: artGradient(dest) }}>
          <div className="route">
            <span>{origin}</span>
            <span className="ln"><PlaneIcon size={18} /></span>
            <span>{dest}</span>
          </div>
          <div className="c">
            {cityName(dest)}
            {countryName(dest) ? `, ${countryName(dest)}` : ""}
          </div>
          <div className="m">
            {longDate(best?.dep_date ?? dep)} – {longDate(best?.ret_date ?? ret)}
            {best && ` · ${[airlineName(best.airline), stops(best.transfers), duration(best.duration_min)].filter(Boolean).join(" · ")}`}
          </div>
        </div>

        {error && <div className="error" style={{ marginTop: 12 }}>{error}</div>}

        <div className="sbox">
          <h3>Գնի պատմություն <span>{history.length ? `${history.length} օր` : "հավաքվում է"}</span></h3>
          {detail === null && !error ? (
            <div className="skel" style={{ height: 120 }} />
          ) : history.length >= 2 ? (
            <PriceChart points={history} refUsd={refUsd} />
          ) : (
            <p className="meta" style={{ margin: 0 }}>Այս ուղղության պատմությունը դեռ հավաքվում է։ Մի քանի օրից այստեղ կերևա գրաֆիկը։</p>
          )}
          {verdict && <div className={`b ${verdict.cls}`} style={{ whiteSpace: "normal", borderRadius: 10, fontSize: 13, padding: "8px 10px" }}>{verdict.text}</div>}
        </div>

        <div className="sbox">
          <h3>Մոտակա օրերի գները <span>սեղմիր՝ ընտրելու համար</span></h3>
          {!grid ? (
            <div className="skel" style={{ height: 180 }} />
          ) : (
            <>
              <div className="mx">
                <div />
                {grid.cells[0]!.map((_, c) => (
                  <div key={`h${c}`} className="hd">{shortDate(addDays(ret, c - grid.offset))}</div>
                ))}
                {grid.cells.map((row, r) => {
                  const d = addDays(dep, r - grid.offset);
                  return [
                    <div key={`r${r}`} className="rh">{shortDate(d)}</div>,
                    ...row.map((v, c) => {
                      const rr = addDays(ret, c - grid.offset);
                      const cur = r === grid.offset && c === grid.offset;
                      return v === null ? (
                        <button key={`${r}-${c}`} className={`na ${cur ? "cur" : ""}`} disabled>–</button>
                      ) : (
                        <button
                          key={`${r}-${c}`}
                          className={`l${level(v)} ${cur ? "cur" : ""}`}
                          onClick={() => {
                            haptic.select();
                            onPickDates(d, rr);
                          }}
                        >
                          {v}
                        </button>
                      );
                    }),
                  ];
                })}
              </div>
              <div className="meta">Տողերը՝ մեկնում, սյուները՝ վերադարձ</div>
            </>
          )}
        </div>

        {(visa.label || (detail?.offers.length ?? 0) > 1) && (
          <div className="sbox">
            <h3>Մանրամասներ <span>{pax} ուղևոր</span></h3>
            {visa.label && <div className={`b ${visa.kind === "free" ? "good" : visa.kind === "required" ? "bad" : "warn"}`} style={{ alignSelf: "flex-start" }}>{visa.label} · հայկական անձնագրով</div>}
            {detail?.offers.slice(0, 4).map((o, i) => (
              <div key={i} className="watch" style={{ boxShadow: "none", padding: 0, flexDirection: "row", justifyContent: "space-between" }}>
                <span>{airlineName(o.airline) || "—"} · {stops(o.transfers)}</span>
                <b className="mono">{Math.round(o.price_usd * pax)}$</b>
              </div>
            ))}
            <p className="meta" style={{ margin: 0 }}>Ուղեբեռի արժեքը կախված է ավիաընկերությունից, ստուգիր ամրագրելիս։</p>
          </div>
        )}

        <div className="sbox">
          <h3>Հետևել գնին <span>Telegram ծանուցում</span></h3>
          <div className="tgt">
            <span>Գրիր, երբ իջնի</span>
            <input
              type="range"
              min={Math.max(10, Math.round((price ?? goal) * 0.5))}
              max={Math.round(price ?? goal * 1.2)}
              value={goal}
              onChange={(e) => setGoal(Number(e.target.value))}
              aria-label="Թիրախային գին"
            />
            <b>{goal}$</b>
          </div>
        </div>

        <div className="acts">
          <button
            className={`btn2 sec ${watching ? "on" : ""}`}
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              try {
                await onWatch(goal);
              } finally {
                setSaving(false);
              }
            }}
          >
            {watching ? "✓ Հետևում ենք" : saving ? "Պահում ենք…" : "🔔 Հետևել"}
          </button>
          <button
            className="btn2 pri"
            disabled={!best?.link}
            onClick={() => {
              haptic.tap();
              if (best?.link) openExternal(best.link);
            }}
          >
            Ամրագրել ↗
          </button>
        </div>
      </motion.div>
    </>
  );
}
