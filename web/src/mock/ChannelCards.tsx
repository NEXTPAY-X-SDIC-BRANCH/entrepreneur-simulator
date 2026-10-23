import type React from "react";
// 월 정산 "어디서 남았나" 카드 (카페: 매장·포장·배달, 옷가게: 매장·온라인). 치킨·분식의 홀·포장·배달 카드와 같은 모양
// rows: 갈래마다 주문 수, 매출, 빠지는 돈 [이름, 금액]. 금액 단위는 fmt가 받는 단위와 같다. perOne은 한 건 남는 돈을 원으로 바꾸는 배수
export type ChRow = { key: "visit" | "takeout" | "delivery"; label: string; orders: number; rev: number; costs: [string, number][] };

export default function ChannelCards({ rows, fmt, perOne }: { rows: ChRow[]; fmt: (x: number) => string; perOne: number }) {
  const left = (r: ChRow) => r.rev - r.costs.reduce((a, [, x]) => a + x, 0);
  const one = (r: ChRow) => (left(r) * perOne) / Math.max(1, r.orders);
  const live = rows.filter((r) => r.orders > 0);
  const best = live.length > 1 ? Math.max(...live.map(one)) : NaN;
  const total = Math.max(1, rows.reduce((a, r) => a + r.rev, 0));
  return (
    <div className="ch-cards" style={{ ["--ch-n" as string]: rows.length } as React.CSSProperties}>
      {rows.map((r) => (
        <article key={r.key + r.label} className={`ch-card is-${r.key}`}>
          <header><b>{r.label}</b><span className="ch-share">매출의 {Math.round((r.rev / total) * 100)}%</span>{r.orders > 0 && one(r) === best && <span className="ch-best">한 건에 가장 많이 남아요</span>}</header>
          <dl>
            <div><dt>주문</dt><dd>{Math.round(r.orders).toLocaleString("ko-KR")}건</dd></div>
            <div><dt>매출</dt><dd>{fmt(r.rev)}</dd></div>
            {r.costs.map(([k, x]) => <div key={k}><dt>{k}</dt><dd>{x ? `−${fmt(x)}` : "없음"}</dd></div>)}
          </dl>
          <footer><span>남는 돈</span><strong>{fmt(left(r))}</strong><small>{r.orders > 0 ? `한 건 ${Math.round(one(r)).toLocaleString("ko-KR")}원` : "주문 없음"}</small></footer>
        </article>
      ))}
    </div>
  );
}
