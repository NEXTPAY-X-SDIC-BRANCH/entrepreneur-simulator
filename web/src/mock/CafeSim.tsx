// 카페 시뮬레이션 (4단계). 고깃집 시뮬레이션(SimulateEngine.tsx)과 같은 구조: 전체 화면 3D 위에 지표 줄, 왼쪽 현금 그래프와 운영 계획,
// 아래 재생 바, 시작·운영 계획·정산·결과는 팝업. 엔진은 카페 월별 모델(sim/cafe, 포트 8010 /cafe/season)이다.
// 엔진은 손님 한 명씩이 아니라 시간대별 주문·처리 능력을 계산하므로, 영업 장면은 하루 시간대를 따라 의자가 차고 비는 모습으로 보여 준다.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { PEEK_BACK, useSimChrome } from "../lab/ui/peek"; // lab:peek
import { cafeDong } from "./cafe";
import { flowRatioNote } from "./DongFlow";
import { cafeDaily, cafeOpenFromEngine, engineBody, type CafeCfg, type EngineCapex, type EngineFunding } from "./cafeChecks";
import CafeRoom3D from "./CafeRoom3D";
import { ENGINE, type Preview } from "./useCafePreview";
import { guStat, man, type Profile } from "./model";
import Assume from "./Assume";
import { ModeTag, type Mode } from "./ModeSwitch";
import QuickPicks, { type Pick as QPick } from "./QuickPicks";
import Insight, { type Try } from "./Insight";
import CashFlow, { type CfMonth } from "./CashFlow";
import CostBar from "./CostBar";
import ChannelCards from "./ChannelCards";
import { CAFE_REF, cafeBand } from "./priceCompare";
import { IconBattery, IconCal, IconCash, IconHeart, IconStar, Metric, Q } from "./SimulateEngine";
import CardMonthLine, { CardSeasonLine, type CardMonth } from "../lab/finance/CardMonthLine"; // lab:finance
import { cafeFinance } from "../lab/finance/finance"; // lab:finance
import "./simulate-engine.css";
import "./cafe-sim.css";
import CostStack from "../lab/cost/CostStack"; // lab:cost
import { VAT_NOTE, cafeStack, prorate, type CafeLine } from "../lab/cost/stackModel"; // lab:cost
import MenuEditor, { MenuSummary } from "../lab/menu/MenuEditor"; // lab:menu
import { fetchTemplate, toEngine as menuToEngine, type MenuDoc } from "../lab/menu/api"; // lab:menu (toEngine 이름은 upstream 계획 변환이 쓴다)
import ScoreCard from "../lab/score/ScoreCard"; // lab:score
import { cafeSummary } from "../lab/score/summary"; // lab:score
import RecordAttempt from "../lab/modes/RecordAttempt"; // lab:modes 하드 모드 판 기록 (다시 해보기 비교)
import { paybackOf, setEngineCtx } from "./chatContext";

const wman = (krw: number) => man(krw / 10000);
const sgn = (krw: number) => `${krw >= 0 ? "+" : "−"}${man(Math.abs(krw / 10000))}`;
const tone = (v: number) => (v < 0 ? "neg" : "pos");

type Hours = "short" | "standard" | "long";
type Staff = "lean" | "standard" | "generous";
// hard 모드 메뉴·판촉 (엔진 sim/cafe/season.py MENU_DEFAULT와 같은 키)
type CafeMenu = { bean: "standard" | "specialty"; seasonal: boolean; dessert_price_pct: number; takeout_disc: number; loyalty: boolean; delivery_share: number | null; free_dlvy_krw: number; min_order_krw?: number };
const MENU0: CafeMenu = { bean: "standard", seasonal: false, dessert_price_pct: 0, takeout_disc: 0, loyalty: false, delivery_share: null, free_dlvy_krw: 0, min_order_krw: 12000 };
// 음료 가격을 원으로 보여 주기: 개업 때 아메리카노 = 조사 중앙값 4,000원, 지난달까지 바꾼 가격 배수(CUP_LEVEL)에 이번 달 조정을 곱한다
let CUP_LEVEL = 1;
const cupWon = (pct: number) => Math.round((4000 * CUP_LEVEL * (1 + pct / 100)) / 50) * 50;
const cupKo = (pct: number) => `${cupWon(pct).toLocaleString("ko-KR")}원`;
type Dec = { price_change_pct: number; hours: Hours; staff_policy: Staff; marketing_krw: number; dessert: boolean; delivery: boolean; open_hour?: number; close_hour?: number; menu?: CafeMenu; staff_max?: number };
const HOUR_PRESET: Record<Hours, [number, number]> = { short: [11, 20], standard: [10, 22], long: [8, 23] };
// 엔진에 보낼 계획: easy 모드나 프리셋과 같은 시각이면 직접 정한 시각을 빼고 보낸다 (프리셋 영업시간이 그대로 먹게)
const toEngine = (d: Dec, mode: "easy" | "hard"): Dec => {
  const pre = HOUR_PRESET[d.hours];
  void mode;
  if (d.open_hour == null || d.close_hour == null || (d.open_hour === pre[0] && d.close_hour === pre[1])) {
    const { open_hour: _o, close_hour: _c, ...rest } = d; void _o; void _c; return rest;
  }
  return d;
};
const clockKo = (h: number) => (h < 12 ? `오전 ${h}시` : h === 12 ? "낮 12시" : h === 24 ? "밤 12시" : `${h < 18 ? "오후" : "밤"} ${h - 12}시`);
const HOURS_KO: Record<Hours, string> = { short: "짧게 (11~20시)", standard: "기본 (10~22시)", long: "길게 (8~23시)" };
const HOURS_ORDER: Hours[] = ["short", "standard", "long"];
// 바쁜 시간에 함께 일하는 사람 수 (사장님 포함). 엔진 staff_max, 한가한 시간은 일의 양만큼만 쓴다
const STAFF_MIN = 1, STAFF_MAX = 8, STAFF0 = 3;
const staffN = (d: Dec) => d.staff_max ?? STAFF0;
const staffKo = (n: number) => (n <= 1 ? "사장님 혼자" : `사장님 + 직원 ${n - 1}명`);

