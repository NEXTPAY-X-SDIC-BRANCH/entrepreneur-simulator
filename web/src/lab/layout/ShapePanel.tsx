// lab:layout — the 문·창문 tab of the builder tray (option C in cu-layout-options): three compact cards that fit the
// tray's catalog column without scrolling — 가로:세로, 출입문 (wall + position along it), 창문 + 손님 동선 toggle.
// Also the 동선 card laid over the 3D stage (length, the congestion lines) and the stop numbering legend.
import { setView } from "../../mock/Scene3D";
import { IN_COLOR, OUT_COLOR } from "./Arrows3D";
import { DOOR_PRICE_MAN, WALLS, WALL_KO, WALL_SIDE, doorCount, doorWhere, nudgeDoor, ratioLabel, ratioSteps, ratioWord, type RoomShape, type Wall } from "./shape";
import "./layout.css";

export type FlowHint = { level: "ok" | "warn" | "weak"; text: string };
export type FlowSummary = { inLen: number; outLen: number; inLabel: string; outLabel: string; hints: FlowHint[]; note?: string };

export function ShapePanel({ shape, onShape, pyeong, w, d, margin, defRatio, ratioAllowed, flowOn, setFlowOn }: {
  shape: RoomShape; onShape: (s: RoomShape, what: string) => void; pyeong: number; w: number; d: number; margin: number; defRatio: number;
  ratioAllowed: (r: number) => boolean; flowOn: boolean; setFlowOn: (v: boolean) => void;
}) {
  const steps = ratioSteps(defRatio);
  const i = steps.findIndex((r) => Math.abs(r - shape.ratio) < 0.02);
  const prev = steps.slice(0, Math.max(0, i)).reverse().find(ratioAllowed);
  const next = steps.slice(i + 1).find(ratioAllowed);
  const setWall = (wall: Wall) => onShape({ ...shape, door: { wall, pos: shape.door.wall === wall ? shape.door.pos : 0.5 } }, `출입문을 ${WALL_SIDE[wall]} 벽으로 옮겼어요.`);
  const toggleWin = (wall: Wall) => {
    const on = shape.windows.includes(wall);
    onShape({ ...shape, windows: on ? shape.windows.filter((x) => x !== wall) : [...shape.windows, wall] }, on ? `${WALL_SIDE[wall]} 창문을 막았어요.` : `${WALL_SIDE[wall]} 벽에 창문을 냈어요.`);
  };
  const moveDoor = (m: number) => onShape(nudgeDoor(shape, m, w, d, margin), "출입문 위치를 옮겼어요.");
  return (
    <div className="ly-panel" role="tabpanel" aria-label="문·창문과 가게 모양">
      <section className="ly-card" aria-labelledby="ly-ratio">
        <h3 id="ly-ratio">가로 : 세로</h3>
        <small>{pyeong}평 {(pyeong * 3.3).toFixed(0)}㎡ · 가로 {w.toFixed(1)}m × 세로 {d.toFixed(1)}m</small>
        <div className="m-stepper">
          <button type="button" aria-label="세로로 더 길게" disabled={prev === undefined} onClick={() => prev !== undefined && onShape({ ...shape, ratio: prev }, `가게를 ${ratioLabel(prev)}로 바꿨어요.`)}>‹</button>
          <output aria-live="polite">{ratioLabel(shape.ratio)}</output>
          <button type="button" aria-label="가로로 더 길게" disabled={next === undefined} onClick={() => next !== undefined && onShape({ ...shape, ratio: next }, `가게를 ${ratioLabel(next)}로 바꿨어요.`)}>›</button>
        </div>
        <small>{ratioWord(shape.ratio)}, 평수는 그대로</small>
      </section>
      <section className="ly-card ly-door" aria-labelledby="ly-door">
        <h3 id="ly-door">출입문</h3>
        <div className="m-seg" role="group" aria-label="출입문이 있는 벽">
          {WALLS.map((wl) => <button type="button" key={wl} aria-pressed={shape.door.wall === wl} onClick={() => setWall(wl)}>{WALL_KO[wl]}</button>)}
        </div>
        <div className="m-stepper">
          <button type="button" aria-label="출입문을 0.5m 앞쪽 또는 왼쪽으로" disabled={shape.door.pos <= 0} onClick={() => moveDoor(-0.5)}>‹</button>
          <output>{doorWhere(shape, w, d, margin)}</output>
          <button type="button" aria-label="출입문을 0.5m 뒤쪽 또는 오른쪽으로" disabled={shape.door.pos >= 1} onClick={() => moveDoor(0.5)}>›</button>
        </div>
        {/* lab:merge 수빈 10/23 출입문 개수: 더 단 문은 같은 벽, 먼 쪽 끝부터 */}
        <div className="m-stepper ly-doors">
          <span id="ly-doors">문 개수</span>
          <button type="button" aria-label="출입문 1개 빼기" disabled={doorCount(shape) <= 1} onClick={() => onShape({ ...shape, doors: doorCount(shape) - 1 }, `출입문을 ${doorCount(shape) - 1}개로 줄였어요.`)}>−</button>
          <output aria-labelledby="ly-doors">{doorCount(shape)}개</output>
          <button type="button" aria-label="출입문 1개 더 달기" disabled={doorCount(shape) >= 3} onClick={() => onShape({ ...shape, doors: doorCount(shape) + 1 }, `같은 벽에 출입문을 하나 더 달았어요 (${DOOR_PRICE_MAN}만원).`)}>+</button>
        </div>
        <small>더 다는 문은 같은 벽에, 하나에 {DOOR_PRICE_MAN}만원 (가정)</small>
      </section>
      <section className="ly-card" aria-labelledby="ly-win">
        <h3 id="ly-win">창문</h3>
        <div className="ly-chips" role="group" aria-label="창문이 있는 벽">
          {WALLS.map((wl) => <button type="button" key={wl} aria-pressed={shape.windows.includes(wl)} onClick={() => toggleWin(wl)}>{wl === "front" ? "앞 유리" : WALL_KO[wl]}</button>)}
        </div>
        <button type="button" className="ly-flowbtn" aria-pressed={flowOn} onClick={() => { const v = !flowOn; setFlowOn(v); if (v) setView("top"); }}>
          {flowOn ? "손님 동선 숨기기" : "손님 동선 보기"}
        </button>
      </section>
    </div>
  );
}

const m1 = (v: number) => `${v.toFixed(1).replace(/\.0$/, "")}m`;
// the card over the stage while 동선 is on: length, in/out split, the most important hint (congestion first); the
// rest folds away so the card covers little of the floor
export function FlowCard({ f, onTop }: { f: FlowSummary; onTop: () => void }) {
  const [first, ...rest] = f.hints;
  return (
    <div className="ly-flowcard" role="status" aria-live="polite">
      <p className="ly-flow-h">
        <strong>손님 동선 {m1(f.inLen + f.outLen)}</strong>
        <span><i style={{ background: IN_COLOR }} />{f.inLabel} {m1(f.inLen)}</span>
        <span><i style={{ background: OUT_COLOR }} />{f.outLabel} {m1(f.outLen)}</span>
      </p>
      {first && <p className={`ly-hint is-${first.level}`}>{first.text}</p>}
      <details>
        <summary>{rest.length ? `안내 ${rest.length}개 더 보기` : "어떻게 쟀나요"}</summary>
        {rest.map((h) => <p key={h.text} className={`ly-hint is-${h.level}`}>{h.text}</p>)}
        {f.note && <small>{f.note}</small>}
        <button type="button" className="m-link" onClick={onTop}>위에서 보기</button>
      </details>
    </div>
  );
}
