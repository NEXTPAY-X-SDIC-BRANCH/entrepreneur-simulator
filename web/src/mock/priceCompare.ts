// 내 가격이 비교 기준보다 높은 편 / 비슷 / 낮은 편인지. 동네 단위 메뉴 가격 자료가 없어 서울·전국 조사값과 비교한다.
//   고깃집: 참가격 외식비 서울 삼겹살 200g ₩21,321 (2026-06, S23). 평균 한 점뿐이라 ±5% 안을 '비슷'으로 본다 (가정).
//   카페: 외식업체 경영실태조사 2025 원자료 대표메뉴 '커피' 가격 25%·50%·75% = 3,500·4,000·5,000원 (cafe_cost.json reg_price_menu_0).
//         25%보다 싸면 낮은 편, 75%보다 비싸면 높은 편.
export type PriceBand = { band: "낮은 편" | "비슷" | "높은 편"; tone: "pos" | "" | "neg"; text: string };

export const BBQ_REF = { price: 21321, grams: 200, src: "참가격 서울 삼겹살 외식비 (2026년 6월)" };
export const CAFE_REF = { low: 3500, mid: 4000, high: 5000, src: "외식업체 경영실태조사 2025 커피 대표메뉴 가격" };
const fmt = (n: number) => Math.round(n).toLocaleString("ko-KR");

export function bbqBand(price: number): PriceBand {
  const r = price / BBQ_REF.price - 1, pct = Math.round(r * 100);
  const band = r < -0.05 ? "낮은 편" : r > 0.05 ? "높은 편" : "비슷";
  return { band, tone: band === "낮은 편" ? "pos" : band === "높은 편" ? "neg" : "",
    text: `1인분(200g) ${fmt(price)}원은 서울 평균 ${fmt(BBQ_REF.price)}원보다 ${band === "비슷" ? `비슷해요 (${pct >= 0 ? "+" : ""}${pct}%)` : `${band === "낮은 편" ? "싼" : "비싼"} 편이에요 (${pct > 0 ? "+" : ""}${pct}%)`}` };
}

export function cafeBand(price: number): PriceBand {
  const band = price < CAFE_REF.low ? "낮은 편" : price > CAFE_REF.high ? "높은 편" : "비슷";
  return { band, tone: band === "낮은 편" ? "pos" : band === "높은 편" ? "neg" : "",
    text: `커피 한 잔 ${fmt(price)}원은 ${band === "비슷" ? `조사한 카페 절반이 받는 ${fmt(CAFE_REF.low)}~${fmt(CAFE_REF.high)}원 안이에요` : band === "낮은 편" ? `카페 4곳 중 3곳보다 싸요 (25% 값 ${fmt(CAFE_REF.low)}원)` : `카페 4곳 중 3곳보다 비싸요 (75% 값 ${fmt(CAFE_REF.high)}원)`}` };
}
