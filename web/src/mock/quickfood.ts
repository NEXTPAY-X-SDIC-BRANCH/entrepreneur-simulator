// 치킨집·분식집 모델: 여는 돈, 한 달 계산, 이달의 사건, 쉬운 모드 방향. 화면은 QuickFoodBuild.tsx, QuickFoodSim.tsx.
// 옷가게처럼 달 단위 계산이다. 두 업종에서 가르치려는 것은 "배달은 매출을 늘리지만 한 건마다 수수료가 빠진다"와
// "손님이 몰리는 달에 일손이 모자라면 주문을 놓친다"이다. 손님은 매장(홀)·포장·배달 세 갈래로 나눠 센다.
//
// 숫자의 출처
//   한 달 매출 수준: 서울시 상권분석서비스 2025 치킨전문점(CS100007)·분식전문점(CS100008) 구별 카드 추정 점포당 월매출 (gu_stats.json).
//     카드 추정에는 배달앱 결제가 거의 잡히지 않아 ÷ (1 − 배달 주문 비중)으로 보정한다. 치킨은 서울 평균 937만원 → 약 1,490만원으로,
//     외식업체 경영실태조사의 전국 치킨전문점 월평균 1,477만원과 거의 같다 (model.ts guStat).
//   비용 구조·주문 갈래·배달 수수료·일손·인테리어: 외식업체 경영실태조사 2025 (2024년 실적, 전국) 치킨전문점 / 김밥 및 기타 간이 음식점업
//     (quickfood_krei.json, pipelines/fetch_krei_quickfood.py). 값마다 아래 derived()에 계산을 적었다.
//   배달 시장의 달별 크기: 통계청 온라인쇼핑동향 음식서비스 거래액 달별 배율 (delivery_market.json)
//   평당 월세·보증금 개월 수·사장 생활비·대출 금리: 다른 업종과 같은 값 (model.ts)
//   그 밖(가격 탄력, 면적 효과, 배달 광고 효과, 기타경비 5%, 설비비, 사건 효과 크기)은 가정이고 아래에 '가정'으로 적었다.
import type { ShopLayout } from "./ShopRoom3D";
import { DEPOSIT_MONTHS, LOAN_RATE, OWNER_DRAW, guStat, setQfDelivery, type CostLine, type Grade, type Profile } from "./model";

export type QfInd = "chicken" | "bunsik";
export const QF_NAME: Record<QfInd, string> = { chicken: "치킨집", bunsik: "분식집" };

type Krei = {
  sales_month_man: number; op_margin: number; food_labor_ratio: number; sales_per_worker_year_man: number; ticket_krw: number;
  visit_per_day: number; delivery_per_day: number; takeout_per_day: number; delivery_app_fee_month_krw: number; delivery_agency_fee_month_krw: number;
  interior_total_man: number; area_m2: number; open_days: number; workers: number; family_unpaid: number; wage_month_man: number;
  food_mix_pct?: Record<string, number>; delivery_app_use?: number; delivery_agency_use?: number;
};
// 파일이 없을 때 쓰는 값도 같은 조사의 같은 값이다 (2026-10-21 받은 값)
const FALLBACK: Record<QfInd, Krei> = {
  chicken: { sales_month_man: 1476.5, op_margin: 0.092, food_labor_ratio: 0.708, sales_per_worker_year_man: 11188, ticket_krw: 16487, visit_per_day: 26.8, delivery_per_day: 21.7, takeout_per_day: 10.2,
    delivery_app_fee_month_krw: 555376, delivery_agency_fee_month_krw: 860806, interior_total_man: 2590.7, area_m2: 54.3, open_days: 28.5, workers: 2.56, family_unpaid: 0.51, wage_month_man: 214.3,
    food_mix_pct: { "쌀": 3.5, "축산물": 52.4, "가공식품(공산품)": 16.9 }, delivery_app_use: 74.5, delivery_agency_use: 69.8 },
  bunsik: { sales_month_man: 920.6, op_margin: 0.093, food_labor_ratio: 0.71, sales_per_worker_year_man: 7614, ticket_krw: 6700.5, visit_per_day: 49.6, delivery_per_day: 15.5, takeout_per_day: 24.7,
    delivery_app_fee_month_krw: 259536, delivery_agency_fee_month_krw: 986515, interior_total_man: 2176.6, area_m2: 44, open_days: 27.5, workers: 2.64, family_unpaid: 0.53, wage_month_man: 191.3,
    food_mix_pct: { "쌀": 16.2, "축산물": 13.2, "가공식품(공산품)": 32.4 }, delivery_app_use: 48.5, delivery_agency_use: 48.5 },
};
let K: Record<QfInd, Krei> = FALLBACK;
let LOADED = false;
export function setQuickfoodKrei(d: Partial<Record<QfInd, Partial<Krei>>> | null) {
  if (!d) return;
  K = { chicken: { ...FALLBACK.chicken, ...(d.chicken ?? {}) } as Krei, bunsik: { ...FALLBACK.bunsik, ...(d.bunsik ?? {}) } as Krei };
  for (const ind of ["chicken", "bunsik"] as const) setQfDelivery(ind, derived(ind).share.delivery); // 구 매출 보정(model.ts)도 같은 비중으로
  LOADED = true;
}
export const quickfoodLoaded = () => LOADED;
// 통계청 음식서비스 거래액의 달별 배율 (그해 월평균 = 1). 배달 손님에만 곱한다
let DELIVERY_MONTH: Record<number, number> = { 1: 0.978, 2: 0.904, 3: 0.959, 4: 0.927, 5: 0.988, 6: 0.98, 7: 1.044, 8: 1.082, 9: 0.987, 10: 1.022, 11: 1.005, 12: 1.125 };
// 구별 배달·포장 수요 지수 (서울 = 1): 서울서베이 2022 연령·가구형태별 주당 배달·포장 식사 × 구 상주인구 연령·가구형태 (delivery_gu.json)
let DELIVERY_GU: Record<string, { index: number; single_share: number | null }> = {};
export function setDeliveryGu(d: { gu?: Record<string, { index: number; single_share: number | null }> } | null) { DELIVERY_GU = d?.gu ?? {}; }
export const deliveryGu = (gu: string) => DELIVERY_GU[gu]?.index ?? 1;
export const deliveryGuInfo = (gu: string) => DELIVERY_GU[gu] ?? null;
export function setDeliveryMarket(d: { month_index?: Record<string, number> } | null) {
  if (d?.month_index) DELIVERY_MONTH = Object.fromEntries(Object.entries(d.month_index).map(([k, v]) => [Number(k), v]));
}

