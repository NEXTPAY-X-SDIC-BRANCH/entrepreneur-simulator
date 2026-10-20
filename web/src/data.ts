// Loaders and types for web/public/data (written by web/scripts/sync_data.py). All values illustrative.
import { useEffect, useState } from "react";

export type Hero = {
  tables: number;
  seats_per_table: number;
  terrace_tables: number;
  servers: number;
  open_hours: number;
  open_clock: string;
  meat_price: number;
  soju_price: number;
  area_pyeong: number;
  pnl: Record<string, number>;
  owner_wage?: number;
  review?: { reviewed: number; total: number };
};

export type SegmentId = "twenties" | "office" | "family";

export type SimEvent = {
  segment?: SegmentId;
  t: number;
  clock: string;
  type: "arrive" | "queue" | "balk" | "seat" | "order" | "leave" | "table_ready";
  party: number | null;
  size?: number;
  table_id?: string;
  tables?: string[]; // a large walk-in group seated across two tables (§12.1)
  closed?: boolean; // turned away at the door (not seating new guests, or meat ran out)
  waited?: number;
  bill?: number;
  portions?: number;
  bottles?: number;
  meals?: number;
  reorder?: boolean;
  queue_len?: number;
};

export type Night = { dow: string; terrace_open: boolean; tables_available: number; open_clock: string; events: SimEvent[] };
export type EventsFile = { seed: number; base: Night; shocked: Night | null };

export type Band = { p10: number; p50: number; p90: number };
export type KpiFile = {
  meta: { runs: number; seed: number };
  shock: { id: string; driver: string; params: ShockParam[] };
  base: Record<string, Band>;
  shocked: Record<string, Band>;
  delta_p50: Record<string, number>;
};

export type ShockParam = {
  parameter: string;
  delta_type: "pct" | "abs" | "set";
  low: number;
  base: number;
  high: number;
  mechanism: string;
  rationale: string;
  confidence: string;
  source_id: string | null;
};
export type Shocks = Record<string, { driver: string; params: ShockParam[] }>;

export type OntNode = {
  id: string;
  ko: string;
  en: string;
  category: string;
  parent: string | null;
  unit: string;
  method: string;
  in_sim: boolean;
  source: string | null;
  base: number | string | null;
  low: number | string | null;
  high: number | string | null;
  confidence: string | null;
  reviewed?: boolean; // reviewed_by is filled in research/hero_base.yaml
  formula?: string | null; // the '= …' clause of criteria.csv notes, when it is a formula in Korean terms
};
export type Ontology = { nodes: OntNode[]; edges: { from: string; to: string; sign: string; why: string; confidence?: string; source?: string | null }[] };

export type District = {
  areas: { code: string; name: string; geometry: { type: string; coordinates: unknown } }[];
  stores: { lon: number; lat: number; code: string; role: string; trdar: string; franchise: boolean }[];
  profile: {
    quarter: string;
    hansik_stores: number;
    pork_stores: number;
    evening_share: number;
    age20_share: number;
    timeband_share: Record<string, number>;
    dow_share: Record<string, number>;
    sales_per_store_month: number;
  };
};

const cache = new Map<string, Promise<unknown>>();

export function load<T>(path: string): Promise<T> {
  if (!cache.has(path)) {
    cache.set(path, fetch(path.startsWith("runs/") ? `./${path}` : `./data/${path}`).then((r) => {
      if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
      return r.json();
    }));
  }
  return cache.get(path) as Promise<T>;
}

export function useData<T>(path: string | null): T | null {
  const [v, setV] = useState<T | null>(null);
  useEffect(() => {
    let live = true;
    setV(null);
    if (path) load<T>(path).then((d) => live && setV(d));
    return () => {
      live = false;
    };
  }, [path]);
  return v;
}

// Shock labels in plain Korean (the Shocks sheet has the mechanism; these are picker names).
export const SHOCK_LABELS: Record<string, string> = {
  SH01: "고기 가격 10% 인상",
  SH02: "고기 가격 10% 인하",
  SH03: "돼지고기 도매가 8% 상승",
  SH04: "소주 가격 1,000원 인상",
  SH05: "1인당 음주량 20% 감소",
  SH06: "알바 시급 5% 인상",
  SH07: "교대당 알바 1명 감축",
  SH08: "재계약 임대료 5% 인상",
  SH09: "방학 수요 8% 감소",
  SH10: "비 오는 밤이 평년만큼 (한 달 6일)",
  SH10b: "한 달 내내 비 (최악의 경우)",
  SH11: "근처 경쟁 고깃집 개점",
};

