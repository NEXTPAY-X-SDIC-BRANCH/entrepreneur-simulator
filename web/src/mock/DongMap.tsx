// 구를 누르면 그 구의 동네(행정동)가 지도처럼 펼쳐진다. SeoulMap과 같은 규칙: 고른 값은 파랑 한 가지의 밝기로만 칠하고, 테두리는 없다.
// 값이 없는 동(점포 20곳 미만 등)은 회색으로 둔다.
import { useEffect, useRef, useState } from "react";
import { RAMP, type Dong } from "./model";
import { DONG_METRICS, dongValue, type DongGeo, type DongMetric, type DongProfile } from "./area";

const rampIndex = (t: number) => Math.min(RAMP.length - 1, Math.max(0, Math.floor(t * RAMP.length)));
const path = (g: DongGeo) => g.rings.map((r) => `M${r.map(([x, y]) => `${x},${-y}`).join("L")}Z`).join("");

export default function DongMap({ geo, profiles, dongs, metric, selected, onSelect }: {
  geo: DongGeo[]; profiles: DongProfile[]; dongs: Dong[]; metric: DongMetric; selected: string | null; onSelect: (name: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [px, setPx] = useState(520); // 지도가 그려진 가로 픽셀 (글자가 읽히는 크기인지 가늠하는 데 쓴다)
  useEffect(() => {
    const el = box.current; if (!el) return;
    const ro = new ResizeObserver(() => setPx(el.clientWidth || 520)); ro.observe(el); setPx(el.clientWidth || 520);
    return () => ro.disconnect();
  }, []);
  const [tip, setTip] = useState<{ name: string; x: number; y: number } | null>(null);
  const pBy = new Map(profiles.map((p) => [p.name, p]));
  const dBy = new Map(dongs.map((d) => [d.name, d]));
  const val = (name: string) => { const p = pBy.get(name); return p ? dongValue(metric, p, dBy.get(name)) : null; };
  const nums = geo.map((g) => val(g.name)).filter((v): v is number => v != null);
  const lo = Math.min(...nums), hi = Math.max(...nums);
  const colour = (name: string) => { const v = val(name); return v == null ? "#e9edf2" : RAMP[rampIndex(hi > lo ? (v - lo) / (hi - lo) : 0.5)]; };

  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const g of geo) for (const r of g.rings) for (const [x, y] of r) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, -y); y1 = Math.max(y1, -y); }
  const pad = Math.max(x1 - x0, y1 - y0) * 0.04;
  const focus = tip?.name ?? null;
  const rank = (g: DongGeo) => (g.name === focus ? 2 : g.name === selected ? 1 : 0);
  const ordered = [...geo].sort((a, b) => rank(a) - rank(b));
  const W = x1 - x0 + pad * 2, perUnit = px / W;   // 화면 픽셀 / 지도 단위
  // 글자: 동의 가장 큰 내접원 한가운데에 놓고, 그 원의 지름 안에 이름이 들어가는 크기로 정한다. 9px보다 작아지면 쓰지 않고 마우스를 올리면 보여 준다.
  const label = (g: DongGeo) => {
    const chars = [...g.name].reduce((n, c) => n + (c === "·" || /\d/.test(c) ? 0.55 : 1), 0);
    const f = Math.min((g.r * 2 * 0.9) / (chars * 0.98), g.r * 0.95, W / 28);
    return f * perUnit >= 9 ? f : 0;
  };
  const move = (e: React.PointerEvent, name: string) => {
    const r = box.current!.getBoundingClientRect();
    setTip({ name, x: e.clientX - r.left, y: e.clientY - r.top });
  };
  const m = DONG_METRICS[metric];

  return (
    <div className="m-map2d" ref={box}>
      <svg viewBox={`${x0 - pad} ${y0 - pad} ${x1 - x0 + pad * 2} ${y1 - y0 + pad * 2}`} role="group" aria-label={`동네별 ${m.label}`} className={focus ? "has-focus" : undefined}>
        {ordered.map((g) => {
          const v = val(g.name);
          return (
            <path key={g.code} d={path(g)} fill={colour(g.name)} stroke={colour(g.name)}
              className={[g.name === selected ? "is-on" : "", g.name === focus ? "is-focus" : ""].join(" ")}
              role="button" tabIndex={0} aria-pressed={g.name === selected}
              aria-label={`${g.name}, ${m.label} ${v == null ? "비교 자료 없음" : m.fmt(v)}`}
              onClick={() => onSelect(g.name)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(g.name); } }}
              onFocus={() => setTip((t) => t ?? { name: g.name, x: -999, y: -999 })} onBlur={() => setTip(null)}
              onPointerMove={(e) => move(e, g.name)} onPointerLeave={() => setTip(null)} />
          );
        })}
        {geo.map((g) => {
          const v = val(g.name);
          const dark = v != null && hi > lo && rampIndex((v - lo) / (hi - lo)) >= 3;
          const f = label(g);
          if (!f) return null;
          return (
            <text key={g.code} x={g.p[0]} y={-g.p[1]} style={{ fontSize: f }}
              className={[dark ? "on-dark" : "", g.name === selected ? "is-on" : "", focus && g.name !== focus && g.name !== selected ? "is-dim" : ""].join(" ")}>{g.name}</text>
          );
        })}
      </svg>
      {tip && tip.x > -900 && (() => {
        const v = val(tip.name);
        return (
          <div className="m-tip" style={{ insetInlineStart: tip.x, insetBlockStart: tip.y }}>
            <strong>{tip.name}</strong>
            <span>{m.label} {v == null ? "비교 자료 없음" : m.fmt(v)}</span>
          </div>
        );
      })()}
    </div>
  );
}

export function dongRange(metric: DongMetric, geo: DongGeo[], profiles: DongProfile[], dongs: Dong[]) {
  const pBy = new Map(profiles.map((p) => [p.name, p]));
  const dBy = new Map(dongs.map((d) => [d.name, d]));
  const nums = geo.map((g) => { const p = pBy.get(g.name); return p ? dongValue(metric, p, dBy.get(g.name)) : null; }).filter((v): v is number => v != null);
  return nums.length ? { lo: Math.min(...nums), hi: Math.max(...nums) } : null;
}
