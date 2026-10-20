// Mock model for the pre-founder flow. Not the sim engine: a transparent monthly formula.
// District numbers are real (서울시 상권분석서비스 2025, built by pipelines/build_gu_stats.py into gu_stats.json) except
// rent, which is still a placeholder. Store constants are borrowed from the 대학로 hero store (hero.json pnl) and the
// shock sizes from research/shocks.yaml. Every input and its standing is listed on the #/sources page (sources.ts).

export type Industry = "bbq" | "cafe" | "apparel";
// 화면 문구와 계산에서 업종마다 달라지는 말. 동네 분석은 setIndustry로 업종을 바꾸면 같은 코드가 카페용 자료로 돈다.
export const TXT = {
  bbq: { shop: "고깃집", base: "한식음식점", kind: "돼지고기 구이 가게", cat: "한식 가게" },
  cafe: { shop: "카페", base: "커피·음료 가게", kind: "카페", cat: "커피·음료 가게" },
  apparel: { shop: "옷가게", base: "의류 가게", kind: "옷가게", cat: "의류 가게" },
} as const;
let IND: Industry = "bbq";
export const industry = (): Industry => IND;
export const T = () => TXT[IND];
// rent: 사용자가 직접 넣은 현금 월세(만원/평·월, 보증금 제외). 넣은 구에서만 쓴다. 선택 사항.
// dong: 고른 동네(행정동). 그 구에서만 쓴다. 없으면 구 전체 평균.
export type Profile = { industry: Industry; gu: string; reasons: string[]; capital: number; age: string; rent?: { gu: string; v: number }; dong?: { gu: string; name: string }; keyMoney?: number }; // capital, keyMoney in 만원
export type Gu = { code: string; name: string; rings: [number, number][][]; c: [number, number]; r: number }; // c: label point, r: room around it
// demand: 점포당 월매출 ÷ 서울 평균. stores: 상권 안 한식음식점 수. closure: 1년 폐업률(%). sales: 점포당 월매출(만원).
// tx: 점포당 하루 결제 건수. ticket: 결제 1건 금액(원). rent: 현금 월세 만원/평·월 (rentSrc가 값의 출처). pork: 구 전체의 돼지고기 구이 가게 수.
// dow: 요일별 매출 비중 (월..일). qidx: 분기별 매출 지수 (1~4분기, 연평균 1).
export type RentSrc = "입력" | "R-ONE 동네" | "R-ONE 근사" | "R-ONE 채움" | "예시값";
// area*: 동네를 골랐을 때만 채워진다 (pipelines/build_dong_stats.py). 동네를 안 골랐으면 null.
export type GuStat = {
  demand: number; stores: number; closure: number; sales: number; tx: number; ticket: number; rent: number; rentLow: number; rentHigh: number;
  rentAll: number | null; rentAreas: number; rentArea: string | null; rentSrc: RentSrc; pork: number; opening: number; dow: number[]; qidx: number[];
  area: string | null; areaType: string | null; areaPork: number | null; areaStores: number | null;
  salesRange: [number, number] | null; // 카페만: 점포당 월매출의 4분의 1·4분의 3 분위 (만원). 고깃집은 null
  growth: number | null; netOpen: number | null; salesHansik: number; // 점포당 월매출 전년 대비 %, 개업률-폐업률 %p, 한식음식점 기준 월매출(만원)
};
export type Dong = {
  code: string; name: string; stores: number; pork: number; sales_month: number; raw_per_store: number | null; rel: number | null;
  dow: number[]; qidx: number[]; shares: { weekend: number; lunch: number; evening: number; age20: number; age30: number }; type: string;
};
// 카페용(cafe_dong_stats.json)은 _meta에 보정 배율(adj)과 구별 카페 수(gu_cafes)가 더 들어 있다.
export type DongData = { _meta: { generated: string; year: number; caveats: string[]; adj?: number; gu_cafes?: Record<string, number> }; gu: Record<string, Dong[]> };
let DONGS: DongData | null = null;
export const setDongData = (d: DongData | null) => { DONGS = d; };
export const dongsOf = (gu: string): Dong[] => DONGS?.gu[gu] ?? [];
let AREA_IN: { gu: string; name: string } | null = null;
export const setAreaInput = (a: { gu: string; name: string } | null) => { AREA_IN = a; };
type Row = Record<string, number> & { dow_share: number[]; quarter_index: number[] };
type Block = { service_name: string; seoul: Row; gu: Record<string, Row> };
export type GuData = {
  _meta: { generated: string; year: number; quarters: string[]; sources: Record<string, string>; license: string; method: string; caveats: string[] };
  bbq: Block; cafe: Block; apparel?: Block;
  pork?: { snapshot: string; source: string; codes: Record<string, string>; gu: Record<string, { hansik: number; pork: number; beef: number; tripe: number }> };
};
// 외식업체 경영실태조사(2025) 한식 육류 요리 전문점 값. pipelines/build_gogi_krei.py가 만든 gogi_krei.json.
export type KreiRow = { n: number; values: Record<string, number> };
export type KreiTable = { table: number; title: string; meat?: KreiRow; hansik?: KreiRow; hansik_all?: KreiRow; all?: KreiRow };
export type Quant = { n: number; p25: number; p50: number; p75: number } | null;
export type KreiData = { _meta: { caveat: string[]; files: string[] }; tables: Record<string, KreiTable>; micro: Record<string, any> };
let KREI: KreiData | null = null;
export const setKrei = (d: KreiData | null) => { KREI = d; };
export const krei = () => KREI;
export const kreiMean = (k: string, who: "meat" | "hansik_all" = "meat") => KREI?.tables[k]?.[who]?.values["평균"] ?? null;
// 한식 육류 요리 전문점의 점포당 연매출 ÷ 한식 전체 점포당 연매출. 서울시 상권분석서비스의 한식음식점 값을 육류 전문점 수준으로 옮기는 배율.
export const meatUplift = (): number => { const a = kreiMean("pl_sales"), b = kreiMean("pl_sales", "hansik_all"); return a && b ? a / b : 1; };