// ---------------------------------------------------------------- 식재료 시세 (food_cost.json, pipelines/fetch_food_cost.py)
// 품목마다 level_vs_2024 (최근 12개월 평균 ÷ 2024년 평균)와 month_index (그해 평균 = 1, 2021~2025 평균)가 있다.
// 경영실태조사 식재료비율은 2024년 실적이라, 그 뒤 오른 몫과 달별 출렁임을 식재료비 구성 비중만큼 곱한다.
type FoodItem = { label: string; level_vs_2024: number | null; month_index: Record<string, number>; kamis?: { unit: string; latest_krw: number } };
let FOOD: Record<string, FoodItem> | null = null;
export function setFoodCost(d: { items?: Record<string, FoodItem> } | null) { FOOD = d?.items ?? null; }
export const foodItems = () => FOOD;
// 식재료비 구성(경영실태조사 DT_114054_031)의 갈래 → 생활물가지수 품목. 치킨 가공식품은 튀김유, 분식 축산물은 김밥·순대의 달걀·돼지고기,
// 분식 가공식품은 떡·어묵으로 본다 (대응은 가정). 나머지 갈래(채소·음료 등)는 지수 없이 그대로 둔다
const FOOD_MAP: Record<QfInd, [string, string[]][]> = {
  chicken: [["축산물", ["chicken"]], ["가공식품(공산품)", ["oil"]], ["쌀", ["rice"]]],
  bunsik: [["쌀", ["rice"]], ["축산물", ["egg", "pork"]], ["가공식품(공산품)", ["tteok", "fishcake"]]],
};
export type FoodPart = { group: string; items: string[]; share: number; factor: number };
export function foodMult(ind: QfInd, month: number): { mult: number; parts: FoodPart[] } {
  const mix = K[ind].food_mix_pct ?? {};
  const parts: FoodPart[] = [];
  let mult = 1;
  for (const [group, items] of FOOD_MAP[ind]) {
    const share = (mix[group] ?? 0) / 100;
    const fs = items.map((i) => FOOD?.[i]).filter((x): x is FoodItem => !!x && x.level_vs_2024 != null);
    if (!share || !fs.length) continue;
    const factor = fs.reduce((a, x) => a + x.level_vs_2024! * (x.month_index[String(month)] ?? 1), 0) / fs.length;
    mult += share * (factor - 1);
    parts.push({ group, items: fs.map((x) => x.label), share, factor });
  }
  return { mult, parts };
}

// 조사값에서 바로 계산하는 값
export function derived(ind: QfInd) {
  const k = K[ind];
  const orders = k.visit_per_day + k.delivery_per_day + k.takeout_per_day;          // 방문(명)과 배달·포장(인분)을 같은 단위로 본다 (가정)
  // 하루 배달 건수(023)는 배달 안 하는 가게까지 넣은 평균이고, 배달앱·대행 비용(016)은 이용하는 가게의 평균이다.
  // 그래서 건당 비용 = 이용 가게 비용 ÷ (전체 평균 배달 ÷ 이용 비율 × 영업일)
  const usersOrders = (use?: number) => (k.delivery_per_day / Math.max(0.05, (use ?? 100) / 100)) * k.open_days;
  const hired = Math.max(0, k.workers - 1 - k.family_unpaid);                         // 대표·무급 가족을 뺀 고용 인원
  const laborRatio = (hired * k.wage_month_man) / k.sales_month_man;
  // 조사의 '식재료 및 인건비 비율'에는 대표자 인건비도 들어 있다 (같은 조사 사업실적표 DT_114054_028, 기타 음식점업: 식재료 41.8%,
  // 고용인 12.9%, 대표자 13.2%, 가족 3.8%. 영업이익 8.9%는 대표자 인건비를 뺀 뒤 값). 그래서 식재료비율은 (대표 + 고용) 인건비를 뺀다.
  // 치킨은 41.0%로 사업실적표의 41.8%와 맞는다. 이 시뮬레이터에서 사장 몫은 영업이익이 아니라 생활비(OWNER_DRAW)로 현금에서 빠진다
  const laborWithOwner = ((1 + hired) * k.wage_month_man) / k.sales_month_man;
  return {
    share: { visit: k.visit_per_day / orders, takeout: k.takeout_per_day / orders, delivery: k.delivery_per_day / orders },
    // 배달 한 건마다 가게가 내는 돈 (만원): 배달앱 월평균 사용료 ÷ 배달 주문, 배달대행 월평균 비용 ÷ 배달 주문 (이용 가게 평균)
    appFee: k.delivery_app_fee_month_krw / 1e4 / usersOrders(k.delivery_app_use),
    agencyFee: k.delivery_agency_fee_month_krw / 1e4 / usersOrders(k.delivery_agency_use),
    foodRatio: k.food_labor_ratio - laborWithOwner,                                   // 식재료비율 = (식재료+인건비 비율) − (대표 + 고용) 인건비 비율
    laborRatio, hired,
    wage: k.wage_month_man,                                                           // 고용 1명 월 인건비 (만원)
    perWorker: k.sales_per_worker_year_man / 12,                                      // 종사원 1명당 월매출 (만원)
    areaPy: k.area_m2 / 3.3058,
    interiorPerPy: k.interior_total_man / (k.area_m2 / 3.3058),                        // 응답한 가게 평균 (모름 응답은 빠짐)
    ticket: k.ticket_krw, opMargin: k.op_margin, salesSurvey: k.sales_month_man, openDays: k.open_days,
  };
}

