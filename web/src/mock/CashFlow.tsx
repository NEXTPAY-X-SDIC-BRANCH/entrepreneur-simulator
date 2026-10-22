// 현금흐름표와 달마다 쌓이는 영수증. 다섯 업종이 같이 쓴다. 금액은 모두 원.
// lines는 그 달 현금이 실제로 들어오고(+) 나간(−) 항목. 엔진의 월말 현금과 맞지 않는 나머지는 '그 밖의 현금'으로 맞춘다.
// 세금은 엔진 현금에 빠져 있어서 따로 '떼어 둘 돈'으로 보여 준다 (tax.ts).
import { useMemo } from "react";
import Assume from "./Assume";
import { man } from "./model";
import { taxByMonth, vatDue, type TaxIn, type TaxKind } from "./tax";
import "./cashflow.css";

export type CfLine = { label: string; amount: number };
export type CfMonth = { month: number; start: number; end: number; lines: CfLine[]; tax: TaxIn };

const m10k = (x: number) => Math.round(x / 1e4);
const sg = (x: number) => (Math.round(x / 1e4) === 0 ? "0원" : `${x > 0 ? "+" : "−"}${man(Math.abs(m10k(x)))}`);

function fill(m: CfMonth): CfLine[] {
  const gap = m.end - m.start - m.lines.reduce((a, l) => a + l.amount, 0);
  const lines = m.lines.filter((l) => Math.abs(l.amount) >= 5_000);
  return Math.abs(gap) >= 10_000 ? [...lines, { label: "그 밖의 현금", amount: gap }] : lines;
}

export default function CashFlow({ months, kind, shop, latestOnly }: { months: CfMonth[]; kind: TaxKind; shop: string; latestOnly?: boolean }) {
  const taxes = useMemo(() => taxByMonth(months.map((m) => m.tax), kind), [months, kind]);
  const rows = useMemo(() => months.map(fill), [months]);
  if (!months.length) return null;
  const labels: string[] = [];
  for (const r of rows) for (const l of r) if (!labels.includes(l.label)) labels.push(l.label);
  const ins = labels.filter((lb) => rows.some((r) => r.find((l) => l.label === lb && l.amount > 0)) && !rows.some((r) => r.find((l) => l.label === lb && l.amount < 0)));
  const outs = labels.filter((lb) => !ins.includes(lb));
  const cell = (i: number, lb: string) => rows[i].find((l) => l.label === lb)?.amount ?? 0;
  let reserve = 0;
  const afterTax = months.map((m, i) => (reserve += taxes[i].vat + taxes[i].income, m.end - reserve));
  const t0 = taxes[0];
  const recs = latestOnly ? [months.length - 1] : months.map((_, i) => i);

  return (
    <div className="cf">
      <section className="sx-sec">
        <h2>현금흐름표</h2>
        <div className="cf-scroll">
          <table className="sx-table cf-table">
            <thead><tr><th>항목</th>{months.map((m) => <th key={m.month}>{m.month}월</th>)}<th>합계</th></tr></thead>
            <tbody>
              <tr className="sub"><th>월초 현금</th>{months.map((m) => <td key={m.month}>{man(m10k(m.start))}</td>)}<td /></tr>
              {ins.map((lb) => <tr key={lb} className="cf-in"><th>{lb}</th>{months.map((m, i) => <td key={m.month}>{sg(cell(i, lb))}</td>)}<td>{sg(rows.reduce((a, _, i) => a + cell(i, lb), 0))}</td></tr>)}
              {outs.map((lb) => <tr key={lb}><th>{lb}</th>{months.map((m, i) => <td key={m.month}>{sg(cell(i, lb))}</td>)}<td>{sg(rows.reduce((a, _, i) => a + cell(i, lb), 0))}</td></tr>)}
              <tr className="sum"><th>이달 현금 변화</th>{months.map((m) => <td key={m.month}>{sg(m.end - m.start)}</td>)}<td>{sg(months.at(-1)!.end - months[0].start)}</td></tr>
              <tr className="sum"><th>월말 현금</th>{months.map((m) => <td key={m.month}>{man(m10k(m.end))}</td>)}<td /></tr>
              <tr className="cf-tax"><th>부가세 떼어 둘 돈<Assume id="vat" /></th>{taxes.map((t, i) => <td key={i}>{t.vat ? `−${man(m10k(t.vat))}` : "0원"}</td>)}<td>−{man(m10k(taxes.reduce((a, t) => a + t.vat, 0)))}</td></tr>
              <tr className="cf-tax"><th>소득세 떼어 둘 돈<Assume id="incomeTax" /></th>{taxes.map((t, i) => <td key={i}>{t.income ? `−${man(m10k(t.income))}` : "0원"}</td>)}<td>−{man(m10k(taxes.reduce((a, t) => a + t.income, 0)))}</td></tr>
              <tr className="sum cf-net"><th>세금 떼어 둔 뒤 현금</th>{afterTax.map((x, i) => <td key={i}>{man(m10k(x))}</td>)}<td /></tr>
            </tbody>
          </table>
        </div>
        <p className="sx-note">
          {t0.exempt ? "이 속도면 1년 매출이 4,800만원보다 적어 부가세 납부가 면제돼요."
            : t0.simplified ? "이 속도면 1년 매출이 1억 400만원보다 적어 간이과세자예요. 부가세는 매출의 1.5%에서 카드 매출 공제를 뺀 만큼, 다음 해 1월 25일에 한 번 내요."
            : `이 속도면 1년 매출이 1억 400만원을 넘어 일반과세자예요. 부가세는 1~6월분을 7월 25일, 7~12월분을 다음 해 1월 25일에 내요${kind === "food" ? ". 고기·채소 같은 농축산물 원가는 의제매입세액으로 일부 돌려받아요" : ""}.`}
          {" "}종합소득세는 다음 해 5월에 내요. 엔진의 현금은 세금을 내기 전 금액이라, 그때 한꺼번에 나갈 돈을 미리 떼어 봤어요.
        </p>
      </section>
      <section className="sx-sec">
        <h2>영수증 <small className="cf-count">{months.length}장</small></h2>
        <div className="cf-stack" aria-label="달마다 쌓이는 영수증">
          {recs.slice().reverse().map((i, k) => {
            const m = months[i], r = rows[i], t = taxes[i];
            return (
              <article key={m.month} className={`cf-rcpt${k === 0 ? " is-new" : ""}`} style={{ zIndex: 50 - k }}>
                <header><b>{shop}</b><span>{m.month}월 정산 영수증</span></header>
                <dl>
                  <div className="cf-r-start"><dt>월초 현금</dt><dd>{man(m10k(m.start))}</dd></div>
                  {r.map((l) => <div key={l.label} className={l.amount > 0 ? "in" : ""}><dt>{l.label}</dt><dd>{sg(l.amount)}</dd></div>)}
                  <div className="cf-r-sum"><dt>월말 현금</dt><dd>{man(m10k(m.end))}</dd></div>
                  <div className="cf-r-tax"><dt>세금 떼어 둘 돈</dt><dd>−{man(m10k(t.vat + t.income))}</dd></div>
                </dl>
                <footer>부가세 {vatDue(m.month, t.simplified)} 납부 · 소득세 다음 해 5월</footer>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}
