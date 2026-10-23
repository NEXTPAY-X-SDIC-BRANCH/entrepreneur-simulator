// lab:industry 2단계 동네 분석 (새 업종). 고깃집·카페 화면(Analysis.tsx)과 같은 두 칸: 왼쪽 서울 지도, 오른쪽 '동네 / 드는 돈 / 모자란 돈' 세 칸.
// 지도와 구 숫자는 guStat(model.ts)이 industry_gu.json에서, 동네 숫자는 industry_<id>_dong.json에서 읽는다.
// 자리 잡힌 달 매출과 여는 비용은 엔진(/lab/industry/preview)이 계산한다. 이 업종에 없는 지표(성장률, 동네 유형 이름 짓기, 상권 추천)는 보이지 않는다.
import { useMemo, useState } from "react";
import SeoulMap from "../../mock/SeoulMap";
import { FundsPanel } from "../../mock/Analysis"; // lab:merge 돈 구하는 길
import { LOAN_RATE, METRICS, RAMP, T, dongsOf, guData, guStat, man, type Gu, type Metric, type Profile, type Grade } from "../../mock/model";
import { pct, usePreview, wman, type IndustryCfg } from "./api";
import { LAB_TXT, isLab, josa, type LabIndustry } from "./industries";
import "./industry.css";

const RUNWAY = 3; // 가정: 자리 잡기 전 석 달 치 고정비

