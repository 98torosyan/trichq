import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DetailSheet, type SheetTarget } from "./components/DetailSheet";
import { DealsView, WatchesView } from "./components/Feeds";
import { BellIcon, FireIcon, PlaneIcon, SearchIcon } from "./components/Icons";
import { Board, ResultsView } from "./components/Results";
import { RouteMap } from "./components/RouteMap";
import { type SearchParams, SearchPanel } from "./components/SearchPanel";
import { ApiError, type SearchResponse, type Watch, api } from "./lib/api";
import { addDays, longDate, nightsBetween, todayYerevan } from "./lib/format";
import { cityName } from "./lib/ref";
import { haptic, inTelegram } from "./lib/tg";

type Tab = "search" | "deals" | "watches";

function initialParams(): SearchParams {
  const today = todayYerevan();
  const dep = addDays(today, 21);
  return { origin: "EVN", alts: [], dep, ret: addDays(dep, 4), flex: 2, pax: 1 };
}

/** ?o=EVN&d=AYT&dep=...&ret=... opens a route directly (used by price-alert buttons). */
function deepLink(): SheetTarget | null {
  const p = new URLSearchParams(location.search);
  const o = p.get("o");
  const d = p.get("d");
  const dep = p.get("dep");
  const ret = p.get("ret");
  if (!o || !d || !dep || !ret) return null;
  return { origin: o, dest: d, dep, ret, offer: null, refUsd: null };
}

