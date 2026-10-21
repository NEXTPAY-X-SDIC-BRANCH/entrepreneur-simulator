// lab:industry 새 업종 엔진(/lab/industry, api/lab_industry.py) 요청과 응답 모양.
import { useEffect, useState } from "react";
import type { Grade, Profile } from "../../mock/model";
import { ENGINE } from "../../mock/useCafePreview";
import type { LabIndustry } from "./industries";

export type IndustryCfg = { industry: LabIndustry; pyeong?: number; tables?: number; staff?: number; grade: Grade; delivery: boolean };
export type Line = { key: string; item_ko: string; krw: number; grade: string; note_ko?: string };
export type Preview = {
  industry: LabIndustry; name_ko: string;
  input: { pyeong: number; tables: number; staff: number; grade: Grade; delivery: boolean; dong: string | null };
  demand: { anchor_month_krw: number; settled_units_day: number; gu_index: number; dong_rel: number; size_factor: number; ticket_krw: number; days_month: number;
    channels: { hall: number; delivery: number; takeout: number }; delivery_available: boolean; note_ko: string };
  room: { width_m: number; depth_m: number; door: { x: number; w: number } } | null;
  layout: { id: string; type: string; x: number; z: number; rot_deg: number; fits: boolean; w: number; d: number; unassigned?: boolean; label_ko?: string }[];
  roster: { id: string; role: string; label_ko: string; x: number; z: number; fits: boolean }[];
  furniture_ko: Record<string, string>;
  seats: { total: number; tables: number; per_table: number };
  capacity: { seat_units_day: number; crew_units_day: number; demand_units_day: number; bottleneck: "seats" | "staff" | null; walk_share: number; note_ko: string };
  staff: { staff: number; default: number; pay_month_krw: number };
  hours: { standard: [number, number]; presets: Record<"short" | "standard" | "long", [number, number]> };
  rent: { man_per_pyeong: number; source: string };
  capex: { lines: (Line & { depreciate: boolean })[]; total_krw: number; own_capital_krw: number; loan_needed_krw: number; depreciation_month_krw: number; note_ko: string };
  monthly_fixed: { rent_krw: number; labor_krw: number; depreciation_krw: number; total_krw: number };
  rough_month: { revenue_krw: number; op_krw: number; op_margin: number | null; lines: Line[]; covers: number; walkaways: number; owner_pay_ref_krw: number; note_ko: string };
  breakeven_units_day: number | null;
  benchmark: { op_share_survey: number; rent_share_survey: number; krei_label: string; owner_family_share_survey: number; sales_p25_month_krw: number; sales_p75_month_krw: number; note_ko: string };
  area: { opening_rate: number; closure_rate: number; rent_source: string };
};
export type EventOpt = { id: string; label: string; hint: string; downside: string };
export type Event = { id: string; title: string; prompt: string; why: string; default: string; options: EventOpt[] };
export type Month = {
  month: number; calendar_month: number; status: "open" | "closed" | "finished"; owner_note_ko: string;
  decisions: { price_level: number; hours: "short" | "standard" | "long"; staff: number; marketing_krw: number; delivery: boolean; choice: string };
  event: { id: string; title: string; choice: string; choice_label: string; downside: string };
  random_events: { key: string; label_ko: string; effect_ko: string }[];
  kpi: { revenue_krw: number; op_krw: number; op_margin: number | null; cash_krw: number; covers: number; hall_covers: number; walkaways: number; walkaway_share: number;
    delivery_revenue_krw: number; ticket_krw: number; rating: number; rating_delta: number; owner_pay_ref_krw: number };
  pnl: { revenue_krw: number; lines: Line[]; op_krw: number };
  cash: { start_krw: number; op_krw: number; depreciation_addback_krw: number; loan_interest_krw: number; loan_principal_krw: number; end_krw: number; loan_balance_krw: number };
  drivers: { ramp: number; season: number; bottleneck: "seats" | "staff" | null; days_open: number; seat_units_day: number; crew_units_day: number };
  closure: { closed: boolean; reason_ko: string | null };
  next_event?: Event; next_calendar_month?: number; state_token: string;
};
export type Start = {
  name_ko: string; start_month: number; months_total: number; start_cash_krw: number;
  capex: Preview["capex"]; loan: { principal_krw: number; rate: number; monthly_payment_krw: number; note_ko: string };
  options: { hours: Record<"short" | "standard" | "long", [number, number]>; delivery_available: boolean };
  decisions: { staff: number; delivery: boolean };
  next_event: Event; next_calendar_month: number; state_token: string;
};

export const engineBody = (profile: Profile, cfg: IndustryCfg) => ({
  industry: cfg.industry, gu: profile.gu, dong: profile.dong && profile.dong.gu === profile.gu ? profile.dong.name : null,
  pyeong: cfg.pyeong, tables: cfg.tables, staff: cfg.staff, grade: cfg.grade, delivery: cfg.delivery,
  own_capital_krw: Math.round(profile.capital * 10000), key_money_krw: Math.round((profile.keyMoney ?? 0) * 10000),
  rent_man_per_pyeong: profile.rent && profile.rent.gu === profile.gu ? profile.rent.v : null,
});

export async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${ENGINE}/lab/industry${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(typeof j.detail === "string" ? j.detail : j.detail?.detail ?? "입력 범위를 확인해 주세요");
  return j as T;
}
export const netErr = (e: unknown) => (/fetch/i.test(String(e))
  ? "엔진 서버에 연결하지 못했어요. uvicorn api.changeup:app --host 127.0.0.1 --port 8010 으로 켜 주세요."
  : String((e as Error)?.message ?? e));

// 입력이 바뀔 때마다 (0.3초 모아서) 미리보기를 다시 부른다
export function usePreview(profile: Profile, cfg: IndustryCfg): { data: Preview | null; err: string } {
  const [data, setData] = useState<Preview | null>(null);
  const [err, setErr] = useState("");
  const key = JSON.stringify(engineBody(profile, cfg));
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      post<Preview>("/preview", JSON.parse(key)).then((d) => { if (alive) { setData(d); setErr(""); } }).catch((e) => alive && setErr(netErr(e)));
    }, 300);
    return () => { alive = false; clearTimeout(t); };
  }, [key]);
  return { data, err };
}

export const wman = (krw: number) => {
  const v = Math.round(krw / 10000);
  const a = Math.abs(v);
  const s = a >= 10000 ? `${Math.floor(a / 10000)}억${a % 10000 ? ` ${(a % 10000).toLocaleString("ko-KR")}만원` : "원"}` : `${a.toLocaleString("ko-KR")}만원`;
  return v < 0 ? `−${s}` : s;
};
export const sgn = (krw: number) => `${krw >= 0 ? "+" : "−"}${wman(Math.abs(krw))}`;
export const pct = (x: number, d = 0) => `${(x * 100).toFixed(d)}%`;
