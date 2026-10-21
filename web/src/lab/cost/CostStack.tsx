// 비용 쌓기 패널 (시안 B, 2026-10-21 coordinator 승인): 매출 막대 하나를 비용이 차례로 나눠 갖고, 남은 몫이 영업이익.
// 비용이 매출보다 크면 막대를 비용 합 기준으로 그리고 매출 위치에 선을 긋는다 (그 너머가 적자).
// 매장 운영비 줄은 눌러서 내역(공과금·소모품·수선·보험·통신·마케팅 ...)을 펼친다.
import { useState, type ReactNode } from "react";
import { COLORS, type Stack } from "./stackModel";
import "./cost.css";

const man = (won: number) => {
  const v = won / 1e4;
  if (v !== 0 && Math.abs(v) < 0.1) return "0.1만원 미만";
  const r = Math.abs(v) < 10 && Math.round(v) !== v ? Math.round(v * 10) / 10 : Math.round(v);
  return `${Math.abs(r).toLocaleString("ko-KR")}만원`;
};
const signed = (won: number) => `${won < 0 ? "−" : "+"}${man(won)}`;
const pct = (x: number, of: number) => (of > 0 ? `${Math.round((x / of) * 100)}%` : "");

export default function CostStack({ stack, head, headValue, foot, extra, compact, className }: {
  stack: Stack; head: ReactNode; headValue?: ReactNode; foot?: ReactNode; extra?: ReactNode; compact?: boolean; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const rows = stack.rows.filter((r) => Math.abs(r.amount) >= 1);
  const cost = rows.reduce((a, r) => a + Math.max(0, r.amount), 0);
  const scale = Math.max(stack.revenue, cost, 1);
  const opPos = Math.max(0, stack.op);
  const lossShare = stack.op < 0 ? stack.revenue / scale : null;
  return (
    <section className={`cst-panel${compact ? " is-compact" : ""}${className ? ` ${className}` : ""}`} aria-label="매출과 비용">
      <p className="cst-head"><span>{head}</span>{headValue ?? <b>{man(stack.revenue)}</b>}</p>
      <div className="cst-bar" role="img" aria-label={`매출 ${man(stack.revenue)} 중 비용 ${man(cost)}, 영업이익 ${signed(stack.op)}`}>
        {rows.map((r) => <i key={r.key} style={{ width: `${(Math.max(0, r.amount) / scale) * 100}%`, background: COLORS[r.key] ?? "#cdd3dc" }} />)}
        {opPos > 0 && <i style={{ width: `${(opPos / scale) * 100}%`, background: COLORS.op }} />}
        {lossShare !== null && <span className="cst-revline" style={{ left: `${lossShare * 100}%` }} />}
      </div>
      {lossShare !== null && <p className="cst-loss">선까지가 매출이에요. 그 오른쪽만큼 비용이 매출보다 많아요.</p>}
      <dl className="cst-legend">
        <div className="cst-rev"><i /><dt>매출</dt><dd>{man(stack.revenue)}</dd><span /></div>
        {rows.map((r) => {
          const kids = r.kids && r.kids.length > 1 ? r.kids : null;
          return (
            <div key={r.key} className={`cst-row${kids ? " has-kids" : ""}`}>
              <i style={{ background: COLORS[r.key] ?? "#cdd3dc" }} />
              <dt>
                {kids ? (
                  <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
                    {r.label}<svg className={`cst-caret${open ? " is-open" : ""}`} viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" /></svg>
                  </button>
                ) : r.label}
                {r.tag && <span className={`cst-tag is-${r.tag === "가정" ? "guess" : "data"}`}>{r.tag}</span>}
                {!compact && r.hint && <small>{r.hint}</small>}
              </dt>
              <dd>−{man(r.amount)}</dd>
              <span className="cst-pct">{pct(r.amount, stack.revenue)}</span>
              {kids && open && (
                <ul className="cst-kids">
                  {kids.map((x) => <li key={x.label}><span>{x.label}</span><b>−{man(x.amount)}</b></li>)}
                </ul>
              )}
            </div>
          );
        })}
        <div className="cst-op"><i style={{ background: stack.op >= 0 ? COLORS.op : "#b3261e" }} /><dt>{stack.opLabel ?? "영업이익"}</dt>
          <dd className={stack.op >= 0 ? "pos" : "neg"}>{signed(stack.op)}</dd><span className="cst-pct">{pct(stack.op, stack.revenue)}</span></div>
      </dl>
      {extra}
      {foot && <p className="cst-foot">{foot}</p>}
    </section>
  );
}
