// 옷가게(일반의류) 모델: 여는 돈, 한 달 계산, 이달의 사건, 쉬운 모드 방향. 화면은 ApparelBuild.tsx, ApparelSim.tsx.
// 고깃집처럼 손님 한 팀씩 돌리는 엔진이 아니라 달 단위 계산이다. 옷가게에서 가르치려는 것은 "재고가 현금을 묶는다"이다:
// 많이 사 두면 돈이 선반에 묶이고, 적게 사면 사이즈·색이 빠져 손님을 놓친다. 오래 둔 옷은 값이 떨어져 세일로 털어야 한다.
// 재고는 품목 4개(상의·하의·아우터·잡화) × 나이(들어온 지 몇 달) 칸으로 센다. 달마다 품목 비중이 바뀌어
// 철 지난 품목은 덜 팔리고 나이를 먹는다. 매입 방식(반응 재주문 / 시즌 선발주 / 위탁)은 가게를 꾸밀 때 고른다.
//
// 숫자의 출처
//   점포당 월매출·분기 지수·결제 1건 금액: 서울시 상권분석서비스 2025 일반의류(CS300011), 구 단위 (guStat, gu_stats.json apparel)
//   원가율 29.0%, 기타경비 33.6%: 통계청 도소매업조사 2024 서울 의복 소매업(4741) 연매출 1억~5억 사업체 (apparel_kosis.json)
//   일손 한 명이 감당하는 매출 월 약 978만원: 같은 조사 연매출 5억~10억 구간의 사업체당 월매출 1,955만원 ÷ 종사자 2.0명
//   평당 월세: 한국부동산원 R-ONE (guStat). 보증금 월세 12개월치: 서울시 상가임대차 실태조사 (고깃집과 같다)
//   알바 시급 10,320원과 주휴 배수 1.33, 사장 생활비 300만원, 대출 금리: 고깃집과 같은 값 (model.ts, hero_base.yaml)
//   새 가게 인지도 0.6에서 매달 15%씩 1로, 협찬 100만원당 인지도 +0.15: 고깃집 시즌 엔진의 가정 (season_params.yaml)
//   그 밖(면적 효과, 할인 탄력, 달별 품목 비중, 결품 곡선, 재고 값 하락, 세일 판매 속도, 매입 방식별 원가, 사건 효과 크기)은
//   가정이고 아래에 '가정'으로 적었다. 인터뷰·POS 자료가 생기면 이 값부터 바꾼다.
import { interiorLines, itemLines } from "./shopItems";
import { snsMonth } from "./sns";
import type { ShopLayout } from "./ShopRoom3D";
import { DEPOSIT_MONTHS, FTC_INTERIOR, GRADES, LOAN_RATE, OWNER_DRAW, guStat, type CostLine, type Grade, type Profile } from "./model";

// 옷가게 평당 인테리어 공사비(만원): 공정위 의류 가맹 분위수를 기본·중급·고급에 맞춘다 (model.ts FTC_INTERIOR)
const AP_GRADE_COST: Record<Grade, number> = { basic: FTC_INTERIOR.apparel.p25, mid: FTC_INTERIOR.apparel.median, high: FTC_INTERIOR.apparel.p75 };

export type BuyMode = "react" | "pre" | "consign";
export type ApparelCfg = { pyeong: number; grade: Grade; staff: number; stockMonths: number; loan: number; buyMode: BuyMode; layout?: ShopLayout }; // loan 만원
export const DEFAULT_APPAREL: ApparelCfg = { pyeong: 13, grade: "basic", staff: 0, stockMonths: 1.5, loan: 0, buyMode: "react" };

type Band = { band: string; cogs_ratio: number; other_ratio: number; labor_ratio: number; rent_ratio: number; op_ratio: number; sales_per_store_month_man: number; workers_per_store: number };
// 파일이 없을 때 쓰는 값도 같은 조사의 같은 구간 값이다
export const KOSIS = { cogs: 0.2903, other: 0.3358, op: 0.1387, perWorker: 978, survival3: 39.1, survival1: 55.0, loaded: false };
export function setApparelKosis(d: { bands: Band[]; survival_seoul_retail_2023: Record<string, number> } | null) {
  if (!d) return;
  const small = d.bands.find((b) => b.band.startsWith("100~500"));
  const mid = d.bands.find((b) => b.band.startsWith("500~1000"));
  if (small) Object.assign(KOSIS, { cogs: small.cogs_ratio, other: small.other_ratio, op: small.op_ratio });
  if (mid) KOSIS.perWorker = Math.round(mid.sales_per_store_month_man / mid.workers_per_store);
  KOSIS.survival3 = d.survival_seoul_retail_2023["3년 생존율"] ?? KOSIS.survival3;
  KOSIS.survival1 = d.survival_seoul_retail_2023["1년 생존율"] ?? KOSIS.survival1;
  KOSIS.loaded = true;
}

const WAGE = (10320 * 8 * 26 * 1.33) / 1e4; // 만원/월, 하루 8시간 26일 근무 알바 한 명 (최저시급 × 주휴 배수)
export const STAFF_PAY = Math.round(WAGE);
export const FIXTURES = 100, SIGN = 250; // 만원. 벽 선반·진열 조명 (가정, 행거·피팅룸 등은 shopItems.ts에서 고른 만큼), 간판 (고깃집과 같은 가정)
const BASE_PYEONG = 13; // 가정: 면적 효과의 기준. 매출은 (평수 ÷ 13)^0.5 배
const ELASTIC = 1.5;    // 가정: 할인율 10%면 팔리는 양 +15%
// 분기 안의 달 비율 (분기 평균 1): 통계청 소매판매액지수 의복 불변지수 월 합계, 2023~2025 평균 (KOSIS DT_1K41012 G21, kosis_monthly.json)
const MONTH_IN_QUARTER: Record<number, number> = { 1: 0.946, 2: 0.911, 3: 1.143, 4: 1.024, 5: 1.039, 6: 0.937, 7: 1.038, 8: 0.904, 9: 1.058, 10: 1.008, 11: 1.032, 12: 0.961 };

