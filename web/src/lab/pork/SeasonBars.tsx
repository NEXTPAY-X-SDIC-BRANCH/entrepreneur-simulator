// 달별 계절지수 (1.00 = 연중 평균). 위는 평균보다 비싼 달, 아래는 싼 달. 값은 막대 위 툴팁과 표에 있다.
import { useState } from "react";

const W = 520, H = 130, PL = 34, PR = 8, MID = 58, SCALE = 260;

export default function SeasonBars({ index }: { index: Record<string, number> }) {
  const [hov, setHov] = useState<number | null>(null);
  const bw = (W - PL - PR) / 12;
  const ms = Array.from({ length: 12 }, (_, i) => i + 1);
  return (
    <div className="pk-season">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`달별 계절지수: ${ms.map((m) => `${m}월 ${index[m].toFixed(2)}`).join(", ")}`}>
        {[1.1, 1.0, 0.9].map((t) => (
          <g key={t}>
            <line x1={PL} x2={W - PR} y1={MID - (t - 1) * SCALE} y2={MID - (t - 1) * SCALE} className={t === 1 ? "pk-base" : "pk-grid"} />
            <text x={PL - 6} y={MID - (t - 1) * SCALE + 4} className="pk-ax" textAnchor="end">{t.toFixed(1)}</text>
          </g>
        ))}
        {ms.map((m) => {
          const v = index[m], h = Math.abs(v - 1) * SCALE, x = PL + (m - 1) * bw + bw * 0.2, w = Math.min(24, bw * 0.6);
          const up = v >= 1;
          const r = Math.min(4, h);
          const d = up
            ? `M${x},${MID} V${MID - h + r} Q${x},${MID - h} ${x + r},${MID - h} H${x + w - r} Q${x + w},${MID - h} ${x + w},${MID - h + r} V${MID} Z`
            : `M${x},${MID} V${MID + h - r} Q${x},${MID + h} ${x + r},${MID + h} H${x + w - r} Q${x + w},${MID + h} ${x + w},${MID + h - r} V${MID} Z`;
          return (
            <g key={m} onPointerEnter={() => setHov(m)} onPointerLeave={() => setHov(null)}>
              <rect x={PL + (m - 1) * bw} y={0} width={bw} height={H} fill="transparent" />
              <path d={d} className={up ? "pk-bar-up" : "pk-bar-dn"} opacity={hov && hov !== m ? 0.45 : 1} />
              <text x={x + w / 2} y={H - 6} className="pk-ax" textAnchor="middle">{m}월</text>
            </g>
          );
        })}
      </svg>
      {hov && <p className="pk-season-tip" role="status">{hov}월 계절지수 {index[hov].toFixed(2)} (연중 평균보다 {Math.round(Math.abs(index[hov] - 1) * 100)}% {index[hov] >= 1 ? "비쌈" : "쌈"})</p>}
      <p className="pk-legend" aria-hidden="true"><span><i className="pk-key-up" />평균보다 비싼 달</span><span><i className="pk-key-dn" />평균보다 싼 달</span></p>
    </div>
  );
}
