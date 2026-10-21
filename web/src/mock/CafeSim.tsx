// 카페 시뮬레이션 (4단계). 고깃집 시뮬레이션(SimulateEngine.tsx)과 같은 구조: 전체 화면 3D 위에 지표 줄, 왼쪽 현금 그래프와 운영 계획,
// 아래 재생 바, 시작·운영 계획·정산·결과는 팝업. 엔진은 카페 월별 모델(sim/cafe, 포트 8010 /cafe/season)이다.
// 엔진은 손님 한 명씩이 아니라 시간대별 주문·처리 능력을 계산하므로, 영업 장면은 하루 시간대를 따라 의자가 차고 비는 모습으로 보여 준다.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { profileOf } from "./area";
import { flowRatioNote } from "./DongFlow";
import { areaFx, engineBody, type CafeCfg } from "./cafeChecks";
import CafeRoom3D from "./CafeRoom3D";
import { ENGINE, type Preview } from "./useCafePreview";
import { guStat, man, type Profile } from "./model";
import { IconBattery, IconCal, IconCash, IconHeart, IconStar, Metric, Q } from "./SimulateEngine";
import CardMonthLine, { CardSeasonLine, type CardMonth } from "../lab/finance/CardMonthLine"; // lab:finance
import { cafeFinance } from "../lab/finance/finance"; // lab:finance
import "./simulate-engine.css";
import "./cafe-sim.css";
import CostStack from "../lab/cost/CostStack"; // lab:cost
import { VAT_NOTE, cafeStack, prorate, type CafeLine } from "../lab/cost/stackModel"; // lab:cost
import MenuEditor, { MenuSummary } from "../lab/menu/MenuEditor"; // lab:menu
import { fetchTemplate, toEngine, type MenuDoc } from "../lab/menu/api"; // lab:menu
import ScoreCard from "../lab/score/ScoreCard"; // lab:score
import { cafeSummary } from "../lab/score/summary"; // lab:score
import RecordAttempt from "../lab/modes/RecordAttempt"; // lab:modes 하드 모드 판 기록 (다시 해보기 비교)

const wman = (krw: number) => man(krw / 10000);
const sgn = (krw: number) => `${krw >= 0 ? "+" : "−"}${man(Math.abs(krw / 10000))}`;
const tone = (v: number) => (v < 0 ? "neg" : "pos");

type Hours = "short" | "standard" | "long";
type Staff = "lean" | "standard" | "generous";
type Dec = { price_change_pct: number; hours: Hours; staff_policy: Staff; marketing_krw: number; dessert: boolean };
const HOURS_KO: Record<Hours, string> = { short: "짧게 (11~20시)", standard: "기본 (10~22시)", long: "길게 (8~23시)" };
const STAFF_KO: Record<Staff, string> = { lean: "빠듯하게", standard: "기본", generous: "넉넉하게" };
const HOURS_ORDER: Hours[] = ["short", "standard", "long"], STAFF_ORDER: Staff[] = ["lean", "standard", "generous"];

type Lever = { key: string; label: string; hint: string; text: (d: Dec) => string; can: (d: Dec, s: -1 | 1) => boolean; move: (d: Dec, s: -1 | 1) => Dec };
const LEVERS: Lever[] = [
  { key: "price", label: "가격 조정", hint: "이번 달에 메뉴 가격을 한 번 바꿔요. 올리면 손님이 줄고 객단가가 늘어요.",
    text: (d) => (d.price_change_pct === 0 ? "그대로" : `${d.price_change_pct > 0 ? "+" : ""}${d.price_change_pct}%`),
    can: (d, s) => d.price_change_pct + s * 5 >= -20 && d.price_change_pct + s * 5 <= 30, move: (d, s) => ({ ...d, price_change_pct: d.price_change_pct + s * 5 }) },
  { key: "hours", label: "영업시간", hint: "길게 열면 손님을 더 받지만 일하는 시간(인건비)이 늘어요.",
    text: (d) => HOURS_KO[d.hours], can: (d, s) => HOURS_ORDER.indexOf(d.hours) + s >= 0 && HOURS_ORDER.indexOf(d.hours) + s < 3,
    move: (d, s) => ({ ...d, hours: HOURS_ORDER[HOURS_ORDER.indexOf(d.hours) + s] }) },
  { key: "staff", label: "직원 운영", hint: "빠듯하면 인건비가 줄지만 바쁜 시간에 손님이 돌아가요.",
    text: (d) => STAFF_KO[d.staff_policy], can: (d, s) => STAFF_ORDER.indexOf(d.staff_policy) + s >= 0 && STAFF_ORDER.indexOf(d.staff_policy) + s < 3,
    move: (d, s) => ({ ...d, staff_policy: STAFF_ORDER[STAFF_ORDER.indexOf(d.staff_policy) + s] }) },
  { key: "marketing", label: "마케팅", hint: "한 달 광고·SNS 비용이에요. 늘리면 알려지는 데 도움이 돼요.",
    text: (d) => (d.marketing_krw ? `월 ${wman(d.marketing_krw)}` : "없음"), can: (d, s) => d.marketing_krw + s * 500_000 >= 0 && d.marketing_krw + s * 500_000 <= 5_000_000,
    move: (d, s) => ({ ...d, marketing_krw: d.marketing_krw + s * 500_000 }) },
  { key: "dessert", label: "디저트", hint: "디저트를 팔면 객단가가 늘지만 폐기와 준비 시간이 생겨요.",
    text: (d) => (d.dessert ? "판매" : "안 팔아요"), can: (d, s) => (s > 0 ? !d.dessert : d.dessert), move: (d, s) => ({ ...d, dessert: s > 0 }) },
];
const planKey = (l: Lever): keyof Dec => (l.key === "price" ? "price_change_pct" : l.key === "hours" ? "hours" : l.key === "staff" ? "staff_policy" : l.key === "marketing" ? "marketing_krw" : "dessert");