// 성장률. pipelines/build_growth.py가 만든 growth.json: 2025년과 2024년의 한식음식점을 같은 상권끼리 비교한 값.
export type GrowthRow = { sales_growth: number; store_growth: number; closure_prev: number; closure_now: number; opening_prev: number; opening_now: number; net_open: number };
export type GrowthData = { _meta: { prev: number; year: number }; seoul: GrowthRow; gu: Record<string, GrowthRow> };
let GROWTH: GrowthData | null = null;
export const setGrowth = (d: GrowthData | null) => { GROWTH = d; };
export const growthOf = (gu: string): GrowthRow | null => GROWTH?.gu[gu] ?? null;
export const growthMeta = () => GROWTH?._meta ?? null;

let DATA: GuData | null = null;
export const setGuData = (d: GuData) => { DATA = d; };
export const guData = () => DATA;

// 월세. pipelines/fetch_rone.py가 만든 rent_gu.json: 한국부동산원 소규모 상가 1층 임대료(보증금 환산 포함)를 상권별로 받아 구에 배정한 근사.
// 현금 월세 = 환산 포함 값 ÷ (1 + 보증금 개월 수 × 전환율 ÷ 12). 보증금 개월 수는 서울시 상가임대차 실태조사의 11~15개월 안에서 12로 둠.
export const DEPOSIT_MONTHS = 12;
export type RentData = {
  _meta: { quarter: string; generated: string };
  seoul_avg: number | null; conv_seoul_pct: number | null;
  gu: Record<string, { rent_man_per_pyeong: number; n_areas: number; areas: string[]; imputed: boolean }>;
  area: Record<string, number>;
  dong?: Record<string, { rent_man_per_pyeong: number; areas: string[] }>; // "구|동 이름"
};
let RENT: RentData | null = null;
export const setRentData = (d: RentData | null) => { RENT = d; };
export const rentData = () => RENT;
let RENT_IN: { gu: string; v: number } | null = null;
export const setRentInput = (r: { gu: string; v: number } | null) => { RENT_IN = r; };
export const cashRent = (all: number) => all / (1 + (DEPOSIT_MONTHS * ((RENT?.conv_seoul_pct ?? 7) / 100)) / 12);
const round1 = (x: number) => Math.round(x * 10) / 10;

export const DEFAULT_PROFILE: Profile = { industry: "bbq", gu: "마포구", reasons: [], capital: 12000, age: "30대" };

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

// 카페 매출 대표값. 전국 독립 커피전문점 연매출 중앙값 10,740만원(25%·75% = 8,000·16,000, n=153)을 농식품부·KREI 2024 비프랜차이즈
// 음료점 평균 연 13,759만원으로 나눈 값이 0.78 (카페 팀 지표 엑셀 시작 비용 시트). 서울 값이 아니라 전국 배율을 서울 평균에 옮긴 추정(등급 L).
export const CAFE_MEDIAN = { ratio: 10740 / 13759, p25: 8000 / 10740, p75: 16000 / 10740 };
export function guStat(name: string): GuStat {
  const g = DATA?.[IND]?.gu[name];
  let rent = Math.round(9 + hash(name + "r") * 20); // 월세 자료가 없을 때만 쓰는 예시값
  let rentLow = rent * 0.75, rentHigh = rent * 1.25, rentAll: number | null = null, rentAreas = 0;
  let rentSrc: RentSrc = "예시값";
  const rr = RENT?.gu[name];
  if (rr) {
    rentAll = rr.rent_man_per_pyeong;
    rent = round1(cashRent(rentAll));
    const vals = rr.areas.map((a) => RENT?.area[a]).filter((v): v is number => v != null).map(cashRent);
    rentLow = vals.length >= 2 ? Math.min(...vals) : rent * 0.75; // 상권이 한 곳이면 ±25% (가정)
    rentHigh = vals.length >= 2 ? Math.max(...vals) : rent * 1.25;
    rentAreas = rr.imputed ? 0 : rr.n_areas;
    rentSrc = rr.imputed ? "R-ONE 채움" : "R-ONE 근사";
  }
  if (RENT_IN && RENT_IN.gu === name && RENT_IN.v > 0) { rent = RENT_IN.v; rentLow = rentHigh = rent; rentSrc = "입력"; }
  // 동네를 골랐으면 그 동네 값으로 바꾼다. 점포당 매출은 구 값에 구 안의 상대 위치(rel)를 곱하고, 월세는 이름이 맞는 R-ONE 상권 값을 쓴다.
  const dg = AREA_IN && AREA_IN.gu === name ? DONGS?.gu[name]?.find((d) => d.name === AREA_IN!.name) : undefined;
  let rentArea: string | null = null;
  if (dg && rentSrc !== "입력") {
    const dr = RENT?.dong?.[`${name}|${dg.name}`];
    if (dr) {
      rent = round1(cashRent(dr.rent_man_per_pyeong));
      rentAll = dr.rent_man_per_pyeong; rentLow = rent * 0.75; rentHigh = rent * 1.25; // 상권 하나라 ±25% (가정)
      rentAreas = 1; rentArea = dr.areas.join(", "); rentSrc = "R-ONE 동네";
    }
  }
  const rentPart = { rent, rentLow: round1(rentLow), rentHigh: round1(rentHigh), rentAll, rentAreas, rentArea, rentSrc };
  const area = { area: dg?.name ?? null, areaType: dg?.type ?? null, areaPork: dg?.pork ?? null, areaStores: dg?.stores ?? null };
  const gr = IND === "bbq" ? GROWTH?.gu[name] ?? null : null;
  // 카페는 2024년 구 매출이 없어 growth 자리에 '가게 수 흐름'(개업률−폐업률, %p)을 넣는다. 화면은 업종을 보고 문구를 바꾼다.
  const flow = IND !== "bbq" && g ? round1((g.opening_rate - g.closure_rate) * 100) : null;
  const grow = { growth: gr?.sales_growth ?? flow, netOpen: gr?.net_open ?? flow };
  if (!g) return { demand: 1, stores: 0, closure: 0, sales: 0, salesRange: null, salesHansik: 0, tx: 0, ticket: 0, ...rentPart, ...area, ...grow, pork: 0, opening: 0, dow: Array(7).fill(1 / 7), qidx: [1, 1, 1, 1] };
  const salesH = dg?.rel ? Math.round(g.sales_per_store_month * Math.min(2, Math.max(0.4, dg.rel))) : g.sales_per_store_month;
  // 고깃집: 한식 값 × 육류 전문점 배율. 카페: 카드 추정매출 × 서울 소상공인 카페 월매출로 맞춘 보정 배율(지표 엑셀, 1.538).
  // 카페는 평균이 아니라 중앙값을 대표값으로 쓴다(잘되는 가게 몇 곳이 평균을 끌어올리므로). 서울 소상공인 카페 월매출 평균(보정 후)에
  // 전국 독립 음료점의 '중앙값 ÷ 평균' 배율을 곱한 추정이다. 서울 중앙값은 공개 자료에 없다(CAFE_MEDIAN).
  // 옷가게: 서울시 상권분석서비스 일반의류(CS300011) 카드 추정 점포당 매출을 그대로 쓴다 (보정 배율 없음)
  const sales = Math.round(salesH * (IND === "cafe" ? (DONGS?._meta.adj ?? 1.538) * CAFE_MEDIAN.ratio : IND === "apparel" ? 1 : meatUplift()));
  const salesRange: [number, number] | null = IND === "cafe" ? [Math.round(sales * CAFE_MEDIAN.p25), Math.round(sales * CAFE_MEDIAN.p75)] : null;
  return {
    demand: +(g.demand_index * (salesH / g.sales_per_store_month)).toFixed(2), stores: g.stores, closure: +(g.closure_rate * 100).toFixed(1),
    sales, salesRange, salesHansik: salesH, ...grow, tx: g.tx_per_store_day,
    ticket: g.ticket, ...rentPart, ...area, pork: IND === "cafe" ? DONGS?._meta.gu_cafes?.[name] ?? g.stores : IND === "apparel" ? g.stores : DATA?.pork?.gu[name]?.pork ?? 0, opening: g.opening_rate,
    dow: dg?.dow ?? g.dow_share, qidx: dg?.qidx ?? g.quarter_index,
  };
}

