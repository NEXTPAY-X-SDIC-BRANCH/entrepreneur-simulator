// 가게 배치 고르기: 계산대(포스) 자리, 테이블 수와 바 자리(음식점), 행거 수와 방향(옷가게). 3D 화면이 바로 따라 바뀐다.
import { POS_LABEL, shopPlan, type PosSpot, type ShopKind, type ShopLayout } from "./ShopRoom3D";

export default function LayoutPicker({ kind, pyeong, layout, set }: { kind: ShopKind; pyeong: number; layout: ShopLayout; set: (l: ShopLayout) => void }) {
  const plan = shopPlan(kind, pyeong, layout);
  const up = (p: Partial<ShopLayout>) => set({ ...layout, ...p });
  const food = kind !== "apparel";
  const nT = plan.tables.length, nR = plan.racks.length;
  return (
    <div className="m-layout" role="group" aria-label="가게 배치">
      <b className="m-layout-h">가게 배치</b>
      <div className="m-layout-row">
        <span id={`pos-${kind}`}>계산대</span>
        <div className="m-seg" role="group" aria-labelledby={`pos-${kind}`}>
          {(["door", "window", "back"] as PosSpot[]).map((p) => (
            <button type="button" key={p} aria-pressed={(layout.pos ?? "door") === p} onClick={() => up({ pos: p })}>{POS_LABEL[p]}</button>
          ))}
        </div>
      </div>
      {food ? (
        <>
          <div className="m-stepper">
            <span id={`tb-${kind}`}>2인 테이블</span>
            <button type="button" aria-label="테이블 1개 빼기" disabled={nT <= 0} onClick={() => up({ tables: nT - 1 })}>−</button>
            <output aria-labelledby={`tb-${kind}`}>{nT}개</output>
            <button type="button" aria-label="테이블 1개 더 놓기" disabled={nT >= plan.maxTables} onClick={() => up({ tables: nT + 1 })}>+</button>
          </div>
          {kind === "bunsik" && (
            <div className="m-layout-row">
              <span id="bar-bunsik">벽 쪽 바 자리</span>
              <div className="m-seg" role="group" aria-labelledby="bar-bunsik">
                <button type="button" aria-pressed={layout.bar !== false} onClick={() => up({ bar: true })}>놓기</button>
                <button type="button" aria-pressed={layout.bar === false} onClick={() => up({ bar: false })}>빼기</button>
              </div>
            </div>
          )}
          <small>앉는 자리 {plan.seats.length}석 (테이블 {nT * 2}석{plan.stools.length ? ` + 바 ${plan.stools.length}석` : ""}). 이 평수에는 테이블을 {plan.maxTables}개까지 놓을 수 있어요.</small>
        </>
      ) : (
        <>
          <div className="m-layout-row">
            <span id="rd-apparel">행거 방향</span>
            <div className="m-seg" role="group" aria-labelledby="rd-apparel">
              <button type="button" aria-pressed={layout.rackDir !== "col"} onClick={() => up({ rackDir: "row", racks: undefined })}>가로 줄</button>
              <button type="button" aria-pressed={layout.rackDir === "col"} onClick={() => up({ rackDir: "col", racks: undefined })}>세로 줄</button>
            </div>
          </div>
          <div className="m-stepper">
            <span id="rk-apparel">행거</span>
            <button type="button" aria-label="행거 1개 빼기" disabled={nR <= 1} onClick={() => up({ racks: nR - 1 })}>−</button>
            <output aria-labelledby="rk-apparel">{nR}개</output>
            <button type="button" aria-label="행거 1개 더 놓기" disabled={nR >= plan.maxRacks} onClick={() => up({ racks: nR + 1 })}>+</button>
          </div>
          <small>행거 {nR}개에 옷을 걸고, 벽 선반과 함께 손님이 둘러볼 자리 {plan.spots.length}곳이 생겨요. 이 평수에는 {plan.maxRacks}개까지 놓을 수 있어요.</small>
        </>
      )}
    </div>
  );
}