export default function App() {
  const [tab, setTab] = useState<Tab>("search");
  const [params, setParams] = useState<SearchParams>(initialParams);
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<SheetTarget | null>(deepLink);
  const [watches, setWatches] = useState<Watch[] | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number>();
  const resultsRef = useRef<HTMLDivElement>(null);

  const say = useCallback((msg: string) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2800);
  }, []);

  const loadWatches = useCallback(() => {
    api.watches().then((r) => setWatches(r.watches)).catch(() => setWatches([]));
  }, []);
  useEffect(loadWatches, [loadWatches]);

  const search = useCallback(
    async (p: SearchParams = params) => {
      setBusy(true);
      setError(null);
      setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
      try {
        const res = await api.search(p);
        setData(res);
        haptic.success();
      } catch (e) {
        setError(e instanceof ApiError ? e.message : "Չհաջողվեց որոնել։ Փորձիր նորից։");
        haptic.error();
      } finally {
        setBusy(false);
      }
    },
    [params],
  );

  // First search on open, so the app never starts empty.
  useEffect(() => {
    void search();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isWatched = (t: SheetTarget) =>
    (watches ?? []).some((w) => w.origin === t.origin && w.dest === t.dest && w.dep_date === (t.offer?.dep_date ?? t.dep));

  const addWatch = async (t: SheetTarget, target: number) => {
    try {
      const dep = t.offer?.dep_date ?? t.dep;
      const ret = t.offer?.ret_date ?? t.ret;
      await api.addWatch({ origin: t.origin, dest: t.dest, dep_date: dep, ret_date: ret, flex_days: params.flex ? 1 : 0, target_usd: target });
      haptic.success();
      say(`Կգրենք Telegram-ով, երբ ${cityName(t.dest)}-ն իջնի ${target}$-ից`);
      loadWatches();
    } catch (e) {
      haptic.error();
      say(e instanceof ApiError ? e.message : "Չհաջողվեց պահել");
    }
  };

  const pins = useMemo(
    () => (data?.results ?? []).slice(0, 14).map((r) => ({ code: r.dest, price: r.best?.price_usd ?? r.alt?.effective_usd ?? null })),
    [data],
  );

  const goTab = (t: Tab) => {
    haptic.select();
    setTab(t);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <MotionConfig reducedMotion="user">
      <div className="app">
        <header className="top">
          <div className="brand">
            <div className="logo" aria-hidden="true"><PlaneIcon /></div>
            <div>
              <b>Թռիչք</b>
              <small>ԷԺԱՆ ՏՈՄՍԵՐ ՀԱՅԱՍՏԱՆԻՑ</small>
            </div>
          </div>
          {!inTelegram && <span className="pill-muted">Բացիր Telegram-ով</span>}
        </header>

        <AnimatePresence mode="wait">
          <motion.section
            key={tab}
            initial={{ opacity: 0, x: 12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -12 }}
            transition={{ duration: 0.22 }}
            style={{ display: "flex", flexDirection: "column", gap: 18 }}
          >
            {tab === "search" && (
              <>
                <div className="hero">
                  <h1>
                    Նշիր օրերը։ <em>Ամենաէժան ուղղությունները</em> մենք կգտնենք։
                  </h1>
                  <p>Ստուգում ենք Հայաստանից բոլոր թռիչքները ու դասավորում ըստ գնի։</p>
                  <RouteMap origin={params.origin} pins={pins} />
                </div>
                <SearchPanel value={params} onChange={setParams} onSearch={() => void search()} busy={busy} />
                <div ref={resultsRef} style={{ scrollMarginTop: 12 }} />
                {busy && <Board origin={params.origin} alts={params.alts} />}
                {!busy && error && <div className="error" role="alert">{error}</div>}
                {!busy && data && (
                  <>
                    <p className="meta" style={{ margin: 0 }}>
                      {longDate(data.query.dep)} – {longDate(data.query.ret)} · {nightsBetween(data.query.dep, data.query.ret)} գիշեր
                      {data.query.flex ? ` · ±${data.query.flex} օր` : ""}
                    </p>
                    <ResultsView
                      items={data.results}
                      pax={params.pax}
                      onOpen={(it) => {
                        const offer = it.best ?? it.alt;
                        setSheet({
                          origin: offer?.origin ?? data.query.origin,
                          dest: it.dest,
                          dep: offer?.dep_date ?? data.query.dep,
                          ret: offer?.ret_date ?? data.query.ret,
                          offer: offer ?? null,
                          refUsd: it.ref_usd,
                        });
                      }}
                    />
                  </>
                )}
              </>
            )}
            {tab === "deals" && (
              <DealsView
                onOpen={(d) =>
                  setSheet({
                    origin: d.origin,
                    dest: d.dest,
                    dep: d.dep_date,
                    ret: d.ret_date ?? addDays(d.dep_date, 4),
                    offer: d.ret_date
                      ? { origin: d.origin, dep_date: d.dep_date, ret_date: d.ret_date, price_usd: d.price_usd, airline: d.airline, transfers: d.transfers, return_transfers: null, duration_min: null, link: d.link }
                      : null,
                    refUsd: d.ref_usd,
                  })
                }
              />
            )}
            {tab === "watches" && (
              <WatchesView
                watches={watches}
                onOpen={(w) => setSheet({ origin: w.origin, dest: w.dest, dep: w.dep_date, ret: w.ret_date ?? addDays(w.dep_date, 4), offer: null, refUsd: null })}
                onRemove={async (id) => {
                  setWatches((ws) => (ws ?? []).filter((w) => w.id !== id));
                  try {
                    await api.removeWatch(id);
                    say("Հետևումը դադարեցվեց");
                  } catch {
                    loadWatches();
                  }
                }}
              />
            )}
          </motion.section>
        </AnimatePresence>

        <p className="foot">Թռիչք · գները Aviasales-ից և մեր գիշերային հավաքումից · ամրագրելուց առաջ ստուգիր</p>
      </div>

      <div className="tabs">
        <nav role="tablist">
          <button className="tab" role="tab" aria-selected={tab === "search"} onClick={() => goTab("search")}>
            <SearchIcon />Որոնում
          </button>
          <button className="tab" role="tab" aria-selected={tab === "deals"} onClick={() => goTab("deals")}>
            <FireIcon />Որս
          </button>
          <button className="tab" role="tab" aria-selected={tab === "watches"} onClick={() => goTab("watches")}>
            <BellIcon />Հետևում
            {watches && watches.length > 0 && <span className="dotn">{watches.length}</span>}
          </button>
        </nav>
      </div>

      <AnimatePresence>
        {sheet && (
          <DetailSheet
            key={`${sheet.dest}-${sheet.dep}-${sheet.ret}`}
            target={sheet}
            pax={params.pax}
            watching={isWatched(sheet)}
            onClose={() => setSheet(null)}
            onWatch={(goal) => addWatch(sheet, goal)}
            onPickDates={(dep, ret) => {
              setSheet(null);
              const next = { ...params, dep, ret };
              setParams(next);
              setTab("search");
              void search(next);
            }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {toast && (
          <motion.div className="toast" role="status" initial={{ opacity: 0, y: 24, x: "-50%" }} animate={{ opacity: 1, y: 0, x: "-50%" }} exit={{ opacity: 0, y: 24, x: "-50%" }}>
            {toast}
          </motion.div>
        )}
      </AnimatePresence>
    </MotionConfig>
  );
}
