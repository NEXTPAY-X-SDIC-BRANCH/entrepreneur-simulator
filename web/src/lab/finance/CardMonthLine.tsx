// lab:finance — 한 달 정산에 붙는 월세 카드 할부 한 줄 (엔진 결과 rent_card, 원 단위).
import "./finance.css";

export type CardMonth = { paid: number; charged: number; fee: number; balance: number; months: number; cash_delta: number };
const m1 = (won: number) => `${(Math.round(won / 1e3) / 10).toLocaleString("ko-KR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}만원`;

export default function CardMonthLine({ rc }: { rc?: CardMonth | null }) {
  if (!rc) return null;
  return (
    <small className="lf-monthline">
      월세 카드 할부: {rc.charged > 0 ? `이번 달 월세 ${m1(rc.charged)}은 카드로 내서 현금이 나가지 않았어요 (${rc.months}개월 할부, 수수료 ${m1(rc.fee)}). ` : "이번 달 월세는 현금으로 냈어요. "}
      {rc.paid > 0 ? `앞서 카드로 낸 월세의 할부금 ${m1(rc.paid)}이 빠졌어요. ` : ""}
      남은 할부 {m1(rc.balance)}은 앞으로 갚아야 할 돈이에요. 손익의 월세는 그대로예요.
    </small>
  );
}

/** 시즌 결과에 붙는 한 줄: 수수료 합계와 끝났을 때 남은 할부 (달마다의 rent_card 목록). */
export function CardSeasonLine({ items }: { items: (CardMonth | undefined | null)[] }) {
  const rc = items.filter((x): x is CardMonth => !!x);
  if (!rc.length) return null;
  const last = rc[rc.length - 1];
  const fee = rc.reduce((a, x) => a + x.fee, 0);
  const months = rc.find((x) => x.months > 0)?.months ?? last.months;
  return (
    <small className="lf-monthline">
      월세를 카드 {months}개월 할부로 냈어요. 수수료는 모두 {m1(fee)}이고, 남은 할부 {m1(last.balance)}은 시즌이 끝난 뒤에도 갚아야 할 돈이에요. 마지막 현금에는 아직 빠지지 않았어요.
    </small>
  );
}
