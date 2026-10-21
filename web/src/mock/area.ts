// 동네(행정동) 분석: 경쟁 강도, 비용, 성장, 동네 특징을 한 번에 묶어 '~형 상권' 이름과 키워드, 해 볼 일을 만든다.
// 숫자는 dong_profile.json(pipelines/build_dong_profile.py), 경계는 seoul_dong.json(pipelines/build_seoul_dong.py).
// 이름·키워드·제안은 현장 조사가 아니라 아래 규칙으로 만든다. 규칙마다 근거 숫자를 같이 보여 준다(why).
import { T, cashRent, dongsOf, growthMeta, guStat, iga, industry, kreiMean, krei, rankOf, setIndustry, type Dong, type Industry } from "./model";

export type DongProfile = {
  gu: string; name: string; code: string; stores: number; pork: number; type: string;
  shares: { weekend: number; lunch: number; evening: number; age20: number; age30: number };
  growth: number | null; age: number[] | null; area_km2: number | null; pork_km2: number | null; pork_share: number | null;
  pop_per_pork: number | null; work_pop: number | null; resident_pop: number | null; flow_day: number | null;
  apt_price: number | null; subway: number | null; univ: number | null; rent: number | null; rent_gu: number | null;
  life?: number | null; close_life?: number | null; s_life?: number | null; s_close?: number | null; change?: string | null; leisure?: number | null; // 카페 전용(build_cafe_extra.py)
  comp: "약함" | "보통" | "치열" | null; grow: "하락" | "보합" | "성장" | null; cost: "낮음" | "보통" | "높음" | null; rich: boolean; family: boolean;
};
export type Cut = {
  pork_km2: number[]; growth: number[]; apt_price_top: number; rent: number[]; age40_family: number;
  lunch_hi: number; evening_hi: number; weekend_hi: number; pork_share_hi: number; flow_hi: number;
  life?: number[]; close_life?: number[]; leisure_hi?: number;
};
export type DongGeo = { gu: string; name: string; code: string; c: [number, number]; p: [number, number]; r: number; rings: [number, number][][] }; // p, r: 글자를 놓을 가장 큰 내접원의 중심과 반지름

let PROFILES: { _meta: { cut: Cut; generated: string }; dong: DongProfile[] } | null = null;
let GEO: DongGeo[] = [];
export const setAreaData = (p: typeof PROFILES, g: DongGeo[] | null) => { PROFILES = p; GEO = g ?? []; };
export const profilesOf = (gu: string): DongProfile[] => PROFILES?.dong.filter((d) => d.gu === gu) ?? [];
export const profileOf = (gu: string, name: string): DongProfile | undefined => PROFILES?.dong.find((d) => d.gu === gu && d.name === name);
export const geoOf = (gu: string): DongGeo[] => GEO.filter((d) => d.gu === gu);
export const hasDongMap = () => GEO.length > 0 && !!PROFILES;
export const cuts = (): Cut | null => PROFILES?._meta.cut ?? null;

