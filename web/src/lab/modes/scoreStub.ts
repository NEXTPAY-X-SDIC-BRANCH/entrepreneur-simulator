// lab:modes — local stand-in for the score lane's POST /score, same contract shape (web/src/lab/types.ts Score).
// scoreOf() calls the real endpoint first and only falls back to this stub when /score is missing (404) or unreachable,
// so once the score lane is merged the real scorecard is used without any change here.
// Every threshold below is a 가정 for the stub only; the real weights belong to the score lane.
import type { Score, ScoreBand, ScoreFix, ScorePart, SeasonSummary } from "../types";
import { ENGINE } from "./api";

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const BAND: Record<ScoreBand, Score["band_label"]> = { fit: "창업 적격", train: "훈련 필요", rethink: "창업 재검토" };
export const bandOf = (t: number): ScoreBand => (t >= 90 ? "fit" : t >= 60 ? "train" : "rethink");

export function stubScore(s: SeasonSummary): Score {
  const M = s.months;
  const sum = (k: "revenue" | "op" | "labor" | "rent" | "cogs") => M.reduce((a, m) => a + m[k], 0);
  const rev = Math.max(1, sum("revenue")), op = sum("op");
  const margin = op / rev;
  const lowest = Math.min(s.start_cash, ...M.map((m) => m.cash_after));
  const end = M.at(-1)?.cash_after ?? s.start_cash;
  const laborShare = sum("labor") / rev, rentShare = sum("rent") / rev;
  const negMonths = M.filter((m) => m.op < 0).length;
  const walk = M.reduce((a, m) => a + (m.walkaways ?? 0), 0), covers = M.reduce((a, m) => a + m.covers, 0);
  const walkShare = covers + walk > 0 ? walk / (covers + walk) : 0;
  const rating = M.at(-1)?.rating;
  const parts: ScorePart[] = [
    { key: "profit", label: "6개월 영업이익", max: 25, score: Math.round(25 * clamp01((margin + 0.1) / 0.25)),
      why: `매출 대비 영업이익 ${(margin * 100).toFixed(1)}%` },
    { key: "survival", label: "버티기", max: 20, score: s.closed ? Math.round(20 * (M.length - 1) / 6) : 20,
      why: s.closed ? `${M.length}개월째 문을 닫음` : "6개월을 버팀" },
    { key: "cash", label: "통장 여유", max: 20, score: lowest < 0 ? 0 : Math.round(20 * clamp01(end / Math.max(1, s.start_cash + s.opening_cost * 0.3))),
      why: lowest < 0 ? "현금이 마이너스로 내려간 달이 있음" : `6개월 뒤 현금 ${Math.round(end / 1e4).toLocaleString("ko-KR")}만원` },
    { key: "customer", label: "손님", max: 15,
      score: Math.round(15 * (rating != null && rating > 1 ? clamp01((rating - 3) / 1.5) : clamp01(1 - walkShare * 5))),
      why: rating != null ? `마지막 달 별점 ${rating.toFixed(2)}` : `돌아간 손님 ${(walkShare * 100).toFixed(1)}%` },
    { key: "cost", label: "비용 구조", max: 10, score: Math.round(10 * clamp01((0.65 - laborShare - rentShare) / 0.25)),
      why: `인건비 ${(laborShare * 100).toFixed(0)}%, 월세 ${(rentShare * 100).toFixed(0)}% (매출 대비)` },
    { key: "risk", label: "위험", max: 10, score: Math.max(0, 10 - 2 * negMonths - (s.loan > s.opening_cost * 0.5 ? 2 : 0)),
      why: `적자 달 ${negMonths}번${s.loan > 0 ? `, 대출 ${Math.round(s.loan / 1e4).toLocaleString("ko-KR")}만원` : ""}` },
  ];
  const total = Math.min(100, parts.reduce((a, p) => a + p.score, 0));
  const fixes: ScoreFix[] = [];
  const inp = s.inputs as Record<string, number | undefined>;
  if (laborShare > 0.3 && (inp.staff ?? 0) > 0) fixes.push({ key: "staff_down", lever: "staff_per_shift", text: `알바를 ${inp.staff}명에서 ${(inp.staff ?? 1) - 1}명으로 줄여 보기`, expected: `인건비가 매출의 ${(laborShare * 100).toFixed(0)}%예요` });
  if (walkShare > 0.05) fixes.push({ key: "staff_up", lever: "staff_per_shift", text: "바쁜 시간 직원을 한 명 늘려 보기", expected: `손님 ${(walkShare * 100).toFixed(0)}%가 기다리다 돌아갔어요` });
  if (rentShare > 0.15 && (inp.pyeong ?? 0) > 12) fixes.push({ key: "pyeong_down", lever: "pyeong", text: `평수를 ${inp.pyeong}평보다 줄여 보기`, expected: `월세가 매출의 ${(rentShare * 100).toFixed(0)}%예요` });
  if (margin < 0.05 && s.industry === "bbq" && (inp.price ?? 19000) < 22000) fixes.push({ key: "price_up", lever: "price", text: "삼겹살 가격을 1,000원 올려 보기", expected: "손님은 조금 줄고 한 팀 매출이 늘어요" });
  if (lowest < 0) fixes.push({ key: "cash_buffer", lever: "loan_man", text: "문 열 때 통장에 석 달 버틸 돈을 남기기", expected: "현금이 마이너스로 내려간 달이 있었어요" });
  return { total, band: bandOf(total), band_label: BAND[bandOf(total)], parts, fixes: fixes.slice(0, 3), version: "modes-stub-v1" };
}

export type Scored = { score: Score; stub: boolean };
export async function scoreOf(s: SeasonSummary): Promise<Scored> {
  try {
    const r = await fetch(`${ENGINE}/score`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(s) });
    if (r.ok) {
      const j = await r.json();
      if (typeof j?.total === "number" && Array.isArray(j?.parts)) return { score: j as Score, stub: false };
    }
  } catch { /* score lane not merged yet or engine down: use the stub */ }
  return { score: stubScore(s), stub: true };
}