export const RAMP = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"]; // one hue, light to dark

export type Metric = "demand" | "growth" | "pork" | "closure";
type MetricInfo = { label: string; fmt: (v: number) => string; hint: string };
const gone = (v: number) => `${v.toLocaleString("ko-KR")}곳`;
const METRICS_BY: Record<Industry, Record<Metric, MetricInfo>> = {
  bbq: {
    demand: { label: "매출 지수", fmt: (v) => v.toFixed(2), hint: "한식음식점 한 곳의 월매출, 서울 평균이 1" },
    growth: { label: "매출 성장률", fmt: (v) => `${v > 0 ? "+" : ""}${v}%`, hint: "한식음식점 한 곳의 월매출이 2024년보다 늘어난 비율 (물가 상승 포함)" },
    pork: { label: "고깃집 수", fmt: gone, hint: "돼지고기 구이 가게, 구 전체" },
    closure: { label: "1년 폐업률", fmt: (v) => `${v}%`, hint: "2025년에 문 닫은 한식음식점 비율" },
  },
  cafe: {
    demand: { label: "매출 지수", fmt: (v) => v.toFixed(2), hint: "커피·음료 가게 한 곳의 월매출(카드 추정), 서울 평균이 1" },
    growth: { label: "가게 수 흐름", fmt: (v) => `${v > 0 ? "+" : ""}${v}%p`, hint: "연 개업률 − 연 폐업률. 카페는 2024년 구 매출 자료가 없어 매출 성장률 대신 써요" },
    pork: { label: "카페 수", fmt: gone, hint: "소상공인 상가정보의 카페, 구 전체 (프랜차이즈 포함)" },
    closure: { label: "1년 폐업률", fmt: (v) => `${v}%`, hint: "최근 4분기에 문 닫은 커피·음료 가게 비율" },
  },
  apparel: {
    demand: { label: "매출 지수", fmt: (v) => v.toFixed(2), hint: "옷가게(일반의류) 한 곳의 월매출(카드 추정), 서울 평균이 1" },
    growth: { label: "가게 수 흐름", fmt: (v) => `${v > 0 ? "+" : ""}${v}%p`, hint: "연 개업률 − 연 폐업률 (2025년, 상권 안 일반의류 가게)" },
    pork: { label: "옷가게 수", fmt: gone, hint: "서울시 상권분석서비스 상권 안의 일반의류 가게 (구 전체가 아님)" },
    closure: { label: "1년 폐업률", fmt: (v) => `${v}%`, hint: "2025년에 문 닫은 일반의류 가게 비율" },
  },
};
export const METRICS: Record<Metric, MetricInfo> = { ...METRICS_BY.bbq };
// 업종을 바꾼다. 화면이 읽기 전에 부른다(Mock.tsx).
export function setIndustry(i: Industry) { IND = i; Object.assign(METRICS, METRICS_BY[i]); }

