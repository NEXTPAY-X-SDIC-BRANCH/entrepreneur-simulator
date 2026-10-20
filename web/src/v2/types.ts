// v2 contract shapes (docs/GAME-V2-SPEC.md §11) exactly as sim/season.py and api/main.py emit them.
// The web reads only these; nightOf() turns night_events into the 3D replay's night.
import type { SegmentId, SimEvent } from "../data";

export type MeatGrade = "imported" | "domestic" | "aged";
export type MenuExtra = "naengsam" | "tongsam" | "minari";
export type Hygiene = "basic" | "normal" | "high";
export type Weather = "clear" | "rain" | "snow";

export type Plan = {
  meat_price: number;
  soju_price: number;
  meat_grade: MeatGrade;
  menu_extras: MenuExtra[];
  banchan: number;
  staff_grilling: boolean;
  staff_per_shift: number;
  close_hour: number; // 23 | 24 | 25 (= 01시)
  lunch: boolean;
  terrace: boolean;
  marketing_budget: number;
  review_event: boolean;
  group_reservations: boolean;
  hygiene: Hygiene;
};

export const BASE_PLAN: Plan = {
  meat_price: 19000, soju_price: 5000, meat_grade: "domestic", menu_extras: [], banchan: 5, staff_grilling: false,
  staff_per_shift: 2, close_hour: 24, lunch: false, terrace: true, marketing_budget: 0, review_event: false,
  group_reservations: false, hygiene: "normal",
};

export type BubbleObj = { code: string; text: string };
export type NightEvent = SimEvent & { bubble?: BubbleObj; satisfaction?: number };
export type NightHeader = { dow: string; rain: boolean; weather?: Weather; terrace_open: boolean; tables_available: number; servers: number; open_clock: string; close_hour: number };

// what the 3D store draws
export type NightV2 = {
  dow: string;
  terrace_open: boolean;
  tables_available: number;
  open_clock: string;
  close_hour?: number;
  staff?: number;
  weather?: Weather;
  competitor?: boolean;
  festival?: boolean;
  events: NightEvent[];
};

// the month's drawn events before play (GET /season/{id} state.month_events, play → next_month_events)
export type MonthEvent = { id: string; label: string; kind?: string | null; effect?: string | null; tag?: string | null };

export type SeasonEvent = { id: string; label: string; group?: string; mechanism?: string; tag: string; detail?: string };
export type Kpis = Record<string, number>;
export type Draw = { kpis: Kpis; p10: Kpis; p50: Kpis; p90: Kpis; op_percentile?: number; band_runs?: number };
export type WaterfallStep = { driver: string; key: string; delta: number; kind: "start" | "step" | "end"; note?: string | null; levers?: (keyof Plan)[]; events?: string[] };
export type Flags = { competitor: boolean; rent_mult: number; wage_mult: number };
export type HistoryRow = { month: number; label: string; op: number; cash: number; rating: number; events: string[] };
export type SeasonState = {
  engine?: string;
  mode?: string;
  seed?: number;
  month_index: number;
  cash: number;
  rating: number;
  rating_recent?: number;
  rating_all?: number;
  review_count: number;
  awareness: number;
  regular_share: number;
  fatigue: number;
  negative_months: number;
  low_revenue_months?: number;
  closed: boolean;
  closed_reason?: "cash" | "revenue" | null;
  plan: Plan;
  flags: Flags;
  history: HistoryRow[];
  month_events?: MonthEvent[] | null;
};
export type Review = {
  id: string;
  month?: string;
  segment: SegmentId;
  segment_ko?: string;
  stars: number;
  party_size?: number;
  wait_min?: number;
  walked_away?: boolean;
  satisfaction?: number;
  reason_codes: string[];
  shown_codes?: string[];
  levers?: string[];
  cause_levers?: string[];
  cause_events?: string[]; // chips consistent with the stars (agents/persona); falls back to reason_codes
  event_label?: string | null;
  text_meta?: { main: "positive" | "complaint" | "neutral"; caveats?: string[]; complaints?: string[] };
  incentivized?: boolean;
  dow?: string;
  text?: string;
};
export type Label = { mechanism: string; label: string; tag: string; downside?: string; detail?: string };
export type Calendar = { label: string; note?: string; demand_index: number; tags?: Record<string, string> };
export type OwnerLine = { mood?: "great" | "ok" | "worried" | "desperate"; text: string; codes?: string[]; placeholder?: boolean; event_lines?: Record<string, string> };

