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
import Assume from "./Assume";
import ModeSwitch, { type Mode } from "./ModeSwitch";
import QuickPicks, { type Pick as QPick } from "./QuickPicks";
import Insight, { type Try } from "./Insight";
import CashFlow, { type CfMonth } from "./CashFlow";
import { CAFE_REF, cafeBand } from "./priceCompare";
import { IconBattery, IconCal, IconCash, IconHeart, IconStar, Metric, Q } from "./SimulateEngine";
import "./simulate-engine.css";
import "./cafe-sim.css";

const wman = (krw: number) => man(krw / 10000);
const sgn = (krw: number) => `${krw >= 0 ? "+" : "−"}${man(Math.abs(krw / 10000))}`;
const tone = (v: number) => (v < 0 ? "neg" : "pos");

type Hours = "short" | "standard" | "long";
type Staff = "lean" | "standard" | "generous";
// hard 모드 메뉴·판촉 (엔진 sim/cafe/season.py MENU_DEFAULT와 같은 키)
type CafeMenu = { bean: "standard" | "specialty"; seasonal: boolean; dessert_price_pct: number; takeout_disc: number; loyalty: boolean; delivery_share: number | null; free_dlvy_krw: number };
const MENU0: CafeMenu = { bean: "standard", seasonal: false, dessert_price_pct: 0, takeout_disc: 0, loyalty: false, delivery_share: null, free_dlvy_krw: 0 };
type Dec = { price_change_pct: number; hours: Hours; staff_policy: Staff; marketing_krw: number; dessert: boolean; delivery: boolean; open_hour?: number; close_hour?: number; menu?: CafeMenu };
const HOUR_PRESET: Record<Hours, [number, number]> = { short: [11, 20], standard: [10, 22], long: [8, 23] };
// 엔진에 보낼 계획: easy 모드나 프리셋과 같은 시각이면 직접 정한 시각을 빼고 보낸다 (프리셋 영업시간이 그대로 먹게)
const toEngine = (d: Dec, mode: "easy" | "hard"): Dec => {
  const pre = HOUR_PRESET[d.hours];
  if (mode === "easy" || d.open_hour == null || d.close_hour == null || (d.open_hour === pre[0] && d.close_hour === pre[1])) {
    const { open_hour: _o, close_hour: _c, ...rest } = d; void _o; void _c; return rest;
  }
  return d;
};
const clockKo = (h: number) => (h < 12 ? `오전 ${h}시` : h === 12 ? "낮 12시" : h === 24 ? "밤 12시" : `${h < 18 ? "오후" : "밤"} ${h - 12}시`);
const HOURS_KO: Record<Hours, string> = { short: "짧게 (11~20시)", standard: "기본 (10~22시)", long: "길게 (8~23시)" };
const STAFF_KO: Record<Staff, string> = { lean: "빠듯하게", standard: "기본", generous: "넉넉하게" };
const HOURS_ORDER: Hours[] = ["short", "standard", "long"], STAFF_ORDER: Staff[] = ["lean", "standard", "generous"];

