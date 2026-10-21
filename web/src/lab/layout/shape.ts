// lab:layout — the room's shape: 가로:세로 비율, 출입문 (벽 + 벽을 따라 위치), 창문이 있는 벽.
// Scene frame (both stores): room centred on the origin, x left→right, z back(−)→front(+, street side), metres.
// Door position `pos` is 0..1 along the wall between two corner margins: front/back walls from the left corner,
// left/right walls from the front corner. The cafe engine (sim/cafe/layout.py door_frame) uses the same rule.

export type Wall = "front" | "back" | "left" | "right";
export const WALLS: Wall[] = ["front", "back", "left", "right"];
export const WALL_KO: Record<Wall, string> = { front: "앞", back: "뒤", left: "왼쪽", right: "오른쪽" };
export const WALL_SIDE: Record<Wall, string> = { front: "앞쪽", back: "뒤쪽", left: "왼쪽", right: "오른쪽" };
export type RoomShape = { ratio: number; door: { wall: Wall; pos: number }; windows: Wall[] }; // ratio = 가로 ÷ 세로

// Defaults reproduce the rooms the app drew before this lane: 고깃집 1.45 (model.roomSize), 카페 1.6 (research/cafe
// params layout.aspect), door at the right end of the glass front.
export const BBQ_SHAPE: RoomShape = { ratio: 1.45, door: { wall: "front", pos: 1 }, windows: ["front"] };
export const CAFE_SHAPE: RoomShape = { ratio: 1.6, door: { wall: "front", pos: 1 }, windows: ["front"] };
export const DOOR_W = 1.0;            // 문 폭 (가정)
export const BBQ_DOOR_MARGIN = 1.2;   // 고깃집 문 중심과 모서리 사이 최소 거리: 예전 문 자리(오른쪽 벽에서 1.2m)가 pos=1
export const CAFE_DOOR_MARGIN = 0.75; // 카페: 엔진 entry_w(1.5m)의 절반

// 1:2.5 (세로로 김) … 2.5:1 (가로로 김), plus the store's default
const BASE_RATIOS = [1 / 2.5, 1 / 2, 1 / 1.5, 1 / 1.25, 1, 1.25, 1.5, 2, 2.5];
export function ratioSteps(def: number): number[] {
  const out = [...BASE_RATIOS];
  if (!out.some((r) => Math.abs(r - def) < 0.02)) out.push(def);
  return out.sort((a, b) => a - b);
}
const trim = (v: number) => String(Math.round(v * 100) / 100).replace(/\.0+$/, "");
export const ratioLabel = (r: number) => (r >= 1 - 1e-9 ? `${trim(r)} : 1` : `1 : ${trim(1 / r)}`);
export const ratioWord = (r: number) => (r > 1.05 ? "가로로 긴 가게" : r < 0.95 ? "세로로 긴 가게" : "정사각형에 가까운 가게");

// wall length and where the door centre sits on it (metres from the wall's start corner)
export const wallLen = (wall: Wall, w: number, d: number) => (wall === "front" || wall === "back" ? w : d);
export function doorAlong(shape: RoomShape, w: number, d: number, margin: number): number {
  const len = wallLen(shape.door.wall, w, d);
  const m = Math.min(margin, len / 2);
  return m + Math.min(1, Math.max(0, shape.door.pos)) * (len - 2 * m);
}
// a position along a wall -> scene point on the wall line, and the inward normal
export function wallPoint(wall: Wall, along: number, w: number, d: number): { x: number; z: number; nx: number; nz: number } {
  if (wall === "front") return { x: -w / 2 + along, z: d / 2, nx: 0, nz: -1 };
  if (wall === "back") return { x: -w / 2 + along, z: -d / 2, nx: 0, nz: 1 };
  if (wall === "left") return { x: -w / 2, z: d / 2 - along, nx: 1, nz: 0 };
  return { x: w / 2, z: d / 2 - along, nx: -1, nz: 0 };
}
export function doorPoint(shape: RoomShape, w: number, d: number, margin: number) {
  return wallPoint(shape.door.wall, doorAlong(shape, w, d, margin), w, d);
}
// move the door by `metres` along its wall, kept inside the margins
export function nudgeDoor(shape: RoomShape, metres: number, w: number, d: number, margin: number): RoomShape {
  const len = wallLen(shape.door.wall, w, d), span = Math.max(1e-6, len - 2 * Math.min(margin, len / 2));
  const pos = Math.min(1, Math.max(0, shape.door.pos + metres / span));
  return { ...shape, door: { ...shape.door, pos: Math.round(pos * 1000) / 1000 } };
}
export const doorWhere = (shape: RoomShape, w: number, d: number, margin: number) => {
  const a = doorAlong(shape, w, d, margin);
  const from = shape.door.wall === "front" || shape.door.wall === "back" ? "왼쪽 모서리" : "앞쪽 모서리";
  return `${from}에서 ${a.toFixed(1)}m`;
};

// windows along a wall (not the front, which is a glass storefront when it has a window): 1.4 m panes, sill 0.9 m,
// head 2.1 m, spaced evenly, skipping any that would cut into the door gap
export const WIN = { w: 1.4, sill: 0.9, head: 2.1 };
export function windowSpans(len: number, door: [number, number] | null): [number, number][] {
  const n = Math.max(1, Math.floor((len - 0.8) / 2.6));
  const step = len / n;
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const c = step * (i + 0.5), a = c - WIN.w / 2, b = c + WIN.w / 2;
    if (a < 0.35 || b > len - 0.35) continue;
    if (door && b > door[0] - 0.25 && a < door[1] + 0.25) continue;
    out.push([a, b]);
  }
  return out;
}
