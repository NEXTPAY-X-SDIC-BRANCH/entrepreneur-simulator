// lab:finance — 가게 꾸미기 현금 상자 안의 두 줄 (지금 대출 금리, 월세 내는 방법)과 자세히 보는 창.
import { useEffect, useRef, useState } from "react";
import BankRates from "./BankRates";
import RentCard from "./RentCard";
import { loadBankRates, loanRateInfo, useFinance, type RateInfo } from "./finance";
import "./finance.css";

export default function FinanceBox({ loanMan, rentMan, loanNote, fallback }: { loanMan: number; rentMan: number; loanNote?: string; fallback?: RateInfo }) {
  const fin = useFinance();
  const [open, setOpen] = useState(false);
  const dlg = useRef<HTMLDialogElement>(null);
  useEffect(() => { loadBankRates(); }, []);
  useEffect(() => {
    const d = dlg.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  const r = loanRateInfo(fin, fallback);
  const n = fin.card.months;
  return (
    <div className="lf-box">
      <small>
        대출 금리 연 {r.rate.toFixed(2)}% ({r.who}, {r.label}){loanNote ? `. ${loanNote}` : ""}
      </small>
      <small>월세 {n === 0 ? "현금으로 내기" : `카드 ${n}개월 할부${fin.card.interestFree ? " (무이자)" : ""}`}</small>
      <button type="button" className="m-btn m-btn-quiet lf-open" onClick={() => setOpen(true)}>은행별 금리, 월세 카드 할부 보기</button>
      <dialog ref={dlg} className="lf-dialog" aria-labelledby="lf-dlg-h" onClose={() => setOpen(false)}
        onClick={(e) => { if (e.target === dlg.current) setOpen(false); }}>
        <div className="lf-dialog-in">
          <header>
            <h1 id="lf-dlg-h">대출 금리와 월세 내는 방법</h1>
            <button type="button" className="lf-x" onClick={() => setOpen(false)}>닫기</button>
          </header>
          <BankRates loanMan={loanMan} />
          <RentCard rentMan={rentMan} />
        </div>
      </dialog>
    </div>
  );
}