type Lever = { key: string; label: string; hint: string; text: (d: Dec) => string; can: (d: Dec, s: -1 | 1) => boolean; move: (d: Dec, s: -1 | 1) => Dec };
const LEVERS: Lever[] = [
  { key: "price", label: "가격 조정", hint: "이번 달에 메뉴 가격을 한 번 바꿔요. 올리면 손님이 줄고 객단가가 늘어요.",
    text: (d) => (d.price_change_pct === 0 ? "그대로" : `${d.price_change_pct > 0 ? "+" : ""}${d.price_change_pct}%`),
    can: (d, s) => d.price_change_pct + s * 5 >= -20 && d.price_change_pct + s * 5 <= 30, move: (d, s) => ({ ...d, price_change_pct: d.price_change_pct + s * 5 }) },
  { key: "hours", label: "영업시간", hint: "길게 열면 손님을 더 받지만 일하는 시간(인건비)이 늘어요.",
    text: (d) => (d.open_hour != null && d.close_hour != null ? `${clockKo(d.open_hour)}~${clockKo(d.close_hour)}` : HOURS_KO[d.hours]), can: (d, s) => HOURS_ORDER.indexOf(d.hours) + s >= 0 && HOURS_ORDER.indexOf(d.hours) + s < 3,
    move: (d, s) => ({ ...d, hours: HOURS_ORDER[HOURS_ORDER.indexOf(d.hours) + s] }) },
  { key: "staff", label: "직원 운영", hint: "빠듯하면 인건비가 줄지만 바쁜 시간에 손님이 돌아가요.",
    text: (d) => STAFF_KO[d.staff_policy], can: (d, s) => STAFF_ORDER.indexOf(d.staff_policy) + s >= 0 && STAFF_ORDER.indexOf(d.staff_policy) + s < 3,
    move: (d, s) => ({ ...d, staff_policy: STAFF_ORDER[STAFF_ORDER.indexOf(d.staff_policy) + s] }) },
  { key: "marketing", label: "마케팅", hint: "한 달 광고·SNS 비용이에요. 늘리면 알려지는 데 도움이 돼요.",
    text: (d) => (d.marketing_krw ? `월 ${wman(d.marketing_krw)}` : "없음"), can: (d, s) => d.marketing_krw + s * 500_000 >= 0 && d.marketing_krw + s * 500_000 <= 5_000_000,
    move: (d, s) => ({ ...d, marketing_krw: d.marketing_krw + s * 500_000 }) },
  { key: "dessert", label: "디저트", hint: "디저트를 팔면 객단가가 늘지만 폐기와 준비 시간이 생겨요.",
    text: (d) => (d.dessert ? "판매" : "안 팔아요"), can: (d, s) => (s > 0 ? !d.dessert : d.dessert), move: (d, s) => ({ ...d, dessert: s > 0 }) },
  { key: "delivery", label: "배달", hint: "배달앱에 들어가면 주문이 늘지만(배달하는 카페는 주문의 25%가 배달) 한 건마다 배달앱 258원·대행 1,147원·포장재가 빠져요 (외식업체 경영실태조사).",
    text: (d) => (d.delivery ? "배달앱 입점" : "안 해요"), can: (d, s) => (s > 0 ? !d.delivery : d.delivery), move: (d, s) => ({ ...d, delivery: s > 0 }) },
];
const planKey = (l: Lever): keyof Dec => (l.key === "price" ? "price_change_pct" : l.key === "hours" ? "hours" : l.key === "staff" ? "staff_policy" : l.key === "marketing" ? "marketing_krw" : l.key === "delivery" ? "delivery" : "dessert");

type Month = {
  month: number; calendar_month: number; status: "open" | "closed" | "finished"; owner_note_ko: string;
  decisions: Dec & { price_level: number; scenario?: Record<string, string> }; scenario_ko?: { title: string; choice: string }[];
  drivers?: { maturity: number; peak_util: number; bottleneck_label_ko: string };
  kpi: { revenue_krw: number; op_krw: number; cash_krw: number; customers: number; walkaways: number; walkaway_share: number; rating: number; regulars: number };
  pnl: { revenue_krw: number; lines: { key: string; item_ko: string; krw: number }[]; op_krw: number };
  cash: { start_krw: number; op_krw: number; depreciation_addback_krw: number; loan_interest_krw: number; loan_principal_krw: number; vat_refund_krw: number; end_krw: number };
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
type View = "intro" | "plan" | "scenario" | "settle" | "report" | null; // null = 영업 장면 재생 중

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
  // 배달: 손님이 돌아갈 만큼 바쁘면 배달을 끄라고, 한가하고 적자면 켜 보라고 (건당 수수료가 커서 남는 돈이 적다)
  if (lp.delivery && walk >= 0.12) rec("delivery", { ...lp, delivery: false }, `매장 손님도 ${pct}%가 돌아갈 만큼 바빠요. 배달을 끄면 한 건에 1,400원쯤 빠지는 수수료를 아껴요.`);
  else if (!lp.delivery && walk < 0.05 && op < 0) rec("delivery", { ...lp, delivery: true }, "매장이 한가하고 적자예요. 배달앱에 들어가면 주문은 늘지만 한 건마다 수수료가 빠져요.");
  else rec("delivery", lp, lp.delivery ? "배달 수수료가 정산표에 따로 나와요. 남는 돈보다 크면 꺼 보세요." : "배달은 안 하고 있어요. 한가한 달에 켜 볼 만해요.");
  return LEVERS.map((l) => out.find((r) => r.lever.key === l.key)!);
}