// cfg·setCfg: 여기서 고른 평수·마감이 가게 꾸미기(IndustryBuild)로 그대로 넘어간다
export default function IndustryArea({ profile, setProfile, gus, onNext, cfg: cfgIn, setCfg }: { profile: Profile; setProfile: (p: Profile) => void; gus: Gu[]; onNext: () => void; cfg?: IndustryCfg | null; setCfg?: (c: IndustryCfg) => void }) {
  const ind = profile.industry as LabIndustry;
  const [metric, setMetric] = useState<Metric>("demand");
  // lab:merge 수빈 10/23: 고깃집·카페 동네 분석처럼 '동네 / 드는 돈 / 모자란 돈' 세 칸으로 나눠 본다 (한 줄로 길게 나오던 것)
  const [tab, setTab0] = useState<"place" | "budget" | "fund">("place");
  const setTab = (k: "place" | "budget" | "fund") => { setTab0(k); document.getElementById("ia-title")?.closest(".ia-card")?.scrollIntoView({ block: "start", behavior: "smooth" }); };
  const cfg: IndustryCfg = useMemo(() => (cfgIn && cfgIn.industry === ind ? cfgIn : { industry: ind, grade: "basic", delivery: true }), [cfgIn, ind]);
  const setC = (x: Partial<IndustryCfg>) => setCfg?.({ ...cfg, ...x, tables: undefined });
  const pv = usePreview(profile, cfg);
  const t = LAB_TXT[ind];
  const names = gus.map((g) => g.name);
  const st = guStat(profile.gu);
  const vals = names.map((n) => guStat(n)[metric] ?? 0);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const dongs = dongsOf(profile.gu);
  const d = st.area ? dongs.find((x) => x.name === st.area) as (ReturnType<typeof dongsOf>[number] & { open_rate?: number | null; close_rate?: number | null }) | undefined : undefined;
  const block = guData()?.[ind] as { gu: Record<string, { franchise?: number; ticket?: number }>; seoul: { sales_per_store_month: number } } | undefined;
  const g = block?.gu[profile.gu];
  const p = pv.data;
  const fixed3 = p ? RUNWAY * (p.monthly_fixed.rent_krw + p.monthly_fixed.labor_krw) : 0;
  const need = p ? p.capex.total_krw + fixed3 : 0;
  const gap = need - profile.capital * 10000;
  const pickDong = (name: string) => setProfile({ ...profile, dong: name ? { gu: profile.gu, name } : undefined });
  const rankDemand = names.filter((n) => guStat(n).demand > st.demand).length + 1;
  if (!isLab(ind)) return null;

  return (
    <main className="ia-wrap">
      <section className="ia-card ia-map" aria-label="서울 지도">
        <h2>지도로 보는 지역</h2>
        <p>서울 25개 구의 {t.shop} 숫자를 견줘 보세요. 구를 누르면 오른쪽이 그 구로 바뀌어요.</p>
        <div className="a-pills" role="group" aria-label="지도에 표시할 값">
          {(Object.keys(METRICS) as Metric[]).map((k) => (
            <button type="button" key={k} aria-pressed={metric === k} onClick={() => setMetric(k)}>{METRICS[k].label}</button>
          ))}
        </div>
        {gus.length > 0 ? <SeoulMap gus={gus} metric={metric} selected={profile.gu} onSelect={(gu) => setProfile({ ...profile, gu, rent: undefined, dong: undefined })} /> : <p className="m-loading">지도를 그리는 중이에요</p>}
        <div className="a-legend">
          <span>낮은 구</span>
          <span className="a-ramp" aria-hidden="true">{RAMP.map((c) => <i key={c} style={{ background: c }} />)}</span>
          <span>높은 구</span>
        </div>
        <p className="a-legend-note">{METRICS[metric].hint}. {METRICS[metric].fmt(lo)}부터 {METRICS[metric].fmt(hi)}까지예요.</p>
      </section>

      <section className="ia-card" aria-labelledby="ia-title">
        <div className="a-tabs" role="tablist" aria-label="분석 내용">
          {([["place", "동네"], ["budget", "드는 돈"], ["fund", "모자란 돈"]] as const).map(([k, l]) => (
            <button type="button" role="tab" key={k} aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>
        {tab === "place" && (<>
        <span className="ia-eyebrow">2단계 동네 분석, {t.shop}</span>
        <div className="ia-head">
          <h1 id="ia-title">{profile.gu}</h1>
          {dongs.length > 0 && (
            <select aria-label="보고 있는 동네" value={st.area ?? ""} onChange={(e) => pickDong(e.target.value)}>
              <option value="">구 전체</option>
              {dongs.map((x) => <option key={x.code} value={x.name}>{x.name}</option>)}
            </select>
          )}
        </div>
        <p className="ia-lead">
          {p ? <>{st.area ?? profile.gu}에서 {josa(t.shop, "이가")} 자리를 잡으면 한 달에 <mark>{wman(p.rough_month.revenue_krw)}</mark>쯤 팔 거라고 엔진이 봐요 (업종 중앙값 가게 기준).</> : pv.err || "엔진에서 계산하는 중이에요."}
        </p>

        <div className="ia-kpis">
          <div className="ia-kpi"><span>자리 잡힌 달 매출</span><strong>{p ? wman(p.rough_month.revenue_krw) : "-"}</strong><small>업종 중앙값에서 옮긴 엔진 추정, {p?.input.pyeong ?? "-"}평</small></div>
          <div className="ia-kpi"><span>{t.kind} 수</span><strong>{(st.area ? st.areaPork ?? 0 : st.pork).toLocaleString("ko-KR")}<i>곳</i></strong><small>{st.area ? `${st.area} 안` : "구 전체"}</small></div>
          <div className="ia-kpi"><span>평당 월세</span><strong>{st.rent}<i>만원</i></strong><small>{st.rentSrc}, 현금 월세</small></div>
          <div className="ia-kpi"><span>1년 폐업률</span><strong>{d?.close_rate != null ? (d.close_rate * 100).toFixed(1) : st.closure}<i>%</i></strong><small>{d?.close_rate != null ? "이 동네" : "구 안 상권"}, 2025년</small></div>
        </div>

        <dl className="ia-rows">
          <div><dt>매출 지수<small>{t.base} 한 곳의 카드 매출, 서울 평균이 1. 25개 구 중 {rankDemand}번째</small></dt><dd>{st.demand.toFixed(2)}</dd></div>
          {d?.rel != null && <div><dt>동네 위치<small>{st.area}의 점포당 카드 매출 ÷ {profile.gu} 평균</small></dt><dd>{Math.round(d.rel * 100)}%</dd></div>}
          <div><dt>가게 수 흐름<small>연 개업률 − 연 폐업률, 0보다 작으면 가게가 줄어드는 중</small></dt><dd>{st.netOpen != null ? `${st.netOpen > 0 ? "+" : ""}${st.netOpen}%p` : "-"}</dd></div>
          {d?.open_rate != null && d.close_rate != null && <div><dt>이 동네 개업률과 폐업률<small>{st.area}, 2025년 (상권분석서비스 행정동)</small></dt><dd>{pct(d.open_rate, 1)} / {pct(d.close_rate, 1)}</dd></div>}
          {g?.franchise != null && <div><dt>프랜차이즈 비중<small>구 안 상권의 {t.base} 중 가맹점</small></dt><dd>{pct(g.franchise)}</dd></div>}
          {p && <div><dt>같은 업종 한 달 매출 (전국)<small>경영실태조사 2025: 평균 {wman(p.benchmark.sales_mean_month_krw)}, 4분의 1~4분의 3은 {wman(p.benchmark.sales_p25_month_krw)}~{wman(p.benchmark.sales_p75_month_krw)}. 엔진은 중앙값 가게를 서울과 이 동네로 옮겨요</small></dt><dd>중앙값 {wman(p.benchmark.sales_p50_month_krw)}</dd></div>}
          {p && <div><dt>객단가<small>경영실태조사 2025 {t.shop} 1인 평균 (전국)</small></dt><dd>{p.demand.ticket_krw.toLocaleString("ko-KR")}원</dd></div>}
          {p && <div><dt>홀 / 배달 / 포장<small>매출 비중 (경영실태조사 2025, 전국)</small></dt><dd>{pct(p.demand.channels.hall)} / {pct(p.demand.channels.delivery)} / {pct(p.demand.channels.takeout)}</dd></div>}
        </dl>
        <details className="m-srcnote"><summary>숫자의 출처와 한계</summary>
          <p className="m-src">
            자리 잡힌 달 매출은 {p?.demand.note_ko ?? "외식업체 경영실태조사 업종 중앙값 × 서울 배율 × 구 지수"}로 낸 엔진 추정이에요. 구 지수와 가게 수 흐름, 폐업률은 서울시 상권분석서비스 2025년 {t.base} 값이고,
            카드 매출이라 배달 앱 결제가 많은 업종은 실제보다 낮게 잡혀요. 그래서 금액이 아니라 구 사이 비교에만 써요. 가게 수는 소상공인 상가정보 2026년 6월 기준이에요.
            월세는 한국부동산원 소규모 상가 1층 임대료에서 보증금 환산분을 뺀 현금 월세예요.{ind === "hansik" ? " 한식 백반집은 상권분석서비스에 따로 코드가 없어 한식음식점 전체(고깃집 포함) 값을 써요." : ""}
          </p>
        </details>
        <p className="ia-note">{T().shop}의 성장률(2024년 대비 매출)과 동네 유형 이름은 자료가 없어 보여 드리지 않아요.</p>
        <div className="ia-go">
          <button type="button" className="m-btn" onClick={() => setTab("budget")}>여는 데 드는 돈 보기</button>
        </div>
        </>)}

        {tab === "budget" && (
        <section className="ia-sec" aria-labelledby="ia-cost">
          <h2 id="ia-cost">{p ? `${p.input.pyeong}평 ${josa(t.shop, "을를")} 열려면 ${wman(need)}쯤 필요해요` : "여는 데 드는 돈"}</h2>
          {/* 평수와 마감을 여기서 바로 바꿔 드는 돈을 견줘 본다 (고깃집·카페 동네 분석의 '드는 돈'과 같은 칸) */}
          <div className="ia-setup">
            <div className="m-stepper">
              <span id="ia-py">평수</span>
              <button type="button" aria-label="1평 줄이기" disabled={!p || p.input.pyeong <= 10} onClick={() => p && setC({ pyeong: p.input.pyeong - 1 })}>−</button>
              <output aria-labelledby="ia-py">{p ? `${p.input.pyeong}평` : "-"}</output>
              <button type="button" aria-label="1평 늘리기" disabled={!p || p.input.pyeong >= 40} onClick={() => p && setC({ pyeong: p.input.pyeong + 1 })}>+</button>
            </div>
            <div className="m-seg" role="group" aria-label="마감 수준">
              {([["basic", "기본"], ["mid", "중급"], ["high", "고급"]] as [Grade, string][]).map(([g, l]) => (
                <button type="button" key={g} aria-pressed={cfg.grade === g} onClick={() => setC({ grade: g })}>{l} 마감</button>
              ))}
            </div>
            {cfg.pyeong != null && <button type="button" className="m-link" onClick={() => setC({ pyeong: undefined })}>업종 보통 크기로</button>}
          </div>
          {p && (
            <table className="m-quote">
              <caption>평당 설비비는 경영실태조사 2025 개업 투자 비용의 25% 분위(기본 마감)예요. 여기서 고른 평수와 마감이 가게 꾸미기로 이어져요.</caption>
              <tbody>
                {p.capex.lines.filter((l) => l.krw > 0).map((l) => <tr key={l.key}><th scope="row">{l.item_ko}<small>{l.note_ko}</small></th><td>{wman(l.krw)}</td></tr>)}
                <tr><th scope="row">석 달 치 월세와 인건비<small>자리 잡기 전 버틸 돈, 가정</small></th><td>{wman(fixed3)}</td></tr>
              </tbody>
              <tfoot>
                <tr><th scope="row">합계</th><td>{wman(need)}</td></tr>
                <tr><th scope="row">내가 가진 돈</th><td>{man(profile.capital)}</td></tr>
              </tfoot>
            </table>
          )}
          {p && <p className={gap > 0 ? "ia-note ia-warn" : "ia-note"}>{gap > 0 ? `가진 돈보다 ${wman(gap)}이 모자라요. 시뮬레이션에서는 모자란 만큼을 대출(연 ${(LOAN_RATE * 100).toFixed(2)}%, 한국은행 은행 중소기업 대출금리)로 계산해요.` : `가진 돈으로 열 수 있고 ${wman(-gap)}이 남아요.`}</p>}
          <div className="ia-go">
            <button type="button" className="m-btn" onClick={() => setTab("fund")}>{gap > 0 ? "모자란 돈 구할 방법 보기" : "남는 돈 확인하기"}</button>
          </div>
        </section>
        )}

        {tab === "fund" && ( // lab:merge 수빈 10/23: 고깃집·카페처럼 '모자란 돈' (정책자금, 은행 대출 상품, 지원사업, 월세 카드 할부)
          <section className="ia-sec ia-funds" aria-labelledby="ia-fund">
            <h2 id="ia-fund">{!p ? "돈을 구하는 길" : gap > 0 ? `가진 돈으로는 ${wman(gap)}이 모자라요` : `가진 돈으로 열 수 있고 ${wman(-gap)}이 남아요`}</h2>
            {p && <FundsPanel gap={Math.round(gap / 1e4)} young={profile.age === "20대" || profile.age === "30대"} gu={profile.gu} rentMan={st.rent * p.input.pyeong} />}
            <div className="ia-go">
              <button type="button" className="m-btn" onClick={onNext}>가게 꾸미러 가기</button>
            </div>
          </section>
        )}

      </section>
    </main>
  );
}