const ELASTIC = 2;       // 가정: 가격을 10% 올리면 주문 약 17% 감소 (주문 ∝ 가격배수^-2). 근처에 같은 업종이 많아 옮겨 가기 쉽다고 봄.
                         // 이 값이면 남는 돈이 가장 큰 가격이 처음 가격 근처라, 가격만 올려서 이기는 일이 없다
const OTHER = 0.05;      // 가정: 카드 수수료·가스·전기·수도·포장재 일부. 조사의 영업이익률에서 역산하면 월세 포함 6~10%라 월세를 따로 뺀 몫으로 5%
const HEADROOM = 1.4, CAP_K = 4; // 일손: 종사원 1명당 평균 매출 × 1.4를 감당 수준으로 본다 (옷가게와 같은 가정)
const AD_BOOST = [1, 1.15, 1.28];   // 가정: 배달앱 광고 없음 / 기본 / 적극일 때 배달 주문 배수
export const AD_COST = [0, 20, 50]; // 가정: 배달앱 광고비 (만원/월). 깃발형 광고 2~6개 수준
export const SIGN = 250;            // 간판 (다른 업종과 같은 가정)
export const EQUIP: Record<QfInd, number> = { chicken: 1500, bunsik: 1000 }; // 가정: 튀김기·냉장고·후드 / 조리대·냉장고·밥솥 (만원)
const GRADE_MULT: Record<Grade, number> = { basic: 0.7, mid: 1, high: 1.4 }; // 가정: 조사 평균을 중급으로 놓고 ±
export const GRADE_LABEL: Record<Grade, string> = { basic: "기본", mid: "중급", high: "고급" };

export type QfCfg = { ind: QfInd; pyeong: number; grade: Grade; staff: number; loan: number; layout?: ShopLayout };
export const defaultQf = (ind: QfInd): QfCfg => ({ ind, pyeong: Math.round(derived(ind).areaPy), grade: "mid", staff: 1, loan: 0 });

// 자리 잡은 뒤 한 달 매출 (만원). 면적 효과는 조사 평균 면적 기준 제곱근 (가정)
export const expectedSales = (cfg: QfCfg, gu: string) => guStat(gu).sales * Math.sqrt(cfg.pyeong / derived(cfg.ind).areaPy);

export function qfOpeningCost(cfg: QfCfg, gu: string, keyMoney = 0): { lines: CostLine[]; total: number } {
  const st = guStat(gu), d = derived(cfg.ind);
  const perPy = Math.round(d.interiorPerPy * GRADE_MULT[cfg.grade]);
  const stock = Math.round(expectedSales(cfg, gu) * d.foodRatio * 0.25);
  const lines: CostLine[] = [
    ...(keyMoney > 0 ? [{ key: "keymoney", label: "권리금", amount: keyMoney, basis: "직접 넣은 값 (나갈 때 돌려받지 못해요)" }] : []),
    { key: "deposit", label: "보증금", amount: Math.round(st.rent * cfg.pyeong * DEPOSIT_MONTHS), basis: `월세 ${DEPOSIT_MONTHS}개월분 (서울시 상가임대차 실태조사)` },
    { key: "interior", label: "인테리어 공사", amount: perPy * cfg.pyeong, basis: `${cfg.pyeong}평, 평당 ${perPy}만원 (${GRADE_LABEL[cfg.grade]}). 외식업체 경영실태조사 ${QF_NAME[cfg.ind]} 평균 평당 ${Math.round(d.interiorPerPy)}만원을 중급으로 놓음, 기본·고급은 가정` },
    { key: "equip", label: cfg.ind === "chicken" ? "튀김기·냉장·후드" : "조리대·냉장·밥솥", amount: EQUIP[cfg.ind], basis: "가정" },
    { key: "sign", label: "간판", amount: SIGN, basis: "전면 간판 1개, 가정" },
    { key: "stock", label: "첫 식재료", amount: stock, basis: `한 달 예상 매출의 1주일치를 식재료비율 ${Math.round(d.foodRatio * 100)}%로 (가정)` },
  ];
  return { lines, total: lines.reduce((n, l) => n + l.amount, 0) };
}

export function qfEstimate(profile: Profile, ind: QfInd): { pyeong: number; cost: ReturnType<typeof qfOpeningCost> } {
  let pyeong = Math.round(derived(ind).areaPy);
  const at = (p: number) => qfOpeningCost({ ...defaultQf(ind), pyeong: p }, profile.gu, profile.keyMoney ?? 0);
  while (pyeong > 7 && at(pyeong).total + 1650 > profile.capital) pyeong--;
  return { pyeong, cost: at(pyeong) };
}

