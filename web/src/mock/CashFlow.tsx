// 현금흐름표와 그래프 두 개 (이달 돈의 흐름 폭포 그래프, 달마다 남은 현금). 다섯 업종이 같이 쓴다. 금액은 모두 원.
// lines는 그 달 현금이 실제로 들어오고(+) 나간(−) 항목. 엔진의 월말 현금과 맞지 않는 나머지는 '그 밖의 현금'으로 맞춘다.
// 세금은 엔진 현금에 빠져 있어서 따로 '떼어 둘 돈'으로 보여 준다 (tax.ts).
import { useMemo } from "react";
import Assume from "./Assume";
import { man } from "./model";
import { taxByMonth, type TaxIn, type TaxKind } from "./tax";
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

export default function CashFlow({ months, kind }: { months: CfMonth[]; kind: TaxKind; shop?: string; latestOnly?: boolean }) {
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
        <h2>{months.at(-1)!.month}월, 돈이 이렇게 들어오고 나갔어요</h2>
        <Waterfall m={months.at(-1)!} lines={rows.at(-1)!} tax={taxes.at(-1)!.vat + taxes.at(-1)!.income} />
      </section>
      {months.length > 1 && (
        <section className="sx-sec">
          <h2>달마다 남은 현금</h2>
          <CashBars months={months} after={afterTax} />
        </section>
      )}
    </div>
  );
}

const W = 64; // 막대 한 칸 폭 (svg 단위)
const short = (lb: string) => (lb.length > 7 ? lb.slice(0, 7) + "…" : lb);
const mk = (x: number) => { const v = Math.round(x / 1e4); return Math.abs(v) >= 1e4 ? `${(v / 1e4).toFixed(1)}억` : `${v.toLocaleString("ko-KR")}만`; };

// 폭포 그래프: 월초 현금에서 들어온 돈(초록)은 올라가고 나간 돈(빨강)은 내려가 월말 현금(파랑)에 닿는다. 마지막에 세금 떼어 둘 돈을 빼 본다.
function Waterfall({ m, lines, tax }: { m: CfMonth; lines: CfLine[]; tax: number }) {
  const ins = lines.filter((l) => l.amount > 0).sort((a, b) => b.amount - a.amount);
  const outs = lines.filter((l) => l.amount < 0).sort((a, b) => a.amount - b.amount);
  type Bar = { label: string; from: number; to: number; kind: "total" | "in" | "out" | "tax" | "net" };
  const bars: Bar[] = [{ label: "월초 현금", from: 0, to: m.start, kind: "total" }];
  let run = m.start;
  for (const l of [...ins, ...outs]) { bars.push({ label: l.label, from: run, to: run + l.amount, kind: l.amount > 0 ? "in" : "out" }); run += l.amount; }
  bars.push({ label: "월말 현금", from: 0, to: m.end, kind: "total" });
  if (tax > 0) { bars.push({ label: "세금 떼어 둘 돈", from: m.end, to: m.end - tax, kind: "tax" }); bars.push({ label: "세금 뗀 뒤", from: 0, to: m.end - tax, kind: "net" }); }
  const vals = bars.flatMap((x) => [x.from, x.to]);
  const hi = Math.max(0, ...vals), lo = Math.min(0, ...vals);
  const H = 220, top = 22, y = (v: number) => top + ((hi - v) / Math.max(1, hi - lo)) * H;
  const width = bars.length * W + 8;
  return (
    <div className="cf-chart">
      <svg viewBox={`0 0 ${width} ${top + H + 46}`} role="img" aria-label={`${m.month}월 현금 흐름 그래프. 월초 ${mk(m.start)}원에서 월말 ${mk(m.end)}원`}>
        <line x1={0} x2={width} y1={y(0)} y2={y(0)} className="cf-zero" />
        {bars.map((x, i) => {
          const y1 = y(Math.max(x.from, x.to)), y2 = y(Math.min(x.from, x.to));
          const cx = 4 + i * W + W / 2;
          const d = x.to - x.from;
          return (
            <g key={i} className={`cf-b is-${x.kind}`}>
              <rect x={cx - 21} y={y1} width={42} height={Math.max(2, y2 - y1)} rx={5} />
              {i < bars.length - 1 && <line x1={cx + 21} x2={cx + W - 21} y1={y(x.to)} y2={y(x.to)} className="cf-link" />}
              <text x={cx} y={y1 - 6} className="cf-v">{x.kind === "total" || x.kind === "net" ? mk(x.to) : `${d > 0 ? "+" : "−"}${mk(Math.abs(d))}`}</text>
              <text x={cx} y={top + H + 20} className="cf-l">{short(x.label)}</text>
              <title>{`${x.label}: ${x.kind === "total" || x.kind === "net" ? mk(x.to) : (d > 0 ? "+" : "−") + mk(Math.abs(d))}원`}</title>
            </g>
          );
        })}
      </svg>
      <ul className="cf-key" aria-hidden>
        <li className="is-total">가진 현금</li><li className="is-in">들어온 돈</li><li className="is-out">나간 돈</li>{tax > 0 && <li className="is-tax">세금으로 떼어 둘 돈</li>}
      </ul>
    </div>
  );
}

// 달마다 월말 현금(파란 막대)과 세금을 떼어 둔 뒤의 현금(진한 점선). 이달 현금이 늘었는지 줄었는지 막대 위에 적는다.
function CashBars({ months, after }: { months: CfMonth[]; after: number[] }) {
  const hi = Math.max(0, ...months.map((m) => m.end), ...after), lo = Math.min(0, ...months.map((m) => m.end), ...after);
  const H = 180, top = 22, y = (v: number) => top + ((hi - v) / Math.max(1, hi - lo)) * H;
  const width = months.length * W + 8;
  const pts = after.map((v, i) => `${4 + i * W + W / 2},${y(v)}`).join(" ");
  return (
    <div className="cf-chart">
      <svg viewBox={`0 0 ${width} ${top + H + 30}`} role="img" aria-label="달마다 월말 현금 그래프">
        <line x1={0} x2={width} y1={y(0)} y2={y(0)} className="cf-zero" />
        {months.map((m, i) => {
          const cx = 4 + i * W + W / 2, d = m.end - m.start;
          return (
            <g key={m.month} className={`cf-b ${m.end < 0 ? "is-out" : "is-total"}`}>
              <rect x={cx - 18} y={y(Math.max(0, m.end))} width={36} height={Math.max(2, Math.abs(y(m.end) - y(0)))} rx={5} />
              <text x={cx} y={y(Math.max(0, m.end)) - 6} className={`cf-v ${d >= 0 ? "up" : "down"}`}>{d >= 0 ? "▲" : "▼"}{mk(Math.abs(d))}</text>
              <text x={cx} y={top + H + 20} className="cf-l">{m.month}월</text>
              <title>{`${m.month}월 월말 현금 ${mk(m.end)}원, 세금 떼어 둔 뒤 ${mk(after[i])}원`}</title>
            </g>
          );
        })}
        <polyline points={pts} className="cf-after" />
        {after.map((v, i) => <circle key={i} cx={4 + i * W + W / 2} cy={y(v)} r={3.5} className="cf-after-d" />)}
      </svg>
      <ul className="cf-key" aria-hidden><li className="is-total">월말 현금 (▲▼ 지난달보다)</li><li className="is-after">세금 떼어 둔 뒤 현금</li></ul>
    </div>
  );
}
