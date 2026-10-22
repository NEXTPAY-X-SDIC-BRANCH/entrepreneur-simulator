// 가게 꾸미기 물건 쟁반 (치킨집·분식집·옷가게). 고깃집 Builder의 좌석·설비·꾸밈 탭과 같은 모양이고, 카드마다 값과 개수 −/+.
// 개수를 바꾸면 3D(ShopRoom3D)가 자리를 다시 잡고, 여는 돈(itemLines)에서 그만큼 빠진다.
import { useState } from "react";
import { man } from "./model";
import { ITEM_CATS, RETAIL_CATS, SHOP_ITEMS, itemCount, itemMax, withCount, type ItemCat } from "./shopItems";
import { shopPlan, type ShopKind, type ShopLayout } from "./ShopRoom3D";

// 평면 기호 (고깃집 쟁반의 Stamp처럼 위에서 본 모양). 카페 쟁반(CafeBuild)도 같이 쓴다
export function ItemIcon({ k: k0 }: { k: string }) {
  const k = ({ chairs: "chair", groups: "machine", pos: "posN", kiosks: "kiosk", oven: "oven", showcase: "showcase" } as Record<string, string>)[k0] ?? k0;
  return (
    <svg viewBox="-40 -26 80 52" aria-hidden="true">
      {k === "tables4" ? <><rect x={-14} y={-18} width={28} height={36} rx="1.5" />{[[-7, -14], [7, -14], [-7, 14], [7, 14]].map(([x, y], i) => <circle key={i} cx={x} cy={y} r="3" className="seat" />)}</>
        : k === "tables" ? <><rect x={-16} y={-9} width={32} height={18} rx="1.5" /><circle cx={-10} cy={0} r="3" className="seat" /><circle cx={10} cy={0} r="3" className="seat" /></>
        : k === "bar" ? <><rect x={-28} y={-4} width={56} height={8} rx="1.5" />{[-18, -6, 6, 18].map((x) => <circle key={x} cx={x} cy={10} r="3" className="seat" />)}</>
        : k === "racks" ? <><line x1={-24} y1={0} x2={24} y2={0} strokeWidth="3" />{[-16, -8, 0, 8, 16].map((x) => <rect key={x} x={x - 3} y={-10} width={6} height={20} rx="1" />)}</>
        : k === "fit" ? <><rect x={-16} y={-16} width={32} height={32} rx="1.5" /><path d="M-16 16 Q -8 10 0 16 Q 8 10 16 16" fill="none" /></>
        : k === "mirror" ? <rect x={-6} y={-18} width={12} height={36} rx="2" />
        : k === "display" ? <><rect x={-22} y={-12} width={44} height={24} rx="1.5" />{[-12, 0, 12].map((x) => <rect key={x} x={x - 4} y={-5} width={8} height={10} />)}</>
        : k === "mannequin" ? <><circle cx={0} cy={-12} r="5" /><rect x={-7} y={-6} width={14} height={20} rx="4" /></>
        : k === "plant" ? <><circle r="12" /><circle r="5" className="seat" /></>
        : k === "bench" ? <rect x={-22} y={-6} width={44} height={12} rx="2" />
        : k === "fryer" ? <><rect x={-12} y={-14} width={24} height={28} rx="1.5" /><rect x={-7} y={-9} width={14} height={18} className="seat" /></>
        : k === "chair" ? <><rect x={-9} y={-9} width={18} height={18} rx="3" /><line x1={-9} y1={-12} x2={9} y2={-12} /></>
        : k === "machine" ? <><rect x={-20} y={-12} width={40} height={24} rx="2" />{[-10, 0, 10].map((x) => <circle key={x} cx={x} cy={4} r="3" className="seat" />)}</>
        : k === "posN" ? <><rect x={-22} y={-8} width={44} height={16} rx="1.5" /><rect x={-6} y={-5} width={12} height={10} className="seat" /></>
        : k === "showcase" ? <><rect x={-22} y={-10} width={44} height={20} rx="1.5" /><line x1={-22} y1={0} x2={22} y2={0} /></>
        : k === "oven" ? <><rect x={-14} y={-14} width={28} height={28} rx="2" /><rect x={-9} y={-6} width={18} height={12} className="seat" /></>
        : k === "kiosk" ? <><rect x={-8} y={-14} width={16} height={28} rx="2" /><rect x={-5} y={-10} width={10} height={12} className="seat" /></>
        : <><rect x={-12} y={-16} width={24} height={32} rx="1.5" /><line x1={-12} y1={0} x2={12} y2={0} /></>}
    </svg>
  );
}

export default function ItemTray({ kind, pyeong, layout, set }: { kind: ShopKind; pyeong: number; layout: ShopLayout; set: (l: ShopLayout) => void }) {
  const cats = kind === "apparel" ? RETAIL_CATS : ITEM_CATS;
  const [cat, setCat] = useState<ItemCat>("seat");
  const plan = shopPlan(kind, pyeong, layout);
  const items = SHOP_ITEMS[kind].filter((x) => x.cat === cat);
  return (
    <>
      <div className="m-cats" role="tablist" aria-label="물건 종류">
        {cats.map((c) => <button type="button" role="tab" key={c.key} aria-selected={cat === c.key} onClick={() => setCat(c.key)}>{c.label}</button>)}
      </div>
      <ul className="m-catalog">
        {items.map((it) => {
          const v = itemCount(kind, pyeong, layout, it.key, plan), mx = itemMax(kind, pyeong, layout, it, plan);
          return (
            <li key={it.key}>
              <div className="cs-card it-card">
                <ItemIcon k={it.key} />
                <span>{it.name}</span>
                <small>{man(it.price)}{it.key === "bar" ? "" : "/개"}{it.note ? `, ${it.note}` : ""}</small>
                <div className="m-stepper">
                  <button type="button" aria-label={`${it.name} 빼기`} disabled={v <= it.min} onClick={() => set(withCount(layout, it.key, v - 1))}>−</button>
                  <output>{it.key === "bar" ? (v ? "놓기" : "빼기") : `${v}개`}</output>
                  <button type="button" aria-label={`${it.name} 더 놓기`} disabled={v >= mx} onClick={() => set(withCount(layout, it.key, v + 1))}>+</button>
                </div>
                {v >= mx && mx > 0 && it.max > mx && <small className="it-full">이 평수에 놓을 자리는 여기까지예요</small>}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
