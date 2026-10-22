// lab:industry 새 업종(한식 백반집, 호프·주점, 분식집, 베이커리, 치킨집)의 화면용 값. 엔진은 sim/generic, 근거는 research/industries/README.md.
// 숫자는 research/industries/rank.json·krei.json에서 옮겼다 (서울 가게 수 = 소상공인 상가정보 2026년 6월, 객단가 = 경영실태조사 2025 원자료 가중 평균).
export const LAB_IDS = ["hansik", "pub", "bunsik", "bakery", "chicken"] as const;
export type LabIndustry = (typeof LAB_IDS)[number];
export const isLab = (i: string): i is LabIndustry => (LAB_IDS as readonly string[]).includes(i);

type Txt = { shop: string; base: string; kind: string; cat: string };
// model.ts TXT와 같은 모양: shop = 화면 이름, base = 서울시 상권분석서비스 업종 이름
export const LAB_TXT: Record<LabIndustry, Txt> = {
  hansik: { shop: "한식 백반집", base: "한식음식점", kind: "백반집", cat: "한식 가게" },
  pub: { shop: "호프·주점", base: "호프-간이주점", kind: "주점", cat: "주점" },
  bunsik: { shop: "분식집", base: "분식전문점", kind: "분식집", cat: "분식 가게" },
  bakery: { shop: "베이커리", base: "제과점", kind: "빵집", cat: "빵집" },
  chicken: { shop: "치킨집", base: "치킨전문점", kind: "치킨집", cat: "치킨 가게" },
};

// 1단계 업종 고르기 (안 B: 식사 / 술 / 카페·빵, 2열). 일곱 업종 모두 같은 출처의 한 줄을 단다.
export type PickerItem = { id: string; name: string; desc: string; data: string; group: "meal" | "drink" | "cafe" | "shop"; isNew: boolean; easy?: false }; // easy: false = 이지 모드에 없음
export const PICKER: PickerItem[] = [
  { id: "bbq", name: "고깃집", desc: "삼겹살, 목살 같은 돼지고기 구이 (자료는 한식 육류 요리 전문점 기준)", data: "서울 7,834곳 · 객단가 1만 8,900원", group: "meal", isNew: false },
  { id: "hansik", name: "한식 백반집", desc: "백반, 찌개, 국밥 같은 식사 위주 한식 (자료는 한식 일반음식점 기준)", data: "서울 3만 1,700곳 · 객단가 1만 3,700원", group: "meal", isNew: true },
  { id: "bunsik", name: "분식집", desc: "김밥, 떡볶이, 라면처럼 빠르게 먹는 메뉴", data: "서울 8,097곳 · 객단가 6,700원", group: "meal", isNew: true },
  { id: "chicken", name: "치킨집", desc: "튀김·구이 치킨, 매출의 40%가 배달", data: "서울 5,560곳 · 객단가 1만 6,500원", group: "meal", isNew: true },
  { id: "pub", name: "호프·주점", desc: "생맥주, 요리 주점, 포차처럼 저녁에 여는 술집", data: "서울 1만 3,639곳 · 객단가 2만 1,000원", group: "drink", isNew: true },
  { id: "cafe", name: "카페", desc: "커피, 음료, 디저트 (자료는 독립 카페 기준, 동네 분석부터 열려 있어요)", data: "서울 2만 2,739곳 · 객단가 5,700원", group: "cafe", isNew: false },
  { id: "bakery", name: "베이커리", desc: "빵, 케이크, 구움과자, 매출의 59%가 포장", data: "서울 6,119곳 · 객단가 8,200원", group: "cafe", isNew: true },
  // lab:merge 옷가게 (upstream apparel.ts 화면). 가게 수와 결제 1건 금액은 서울시 상권분석서비스 일반의류(상권 안, gu_stats.json apparel)
  { id: "apparel", name: "옷가게", desc: "동네 의류 가게 (서울 소매업 중 가게 수와 매출이 가장 많은 일반의류 기준, 구 단위 분석)", data: "서울 상권 안 5만 1,953곳 · 결제 1건 6만 3,800원", group: "shop", isNew: true, easy: false },
];
export const PICKER_GROUPS: { key: PickerItem["group"]; label: string }[] = [
  { key: "meal", label: "식사" }, { key: "drink", label: "술" }, { key: "cafe", label: "카페·빵" }, { key: "shop", label: "판매" },
];
export const PICKER_SRC = "서울 가게 수는 소상공인 상가정보(2026년 6월), 객단가는 외식업체 경영실태조사 2025 원자료(전국, 1인 평균)예요. 옷가게는 서울시 상권분석서비스(상권 안 일반의류) 값이에요.";
export const industryLabel = (id: string) => PICKER.find((p) => p.id === id)?.name ?? id;

