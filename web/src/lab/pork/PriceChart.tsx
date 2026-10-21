// 삼겹살 도매가: 지난 36개월 실제(실선) + 6개월 예측(점선 + 80% 범위). 질병 사건은 x축 위 표시만 (예측에는 안 들어감).
import { useRef, useState } from "react";
import { mon, won, ym, type Band, type DiseaseEvent } from "./types";

type Pt = { k: string; v?: number; band?: Band };
const W = 760, H = 310, PL = 64, PR = 18, PT = 30, PB = 34;

export default function PriceChart({ history, forecast, events }: { history: Record<string, number>; forecast: Record<string, Band>; events: DiseaseEvent[] }) {
  const hist = Object.entries(history).slice(-36);
  const fc = Object.entries(forecast);
  const pts: Pt[] = [...hist.map(([k, v]) => ({ k, v })), ...fc.map(([k, b]) => ({ k, band: b }))];
  const vals = [...hist.map(([, v]) => v), ...fc.flatMap(([, b]) => [b.lo, b.hi])];
  const step = 2000;
  const lo = Math.floor(Math.min(...vals) / step) * step, hi = Math.ceil(Math.max(...vals) / step) * step;
  const X = (i: number) => PL + ((W - PL - PR) * i) / (pts.length - 1);
  const Y = (v: number) => PT + (H - PT - PB) * (1 - (v - lo) / (hi - lo));
  const b = hist.length - 1;
  const last = hist[b][1];
  const band = `M${X(b)},${Y(last)} ${fc.map(([, f], i) => `L${X(b + 1 + i)},${Y(f.hi)}`).join(" ")} ${[...fc].reverse().map(([, f], i) => `L${X(b + fc.length - i)},${Y(f.lo)}`).join(" ")} Z`;
  const ticks: number[] = [];
  for (let v = lo; v <= hi; v += step) ticks.push(v);
  const idxOf = (k: string) => pts.findIndex((p) => p.k === k);
  const evs = events.map((e) => ({ e, i: idxOf(e.date.slice(0, 7).replace("-", "")) })).filter((x) => x.i >= 0);

  const ref = useRef<SVGSVGElement>(null);
  const [hov, setHov] = useState<number | null>(null);
  const move = (ev: React.PointerEvent) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const x = ((ev.clientX - r.left) / r.width) * W;
    const i = Math.round(((x - PL) / (W - PL - PR)) * (pts.length - 1));
    setHov(i >= 0 && i < pts.length ? i : null);
  };
  const hp = hov != null ? pts[hov] : null;

  return (
    <div className="pk-chart">
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`삼겹살 도매가 ${ym(hist[0][0])}부터 ${ym(fc[fc.length - 1][0])}까지. 마지막 실제 ${won(last)}원, 6개월 뒤 예측 ${won(fc[fc.length - 1][1].mid)}원`}
        onPointerMove={move} onPointerLeave={() => setHov(null)}>
        <text x={PL - 10} y={12} className="pk-ax" textAnchor="end">원/kg</text>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={PL} x2={W - PR} y1={Y(v)} y2={Y(v)} className="pk-grid" />
            <text x={PL - 10} y={Y(v) + 4} className="pk-ax" textAnchor="end">{won(v)}</text>
          </g>
        ))}
        <rect x={X(b)} y={PT} width={W - PR - X(b)} height={H - PT - PB} className="pk-fczone" />
        <line x1={X(b)} x2={X(b)} y1={PT} y2={H - PB} className="pk-split" />
        <text x={X(b) + 8} y={PT + 14} className="pk-fclabel">예측</text>
        <text x={X(b) - 8} y={PT + 14} className="pk-ax" textAnchor="end">실제</text>
        <path d={band} className="pk-band" />
        <polyline points={hist.map(([, v], i) => `${X(i)},${Y(v)}`).join(" ")} className="pk-line" />
        <polyline points={`${X(b)},${Y(last)} ${fc.map(([, f], i) => `${X(b + 1 + i)},${Y(f.mid)}`).join(" ")}`} className="pk-fcline" />
        {pts.map((p, i) => (p.k.endsWith("01") || (i === 0 && !pts.slice(0, 4).some((q) => q.k.endsWith("01")))) && (
          <text key={p.k} x={X(i)} y={H - 12} className="pk-ax" textAnchor="middle">{p.k.endsWith("01") ? `${p.k.slice(0, 4)}년` : ym(p.k)}</text>
        ))}
        {evs.map(({ e, i }) => (
          <g key={e.date}>
            <line x1={X(i)} x2={X(i)} y1={H - PB} y2={H - PB - 8} className="pk-evtick" />
            <circle cx={X(i)} cy={H - PB - 11} r={3.5} className={`pk-evdot is-${e.kind.toLowerCase()}`} />
          </g>
        ))}
        <circle cx={X(b)} cy={Y(last)} r={4.5} className="pk-enddot" />
        {hp && hov != null && (
          <g pointerEvents="none">
            <line x1={X(hov)} x2={X(hov)} y1={PT} y2={H - PB} className="pk-cross" />
            <circle cx={X(hov)} cy={Y(hp.v ?? hp.band!.mid)} r={4.5} className={hp.v != null ? "pk-enddot" : "pk-fcdot"} />
          </g>
        )}
        <rect x={PL} y={PT} width={W - PL - PR} height={H - PT - PB} fill="transparent" />
      </svg>
      {hp && hov != null && (
        <div className="pk-tip" style={{ left: `${(X(hov) / W) * 100}%` }} role="status">
          <b>{ym(hp.k)}</b>
          {hp.v != null ? <span>{won(hp.v)}원/kg · 실제</span> : (
            <><span>{won(hp.band!.mid)}원/kg · 예측</span><span className="pk-tip-sub">80% 범위 {won(hp.band!.lo)}~{won(hp.band!.hi)}</span></>
          )}
          {evs.filter((x) => x.i === hov).map(({ e }) => <span key={e.date} className="pk-tip-sub">{e.label}</span>)}
        </div>
      )}
      <div className="pk-legend" aria-hidden="true">
        <span><i className="pk-key-line" />실제</span>
        <span><i className="pk-key-fc" />예측 가운데 값</span>
        <span><i className="pk-key-band" />80% 범위</span>
        <span><i className="pk-key-ev" />질병 발생 (예측에는 안 넣음)</span>
      </div>
      <details className="pk-table">
        <summary>표로 보기</summary>
        <table>
          <thead><tr><th>달</th><th>원/kg</th><th>구분</th></tr></thead>
          <tbody>
            {hist.slice(-12).map(([k, v]) => <tr key={k}><td>{ym(k)}</td><td>{won(v)}</td><td>실제</td></tr>)}
            {fc.map(([k, f]) => <tr key={k}><td>{ym(k)} ({mon(k)})</td><td>{won(f.mid)} ({won(f.lo)}~{won(f.hi)})</td><td>예측</td></tr>)}
          </tbody>
        </table>
      </details>
    </div>
  );
}
