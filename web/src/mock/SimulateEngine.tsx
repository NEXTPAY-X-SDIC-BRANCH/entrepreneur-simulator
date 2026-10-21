// Step 4 (engine). 시즌 엔진(sim.season)이 한 달에 한 번 계산하고, 화면은 그 한 달을 날마다 풀어서 보여 준다.
// 화면 전체가 3D 가게이고, 위에는 지표 줄, 오른쪽에는 영수증 형태의 현금 흐름 기록이 있다.
// 한 달의 순서: 운영 계획 팝업 → (이달의 사건 대응 팝업) → 하루씩 재생 → 정산 팝업 → 다음 달 운영 계획.
// 날마다의 값은 엔진이 만든 밤별 매출·손님을 그달 합계에 맞춰 나눈 것이고, 월세·이자는 첫날에, 인건비·사장 생활비·매장 운영비는 문 연 날마다 하루치씩 빠진다 (lab:cost).
// 엔진 서버(api/changeup.py, 포트 8010)가 필요하다. 목업 계산(sim.ts)은 쓰지 않는다.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Canvas } from "@react-three/fiber";
import { GLGuard } from "../shared/GLGuard";
import { Items, Room, TableLife, seatPoses } from "./Parts3D";
import { FitControls, People, StoreLights, ViewBar, gfxDpr, gfxFrameloop, gfxShadows, useGfx, type Person } from "./Scene3D";
import { flowRatioNote } from "./DongFlow";
import { flowShape, profileOf } from "./area";
import "./simulate-engine.css";
import CostStack from "../lab/cost/CostStack"; // lab:cost
import { VAT_NOTE, bbqStack, prorate, type BbqKpis } from "../lab/cost/stackModel"; // lab:cost
import { setEngineCtx } from "./chatContext";
import CardMonthLine, { type CardMonth } from "../lab/finance/CardMonthLine"; // lab:finance
import { rentCardPlan } from "../lab/finance/finance"; // lab:finance
import { LOAN_RATE, OWNER_DRAW, guStat, man, openingCost, storeStats, type Levers, type Profile, type Store } from "./model";
import MenuEditor, { MenuSummary } from "../lab/menu/MenuEditor"; // lab:menu
import { fetchTemplate, recompute, toEngine, type EngineMenuItem, type MenuDoc } from "../lab/menu/api"; // lab:menu
import { roomDims, shapeOf } from "../lab/layout/plan"; // lab:layout
import ScoreCard from "../lab/score/ScoreCard"; // lab:score
import { bbqSummary } from "../lab/score/summary"; // lab:score

const API = (import.meta.env.VITE_ENGINE_API as string | undefined) ?? "http://127.0.0.1:8010";
const SHIRTS = ["#e0735a", "#43648a", "#d4a032", "#5679a3", "#ec8a4f", "#35614a"];
const DOW_KO = ["일", "월", "화", "수", "목", "금", "토"];
const TURNS = 6;

type Plan = { meat_price: number; staff_per_shift: number; close_hour: number; marketing_budget: number; meat_grade: string; banchan: number; delivery: string;
  menu?: EngineMenuItem[]; table_cost?: number }; // lab:menu  메뉴판이 있으면 엔진이 삼겹살 가격 대신 메뉴로 객단가·원가를 계산
type Night = { dow: string; rain: boolean; revenue: number; covers: number; walkaways: number; cogs: number; fees: number };
type Ev = { id: string; label: string; group: string; mechanism: string | null; outcome?: string | null };
type Option = { id: string; label: string; hint: string; downside: string; tag: string };
type Dp = { id: string; kind: string; title: string; prompt: string; clock: string; default: string; count: number; count_tag: string; count_note?: string | null; options: Option[] };
type Decision = Dp & {
  chosen: string; chosen_label: string; default_label: string; month_op: number; month_revenue: number; vs_default_op: number;
  night: { revenue: number; op: number; covers: number; walkaways: number; satisfaction: number }; state: Record<string, number>;
};
type MonthResult = {
  month: number; month_index: number; label: string; note: string | null; demand_index: number; events: Ev[]; decisions: Decision[];
  kpis: Record<string, number>; p10: { revenue: number; op: number }; p50: { revenue: number; op: number }; p90: { revenue: number; op: number };
  nights: Night[]; reviews: { stars: number }[]; owner_line: { text?: string } | null;
  state_after: { cash: number; rating: number; review_count: number; awareness: number; regular_share: number; fatigue: number };
  closed: boolean; closed_reason: string | null;
  rent_card?: CardMonth; // lab:finance 월세 카드 할부 (원)
  base_plan: Plan; shadow: { revenue: number; op: number; covers: number }; waterfall: { driver: string; delta: number }[];
};
type Tick = { label: string; amount: number }; // 원
type Day = { n: number; date: Date; open: boolean; covers: number; rain: boolean; revenue: number; ticks: Tick[]; notes: string[]; net: number; cash: number };
type Done = { result: MonthResult; plan: Plan; days: Day[]; cashStart: number; cashEnd: number; year: number; picked: Record<string, string> };
// 고르지 않은 대응을 골랐다면: 같은 달을 그 대응으로 한 번 더 계산한 결과 (고른 뒤에만 계산한다)
type Alt = { label: string; month_op: number; op_gap: number; revenue: number; night_revenue: number; night_covers: number };
type Ledger = {
  rows: { month: number; op: number; cash_op: number; interest: number; net: number; cash: number; cum_recovered: number; rent_card_paid?: number; card_balance?: number }[]; // lab:finance rent_card_*
  start_cash: number; end_cash: number; lowest_cash: number; lowest_month: number; spent: number; deposit: number;
  payback: { month: number | null; estimated: boolean; within_engine: boolean; reason: string }; note: string;
  rent_card?: { months: number; fee_rate: number; fee_total: number; card_balance: number }; // lab:finance
};
type View = "intro" | "plan" | "menu" | "scenario" | "settle" | "report" | null; // lab:menu "menu"

const won = (x: number) => Math.round(x / 1e4);
const signed = (v: number) => `${v >= 0 ? "+" : "−"}${man(Math.abs(v))}`;
const fmt = (n: number) => n.toLocaleString("ko-KR");

// ---------------------------------------------------------------- 운영 계획 변수
const GRADES = ["imported", "domestic", "aged"] as const;
const GRADE_KO: Record<string, string> = { imported: "수입 냉동", domestic: "국내산", aged: "숙성" };
const GRADE_HINT: Record<string, string> = { imported: "원가가 낮고 맛 평가도 낮아요", domestic: "기본이에요", aged: "원가가 높고 맛 평가도 높아요" };
// 배민배달 매출 규모 구간 (research/season_params.yaml delivery.tier). 앱 안에서 내 가게의 순위로 정해져 사용자가 고른다.
const DELIVERY = ["none", "bottom20", "mid50_80", "mid35_50", "top35"] as const;
const DELIVERY_KO: Record<string, string> = {
  none: "안 함", bottom20: "하위 20% · 2.0% + 2,900원", mid50_80: "상위 50~80% · 6.8% + 2,900원",
  mid35_50: "상위 35~50% · 6.8% + 3,100원", top35: "상위 35% · 7.8% + 3,400원",
};
const DELIVERY_HINT = "배달앱 안에서 내 매출 순위 구간이에요. 중개수수료와 건당 배달비(서울)가 달라지고, 결제 수수료·포장재도 나가요. 배달 손님 일부는 원래 매장에 올 손님이에요";
const closeText = (h: number) => (h === 23 ? "밤 11시" : h === 24 ? "밤 12시" : "새벽 1시");
const mktText = (v: number) => (v ? `${v / 1e4}만원` : "없음");

type LeverDef = { key: keyof Plan; label: string; hint: string; text: (p: Plan) => string; can: (p: Plan, d: -1 | 1) => boolean; move: (p: Plan, d: -1 | 1) => Plan };
const num = (key: "meat_price" | "staff_per_shift" | "close_hour" | "banchan" | "marketing_budget", min: number, max: number, step: number) => ({
  can: (p: Plan, d: -1 | 1) => p[key] + d * step >= min && p[key] + d * step <= max,
  move: (p: Plan, d: -1 | 1) => ({ ...p, [key]: p[key] + d * step }),
});
const LEVERS: LeverDef[] = [
  { key: "meat_price", label: "삼겹살 1인분 가격", hint: "올리면 한 팀의 매출이 늘고 손님이 조금 줄어요", text: (p) => `${fmt(p.meat_price)}원`, ...num("meat_price", 15000, 25000, 1000) },
  { key: "staff_per_shift", label: "교대당 알바", hint: "많으면 서비스가 빠르고 인건비와 피로가 줄어요", text: (p) => `${p.staff_per_shift}명`, ...num("staff_per_shift", 0, 4, 1) },
  { key: "close_hour", label: "마감 시간", hint: "늦게 닫으면 손님이 늘지만 인건비와 공과금이 늘어요", text: (p) => closeText(p.close_hour), ...num("close_hour", 23, 25, 1) },
  { key: "banchan", label: "반찬 가짓수", hint: "많으면 만족이 오르고 원가와 서빙 시간이 늘어요", text: (p) => `${p.banchan}가지`, ...num("banchan", 3, 8, 1) },
  { key: "marketing_budget", label: "SNS 협찬 예산", hint: "인지도가 오르고 리뷰가 늘어요", text: (p) => mktText(p.marketing_budget), ...num("marketing_budget", 0, 3_000_000, 500_000) },
  {
    key: "meat_grade", label: "고기", hint: "", text: (p) => GRADE_KO[p.meat_grade] ?? p.meat_grade,
    can: (p, d) => { const i = GRADES.indexOf(p.meat_grade as (typeof GRADES)[number]); return i + d >= 0 && i + d < GRADES.length; },
    move: (p, d) => ({ ...p, meat_grade: GRADES[GRADES.indexOf(p.meat_grade as (typeof GRADES)[number]) + d] }),
  },
  {
    key: "delivery", label: "배달", hint: DELIVERY_HINT, text: (p) => DELIVERY_KO[p.delivery] ?? p.delivery,
    can: (p, d) => { const i = DELIVERY.indexOf(p.delivery as (typeof DELIVERY)[number]); return i + d >= 0 && i + d < DELIVERY.length; },
    move: (p, d) => ({ ...p, delivery: DELIVERY[DELIVERY.indexOf(p.delivery as (typeof DELIVERY)[number]) + d] }),
  },
];