// ---- 동네 지도에 칠할 값 ------------------------------------------------------------------------------
export type DongMetric = "sales" | "growth" | "compete" | "cost" | "life";
type DongMetricInfo = { label: string; hint: string; fmt: (v: number) => string; high: string; low: string };
const life: DongMetricInfo = { label: "버티는 기간", hint: "영업 중인 가게의 평균 영업 개월 (서울시 상권변화지표, 업종 구분 없는 동 전체, 점포 20곳 미만은 비교 안 함)", fmt: (v) => `${v}개월`, high: "오래 버티는 동네", low: "가게가 자주 바뀌는 동네" };
const cost: DongMetricInfo = { label: "월세", hint: "평당 월세 (한국부동산원, 동네 값이 없으면 구 값)", fmt: (v) => `${v}만원`, high: "월세가 비싼 동네", low: "월세가 싼 동네" };
const DONG_METRICS_BY: Record<Industry, Record<DongMetric, DongMetricInfo>> = {
  bbq: {
    sales: { label: "매출", hint: "구 평균 대비 한식 점포당 매출 (점포 20곳 미만은 비교 안 함)", fmt: (v) => `구 평균의 ${Math.round(v * 100)}%`, high: "매출이 높은 동네", low: "매출이 낮은 동네" },
    growth: { label: "성장", hint: "한식음식점 매출이 2024년보다 늘어난 비율 (동 전체, 물가 상승 포함)", fmt: (v) => `${v > 0 ? "+" : ""}${v}%`, high: "성장이 빠른 동네", low: "성장이 느린 동네" },
    compete: { label: "경쟁", hint: "고깃집(돼지고기 구이/찜) 수 ÷ 동 면적", fmt: (v) => `${v}곳/㎢`, high: "고깃집이 많은 동네", low: "고깃집이 적은 동네" },
    cost, life,
  },
  cafe: {
    sales: { label: "매출", hint: "구 평균 대비 카페 점포당 매출, 카드 추정 (점포 20곳 미만은 비교 안 함)", fmt: (v) => `구 평균의 ${Math.round(v * 100)}%`, high: "매출이 높은 동네", low: "매출이 낮은 동네" },
    growth: { label: "흐름", hint: "연 개업률 − 연 폐업률 (점포 20곳 미만은 비교 안 함). 카페는 동네별 2024년 매출이 없어 가게 수 흐름으로 봐요", fmt: (v) => `${v > 0 ? "+" : ""}${v}%p`, high: "가게가 느는 동네", low: "가게가 주는 동네" },
    compete: { label: "경쟁", hint: "카페 수 ÷ 동 면적", fmt: (v) => `${v}곳/㎢`, high: "카페가 많은 동네", low: "카페가 적은 동네" },
    cost, life,
  },
  // 옷가게는 동네(행정동) 자료를 아직 만들지 않아 구 단위로만 본다. 동네 지도는 숨겨진다 (Mock.tsx에서 동네 파일을 읽지 않음).
  apparel: {
    sales: { label: "매출", hint: "구 평균 대비 옷가게 점포당 매출", fmt: (v) => `구 평균의 ${Math.round(v * 100)}%`, high: "매출이 높은 동네", low: "매출이 낮은 동네" },
    growth: { label: "흐름", hint: "연 개업률 − 연 폐업률", fmt: (v) => `${v > 0 ? "+" : ""}${v}%p`, high: "가게가 느는 동네", low: "가게가 주는 동네" },
    compete: { label: "경쟁", hint: "옷가게 수 ÷ 동 면적", fmt: (v) => `${v}곳/㎢`, high: "옷가게가 많은 동네", low: "옷가게가 적은 동네" },
    cost, life,
  },
  // 치킨·분식은 동네(행정동) 자료를 아직 만들지 않아 구 단위로만 본다 (Mock.tsx에서 동네 파일을 읽지 않음)
  chicken: {
    sales: { label: "매출", hint: "구 평균 대비 치킨집 점포당 매출", fmt: (v) => `구 평균의 ${Math.round(v * 100)}%`, high: "매출이 높은 동네", low: "매출이 낮은 동네" },
    growth: { label: "흐름", hint: "연 개업률 − 연 폐업률", fmt: (v) => `${v > 0 ? "+" : ""}${v}%p`, high: "가게가 느는 동네", low: "가게가 주는 동네" },
    compete: { label: "경쟁", hint: "치킨집 수 ÷ 동 면적", fmt: (v) => `${v}곳/㎢`, high: "치킨집이 많은 동네", low: "치킨집이 적은 동네" },
    cost, life,
  },
  bunsik: {
    sales: { label: "매출", hint: "구 평균 대비 분식집 점포당 매출", fmt: (v) => `구 평균의 ${Math.round(v * 100)}%`, high: "매출이 높은 동네", low: "매출이 낮은 동네" },
    growth: { label: "흐름", hint: "연 개업률 − 연 폐업률", fmt: (v) => `${v > 0 ? "+" : ""}${v}%p`, high: "가게가 느는 동네", low: "가게가 주는 동네" },
    compete: { label: "경쟁", hint: "분식집 수 ÷ 동 면적", fmt: (v) => `${v}곳/㎢`, high: "분식집이 많은 동네", low: "분식집이 적은 동네" },
    cost, life,
  },
};
export const DONG_METRICS: Record<DongMetric, DongMetricInfo> = { ...DONG_METRICS_BY.bbq };
// 업종을 바꾼다 (모델의 지표 문구와 이 파일의 동네 지도 문구를 함께). 화면이 읽기 전에 부른다.
export function useIndustry(i: Industry) { setIndustry(i); Object.assign(DONG_METRICS, DONG_METRICS_BY[i]); }
// 지도 알약에 보일 지표: 고깃집에는 영업 기간 자료가 없다
export const dongMetricKeys = (): DongMetric[] => (Object.keys(DONG_METRICS) as DongMetric[]).filter((k) => k !== "life" || industry() === "cafe");
export function dongValue(m: DongMetric, p: DongProfile, d: Dong | undefined): number | null {
  if (m === "sales") return d?.rel ?? null;
  if (m === "growth") return p.growth;
  if (m === "compete") return p.stores >= 20 ? p.pork_km2 : null;
  if (m === "life") return p.stores >= 20 ? p.life ?? null : null;
  return p.rent ?? p.rent_gu;
}

// ---- 요약 줄: 태그 하나에 문장 하나, 태그를 누르면 짝이 되는 지표 탭(KTab)이 열린다 ------------------------------------------
export type Tone = "good" | "mid" | "warn";
export type KTab = "sales" | "comp" | "cost" | "survive";
export type Line = { tag: string; tone: Tone; tab: KTab; text: string };
export type Summary = { warn: Line[]; good: Line[] };
// 순위를 기준과 함께 풀어 쓴다: 위쪽 절반이면 "25개 구 중 3번째로 많아요", 아래쪽이면 아래에서 센다 "25개 구 중 가장 적어요".
export function rankWord(r: number, n: number, hi: string, lo: string): string {
  if (r <= Math.ceil(n / 2)) return r === 1 ? `${n}개 구 중 가장 ${hi}` : `${n}개 구 중 ${r}번째로 ${hi}`;
  const b = n - r + 1;
  return b === 1 ? `${n}개 구 중 가장 ${lo}` : `${n}개 구 중 ${b}번째로 ${lo}`;
}
const AVERAGE: Line = { tag: "평균 범위", tone: "mid", tab: "sales", text: "눈에 띄게 좋은 점은 없지만, 매출 수준은 서울 평균 범위예요." };

// ---- 이름, 키워드, 제안 --------------------------------------------------------------------------------
export type Insight = {
  style: string; why: string; keywords: string[]; actions: { text: string; why: string }[]; summary: Summary;
};
const sign = (v: number | null) => (v != null && v > 0 ? "+" : "");
const pct = (x: number) => `${Math.round(x * 100)}%`;
const won = (x: number) => `${Math.round(x / 1e8).toLocaleString("ko-KR")}억`;