export function rankOf(name: string, metric: Metric, names: string[]): number {
  const v = guStat(name)[metric] ?? -Infinity;
  return names.filter((n) => (guStat(n)[metric] ?? -Infinity) > v).length + 1;
}

// 을/를 by the last syllable's 받침 (non-Hangul endings take 를)
export function eul(word: string): string {
  const c = word.charCodeAt(word.length - 1);
  return word + (c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 ? "을" : "를");
}

export function iga(word: string): string {
  const c = word.charCodeAt(word.length - 1);
  return word + (c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 ? "이" : "가");
}

// ---- money -------------------------------------------------------------------------------------------
export function man(v: number): string {
  const r = Math.round(v);
  const neg = r < 0 ? "−" : "";
  const a = Math.abs(r);
  const eok = Math.floor(a / 10000);
  const rest = a % 10000;
  if (eok && rest) return `${neg}${eok}억 ${rest.toLocaleString("ko-KR")}만원`;
  if (eok) return `${neg}${eok}억원`;
  return `${neg}${a.toLocaleString("ko-KR")}만원`;
}

// ---- store plan (the builder's output) ---------------------------------------------------------------
export type Grade = "basic" | "mid" | "high";
// 평당 인테리어 공사비(만원). 외식업체 경영실태조사 2025 원자료, 한식 육류 요리 전문점 중 12~40평 가게의 가중 분위수:
// 25% 42 / 50% 77 / 75% 153 (응답 85곳, gogi_krei.json micro.mid_size_12_40). 기본·중급·고급을 이 세 분위수에 맞춰 45·80·150으로 둔다.
// 예전 가정값은 150·220·320이었고, 실측 상위 25%가 150이라 고급 320은 조사 범위를 벗어난다.
export const GRADES: Record<Grade, { label: string; perPyeong: number; floor: string; wall: string }> = {
  basic: { label: "기본", perPyeong: 45, floor: "#cbb9a0", wall: "#efe6d6" },
  mid: { label: "중급", perPyeong: 80, floor: "#9a8672", wall: "#e4ddd0" },
  high: { label: "고급", perPyeong: 150, floor: "#5b4a3f", wall: "#d8cdbb" },
};

export type CatalogItem = {
  id: string; name: string; cat: "seat" | "equip" | "deco"; price: number; // 만원, 가정
  w: number; d: number; h: number; seats?: number; max?: number; note?: string; fixed?: boolean; // fixed: part of the shell, not in the catalog
};
export const CATALOG: CatalogItem[] = [
  // 테이블: 경영실태조사 육류 전문점 홀 관련 비용 중앙값 1,388만원 ÷ 테이블 수 중앙값 12개 = 116만원, 원 연구 레포 등급 점검값 113·57과 맞춰 둠
  { id: "table4", name: "4인 테이블", cat: "seat", price: 113, w: 1.5, d: 2, h: 0.74, seats: 4, note: "불판, 환기 포함" },
  { id: "table2", name: "2인 테이블", cat: "seat", price: 57, w: 1.5, d: 1, h: 0.74, seats: 2, note: "불판, 환기 포함" },
  // 주방: 육류 전문점 '주방 관련 비용' 중앙값 1,500만원 (응답 111곳). 예전 가정값 900
  { id: "kitchen", name: "주방", cat: "equip", price: 1500, w: 4, d: 2.5, h: 2.6, max: 1, fixed: true, note: "벽으로 나눈 방" },
  { id: "counter", name: "계산대와 POS", cat: "equip", price: 150, w: 1.5, d: 1, h: 1.05, max: 1 },
  { id: "kiosk", name: "키오스크", cat: "equip", price: 120, w: 0.5, d: 0.5, h: 1.5 },
  { id: "fridge", name: "주류 냉장고", cat: "equip", price: 180, w: 1, d: 1, h: 1.9 },
  { id: "bench", name: "대기 의자", cat: "deco", price: 12, w: 1.5, d: 0.5, h: 0.45 },
  { id: "plant", name: "화분", cat: "deco", price: 8, w: 0.5, d: 0.5, h: 1.1 },
  { id: "lamp", name: "스탠드 조명", cat: "deco", price: 15, w: 0.5, d: 0.5, h: 1.6 },
];
export const ITEM = Object.fromEntries(CATALOG.map((c) => [c.id, c])) as Record<string, CatalogItem>;

export type Placed = { uid: number; id: string; x: number; z: number; rot: 0 | 1 }; // x,z = centre in metres; rot 1 = quarter turn
export type Store = { pyeong: number; grade: Grade; items: Placed[]; loan: number }; // loan in 만원

export const CELL = 0.5;
export function roomSize(pyeong: number): { w: number; d: number } {
  const area = pyeong * 3.3;
  const w = Math.round(Math.sqrt(area * 1.45) / CELL) * CELL;
  return { w, d: Math.round(area / w / CELL) * CELL };
}
export function footprint(p: { id: string; rot: 0 | 1 }): { w: number; d: number } {
  const it = ITEM[p.id];
  return p.rot ? { w: it.d, d: it.w } : { w: it.w, d: it.d };
}
export function fits(store: Store, cand: { id: string; x: number; z: number; rot: 0 | 1 }, ignore?: number): boolean {
  const { w, d } = roomSize(store.pyeong);
  const f = footprint(cand);
  if (cand.x - f.w / 2 < -w / 2 - 1e-6 || cand.x + f.w / 2 > w / 2 + 1e-6) return false;
  if (cand.z - f.d / 2 < -d / 2 - 1e-6 || cand.z + f.d / 2 > d / 2 + 1e-6) return false;
  return store.items.every((o) => {
    if (o.uid === ignore) return true;
    const g = footprint(o);
    return Math.abs(o.x - cand.x) >= (f.w + g.w) / 2 - 1e-6 || Math.abs(o.z - cand.z) >= (f.d + g.d) / 2 - 1e-6;
  });
}
export function snap(v: number, size: number): number {
  // centre so that the item's edges sit on the grid
  const half = size / 2;
  return Math.round((v - half) / CELL) * CELL + half;
}

