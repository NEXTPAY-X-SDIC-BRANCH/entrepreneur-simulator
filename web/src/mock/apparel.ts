// 옷가게(일반의류) 모델: 여는 돈, 한 달 계산, 이달의 사건, 쉬운 모드 방향. 화면은 ApparelBuild.tsx, ApparelSim.tsx.
// 고깃집처럼 손님 한 팀씩 돌리는 엔진이 아니라 달 단위 계산이다. 옷가게에서 가르치려는 것은 "재고가 현금을 묶는다"이다:
// 많이 사 두면 돈이 선반에 묶이고, 적게 사면 물건이 떨어져 손님을 놓친다. 철이 지난 옷은 세일로 털어야 한다.
//
// 숫자의 출처
//   점포당 월매출·분기 지수·결제 1건 금액: 서울시 상권분석서비스 2025 일반의류(CS300011), 구 단위 (guStat, gu_stats.json apparel)
//   원가율 29.0%, 기타경비 33.6%: 통계청 도소매업조사 2024 서울 의복 소매업(4741) 연매출 1억~5억 사업체 (apparel_kosis.json)
//   일손 한 명이 감당하는 매출 월 약 978만원: 같은 조사 연매출 5억~10억 구간의 사업체당 월매출 1,955만원 ÷ 종사자 2.0명
//   평당 월세: 한국부동산원 R-ONE (guStat). 보증금 월세 12개월치: 서울시 상가임대차 실태조사 (고깃집과 같다)
//   알바 시급 10,320원과 주휴 배수 1.33, 사장 생활비 300만원, 대출 금리: 고깃집과 같은 값 (model.ts, hero_base.yaml)
//   새 가게 인지도 0.6에서 매달 15%씩 1로, 협찬 100만원당 인지도 +0.15: 고깃집 시즌 엔진의 가정 (season_params.yaml)
//   그 밖(면적 효과, 할인 탄력, 철 지난 재고 비율, 사건 효과 크기)은 가정이고 아래에 '가정'으로 적었다.
import { DEPOSIT_MONTHS, GRADES, LOAN_RATE, OWNER_DRAW, guStat, type CostLine, type Grade, type Profile } from "./model";

export type ApparelCfg = { pyeong: number; grade: Grade; staff: number; stockMonths: number; loan: number }; // loan 만원
export const DEFAULT_APPAREL: ApparelCfg = { pyeong: 13, grade: "basic", staff: 0, stockMonths: 1.5, loan: 0 };

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
export const FIXTURES = 300, SIGN = 250; // 만원. 행거·진열대·거울·피팅룸 (가정), 간판 (고깃집과 같은 가정)
const BASE_PYEONG = 13; // 가정: 면적 효과의 기준. 매출은 (평수 ÷ 13)^0.5 배
const ELASTIC = 1.5;    // 가정: 할인율 10%면 팔리는 양 +15%
const OLD_SHARE = 0.4;  // 가정: 시즌이 바뀔 때 재고의 40%가 철 지난 옷이 된다
// 분기 안의 달 비율 (분기 평균 1): 통계청 소매판매액지수 의복 불변지수 월 합계, 2023~2025 평균 (KOSIS DT_1K41012 G21, kosis_monthly.json)
const MONTH_IN_QUARTER: Record<number, number> = { 1: 0.946, 2: 0.911, 3: 1.143, 4: 1.024, 5: 1.039, 6: 0.937, 7: 1.038, 8: 0.904, 9: 1.058, 10: 1.008, 11: 1.032, 12: 0.961 };

export const expectedSales = (gu: string, pyeong: number) => guStat(gu).sales * Math.sqrt(pyeong / BASE_PYEONG); // 만원/월, 자리 잡은 뒤

