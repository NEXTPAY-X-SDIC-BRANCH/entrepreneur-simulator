// 카페의 여는 비용. 고깃집(model.ts openingCost)과 같은 줄 구성이지만 값은 카페 자료에서 가져온다.
// 값의 출처: 서울 행정동 카페 지표 엑셀 '시작 비용' 시트(cafe_cost.json), 외식업체 경영실태조사 2025 원자료 중 독립(비프랜차이즈) 커피 전문점·음료점의
// 가중 25/50/75 분위수 (등급 H). 간판과 첫 재료는 자료가 없어 고깃집과 같은 가정값이다.
import { cafeRowOf, profileOf, profilesOf } from "./area";
import { DEPOSIT_MONTHS, ftcNote, guStat, type CostLine, type Grade, type Profile } from "./model";
import { interiorLines } from "./shopItems";

// 가게 꾸미기에서 고르는 물건 한 개 값 (만원, 기본 마감 기준, 가정). 중급은 1.4배, 고급은 2배
export type CafeCounts = { tables: number; chairs: number; bar: number; groups: number; showcase: number; oven: number; kiosks: number; pos: number };
export const CAFE_ITEM_PRICE: CafeCounts = { tables: 30, chairs: 8, bar: 10, groups: 450, kiosks: 120, pos: 150, showcase: 250, oven: 300 };
export const CAFE_ITEM_GRADE: Record<Grade, number> = { basic: 1, mid: 1.4, high: 2 };
export const cafeDefaultCounts = (pyeong: number): CafeCounts => ({ tables: Math.max(1, Math.round(pyeong * 0.36)), chairs: Math.max(2, Math.round(pyeong * 1.27)), bar: 0, groups: 2, showcase: 1, oven: 0, kiosks: 0, pos: 1 });

export const CAFE_PYEONG = { low: 13, mid: 20, high: 28 } as const; // 매장 면적 분위수 (sto_area_pyeong)
// 평당 만원. 기본·중급·고급을 25·50·75분위에 맞춘다 (고깃집과 같은 방식).
export const CAFE_GRADES: Record<Grade, { label: string; interior: number; kitchen: number; hall: number }> = {
  basic: { label: "기본", interior: 75, kitchen: 40, hall: 25 },    // cst_interior_per_pyeong 75 / cst_kitchen_per_pyeong 40 / 홀 총액 500÷20평
  mid: { label: "중급", interior: 150, kitchen: 91, hall: 50 },      // 150 / 90.9 / 1,000÷20평
  high: { label: "고급", interior: 208, kitchen: 150, hall: 100 },   // 208.3 / 150 / 2,000÷20평
};
export const CAFE_SIGN = 250, CAFE_FIRST_STOCK = 300; // 가정 (고깃집과 같은 값)
export const CAFE_KEY_MONEY = { low: 1500, base: 2500, high: 4000 }; // 권리금을 낸 독립 매장의 분위수 (cst_key_money)

export function cafeOpeningCost(pyeong: number, grade: Grade, gu: string, keyMoney = 0, counts?: CafeCounts, doors?: number): { lines: CostLine[]; total: number } {
  const st = guStat(gu), g = CAFE_GRADES[grade], c = counts ?? cafeDefaultCounts(pyeong), gm = CAFE_ITEM_GRADE[grade];
  const sum = (ks: (keyof CafeCounts)[]) => ks.reduce((a, k) => a + Math.round(CAFE_ITEM_PRICE[k] * gm) * c[k], 0);
  const say = (ks: (keyof CafeCounts)[], nm: Record<string, string>) => ks.filter((k) => c[k] > 0).map((k) => `${nm[k]} ${c[k]}개 × ${Math.round(CAFE_ITEM_PRICE[k] * gm)}만원`).join(", ") + " (가정)";
  const NM = { tables: "테이블", chairs: "의자", bar: "바 좌석", groups: "머신 그룹", kiosks: "키오스크", pos: "계산대", showcase: "진열장", oven: "오븐" };
  const lines: CostLine[] = [
    ...(keyMoney > 0 ? [{ key: "keymoney", label: "권리금", amount: keyMoney, basis: "직접 넣은 값 (가게 자리에 붙는 웃돈, 나갈 때 돌려받지 못해요)" }] : []),
    { key: "deposit", label: "보증금", amount: Math.round(st.rent * pyeong * DEPOSIT_MONTHS), basis: `월세 ${DEPOSIT_MONTHS}개월분 (서울시 실태조사: 보증금은 월세의 11~15개월)` },
    ...interiorLines(g.interior * pyeong, `${pyeong}평, 평당 ${g.interior}만원 (${g.label}). ${ftcNote("cafe")}`),
    { key: "equip", label: "냉장·제빙·정수 기본 설비", amount: Math.round(g.kitchen * pyeong * 0.4), basis: `평당 ${g.kitchen}만원 (${g.label})의 40%. 머신·계산대·진열장은 고른 만큼 따로 (가정)` },
    { key: "item_equip", label: "머신·계산대·키오스크", amount: sum(["groups", "pos", "kiosks"]), basis: say(["groups", "pos", "kiosks"], NM) },
    { key: "item_deco", label: "진열장·오븐", amount: sum(["showcase", "oven"]), basis: say(["showcase", "oven"], NM) },
    { key: "seat", label: "테이블·의자·바 좌석", amount: sum(["tables", "chairs", "bar"]), basis: say(["tables", "chairs", "bar"], NM) },
    { key: "door", label: "출입문", amount: 150 * (doors ?? 1), basis: `${doors ?? 1}개 × 150만원 (유리문·문틀·도어클로저, 가정)` },
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
// 다른 업종처럼 구만 골라도 돌아가게: 동네를 안 골랐으면 그 구에서 카페 수가 가운데인 행정동을 대표로 쓴다
export function cafeDong(profile: Profile): { code: string; name: string; scope: "dong" | "gu" } | null {
  const p = profile.dong && profile.dong.gu === profile.gu ? profileOf(profile.gu, profile.dong.name) : undefined;
  if (p) return { code: String(p.code), name: p.name, scope: "dong" };
  const rows = profilesOf(profile.gu).map((d) => ({ d, r: cafeRowOf(String(d.code)) })).filter((x) => x.r && x.r.cafes > 0).sort((a, b) => a.r!.cafes - b.r!.cafes);
  const mid = rows[Math.floor(rows.length / 2)];
  return mid ? { code: String(mid.d.code), name: mid.d.name, scope: "gu" } : null;
}
export const cafeDistrictCode = (profile: Profile): string => cafeDong(profile)?.code ?? "3120012";
