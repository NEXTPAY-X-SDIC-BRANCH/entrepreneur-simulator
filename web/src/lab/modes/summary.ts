// lab:modes — season results → SeasonSummary (web/src/lab/types.ts, the score lane's input). All amounts 원.
import type { MonthLine, SeasonSummary } from "../types";
import type { EngineCtx } from "../../mock/chatContext";
import type { BbqRun, CafeRun, EasyInputs } from "./api";

// What the learner chose, flattened for the coach and for the retry diff. Keys are shared across modes so a diff
// between an easy attempt and a hard attempt still lines up.
export type Inputs = {
  gu: string; dong: string | null; capital_man: number; pyeong: number; staff: number; loan_man: number;
  tables?: number; price?: number; daily_customers?: number; start_month?: number; grade?: string;
};

export function easyInputsOf(i: EasyInputs): Inputs {
  if (i.industry === "cafe") {
    return { gu: i.gu, dong: i.dong, capital_man: i.capital_man, pyeong: i.pyeong ?? 0, staff: i.staff, loan_man: 0,
      daily_customers: i.run.daily_customers, start_month: i.run.start_month, grade: "basic" };
  }
  return { gu: i.gu, dong: i.dong, capital_man: i.capital_man, pyeong: i.store?.pyeong ?? 0, tables: i.store?.tables, staff: i.staff,
    price: i.price, loan_man: i.loan_man ?? 0, start_month: i.run.store?.start_month, grade: "basic" };
}

export function bbqSummary(run: BbqRun, inv: Record<string, number>, loan: { principal: number; annual_rate: number } | null,
  inputs: Inputs, mode: SeasonSummary["mode"], attempt: number): SeasonSummary {
  const months: MonthLine[] = run.months.map((m, i) => ({
    month: m.month, revenue: m.kpis.revenue, op: m.kpis.op, covers: m.kpis.covers, cogs: m.kpis.cogs, labor: m.kpis.labor,
    rent: m.kpis.rent, mgmt: m.kpis.mgmt, fees: m.kpis.fees, cash_after: run.ledger.rows[i]?.cash ?? m.state_after.cash,
    satisfaction: m.kpis.satisfaction, rating: m.state_after.rating, walkaways: m.kpis.walkaways,
  }));
  return {
    industry: "bbq", mode, start_cash: run.ledger.start_cash, opening_cost: Object.values(inv).reduce((a, b) => a + b, 0),
    loan: loan?.principal ?? 0, loan_rate: loan?.annual_rate, months, closed: run.closed, closed_reason: run.closed_reason,
    inputs: { ...inputs }, attempt,
  };
}

const CAFE_COGS = new Set(["food"]), CAFE_FEES = new Set(["card"]);
export function cafeSummary(run: CafeRun, inputs: Inputs, mode: SeasonSummary["mode"], attempt: number): SeasonSummary {
  const months: MonthLine[] = run.months.map((m) => {
    const L = m.pnl.lines;
    const sum = (f: (k: string) => boolean) => L.filter((x) => f(x.key)).reduce((a, x) => a + x.krw, 0);
    const detail: Record<string, number> = {};
    for (const x of L) if (!["food", "card", "rent", "labor"].includes(x.key) && x.krw) detail[x.item_ko] = x.krw;
    if (m.pnl.depreciation_krw) detail["감가상각"] = m.pnl.depreciation_krw; // 카페 엔진의 영업이익은 감가상각을 뺀 값이라 운영비에 넣어 합을 맞춘다
    return {
      month: m.calendar_month, revenue: m.kpi.revenue_krw, op: m.kpi.op_krw, covers: m.kpi.customers,
      cogs: sum((k) => CAFE_COGS.has(k)), labor: sum((k) => k === "labor"), rent: sum((k) => k === "rent"),
      mgmt: sum((k) => !CAFE_COGS.has(k) && !CAFE_FEES.has(k) && k !== "labor" && k !== "rent") + m.pnl.depreciation_krw,
      fees: sum((k) => CAFE_FEES.has(k)), opex_detail: detail, cash_after: m.kpi.cash_krw, rating: m.kpi.rating, walkaways: m.kpi.walkaways,
    };
  });
  const last = run.months.at(-1);
  return {
    industry: "cafe", mode, start_cash: run.start.start.cash_krw, opening_cost: run.start.start.capex_krw, loan: run.start.start.loan_krw,
    loan_rate: run.start.loan.rate, months, closed: !run.report.survived, closed_reason: last?.closure.reason_ko ?? null,
    inputs: { ...inputs, loan_man: Math.round(run.start.start.loan_krw / 1e4) }, attempt,
  };
}

// 하드 모드 고깃집: SimulateEngine이 챗봇용으로 넘기는 결과(chatContext)를 그대로 읽는다. SimulateEngine은 고치지 않는다.
export function hardBbqSummary(ctx: EngineCtx, startCash: number, openingCost: number, loanWon: number, loanRate: number,
  inputs: Inputs, attempt: number): SeasonSummary {
  return {
    industry: "bbq", mode: "hard", start_cash: startCash, opening_cost: openingCost, loan: loanWon, loan_rate: loanRate,
    months: ctx.months.map((m) => ({ month: m.month, revenue: m.revenue, op: m.op, covers: m.covers, cogs: m.cogs, labor: m.labor,
      rent: m.rent, mgmt: m.mgmt, fees: m.fees, cash_after: m.cash_end })),
    closed: ctx.closed, closed_reason: ctx.closed ? "현금이 바닥나 폐업" : null, inputs: { ...inputs }, attempt,
  };
}

// ---- 지난 판과 바뀐 것 -----------------------------------------------------------------------------------
const LABEL: Record<string, [string, (v: any) => string]> = {
  gu: ["구", (v) => String(v)],
  dong: ["동네", (v) => v ?? "구 전체"],
  capital_man: ["가진 돈", (v) => `${Number(v).toLocaleString("ko-KR")}만원`],
  pyeong: ["평수", (v) => `${v}평`],
  tables: ["4인 테이블", (v) => `${v}개`],
  staff: ["교대당 알바", (v) => `${v}명`],
  price: ["삼겹살 1인분", (v) => `${Number(v).toLocaleString("ko-KR")}원`],
  loan_man: ["대출", (v) => `${Math.round(Number(v)).toLocaleString("ko-KR")}만원`],
  daily_customers: ["바쁜 날 주문 수", (v) => `${v}건`],
  start_month: ["여는 달", (v) => `${v}월`],
  grade: ["인테리어 등급", (v) => ({ basic: "기본", mid: "중급", high: "고급" } as Record<string, string>)[v] ?? String(v)],
};
export type DiffRow = { key: string; label: string; before: string; after: string; changed: boolean };
export function diffInputs(a: Record<string, unknown>, b: Record<string, unknown>, industry: string): DiffRow[] {
  const keys = Object.keys(LABEL).filter((k) => (a[k] !== undefined || b[k] !== undefined));
  return keys.map((k) => {
    const [label, f] = LABEL[k];
    const shown = industry === "cafe" && k === "staff" ? "바쁜 시간 직원" : label;
    const fa = a[k] === undefined ? "없음" : f(a[k]), fb = b[k] === undefined ? "없음" : f(b[k]);
    return { key: k, label: shown, before: fa, after: fb, changed: fa !== fb };
  });
}

export const cumOp = (s: SeasonSummary) => s.months.reduce((a, m) => a + m.op, 0);
