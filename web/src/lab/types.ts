// lab shared types (score lane owns this file; other lanes import it).
// Shapes are binding per LAB_CONTRACT.md "Cross-lane API shapes".

export type Industry = "bbq" | "cafe" | string; // industry lane adds ids, e.g. "chicken", "bunsik"

export interface MonthLine {
  month: number; // calendar month 1-12
  revenue: number;
  op: number;
  covers: number; // 원, 원, 명
  cogs: number;
  labor: number;
  rent: number;
  mgmt: number;
  fees: number; // 원 (mgmt = 매장 운영비 total)
  opex_detail?: Record<string, number>; // cost lane: 공과금, 소모품, 수선, 보험, 마케팅 ... (원)
  rent_card_fee?: number; // finance lane
  cash_after: number;
  satisfaction?: number;
  rating?: number;
  walkaways?: number;
}

export interface SeasonSummary {
  industry: Industry;
  mode: "easy" | "hard" | "free";
  start_cash: number;
  opening_cost: number;
  loan: number;
  loan_rate?: number;
  months: MonthLine[];
  closed: boolean;
  closed_reason?: string | null;
  inputs: Record<string, unknown>; // what the learner chose (for the coach and for retry diffs)
  attempt?: number; // modes lane: 1, 2, 3 ...
}

// Score (score lane) — POST /score on the engine port
export type ScoreBand = "fit" | "train" | "rethink";
export type ScorePartKey = "profit" | "survival" | "cash" | "customer" | "cost" | "risk";

export interface ScorePart {
  key: ScorePartKey;
  label: string;
  score: number;
  max: number;
  why: string;
}

export interface ScoreFix {
  key: string;
  text: string; // 다음 판에서 바꿔 볼 것
  lever: string; // staff_per_shift | price | ...
  expected: string;
}

export interface Score {
  total: number; // 0-100
  band: ScoreBand;
  band_label: "창업 적격" | "훈련 필요" | "창업 재검토";
  parts: ScorePart[];
  fixes: ScoreFix[];
  version: string; // "score-v1"
}
