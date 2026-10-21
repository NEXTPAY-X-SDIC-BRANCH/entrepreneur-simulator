// 돼지고기 도매가 대시보드 (lab:pork, 10/20 피드백 6번). 고깃집 흐름의 '돼지고기 시세' 버튼으로 열린다.
// 자료: /mock/pork_forecast.json (pipelines/build_pork_forecast.py). 숫자마다 공공 통계 / 업계 자료 / 추정 / 가정을 붙인다.
import { useEffect, useState } from "react";
import PriceChart from "./PriceChart";
import SeasonBars from "./SeasonBars";
import { METHOD_KO, mon, signed, won, ym, type DiseaseEvent, type Driver, type PorkForecast, type Source } from "./types";
import "./pork.css";

export default function PorkDashboard({ onClose }: { onClose: () => void }) {
  const [d, setD] = useState<PorkForecast | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}mock/pork_forecast.json`).then((r) => r.json()).then(setD).catch(() => setErr(true));
  }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [onClose]);

  return (
    <div className="pk" role="dialog" aria-modal="true" aria-labelledby="pk-title">
      <div className="pk-bar">
        <span className="pk-bar-name">돼지고기 시세</span>
        <button type="button" className="pk-close" onClick={onClose}>닫고 돌아가기</button>
      </div>
      {err && <p className="pk-msg">시세 자료를 불러오지 못했어요. pipelines/build_pork_forecast.py로 pork_forecast.json을 만들어 주세요.</p>}
      {!d && !err && <p className="pk-msg">시세 자료를 불러오는 중이에요</p>}
      {d && <Body d={d} />}
    </div>
  );
}

function Body({ d }: { d: PorkForecast }) {
  const hist = Object.entries(d.history);
  const [lastK, lastV] = hist[hist.length - 1];
  const yoyK = `${Number(lastK.slice(0, 4)) - 1}${lastK.slice(4)}`;
  const fc = Object.entries(d.forecast);
  const [f1k, f1] = fc[0];
  const [f6k, f6] = fc[fc.length - 1];
  const disease = d.drivers.find((x) => x.kind === "disease");
  const events = ((disease?.data?.events as DiseaseEvent[]) ?? []);
  const bt = d.backtest;
  const pick = d._meta.method_key;
  const parts = Object.entries(d.parts).sort((a, b) => b[1].latest - a[1].latest);

  return (
    <main className="pk-main">
      <header className="pk-head">
        <h1 id="pk-title">삼겹살 도매가, 앞으로 6개월</h1>
        <p className="pk-lede">
          고깃집이 사는 단계의 값(도매 식육포장, 전국 평균)이에요. {ym(lastK)} {won(lastV)}원/kg에서 {mon(f6k)}에는 {won(f6.mid)}원 안팎으로 예상돼요.
        </p>
        <p className="pk-src">기준 {ym(lastK)} · 출처 {d._meta.source} · <Tag kind="data" /> 실제 값 <Tag kind="est" /> 예측 값</p>
      </header>

      <div className="pk-top">
        <section className="pk-card pk-now" aria-labelledby="pk-now-h">
          <h2 id="pk-now-h" className="pk-h">지금과 다음 달</h2>
          <div className="pk-hero"><span className="pk-hero-v">{won(lastV)}</span><span className="pk-hero-u">원/kg</span></div>
          <p className="pk-hero-cap">{ym(lastK)} 실제 <Tag kind="data" />{d.history[yoyK] ? ` · 1년 전 ${won(d.history[yoyK])}원보다 ${signed(100 * (lastV / d.history[yoyK] - 1))}` : ""}</p>
          <dl className="pk-mini">
            <div><dt>{mon(f1k)} 예측 <Tag kind="est" /></dt><dd>{won(f1.mid)}원</dd><dd className="pk-sub">80% 범위 {won(f1.lo)}~{won(f1.hi)}</dd></div>
            <div><dt>{mon(f6k)} 예측 <Tag kind="est" /></dt><dd>{won(f6.mid)}원</dd><dd className="pk-sub">80% 범위 {won(f6.lo)}~{won(f6.hi)}</dd></div>
          </dl>
          <PriceChart history={d.history} forecast={d.forecast} events={events} />
        </section>

        <section className="pk-card pk-parts" aria-labelledby="pk-parts-h">
          <h2 id="pk-parts-h" className="pk-h">부위별 도매 시세 ({ym(parts[0][1].month.replace("-", ""))})</h2>
          <table>
            <thead><tr><th scope="col">부위</th><th scope="col">원/kg</th><th scope="col">전월</th><th scope="col">1년 전</th></tr></thead>
            <tbody>
              {parts.map(([k, v]) => (
                <tr key={k} className={k === "삼겹살" ? "is-main" : undefined}>
                  <th scope="row">{k}</th><td>{won(v.latest)}</td><td>{signed(v.mom_pct)}</td><td>{signed(v.yoy_pct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="pk-src">도매 식육포장가격 전국 평균 <Tag kind="data" /> · <SrcLink s={d.parts_source} /></p>
        </section>
      </div>

      <section className="pk-card pk-method" aria-labelledby="pk-m-h">
        <h2 id="pk-m-h" className="pk-h">어떻게 예측했나</h2>
        <p className="pk-lead2">
          <b>{METHOD_KO[pick] ?? d._meta.method}</b>이 지난 24개월을 1~6개월 앞에서 맞혀 본 오차가 가장 작았어요 (평균 {bt[pick].mape_1_6}%). 그래서 이 방법으로 예측했어요.
        </p>
        <table className="pk-bt">
          <thead><tr><th scope="col">방법</th><th scope="col">1~6개월 앞 평균 오차</th><th scope="col">최근 12개월만</th></tr></thead>
          <tbody>
            {["ceo_cpi", "ceo", "seasonal", "naive"].filter((k) => bt[k]).map((k) => (
              <tr key={k} className={k === pick ? "is-pick" : undefined}>
                <th scope="row">{METHOD_KO[k]}{k === pick && <span className="pk-pick">사용</span>}</th>
                <td><Meter v={bt[k].mape_1_6 ?? 0} max={Math.max(...Object.values(bt).map((x) => x.mape_1_6 ?? 0))} />{bt[k].mape_1_6}%</td>
                <td>{bt[k].mape_1_6_last12}%</td>
              </tr>
            ))}
          </tbody>
        </table>
        <ul className="pk-notes">
          <li>물가 상승률 = KOSIS 돼지고기 생활물가지수 최근 12개월 평균 ÷ 그 전 12개월 평균. 도매가 상승률 = 같은 식을 도매가로</li>
          <li>{d._meta.selection_note}</li>
          <li>범위: {d._meta.interval}. 질병·날씨 같은 사건은 넣지 않았어요</li>
          <li>시뮬레이션 엔진은 이 예측을 달마다 고기 원가에 반영할 수 있어요 (지금은 꺼져 있음). 켜면 {ym(d.cost_mult.base_month.replace("-", ""))} {won(d.cost_mult.base_value)}원 대비 예측 비율만큼 1인분 원가가 바뀌어요 <Tag kind="assume" /></li>
        </ul>
      </section>

      <h2 className="pk-sec">값을 움직이는 것들</h2>
      <div className="pk-drivers">
        <div className="pk-col">{d.drivers.filter((x) => x.kind !== "disease").map((x, i) => <DriverCard key={x.kind + i} x={x} />)}</div>
        <div className="pk-col">{d.drivers.filter((x) => x.kind === "disease").map((x, i) => <DriverCard key={x.kind + i} x={x} />)}</div>
      </div>
      <p className="pk-foot">돼지고기 가격은 질병, 시기, 날씨, 공급에 민감해요. 이 화면의 근거는 공공 통계와 정부 발표이고, 근거가 없는 설명은 '가정'으로 표시했어요.</p>
    </main>
  );
}

function DriverCard({ x }: { x: Driver }) {
  const events = (x.data?.events as DiseaseEvent[] | undefined) ?? [];
  const si = x.data?.seasonal_index_belly as Record<string, number> | undefined;
  return (
    <section className={`pk-card pk-drv is-${x.kind}`} aria-label={x.label}>
      <h3 className="pk-h3">{x.label}</h3>
      <p className="pk-key">{x.summary}</p>
      {si && <SeasonBars index={si} />}
      {x.kind === "disease" && (
        <ol className="pk-events">
          {[...events].reverse().map((e) => (
            <li key={e.date}>
              <div className="pk-ev-top"><time dateTime={e.date}>{e.date.replaceAll("-", ".")}</time><span className={`pk-evk is-${e.kind.toLowerCase()}`}>{e.kind === "ASF" ? "아프리카돼지열병" : "구제역"} · {e.species}</span></div>
              <p className="pk-ev-l">{e.label}</p>
              {e.change_pct != null && (
                <p className="pk-ev-n">지육가 {e.window?.replaceAll("-", ".")}: {won(e.price_before!)} → {won(e.price_after!)}원 ({signed(e.change_pct)}){e.deseason_change_pct != null ? `, 계절 효과 빼면 ${signed(e.deseason_change_pct)}` : ""}</p>
              )}
              {e.note && <p className="pk-ev-note">{e.note}</p>}
              <p className="pk-ev-src">출처 <SrcLink s={e.source} /></p>
            </li>
          ))}
        </ol>
      )}
      <details className="pk-more">
        <summary>더 보기</summary>
        <p>{x.evidence}</p>
      </details>
      <p className="pk-src"><Tag kind={x.basis.includes("업계") ? "industry" : "data"} label={x.basis} /> {x.kind !== "disease" && <>· {dedupe(x.sources).map((s, i) => <span key={i}>{i > 0 && ", "}<SrcLink s={s} /></span>)}</>}</p>
    </section>
  );
}

const dedupe = (ss: Source[]) => ss.filter((s, i) => ss.findIndex((t) => t.title === s.title) === i);

function SrcLink({ s }: { s: Source }) {
  const text = `${s.publisher}${s.page ? ` p.${s.page}` : ""}`;
  return s.url ? <a href={s.url} target="_blank" rel="noreferrer noopener" title={s.title}>{text}</a> : <span title={s.title}>{text}</span>;
}

function Tag({ kind, label }: { kind: "data" | "est" | "assume" | "industry"; label?: string }) {
  const t = { data: "공공 통계", est: "추정", assume: "가정", industry: "업계 자료" }[kind];
  return <span className={`pk-tag is-${kind}`}>{label ?? t}</span>;
}

function Meter({ v, max }: { v: number; max: number }) {
  return <span className="pk-meter" aria-hidden="true"><i style={{ inlineSize: `${(v / max) * 100}%` }} /></span>;
}