export function apparelOpeningCost(cfg: ApparelCfg, gu: string, keyMoney = 0): { lines: CostLine[]; total: number } {
  const st = guStat(gu), g = GRADES[cfg.grade];
  const stock = Math.round(expectedSales(gu, cfg.pyeong) * KOSIS.cogs * cfg.stockMonths);
  const lines: CostLine[] = [
    ...(keyMoney > 0 ? [{ key: "keymoney", label: "권리금", amount: keyMoney, basis: "직접 넣은 값 (나갈 때 돌려받지 못해요)" }] : []),
    { key: "deposit", label: "보증금", amount: Math.round(st.rent * cfg.pyeong * DEPOSIT_MONTHS), basis: `월세 ${DEPOSIT_MONTHS}개월분 (서울시 상가임대차 실태조사)` },
    { key: "interior", label: "인테리어 공사", amount: g.perPyeong * cfg.pyeong, basis: `${cfg.pyeong}평, 평당 ${g.perPyeong}만원 (${g.label}, 의류 자료가 없어 고깃집 값을 빌려 씀)` },
    { key: "seat", label: "진열대·행거·피팅룸", amount: FIXTURES, basis: "가정" },
    { key: "sign", label: "간판", amount: SIGN, basis: "전면 간판 1개, 가정" },
    { key: "stock", label: "첫 재고", amount: stock, basis: `한 달 예상 매출 ${cfg.stockMonths}개월치를 원가 ${Math.round(KOSIS.cogs * 100)}%로 (도소매업조사)` },
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
export type ApPlan = { buy: number; discount: number; staff: number; marketing: number }; // buy: 예상 판매분 대비 매입 배수, marketing 만원
export const DEFAULT_PLAN: ApPlan = { buy: 1, discount: 0, staff: 0, marketing: 0 };
export type ApState = { cash: number; stock: number; old: number; awareness: number; negMonths: number; closed: boolean }; // 만원
export type Fx = { demand?: number; buy?: number; discount?: number; cost?: number; awareness?: number; clear?: number; clearCut?: number };
export type ApMonth = {
  month: number; revenue: number; cogs: number; staffPay: number; rent: number; other: number; marketing: number; eventCost: number;
  op: number; interest: number; draw: number; purchase: number; cash: number; stockEnd: number; oldEnd: number; writeOff: number;
  lost: number; sellThrough: number; load: number; tx: number; ticket: number; awareness: number; closed: boolean; demand: number;
  plan: ApPlan; event: string; choice: string;
};

export function startState(profile: Profile, cfg: ApparelCfg): ApState {
  const cost = apparelOpeningCost(cfg, profile.gu, profile.keyMoney ?? 0);
  const stock = cost.lines.find((l) => l.key === "stock")!.amount;
  return { cash: profile.capital + cfg.loan - cost.total, stock, old: 0, awareness: 0.6, negMonths: 0, closed: false };
}

export function playMonth(profile: Profile, cfg: ApparelCfg, s: ApState, month: number, plan: ApPlan, ev: ApEvent, opt: ApOption): { month: ApMonth; next: ApState } {
  const st = guStat(profile.gu);
  const fx = opt.fx;
  const q = Math.floor((month - 1) / 3);
  const base = expectedSales(profile.gu, cfg.pyeong) * (st.qidx[q] ?? 1) * MONTH_IN_QUARTER[month];
  const discount = Math.min(0.5, plan.discount + (fx.discount ?? 0));
  const demand = base * s.awareness * (ev.demand ?? 1) * (fx.demand ?? 1) * (1 + ELASTIC * discount); // 정가 기준 팔고 싶은 양 (만원)
  const capacity = KOSIS.perWorker * (1 + plan.staff);                                                      // 사장 + 알바
  // 재고는 원가로 센다. 새 옷(fresh)은 정가로, 철 지난 옷(old)은 정리 세일로만 팔린다.
  // 매입: 이번 달 팔 양의 (매입 배수 × 첫 재고 개월 수)만큼 새 옷을 갖춰 둔다. 배수가 1보다 크면 재고가 쌓인다.
  const fresh0 = s.stock - s.old;
  const purchase = Math.max(0, demand * KOSIS.cogs * (plan.buy + (fx.buy ?? 0)) * cfg.stockMonths - fresh0);
  const avail = s.stock + purchase;
  const sold = Math.min(fresh0 + purchase, Math.min(demand, capacity) * KOSIS.cogs); // 원가 기준
  const fullPrice = sold / KOSIS.cogs;
  // 철 지난 재고 정리: 그 원가어치를 세일가로 판다
  const clearCost = (fx.clear ?? 0) * s.old;
  const clearRev = (clearCost / KOSIS.cogs) * (1 - (fx.clearCut ?? 0));
  const revenue = fullPrice * (1 - discount) + clearRev;
  let old = s.old - clearCost;
  let stock = avail - sold - clearCost;
  let wo = 0;
  if ([2, 5, 8, 11].includes(month)) {
    // 시즌이 바뀌는 달: 남은 철 지난 옷은 값이 20% 떨어지고 (가정), 남은 새 옷의 40%가 철 지난 옷이 된다 (가정)
    wo = old * 0.2;
    old -= wo;
    stock -= wo;
    old += (stock - old) * OLD_SHARE;
  }
  const staffPay = STAFF_PAY * plan.staff;
  const rent = st.rent * cfg.pyeong;
  const other = revenue * KOSIS.other;
  const cogs = sold + clearCost;
  const marketing = plan.marketing;
  const eventCost = fx.cost ?? 0;
  const op = revenue - cogs - staffPay - rent - other - marketing - eventCost - wo;
  const interest = (cfg.loan * LOAN_RATE) / 12;
  const cash = s.cash + revenue - purchase - staffPay - rent - other - marketing - eventCost - OWNER_DRAW - interest;
  const negMonths = cash < 0 ? s.negMonths + 1 : 0;
  const awareness = Math.min(1.3, s.awareness + (1 - s.awareness) * 0.15 + (marketing / 100) * 0.15 + (fx.awareness ?? 0));
  const lost = Math.max(0, demand - fullPrice);
  const m: ApMonth = {
    month, revenue, cogs, staffPay, rent, other, marketing, eventCost, op, interest, draw: OWNER_DRAW, purchase, cash, stockEnd: stock, oldEnd: old, writeOff: wo,
    lost, sellThrough: avail > 0 ? (sold + clearCost) / avail : 0, load: Math.min(1.5, demand / capacity), tx: (revenue * 1e4) / st.ticket, ticket: st.ticket,
    awareness, closed: negMonths >= 2, demand, plan, event: ev.title, choice: opt.label,
  };
  return { month: m, next: { cash, stock, old, awareness, negMonths, closed: negMonths >= 2 } };
}

// ---------------------------------------------------------------- 이달의 사건 (달력에 맞춰 하나). 효과 크기는 가정이다
export type ApOption = { id: string; label: string; pro: string; con: string; fx: Fx };
export type ApEvent = { id: string; title: string; prompt: string; demand?: number; note: string; options: ApOption[] };
const keep: ApOption = { id: "keep", label: "평소대로", pro: "추가 비용이 없어요", con: "기회를 놓칠 수 있어요", fx: {} };
export function eventOf(month: number, seed: number): ApEvent {
  if ([2, 5, 8, 11].includes(month)) return {
    id: "season_off", title: "시즌 오프: 철 지난 재고", prompt: "계절이 바뀌어요. 지난 시즌 옷이 선반에 남아 있어요. 그냥 두면 값이 더 떨어져요.", note: "철 지난 재고 비율과 세일 효과는 가정이에요",
    options: [
      { id: "sale30", label: "30% 정리 세일", pro: "철 지난 재고의 70%를 현금으로 바꿔요", con: "정가보다 30% 싸게 팔아 남는 게 적어요", fx: { clear: 0.7, clearCut: 0.3 } },
      { id: "sale15", label: "15% 세일", pro: "덜 깎고 일부를 털어요", con: "재고의 40%만 팔려요", fx: { clear: 0.4, clearCut: 0.15 } },
      { id: "hold", label: "그대로 둔다", pro: "깎아 팔지 않아요", con: "남은 옷은 값이 20% 더 떨어지고 돈이 계속 묶여요", fx: {} },
    ],
  };
  if ([3, 9].includes(month)) return {
    id: "new_season", title: "새 시즌 신상 입고", prompt: "새 시즌 옷을 얼마나 들일까요? 많이 들이면 손님은 늘지만 현금이 재고에 묶여요.", note: "신상 효과 크기는 가정이에요",
    options: [
      { id: "many", label: "많이 들인다", pro: "고를 게 많아 손님 +6%", con: "평소보다 30% 더 사서 현금이 묶여요", fx: { buy: 0.3, demand: 1.06 } },
      { id: "normal", label: "평소만큼", pro: "현금과 재고의 균형", con: "특별한 효과는 없어요", fx: {} },
      { id: "few", label: "조금만 들인다", pro: "현금을 아껴요", con: "고를 게 적어 손님 −4%", fx: { buy: -0.2, demand: 0.96 } },
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
  if ([4, 10].includes(month) || seed % 4 === 0) return {
    id: "spa", title: "근처에 SPA 브랜드 매장 오픈", prompt: "큰 의류 브랜드 매장이 근처에 열었어요. 이번 달 손님 −9%예요.", demand: 0.91, note: "손님 −9%는 고깃집 시뮬의 경쟁점 개점 효과(S20)를 빌려 썼어요",
    options: [
      { id: "cut10", label: "10% 할인 행사", pro: "가격으로 맞서 팔리는 양 +15%", con: "한 벌에 남는 돈이 줄어요", fx: { discount: 0.1 } },
      { id: "regular", label: "단골에게 쿠폰 문자", pro: "단골을 붙잡아 +4%", con: "문자·쿠폰 비용 20만원", fx: { demand: 1.04, cost: 20 } },
      keep,
    ],
  };
  if (month === 12 || month === 1) return {
    id: "peak", title: month === 12 ? "연말 대목" : "설 앞두고 선물 수요", prompt: "선물과 모임으로 옷을 사는 사람이 늘어요. 재고를 더 들일까요?", demand: 1.05, note: "연말 수요의 대부분은 분기 지수에 이미 들어 있어요. +5%는 가정이에요",
    options: [
      { id: "stock_up", label: "재고를 더 들인다", pro: "물건이 떨어지지 않아 손님 +5%", con: "20% 더 사서 현금이 묶여요", fx: { buy: 0.2, demand: 1.05 } },
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
export function apStrategies(last: ApMonth | undefined, plan: ApPlan): { id: ApStratId; title: string; desc: string; plan: ApPlan; changes: string[] }[] {
  const b = last?.plan ?? plan;
  let rec = { ...b };
  if (last) {
    if (last.lost / Math.max(1, last.demand) > 0.1 && last.load > 1) rec = { ...rec, staff: Math.min(2, rec.staff + 1) };
    else if (last.lost / Math.max(1, last.demand) > 0.1) rec = { ...rec, buy: Math.min(1.5, +(rec.buy + 0.1).toFixed(1)) };
    if (last.stockEnd > last.revenue * KOSIS.cogs * 2) rec = { ...rec, buy: Math.max(0.7, +(rec.buy - 0.2).toFixed(1)) };
    if (last.op < 0 && rec.marketing > 0) rec = { ...rec, marketing: 0 };
    if (last.awareness < 0.8 && last.cash > 1000 && rec.marketing === 0) rec = { ...rec, marketing: 50 };
  }
  const grow = { ...b, marketing: Math.max(50, b.marketing), buy: Math.min(1.5, +(b.buy + 0.2).toFixed(1)), discount: Math.min(0.3, +(b.discount + 0.05).toFixed(2)) };
  const save = { ...b, staff: Math.max(0, b.staff - 1), buy: Math.max(0.7, +(b.buy - 0.15).toFixed(2)), marketing: 0, discount: 0 };
  return [
    { id: "rec", title: "추천대로", desc: last ? "지난달 결과를 보고 고칠 곳만 고쳐요." : "첫 달은 기본 계획으로 시작해요.", plan: rec, changes: diffPlan(b, rec) },
    { id: "grow", title: "손님 늘리기", desc: "홍보·할인·재고를 늘려 더 팔아요. 현금이 더 나가요.", plan: grow, changes: diffPlan(b, grow) },
    { id: "save", title: "비용 아끼기", desc: "알바·매입·홍보를 줄여요. 물건이 떨어질 수 있어요.", plan: save, changes: diffPlan(b, save) },
  ];
}
export const PLAN_TEXT: Record<keyof ApPlan, { label: string; text: (p: ApPlan) => string; hint: string }> = {
  buy: { label: "매입량", text: (p) => `예상 판매의 ${Math.round(p.buy * 100)}%`, hint: "많이 사면 물건이 안 떨어지지만 현금이 재고에 묶여요" },
  discount: { label: "상시 할인", text: (p) => (p.discount ? `${Math.round(p.discount * 100)}%` : "없음"), hint: "할인하면 더 팔리지만 한 벌에 남는 돈이 줄어요 (10% 할인 = 판매량 +15%, 가정)" },
  staff: { label: "알바", text: (p) => `${p.staff}명`, hint: `한 명에 월 ${STAFF_PAY}만원. 일손이 모자라면 바쁜 날 손님을 놓쳐요` },
  marketing: { label: "SNS 홍보비", text: (p) => (p.marketing ? `${p.marketing}만원` : "없음"), hint: "인지도가 올라 손님이 늘어요 (100만원당 인지도 +0.15, 고깃집과 같은 가정)" },
};
const diffPlan = (a: ApPlan, b: ApPlan) => (Object.keys(PLAN_TEXT) as (keyof ApPlan)[])
  .filter((k) => PLAN_TEXT[k].text(a) !== PLAN_TEXT[k].text(b)).map((k) => `${PLAN_TEXT[k].label} ${PLAN_TEXT[k].text(a)} → ${PLAN_TEXT[k].text(b)}`);