// ---------------------------------------------------------------- 한 달
// price: 대표 메뉴 처음 가격 대비 배수, staff: 알바(고용) 인원, marketing: SNS 홍보비(만원), ad: 배달앱 광고 0 없음 / 1 기본 / 2 적극
// open·close: 여는 시각·닫는 시각 (24 넘으면 다음 날 새벽, 25 = 새벽 1시), pickup: 포장 할인율
// extras: hard 모드에서 정하는 곁들임 메뉴 가격 (원, 0이면 팔지 않음). 비어 있으면 처음 가격 그대로
// mix: 홀/포장/배달 비중 "홀-포장-배달" (%, 합 100). 비어 있으면 조사한 업종 평균
export type QfPlan = { price: number; staff: number; marketing: number; ad: number; open?: number; close?: number; pickup: number; extras?: Record<string, number>; mix?: string };
export const DEFAULT_PLAN: QfPlan = { price: 1, staff: 1, marketing: 0, ad: 1, pickup: 0 };

// 대표 메뉴. 처음 가격은 가정: 치킨은 주요 브랜드 후라이드 한 마리 2만원 안팎, 분식은 떡볶이 1인분 5천원 안팎 (2025년 가격 인상 보도)
export const MAIN: Record<QfInd, { name: string; p0: number }> = {
  chicken: { name: "후라이드 한 마리", p0: 20000 },
  bunsik: { name: "떡볶이 1인분", p0: 5000 },
};
export const mainPrice = (ind: QfInd, p: QfPlan) => Math.round((MAIN[ind].p0 * p.price) / 100) * 100;

// 곁들임 메뉴. a0 = 처음 가격일 때 주문 100건 중 같이 시키는 건수 (홀·포장·배달), cost = 처음 가격 대비 원가율. 모두 가정
// 조사 객단가에는 이미 처음 가격의 곁들임이 들어 있다고 보고, 가격을 바꾸거나 빼면 그 차이만 더하고 뺀다
export type Extra = { key: string; name: string; p0: number; cost: number; a0: { visit: number; takeout: number; delivery: number }; max: number };
export const EXTRAS: Record<QfInd, Extra[]> = {
  chicken: [
    { key: "side", name: "사이드 (치즈볼·핫도그·감자튀김)", p0: 4500, cost: 0.35, a0: { visit: 0.3, takeout: 0.3, delivery: 0.35 }, max: 9000 },
    { key: "drink", name: "음료 (콜라 1.25L)", p0: 2500, cost: 0.45, a0: { visit: 0.3, takeout: 0.35, delivery: 0.4 }, max: 5000 },
    { key: "beer", name: "주류 (생맥주 500cc)", p0: 4500, cost: 0.3, a0: { visit: 0.8, takeout: 0.05, delivery: 0.05 }, max: 9000 },
  ],
  bunsik: [
    { key: "side", name: "사이드 (튀김·순대)", p0: 4000, cost: 0.35, a0: { visit: 0.45, takeout: 0.4, delivery: 0.45 }, max: 8000 },
    { key: "gimbap", name: "김밥 한 줄", p0: 3500, cost: 0.4, a0: { visit: 0.35, takeout: 0.4, delivery: 0.3 }, max: 7000 },
    { key: "drink", name: "음료 (캔·쿨피스)", p0: 1500, cost: 0.45, a0: { visit: 0.2, takeout: 0.15, delivery: 0.25 }, max: 3000 },
  ],
};
// 판매 방식 비중. 조사 평균에서 한 갈래를 키우면 그 갈래 주문이 늘지만 덜 늘고(지수 0.6), 줄이면 그만큼 손님을 놓친다 (가정).
// 배달 0%면 배달앱에 안 올린 것이라 배달 주문이 없다. 홀 주문은 앉을 자리 × 하루 회전 수를 넘지 못한다.
export const MIX_EXP = 0.6;
export const TURNS: Record<QfInd, number> = { chicken: 2.5, bunsik: 4 }; // 가정: 자리 하나가 하루에 받는 팀 수 (2명 한 팀)
export function mixOf(ind: QfInd, p: QfPlan): Channel {
  const d = derived(ind).share;
  if (!p.mix) return { visit: Math.round(d.visit * 100), takeout: Math.round(d.takeout * 100), delivery: 100 - Math.round(d.visit * 100) - Math.round(d.takeout * 100) };
  const [v, t, dl] = p.mix.split("-").map(Number);
  return { visit: v, takeout: t, delivery: dl };
}
export const mixStr = (m: Channel) => `${m.visit}-${m.takeout}-${m.delivery}`;
export const mixText = (ind: QfInd, p: QfPlan) => { const m = mixOf(ind, p); return `홀 ${m.visit}% · 포장 ${m.takeout}% · 배달 ${m.delivery}%`; };
const reach = (want: number, base: number) => (base <= 0 ? want : Math.pow(want / base, MIX_EXP));
export const EXTRA_ELASTIC = 1.5; // 가정: 곁들임은 대표 메뉴보다 가격에 민감 (10% 올리면 같이 시키는 비율 약 13% 감소)
export const extraPrice = (e: Extra, p: QfPlan) => p.extras?.[e.key] ?? e.p0;
const attach = (e: Extra, price: number, ch: keyof Channel) => (price <= 0 ? 0 : e.a0[ch] * Math.pow(price / e.p0, -EXTRA_ELASTIC));
// 한 주문당 곁들임 매출·원가가 처음 가격 때보다 얼마나 달라지나 (원)
export function extrasDelta(ind: QfInd, p: QfPlan, ch: keyof Channel) {
  let rev = 0, food = 0;
  for (const e of EXTRAS[ind]) {
    const pr = extraPrice(e, p), at = attach(e, pr, ch);
    rev += at * pr - e.a0[ch] * e.p0;
    food += e.p0 * e.cost * (at - e.a0[ch]);
  }
  return { rev, food };
}