export function insightOf(p: DongProfile): Insight | null {
  const c = cuts();
  if (!c) return null;
  const cafe = industry() === "cafe", S = T().shop, W = cafe ? "카페 매출" : industry() === "apparel" ? "의류 매출" : "한식 매출";
  // 동 프로필의 월세와 기준선은 보증금 환산분이 들어간 값이라(분류는 그 값끼리 비교) 문장에는 지표 카드와 같은 현금 월세로 바꿔 쓴다
  const cash = (v: number) => Math.round(cashRent(v) * 10) / 10;
  const rent = cash(p.rent ?? p.rent_gu ?? 0), rentHi = cash(c.rent[1]).toFixed(1);
  const lunchHi = p.shares.lunch >= c.lunch_hi, eveHi = p.shares.evening >= c.evening_hi, weekHi = p.shares.weekend >= c.weekend_hi;
  const porkHi = (p.pork_share ?? 0) >= c.pork_share_hi, flowHi = (p.flow_day ?? 0) >= c.flow_hi;

  // 1) 누가 오는 동네인가 -> 이름의 뒷부분
  let base: string, baseWhy: string;
  if (p.type === "오피스") { base = "직장인 회식형"; baseWhy = `${W}의 점심 비중 ${pct(p.shares.lunch)}, 주말 ${pct(p.shares.weekend)}라 평일 낮에 몰려요`; }
  else if (p.type === "대학·청년") { base = "청년 핫플형"; baseWhy = `${W}의 20대 비중이 ${pct(p.shares.age20)}로 높아요`; }
  else if (p.rich) { base = "부촌 단골형"; baseWhy = `아파트 평균 시가 ${won(p.apt_price ?? 0)}원으로 서울 상위 15%예요`; }
  else if (p.type === "주거" || p.family) { base = "동네 가족형"; baseWhy = `주말 매출 비중 ${pct(p.shares.weekend)}${p.age ? `, 40대 비중 ${pct(p.age[3])}` : ""}로 주거지 성격이 강해요`; }
  else { base = "생활 상권형"; baseWhy = "한쪽으로 치우치지 않고 평일·주말, 낮·밤 매출이 고르게 나뉘어요"; }

  // 2) 지금 어떤 상태인가 -> 이름의 앞부분
  let lead = "";
  if (p.grow === "성장" && p.comp !== "치열") lead = "뜨는 ";
  else if (p.comp === "치열" && p.grow !== "성장") lead = "경쟁 센 ";
  else if (p.grow === "하락" && p.comp === "약함") lead = "식어가는 ";
  else if (p.grow === "성장" && p.comp === "치열") lead = "붐비는 ";

  const keywords: string[] = [];
  if (lunchHi) keywords.push(cafe ? "점심 손님" : "점심 장사");
  if (eveHi) keywords.push(cafe ? "저녁 손님" : "저녁 2차");
  if (weekHi) keywords.push("주말 손님");
  if (p.shares.age20 >= 0.27) keywords.push("2030");
  if (p.age && p.age[3] + p.age[4] >= 0.4) keywords.push("4050 단골");
  if (flowHi || (p.subway ?? 0) >= 2) keywords.push("유동 많음");
  if (porkHi) keywords.push(`${S} 거리`);
  if (cafe && p.life != null && c.life && p.life >= c.life[1]) keywords.push("오래 버티는 상권");
  if (cafe && p.change === "상권확장") keywords.push("상권 확장");
  if (cafe && p.leisure != null && c.leisure_hi != null && p.leisure >= c.leisure_hi) keywords.push("여가·문화 소비");
  if (p.rich) keywords.push("객단가 높은 동네");
  if ((p.univ ?? 0) >= 1 && p.type === "대학·청년") keywords.push("대학가");

  // 3) 해 볼 일 (규칙 -> 근거 숫자)
  const A: { text: string; why: string; w: number }[] = [];
  const groups = krei()?.tables.inflow?.meat?.values;
  const group6 = groups ? Math.round(groups["단체(6인 이상)"]) : null;
  const pair = groups ? Math.round(groups["2~5인"]) : null;
  if (p.comp === "치열") A.push({ w: 9, text: "비슷한 가게가 많아요. 부위, 반찬, 가격대 가운데 한 가지 차별점을 먼저 정하세요.", why: `고깃집 ${p.pork_km2}곳/㎢로 서울 동네의 위쪽 3분의 1이에요` });
  if (p.cost === "높음") A.push({ w: 8, text: "월세가 높은 편이에요. 평수를 줄이거나 직원을 한 명 덜어 다달이 나가는 돈을 낮춰 보세요.", why: `평당 월세 ${rent}만원 (서울 동네 위쪽 3분의 1은 ${rentHi}만원 이상)` });
  if (p.grow === "성장" && p.comp !== "치열") A.push({ w: 10, text: "성장하는데 경쟁이 세지 않은 동네예요. 단골을 일찍 잡는 쪽이 유리해요.", why: `한식 매출 ${p.growth! > 0 ? "+" : ""}${p.growth}% (2024 대비), 고깃집 ${p.pork_km2 ?? "-"}곳/㎢` });
  if (p.grow === "하락") A.push({ w: 8, text: "매출이 줄어드는 동네예요. 첫 6개월 버틸 현금을 더 남겨 두세요.", why: `한식 매출 ${p.growth}% (2024 대비)` });
  if (lunchHi) A.push({ w: 6, text: "점심 손님이 많아요. 점심 한 상 메뉴를 따로 두고 영업을 낮 시간부터 여는 걸 따져 보세요.", why: `11~14시 매출 비중 ${pct(p.shares.lunch)} (서울 동네 위쪽 4분의 1은 ${pct(c.lunch_hi)} 이상)` });
  if (eveHi || p.type === "오피스") A.push({ w: 6, text: "회식 손님을 받을 단체석과 예약부터 갖추세요.", why: group6 != null ? `육류 전문점 손님의 ${group6}%가 6인 이상 단체, ${pair}%가 2~5인 (경영실태조사). 이 동네 저녁(17~24시) 매출 비중 ${pct(p.shares.evening)}` : `저녁 매출 비중 ${pct(p.shares.evening)}` });
  if ((weekHi && p.type !== "대학·청년") || p.family) A.push({ w: 5, text: "주말 가족 손님이 많아요. 4인 테이블 위주로 꾸미고 아이와 오는 손님을 생각한 구성을 해 보세요.", why: `주말 매출 비중 ${pct(p.shares.weekend)}` });
  if (p.shares.age20 >= 0.27) A.push({ w: 5, text: "20대 손님이 많아요. 2인 테이블을 늘리고 한 명 값을 낮춘 구성을 시험해 보세요.", why: `20대 매출 비중 ${pct(p.shares.age20)}` });
  if (p.rich) A.push({ w: 4, text: "집값이 높은 동네예요. 값을 낮추기보다 예약과 좋은 재료로 승부하는 쪽이 어울려요.", why: `아파트 평균 시가 ${won(p.apt_price ?? 0)}원, 서울 상위 15%` });
  if (cafe) { // 카페는 고깃집용 제안(단체석·회식·불판)이 맞지 않아 카페 규칙으로 바꾼다
    A.length = 0;
    const gs = p.growth != null ? `${sign(p.growth)}${p.growth}%p` : "";
    if (p.comp === "치열") A.push({ w: 9, text: "비슷한 카페가 많아요. 원두, 디저트, 자리 분위기 가운데 한 가지 차별점을 먼저 정하세요.", why: `카페 ${p.pork_km2}곳/㎢로 서울 동네의 위쪽 3분의 1이에요` });
    if (p.cost === "높음") A.push({ w: 8, text: "월세가 높은 편이에요. 평수를 줄이거나 직원을 한 명 덜어 다달이 나가는 돈을 낮춰 보세요.", why: `평당 월세 ${rent}만원 (서울 동네 위쪽 3분의 1은 ${rentHi}만원 이상)` });
    if (p.grow === "성장" && p.comp !== "치열") A.push({ w: 10, text: "가게가 늘고 있는데 경쟁이 세지 않은 동네예요. 단골을 일찍 잡는 쪽이 유리해요.", why: `개업이 폐업보다 ${gs} 많아요, 카페 ${p.pork_km2 ?? "-"}곳/㎢` });
    if (p.grow === "하락") A.push({ w: 8, text: "폐업이 개업보다 많은 동네예요. 첫 6개월 버틸 현금을 더 남겨 두세요.", why: `개업률 − 폐업률 ${gs}` });
    if (p.type === "오피스") A.push({ w: 7, text: "직장인 동네예요. 출근길과 점심 직후 주문이 빨리 나가는 동선을 먼저 잡으세요.", why: `점심 매출 비중 ${pct(p.shares.lunch)}, 주말 ${pct(p.shares.weekend)}` });
    if (lunchHi && p.type !== "오피스") A.push({ w: 6, text: "점심 직후 손님이 많아요. 점심 시간대 포장 동선과 점심 세트(음료+디저트)를 따져 보세요.", why: `11~14시 매출 비중 ${pct(p.shares.lunch)} (서울 동네 위쪽 4분의 1은 ${pct(c.lunch_hi)} 이상)` });
    if (eveHi) A.push({ w: 5, text: "저녁 손님이 많아요. 저녁까지 여는 시간과 디저트 구성을 따져 보세요.", why: `17~24시 매출 비중 ${pct(p.shares.evening)}` });
    if (weekHi || p.type === "주거") A.push({ w: 5, text: "주말 손님이 많아요. 앉을 자리와 디저트 구성을 넉넉히 두세요.", why: `주말 매출 비중 ${pct(p.shares.weekend)}` });
    if (p.shares.age20 >= 0.27) A.push({ w: 5, text: "20대 손님이 많아요. 2인 좌석을 늘리고 대표 음료 한두 가지로 시작해 보세요.", why: `20대 매출 비중 ${pct(p.shares.age20)}` });
    if (p.rich) A.push({ w: 4, text: "집값이 높은 동네예요. 값을 낮추기보다 원두와 디저트의 질로 승부하는 쪽이 어울려요.", why: `아파트 평균 시가 ${won(p.apt_price ?? 0)}원, 서울 상위 15%` });
  }
  const actions = A.sort((a, b) => b.w - a.w).slice(0, 3).map(({ text, why }) => ({ text, why }));

  // 주의할 점과 눈여겨볼 점: 줄마다 태그 하나, 숫자를 붙인 문장 하나
  const warn: Line[] = [], good: Line[] = [];
  const gs = `${sign(p.growth)}${p.growth}`;
  if (p.grow === "하락") warn.push(cafe
    ? { tag: "가게 수 감소", tone: "warn", tab: "survive", text: `폐업이 개업보다 ${Math.abs(p.growth ?? 0)}%p 많아요 (최근 4분기).` }
    : { tag: "매출 하락", tone: "warn", tab: "sales", text: `동 전체 한식 매출이 2024년보다 ${Math.abs(p.growth ?? 0)}% 줄었어요.` });
  if (p.comp === "치열") warn.push({ tag: "경쟁 치열", tone: "warn", tab: "comp", text: `${iga(S)} 촘촘해 경쟁이 세요 (1㎢당 ${p.pork_km2}곳).` });
  if (p.pop_per_pork != null && p.pop_per_pork < 150) warn.push({ tag: "인구 대비 많음", tone: "warn", tab: "comp", text: `${S} 1곳당 주민·직장인이 ${p.pop_per_pork}명뿐이에요.` });
  if (p.cost === "높음") warn.push({ tag: "월세 높음", tone: "warn", tab: "cost", text: `평당 월세 ${rent}만원으로 비싼 편이에요 (서울 동네 위쪽 3분의 1은 ${rentHi}만원 이상).` });
  if (cafe && p.close_life != null && c.close_life && p.close_life <= c.close_life[0]) warn.push({ tag: "빨리 닫음", tone: "warn", tab: "survive", text: `문 닫은 가게는 평균 ${p.close_life}개월 만에 닫았어요 (서울 ${p.s_close}개월).` });
  if (p.grow === "성장") good.push(cafe
    ? { tag: "가게 수 증가", tone: "good", tab: "survive", text: `개업이 폐업보다 ${gs}%p 많아요 (최근 4분기).` }
    : { tag: "매출 성장", tone: "good", tab: "sales", text: `동 전체 한식 매출이 2024년보다 ${gs}% 늘었어요.` });
  if (p.comp === "약함") good.push({ tag: "경쟁 약함", tone: "good", tab: "comp", text: `${iga(S)} 드물어 경쟁이 덜해요 (1㎢당 ${p.pork_km2 ?? "-"}곳).` });
  if (p.cost === "낮음") good.push({ tag: "월세 저렴", tone: "good", tab: "cost", text: `평당 월세 ${rent}만원으로 싼 편이에요.` });
  // 오래 버팀·소비 여력·유동 많음은 키워드 띠(bandOf)에 근거 카드로 나오므로 여기에는 넣지 않는다
  // 동 단위는 좋은 점이 키워드 띠로 옮겨 갔을 수 있어서, 없으면 구 단위의 "평균 범위" 문장으로 채우지 않고 묶음을 비운다
  const summary = { warn: warn.slice(0, 4), good: good.slice(0, 3) };
  return { style: `${lead}${base}`, why: baseWhy, keywords: keywords.slice(0, 4), actions, summary };
}