// ---------------------------------------------------------------- 재고: 품목 × 나이
export type Cat = "top" | "bottom" | "outer" | "acc";
export const CATS: { id: Cat; label: string }[] = [
  { id: "top", label: "상의" }, { id: "bottom", label: "하의" }, { id: "outer", label: "아우터" }, { id: "acc", label: "잡화" },
];
// 달마다 팔리는 품목 비중. 잡화는 패션 소비 실태조사 2026 SS의 가방/지갑+기타잡화 ÷ 신발을 뺀 패션 구매액 = 11.1% (fashion_market.json).
// 하의 25%와 아우터의 달별 비중은 가정이다 (실태조사는 상의·하의·아우터로 나누지 않는다). 아우터가 겨울에 늘면 상의가 그만큼 준다
// 옷가게 시장 자료 (pipelines/build_fashion_market.py): 잡화 비중, 수입 의류 원화 단가 상승, 온라인 구매 비중, 가을 소비 전망, SPA 점유
export type FashionMarket = { acc_share: number; online_share: number; spa_casual_share: number; import_cost: { krw_yoy_1_8: number; krw_yoy_aug: number; usd_yoy_1_8: number; fx_2025_1_8: number; fx_2026_1_8: number };
  fall_outlook: { index_apparel: number; decrease: number; increase: number }; indicators: { apparel_retail_yoy_1_7: number; apparel_inventory_yoy_1_7: number } };
export const MARKET: FashionMarket = { acc_share: 0.111, online_share: 0.523, spa_casual_share: 0.212,
  import_cost: { krw_yoy_1_8: 0.045, krw_yoy_aug: 0.064, usd_yoy_1_8: 0.003, fx_2025_1_8: 1416.1, fx_2026_1_8: 1475.1 },
  fall_outlook: { index_apparel: 99.7, decrease: 27.1, increase: 10.1 }, indicators: { apparel_retail_yoy_1_7: 0.092, apparel_inventory_yoy_1_7: -0.073 } };
export function setFashionMarket(d: Partial<FashionMarket> | null) { if (d) Object.assign(MARKET, d); }
const OUTER: Record<number, number> = { 1: 0.30, 2: 0.18, 3: 0.12, 4: 0.06, 5: 0.03, 6: 0.02, 7: 0.02, 8: 0.03, 9: 0.10, 10: 0.22, 11: 0.32, 12: 0.35 };
const OUTER_AVG = Object.values(OUTER).reduce((a, b) => a + b, 0) / 12;
const BOTTOM = 0.25;
export const mixOf = (m: number): Record<Cat, number> => ({ top: 1 - BOTTOM - MARKET.acc_share - OUTER[m], bottom: BOTTOM, outer: OUTER[m], acc: MARKET.acc_share });
export const mixAvg = (): Record<Cat, number> => ({ top: 1 - BOTTOM - MARKET.acc_share - OUTER_AVG, bottom: BOTTOM, outer: OUTER_AVG, acc: MARKET.acc_share });
export const AGES = 7;    // 나이 칸 0~6달, 마지막 칸은 6달 넘은 옷
export const OLD_AGE = 3; // 석 달 넘게 안 팔린 옷 = 오래된 옷
export type Inv = Record<Cat, number[]>; // 원가 기준 금액(만원). 기준 원가율로 샀을 때 값이라 매입 방식과 상관없이 '옷의 양'이다
export const emptyInv = (): Inv => ({ top: Array(AGES).fill(0), bottom: Array(AGES).fill(0), outer: Array(AGES).fill(0), acc: Array(AGES).fill(0) });
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
export const invOf = (inv: Inv, c: Cat, from = 0, to = AGES) => sum(inv[c].slice(from, to));
export const invTotal = (inv: Inv, from = 0, to = AGES) => CATS.reduce((a, c) => a + invOf(inv, c.id, from, to), 0);
// 가정: 사이즈·색 결품. 그 품목 정가 재고가 한 달 팔 양의 몇 배인지(cover)에 따라, 찾는 옷이 있는 손님 비율이 1 − e^(−2×cover):
// 한 달치면 86%, 1.5달치 95%, 반 달치 63%. 재고가 판매량만큼 있어도 사이즈·색이 다 맞지는 않는다
const FILL_K = 2;
export const fillOf = (cover: number) => 1 - Math.exp(-FILL_K * Math.max(0, cover));
// 나이별 한 달 값 하락. 석 달 넘으면 매달 11% (석 달이면 약 30%), 반년 넘으면 12%.
// 근거: 장은영(2001) 「국내 의류업체의 재고처리 및 재고감축실태 연구」 복식 51(2), 의류업체 92곳 조사:
// "제품수명이 짧은 의류제품은 시즌을 넘기면 값이 30% 이상 떨어진다" (S109). 반년 넘은 칸은 가정
const DECAY = [0, 0, 0, 0.11, 0.11, 0.11, 0.12];
// 비교 기준: 같은 논문의 제품 판매 비율 (정상가 44.9%, 30% 세일 21.4%, 50% 세일 12.9%, 시즌 재고율 28.8%). 성적표에 내 가게 값과 나란히 보여 준다
export const PAPER_SELL = { full: 0.4491, sale30: 0.2142, sale50: 0.1285, leftover: 0.2875, leadDays: 10.91 };
const MD_BASE = 0.1;      // 가정: 세일 칸의 옷이 한 달에 팔리는 비율 = 0.1 + 1.5 × 세일 폭 (제철 품목 기준)
const CONSIGN_RETURN = 3; // 가정: 위탁 옷은 석 달 안 팔리면 돌려보낸다
// 가정: 일손 한 명이 감당하는 매출 = 도소매업조사 종사자 1명당 평균 매출(KOSIS.perWorker) × 1.4. 평균은 한가한 날까지 섞인 값이라
// 실제로 받을 수 있는 양은 그보다 많다. 받을 손님이 감당 수준만큼이면 바쁜 날에 16%를 놓치고, 절반이면 거의 다 받는다
// (served = need ÷ (1 + (need/감당)^4)^(1/4))
const HEADROOM = 1.4, CAP_K = 4;