type Rec = { lever: LeverDef; last: string; next: Plan; nextText: string; change: boolean; why: string };

// 규칙으로 만든 추천이다. 지난달 결과의 숫자만 보고, 엔진의 계산을 다시 돌리지는 않는다.
function recommend(last: Done | undefined, plan: Plan): Rec[] {
  const out: Rec[] = [];
  const k = last?.result.kpis;
  const s = last?.result.state_after;
  const lp = last?.plan ?? plan;
  const walk = k && k.covers > 0 ? k.walkaways / (k.covers + k.walkaways) : 0;
  const util = k?.table_utilization ?? 0;
  const op = k?.op ?? 0;
  const rec = (key: keyof Plan, nextPlan: Plan, why: string) => {
    const lv = LEVERS.find((l) => l.key === key)!;
    out.push({ lever: lv, last: lv.text(lp), next: nextPlan, nextText: lv.text(nextPlan), change: nextPlan[key] !== lp[key], why });
  };
  if (!last || !k || !s) {
    for (const lv of LEVERS) rec(lv.key, plan, "");
    return out;
  }
  // 알바
  let n = { ...lp };
  if ((s.fatigue >= 55 || walk >= 0.1) && lp.staff_per_shift < 4) {
    n = { ...lp, staff_per_shift: lp.staff_per_shift + 1 };
    rec("staff_per_shift", n, s.fatigue >= 55 ? `직원 피로가 ${Math.round(s.fatigue)}까지 올랐어요. 한 명 더 두면 서비스가 빨라지고 피로가 내려가요.` : `자리가 없어 돌아간 손님이 ${Math.round(walk * 100)}%예요. 일손을 늘려 보세요.`);
  } else if (util < 0.3 && op < 0 && lp.staff_per_shift > 1) {
    n = { ...lp, staff_per_shift: lp.staff_per_shift - 1 };
    rec("staff_per_shift", n, `테이블이 ${Math.round(util * 100)}%만 찼는데 인건비가 커요. 한 명 줄여도 서비스는 버텨요.`);
  } else rec("staff_per_shift", lp, `피로 ${Math.round(s.fatigue)}, 자리가 없어 돌아간 손님 ${Math.round(walk * 100)}%. 지금 인원이 맞아요.`);
  // 가격
  if (util >= 0.75 || walk >= 0.1) {
    n = { ...lp, meat_price: Math.min(25000, lp.meat_price + 1000) };
    rec("meat_price", n, `테이블이 ${Math.round(util * 100)}% 찼어요. 가격을 올려도 손님이 남을 만해요.`);
  } else if (util < 0.25 && s.awareness < 0.9 && lp.meat_price > 15000) {
    n = { ...lp, meat_price: lp.meat_price - 1000 };
    rec("meat_price", n, `테이블이 ${Math.round(util * 100)}%만 찼어요. 가격을 내려 손님을 불러 보세요.`);
  } else rec("meat_price", lp, "바꿀 신호가 없어요. 바꾸면 단골이 조금 빠져요.");
  // 마감
  if (s.fatigue >= 70 && lp.close_hour > 23) {
    n = { ...lp, close_hour: lp.close_hour - 1 };
    rec("close_hour", n, `직원 피로가 ${Math.round(s.fatigue)}예요. 마감을 한 시간 당기면 일손 부담이 줄어요.`);
  } else rec("close_hour", lp, "피로가 크지 않아 지금 마감을 유지해도 돼요.");
  // 반찬
  if (op < 0 && lp.banchan > 5) {
    n = { ...lp, banchan: lp.banchan - 1 };
    rec("banchan", n, `적자라 원가를 줄여야 해요. 반찬을 ${lp.banchan - 1}가지로 줄이면 원가와 서빙 시간이 줄어요.`);
  } else rec("banchan", lp, "적자가 아니라 반찬을 줄일 이유가 없어요.");
  // 협찬
  if (s.awareness < 0.8 && s.cash > 20_000_000 && lp.marketing_budget < 500_000) {
    n = { ...lp, marketing_budget: 500_000 };
    rec("marketing_budget", n, `인지도가 ${s.awareness.toFixed(2)}로 낮아요. 현금이 여유 있을 때 50만원 협찬을 써 보세요.`);
  } else if (lp.marketing_budget > 0 && s.awareness >= 1.05) {
    n = { ...lp, marketing_budget: 0 };
    rec("marketing_budget", n, `인지도가 ${s.awareness.toFixed(2)}로 충분해요. 협찬을 멈춰도 돼요.`);
  } else rec("marketing_budget", lp, `인지도 ${s.awareness.toFixed(2)}. 지금 예산을 유지하세요.`);
  // 고기
  const gi = GRADES.indexOf(lp.meat_grade as (typeof GRADES)[number]);
  if (s.rating < 3.9 && op > 0 && gi < 2) {
    n = { ...lp, meat_grade: GRADES[gi + 1] };
    rec("meat_grade", n, `평점이 ★${s.rating.toFixed(1)}이고 이익은 나요. 한 단계 좋은 고기로 평점을 올려 보세요.`);
  } else if (op < 0 && gi > 0 && k.cogs / k.revenue > 0.38) {
    n = { ...lp, meat_grade: GRADES[gi - 1] };
    rec("meat_grade", n, `재료비가 매출의 ${Math.round((k.cogs / k.revenue) * 100)}%예요. 한 단계 낮춰 원가를 줄여 보세요.`);
  } else rec("meat_grade", lp, "바꿀 신호가 없어요. 바꾸면 단골이 조금 빠져요.");
  for (const lv of LEVERS) if (!out.some((r) => r.lever.key === lv.key)) rec(lv.key, lp, ""); // lab:finance bugfix: 배달 추천이 없어 2달째 계획 화면이 멈췄다 (main에도 있음)
  return LEVERS.map((l) => out.find((r) => r.lever.key === l.key)!);
}

// ---------------------------------------------------------------- 날짜별 풀이
function buildDays(r: MonthResult, cashStart: number, year: number, ctx: { imputed: number; draw: number; interest: number }): Day[] {
  const n = new Date(year, r.month, 0).getDate();
  const open: Date[] = [];
  const all: Date[] = [];
  for (let d = 1; d <= n; d++) {
    const dt = new Date(year, r.month - 1, d);
    all.push(dt);
    if (dt.getDay() !== 1) open.push(dt); // 월요일 휴무 (엔진 가정)
  }
  const nights = r.nights.slice(0, open.length); // lab:cost — 그달 합계가 실제로 찍히는 밤들에 맞춰 나뉘도록
  const sumRev = nights.reduce((a, x) => a + x.revenue, 0) || 1;
  const sumFood = nights.reduce((a, x) => a + x.cogs, 0) || 1;
  const sumFee = nights.reduce((a, x) => a + x.fees, 0) || 1;
  const k = r.kpis;
  const byDate = new Map<number, Night>();
  // lab:cost — 엔진이 문 닫은 날(위생 영업정지, 사장 몸살)을 빼서 밤 수가 영업일보다 적으면 마지막 밤을 되풀이하지 않고
  // 남는 영업일을 쉬는 날로 둔다 (되풀이하면 날마다의 매출 합이 그달 매출보다 커졌다)
  open.forEach((dt, i) => { const nt = nights[i]; if (nt) byDate.set(dt.getDate(), nt); });
  const laborCash = Math.max(0, k.labor - (typeof k.labor_owner === "number" ? k.labor_owner : ctx.imputed));
  // lab:cost — 인건비·사장 생활비·매장 운영비를 월말에 한 번이 아니라 문 연 날마다 하루치씩 뺀다 (합계는 같다)
  const nOpen = Math.max(1, Math.min(open.length, nights.length));
  const firstSat = all.find((d) => d.getDay() === 6)?.getDate();
  let cash = cashStart;
  return all.map((dt, i) => {
    const nt = byDate.get(dt.getDate());
    const revenue = nt ? (k.revenue * nt.revenue) / sumRev : 0;
    const food = nt ? (k.cogs * nt.cogs) / sumFood : 0;
    const fee = nt ? (k.fees * nt.fees) / sumFee : 0;
    const ticks: Tick[] = [];
    const notes: string[] = [];
    if (nt) {
      ticks.push({ label: "매출", amount: revenue });
      ticks.push({ label: "재료비", amount: -food });
      if (fee > 0) ticks.push({ label: k.delivery_fee > 0 ? "카드·배달 수수료" : "카드 수수료", amount: -fee });
      if (laborCash > 0) ticks.push({ label: "인건비 (알바)", amount: -laborCash / nOpen }); // lab:cost
      if (ctx.draw > 0) ticks.push({ label: "사장 생활비", amount: -ctx.draw / nOpen }); // lab:cost
      ticks.push({ label: "매장 운영비", amount: -k.mgmt / nOpen }); // lab:cost
    }
    if (i === 0) {
      if (r.rent_card && r.rent_card.charged > 0) notes.push(`월세 ${Math.round(r.rent_card.charged / 1e4).toLocaleString("ko-KR")}만원은 카드 ${r.rent_card.months}개월 할부로 냈어요`); // lab:finance
      else ticks.push({ label: "월세", amount: -k.rent });
      if (!nights.length) { // lab:cost — 문 연 날이 없는 달: 하루치로 나눌 수 없어 첫날에 한 번에
        if (laborCash > 0) ticks.push({ label: "인건비 (알바)", amount: -laborCash });
        if (ctx.draw > 0) ticks.push({ label: "사장 생활비", amount: -ctx.draw });
        ticks.push({ label: "매장 운영비", amount: -k.mgmt });
      }
      if (ctx.interest > 0) ticks.push({ label: "대출 이자", amount: -ctx.interest });
      for (const e of r.events) notes.push(`일어난 일 · ${e.label}`);
    }
    if (i === 13 && r.rent_card && r.rent_card.paid > 0) ticks.push({ label: "카드 할부 대금 (월세, 결제일 14일 가정)", amount: -r.rent_card.paid }); // lab:finance
    if (dt.getDate() === firstSat) {
      for (const d of r.decisions) notes.push(`${d.clock} ${d.title} · ${d.chosen_label}`);
    }
    const net = ticks.reduce((a, t) => a + t.amount, 0);
    cash += net;
    return { n: i + 1, date: dt, open: !!nt, covers: nt?.covers ?? 0, rain: !!nt?.rain, revenue, ticks, notes, net, cash };
  });
}