// ---- 이 구에서 눈여겨볼 동네 -------------------------------------------------------------------------
export type Pick = { p: DongProfile; d: Dong | undefined; note: string };
export function picksOf(gu: string): { small: Pick[]; steady: Pick[] } {
  const ds = dongsOf(gu);
  const byName = new Map(ds.map((d) => [d.name, d]));
  const rows = profilesOf(gu).map((p) => ({ p, d: byName.get(p.name) })).filter((x) => x.p.stores >= 20);
  const cafe = industry() === "cafe";
  const note = ({ p, d }: { p: DongProfile; d: Dong | undefined }) =>
    `구 평균 대비 매출 ${Math.round(d!.rel! * 100)}% · ${cafe ? "가게 수 흐름" : "성장"} ${sign(p.growth)}${p.growth}${cafe ? "%p" : "%"} · 경쟁 ${p.comp ?? "비교 없음"}`;
  const small = rows
    .filter(({ p, d }) => d?.rel != null && d.rel < 1 && p.grow === "성장" && p.comp !== "치열")
    .sort((a, b) => (b.p.growth ?? 0) - (a.p.growth ?? 0)).slice(0, 3)
    .map((x) => ({ ...x, note: note(x) }));
  // '꺾이지 않은' 동네라 성장률이 0% 이상인 곳만 넣는다 ('보합'에는 -0.9% 같은 감소가 섞여 있었다)
  const steady = rows
    .filter(({ p, d }) => d?.rel != null && d.rel >= 1.05 && p.growth != null && p.growth >= 0)
    .sort((a, b) => (b.d!.rel ?? 0) - (a.d!.rel ?? 0)).slice(0, 3)
    .map((x) => ({ ...x, note: note(x) }));
  return { small, steady };
}

