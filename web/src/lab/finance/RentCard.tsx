// lab:finance — 월세 카드 할부. 손익의 월세는 그대로이고, 현금이 빠지는 때와 수수료만 바뀐다.
// 부대표님이 준비 중인 '임대료 카드 결제' 서비스와 연결할 자리다. 제품 이름은 정해지지 않아 쓰지 않는다.
import { CARD_MONTHS, RENT_CARD_SRC, cardFeeRate, rentSchedule, setCard, useFinance, type CardMonths } from "./finance";
import "./finance.css";

const m1 = (v: number) => `${(Math.round(v * 10) / 10).toLocaleString("ko-KR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}만원`;
const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
const LABEL: Record<CardMonths, string> = { 0: "현금", 2: "카드 2개월", 3: "카드 3개월", 6: "카드 6개월" };

/** rentMan: 한 달 월세 (만원). months: 미리보기 개월 수. */
export default function RentCard({ rentMan, months = 6 }: { rentMan: number; months?: number }) {
  const fin = useFinance();
  const { months: n, interestFree } = fin.card;
  const fee = cardFeeRate(n, interestFree);
  const rents = Array.from({ length: months }, () => rentMan);
  const rows = rentSchedule(rents, n, fee);
  const feeTotal = rows.reduce((a, r) => a + r.fee, 0);
  const last = rows.at(-1);
  return (
    <section className="lf-card" aria-labelledby="lf-card-h">
      <h2 className="m-sub" id="lf-card-h">월세를 카드로 내면</h2>
      <p className="lf-frame">
        임대료 카드 결제 서비스를 쓰면 사장님은 월세를 카드로 내고 할부로 나눠 갚고, 건물주는 현금으로 받아요. 그동안 쓸 수 있는 현금이 늘어나요.
        아래 숫자는 업계 자료와 가정으로 계산한 예시예요.
      </p>
      <div className="lf-choose">
        <div className="m-seg" role="group" aria-label="월세 내는 방법">
          {CARD_MONTHS.map((k) => (
            <button type="button" key={k} aria-pressed={n === k} onClick={() => setCard(k)}>{LABEL[k]}{k ? " 할부" : ""}</button>
          ))}
        </div>
        {n > 0 && (
          <label className="lf-check">
            <input type="checkbox" checked={interestFree} onChange={(e) => setCard(n, e.target.checked)} />
            무이자 할부 (카드사 행사가 있을 때)
          </label>
        )}
      </div>
      {n === 0 ? (
        <p className="lf-line">지금은 월세 {m1(rentMan)}을 매달 현금으로 내요. 할부를 고르면 시뮬레이션의 월별 현금에 그대로 반영돼요.</p>
      ) : (
        <>
          <p className="lf-line">
            수수료는 월세의 <b>{pct(fee)}</b>예요 (서비스 수수료 {pct(0.022)}{interestFree ? ", 무이자 할부" : ` + 할부 수수료 ${pct(fee - 0.022)}`}, 업계 자료·가정).
            첫 달은 월세 {m1(rentMan)}이 현금으로 나가지 않아요. 대신 {months}개월 뒤에도 할부 <b>{m1(last?.balance ?? 0)}</b>이 남아 앞으로 갚아야 해요.{" "}
            {months}개월 수수료는 모두 {m1(feeTotal)}이에요. 손익의 월세는 그대로예요.
          </p>
          <div className="lf-scroll">
            <table className="lf-table lf-sched">
              <thead><tr><th scope="col">달</th><th scope="col" className="lf-num">현금으로 낼 때</th><th scope="col" className="lf-num">카드 할부로 낼 때</th><th scope="col" className="lf-num">현금 차이</th><th scope="col" className="lf-num">남은 할부</th></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <th scope="row">{i + 1}달째</th>
                    <td className="lf-num">−{m1(rentMan)}</td>
                    <td className="lf-num">{r.paid > 0 ? `−${m1(r.paid)}` : "0"}</td>
                    <td className={`lf-num ${r.cash_delta >= 0 ? "is-up" : "is-down"}`}>{r.cash_delta >= 0 ? "+" : "−"}{m1(Math.abs(r.cash_delta))}</td>
                    <td className="lf-num">{m1(r.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <details className="lf-src">
        <summary>수수료 근거</summary>
        <ul>{RENT_CARD_SRC.map((s) => <li key={s}>{s}</li>)}</ul>
      </details>
    </section>
  );
}
