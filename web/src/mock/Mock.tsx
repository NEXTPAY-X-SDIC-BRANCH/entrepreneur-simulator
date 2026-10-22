// The pre-founder flow (mock): 내 조건 → 동네 분석 → 가게 꾸미기 (위험 신호 점검 포함) → 시뮬레이션. See DESIGN.md.
import { Suspense, lazy, useEffect, useState } from "react";
import { DEFAULT_LEVERS, DEFAULT_PROFILE, emptyStore, setAreaInput, setDongData, setEcos, setGrowth, setGuData, setKrei, setRentData, setRentInput, type Gu, type Levers, type Profile, type Store } from "./model";
import ProfileStep from "./Profile";
import Login, { AccountButton } from "./Login";
import { setAreaData, setFlowData, setShopData, setTrdarData, useIndustry } from "./area";
import Analysis from "./Analysis";
import Chat from "./Chat";
import CafeBuild from "./CafeBuild";
import CafeSim from "./CafeSim";
import ApparelBuild from "./ApparelBuild";
import ApparelSim from "./ApparelSim";
import { DEFAULT_APPAREL, apparelOpeningCost, setApparelKosis, setFashionMarket, type ApparelCfg } from "./apparel";
import { setSns } from "./sns";
import { cafeOpeningCost } from "./cafe";
import { setSbizDelivery } from "./quickfood";
import type { CafeCfg } from "./cafeChecks";
import { isLab } from "../lab/industry/industries"; // lab:industry
import { IndustryArea, IndustryBuild, IndustrySim, type IndustryCfg } from "../lab/industry/screens"; // lab:industry
import "./mock.css";
import "./analysis.css";
import PorkEntry from "../lab/pork/PorkEntry"; // lab:pork
import ModePick, { type Mode } from "../lab/modes/ModePick"; // lab:modes
import Easy, { type HardSeed } from "../lab/modes/Easy"; // lab:modes
import HardTools from "../lab/modes/HardTools"; // lab:modes
import { starterStore } from "./model"; // lab:modes

const Builder = lazy(() => import("./Builder"));
const Simulate = lazy(() => import("./SimulateEngine"));

export type Step = "profile" | "area" | "build" | "sim";
const STEPS: { key: Step; label: string }[] = [
  { key: "profile", label: "내 조건" },
  { key: "area", label: "동네 분석" },
  { key: "build", label: "가게 꾸미기" },
  { key: "sim", label: "시뮬레이션" },
];

// 옷가게: 동네 성격은 dong_profile.json(한식 기준)을 쓰고, 가게 수와 경쟁 밀도(곳/㎢)는 옷가게 행정동 파일 값으로 바꾼다.
// 업종별 동네 성장률은 없어서 비운다 (지도 알약에서도 뺀다, area.ts dongMetricKeys)
type Prof = { dong: { code: string; stores: number; pork: number; area_km2: number | null; pork_km2: number | null; pork_share: number | null; growth: number | null }[] };
function adaptProfiles(pf: Prof | null, dn: { gu: Record<string, { code: string; stores: number }[]> } | null): Prof | null {
  if (!pf || !dn) return pf;
  const n = new Map(Object.values(dn.gu).flat().map((x) => [x.code, x.stores]));
  return { ...pf, dong: pf.dong.map((d) => {
    const k = n.get(d.code) ?? 0;
    return { ...d, pork: k, pork_km2: d.area_km2 ? Math.round((k / d.area_km2) * 10) / 10 : null, pork_share: null, growth: null };
  }) };
}

