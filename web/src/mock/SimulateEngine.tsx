// Step 4 (engine). 시즌 엔진(sim.season)이 한 달에 한 번 계산하고, 화면은 그 한 달을 날마다 풀어서 보여 준다.
// 화면 전체가 3D 가게이고, 위에는 지표 줄, 오른쪽에는 영수증 형태의 현금 흐름 기록이 있다.
// 한 달의 순서: 운영 계획 팝업 → (이달의 사건 대응 팝업) → 하루씩 재생 → 정산 팝업 → 다음 달 운영 계획.
// 날마다의 값은 엔진이 만든 밤별 매출·손님을 그달 합계에 맞춰 나눈 것이고, 월세·급여·생활비·이자는 지급일에 빠진다.
// 엔진 서버(api/changeup.py, 포트 8010)가 필요하다. 목업 계산(sim.ts)은 쓰지 않는다.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Canvas } from "@react-three/fiber";
import { GLGuard } from "../shared/GLGuard";
import { Items, Room, TableLife, seatPoses } from "./Parts3D";
import { FitControls, People, StoreLights, ViewBar, gfxDpr, gfxFrameloop, gfxShadows, useGfx, type Person } from "./Scene3D";
import { flowRatioNote } from "./DongFlow";
import { flowShape, profileOf } from "./area";
import "./simulate-engine.css";
import { setEngineCtx } from "./chatContext";
import Assume from "./Assume";
import QuickPicks, { type Pick } from "./QuickPicks";
import PriceTrend from "./PriceTrend";
import { BBQ_REF, bbqBand } from "./priceCompare";
import ModeSwitch from "./ModeSwitch";
import CashFlow, { type CfMonth } from "./CashFlow";
import Scorecard, { GRADES as SCORE_GRADES, scoreOf, type ScoreMonth } from "./Scorecard";
import { LOAN_RATE, OWNER_DRAW, guStat, man, openingCost, roomSize, storeStats, type Levers, type Profile, type Store } from "./model";

const API = "http://127.0.0.1:8010";
const SHIRTS = ["#e0735a", "#43648a", "#d4a032", "#5679a3", "#ec8a4f", "#35614a"];
const DOW_KO = ["일", "월", "화", "수", "목", "금", "토"];
const TURNS = 6;

export type MenuItem = { name: string; price: number; cost: number; share: number }; // 1인분 원, 주문 비중 %
type Plan = { meat_price: number; staff_per_shift: number; close_hour: number; marketing_budget: number; meat_grade: string; banchan: number; delivery: string; menu?: MenuItem[] };
type Mode = "easy" | "hard"; // easy 모드: 계획은 추천대로 자동, 사건 대응만 고른다. hard 모드: 메뉴·원가와 계획을 직접 정한다
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
  cost_index?: { meat: number; veg: number } | null; cost_range?: { meat: [number, number]; veg: [number, number] } | null;
  kpis: Record<string, number>; p10: { revenue: number; op: number }; p50: { revenue: number; op: number }; p90: { revenue: number; op: number };
  nights: Night[]; reviews: { stars: number }[]; owner_line: { text?: string } | null;
  state_after: { cash: number; rating: number; review_count: number; awareness: number; regular_share: number; fatigue: number };
  closed: boolean; closed_reason: string | null;
  base_plan: Plan; shadow: { revenue: number; op: number; covers: number }; waterfall: { driver: string; delta: number }[];
};
type Tick = { label: string; amount: number }; // 원
type Day = { n: number; date: Date; open: boolean; covers: number; rain: boolean; revenue: number; ticks: Tick[]; notes: string[]; net: number; cash: number; fixedShare: number; cum: number };
type Done = { result: MonthResult; plan: Plan; days: Day[]; cashStart: number; cashEnd: number; year: number; picked: Record<string, string>; rentPaid: number; rentFee: number };
// 임대료 카드 할부 선택지 (hard 모드, 시작 화면). 끄려면 false
const RENT_CARD_ON = true;
// 임대료 카드 할부 (hard 모드, 시즌 시작 때 고르고 그 시즌 동안 고정). 달마다 월세를 카드로 내고, 수수료를 더한 금액을 N개월에 나눠 갚는다.
// 손익(엔진 영업이익)은 그대로고 현금이 나가는 시점만 뒤로 밀린다. 수수료는 현금에서 따로 빠진다. 수수료율은 가정 (카드 임대료 결제 서비스 이용료 + 할부 수수료).
type RentN = 0 | 3 | 6;
const RENT_PAY: Record<RentN, { label: string; fee: number; desc: string }> = {
  0: { label: "현금으로 바로", fee: 0, desc: "월세를 매달 1일에 한 번에 내요." },
  3: { label: "카드 3개월 할부", fee: 0.03, desc: "월세를 카드로 내고 3개월에 나눠 갚아요. 수수료 3%." },
  6: { label: "카드 6개월 할부", fee: 0.045, desc: "6개월에 나눠 갚아요. 첫 달 현금이 가장 많이 남지만 수수료 4.5%." },
};
// 이번 달 현금으로 나가는 월세 몫과 그중 수수료. rents는 1월차부터 이번 달까지의 월세(손익 기준)
function rentSchedule(rents: number[], n: RentN): { paid: number; fee: number; left: number } {
  if (!n) return { paid: rents.at(-1) ?? 0, fee: 0, left: 0 };
  const f = RENT_PAY[n].fee, i = rents.length - 1;
  let paid = 0, fee = 0, left = 0;
  rents.forEach((r, j) => {
    const done = Math.min(n, i - j + 1); // j번째 달 월세 중 이번 달까지 갚은 회차
    if (i - j < n) { paid += (r * (1 + f)) / n; fee += (r * f) / n; }
    left += (r * (1 + f) * (n - done)) / n;
  });
  return { paid, fee, left };
}
// 고르지 않은 대응을 골랐다면: 같은 달을 그 대응으로 한 번 더 계산한 결과 (고른 뒤에만 계산한다)
type Alt = { label: string; month_op: number; op_gap: number; revenue: number; night_revenue: number; night_covers: number };
type Ledger = {
  rows: { month: number; op: number; cash_op: number; interest: number; net: number; cash: number; cum_recovered: number }[];
  start_cash: number; end_cash: number; lowest_cash: number; lowest_month: number; spent: number; deposit: number;
  payback: { month: number | null; estimated: boolean; within_engine: boolean; reason: string }; note: string;
};
type View = "intro" | "plan" | "scenario" | "settle" | "report" | null;

