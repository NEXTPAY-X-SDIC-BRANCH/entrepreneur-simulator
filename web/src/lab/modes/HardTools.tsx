// lab:modes — 하드 모드 머리글 도구: 민감도 보기, 다시 해보기 (판 기록 + 지난 판 비교).
// SimulateEngine/CafeSim은 고치지 않는다. 고깃집 결과는 SimulateEngine이 챗봇용으로 내보내는 chatContext에서 읽는다.
import { useState } from "react";
import { getEngineCtx } from "../../mock/chatContext";
import { flowShape, profileOf } from "../../mock/area";
import { areaFx, engineBody, type CafeCfg } from "../../mock/cafeChecks";
import { LOAN_RATE, OWNER_DRAW, guStat, openingCost, storeStats, type Levers, type Profile, type Store } from "../../mock/model";
import { netErr, post } from "./api";
import { addAttempt, attemptsOf, nextAttemptNo, type Attempt } from "./attempts";
import Compare from "./Compare";
import { scoreOf } from "./scoreStub";
import Sensitivity from "./Sensitivity";
import { hardBbqSummary, type Inputs } from "./summary";
import { isLab } from "../industry/industries";
import { engineBody as labBody, type IndustryCfg } from "../industry/api";
import "./modes.css";

const nextMonth = () => (new Date().getMonth() + 1) % 12 + 1;

/** SimulateEngine의 spec()과 같은 점포 입력 + 빌더에서 정한 가격·알바로 /season/run 몸통 */
export function bbqHardBody(profile: Profile, store: Store, levers: Levers, startMonth = nextMonth()) {
  const st = guStat(profile.gu), stats = storeStats(store);
  const code = profile.dong && profile.dong.gu === profile.gu ? profileOf(profile.gu, profile.dong.name)?.code : undefined;
  const staff = Math.min(4, levers.staff);
  const cost = openingCost(store, profile.gu, profile.keyMoney ?? 0);
  return {
    seed: 42, opening: true,
    store: { gu_sales_man: st.salesHansik, pyeong: store.pyeong, tables: Math.max(1, stats.tables), seats: stats.seats,
      cash_rent_man_per_pyeong: st.rent, staff, price: levers.price, baseline_runs: 150, quarter_index: st.qidx,
      area_type: st.areaType ?? "일반", start_month: startMonth, flow: flowShape(code, profile.gu) },
    plan: { meat_price: levers.price, staff_per_shift: staff, close_hour: 24, marketing_budget: 0, meat_grade: "domestic", banchan: 5, delivery: "none" },
    invest: Object.fromEntries(cost.lines.map((l) => [l.key, l.amount * 1e4])),
    own_capital: profile.capital * 1e4, owner_draw: OWNER_DRAW * 1e4,
    loan: store.loan > 0 ? { principal: store.loan * 1e4, annual_rate: LOAN_RATE, term_months: 60, grace_months: 60 } : null,
  };
}

/** CafeSim과 같은 몸통: 배치 + 이 동네 보통 카페 매출에 맞춘 손님 수 (/cafe/preview 두 번) */
export async function cafeHardBody(profile: Profile, cfg: CafeCfg) {
  const code = profile.dong && profile.dong.gu === profile.gu ? profileOf(profile.gu, profile.dong.name)?.code : undefined;
  if (!code) throw new Error("카페는 동네를 골라야 돌릴 수 있어요. 동네 분석에서 동을 골라 주세요.");
  const body = engineBody(profile, cfg, String(code));
  const p0 = await post<{ rough_month: { revenue_krw: number }; demand: { default_daily_customers: number } }>("/cafe/preview", body);
  const ratio = (guStat(profile.gu).sales * areaFx(cfg.pyeong) * 10000) / p0.rough_month.revenue_krw;
  return { ...body, daily_customers: Math.min(600, Math.max(10, Math.round(p0.demand.default_daily_customers * ratio))), start_month: 3 };
}

/** 새 업종: IndustrySim과 같은 몸통 (가게 꾸미기 값, 비어 있으면 엔진의 업종 기본값). 시작 달은 IndustrySim 기본 3월, 시드 고정 */
export function labHardBody(profile: Profile, cfg: IndustryCfg | null) {
  const c: IndustryCfg = cfg ?? { industry: profile.industry as IndustryCfg["industry"], grade: "basic", delivery: true };
  return { ...labBody(profile, c), seed: 42, start_month: 3 };
}