export const SHOCK_IF: Record<string, string> = {
  SH01: "고기 가격을 10% 올리면",
  SH02: "고기 가격을 10% 내리면",
  SH03: "돼지고기 도매가가 8% 오르면",
  SH04: "소주 가격을 1,000원 올리면",
  SH05: "손님이 술을 20% 덜 마시면",
  SH06: "알바 시급이 5% 오르면",
  SH07: "교대마다 알바를 한 명 줄이면",
  SH08: "재계약 때 임대료가 5% 오르면",
  SH09: "방학으로 손님이 8% 줄면",
  SH10: "평년처럼 한 달에 6일쯤 비가 오면",
  SH10b: "한 달 내내 비가 오면",
  SH11: "근처에 고깃집이 하나 더 생기면",
};

export const won = (x: number) => `${Math.round(x).toLocaleString("ko-KR")}원`;
export const man = (x: number) => `${(x / 10000).toLocaleString("ko-KR", { maximumFractionDigits: 0 })}만원`;
export const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;
// A change that rounds to zero at display precision is shown as no change.
export const isFlat = (d: number, f: (v: number) => string) => f(Math.abs(d)) === f(0);
export const signed = (x: number, f: (v: number) => string) => (x > 0 ? "+" : x < 0 ? "-" : "") + f(Math.abs(x));

export const KPI_META: { key: string; label: string; fmt: (v: number) => string; better: "up" | "down" }[] = [
  { key: "revenue", label: "월 매출", fmt: man, better: "up" },
  { key: "op", label: "영업이익", fmt: man, better: "up" },
  { key: "op_margin", label: "영업이익률", fmt: (v) => pct(v), better: "up" },
  { key: "covers", label: "월 손님 수", fmt: (v) => `${Math.round(v).toLocaleString("ko-KR")}명`, better: "up" },
  { key: "ticket", label: "객단가", fmt: won, better: "up" },
  { key: "walkaways", label: "기다리다 돌아간 팀", fmt: (v) => `${Math.round(v)}팀`, better: "down" },
  { key: "avg_wait_min", label: "평균 대기", fmt: (v) => `${v.toFixed(1)}분`, better: "down" },
  { key: "table_utilization", label: "테이블 가동률", fmt: (v) => pct(v, 0), better: "up" },
  { key: "cogs", label: "식재료비", fmt: man, better: "down" },
  { key: "labor_hours", label: "근무 시간", fmt: (v) => `${Math.round(v)}시간`, better: "down" },
  { key: "revpash", label: "좌석 시간당 매출", fmt: won, better: "up" },
  { key: "alcohol_share", label: "주류 매출 비중", fmt: (v) => pct(v), better: "up" },
];

// --- precomputed game runs (web/public/runs, written by python -m sim.precompute) ---------------------
export type Bands = Record<string, Band>;
export type Drivers = Record<string, number>;
export type Moved = { driver: string; label: string; op_effect: number };
export type RunFile = {
  meta: { runs: number; seed: number };
  shock: { id: string; label: string; if: string; driver: string; params: ShockParam[] };
  action: { id: string; label: string; phrase: string; description: string; args: Record<string, number> };
  base: Bands;
  shocked: Bands;
  reacted: Bands;
  delta_p50: Record<string, number>;
  delta_vs_shock_p50: Record<string, number>;
  shock_headline: string;
  headline: string;
  drivers: { base: Drivers; shocked: Drivers; reacted: Drivers };
  moved: { shock: Moved[]; choice: Moved[] };
  night: Night;
};
export type BaseFile = {
  meta: { runs: number; seed: number };
  kpis: Bands;
  drivers: Drivers;
  excel: Drivers;
  segment_cover_share: Record<SegmentId, number>;
  segments: Record<SegmentId, string>;
  headline: string;
  night: Night;
};
export type Evidence = { needs_interview: boolean; weakest: string | null; mechanisms: string[]; reasons: string[] };
export type Flags = { l_mechanism_badge?: boolean; peak_reshape?: boolean; rain_mode?: string; season_months?: number; carry_state?: boolean };
export type MatrixCell = { op_p50: number; revenue_p50: number; covers_p50: number; walkaways_p50: number; op_vs_base: number; op_vs_shock: number; headline: string };
export type RunIndex = {
  meta: { runs: number; seed: number; flags?: Flags };
  base: Record<string, number>;
  shocks: Record<string, { label: string; if: string; driver: string; params: ShockParam[]; evidence?: Evidence }>;
  actions: Record<string, { label: string; phrase: string; description: string; args: Record<string, number>; evidence?: Evidence }>;
  matrix: Record<string, Record<string, MatrixCell> & { _shock: { op_p50: number; op_vs_base: number; headline: string } }>;
  excluded?: string[];
};

// --- season grid (python -m sim.precompute --season) ----------------------------------------------
export type SeasonCell = { kpis: Bands; drivers: Drivers };
export type SeasonState = { state: Record<string, number>; key: string; describe: string[]; shocks: Record<string, SeasonCell> };
export type SeasonIndex = {
  meta: { months: number; carry_state: boolean; flags?: Flags };
  levers: string[];
  base_state: string;
  states: string[];
  transitions: Record<string, Record<string, string>>;
};
