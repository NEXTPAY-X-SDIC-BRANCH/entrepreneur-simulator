// The pre-founder flow (mock): 내 조건 → 동네 분석 → 가게 꾸미기 (위험 신호 점검 포함) → 시뮬레이션. See DESIGN.md.
import { Suspense, lazy, useEffect, useState } from "react";
import { DEFAULT_LEVERS, DEFAULT_PROFILE, emptyStore, setAreaInput, setDongData, setEcos, setGrowth, setGuData, setKrei, setRentData, setRentInput, type Gu, type Levers, type Profile, type Store } from "./model";
import ProfileStep from "./Profile";
import Login, { AccountButton } from "./Login";
import { getAccount } from "./account";
import { setAreaData, setFlowData, setShopData, setTrdarData, useIndustry } from "./area";
import Analysis from "./Analysis";
import Chat from "./Chat";
import CafeBuild from "./CafeBuild";
import CafeSim from "./CafeSim";
import ApparelBuild from "./ApparelBuild";
import ApparelSim from "./ApparelSim";
import { DEFAULT_APPAREL, setApparelKosis, type ApparelCfg } from "./apparel";
import type { CafeCfg } from "./cafeChecks";
import "./mock.css";
import "./analysis.css";

const Builder = lazy(() => import("./Builder"));
const Simulate = lazy(() => import("./SimulateEngine"));

