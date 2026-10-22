// 월 정산 "매출 100원이 어디로 갔나" 막대 (모든 업종 공통). items는 [이름, 금액], 금액 단위는 revenue·op와 같으면 된다
export default function CostBar({ items, revenue, op, fmt }: { items: [string, number][]; revenue: number; op: number; fmt: (x: number) => string }) {
  const r = Math.max(1, revenue), xs = items.filter(([, v]) => v / r > 0.002);
  const COL = ["#2f4fc4", "#4d6bd6", "#7089e0", "#94a8ea", "#b6c4f1", "#d3dcf7"]; // 파란 계열 한 가지로 진하기만 다르게 (앞 비용이 큰 순)
  return (
    <section className="sx-sec cb">
      <h2>매출 100원이 어디로 갔나</h2>
      <div className="cb-bar" role="img" aria-label={xs.map(([k, v]) => `${k} ${Math.round((v / r) * 100)}원`).join(", ") + `, 남은 이익 ${Math.round((op / r) * 100)}원`}>
        {xs.map(([k, v], i) => <span key={k} className={i >= 3 ? "lt" : undefined} style={{ flexGrow: v, background: COL[i % COL.length] }} title={`${k} ${fmt(v)}`}>{v / r >= 0.07 ? `${k} ${Math.round((v / r) * 100)}` : ""}</span>)}
        {op > 0 && <span className="cb-op" style={{ flexGrow: op }}>{op / r >= 0.05 ? `이익 ${Math.round((op / r) * 100)}` : ""}</span>}
      </div>
      {op <= 0 && <p className="cb-loss">비용이 매출보다 {fmt(-op)} 많았어요 (매출 100원당 {Math.round((-op / r) * 100)}원 적자).</p>}
    </section>
  );
}