// the kitchen is a walled room in the back-left corner; it moves with the walls when the size changes
export function kitchenSpot(pyeong: number): { x: number; z: number } {
  const { w, d } = roomSize(pyeong);
  return { x: -w / 2 + ITEM.kitchen.w / 2, z: -d / 2 + ITEM.kitchen.d / 2 };
}

// Where tables can go: rows from the front wall back, half a metre of aisle around each, clear of the kitchen room.
export function tableSlots(pyeong: number): { x: number; z: number }[] {
  const { w, d } = roomSize(pyeong);
  const k = kitchenSpot(pyeong), kw = ITEM.kitchen.w, kd = ITEM.kitchen.d, tw = ITEM.table4.w, td = ITEM.table4.d, gap = 0.5;
  const cols = Math.floor((w - gap) / (tw + gap));
  const x0 = -((cols - 1) * (tw + gap)) / 2; // centre the columns across the room
  const out: { x: number; z: number }[] = [];
  for (let z = d / 2 - gap - td / 2; z - td / 2 >= -d / 2 + gap - 1e-6; z -= td + gap) {
    for (let i = 0; i < cols; i++) {
      const x = snap(x0 + i * (tw + gap), tw);
      const clearK = Math.abs(x - k.x) >= (tw + kw) / 2 + gap - 1e-6 || Math.abs(z - k.z) >= (td + kd) / 2 + gap - 1e-6;
      const fx = -w / 2 + kw + 0.5, fz = -d / 2 + 0.5; // the fridge, next to the kitchen
      const clearF = Math.abs(x - fx) >= (tw + 1) / 2 + gap - 1e-6 || Math.abs(z - fz) >= (td + 1) / 2 + gap - 1e-6;
      if (clearK && clearF) out.push({ x, z: snap(z, td) });
    }
  }
  return out;
}

// 처음 화면: 벽으로 나뉜 주방만 있고 테이블, 냉장고, 계산대는 없다. 사용자가 직접 놓거나 '추천 배치'를 누른다.
export function emptyStore(pyeong = 20, grade: Grade = "basic"): Store {
  return { pyeong, grade, items: [{ uid: 1, id: "kitchen", ...kitchenSpot(pyeong), rot: 0 }], loan: 0 };
}

// the kitchen room, one drinks fridge and `tables` four-seat tables, laid out automatically
export function starterStore(pyeong = 20, grade: Grade = "basic", loan = 0, tables = 3): Store {
  const store: Store = { pyeong, grade, items: [], loan };
  const { w, d } = roomSize(pyeong);
  let uid = 1;
  store.items.push({ uid: uid++, id: "kitchen", ...kitchenSpot(pyeong), rot: 0 });
  const fr = { id: "fridge", x: snap(-w / 2 + ITEM.kitchen.w + 0.5, 1), z: snap(-d / 2 + 0.5, 1), rot: 0 as const };
  if (fits(store, fr)) store.items.push({ uid: uid++, ...fr });
  for (const t of tableSlots(pyeong).slice(0, tables)) {
    const c = { id: "table4", ...t, rot: 0 as const };
    if (fits(store, c)) store.items.push({ uid: uid++, ...c });
  }
  return store;
}
export const nextUid = (s: Store) => s.items.reduce((m, i) => Math.max(m, i.uid), 0) + 1;

export function storeStats(store: Store) {
  const seats = store.items.reduce((n, i) => n + (ITEM[i.id].seats ?? 0), 0);
  const tables = store.items.filter((i) => ITEM[i.id].cat === "seat").length;
  const hasKitchen = store.items.some((i) => i.id === "kitchen");
  const furnish = store.items.reduce((n, i) => n + ITEM[i.id].price, 0);
  return { seats, tables, hasKitchen, furnish };
}

