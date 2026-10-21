// lab:layout — the 문·창문 tab of the builder tray (option C in cu-layout-options): three compact cards that fit the
// tray's catalog column without scrolling — 가로:세로, 출입문 (wall + position along it), 창문 + 손님 동선 toggle.
// Also the 동선 card laid over the 3D stage (length, the congestion lines) and the stop numbering legend.
import { setView } from "../../mock/Scene3D";
import { IN_COLOR, OUT_COLOR } from "./Arrows3D";
import { WALLS, WALL_KO, WALL_SIDE, doorWhere, nudgeDoor, ratioLabel, ratioSteps, ratioWord, type RoomShape, type Wall } from "./shape";
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
// the card over the stage while 동선 is on: length, in/out split, every hint (the congestion line first)
export function FlowCard({ f, onTop }: { f: FlowSummary; onTop: () => void }) {
  return (
    <div className="ly-flowcard" role="status" aria-live="polite">
      <p className="ly-flow-h">
        <strong>손님 동선 {m1(f.inLen + f.outLen)}</strong>
        <span><i style={{ background: IN_COLOR }} />{f.inLabel} {m1(f.inLen)}</span>
        <span><i style={{ background: OUT_COLOR }} />{f.outLabel} {m1(f.outLen)}</span>
        <button type="button" className="m-link" onClick={onTop}>위에서 보기</button>
      </p>
      <ul>{f.hints.map((h) => <li key={h.text} className={`is-${h.level}`}>{h.text}</li>)}</ul>
      {f.note && <small>{f.note}</small>}
    </div>
  );
}
