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
import { DEPOSIT_MONTHS, LOAN_RATE, OWNER_DRAW, guStat, setQfDelivery, type CostLine, type Grade, type Profile } from "./model";

export type QfInd = "chicken" | "bunsik";
export const QF_NAME: Record<QfInd, string> = { chicken: "치킨집", bunsik: "분식집" };

type Krei = {
  sales_month_man: number; op_margin: number; food_labor_ratio: number; sales_per_worker_year_man: number; ticket_krw: number;
  visit_per_day: number; delivery_per_day: number; takeout_per_day: number; delivery_app_fee_month_krw: number; delivery_agency_fee_month_krw: number;
  interior_total_man: number; area_m2: number; open_days: number; workers: number; family_unpaid: number; wage_month_man: number;
};
// 파일이 없을 때 쓰는 값도 같은 조사의 같은 값이다 (2026-10-21 받은 값)
const FALLBACK: Record<QfInd, Krei> = {
  chicken: { sales_month_man: 1476.5, op_margin: 0.092, food_labor_ratio: 0.708, sales_per_worker_year_man: 11188, ticket_krw: 16487, visit_per_day: 26.8, delivery_per_day: 21.7, takeout_per_day: 10.2,
    delivery_app_fee_month_krw: 555376, delivery_agency_fee_month_krw: 860806, interior_total_man: 2590.7, area_m2: 54.3, open_days: 28.5, workers: 2.56, family_unpaid: 0.51, wage_month_man: 214.3 },
  bunsik: { sales_month_man: 920.6, op_margin: 0.093, food_labor_ratio: 0.71, sales_per_worker_year_man: 7614, ticket_krw: 6700.5, visit_per_day: 49.6, delivery_per_day: 15.5, takeout_per_day: 24.7,
    delivery_app_fee_month_krw: 259536, delivery_agency_fee_month_krw: 986515, interior_total_man: 2176.6, area_m2: 44, open_days: 27.5, workers: 2.64, family_unpaid: 0.53, wage_month_man: 191.3 },
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
export function setDeliveryMarket(d: { month_index?: Record<string, number> } | null) {
  if (d?.month_index) DELIVERY_MONTH = Object.fromEntries(Object.entries(d.month_index).map(([k, v]) => [Number(k), v]));
}

// 조사값에서 바로 계산하는 값
export function derived(ind: QfInd) {
  const k = K[ind];
  const orders = k.visit_per_day + k.delivery_per_day + k.takeout_per_day;          // 방문(명)과 배달·포장(인분)을 같은 단위로 본다 (가정)
  const deliveryOrders = k.delivery_per_day * k.open_days;                           // 한 달 배달 주문
  const hired = Math.max(0, k.workers - 1 - k.family_unpaid);                         // 대표·무급 가족을 뺀 고용 인원
  const laborRatio = (hired * k.wage_month_man) / k.sales_month_man;
  // 조사의 '식재료 및 인건비 비율'에는 대표자 인건비도 들어 있다 (같은 조사 사업실적표 DT_114054_028, 기타 음식점업: 식재료 41.8%,
  // 고용인 12.9%, 대표자 13.2%, 가족 3.8%. 영업이익 8.9%는 대표자 인건비를 뺀 뒤 값). 그래서 식재료비율은 (대표 + 고용) 인건비를 뺀다.
  // 치킨은 41.0%로 사업실적표의 41.8%와 맞는다. 이 시뮬레이터에서 사장 몫은 영업이익이 아니라 생활비(OWNER_DRAW)로 현금에서 빠진다
  const laborWithOwner = ((1 + hired) * k.wage_month_man) / k.sales_month_man;
  return {
    share: { visit: k.visit_per_day / orders, takeout: k.takeout_per_day / orders, delivery: k.delivery_per_day / orders },
    // 배달 한 건마다 가게가 내는 돈 (만원): 배달앱 월평균 사용료 ÷ 배달 주문, 배달대행 월평균 비용 ÷ 배달 주문 (이용 가게 평균)
    appFee: k.delivery_app_fee_month_krw / 1e4 / deliveryOrders,
    agencyFee: k.delivery_agency_fee_month_krw / 1e4 / deliveryOrders,
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

export type QfCfg = { ind: QfInd; pyeong: number; grade: Grade; staff: number; loan: number };
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
// price: 처음 가격 대비 배수, staff: 알바(고용) 인원, marketing: SNS 홍보비(만원), ad: 배달앱 광고 0 없음 / 1 기본 / 2 적극
export type QfPlan = { price: number; staff: number; marketing: number; ad: number };
export const DEFAULT_PLAN: QfPlan = { price: 1, staff: 1, marketing: 0, ad: 1 };
export type QfState = { cash: number; awareness: number; negMonths: number; closed: boolean };
export type Fx = { demand?: number; visit?: number; delivery?: number; takeout?: number; food?: number; cost?: number; awareness?: number; extraWorker?: number; feeAdd?: number; price?: number };
export type Channel = { visit: number; takeout: number; delivery: number };
export type QfMonth = {
  month: number; revenue: number; ch: Channel; orders: Channel; food: number; staffPay: number; rent: number; other: number; marketing: number; adCost: number;
  appFees: number; agencyFees: number; eventCost: number; op: number; interest: number; draw: number; cash: number; lost: number; demand: number; load: number;
  tx: number; ticket: number; awareness: number; closed: boolean; plan: QfPlan; event: string; choice: string;
};

export function startState(profile: Profile, cfg: QfCfg): QfState {
  return { cash: profile.capital + cfg.loan - qfOpeningCost(cfg, profile.gu, profile.keyMoney ?? 0).total, awareness: 0.6, negMonths: 0, closed: false };
}

export function playMonth(profile: Profile, cfg: QfCfg, s: QfState, month: number, plan: QfPlan, ev: QfEvent, opt: QfOption): { month: QfMonth; next: QfState } {
  const st = guStat(profile.gu), d = derived(cfg.ind), fx = opt.fx;
  const level = plan.price * (fx.price ?? 1);
  const base = expectedSales(cfg, profile.gu) * (st.qidx[Math.floor((month - 1) / 3)] ?? 1) * s.awareness * (ev.fx?.demand ?? 1) * (fx.demand ?? 1)
    * Math.pow(level, 1 - ELASTIC);  // 매출 = 주문 × 가격: 주문은 level^-1.2, 한 건 값은 level배
  const want: Channel = {
    visit: base * d.share.visit * (ev.fx?.visit ?? 1) * (fx.visit ?? 1),
    takeout: base * d.share.takeout * (ev.fx?.takeout ?? 1) * (fx.takeout ?? 1),
    delivery: base * d.share.delivery * DELIVERY_MONTH[month] * AD_BOOST[plan.ad] * (ev.fx?.delivery ?? 1) * (fx.delivery ?? 1),
  };
  const need = want.visit + want.takeout + want.delivery;
  const capacity = d.perWorker * HEADROOM * (1 + plan.staff + (fx.extraWorker ?? 0));
  const served = need > 0 ? need / Math.pow(1 + Math.pow(need / capacity, CAP_K), 1 / CAP_K) : 0;
  const k = need > 0 ? served / need : 1;
  const ch: Channel = { visit: want.visit * k, takeout: want.takeout * k, delivery: want.delivery * k };
  const revenue = ch.visit + ch.takeout + ch.delivery;
  const ticket = Math.round(d.ticket * level);
  const orders: Channel = { visit: (ch.visit * 1e4) / ticket, takeout: (ch.takeout * 1e4) / ticket, delivery: (ch.delivery * 1e4) / ticket };
  const appFees = orders.delivery * (d.appFee + (fx.feeAdd ?? 0));
  const agencyFees = orders.delivery * d.agencyFee;
  const food = (revenue / level) * d.foodRatio * (ev.fx?.food ?? 1) * (fx.food ?? 1);   // 가격을 올려도 식재료는 그대로
  const staffPay = d.wage * plan.staff;
  const rent = st.rent * cfg.pyeong;
  const other = revenue * OTHER;
  const adCost = AD_COST[plan.ad];
  const eventCost = fx.cost ?? 0;
  const op = revenue - food - staffPay - rent - other - plan.marketing - adCost - appFees - agencyFees - eventCost;
  const interest = (cfg.loan * LOAN_RATE) / 12;
  const cash = s.cash + op - OWNER_DRAW - interest;
  const negMonths = cash < 0 ? s.negMonths + 1 : 0;
  const awareness = Math.min(1.3, s.awareness + (1 - s.awareness) * 0.15 + (plan.marketing / 100) * 0.15 + (fx.awareness ?? 0));
  const m: QfMonth = {
    month, revenue, ch, orders, food, staffPay, rent, other, marketing: plan.marketing, adCost, appFees, agencyFees, eventCost, op, interest, draw: OWNER_DRAW, cash,
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
      id: "boknal", title: "복날 · 닭값 상승", prompt: "복날 앞뒤로 닭 주문이 몰려 주문이 8% 늘지만 닭값이 올라 식재료비가 8% 늘어요.", fx: { demand: 1.08, food: 1.08 }, note: "복날 효과와 닭값 +8%는 가정이에요 (육계 시세 자료 연결 전)",
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
      id: "rice", title: "쌀·떡값 상승", prompt: "쌀과 떡 값이 올라 식재료비가 6% 늘어요.", fx: { food: 1.06 }, note: "식재료비 +6%는 가정이에요 (분식은 쌀·곡류가 식재료비의 22%, 경영실태조사)",
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
export function qfStrategies(last: QfMonth | undefined, plan: QfPlan): { id: QfStratId; title: string; desc: string; plan: QfPlan; changes: string[] }[] {
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
    { id: "rec", title: "추천대로", desc: last ? "지난달 결과를 보고 고칠 곳만 고쳐요." : "첫 달은 기본 계획으로 시작해요.", plan: rec, changes: diffPlan(b, rec) },
    { id: "grow", title: "주문 늘리기", desc: "홍보·배달 광고·알바를 늘려 더 받아요. 돈이 더 나가요.", plan: grow, changes: diffPlan(b, grow) },
    { id: "save", title: "비용 아끼기", desc: "알바·광고·홍보를 줄여요. 바쁜 날 주문을 놓칠 수 있어요.", plan: save, changes: diffPlan(b, save) },
  ];
}
const AD_TEXT = ["안 함", "기본", "적극"];
export const PLAN_TEXT: Record<keyof QfPlan, { label: string; text: (p: QfPlan) => string; hint: string }> = {
  price: { label: "가격", text: (p) => (p.price === 1 ? "처음 가격" : `처음 가격의 ${Math.round(p.price * 100)}%`), hint: "올리면 한 건 값이 늘고 주문이 줄어요 (10% 올리면 주문 약 17% 감소, 가정)" },
  staff: { label: "알바", text: (p) => `${p.staff}명`, hint: "모자라면 몰리는 날 주문을 놓치고, 많으면 인건비가 남아요" },
  ad: { label: "배달앱 광고", text: (p) => `${AD_TEXT[p.ad]}${p.ad ? ` (${AD_COST[p.ad]}만원)` : ""}`, hint: "배달 주문이 늘지만(기본 +15%, 적극 +28%, 가정) 한 건마다 수수료도 나가요. 주문이 적은 동네에서는 광고비를 못 뽑아요" },
  marketing: { label: "SNS 홍보비", text: (p) => (p.marketing ? `${p.marketing}만원` : "없음"), hint: "인지도가 올라 손님이 늘어요 (100만원당 인지도 +0.15, 고깃집과 같은 가정)" },
};
const diffPlan = (a: QfPlan, b: QfPlan) => (Object.keys(PLAN_TEXT) as (keyof QfPlan)[])
  .filter((k) => PLAN_TEXT[k].text(a) !== PLAN_TEXT[k].text(b)).map((k) => `${PLAN_TEXT[k].label} ${PLAN_TEXT[k].text(a)} → ${PLAN_TEXT[k].text(b)}`);