// ---- opening cost -------------------------------------------------------------------------------------
export const SIGN = 250, FIRST_STOCK = 300; // 가정
// 대출 이자율. pipelines/fetch_ecos.py가 만든 ecos_rates.json의 예금은행 신규취급 중소기업대출 최신 금리(한국은행 121Y006).
// 파일이 없으면 연 6% 가정. 이자만 매달 낸다. let이라 setEcos 뒤에는 import한 쪽에서도 새 값이 보인다.
export let LOAN_RATE = 0.06;
export type EcosRate = { month: string; rate: number };
export type EcosData = { latest: Partial<Record<"base_rate" | "loan_sme" | "loan_corp" | "loan_avg", EcosRate>> };
let ECOS: EcosData | null = null;
export const setEcos = (d: EcosData | null) => { ECOS = d; LOAN_RATE = d?.latest.loan_sme ? d.latest.loan_sme.rate / 100 : 0.06; };
export const ecosRates = () => ECOS?.latest ?? null;
export const ymKo = (ym: string) => `${ym.slice(0, 4)}년 ${+ym.slice(4, 6)}월`;
export const cashLeft = (profile: Profile, store: Store) => profile.capital + store.loan - openingCost(store, profile.gu, profile.keyMoney ?? 0).total;
export type CostLine = { key: string; label: string; amount: number; basis: string };
export function openingCost(store: Store, gu: string, keyMoney = 0): { lines: CostLine[]; total: number } {
  const st = guStat(gu);
  const s = storeStats(store);
  const seatCost = store.items.filter((i) => ITEM[i.id].cat === "seat").reduce((n, i) => n + ITEM[i.id].price, 0);
  const equip = store.items.filter((i) => ITEM[i.id].cat === "equip").reduce((n, i) => n + ITEM[i.id].price, 0);
  const lines: CostLine[] = [
    ...(keyMoney > 0 ? [{ key: "keymoney", label: "권리금", amount: keyMoney, basis: "직접 넣은 값 (가게 자리에 붙는 웃돈, 나갈 때 돌려받지 못해요)" }] : []),
    { key: "deposit", label: "보증금", amount: st.rent * store.pyeong * DEPOSIT_MONTHS, basis: `월세 ${DEPOSIT_MONTHS}개월분 (서울시 실태조사: 보증금은 월세의 11~15개월)` },
    { key: "interior", label: "인테리어 공사", amount: GRADES[store.grade].perPyeong * store.pyeong, basis: `${store.pyeong}평, 평당 ${GRADES[store.grade].perPyeong}만원 (${GRADES[store.grade].label})` },
    { key: "equip", label: "주방과 설비", amount: equip, basis: "주방, 냉장고, 계산대 등" },
    { key: "seat", label: "테이블과 의자", amount: seatCost, basis: `테이블 ${s.tables}개, ${s.seats}석` },
    { key: "deco", label: "꾸밈", amount: s.furnish - seatCost - equip, basis: "화분, 조명, 대기 의자" },
    { key: "sign", label: "간판", amount: SIGN, basis: "전면 간판 1개" },
    { key: "stock", label: "첫 재료와 소모품", amount: FIRST_STOCK, basis: "고기, 주류, 반찬 재료" },
  ];
  return { lines, total: lines.reduce((n, l) => n + l.amount, 0) };
}

// ---- six-month run ------------------------------------------------------------------------------------
export type Levers = { price: number; staff: number; days: 26 | 30 };
export const DEFAULT_LEVERS: Levers = { price: 19000, staff: 3, days: 26 };
export type ShockId = "rain" | "cost" | "rival" | "quit";
export const SHOCKS: Record<ShockId, { label: string; detail: string }> = {
  rain: { label: "비가 잦은 달이 이어진다", detail: "밤의 35%에 비, 그날 손님 10% 감소 (기존 시뮬의 가정값)" },
  cost: { label: "고깃값이 10% 오른다", detail: "재료비가 약 7% 늘어남" },
  rival: { label: "근처에 고깃집이 새로 생긴다", detail: "손님 10% 감소 (기존 시뮬의 가정값)" },
  quit: { label: "직원 한 명이 그만둔다", detail: "받을 수 있는 손님이 줄어듦" },
};

export const PERSON_TICKET = 27000;   // hero pnl ticket per guest (팀 추정): turns district sales into guests
export const OPEN_DAYS = 26;          // hero pnl days
export const SIDE_TICKET = 8000;      // hero pnl t_alc + t_side
export const FOOD_SHARE = 0.31;       // hero pnl food ÷ rev
export const STAFF_COST = 199;        // 만원/월, hero pnl (l_pt + l_emp) ÷ servers
export const MGMT_PER_PYEONG = 12.8;  // 만원/월, hero pnl mgmt ÷ area
export const FEE_SHARE = 0.0084;      // hero pnl fees ÷ rev
export const OWNER_DRAW = 300;        // 만원/월, hero owner_wage
export const OPEN_CURVE = [0.55, 0.7, 0.82, 0.9, 0.96, 1.0]; // 오픈 곡선, 가정
export const SEAT_TURN = 1.5;         // covers per seat per day the room can take, 가정
export const COVERS_PER_STAFF = 15;   // 가정
// opening every day means four more shifts a month to pay for (가정: 급여가 영업일에 비례)
export const staffPay = (staff: number, days: 26 | 30) => staff * STAFF_COST * (days === 30 ? 30 / 26 : 1);

export type MonthRow = { m: number; demand: number; capacity: number; covers: number; revenue: number; cost: number; op: number; cash: number };
export type Run = { rows: MonthRow[]; start: number; opening: number; capMonthly: number };

export function simulate(profile: Profile, store: Store, lv: Levers, shocks: ShockId[], demandMult = 1): Run {
  const st = guStat(profile.gu);
  const s = storeStats(store);
  const opening = openingCost(store, profile.gu, profile.keyMoney ?? 0).total;
  const start = profile.capital + store.loan - opening;
  const staff = Math.max(0, lv.staff - (shocks.includes("quit") ? 1 : 0));
  const capacity = s.hasKitchen ? Math.min(s.seats * SEAT_TURN, (staff + 1) * COVERS_PER_STAFF) : 0;
  const ticket = lv.price + SIDE_TICKET;
  const priceFx = Math.pow(lv.price / 19000, -0.8);
  const shockFx = (shocks.includes("rain") ? 1 - 0.35 * 0.1 : 1) * (shocks.includes("rival") ? 0.9 : 1);
  const food = FOOD_SHARE * (19000 / lv.price) * (shocks.includes("cost") ? 1.07 : 1);
  // a settled store is assumed to draw what the average 한식음식점 in this 구 does (real sales ÷ the hero ticket per guest)
  const settled = (st.sales * 10000) / (PERSON_TICKET * OPEN_DAYS);
  let cash = start;
  const rows = OPEN_CURVE.map((r, i) => {
    const demand = settled * r * priceFx * shockFx * demandMult * (lv.days === 30 ? 0.96 : 1);
    const covers = Math.min(demand, capacity);
    const revenue = (covers * ticket * lv.days) / 10000;
    const cost = revenue * (food + FEE_SHARE) + staffPay(staff, lv.days) + st.rent * store.pyeong + MGMT_PER_PYEONG * store.pyeong;
    const op = revenue - cost;
    cash += op - OWNER_DRAW - (store.loan * LOAN_RATE) / 12;
    return { m: i + 1, demand, capacity, covers, revenue, cost, op, cash };
  });
  return { rows, start, opening, capMonthly: (capacity * ticket * lv.days) / 10000 };
}

