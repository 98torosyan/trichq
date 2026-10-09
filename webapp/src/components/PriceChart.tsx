import { shortDate } from "../lib/format";

/** Price history: area + line of the daily cheapest price, a dashed typical-price line and an emphasised endpoint. */
export function PriceChart({ points, refUsd }: { points: { day: string; price: number }[]; refUsd: number | null }) {
  if (points.length < 2) return null;
  const W = 320;
  const H = 130;
  const pl = 38;
  const pr = 10;
  const pt = 10;
  const pb = 20;
  const vals = points.map((p) => p.price);
  const mn = Math.min(...vals, refUsd ?? Infinity);
  const mx = Math.max(...vals, refUsd ?? -Infinity);
  const step = mx - mn > 200 ? 50 : 10;
  const lo = Math.floor((mn - step / 2) / step) * step;
  const hi = Math.ceil((mx + step / 2) / step) * step;
  const X = (i: number) => pl + (i * (W - pl - pr)) / (points.length - 1);
  const Y = (v: number) => pt + ((hi - v) * (H - pt - pb)) / (hi - lo || 1);
  const line = points.map((p, i) => `${i ? "L" : "M"}${X(i).toFixed(1)} ${Y(p.price).toFixed(1)}`).join("");
  const area = `${line}L${X(points.length - 1)} ${H - pb}L${X(0)} ${H - pb}Z`;
  const ticks = [lo, Math.round((lo + hi) / 2), hi];
  const last = points[points.length - 1]!;
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Գնի պատմություն">
      {ticks.map((t) => (
        <g key={t}>
          <line className="grid" x1={pl} x2={W - pr} y1={Y(t)} y2={Y(t)} />
          <text className="ax" x={pl - 6} y={Y(t) + 3} textAnchor="end">{t}$</text>
        </g>
      ))}
      {refUsd !== null && (
        <>
          <line className="ref" x1={pl} x2={W - pr} y1={Y(refUsd)} y2={Y(refUsd)} />
          <text className="ax" x={W - pr} y={Y(refUsd) - 4} textAnchor="end">սովորական {Math.round(refUsd)}$</text>
        </>
      )}
      <path className="area" d={area} />
      <path className="ln" d={line} />
      <circle className="end" cx={X(points.length - 1)} cy={Y(last.price)} r={5} />
      <text className="ax" x={pl} y={H - 5}>{shortDate(points[0]!.day)}</text>
      <text className="ax" x={W - pr} y={H - 5} textAnchor="end">այսօր</text>
    </svg>
  );
}
