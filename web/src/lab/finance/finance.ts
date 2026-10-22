// lab:finance — 은행별 금리(은행연합회 비교공시 공시 평균) 고르기와 월세 카드 할부. 화면 사이에서 같은 선택을 쓰도록 모듈 하나에 상태를 둔다.
// 은행·정책자금 자료: web/public/mock/bank_rates.json (pipelines/build_bank_rates.py). 고른 금리는 model.ts의 LOAN_RATE를
// 덮어써서 기존 이자 계산(가게 꾸미기, 시뮬레이션, 투자 회수)이 그대로 따라온다.
// 월세 카드 할부의 계산은 엔진(sim/rent_card.py)이 기준이다. 여기 rentSchedule은 시뮬레이션 전 미리보기용으로 같은 식을 옮긴 것이고,
// 상수(서비스 수수료, 할부 이율)는 sim/rent_card.py와 같아야 한다 (tests/test_lab_finance.py가 json 값과 대조하지는 않으니 바꿀 때 둘 다).
import { useSyncExternalStore } from "react";
import { ecosRates, setLoanOverride } from "../../mock/model";

export type LenderLabel = "공시 평균" | "공고 금리" | "금리 공고 확인 필요";   // lab:merge 은행은 비교공시 실제 값 (가상 값 없앰)
export type Lender = {
  id: string; name: string; kind: "은행" | "인터넷은행" | "정책자금"; rate: number | null; rate_credit?: number | null;
  label: LenderLabel; who: string; url: string; as_of?: string | null; source?: string | null; youth?: boolean;
};
export type BankRates = {
  _meta: { anchor: { rate: number; month: string; series: string; source: string }; method: string; order: string; link_only: string; built: string };
  compare_url: string; lenders: Lender[]; ym: string;   // ym: 비교공시 달 (upstream 키)
};

let DATA: BankRates | null = null;
let FAILED = false;
let LOADING: Promise<BankRates | null> | null = null;
export function loadBankRates(): Promise<BankRates | null> {
  if (DATA) return Promise.resolve(DATA);
  const done = (d: BankRates | null) => { DATA = d; FAILED = !d; LOADING = d ? LOADING : null; STATE = { ...STATE }; emit(); return d; }; // 새 스냅숏이어야 다시 그려진다
  LOADING ??= fetch(`${import.meta.env.BASE_URL}mock/bank_rates.json`).then((r) => (r.ok ? r.json() : null)).then(done, () => done(null));
  return LOADING;
}
export const bankRatesFailed = () => FAILED;
export const bankRates = () => DATA;

// ---- 월세 카드 할부 (sim/rent_card.py와 같은 식) ----------------------------------------------------------
export type CardMonths = 0 | 2 | 3 | 6;
export const CARD_MONTHS: CardMonths[] = [0, 2, 3, 6];
export const SERVICE_FEE = 0.022;                                     // 업계 자료: 한달페이 사업자회원 2.2% (부가세 별도)
export const INSTALLMENT_APR: Record<2 | 3 | 6, number> = { 2: 0.125, 3: 0.175, 6: 0.189 }; // 업계 자료: 신한카드 할부수수료율 안내
export const RENT_CARD_SRC = [
  // 출처 (화면에는 서비스·카드사 이름을 쓰지 않는다): 한달페이 사업자회원 2.2%, 벤처스퀘어 2026-09-12 / 신한카드 마이월세 1% 안팎, 아이뉴스24 2020-06-30 / 신한카드 할부수수료율 안내
  "서비스 수수료 2.2% (부가세 별도): 임대료 카드 결제 서비스의 공개 사업자 수수료 예시, 2026년 9월 기사. 카드사 월세 납부 서비스는 1% 안팎 (2020년 기사)",
  "할부 수수료: 카드사 공시 할부수수료율 예시 2개월 연 12.5%, 3개월 17.5%, 6개월 18.9% (회원 신용과 카드사에 따라 달라요)",
  "카드 대금은 다음 달부터 빠진다고 가정, 할부 수수료는 원금이 줄어드는 것을 반영해 연 이율 ÷ 12 × (개월 수 + 1) ÷ 2로 어림",
];
export function cardFeeRate(months: CardMonths, interestFree = false): number {
  if (months === 0) return 0;
  const inst = interestFree ? 0 : (INSTALLMENT_APR[months] / 12) * (months + 1) / 2;
  return Math.round((SERVICE_FEE + inst) * 1e5) / 1e5;
}
export type CardStep = { paid: number; charged: number; fee: number; balance: number; cash_delta: number };
export function rentSchedule(rents: number[], months: CardMonths, feeRate: number): CardStep[] {
  if (months === 0) return [];
  let q: number[] = [];
  return rents.map((rent) => {
    const paid = q[0] ?? 0;
    const rest = q.slice(1);
    const fee = rent * feeRate;
    const inst = (rent + fee) / months;
    while (rest.length < months) rest.push(0);
    for (let i = 0; i < months; i++) rest[i] += inst;
    q = rest;
    return { paid, charged: rent, fee, balance: rest.reduce((a, b) => a + b, 0), cash_delta: rent - paid };
  });
}