export const meatSalesNote = () => {
  const a = kreiMean("pl_sales"), b = kreiMean("pl_sales", "hansik_all");
  return a && b ? { meat: a, all: b, ratio: a / b } : null;
};

// ---- 구 단위: "OO구 한눈에 보기" ---------------------------------------------------------------------------
export type GuInsight = { summary: Summary; compete: "약함" | "보통" | "치열" };
export function guInsight(gu: string, names: string[]): GuInsight {
  const st = guStat(gu), n = names.length;
  const third = Math.ceil(n / 3);
  // 매출 성장률은 고깃집(한식)만 있다. 카페·옷가게는 growth 자리에 가게 수 흐름이 들어 있어 성장 문장을 쓰지 않는다
  const S = T().shop, B = T().base, cafe = industry() !== "bbq";
  const rD = rankOf(gu, "demand", names), rG = rankOf(gu, "growth", names), rP = rankOf(gu, "pork", names), rC = rankOf(gu, "closure", names);
  const rentRank = names.filter((x) => guStat(x).rent > st.rent).length + 1; // 비싼 순
  const prev = growthMeta()?.prev ?? 2024;
  const warn: Line[] = [], good: Line[] = [];
  // 매출
  if (rD <= third) good.push({ tag: "매출 상위", tone: "good", tab: "sales", text: `${B} 한 곳당 월매출이 ${rankWord(rD, n, "높아요", "낮아요")}.` });
  if (rD > n - third) warn.push({ tag: "매출 하위", tone: "warn", tab: "sales", text: `${B} 한 곳당 월매출이 ${rankWord(rD, n, "높아요", "낮아요")}.` });
  if (!cafe && st.growth != null && rG <= third && st.growth > 0) good.push({ tag: "성장 중", tone: "good", tab: "sales", text: `${B} 점포당 월매출이 ${prev}년보다 ${st.growth}% 늘었어요. ${rankWord(rG, n, "많이 늘었어요", "적게 늘었어요")}.` });
  if (!cafe && st.growth != null && (rG > n - third || st.growth < -1.5)) warn.push({ tag: "성장 둔화", tone: "warn", tab: "sales", text: st.growth < 0
    ? `${B} 점포당 월매출이 ${prev}년보다 ${Math.abs(st.growth)}% 줄었어요. ${rankWord(rG, n, "적게 줄었어요", "많이 줄었어요")}.`
    : `${B} 점포당 월매출이 ${prev}년보다 ${st.growth}% 늘었지만, ${rankWord(rG, n, "많이 늘었어요", "적게 늘었어요")}.` });
  // 경쟁
  const compete: GuInsight["compete"] = rP <= third ? "치열" : rP > n - third ? "약함" : "보통";
  const shops = `${iga(S)} ${st.pork.toLocaleString("ko-KR")}곳으로 ${rankWord(rP, n, "많아요", "적어요")}.`;
  if (compete === "치열") warn.push({ tag: "경쟁 치열", tone: "warn", tab: "comp", text: shops });
  if (compete === "약함") good.push({ tag: "경쟁 약함", tone: "good", tab: "comp", text: shops });
  // 비용
  const rent = `평당 월세 ${st.rent}만원으로 ${rankWord(rentRank, n, "비싸요", "싸요")}.`;
  if (rentRank <= third) warn.push({ tag: "월세 높음", tone: "warn", tab: "cost", text: rent });
  if (rentRank > n - third) good.push({ tag: "월세 저렴", tone: "good", tab: "cost", text: rent });
  // 생존
  const closed = `${B} 10곳 중 ${(st.closure / 10).toFixed(1)}곳이 1년 안에 문을 닫았어요 (${industry() === "cafe" ? "최근 4분기" : "2025년"}). ${rankWord(rC, n, "많아요", "적어요")}.`;
  if (rC <= third) warn.push({ tag: "폐업 많음", tone: "warn", tab: "survive", text: closed });
  if (rC > n - third) good.push({ tag: "폐업 적음", tone: "good", tab: "survive", text: closed });
  if (st.netOpen != null && st.netOpen > 0) good.push({ tag: "가게 증가", tone: "good", tab: "survive", text: `개업이 폐업보다 많아 ${iga(B)} 늘고 있어요 (${sign(st.netOpen)}${st.netOpen}%p).` });
  return { summary: { warn: warn.slice(0, 4), good: good.length ? good.slice(0, 3) : [AVERAGE] }, compete };
}

