// lab:modes — 판 비교 (다시 해보기): 지난 판 점수 → 이번 판 점수, 바뀐 입력, 다음 판에 바꿔 볼 것.
import type { ScoreFix } from "../types";
import type { Attempt } from "./attempts";
import { cumOp, diffInputs } from "./summary";

export const manWon = (won: number) => `${Math.round(won / 1e4).toLocaleString("ko-KR")}만원`;
export const signedMan = (won: number) => { const v = Math.round(won / 1e4); return v === 0 ? "0원" : `${v > 0 ? "+" : "−"}${Math.abs(v).toLocaleString("ko-KR")}만원`; };

export function ScoreRow({ prev, cur }: { prev?: Attempt; cur: Attempt }) {
  const d = prev ? cur.scored.score.total - prev.scored.score.total : 0;
  return (
    <div className="lm-scores">
      {prev && (
        <>
          <div className="lm-score is-prev"><small>{prev.n}판</small><b>{prev.scored.score.total}</b><small>{prev.scored.score.band_label}</small></div>
          <span className="lm-arrow" aria-hidden>→</span>
        </>
      )}
      <div className="lm-score"><small>{cur.n}판{prev ? "" : "째 점수"}</small><b>{cur.scored.score.total}</b><small>{cur.scored.score.band_label}</small></div>
      <div className="lm-delta">
        {prev && <b className={d > 0 ? "is-up" : d < 0 ? "is-down" : ""}>{d > 0 ? `+${d}` : d < 0 ? `−${Math.abs(d)}` : "같음"}{d !== 0 && "점"}</b>}
        <small>
          6개월 영업이익{cur.summary.industry === "bbq" || cur.summary.industry === "cafe" ? "" : "(사장님 몫 빼기 전)"} {prev ? `${signedMan(cumOp(prev.summary))} → ` : ""}{signedMan(cumOp(cur.summary))}
          {cur.summary.closed ? `, ${cur.summary.months.length}개월째 폐업` : ", 6개월 버팀"}
        </small>
        {cur.scored.stub && <small className="lm-stub">임시 점수: 성적표 기능이 붙기 전까지 쓰는 규칙이에요 (가정)</small>}
      </div>
    </div>
  );
}

export function DiffTable({ prev, cur }: { prev: Attempt; cur: Attempt }) {
  const rows = diffInputs(prev.summary.inputs, cur.summary.inputs, cur.summary.industry);
  const changed = rows.filter((r) => r.changed);
  return (
    <section className="lm-sec">
      <h2>지난 판과 바뀐 것</h2>
      {changed.length === 0 && <p className="lm-quiet">입력은 그대로예요. {prev.summary.mode !== cur.summary.mode ? "모드만 바뀌었어요." : cur.summary.mode === "easy" ? "같은 입력이면 이지 모드 결과도 같아요." : "하드 모드는 달마다 고른 운영과 사건 대응, 판마다 다른 사건 때문에 입력이 같아도 결과가 달라질 수 있어요."}</p>}
      <table className="lm-tbl">
        <thead><tr><th scope="col">입력</th><th scope="col">{prev.n}판</th><th scope="col">{cur.n}판</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className={r.changed ? "is-changed" : ""}><th scope="row">{r.label}</th><td>{r.before}</td><td>{r.changed ? <b>{r.after}</b> : r.after}</td></tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

const LEVER_TO_CONTROL: Record<string, string> = { staff_per_shift: "staff", staff_policy: "staff", staff: "staff", price: "price", meat_price: "price", pyeong: "pyeong", tables: "tables", loan_man: "loan", loan: "loan", capital: "loan", price_change_pct: "price" }; // capital(운영자금 더 남기기) = 이지 모드에서는 대출 칸
export const controlOf = (lever: string) => LEVER_TO_CONTROL[lever];

export function Fixes({ fixes, onFix }: { fixes: ScoreFix[]; onFix?: (control: string) => void }) {
  return (
    <section className="lm-sec">
      <h2>다음 판에 바꿔 볼 것</h2>
      <small>성적표가 이번 판에서 고른 것이에요. 바꿀지는 직접 정해요</small>
      {fixes.length === 0 && <p className="lm-quiet">고칠 점을 찾지 못했어요. 다른 동네나 평수로 견줘 보세요.</p>}
      <ul className="lm-fixes">
        {fixes.map((f) => (
          <li key={f.key}>
            <div><b>{f.text}</b><small>{f.expected}</small></div>
            {onFix && controlOf(f.lever) && <button type="button" className="m-link" onClick={() => onFix(controlOf(f.lever))}>이 값 고치기</button>}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** 3판 이상이면 판 기록 선 */
export function AttemptLine({ list }: { list: Attempt[] }) {
  if (list.length < 3) return null;
  const W = 640, H = 150, P = 28;
  const x = (i: number) => P + (i * (W - 2 * P)) / Math.max(1, list.length - 1);
  const y = (t: number) => 12 + (1 - (Math.max(30, t) - 30) / 70) * (H - 40); // 30~100점 구간을 그린다
  return (
    <figure className="lm-line">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`판별 점수: ${list.map((a) => `${a.n}판 ${a.scored.score.total}점`).join(", ")}`}>
        {[60, 90].map((t) => <g key={t}><line x1={P} x2={W - P} y1={y(t)} y2={y(t)} className="lm-line-guide" /><text x={2} y={y(t) + 4}>{t}</text></g>)}
        <polyline points={list.map((a, i) => `${x(i)},${y(a.scored.score.total)}`).join(" ")} className="lm-line-path" />
        {list.map((a, i) => (
          <g key={a.n}><circle cx={x(i)} cy={y(a.scored.score.total)} r={i === list.length - 1 ? 6 : 4.5} className="lm-line-dot" />
            <text x={x(i)} y={H - 6} textAnchor="middle">{a.n}판 {a.scored.score.total}</text></g>
        ))}
      </svg>
    </figure>
  );
}

export default function Compare({ prev, cur, onFix }: { prev?: Attempt; cur: Attempt; onFix?: (control: string) => void }) {
  return (
    <div className="lm-compare">
      <ScoreRow prev={prev} cur={cur} />
      <div className="lm-two">
        {prev ? <DiffTable prev={prev} cur={cur} /> : <Parts cur={cur} />}
        <Fixes fixes={cur.scored.score.fixes} onFix={onFix} />
      </div>
    </div>
  );
}

export function Parts({ cur }: { cur: Attempt }) {
  return (
    <section className="lm-sec">
      <h2>점수 내역</h2>
      <table className="lm-tbl">
        <tbody>
          {cur.scored.score.parts.map((p) => (
            <tr key={p.key}><th scope="row">{p.label}</th><td className="lm-num">{p.score} / {p.max}</td><td><small>{p.why}</small></td></tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
