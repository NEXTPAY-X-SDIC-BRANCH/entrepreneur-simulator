// 카페의 여는 비용. 고깃집(model.ts openingCost)과 같은 줄 구성이지만 값은 카페 자료에서 가져온다.
// 값의 출처: 서울 행정동 카페 지표 엑셀 '시작 비용' 시트(cafe_cost.json), 외식업체 경영실태조사 2025 원자료 중 독립(비프랜차이즈) 커피 전문점·음료점의
// 가중 25/50/75 분위수 (등급 H). 간판과 첫 재료는 자료가 없어 고깃집과 같은 가정값이다.
import { profileOf } from "./area";
import { DEPOSIT_MONTHS, guStat, type CostLine, type Grade, type Profile } from "./model";

export const CAFE_PYEONG = { low: 13, mid: 20, high: 28 } as const; // 매장 면적 분위수 (sto_area_pyeong)
// 평당 만원. 기본·중급·고급을 25·50·75분위에 맞춘다 (고깃집과 같은 방식).
export const CAFE_GRADES: Record<Grade, { label: string; interior: number; kitchen: number; hall: number }> = {
  basic: { label: "기본", interior: 75, kitchen: 40, hall: 25 },    // cst_interior_per_pyeong 75 / cst_kitchen_per_pyeong 40 / 홀 총액 500÷20평
  mid: { label: "중급", interior: 150, kitchen: 91, hall: 50 },      // 150 / 90.9 / 1,000÷20평
  high: { label: "고급", interior: 208, kitchen: 150, hall: 100 },   // 208.3 / 150 / 2,000÷20평
};
export const CAFE_SIGN = 250, CAFE_FIRST_STOCK = 300; // 가정 (고깃집과 같은 값)
export const CAFE_KEY_MONEY = { low: 1500, base: 2500, high: 4000 }; // 권리금을 낸 독립 매장의 분위수 (cst_key_money)

export function cafeOpeningCost(pyeong: number, grade: Grade, gu: string, keyMoney = 0): { lines: CostLine[]; total: number } {
  const st = guStat(gu), g = CAFE_GRADES[grade];
  const lines: CostLine[] = [
    ...(keyMoney > 0 ? [{ key: "keymoney", label: "권리금", amount: keyMoney, basis: "직접 넣은 값 (가게 자리에 붙는 웃돈, 나갈 때 돌려받지 못해요)" }] : []),
    { key: "deposit", label: "보증금", amount: Math.round(st.rent * pyeong * DEPOSIT_MONTHS), basis: `월세 ${DEPOSIT_MONTHS}개월분 (서울시 실태조사: 보증금은 월세의 11~15개월)` },
    { key: "interior", label: "인테리어 공사", amount: g.interior * pyeong, basis: `${pyeong}평, 평당 ${g.interior}만원 (${g.label})` },
    { key: "equip", label: "머신과 주방 설비", amount: g.kitchen * pyeong, basis: `에스프레소 머신, 냉장·제빙 등, 평당 ${g.kitchen}만원 (${g.label})` },
    { key: "seat", label: "가구와 집기", amount: g.hall * pyeong, basis: `테이블, 의자, 카운터 집기, 평당 ${g.hall}만원 (${g.label})` },
    { key: "sign", label: "간판", amount: CAFE_SIGN, basis: "전면 간판 1개, 가정" },
    { key: "stock", label: "첫 재료와 소모품", amount: CAFE_FIRST_STOCK, basis: "원두, 우유, 컵, 디저트, 가정" },
  ];
  return { lines, total: lines.reduce((n, l) => n + l.amount, 0) };
}

// 가진 돈에 맞춘 대략의 구성: 독립 카페 면적 중앙값(20평)에서 시작해, 석 달 버틸 돈까지 못 맞추면 평수를 줄인다(최소 10평).
export function cafeEstimate(profile: Profile, burn: number): { pyeong: number; grade: Grade; cost: ReturnType<typeof cafeOpeningCost> } {
  const grade: Grade = "basic";
  let pyeong: number = CAFE_PYEONG.mid;
  while (pyeong > 10 && cafeOpeningCost(pyeong, grade, profile.gu, profile.keyMoney ?? 0).total + burn > profile.capital) pyeong--;
  return { pyeong, grade, cost: cafeOpeningCost(pyeong, grade, profile.gu, profile.keyMoney ?? 0) };
}

// 엔진에 넘길 행정동 코드. 동네를 안 골랐으면 배치 미리보기용으로 대학로 상권 코드를 쓴다 (배치는 상권과 무관).
export const cafeDistrictCode = (profile: Profile): string => {
  const p = profile.dong && profile.dong.gu === profile.gu ? profileOf(profile.gu, profile.dong.name) : undefined;
  return p ? String(p.code) : "3120012";
};