type Lever = { key: string; label: string; hint: string; text: (d: Dec) => string; can: (d: Dec, s: -1 | 1) => boolean; move: (d: Dec, s: -1 | 1) => Dec };
const LEVERS: Lever[] = [
  { key: "price", label: "음료 가격 (아메리카노)", hint: "한 잔 값을 정해요. 다른 메뉴도 같은 비율로 바뀌어요. 올리면 손님이 줄고 한 잔에 남는 돈이 늘어요.",
    text: (d) => (d.price_change_pct === 0 ? `${cupKo(0)} 그대로` : `${cupKo(d.price_change_pct)} (${d.price_change_pct > 0 ? "+" : ""}${d.price_change_pct}%)`),
    can: (d, s) => d.price_change_pct + s * 5 >= -20 && d.price_change_pct + s * 5 <= 30, move: (d, s) => ({ ...d, price_change_pct: d.price_change_pct + s * 5 }) },
  { key: "hours", label: "영업시간", hint: "길게 열면 손님을 더 받지만 일하는 시간(인건비)이 늘어요.",
    text: (d) => (d.open_hour != null && d.close_hour != null ? `${clockKo(d.open_hour)}~${clockKo(d.close_hour)}` : HOURS_KO[d.hours]), can: (d, s) => HOURS_ORDER.indexOf(d.hours) + s >= 0 && HOURS_ORDER.indexOf(d.hours) + s < 3,
    move: (d, s) => ({ ...d, hours: HOURS_ORDER[HOURS_ORDER.indexOf(d.hours) + s] }) },
  { key: "staff", label: "바쁜 시간 인원", hint: "가장 바쁜 시간에 함께 일하는 사람 수예요 (사장님 포함). 한가한 시간엔 필요한 만큼만 써요. 적으면 인건비가 줄지만 줄이 길어져 손님이 돌아가요.",
    text: (d) => staffKo(staffN(d)), can: (d, s) => staffN(d) + s >= STAFF_MIN && staffN(d) + s <= STAFF_MAX,
    move: (d, s) => ({ ...d, staff_max: staffN(d) + s }) },
  { key: "marketing", label: "마케팅", hint: "한 달 광고·SNS 비용이에요. 늘리면 알려지는 데 도움이 돼요.",
    text: (d) => (d.marketing_krw ? `월 ${wman(d.marketing_krw)}` : "없음"), can: (d, s) => d.marketing_krw + s * 500_000 >= 0 && d.marketing_krw + s * 500_000 <= 5_000_000,
    move: (d, s) => ({ ...d, marketing_krw: d.marketing_krw + s * 500_000 }) },
  { key: "dessert", label: "디저트", hint: "디저트를 팔면 객단가가 늘지만 폐기와 준비 시간이 생겨요.",
    text: (d) => (d.dessert ? "판매" : "안 팔아요"), can: (d, s) => (s > 0 ? !d.dessert : d.dessert), move: (d, s) => ({ ...d, dessert: s > 0 }) },
  { key: "delivery", label: "배달", hint: "배달앱에 들어가면 주문이 늘지만(배달하는 카페는 주문의 25%가 배달) 한 건마다 배달앱 258원·대행 1,147원·포장재가 빠져요 (외식업체 경영실태조사).",
    text: (d) => (d.delivery ? "배달앱 입점" : "안 해요"), can: (d, s) => (s > 0 ? !d.delivery : d.delivery), move: (d, s) => ({ ...d, delivery: s > 0 }) },
];
const planKey = (l: Lever): keyof Dec => (l.key === "price" ? "price_change_pct" : l.key === "hours" ? "hours" : l.key === "staff" ? "staff_max" : l.key === "marketing" ? "marketing_krw" : l.key === "delivery" ? "delivery" : "dessert");