export const BUY_MODES: Record<BuyMode, { label: string; cost: number; reorder: number; desc: string }> = {
  react: { label: "동대문 반응 재주문", cost: 1, reorder: 1, desc: "매달 팔리는 만큼 다시 사요. 원가는 도소매업조사 원가율 그대로예요. 재주문하면 평균 11일 안에 들어와요 (의류업체 QR 생산 리드타임 10.9일, 장은영 2001)" },
  pre: { label: "시즌 선발주", cost: 0.88, reorder: 1.05, desc: "분기 첫 달(3·6·9·12월)에 석 달치를 한 번에 12% 싸게 사요. 중간에 떨어지면 소량 재주문은 5% 비싸요" },
  consign: { label: "위탁 매입", cost: 1.54, reorder: 1.54, desc: "선반의 옷은 도매상 것이라 미리 돈이 안 나가요. 팔린 만큼만 정산하고 석 달 안 팔린 옷은 돌려보내요. 대신 원가가 54% 비싸요 (사입이 위탁보다 30~40% 싸다는 조사, 장은영 2001)" },
};
export const BUY_MODE_ASSUME = "선발주 −12%, 소량 재주문 +5%, 위탁 반품 기한 석 달은 가정. 위탁 원가 ×1.54는 '수주(사입)판매는 위탁판매보다 30~40% 낮은 가격'(장은영 2001)의 가운데 35%로 계산";
const ORDER_MONTHS = [3, 6, 9, 12];

export const expectedSales = (gu: string, pyeong: number) => guStat(gu).sales * Math.sqrt(pyeong / BASE_PYEONG); // 만원/월, 자리 잡은 뒤

export function apparelOpeningCost(cfg: ApparelCfg, gu: string, keyMoney = 0): { lines: CostLine[]; total: number } {
  const st = guStat(gu), g = { label: GRADES[cfg.grade].label, perPyeong: AP_GRADE_COST[cfg.grade] }, bm = BUY_MODES[cfg.buyMode];
  const units = expectedSales(gu, cfg.pyeong) * KOSIS.cogs * cfg.stockMonths;
  const stock = cfg.buyMode === "consign" ? 0 : Math.round(units * bm.cost);
  const lines: CostLine[] = [
    ...(keyMoney > 0 ? [{ key: "keymoney", label: "권리금", amount: keyMoney, basis: "직접 넣은 값 (나갈 때 돌려받지 못해요)" }] : []),
    { key: "deposit", label: "보증금", amount: Math.round(st.rent * cfg.pyeong * DEPOSIT_MONTHS), basis: `월세 ${DEPOSIT_MONTHS}개월분 (서울시 상가임대차 실태조사)` },
    ...interiorLines(g.perPyeong * cfg.pyeong, `${cfg.pyeong}평, 평당 ${g.perPyeong}만원 (${g.label}). 공정위 정보공개서 의류 가맹 ${FTC_INTERIOR.apparel.n}개 브랜드의 25·50·75% 값이라 표본이 적어요`),
    { key: "seat", label: "벽 선반·진열 조명", amount: FIXTURES, basis: "가정. 행거·피팅룸·계산대는 고른 만큼 따로" },
    ...itemLines("apparel", cfg.pyeong, cfg.layout),
    { key: "sign", label: "간판", amount: SIGN, basis: "전면 간판 1개, 가정" },
    { key: "stock", label: "첫 재고", amount: stock, basis: cfg.buyMode === "consign"
      ? `위탁이라 미리 내는 돈이 없어요 (${cfg.stockMonths}개월치를 들여놓고 팔린 만큼 정산, 가정)`
      : `한 달 예상 매출 ${cfg.stockMonths}개월치를 원가 ${Math.round(KOSIS.cogs * 100)}%로 (도소매업조사)${bm.cost !== 1 ? `, ${bm.label}라 ×${bm.cost} (가정)` : ""}` },
  ];
  return { lines, total: lines.reduce((n, l) => n + l.amount, 0) };
}

// 동네 분석의 '드는 돈' 견적: 13평에서 시작해 석 달 버틸 돈까지 못 맞추면 평수를 줄인다 (최소 7평)
export function apparelEstimate(profile: Profile): { pyeong: number; cost: ReturnType<typeof apparelOpeningCost> } {
  let pyeong = 13;
  const at = (p: number) => apparelOpeningCost({ ...DEFAULT_APPAREL, pyeong: p }, profile.gu, profile.keyMoney ?? 0);
  while (pyeong > 7 && at(pyeong).total + 1650 > profile.capital) pyeong--;
  return { pyeong, cost: at(pyeong) };
}

// ---------------------------------------------------------------- 한 달
// buy: 예상 판매분 대비 매입 배수, marketing 만원, markdownAge: 몇 달 지난 옷부터 세일 칸으로 옮길지, markdown: 세일 폭, focus: 더 들일 품목
// buyCat: hard 모드 품목별 매입 배수 (상의·하의·아우터·잡화 따로, 1 = 예상 판매만큼). onlineAd: 온라인 광고비(만원), freeShip: 무료배송
export type ApPlan = { buy: number; discount: number; staff: number; marketing: number; markdownAge: number; markdown: number; focus: Cat | "none"; online: number;
  buyCat?: Partial<Record<Cat, number>>; onlineAd?: number; freeShip?: boolean;
  // hard 모드 추가 (1 = 함): live SNS 라이브·공동구매, vmd 진열 바꾸기, loyalty 회원 적립, alter 사이즈 교환·수선
  live?: number; vmd?: number; loyalty?: number; alter?: number };