export type Step = "profile" | "area" | "build" | "sim";
const STEPS: { key: Step; label: string }[] = [
  { key: "profile", label: "내 조건" },
  { key: "area", label: "동네 분석" },
  { key: "build", label: "가게 꾸미기" },
  { key: "sim", label: "시뮬레이션" },
];

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
  const [apparelCfg, setApparelCfg] = useState<ApparelCfg>(DEFAULT_APPAREL);
  const [loginOpen, setLoginOpen] = useState(() => !getAccount()); // 처음 들어오면 로그인 화면부터 (둘러보기도 가능)

  const ind = profile.industry;
  useEffect(() => {
    const get = (f: string) => fetch(`${import.meta.env.BASE_URL}mock/${f}`).then((r) => r.json());
    const cafe = ind === "cafe";
    const apparel = ind === "apparel"; // 옷가게는 구 단위 자료만 있다. 동네 파일(한식·카페 기준)은 읽지 않는다
    const none = Promise.resolve(null);
    let alive = true; // 업종을 빠르게 바꿔도 늦게 도착한 이전 업종의 자료가 덮어쓰지 않게
    setReady(false);
    const rent = get("rent_gu.json").catch(() => null); // 없으면 월세는 예시값으로 돌아간다
    const dong = apparel ? none : get(cafe ? "cafe_dong_stats.json" : "dong_stats.json").catch(() => null); // 없으면 동네 고르기를 숨긴다
    const krei = cafe || apparel ? none : get("gogi_krei.json").catch(() => null);        // 없으면 한식음식점 기준으로 돌아간다
    const growth = cafe || apparel ? none : get("growth.json").catch(() => null);         // 없으면 성장률을 숨긴다. 카페는 2024년 구 매출이 없다
    const prof = apparel ? none : get(cafe ? "cafe_dong_profile.json" : "dong_profile.json").catch(() => null);     // 없으면 동네 지도와 '~형 상권'을 숨긴다
    const geo = get("seoul_dong.json").catch(() => null);
    const trdar = apparel ? none : get("dong_trdar.json").catch(() => null);                                     // 없으면 동 안 상권 추천을 숨긴다
    const flow = get("dong_flow.json").catch(() => null);                                      // 없으면 '이 동네 지나가는 사람'을 숨기고 엔진은 기준 상권 모양을 쓴다
    const shops = apparel ? none : get("dong_shops.json").catch(() => null);                                    // 없으면 동 경쟁 탭의 가게 목록을 숨긴다
    const cafeDong = cafe ? get("cafe_dong.json").catch(() => null) : Promise.resolve(null); // 카페 구성(지표 엑셀)과 서울 비교
    const ecos = get("ecos_rates.json").catch(() => null);
    if (apparel) get("apparel_kosis.json").then(setApparelKosis).catch(() => null);          // 없으면 apparel.ts의 같은 값으로 계산                                    // 없으면 대출 이자는 연 6% 가정
    Promise.all([get("seoul_gu.json"), get("gu_stats.json"), rent, dong, krei, growth, prof, geo, shops, cafeDong, trdar, flow, ecos]).then(([g, d, r, dn, k, gr, pf, ge, sh, cd, tr, fl, ec]) => {
      useIndustry(ind); // 아래 set*보다 먼저: 구 통계가 업종 블록을 고른다
      if (!alive) return; setGuData(d); setRentData(r); setDongData(dn); setKrei(k); setGrowth(gr); setAreaData(pf, ge?.dong ?? null); setShopData(sh, cd); setTrdarData(tr); setFlowData(fl); setEcos(ec); setGus(g); setReady(true);
    }).catch(() => alive && setReady(true));
    return () => { alive = false; };
  }, [ind]);

  const go = (s: Step) => {
    setStep(s);
    setReached((r) => Math.max(r, STEPS.findIndex((x) => x.key === s)));
    scrollTo({ top: 0 });
  };
  const idx = STEPS.findIndex((s) => s.key === step);
  setRentInput(profile.rent && profile.rent.gu === profile.gu ? profile.rent : null); // 하위 화면이 읽기 전에 맞춰 둔다
  setAreaInput(profile.dong && profile.dong.gu === profile.gu ? profile.dong : null);

  return (
    <div className={`m-app m-step-${step}`}>
      <header className="m-top">
        <a className="m-brand" href="#/" onClick={() => go("profile")}>ChangeUp</a>
        <nav aria-label="진행 단계">
          <ol>
            {STEPS.map((s, i) => (
              <li key={s.key}>
                <button type="button" aria-current={s.key === step ? "step" : undefined} disabled={i > reached} onClick={() => go(s.key)}>
                  <span className="m-num">{i + 1}</span>{s.label}
                </button>
              </li>
            ))}
          </ol>
        </nav>
        {idx >= 1 && (
          <button type="button" className="m-chatbtn" aria-expanded={chat} onClick={() => setChat((c) => !c)}>
            {chat ? "질문 창 닫기" : "궁금한 것 물어보기"}
          </button>
        )}
        <AccountButton onLogin={() => setLoginOpen(true)} />
      </header>
      {loginOpen && <Login onDone={() => setLoginOpen(false)} onSkip={() => setLoginOpen(false)} />}

      {!loginOpen && !ready && <p className="m-loading">자료를 불러오는 중이에요</p>}
      {!loginOpen && ready && step === "profile" && <ProfileStep profile={profile} setProfile={setProfile} gus={gus} onDone={() => go("area")} />}
      {!loginOpen && ready && step === "area" && <Analysis profile={profile} setProfile={setProfile} gus={gus} onNext={() => go("build")} />}
      {!loginOpen && ready && ind === "cafe" && step === "build" && <CafeBuild profile={profile} cfg={cafeCfg} setCfg={setCafeCfg} onNext={() => go("sim")} />}
      {!loginOpen && ready && ind === "cafe" && step === "sim" && <CafeSim profile={profile} cfg={cafeCfg ?? { pyeong: 20, grade: "basic", staff: 1 }} onBack={() => go("build")} />}
      {!loginOpen && ready && ind === "apparel" && step === "build" && <ApparelBuild profile={profile} cfg={apparelCfg} setCfg={setApparelCfg} onNext={() => go("sim")} />}
      {!loginOpen && ready && ind === "apparel" && step === "sim" && <ApparelSim profile={profile} cfg={apparelCfg} onBack={() => go("build")} />}
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

      {idx >= 1 && chat && <Chat profile={profile} store={store} levers={levers} shocks={[]} gus={gus} onClose={() => setChat(false)} />}
    </div>
  );
}
