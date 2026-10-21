// lab:modes — 판 기록 (다시 해보기). Kept client-side only: this tab's memory, mirrored to sessionStorage so a reload keeps
// the class session. Nothing is sent anywhere; the score lane's /score/submit is the place for class rankings.
import { useSyncExternalStore } from "react";
import type { SeasonSummary } from "../types";
import type { Scored } from "./scoreStub";

export type Attempt = { n: number; summary: SeasonSummary; scored: Scored; at: number };
const KEY = "changeup.lab.attempts.v1";

let list: Attempt[] = (() => {
  try { const raw = sessionStorage.getItem(KEY); return raw ? (JSON.parse(raw) as Attempt[]) : []; } catch { return []; }
})();
const subs = new Set<() => void>();
const save = () => { try { sessionStorage.setItem(KEY, JSON.stringify(list.slice(-30))); } catch { /* private mode, quota */ } };
const emit = () => { save(); subs.forEach((f) => f()); };

/** attempts of one industry, oldest first */
export const attemptsOf = (industry: string) => list.filter((a) => a.summary.industry === industry);
export const nextAttemptNo = (industry: string) => (attemptsOf(industry).at(-1)?.n ?? 0) + 1;
export function addAttempt(summary: SeasonSummary, scored: Scored): Attempt {
  const a: Attempt = { n: summary.attempt ?? nextAttemptNo(summary.industry), summary, scored, at: Date.now() };
  list = [...list, a];
  emit();
  return a;
}
export function clearAttempts(industry?: string) { list = industry ? list.filter((a) => a.summary.industry !== industry) : []; emit(); }

export function useAttempts(industry: string): Attempt[] {
  const all = useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => list);
  return all.filter((a) => a.summary.industry === industry);
}
