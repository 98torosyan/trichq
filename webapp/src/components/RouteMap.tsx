import { useEffect, useMemo, useRef, useState } from "react";
import { coords } from "../lib/ref";

const W = 360;
const H = 178;
// Equirectangular window centred on the region Armenians fly to most: Europe, Middle East, Central Asia.
const LON0 = -12;
const LON1 = 82;
const LAT0 = 18;
const LAT1 = 62;
const project = ([lat, lon]: [number, number]): [number, number] => [
  ((lon - LON0) / (LON1 - LON0)) * W,
  ((LAT1 - lat) / (LAT1 - LAT0)) * H,
];

interface Pin {
  code: string;
  price: number | null;
}

/** Animated arcs from the origin to the cheapest destinations; a plane flies each route and drops a price tag. */
export function RouteMap({ origin, pins }: { origin: string; pins: Pin[] }) {
  const home = coords(origin) ?? [40.15, 44.4];
  const [hx, hy] = project(home);
  const arcs = useMemo(
    () =>
      pins
        .map((p) => {
          const c = coords(p.code);
          if (!c) return null;
          const [x, y] = project(c);
          if (x < 0 || x > W || y < 0 || y > H) return null;
          const dist = Math.hypot(x - hx, y - hy);
          const d = `M${hx} ${hy} Q${(hx + x) / 2} ${(hy + y) / 2 - dist * 0.38} ${x} ${y}`;
          return { ...p, x, y, d };
        })
        .filter((a): a is NonNullable<typeof a> => a !== null)
        .slice(0, 14),
    [pins, hx, hy],
  );

  const pathRefs = useRef<(SVGPathElement | null)[]>([]);
  const planeRef = useRef<SVGPathElement>(null);
  const [tag, setTag] = useState<{ x: number; y: number; text: string } | null>(null);

  useEffect(() => {
    if (!arcs.length || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    let idx = 0;
    let t0 = performance.now();
    const cycle = 2600;
    const loop = (now: number) => {
      const top = arcs.slice(0, 6);
      const arc = top[idx % top.length]!;
      const path = pathRefs.current[arcs.indexOf(arc)];
      let k = (now - t0) / cycle;
      if (k >= 1.5) {
        idx += 1;
        t0 = now;
        k = 0;
      }
      if (path && planeRef.current) {
        const L = path.getTotalLength();
        const kk = Math.min(k, 1);
        const e = kk < 0.5 ? 2 * kk * kk : 1 - (-2 * kk + 2) ** 2 / 2;
        const p1 = path.getPointAtLength(L * e);
        const p2 = path.getPointAtLength(Math.min(L, L * e + 1));
        const ang = (Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180) / Math.PI;
        planeRef.current.setAttribute("transform", `translate(${p1.x} ${p1.y}) rotate(${ang})`);
        planeRef.current.setAttribute("opacity", kk >= 1 ? "0" : "1");
        if (kk >= 1 && arc.price !== null) setTag((t) => (t?.text.startsWith(arc.code) ? t : { x: arc.x, y: arc.y, text: `${arc.code} ${Math.round(arc.price!)}$` }));
        else if (kk < 1) setTag(null);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [arcs]);

  const tagW = tag ? tag.text.length * 5.1 + 10 : 0;
  return (
    <svg className="map" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Թռիչքների քարտեզ">
      {arcs.map((a, i) => (
        <g key={a.code}>
          <path d={a.d} className="arc-base" />
          <path
            ref={(el) => {
              pathRefs.current[i] = el;
            }}
            d={a.d}
            className="arc"
            pathLength={1}
            style={{ strokeDasharray: 1, strokeDashoffset: 1, animation: `draw 4.2s ${i * 0.26}s ease-in-out infinite` }}
          />
          <circle cx={a.x} cy={a.y} r={1.8} className="dot" />
          <text x={a.x + (a.x < hx ? -3 : 3)} y={a.y - 4} className="lbl" textAnchor={a.x < hx ? "end" : "start"}>
            {a.code}
          </text>
        </g>
      ))}
      <circle cx={hx} cy={hy} r={4} fill="none" stroke="#FF9150">
        <animate attributeName="r" from="4" to="16" dur="1.8s" repeatCount="indefinite" />
        <animate attributeName="opacity" from="0.9" to="0" dur="1.8s" repeatCount="indefinite" />
      </circle>
      <circle cx={hx} cy={hy} r={4} className="home" />
      <text x={hx + 7} y={hy + 12} className="lbl" style={{ fill: "#FF9150", fontSize: 9 }}>
        {origin}
      </text>
      {tag && (
        <g className="tag" transform={`translate(${Math.min(W - tagW - 4, Math.max(4, tag.x - tagW / 2))} ${tag.y - 22})`}>
          <rect rx={4} height={13} width={tagW} />
          <text x={5} y={9.5}>
            {tag.text}
          </text>
        </g>
      )}
      <path ref={planeRef} d="M6 0 L-4 -4.5 L-1.5 0 L-4 4.5 Z" fill="#fff" opacity={0} />
      <style>{"@keyframes draw{0%{stroke-dashoffset:1;opacity:0}10%{opacity:.75}50%{stroke-dashoffset:0;opacity:.75}100%{stroke-dashoffset:0;opacity:0}}"}</style>
    </svg>
  );
}