type Month = {
  month: number; calendar_month: number; status: "open" | "closed" | "finished"; owner_note_ko: string;
  decisions: Dec & { price_level: number; scenario?: Record<string, string> }; scenario_ko?: { title: string; choice: string }[];
  drivers?: { maturity: number; peak_util: number; bottleneck_label_ko: string };
  kpi: { revenue_krw: number; op_krw: number; cash_krw: number; customers: number; walkaways: number; walkaway_share: number; rating: number; regulars: number; loan_payment_krw?: number };
  channels?: { dine: number; takeout: number; delivery: number };
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
  const sn = staffN(lp), hi = HOURS_ORDER.indexOf(lp.hours);
  if (walk >= 0.1 && sn < STAFF_MAX) rec("staff", { ...lp, staff_max: sn + 1 }, `바쁜 시간에 돌아간 손님이 ${pct}%예요. 한 명 더 두면 더 받을 수 있어요.`);
  else if (walk < 0.03 && op < 0 && sn > STAFF_MIN && last.month >= 4) rec("staff", { ...lp, staff_max: sn - 1 }, `돌아간 손님이 ${pct}%뿐인데 적자예요. 한 명 줄여 인건비를 아껴 보세요.`);
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
export function cafeStrategies(last: Month | undefined, plan: Dec, recs: Rec[]): { id: StratId; title: string; desc: string; plan: Dec; changes: string[] }[] {
  const lp: Dec = last ? { ...plan, ...last.decisions, price_change_pct: 0 } : { ...plan, price_change_pct: 0 };
  const hi = HOURS_ORDER.indexOf(lp.hours), sn = staffN(lp);
  const rec = recs.reduce((p, r) => (r.change ? { ...p, [planKey(r.lever)]: r.next[planKey(r.lever)] } : p), lp);
  const grow: Dec = { ...lp, hours: HOURS_ORDER[Math.min(2, hi + 1)], staff_max: Math.max(sn, STAFF0), marketing_krw: Math.min(2_000_000, lp.marketing_krw + 500_000), dessert: true };
  const save: Dec = { ...lp, hours: HOURS_ORDER[Math.max(0, hi - 1)], staff_max: Math.max(STAFF_MIN, sn - 1), marketing_krw: 0 };
  const diff = (d: Dec) => LEVERS.filter((l) => l.text(d) !== l.text(lp)).map((l) => l.label + " " + l.text(d));
  return [
    { id: "rec", title: "추천대로", desc: last ? "지난달 결과를 보고 고칠 것만 고쳐요." : "처음 달은 기본 운영으로 시작해요.", plan: rec, changes: diff(rec) },
    { id: "grow", title: "손님 늘리기", desc: "더 오래 열고 마케팅을 늘려요. 인건비와 광고비가 늘어요.", plan: grow, changes: diff(grow) },
    { id: "save", title: "비용 아끼기", desc: "영업시간과 직원을 한 단계 줄이고 마케팅을 멈춰요. 바쁜 시간에 손님이 돌아갈 수 있어요.", plan: save, changes: diff(save) },
  ];
}
const PICKS: QPick<Dec>[] = [
  { key: "price_change_pct", label: "아메리카노 한 잔", hint: "다른 메뉴도 같은 비율로 바뀌어요", opts: [-10, -5, 0, 5, 10].map((v) => ({ label: v === 0 ? "그대로" : `${v > 0 ? "+" : ""}${v}%`, value: v })) },
  { key: "open_hour", label: "몇 시에 열까요?", hint: "일찍 열면 출근길 손님을 받지만 인건비·전기료가 늘어요", opts: Array.from({ length: 9 }, (_, i) => 6 + i).map((h) => ({ label: clockKo(h), value: h })) },
  { key: "close_hour", label: "몇 시에 닫을까요?", hint: "늦게 닫으면 저녁 손님을 더 받지만 손님이 적은 시간에도 인건비가 나가요", opts: Array.from({ length: 7 }, (_, i) => 18 + i).map((h) => ({ label: clockKo(h), value: h })) },
  { key: "staff_max", label: "바쁜 시간 몇 명이 일할까요?", hint: "사장님 포함. 적으면 인건비가 줄고, 바쁜 시간에 손님이 돌아가요", opts: Array.from({ length: STAFF_MAX }, (_, i) => i + 1).map((n) => ({ label: `${n}명`, value: n })) },
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
        {plan.delivery && row("배달 최소주문금액", "올리면 주문은 줄지만 한 건이 커져 건당 수수료 부담이 줄어요 (기준 12,000원, 가정)", `${(mn.min_order_krw ?? 12000).toLocaleString("ko-KR")}원`, (mn.min_order_krw ?? 12000) > 6000 ? () => um({ min_order_krw: (mn.min_order_krw ?? 12000) - 1000 }) : null, (mn.min_order_krw ?? 12000) < 25000 ? () => um({ min_order_krw: (mn.min_order_krw ?? 12000) + 1000 }) : null)}
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

export default function CafeSim({ profile, cfg, onBack, onArea }: { profile: Profile; cfg: CafeCfg; onBack: () => void; onArea?: () => void }) {
  const dongPick = cafeDong(profile), code = dongPick?.code; // lab:merge 수빈: 동네를 안 골랐으면 그 구의 대표 동네로 돌린다
  const body = useMemo(() => code ? engineBody(profile, cfg, String(code)) : null, [code, cfg, profile.capital]); // eslint-disable-line react-hooks/exhaustive-deps
  const [top, setTop] = useState(108);
  const [start, setStart] = useState<any>(null);
  const [pv, setPv] = useState<(Preview & { capex: EngineCapex; funding?: EngineFunding }) | null>(null);
  const [months, setMonths] = useState<Month[]>([]);
  const [token, setToken] = useState("");
  const [startMonth, setStartMonth] = useState(3);
  const [plan, setPlan] = useState<Dec>({ price_change_pct: 0, hours: "standard", staff_policy: "standard", marketing_krw: 0, dessert: true, delivery: false });
  const [view, setView] = useState<View>("intro");
  const { peek, setPeek, planOpen, setPlanOpen } = useSimChrome(view); // lab:peek 팝업 내려 두고 가게 보기, 운영 계획 판 접기
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
  // lab:merge 이지/하드는 시작 화면(ModePick)에서 고르고, 카페 시뮬레이션 화면은 하드 모드다. upstream easy 화면(QuickPicks)은 남겨 두지만 쓰지 않는다
  const mode = "hard" as Mode;
  const [, setStrat] = useState<StratId>("rec");
  const [tweak, setTweak] = useState<Partial<Dec>>({});
  const [receipt, setReceipt] = useState(true);
  const receiptEnd = useRef<HTMLDivElement>(null);
  useEffect(() => { receiptEnd.current?.scrollIntoView({ block: "end" }); }, [months.length, receipt]);
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
      daily.current = cafeDaily(p0, profile.gu, cfg.pyeong); // 가게 꾸미기(CafeBuild)와 이지 모드(sim/easy.py cafe_daily)와 같은 식
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
    post("/cafe/season", { ...body, daily_customers: daily.current, start_month: startMonth, menu: menuDoc ? menuToEngine(menuDoc.items) : undefined, ...cafeFinance() }) // lab:menu lab:finance
      .then((s) => { hist.current = []; setAlts({}); setAltPick({}); setStart(s); setToken(s.state_token); setMonths([]); setReport(null); setPlan({ price_change_pct: 0, hours: s.decisions.hours, staff_policy: "standard", staff_max: Math.min(STAFF_MAX, Math.max(STAFF_MIN, s.crew_peak ?? STAFF0)), marketing_krw: 0, dessert: true, delivery: false, open_hour: HOUR_PRESET[s.decisions.hours as Hours][0], close_hour: HOUR_PRESET[s.decisions.hours as Hours][1] }); setView("plan"); })
      .catch((e) => setErr(netErr(e))).finally(() => setBusy(false));
  };
  // 운영 계획을 확정하면 먼저 이번 달 사건과 대응 상황을 받는다
  const askScenario = async () => {
    setBusy(true); setErr("");
    try {
      const p = mode === "easy" ? { ...plan, ...tweak } : plan;
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
    const sn = staffN(d), hi = HOURS_ORDER.indexOf(d.hours);
    const cands: Omit<Try<Partial<Dec>>, "d">[] = [
      { title: "가격 5% 올리기", why: "한 잔 값이 늘어요. 손님은 조금 줄어요.", patch: { price_change_pct: 5 } },
      { title: "가격 5% 내리기", why: "손님이 늘어요. 한 잔에 남는 돈은 줄어요.", patch: { price_change_pct: -5 } },
      ...(sn < STAFF_MAX ? [{ title: `바쁜 시간 ${sn + 1}명`, why: now.kpi.walkaway_share > 0.05 ? `바빠서 손님 ${Math.round(now.kpi.walkaway_share * 100)}%가 돌아갔어요.` : "바쁜 시간에 손님을 덜 놓쳐요.", patch: { staff_max: sn + 1 } }] : []),
      ...(sn > STAFF_MIN ? [{ title: `바쁜 시간 ${sn - 1}명`, why: "인건비를 아껴요.", patch: { staff_max: sn - 1 } }] : []),
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

  // 챗봇이 "몇 달째부터 남아요?", "하루 몇 명 받아야 본전이에요?", "여는 데 돈이 제일 많이 드는 곳은?"에 이 판의 결과로 답하게 넘긴다 (원).
  // 여는 돈은 엔진 값(권리금·부가세 선납 포함, cafeOpenFromEngine). 손익 줄을 고깃집과 같은 칸으로 나눈다: 재료·포장·폐기는 cogs,
  // 카드수수료와 매출 비례 소모품·기본 마케팅은 fees, 나머지(사장 가상 급여, 전기·관리비, 추가 마케팅, 대응 비용, 수리)는 mgmt.
  // 카페 엔진은 사장 가상 급여를 손익에 넣으므로(lab:cost) 손익분기에 따로 더하지 않고, 회수는 영업이익에서 이자만 뺀다.
  useEffect(() => {
    const f = pv?.funding ? cafeOpenFromEngine(pv.capex, pv.funding) : null;
    const opening = f ? { total: f.total, lines: f.lines.map((l) => ({ label: l.label, amount: l.amount })) } : undefined;
    const ownerLine = (m?: Month) => m?.pnl.lines.find((l) => l.key === "owner")?.krw ?? 0;
    const ow = ownerLine(months[0]);
    const owner_note = ow ? `사장 가상 급여 월 ${Math.round(ow / 1e4).toLocaleString("ko-KR")}만원 포함` : "사장 가상 급여 포함";
    if (!months.length) { setEngineCtx(opening ? { start_month: startMonth, months: [], closed: false, finished: false, cash_now: f ? f.cash * 1e4 : 0, opening, owner_note } : null); return; }
    const sum = (m: Month, keys: string[]) => m.pnl.lines.filter((l) => keys.includes(l.key)).reduce((a, l) => a + l.krw, 0);
    const rows = months.map((m) => {
      const cogs = sum(m, ["food", "packaging", "dessert_waste", "delivery"]), fees = sum(m, ["card", "shares"]), labor = sum(m, ["labor"]), rent = sum(m, ["rent"]);
      return { month: m.calendar_month, revenue: m.pnl.revenue_krw, cogs, fees, labor, rent, mgmt: m.pnl.revenue_krw - cogs - fees - labor - rent - m.pnl.op_krw,
        covers: m.kpi.customers, op: m.pnl.op_krw, open_days: new Date(2026, m.calendar_month, 0).getDate(), cash_end: m.kpi.cash_krw };
    });
    const total = start?.months_total ?? 6;
    const spent = f ? f.sunk * 1e4 : 0; // 보증금과 돌려받는 부가세 선납을 뺀 쓴 돈
    const cashStart: number = start ? start.start.cash_krw : 0;
    setEngineCtx({
      start_month: months[0].calendar_month, months: rows, closed: last.closure.closed, finished: over || months.length >= total, cash_now: last.kpi.cash_krw,
      payback: paybackOf(spent, months.map((m) => m.pnl.op_krw - m.cash.loan_interest_krw)), spent,
      end_cash: last.kpi.cash_krw, lowest_cash: Math.min(cashStart, ...months.map((m) => m.kpi.cash_krw)), owner_note, ...(opening ? { opening } : {}),
    });
  }, [months, pv, start]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => setEngineCtx(null), []);

  if (!body) return (
    <main className="m-area"><section className="m-panel a-card">
      <h1>동네 자료를 불러오는 중이에요</h1>
      <p>{profile.gu}의 동네 자료가 아직 없어요. 동네 분석 화면을 한 번 열었다가 다시 와 주세요.</p>
      <div className="sx-dongbtns">
        {onArea && <button type="button" className="se-btn" onClick={onArea}>동네 분석 열기</button>}
        <button type="button" className="a-back" onClick={onBack}>가게 꾸미기로 돌아가기</button>
      </div>
    </section></main>
  );

  const TOTAL: number = start?.months_total ?? 6; // 한 시즌의 달 수 (엔진 season.months)
  // 문을 열기 전에도 엔진이 계산한 '문 열 때 현금'(가진 돈 + 대출 − 여는 비용)을 보여 준다. 0만원으로 두면 돈이 없는 것처럼 보였다
  const fund = pv?.funding ? cafeOpenFromEngine(pv.capex, pv.funding) : null;
  const startCash: number = start ? start.start.cash_krw : fund ? fund.cash * 10000 : 0;
  const cur = last;
  CUP_LEVEL = cur?.decisions.price_level ?? 1; // 음료 가격 원 표시용
  const prevPlan = months.length > 1 ? months[months.length - 2].decisions : undefined;
  const occupancy = view === null && sched[hourIdx] ? (sched[hourIdx].orders / maxOrders) * 0.9 : 0;
  const recs = view === "plan" ? recommend(cur, plan) : [];
  const scoreSummary = view === "report" && start && months.length ? cafeSummary(months, start.start, { gu: profile.gu, dong: profile.dong?.name ?? null, pyeong: cfg.pyeong, grade: cfg.grade, staff: cfg.staff,
    // lab:standing 상위 % 와 놓친 것 계산에 쓰는 값: 가진 돈, 마지막 달 운영, 처음보다 바뀐 가격
    capital_man: profile.capital, hours: months.at(-1)!.decisions.hours, marketing_krw: months.at(-1)!.decisions.marketing_krw,
    dessert: months.at(-1)!.decisions.dessert, delivery: months.at(-1)!.decisions.delivery,
    price_change_pct: Math.round(((months.at(-1)!.decisions.price_level ?? 1) - 1) * 100) }) : null; // lab:score
  const nextMonth: number = cur ? (cur.calendar_month % 12) + 1 : start?.start_month ?? startMonth;
  const place = dongPick?.scope === "dong" ? `${profile.gu} ${dongPick.name}` : `${profile.gu} (대표 동네 ${dongPick?.name ?? ""})`;

  return (
    <div className="sx-root" style={{ top }}>
      <div className="sx-canvas">
        {pv ? <CafeRoom3D moves={cfg.moves} shape={cfg.shape} room={pv.room} layout={pv.layout} roster={view === null ? pv.staff.roster : []} occupancy={occupancy} height="fill" /> : <p className="m-loading">엔진을 부르는 중이에요</p>}
      </div>

      <header className="sx-hud">
        <Metric icon={<IconCash />} label="현금" tip={<>문을 열고 남은 운영자금이에요. 매달 영업이익이 더해지고, 대출 이자와 원금은 빠져요. 개업 비용을 낸 뒤 통장에 남은 돈에서 시작해요.</>}>
          {cur || start || fund ? wman(cur ? cur.kpi.cash_krw : startCash) : "-"}
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

      <button type="button" className="sx-rtoggle" aria-expanded={receipt} onClick={() => setReceipt((v) => !v)}>{receipt ? "현금 흐름 기록 접기" : "현금 흐름 기록 펴기"}</button>
      {receipt && (
        <aside className="sx-receipt" aria-label="현금 흐름 기록">
          <div className="sx-paper">
            <p className="sx-r-title">현금 흐름 영수증</p>
            <p className="sx-r-sub">{place} · 시작 현금 {wman(startCash)}</p>
            <p className="sx-r-acc">카페 엔진은 한 달을 한꺼번에 계산해서, 달이 끝날 때마다 한 장씩 쌓여요. 회색 줄은 현금이 아니라 이익 계산이에요.</p>
            {months.length === 0 && <p className="sx-r-empty">아직 찍힌 내역이 없어요. 첫 달이 끝나면 한 장씩 쌓여요.</p>}
            {months.map((m) => (
              <section key={m.month} className="sx-r-day">
                <p className="sx-r-month">{m.calendar_month}월</p>
                <p className="sx-r-head"><b>{m.calendar_month}월 한 달</b><span>손님 {m.kpi.customers.toLocaleString("ko-KR")}명</span></p>
                <ul>
                  <li className="in"><span>매출</span><b>+{wman(m.pnl.revenue_krw)}</b></li>
                  {m.pnl.lines.filter((l) => Math.abs(l.krw) >= 10000).map((l) => <li key={l.key} className="out"><span>{l.item_ko}</span><b>−{wman(Math.abs(l.krw))}</b></li>)}
                  <li className={`acc-sum ${m.kpi.op_krw >= 0 ? "in" : "out"}`}><span>이달 영업이익</span><b>{m.kpi.op_krw >= 0 ? "+" : "−"}{wman(Math.abs(m.kpi.op_krw))}</b></li>
                </ul>
                <p className="sx-r-sum"><span>남은 현금</span><b>{wman(m.kpi.cash_krw)}</b></p>
              </section>
            ))}
            <div ref={receiptEnd} />
          </div>
        </aside>
      )}

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
          <aside className={`sx-planpanel${planOpen ? "" : " is-folded"}`} aria-label={`${cur.calendar_month}월 운영 계획`}>
            <p className="sx-panel-h"><span>{cur.calendar_month}월 운영 계획</span><button type="button" className="sx-fold" aria-expanded={planOpen} onClick={() => setPlanOpen((v) => !v)}>{planOpen ? "접기" : "펴기"}</button></p>
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

      {peek && view && <button type="button" className="sx-peekback" onClick={() => setPeek(false)}>{PEEK_BACK[view] ?? "창 다시 보기"}</button>}{/* lab:peek */}
      {view !== null && (
        <div className="sx-modal" role="dialog" aria-modal="true" hidden={peek}>
          <div className={`sx-pop sx-pop-${view}`}>
            <button type="button" className="sx-peekbtn" onClick={() => setPeek(true)}>가게 화면 보기</button>{/* lab:peek */}
            {view === "intro" && (
              <>
                <div className="sx-scroll">
                  <h1>{place}에서 {TOTAL}개월</h1>
                  <p className="sx-note sx-modenote">{mode === "easy" ? <><b>easy 모드</b> · 달마다 방향만 골라요: 추천대로 / 손님 늘리기 / 비용 아끼기. 가격·영업시간·배달은 버튼으로 바꿀 수 있어요.</> : <><b>hard 모드</b> · 달마다 가격·영업시간·직원·마케팅·디저트·배달을 하나씩 정해요.</>}</p>
                  <Kpis items={[
                    { label: "가게", value: `${cfg.pyeong}평 · ${pv?.seats.total ?? "-"}석` },
                    { label: "평당 월세", value: `${guStat(profile.gu).rent}만원` },
                    { label: "여는 데 드는 돈", value: fund ? man(fund.total) : "-" },
                    { label: "가진 돈", value: man(profile.capital) },
                    { label: "대출", value: fund ? (fund.loan > 0 ? man(fund.loan) : "없음") : "-" },
                    { label: "문 열 때 현금", value: fund ? man(fund.cash) : "-", main: true },
                  ]} />
                  {fund && <p className="sx-note">여는 비용은 가게 꾸미기 화면과 같은 엔진 값이에요(보증금 {man(fund.deposit)}, 권리금 {man(fund.keyMoney)}, 부가세 선납 {man(fund.vat)} 포함, 부가세는 개업 후 돌려받아요).</p>}
                  {fund && fund.loan > 0 && <p className="sx-warnline">{fund.gap > 0 ? `여는 비용이 가진 돈보다 ${man(fund.gap)} 많아요. ` : ""}대출 {man(fund.loan)}({fund.gap > 0 ? `모자란 ${man(fund.gap)} + ` : ""}운전자금 {man(fund.extra)})으로 시작하고, 다달이 원리금 {man(fund.pay)}씩 갚아요(고른 금리가 없으면 연 4.5%, 5년).</p>}
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
                  <h1>{nextMonth}월 운영 계획<ModeTag mode={mode} /></h1>
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
                      return (
                        <section className="sx-right" aria-label="이번 달 운영 계획">
                          <h2>{nextMonth}월에 이렇게 할게요</h2>
                          <QuickPicks picks={PICKS.map((pk) => pk.key === "price_change_pct" ? { ...pk, opts: pk.opts.map((o) => ({ ...o, label: cupKo(o.value as number) })) } : pk)} base={plan} prev={cur ? { ...plan, ...cur.decisions, price_change_pct: 0 } : undefined} tweak={tweak} setTweak={setTweak} />
                          <p className="sx-note">hard 모드에서는 가격·영업시간·직원·마케팅·디저트·배달을 하나씩 정할 수 있어요.</p>
                        </section>
                      );
                    })() : (
                    <section className="sx-right" aria-label="이번 달 운영 계획">
                      <h2>{nextMonth}월에 이렇게 할게요</h2>
                      <div className="sx-steps">
                        <MenuSummary doc={menuDoc} onEdit={() => setView("menu")} locked={months.length ? "메뉴판은 첫 달을 시작하기 전에 정해요. 가격은 아래 가격 조정으로 바꿔요" : undefined} />{/* lab:menu */}
                        {LEVERS.filter((lv) => lv.key !== "hours").map((lv) => <Stepper key={lv.key} lv={lv} plan={plan} prev={cur ? { ...plan, ...cur.decisions, price_change_pct: 0 } : undefined} set={setPlan} />)}
                      </div>
                      <CafeHard plan={plan} set={setPlan} />{/* upstream hard 선택지 (영업 시각·원두·시즌 음료·디저트 가격·포장 할인·스탬프·배달) */}
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

            {view === "menu" && menuDoc && body && ( // lab:menu  첫 달 전이라 고친 메뉴로 시즌을 새로 시작한다 (같은 시드)
              <MenuEditor api={ENGINE} industry="cafe" grade="domestic" district={String(body.district)} doc={menuDoc}
                onCancel={() => setView("plan")} note="카페는 첫 달 전에 메뉴판을 정해요. 시즌 중에는 가격 조정으로 바꿔요."
                onSave={(d) => {
                  setMenuDoc(d); setBusy(true); setErr("");
                  post("/cafe/season", { ...body, daily_customers: daily.current, start_month: startMonth, menu: menuToEngine(d.items), ...cafeFinance() })
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
                  <div className={`sx-dps${dps.points.length === 1 ? " is-single" : ""}`}>
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
                  <h1>{cur.calendar_month}월 정산<ModeTag mode={mode} /></h1>
                  {(() => {
                    const op = cur.kpi.op_krw, opM = Math.round(op / 1e4), walk = cur.kpi.walkaway_share;
                    const why = opM >= 0 ? (walk >= 0.08 ? "더 받을 수 있었는데 바쁜 시간에 손님이 돌아갔어요" : "손님과 비용이 잘 맞았어요")
                      : walk >= 0.1 ? "바쁜 시간에 손님을 놓쳤어요" : "매출이 고정비를 덮지 못했어요";
                    return (
                      <>
                        <div className={`sc-hero ${opM >= 0 ? "" : "is-bad"}`}>
                          <h2>{opM === 0 ? "본전" : op > 0 ? "흑자" : "적자"} {sgn(op)}</h2>
                          <p>{why}. 손님 {cur.kpi.customers.toLocaleString("ko-KR")}명 · 돌아간 손님 {Math.round(walk * 100)}% · ★ {cur.kpi.rating.toFixed(1)}</p>
                        </div>
                        <Kpis items={[
                          { label: "매출", value: wman(cur.kpi.revenue_krw) },
                          { label: "나간 돈", value: wman(cur.kpi.revenue_krw - op) },
                          { label: "영업이익", value: sgn(op), tone: tone(op) },
                          { label: "월말 현금", value: wman(cur.kpi.cash_krw), main: true },
                        ]} />
                      </>
                    );
                  })()}
                  {cur.closure.closed && <p className="se-err">가게를 닫았어요. {cur.closure.reason_ko}</p>}
                  <p className="sx-note">{cur.owner_note_ko}</p>
                  {ins?.idx === months.length - 1 ? (
                    <Insight tries={ins.tries} last={over} onApply={(patch) => {
                      const { price_change_pct, ...rest } = patch;
                      if (mode === "easy") setTweak({ ...rest, ...(price_change_pct ? { price_change_pct } : {}) });
                      else setPlan({ ...plan, ...rest, price_change_pct: price_change_pct ?? 0 });
                      nextAfterSettle();
                    }} />
                  ) : <section className="ins"><h2>다음 달에 이렇게 바꿔 보세요</h2><p className="ins-sub">같은 달을 계획 한 가지씩 바꿔 엔진으로 다시 계산하고 있어요…</p></section>}
                  {(() => {
                    const xs = cur.pnl.lines.filter((l) => l.krw > 0).sort((a, b) => b.krw - a.krw);
                    const top: [string, number][] = xs.slice(0, 5).map((l) => [l.item_ko.replace(/\s*\(.*\)$/, ""), l.krw]);
                    const rest = xs.slice(5).reduce((a, l) => a + l.krw, 0);
                    return <CostBar items={rest > 0 ? [...top, ["기타", rest]] : top} revenue={cur.pnl.revenue_krw} op={cur.pnl.op_krw} fmt={(x) => wman(x)} />;
                  })()}
                  <CashFlow months={cfMonths} kind="food" shop="카페" compact />
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
                  <details className="sx-more">
                    <summary>손익표와 매장·포장·배달별 자세히 보기</summary>
                    <section className="st-card">
                      <header className="st-h"><span className="st-ico" aria-hidden>₩</span><div><h2>손익표</h2><small>이번 달 매출에서 비용을 하나씩 뺀 계산이에요</small></div></header>
                      {cur.month_line ? ( // lab:cost — 비용 쌓기: 인건비는 알바와 사장 가상 급여, 매장 운영비는 내역까지
                        <CostStack className="cst-settle" stack={cafeStack(cur.month_line)}
                          head={<>매출 (손님 {Math.round(cur.kpi.customers).toLocaleString("ko-KR")}명, 객단가 {Math.round(cur.kpi.revenue_krw / Math.max(1, cur.kpi.customers)).toLocaleString("ko-KR")}원)</>}
                          foot={VAT_NOTE} />
                      ) : (
                      <table className="sx-table st-table"><tbody>
                        <tr><th>매출</th><td>{wman(cur.pnl.revenue_krw)}</td></tr>
                        {cur.pnl.lines.filter((l) => l.krw !== 0).map((l) => <tr key={l.key}><th>{l.item_ko}</th><td>{l.krw < 0 ? "+" : "−"}{wman(Math.abs(l.krw))}</td></tr>)}
                        <tr><th>영업이익</th><td className={tone(cur.pnl.op_krw)}>{sgn(cur.pnl.op_krw)}</td></tr>
                      </tbody></table>
                      )}
                      <p className="sx-note">현금 변화: 영업이익 {sgn(cur.cash.op_krw)}, 감가상각 되돌림 +{wman(cur.cash.depreciation_addback_krw)},{cur.cash.owner_pay_addback_krw ? ` 사장 가상 급여 되돌림 +${wman(cur.cash.owner_pay_addback_krw)},` : ""} 대출 이자 −{wman(cur.cash.loan_interest_krw)}, 원금 −{wman(cur.cash.loan_principal_krw)}{cur.cash.vat_refund_krw ? `, 부가세 환급 +${wman(cur.cash.vat_refund_krw)}` : ""}{cur.cash.rent_card ? `, 월세 카드 할부 ${cur.cash.rent_card.cash_delta >= 0 ? "+" : "−"}${wman(Math.abs(cur.cash.rent_card.cash_delta))}` : ""}.</p>
                      <CardMonthLine rc={cur.cash.rent_card} />{/* lab:finance */}
                    </section>
                    {cur.channels && (() => {
                      const ch = cur.channels, n = Math.max(1, ch.dine + ch.takeout + ch.delivery), t = cur.pnl.revenue_krw / n;
                      const ln = (k: string) => cur.pnl.lines.find((l) => l.key === k)?.krw ?? 0;
                      const fr = ln("food") / Math.max(1, cur.pnl.revenue_krw);
                      return (
                        <section className="st-card">
                          <header className="st-h"><span className="st-ico is-ch" aria-hidden>⇄</span><div><h2>매장·포장·배달, 어디서 남았나</h2><small>같은 커피라도 포장은 컵·뚜껑값이, 배달은 한 건마다 수수료가 빠져요. 월세·인건비는 갈래와 상관없이 나가요</small></div></header>
                          <ChannelCards fmt={wman} perOne={1} rows={[
                            { key: "visit", label: "매장", orders: ch.dine, rev: ch.dine * t, costs: [["식재료", ch.dine * t * fr]] },
                            { key: "takeout", label: "포장", orders: ch.takeout, rev: ch.takeout * t, costs: [["식재료", ch.takeout * t * fr], ["컵·포장재", ln("packaging")]] },
                            { key: "delivery", label: "배달", orders: ch.delivery, rev: ch.delivery * t, costs: [["식재료", ch.delivery * t * fr], ["배달 수수료·포장", ln("delivery")]] },
                          ]} />
                          {ch.delivery === 0 && <p className="sx-note">배달을 안 했어요. 배달앱에 들어가면 이 동네 카페 점포당 배달 주문(소상공인365 배달분석)에 맞춰 주문이 늘어요.</p>}
                        </section>
                      );
                    })()}
                    <section className="st-card">
                      <header className="st-h"><span className="st-ico is-ch" aria-hidden>⇄</span><div><h2>지난달과 달라진 이유</h2><small>영업이익이 무엇 때문에 늘고 줄었나</small></div></header>
                      <ul className="sx-wf">{cur.waterfall.steps.filter((s) => Math.abs(s.krw) >= 10000).map((s) => <li key={s.key}><span>{s.label_ko}</span><b className={tone(s.krw)}>{sgn(s.krw)}</b></li>)}</ul>
                      {cur.events.length > 0 && <div className="st-ev"><b>이번 달 사건</b><ul className="sx-evs">{cur.events.map((e) => <li key={e.key}><b>{e.label_ko}</b><span>{e.effect_ko}</span></li>)}</ul></div>}
                    </section>
                  </details>
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
                  <h1>{months.length}개월 결과<ModeTag mode={mode} /></h1>
                  {!report ? <p>계산 중이에요.</p> : (
                    <>
                      <p className="sx-note">{report.survived ? `${TOTAL}개월을 버텼어요. ` : <b>가게를 닫게 됐어요. </b>}{report.summary_ko}</p>
                      <CardSeasonLine items={months.map((m) => m.cash.rent_card)} />{/* lab:finance */}
                      <section className="sx-sec"><h2>남은 현금</h2><Cash start={startCash} months={months} total={TOTAL} /></section>
                      <details className="sx-more sc-more rp-more"><summary>돈의 흐름 · 현금흐름표 · 달마다 기록 자세히 보기</summary>
                      <CashFlow months={cfMonths} kind="food" shop="카페" />
                      <section className="sx-sec"><h2>월별</h2>
                        <table className="sx-table"><thead><tr><th>달</th><th>매출</th><th>영업이익</th><th>월말 현금</th></tr></thead>
                          <tbody>{report.months.map((x: any) => <tr key={x.month}><td>{x.calendar_month}월</td><td>{wman(x.revenue_krw)}</td><td className={tone(x.op_krw)}>{sgn(x.op_krw)}</td><td>{wman(x.cash_krw)}</td></tr>)}</tbody></table>
                      </section>
                      </details>
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
