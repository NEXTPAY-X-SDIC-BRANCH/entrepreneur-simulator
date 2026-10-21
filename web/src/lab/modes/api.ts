// lab:modes — engine calls for 이지 모드 and 민감도 (api/lab_modes.py). Amounts from the engine are 원; inputs are 만원.
export const ENGINE = (import.meta.env.VITE_ENGINE_API as string | undefined) ?? "http://127.0.0.1:8010";

export async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${ENGINE}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await r.text();
  let j: any = null;
  try { j = JSON.parse(text); } catch { /* not JSON */ }
  if (!r.ok) throw new Error(typeof j?.detail === "string" ? j.detail : (text || `${r.status}`).slice(0, 200));
  return j as T;
}

export const netErr = (e: unknown) =>
  /fetch|network/i.test(String(e)) ? "엔진 서버에 연결하지 못했어요. 엔진 서버(api.changeup)가 켜져 있는지 확인해 주세요." : String((e as Error)?.message ?? e);

export type Src = "공공 통계" | "업계 자료" | "가정" | "입력";
export type Shown = { key: string; label: string; value: number | string; unit: string; src: Src; basis: string };
export type Overrides = { pyeong?: number; tables?: number; staff?: number; price?: number; loan_man?: number };
export type EasyIndustry = string; // "bbq" | "cafe" | 새 업종 id (lab:industry LAB_IDS)
export type EasyReq = { industry: EasyIndustry; gu: string; dong?: string | null; capital_man: number; pyeong?: number | null; start_month: number; overrides?: Overrides };

export type EasyInputs = {
  industry: EasyIndustry; gu: string; dong: string | null; capital_man: number; shown: Shown[];
  run: Record<string, any>; opening: { key: string; label: string; amount: number }[];
  // bbq
  store?: { pyeong: number; tables: number; seats: number }; staff: number; price?: number; loan_man?: number; loan_rate?: number;
  opening_total?: number; fits_capital?: boolean; safe_by_rule?: boolean;
  // cafe, 새 업종
  pyeong?: number; tables?: number;
};

// /season/run (api/changeup.py season_run) — only the fields the adapters read
export type BbqMonth = {
  month: number; month_index: number; label: string; kpis: Record<string, number>;
  state_after: { cash: number; rating: number }; closed: boolean; closed_reason: string | null;
};
export type BbqRun = {
  months: BbqMonth[]; closed: boolean; closed_reason: string | null;
  ledger: { rows: { month: number; op: number; cash: number }[]; start_cash: number; end_cash: number; lowest_cash: number };
};
// sim/cafe/season.py public_month / public_start / report
export type CafeMonth = {
  month: number; calendar_month: number; status: string;
  kpi: { revenue_krw: number; op_krw: number; cash_krw: number; customers: number; walkaways: number; rating: number };
  pnl: { lines: { key: string; item_ko: string; krw: number }[]; depreciation_krw: number; op_krw: number };
  closure: { closed: boolean; reason_ko: string | null };
};
export type CafeRun = {
  start: { start: { cash_krw: number; capex_krw: number; loan_krw: number }; loan: { rate: number } };
  months: CafeMonth[]; report: { survived: boolean; end_cash_krw: number; cumulative_op_krw: number; summary_ko: string };
};
// sim/generic/season.py (lab:industry) — public_month and report; report.season_summary already has the SeasonSummary shape
export type GenericMonth = {
  month: number; calendar_month: number; status: string; kpi: { revenue_krw: number; op_krw: number; cash_krw: number };
  cash: { depreciation_addback_krw: number }; closure: { closed: boolean; reason_ko: string | null };
};
export type GenericRun = {
  start: { start_cash_krw: number; loan: { principal_krw: number; rate: number } }; months: GenericMonth[];
  report: { survived: boolean; end_cash_krw: number; cumulative_op_krw: number; summary_ko: string; season_summary: import("../types").SeasonSummary };
};
export type EasyRes = { inputs: EasyInputs; bbq?: BbqRun; cafe?: CafeRun; generic?: GenericRun };

export const easyRun = (req: EasyReq) => post<EasyRes>("/lab/easy/run", req);

// 민감도
export type Cell = { ops: number[]; revenue: number; cum_op: number; end_cash: number; lowest_cash: number; closed: boolean; closed_month: number | null };
export type Factor = { key: string; label: string; pct: number; low: Cell; high: Cell; good: "high" | "low"; swing: number };
export type Sens = {
  industry: string; ranges: Record<string, number>; base: Cell; factors: Factor[];
  grid: { x: { key: string; label: string; pct: number }; y: { key: string; label: string; pct: number }; cells: Cell[][] };
  worst: Cell; best: Cell; runs: number; note: string;
};
export const sensitivity = (industry: string, body: Record<string, unknown>, ranges: Record<string, number>) =>
  post<Sens>("/lab/sensitivity", { industry, body, ranges });
