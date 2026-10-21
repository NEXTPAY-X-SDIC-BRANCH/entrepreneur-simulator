// lab:score — 화면이 가진 6개월 결과를 SeasonSummary(web/src/lab/types.ts)로 바꾼다. 엔진을 다시 돌리지 않는다.
import type { MonthLine, SeasonSummary } from "../types";

type Kpis = Record<string, number>;
type BbqMonth = {
  result: { month: number; kpis: Kpis; state_after: { rating: number }; closed: boolean; closed_reason: string | null };
  cashEnd: number; plan: Record<string, unknown>;
};

// 고깃집 (SimulateEngine.tsx). 현금은 화면의 현금 기록(생활비·이자를 뺀 월말 현금)을 쓴다.
export function bbqSummary(done: BbqMonth[], o: {
  startCash: number; openingCost: number; loan: number; loanRate: number; inputs: Record<string, unknown>;
}): SeasonSummary {
  const months: MonthLine[] = done.map((m) => {
    const k = m.result.kpis;
    return {
      month: m.result.month, revenue: k.revenue, op: k.op, covers: k.covers, cogs: k.cogs, labor: k.labor, rent: k.rent,
      mgmt: k.mgmt, fees: k.fees, cash_after: m.cashEnd, satisfaction: k.satisfaction, rating: m.result.state_after.rating,
      walkaways: k.walkaways,
    };
  });
  const last = done.at(-1);
  return {
    industry: "bbq", mode: "free", start_cash: o.startCash, opening_cost: o.openingCost, loan: o.loan, loan_rate: o.loanRate,
    months, closed: !!last?.result.closed, closed_reason: last?.result.closed_reason ?? null,
    inputs: { ...(last?.plan ?? {}), ...o.inputs, plans: done.map((m) => m.plan) },
  };
}

type CafeMonth = {
  calendar_month: number; decisions: Record<string, unknown>;
  kpi: { revenue_krw: number; op_krw: number; cash_krw: number; customers: number; walkaways: number; rating: number };
  pnl: { revenue_krw: number; lines: { key: string; krw: number }[]; op_krw: number };
  closure: { closed: boolean };
};

// 카페 (CafeSim.tsx). 운영비 = 매출 − 영업이익 − 나머지 비용 (감가상각·포장재·공과금·마케팅 등 전부)
export function cafeSummary(months: CafeMonth[], start: { cash_krw: number; capex_krw: number; loan_krw: number }, inputs: Record<string, unknown>): SeasonSummary {
  const lines: MonthLine[] = months.map((m) => {
    const L: Record<string, number> = Object.fromEntries(m.pnl.lines.map((x) => [x.key, x.krw]));
    const cogs = (L.food ?? 0) + (L.dessert_waste ?? 0), labor = L.labor ?? 0, rent = L.rent ?? 0, fees = L.card ?? 0;
    const revenue = m.pnl.revenue_krw, op = m.kpi.op_krw;
    return {
      month: m.calendar_month, revenue, op, covers: m.kpi.customers, cogs, labor, rent, fees,
      mgmt: revenue - op - cogs - labor - rent - fees, cash_after: m.kpi.cash_krw, rating: m.kpi.rating, walkaways: m.kpi.walkaways,
    };
  });
  const last = months.at(-1);
  return {
    industry: "cafe", mode: "free", start_cash: start.cash_krw, opening_cost: start.capex_krw, loan: start.loan_krw,
    months: lines, closed: !!last?.closure.closed, closed_reason: last?.closure.closed ? "cash" : null,
    inputs: { ...(last?.decisions ?? {}), ...inputs, plans: months.map((m) => m.decisions) },
  };
}
