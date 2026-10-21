// lab:modes — 하드 모드 머리글 도구: 민감도 보기, 다시 해보기 (판 기록 + 지난 판 비교).
// 판 기록은 모든 업종에서 결과 화면의 RecordAttempt가 남긴다. 여기서는 비교 창을 띄우고, 고깃집 시즌 중간이면 그만둘지 묻는다.
import { useState } from "react";
import { getEngineCtx } from "../../mock/chatContext";
import { flowShape, profileOf } from "../../mock/area";
import { cafeDaily, engineBody, type CafeCfg } from "../../mock/cafeChecks";
import { LOAN_RATE, OWNER_DRAW, guStat, openingCost, storeStats, type Levers, type Profile, type Store } from "../../mock/model";
import { ENGINE, post } from "./api";
import { fetchTemplate, recompute, toEngine } from "../menu/api";
import { attemptsOf, useAttempts, type Attempt } from "./attempts";
import Compare from "./Compare";
import { forgetRecorded, recordPending } from "./RecordAttempt";
import Sensitivity from "./Sensitivity";
import { isLab } from "../industry/industries";
import { engineBody as labBody, type IndustryCfg } from "../industry/api";
import "./modes.css";

const nextMonth = () => (new Date().getMonth() + 1) % 12 + 1;

/** 하드 모드 시뮬레이션의 첫 메뉴판과 같은 기본 메뉴 (lab:menu). 고깃집은 삼겹살 가격 비율로 주메뉴 가격을 맞추고 상차림 원가를 넣는다 */
async function defaultMenu(industry: "bbq" | "cafe", price: number, district?: string) {
  try {
    let d = await fetchTemplate(ENGINE, industry, "domestic", district);
    const k = price / 19000;
    if (industry === "bbq" && Math.abs(k - 1) > 1e-6) {
      d = await recompute(ENGINE, "bbq", "domestic", d.items.map((x) => (x.kind === "main" ? { ...x, price: Math.round((x.price * k) / 100) * 100 } : x)), { table: d.table_setting });
    }
    return { menu: toEngine(d.items), table_cost: d.table_setting?.cost };
  } catch { return {}; } // 메뉴판 서버가 없으면 예전 계산 (삼겹살 가격, 업계 원가율)
}

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
  const p0 = await post<Parameters<typeof cafeDaily>[0]>("/cafe/preview", body);
  return { ...body, daily_customers: cafeDaily(p0, profile.gu, cfg.pyeong), start_month: 3 }; // CafeSim·이지와 같은 손님 수 (자리 제한 전 매출 기준)
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
  // 카페·새 업종: 비교 창은 이 화면이 뜬 뒤에 남긴 판만, 한 번씩 띄운다 (새로 고침 전 판은 다시 안 띄움).
  // 판 번호가 아니라 기록 시각으로 본다: 번호는 업종마다 1부터라, 업종을 바꾸면 다른 업종의 번호와 겹친다
  const [since] = useState(() => Date.now());
  const [shown] = useState(() => new Set<number>());
  const ind = profile.industry;
  const recorded = useAttempts(ind); // 판이 기록되면 머리글의 몇 판째 표시도 바로 바뀐다
  const n = (recorded.at(-1)?.n ?? 0) + 1;
  if (step !== "build" && step !== "sim") return null;

  const retry = async () => {
    // 모든 업종: 결과 화면(성적표 옆 RecordAttempt)이 판을 남긴다. 아직 비교를 안 보여 준 판이면 비교부터 (성적표와 같은 요약이라 점수도 같다)
    setBusy(true); await recordPending(); setBusy(false);
    const list = attemptsOf(ind), last = list.at(-1);
    if (last && last.summary.mode === "hard" && last.at >= since && !shown.has(last.at)) { shown.add(last.at); setCmp({ prev: list.at(-2), cur: last }); return; }
    const ctx = ind === "bbq" ? getEngineCtx() : null;
    const midSeason = ind === "bbq" ? !!ctx && ctx.months.length > 0 && !ctx.finished && !ctx.closed : false;
    if (midSeason && !window.confirm("아직 6개월이 끝나지 않았어요. 이번 판은 기록하지 않고 가게 꾸미기로 돌아갈까요?")) return;
    forgetRecorded(); onRetry();
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
            title={!finished && ind === "bbq" ? "6개월을 끝까지 돌리면 이번 판 점수를 남기고 다음 판과 비교해요" : ind !== "bbq" ? "결과 화면까지 가면 이번 판 점수를 남기고 다음 판과 비교해요" : undefined}>
            {busy ? "점수 매기는 중" : "다시 해보기"}
          </button>
        )}
      </span>
      {sens && (
        <Sensitivity industry={ind} onClose={() => setSens(false)}
          note={ind === "bbq" ? undefined : "시작 달은 3월로 고정해서, 시뮬레이션에서 다른 달을 골랐거나 사건이 달랐다면 그 판의 숫자와 달라요."}
          getBody={async () => {
            if (ind === "bbq") { const b = bbqHardBody(profile, store, levers); const m = await defaultMenu("bbq", levers.price); return { ...b, plan: { ...b.plan, ...m } }; }
            if (isLab(ind)) return labHardBody(profile, indCfg ?? null);
            const c = await cafeHardBody(profile, cafeCfg ?? { pyeong: 20, grade: "basic", staff: 1 });
            return { ...c, ...(await defaultMenu("cafe", 0, String(c.district))) };
          }} />
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
              <button type="button" className="m-btn" onClick={() => { setCmp(null); forgetRecorded(); onRetry(); }}>가게 고치러 가기 ({cmp.cur.n + 1}판)</button>
              <small>가게 배치, 대출, 가격과 알바는 그대로 남아 있어요. 고친 뒤 다시 돌리면 이번 판과 비교해 드려요.</small>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
