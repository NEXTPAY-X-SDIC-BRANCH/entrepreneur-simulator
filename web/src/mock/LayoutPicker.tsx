// 가게 배치 고르기: 계산대(포스) 자리, 테이블 수와 바 자리(음식점), 행거 수와 방향(옷가게). 3D 화면이 바로 따라 바뀐다.
import { DOOR_LABEL, POS_LABEL, SHAPE_LABEL, shopPlan, type DoorSpot, type PosSpot, type RoomShape, type ShopKind, type ShopLayout } from "./ShopRoom3D";

export default function LayoutPicker({ kind, pyeong, layout, set }: { kind: ShopKind; pyeong: number; layout: ShopLayout; set: (l: ShopLayout) => void }) {
  const plan = shopPlan(kind, pyeong, layout);
  const up = (p: Partial<ShopLayout>) => set({ ...layout, ...p });
  const food = kind !== "apparel";
  const nT = plan.tables.length, n4 = plan.tables4.length, nR = plan.racks.length;
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
      <div className="m-layout-row">
        <span id={`pos-${kind}`}>계산대</span>
        <div className="m-seg" role="group" aria-labelledby={`pos-${kind}`}>
          {(["door", "window", "back"] as PosSpot[]).map((p) => (
            <button type="button" key={p} aria-pressed={(layout.pos ?? "door") === p} onClick={() => up({ pos: p })}>{POS_LABEL[p]}</button>
          ))}
        </div>
      </div>
      {!food && (
        <div className="m-layout-row">
          <span id="rd-apparel">행거 방향</span>
          <div className="m-seg" role="group" aria-labelledby="rd-apparel">
            <button type="button" aria-pressed={layout.rackDir !== "col"} onClick={() => up({ rackDir: "row" })}>가로 줄</button>
            <button type="button" aria-pressed={layout.rackDir === "col"} onClick={() => up({ rackDir: "col" })}>세로 줄</button>
          </div>
        </div>
      )}
      <small>{food ? `앉는 자리 ${plan.seats.length}석 (4인 ${n4 * 4}석 + 2인 ${nT * 2}석${plan.stools.length ? ` + 바 ${plan.stools.length}석` : ""}).` : `행거 ${nR}개, 손님이 둘러볼 자리 ${plan.spots.length}곳.`} 물건은 아래 쟁반에서 골라 넣어요.</small>
    </div>
  );
}