const won = (x: number) => Math.round(x / 1e4);
const signed = (v: number) => `${v >= 0 ? "+" : "−"}${man(Math.abs(v))}`;
const fmt = (n: number) => n.toLocaleString("ko-KR");

// ---------------------------------------------------------------- 운영 계획 변수
const GRADES = ["imported", "domestic", "aged"] as const;
const GRADE_KO: Record<string, string> = { imported: "수입 냉동", domestic: "국내산", aged: "숙성" };
// easy 모드 '한 가지 더 정하기': hard 모드의 선택지 중 손님이 바로 느끼는 세 가지만 버튼으로
const BBQ_PICKS: Pick<Plan>[] = [
  { key: "meat_price", label: "삼겹살 1인분 가격", hint: "대표 메뉴 값. 올리면 한 팀의 매출이 늘고 손님이 조금 줄어요",
    opts: [16000, 17000, 18000, 19000, 20000].map((x) => ({ label: `${x.toLocaleString("ko-KR")}원`, value: x })) },
  { key: "meat_grade", label: "어떤 고기를 쓸까요?", hint: "냉동은 원가가 싸고, 국내산·숙성은 비싸지만 만족과 재방문이 올라요",
    opts: GRADES.map((g) => ({ label: GRADE_KO[g], value: g })) },
  { key: "staff_per_shift", label: "알바는 몇 명?", hint: "많으면 손님을 빨리 받고, 인건비가 늘어요",
    opts: [1, 2, 3].map((n) => ({ label: `${n}명`, value: n })) },
  { key: "marketing_budget", label: "SNS 홍보할까요?", hint: "체험단·협찬으로 처음 보는 손님이 늘어요",
    opts: [{ label: "안 해요", value: 0 }, { label: "조금 (50만원)", value: 500_000 }, { label: "많이 (150만원)", value: 1_500_000 }] },
  { key: "delivery", label: "배달", hint: "배달앱에 올리면 주문이 늘지만 수수료·배달비가 나가요", opts: [{ label: "안 해요", value: "none" }, { label: "배달앱 입점", value: "mid50_80" }] },
];
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
  // 배달: 추천 규칙이 없어 지금 구간을 그대로 둔다 (구간은 앱 안 매출 순위라 사장이 정하는 값이 아니다)
  rec("delivery", lp, lp.delivery === "none" ? "배달을 켜면 매출이 늘지만 수수료와 배달비가 나가요." : "앱 안 매출 순위 구간이라 그대로 둬요.");
  return LEVERS.map((l) => out.find((r) => r.lever.key === l.key)).filter((r): r is Rec => !!r);
}

// ---------------------------------------------------------------- 날짜별 풀이
function buildDays(r: MonthResult, cashStart: number, year: number, ctx: { imputed: number; draw: number; interest: number; rentPaid?: number; rentFee?: number; rentN?: RentN }): Day[] {
  const n = new Date(year, r.month, 0).getDate();
  const open: Date[] = [];
  const all: Date[] = [];
  for (let d = 1; d <= n; d++) {
    const dt = new Date(year, r.month - 1, d);
    all.push(dt);
    if (dt.getDay() !== 1) open.push(dt); // 월요일 휴무 (엔진 가정)
  }
  const nights = r.nights;
  const sumRev = nights.reduce((a, x) => a + x.revenue, 0) || 1;
  const sumFood = nights.reduce((a, x) => a + x.cogs, 0) || 1;
  const sumFee = nights.reduce((a, x) => a + x.fees, 0) || 1;
  const k = r.kpis;
  const byDate = new Map<number, Night>();
  open.forEach((dt, i) => { const nt = nights[Math.min(i, nights.length - 1)]; if (nt) byDate.set(dt.getDate(), nt); });
  const laborCash = Math.max(0, k.labor - ctx.imputed);
  // 월세·관리비·급여·생활비·이자는 지급일에 한꺼번에 나가 영업일 영수증에는 안 보인다. 영업일마다 그 몫을 따로 보여 준다 (현금에는 지급일에 반영)
  const rentFee = ctx.rentFee ?? 0;
  const fixedShare = (k.rent + rentFee + k.mgmt + laborCash + ctx.draw + ctx.interest) / Math.max(1, byDate.size);
  const firstSat = all.find((d) => d.getDay() === 6)?.getDate();
  let cash = cashStart;
  let cum = 0; // 이달 1일부터 오늘까지 (매출 - 재료비 - 수수료 - 오늘 몫 고정비)의 합
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
    }
    if (i === 0) {
      if (ctx.rentN) {
        ticks.push({ label: `월세 (카드 ${ctx.rentN}개월 할부 갚는 몫)`, amount: -((ctx.rentPaid ?? k.rent) - rentFee) });
        if (rentFee > 0) ticks.push({ label: "할부 수수료", amount: -rentFee });
      } else ticks.push({ label: "월세", amount: -k.rent });
      ticks.push({ label: "관리비", amount: -k.mgmt });
      if (ctx.interest > 0) ticks.push({ label: "대출 이자", amount: -ctx.interest });
      for (const e of r.events) notes.push(`일어난 일 · ${e.label}`);
    }
    if (i === 9) ticks.push({ label: "직원 급여", amount: -laborCash });
    if (i === 24) ticks.push({ label: "사장 생활비", amount: -ctx.draw });
    if (dt.getDate() === firstSat) {
      for (const d of r.decisions) notes.push(`${d.clock} ${d.title} · ${d.chosen_label}`);
    }
    const net = ticks.reduce((a, t) => a + t.amount, 0);
    cash += net;
    if (nt) cum += revenue - food - fee - fixedShare;
    return { n: i + 1, date: dt, open: !!nt, covers: nt?.covers ?? 0, rain: !!nt?.rain, revenue, ticks, notes, net, cash, fixedShare: nt ? fixedShare : 0, cum };
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
        <small>{lv.key === "meat_grade" ? GRADE_HINT[plan.meat_grade] : lv.hint}{lv.key === "delivery" && <Assume id="bbqDelivery" />}</small>
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

