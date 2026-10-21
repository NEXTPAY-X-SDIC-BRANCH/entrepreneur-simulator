// Step 2. 왼쪽에 지도 카드, 오른쪽에 분석 카드. 구를 누르면 지도가 그 구의 행정동 지도로 바뀐다.
// 분석 카드(동네 탭)는 위에서 아래로 한 층에 역할 하나: 제목 = 동네 선택창 → 한눈에 보기(태그 + 문장, 접힌 추천 동네) → 지표 탭 4개 → 주요 지표 상세.
// 보고 있는 동네는 profile.dong 하나뿐이라 제목 선택창, 지도, 추천 카드 어디서 골라도 같이 바뀐다. 시안: docs/design-handoff/mockups/Main.dc.html
import { useMemo, useState } from "react";
import SeoulMap from "./SeoulMap";
import DongMap, { dongRange } from "./DongMap";
import Icon from "./Icons";
import { BbqComp, CafeComp } from "./DongComp";
import DongTrdar from "./DongTrdar";
import DongFlow from "./DongFlow";
import { DONG_METRICS, bandOf, dongMetricKeys, cuts, geoOf, guInsight, hasDongMap, insightOf, meatSalesNote, picksOf, profileOf, profilesOf, rankWord, type DongMetric, type KTab, type Line, type Tone } from "./area";
import { BANKS, BANK_COMPARE_URL, BANK_GUARANTEE_URL, FUNDS, FUNDS_SRC, type Fund } from "./funds";
import KStartup from "./KStartup";
import { CAFE_KEY_MONEY, cafeEstimate } from "./cafe";
import { apparelEstimate } from "./apparel";
import { QF_NAME, derived as qfDerived, qfEstimate } from "./quickfood";
import { DEPOSIT_MONTHS, LOAN_RATE, METRICS, ecosRates, ymKo, RAMP, T, iga, dongsOf, guStat, krei, kreiMean, man, openingCost, rankOf, recommend, rentData, type Gu, type Metric, type Profile } from "./model";

type Tab = "place" | "budget" | "fund";
const TABS: { key: Tab; label: string }[] = [{ key: "place", label: "동네" }, { key: "budget", label: "드는 돈" }, { key: "fund", label: "모자란 돈" }];
const RUNWAY_MONTHS = 3; // 가정: 자리 잡기 전 석 달 치 적자와 생활비
const MONTHLY_BURN = 550;
const sign = (v: number) => (v > 0 ? "+" : "");
// 정책자금 금리를 ECOS 은행 신규 중소기업대출 평균(LOAN_RATE)과 견준 한 줄. 변동금리는 지금 기준금리를 보여 준다.
function rateVsBank(f: Fund): string {
  const ecos = ecosRates();
  const bank = +(LOAN_RATE * 100).toFixed(2);
  const when = ecos?.loan_sme ? ` (한국은행 ${ymKo(ecos.loan_sme.month)})` : " (가정)";
  if (f.floating) return ecos?.base_rate ? `기준금리에 따라 움직여요. 지금 기준금리는 연 ${ecos.base_rate.rate}%예요 (한국은행 ${ymKo(ecos.base_rate.month)}).` : "기준금리에 따라 움직여요.";
  const [lo, hi] = f.rate!;
  const range = lo === hi ? `연 ${lo}%` : `연 ${lo}~${hi}%`;
  const dLo = +(bank - hi).toFixed(2), dHi = +(bank - lo).toFixed(2);
  if (dLo > 0) return `${range}로 은행 평균 연 ${bank}%${when}보다 ${dLo === dHi ? dLo : `${dLo}~${dHi}`}%p 낮아요.`;
  if (dHi < 0) return `${range}로 은행 평균 연 ${bank}%${when}보다 ${+(-dHi).toFixed(2)}%p 높아요. 신용이 낮아 은행 대출이 어려운 분을 위한 상품이에요.`;
  return `${range}로 은행 평균 연 ${bank}%${when}와 비슷해요.`;
}
const n0 = (v: number) => v.toLocaleString("ko-KR");
const lowHigh = (): Record<Metric, [string, string]> => ({ demand: ["매출이 낮은 구", "매출이 높은 구"], growth: ["성장이 느린 구", "성장이 빠른 구"], pork: [`${iga(T().shop)} 적은 구`, `${iga(T().shop)} 많은 구`], closure: ["폐업이 적은 구", "폐업이 많은 구"] });

// 근거 한 줄. scope는 숫자의 업종과 범위(예: "한식음식점 · 구 안 상권")라 고깃집 값과 한식 값, 구 값과 동 값이 섞여 보이지 않게 한다.
type Detail = { title: string; sub: string; scope: string; value: string };
function DetailRow({ title, sub, scope, value }: Detail) {
  return (
    <div className="a-drow">
      <div><b>{title}</b><small>{sub}</small></div>
      <span className="a-scope">{scope}</span>
      <strong>{value}</strong>
    </div>
  );
}
type Kpi = { key: KTab; name: string; tag: string; tone: Tone; value: string; unit: string; sub: string; subTone?: "up" | "down"; basis: string; rows: Detail[] };

