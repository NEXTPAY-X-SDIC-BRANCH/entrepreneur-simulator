// 치킨집·분식집·옷가게 가게 꾸미기의 물건 쟁반 (고깃집 Builder의 좌석·설비·꾸밈과 같은 틀).
// 물건은 개수로 정하고 3D 화면(ShopRoom3D)이 자리를 잡는다. 값은 한 개 값(만원)이고 여는 돈에서 빠진다.
// 테이블 값은 고깃집 카탈로그(불판·환기 포함 113·57만원)에서 불판·환기를 뺀 가정값. 나머지도 가정.
import type { CostLine } from "./model";
import { shopPlan, type ShopKind, type ShopLayout } from "./ShopRoom3D";

export type ItemCat = "seat" | "equip" | "deco";
export type ItemKey = "tables4" | "tables" | "bar" | "posN" | "range" | "kiosk" | "fryer" | "fridge" | "bench" | "plant" | "racks" | "fit" | "mirror" | "display" | "mannequin";
// need: 가게를 열려면 꼭 하나는 있어야 하는 물건. def: 빈 가게로 시작하지 않을 때(추천 배치·다른 화면의 어림값) 놓는 개수
export type ShopItem = { key: ItemKey; name: string; cat: ItemCat; price: number; note: string; min: number; max: number; def: number; need?: boolean };
export const ITEM_CATS: { key: ItemCat; label: string }[] = [{ key: "seat", label: "좌석" }, { key: "equip", label: "설비" }, { key: "deco", label: "꾸밈" }];
export const RETAIL_CATS: { key: ItemCat; label: string }[] = [{ key: "seat", label: "진열" }, { key: "equip", label: "설비" }, { key: "deco", label: "꾸밈" }];

const FOOD: ShopItem[] = [
  { key: "tables4", name: "4인 테이블", cat: "seat", price: 45, note: "의자 4개 포함", min: 0, max: 20, def: 0 },
  { key: "tables", name: "2인 테이블", cat: "seat", price: 25, note: "의자 2개 포함", min: 0, max: 30, def: 0 },
  { key: "posN", name: "계산대와 POS", cat: "equip", price: 150, note: "주문·결제 받는 곳", min: 0, max: 1, def: 1, need: true },
  { key: "kiosk", name: "키오스크", cat: "equip", price: 120, note: "주문 받는 일손을 덜어요", min: 0, max: 2, def: 0 },
  { key: "fridge", name: "음료 냉장고", cat: "equip", price: 150, note: "홀에 두는 음료·주류 냉장고", min: 0, max: 2, def: 1 },
  { key: "bench", name: "대기 의자", cat: "deco", price: 12, note: "포장 손님이 기다리는 자리", min: 0, max: 2, def: 1 },
  { key: "plant", name: "화분", cat: "deco", price: 8, note: "", min: 0, max: 4, def: 2 },
];
export const SHOP_ITEMS: Record<ShopKind, ShopItem[]> = {
  chicken: [
    ...FOOD.slice(0, 2),
    { key: "fryer", name: "튀김기", cat: "equip", price: 180, note: "많을수록 바쁜 시간에 한꺼번에 튀겨요", min: 0, max: 4, def: 2, need: true },
    ...FOOD.slice(2),
  ],
  bunsik: [
    ...FOOD.slice(0, 2),
    { key: "bar", name: "벽 쪽 바 자리", cat: "seat", price: 40, note: "혼자 온 손님 자리 (한 줄)", min: 0, max: 1, def: 1 },
    { key: "range", name: "떡볶이 판·어묵 통", cat: "equip", price: 120, note: "조리 자리 한 벌 (판·통·밥솥)", min: 0, max: 2, def: 1, need: true },
    ...FOOD.slice(2),
  ],
  apparel: [
    { key: "racks", name: "행거", cat: "seat", price: 25, note: "옷 거는 봉 (1.3m)", min: 0, max: 20, def: 0, need: true },
    { key: "display", name: "매대", cat: "seat", price: 35, note: "접어 둔 옷·잡화를 올려요", min: 0, max: 3, def: 1 },
    { key: "mannequin", name: "마네킹", cat: "seat", price: 20, note: "창가에 세워 지나가는 손님을 끌어요", min: 0, max: 3, def: 2 },
    { key: "posN", name: "계산대와 POS", cat: "equip", price: 150, note: "결제·포장하는 곳", min: 0, max: 1, def: 1, need: true },
    { key: "fit", name: "피팅룸", cat: "equip", price: 120, note: "커튼·거울·조명 포함", min: 0, max: 3, def: 1, need: true },
    { key: "mirror", name: "전신 거울", cat: "equip", price: 15, note: "", min: 0, max: 3, def: 1 },
    { key: "plant", name: "화분", cat: "deco", price: 8, note: "", min: 0, max: 4, def: 2 },
  ],
};