type Month = {
  month: number; calendar_month: number; status: "open" | "closed" | "finished"; owner_note_ko: string;
  decisions: Dec & { price_level: number; scenario?: Record<string, string> }; scenario_ko?: { title: string; choice: string }[];
  drivers?: { maturity: number; peak_util: number; bottleneck_label_ko: string };
  kpi: { revenue_krw: number; op_krw: number; cash_krw: number; customers: number; walkaways: number; walkaway_share: number; rating: number; regulars: number };
  pnl: { revenue_krw: number; lines: { key: string; item_ko: string; krw: number }[]; op_krw: number };
  month_line?: CafeLine; // lab:cost
  cash: { start_krw: number; op_krw: number; depreciation_addback_krw: number; owner_pay_addback_krw?: number; loan_interest_krw: number; loan_principal_krw: number; vat_refund_krw: number; end_krw: number; rent_card?: CardMonth }; // lab:cost lab:finance
  events: { key: string; label_ko: string; effect_ko: string }[];
  waterfall: { steps: { key: string; label_ko: string; krw: number }[] };
  closure: { closed: boolean; reason_ko: string };
  state_token: string;
};
type Opt = { id: string; label: string; hint: string; downside: string };
type Point = { id: string; clock: string; title: string; prompt: string; note: string; default: string; options: Opt[] };
type Dps = { month: number; events: { key: string; label_ko: string; effect_ko: string }[]; points: Point[] };
type Rec = { lever: Lever; last: string; next: Dec; nextText: string; change: boolean; why: string };
// 고르지 않은 대응을 골랐다면: 같은 달을 그 대응으로 한 번 더 계산한 결과 (고른 뒤에만 계산하고, 저장하지 않는다)
type Alt = { label: string; op: number; opGap: number; revenue: number; customers: number };
type Hist = { token: string; plan: Dec; picked: Record<string, string> }; // 그 달을 시작하기 전 상태
type Row = { hour: number; orders: number; staff: number; need: number; short: boolean };
type View = "intro" | "plan" | "menu" | "scenario" | "settle" | "report" | null; // null = 영업 장면 재생 중, menu = 메뉴판 (lab:menu)

// 규칙으로 만든 추천이다. 지난달 결과의 숫자만 보고, 엔진의 계산을 다시 돌리지는 않는다.
function recommend(last: Month | undefined, plan: Dec): Rec[] {
  const lp: Dec = last ? { ...plan, ...last.decisions, price_change_pct: 0 } : plan;
  const out: Rec[] = [];
  const rec = (key: string, next: Dec, why: string) => {
    const lv = LEVERS.find((l) => l.key === key)!, k = planKey(lv);
    out.push({ lever: lv, last: lv.text(lp), next, nextText: lv.text(next), change: next[k] !== lp[k], why });
  };
  if (!last) { for (const lv of LEVERS) rec(lv.key, plan, ""); return out; }
  const k = last.kpi, walk = k.walkaway_share, op = k.op_krw, pct = Math.round(walk * 100);
  const si = STAFF_ORDER.indexOf(lp.staff_policy), hi = HOURS_ORDER.indexOf(lp.hours);
  if (walk >= 0.1 && si < 2) rec("staff", { ...lp, staff_policy: STAFF_ORDER[si + 1] }, `바쁜 시간에 돌아간 손님이 ${pct}%예요. 직원을 한 단계 늘리면 더 받을 수 있어요.`);
  else if (walk < 0.03 && op < 0 && si > 0 && last.month >= 4) rec("staff", { ...lp, staff_policy: STAFF_ORDER[si - 1] }, `돌아간 손님이 ${pct}%뿐인데 적자예요. 인건비를 한 단계 줄여 보세요.`);
  else rec("staff", lp, `돌아간 손님 ${pct}%. 지금 직원 운영이 맞아요.`);
  if (walk >= 0.12) rec("price", { ...lp, price_change_pct: 5 }, `손님이 몰려 ${pct}%가 돌아갔어요. 가격을 5% 올려도 손님이 남을 만해요.`);
  else rec("price", lp, "바꿀 신호가 없어요. 올리면 손님이 줄고 내리면 객단가가 줄어요.");
  if (op < 0 && hi === 2) rec("hours", { ...lp, hours: "standard" }, "길게 열어도 이익이 나지 않아요. 기본 시간으로 줄이면 일하는 시간(인건비)이 줄어요.");
  else if (op > 0 && hi === 0) rec("hours", { ...lp, hours: "standard" }, "이익이 나요. 기본 시간으로 늘려 더 많은 손님을 받아 보세요.");
  else rec("hours", lp, "지금 영업시간을 유지해도 돼요.");
  if (lp.marketing_krw === 0 && k.regulars < 40 && k.cash_krw > 20_000_000 && walk < 0.1) rec("marketing", { ...lp, marketing_krw: 500_000 }, `단골이 ${Math.round(k.regulars)}명이고 현금에 여유가 있어요. 50만원 마케팅을 써 보세요.`);
  else if (lp.marketing_krw > 0 && walk >= 0.1) rec("marketing", { ...lp, marketing_krw: 0 }, "이미 손님을 다 받지 못해요. 마케팅을 멈춰도 돼요.");
  else rec("marketing", lp, "바꿀 신호가 없어요.");
  rec("dessert", lp, lp.dessert ? "디저트는 객단가를 올려 줘요. 폐기가 크지 않으면 유지하세요." : "디저트를 팔지 않고 있어요. 객단가를 올리고 싶으면 켜 보세요.");
  return LEVERS.map((l) => out.find((r) => r.lever.key === l.key)!);
}