export default function Analysis({ profile, setProfile, gus, onNext }: {
  profile: Profile; setProfile: (p: Profile) => void; gus: Gu[]; onNext: () => void;
}) {
  const [tab, setTab] = useState<Tab>("place");
  const [ktab, setKtab] = useState<KTab>("sales");
  const [recOpen, setRecOpen] = useState(false);
  const [metric, setMetric] = useState<Metric>("demand");
  const [dmetric, setDmetric] = useState<DongMetric>("growth");
  const [zoom, setZoom] = useState(false);
  const names = gus.map((g) => g.name);
  const st = guStat(profile.gu);
  const all = names.map(guStat);
  const span = (k: Metric) => { const v = all.map((a) => a[k]).filter((x): x is number => x != null); return { lo: Math.min(...v), hi: Math.max(...v) }; };
  // 드는 돈 견적은 사용자가 아직 꾸미지 않았을 수 있어서, 이 돈과 동네에 맞춘 추천 구성으로 낸다 (가게 꾸미기의 '추천 배치'와 같다)
  const est = useMemo(() => profile.industry === "cafe" ? { pyeong: cafeEstimate(profile, RUNWAY_MONTHS * MONTHLY_BURN).pyeong } : profile.industry === "apparel" ? { pyeong: apparelEstimate(profile).pyeong } : profile.industry === "chicken" || profile.industry === "bunsik" ? { pyeong: qfEstimate(profile, profile.industry).pyeong } : recommend(profile).store, [profile.industry, profile.gu, profile.capital, profile.keyMoney, profile.rent, profile.dong, profile.age]); // eslint-disable-line react-hooks/exhaustive-deps
  const cost = profile.industry === "cafe" ? cafeEstimate(profile, RUNWAY_MONTHS * MONTHLY_BURN).cost : profile.industry === "apparel" ? apparelEstimate(profile).cost : profile.industry === "chicken" || profile.industry === "bunsik" ? qfEstimate(profile, profile.industry).cost : openingCost(est as ReturnType<typeof recommend>["store"], profile.gu, profile.keyMoney ?? 0);
  const need = cost.total + RUNWAY_MONTHS * MONTHLY_BURN;
  const gap = need - profile.capital;
  const young = profile.age === "20대" || profile.age === "30대";
  const demandRank = rankOf(profile.gu, "demand", names);
  const rentRank = names.filter((n) => guStat(n).rent > st.rent).length + 1;
  const m = span(metric);
  const q = rentData()?._meta.quarter;
  const qLabel = q ? `${q.slice(0, 4)}년 ${Number(q.slice(4))}분기` : "";
  const dongs = dongsOf(profile.gu);
  const geo = geoOf(profile.gu);
  const profs = profilesOf(profile.gu);
  const mapMode = zoom && hasDongMap() && geo.length > 0;
  const dp = st.area ? profileOf(profile.gu, st.area) : undefined;
  const ins = dp ? insightOf(dp) : null;
  const gi = guInsight(profile.gu, names);
  const picks = picksOf(profile.gu);
  const sn = meatSalesNote();
  const c = cuts();
  const rentNote = st.rentSrc === "입력" ? "월세는 직접 넣은 값이에요."
    : st.rentSrc === "R-ONE 동네" ? `월세는 한국부동산원 ${qLabel} 소규모 상가 1층 임대료 중 이 동네가 속한 상권(${st.rentArea})의 값에서 보증금 환산분(${DEPOSIT_MONTHS}개월)을 뺀 현금 월세예요.`
    : st.rentSrc === "R-ONE 근사" ? `월세는 한국부동산원 ${qLabel} 소규모 상가 1층 임대료를 이 구의 상권 ${st.rentAreas}곳으로 평균내고, 보증금 환산분(${DEPOSIT_MONTHS}개월)을 뺀 현금 월세예요.`
    : st.rentSrc === "R-ONE 채움" ? "월세는 이 구에 조사 상권이 없어 다른 구 상권의 중앙값으로 채웠어요."
    : "월세는 예시값이에요. 자료를 불러오지 못했어요.";
  const dr = mapMode ? dongRange(dmetric, geo, profs, dongs) : null;
  // 동네 고르기는 여기 하나로: 빈 이름이면 구 전체로 돌아간다. 동을 고르면 지도도 그 구의 동네 지도로 연다.
  const pickDong = (name: string) => {
    setProfile({ ...profile, dong: name ? { gu: profile.gu, name } : undefined });
    if (name && hasDongMap()) setZoom(true);
  };
  const kk = krei()?.micro;
  const keyN = krei()?.tables.key_money?.meat?.n ?? null;
  const growth = dp?.growth ?? st.growth;
  const compete = dp?.comp ?? gi.compete;
  const scope = st.area ?? profile.gu;
  const summary = ins && dp ? ins.summary : gi.summary;
  const gMap = lowHigh()[metric];
  const S = T().shop, B = T().base, cafe = S === "카페", apparel = S === "옷가게";
  const qfInd = profile.industry === "chicken" || profile.industry === "bunsik" ? profile.industry : null;
  const lite = apparel || qfInd != null; // 구 단위만 있는 업종 (동네 매출·성장률 없음)
  const dMap = DONG_METRICS[dmetric];
  const n = names.length;
  const lines = [...summary.warn, ...summary.good];

  // 지표 탭 4개. 카드 오른쪽 위 태그는 요약에서 그 탭을 가리키는 첫 태그를 그대로 쓰고, 없으면 중립 태그를 단다.
  const tagOf = (k: KTab, fallback: string): { tag: string; tone: Tone } => {
    const l: Line | undefined = lines.find((x) => x.tab === k);
    return l ? { tag: l.tag, tone: l.tone } : { tag: fallback, tone: "mid" };
  };
  const guArea = `${B} · 구 안 상권`;
  const count = st.area ? st.areaPork ?? 0 : st.pork;
  const kpis: Kpi[] = [
    {
      key: "sales", name: "매출", ...tagOf("sales", "평균 범위"), value: n0(st.sales), unit: "만원",
      sub: cafe ? (st.salesRange ? `4분의 1~4분의 3: ${n0(st.salesRange[0])}~${n0(st.salesRange[1])}만원` : "점포당 월매출 중앙값")
        : lite ? `한 번에 평균 ${n0(st.ticket)}원 결제${qfInd ? " (매장 카드 결제)" : ""}`
        : growth != null ? `${growth >= 0 ? "▲" : "▼"} ${Math.abs(growth)}% 전년 대비 (${st.area ? "동 전체 한식 매출" : "한식"})` : "전년 자료 없음",
      subTone: !cafe && !lite && growth != null ? (growth >= 0 ? "up" : "down") : undefined,
      basis: cafe ? `카페 점포당 월매출 중앙값 (추정)${st.area ? ", 구 값 × 동네 위치" : ""}` : apparel ? `옷가게 점포당 월매출 (카드 추정)${st.area ? ", 구 값 × 동네 위치" : ""}` : qfInd ? `${S} 점포당 월매출 (카드 추정 ÷ (1 − 배달 비중))` : `고깃집 점포당 월매출 (추정)${st.area ? ", 구 값 × 동네 위치" : ""}`,
      rows: [
        { title: "하루 결제 건수", sub: cafe || lite ? "한 곳당 하루 평균 카드 결제" : "한 곳당 하루 평균, 1건은 보통 한 팀", scope: guArea, value: `${st.tx}건` },
        { title: "매출 지수", sub: "서울 평균을 1로 놓았을 때", scope: st.area ? `${B} · 동 (구 값 × 동네 위치)` : guArea, value: st.demand.toFixed(2) },
        ...(dp?.apt_price != null ? [{ title: "아파트 평균 시가", sub: "동네 소득 수준을 가늠하는 값", scope: "아파트 · 동", value: `${(Math.round(dp.apt_price / 1e7) / 10).toFixed(1)}억원` }] : []),
      ],
    },
    {
      key: "comp", name: "경쟁", ...tagOf("comp", `경쟁 ${compete}`), value: n0(count), unit: "곳",
      sub: st.area ? (dp?.pork_km2 != null && dp.stores >= 20 ? `1㎢당 ${dp.pork_km2}곳 · 경쟁 ${compete}` : `경쟁 ${compete}`) : rankWord(rankOf(profile.gu, "pork", names), n, "많음", "적음"),
      basis: `${S} 수 (${st.area ? `${st.area} 안` : "구 전체"})`,
      rows: [
        // 고깃집은 한식음식점 값과 섞지 않고 고깃집 수만 따로 보인다
        cafe
          ? { title: `${B} 수`, sub: "카페를 포함한 커피·음료 가게 전체", scope: st.area ? `${B} · 동` : guArea, value: `${n0(st.area ? st.areaStores ?? 0 : st.stores)}곳` }
          : qfInd ? { title: `${S} 수`, sub: `상권 안 ${B} · ${rankWord(rankOf(profile.gu, "pork", names), n, "많음", "적음")}`, scope: guArea, value: `${n0(st.stores)}곳` }
          : apparel ? (st.area
            ? { title: "옷가게 수", sub: `${st.area} 안의 남성·여성·기타 의류 소매점 (소상공인 상가정보)`, scope: "옷가게 · 동", value: `${n0(st.areaPork ?? 0)}곳` }
            : { title: "옷가게 수", sub: `상권 안 일반의류 가게 · ${rankWord(rankOf(profile.gu, "pork", names), n, "많음", "적음")}`, scope: guArea, value: `${n0(st.stores)}곳` })
          : { title: "고깃집 수", sub: st.area ? `${st.area} 안의 돼지고기 구이/찜 가게` : `돼지고기 구이/찜 가게 · ${rankWord(rankOf(profile.gu, "pork", names), n, "많음", "적음")}`, scope: st.area ? "고깃집 · 동" : "고깃집 · 구 전체", value: `${n0(count)}곳` },
        ...(dp?.pop_per_pork != null ? [{ title: `${S} 1곳당 인구`, sub: "주민 + 직장인", scope: `${S} · 동`, value: `${n0(dp.pop_per_pork)}명` }] : []),
      ],
    },
    {
      key: "cost", name: "비용", ...tagOf("cost", "월세 보통"), value: String(st.rent), unit: "만원",
      sub: st.area ? (st.rentSrc === "R-ONE 동네" ? "이 동네 상권 값" : "구 평균 값") : rankWord(rentRank, n, "비쌈", "쌈"),
      basis: "평당 월세 (현금)",
      rows: st.rentLow !== st.rentHigh ? [{
        title: "평당 월세 범위", sub: st.rentSrc === "R-ONE 근사" ? `구 안 상권 ${st.rentAreas}곳 중 가장 싼 곳 ~ 가장 비싼 곳` : "상권 값 하나의 ±25% (가정)",
        scope: "소규모 상가 1층", value: `${st.rentLow}~${st.rentHigh}만원`,
      }] : [],
    },
    {
      key: "survive", name: "생존", ...tagOf("survive", st.area ? "구 기준" : "폐업 보통"), value: String(st.closure), unit: "%", sub: "1년 폐업률",
      basis: `${B}, ${cafe ? "최근 4분기" : "2025년"}${st.area ? " · 구 전체" : ""}`,
      rows: [
        ...(st.netOpen != null ? [{ title: "가게 수 흐름", sub: "개업률에서 폐업률을 뺀 값, 0보다 작으면 가게가 줄어드는 중", scope: guArea, value: `${sign(st.netOpen)}${st.netOpen}%p` }] : []),
        ...(cafe && dp?.growth != null ? [{ title: "동네 가게 수 흐름", sub: "이 동네의 개업률 − 폐업률", scope: `${B} · 동`, value: `${sign(dp.growth)}${dp.growth}%p` }] : []),
        ...(cafe && dp?.life != null ? [{ title: "가게가 버틴 기간", sub: `영업 중인 가게 평균. 문 닫은 가게는 평균 ${dp.close_life}개월 (서울 ${dp.s_close}개월)`, scope: "모든 업종 · 동", value: `${dp.life}개월` }] : []),
        ...(cafe && dp?.change ? [{ title: "상권 변화 유형", sub: "서울시 상권변화지표 분류 (다이나믹·상권확장·정체·상권축소)", scope: "모든 업종 · 동", value: dp.change }] : []),
      ],
    },
  ];
  const kp = kpis.find((k) => k.key === ktab)!;
  const band = ins && dp ? bandOf(dp, ins) : [];
  const recGroups = [
    { title: "규모는 작아도 성장하는 동네", items: picks.small },
    { title: "매출이 크고 꺾이지 않은 동네", items: picks.steady },
  ].filter((g) => g.items.length > 0);

  return (
    <main className="m-area">
      <section className="m-mapcol a-card" aria-label={mapMode ? `${profile.gu} 동네 지도` : "서울 지도"}>
        <header className="a-maphead">
          <span className="a-ico a-ico-lg"><Icon name="pin" size={20} /></span>
          <div>
            <h2>지도로 보는 지역</h2>
            <p>{mapMode ? `${profile.gu} 안의 행정동별 특성을 한눈에 확인해 보세요.` : "서울 25개 구의 매출과 상권 특성을 한눈에 확인해 보세요."}</p>
          </div>
          {mapMode && <button type="button" className="a-back" onClick={() => setZoom(false)}>← 서울 전체</button>}
        </header>
        {mapMode ? (
          <>
            <div className="a-pills" role="group" aria-label="동네 지도에 표시할 값">
              {dongMetricKeys().map((k) => (
                <button type="button" key={k} aria-pressed={dmetric === k} onClick={() => setDmetric(k)}>{DONG_METRICS[k].label}</button>
              ))}
            </div>
            <DongMap geo={geo} profiles={profs} dongs={dongs} metric={dmetric} selected={st.area} onSelect={pickDong} />
            <div className="a-legend">
              <span>{dMap.low}</span>
              <span className="a-ramp" aria-hidden="true">{RAMP.map((col) => <i key={col} style={{ background: col }} />)}</span>
              <span>{dMap.high}</span>
            </div>
            <p className="a-legend-note">{dMap.hint}. {dr ? `${dMap.fmt(dr.lo)}부터 ${dMap.fmt(dr.hi)}까지예요. ` : ""}회색은 비교할 자료가 없는 동네예요.</p>
          </>
        ) : (
          <>
            <div className="a-pills" role="group" aria-label="지도에 표시할 값">
              {(Object.keys(METRICS) as Metric[]).map((k) => (
                <button type="button" key={k} aria-pressed={metric === k} onClick={() => setMetric(k)}>{METRICS[k].label}</button>
              ))}
            </div>
            {gus.length > 0
              ? <SeoulMap gus={gus} metric={metric} selected={profile.gu} onSelect={(gu) => { setProfile({ ...profile, gu, rent: undefined, dong: undefined }); setZoom(true); }} />
              : <p className="m-loading">지도를 그리는 중이에요</p>}
            <div className="a-legend">
              <span>{gMap[0]}</span>
              <span className="a-ramp" aria-hidden="true">{RAMP.map((col) => <i key={col} style={{ background: col }} />)}</span>
              <span>{gMap[1]}</span>
            </div>
            <p className="a-legend-note">{METRICS[metric].hint}. {METRICS[metric].fmt(m.lo)}부터 {METRICS[metric].fmt(m.hi)}까지예요. 구를 누르면 그 구의 동네 지도가 열려요.</p>
            {hasDongMap() && <button type="button" className="a-back" onClick={() => setZoom(true)}>{profile.gu}의 동네 지도 보기</button>}
          </>
        )}
      </section>

      <section className="m-panel a-card">
        <div className="a-tabs" role="tablist" aria-label="분석 내용">
          {TABS.map((t) => <button type="button" role="tab" key={t.key} aria-selected={tab === t.key} onClick={() => setTab(t.key)}>{t.label}</button>)}
        </div>

        {tab === "place" && (
          <div className="m-finding a-place" key="place">
            <header className="a-head">
              <span className="a-eyebrow">2단계 · 입지 · {S}</span>
              <div className="a-title">
                <h1>{profile.gu}</h1>
                {dongs.length > 0 && (
                  <select className="a-dongsel" aria-label="보고 있는 동네" value={st.area ?? ""} onChange={(e) => pickDong(e.target.value)}>
                    <option value="">구 전체</option>
                    {dongs.map((d) => <option key={d.code} value={d.name}>{d.name}</option>)}
                  </select>
                )}
                {st.area && <button type="button" className="a-backgu" onClick={() => pickDong("")}>{profile.gu} 전체로 돌아가기</button>}
                {/* 추천 동네: 제목 옆 작은 버튼, 누르면 바로 아래에 펼친다 */}
                <button type="button" className="a-rec-btn" aria-expanded={recOpen} aria-controls="rec-list" onClick={() => setRecOpen((o) => !o)}>
                  <Icon name="star" size={15} />이런 동네는 어때요?<Icon name="arrow" size={16} />
                </button>
              </div>
              <small>제목 옆에서 동네를 바꾸거나, 추천 동네나 지도에서 골라도 돼요</small>
              {recOpen && (
                <div className="a-rec-body" id="rec-list">
                  <small>{profile.gu} 안에서 {S} 열기 좋은 동네를 골라 봤어요. 누르면 이 화면의 지표가 그 동네로 바뀌어요.</small>
                  {recGroups.length > 0 ? recGroups.map((g) => (
                    <div className="a-rec-grp" key={g.title}>
                      <h3>{g.title}</h3>
                      {g.items.map(({ p, note }) => {
                        const on = st.area === p.name;
                        return (
                          <button type="button" key={p.code} className="a-rec-item" aria-pressed={on} onClick={() => pickDong(p.name)}>
                            <span className="a-rec-name">{p.name}{on && <span className="a-rec-on">보는 중</span>}<Icon name="arrow" size={18} /></span>
                            <small>{note}</small>
                          </button>
                        );
                      })}
                    </div>
                  )) : <p className="a-rec-none">이 구에는 기준에 맞는 동네가 아직 없어요. 지도에서 직접 골라 보세요.</p>}
                </div>
              )}
              {st.area && <p className="a-lead">{st.area} {S}{cafe ? "는" : "은"} 한 곳당 한 달에 {cafe ? "보통 " : ""}<mark>{man(st.sales)}</mark>쯤 팔아요.</p>}
            </header>

            {/* 키워드 띠는 '어떤 동네인가'(손님·시간대·사람), 아래 한눈에 보기는 '좋은가 나쁜가'(매출 흐름·경쟁·월세·생존). 같은 숫자를 두 번 쓰지 않는다 */}
            {ins && dp && (
              <section className="a-kw" aria-labelledby="kw-title">
                <span id="kw-title" className="a-kw-eyebrow">이 동네는 이런 상권이에요</span>
                <div className="a-kw-name">
                  <strong>{ins.style}</strong>
                  {ins.keywords.map((k) => <span key={k}>{k}</span>)}
                </div>
                <p>{ins.why}.</p>
                {band.length > 0 && (
                  <div className="a-kw-cards">
                    {band.map((b) => (
                      <div key={b.label}><span>{b.label}</span><b>{b.value}</b><small>{b.sub}</small></div>
                    ))}
                  </div>
                )}
              </section>
            )}

            <DongFlow code={dp && st.area ? dp.code : undefined} gu={profile.gu} dong={st.area ?? null} />

            {dp && st.area && <DongTrdar code={dp.code} dong={st.area} />}

            <section className="a-sum" aria-labelledby="sum-title">
              <div className="a-sum-head">
                <h2 id="sum-title">{scope} 한눈에 보기</h2>
                <small>태그를 누르면 바로 아래 지표로 연결돼요</small>
              </div>
              {([["눈여겨볼 점", "good", summary.good], ["주의할 점", "warn", summary.warn]] as const).map(([title, tone, ls]) => ls.length > 0 && (
                <div className="a-sum-grp" key={tone}>
                  <h3 className={`is-${tone}`}>{title}</h3>
                  {ls.map((l) => (
                    <div className="a-line" key={l.tag}>
                      <button type="button" className={`a-tag is-${l.tone}`} aria-pressed={ktab === l.tab} onClick={() => setKtab(l.tab)}>{l.tag}</button>
                      <span>{l.text}</span>
                    </div>
                  ))}
                </div>
              ))}
              {ins && dp && ins.actions.length > 0 && (
                <div className="a-acts">
                  <p className="a-sub">이렇게 해 보세요</p>
                  {/* 근거 숫자는 바로 위 줄과 키워드 띠에 이미 있어서 제안 문장만 보인다 */}
                  <ol className="m-acts">
                    {ins.actions.map((a) => <li key={a.text}>{a.text}</li>)}
                  </ol>
                </div>
              )}
            </section>

            <div className="a-ktabs" role="tablist" aria-label={`${scope} 지표`}>
              {kpis.map((k) => (
                <button type="button" role="tab" key={k.key} id={`kt-${k.key}`} aria-selected={ktab === k.key} aria-controls="kpanel" className="a-ktab" onClick={() => setKtab(k.key)}>
                  <span className="a-ktab-top"><span className="a-ktab-name">{k.name}</span><span className={`a-tag-sm is-${k.tone}`}>{k.tag}</span></span>
                  <strong>{k.value}<span>{k.unit}</span></strong>
                  <span className={`a-ktab-sub${k.subTone ? ` is-${k.subTone}` : ""}`}>{k.sub}</span>
                  <small>{k.basis}</small>
                </button>
              ))}
            </div>

            <div className="a-kpanel" role="tabpanel" id="kpanel" aria-labelledby={`kt-${ktab}`}>
              <p className="a-kpanel-title">주요 지표 상세</p>
              {ktab === "comp" && dp
                ? (cafe ? <CafeComp p={dp} gu={profile.gu} /> : <BbqComp p={dp} count={count} />)
                : kp.rows.map((r) => <DetailRow key={r.title} {...r} />)}
              {ktab === "cost" && (
                <div className="a-rent">
                  <label htmlFor="rent-in">찾아 둔 매물이 있다면 평당 월세를 넣어 보세요 <small>(선택)</small></label>
                  <div>
                    <input id="rent-in" type="number" inputMode="decimal" min={0} step={0.1} placeholder={String(st.rent)}
                      value={profile.rent && profile.rent.gu === profile.gu ? profile.rent.v : ""}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value);
                        setProfile({ ...profile, rent: v > 0 ? { gu: profile.gu, v } : undefined });
                      }} />
                    <span>만원/평·월</span>
                    {profile.rent && <button type="button" className="m-link" onClick={() => setProfile({ ...profile, rent: undefined })}>지우기</button>}
                  </div>
                  <small>보증금을 뺀, 매달 내는 현금 월세예요. 넣으면 보증금과 월 고정비가 이 값으로 다시 계산돼요.</small>
                </div>
              )}
            </div>

            <p className="a-notice"><Icon name="info" size={17} />지표는 지역 평균 기준이에요. 실제 매장 상황에 따라 달라질 수 있어요. {rentNote}</p>

            {(profile.reasons.includes("월세가 쌀 것 같아서") || profile.reasons.includes("유동 인구가 많아서")) && (
              <div className="a-asides">
                {profile.reasons.includes("월세가 쌀 것 같아서") && (
                  <p className="m-aside">
                    {st.rentSrc === "예시값"
                      ? <><b>월세가 쌀 것 같다고 하셨는데,</b> 월세 자료를 불러오지 못해 확인해 드릴 수 없어요 (예시값 {rentRank}번째).</>
                      : <><b>월세가 쌀 것 같다고 하셨죠.</b> 이 구의 평당 월세는 25개 구 중 비싼 순으로 {rentRank}번째예요. 상권 값을 구로 묶은 근사라, 같은 구 안에서도 골목마다 크게 달라요.</>}
                  </p>
                )}
                {profile.reasons.includes("유동 인구가 많아서") && (
                  <p className="m-aside"><b>유동 인구가 많다고 하셨죠.</b> 가게 한 곳의 매출로는 {demandRank}번째예요. 지나가는 사람이 많아도 가게마다 손님이 많다는 뜻은 아니에요.</p>
                )}
              </div>
            )}

            <details className="m-srcnote"><summary>숫자의 출처와 한계</summary>
              <p className="m-src">
                {qfInd ? (
                  <>
                    매출과 가게 수, 폐업률·개업률은 서울시 상권분석서비스 2025년 {B}({qfInd === "chicken" ? "CS100007" : "CS100008"}) 상권 값을 구로 모은 거예요. 카드사 추정 매출에는 배달앱 결제가 거의 빠져 있어, 외식업체 경영실태조사 2025의 배달 주문 비중({Math.round(qfDerived(qfInd).share.delivery * 100)}%)만큼 나눠 보정했어요.
                    식재료비율·배달 수수료·인건비·인테리어비는 같은 조사의 전국 {qfInd === "chicken" ? "치킨전문점" : "김밥 및 기타 간이 음식점업"} 값이에요. 동네(행정동) 자료는 아직 없어 구 단위로만 봐요.
                  </>
                ) : apparel ? (
                  <>
                    매출과 가게 수, 폐업률·개업률은 서울시 상권분석서비스 2025년 일반의류(CS300011) 상권 값을 구로 모은 거예요. 매출은 카드사 추정이고 현금·온라인 매출은 빠져 있어요.
                    원가와 경비 비율은 통계청 도소매업조사 2024년 서울 의복 소매업 중 연매출 1억~5억 사업체 값이에요. 동네를 고르면 서울시 상권분석서비스 행정동 일반의류 매출과 소상공인 상가정보(2026년 6월) 남성·여성·기타 의류 소매점 수로 구 안의 위치를 맞춰요. 동네 가게 수는 상권 밖 가게까지 센 값이라 구 전체의 상권 안 가게 수와 기준이 달라요.
                  </>
                ) : cafe ? (
                  <>
                    매출 규모는 서울시 상권분석서비스 2025년 커피-음료 카드 추정매출에 서울 소상공인 카페 월매출(외식업체 경영실태조사 2025, 응답 63곳)로 맞춘 배율 1.54를 곱했어요. 카드 추정은 실제보다 낮게 잡혀서 배율로 보정한 값이에요. 화면의 대표값은 평균이 아니라 중앙값이에요. 잘되는 가게 몇 곳이 평균을 끌어올리기 때문이고, 전국 독립 카페의 중앙값÷평균 배율(0.78)과 4분의 1·4분의 3 분위(중앙값의 0.75배·1.49배)를 서울 값에 옮긴 추정이라 서울 실제 분포와는 다를 수 있어요.
                    카페 수는 소상공인 상가정보 2026년 6월 기준이고 프랜차이즈가 섞여 있어요. 카페는 동네별 2024년 매출이 없어 성장률 대신 개업률에서 폐업률을 뺀 '가게 수 흐름'을 보여 줘요. 가게가 버틴 기간과 상권 변화 유형은 서울시 상권분석서비스 상권변화지표(2026년 2분기)이고, 카페만의 값이 아니라 그 동네 모든 업종의 값이에요. 이름·키워드·제안은 숫자에서 규칙으로 뽑은 분류이고 현장 조사가 아니에요.
                    {c ? ` 경쟁은 카페 밀도 ${c.pork_km2[0].toFixed(1)}·${c.pork_km2[1].toFixed(1)}곳/㎢ 기준 3등분이에요.` : ""}
                  </>
                ) : (
                  <>
                    매출 규모는 서울시 상권분석서비스 2025년 한식음식점 값에 외식업체 경영실태조사(2025)의 한식 육류 요리 전문점 매출을 한식 전체와 견줘 곱했어요{sn ? ` (육류 전문점 연 ${Math.round(sn.meat).toLocaleString("ko-KR")}만원 ÷ 한식 전체 ${Math.round(sn.all).toLocaleString("ko-KR")}만원 = ${sn.ratio.toFixed(2)}배)` : ""}.
                    폐업률과 성장률은 육류 전문점만의 통계가 없어 한식음식점 전체 값이에요. 고깃집 수는 소상공인 상가정보 2026년 6월 기준이에요. 이름·키워드·제안은 숫자에서 규칙으로 뽑은 분류이고 현장 조사가 아니에요.
                    {c ? ` 경쟁은 고깃집 밀도 ${c.pork_km2[0].toFixed(1)}·${c.pork_km2[1].toFixed(1)}곳/㎢ 기준 3등분이에요.` : ""}
                  </>
                )}
              </p>
            </details>
            <button type="button" className="a-cta" onClick={() => setTab("budget")}>여는 데 드는 돈 보기 <Icon name="arrow" size={18} /></button>
          </div>
        )}

        {tab === "budget" && (
          <div className="m-finding" key="budget">
            <h1>{profile.gu}에 {est.pyeong}평 {S}{cafe || apparel ? "를" : "을"} 열려면 <mark>{man(need)}</mark>쯤 필요해요.</h1>
            <table className="m-quote">
              <caption>{qfInd ? `조사한 ${QF_NAME[qfInd]} 평균 면적(${Math.round(qfDerived(qfInd).areaPy)}평)에서 시작해 가진 돈에 맞춘 대략의 견적이에요. 인테리어는 외식업체 경영실태조사 평균, 설비비는 가정이에요.` : apparel ? "13평에서 시작해 가진 돈에 맞춘 대략의 견적이에요. 첫 재고는 이 구 옷가게의 한 달 매출 1.5개월치를 원가(29%)로 들인다고 봤어요. 인테리어 단가는 공정위 정보공개서 의류 가맹 9개 브랜드 값이라 표본이 적어요." : cafe ? `독립 카페 면적 중앙값(20평)에서 시작해 가진 돈에 맞춘 대략의 견적이에요. 값은 외식업체 경영실태조사 2025 원자료의 25%·50%·75% 분위수를 기본·중급·고급으로 놓은 거예요.` : "이 돈에 맞춘 추천 구성으로 낸 견적이에요. 다음 단계에서 직접 꾸미거나 '추천 배치'를 누르면 이 구성이 놓여요."}</caption>
              <tbody>
                {cost.lines.filter((l: { amount: number }) => l.amount > 0).map((l) => (
                  <tr key={l.key}><th scope="row">{l.label}<small>{l.basis}</small></th><td>{man(l.amount)}</td></tr>
                ))}
                <tr><th scope="row">석 달 치 버틸 돈<small>자리 잡기 전 적자와 생활비, 가정</small></th><td>{man(RUNWAY_MONTHS * MONTHLY_BURN)}</td></tr>
              </tbody>
              <tfoot>
                <tr><th scope="row">합계</th><td>{man(need)}</td></tr>
                <tr><th scope="row">내가 가진 돈</th><td>{man(profile.capital)}</td></tr>
              </tfoot>
            </table>
            <div className="m-rentin">
              <label htmlFor="key-in">권리금이 붙은 자리를 보고 있다면 넣어 보세요 <small>(선택)</small></label>
              <div>
                <input id="key-in" type="number" inputMode="numeric" min={0} step={100} placeholder="0"
                  value={profile.keyMoney || ""}
                  onChange={(e) => { const v = parseInt(e.target.value, 10); setProfile({ ...profile, keyMoney: v > 0 ? v : undefined }); }} />
                <span>만원</span>
                {profile.keyMoney ? <button type="button" className="m-link" onClick={() => setProfile({ ...profile, keyMoney: undefined })}>지우기</button> : null}
              </div>
              <small>{qfInd ? `${S} 권리금은 아직 정리하지 못했어요. 위 견적에는 넣지 않았어요.` : apparel ? "옷가게 권리금은 공개 통계를 아직 찾지 못했어요. 위 견적에는 넣지 않았어요." : cafe
                ? `권리금을 낸 독립 카페의 중앙값은 ${man(CAFE_KEY_MONEY.base)}이고, 4분의 1은 ${man(CAFE_KEY_MONEY.low)} 아래, 4분의 1은 ${man(CAFE_KEY_MONEY.high)} 위예요. 위 견적에는 넣지 않았어요 (경영실태조사 2025 원자료, 카페 팀 지표 엑셀 정리, 전국).`
                : kk && keyN
                ? `한식 육류 요리 전문점 중 가게를 빌려 쓰는 곳의 절반쯤이 권리금을 냈고(응답 ${keyN}곳), 낸 곳의 중앙값은 ${man(Math.round(kk.key_money.p50 / 100) * 100)}, 평균은 ${man(Math.round(kreiMean("key_money")!))}이에요. 위 견적에는 넣지 않았어요 (경영실태조사 2025, 전국).`
                : "권리금은 위 견적에 넣지 않았어요."}</small>
            </div>
            <button type="button" className="m-btn" onClick={() => setTab("fund")}>{gap > 0 ? "모자란 돈 구할 방법 보기" : "남는 돈 확인하기"}</button>
          </div>
        )}

        {tab === "fund" && (() => {
          // 모자란 돈: 갈래마다 박스로 나눈다. 청년 전용(만 39세 이하)은 맨 앞 박스, 그다음 정책 대출·보증, 은행 대출, 교육·프로그램, 접수 중 공고
          const youthFunds = young ? FUNDS.filter((f) => f.youth) : [];
          const loans = FUNDS.filter((f) => !f.program && !f.youth);
          const programs = FUNDS.filter((f) => f.program && !f.youth);
          const WHEN: Record<Fund["pre"], string> = { "가능": "사업자등록 전 가능", "조건부": "조건이 맞으면", "등록 후": "가게를 연 뒤" };
          const sections = [
            ...(youthFunds.length ? [{ id: "fs-youth", label: "청년 지원" }] : []),
            { id: "fs-loan", label: "정책 대출·보증" }, { id: "fs-bank", label: "은행 대출" },
            { id: "fs-edu", label: "교육·프로그램" }, { id: "fs-now", label: "접수 중 공고" },
          ];
          const card = (f: Fund) => {
            const rt = f.rate || f.floating ? rateVsBank(f) : null;
            return (
              <li key={f.name} className="fd-card">
                <div className="fd-tags">
                  {f.youth && <span className="fd-tag is-youth">청년</span>}
                  <span className={`fd-tag ${f.program ? "is-edu" : ""}`}>{f.program ? "빌리는 돈 아님" : WHEN[f.pre]}</span>
                  {f.rate && <span className="fd-tag is-rate">연 {f.rate[0] === f.rate[1] ? f.rate[0] : `${f.rate[0]}~${f.rate[1]}`}%</span>}
                </div>
                <h3>{f.url ? <a href={f.url} target="_blank" rel="noreferrer">{f.name}</a> : f.name}</h3>
                <p className="fd-who">{f.org} · {f.who}</p>
                <p className="fd-terms">{f.limit}. {f.terms}</p>
                {rt && <p className={`m-rate fd-rate ${rt.includes("높아요") ? "is-high" : ""}`}>{rt}</p>}
                <p className="fd-note">{f.where}. {f.note}</p>
              </li>
            );
          };
          return (
            <div className="m-finding fd" key="fund">
              {gap > 0 ? (
                <>
                  <h1>가진 돈으로는 <mark>{man(gap)}</mark>이 모자라요.</h1>
                  <ul className="fd-ways">
                    <li><b>줄이기</b><span>평수나 마감을 낮춰요 ('드는 돈' 탭)</span></li>
                    <li><b>옮기기</b><span>월세가 싼 구를 골라요 ('동네' 탭 지도)</span></li>
                    <li><b>구하기</b><span>아래 정책자금·대출을 알아봐요</span></li>
                  </ul>
                </>
              ) : (
                <>
                  <h1>가진 돈으로 열 수 있고 <mark>{man(-gap)}</mark>이 남아요.</h1>
                  <p>남는 돈은 장사가 자리 잡기 전까지 버티는 데 쓰여요. 한 달에 {man(MONTHLY_BURN)}쯤 줄어든다고 보면 {Math.floor(-gap / MONTHLY_BURN) + RUNWAY_MONTHS}개월을 버틸 수 있어요. 교육·지원 프로그램은 돈이 충분해도 들어 둘 만해요.</p>
                </>
              )}
              <nav className="fd-jump" aria-label="모자란 돈 구역">
                {sections.map((s) => <a key={s.id} href={`#${s.id}`} onClick={(e) => { e.preventDefault(); document.getElementById(s.id)?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>{s.label}</a>)}
              </nav>

              {youthFunds.length > 0 && (
                <section id="fs-youth" className="fd-box is-youth">
                  <header><h2>청년 지원</h2><p>만 39세 이하만 받을 수 있는 자금과 프로그램이에요. 나이 조건이 있어 경쟁이 덜하고 금리가 낮은 편이에요.</p></header>
                  <ul className="fd-list">{youthFunds.map(card)}</ul>
                </section>
              )}

              {gap > 0 && (
                <section id="fs-loan" className="fd-box is-loan">
                  <header><h2>정책 대출·보증</h2><p>빌리는 돈이에요. 갚아야 해요. 받을 수 있는 시점(사업자등록 전/후)을 먼저 보세요.</p></header>
                  <ul className="fd-list">{loans.map(card)}</ul>
                  {!young && <p className="fd-foot">나이 조건(만 39세 이하)이 있는 청년 자금은 뺐어요.</p>}
                </section>
              )}

              {gap > 0 && (
                <section id="fs-bank" className="fd-box is-bank">
                  <header><h2>은행 대출</h2><p>지역신용보증재단 보증서를 담보로 한 대출은 아래 은행에서 방문 없이 신청할 수 있어요 (<a href={BANK_GUARANTEE_URL} target="_blank" rel="noreferrer">신용보증재단중앙회 안내</a>). 지금 은행 중소기업대출 평균 금리는 연 {+(LOAN_RATE * 100).toFixed(2)}%예요.</p></header>
                  <ul className="fd-banks">
                    {BANKS.map((b) => (
                      <li key={b.name}><a href={b.url} target="_blank" rel="noreferrer" title={b.kind === "앱" ? `${b.app} 앱 안내 (Google Play)` : `${b.name} ${b.app} (은행 홈페이지)`}>
                        <b>{b.name}</b><span>{b.kind === "앱" ? `${b.app} 앱` : b.app}</span><small>{b.kind === "앱" ? "앱 안내" : "상품 페이지"}</small>
                      </a></li>
                    ))}
                  </ul>
                  <p className="fd-foot">은행마다 금리가 어떻게 다른지는 <a href={BANK_COMPARE_URL} target="_blank" rel="noreferrer">은행연합회 개인사업자 대출금리 비교</a>에서 볼 수 있어요. 모두 보안 프로그램을 깔지 않아도 열려요 (2026년 10월 확인). 이 화면은 은행을 추천하거나 신청을 받지 않아요.</p>
                </section>
              )}

              <section id="fs-edu" className="fd-box is-edu">
                <header><h2>교육·지원 프로그램</h2><p>빌리는 돈이 아니에요. 배우고 준비하는 과정이고, 일부는 끝나면 자금을 연결해 줘요.</p></header>
                <ul className="fd-list">{programs.map(card)}</ul>
              </section>

              <section id="fs-now" className="fd-box is-now">
                <header><h2>지금 접수 중인 공고</h2><p>창업진흥원 K-Startup에 올라온 공고 중 이 구·서울·전국 대상이에요. 마감이 가까운 순이에요.</p></header>
                <KStartup young={young} gu={profile.gu} bare />
              </section>

              <small className="m-src">{FUNDS_SRC}. 업계 글을 모은 표라 한도와 금리는 기관 공고 원문으로 확인해야 해요. 이 시뮬레이터의 대출 이자는 정책자금이 아니라 일반 은행 대출로 본 연 {+(LOAN_RATE * 100).toFixed(2)}%예요.</small>
              <button type="button" className="m-btn" onClick={onNext}>가게 꾸미러 가기</button>
            </div>
          );
        })()}
      </section>
    </main>
  );
}