// 지금 놓인 개수. 테이블·행거는 비워 두면 3D 배치가 자리만큼 채우므로 배치 결과에서 센다
export function itemCount(kind: ShopKind, pyeong: number, lay: ShopLayout, key: ItemKey, plan = shopPlan(kind, pyeong, lay)): number {
  if (key === "tables") return plan.tables.length;
  if (key === "tables4") return plan.tables4.length;
  if (key === "racks") return plan.racks.length;
  if (key === "bar") return plan.bar ? 1 : 0;
  const it = SHOP_ITEMS[kind].find((x) => x.key === key);
  return (lay[key] as number | undefined) ?? (lay.blank ? 0 : it?.def ?? 0);
}
export function itemMax(kind: ShopKind, pyeong: number, lay: ShopLayout, it: ShopItem, plan = shopPlan(kind, pyeong, lay)): number {
  if (it.key === "tables") return plan.maxTables;
  if (it.key === "tables4") return plan.maxTables4;
  if (it.key === "racks") return plan.maxRacks;
  return it.max;
}
// 아직 놓지 않은 꼭 필요한 물건 이름
export function missingItems(kind: ShopKind, pyeong: number, lay: ShopLayout = {}): string[] {
  const plan = shopPlan(kind, pyeong, lay);
  return SHOP_ITEMS[kind].filter((it) => it.need && itemCount(kind, pyeong, lay, it.key, plan) < 1).map((it) => it.name);
}
// 개수를 바꾼 배치
export function withCount(lay: ShopLayout, key: ItemKey, n: number): ShopLayout {
  if (key === "bar") return { ...lay, bar: n > 0 };
  return { ...lay, [key]: n };
}

// 고른 물건 값 (여는 돈의 한 줄). 좌석·진열 / 설비 / 꾸밈 세 줄로 나눈다
export function itemLines(kind: ShopKind, pyeong: number, lay: ShopLayout = {}): CostLine[] {
  const plan = shopPlan(kind, pyeong, lay);
  const sum = (cat: ItemCat) => SHOP_ITEMS[kind].filter((x) => x.cat === cat);
  const label = { seat: kind === "apparel" ? "행거·매대·마네킹" : "테이블·의자", equip: kind === "apparel" ? "계산대·피팅룸·거울" : kind === "chicken" ? "계산대·튀김기·냉장고" : "계산대·조리 자리·냉장고", deco: "대기 의자·화분" } as const;
  return (["seat", "equip", "deco"] as ItemCat[]).map((cat) => {
    const xs = sum(cat).map((it) => [it, itemCount(kind, pyeong, lay, it.key, plan)] as const).filter(([, n]) => n > 0);
    return {
      key: `item_${cat}`, label: kind === "apparel" && cat === "deco" ? "화분" : label[cat],
      amount: xs.reduce((a, [it, n]) => a + it.price * n, 0),
      basis: xs.map(([it, n]) => `${it.name} ${n}개 × ${it.price}만원`).join(", ") + " (가정)",
    };
  }).filter((l) => l.amount > 0);
}

// 인테리어 공사를 공정별로 나눈 줄 (합은 원래 인테리어 공사비와 같다). 나누는 비율은 소규모 상가 인테리어 견적의 흔한 구성 (가정)
const INTERIOR_SPLIT: [string, string, number][] = [
  ["interior_demo", "철거·설비 기초", 0.1],
  ["interior_elec", "전기·조명", 0.2],
  ["interior_floor", "바닥", 0.18],
  ["interior_wall", "벽·도배·도장", 0.2],
  ["interior_ceil", "천장", 0.1],
  ["interior", "목공·마감·창호", 0.22],
];
export function interiorLines(total: number, basis: string): CostLine[] {
  let left = total;
  return INTERIOR_SPLIT.map(([key, label, r], i) => {
    const amount = i === INTERIOR_SPLIT.length - 1 ? left : Math.round(total * r);
    left -= amount;
    return { key, label, amount, basis: i === INTERIOR_SPLIT.length - 1 ? `${basis}. 공정별 나눔(철거 10·전기 20·바닥 18·벽 20·천장 10·목공 22%)은 가정` : `인테리어 공사의 ${Math.round(r * 100)}% (가정)` };
  });
}
export const isDepLine = (key: string) => key.startsWith("interior") || key.startsWith("item_") || ["equip", "kitchen", "seat", "deco", "sign"].includes(key);