function Kpis({ items }: { items: { label: string; value: string; tone?: string; main?: boolean }[] }) {
  return <dl className="sx-kpis">{items.map((x) => <div key={x.label} className={x.main ? "main" : ""}><dt>{x.label}</dt><dd className={x.tone}>{x.value}</dd></div>)}</dl>;
}
function Stepper({ lv, plan, prev, set }: { lv: Lever; plan: Dec; prev?: Dec; set: (d: Dec) => void }) {
  const k = planKey(lv);
  const changed = lv.key === "price" ? plan.price_change_pct !== 0 : prev != null && prev[k] !== plan[k];
  const id = `cs-${lv.key}`;
  return (
    <div className={`sx-step${changed ? " is-changed" : ""}`}>
      <div className="sx-step-t"><span id={id} className="sx-step-l">{lv.label}</span><small>{lv.hint}</small>{changed && lv.key !== "price" && <small className="sx-step-prev">지난달 {lv.text(prev!)}</small>}</div>
      <div className="sx-step-c">
        <button type="button" aria-label={`${lv.label} 낮추기`} disabled={!lv.can(plan, -1)} onClick={() => set(lv.move(plan, -1))}>−</button>
        <output aria-labelledby={id}>{lv.text(plan)}</output>
        <button type="button" aria-label={`${lv.label} 높이기`} disabled={!lv.can(plan, 1)} onClick={() => set(lv.move(plan, 1))}>+</button>
      </div>
    </div>
  );
}
function Cash({ start, months, total }: { start: number; months: Month[]; total: number }) {
  const pts = [start, ...months.map((m) => m.kpi.cash_krw)];
  const lo = Math.min(0, ...pts), hi = Math.max(1, ...pts), W = 340, H = 120;
  const x = (i: number) => 10 + (i * (W - 20)) / total, y = (v: number) => 8 + ((hi - v) / Math.max(1, hi - lo)) * (H - 22);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="cs-chart" role="img" aria-label="남은 현금">
      <line x1="0" x2={W} y1={y(0)} y2={y(0)} className="cs-zero" />
      <polyline fill="none" className="cs-line" points={pts.map((v, i) => `${x(i)},${y(v)}`).join(" ")} />
      {pts.map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r="3" className={v < 0 ? "cs-dot is-neg" : "cs-dot"} />)}
    </svg>
  );
}

