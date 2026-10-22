// lab:finance — 은행별 사업자 대출 금리 표 (시안 A). 은행 숫자는 은행연합회 비교공시의 개인사업자 보증서담보대출 평균
// (upstream pipelines/fetch_kfb_rates.py, lab:merge)이고, 정책자금은 공고에서 확인한 금리만 숫자로 보여 준다.
// 고른 금리가 대출 이자 계산에 들어간다. 링크는 각 기관 홈페이지 또는 비교공시뿐이고 신청·연결은 하지 않는다.
import { useEffect } from "react";
import { bankRates, bankRatesFailed, loadBankRates, pickLender, useFinance, type Lender } from "./finance";
import "./finance.css";

const LO = 3.5, HI = 5.5; // 막대 눈금 (연 %)
const pos = (r: number) => `${Math.min(100, Math.max(0, ((r - LO) / (HI - LO)) * 100))}%`;
const man1 = (v: number) => `${(Math.round(v * 10) / 10).toLocaleString("ko-KR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}만원`;
const sgn1 = (v: number) => (Math.abs(v) < 0.05 ? "같아요" : `${v > 0 ? "+" : "−"}${man1(Math.abs(v))}`);
const ym = (m: string) => `${m.slice(0, 4)}년 ${+m.slice(4)}월`;

/** loanMan: 이자를 계산할 대출 금액 (만원). young: 만 39세 이하 (청년 자금 표시). */
export default function BankRates({ loanMan, young = true }: { loanMan: number; young?: boolean }) {
  const fin = useFinance();
  useEffect(() => { loadBankRates(); }, []);
  const d = bankRates();
  if (!d) return bankRatesFailed()
    ? <p className="lf-empty">은행 금리 자료를 불러오지 못했어요. 은행별 실제 금리는 <a href="https://portal.kfb.or.kr/compare/loan_snmindustry.php" target="_blank" rel="noopener noreferrer">은행연합회 소비자포털 비교공시</a>에서 볼 수 있어요.</p>
    : <p className="lf-empty">은행 금리 자료를 불러오는 중이에요.</p>;
  const a = d._meta.anchor.rate;
  const example = !(loanMan > 0);                                    // 대출을 정하지 않았으면 1,000만원 예시로 보여 준다
  const amt = example ? 1000 : Math.round(loanMan);
  const monthly = (r: number) => (amt * r) / 100 / 12;               // 이자만 낼 때 한 달 이자 (만원)
  const banks = d.lenders.filter((l) => l.kind !== "정책자금");
  const policy = d.lenders.filter((l) => l.kind === "정책자금" && (young || !l.youth));

  const row = (l: Lender) => {
    const on = fin.lender === l.id;
    const known = l.rate != null;
    return (
      <tr key={l.id} className={on ? "is-on" : undefined}>
        <th scope="row"><b>{l.name}</b><small>{l.kind === "정책자금" ? l.who : l.kind}</small></th>
        <td className="lf-rate">
          {known ? <>연 {l.rate!.toFixed(2)}%</> : <span className="lf-na">금리 공고 확인 필요</span>}
          {known && (
            <span className="lf-tag is-posted">
              {l.label === "공고 금리" && l.as_of ? `공고 금리, ${+l.as_of.slice(5, 7)}월 ${+l.as_of.slice(8, 10)}일 적용`
                : l.label === "공시 평균" && l.as_of ? `공시 평균, ${ym(l.as_of)}` : l.label}
            </span>
          )}
          {known && <small>평균보다 {l.rate! - a >= 0 ? "+" : "−"}{Math.abs(l.rate! - a).toFixed(2)}%p</small>}
        </td>
        <td aria-hidden="true">{known && <span className="lf-bar"><b style={{ left: pos(a) }} /><i style={{ left: pos(l.rate!) }} /></span>}</td>
        <td className="lf-num">{known && <>{man1(monthly(l.rate!))}<small>6개월 이자 평균보다 {sgn1((monthly(l.rate!) - monthly(a)) * 6)}</small></>}</td>
        <td>
          {known && (
            <button type="button" className="lf-pick" aria-pressed={on} onClick={() => pickLender(on ? null : l)}>
              {on ? "계산에 쓰는 중" : "이 금리로 계산"}
            </button>
          )}
        </td>
        <td><a href={l.url} target="_blank" rel="noopener noreferrer">{l.kind === "정책자금" ? "안내 페이지" : l.url === d.compare_url ? "비교공시" : "홈페이지"}</a></td>
      </tr>
    );
  };
  const head = (first: string) => (
    <thead>
      <tr>
        <th scope="col">{first}</th><th scope="col">연 금리</th>
        <th scope="col"><span className="m-sr">평균 대비 막대</span></th>
        <th scope="col" className="lf-num">{amt.toLocaleString("ko-KR")}만원 빌리면 월 이자{example ? " (예시)" : ""}</th>
        <th scope="col"><span className="m-sr">계산에 쓰기</span></th><th scope="col"><span className="m-sr">링크</span></th>
      </tr>
    </thead>
  );

  return (
    <section className="lf-banks" aria-labelledby="lf-banks-h">
      <h2 className="m-sub" id="lf-banks-h">은행별 사업자 대출 금리</h2>
      <p className="lf-anchor">
        은행별 숫자는 은행연합회 비교공시의 개인사업자 <b>보증서담보대출 평균</b>({ym(d.ym)}, 신규취급액)이에요.
        처음 여는 가게는 보통 지역신용보증재단 보증서를 담보로 빌려요. 비교 기준선은 한국은행 예금은행 중소기업대출 신규 평균 <b>연 {a}%</b> ({ym(d._meta.anchor.month)}).
        실제 금리는 신용과 보증비율에 따라 달라져요.
      </p>
      <div className="lf-scroll">
        <table className="lf-table">
          {head("은행")}
          <tbody>{banks.map(row)}</tbody>
        </table>
      </div>
      <h3 className="lf-h3">정책자금</h3>
      <div className="lf-scroll">
        <table className="lf-table">
          {head("기관")}
          <tbody>{policy.map(row)}</tbody>
        </table>
      </div>
      <small className="m-src">
        월 이자는 이자만 낸다고 본 값이에요. 표의 막대는 연 {LO}~{HI}% 눈금이고 점선이 한국은행 평균이에요. 은행 순서는 은행연합회 비교공시의 은행 목록 순서이고 추천이나 순위가 아니에요.
        신규 취급을 멈춘 은행은 뺐어요. 홈페이지를 확인하지 못한 은행은 비교공시로 연결해요.
        정책자금 금리는 소상공인시장진흥공단 정책자금 누리집 금리안내에서 확인한 공고 금리예요 (분기마다 바뀌어요). 서울신용보증재단은 자금마다 금리가 달라 숫자를 넣지 않았어요.
        은행별 금리 원자료는 <a href={d.compare_url} target="_blank" rel="noopener noreferrer">은행연합회 소비자포털 중소기업(개인사업자) 대출금리 비교공시</a>에 나와요.
        이 화면은 각 기관 홈페이지로 가는 링크만 보여 주고, 대출을 대신 신청하거나 연결하지 않아요.
      </small>
      {fin.lender && <button type="button" className="m-link" onClick={() => pickLender(null)}>은행 평균 금리로 되돌리기</button>}
    </section>
  );
}