// 온라인 판매 (online: 0 안 함 / 1 스마트스토어 / 2 패션 플랫폼 입점). 같은 재고로 판다. 근거: 2026 SS 패션 구매의 52.3%가 온라인 (S105).
// 매장 대비 늘어나는 주문(lift), 판매 수수료(fee), 월 고정비(fixed, 사진·등록·광고), 주문당 택배비(ship, 만원)와 반품률은 가정이다
export const ONLINE = [
  { label: "안 함", lift: 0, fee: 0, fixed: 0, ship: 0 },
  { label: "스마트스토어", lift: 0.15, fee: 0.056, fixed: 15, ship: 0.3 },
  { label: "패션 플랫폼 입점", lift: 0.35, fee: 0.28, fixed: 10, ship: 0.3 },
];
// 가정: 온라인 광고는 최대 +50%까지 온라인 주문을 늘리고(반은 50만원에서), 고객이 택배비를 내면 온라인 주문이 25% 적다
const ONLINE_AD_MAX = 0.5, ONLINE_AD_HALF = 50, PAID_SHIP_LIFT = 0.75;
export const onlineLift = (plan: ApPlan, month = 0) => {
  const on = ONLINE[plan.online ?? 0] ?? ONLINE[0];
  if (!on.lift) return 0;
  return on.lift * (1 + ONLINE_AD_MAX * (1 - Math.exp(-(plan.onlineAd ?? 0) / ONLINE_AD_HALF))) * (plan.freeShip === false ? PAID_SHIP_LIFT : 1)
    * (plan.live ? 1 + AP_MORE.liveLift * snsMonthOf(month) : 1);
};
// hard 모드 추가 선택지의 효과 (모두 가정)
const snsMonthOf = (m: number) => (m ? snsMonth("apparel", m) : 1);
export const AP_MORE = { liveLift: 0.3, liveCost: 30, vmdDemand: 1.04, vmdCost: 40, loyaltyDemand: 1.03, loyaltyGive: 0.02, alterLostCut: 0.15, alterCostShare: 0.01 };
const ONLINE_RETURN = 0.15; // 가정: 온라인 주문 중 반품 비율 (반품 택배비만 더 든다고 본다)
export const ONLINE_ASSUME = "온라인 주문 증가(스마트스토어 매장의 +15%, 플랫폼 +35%), 수수료(5.6% / 28%), 택배비 3,000원, 반품 15%, 월 고정비(15만 / 10만원), 온라인 매출의 기타경비 15%, 포장 일손은 가정. 인터뷰로 확인 필요";
// 세일 시작 2달·폭 30%: "직영점이나 백화점에서 통상 1~2개월 정상판매되고 … 정상가의 20~30% 할인된 가격으로" (장은영 2001)
export const DEFAULT_PLAN: ApPlan = { buy: 1, discount: 0, staff: 0, marketing: 0, markdownAge: 2, markdown: 0.3, focus: "none", online: 0 };
// costAvg = 지금 선반 재고를 산 평균 원가 배수 (매입 방식·재주문에 따라 1 근처). 재고를 돈으로 셀 때 곱한다
export type ApState = { cash: number; inv: Inv; costAvg: number; awareness: number; negMonths: number; closed: boolean };
export type Fx = { demand?: number; buy?: number; discount?: number; cost?: number; awareness?: number; clear?: number; clearCut?: number; buyCost?: number }; // buyCost: 이달 매입 단가 배수
// 품목별 한 달 (원가 기준 만원, demand·lostStock만 정가 매출 기준)
export type CatMonth = { demand: number; bought: number; sold: number; mdSold: number; fill: number; lostStock: number; stock: number; old: number };
export type ApMonth = {
  month: number; revenue: number; cogs: number; staffPay: number; rent: number; other: number; marketing: number; eventCost: number;
  op: number; interest: number; draw: number; purchase: number; settle: number; cash: number; stockEnd: number; oldEnd: number; consigned: number;
  writeOff: number; returned: number; mdRev: number; clearRev: number; onlineRev: number; onlineCost: number; onlineOrders: number;
  lost: number; lostStock: number; lostCap: number; fill: number; sellThrough: number; load: number; tx: number; ticket: number; awareness: number;
  closed: boolean; demand: number; plan: ApPlan; event: string; choice: string; buyMode: BuyMode; ordered: boolean;
  cats: Record<Cat, CatMonth>; invEnd: Inv; costAvg: number;
};

export function startState(profile: Profile, cfg: ApparelCfg, month = 1): ApState {
  const units = expectedSales(profile.gu, cfg.pyeong) * KOSIS.cogs * cfg.stockMonths;
  const cost = apparelOpeningCost(cfg, profile.gu, profile.keyMoney ?? 0);
  const inv = emptyInv(), mix = mixOf(month);
  for (const c of CATS) inv[c.id][0] = units * mix[c.id];
  return { cash: profile.capital + cfg.loan - cost.total, inv, costAvg: BUY_MODES[cfg.buyMode].cost, awareness: 0.6, negMonths: 0, closed: false };
}
// 정산 화면의 '이 달을 다시': 지난달 끝 상태로 되돌린다
export const stateAfter = (m: ApMonth): ApState => ({ cash: m.cash, inv: m.invEnd, costAvg: m.costAvg, awareness: m.awareness, negMonths: m.cash < 0 ? 1 : 0, closed: false });
// 화면에 보이는 재고 금액: 내 돈이 묶인 재고 (위탁은 도매상 것이라 0)
export const stockValue = (s: ApState, cfg: ApparelCfg, from = 0) => (cfg.buyMode === "consign" ? 0 : invTotal(s.inv, from) * s.costAvg);