// ---- 선택 상태 ---------------------------------------------------------------------------------------------
export type FinState = { lender: string | null; card: { months: CardMonths; interestFree: boolean } };
let STATE: FinState = { lender: null, card: { months: 0, interestFree: false } };
const SUBS = new Set<() => void>();
function emit() { for (const f of SUBS) f(); }
const subscribe = (f: () => void) => { SUBS.add(f); return () => { SUBS.delete(f); }; };
const snap = () => STATE;
/** 고른 은행, 카드 할부 선택. 바뀌면 이 훅을 쓰는 화면이 다시 그려진다. */
export function useFinance(): FinState { return useSyncExternalStore(subscribe, snap, snap); }

export const lenderOf = (id: string | null): Lender | null => (id && DATA ? DATA.lenders.find((l) => l.id === id) ?? null : null);
export function pickLender(l: Lender | null) {
  if (l && l.rate == null) return; // 금리를 확인하지 못한 곳은 계산에 쓰지 않는다
  STATE = { ...STATE, lender: l?.id ?? null };
  setLoanOverride(l ? l.rate! / 100 : null);
  emit();
}
export function setCard(months: CardMonths, interestFree = STATE.card.interestFree) {
  STATE = { ...STATE, card: { months, interestFree: months === 0 ? false : interestFree } };
  emit();
}
/** 엔진에 보낼 plan.rent_card (현금이면 null). */
export function rentCardPlan(s: FinState = STATE): { months: CardMonths; fee_rate: number } | null {
  return s.card.months === 0 ? null : { months: s.card.months, fee_rate: cardFeeRate(s.card.months, s.card.interestFree) };
}
/** 지금 이자 계산에 쓰는 금리 (연 %)와 그 근거 한 줄. */
export type RateInfo = { rate: number; who: string; label: string };
export function loanRateInfo(s: FinState = STATE, fallback?: RateInfo): RateInfo {
  const l = lenderOf(s.lender);
  if (l && l.rate != null) return { rate: l.rate, who: l.name, label: l.label };
  if (fallback) return fallback;
  const e = ecosRates()?.loan_sme;
  return e ? { rate: e.rate, who: "은행 평균", label: `한국은행 ${e.month.slice(0, 4)}년 ${+e.month.slice(4)}월` } : { rate: 6, who: "가정", label: "가정" };
}

/** 카페 엔진(/cafe/season)에 더할 값. 은행을 고르지 않았으면 loan_rate를 보내지 않아 엔진 기본값(params loan_rate)을 쓴다. */
export function cafeFinance(s: FinState = STATE): { loan_rate?: number; rent_card?: { months: CardMonths; fee_rate: number } } {
  const l = lenderOf(s.lender);
  const rc = rentCardPlan(s);
  return { ...(l && l.rate != null ? { loan_rate: Math.round(l.rate * 100) / 1e4 } : {}), ...(rc ? { rent_card: rc } : {}) };
}
/** 카페 엔진의 기본 대출 금리 (research/cafe/params.yaml season.loan_rate). 은행을 고르지 않았을 때 화면에 보여 준다. */
export const CAFE_DEFAULT_RATE: RateInfo = { rate: 4.5, who: "카페 엔진 기본값", label: "은행 평균과 정책자금 사이로 둔 가정" };