// ---------------------------------------------------------------- 3D와 작은 부품
function Guests({ store, filled }: { store: Store; filled: number }) {
  const spots = useMemo(() => seatPoses(store.items), [store.items]);
  const order = useMemo(() => spots.map((_, i) => i).sort((a, b) => ((a * 7919) % 13) - ((b * 7919) % 13)), [spots]);
  // seated low-poly guests (store3d/Figures) facing their grill, forearms toward the table
  const list = useMemo(() => order.slice(0, filled).map((i): Person => {
    const [x, z, h] = spots[i];
    return { x: x - Math.sin(h) * 0.04, z: z - Math.cos(h) * 0.04, heading: h, seated: true, seed: i + 1, shirt: SHIRTS[i % SHIRTS.length], armsUp: 0.5 };
  }), [order, spots, filled]);
  const seated = useMemo(() => order.slice(0, filled), [order, filled]);
  return (
    <>
      <People list={list} />
      <TableLife items={store.items} seated={seated} />
    </>
  );
}

const ico = { width: 22, height: 22, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;
export const IconCash = () => <svg {...ico}><rect x="2.5" y="6" width="19" height="12" rx="1.5" /><circle cx="12" cy="12" r="2.8" /><path d="M6 9.5v.01M18 14.5v.01" /></svg>;
export const IconCal = () => <svg {...ico}><rect x="3.5" y="5" width="17" height="15" rx="2" /><path d="M3.5 10h17M8 3v4M16 3v4" /></svg>;
export const IconStar = () => <svg {...ico}><path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9l-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z" /></svg>;
export const IconHeart = () => <svg {...ico}><path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.6 4.3 4.3 0 0 1 19.5 10C19.5 15.4 12 20 12 20z" /></svg>;
export const IconBattery = ({ level }: { level: number }) => (
  <svg {...ico}><rect x="2.5" y="7.5" width="16" height="9" rx="2" /><path d="M21 10.5v3" /><rect x="4.5" y="9.5" width={Math.max(0.5, 12 * (1 - level / 100))} height="5" rx="0.8" fill="currentColor" stroke="none" /></svg>
);

// ? 아이콘. 누르거나 올리면 설명 상자가 뜬다. 설명을 빼면 아이콘만 보인다.
export function Q({ children }: { children?: ReactNode }) {
  return (
    <span className="sx-q" tabIndex={0} aria-label="설명 보기">
      ?
      {children ? <span className="sx-q-body" role="tooltip">{children}</span> : null}
    </span>
  );
}

export function Metric({ icon, label, children, tip }:{ icon: ReactNode; label: string; children: ReactNode; tip: ReactNode }) {
  return (
    <div className="sx-metric" tabIndex={0}>
      <span className="sx-ico">{icon}</span>
      <span className="sx-mt"><span className="sx-k">{label}<Q>{tip}</Q></span><b>{children}</b></span>
    </div>
  );
}

function Stepper({ lv, plan, prev, set }: { lv: LeverDef; plan: Plan; prev?: Plan; set: (p: Plan) => void }) {
  const id = `sx-${lv.key}`;
  const changed = prev && prev[lv.key] !== plan[lv.key];
  return (
    <div className={`sx-step${changed ? " is-changed" : ""}`}>
      <div className="sx-step-t">
        <span id={id} className="sx-step-l">{lv.label}</span>
        <small>{lv.key === "meat_grade" ? GRADE_HINT[plan.meat_grade] : lv.hint}</small>
        {changed && <small className="sx-step-prev">지난달 {lv.text(prev!)}</small>}
      </div>
      <div className="sx-step-c">
        <button type="button" aria-label={`${lv.label} 낮추기`} disabled={!lv.can(plan, -1)} onClick={() => set(lv.move(plan, -1))}>−</button>
        <output aria-labelledby={id}>{lv.text(plan)}</output>
        <button type="button" aria-label={`${lv.label} 높이기`} disabled={!lv.can(plan, 1)} onClick={() => set(lv.move(plan, 1))}>+</button>
      </div>
    </div>
  );
}

function CashChart({ start, months, labels, compact }: { start: number; months: Done[]; labels: number[]; compact?: boolean }) {
  const W = compact ? 360 : 640, H = compact ? 170 : 200, P = { l: compact ? 58 : 70, r: 10, t: 12, b: 24 };
  const pts: { x: number; v: number }[] = [{ x: 0, v: start }];
  months.forEach((m, mi) => m.days.forEach((d, di) => pts.push({ x: mi * 31 + di + 1, v: d.cash })));
  const maxX = TURNS * 31;
  const lo = Math.min(0, ...pts.map((p) => p.v)), hi = Math.max(start, ...pts.map((p) => p.v));
  const pad = (hi - lo) * 0.1 || 1e6;
  const y0 = lo - pad, y1 = hi + pad;
  const X = (x: number) => P.l + (x / maxX) * (W - P.l - P.r);
  const Y = (v: number) => P.t + (1 - (v - y0) / (y1 - y0)) * (H - P.t - P.b);
  const stepSize = [5e6, 1e7, 2e7, 5e7].find((s) => (y1 - y0) / s <= 4) ?? 1e8;
  const ticks: number[] = [];
  for (let t = Math.ceil(y0 / stepSize) * stepSize; t <= y1; t += stepSize) ticks.push(t);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="sx-chart" role="img" aria-label="날마다 남은 현금">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={P.l} x2={W - P.r} y1={Y(t)} y2={Y(t)} className={t === 0 ? "zero" : "grid"} />
          <text x={P.l - 8} y={Y(t) + 4} textAnchor="end">{t === 0 ? "0" : man(won(t))}</text>
        </g>
      ))}
      {labels.map((m, i) => <text key={i} x={X(i * 31 + 15)} y={H - 6} textAnchor="middle">{m}월</text>)}
      <line x1={P.l} x2={W - P.r} y1={Y(start)} y2={Y(start)} className="cross" />
      <path d={pts.map((p, i) => `${i ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.v).toFixed(1)}`).join("")} className="line" />
      {pts.length > 1 && <circle cx={X(pts[pts.length - 1].x)} cy={Y(pts[pts.length - 1].v)} r="4" className="dot" />}
    </svg>
  );
}

// lab:cost — 정산표를 비용 쌓기(매출 막대 + 줄별 금액)로: 인건비는 알바와 사장 가상 급여, 매장 운영비는 내역까지
function SettleTable({ m, imputed }: { m: MonthResult; imputed: number }) {
  const k = m.kpis;
  const per = k.delivery_orders >= 1 ? k.delivery_revenue / k.delivery_orders : 0;
  const net = per ? per - k.delivery_fee / k.delivery_orders - per * (k.cogs / k.revenue) : 0;
  return (
    <CostStack className="cst-settle" stack={bbqStack(k as BbqKpis, imputed)}
      head={<>매출 (손님 {fmt(Math.round(k.covers))}명, 객단가 {fmt(Math.round(k.ticket))}원)</>}
      extra={
        <ul className="sx-cs-notes">
          {k.delivery_revenue > 0 && <li>배달 매출 {man(won(k.delivery_revenue))} 포함, 주문 {fmt(Math.round(k.delivery_orders))}건. 배달 수수료 {man(won(k.delivery_fee))}(배달 매출의 {Math.round((k.delivery_fee / k.delivery_revenue) * 100)}%)는 수수료 줄에 들어 있어요.{per ? ` 한 건 평균 ${fmt(Math.round(per / 100) * 100)}원 주문에 재료비까지 빼면 ${fmt(Math.round(net / 100) * 100)}원 남아요.` : ""}</li>}
          <li>비슷한 달 10번 중 8번은 영업이익이 {signed(won(m.p10.op))} ~ {signed(won(m.p90.op))}예요.</li>
        </ul>
      }
      foot={VAT_NOTE} />
  );
}