export function playMonth(profile: Profile, cfg: ApparelCfg, s: ApState, month: number, plan: ApPlan, ev: ApEvent, opt: ApOption): { month: ApMonth; next: ApState } {
  const st = guStat(profile.gu);
  const fx = opt.fx;
  const bm = BUY_MODES[cfg.buyMode], consign = cfg.buyMode === "consign";
  const cogsR = KOSIS.cogs;
  const discount = Math.min(0.5, plan.discount + (fx.discount ?? 0));
  const baseAt = (mm: number) => expectedSales(profile.gu, cfg.pyeong) * (st.qidx[Math.floor((mm - 1) / 3)] ?? 1) * MONTH_IN_QUARTER[mm];
  const demandStore = baseAt(month) * s.awareness * (ev.demand ?? 1) * (fx.demand ?? 1) * (1 + ELASTIC * discount) // 매장에서 정가로 팔고 싶은 양 (만원)
    * (plan.vmd ? AP_MORE.vmdDemand : 1) * (plan.loyalty ? AP_MORE.loyaltyDemand : 1);
  const on = ONLINE[plan.online ?? 0] ?? ONLINE[0];
  const lift = onlineLift(plan, month);
  const demand = demandStore * (1 + lift);   // 온라인 주문도 같은 재고·같은 일손(포장)으로 받는다
  // 사장 + 알바가 감당하는 매출. 온라인 주문 포장은 영업시간 밖에 한다고 보고 그 절반만큼 일손을 더 쳐 준다 (가정)
  const capacity = KOSIS.perWorker * HEADROOM * (1 + plan.staff) * (1 + lift * 0.5);
  const mix = mixOf(month);
  const inv: Inv = { top: [...s.inv.top], bottom: [...s.inv.bottom], outer: [...s.inv.outer], acc: [...s.inv.acc] };
  const mdAge = plan.markdownAge;
  const buyMul = Math.max(0.3, plan.buy + (fx.buy ?? 0));
  const tilt = (c: Cat) => (plan.focus === c ? 1.3 : 1) * (plan.buyCat?.[c] ?? 1);

  // 1) 매입 (월초). 새 옷은 나이 0 칸에 들어간다. 세일 칸(나이 ≥ markdownAge)은 채워야 할 양에 세지 않는다
  const ordered = cfg.buyMode === "pre" && ORDER_MONTHS.includes(month);
  const bought = {} as Record<Cat, number>;
  let paid = 0, units = 0;
  for (const { id: c } of CATS) {
    const want = demand * mix[c] * cogsR;
    const fresh = invOf(inv, c, 0, mdAge);
    let need = 0, price = bm.cost * (fx.buyCost ?? 1);
    if (ordered) {
      // 다음 석 달 예상 판매를 한 번에 (이달 사건·할인 효과는 이달 몫에만)
      const later = [1, 2].reduce((a, k) => { const mm = ((month - 1 + k) % 12) + 1; return a + baseAt(mm) * s.awareness * mixOf(mm)[c] * cogsR; }, 0);
      need = (want + later) * buyMul * tilt(c) - fresh;
    } else if (cfg.buyMode === "pre") {
      // 선발주 사이 달: 반 달치 밑으로 떨어진 품목만 한 달치까지 소량 재주문
      if (fresh < want * 0.5) { need = want * buyMul * tilt(c) - fresh; price = bm.reorder * (fx.buyCost ?? 1); }
    } else {
      need = want * buyMul * cfg.stockMonths * tilt(c) - fresh;
    }
    bought[c] = Math.max(0, need);
    inv[c][0] += bought[c];
    paid += bought[c] * price;
    units += bought[c];
  }
  const before = invTotal(s.inv);
  const costAvg = units > 0 ? (before * s.costAvg + paid) / (before + units) : s.costAvg;
  const avail = invTotal(inv);

  // 2) 정가 판매: 품목마다 결품 곡선으로 찾는 옷이 있는 손님만 산다. 일손이 모자라면 전체를 줄인다
  const reach = {} as Record<Cat, number>, fills = {} as Record<Cat, number>;
  for (const { id: c } of CATS) {
    const want = demand * mix[c];
    fills[c] = want > 0 ? fillOf(invOf(inv, c, 0, mdAge) / (want * cogsR)) : 1;
    reach[c] = want * fills[c];
  }
  const reachAll = CATS.reduce((a, c) => a + reach[c.id], 0);
  const cats = {} as Record<Cat, CatMonth>;
  let soldUnits = 0, fullRev = 0, mdRev = 0, clearRev = 0, lostStock = 0;
  // 세일 칸부터: 세일 폭이 클수록, 제철 품목일수록 빨리 빠진다. 사건 대응의 정리 세일은 두 달 넘은 옷 중 남은 것의 일부를 판다
  const mdSold = {} as Record<Cat, number>;
  for (const { id: c } of CATS) {
    const fit = Math.max(0.3, Math.min(1.5, mix[c] / mixAvg()[c]));
    const rate = Math.min(0.9, (MD_BASE + ELASTIC * plan.markdown) * fit);
    let md = 0, cleared = 0;
    for (let a = mdAge; a < AGES; a++) { const x = inv[c][a] * rate; inv[c][a] -= x; md += x; }
    if (fx.clear) for (let a = 2; a < AGES; a++) { const x = inv[c][a] * fx.clear; inv[c][a] -= x; cleared += x; }
    mdRev += (md / cogsR) * (1 - plan.markdown);
    clearRev += (cleared / cogsR) * (1 - (fx.clearCut ?? 0));
    mdSold[c] = md + cleared;
  }
  // 일손: 받을 손님(정가 + 세일)이 감당 수준에 가까워질수록 바쁜 날 놓치는 손님이 서서히 는다 (부드러운 한도, 아래 served)
  // 세일 손님도 같은 일손으로 받고, 놓치는 몫은 정가 손님에서 뺀다
  const need = reachAll + mdRev + clearRev;
  const served = need > 0 ? need / Math.pow(1 + Math.pow(need / capacity, CAP_K), 1 / CAP_K) : 0;
  const capScale = reachAll > 0 ? Math.min(1, Math.max(0, served - mdRev - clearRev) / reachAll) : 1;
  for (const { id: c } of CATS) {
    // 정가 칸은 오래된 옷부터 판다 (선반 앞쪽에 먼저 꺼내 둔다)
    const soldFull = Math.min(invOf(inv, c, 0, mdAge), reach[c] * capScale * cogsR);
    let left = soldFull;
    for (let a = mdAge - 1; a >= 0 && left > 0; a--) { const x = Math.min(inv[c][a], left); inv[c][a] -= x; left -= x; }
    fullRev += soldFull / cogsR;
    soldUnits += soldFull + mdSold[c];
    const ls = demand * mix[c] * (1 - fills[c]) * (plan.alter ? 1 - AP_MORE.alterLostCut : 1); // 사이즈 교환·수선이면 일부는 다른 사이즈로 산다
    lostStock += ls;
    cats[c] = { demand: demand * mix[c], bought: bought[c], sold: soldFull, mdSold: mdSold[c], fill: fills[c], lostStock: ls, stock: 0, old: 0 };
  }
  const lostCap = reachAll * (1 - capScale);

  // 3) 한 달 나이 먹기: 칸을 한 칸씩 민다. 오래된 옷은 값이 떨어지고(평가손), 위탁 옷은 석 달이 되면 돌려보낸다
  let woUnits = 0, returned = 0;
  for (const { id: c } of CATS) {
    const a = inv[c];
    const next = [0, ...a.slice(0, AGES - 2), a[AGES - 2] + a[AGES - 1]];
    for (let k = 0; k < AGES; k++) {
      if (consign && k >= CONSIGN_RETURN) { returned += next[k]; next[k] = 0; continue; }
      const d = next[k] * DECAY[k]; next[k] -= d; woUnits += d;
    }
    inv[c] = next;
    cats[c].stock = sum(next);
    cats[c].old = invOf(inv, c, OLD_AGE);
  }
  const own = consign ? 0 : 1;
  const writeOff = woUnits * costAvg * own;
  const revenue = (fullRev * (1 - discount) + mdRev + clearRev) * (plan.loyalty ? 1 - AP_MORE.loyaltyGive : 1); // 회원 적립금만큼 매출이 준다
  // 온라인 몫: 정가 판매 중 온라인 주문 비중만큼. 수수료 + (주문 + 반품) 택배비 + 월 고정비
  const onlineRev = lift > 0 ? fullRev * (1 - discount) * (lift / (1 + lift)) : 0;
  const onlineOrders = (onlineRev * 1e4) / st.ticket;
  // 택배비: 무료배송이면 보내는 택배 + 반품 택배, 고객이 내면 반품 택배만 가게가 낸다. 온라인 광고비는 온라인 비용에 넣는다
  const shipN = plan.freeShip === false ? ONLINE_RETURN : 1 + ONLINE_RETURN;
  const onlineCost = lift > 0 ? onlineRev * on.fee + onlineOrders * shipN * on.ship + on.fixed + (plan.onlineAd ?? 0) : 0;
  const cogs = soldUnits * (consign ? bm.cost : costAvg);
  const staffPay = STAFF_PAY * plan.staff;
  const rent = st.rent * cfg.pyeong;
  // 기타경비(카드 수수료·공과금·포장 등)는 매장 매출에 도소매업조사 비율, 온라인 매출에는 15% (카드 수수료는 플랫폼 수수료로 대신, 가정)
  const other = (revenue - onlineRev) * KOSIS.other + onlineRev * 0.15;
  const marketing = plan.marketing;
  // 사건 대응 + SNS 라이브 + 진열 바꾸기 + 수선비 (정산표 '홍보·사건 대응' 줄)
  const eventCost = (fx.cost ?? 0) + (plan.live ? AP_MORE.liveCost : 0) + (plan.vmd ? AP_MORE.vmdCost : 0) + (plan.alter ? revenue * AP_MORE.alterCostShare : 0);
  const op = revenue - cogs - staffPay - rent - other - marketing - eventCost - writeOff - onlineCost;
  const interest = (cfg.loan * LOAN_RATE) / 12;
  const purchase = consign ? 0 : paid;
  const settle = consign ? cogs : 0; // 위탁: 팔린 옷값을 도매상에 정산
  const cash = s.cash + revenue - purchase - settle - staffPay - rent - other - marketing - eventCost - onlineCost - OWNER_DRAW - interest;
  const negMonths = cash < 0 ? s.negMonths + 1 : 0;
  const awareness = Math.min(1.3, s.awareness + (1 - s.awareness) * 0.15 + (marketing / 100) * 0.15 + (fx.awareness ?? 0));
  const endUnits = invTotal(inv);
  const m: ApMonth = {
    month, revenue, cogs, staffPay, rent, other, marketing, eventCost, op, interest, draw: OWNER_DRAW, purchase, settle, cash,
    stockEnd: endUnits * costAvg * own, oldEnd: invTotal(inv, OLD_AGE) * costAvg * own, consigned: consign ? endUnits * bm.cost : 0,
    writeOff, returned: returned * bm.cost, mdRev, clearRev, onlineRev, onlineCost, onlineOrders,
    lost: lostStock + lostCap, lostStock, lostCap, fill: demand > 0 ? reachAll / demand : 1,
    sellThrough: avail > 0 ? soldUnits / avail : 0, load: Math.min(1.5, demand / capacity), tx: (revenue * 1e4) / st.ticket, ticket: st.ticket,
    awareness, closed: negMonths >= 2, demand, plan, event: ev.title, choice: opt.label, buyMode: cfg.buyMode, ordered,
    cats, invEnd: inv, costAvg,
  };
  return { month: m, next: { cash, inv, costAvg, awareness, negMonths, closed: negMonths >= 2 } };
}

