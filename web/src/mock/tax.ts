// 세금 떼어 둘 돈 (어림). 엔진의 현금에는 부가세 납부와 종합소득세가 빠져 있어, 현금흐름표에서 따로 떼어 둔 뒤의 현금을 보여 준다.
// 모든 금액은 원. 매출은 카드·현금 결제 금액(부가세 포함)이라고 본다.
//
// 부가세 (부가가치세법)
//   간이과세자: 1년 매출 1억 400만원 미만 (2024년 7월부터). 납부세액 = 매출 × 업종 부가가치율 × 10%
//     부가가치율: 음식점업 15%, 소매업 15% (부가가치세법 시행령 제111조). 세금계산서 받은 매입 × 0.5% 공제.
//     1년 매출 4,800만원 미만이면 납부 면제.
//   일반과세자: 매출세액(매출 ÷ 11) − 매입세액(과세 매입 ÷ 11) − 의제매입세액(음식점, 면세 농축수산물 × 9/109, 개인 과세표준 2억 이하)
//   공통: 신용카드 매출세액공제 매출 × 1.3%, 연 1,000만원 한도 (조세특례제한법 제126조의3, 2027년까지)
//   내는 때: 1~6월분은 7월 25일, 7~12월분은 다음 해 1월 25일 (간이과세자는 1년치를 1월 25일)
// 종합소득세 (소득세법 제55조, 2023년 귀속부터) + 지방소득세 10%. 본인 기본공제 150만원만 뺀 어림. 내는 때: 다음 해 5월
export type TaxKind = "food" | "retail";
export type TaxIn = { revenue: number; taxableBuy: number; farmBuy?: number; profit: number };
export type TaxMonth = { vat: number; income: number; simplified: boolean; exempt: boolean };

const BRACKETS: [number, number, number][] = [ // 과세표준 상한, 세율, 누진공제
  [14_000_000, 0.06, 0], [50_000_000, 0.15, 1_260_000], [88_000_000, 0.24, 5_760_000], [150_000_000, 0.35, 15_440_000],
  [300_000_000, 0.38, 19_940_000], [500_000_000, 0.40, 25_940_000], [1_000_000_000, 0.42, 35_940_000], [Infinity, 0.45, 65_940_000],
];
export function incomeTaxYear(profit: number): number {
  const base = Math.max(0, profit - 1_500_000);
  const [, r, d] = BRACKETS.find(([cap]) => base <= cap)!;
  return Math.max(0, base * r - d) * 1.1;
}

// months: 지금까지의 달. 1년 매출과 이익은 지금까지 평균 × 12로 어림해 간이/일반과 소득세 구간을 정한다.
export function taxByMonth(months: TaxIn[], kind: TaxKind): TaxMonth[] {
  if (!months.length) return [];
  const n = months.length;
  const yearRev = (months.reduce((a, m) => a + m.revenue, 0) / n) * 12;
  const yearProfit = (months.reduce((a, m) => a + m.profit, 0) / n) * 12;
  const simplified = yearRev < 104_000_000, exempt = yearRev < 48_000_000;
  const income = incomeTaxYear(yearProfit) / 12;
  return months.map((m) => {
    const card = Math.min(m.revenue * 0.013, 10_000_000 / 12);
    let vat: number;
    if (exempt) vat = 0;
    else if (simplified) vat = m.revenue * 0.15 * 0.1 - m.taxableBuy * 0.005 - card;
    else vat = m.revenue / 11 - m.taxableBuy / 11 - (kind === "food" ? (m.farmBuy ?? 0) * 9 / 109 : 0) - card;
    return { vat: Math.max(0, vat), income, simplified, exempt };
  });
}

export const vatDue = (calMonth: number, simplified: boolean) =>
  simplified ? "다음 해 1월 25일" : calMonth <= 6 ? "7월 25일" : "다음 해 1월 25일";