// 영업시간. 시간대별 주문 무게 (가정): 치킨은 저녁 매출이 82%라 18~22시에 몰리고, 분식은 점심과 하교 시간에 몰린다.
// 영등포구 식당운영정보(2022)에서 치킨집 81%가 자정 넘어서까지 연다. 여는 시간이 늘면 그 시간대 주문만큼 늘고 알바비·공과금도 는다
const HOUR_W: Record<QfInd, Record<number, number>> = {
  chicken: { 10: 0.3, 11: 0.6, 12: 1, 13: 0.8, 14: 0.5, 15: 0.6, 16: 1, 17: 2, 18: 4, 19: 5.5, 20: 5.5, 21: 5, 22: 4, 23: 3, 24: 2, 25: 1.2, 26: 0.6, 27: 0.3 },
  bunsik: { 8: 0.3, 9: 0.6, 10: 1, 11: 3, 12: 5, 13: 4, 14: 2.5, 15: 2.5, 16: 3, 17: 3.5, 18: 3.5, 19: 2.5, 20: 1.5, 21: 1, 22: 0.6, 23: 0.3, 24: 0.2 },
};
export const HOURS_DEFAULT: Record<QfInd, { open: number; close: number }> = { chicken: { open: 15, close: 25 }, bunsik: { open: 10, close: 21 } };
export const HOURS_RANGE: Record<QfInd, { open: [number, number]; close: [number, number] }> = {
  chicken: { open: [10, 18], close: [21, 28] }, bunsik: { open: [8, 14], close: [17, 24] },
};
const hoursOf = (ind: QfInd, p: QfPlan) => ({ open: p.open ?? HOURS_DEFAULT[ind].open, close: p.close ?? HOURS_DEFAULT[ind].close });
const wSum = (ind: QfInd, o: number, c: number) => { let t = 0; for (let h = o; h < c; h++) t += HOUR_W[ind][h] ?? 0; return t; };
export function hoursFx(ind: QfInd, p: QfPlan) {
  const { open, close } = hoursOf(ind, p), d = HOURS_DEFAULT[ind];
  const len = close - open, len0 = d.close - d.open;
  return { demand: wSum(ind, open, close) / wSum(ind, d.open, d.close), staff: len / len0, other: 0.5 + 0.5 * (len / len0), len };
}
export const clock = (h: number) => {
  const hh = h % 24;
  const ap = h >= 24 ? "새벽" : hh < 12 ? "오전" : hh === 12 ? "낮" : hh < 18 ? "오후" : "밤";
  const n = hh === 0 ? 12 : hh > 12 ? hh - 12 : hh;
  return `${ap} ${n}시`;
};
export const hoursText = (ind: QfInd, p: QfPlan) => { const { open, close } = hoursOf(ind, p); return `${clock(open)} ~ ${clock(close)} (${close - open}시간)`; };
const PICKUP_LIFT = 2; // 가정: 포장 할인 10%면 포장 주문 +20%
export type QfState = { cash: number; awareness: number; negMonths: number; closed: boolean };
export type Fx = { demand?: number; visit?: number; delivery?: number; takeout?: number; food?: number; cost?: number; awareness?: number; extraWorker?: number; feeAdd?: number; price?: number };
export type Channel = { visit: number; takeout: number; delivery: number };
export type QfMonth = {
  month: number; revenue: number; ch: Channel; orders: Channel; food: number; staffPay: number; rent: number; other: number; marketing: number; adCost: number;
  appFees: number; agencyFees: number; eventCost: number; foodMult: number; op: number; interest: number; draw: number; cash: number; lost: number; demand: number; load: number;
  tx: number; ticket: number; awareness: number; closed: boolean; plan: QfPlan; event: string; choice: string;
};

export function startState(profile: Profile, cfg: QfCfg): QfState {
  return { cash: profile.capital + cfg.loan - qfOpeningCost(cfg, profile.gu, profile.keyMoney ?? 0).total, awareness: 0.6, negMonths: 0, closed: false };
}