// ---------------------------------------------------------------- 이달의 사건 (달력에 맞춰 하나). 효과 크기는 가정이다
export type ApOption = { id: string; label: string; pro: string; con: string; fx: Fx };
export type ApEvent = { id: string; title: string; prompt: string; demand?: number; note: string; options: ApOption[] };
const keep: ApOption = { id: "keep", label: "평소대로", pro: "추가 비용이 없어요", con: "기회를 놓칠 수 있어요", fx: {} };
export function eventOf(month: number, seed: number): ApEvent {
  if ([2, 5, 8, 11].includes(month)) return {
    id: "season_off", title: "시즌 오프: 지난 시즌 재고", prompt: "계절이 바뀌어요. 두 달 넘게 안 팔린 옷이 선반에 남아 있어요. 석 달이 넘으면 매달 값이 떨어져요.", note: "정리 세일로 팔리는 비율은 가정이에요",
    options: [
      { id: "sale30", label: "30% 정리 세일", pro: "두 달 넘은 옷의 70%를 현금으로 바꿔요", con: "정가보다 30% 싸게 팔아 남는 게 적어요", fx: { clear: 0.7, clearCut: 0.3 } },
      { id: "sale15", label: "15% 세일", pro: "덜 깎고 일부를 털어요", con: "두 달 넘은 옷의 40%만 팔려요", fx: { clear: 0.4, clearCut: 0.15 } },
      { id: "hold", label: "그대로 둔다", pro: "깎아 팔지 않아요", con: "오래된 옷은 매달 값이 더 떨어지고 돈이 계속 묶여요", fx: {} },
    ],
  };
  if ([3, 9].includes(month)) return {
    id: "new_season", title: "새 시즌 신상 입고", prompt: "새 시즌 옷을 얼마나 들일까요? 많이 들이면 사이즈가 덜 빠지지만 현금이 재고에 묶여요.", note: "신상 효과 크기는 가정이에요",
    options: [
      { id: "many", label: "많이 들인다", pro: "고를 게 많아 손님 +6%", con: "평소보다 30% 더 사서 현금이 묶여요", fx: { buy: 0.3, demand: 1.06 } },
      { id: "normal", label: "평소만큼", pro: "현금과 재고의 균형", con: "특별한 효과는 없어요", fx: {} },
      { id: "few", label: "조금만 들인다", pro: "현금을 아껴요", con: "고를 게 적어 손님 −4%, 사이즈도 더 빠져요", fx: { buy: -0.2, demand: 0.96 } },
    ],
  };
  if ([6, 7].includes(month)) return {
    id: "rain", title: "장마", prompt: "비가 잦아 거리에 사람이 줄었어요. 이번 달 손님 −10%예요.", demand: 0.9, note: "손님 −10%는 고깃집 시뮬의 비 오는 날 가정과 같아요",
    options: [
      { id: "rain_item", label: "레인 아이템 들이기", pro: "우산·레인부츠로 손님 일부를 되찾아요 (+6%)", con: "50만원어치를 따로 사요", fx: { demand: 1.06, cost: 50 } },
      { id: "live", label: "인스타 라이브 판매", pro: "가게 밖 손님에게 팔아 +5%, 인지도도 올라요", con: "준비와 촬영에 30만원", fx: { demand: 1.05, cost: 30, awareness: 0.03 } },
      keep,
    ],
  };
  if ([4, 10].includes(month) && seed % 4 === 1) {
    const up = MARKET.import_cost.krw_yoy_1_8;
    return {
      id: "import_cost", title: "수입 의류 도매가 상승", prompt: `환율이 올라 수입 옷의 원화 값이 1년 전보다 ${(up * 100).toFixed(1)}% 비싸졌어요 (달러 단가 ${(MARKET.import_cost.usd_yoy_1_8 * 100).toFixed(1)}% × 원/달러 ${Math.round(MARKET.import_cost.fx_2025_1_8).toLocaleString("ko-KR")}→${Math.round(MARKET.import_cost.fx_2026_1_8).toLocaleString("ko-KR")}원). 이번 달 들이는 옷 값이 그만큼 올라요.`,
      note: "원가 상승폭은 2026년 1~8월 의류 수입실적(섬유류 수출입실적)과 환율로 계산했어요. 대응의 효과 크기는 가정이에요",
      options: [
        { id: "absorb", label: "그대로 들인다", pro: "고를 옷이 그대로예요", con: `이달 매입 원가 +${(up * 100).toFixed(1)}%`, fx: { buyCost: 1 + up } },
        { id: "local", label: "동대문 국내 생산 비중 늘리기", pro: "환율 영향을 덜 받아요 (원가 그대로)", con: "고를 옷이 줄어 손님 −2%", fx: { buyCost: 1, demand: 0.98 } },
        { id: "price", label: "정가 3% 올리기", pro: "오른 원가를 손님과 나눠요", con: `원가는 +${(up * 100).toFixed(1)}%, 팔리는 양 −4.5%`, fx: { buyCost: 1 + up, discount: -0.03 } },
      ],
    };
  }
  if ([4, 10].includes(month) || seed % 4 === 0) return {
    id: "spa", title: "근처에 SPA 브랜드 매장 오픈", prompt: `큰 의류 브랜드 매장이 근처에 열었어요. 이번 달 손님 −9%예요. 캐주얼 옷을 산 사람의 ${Math.round(MARKET.spa_casual_share * 100)}%가 유니클로·탑텐·자라에서 샀어요 (패션 소비 실태조사 2026 SS).`, demand: 0.91, note: "손님 −9%는 고깃집 시뮬의 경쟁점 개점 효과(S20)를 빌려 썼어요",
    options: [
      { id: "cut10", label: "10% 할인 행사", pro: "가격으로 맞서 팔리는 양 +15%", con: "한 벌에 남는 돈이 줄어요", fx: { discount: 0.1 } },
      { id: "regular", label: "단골에게 쿠폰 문자", pro: "단골을 붙잡아 +4%", con: "문자·쿠폰 비용 20만원", fx: { demand: 1.04, cost: 20 } },
      keep,
    ],
  };
  if (month === 12 || month === 1) return {
    id: "peak", title: month === 12 ? "연말 대목" : "설 앞두고 선물 수요", prompt: "선물과 모임으로 옷을 사는 사람이 늘어요. 재고를 더 들일까요?", demand: 1.05, note: "연말 수요의 대부분은 분기 지수에 이미 들어 있어요. +5%는 가정이에요",
    options: [
      { id: "stock_up", label: "재고를 더 들인다", pro: "사이즈가 덜 빠지고 손님 +5%", con: "20% 더 사서 현금이 묶여요", fx: { buy: 0.2, demand: 1.05 } },
      { id: "wrap", label: "선물 포장 서비스", pro: "선물 손님 +3%, 인지도 상승", con: "포장재 15만원", fx: { demand: 1.03, cost: 15, awareness: 0.02 } },
      keep,
    ],
  };
  return {
    id: "quiet", title: "조용한 달", prompt: "특별한 일이 없는 달이에요. 무엇에 힘을 쓸까요?", note: "효과 크기는 가정이에요",
    options: [
      { id: "sns", label: "SNS 홍보", pro: "인지도 +0.05", con: "광고비 30만원", fx: { cost: 30, awareness: 0.05 } },
      { id: "display", label: "진열 바꾸기", pro: "새로워 보여 손님 +3%", con: "소품·조명 비용 10만원", fx: { demand: 1.03, cost: 10 } },
      keep,
    ],
  };
}