// easy 모드: 달마다 방향 세 가지. 지난달 결정에서 출발해 추천/늘리기/아끼기로 몇 가지를 바꾼다
type StratId = "rec" | "grow" | "save";
function cafeStrategies(last: Month | undefined, plan: Dec, recs: Rec[]): { id: StratId; title: string; desc: string; plan: Dec; changes: string[] }[] {
  const lp: Dec = last ? { ...plan, ...last.decisions, price_change_pct: 0 } : { ...plan, price_change_pct: 0 };
  const hi = HOURS_ORDER.indexOf(lp.hours), si = STAFF_ORDER.indexOf(lp.staff_policy);
  const rec = recs.reduce((p, r) => (r.change ? { ...p, [planKey(r.lever)]: r.next[planKey(r.lever)] } : p), lp);
  const grow: Dec = { ...lp, hours: HOURS_ORDER[Math.min(2, hi + 1)], staff_policy: STAFF_ORDER[Math.max(1, si)], marketing_krw: Math.min(2_000_000, lp.marketing_krw + 500_000), dessert: true };
  const save: Dec = { ...lp, hours: HOURS_ORDER[Math.max(0, hi - 1)], staff_policy: STAFF_ORDER[Math.max(0, si - 1)], marketing_krw: 0 };
  const diff = (d: Dec) => LEVERS.filter((l) => l.text(d) !== l.text(lp)).map((l) => l.label + " " + l.text(d));
  return [
    { id: "rec", title: "추천대로", desc: last ? "지난달 결과를 보고 고칠 것만 고쳐요." : "처음 달은 기본 운영으로 시작해요.", plan: rec, changes: diff(rec) },
    { id: "grow", title: "손님 늘리기", desc: "더 오래 열고 마케팅을 늘려요. 인건비와 광고비가 늘어요.", plan: grow, changes: diff(grow) },
    { id: "save", title: "비용 아끼기", desc: "영업시간과 직원을 한 단계 줄이고 마케팅을 멈춰요. 바쁜 시간에 손님이 돌아갈 수 있어요.", plan: save, changes: diff(save) },
  ];
}
const PICKS: QPick<Dec>[] = [
  { key: "price_change_pct", label: "가격", hint: "이번 달 한 번 바꾸는 폭", opts: [{ label: "−5%", value: -5 }, { label: "그대로", value: 0 }, { label: "+5%", value: 5 }] },
  { key: "hours", label: "영업시간", hint: "길수록 손님·인건비가 같이 늘어요", opts: HOURS_ORDER.map((h) => ({ label: HOURS_KO[h].split(" ")[0], value: h })) },
  { key: "staff_policy", label: "직원", hint: "빠듯하면 인건비가 줄고, 바쁜 시간에 손님이 돌아가요", opts: STAFF_ORDER.map((x) => ({ label: STAFF_KO[x], value: x })) },
  { key: "dessert", label: "디저트", hint: "객단가가 오르지만 폐기와 준비 시간이 생겨요", opts: [{ label: "팔아요", value: true }, { label: "안 팔아요", value: false }] },
  { key: "delivery", label: "배달", hint: "주문은 늘지만 한 건마다 수수료", opts: [{ label: "안 해요", value: false }, { label: "배달앱 입점", value: true }] },
];