export default function HardTools({ profile, store, levers, cafeCfg, indCfg, step, onRetry }: {
  profile: Profile; store: Store; levers: Levers; cafeCfg: CafeCfg | null; indCfg?: IndustryCfg | null; step: string; onRetry: () => void;
}) {
  const [sens, setSens] = useState(false);
  const [cmp, setCmp] = useState<{ prev?: Attempt; cur: Attempt } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const ind = profile.industry;
  const n = nextAttemptNo(ind);
  if (step !== "build" && step !== "sim") return null;

  const retry = async () => {
    const ctx = ind === "bbq" ? getEngineCtx() : null;
    if (!ctx || !ctx.months.length || !(ctx.finished || ctx.closed)) { onRetry(); return; }
    setBusy(true); setErr("");
    try {
      const cost = openingCost(store, profile.gu, profile.keyMoney ?? 0);
      const st = storeStats(store);
      const inputs: Inputs = { gu: profile.gu, dong: profile.dong?.gu === profile.gu ? profile.dong.name : null, capital_man: profile.capital,
        pyeong: store.pyeong, tables: st.tables, staff: Math.min(4, levers.staff), price: levers.price, loan_man: store.loan, start_month: ctx.start_month, grade: store.grade };
      const summary = hardBbqSummary(ctx, (profile.capital + store.loan - cost.total) * 1e4, cost.total * 1e4, store.loan * 1e4, LOAN_RATE, inputs, n);
      const scored = await scoreOf(summary);
      const before = attemptsOf(ind).at(-1);
      const cur = addAttempt(summary, scored);
      setCmp({ prev: before, cur });
    } catch (e) { setErr(netErr(e)); }
    setBusy(false);
  };

  const cafeReady = ind !== "cafe" || !!cafeCfg;
  const finished = ind === "bbq" && step === "sim" && !!getEngineCtx()?.finished;
  return (
    <>
      <span className="lm-tools">
        {n > 1 && <span className="lm-badge">{n}판째</span>}
        <button type="button" className="m-btn m-btn-quiet lm-toolbtn" disabled={!cafeReady} onClick={() => setSens(true)}>민감도 보기</button>
        {step === "sim" && (
          <button type="button" className="m-btn m-btn-quiet lm-toolbtn" disabled={busy} onClick={retry}
            title={ind !== "bbq" ? "이 업종의 하드 모드는 성적표가 결과 화면에 붙은 뒤 판 기록을 남겨요. 지금은 입력을 그대로 두고 가게 꾸미기로 돌아가요" : !finished ? "6개월을 끝까지 돌리면 이번 판 점수를 남기고 다음 판과 비교해요" : undefined}>
            {busy ? "점수 매기는 중" : ind !== "bbq" ? "다시 해보기 (점수 기록 없이)" : "다시 해보기"}
          </button>
        )}
        {err && <span className="lm-err lm-err-inline" role="alert">{err}</span>}
      </span>
      {sens && (
        <Sensitivity industry={ind} onClose={() => setSens(false)}
          getBody={async () => (ind === "bbq" ? bbqHardBody(profile, store, levers) : isLab(ind) ? labHardBody(profile, indCfg ?? null)
            : cafeHardBody(profile, cafeCfg ?? { pyeong: 20, grade: "basic", staff: 1 }))} />
      )}
      {cmp && (
        <div className="lm-modal" role="dialog" aria-modal="true" aria-labelledby="lm-cmp-h">
          <div className="lm-sheet">
            <header className="lm-sheet-h">
              <h2 id="lm-cmp-h">{cmp.cur.n}판 결과를 남겼어요</h2>
              <button type="button" className="m-btn m-btn-quiet lm-close" onClick={() => setCmp(null)}>닫기</button>
            </header>
            <Compare prev={cmp.prev} cur={cmp.cur} />
            <div className="lm-actions">
              <button type="button" className="m-btn" onClick={() => { setCmp(null); onRetry(); }}>가게 고치러 가기 ({cmp.cur.n + 1}판)</button>
              <small>가게 배치, 대출, 가격과 알바는 그대로 남아 있어요. 고친 뒤 다시 돌리면 이번 판과 비교해 드려요.</small>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