const won1 = (x: number) => { const v = x / 1e4; return Math.abs(v) < 10 ? Math.round(v * 10) / 10 : Math.round(v); };
const signedMan = (x: number) => { const v = won1(x); return v === 0 ? "0원" : `${v > 0 ? "+" : "−"}${Math.abs(v).toLocaleString("ko-KR")}만원`; };
const tone = (x: number) => (x > 0 ? "pos" : x < 0 ? "neg" : "");
const STATE_KO: Record<string, (x: number) => string> = {
  awareness: (x) => `인지도 ${x > 0 ? "+" : "−"}${Math.abs(x).toFixed(2)}`,
  rating: (x) => `평점 ${x > 0 ? "+" : "−"}${Math.abs(x).toFixed(2)}`,
  fatigue: (x) => `직원 피로 ${x > 0 ? "+" : "−"}${Math.abs(Math.round(x))}`,
};
const planText = (p: Plan) => `삼겹살 ${fmt(p.meat_price)}원 · 알바 ${p.staff_per_shift}명 · ${closeText(p.close_hour)} 마감 · 반찬 ${p.banchan}가지 · 협찬 ${mktText(p.marketing_budget)} · ${GRADE_KO[p.meat_grade] ?? p.meat_grade}`;

function Kpis({ items }: { items: { label: string; value: string; tone?: string; main?: boolean }[] }) {
  return (
    <dl className="sx-kpis">
      {items.map((x) => <div key={x.label} className={x.main ? "main" : ""}><dt>{x.label}</dt><dd className={x.tone}>{x.value}</dd></div>)}
    </dl>
  );
}

function DecisionCard({ d, alts, busy, onTry }: { d: Decision; alts: Record<string, Alt>; busy: boolean; onTry: (dp: string, opt: string) => void }) {
  const same = d.chosen === d.default;
  const st = Object.entries(d.state || {}).filter(([k, x]) => STATE_KO[k] && Math.abs(x) > 1e-9);
  const [pick, setPick] = useState<string | null>(null);
  const alt = pick ? alts[`${d.id}:${pick}`] : undefined;
  return (
    <article className="sx-dres">
      <header>
        <span className="sx-clock">{d.clock}</span>
        <h3>{d.title}</h3>
      </header>
      <p className="sx-dres-pick">내 선택 <b>{d.chosen_label}</b>{same ? <span className="sx-chip">기본 대응</span> : null}</p>
      <dl className="sx-dres-nums">
        <div><dt>그 밤 매출</dt><dd className={tone(d.night.revenue)}>{signedMan(d.night.revenue)}</dd></div>
        <div><dt>그 밤 손님</dt><dd className={tone(d.night.covers)}>{d.night.covers > 0 ? "+" : d.night.covers < 0 ? "−" : ""}{Math.abs(Math.round(d.night.covers))}명</dd></div>
        <div className="main"><dt>이달 영업이익<Q>이런 밤이 한 달에 {d.count}번 있다고 보고(가정) 그 밤의 차이를 이달 값에 곱했어요.</Q></dt><dd className={tone(d.month_op)}>{signedMan(d.month_op)}</dd></div>
      </dl>
      {st.length > 0 && <p className="sx-dres-state">{st.map(([k, x]) => <span key={k} className={`sx-chip ${tone(k === "fatigue" ? -x : x)}`}>{STATE_KO[k](x)}</span>)}</p>}
      <p className="sx-dres-vs">
        {same ? "기본 대응을 골랐어요." : <>기본 대응(<b>{d.default_label}</b>)을 골랐다면보다 이달 영업이익 <b className={tone(d.vs_default_op)}>{signedMan(d.vs_default_op)}</b></>}
      </p>
      <div className="sx-alt">
        <p className="sx-alt-h">다른 대응을 골랐다면</p>
        <div className="sx-alt-btns">
          {d.options.filter((o) => o.id !== d.chosen).map((o) => (
            <button key={o.id} type="button" className={pick === o.id ? "on" : ""} disabled={busy}
              onClick={() => { setPick(o.id); if (!alts[`${d.id}:${o.id}`]) onTry(d.id, o.id); }}>{o.label}</button>
          ))}
        </div>
        {pick && !alt && <p className="sx-note">{busy ? "그 대응으로 이달을 다시 계산하는 중이에요…" : "계산하지 못했어요."}</p>}
        {alt && (
          <div className="sx-alt-res">
            <p><b>{alt.label}</b>을 골랐다면 이 달은 이렇게 됐을 거예요.</p>
            <dl className="sx-dres-nums">
              <div><dt>그 밤 매출</dt><dd className={tone(alt.night_revenue)}>{signedMan(alt.night_revenue)}</dd></div>
              <div><dt>그 밤 손님</dt><dd className={tone(alt.night_covers)}>{alt.night_covers > 0 ? "+" : alt.night_covers < 0 ? "−" : ""}{Math.abs(Math.round(alt.night_covers))}명</dd></div>
              <div className="main"><dt>이달 영업이익</dt><dd className={tone(alt.month_op)}>{signedMan(alt.month_op)}</dd></div>
            </dl>
            <p className="sx-dres-vs">지금 선택({d.chosen_label})보다 이달 영업이익 <b className={tone(alt.op_gap)}>{signedMan(alt.op_gap)}</b></p>
          </div>
        )}
      </div>
    </article>
  );
}

