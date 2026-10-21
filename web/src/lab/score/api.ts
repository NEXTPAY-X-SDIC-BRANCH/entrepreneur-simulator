// lab:score — 성적표 서버 호출 (엔진 서버 api/lab_score.py, api/lab_coach.py). 로그인 정보는 이 브라우저에만 둔다.
import type { Score, SeasonSummary } from "../types";

export const ENGINE = (import.meta.env.VITE_ENGINE_API as string | undefined) ?? "http://127.0.0.1:8010";

export type Login = { nickname: string; class_code: string };
export type RankRow = { rank: number; nickname: string; best: number; band: string; attempts: number; last: number; first: number; gain: number; demo?: boolean };
export type Submit = { score: Score; me: RankRow & { is_best: boolean }; class_size: number; rank: RankRow[]; class_code: string };
export type Cause = { id: string; title: string; evidence: string; why: string };
export type Next = { id: string; lever: string; text: string; expected: string; how: string };
export type Coach = { source: "llm" | "rule"; model?: string; causes: Cause[]; next: Next[]; fallback_reason?: string };
export type Admin = { class_code: string; learners: RankRow[]; bands: Record<string, number>; weakest: { key: string; lost_share: number }[] };

async function call<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${ENGINE}${path}`, body === undefined ? undefined : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof j.detail === "string" ? j.detail : `${r.status}`);
  return j as T;
}

export const getScore = (s: SeasonSummary) => call<Score>("/score", s);
export const getCoach = (s: SeasonSummary, llm: boolean) => call<Coach>("/coach", { summary: s, llm });
export const submit = (l: Login, s: SeasonSummary) => call<Submit>("/score/submit", { ...l, summary: s });
export const getRank = (cls: string, industry: string) =>
  call<{ rank: RankRow[]; class_size: number }>(`/score/rank?class_code=${encodeURIComponent(cls)}&industry=${encodeURIComponent(industry)}`);
export const getAdmin = (cls: string) => call<Admin>(`/score/admin?class_code=${encodeURIComponent(cls)}`);

const KEY = "cu.lab.login";
export function loadLogin(): Login | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return v && typeof v.nickname === "string" && typeof v.class_code === "string" ? v : null;
  } catch { return null; }
}
export function saveLogin(l: Login | null) {
  try { if (l) localStorage.setItem(KEY, JSON.stringify(l)); else localStorage.removeItem(KEY); } catch { /* 저장이 막힌 브라우저 */ }
}
