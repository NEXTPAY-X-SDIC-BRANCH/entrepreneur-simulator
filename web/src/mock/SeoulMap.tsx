// 서울 25개 구 as a flat choropleth: the chosen metric is shown by blue lightness only (one hue, light to dark).
// No outlines. The 구 under the pointer lifts with a shadow while the others fade; the chosen 구 keeps that lift.
import { useRef, useState } from "react";
import { METRICS, RAMP, guStat, type Gu, type Metric } from "./model";

const rampIndex = (t: number) => Math.min(RAMP.length - 1, Math.max(0, Math.floor(t * RAMP.length)));
const path = (g: Gu) => g.rings.map((r) => `M${r.map(([x, y]) => `${x},${-y}`).join("L")}Z`).join("");

export default function SeoulMap({ gus, metric, selected, onSelect }: {
  gus: Gu[]; metric: Metric; selected: string; onSelect: (name: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ name: string; x: number; y: number } | null>(null);
  const vals: Record<string, number> = Object.fromEntries(gus.map((g) => [g.name, guStat(g.name)[metric] ?? 0]));
  const all = Object.values(vals);
  const lo = Math.min(...all), hi = Math.max(...all);
  const step = (name: string) => rampIndex(hi > lo ? (vals[name] - lo) / (hi - lo) : 0.5);
  const focus = tip?.name ?? null;
  // draw the chosen 구 and then the hovered one last, so their shadows fall over the neighbours
  const rank = (g: Gu) => (g.name === focus ? 2 : g.name === selected ? 1 : 0);
  const ordered = [...gus].sort((a, b) => rank(a) - rank(b));
  const move = (e: React.PointerEvent, name: string) => {
    const r = box.current!.getBoundingClientRect();
    setTip({ name, x: e.clientX - r.left, y: e.clientY - r.top });
  };

  return (
    <div className="m-map2d" ref={box}>
      <svg viewBox="-21 -16.2 39.6 32.8" role="group" aria-label={`서울 25개 구의 ${METRICS[metric].label}`} className={focus ? "has-focus" : undefined}>
        {ordered.map((g) => (
          <path key={g.code} d={path(g)} fill={RAMP[step(g.name)]} stroke={RAMP[step(g.name)]}
            className={[g.name === selected ? "is-on" : "", g.name === focus ? "is-focus" : ""].join(" ")}
            role="button" tabIndex={0} aria-pressed={g.name === selected} aria-label={`${g.name}, ${METRICS[metric].label} ${METRICS[metric].fmt(vals[g.name])}`}
            onClick={() => onSelect(g.name)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(g.name); } }}
            onFocus={() => setTip((t) => t ?? { name: g.name, x: -999, y: -999 })} onBlur={() => setTip(null)}
            onPointerMove={(e) => move(e, g.name)} onPointerLeave={() => setTip(null)} />
        ))}
        {gus.map((g) => (
          <text key={g.code} x={g.c[0]} y={-g.c[1]} style={{ fontSize: Math.min(0.86, g.r * 0.62) }}
            className={[step(g.name) >= 3 ? "on-dark" : "", g.name === selected ? "is-on" : "", focus && g.name !== focus && g.name !== selected ? "is-dim" : ""].join(" ")}>{g.name}</text>
        ))}
      </svg>
      {tip && tip.x > -900 && (
        <div className="m-tip" style={{ insetInlineStart: tip.x, insetBlockStart: tip.y }}>
          <strong>{tip.name}</strong>
          <span>{METRICS[metric].label} {METRICS[metric].fmt(vals[tip.name])}</span>
        </div>
      )}
    </div>
  );
}