// 옷가게 시뮬레이션(ApparelSim.tsx)도 같은 그래프를 쓴다: 달마다 날짜별 현금(원)만 있으면 된다
export function CashChart({ start, months, labels, compact }: { start: number; months: { days: { cash: number }[] }[]; labels: number[]; compact?: boolean }) {
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

// 손익계산서 순서: 매출 → 매출원가 → 매출총이익 → 판매관리비 → 영업이익 → 감가상각·이자 → 세전이익.
// 영업이익은 엔진 값(감가상각 전)이다. 감가상각은 인테리어·설비·가구·간판을 5년(60개월)에 나눈 몫으로 현금은 안 나간다
// (법인세법 시행규칙 별표5 기구 및 비품 기준내용연수 5년, 카페 엔진과 같은 기준). 부가세·소득세·4대보험 사업주 부담은 아직 없다.
function SettleTable({ m, imputed, dep, interest, rent }: { m: MonthResult; imputed: number; dep: number; interest: number; rent?: { n: RentN; paid: number; fee: number; left: number } }) {
  const k = m.kpis;
  const pre = k.op - dep - interest;
  return (
    <table className="sx-table">
      <tbody>
        <tr><th>매출</th><td>{man(won(k.revenue))}</td><td>손님 {fmt(Math.round(k.covers))}명, 객단가 {fmt(Math.round(k.ticket))}원</td></tr>
        <tr><th>재료비 (매출원가)</th><td>−{man(won(k.cogs))}</td><td>매출의 {Math.round((k.cogs / k.revenue) * 100)}%, 남는 재료 폐기 포함</td></tr>
        {m.cost_index && m.cost_range && m.month !== 10 && (
          <tr className="sub"><th>이달 시세 (10월 = 1)</th><td></td><td>
            돼지고기 {m.cost_index.meat.toFixed(2)}배 (지난 시즌 {m.cost_range.meat[0].toFixed(2)}~{m.cost_range.meat[1].toFixed(2)}),
            채소 {m.cost_index.veg.toFixed(2)}배 ({m.cost_range.veg[0].toFixed(2)}~{m.cost_range.veg[1].toFixed(2)}). 예측이 아니라 과거 같은 달 값이에요
            (통계청 생활물가지수, KAMIS 서울 도매가)
          </td></tr>
        )}
        <tr className="sub"><th>매출총이익</th><td>{signed(won(k.revenue - k.cogs))}</td><td>매출의 {Math.round(((k.revenue - k.cogs) / k.revenue) * 100)}%</td></tr>
        <tr><th>인건비</th><td>−{man(won(k.labor))}</td><td>알바(주휴수당 포함)·직원 급여 {man(won(k.labor - imputed))}, 사장 가상 급여 {man(won(imputed))}</td></tr>
        <tr><th>월세</th><td>−{man(won(k.rent))}</td><td>{rent?.n ? <>카드 {rent.n}개월 할부로 냈어요. 이번 달 현금으로 나간 몫 {man(won(rent.paid - rent.fee))}, 남은 할부금 {man(won(rent.left))}<Assume id="rentFee" /></> : null}</td></tr>
        <tr><th>관리비·공과금·기타</th><td>−{man(won(k.mgmt))}</td><td>전기·가스·수도, 소모품·수선, 마케팅</td></tr>
        {k.delivery_revenue > 0 && (
          <tr><th>배달 매출</th><td>{man(won(k.delivery_revenue))}</td><td>매출에 포함, 주문 {fmt(Math.round(k.delivery_orders))}건. 일부는 원래 매장에 올 손님이라 그만큼 매장 매출이 줄었어요<Assume id="bbqDelivery" /></td></tr>
        )}
        <tr><th>카드 수수료</th><td>−{man(won(k.fees - (k.delivery_fee ?? 0)))}</td><td /></tr>
        {k.delivery_fee > 0 && (
          <tr><th>배달 수수료</th><td>−{man(won(k.delivery_fee))}</td><td>중개수수료, 결제 수수료, 건당 배달비·포장재<Assume id="packaging" />. 배달 매출의 {Math.round((k.delivery_fee / k.delivery_revenue) * 100)}%.{" "}
            {k.delivery_orders >= 1 && (() => {
              const per = k.delivery_revenue / k.delivery_orders;
              const net = per - k.delivery_fee / k.delivery_orders - per * (k.cogs / k.revenue);
              return `한 건 평균 ${fmt(Math.round(per / 100) * 100)}원 주문에 재료비까지 빼면 ${fmt(Math.round(net / 100) * 100)}원 남아요`;
            })()}</td></tr>
        )}
        <tr className="sum"><th>영업이익</th><td>{signed(won(k.op))}</td><td>감가상각 전. 비슷한 달 10번 중 8번은 {signed(won(m.p10.op))} ~ {signed(won(m.p90.op))}</td></tr>
        <tr><th>감가상각비</th><td>−{man(won(dep))}</td><td>인테리어·설비를 5년에 나눈 몫. 현금은 안 나가요</td></tr>
        {rent?.n && rent.fee > 0 ? <tr><th>할부 수수료</th><td>−{man(won(rent.fee))}</td><td>임대료 카드 할부. 영업이익에는 없고 현금에서 빠져요</td></tr> : null}
        {interest > 0 && <tr><th>이자비용</th><td>−{man(won(interest))}</td><td>대출 이자 (연 {+(LOAN_RATE * 100).toFixed(2)}%)</td></tr>}
        <tr className="sum"><th>세전이익</th><td>{signed(won(pre))}</td><td>부가세·소득세는 아직 계산하지 않아요</td></tr>
      </tbody>
    </table>
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
// ---------------------------------------------------------------- easy 모드: 달마다 방향 세 가지
// 추천대로 = 지난달 결과로 만든 규칙 추천(recommend)을 모두 적용. 손님 늘리기·비용 아끼기는 지난달 계획에서 몇 가지만 한 칸씩 움직인다.
type StratId = "rec" | "grow" | "save";
function strategies(cur: Done | undefined, plan: Plan): { id: StratId; title: string; desc: string; plan: Plan; changes: string[] }[] {
  const base = cur?.plan ?? plan;
  const rec = cur ? recommend(cur, base).reduce((p, r) => (r.change ? { ...p, [r.lever.key]: r.next[r.lever.key] } : p), base) : base;
  const grow: Plan = { ...base, staff_per_shift: Math.min(4, base.staff_per_shift + 1), marketing_budget: Math.max(base.marketing_budget, 500_000),
    delivery: base.delivery === "none" ? "mid50_80" : base.delivery };
  const save: Plan = { ...base, staff_per_shift: Math.max(1, base.staff_per_shift - 1), close_hour: 23, marketing_budget: 0, banchan: Math.max(3, base.banchan - 1) };
  const diff = (p: Plan) => LEVERS.filter((lv) => lv.text(p) !== lv.text(base)).map((lv) => `${lv.label} ${lv.text(base)} → ${lv.text(p)}`);
  return [
    { id: "rec", title: "추천대로", desc: cur ? "지난달 결과를 보고 고칠 곳만 고쳐요." : "첫 달은 기본 계획으로 시작해요.", plan: rec, changes: diff(rec) },
    { id: "grow", title: "손님 늘리기", desc: "일손·홍보·배달을 늘려 손님을 더 받아요. 비용도 늘어요.", plan: grow, changes: diff(grow) },
    { id: "save", title: "비용 아끼기", desc: "일손·영업시간·반찬·홍보를 줄여요. 손님을 놓칠 수 있어요.", plan: save, changes: diff(save) },
  ];
}

// ---------------------------------------------------------------- 메뉴 등록 (hard 모드)
// 메뉴마다 1인분 가격, 원가, 주문 비중(%)을 넣으면 엔진은 비중 가중 평균 가격과 원가를 쓴다 (sim/season.py _menu).
// 처음 줄의 원가 4,500원은 엔진의 국내산 200g 원가 (research/season_params.yaml meat_grade.domestic, S68·S69).
export function menuAvg(menu: MenuItem[]) {
  const ok = menu.filter((m) => m.price > 0 && m.share > 0);
  const total = ok.reduce((a, m) => a + m.share, 0) || 1;
  const price = Math.round(ok.reduce((a, m) => a + m.price * m.share, 0) / total);
  const cost = Math.round(ok.reduce((a, m) => a + m.cost * m.share, 0) / total);
  return { price, cost, ratio: price ? cost / price : 0 };
}
function MenuEditor({ plan, set }: { plan: Plan; set: (p: Plan) => void }) {
  const menu = plan.menu ?? [];
  const put = (i: number, k: keyof MenuItem, v: string) =>
    set({ ...plan, menu: menu.map((m, j) => (j === i ? { ...m, [k]: k === "name" ? v : Math.max(0, Number(v) || 0) } : m)) });
  const avg = menuAvg(menu);
  const bad = menu.some((m) => m.price < 3000 || m.cost > m.price);
  return (
    <div className="sx-menu">
      <h3>메뉴 등록</h3>
      <table>
        <thead><tr><th>메뉴</th><th>1인분 가격</th><th>원가</th><th>주문 비중</th><th /></tr></thead>
        <tbody>
          {menu.map((m, i) => (
            <tr key={i}>
              <td><input aria-label="메뉴 이름" value={m.name} maxLength={20} onChange={(e) => put(i, "name", e.target.value)} /></td>
              <td><input aria-label={`${m.name} 가격`} type="number" step={500} value={m.price} onChange={(e) => put(i, "price", e.target.value)} />원</td>
              <td><input aria-label={`${m.name} 원가`} type="number" step={100} value={m.cost} onChange={(e) => put(i, "cost", e.target.value)} />원</td>
              <td><input aria-label={`${m.name} 주문 비중`} type="number" step={5} value={m.share} onChange={(e) => put(i, "share", e.target.value)} />%</td>
              <td>{menu.length > 1 && <button type="button" className="se-link" onClick={() => set({ ...plan, menu: menu.filter((_, j) => j !== i) })}>빼기</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {menu.length < 8 && <button type="button" className="sx-ghost" onClick={() => set({ ...plan, menu: [...menu, { name: "", price: plan.meat_price, cost: 0, share: 10 }] })}>메뉴 추가</button>}
      <p className={`sx-note ${bad ? "se-err" : ""}`}>
        {bad ? "가격은 3,000원 이상, 원가는 가격보다 작아야 해요. 맞지 않는 줄은 계산에서 빠져요. " : ""}
        손님이 보는 평균 가격 <b>{fmt(avg.price)}원</b>, 평균 원가 <b>{fmt(avg.cost)}원</b>, 원가율 <b>{Math.round(avg.ratio * 100)}%</b>.
        {" "}{avg.price > 0 && bbqBand(avg.price).text}.
        비중은 합이 100이 아니어도 비율로 맞춰요. 고기 등급은 맛 평가에만 쓰고 원가는 이 표를 써요.
      </p>
    </div>
  );
}

export default function SimulateEngine({ profile, store, levers, onBack }: {
  profile: Profile; store: Store; levers: Levers; setLevers: (l: Levers) => void; onBack: () => void;
}) {
  const st = guStat(profile.gu);
  const stats = storeStats(store);
  const cost = useMemo(() => openingCost(store, profile.gu, profile.keyMoney ?? 0), [store, profile.gu, profile.keyMoney]);
  const startCash = (profile.capital + store.loan - cost.total) * 1e4; // 원
  const interest = (store.loan * 1e4 * LOAN_RATE) / 12;
  // 감가상각: 보증금·권리금·첫 재료처럼 쓰고 사라지지 않거나 바로 쓰는 돈은 빼고, 시설·가구만 60개월로 나눈다 (SettleTable 주석)
  const dep = (cost.lines.filter((l) => ["interior", "equip", "seat", "deco", "sign"].includes(l.key)).reduce((a, l) => a + l.amount, 0) * 1e4) / 60;
  // 현금흐름표·영수증 (원). 사장 가상 급여는 현금이 안 나가므로 인건비에서 뺀다
  const cfOf = (ds: Done[]): CfMonth[] => ds.map((d) => {
    const k = d.result.kpis, rp = d.rentPaid ? d.rentPaid - d.rentFee : k.rent;
    return { month: d.result.month, start: d.cashStart, end: d.cashEnd, lines: [
      { label: "매출", amount: k.revenue }, { label: "재료비 (고기·채소·주류)", amount: -k.cogs }, { label: "알바·직원 급여", amount: -Math.max(0, k.labor - imputed) },
      { label: "월세", amount: -rp }, { label: "임대료 할부 수수료", amount: -(d.rentFee || 0) }, { label: "관리비·공과금·기타", amount: -k.mgmt },
      { label: "카드·배달 수수료", amount: -k.fees }, { label: "사장 생활비", amount: -draw }, { label: "대출 이자", amount: -interest },
    ], tax: { revenue: k.revenue, farmBuy: k.cogs * 0.8, taxableBuy: k.rent + k.mgmt * 0.6 + (k.delivery_fee ?? 0), profit: k.op + imputed - dep - interest } };
  });
  const draw = OWNER_DRAW * 1e4;
  const now = new Date();
  const [startMonth, setStartMonth] = useState((now.getMonth() + 1) % 12 + 1); // 기본: 다음 달부터
  const [imputed, setImputed] = useState(3_000_000);
  const [health, setHealth] = useState<"check" | "ok" | "down">("check");
  const [seed, setSeed] = useState(() => 1000 + Math.floor(Math.random() * 9000));
  const [engineState, setEngineState] = useState<Record<string, unknown> | null>(null);
  const [done, setDone] = useState<Done[]>([]);
  const [plan, setPlan] = useState<Plan>({ meat_price: levers.price, staff_per_shift: Math.min(4, levers.staff), close_hour: 24, marketing_budget: 0, meat_grade: "domestic", banchan: 5, delivery: "none" });
  const gfx = useGfx();
  const [mode, setMode] = useState<Mode>("easy");
  const [rentN, setRentN] = useState<RentN>(0); // easy 모드는 늘 현금
  const [strat, setStrat] = useState<StratId>("rec");
  const [tweak, setTweak] = useState<Partial<Plan>>({});
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

  const dongCode = profile.dong && profile.dong.gu === profile.gu ? profileOf(profile.gu, profile.dong.name)?.code : undefined;
  const spec = () => ({
    gu_sales_man: st.salesHansik, // 엔진 기준 점포(대학로 고깃집)가 한식음식점 평균에 맞춰져 있어 한식 기준 값을 준다 (육류 배율을 또 곱하면 두 번 센다)
    pyeong: store.pyeong, tables: Math.max(1, stats.tables), seats: stats.seats, cash_rent_man_per_pyeong: st.rent,
    staff: plan.staff_per_shift, price: plan.meat_price, baseline_runs: 150, quarter_index: st.qidx, area_type: st.areaType ?? "일반",
    start_month: startMonth,
    flow: flowShape(dongCode, profile.gu), // 동네의 요일·시간대·연령 비율 (없으면 엔진이 기준 상권 값을 씀)
  });

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
      setBusy(false);
      swap("plan");
    } catch (e) { setErr(String(e)); setBusy(false); }
  };

  // 운영 계획을 확정하면 먼저 이번 달 사건과 그 달 사건의 대응 상황을 받는다
  const startMonthCall = async (p: Plan = plan, es: Record<string, unknown> | null = engineState) => {
    if (!es) return;
    setErr(""); setBusy(true);
    try {
      const s = await post("/season/start", { state: es, plan: p, store: spec() });
      const points: Dp[] = s.decision_points ?? [];
      setDps({ events: s.events ?? [], points, note: s.note ?? null });
      setChoices(Object.fromEntries(points.map((p) => [p.id, p.default])));
      setBusy(false);
      if (points.length) swap("scenario"); else await playMonth({}, p, es);
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
      const out = await post("/season/play", { state: pre, plan: cur.plan, store: spec(), night: true, night_choices: { ...cur.picked, [dp]: opt }, band_runs: 20 });
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

  const playMonth = async (picked: Record<string, string>, p: Plan = plan, es: Record<string, unknown> | null = engineState) => {
    if (!es) return;
    setErr(""); setBusy(true);
    try {
      const out = await post("/season/play", { state: es, plan: p, store: spec(), night: true, night_choices: picked, band_runs: 20 });
      const result: MonthResult = out.result;
      const idx = done.length;
      const cs = cashAtStart.current[idx];
      const rn: RentN = mode === "hard" ? rentN : 0;
      const rs = rentSchedule([...done.map((m) => m.result.kpis.rent), result.kpis.rent], rn);
      const days = buildDays(result, cs, yearOf(idx), { imputed, draw, interest, rentPaid: rs.paid, rentFee: rs.fee, rentN: rn });
      const entry: Done = { result, plan: p, days, cashStart: cs, cashEnd: days.at(-1)?.cash ?? cs, year: yearOf(idx), picked, rentPaid: rs.paid, rentFee: rs.fee };
      setDone((d) => [...d, entry]);
      setAlts({});
      setEngineState(out.state);
      states.current[idx + 1] = out.state;
      cashAtStart.current[idx + 1] = entry.cashEnd;
      setDayIdx(0); setPlaying(true); setBusy(false); swap(null);
    } catch (e) { setErr(String(e)); setBusy(false); }
  };

  const cur = done.at(-1);
  const scoreMonths = (ds: Done[]): ScoreMonth[] => ds.map((m) => ({
    month: m.result.month, revenue: m.result.kpis.revenue, op: m.result.kpis.op, cogs: m.result.kpis.cogs,
    labor: m.result.kpis.labor, rent: m.result.kpis.rent, mgmt: m.result.kpis.mgmt, fees: m.result.kpis.fees,
    covers: m.result.kpis.covers, walkaways: m.result.kpis.walkaways, util: m.result.kpis.table_utilization ?? 0,
    fatigue: m.result.state_after.fatigue, closed: m.result.closed,
    decisions: m.result.decisions.map((x) => ({ title: x.title, chosen_label: x.chosen_label, vs_default_op: x.vs_default_op })),
  }));
  // 한 달에 현금으로 나가는 고정 지출 평균 (월세·관리비·실제 급여·사장 생활비·이자)
  const monthlyOut = (ds: Done[]) => ds.reduce((a, m) => a + m.result.kpis.rent + m.result.kpis.mgmt + Math.max(0, m.result.kpis.labor - imputed) + draw + interest, 0) / Math.max(1, ds.length);
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
        });
        setLedger(L);
      } catch (e) { setErr(String(e)); }
      return;
    }
    setStrat("rec"); setTweak({});
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
  const { w, d } = roomSize(store.pyeong);
  const state = cur?.result.state_after;
  const cashNow = view === null || view === "settle" || view === "report" ? curDay?.cash ?? startCash : (cashAtStart.current[done.length] ?? startCash);
  const planMonth = monthSeq[Math.min(idx, TURNS - 1)];
  const filled = curDay && curDay.open ? Math.min(stats.seats, Math.round((curDay.covers / Math.max(1, stats.seats * 1.5)) * stats.seats)) : 0;
  const recs = useMemo(() => recommend(cur, plan), [cur, plan]);

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
            <Room w={w} d={d} grade={store.grade} pyeong={store.pyeong} items={store.items} />
            <Items items={store.items} />
            <Guests store={store} filled={view === "intro" || view === "plan" || view === "scenario" ? 0 : filled} />
            <FitControls box={[-w / 2, -d / 2, w / 2, d / 2 + 0.6]} dir={[0.7, 1.2, 1.6]} />
          </Canvas>
        </GLGuard>
        <ViewBar />
      </div>

      <header className="sx-hud">
        <Metric icon={<IconCash />} label="현금" tip={<>문을 열고 남은 운영자금에서 매출과 비용이 날마다 더해지고 빠져요. 월세·급여·생활비·이자는 지급일에 한꺼번에 나가요.</>}>
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
                const changed = before !== null && before[lv.key] !== cur.plan[lv.key];
                return (
                  <div key={lv.key} className={changed ? "is-changed" : undefined}>
                    <dt>{lv.key === "meat_price" && cur.plan.menu?.length ? `메뉴 ${cur.plan.menu.length}개 평균` : lv.label}</dt>
                    <dd>{lv.key === "meat_price" && cur.plan.menu?.length ? `${fmt(menuAvg(cur.plan.menu).price)}원` : lv.text(cur.plan)}</dd>
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
        <aside className="sx-receipt" aria-label="현금 흐름 기록">
          <div className="sx-paper">
            <p className="sx-r-title">현금 흐름 영수증</p>
            <p className="sx-r-sub">{profile.gu}{st.area ? ` ${st.area}` : ""} · 시작 현금 {man(won(cashAtStart.current[0] ?? startCash))}</p>
            <p className="sx-r-acc">회색 줄은 월세·관리비·급여·생활비·이자를 영업일로 나눈 오늘 몫이에요. 실제 돈은 지급일에 한꺼번에 나가요. 이달 누적은 1일부터 오늘까지 고정비 몫까지 뺀 합이에요.</p>
            {receiptDays.length === 0 && <p className="sx-r-empty">아직 찍힌 내역이 없어요. 첫 달이 시작되면 하루씩 쌓여요.</p>}
            {receiptDays.map((x, i) => (
              <section key={`${x.mi}-${x.n}`} className="sx-r-day">
                {(i === 0 || receiptDays[i - 1].mi !== x.mi) && <p className="sx-r-month">{done[x.mi].result.month}월</p>}
                <p className="sx-r-head"><b>{x.date.getMonth() + 1}/{x.date.getDate()} ({DOW_KO[x.date.getDay()]})</b><span>{x.open ? `손님 ${x.covers}명${x.rain ? " · 비" : ""}` : "쉬는 날"}</span></p>
                {x.notes.map((n) => <p key={n} className="sx-r-note">{n}</p>)}
                <ul>
                  {x.ticks.map((t) => <li key={t.label} className={t.amount >= 0 ? "in" : "out"}><span>{t.label}</span><b>{signed(won(t.amount))}</b></li>)}
                  {x.fixedShare > 0 && (() => {
                    const day = x.ticks.filter((t) => ["매출", "재료비", "카드 수수료", "카드·배달 수수료"].includes(t.label)).reduce((a, t) => a + t.amount, 0);
                    return <>
                      <li className="acc"><span>오늘 몫 고정비</span><b>{signed(won(-x.fixedShare))}</b></li>
                      <li className={`acc-sum ${day - x.fixedShare >= 0 ? "in" : "out"}`}><span>고정비까지 빼면</span><b>{signed(won(day - x.fixedShare))}</b></li>
                      <li className={`acc-sum ${x.cum >= 0 ? "in" : "out"}`}><span>이달 누적</span><b>{signed(won(x.cum))}</b></li>
                    </>;
                  })()}
                </ul>
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
                  <h1>{profile.gu}{st.area ? ` ${st.area}` : ""}에서 6개월<ModeSwitch mode={mode} set={(m) => { setMode(m); if (m === "hard" && !plan.menu) setPlan({ ...plan, menu: [{ name: "삼겹살", price: plan.meat_price, cost: 4500, share: 100 }] }); }} /></h1>
                  <p className="sx-note sx-modenote">{mode === "easy" ? <><b>easy 모드</b> · 달마다 방향만 골라요: 추천대로 / 손님 늘리기 / 비용 아끼기. 이달의 사건 대응도 골라요.</> : <><b>hard 모드</b> · 메뉴와 원가를 직접 등록하고, 달마다 가격·알바·마감·반찬·협찬·고기·배달을 하나씩 정해요.</>}</p>
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
                  {RENT_CARD_ON && mode === "hard" && (
                    <fieldset className="sx-mode">
                      <legend>임대료는 어떻게 낼까요? <Assume id="rentFee" /></legend>
                      {([0, 3, 6] as RentN[]).map((n) => (
                        <label key={n} className={rentN === n ? "on" : ""}>
                          <input type="radio" name="rentpay" checked={rentN === n} onChange={() => setRentN(n)} />
                          <span><b>{RENT_PAY[n].label}</b><small>{RENT_PAY[n].desc}</small></span>
                        </label>
                      ))}
                      <small>영업이익은 같고, 현금이 나가는 때만 뒤로 밀려요. 그 대신 수수료만큼 현금이 더 나가요. 시즌 중에는 바꿀 수 없어요.</small>
                    </fieldset>
                  )}
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
                  <h1>{planMonth}월 운영 계획<ModeSwitch locked mode={mode} set={(m) => { setMode(m); if (m === "hard" && !plan.menu) setPlan({ ...plan, menu: [{ name: "삼겹살", price: plan.meat_price, cost: 4500, share: 100 }] }); }} /></h1>
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
                      {mode === "hard" && cur && recs.some((r) => r.change) && (
                        <button type="button" className="sx-ghost" onClick={() => setPlan(recs.reduce((p, r) => (r.change ? { ...p, [r.lever.key]: r.next[r.lever.key] } : p), plan))}>추천대로 적용</button>
                      )}
                      {(() => {
                        const b = bbqBand(plan.menu?.length ? menuAvg(plan.menu).price : plan.meat_price);
                        return <p className="sx-note sx-price">가격 비교 <span className={`sx-badge ${b.tone}`}>{b.band}</span> {b.text}<Assume id="priceRef" what={`비교 기준: ${BBQ_REF.src}. 동네 단위 메뉴 가격 자료가 없어 서울 평균과 비교해요. ±5% 안을 '비슷'으로 봐요 (가정)`} /></p>;
                      })()}
                      <PriceTrend month={planMonth} />
                    </section>
                    {mode === "easy" ? (
                    <section className="sx-right" aria-label="이번 달 방향">
                      <h2>{planMonth}월, 어느 쪽으로 갈까요?</h2>
                      <div className="sx-strats" role="radiogroup">
                        {strategies(cur, plan).map((x) => (
                          <label key={x.id} className={strat === x.id ? "on" : ""}>
                            <input type="radio" name="strat" checked={strat === x.id} onChange={() => setStrat(x.id)} />
                            <span className="sx-strat">
                              <b>{x.title}</b>
                              <small>{x.desc}</small>
                              <span className="sx-strat-chg">{x.changes.length ? x.changes.join(" · ") : "지난달과 같아요"}</span>
                            </span>
                          </label>
                        ))}
                      </div>
                      <QuickPicks picks={BBQ_PICKS} base={strategies(cur, plan).find((x) => x.id === strat)!.plan} tweak={tweak} setTweak={setTweak} />
                      <p className="sx-note">hard 모드에서는 메뉴·원가와 가격·알바·마감·반찬·배달을 하나씩 정할 수 있어요.</p>
                    </section>
                    ) : (
                    <section className="sx-right" aria-label="이번 달 운영 계획">
                      <h2>{planMonth}월에 이렇게 할게요</h2>
                      {mode === "hard" && <MenuEditor plan={plan} set={setPlan} />}
                      <div className="sx-steps">{LEVERS.filter((lv) => !(lv.key === "meat_price" && plan.menu?.length)).map((lv) => <Stepper key={lv.key} lv={lv} plan={plan} prev={cur?.plan} set={setPlan} />)}</div>
                      <p className="sx-note">가격이나 고기를 바꾸면 그달 단골이 조금 빠져요.</p>
                    </section>
                    )}
                  </div>
                  {err && <p className="se-err" role="alert">{err}</p>}
                </div>
                <footer className="sx-foot">
                  <button type="button" className="se-btn" onClick={() => {
                    if (mode === "hard") return void startMonthCall();
                    const chosen = { ...strategies(cur, plan).find((x) => x.id === strat)!.plan, ...tweak };
                    setPlan(chosen);
                    void startMonthCall(chosen);
                  }} disabled={busy}>{busy ? "엔진이 계산 중이에요" : `${planMonth}월 시작`}</button>
                </footer>
              </>
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
                    <p className="sx-note">사장님의 선택이 이번 달 이익을 바꿔요. 장점(+)과 단점(−)을 보고 하나를 골라 주세요. 처음에는 기본 대응이 골라져 있어요.</p>
                  </section>
                  <div className={`sx-dps${dps.points.length === 1 ? " is-single" : ""}`}>
                    {dps.points.map((dp) => (
                      <div key={dp.id} className="sx-dp" role="radiogroup" aria-labelledby={`${dp.id}-h`}
                        style={dps.points.length === 1 ? undefined : { gridRow: `span ${2 + Math.max(...dps.points.map((x) => x.options.length))}` }}>
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
                      (() => {
                        const sc = scoreOf(scoreMonths(done), cashAtStart.current[0] ?? startCash, Math.min(cashAtStart.current[0] ?? startCash, ...done.flatMap((m) => m.days.map((d) => d.cash))),
                          cur.cashEnd, monthlyOut(done));
                        return { label: `지금까지 점수 (${done.length}/${TURNS}개월)`, value: `${sc.total}점 · ${SCORE_GRADES.find((g) => sc.total >= g.min)!.label}` };
                      })(),
                    ]} />
                    {flowRatioNote(dongCode, profile.gu, r.kpis.covers) && <p className="sx-note">{flowRatioNote(dongCode, profile.gu, r.kpis.covers)}</p>}
                    {r.closed && <p className="se-err">현금이 두 달 연속 바닥이라 가게를 닫게 됐어요.</p>}

                    <div className="sx-settle">
                      <section className="sx-sec">
                        <h2>정산표</h2>
                        <SettleTable m={r} imputed={imputed} dep={dep} interest={interest} rent={cur && mode === "hard" && rentN ? { n: rentN, paid: cur.rentPaid, fee: cur.rentFee, left: rentSchedule(done.map((x) => x.result.kpis.rent), rentN).left } : undefined} />
                        <small>월말 현금은 영업이익에서 사장 생활비 {man(won(draw))}와 이자를 빼고, 사장 가상 급여는 되돌린 값이에요.</small>
                      </section>
                      <section className="sx-sec">
                        <h2>이번 달 사건</h2>
                        {r.events.length === 0 ? <p className="sx-note">특별한 사건은 없었어요.</p> : (
                          <ul className="sx-evs">{r.events.map((e) => <li key={e.id}><b>{e.label}</b>{e.mechanism ? <span>{e.mechanism}</span> : null}</li>)}</ul>
                        )}
                        {r.reviews.length > 0 && <p className="sx-note">새 리뷰 {r.reviews.length}건, 평균 ★ {(r.reviews.reduce((a, x) => a + x.stars, 0) / r.reviews.length).toFixed(1)}</p>}
                      </section>
                    </div>
                    <CashFlow months={cfOf(done)} kind="food" shop="고깃집" />

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
                  <h1>{done.length}개월 결과</h1>
                  {!ledger ? <p>계산 중이에요.</p> : (
                    <>
                      <Scorecard
                        months={scoreMonths(done)}
                        startCash={ledger.start_cash} lowestCash={ledger.lowest_cash} endCash={ledger.end_cash}
                        monthlyCashOut={monthlyOut(done)}
                        gu={profile.gu} mode={mode} seed={seed}
                        plans={done.map((x) => LEVERS.map((lv) => `${lv.label} ${lv.text(x.plan)}`).join(" · "))}
                      />
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
                        <CashFlow months={cfOf(done)} kind="food" shop="고깃집" />
                      </section>
                      <section className="sx-sec">
                        <h2>월별 현금</h2>
                        <table className="sx-table">
                          <thead><tr><th>달</th><th>영업이익</th><th>이자</th><th>생활비 반영 현금 변화</th><th>월말 현금</th></tr></thead>
                          <tbody>{ledger.rows.map((x) => (
                            <tr key={x.month}><td>{monthSeq[x.month - 1]}월</td><td>{signed(won(x.op))}</td><td>−{man(won(x.interest))}</td><td>{signed(won(x.net))}</td><td>{man(won(x.cash))}</td></tr>
                          ))}</tbody>
                        </table>
                      </section>
                      <section className="sx-sec">
                        <h2>달마다의 정산표</h2>
                        {done.map((m, i) => (
                          <details key={i} className="sx-det" open={i === done.length - 1}>
                            <summary><b>{m.result.month}월</b><span className={tone(m.result.kpis.op)}>영업이익 {signedMan(m.result.kpis.op)}</span><span>월말 현금 {man(won(m.cashEnd))}</span></summary>
                            <SettleTable m={m.result} imputed={imputed} dep={dep} interest={interest} rent={m.rentFee || mode === "hard" && rentN ? { n: mode === "hard" ? rentN : 0, paid: m.rentPaid, fee: m.rentFee, left: rentSchedule(done.slice(0, i + 1).map((x) => x.result.kpis.rent), mode === "hard" ? rentN : 0).left } : undefined} />
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