// 3단계 '가진 돈' 질문의 참고 문장: 경영실태조사 2025 개업 시 투자 비용(보증금·권리금 제외) 분위수, 만원
export const INVEST: Record<LabIndustry, { p25: number; p50: number; p75: number; n: number; label: string }> = {
  hansik: { p25: 2800, p50: 5000, p75: 8000, n: 282, label: "한식 일반음식점" },
  pub: { p25: 3000, p50: 5000, p75: 8000, n: 168, label: "생맥주 전문점과 기타 주점" },
  bunsik: { p25: 2500, p50: 4000, p75: 6000, n: 132, label: "김밥 및 기타 간이음식점" },
  bakery: { p25: 3500, p50: 5500, p75: 8000, n: 105, label: "제과점" },
  chicken: { p25: 3000, p50: 5200, p75: 8000, n: 94, label: "치킨 전문점" },
};

// 지도 지표 문구 (model.ts METRICS_BY와 같은 모양). 새 업종은 2024년 구 매출이 없어 카페처럼 '가게 수 흐름'을 쓴다.
export const labMetrics = (i: LabIndustry) => {
  const t = LAB_TXT[i];
  return {
    demand: { label: "매출 지수", fmt: (v: number) => v.toFixed(2), hint: `${t.base} 한 곳의 월매출(카드 추정), 서울 평균이 1` },
    growth: { label: "가게 수 흐름", fmt: (v: number) => `${v > 0 ? "+" : ""}${v}%p`, hint: "연 개업률 − 연 폐업률 (서울시 상권분석서비스 2025)" },
    pork: { label: `${t.kind} 수`, fmt: (v: number) => `${v.toLocaleString("ko-KR")}곳`, hint: `${t.shop} 가게 수, 구 전체 (소상공인 상가정보 2026년 6월)` },
    closure: { label: "1년 폐업률", fmt: (v: number) => `${v}%`, hint: `2025년에 문 닫은 ${t.base} 비율` },
  };
};
// 동네 지도 문구 (area.ts DONG_METRICS_BY와 같은 모양). 새 업종 화면은 동네 지도를 쓰지 않지만 업종을 바꿀 때 비워 두지 않게 채운다.
export const labDongMetrics = (i: LabIndustry) => {
  const t = LAB_TXT[i];
  return {
    sales: { label: "매출", hint: `구 평균 대비 ${t.base} 점포당 매출, 카드 추정`, fmt: (v: number) => `구 평균의 ${Math.round(v * 100)}%`, high: "매출이 높은 동네", low: "매출이 낮은 동네" },
    growth: { label: "흐름", hint: "연 개업률 − 연 폐업률", fmt: (v: number) => `${v > 0 ? "+" : ""}${v}%p`, high: "가게가 느는 동네", low: "가게가 주는 동네" },
    compete: { label: "경쟁", hint: `${t.kind} 수`, fmt: (v: number) => `${v}곳`, high: `${t.kind}이 많은 동네`, low: `${t.kind}이 적은 동네` },
    cost: { label: "월세", hint: "평당 월세 (한국부동산원)", fmt: (v: number) => `${v}만원`, high: "월세가 비싼 동네", low: "월세가 싼 동네" },
    life: { label: "버티는 기간", hint: "자료 없음", fmt: (v: number) => `${v}개월`, high: "", low: "" },
  };
};

// 받침에 맞는 조사: josa("베이커리", "이가") -> "베이커리가", josa("치킨집", "을를") -> "치킨집을"
export function josa(word: string, pair: "이가" | "은는" | "을를" | "과와"): string {
  const ch = word.charCodeAt(word.length - 1);
  const batchim = ch >= 0xac00 && ch <= 0xd7a3 && (ch - 0xac00) % 28 !== 0;
  return word + (batchim ? pair[0] : pair[1]);
}