export const LOW = 0.8, HIGH = 1.15; // 범위: 손님이 20% 적을 때와 15% 많을 때 (가정)

// ---- operating numbers ---------------------------------------------------------------------------------
// what the store must pay every month whether or not anyone comes, and how many guests a day cover it
export function breakEven(profile: Profile, store: Store, lv: Levers) {
  const st = guStat(profile.gu);
  const lines = [
    { label: "월세", amount: st.rent * store.pyeong },
    { label: "관리비", amount: MGMT_PER_PYEONG * store.pyeong },
    { label: `직원 ${lv.staff}명 급여`, amount: staffPay(lv.staff, lv.days) },
    { label: "사장 생활비", amount: OWNER_DRAW },
    { label: "대출 이자", amount: (store.loan * LOAN_RATE) / 12 },
  ].filter((l) => l.amount > 0);
  const fixed = lines.reduce((n, l) => n + l.amount, 0);
  const margin = (lv.price + SIDE_TICKET) * (1 - FOOD_SHARE * (19000 / lv.price) - FEE_SHARE); // 원, what one guest leaves after food and card fees
  return { lines, fixed, margin, perDay: (fixed * 10000) / (margin * lv.days) };
}
// money that does not come back: everything spent to open except the deposit
export const sunkCost = (store: Store, gu: string, keyMoney = 0) => openingCost(store, gu, keyMoney).lines.filter((l) => l.key !== "deposit").reduce((n, l) => n + l.amount, 0);
// settled month: what is left after every cost, the owner's pay and loan interest
export const settledNet = (run: Run, store: Store) => run.rows[5].op - OWNER_DRAW - (store.loan * LOAN_RATE) / 12;

// The store this money can best afford: among the sizes, table counts and staff numbers that survive six months even
// with 20% fewer guests, the one that leaves the most each month once settled. If none survives, the one that ends
// the six months with the most cash.
export function recommend(profile: Profile): { store: Store; staff: number; safe: boolean } {
  let best: { store: Store; staff: number; safe: boolean; score: number } | null = null;
  for (let pyeong = 12; pyeong <= 30; pyeong++) {
    const slots = tableSlots(pyeong).length;
    for (let tables = 2; tables <= slots; tables++) {
      const store = starterStore(pyeong, "basic", 0, tables);
      if (cashLeft(profile, store) < 0) break;
      for (let staff = 0; staff <= 6; staff++) {
        const lv = { ...DEFAULT_LEVERS, staff };
        const low = simulate(profile, store, lv, [], LOW);
        const safe = low.rows.every((r) => r.cash >= 0);
        const score = safe ? settledNet(simulate(profile, store, lv, []), store) : low.rows[5].cash;
        if (!best || (safe && !best.safe) || (safe === best.safe && score > best.score + 1e-6)) best = { store, staff, safe, score };
      }
    }
  }
  return best ?? { store: starterStore(12, "basic", 0, 2), staff: 1, safe: false };
}

// ---- 열기 전 점검: five questions an owner asks, each with the numbers behind the answer ---------------
export type Status = "ok" | "warn" | "weak";
export const STATUS_LABEL: Record<Status, string> = { ok: "여유", warn: "주의", weak: "취약" };
export type Check = { key: string; title: string; status: Status; line: string; todo?: string; rule: string; rows?: { label: string; value: string; ok: boolean }[] };

export function firstNegative(run: Run): number | null {
  if (run.start < 0) return 0;
  const r = run.rows.find((x) => x.cash < 0);
  return r ? r.m : null;
}
const months = (n: number) => (n >= 12 ? `${Math.floor(n / 12)}년${n % 12 ? ` ${n % 12}개월` : ""}` : `${n}개월`);

