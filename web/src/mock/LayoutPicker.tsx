// 가게 배치 고르기: 계산대(포스) 자리, 테이블 수와 바 자리(음식점), 행거 수와 방향(옷가게). 3D 화면이 바로 따라 바뀐다.
import { man } from "./model";
import { DOOR_LABEL, SHAPE_LABEL, shopPlan, type DoorSpot, type RoomShape, type ShopKind, type ShopLayout } from "./ShopRoom3D";

export default function LayoutPicker({ kind, pyeong, layout, set }: { kind: ShopKind; pyeong: number; layout: ShopLayout; set: (l: ShopLayout) => void }) {
  const plan = shopPlan(kind, pyeong, layout);
  const up = (p: Partial<ShopLayout>) => set({ ...layout, ...p });
  const food = kind !== "apparel";
  const nT = plan.tables.length, n4 = plan.tables4.length;
  return (
    <div className="m-layout" role="group" aria-label="가게 배치">
      <b className="m-layout-h">가게 배치 <small>파란 화살표가 손님 동선이에요</small></b>
      <div className="m-layout-row">
        <span id={`shape-${kind}`}>가게 모양</span>
        <div className="m-seg" role="group" aria-labelledby={`shape-${kind}`}>
          {(["wide", "square", "deep"] as RoomShape[]).map((x) => (
            <button type="button" key={x} aria-pressed={(layout.shape ?? "wide") === x} onClick={() => up({ shape: x })}>{SHAPE_LABEL[x]}</button>
          ))}
        </div>
      </div>
      <div className="m-layout-row">
        <span id={`door-${kind}`}>출입문</span>
        <div className="m-seg" role="group" aria-labelledby={`door-${kind}`}>
          {(["left", "center", "right"] as DoorSpot[]).map((x) => (
            <button type="button" key={x} aria-pressed={(layout.door ?? "right") === x} onClick={() => up({ door: x })}>{DOOR_LABEL[x]}</button>
          ))}
        </div>
      </div>
      <div className="m-stepper">
            <span id={`doors-${kind}`}>출입문 수</span>
            <button type="button" aria-label="출입문 1개 빼기" disabled={(layout.doors ?? 1) <= 1} onClick={() => ((n: number) => up({ doors: n }))((layout.doors ?? 1) - 1)}>−</button>
            <output aria-labelledby={`doors-${kind}`}>{(layout.doors ?? 1)}개 · {man(150 * (layout.doors ?? 1))}</output>
            <button type="button" aria-label="출입문 1개 더 달기" disabled={(layout.doors ?? 1) >= 3} onClick={() => ((n: number) => up({ doors: n }))((layout.doors ?? 1) + 1)}>+</button>
          </div>
      {food && <small>{`앉는 자리 ${plan.seats.length}석 (4인 ${n4 * 4}석 + 2인 ${nT * 2}석${plan.stools.length ? ` + 바 ${plan.stools.length}석` : ""}).`} 물건은 아래 쟁반에서 골라 넣어요.</small>}
    </div>
  );
}