// ---------------------------------------------------------------- 쉬운 모드: 달마다 방향 세 가지
export type ApStratId = "rec" | "grow" | "save";
// 다음 달 가장 잘 팔릴 철 품목: 아우터 철(비중 20% 이상)이면 아우터, 아니면 상의
const nextFocus = (m: number): Cat => (OUTER[(m % 12) + 1] >= 0.2 ? "outer" : "top");
export function apStrategies(last: ApMonth | undefined, plan: ApPlan): { id: ApStratId; title: string; desc: string; plan: ApPlan; changes: string[] }[] {
  const b = last?.plan ?? plan;
  let rec = { ...b };
  if (last) {
    if (last.lostCap > last.demand * 0.1) rec = { ...rec, staff: Math.min(2, rec.staff + 1) };
    if (last.lostStock > last.demand * 0.15) rec = { ...rec, buy: Math.min(1.5, +(rec.buy + 0.1).toFixed(1)) };
    if (last.stockEnd > last.revenue * KOSIS.cogs * 2) rec = { ...rec, buy: Math.max(0.7, +(rec.buy - 0.2).toFixed(1)) };
    if (last.stockEnd > 0 && last.oldEnd > last.stockEnd * 0.3) rec = { ...rec, markdownAge: Math.max(2, rec.markdownAge - 1) };
    rec = { ...rec, focus: nextFocus(last.month) };
    if (last.op < 0 && rec.marketing > 0) rec = { ...rec, marketing: 0 };
    if (last.awareness < 0.8 && last.cash > 1000 && rec.marketing === 0) rec = { ...rec, marketing: 50 };
  }
  const grow = { ...b, marketing: Math.max(50, b.marketing), buy: Math.min(1.5, +(b.buy + 0.2).toFixed(1)), discount: Math.min(0.3, +(b.discount + 0.05).toFixed(2)), online: Math.max(1, b.online ?? 0) };
  const save = { ...b, staff: Math.max(0, b.staff - 1), buy: Math.max(0.7, +(b.buy - 0.15).toFixed(2)), marketing: 0, discount: 0, markdownAge: 2, markdown: Math.max(b.markdown, 0.4) };
  return [
    { id: "rec", title: "추천대로", desc: last ? "지난달 결과를 보고 고칠 곳만 고쳐요. 다음 달 잘 팔릴 품목을 더 들여요." : "첫 달은 기본 계획으로 시작해요.", plan: rec, changes: diffPlan(b, rec) },
    { id: "grow", title: "손님 늘리기", desc: "홍보·할인·재고를 늘려 더 팔아요. 현금이 더 나가요.", plan: grow, changes: diffPlan(b, grow) },
    { id: "save", title: "비용 아끼기", desc: "알바·매입·홍보를 줄이고 오래된 옷을 일찍 크게 세일해 현금을 돌려요. 사이즈가 빠질 수 있어요.", plan: save, changes: diffPlan(b, save) },
  ];
}
export const catLabel = (c: Cat | "none") => (c === "none" ? "고르게" : CATS.find((x) => x.id === c)!.label);
export const PLAN_TEXT: Record<keyof ApPlan, { label: string; text: (p: ApPlan) => string; hint: string }> = {
  buy: { label: "매입량", text: (p) => `예상 판매의 ${Math.round(p.buy * 100)}%`, hint: "많이 사면 사이즈가 덜 빠지지만 현금이 재고에 묶여요. 한 달치가 있어도 찾는 사이즈가 있는 손님은 86%예요 (가정)" },
  focus: { label: "더 들일 품목", text: (p) => catLabel(p.focus), hint: "고른 품목을 30% 더 사요. 철에 맞으면 결품이 줄고, 철이 지나면 오래된 옷이 돼요" },
  discount: { label: "상시 할인", text: (p) => (p.discount ? `${Math.round(p.discount * 100)}%` : "없음"), hint: "할인하면 더 팔리지만 한 벌에 남는 돈이 줄어요 (10% 할인 = 판매량 +15%, 가정)" },
  markdownAge: { label: "세일 시작", text: (p) => `${p.markdownAge}달 지난 옷부터`, hint: "세일 칸으로 옮긴 옷은 정가로 안 팔고 매달 일부가 세일로 빠져요. 석 달 넘은 옷은 매달 값이 11% 떨어져요 (시즌을 넘기면 30% 이상 떨어진다는 조사, 장은영 2001). 보통 1~2달 정가로 팔고 20~30% 세일해요" },
  markdown: { label: "세일 폭", text: (p) => `${Math.round(p.markdown * 100)}%`, hint: "폭이 클수록 세일 칸이 빨리 비지만 남는 돈이 줄어요. 30%면 제철 품목은 한 달에 55%가 팔려요 (가정)" },
  staff: { label: "알바", text: (p) => `${p.staff}명`, hint: `한 명에 월 ${STAFF_PAY}만원. 일손이 모자라면 바쁜 날 손님을 놓쳐요` },
  marketing: { label: "SNS 홍보비", text: (p) => (p.marketing ? `${p.marketing}만원` : "없음"), hint: "인지도가 올라 손님이 늘어요 (100만원당 인지도 +0.15, 고깃집과 같은 가정)" },
  buyCat: { label: "품목별 매입", text: (p) => (p.buyCat && Object.values(p.buyCat).some((x) => x !== 1) ? CATS.map((c) => `${c.label} ${Math.round((p.buyCat?.[c.id] ?? 1) * 100)}%`).join(" · ") : "고르게"), hint: "품목마다 예상 판매의 몇 %를 들일지예요" },
  onlineAd: { label: "온라인 광고", text: (p) => (p.onlineAd ? `${p.onlineAd}만원` : "없음"), hint: "검색·플랫폼 광고. 온라인 주문이 늘지만 효과는 점점 줄어요 (최대 +50%, 50만원에서 절반, 가정)" },
  live: { label: "SNS 라이브·공동구매", text: (p) => (p.live ? "해요 (월 30만원)" : "안 해요"), hint: "인스타 라이브나 공동구매로 온라인 주문 +30% × 그 달 SNS 관심도 (소상공인365 SNS 분석). 온라인 판매를 할 때만 효과가 있어요 (가정)" },
  vmd: { label: "진열 바꾸기", text: (p) => (p.vmd ? "바꿔요 (40만원)" : "그대로"), hint: "마네킹·쇼윈도를 그 달 품목으로 바꾸면 매장 손님 +4% (가정)" },
  loyalty: { label: "회원 적립", text: (p) => (p.loyalty ? "해요" : "안 해요"), hint: "구매액의 2%를 적립해 주면 손님 +3%, 적립금만큼 매출 −2% (가정)" },
  alter: { label: "사이즈 교환·수선", text: (p) => (p.alter ? "해요" : "안 해요"), hint: "사이즈가 없어 놓치는 손님이 15% 줄고, 수선비가 매출의 1% 들어요 (가정)" },
  freeShip: { label: "배송비", text: (p) => (p.freeShip === false ? "고객 부담" : "무료배송"), hint: "무료배송이면 주문이 많고 택배비를 가게가 내요. 고객이 내면 주문이 25% 적어요 (가정)" },
  online: { label: "온라인 판매", text: (p) => ONLINE[p.online ?? 0].label, hint: "같은 재고를 온라인으로도 팔아요. 스마트스토어는 수수료가 싸고 손님이 적게 늘고, 플랫폼은 손님이 많이 늘지만 수수료가 28%예요 (가정). 택배비와 반품도 들어요" },
};
const diffPlan = (a: ApPlan, b: ApPlan) => (Object.keys(PLAN_TEXT) as (keyof ApPlan)[])
  .filter((k) => PLAN_TEXT[k].text(a) !== PLAN_TEXT[k].text(b)).map((k) => `${PLAN_TEXT[k].label} ${PLAN_TEXT[k].text(a)} → ${PLAN_TEXT[k].text(b)}`);