export function playMonth(profile: Profile, cfg: QfCfg, s: QfState, month: number, plan: QfPlan, ev: QfEvent, opt: QfOption, seats = 0): { month: QfMonth; next: QfState } {
  const st = guStat(profile.gu), d = derived(cfg.ind), fx = opt.fx;
  const level = plan.price * (fx.price ?? 1);
  const hrs = hoursFx(cfg.ind, plan);
  const pick = plan.pickup ?? 0;
  const base = expectedSales(cfg, profile.gu) * (st.qidx[Math.floor((month - 1) / 3)] ?? 1) * s.awareness * (ev.fx?.demand ?? 1) * (fx.demand ?? 1)
    * Math.pow(level, 1 - ELASTIC) * hrs.demand;  // 매출 = 주문 × 가격, 영업시간 배수
  const mx = mixOf(cfg.ind, plan), sh0 = d.share;
  const mv = sh0.visit * reach(mx.visit / 100, sh0.visit), mt = sh0.takeout * reach(mx.takeout / 100, sh0.takeout), md = sh0.delivery * reach(mx.delivery / 100, sh0.delivery);
  const seatCap = seats > 0 ? ((seats / 2) * TURNS[cfg.ind] * 30 * d.ticket * level) / 1e4 : Infinity; // 홀 매출 한도 (만원)
  const visitWant = base * mv * (ev.fx?.visit ?? 1) * (fx.visit ?? 1);
  const want: Channel = {
    visit: Number.isFinite(seatCap) ? visitWant / Math.pow(1 + Math.pow(visitWant / seatCap, 4), 1 / 4) : visitWant,
    takeout: base * mt * (ev.fx?.takeout ?? 1) * (fx.takeout ?? 1) * (1 + PICKUP_LIFT * pick) * (1 - pick),  // 할인한 만큼 한 건 값이 준다
    delivery: base * md * DELIVERY_MONTH[month] * deliveryGu(profile.gu) * AD_BOOST[plan.ad] * (ev.fx?.delivery ?? 1) * (fx.delivery ?? 1),
  };
  const need = want.visit + want.takeout + want.delivery;
  const capacity = d.perWorker * HEADROOM * (1 + plan.staff + (fx.extraWorker ?? 0));
  const served = need > 0 ? need / Math.pow(1 + Math.pow(need / capacity, CAP_K), 1 / CAP_K) : 0;
  const k = need > 0 ? served / need : 1;
  const ch0: Channel = { visit: want.visit * k, takeout: want.takeout * k, delivery: want.delivery * k };
  const ticket0 = d.ticket * level;
  const orders: Channel = { visit: (ch0.visit * 1e4) / ticket0, takeout: (ch0.takeout * 1e4) / ticket0, delivery: (ch0.delivery * 1e4) / ticket0 };
  // 곁들임 메뉴 가격을 바꾸거나 뺀 만큼 매출·원가를 더하고 뺀다 (만원)
  const xd = (["visit", "takeout", "delivery"] as const).map((c) => ({ c, ...extrasDelta(cfg.ind, plan, c) }));
  const ch: Channel = { visit: ch0.visit, takeout: ch0.takeout, delivery: ch0.delivery };
  let extraFood = 0;
  for (const x of xd) { ch[x.c] = Math.max(0, ch[x.c] + (orders[x.c] * x.rev) / 1e4); extraFood += (orders[x.c] * x.food) / 1e4; }
  const revenue = ch.visit + ch.takeout + ch.delivery;
  const ticket = Math.round((revenue * 1e4) / Math.max(1, orders.visit + orders.takeout + orders.delivery));
  const appFees = orders.delivery * (d.appFee + (fx.feeAdd ?? 0));
  const agencyFees = orders.delivery * d.agencyFee;
  const fm = foodMult(cfg.ind, month).mult;
  const food = ((ch0.visit + ch0.takeout + ch0.delivery) / level * d.foodRatio + extraFood) * fm * (ev.fx?.food ?? 1) * (fx.food ?? 1);   // 가격을 올려도 식재료는 그대로. fm = 이달 식재료 시세
  const staffPay = d.wage * plan.staff * hrs.staff;
  const rent = st.rent * cfg.pyeong;
  const other = revenue * OTHER * hrs.other;
  const adCost = AD_COST[plan.ad];
  const eventCost = fx.cost ?? 0;
  const op = revenue - food - staffPay - rent - other - plan.marketing - adCost - appFees - agencyFees - eventCost;
  const interest = (cfg.loan * LOAN_RATE) / 12;
  const cash = s.cash + op - OWNER_DRAW - interest;
  const negMonths = cash < 0 ? s.negMonths + 1 : 0;
  const awareness = Math.min(1.3, s.awareness + (1 - s.awareness) * 0.15 + (plan.marketing / 100) * 0.15 + (fx.awareness ?? 0));
  const m: QfMonth = {
    month, revenue, ch, orders, food, staffPay, rent, other, marketing: plan.marketing, adCost, appFees, agencyFees, eventCost, foodMult: fm, op, interest, draw: OWNER_DRAW, cash,
    lost: need - served, demand: need, load: Math.min(1.5, need / capacity), tx: orders.visit + orders.takeout + orders.delivery, ticket, awareness,
    closed: negMonths >= 2, plan, event: ev.title, choice: opt.label,
  };
  return { month: m, next: { cash, awareness, negMonths, closed: negMonths >= 2 } };
}

