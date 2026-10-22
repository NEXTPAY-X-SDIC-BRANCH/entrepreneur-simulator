// 재료 시세 대시보드: 돼지고기·채소값이 지난 시즌들에 10월 대비 어떻게 움직였는지 (예측이 아니다).
// 데이터: web/public/mock/cost_index.json (pipelines/fetch_cost_index.py). 시즌마다 그해 10월 = 1.
// 엔진도 같은 파일의 평균(index)을 calendar.yaml cost_index로 원가에 곱한다.
import Assume from "./Assume";
import { useEffect, useState } from "react";

type Path = { seasons: string[]; index: Record<string, number>; low: Record<string, number>; high: Record<string, number>; by_season: Record<string, Record<string, number>> };
type CostIndex = { pork: Path; veg: Path; pork_wholesale_jeju: Path };
const SEASON = [10, 11, 12, 1, 2, 3];
let cache: CostIndex | null = null;

function Chart({ title, path, month, lo, hi, note }: { title: string; path: Path; month: number; lo: number; hi: number; note: string }) {
  const W = 300, H = 150, L = 34, R = 8, T = 10, B = 22;
  const x = (i: number) => L + (i * (W - L - R)) / (SEASON.length - 1);
  const y = (v: number) => T + ((hi - v) * (H - T - B)) / (hi - lo);
  const line = (vals: (number | undefined)[]) => vals.map((v, i) => (v == null ? "" : `${i && vals[i - 1] != null ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`)).join("");
  const band = SEASON.map((m, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(path.high[m]).toFixed(1)}`).join("")
    + [...SEASON].reverse().map((m, k) => `L${x(SEASON.length - 1 - k).toFixed(1)},${y(path.low[m]).toFixed(1)}`).join("") + "Z";
  const ticks = [lo, (lo + hi) / 2, 1, hi].filter((v, i, a) => a.indexOf(v) === i && v >= lo && v <= hi);
  const mi = SEASON.indexOf(month);
  return (
    <figure className="pt-fig">
      <figcaption><b>{title}</b>{mi >= 0 && <span>{month}월 평균 {path.index[month].toFixed(2)}배 · 범위 {path.low[month].toFixed(2)}~{path.high[month].toFixed(2)}</span>}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}: 10월을 1로 놓은 지난 시즌별 값`}>
        {ticks.map((v) => <g key={v}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className={v === 1 ? "pt-one" : "pt-grid"} /><text x={L - 4} y={y(v) + 3} textAnchor="end">{v.toFixed(2)}</text></g>)}
        <path d={band} className="pt-band" />
        {path.seasons.map((s) => <path key={s} d={line(SEASON.map((m) => path.by_season[s]?.[m]))} className="pt-season"><title>{s} 시즌</title></path>)}
        <path d={line(SEASON.map((m) => path.index[m]))} className="pt-mean" />
        {mi >= 0 && <circle cx={x(mi)} cy={y(path.index[month])} r={4} className="pt-now" />}
        {SEASON.map((m, i) => <text key={m} x={x(i)} y={H - 6} textAnchor="middle" className={m === month ? "pt-cur" : undefined}>{m}월</text>)}
      </svg>
      <small>{note}</small>
    </figure>
  );
}

export default function PriceTrend({ month }: { month: number }) {
  const [d, setD] = useState<CostIndex | null>(cache);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (cache) return;
    fetch(`${import.meta.env.BASE_URL}mock/cost_index.json`).then((r) => r.json()).then((j) => { cache = j; setD(j); }).catch(() => setD(null));
  }, []);
  if (!d) return null;
  const vals = (p: Path) => SEASON.flatMap((m) => [p.low[m], p.high[m]]);
  const range = (p: Path, pad: number) => [Math.floor((Math.min(...vals(p)) - pad) * 10) / 10, Math.ceil((Math.max(...vals(p)) + pad) * 10) / 10] as const;
  const [plo, phi] = range(d.pork, 0.02), [vlo, vhi] = range(d.veg, 0.05);
  return (
    <section className="pt">
      <button type="button" className="sx-ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? "재료 시세 접기" : "재료 시세 보기 (지난 시즌)"}</button>
      {open && (
        <>
          <p className="sx-note">10월 값을 1로 놓고 지난 시즌마다 그린 선이에요. 굵은 선이 평균이고 색칠한 띠가 가장 싼 해~가장 비싼 해예요. <b>예측이 아니라</b> 과거 같은 시기에 이만큼 움직였다는 뜻이에요. 엔진은 평균값을 이달 원가에 곱해요.<Assume id="priceCheck" /></p>
          <p className="sx-note pt-check">검증해 보니 돼지고기는 계절 평균을 쓰면 6개월 뒤 값을 평균 4.9% 오차로 맞혀요 ('지금 값 그대로'는 6.3%). 다만 실제 값이 과거 띠 안에 든 건 절반쯤이라, 띠 밖으로 크게 오를 수도 있어요.</p>
          <div className="pt-grid2">
            <Chart title="돼지고기" path={d.pork} month={month} lo={plo} hi={phi} note={`통계청 생활물가지수 돼지고기 서울, ${d.pork.seasons[0]}~${d.pork.seasons.at(-1)} 시즌. 10월부터 3월까지 꾸준히 싸져요`} />
            <Chart title="쌈채소·양념 채소" path={d.veg} month={month} lo={vlo} hi={vhi} note={`KAMIS 서울 도매가 상추·깻잎·풋고추·양파·대파 평균, ${d.veg.seasons[0]}~${d.veg.seasons.at(-1)} 시즌. 해마다 차이가 커요`} />
          </div>
        </>
      )}
    </section>
  );
}