export function checks(profile: Profile, store: Store, lv: Levers): Check[] {
  const st = guStat(profile.gu);
  const s = storeStats(store);
  const mid = simulate(profile, store, lv, []);
  const low = simulate(profile, store, lv, [], LOW);
  const be = breakEven(profile, store, lv);
  const last = mid.rows[5];
  const want = Math.round(last.demand), need = Math.ceil(be.perDay);
  const bySeat = s.seats * SEAT_TURN, byStaff = (lv.staff + 1) * COVERS_PER_STAFF;
  const cap = Math.round(last.capacity);
  const net = settledNet(mid, store);
  const sunk = sunkCost(store, profile.gu, profile.keyMoney ?? 0);
  const neg = firstNegative(low);
  const base = last.cash;
  const shockRows = (Object.keys(SHOCKS) as ShockId[]).map((k) => {
    const end = simulate(profile, store, lv, [k]).rows[5].cash;
    return { label: `${SHOCKS[k].label}: ${SHOCKS[k].detail}`, value: `6개월 뒤 ${man(end)} (${man(end - base)})`, ok: end >= 0 };
  });
  const bad = shockRows.filter((r) => !r.ok).length;

  const fit: Check = { key: "fit", title: "자리와 일손이 손님 수에 맞나요?", status: "ok", line: "", rule: "" };
  if (s.seats === 0) { fit.status = "weak"; fit.line = "테이블이 없어서 손님을 받을 수 없어요."; }
  else if (want > cap * 1.15) {
    fit.status = "warn";
    fit.line = `하루 ${want}명쯤 올 텐데 ${cap}명까지만 받을 수 있어요. 날마다 ${want - cap}명쯤 돌려보내요.`;
    fit.todo = byStaff < bySeat ? "자리는 있는데 일손이 모자라요. 직원을 한 명 늘리면 더 받을 수 있어요." : "테이블을 늘리면 그만큼 매출이 늘어요.";
  } else if (want < cap * 0.6) {
    fit.status = "warn";
    fit.line = `${cap}명까지 받을 수 있는데 하루 ${want}명쯤 와요. 자리의 ${Math.round((1 - want / cap) * 100)}%가 비어요.`;
    fit.todo = "빈자리에도 월세가 나가요. 평수를 줄이면 다달이 나가는 돈이 줄어요.";
  } else {
    fit.line = `하루 ${want}명쯤 올 텐데 ${cap}명까지 받을 수 있어요. 금요일처럼 붐비는 날에도 대부분 받아요.`;
  }
  if (s.seats > 0 && lv.staff > 0 && lv.staff * COVERS_PER_STAFF >= want * 1.15 && lv.staff * COVERS_PER_STAFF >= Math.min(bySeat, want * 1.15)) {
    fit.status = fit.status === "ok" ? "warn" : fit.status;
    fit.todo = `직원을 한 명 줄여도 하루 ${Math.round(lv.staff * COVERS_PER_STAFF)}명까지 받을 수 있어요. 한 달에 ${man(STAFF_COST)}을 아껴요.`;
  }
  fit.rule = `올 손님 ${want}명은 ${profile.gu} 한식음식점 한 곳의 월매출 ${man(st.sales)}을 손님 한 명 ${PERSON_TICKET.toLocaleString("ko-KR")}원, 한 달 ${OPEN_DAYS}일로 나눈 값이에요(자리 잡힌 6개월째, 가격 반영). 받을 수 있는 손님은 좌석 ${s.seats}석 × 하루 ${SEAT_TURN}번 = ${Math.round(bySeat)}명과, 일하는 사람 ${lv.staff + 1}명 × ${COVERS_PER_STAFF}명 = ${byStaff}명 가운데 작은 쪽이에요. 회전수와 1인당 손님 수는 가정이에요.`;

  return [
    {
      key: "breakeven", title: "하루에 몇 명이 와야 본전인가요?",
      status: want >= need * 1.1 ? "ok" : want >= need ? "warn" : "weak",
      line: `하루 ${need}명이에요. ${profile.gu}의 비슷한 가게에는 하루 ${want}명쯤 와요.`,
      todo: want >= need ? undefined : `${need - want}명이 모자라요. 다달이 나가는 돈 ${man(be.fixed)}을 줄여야 해요.`,
      rule: `다달이 나가는 돈은 ${be.lines.map((l) => `${l.label} ${man(l.amount)}`).join(", ")}로 모두 ${man(be.fixed)}이에요. 손님 한 명이 재료비와 카드 수수료를 빼고 ${Math.round(be.margin).toLocaleString("ko-KR")}원을 남기니, 한 달 ${lv.days}일 영업이면 하루 ${need}명이 와야 0원이 돼요.`,
    },
    fit,
    {
      key: "runway", title: "현금은 언제까지 버티나요?",
      status: neg === null ? "ok" : neg <= 3 ? "weak" : "warn",
      line: neg === 0 ? `여는 데 드는 돈이 가진 돈보다 ${man(-mid.start)} 많아요.`
        : neg ? `손님이 예상보다 20% 적으면 ${neg}개월째에 현금이 바닥나요.` : `손님이 예상보다 20% 적어도 6개월 뒤 ${man(low.rows[5].cash)}이 남아요.`,
      todo: neg ? "새 가게는 첫 달에 자리 잡힌 뒤의 55%만 온다고 봤어요. 그동안 버틸 현금을 남겨 두세요." : undefined,
      rule: `가게를 열고 남는 현금 ${man(mid.start)}에서 시작해요. 손님은 첫 달 55%에서 6개월째 100%로 늘어난다고 가정했고, 예상대로 오면 6개월 뒤 ${man(base)}이에요.`,
    },
    {
      key: "payback", title: "들인 돈은 언제 돌아오나요?",
      status: net <= 0 ? "weak" : sunk / net <= 36 ? "ok" : sunk / net <= 60 ? "warn" : "weak",
      line: net <= 0 ? `자리가 잡힌 뒤에도 한 달에 ${man(-net)}씩 줄어요. 이 구성으로는 돌아오지 않아요.`
        : `자리가 잡히면 한 달에 ${man(net)}이 남아요. 들인 돈 ${man(sunk)}은 약 ${months(Math.ceil(sunk / net))} 뒤에 돌아와요.`,
      rule: `들인 돈은 보증금을 뺀 공사, 설비, 간판, 첫 재료 값이에요(보증금은 나갈 때 돌려받아요). 한 달에 남는 돈은 6개월째 매출에서 재료비, 급여, 월세, 관리비, 사장 생활비 ${man(OWNER_DRAW)}, 이자를 뺀 값이에요.`,
    },
    {
      key: "shock", title: "오픈 이후 어떤 사건들이 생길까요?",
      status: bad === 0 ? "ok" : bad <= 2 ? "warn" : "weak",
      line: bad === 0 ? "아래 네 가지 사건 가운데 무엇이 하나 생겨도 6개월 뒤 현금이 남아요." : `아래 네 가지 사건 가운데 ${bad}가지는 하나만 생겨도 6개월 안에 현금이 바닥나요.`,
      rows: shockRows,
      rule: "한 가지씩 따로 6개월 내내 이어진다고 보고 계산했어요. 괄호 안은 아무 일 없을 때와의 차이예요. 크기는 기존 시뮬레이터의 가정값이에요.",
    },
  ];
}

// 자료를 모듈 변수에 들고 있어서, 이 파일이 핫리로드로 새로 불리면 자료가 비는데 화면은 로딩 완료로 남는다. 통째로 다시 불러 맞춘다.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());