function Kpis({ items }: { items: { label: string; value: string; tone?: string; main?: boolean }[] }) {
  return <dl className="sx-kpis">{items.map((x) => <div key={x.label} className={x.main ? "main" : ""}><dt>{x.label}</dt><dd className={x.tone}>{x.value}</dd></div>)}</dl>;
}
// hard 모드: 영업 시각을 한 시간 단위로, 원두·시즌 음료·디저트 가격·포장 할인·스탬프·배달 비중·무료배달
function CafeHard({ plan, set }: { plan: Dec; set: (d: Dec) => void }) {
  const mn = { ...MENU0, ...(plan.menu ?? {}) };
  const [o, c] = plan.open_hour != null && plan.close_hour != null ? [plan.open_hour, plan.close_hour] : HOUR_PRESET[plan.hours];
  const um = (x: Partial<CafeMenu>) => set({ ...plan, menu: { ...mn, ...x } });
  const hrs = (no: number, nc: number) => set({ ...plan, open_hour: no, close_hour: nc });
  const row = (label: string, hint: string, text: string, dn: (() => void) | null, upf: (() => void) | null, changed = false) => (
    <div className={`sx-step${changed ? " is-changed" : ""}`} key={label}>
      <div className="sx-step-t"><span className="sx-step-l">{label}</span><small>{hint}</small></div>
      <div className="sx-step-c">
        <button type="button" aria-label={`${label} 낮추기`} disabled={!dn} onClick={() => dn?.()}>−</button>
        <output>{text}</output>
        <button type="button" aria-label={`${label} 높이기`} disabled={!upf} onClick={() => upf?.()}>+</button>
      </div>
    </div>
  );
  const dsh = mn.delivery_share ?? 0.25;
  return (
    <>
      <h3 className="sx-sub">영업 시각 <Assume what="영업 시각: 상권의 시간대별 손님 비중만큼 손님이 늘고 줄어요. 문을 닫은 시간 손님의 일부는 연 시간으로 옮겨 와요" src="서울시 상권분석서비스 시간대 매출 비중 (엔진 step 2)" f="손님 배수 = 연 시간대 비중 합 ÷ 기본(10~22시) 비중 합" need="이 가게 자리의 시간대별 유동인구·카드 매출" /></h3>
      <div className="sx-steps">
        {row("여는 시각", "일찍 열면 출근길 손님을 받지만 인건비와 전기료가 늘어요", clockKo(o), o > 6 ? () => hrs(o - 1, c) : null, c - o > 4 ? () => hrs(o + 1, c) : null)}
        {row("닫는 시각", "늦게 닫으면 저녁 손님을 더 받지만 손님이 적은 시간에도 인건비가 나가요", clockKo(c), c - o > 4 ? () => hrs(o, c - 1) : null, c < 24 ? () => hrs(o, c + 1) : null)}
      </div>
      <h3 className="sx-sub">메뉴와 판촉 <Assume what="원두·시즌 음료·디저트 가격·포장 할인·스탬프·배달 비중의 효과 크기" src="research/cafe/params.yaml season (모두 가정)" f="스페셜티: 음료 원가 ×1.15, 손님 +4% / 시즌 음료: 손님 +5%, 객단가 +3%, 월 30만원 / 디저트: 사는 비율 × 가격^−1.5 / 포장 할인 d: 포장 손님 × (1 + 2d) / 스탬프: 손님 +4%, 매출 −3% / 배달 비중: (고른 비중 ÷ 25%)^0.6" need="이 가게 POS의 메뉴별 판매량과 판촉 전후 비교" /></h3>
      <div className="sx-steps">
        {row("원두", "스페셜티로 바꾸면 원가가 오르지만 맛을 찾는 손님이 늘어요", mn.bean === "specialty" ? "스페셜티" : "일반", mn.bean === "specialty" ? () => um({ bean: "standard" }) : null, mn.bean === "standard" ? () => um({ bean: "specialty" }) : null)}
        {row("시즌 음료", "딸기 라떼처럼 그 달만 파는 음료. 손님과 객단가가 늘고 개발·재료비가 들어요", mn.seasonal ? "내요" : "안 내요", mn.seasonal ? () => um({ seasonal: false }) : null, !mn.seasonal ? () => um({ seasonal: true }) : null)}
        {plan.dessert && row("디저트 가격", "올리면 한 개 값이 늘지만 같이 사는 손님이 줄어요", mn.dessert_price_pct ? `${mn.dessert_price_pct > 0 ? "+" : ""}${mn.dessert_price_pct}%` : "처음 가격", mn.dessert_price_pct > -30 ? () => um({ dessert_price_pct: mn.dessert_price_pct - 10 }) : null, mn.dessert_price_pct < 50 ? () => um({ dessert_price_pct: mn.dessert_price_pct + 10 }) : null)}
        {row("포장 할인", "테이크아웃 손님에게 깎아 주면 포장 손님이 늘어요 (자리가 모자랄 때 좋아요)", mn.takeout_disc ? `${Math.round(mn.takeout_disc * 100)}%` : "없음", mn.takeout_disc > 0 ? () => um({ takeout_disc: +(mn.takeout_disc - 0.05).toFixed(2) }) : null, mn.takeout_disc < 0.3 ? () => um({ takeout_disc: +(mn.takeout_disc + 0.05).toFixed(2) }) : null)}
        {row("스탬프 적립", "10잔에 1잔 무료. 단골이 늘지만 공짜로 나가는 잔이 생겨요", mn.loyalty ? "해요" : "안 해요", mn.loyalty ? () => um({ loyalty: false }) : null, !mn.loyalty ? () => um({ loyalty: true }) : null)}
        {plan.delivery && row("배달 비중", "전체 주문 중 배달 몫. 키울수록 배달은 덜 늘고 한 건마다 수수료가 빠져요", `${Math.round(dsh * 100)}%`, dsh > 0.05 ? () => um({ delivery_share: +(dsh - 0.05).toFixed(2) }) : null, dsh < 0.6 ? () => um({ delivery_share: +(dsh + 0.05).toFixed(2) }) : null)}
        {plan.delivery && row("무료배달 부담", "가게가 배달비를 대신 내면 배달 주문이 늘어요 (1,000원당 +8%)", mn.free_dlvy_krw ? `건당 ${mn.free_dlvy_krw.toLocaleString("ko-KR")}원` : "안 해요", mn.free_dlvy_krw > 0 ? () => um({ free_dlvy_krw: mn.free_dlvy_krw - 1000 }) : null, mn.free_dlvy_krw < 3000 ? () => um({ free_dlvy_krw: mn.free_dlvy_krw + 1000 }) : null)}
      </div>
    </>
  );
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
  const [plan, setPlan] = useState<Dec>({ price_change_pct: 0, hours: "standard", staff_policy: "standard", marketing_krw: 0, dessert: true, delivery: false });
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
  const [mode, setMode] = useState<Mode>("easy");
  const [strat, setStrat] = useState<StratId>("rec");
  const [tweak, setTweak] = useState<Partial<Dec>>({});
  const [ins, setIns] = useState<{ idx: number; tries: Try<Partial<Dec>>[] } | null>(null);
  useEffect(() => { setStrat("rec"); setTweak({}); }, [months.length]);
  // 현금흐름표·영수증 (원). 엔진 현금 = 월초 + 감가상각 전 영업이익 − 이자 − 원금 + 개업 부가세 환급
  const cfMonths: CfMonth[] = months.map((m) => {
    const L = (k: string) => m.pnl.lines.find((l) => l.key === k)?.krw ?? 0;
    return { month: m.calendar_month, start: m.cash.start_krw, end: m.cash.end_krw, lines: [
      { label: "매출", amount: m.pnl.revenue_krw },
      ...m.pnl.lines.filter((l) => l.krw).map((l) => ({ label: l.item_ko, amount: -l.krw })),
      { label: "대출 이자", amount: -m.cash.loan_interest_krw }, { label: "대출 원금", amount: -m.cash.loan_principal_krw },
      { label: "개업 부가세 환급", amount: m.cash.vat_refund_krw },
    ], tax: { revenue: m.pnl.revenue_krw, farmBuy: L("food") * 0.3, profit: m.pnl.op_krw - m.cash.loan_interest_krw,
      taxableBuy: L("rent") + L("utilities") + L("packaging") + L("delivery") + L("shares") + L("food") * 0.7 } };
  });
  const daily = useRef<number | null>(null);

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
    post("/cafe/season", { ...body, daily_customers: daily.current, start_month: startMonth })
      .then((s) => { hist.current = []; setAlts({}); setAltPick({}); setStart(s); setToken(s.state_token); setMonths([]); setReport(null); setPlan({ price_change_pct: 0, hours: s.decisions.hours, staff_policy: s.decisions.staff_policy, marketing_krw: 0, dessert: true, delivery: false }); setView("plan"); })
      .catch((e) => setErr(netErr(e))).finally(() => setBusy(false));
  };
  // 운영 계획을 확정하면 먼저 이번 달 사건과 대응 상황을 받는다
  const askScenario = async () => {
    setBusy(true); setErr("");
    try {
      const p = mode === "easy" ? { ...cafeStrategies(cur, plan, recs).find((x) => x.id === strat)!.plan, ...tweak } : plan;
      if (mode === "easy") setPlan(p);
      const d: Dps = await post("/cafe/season/scenario", { state_token: token, ...p });
      setDps(d); setPts(d.points); setChoices(Object.fromEntries(d.points.map((p) => [p.id, p.default]))); setView("scenario");
    } catch (e: any) { setErr(netErr(e)); }
    setBusy(false);
  };
  const play = async () => {
    setBusy(true); setErr("");
    try {
      const m: Month = await post("/cafe/season/month", { state_token: token, month_index: months.length, ...toEngine(plan, mode), scenario: choices });
      hist.current[months.length] = { token, plan: { ...plan }, picked: { ...choices } };
      setAlts({}); setAltPick({});
      setMonths([...months, m]); setToken(m.state_token); setPlan({ ...plan, price_change_pct: 0 });
      setHourIdx(0); setPlaying(true); setView(null); setDps(null);
    } catch (e: any) { setErr(netErr(e)); }
    setBusy(false);
  };
  useEffect(() => {
    const idx = months.length - 1, h = hist.current[idx], now = months[idx];
    if (view !== "settle" || !h || !now || ins?.idx === idx) return;
    const d = { ...h.plan };
    const mn = { ...MENU0, ...(d.menu ?? {}) };
    const si = STAFF_ORDER.indexOf(d.staff_policy), hi = HOURS_ORDER.indexOf(d.hours);
    const cands: Omit<Try<Partial<Dec>>, "d">[] = [
      { title: "가격 5% 올리기", why: "한 잔 값이 늘어요. 손님은 조금 줄어요.", patch: { price_change_pct: 5 } },
      { title: "가격 5% 내리기", why: "손님이 늘어요. 한 잔에 남는 돈은 줄어요.", patch: { price_change_pct: -5 } },
      ...(si < 2 ? [{ title: `직원 ${STAFF_KO[STAFF_ORDER[si + 1]]}`, why: now.kpi.walkaway_share > 0.05 ? `바빠서 손님 ${Math.round(now.kpi.walkaway_share * 100)}%가 돌아갔어요.` : "바쁜 시간에 손님을 덜 놓쳐요.", patch: { staff_policy: STAFF_ORDER[si + 1] } }] : []),
      ...(si > 0 ? [{ title: `직원 ${STAFF_KO[STAFF_ORDER[si - 1]]}`, why: "인건비를 아껴요.", patch: { staff_policy: STAFF_ORDER[si - 1] } }] : []),
      ...(hi < 2 ? [{ title: `영업시간 ${HOURS_KO[HOURS_ORDER[hi + 1]]}`, why: "더 오래 열어 손님을 더 받아요.", patch: { hours: HOURS_ORDER[hi + 1], open_hour: undefined, close_hour: undefined } }] : []),
      ...(hi > 0 ? [{ title: `영업시간 ${HOURS_KO[HOURS_ORDER[hi - 1]]}`, why: "손님이 적은 시간의 인건비·전기료를 아껴요.", patch: { hours: HOURS_ORDER[hi - 1], open_hour: undefined, close_hour: undefined } }] : []),
      { title: d.delivery ? "배달 그만하기" : "배달앱 입점", why: d.delivery ? "한 건마다 빠지는 수수료를 아껴요." : "매장 밖 주문을 받아요. 수수료가 빠져요.", patch: { delivery: !d.delivery } },
      { title: d.dessert ? "디저트 빼기" : "디저트 팔기", why: d.dessert ? "폐기와 준비 시간이 줄어요." : "객단가가 올라요.", patch: { dessert: !d.dessert } },
      ...(d.marketing_krw < 2_000_000 ? [{ title: `마케팅 ${(d.marketing_krw + 500_000) / 1e4}만원`, why: "알려지면 손님이 늘어요.", patch: { marketing_krw: d.marketing_krw + 500_000 } }] : []),
      ...(mode === "hard" ? [
        { title: mn.seasonal ? "시즌 음료 그만" : "시즌 음료 내기", why: mn.seasonal ? "개발·재료비를 아껴요." : "손님과 객단가가 늘어요.", patch: { menu: { ...mn, seasonal: !mn.seasonal } } },
        { title: mn.loyalty ? "스탬프 적립 그만" : "스탬프 적립", why: mn.loyalty ? "공짜 잔이 줄어요." : "단골이 늘어요.", patch: { menu: { ...mn, loyalty: !mn.loyalty } } },
      ] : []),
    ];
    let live = true;
    (async () => {
      const out: Try<Partial<Dec>>[] = [];
      for (const c of cands) {
        try {
          const m: Month = await post("/cafe/season/month", { state_token: h.token, month_index: idx, ...toEngine({ ...d, ...c.patch, price_change_pct: (d.price_change_pct || 0) + (c.patch.price_change_pct || 0) } as Dec, mode), scenario: h.picked });
          out.push({ ...c, d: (m.kpi.op_krw - now.kpi.op_krw) / 1e4 });
        } catch { /* 한 가지가 실패해도 나머지는 보여 준다 */ }
      }
      if (live) setIns({ idx, tries: out.filter((x) => x.d >= 3).sort((a, b) => b.d - a.d) });
    })();
    return () => { live = false; };
  }, [view, months.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const tryAlt = async (dp: string, opt: string) => {
    const idx = months.length - 1, h = hist.current[idx], now = months[idx];
    if (!h || !now) return;
    const key = `${dp}:${opt}`;
    setAltBusy(true); setErr("");
    try {
      const m: Month = await post("/cafe/season/month", { state_token: h.token, month_index: idx, ...toEngine(h.plan, mode), scenario: { ...h.picked, [dp]: opt } });
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
                  <h1>{place}에서 {TOTAL}개월<ModeSwitch mode={mode} set={setMode} /></h1>
                  <p className="sx-note sx-modenote">{mode === "easy" ? <><b>easy 모드</b> · 달마다 방향만 골라요: 추천대로 / 손님 늘리기 / 비용 아끼기. 가격·영업시간·배달은 버튼으로 바꿀 수 있어요.</> : <><b>hard 모드</b> · 달마다 가격·영업시간·직원·마케팅·디저트·배달을 하나씩 정해요.</>}</p>
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
                  <h1>{nextMonth}월 운영 계획<ModeSwitch mode={mode} set={setMode} /></h1>
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
                      {(() => {
                        // 개업 때 커피 가격 = 조사 중앙값 4,000원. 가격 조정은 이 값에 누적 배수로 붙는다
                        const level = (cur?.decisions.price_level ?? 1) * (1 + plan.price_change_pct / 100);
                        const b = cafeBand(Math.round((CAFE_REF.mid * level) / 100) * 100);
                        return <p className="sx-note sx-price">가격 비교 <span className={`sx-badge ${b.tone}`}>{b.band}</span> {b.text}{plan.price_change_pct ? " (이번 달 조정 포함)" : ""}<Assume id="priceRef" what={`비교 기준: ${CAFE_REF.src}. 개업 가격을 중앙값 4,000원으로 봤어요. 동네 단위 메뉴 가격 자료는 없어요`} /></p>;
                      })()}
                    </section>
                    {mode === "easy" ? (() => {
                      const strats = cafeStrategies(cur, plan, recs);
                      return (
                        <section className="sx-right" aria-label="이번 달 방향">
                          <h2>{nextMonth}월, 어느 쪽으로 갈까요?</h2>
                          <div className="sx-strats" role="radiogroup">
                            {strats.map((x) => (
                              <label key={x.id} className={strat === x.id ? "on" : ""}>
                                <input type="radio" name="cf-strat" checked={strat === x.id} onChange={() => setStrat(x.id)} />
                                <span className="sx-strat"><b>{x.title}</b><small>{x.desc}</small><span className="sx-strat-chg">{x.changes.length ? x.changes.join(" · ") : "지난달과 같아요"}</span></span>
                              </label>
                            ))}
                          </div>
                          <QuickPicks picks={PICKS} base={strats.find((x) => x.id === strat)!.plan} tweak={tweak} setTweak={setTweak} />
                          <p className="sx-note">hard 모드에서는 가격·영업시간·직원·마케팅·디저트·배달을 하나씩 정할 수 있어요.</p>
                        </section>
                      );
                    })() : (
                    <section className="sx-right" aria-label="이번 달 운영 계획">
                      <h2>{nextMonth}월에 이렇게 할게요</h2>
                      <div className="sx-steps">{LEVERS.filter((lv) => lv.key !== "hours").map((lv) => <Stepper key={lv.key} lv={lv} plan={plan} prev={cur ? { ...plan, ...cur.decisions, price_change_pct: 0 } : undefined} set={setPlan} />)}</div>
                      <CafeHard plan={plan} set={setPlan} />
                      <p className="sx-note">가격은 이번 달에 한 번 바꾸는 폭이고, 나머지는 바꾸기 전까지 이어져요.</p>
                    </section>
                    )}
                  </div>
                  {err && <p className="se-err" role="alert">{err}</p>}
                </div>
                <footer className="sx-foot">
                  <button type="button" className="se-btn" onClick={askScenario} disabled={busy}>{busy ? "엔진이 계산 중이에요" : `${nextMonth}월 시작`}</button>
                </footer>
              </>
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
                  {ins?.idx === months.length - 1 ? (
                    <Insight tries={ins.tries} last={over} onApply={(patch) => {
                      const { price_change_pct, ...rest } = patch;
                      if (mode === "easy") setTweak({ ...rest, ...(price_change_pct ? { price_change_pct } : {}) });
                      else setPlan({ ...plan, ...rest, price_change_pct: price_change_pct ?? 0 });
                      nextAfterSettle();
                    }} />
                  ) : <section className="ins"><h2>다음 달에 이렇게 바꿔 보세요</h2><p className="ins-sub">같은 달을 계획 한 가지씩 바꿔 엔진으로 다시 계산하고 있어요…</p></section>}
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
                      <table className="sx-table"><tbody>
                        <tr><th>매출</th><td>{wman(cur.pnl.revenue_krw)}</td></tr>
                        {cur.pnl.lines.filter((l) => l.krw !== 0).map((l) => <tr key={l.key}><th>{l.item_ko}</th><td>{l.krw < 0 ? "+" : "−"}{wman(Math.abs(l.krw))}</td></tr>)}
                        <tr><th>영업이익</th><td className={tone(cur.pnl.op_krw)}>{sgn(cur.pnl.op_krw)}</td></tr>
                      </tbody></table>
                    </section>
                    <section className="sx-sec"><h2>지난달과 달라진 이유</h2>
                      <ul className="sx-wf">{cur.waterfall.steps.filter((s) => Math.abs(s.krw) >= 10000).map((s) => <li key={s.key}><span>{s.label_ko}</span><b className={tone(s.krw)}>{sgn(s.krw)}</b></li>)}</ul>
                      <p className="sx-note">현금 변화: 영업이익 {sgn(cur.cash.op_krw)}, 감가상각 되돌림 +{wman(cur.cash.depreciation_addback_krw)}, 대출 이자 −{wman(cur.cash.loan_interest_krw)}, 원금 −{wman(cur.cash.loan_principal_krw)}{cur.cash.vat_refund_krw ? `, 부가세 환급 +${wman(cur.cash.vat_refund_krw)}` : ""}.</p>
                    </section>
                  </div>
                  {cur.closure.closed && <p className="se-err">가게를 닫았어요. {cur.closure.reason_ko}</p>}
                  <CashFlow months={cfMonths} kind="food" shop="카페" />
                </div>
                <footer className="sx-foot">
                  <button type="button" className="se-btn" onClick={nextAfterSettle}>{over ? "전체 결과 보기" : `${nextMonth}월 운영 계획 정하기`}</button>
                </footer>
              </>
            )}

            {view === "report" && (
              <>
                <div className="sx-scroll">
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
                      <section className="sx-sec"><h2>남은 현금</h2><Cash start={startCash} months={months} total={TOTAL} /></section>
                      <CashFlow months={cfMonths} kind="food" shop="카페" />
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