export type MonthResult = {
  engine?: string;
  month: number; // calendar month (10, 11, ...)
  month_index: number;
  calendar: Calendar;
  events: SeasonEvent[];
  plan: Plan;
  draw: Draw;
  demand_factors?: Record<string, number>;
  waterfall: WaterfallStep[];
  state_before?: Partial<SeasonState>;
  state_after: SeasonState;
  reviews: Review[];
  reviews_total?: number;
  owner_line: OwnerLine;
  night_events: (NightEvent | { night: NightHeader })[];
  labels: Label[];
  persona_backend?: string;
  season_end?: SeasonEnd | null;
  shadow?: { basis: string; kpis: Kpis } | null;
  next_month_events?: MonthEvent[];
  night_decisions?: NightDecision[];
  decision_points?: DecisionPoint[];
};

export type SeasonEnd = {
  cash: number; forward_value: number; store_value: number; horizon_months: number; closed: boolean; tag: string; basis?: string;
  label?: string; reputation_effect?: number;
  drivers?: Record<string, { end: number; start: number }>;
};

export type PlanPreview = {
  month: number;
  calendar?: { label: string; demand_index: number };
  events?: string[];
  plan: Plan;
  expected: Kpis;
  state_next: { fatigue: number; quit_risk: number; cash: number };
  vs_base: { op: number; revenue: number; base_op?: number; basis?: string };
  vs_baseline?: { base_op: number; op: number; label_ko: string; events_ko: string[] };   // vs the tour's 평소 달 (sim.season.baseline_month)
  op_range?: { p10: number; p90: number; tag: string; error?: number; overload?: boolean };
  risks?: { id: string; label: string; prob: number; op_delta: number; tag: string }[];
  lunch?: { revenue: number; cost: number; net: number } | null;
  sensitivity?: Sensitivity;
  warnings: (string | { code: string; text: string })[];
  warning_codes?: string[];
  labels: Label[];
};

export type SeasonView = {
  id: string;
  mode: string;
  seed: number;
  engine: string;
  state: SeasonState;
  months: MonthResult[];
  months_played: number;
  months_total: number;
  default_plan?: Plan;
  month_events?: MonthEvent[];
};

export type SurveyItem = { guide_q: number; question: string | null; answer: string; rows?: unknown[]; used: { key: string; value: unknown; source: string }[] };
export type Survey = { season_id: string; items: SurveyItem[] };
export type Citation = { label: string; title?: string | null; source_id?: string | null; doc_id: string };
export type AskAnswer = { who: string; answer: string; backend?: string; numbers_from?: string[]; sources?: unknown[]; citations?: Citation[] };

export function nightOf(m: Pick<MonthResult, "night_events" | "events" | "state_after" | "plan">): NightV2 {
  const head = (m.night_events.find((e) => "night" in e) as { night: NightHeader } | undefined)?.night;
  const events = m.night_events.filter((e): e is NightEvent => !("night" in e));
  const ids = new Set(m.events.map((e) => e.id));
  const snow = ids.has("cold_wave");
  return {
    dow: head?.dow ?? "sat",
    terrace_open: head?.terrace_open ?? m.plan.terrace,
    tables_available: head?.tables_available ?? 12,
    open_clock: head?.open_clock ?? "17:00",
    close_hour: head?.close_hour ?? m.plan.close_hour,
    staff: head ? Math.max(0, head.servers - 1) : m.plan.staff_per_shift,
    weather: head?.weather ?? (head?.rain ? "rain" : snow ? "snow" : "clear"),
    competitor: Boolean(m.state_after?.flags?.competitor) || ids.has("competitor_open"),
    festival: ids.has("festival_week") || ids.has("viral_blog"),
    events,
  };
}

// §12.1 in-night decision points
export type DecisionOption = { id: string; label_ko: string; effect_hint_ko: string; tag: string; source_id?: string | null; downside_ko: string; owner_foresight?: string };
export type DecisionPoint = { id: string; kind: string; title_ko?: string; clock_min: number; clock: string; prompt_ko: string; default: string;
  monthly_count: number; count_tag: string; options: DecisionOption[]; owner_prompt?: string };
export type MonthStart = { month: number; month_index: number; calendar: Calendar; events: SeasonEvent[]; plan: Plan;
  night: { night: NightHeader; events: NightEvent[] }; decision_points: DecisionPoint[]; events_used?: string[] };
export type NightDecision = { id: string; kind: string; option_id: string; monthly_count: number; night_delta?: Kpis; month_delta?: Kpis; vs_default_op?: number };
// §12.2
export type SensDelta = { op: number; covers: number; rating_recent: number; fatigue: number; runway_months: number | null };
export type Sensitivity = Record<string, { up: SensDelta | null; down: SensDelta | null; step: string }>;