export default function Mock() {
  const [step, setStep] = useState<Step>("profile");
  const [reached, setReached] = useState(0);
  const [profile, setProfile] = useState<Profile>(DEFAULT_PROFILE);
  const [store, setStoreRaw] = useState<Store>(() => emptyStore());
  const [levers, setLevers] = useState<Levers>(DEFAULT_LEVERS);
  const setStore = (s: Store) => setStoreRaw(s);
  const [gus, setGus] = useState<Gu[]>([]);
  const [ready, setReady] = useState(false);
  const [chat, setChat] = useState(false);
  const [cafeCfg, setCafeCfg] = useState<CafeCfg | null>(null);
  const [indCfg, setIndCfg] = useState<IndustryCfg | null>(null); // lab:industry
  const [mode, setMode] = useState<Mode | null>(null); // lab:modes 이지/하드 (null = 아직 안 고름)
  const [apparelCfg, setApparelCfg] = useState<ApparelCfg>(DEFAULT_APPAREL);
  // upstream 로그인(별명·반 코드, 옷가게 성적표 랭킹). lab:merge 시작 화면은 이지/하드 고르기(ModePick)라 처음에 띄우지 않고 머리글 계정 버튼으로 연다
  const [loginOpen, setLoginOpen] = useState(false);

  const ind = profile.industry;
  useEffect(() => {
    const get = (f: string) => fetch(`${import.meta.env.BASE_URL}mock/${f}`).then((r) => r.json());
    const cafe = ind === "cafe";
    const lab = isLab(ind); // lab:industry 새 업종(치킨·분식 포함): 구 블록(industry_gu.json)과 동네 파일(industry_<id>_dong.json)만, 고깃집 전용 자료는 안 읽는다
    const apparel = ind === "apparel"; // 옷가게는 동네 매출·가게 수(apparel_dong_stats)만 있다. 동네 지도·경쟁 목록 파일(한식·카페 기준)은 읽지 않는다
    const lite = apparel;
    const none = Promise.resolve(null);
    const labGu = lab ? get("industry_gu.json").catch(() => null) : none;
    let alive = true; // 업종을 빠르게 바꿔도 늦게 도착한 이전 업종의 자료가 덮어쓰지 않게
    setReady(false);
    const rent = get("rent_gu.json").catch(() => null); // 없으면 월세는 예시값으로 돌아간다
    const dong = get(cafe ? "cafe_dong_stats.json" : lab ? `industry_${ind}_dong.json` : apparel ? "apparel_dong_stats.json" : "dong_stats.json").catch(() => null); // 없으면 동네 고르기를 숨긴다
    const krei = cafe || lite ? none : get("gogi_krei.json").catch(() => null);        // 없으면 한식음식점 기준으로 돌아간다
    const growth = cafe || lite ? none : get("growth.json").catch(() => null);         // 없으면 성장률을 숨긴다. 카페는 2024년 구 매출이 없다
    // 동네 지도와 '~형 상권'. 옷가게는 동네 성격(고깃집 쪽 파일)을 쓰되 가게 수·경쟁 밀도는 옷가게 값으로 바꾼다 (아래 adaptProfiles)
    const prof = lab ? none : get(cafe ? "cafe_dong_profile.json" : "dong_profile.json").catch(() => null); // lab:industry
    const geo = get("seoul_dong.json").catch(() => null);
    const trdar = lab || lite ? none : get("dong_trdar.json").catch(() => null);  // 없으면 동 안 상권 추천을 숨긴다
    const flow = get("dong_flow.json").catch(() => null);                          // 없으면 '이 동네 지나가는 사람'을 숨기고 엔진은 기준 상권 모양을 쓴다
    const shops = lab || lite ? none : get("dong_shops.json").catch(() => null);  // 없으면 동 경쟁 탭의 가게 목록을 숨긴다
    const cafeDong = cafe ? get("cafe_dong.json").catch(() => null) : Promise.resolve(null); // 카페 구성(지표 엑셀)과 서울 비교
    const ecos = get("ecos_rates.json").catch(() => null);                          // 없으면 대출 이자는 연 6% 가정
    get("sbiz_sns.json").then(setSns).catch(() => null); // 소상공인365 SNS 분석 (홍보 효과의 달별 관심도, 연관어). 없으면 관심도 1
    get("sbiz_delivery.json").then(setSbizDelivery).catch(() => null); // 소상공인365 배달분석 (고깃집 엔진의 구별 배달 배수도 쓴다). 없으면 1
    if (apparel) get("apparel_kosis.json").then(setApparelKosis).catch(() => null);   // 없으면 apparel.ts의 같은 값으로 계산
    if (apparel) get("fashion_market.json").then(setFashionMarket).catch(() => null); // 없으면 apparel.ts MARKET의 같은 값
    Promise.all([get("seoul_gu.json"), get("gu_stats.json"), rent, dong, krei, growth, prof, geo, shops, cafeDong, trdar, flow, ecos, labGu]).then(([g, d0, r, dn, k, gr, pf, ge, sh, cd, tr, fl, ec, lg]) => {
      const d = lab && lg ? { ...d0, [ind]: lg[ind] } : d0; // lab:industry
      useIndustry(ind); // 아래 set*보다 먼저: 구 통계가 업종 블록을 고른다
      if (!alive) return; setGuData(d); setRentData(r); setDongData(dn); setKrei(k); setGrowth(gr); setAreaData(lite ? adaptProfiles(pf, dn) : pf, ge?.dong ?? null); setShopData(sh, cd); setTrdarData(tr); setFlowData(fl); setEcos(ec); setGus(g); setReady(true);
    }).catch(() => alive && setReady(true));
    return () => { alive = false; };
  }, [ind]);

  const go = (s: Step) => {
    setStep(s);
    setReached((r) => Math.max(r, STEPS.findIndex((x) => x.key === s)));
    scrollTo({ top: 0 });
  };
  const idx = STEPS.findIndex((s) => s.key === step);
  const toHard = (h: HardSeed) => { // lab:modes 이지 결과를 하드 모드 가게 꾸미기로 넘긴다 (평수, 테이블, 대출, 가격, 알바 그대로)
    setMode("hard");
    if (h.industry === "bbq") { setStore(starterStore(h.pyeong, "basic", h.loan_man, h.tables)); setLevers({ price: h.price, staff: h.staff, days: 26 }); }
    else if (isLab(h.industry)) setIndCfg({ industry: h.industry, pyeong: h.pyeong, tables: h.tables, staff: h.staff, grade: "basic", delivery: true }); // lab:modes 새 업종
    else setCafeCfg({ pyeong: h.pyeong, grade: "basic", staff: h.staff });
    go("build");
  };
  setRentInput(profile.rent && profile.rent.gu === profile.gu ? profile.rent : null); // 하위 화면이 읽기 전에 맞춰 둔다
  setAreaInput(profile.dong && profile.dong.gu === profile.gu ? profile.dong : null);

  return (
    <div className={`m-app m-step-${step}`}>
      <header className="m-top">
        <a className="m-brand" href="#/" onClick={() => go("profile")}>ChangeUp</a>
        {mode === "easy" && <span className="m-modehead">이지 모드 <button type="button" className="m-link" onClick={() => { setMode(null); go("profile"); }}>연습 방식 바꾸기</button></span> /* lab:modes */}
        {mode === "hard" && <HardTools profile={profile} store={store} levers={levers} cafeCfg={cafeCfg} indCfg={indCfg} step={step} onRetry={() => go("build")} /> /* lab:modes */}
        {mode !== "easy" && <nav aria-label="진행 단계">
          <ol>
            {STEPS.map((s, i) => (
              <li key={s.key}>
                <button type="button" aria-current={s.key === step ? "step" : undefined} disabled={i > reached} onClick={() => go(s.key)}>
                  <span className="m-num">{i + 1}</span>{s.label}
                </button>
              </li>
            ))}
          </ol>
        </nav>}
        {ind === "bbq" && idx >= 1 && <PorkEntry /> /* lab:pork 돼지고기 시세 대시보드 */}
        {idx >= 1 && (
          <button type="button" className="m-chatbtn" aria-expanded={chat} onClick={() => setChat((c) => !c)}>
            {chat ? "질문 창 닫기" : "궁금한 것 물어보기"}
          </button>
        )}
        <AccountButton onLogin={() => setLoginOpen(true)} />
      </header>
      {loginOpen && <Login onDone={() => setLoginOpen(false)} onSkip={() => setLoginOpen(false)} />}

      {!loginOpen && !ready && <p className="m-loading">자료를 불러오는 중이에요</p>}
      {!loginOpen && step === "profile" && !mode && <ModePick initial={mode} onPick={setMode} /> /* lab:modes */}
      {!loginOpen && step === "profile" && mode === "easy" && <Easy profile={profile} setProfile={setProfile} gus={gus} onHard={toHard} onModes={() => setMode(null)} /> /* lab:modes */}
      {!loginOpen && ready && step === "profile" && mode === "hard" /* lab:modes */ && <ProfileStep profile={profile} setProfile={setProfile} gus={gus} onDone={() => go("area")} />}
      {!loginOpen && ready && step === "area" && !isLab(ind) && <Analysis profile={profile} setProfile={setProfile} gus={gus} onNext={() => go("build")} />} {/* lab:industry 새 업종은 아래 IndustryArea */}
      {!loginOpen && ready && ind === "cafe" && step === "build" && <CafeBuild profile={profile} cfg={cafeCfg} setCfg={setCafeCfg} onNext={() => go("sim")} />}
      {!loginOpen && ready && ind === "cafe" && step === "sim" && <CafeSim profile={profile} cfg={cafeCfg ?? { pyeong: 20, grade: "basic", staff: 1 }} onBack={() => go("build")} onArea={() => go("area")} />}
      {!loginOpen && ready && ind === "apparel" && step === "build" && <ApparelBuild profile={profile} cfg={apparelCfg} setCfg={setApparelCfg} onNext={() => go("sim")} />}
      {!loginOpen && ready && ind === "apparel" && step === "sim" && <ApparelSim profile={profile} cfg={apparelCfg} onBack={() => go("build")} />}
      {/* lab:merge 치킨·분식은 lab 엔진(sim/generic) 화면으로 간다. upstream QuickFoodBuild·QuickFoodSim은 남겨 두지만 연결하지 않는다 (업종 고르기에 같은 업종이 두 번 나오지 않게) */}
      {!loginOpen && ready && isLab(ind) && step === "area" && <IndustryArea profile={profile} setProfile={setProfile} gus={gus} onNext={() => go("build")} />} {/* lab:industry */}
      {!loginOpen && ready && isLab(ind) && step === "build" && <IndustryBuild profile={profile} cfg={indCfg} setCfg={setIndCfg} onNext={() => go("sim")} />} {/* lab:industry */}
      {!loginOpen && ready && isLab(ind) && step === "sim" && <IndustrySim profile={profile} cfg={indCfg} onBack={() => go("build")} />} {/* lab:industry */}
      {!loginOpen && ready && ind === "bbq" && step === "build" && (
        <Suspense fallback={<p className="m-loading">가게 도면을 펴는 중이에요</p>}>
          <Builder profile={profile} store={store} setStore={setStore} levers={levers} setLevers={setLevers} onNext={() => go("sim")} />
        </Suspense>
      )}
      {!loginOpen && ready && ind === "bbq" && step === "sim" && (
        <Suspense fallback={<p className="m-loading">가게 문을 여는 중이에요</p>}>
          <Simulate profile={profile} store={store} levers={levers} setLevers={setLevers} onBack={() => go("build")} />
        </Suspense>
      )}

      {idx >= 1 && chat && <Chat profile={profile} store={store} levers={levers} shocks={[]} gus={gus} onClose={() => setChat(false)} alt={
        ind === "apparel" ? { cost: apparelOpeningCost(apparelCfg, profile.gu, profile.keyMoney ?? 0), pyeong: apparelCfg.pyeong, staff: apparelCfg.staff }
          : ind === "cafe" ? { cost: cafeOpeningCost(cafeCfg?.pyeong ?? 20, cafeCfg?.grade ?? "basic", profile.gu, profile.keyMoney ?? 0), pyeong: cafeCfg?.pyeong ?? 20, staff: cafeCfg?.staff ?? 1 }
          : null} />}
    </div>
  );
}