// ---------------------------------------------------------------- 화면
export default function SimulateEngine({ profile, store, levers, onBack }: {
  profile: Profile; store: Store; levers: Levers; setLevers: (l: Levers) => void; onBack: () => void;
}) {
  const st = guStat(profile.gu);
  const stats = storeStats(store);
  const cost = useMemo(() => openingCost(store, profile.gu, profile.keyMoney ?? 0), [store, profile.gu, profile.keyMoney]);
  const startCash = (profile.capital + store.loan - cost.total) * 1e4; // 원
  const interest = (store.loan * 1e4 * LOAN_RATE) / 12;
  const draw = OWNER_DRAW * 1e4;
  const now = new Date();
  const [startMonth, setStartMonth] = useState((now.getMonth() + 1) % 12 + 1); // 기본: 다음 달부터
  const [imputed, setImputed] = useState(3_000_000);
  const [health, setHealth] = useState<"check" | "ok" | "down">("check");
  const [seed, setSeed] = useState(() => 1000 + Math.floor(Math.random() * 9000));
  const [engineState, setEngineState] = useState<Record<string, unknown> | null>(null);
  const [done, setDone] = useState<Done[]>([]);
  const [plan, setPlan] = useState<Plan>({ meat_price: levers.price, staff_per_shift: Math.min(4, levers.staff), close_hour: 24, marketing_budget: 0, meat_grade: "domestic", banchan: 5, delivery: "none" });
  // lab:menu  메뉴판: 처음에 업종 기본 메뉴(원가 = 오늘 시세)를 받아 계획에 넣는다. 원육 등급을 바꾸면 고기 원가를 다시 계산
  const [menuDoc, setMenuDoc] = useState<MenuDoc | null>(null);
  const menuGrade = useRef<string | null>(null);
  const menuSeq = useRef(0);
  const applyMenu = (d: MenuDoc) => { setMenuDoc(d); setPlan((p) => ({ ...p, menu: toEngine(d.items), table_cost: d.table_setting?.cost })); };
  const gfx = useGfx();
  const [view, setView] = useState<View>("intro");
  const [fade, setFade] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [dps, setDps] = useState<{ events: Ev[]; points: Dp[]; note: string | null } | null>(null);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [dayIdx, setDayIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [fast, setFast] = useState(false);
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [alts, setAlts] = useState<Record<string, Alt>>({});
  const [altBusy, setAltBusy] = useState(false);
  const [receipt, setReceipt] = useState(true);
  const [chartOpen, setChartOpen] = useState(true);
  const [top, setTop] = useState(108);
  const states = useRef<Record<string, unknown>[]>([]); // 각 달이 시작될 때의 엔진 상태 (되감기용)
  const cashAtStart = useRef<number[]>([]);
  const receiptEnd = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);

  const monthSeq = useMemo(() => Array.from({ length: TURNS }, (_, i) => ((startMonth - 1 + i) % 12) + 1), [startMonth]);
  const year0 = now.getFullYear() + (startMonth < now.getMonth() + 1 ? 1 : 0);
  const yearOf = (i: number) => year0 + (monthSeq[i] < startMonth ? 1 : 0);

  useEffect(() => {
    mounted.current = true;
    fetch(`${API}/health`).then((r) => r.json()).then((h) => { setImputed(h.owner_imputed_wage ?? 3_000_000); setHealth("ok"); }).catch(() => setHealth("down"));
    return () => { mounted.current = false; };
  }, []);

  // 화면을 머리글 아래부터 끝까지 쓴다
  useLayoutEffect(() => {
    const measure = () => {
      const note = document.querySelector(".m-mocknote") ?? document.querySelector(".m-top");
      setTop(Math.round(note ? note.getBoundingClientRect().bottom : 108));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  useEffect(() => { // lab:menu
    if (health !== "ok") return;
    const g = plan.meat_grade;
    if (menuGrade.current === g) return;
    const first = menuGrade.current === null;
    menuGrade.current = g;
    const n = ++menuSeq.current; // 등급을 빨리 여러 번 바꾸면 마지막 요청만 쓴다
    // 처음에는 가게 꾸미기에서 정한 삼겹살 가격(levers.price)만큼 고기 가격을 맞춘다
    const k = levers.price / 19000;
    const load = first || !menuDoc
      ? fetchTemplate(API, "bbq", g).then((d) => (Math.abs(k - 1) < 1e-6 ? d : recompute(API, "bbq", g,
        d.items.map((x) => (x.kind === "main" ? { ...x, price: Math.round((x.price * k) / 100) * 100 } : x)), { table: d.table_setting })))
      : recompute(API, "bbq", g, menuDoc.items, { table: menuDoc.table_setting });
    load.then((d) => { if (mounted.current && n === menuSeq.current) applyMenu(d); })
      .catch((e) => n === menuSeq.current && setErr(`메뉴판: ${String(e.message ?? e)}`));
  }, [health, plan.meat_grade]); // eslint-disable-line react-hooks/exhaustive-deps

  const dongCode = profile.dong && profile.dong.gu === profile.gu ? profileOf(profile.gu, profile.dong.name)?.code : undefined;
  const spec = () => ({
    gu_sales_man: st.salesHansik, // 엔진 기준 점포(대학로 고깃집)가 한식음식점 평균에 맞춰져 있어 한식 기준 값을 준다 (육류 배율을 또 곱하면 두 번 센다)
    pyeong: store.pyeong, tables: Math.max(1, stats.tables), seats: stats.seats, cash_rent_man_per_pyeong: st.rent,
    staff: plan.staff_per_shift, price: plan.meat_price, baseline_runs: 150, quarter_index: st.qidx, area_type: st.areaType ?? "일반",
    start_month: startMonth,
    flow: flowShape(dongCode, profile.gu), // 동네의 요일·시간대·연령 비율 (없으면 엔진이 기준 상권 값을 씀)
  });

  const [porkFc, setPorkFc] = useState(false); // integrate: lab:pork 돼지고기 도매가 예측을 원가에 반영 (기본 끔)
  const withCard = (p: Plan) => { const rc = rentCardPlan(); const q = porkFc ? { ...p, use_pork_forecast: true } : p; return rc ? { ...q, rent_card: rc } : q; }; // lab:finance 월세 카드 할부 + lab:pork
  const post = async (path: string, body: unknown) => {
    const r = await fetch(`${API}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };

  // 팝업 안에서 화면을 바꿀 때 서서히 사라졌다 나타난다
  const swap = (v: View) => {
    setFade(true);
    window.setTimeout(() => { if (!mounted.current) return; setView(v); setFade(false); }, 220);
  };

  const begin = async () => {
    setErr(""); setBusy(true);
    try {
      const s = await post("/season/new", { seed, opening: true, cash: Math.max(0, startCash) });
      states.current = [s]; cashAtStart.current = [startCash];
      setEngineState(s); setDone([]); setLedger(null); setDayIdx(0);
      setBusy(false); swap("plan");
    } catch (e) { setErr(String(e)); setBusy(false); }
  };

  // 운영 계획을 확정하면 먼저 이번 달 사건과 그 달 사건의 대응 상황을 받는다
  const startMonthCall = async () => {
    if (!engineState) return;
    setErr(""); setBusy(true);
    try {
      const s = await post("/season/start", { state: engineState, plan: withCard(plan), store: spec() }); // lab:finance
      const points: Dp[] = s.decision_points ?? [];
      setDps({ events: s.events ?? [], points, note: s.note ?? null });
      setChoices(Object.fromEntries(points.map((p) => [p.id, p.default])));
      setBusy(false);
      if (points.length) swap("scenario"); else await playMonth({});
    } catch (e) { setErr(String(e)); setBusy(false); }
  };

  // 고르지 않은 대응 하나를 골랐다면: 이 달의 이전 상태에서 그 대응만 바꿔 같은 달을 다시 계산한다 (저장하지 않음)
  const tryAlt = async (dp: string, opt: string) => {
    const idx = done.length - 1;
    const cur = done[idx];
    const pre = states.current[idx];
    if (!cur || !pre) return;
    const key = `${dp}:${opt}`;
    setAltBusy(true); setErr("");
    try {
      const out = await post("/season/play", { state: pre, plan: withCard(cur.plan), store: spec(), night: true, night_choices: { ...cur.picked, [dp]: opt }, band_runs: 20 }); // lab:finance
      const d: Decision | undefined = out.result.decisions.find((x: Decision) => x.id === dp);
      if (!d) throw new Error("선택한 대응의 결과가 없어요");
      const r: MonthResult = out.result;
      setAlts((a) => ({ ...a, [key]: {
        label: d.chosen_label, month_op: r.kpis.op, op_gap: r.kpis.op - cur.result.kpis.op, revenue: r.kpis.revenue,
        night_revenue: d.night.revenue, night_covers: d.night.covers,
      } }));
    } catch (e) { setErr(String(e)); }
    setAltBusy(false);
  };

  const playMonth = async (picked: Record<string, string>) => {
    if (!engineState) return;
    setErr(""); setBusy(true);
    try {
      const out = await post("/season/play", { state: engineState, plan: withCard(plan), store: spec(), night: true, night_choices: picked, band_runs: 20 }); // lab:finance
      const result: MonthResult = out.result;
      const idx = done.length;
      const cs = cashAtStart.current[idx];
      const days = buildDays(result, cs, yearOf(idx), { imputed, draw, interest });
      const entry: Done = { result, plan, days, cashStart: cs, cashEnd: days.at(-1)?.cash ?? cs, year: yearOf(idx), picked };
      setDone((d) => [...d, entry]);
      setAlts({});
      setEngineState(out.state);
      states.current[idx + 1] = out.state;
      cashAtStart.current[idx + 1] = entry.cashEnd;
      setDayIdx(0); setPlaying(true); setBusy(false); swap(null);
    } catch (e) { setErr(String(e)); setBusy(false); }
  };

  const cur = done.at(-1);
  // 재생: 하루씩. 끝나면 정산 팝업.
  useEffect(() => {
    if (view !== null || !playing || !cur) return;
    if (dayIdx >= cur.days.length - 1) { setPlaying(false); swap("settle"); return; }
    const t = setTimeout(() => setDayIdx((i) => i + 1), fast ? 90 : 700);
    return () => clearTimeout(t);
  }, [view, playing, fast, dayIdx, cur]); // eslint-disable-line react-hooks/exhaustive-deps

  const skip = () => { if (cur) { setDayIdx(cur.days.length - 1); setPlaying(false); swap("settle"); } };

  const toNext = async () => {
    if (!cur) return;
    if (cur.result.closed || done.length >= TURNS) {
      swap("report");
      try {
        const ops = done.map((m) => m.result.kpis.op);
        const invest: Record<string, number> = {};
        for (const l of cost.lines) invest[l.key] = l.amount * 1e4;
        const L: Ledger = await post("/venture", {
          monthly_op: ops, invest, own_capital: profile.capital * 1e4, owner_draw: draw, imputed_owner_wage: imputed,
          loan: store.loan > 0 ? { principal: store.loan * 1e4, annual_rate: LOAN_RATE, term_months: 60, grace_months: 60 } : null,
          // lab:finance 장부는 같은 plan으로 할부를 다시 계산한다. 시뮬레이션 화면이 열린 뒤에는 할부 선택이 바뀌지 않아 달마다의 result.rent_card와 같다
          rent_card: rentCardPlan(), monthly_rent: done.map((m) => m.result.kpis.rent),
        });
        setLedger(L);
      } catch (e) { setErr(String(e)); }
      return;
    }
    swap("plan");
  };

  const redoMonth = () => { // 이번 달을 계획을 바꿔 다시. 달이 시작될 때의 상태로 돌아간다
    const i = done.length - 1;
    if (i < 0) return;
    setEngineState(states.current[i]); setDone((d) => d.slice(0, i)); setPlaying(false); swap("plan");
  };
  const restart = () => {
    setDone([]); setLedger(null); setPlaying(false); setDayIdx(0); setSeed(1000 + Math.floor(Math.random() * 9000)); swap("intro");
  };

  const idx = done.length; // 지금 정하거나 재생 중인 달의 순번 (0부터)
  const curDay = cur ? cur.days[Math.min(dayIdx, cur.days.length - 1)] : null;
  const { w, d } = roomDims(store); // lab:layout: the room's 가로:세로
  const state = cur?.result.state_after;
  const cashNow = view === null || view === "settle" || view === "report" ? curDay?.cash ?? startCash : (cashAtStart.current[done.length] ?? startCash);
  const planMonth = monthSeq[Math.min(idx, TURNS - 1)];
  const filled = curDay && curDay.open ? Math.min(stats.seats, Math.round((curDay.covers / Math.max(1, stats.seats * 1.5)) * stats.seats)) : 0;
  // lab:menu  메뉴판이 있으면 가격 추천은 메뉴판에서
  const recs = useMemo(() => recommend(cur, plan).map((r) => (r.lever.key === "meat_price" && plan.menu
    ? { ...r, change: false, last: `메뉴 ${plan.menu.length}개`, why: "메뉴판이 있어서 가격은 메뉴판에서 고쳐요." } : r)), [cur, plan]);
  const scoreSummary = useMemo(() => (view === "report" && done.length ? bbqSummary(done, { // lab:score
    startCash, openingCost: cost.total * 1e4, loan: store.loan * 1e4, loanRate: LOAN_RATE,
    inputs: { gu: profile.gu, dong: profile.dong?.name ?? null, pyeong: store.pyeong, tables: stats.tables, seats: stats.seats, capital: profile.capital * 1e4, start_month: startMonth, owner_wage_month: imputed },
  }) : null), [view, done]); // eslint-disable-line react-hooks/exhaustive-deps

  // 챗봇이 "내 가게는 몇 달째부터 남아요?"에 답할 수 있도록 지금까지의 결과를 넘긴다
  useEffect(() => {
    if (done.length === 0) { setEngineCtx(null); return; }
    const last = done[done.length - 1];
    setEngineCtx({
      start_month: startMonth, closed: last.result.closed, finished: !!ledger, cash_now: last.cashEnd,
      months: done.map((m) => ({
        month: m.result.month, revenue: m.result.kpis.revenue, cogs: m.result.kpis.cogs, labor: m.result.kpis.labor,
        rent: m.result.kpis.rent, mgmt: m.result.kpis.mgmt, fees: m.result.kpis.fees, covers: m.result.kpis.covers,
        op: m.result.kpis.op, open_days: m.result.nights.length || 26, cash_end: m.cashEnd,
      })),
      ...(ledger ? { payback: { month: ledger.payback.month, estimated: ledger.payback.estimated, reason: ledger.payback.reason },
        end_cash: ledger.end_cash, lowest_cash: ledger.lowest_cash, spent: ledger.spent } : {}),
    });
  }, [done, ledger, startMonth]);
  useEffect(() => () => setEngineCtx(null), []);

  // lab:cost — 이달 손익 (재생 중): 지난 날의 매출·재료비와, 문 연 날 수만큼 쌓인 인건비·임차료·매장 운영비
  const live = (() => {
    if (!cur || !(view === null || view === "settle")) return null;
    const k = cur.result.kpis;
    const upto = cur.days.slice(0, (view === "settle" ? cur.days.length : dayIdx + 1));
    const revNow = upto.reduce((a, d) => a + d.revenue, 0);
    const openAll = cur.days.filter((d) => d.open).length || 1;
    const openNow = upto.filter((d) => d.open).length;
    const full = bbqStack(k as BbqKpis, imputed);
    return { stack: prorate(full, k.revenue ? revNow / k.revenue : 0, openNow / openAll, revNow), day: upto.length, days: cur.days.length };
  })();

  // 영수증: 지금까지 지난 날만 쌓인다
  const receiptDays = done.flatMap((m, mi) => {
    const list = mi === done.length - 1 ? m.days.slice(0, dayIdx + 1) : m.days;
    return list.filter((x) => x.ticks.length > 0 || x.notes.length > 0).map((x) => ({ ...x, mi }));
  });
  useEffect(() => { receiptEnd.current?.scrollIntoView({ block: "end" }); }, [receiptDays.length, receipt]);

  if (health === "down") {
    return (
      <main className="se-main">
        <h1>엔진 서버에 연결되지 않아요</h1>
        <p>이 화면은 엔진 서버가 켜져 있어야 해요. 아래 명령으로 켠 뒤 새로고침하세요.</p>
        <pre className="se-pre">uvicorn api.changeup:app --host 127.0.0.1 --port 8010</pre>
        <button type="button" className="se-btn" onClick={onBack}>가게 꾸미기로 돌아가기</button>
      </main>
    );
  }

  const lastPlanMonth = idx > 0 ? monthSeq[idx - 1] : null;

  return (
    <div className="sx-root" style={{ top }}>
      <div className="sx-canvas">
        <GLGuard>
          <Canvas key={gfx} frameloop={gfxFrameloop(gfx)} shadows={gfxShadows(gfx)} camera={{ position: [w * 0.7, Math.max(w, d) * 1.2, d * 1.6], fov: 38 }} dpr={gfxDpr(gfx)}>
            <StoreLights w={w} d={d} r={Math.max(w, d) / 2 + 3} dim={!curDay || curDay.open ? 1 : 0.45} />
            <Room w={w} d={d} grade={store.grade} pyeong={store.pyeong} items={store.items} shape={shapeOf(store)} /> {/* lab:layout */}
            <Items items={store.items} />
            <Guests store={store} filled={view === "intro" || view === "plan" || view === "scenario" ? 0 : filled} />
            <FitControls box={[-w / 2, -d / 2, w / 2, d / 2 + 0.6]} dir={[0.7, 1.2, 1.6]} />
          </Canvas>
        </GLGuard>
        <ViewBar />
      </div>

      <header className="sx-hud">
        <Metric icon={<IconCash />} label="현금" tip={<>문을 열고 남은 운영자금에서 매출과 비용이 날마다 더해지고 빠져요. 월세와 이자는 달 첫날에, 인건비·사장 생활비·매장 운영비는 문 연 날마다 하루치씩 나가요.</>}>{/* lab:cost */}
          {man(won(cashNow))}
        </Metric>
        <Metric icon={<IconCal />} label="달" tip={<>시작 달부터 6개월을 한 달씩 진행해요.</>}>
          {view === "intro" ? `${startMonth}월 시작` : `${view === null || view === "settle" ? cur?.result.month ?? planMonth : planMonth}월 · ${Math.min(view === null || view === "settle" ? done.length : done.length + 1, TURNS)}/${TURNS}`}
        </Metric>
        <Metric icon={<IconStar />} label="평점 · 인지도"
          tip={<>
            <b>평점(총점)</b>은 손님이 남긴 별점(1~5)의 평균이에요. 최근 리뷰 30건이 크게 반영돼요.<br />
            <b>인지도</b>는 1.00이 동네에서 평소 알려진 수준이고, 새 가게는 0.60에서 시작해요. 리뷰가 늘고 SNS 협찬·사건이 있으면 오르고, 아무것도 안 하면 매달 1.00쪽으로 15%씩 돌아가요. 손님 수에 곱해지는 값이에요. (가정)
          </>}>
          {state ? `★ ${state.rating.toFixed(1)} · ${state.awareness.toFixed(2)}` : "리뷰 없음 · 0.60"}
        </Metric>
        <Metric icon={<IconHeart />} label="단골" tip={<>다시 오는 손님의 비율이에요. 만족이 평소보다 높으면 늘고, 가격이나 고기를 바꾸면 조금 빠져요. 새 가게는 5%에서 시작해요.</>}>
          {state ? `${Math.round(state.regular_share * 100)}%` : "5%"}
        </Metric>
        <Metric icon={<IconBattery level={state?.fatigue ?? 30} />} label="직원 피로도" tip={<>0~100이에요. 30부터 서비스가 느려지고 100이면 절반 속도예요. 높으면 알바가 갑자기 그만둘 확률이 올라가요.</>}>
          {state ? Math.round(state.fatigue) : 30}
        </Metric>
      </header>

      <button type="button" className="sx-ctoggle" aria-expanded={chartOpen} onClick={() => setChartOpen((v) => !v)}>
        {chartOpen ? "현금 그래프 접기" : "현금 그래프 펴기"}
      </button>
      <div className="sx-leftcol">
        {chartOpen && (
          <aside className="sx-chartpanel" aria-label="남은 현금 그래프">
            <p className="sx-panel-h"><span>남은 현금</span><b>{man(won(cashNow))}</b></p>
            <CashChart compact start={cashAtStart.current[0] ?? startCash} labels={monthSeq}
              months={done.map((m, i) => (i === done.length - 1 ? { ...m, days: m.days.slice(0, dayIdx + 1) } : m))} />
            <small>점선은 문 연 날의 현금, 빨간 선은 0원이에요.</small>
          </aside>
        )}
        {cur && (view === null || view === "settle") && (
          <aside className="sx-planpanel" aria-label={`${cur.result.month}월 운영 계획`}>
            <p className="sx-panel-h"><span>{cur.result.month}월 운영 계획</span></p>
            <dl>
              {LEVERS.map((lv) => {
                const before = done.length > 1 ? done[done.length - 2].plan : null;
                const asMenu = lv.key === "meat_price" && !!cur.plan.menu; // lab:menu
                const changed = before !== null && (asMenu ? JSON.stringify(before.menu) !== JSON.stringify(cur.plan.menu) : before[lv.key] !== cur.plan[lv.key]);
                return (
                  <div key={lv.key} className={changed ? "is-changed" : undefined}>
                    <dt>{asMenu ? "메뉴판" : lv.label}</dt>
                    <dd>{asMenu ? `메뉴 ${cur.plan.menu!.length}개` : lv.text(cur.plan)}</dd>
                  </div>
                );
              })}
            </dl>
            {done.length > 1 && <small><i aria-hidden="true" />파란색은 지난달과 달라진 조건이에요.</small>}
          </aside>
        )}
      </div>
      <button type="button" className="sx-rtoggle" aria-expanded={receipt} onClick={() => setReceipt((v) => !v)}>
        {receipt ? "현금 흐름 기록 접기" : "현금 흐름 기록 펴기"}
      </button>
      {receipt && (
        <aside className="sx-receipt cst-right" aria-label="이달 손익과 현금 흐름 기록">
          {live && ( // lab:cost
            <div className="cst-live">
              <CostStack compact stack={live.stack} head={<>{cur!.result.month}월 손익, {live.day}/{live.days}일</>}
                headValue={<b className={live.stack.op >= 0 ? "pos" : "neg"}>{signed(won(live.stack.op))}</b>}
                foot="인건비(사장 가상 급여 포함)·임차료·매장 운영비는 지난 날만큼 이미 뺐어요." />
            </div>
          )}
          <div className="sx-paper">
            <p className="sx-r-title">현금 흐름 영수증</p>
            <p className="sx-r-sub">{profile.gu}{st.area ? ` ${st.area}` : ""} · 시작 현금 {man(won(cashAtStart.current[0] ?? startCash))}</p>
            {receiptDays.length === 0 && <p className="sx-r-empty">아직 찍힌 내역이 없어요. 첫 달이 시작되면 하루씩 쌓여요.</p>}
            {receiptDays.map((x, i) => (
              <section key={`${x.mi}-${x.n}`} className="sx-r-day">
                {(i === 0 || receiptDays[i - 1].mi !== x.mi) && <p className="sx-r-month">{done[x.mi].result.month}월</p>}
                <p className="sx-r-head"><b>{x.date.getMonth() + 1}/{x.date.getDate()} ({DOW_KO[x.date.getDay()]})</b><span>{x.open ? `손님 ${x.covers}명${x.rain ? " · 비" : ""}` : "쉬는 날"}</span></p>
                {x.notes.map((n) => <p key={n} className="sx-r-note">{n}</p>)}
                <ul>{x.ticks.map((t) => <li key={t.label} className={t.amount >= 0 ? "in" : "out"}><span>{t.label}</span><b>{signed(won(t.amount))}</b></li>)}</ul>
                <p className="sx-r-sum"><span>남은 현금</span><b>{man(won(x.cash))}</b></p>
              </section>
            ))}
            <div ref={receiptEnd} />
          </div>
        </aside>
      )}

      {view === null && cur && curDay && (
        <div className="sx-bar" role="toolbar" aria-label="재생 조작">
          <button type="button" onClick={() => setPlaying((p) => !p)}>{playing ? "멈춤" : "재생"}</button>
          <button type="button" onClick={() => setFast((f) => !f)} aria-pressed={fast}>빠르게</button>
          <button type="button" onClick={skip}>이 달 끝으로</button>
          <span>{cur.result.month}월 {curDay.date.getDate()}일 ({DOW_KO[curDay.date.getDay()]}) · {curDay.open ? `손님 ${curDay.covers}명${curDay.rain ? ", 비" : ""}` : "쉬는 날"}</span>
        </div>
      )}

      {view !== null && (
        <div className="sx-modal" role="dialog" aria-modal="true">
          <div className={`sx-pop sx-pop-${view}${fade ? " is-fade" : ""}`}>

            {view === "intro" && (
              <>
                <div className="sx-scroll">
                  <h1>{profile.gu}{st.area ? ` ${st.area}` : ""}에서 6개월</h1>
                  <Kpis items={[
                    { label: "가게", value: `${store.pyeong}평 · ${stats.seats}석` },
                    { label: "평당 월세", value: `${st.rent}만원` },
                    { label: "여는 데 든 돈", value: man(cost.total) },
                    { label: "남은 운영자금", value: man(Math.round(startCash / 1e4)), main: true },
                  ]} />
                  <section className="sx-sec">
                    <h2>이렇게 진행돼요</h2>
                    <ol className="sx-flow">
                      <li><b>운영 계획</b><span>달마다 가격·알바·마감 등을 정해요.</span></li>
                      <li><b>이달의 사건</b><span>그 달 달력에 맞는 사건이 하나 생겨요. 어떻게 대응할지 골라요.</span></li>
                      <li><b>영업</b><span>엔진이 그달을 계산하고 하루씩 보여 줘요.</span></li>
                      <li><b>정산</b><span>매출·비용과 내 선택의 결과를 확인해요.</span></li>
                    </ol>
                    <p className="sx-note">새로 연 가게로 시작해요. 리뷰가 없고 손님이 적어, 단골이 쌓이는 데 몇 달이 걸려요.</p>
                  </section>
                  <label className="sx-field">시작할 달
                    <select value={startMonth} onChange={(e) => setStartMonth(+e.target.value)}>
                      {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>{m}월</option>)}
                    </select>
                    <small>{[10, 11, 12, 1, 2, 3].includes(startMonth)
                      ? "이 달은 엔진에 달력 자료(공연·방학·연말)가 있어요."
                      : "4~9월은 엔진에 달력 자료가 없어 동네 분기 매출 지수와 가정한 사건 확률로 채웠어요."}</small>
                  </label>
                  {err && <p className="se-err" role="alert">{err}</p>}
                </div>
                <footer className="sx-foot">
                  <button type="button" className="se-btn" onClick={begin} disabled={health !== "ok" || busy}>{busy ? "준비하는 중이에요" : "문 열기"}</button>
                  <button type="button" className="se-link" onClick={onBack}>가게 꾸미기로 돌아가기</button>
                  <small>새 점포는 처음 20초쯤 걸려요.</small>
                </footer>
              </>
            )}

            {view === "plan" && (
              <>
                <div className="sx-scroll">
                  <h1>{planMonth}월 운영 계획</h1>
                  <div className="sx-split">
                    <section className="sx-left" aria-label="지난달과 추천">
                      <h2>{lastPlanMonth ? `${lastPlanMonth}월 결과와 추천` : "처음 여는 달이에요"}</h2>
                      {cur ? (
                        <Kpis items={[
                          { label: "영업이익", value: signedMan(cur.result.kpis.op), tone: tone(cur.result.kpis.op), main: true },
                          { label: "매출", value: man(won(cur.result.kpis.revenue)) },
                          { label: "손님", value: `${fmt(Math.round(cur.result.kpis.covers))}명` },
                          { label: "평점", value: `★ ${cur.result.state_after.rating.toFixed(1)}` },
                        ]} />
                      ) : <p className="sx-note">지난달 기록이 없어 기본값으로 시작해요. 한 달 뒤부터 결과를 보고 추천해 드려요.</p>}
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
                        <button type="button" className="sx-ghost" onClick={() => setPlan(recs.reduce((p, r) => (r.change ? { ...p, [r.lever.key]: r.next[r.lever.key] } : p), plan))}>추천대로 적용</button>
                      )}
                    </section>
                    <section className="sx-right" aria-label="이번 달 운영 계획">
                      <h2>{planMonth}월에 이렇게 할게요</h2>
                      <div className="sx-steps">
                        {plan.menu && <MenuSummary doc={menuDoc} onEdit={() => swap("menu")} />}{/* lab:menu 삼겹살 가격 자리 */}
                        {LEVERS.filter((lv) => !(plan.menu && lv.key === "meat_price")).map((lv) => <Stepper key={lv.key} lv={lv} plan={plan} prev={cur?.plan} set={setPlan} />)}
                      </div>
                      <p className="sx-note">가격이나 고기를 바꾸면 그달 단골이 조금 빠져요.</p>
                      <label className="sx-note"><input type="checkbox" checked={porkFc} onChange={(e) => setPorkFc(e.target.checked)} /> 고깃값을 돼지고기 도매가 예측대로 바꾸기 (축산물품질평가원 시세로 만든 추정, 상단 '돼지고기 시세'에서 근거 확인)</label>{/* integrate: lab:pork */}
                    </section>
                  </div>
                  {err && <p className="se-err" role="alert">{err}</p>}
                </div>
                <footer className="sx-foot">
                  <button type="button" className="se-btn" onClick={startMonthCall} disabled={busy}>{busy ? "엔진이 계산 중이에요" : `${planMonth}월 시작`}</button>
                </footer>
              </>
            )}

            {view === "menu" && menuDoc && ( // lab:menu
              <MenuEditor api={API} industry="bbq" grade={plan.meat_grade} doc={menuDoc}
                onSave={(d) => { applyMenu(d); swap("plan"); }} onCancel={() => swap("plan")}
                note={`${planMonth}월부터 이 메뉴판으로 계산해요. 가격을 바꾸면 그달 단골이 조금 빠져요.`} />
            )}

            {view === "scenario" && dps && (
              <>
                <div className="sx-scroll">
                  <h1>{planMonth}월에 생길 일</h1>
                  {dps.events.length > 0 && (
                    <section className="sx-evbox">
                      <h2>이번 달 사건</h2>
                      <ul>{dps.events.map((e) => <li key={e.id}><b>{e.label}</b>{e.mechanism ? <span>{e.mechanism}</span> : null}</li>)}</ul>
                    </section>
                  )}
                  <section className="sx-sec">
                    <h2>이달의 사건, 어떻게 대응할까요?</h2>
                    <p className="sx-note">고른 대응대로 그달 계산에 반영돼요. 처음에는 기본 대응이 골라져 있어요.</p>
                  </section>
                  <div className="sx-dps">
                    {dps.points.map((dp) => (
                      <div key={dp.id} className="sx-dp" role="radiogroup" aria-labelledby={`${dp.id}-h`}
                        style={{ gridRow: `span ${2 + Math.max(...dps.points.map((x) => x.options.length))}` }}>
                        <header className="sx-dp-h"><span className="sx-clock">{dp.clock}</span><h3 id={`${dp.id}-h`}>{dp.title}</h3></header>
                        <div className="sx-dp-q">
                          <p>{dp.prompt}</p>
                          <small>{dp.count_note ?? `이런 밤이 한 달에 ${dp.count}번쯤 있다고 가정했어요`}. 효과 크기는 가정이에요.</small>
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
                  <button type="button" className="se-btn" onClick={() => playMonth(choices)} disabled={busy}>{busy ? "엔진이 계산 중이에요" : `${planMonth}월 영업 시작`}</button>
                  <button type="button" className="se-link" disabled={busy} onClick={() => swap("plan")}>운영 계획으로 돌아가기</button>
                </footer>
              </>
            )}

            {view === "settle" && cur && (() => {
              const r = cur.result;
              const diff = r.kpis.op - r.shadow.op;
              return (
                <>
                  <div className="sx-scroll">
                    <h1>{r.month}월 정산</h1>
                    <Kpis items={[
                      { label: "영업이익", value: signedMan(r.kpis.op), tone: tone(r.kpis.op), main: true },
                      { label: "매출", value: man(won(r.kpis.revenue)) },
                      { label: "손님", value: `${fmt(Math.round(r.kpis.covers))}명` },
                      { label: "월말 현금", value: man(won(cur.cashEnd)) },
                    ]} />
                    {flowRatioNote(dongCode, profile.gu, r.kpis.covers) && <p className="sx-note">{flowRatioNote(dongCode, profile.gu, r.kpis.covers)}</p>}
                    {r.closed && <p className="se-err">현금이 두 달 연속 바닥이라 가게를 닫게 됐어요.</p>}

                    <div className="sx-settle">
                      <section className="sx-sec">
                        <h2>정산표</h2>
                        <SettleTable m={r} imputed={imputed} />
                        <small>월말 현금은 영업이익에서 사장 생활비 {man(won(draw))}와 이자를 빼고, 사장 가상 급여는 되돌린 값이에요.</small>
                        <CardMonthLine rc={r.rent_card} />{/* lab:finance */}
                      </section>
                      <section className="sx-sec">
                        <h2>이번 달 사건</h2>
                        {r.events.length === 0 ? <p className="sx-note">특별한 사건은 없었어요.</p> : (
                          <ul className="sx-evs">{r.events.map((e) => <li key={e.id}><b>{e.label}</b>{e.mechanism ? <span>{e.mechanism}</span> : null}</li>)}</ul>
                        )}
                        {r.reviews.length > 0 && <p className="sx-note">새 리뷰 {r.reviews.length}건, 평균 ★ {(r.reviews.reduce((a, x) => a + x.stars, 0) / r.reviews.length).toFixed(1)}</p>}
                      </section>
                    </div>

                    {r.decisions.length > 0 && (
                      <section className="sx-sec">
                        <h2>내 선택의 결과</h2>
                        <p className="sx-note">각 밤은 그 일이 없던 같은 밤과 비교한 값이에요. 한 달에 몇 번 있는지는 가정이고, 이달 영업이익 옆 <Q />에서 볼 수 있어요.</p>
                        <div className="sx-dres-grid">{r.decisions.map((x) => <DecisionCard key={x.id} d={x} alts={alts} busy={altBusy} onTry={tryAlt} />)}</div>
                      </section>
                    )}

                    <section className="sx-sec sx-compare">
                      <h2>기준 운영과 비교</h2>
                      <p className="sx-note">
                        <b>기준 운영</b>은 엔진의 기준 점포(혜화동 고깃집)가 평소 쓰는 방식이에요: {planText(r.base_plan)}.
                        같은 달, 같은 사건, 같은 손님 흐름에 이 방식만 바꿔 한 번 더 계산했어요.
                      </p>
                      <div className="sx-vs">
                        <div><span>기준 운영</span><b className={tone(r.shadow.op)}>{signedMan(r.shadow.op)}</b></div>
                        <div><span>내 운영</span><b className={tone(r.kpis.op)}>{signedMan(r.kpis.op)}</b></div>
                        <div className="main"><span>차이</span><b className={tone(diff)}>{signedMan(diff)}</b></div>
                      </div>
                      {r.waterfall.length > 0 && (
                        <ul className="sx-wf">
                          {r.waterfall.map((w) => <li key={w.driver}><span>{w.driver.replace("밤 결정: ", "이달의 사건 · ")}</span><b className={tone(w.delta)}>{signedMan(w.delta)}</b></li>)}
                        </ul>
                      )}
                    </section>
                  </div>
                  <footer className="sx-foot">
                    <button type="button" className="se-btn" onClick={toNext}>
                      {r.closed || done.length >= TURNS ? "6개월 결과 보기" : `${monthSeq[done.length]}월 운영 계획`}
                    </button>
                    <button type="button" className="se-link" onClick={redoMonth}>이 달을 계획을 바꿔 다시</button>
                  </footer>
                </>
              );
            })()}

            {view === "report" && (
              <>
                <div className="sx-scroll">
                  {scoreSummary && <ScoreCard summary={scoreSummary} />}{/* lab:score */}
                  <h1>{done.length}개월 결과</h1>
                  {!ledger ? <p>계산 중이에요.</p> : (
                    <>
                      <Kpis items={[
                        { label: "6개월 뒤 현금", value: man(won(ledger.end_cash)), main: true },
                        { label: "시작 현금", value: man(won(ledger.start_cash)) },
                        { label: "가장 낮았던 때", value: `${man(won(ledger.lowest_cash))}` },
                        { label: "투자금 회수", value: ledger.payback.month === null ? "못 되찾음" : `${ledger.payback.month}개월째${ledger.payback.estimated ? " (추정)" : ""}` },
                      ]} />
                      <p className="sx-note">
                        {cur?.result.closed ? <b>가게를 닫게 됐어요. </b> : null}
                        {ledger.payback.month === null
                          ? <>쓴 돈 {man(won(ledger.spent))}은 이 속도로는 되찾지 못해요 ({ledger.payback.reason}).</>
                          : <>쓴 돈 {man(won(ledger.spent))}을 {ledger.payback.month}개월째에 되찾아요{ledger.payback.estimated ? ". 6개월 뒤는 마지막 3개월 평균으로 이어 붙인 추정이에요." : "."}</>}
                        {" "}보증금 {man(won(ledger.deposit))}은 닫을 때 돌려받는 돈이라 뺐어요.
                      </p>
                      <section className="sx-sec">
                        <h2>남은 현금</h2>
                        <CashChart start={cashAtStart.current[0] ?? startCash} months={done} labels={monthSeq} />
                      </section>
                      <section className="sx-sec">
                        <h2>월별 현금</h2>
                        <table className="sx-table">
                          <thead><tr><th>달</th><th>영업이익</th><th>이자</th>{ledger.rent_card && <th>카드 할부 (월세)</th>}<th>생활비 반영 현금 변화</th><th>월말 현금</th></tr></thead>
                          <tbody>{ledger.rows.map((x) => (
                            <tr key={x.month}><td>{monthSeq[x.month - 1]}월</td><td>{signed(won(x.op))}</td><td>−{man(won(x.interest))}</td>{ledger.rent_card && <td>{x.rent_card_paid ? `−${man(won(x.rent_card_paid))}` : "0"}</td>}<td>{signed(won(x.net))}</td><td>{man(won(x.cash))}</td></tr>
                          ))}</tbody>
                        </table>
                        {ledger.rent_card && <small>월세를 카드 {ledger.rent_card.months}개월 할부로 냈어요. 수수료는 모두 {man(won(ledger.rent_card.fee_total))}이고, 남은 할부 {man(won(ledger.rent_card.card_balance))}은 시즌이 끝난 뒤에도 갚아야 할 돈이에요. 월말 현금에는 아직 빠지지 않았어요. {/* lab:finance */}</small>}
                      </section>
                      <section className="sx-sec">
                        <h2>달마다의 정산표</h2>
                        {done.map((m, i) => (
                          <details key={i} className="sx-det" open={i === done.length - 1}>
                            <summary><b>{m.result.month}월</b><span className={tone(m.result.kpis.op)}>영업이익 {signedMan(m.result.kpis.op)}</span><span>월말 현금 {man(won(m.cashEnd))}</span></summary>
                            <SettleTable m={m.result} imputed={imputed} />
                            {m.result.events.length > 0 && <p className="sx-note">사건: {m.result.events.map((e) => e.label).join(", ")}</p>}
                            {m.result.decisions.length > 0 && (
                              <ul className="sx-wf">
                                {m.result.decisions.map((x) => <li key={x.id}><span>{x.title}: {x.chosen_label}</span><b className={tone(x.month_op)}>{signedMan(x.month_op)}</b></li>)}
                              </ul>
                            )}
                          </details>
                        ))}
                      </section>
                    </>
                  )}
                  {err && <p className="se-err" role="alert">{err}</p>}
                </div>
                <footer className="sx-foot">
                  <button type="button" className="se-btn" onClick={restart}>처음부터 다시</button>
                  <button type="button" className="se-link" onClick={onBack}>가게 꾸미기로</button>
                </footer>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