export default function CafeSim({ profile, cfg, onBack }: { profile: Profile; cfg: CafeCfg; onBack: () => void }) {
  const code = profile.dong && profile.dong.gu === profile.gu ? profileOf(profile.gu, profile.dong.name)?.code : undefined;
  const body = useMemo(() => code ? engineBody(profile, cfg, String(code)) : null, [code, cfg, profile.capital]); // eslint-disable-line react-hooks/exhaustive-deps
  const [top, setTop] = useState(108);
  const [start, setStart] = useState<any>(null);
  const [pv, setPv] = useState<Preview | null>(null);
  const [months, setMonths] = useState<Month[]>([]);
  const [token, setToken] = useState("");
  const [startMonth, setStartMonth] = useState(3);
  const [plan, setPlan] = useState<Dec>({ price_change_pct: 0, hours: "standard", staff_policy: "standard", marketing_krw: 0, dessert: true });
  const [view, setView] = useState<View>("intro");
  const [hourIdx, setHourIdx] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [fast, setFast] = useState(false);
  const [chartOpen, setChartOpen] = useState(true);
  const [report, setReport] = useState<any>(null);
  const [pts, setPts] = useState<Point[]>([]);
  const dpTitle = (id: string) => pts.find((p) => p.id === id)?.title ?? id;
  const [dps, setDps] = useState<Dps | null>(null);
  const [alts, setAlts] = useState<Record<string, Alt>>({});
  const [altPick, setAltPick] = useState<Record<string, string>>({});
  const [altBusy, setAltBusy] = useState(false);
  const hist = useRef<Hist[]>([]);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const daily = useRef<number | null>(null);
  // lab:menu  메뉴판: 상권 가격에 맞춘 기본 메뉴 (원가 = 오늘 시세). 카페 엔진은 시즌 시작 때 메뉴를 받아서, 첫 달 전에만 고친다
  const [menuDoc, setMenuDoc] = useState<MenuDoc | null>(null);
  useEffect(() => {
    if (!body) return;
    let alive = true;
    fetchTemplate(ENGINE, "cafe", "domestic", String(body.district)).then((d) => { if (alive) setMenuDoc(d); }).catch(() => alive && setMenuDoc(null));
    return () => { alive = false; };
  }, [body]);

  useLayoutEffect(() => {
    const measure = () => { const n = document.querySelector(".m-mocknote") ?? document.querySelector(".m-top"); setTop(Math.round(n ? n.getBoundingClientRect().bottom : 108)); };
    measure(); addEventListener("resize", measure); return () => removeEventListener("resize", measure);
  }, []);

  const post = async (path: string, b: unknown) => {
    const r = await fetch(`${ENGINE}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
    const j = await r.json();
    if (!r.ok) throw new Error(typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail ?? j));
    return j;
  };
  const netErr = (e: any) => (/fetch/i.test(String(e)) ? "엔진 서버에 연결하지 못했어요. uvicorn api.changeup:app --host 127.0.0.1 --port 8010 으로 켜 주세요." : String(e.message ?? e));

  // 미리보기(배치, 시간대 주문)와 중앙값 기준 손님 수. 엔진의 기본 수요는 업종 평균 × 동네 지수라 앞 화면의 중앙값 기준과 달라서,
  // 기본 수요 대비 '이 동네 보통 카페의 매출' 비율로 손님 수를 정해 엔진에 넘긴다(daily_customers).
  useEffect(() => {
    if (!body) return;
    setErr("");
    post("/cafe/preview", body).then((p0) => {
      const ratio = (guStat(profile.gu).sales * areaFx(cfg.pyeong) * 10000) / p0.rough_month.revenue_krw;
      daily.current = Math.min(600, Math.max(10, Math.round(p0.demand.default_daily_customers * ratio)));
      return post("/cafe/preview", { ...body, daily_customers: daily.current });
    }).then(setPv).catch((e) => setErr(netErr(e)));
  }, [body]); // eslint-disable-line react-hooks/exhaustive-deps

  const sched: Row[] = pv?.staff.schedule ?? [];
  const maxOrders = Math.max(1, ...sched.map((r) => r.orders));
  const last = months[months.length - 1];
  const over = !!last && last.status !== "open";

  // 영업 장면: 하루 시간대를 한 칸씩 지나며 의자가 차고 빈다
  useEffect(() => {
    if (view !== null || !playing || sched.length === 0) return;
    const t = setTimeout(() => {
      if (hourIdx >= sched.length - 1) { setPlaying(false); setView("settle"); } else setHourIdx(hourIdx + 1);
    }, fast ? 250 : 800);
    return () => clearTimeout(t);
  }, [view, playing, fast, hourIdx, sched.length]);

  const begin = () => {
    if (!body || daily.current == null) return;
    setBusy(true); setErr("");
    post("/cafe/season", { ...body, daily_customers: daily.current, start_month: startMonth, menu: menuDoc ? toEngine(menuDoc.items) : undefined, ...cafeFinance() }) // lab:menu lab:finance
      .then((s) => { hist.current = []; setAlts({}); setAltPick({}); setStart(s); setToken(s.state_token); setMonths([]); setReport(null); setPlan({ price_change_pct: 0, hours: s.decisions.hours, staff_policy: s.decisions.staff_policy, marketing_krw: 0, dessert: true }); setView("plan"); })
      .catch((e) => setErr(netErr(e))).finally(() => setBusy(false));
  };
  // 운영 계획을 확정하면 먼저 이번 달 사건과 대응 상황을 받는다
  const askScenario = async () => {
    setBusy(true); setErr("");
    try {
      const d: Dps = await post("/cafe/season/scenario", { state_token: token, ...plan });
      setDps(d); setPts(d.points); setChoices(Object.fromEntries(d.points.map((p) => [p.id, p.default]))); setView("scenario");
    } catch (e: any) { setErr(netErr(e)); }
    setBusy(false);
  };
  const play = async () => {
    setBusy(true); setErr("");
    try {
      const m: Month = await post("/cafe/season/month", { state_token: token, month_index: months.length, ...plan, scenario: choices });
      hist.current[months.length] = { token, plan: { ...plan }, picked: { ...choices } };
      setAlts({}); setAltPick({});
      setMonths([...months, m]); setToken(m.state_token); setPlan({ ...plan, price_change_pct: 0 });
      setHourIdx(0); setPlaying(true); setView(null); setDps(null);
    } catch (e: any) { setErr(netErr(e)); }
    setBusy(false);
  };
  const tryAlt = async (dp: string, opt: string) => {
    const idx = months.length - 1, h = hist.current[idx], now = months[idx];
    if (!h || !now) return;
    const key = `${dp}:${opt}`;
    setAltBusy(true); setErr("");
    try {
      const m: Month = await post("/cafe/season/month", { state_token: h.token, month_index: idx, ...h.plan, scenario: { ...h.picked, [dp]: opt } });
      const label = m.scenario_ko?.find((x) => x.title === dpTitle(dp))?.choice ?? opt;
      setAlts((a) => ({ ...a, [key]: { label, op: m.kpi.op_krw, opGap: m.kpi.op_krw - now.kpi.op_krw, revenue: m.kpi.revenue_krw, customers: m.kpi.customers } }));
    } catch (e: any) { setErr(netErr(e)); }
    setAltBusy(false);
  };
  const toReport = async () => {
    setView("report");
    try { setReport(await post("/cafe/season/report", { state_token: token })); } catch (e: any) { setErr(netErr(e)); }
  };
  const nextAfterSettle = () => (over ? toReport() : setView("plan"));
  const restart = () => { setMonths([]); setStart(null); setReport(null); setView("intro"); setErr(""); };

  if (!body) return (
    <main className="m-area"><section className="m-panel a-card">
      <h1>동네를 먼저 골라 주세요</h1>
      <p>카페 시뮬레이션은 행정동 단위로 돌아가요. 동네 분석에서 지도의 동네를 누르거나 목록에서 고르면 돼요.</p>
      <button type="button" className="a-back" onClick={onBack}>← 열기 전 점검으로</button>
    </section></main>
  );

  const TOTAL: number = start?.months_total ?? 6; // 한 시즌의 달 수 (엔진 season.months)
  const startCash: number = start ? start.start.cash_krw : 0;
  const cur = last;
  const prevPlan = months.length > 1 ? months[months.length - 2].decisions : undefined;
  const occupancy = view === null && sched[hourIdx] ? (sched[hourIdx].orders / maxOrders) * 0.9 : 0;
  const recs = view === "plan" ? recommend(cur, plan) : [];
  const scoreSummary = view === "report" && start && months.length ? cafeSummary(months, start.start, { gu: profile.gu, dong: profile.dong?.name ?? null, pyeong: cfg.pyeong, grade: cfg.grade, staff: cfg.staff }) : null; // lab:score
  const nextMonth: number = cur ? (cur.calendar_month % 12) + 1 : start?.start_month ?? startMonth;
  const place = `${profile.gu} ${profile.dong?.name ?? ""}`;

  return (
    <div className="sx-root" style={{ top }}>
      <div className="sx-canvas">
        {pv ? <CafeRoom3D room={pv.room} layout={pv.layout} roster={view === null ? pv.staff.roster : []} occupancy={occupancy} height="fill" /> : <p className="m-loading">엔진을 부르는 중이에요</p>}
      </div>

      <header className="sx-hud">
        <Metric icon={<IconCash />} label="현금" tip={<>문을 열고 남은 운영자금이에요. 매달 영업이익이 더해지고, 대출 이자와 원금은 빠져요. 개업 비용을 낸 뒤 통장에 남은 돈에서 시작해요.</>}>
          {wman(cur ? cur.kpi.cash_krw : startCash)}
        </Metric>
        <Metric icon={<IconCal />} label="달" tip={<>시작 달부터 {TOTAL}개월을 한 달씩 진행해요.</>}>
          {cur ? `${cur.calendar_month}월 · ${cur.month}/${TOTAL}` : start ? `${start.start_month}월 시작` : `${startMonth}월 시작`}
        </Metric>
        <Metric icon={<IconStar />} label="별점 · 자리잡기"
          tip={<>
            <b>별점</b>은 손님이 남긴 별점(1~5)이에요. 새 가게는 처음엔 낮게 시작하고, 기다리다 돌아간 손님이 많거나 가격을 올리면 내려가요. (가정)<br />
            <b>자리잡기</b>는 자리가 잡힌 카페의 손님 수를 1.00으로 봤을 때의 비율이에요. 새 가게는 0.70에서 시작해 단골이 쌓이면 1.00에 가까워져요. 손님 수에 곱해지는 값이에요. (가정)
          </>}>
          {cur ? `★ ${cur.kpi.rating.toFixed(1)} · ${(cur.drivers?.maturity ?? 0.7).toFixed(2)}` : "리뷰 없음 · 0.70"}
        </Metric>
        <Metric icon={<IconHeart />} label="단골" tip={<>한 달에 다시 오는 손님 수예요. 만족이 높으면 늘고, 마케팅을 하면 더 빨리 늘어요. 새 가게는 0명에서 시작해요. (가정)</>}>
          {cur ? `${Math.round(cur.kpi.regulars)}명` : "0명"}
        </Metric>
        <Metric icon={<IconBattery level={cur?.drivers ? Math.min(100, cur.drivers.peak_util * 100) : 0} />} label="바쁜 시간 혼잡"
          tip={<>가장 바쁜 시간에 들어온 주문이 처리 능력의 몇 %인지예요. 100%를 넘으면 기다리다 돌아가는 손님이 생겨요. 지금 가장 먼저 막히는 곳은 {cur?.drivers?.bottleneck_label_ko ?? "아직 몰라요"}.</>}>
          {cur?.drivers ? `${Math.round(cur.drivers.peak_util * 100)}%` : "-"}
        </Metric>
      </header>

      <button type="button" className="sx-ctoggle" aria-expanded={chartOpen} onClick={() => setChartOpen((v) => !v)}>{chartOpen ? "현금 그래프 접기" : "현금 그래프 펴기"}</button>
      <div className="sx-leftcol">
        {chartOpen && start && (
          <aside className="sx-chartpanel" aria-label="남은 현금 그래프">
            <p className="sx-panel-h"><span>남은 현금</span><b>{wman(cur ? cur.kpi.cash_krw : startCash)}</b></p>
            <Cash start={startCash} months={months} total={TOTAL} />
            <small>빨간 점선은 0원이에요. 점은 한 달이 끝난 때의 현금이에요.</small>
          </aside>
        )}
        {cur && (view === null || view === "settle") && (
          <aside className="sx-planpanel" aria-label={`${cur.calendar_month}월 운영 계획`}>
            <p className="sx-panel-h"><span>{cur.calendar_month}월 운영 계획</span></p>
            <dl>
              {LEVERS.map((lv) => {
                const k = planKey(lv); const d = cur.decisions;
                const changed = lv.key === "price" ? false : prevPlan != null && prevPlan[k] !== d[k];
                return <div key={lv.key} className={changed ? "is-changed" : undefined}><dt>{lv.label}</dt><dd>{lv.key === "price" ? `개업가의 ${Math.round(d.price_level * 100)}%` : lv.text(d)}</dd></div>;
              })}
            </dl>
            {months.length > 1 && <small><i aria-hidden="true" />파란색은 지난달과 달라진 조건이에요.</small>}
          </aside>
        )}
      </div>

      {view === null && cur?.month_line && sched[hourIdx] && (() => { // lab:cost — 하루 손익: 한 달 값을 28일로 나눈 하루, 지난 시간만큼
        const all = sched.reduce((a, r) => a + r.orders, 0) || 1;
        const now = sched.slice(0, hourIdx + 1).reduce((a, r) => a + r.orders, 0);
        const day = prorate(cafeStack(cur.month_line), now / all / 28, (hourIdx + 1) / sched.length / 28);
        return (
          <div className="cst-live cst-float">
            <CostStack compact stack={day} head={<>{cur.calendar_month}월 어느 하루, {sched[hourIdx].hour}시까지</>}
              headValue={<b className={day.op >= 0 ? "pos" : "neg"}>{sgn(day.op)}</b>}
              foot="한 달 값을 28일로 나눈 하루예요. 인건비(사장 가상 급여 포함)·임차료·운영비는 지난 시간만큼 뺐어요." />
          </div>
        );
      })()}
      {view === null && cur && sched[hourIdx] && (
        <div className="sx-bar" role="toolbar" aria-label="재생 조작">
          <button type="button" onClick={() => setPlaying((p) => !p)}>{playing ? "멈춤" : "재생"}</button>
          <button type="button" onClick={() => setFast((f) => !f)} aria-pressed={fast}>빠르게</button>
          <button type="button" onClick={() => { setPlaying(false); setView("settle"); }}>이 달 끝으로</button>
          <span>{cur.calendar_month}월 하루 · {sched[hourIdx].hour}시 · 주문 {Math.round(sched[hourIdx].orders)}건{sched[hourIdx].short ? " · 일손 부족" : ""}</span>
        </div>
      )}

      {view !== null && (
        <div className="sx-modal" role="dialog" aria-modal="true">
          <div className={`sx-pop sx-pop-${view}`}>
            {view === "intro" && (
              <>
                <div className="sx-scroll">
                  <h1>{place}에서 {TOTAL}개월</h1>
                  <Kpis items={[
                    { label: "가게", value: `${cfg.pyeong}평 · ${pv?.seats.total ?? "-"}석` },
                    { label: "평당 월세", value: `${guStat(profile.gu).rent}만원` },
                    { label: "여는 데 드는 돈 (엔진)", value: pv ? wman(pv.capex.total_krw) : "-" },
                    { label: "가진 돈", value: man(profile.capital), main: true },
                  ]} />
                  <section className="sx-sec">
                    <h2>이렇게 진행돼요</h2>
                    <ol className="sx-flow">
                      <li><b>운영 계획</b><span>달마다 가격·영업시간·직원·마케팅·디저트를 정해요.</span></li>
                      <li><b>이달의 사건</b><span>그 달 달력에 맞는 사건이 하나 생겨요. 어떻게 대응할지 골라요.</span></li>
                      <li><b>영업</b><span>엔진이 그달을 계산하고 하루 시간대를 따라 의자가 차고 비는 모습을 보여 줘요.</span></li>
                      <li><b>정산</b><span>매출·비용과 달라진 이유를 확인해요.</span></li>
                    </ol>
                    <p className="sx-note">새로 연 가게로 시작해요. 별점과 단골이 없어서 처음엔 자리가 잡힌 달보다 매출이 낮아요. 매출 기준은 동네 분석의 중앙값과 맞췄어요.</p>
                  </section>
                  <label className="sx-field">시작할 달
                    <select value={startMonth} onChange={(e) => setStartMonth(+e.target.value)}>{Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>{m}월</option>)}</select>
                  </label>
                  {err && <p className="se-err" role="alert">{err}</p>}
                </div>
                <footer className="sx-foot">
                  <button type="button" className="se-btn" onClick={begin} disabled={busy || !pv}>{busy ? "준비하는 중이에요" : "문 열기"}</button>
                  <button type="button" className="se-link" onClick={onBack}>가게 꾸미기로 돌아가기</button>
                </footer>
              </>
            )}

            {view === "plan" && (
              <>
                <div className="sx-scroll">
                  <h1>{nextMonth}월 운영 계획</h1>
                  <div className="sx-split">
                    <section className="sx-left" aria-label="지난달 결과와 추천">
                      <h2>{cur ? `${cur.calendar_month}월 결과와 추천` : "처음 여는 달이에요"}</h2>
                      {cur ? (
                        <Kpis items={[
                          { label: "영업이익", value: sgn(cur.kpi.op_krw), tone: tone(cur.kpi.op_krw), main: true },
                          { label: "매출", value: wman(cur.kpi.revenue_krw) },
                          { label: "손님", value: `${cur.kpi.customers.toLocaleString("ko-KR")}명` },
                          { label: "별점", value: `★ ${cur.kpi.rating.toFixed(1)}` },
                        ]} />
                      ) : <p className="sx-note">자리가 잡힌 달 기준 매출은 {wman(start.baseline.revenue_krw)}, 영업이익은 {sgn(start.baseline.op_krw)}이에요. 새 가게는 이보다 낮게 시작해요. 한 달 뒤부터 결과를 보고 추천해 드려요.</p>}
                      {cur && <p className="sx-note">{cur.owner_note_ko}</p>}
                      <ul className="sx-recs">
                        {recs.map((r) => (
                          <li key={r.lever.key} className={r.change ? "chg" : ""}>
                            <div className="sx-rec-row">
                              <span className="sx-rec-name">{r.lever.label}</span>
                              {cur && <span className={`sx-badge ${r.change ? "chg" : ""}`}>{r.change ? "변경 추천" : "유지"}</span>}
                              <span className="sx-rec-v">{r.last}{r.change ? <> → <b>{r.nextText}</b></> : null}</span>
                            </div>
                            {r.why && <p className="sx-rec-w">{r.why}</p>}
                          </li>
                        ))}
                      </ul>
                      {cur && recs.some((r) => r.change) && (
                        <button type="button" className="sx-ghost" onClick={() => setPlan(recs.reduce((p, r) => (r.change ? { ...p, [planKey(r.lever)]: r.next[planKey(r.lever)] } : p), plan))}>추천대로 적용</button>
                      )}
                    </section>
                    <section className="sx-right" aria-label="이번 달 운영 계획">
                      <h2>{nextMonth}월에 이렇게 할게요</h2>
                      <div className="sx-steps">
                        <MenuSummary doc={menuDoc} onEdit={() => setView("menu")} locked={months.length ? "메뉴판은 첫 달을 시작하기 전에 정해요. 가격은 아래 가격 조정으로 바꿔요" : undefined} />{/* lab:menu */}
                        {LEVERS.map((lv) => <Stepper key={lv.key} lv={lv} plan={plan} prev={cur ? { ...plan, ...cur.decisions, price_change_pct: 0 } : undefined} set={setPlan} />)}
                      </div>
                      <p className="sx-note">가격은 이번 달에 한 번 바꾸는 폭이고, 나머지는 바꾸기 전까지 이어져요.</p>
                    </section>
                  </div>
                  {err && <p className="se-err" role="alert">{err}</p>}
                </div>
                <footer className="sx-foot">
                  <button type="button" className="se-btn" onClick={askScenario} disabled={busy}>{busy ? "엔진이 계산 중이에요" : `${nextMonth}월 시작`}</button>
                </footer>
              </>
            )}

            {view === "menu" && menuDoc && body && ( // lab:menu  첫 달 전이라 고친 메뉴로 시즌을 새로 시작한다 (같은 시드)
              <MenuEditor api={ENGINE} industry="cafe" grade="domestic" district={String(body.district)} doc={menuDoc}
                onCancel={() => setView("plan")} note="카페는 첫 달 전에 메뉴판을 정해요. 시즌 중에는 가격 조정으로 바꿔요."
                onSave={(d) => {
                  setMenuDoc(d); setBusy(true); setErr("");
                  post("/cafe/season", { ...body, daily_customers: daily.current, start_month: startMonth, menu: toEngine(d.items) })
                    .then((s) => { setStart(s); setToken(s.state_token); setView("plan"); })
                    .catch((e) => { setErr(netErr(e)); setView("plan"); }).finally(() => setBusy(false));
                }} />
            )}

            {view === "scenario" && dps && (
              <>
                <div className="sx-scroll">
                  <h1>{nextMonth}월에 생길 일</h1>
                  {dps.events.length > 0 && (
                    <section className="sx-evbox">
                      <h2>이번 달 사건</h2>
                      <ul>{dps.events.map((e) => <li key={e.key}><b>{e.label_ko}</b><span>{e.effect_ko}</span></li>)}</ul>
                    </section>
                  )}
                  <section className="sx-sec">
                    <h2>어떻게 대응할까요?</h2>
                    <p className="sx-note">고른 대응대로 그달 계산에 반영돼요. 처음에는 기본 대응이 골라져 있어요. 대응의 효과 크기는 가정값이에요.</p>
                  </section>
                  <div className="sx-dps">
                    {dps.points.map((dp) => (
                      <div key={dp.id} className="sx-dp" role="radiogroup" aria-labelledby={`${dp.id}-h`}
                        style={{ gridRow: `span ${2 + Math.max(...dps.points.map((x) => x.options.length))}` }}>
                        <header className="sx-dp-h"><span className="sx-clock">{dp.clock}</span><h3 id={`${dp.id}-h`}>{dp.title}</h3></header>
                        <div className="sx-dp-q">
                          <p>{dp.prompt}</p>
                          <small>{dp.note}. 효과 크기는 가정이에요.</small>
                        </div>
                        <div className="sx-dp-opts">
                          {dp.options.map((o) => (
                            <label key={o.id} className={choices[dp.id] === o.id ? "on" : ""}>
                              <input type="radio" name={dp.id} checked={choices[dp.id] === o.id} onChange={() => setChoices({ ...choices, [dp.id]: o.id })} />
                              <span className="sx-opt">
                                <span className="sx-opt-h"><b>{o.label}</b>{o.id === dp.default && <span className="sx-chip">기본</span>}</span>
                                <span className="sx-pro">{o.hint}</span>
                                <span className="sx-con">{o.downside}</span>
                              </span>
                            </label>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                  {err && <p className="se-err" role="alert">{err}</p>}
                </div>
                <footer className="sx-foot">
                  <button type="button" className="se-btn" onClick={play} disabled={busy}>{busy ? "엔진이 계산 중이에요" : `${nextMonth}월 영업 시작`}</button>
                  <button type="button" className="se-link" disabled={busy} onClick={() => setView("plan")}>운영 계획으로 돌아가기</button>
                </footer>
              </>
            )}

            {view === "settle" && cur && (
              <>
                <div className="sx-scroll">
                  <h1>{cur.calendar_month}월 정산</h1>
                  <Kpis items={[
                    { label: "영업이익", value: sgn(cur.kpi.op_krw), tone: tone(cur.kpi.op_krw), main: true },
                    { label: "매출", value: wman(cur.kpi.revenue_krw) },
                    { label: "월말 현금", value: wman(cur.kpi.cash_krw) },
                    { label: "돌아간 손님", value: `${cur.kpi.walkaways.toLocaleString("ko-KR")}명 (${Math.round(cur.kpi.walkaway_share * 100)}%)` },
                  ]} />
                  <p className="sx-note">{cur.owner_note_ko}</p>
                  {flowRatioNote(code ? String(code) : undefined, profile.gu, cur.kpi.customers) && <p className="sx-note">{flowRatioNote(code ? String(code) : undefined, profile.gu, cur.kpi.customers)}</p>}
                  {pts.length > 0 && hist.current[months.length - 1] && (
                    <section className="sx-sec">
                      <h2>내 선택의 결과</h2>
                      <p className="sx-note">고른 대응은 이번 달 손익의 &quot;이번 달 대응&quot; 줄에 들어 있어요. 다른 대응을 골랐다면 어땠을지는 같은 달을 그 대응으로 다시 계산한 값이에요.</p>
                      <div className="sx-dres-grid">
                        {pts.map((dp) => {
                          const chosen = hist.current[months.length - 1].picked[dp.id] ?? dp.default;
                          const pick = altPick[dp.id], alt = pick ? alts[`${dp.id}:${pick}`] : undefined;
                          return (
                            <article key={dp.id} className="sx-dres">
                              <header><span className="sx-clock">{dp.clock}</span><h3>{dp.title}</h3></header>
                              <p className="sx-dres-vs">내 선택: <b>{dp.options.find((o) => o.id === chosen)?.label}</b>{chosen === dp.default ? " (기본 대응)" : ""}</p>
                              <div className="sx-alt">
                                <p className="sx-alt-h">다른 대응을 골랐다면</p>
                                <div className="sx-alt-btns">
                                  {dp.options.filter((o) => o.id !== chosen).map((o) => (
                                    <button key={o.id} type="button" className={pick === o.id ? "on" : ""} disabled={altBusy}
                                      onClick={() => { setAltPick({ ...altPick, [dp.id]: o.id }); if (!alts[`${dp.id}:${o.id}`]) tryAlt(dp.id, o.id); }}>{o.label}</button>
                                  ))}
                                </div>
                                {pick && !alt && <p className="sx-note">{altBusy ? "그 대응으로 이달을 다시 계산하는 중이에요…" : "계산하지 못했어요."}</p>}
                                {alt && (
                                  <div className="sx-alt-res">
                                    <p>“<b>{alt.label}</b>” 대응을 골랐다면 이 달은 이렇게 됐을 거예요.</p>
                                    <dl className="sx-dres-nums">
                                      <div><dt>매출</dt><dd>{wman(alt.revenue)}</dd></div>
                                      <div><dt>손님</dt><dd>{alt.customers.toLocaleString("ko-KR")}명</dd></div>
                                      <div className="main"><dt>이달 영업이익<Q>효과 크기는 가정값이에요.</Q></dt><dd className={tone(alt.op)}>{sgn(alt.op)}</dd></div>
                                    </dl>
                                    <p className="sx-dres-vs">지금 선택보다 이달 영업이익 <b className={tone(alt.opGap)}>{sgn(alt.opGap)}</b></p>
                                  </div>
                                )}
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    </section>
                  )}
                  {cur.events.length > 0 && <p className="sx-note"><b>이달의 사건:</b> {cur.events.map((e) => `${e.label_ko} (${e.effect_ko})`).join(", ")}</p>}
                  <div className="sx-split">
                    <section className="sx-sec"><h2>손익</h2>
                      {cur.month_line ? ( // lab:cost — 비용 쌓기: 인건비는 알바와 사장 가상 급여, 매장 운영비는 내역까지
                        <CostStack className="cst-settle" stack={cafeStack(cur.month_line)}
                          head={<>매출 (손님 {Math.round(cur.kpi.customers).toLocaleString("ko-KR")}명, 객단가 {Math.round(cur.kpi.revenue_krw / Math.max(1, cur.kpi.customers)).toLocaleString("ko-KR")}원)</>}
                          foot={VAT_NOTE} />
                      ) : (
                      <table className="sx-table"><tbody>
                        <tr><th>매출</th><td>{wman(cur.pnl.revenue_krw)}</td></tr>
                        {cur.pnl.lines.filter((l) => l.krw !== 0).map((l) => <tr key={l.key}><th>{l.item_ko}</th><td>{l.krw < 0 ? "+" : "−"}{wman(Math.abs(l.krw))}</td></tr>)}
                        <tr><th>영업이익</th><td className={tone(cur.pnl.op_krw)}>{sgn(cur.pnl.op_krw)}</td></tr>
                      </tbody></table>
                      )}
                    </section>
                    <section className="sx-sec"><h2>지난달과 달라진 이유</h2>
                      <ul className="sx-wf">{cur.waterfall.steps.filter((s) => Math.abs(s.krw) >= 10000).map((s) => <li key={s.key}><span>{s.label_ko}</span><b className={tone(s.krw)}>{sgn(s.krw)}</b></li>)}</ul>
                      <p className="sx-note">현금 변화: 영업이익 {sgn(cur.cash.op_krw)}, 감가상각 되돌림 +{wman(cur.cash.depreciation_addback_krw)},{cur.cash.owner_pay_addback_krw ? ` 사장 가상 급여 되돌림 +${wman(cur.cash.owner_pay_addback_krw)},` : ""} 대출 이자 −{wman(cur.cash.loan_interest_krw)}, 원금 −{wman(cur.cash.loan_principal_krw)}{cur.cash.vat_refund_krw ? `, 부가세 환급 +${wman(cur.cash.vat_refund_krw)}` : ""}{cur.cash.rent_card ? `, 월세 카드 할부 ${cur.cash.rent_card.cash_delta >= 0 ? "+" : "−"}${wman(Math.abs(cur.cash.rent_card.cash_delta))}` : ""}.</p>
                      <CardMonthLine rc={cur.cash.rent_card} />{/* lab:finance */}
                    </section>
                  </div>
                  {cur.closure.closed && <p className="se-err">가게를 닫았어요. {cur.closure.reason_ko}</p>}
                </div>
                <footer className="sx-foot">
                  <button type="button" className="se-btn" onClick={nextAfterSettle}>{over ? "전체 결과 보기" : `${nextMonth}월 운영 계획 정하기`}</button>
                </footer>
              </>
            )}

            {view === "report" && (
              <>
                <div className="sx-scroll">
                  {scoreSummary && <ScoreCard summary={scoreSummary} />}{/* lab:score */}
                  {scoreSummary && <RecordAttempt summary={scoreSummary} extra={{ capital_man: profile.capital }} />}{/* lab:modes */}
                  <h1>{months.length}개월 결과</h1>
                  {!report ? <p>계산 중이에요.</p> : (
                    <>
                      <Kpis items={[
                        { label: "마지막 현금", value: wman(report.end_cash_krw), main: true },
                        { label: "누적 영업이익", value: sgn(report.cumulative_op_krw), tone: tone(report.cumulative_op_krw) },
                        { label: "가장 좋았던 달", value: `${report.best_month.calendar_month}월 ${sgn(report.best_month.op_krw)}` },
                        { label: "가장 나빴던 달", value: `${report.worst_month.calendar_month}월 ${sgn(report.worst_month.op_krw)}` },
                      ]} />
                      <p className="sx-note">{report.survived ? `${TOTAL}개월을 버텼어요. ` : <b>가게를 닫게 됐어요. </b>}{report.summary_ko}</p>
                      <CardSeasonLine items={months.map((m) => m.cash.rent_card)} />{/* lab:finance */}
                      <section className="sx-sec"><h2>남은 현금</h2><Cash start={startCash} months={months} total={TOTAL} /></section>
                      <section className="sx-sec"><h2>월별</h2>
                        <table className="sx-table"><thead><tr><th>달</th><th>매출</th><th>영업이익</th><th>월말 현금</th></tr></thead>
                          <tbody>{report.months.map((x: any) => <tr key={x.month}><td>{x.calendar_month}월</td><td>{wman(x.revenue_krw)}</td><td className={tone(x.op_krw)}>{sgn(x.op_krw)}</td><td>{wman(x.cash_krw)}</td></tr>)}</tbody></table>
                      </section>
                    </>
                  )}
                  {err && <p className="se-err" role="alert">{err}</p>}
                </div>
                <footer className="sx-foot">
                  <button type="button" className="se-btn" onClick={restart}>처음부터 다시</button>
                  <button type="button" className="se-link" onClick={onBack}>가게 꾸미기로</button>
                  <small>엔진은 카페 월별 모델이에요. 별점·단골·사건 크기는 가정값이에요.</small>
                </footer>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