// ---------------------------------------------------------------- 이달의 사건 (달력에 맞춰 하나). 효과 크기는 모두 가정이다
export type QfOption = { id: string; label: string; pro: string; con: string; fx: Fx };
export type QfEvent = { id: string; title: string; prompt: string; fx?: Fx; note: string; options: QfOption[] };
const keep: QfOption = { id: "keep", label: "평소대로", pro: "추가 비용이 없어요", con: "기회를 놓칠 수 있어요", fx: {} };
const rain: QfEvent = {
  id: "rain", title: "장마", prompt: "비가 잦아 홀 손님이 15% 줄고 배달 주문이 12% 늘어요.", fx: { visit: 0.85, delivery: 1.12 }, note: "비 오는 날 홀 −15%·배달 +12%는 가정이에요",
  options: [
    { id: "rider", label: "바쁜 저녁에 알바 한 명 더", pro: "몰리는 배달 주문을 덜 놓쳐요", con: "알바비 60만원", fx: { extraWorker: 0.3, cost: 60 } },
    { id: "coupon", label: "비 오는 날 배달 쿠폰", pro: "배달 주문 +6%", con: "쿠폰 비용 25만원", fx: { delivery: 1.06, cost: 25 } },
    keep,
  ],
};
const freeDelivery: QfEvent = {
  id: "free_delivery", title: "배달앱 무료배달 경쟁", prompt: "근처 가게들이 배달앱 무료배달에 들어갔어요. 그대로 두면 배달 주문이 8% 줄어요.", fx: { delivery: 0.92 }, note: "무료배달 참여 시 한 건당 부담 +2,000원은 가정이에요",
  options: [
    { id: "join", label: "무료배달에 참여", pro: "배달 주문을 되찾고 +5%", con: "배달 한 건마다 2,000원을 더 내요", fx: { delivery: 1.14, feeAdd: 0.2 } },
    { id: "pickup", label: "포장 할인 10%", pro: "포장 주문 +15%", con: "포장 손님 몫 가격이 10% 낮아져요 (전체 가격 −3%로 계산)", fx: { takeout: 1.15, price: 0.97 } },
    keep,
  ],
};
export function eventOf(ind: QfInd, month: number, seed: number): QfEvent {
  if ([6, 7].includes(month)) return rain;
  if (ind === "chicken") {
    if (month === 8) return {
      id: "boknal", title: "복날", prompt: `복날 앞뒤로 닭 주문이 몰려 주문이 8% 늘어요. 닭고기 값은 8월이 한 해 중 가장 비싸요 (그해 평균의 ${(FOOD?.chicken?.month_index["8"] ?? 1).toFixed(2)}배, 생활물가지수 2021~2025).`, fx: { demand: 1.08 }, note: "복날 주문 +8%는 가정이에요. 닭값은 식재료 시세 데이터로 계산해요",
      options: [
        { id: "raise", label: "가격 3% 올리기", pro: "오른 닭값을 손님과 나눠요", con: "주문이 조금 줄어요", fx: { price: 1.03 } },
        { id: "parts", label: "순살·부분육 메뉴 밀기", pro: "식재료비 3% 절감", con: "통닭을 찾는 손님 일부가 빠져요 (−2%)", fx: { food: 0.97, demand: 0.98 } },
        keep,
      ],
    };
    if (month === 10 || month === 3) return {
      id: "sports", title: month === 10 ? "가을야구" : "프로야구 개막", prompt: "경기 있는 저녁마다 치킨 주문이 몰려요. 이번 달 배달·포장 +15%예요.", fx: { delivery: 1.15, takeout: 1.15 }, note: "경기 시즌 효과 +15%는 가정이에요",
      options: [
        { id: "set", label: "경기 세트 메뉴", pro: "주문 +5%, 인지도 상승", con: "메뉴판·홍보 15만원", fx: { demand: 1.05, cost: 15, awareness: 0.02 } },
        { id: "staff", label: "경기 날 알바 추가", pro: "몰리는 주문을 덜 놓쳐요", con: "알바비 50만원", fx: { extraWorker: 0.3, cost: 50 } },
        keep,
      ],
    };
    if (month === 12) return {
      id: "yearend", title: "연말 모임", prompt: "송년 모임으로 홀 손님이 10% 늘어요.", fx: { visit: 1.1 }, note: "연말 홀 +10%는 가정이에요",
      options: [
        { id: "group", label: "단체 예약 세트", pro: "홀 손님 +6%", con: "준비 비용 20만원", fx: { visit: 1.06, cost: 20 } },
        { id: "gift", label: "포장 선물 세트", pro: "포장 +10%", con: "포장재 15만원", fx: { takeout: 1.1, cost: 15 } },
        keep,
      ],
    };
  } else {
    if (month === 3 || month === 9) return {
      id: "school", title: "개학", prompt: "학생과 직장인 점심 손님이 돌아와 주문이 6% 늘어요.", fx: { demand: 1.06 }, note: "개학 효과 +6%는 가정이에요",
      options: [
        { id: "student", label: "학생 세트 (조금 싸게)", pro: "주문 +6%", con: "가격 −3%로 계산", fx: { demand: 1.06, price: 0.97 } },
        { id: "morning", label: "아침 김밥 영업", pro: "포장 +12%", con: "아침 알바비 45만원", fx: { takeout: 1.12, cost: 45 } },
        keep,
      ],
    };
    if ([1, 2, 8].includes(month)) return {
      id: "vacation", title: "방학", prompt: "학생 손님이 줄어 이번 달 홀·포장 손님이 7% 줄어요.", fx: { visit: 0.93, takeout: 0.93 }, note: "방학 효과 −7%는 가정이에요 (학교 근처일수록 커요)",
      options: [
        { id: "delivery", label: "배달 메뉴 늘리기", pro: "배달 +10%", con: "포장 용기 등 20만원", fx: { delivery: 1.1, cost: 20 } },
        { id: "family", label: "가족 세트 메뉴", pro: "홀·포장 +4%", con: "메뉴판 10만원", fx: { visit: 1.04, takeout: 1.04, cost: 10 } },
        keep,
      ],
    };
    if (month === 11 || month === 4) return {
      id: "rice", title: "쌀·떡값 부담", prompt: `쌀값이 2024년보다 ${Math.round(((FOOD?.rice?.level_vs_2024 ?? 1) - 1) * 100)}%, 떡값이 ${Math.round(((FOOD?.tteok?.level_vs_2024 ?? 1) - 1) * 100)}% 높아요. 이번 달 식재료비는 2024년 기준보다 ${Math.round((foodMult("bunsik", month).mult - 1) * 100)}% 많이 들어요 (생활물가지수).`, note: "대응의 효과 크기는 가정이에요. 오른 값은 식재료 시세 데이터로 이미 계산돼요",
      options: [
        { id: "raise", label: "대표 메뉴 500원 올리기", pro: "오른 값을 손님과 나눠요 (가격 +4%로 계산)", con: "주문이 조금 줄어요", fx: { price: 1.04 } },
        { id: "portion", label: "사이드 구성 줄이기", pro: "식재료비 3% 절감", con: "만족이 떨어져 주문 −2%", fx: { food: 0.97, demand: 0.98 } },
        keep,
      ],
    };
  }
  if (seed % 3 === 0 || month === 5) return freeDelivery;
  return {
    id: "quiet", title: "조용한 달", prompt: "특별한 일이 없는 달이에요. 무엇에 힘을 쓸까요?", note: "효과 크기는 가정이에요",
    options: [
      { id: "review", label: "리뷰 이벤트", pro: "인지도 +0.05", con: "서비스 메뉴 비용 25만원", fx: { cost: 25, awareness: 0.05 } },
      { id: "menu", label: "신메뉴 하나", pro: "주문 +3%", con: "재료 시험 비용 15만원", fx: { demand: 1.03, cost: 15 } },
      keep,
    ],
  };
}