// ---- 동 단위 키워드 띠: '~형 상권' 이름의 단어와 키워드마다 근거 숫자 하나 --------------------------------------
// 이름과 키워드는 insightOf의 규칙 그대로이고, 여기서는 그 규칙이 본 숫자를 카드로 옮기기만 한다(새 규칙 없음).
export type BandCard = { label: string; value: string; sub: string };
const people = (n: number | null) => (n == null ? "-" : n >= 10000 ? `${(Math.round(n / 1000) / 10).toLocaleString("ko-KR")}만 명` : `${n.toLocaleString("ko-KR")}명`);
export function bandOf(p: DongProfile, ins: Insight): BandCard[] {
  const c = cuts();
  const cafe = industry() === "cafe", S = T().shop, W = cafe ? "카페 매출 비중" : industry() === "apparel" ? "의류 매출 비중" : "한식 매출 비중";
  const out: BandCard[] = [];
  // 같은 숫자는 한 번만: 다른 카드나 띠의 설명 문장(ins.why)에 이미 나온 비율이면 넣지 않는다
  const nums = (t: string): string[] => t.match(/\d+(\.\d+)?%/g) ?? [];
  const add = (b: BandCard) => {
    const n = nums(b.value);
    if (out.some((x) => x.label === b.label || x.value === b.value)) return;
    if (n.length && n.every((x) => nums(ins.why).includes(x))) return;
    out.push(b);
  };
  const age = p.age;
  // 이름 앞말(뜨는·경쟁 센·식어가는·붐비는)은 매출 흐름과 경쟁이라 아래 '한눈에 보기'의 줄이 근거를 맡는다. 여기서는 손님·시간대·사람만.
  if (ins.style.endsWith("직장인 회식형")) add({ label: "직장인", value: `점심 ${pct(p.shares.lunch)} · 주말 ${pct(p.shares.weekend)}`, sub: W });
  if (ins.style.endsWith("청년 핫플형")) add({ label: "청년", value: `20대 매출 ${pct(p.shares.age20)}`, sub: `30대는 ${pct(p.shares.age30)}` });
  if (ins.style.endsWith("부촌 단골형")) add({ label: "부촌", value: `아파트 ${won(p.apt_price ?? 0)}원`, sub: "평균 시가, 서울 상위 15%" });
  if (ins.style.endsWith("동네 가족형")) add({ label: "가족", value: `주말 매출 ${pct(p.shares.weekend)}`, sub: `주민 ${people(p.resident_pop)}` });
  if (ins.style.endsWith("생활 상권형")) {
    add({ label: "생활", value: `주민 ${people(p.resident_pop)}`, sub: `직장인은 ${people(p.work_pop)}` });
    add({ label: "고르게", value: `주말 ${pct(p.shares.weekend)} · 저녁 ${pct(p.shares.evening)}`, sub: W });
  }
  for (const k of ins.keywords) {
    if (k === "점심 장사" || k === "점심 손님") add({ label: k, value: `점심 매출 ${pct(p.shares.lunch)}`, sub: c ? `서울 동네 위쪽 4분의 1은 ${pct(c.lunch_hi)} 이상` : W });
    else if (k === "저녁 2차" || k === "저녁 손님") add({ label: k, value: `저녁 매출 ${pct(p.shares.evening)}`, sub: c ? `서울 동네 위쪽 4분의 1은 ${pct(c.evening_hi)} 이상` : W });
    else if (k === "주말 손님") add({ label: k, value: `주말 매출 ${pct(p.shares.weekend)}`, sub: c ? `서울 동네 위쪽 4분의 1은 ${pct(c.weekend_hi)} 이상` : W });
    else if (k === "2030") add({ label: k, value: `20대 매출 ${pct(p.shares.age20)}`, sub: `30대는 ${pct(p.shares.age30)}` });
    else if (k === "4050 단골" && age) add({ label: k, value: `40·50대 매출 ${pct(age[3] + age[4])}`, sub: `20·30대는 ${pct(age[1] + age[2])}` });
    else if (k === "유동 많음") add(c && (p.flow_day ?? 0) >= c.flow_hi
      ? { label: k, value: `하루 유동 ${people(Math.round(p.flow_day ?? 0))}`, sub: "길단위 유동인구, 서울 동네 위쪽 4분의 1" }
      : { label: k, value: `지하철역 ${p.subway}곳`, sub: "동 안의 역" });
    else if (k === `${S} 거리`) add({ label: k, value: `한식 중 ${S} ${pct(p.pork_share ?? 0)}`, sub: "상가정보 2026년 6월" });
    else if (k === "오래 버티는 상권") add({ label: k, value: `평균 ${p.life}개월`, sub: `영업 중인 가게, 서울 ${p.s_life}개월` });
    else if (k === "상권 확장") add({ label: k, value: "상권확장", sub: "서울시 상권변화지표" });
    else if (k === "여가·문화 소비") add({ label: k, value: `여가 지출 ${pct(p.leisure ?? 0)}`, sub: "동네 지출 중 여가·문화" });
    else if (k === "객단가 높은 동네") add({ label: "객단가", value: `아파트 ${won(p.apt_price ?? 0)}원`, sub: "평균 시가, 서울 상위 15%" });
    else if (k === "대학가") add({ label: k, value: `대학 ${p.univ}곳`, sub: "동 안의 대학교" });
  }
  return out;
}

