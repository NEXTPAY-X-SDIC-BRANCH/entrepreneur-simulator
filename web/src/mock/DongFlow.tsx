// 동네 분석: "이 동네 지나가는 사람". 서울시 길단위인구(행정동·자치구)로 총인구, 성별, 연령대, 시간대, 요일 분포와 상주·직장 인구를 보인다.
// 업종에 맞는 시간대·요일(카페는 낮과 주말, 고깃집은 저녁과 금·토)을 진하게 칠한다. 길단위 값은 추정치라 '하루 약 n명'으로만 적는다.
import { FLOW_DAYS, flowMeta, flowOf, flowPerDay, type FlowBlock } from "./area";
import { iga, industry } from "./model";

const people = (n: number) => `${n >= 10000 ? `${Math.round(n / 1000) / 10}만` : n.toLocaleString("ko-KR")} 명`;
const pct = (x: number) => `${Math.round(x * 100)}%`;
// 업종별로 강조할 시간대(인덱스: 00~06, 06~11, 11~14, 14~17, 17~21, 21~24)와 요일(월..일)
const HI = {
  bbq: { band: [4, 5], dow: [4, 5], bandText: "저녁(17~24시)", dowText: "금·토요일" },
  cafe: { band: [1, 2, 3], dow: [5, 6], bandText: "낮(06~17시)", dowText: "토·일요일" },
} as const;

function Bars({ labels, v, hi, title }: { labels: string[]; v: number[]; hi: readonly number[]; title: string }) {
  const max = Math.max(...v, 0.0001);
  return (
    <div className="fl-bars" role="img" aria-label={`${title}: ${labels.map((l, i) => `${l} ${pct(v[i])}`).join(", ")}`}>
      {v.map((x, i) => (
        <div key={labels[i]} className={hi.includes(i) ? "is-hi" : ""}>
          <b>{pct(x)}</b><i style={{ blockSize: `${Math.max(4, (x / max) * 64)}px` }} /><span>{labels[i]}</span>
        </div>
      ))}
    </div>
  );
}

export default function DongFlow({ code, gu, dong }: { code: string | undefined; gu: string; dong: string | null }) {
  const f = flowOf(code, gu), meta = flowMeta();
  if (!f || !meta) return null;
  const ind = industry(), hi = HI[ind], r: FlowBlock = f.row;
  const place = f.scope === "dong" && dong ? dong : gu;
  const top = (v: number[]) => v.indexOf(Math.max(...v));
  const hiShare = (v: number[] | undefined, idx: readonly number[]) => (v ? idx.reduce((a, i) => a + v[i], 0) : 0);
  const q = meta.quarter;
  return (
    <section className="a-flow" aria-labelledby="flow-title">
      <header>
        <span id="flow-title" className="a-kw-eyebrow">{place}의 유동인구</span>
        <p className="fl-big">이 동네 유동인구(추정) <mark>하루 약 {people(flowPerDay(r))}</mark></p>
        <small>추정이에요. 서울시 길단위인구({q.slice(0, 4)}년 {q.slice(4)}분기)를 {FLOW_DAYS}일로 나눴고, 같은 사람이 여러 번 세어질 수 있어요.</small>
      </header>
      <p className="fl-lead">
        {iga(meta.age[top(r.age)])} 가장 많고(전체의 {pct(r.age[top(r.age)])}){r.male != null ? `, 남성 ${pct(r.male)} · 여성 ${pct(1 - r.male)}이에요.` : "."}
        {r.band && r.dow && <> {hi.bandText}에 {pct(hiShare(r.band, hi.band))}, {hi.dowText}에 {pct(hiShare(r.dow, hi.dow))}가 지나가요(고르게 나누면 각각 {pct(hi.band.length / 6)}, {pct(hi.dow.length / 7)}).</>}
      </p>
      <div className="fl-grid">
        <div><h3>연령대 <small>{iga(meta.age[top(r.age)])} 가장 많아요</small></h3><Bars title="연령대" labels={meta.age} v={r.age} hi={[top(r.age)]} /></div>
        {r.band && <div><h3>시간대 <small>{iga(meta.band[top(r.band)] + "시")} 가장 붐벼요</small></h3><Bars title="시간대" labels={meta.band} v={r.band} hi={hi.band} /></div>}
        {r.dow && <div><h3>요일 <small>{iga(meta.dow[top(r.dow)] + "요일")} 가장 붐벼요</small></h3><Bars title="요일" labels={meta.dow} v={r.dow} hi={hi.dow} /></div>}
      </div>
      {r.band && r.dow && <p className="fl-src">진하게 칠한 칸은 {ind === "cafe" ? "카페" : "고깃집"}이 주로 장사하는 시간대·요일이에요(연령대는 가장 많은 연령대).</p>}
      {(f.resi || f.work) && (
        <p className="fl-pop">
          {f.resi && <span>거주민 <b>{people(f.resi.tot)}</b></span>}
          {f.work ? <span>직장인 <b>{people(f.work.tot)}</b></span> : <span>직장인 <b>자료 없음</b></span>}
          <small>거주민·직장인은 유동인구와 달리 사는 곳, 일하는 곳 기준이에요.</small>
        </p>
      )}
      <p className="fl-src">{place} 기준 값이에요. 출처: 서울시 상권분석서비스(길단위인구·상주인구·직장인구).</p>
    </section>
  );
}

/** 시뮬 정산 한 줄: 이 동네 지나가는 사람 대비 우리 가게 손님. 한 달 손님 수를 30일로 나눈 하루 평균이다. 길단위인구는 추정이라 그렇게 적는다. */
export function flowRatioNote(code: string | undefined, gu: string, customersPerMonth: number): string | null {
  const f = flowOf(code, gu);
  if (!f || customersPerMonth <= 0) return null;
  const pass = flowPerDay(f.row), mine = customersPerMonth / 30;
  const ratio = (mine / pass) * 100;
  return `이 동네 유동인구 하루 약 ${people(pass)}(추정) 중 우리 가게 손님은 하루 평균 약 ${Math.round(mine).toLocaleString("ko-KR")}명(${ratio < 0.1 ? ratio.toFixed(2) : ratio.toFixed(1)}%)이에요. 유동인구는 추정이라 같은 사람이 여러 번 세어질 수 있어요.`;
}
