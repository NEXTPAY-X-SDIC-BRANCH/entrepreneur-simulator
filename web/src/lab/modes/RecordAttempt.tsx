// lab:modes — 하드 모드 판 기록: 시즌 결과 화면(성적표 옆)에 붙어 그 판을 한 번 점수 매겨 판 기록(attempts.ts)에 남긴다.
// 화면에는 아무것도 그리지 않는다. 같은 결과는 한 번만 남긴다 (결과 화면이 다시 그려져도).
import { useEffect } from "react";
import type { SeasonSummary } from "../types";
import { addAttempt, nextAttemptNo } from "./attempts";
import { scoreOf } from "./scoreStub";

const done = new Set<string>();
/** 다시 해보기를 누르면 부른다: 시드가 고정이라 같은 입력의 다음 판은 같은 결과가 나오는데, 그것도 새 판으로 남겨야 한다 */
export const forgetRecorded = () => done.clear();
let pending: Promise<unknown> = Promise.resolve();
/** 다시 해보기가 점수 매기기 전에 눌려도 이번 판을 비교에 넣도록, 진행 중인 기록이 끝날 때까지 기다린다 */
export const recordPending = () => pending;

export default function RecordAttempt({ summary, extra }: { summary: SeasonSummary; extra?: Record<string, unknown> }) {
  const key = JSON.stringify([summary.industry, summary.start_cash, summary.months.map((m) => [m.month, m.op, m.cash_after])]);
  useEffect(() => {
    if (done.has(key)) return;
    done.add(key);
    const n = nextAttemptNo(summary.industry);
    const s: SeasonSummary = { ...summary, mode: "hard", attempt: n, inputs: { ...summary.inputs, ...extra, loan_man: Math.round(summary.loan / 1e4), start_month: summary.months[0]?.month } };
    pending = scoreOf(s).then((scored) => addAttempt(s, scored)).catch(() => done.delete(key)); // 실패하면 다음에 다시
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}