// ---- 동 경쟁 탭: 가게 목록(dong_shops.json, pipelines/build_dong_shops.py)과 카페 구성(cafe_dong.json, 카페 팀 지표 엑셀) ----------
export type Brand = { b: string; low: boolean; n: number; branches: string[] };
export type DongShops = { hansik: Record<string, number>; pork: string[]; cafe_brands: Brand[]; cafe_floor: { known: number; f1: number }; mix: Record<string, number> };
export type ShopData = { _meta: { mix_quarter: string; mix_labels: string[]; seoul_hansik_share: Record<string, number> }; dong: Record<string, DongShops> };
export type CafeRow = {
  gu: string; code: string; name: string; cafes: number; franchise: number; lowcost: number; indie_coffee: number; indie_dessert: number; unmanned: number;
  cf_stores: number; open_y: number; close_y: number; density: number; area_km2: number; franchise_share: number; resident_per_cafe: number; work_per_cafe: number;
  near_station_share: number; subway: number;
};
let SHOPS: ShopData | null = null;
let CAFE_ROWS: CafeRow[] = [];
export const setShopData = (s: ShopData | null, cafe: { dong: CafeRow[] } | null) => { SHOPS = s; CAFE_ROWS = cafe?.dong ?? []; };
export const shopMeta = () => SHOPS?._meta ?? null;
export const shopsOf = (code: string): DongShops | null => SHOPS?.dong[code] ?? null;
export const cafeRowOf = (code: string): CafeRow | undefined => CAFE_ROWS.find((r) => r.code === code);
// 카페 밀도는 동네 지표 카드(cafe_dong_profile의 pork_km2)와 같게 카페 수 ÷ 동 면적으로 낸다. 지표 엑셀의 density 열은 면적 기준이 달라 값이 어긋난다.
export const cafeDensity = (r: CafeRow) => (r.area_km2 ? r.cafes / r.area_km2 : 0);
const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
// 서울 비교 기준: 카페 10곳 이상인 동. 비율은 동별 값의 중간값, 저가 비중만 서울 전체 합으로 낸다(동별 중간값이 0에 몰려서).
export function cafeSeoul(gu: string) {
  const rows = CAFE_ROWS.filter((r) => r.cafes >= 10);
  const g = CAFE_ROWS.filter((r) => r.gu === gu);
  const sum = (rs: CafeRow[], k: keyof CafeRow) => rs.reduce((a, r) => a + (r[k] as number), 0);
  return {
    n: rows.length,
    density: median(rows.map(cafeDensity)),
    densityRank: (v: number) => rows.filter((r) => cafeDensity(r) <= v).length / rows.length, // 한산한 쪽에서 몇 %
    franchise: median(rows.map((r) => r.franchise_share)),
    franchiseGu: g.length ? sum(g, "franchise") / Math.max(1, sum(g, "cafes")) : null,
    lowcost: sum(CAFE_ROWS, "lowcost") / Math.max(1, sum(CAFE_ROWS, "cafes")),
    close: median(rows.map((r) => r.close_y)),
  };
}