// ---------------------------------------------------------------- 쉬운 모드: 달마다 방향 세 가지
export type QfStratId = "rec" | "grow" | "save";
export function qfStrategies(last: QfMonth | undefined, plan: QfPlan, ind: QfInd): { id: QfStratId; title: string; desc: string; plan: QfPlan; changes: string[] }[] {
  const b = last?.plan ?? plan;
  let rec = { ...b };
  if (last) {
    if (last.lost > last.demand * 0.08) rec = { ...rec, staff: Math.min(3, rec.staff + 1) };
    else if (last.load < 0.55 && rec.staff > 0) rec = { ...rec, staff: rec.staff - 1 };
    const net = last.ch.delivery - last.appFees - last.agencyFees - last.adCost - last.food * (last.ch.delivery / Math.max(1, last.revenue));
    if (net < 0 && rec.ad > 0) rec = { ...rec, ad: rec.ad - 1 };
    if (last.op < 0 && rec.marketing > 0) rec = { ...rec, marketing: 0 };
    if (last.awareness < 0.8 && last.cash > 1000 && rec.marketing === 0) rec = { ...rec, marketing: 50 };
  }
  const grow = { ...b, marketing: Math.max(50, b.marketing), ad: Math.min(2, b.ad + 1), staff: Math.min(3, b.staff + 1) };
  const save = { ...b, staff: Math.max(0, b.staff - 1), marketing: 0, ad: Math.max(0, b.ad - 1) };
  return [
    { id: "rec", title: "추천대로", desc: last ? "지난달 결과를 보고 고칠 곳만 고쳐요." : "첫 달은 기본 계획으로 시작해요.", plan: rec, changes: diffPlan(ind, b, rec) },
    { id: "grow", title: "주문 늘리기", desc: "홍보·배달 광고·알바를 늘려 더 받아요. 돈이 더 나가요.", plan: grow, changes: diffPlan(ind, b, grow) },
    { id: "save", title: "비용 아끼기", desc: "알바·광고·홍보를 줄여요. 바쁜 날 주문을 놓칠 수 있어요.", plan: save, changes: diffPlan(ind, b, save) },
  ];
}
const AD_TEXT = ["안 함", "기본", "적극"];
export type PlanKey = "price" | "mix" | "staff" | "ad" | "marketing" | "open" | "close" | "pickup";
export const PLAN_KEYS: PlanKey[] = ["price", "mix", "staff", "ad", "marketing", "open", "close", "pickup"];
const won = (x: number) => `${Math.round(x).toLocaleString("ko-KR")}원`;
export const planText = (ind: QfInd): Record<PlanKey, { label: string; text: (p: QfPlan) => string; hint: string }> => ({
  price: { label: `${MAIN[ind].name} 가격`, text: (p) => won(mainPrice(ind, p)), hint: `대표 메뉴 값이에요. 올리면 한 건 값이 늘고 주문이 줄어요 (10% 올리면 주문 약 17% 감소, 가정). 처음 가격 ${won(MAIN[ind].p0)}` },
  mix: { label: "판매 비중", text: (p) => mixText(ind, p), hint: "홀·포장·배달을 얼마씩 받을지예요. 배달을 키우면 주문은 늘지만 한 건마다 배달앱·대행 수수료가 빠져요. 홀은 앉을 자리만큼만 받아요 (가정)" },
  staff: { label: "알바", text: (p) => `${p.staff}명`, hint: "모자라면 몰리는 날 주문을 놓치고, 많으면 인건비가 남아요" },
  ad: { label: "배달앱 광고", text: (p) => `${AD_TEXT[p.ad]}${p.ad ? ` (${AD_COST[p.ad]}만원)` : ""}`, hint: "배달 주문이 늘지만(기본 +15%, 적극 +28%, 가정) 한 건마다 수수료도 나가요. 주문이 적은 동네에서는 광고비를 못 뽑아요" },
  marketing: { label: "SNS 홍보비", text: (p) => (p.marketing ? `${p.marketing}만원` : "없음"), hint: "인지도가 올라 손님이 늘어요 (100만원당 인지도 +0.15, 고깃집과 같은 가정)" },
  open: { label: "여는 시각", text: (p) => clock(hoursOf(ind, p).open), hint: ind === "chicken" ? "치킨은 저녁 장사라 일찍 열어도 주문이 조금만 늘어요. 여는 시간만큼 알바비가 늘어요 (시간대별 주문 무게, 가정)" : "분식은 점심(11~13시) 주문이 많아요. 늦게 열면 점심을 놓쳐요 (시간대별 주문 무게, 가정)" },
  close: { label: "닫는 시각", text: (p) => clock(hoursOf(ind, p).close), hint: ind === "chicken" ? "밤 10시~새벽 1시에 야식 주문이 몰려요. 늦게 닫을수록 주문이 늘지만 알바비·공과금이 늘어요 (가정)" : "저녁 8시 뒤로는 주문이 적어요. 늦게 닫으면 알바비·공과금이 더 늘어요 (가정)" },
  pickup: { label: "포장 할인", text: (p) => ((p.pickup ?? 0) > 0 ? `${Math.round(p.pickup * 100)}%` : "없음"), hint: "포장 손님에게 깎아 주면 포장 주문이 늘고(10% 할인 = +20%, 가정) 배달 수수료가 안 드는 주문이 많아져요" },
});
const diffPlan = (ind: QfInd, a: QfPlan, b: QfPlan) => { const T = planText(ind); return PLAN_KEYS
  .filter((k) => T[k].text(a) !== T[k].text(b)).map((k) => `${T[k].label} ${T[k].text(a)} → ${T[k].text(b)}`); };
