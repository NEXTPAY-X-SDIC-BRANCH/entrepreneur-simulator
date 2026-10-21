// pork_forecast.json (pipelines/build_pork_forecast.py). Contract: LAB_CONTRACT.md "Pork forecast".
export type Source = { title: string; publisher: string; url: string | null; page?: number };
export type Band = { mid: number; lo: number; hi: number; h: number };
export type Backtest = { method: string; n: number; mape_1_6: number | null; mape_1_12: number | null; mape_1_6_last12: number | null; by_h: Record<string, number | null> };
export type DiseaseEvent = {
  date: string; kind: string; species: string; label: string; note: string; source: Source;
  window?: string; price_before?: number; price_after?: number; change_pct?: number; deseason_change_pct?: number;
};
export type Driver = {
  kind: "season" | "disease" | "weather" | "supply" | "outlook";
  label: string; summary: string; evidence: string; basis: string; sources: Source[];
  data: Record<string, unknown> | null;
};
export type Part = { latest: number; month: string; mom_pct: number; yoy_pct: number | null; history: Record<string, number> };
export type PorkForecast = {
  _meta: {
    source: string; unit: string; series: string; method: string; method_key: string; backtest_mape: number;
    backtest_note: string; interval: string; selection_note: string; basis_date: string; generated: string; history_from: string; label: string;
  };
  history: Record<string, number>;
  forecast: Record<string, Band>;
  backtest: Record<string, Backtest>;
  carcass: { series: string; history: Record<string, number>; forecast: Record<string, Band>; method_key: string; backtest: Record<string, Backtest> };
  parts: Record<string, Part>;
  parts_source: Source;
  cost_mult: { base_month: string; base_value: number; by_month: Record<string, number>; note: string; next6_mean: number; last_year_next6_mean: number | null };
  latest?: {
    fetched?: string;
    belly_weeks: { week: string; range: string; belly: number }[];
    carcass_mtd?: { month: string; from: string; to: string; exj_ex_out: number } | null;
    belly_vs?: { month: string; lo: number; hi: number; mid: number; where: "in" | "above" | "below" };
  };
  drivers: Driver[];
};

export const METHOD_KO: Record<string, string> = {
  ceo_cpi: "대표님 방식 (작년 같은 달 × 물가 상승률)",
  ceo: "대표님 방식 변형 (작년 같은 달 × 도매가 상승률)",
  seasonal: "계절지수 × 추세",
  naive: "지난달 값 그대로 (비교 기준)",
};

export const ym = (k: string) => `${k.slice(0, 4)}.${k.slice(4)}`;          // "202610" -> "2026.10"
export const mon = (k: string) => `${Number(k.slice(4))}월`;
export const won = (v: number) => Math.round(v).toLocaleString("ko-KR");
export const signed = (v: number | null | undefined, d = 1) => (v == null ? "–" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}%`);