// ---- 동 안 상권 추천 (dong_trdar.json, pipelines/build_dong_trdar.py) ---------------------------------------------
// 라벨 규칙은 docs/design-handoff/README.md 4장의 제안에, 성장·안정은 점포 10곳 이상인 상권에만 붙인다는 조건을 더한 것(2026-10-18 확정).
// 점포가 몇 곳 안 되는 상권은 한두 곳의 매출로 증감과 점포당 매출이 크게 흔들려서다. 바꾸려면 여기 숫자만 고치면 된다.
export type TrdarInd = {
  stores: number; franchise: number; open: number; close: number; per_store?: number | null; yoy?: number;
  weekend?: number; band?: Record<"morning" | "lunch" | "afternoon" | "evening" | "night", number> | null; age2030?: number; age4050?: number;
};
export type Trdar = { code: string; name: string; type: string; ind: Partial<Record<Industry, TrdarInd>> };
export type TrdarData = { _meta: { quarter: string; quarter_prev: string; flow_quarters: string[]; bench: Record<Industry, { n: number; per_store_q: number[] }> }; dong: Record<string, Trdar[]> };
export type TrdarLabel = "성장" | "안정" | "조심";
export type TrdarPick = { t: Trdar; m: TrdarInd; label: TrdarLabel | null };
let TRDAR: TrdarData | null = null;
export const setTrdarData = (d: TrdarData | null) => { TRDAR = d; };
export const trdarMeta = () => TRDAR?._meta ?? null;
export const TRDAR_RULE = { minStores: 5, labelMinStores: 10, stableClose: 0.1, cautionYoy: -15, cautionCloseRatio: 1.5 };
export function trdarPicks(code: string): { all: Trdar[]; picks: TrdarPick[] } | null {
  if (!TRDAR) return null;
  const all = TRDAR.dong[code] ?? [];
  const R = TRDAR_RULE, ind = industry();
  // 대상: 해당 업종 점포 5곳 이상이고 매출 자료가 있는 상권
  const cand = all.flatMap((t) => { const m = t.ind[ind]; return m && m.stores >= R.minStores && m.per_store != null ? [{ t, m }] : []; });
  const label = new Map<string, TrdarLabel>();
  const big = cand.filter((x) => x.m.stores >= R.labelMinStores); // 성장·안정 후보
  const grow = [...big].filter((x) => (x.m.yoy ?? 0) > 0).sort((a, b) => (b.m.yoy ?? 0) - (a.m.yoy ?? 0))[0];
  if (grow) label.set(grow.t.code, "성장");
  const top = [...big].sort((a, b) => (b.m.per_store ?? 0) - (a.m.per_store ?? 0))[0];
  if (top && !label.has(top.t.code) && top.m.close <= top.m.stores * R.stableClose) label.set(top.t.code, "안정");
  for (const x of cand) {
    if (label.has(x.t.code)) continue; // 겹치면 성장 > 안정 > 조심
    if ((x.m.yoy ?? 0) <= R.cautionYoy || x.m.close > x.m.open * R.cautionCloseRatio) label.set(x.t.code, "조심");
  }
  const order = { 성장: 0, 안정: 1, 조심: 2 } as const;
  const picks = cand.map(({ t, m }) => ({ t, m, label: label.get(t.code) ?? null }))
    .sort((a, b) => (a.label ? order[a.label] : 3) - (b.label ? order[b.label] : 3) || (b.m.per_store ?? 0) - (a.m.per_store ?? 0));
  return { all, picks };
}

// 자료를 모듈 변수에 들고 있어서, 이 파일이 핫리로드로 새로 불리면 자료가 비는데 화면은 로딩 완료로 남는다. 통째로 다시 불러 맞춘다.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());

// ---- 동네 사람 (dong_flow.json, pipelines/build_dong_flow.py) -----------------------------------------------------
// 서울시 상권분석서비스 길단위인구·상주인구·직장인구(행정동, 자치구). 길단위 값은 분기 값이라 하루 값은 분기 값 ÷ 91로 어림한다
// (같은 자료로 계산한 dong_profile.json의 flow_day와 같은 방식). 추정치이므로 화면에는 '지나가는 사람 하루 약 n명'으로만 적는다.
export type FlowBlock = { tot: number; male: number | null; age: number[]; band?: number[]; dow?: number[]; q?: string };
export type FlowRow = { name: string; flow: FlowBlock; resi?: FlowBlock; work?: FlowBlock };
export type FlowData = { _meta: { quarter: string; age: string[]; band: string[]; dow: string[] }; dong: Record<string, FlowRow>; gu: Record<string, FlowBlock> };
let FLOW: FlowData | null = null;
export const setFlowData = (d: FlowData | null) => { FLOW = d; };
export const flowMeta = () => FLOW?._meta ?? null;
export const FLOW_DAYS = 91;
/** 동 코드가 있으면 그 동, 없으면 구의 길단위인구 */
export function flowOf(code: string | undefined, gu: string): { scope: "dong" | "gu"; row: FlowBlock; resi?: FlowBlock; work?: FlowBlock } | null {
  if (!FLOW) return null;
  const d = code ? FLOW.dong[code] : undefined;
  if (d) return { scope: "dong", row: d.flow, resi: d.resi, work: d.work };
  const g = FLOW.gu[gu];
  return g ? { scope: "gu", row: g } : null;
}
export const flowPerDay = (f: FlowBlock) => Math.round(f.tot / FLOW_DAYS);
/** 엔진에 넘길 요일·시간대·연령 비율 (store_input.from_changeup의 flow) */
export function flowShape(code: string | undefined, gu: string): { dow: number[]; band: number[]; age: number[] } | null {
  const f = flowOf(code, gu)?.row;
  return f && f.dow && f.band ? { dow: f.dow, band: f.band, age: f.age } : null;
}
