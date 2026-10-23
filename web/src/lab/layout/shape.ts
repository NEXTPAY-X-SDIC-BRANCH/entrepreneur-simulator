// lab:layout — the room's shape: 가로:세로 비율, 출입문 (벽 + 벽을 따라 위치), 창문이 있는 벽.
// Scene frame (both stores): room centred on the origin, x left→right, z back(−)→front(+, street side), metres.
// Door position `pos` is 0..1 along the wall between two corner margins: front/back walls from the left corner,
// left/right walls from the front corner. The cafe engine (sim/cafe/layout.py door_frame) uses the same rule.

export type Wall = "front" | "back" | "left" | "right";
export const WALLS: Wall[] = ["front", "back", "left", "right"];
export const WALL_KO: Record<Wall, string> = { front: "앞", back: "뒤", left: "왼쪽", right: "오른쪽" };
export const WALL_SIDE: Record<Wall, string> = { front: "앞쪽", back: "뒤쪽", left: "왼쪽", right: "오른쪽" };
// doors: 출입문 수 1~3 (lab:merge 수빈 10/23의 출입문 개수). 더 단 문은 첫 문과 같은 벽에 선다 (doorAlongs)
export type RoomShape = { ratio: number; door: { wall: Wall; pos: number }; windows: Wall[]; doors?: number }; // ratio = 가로 ÷ 세로
export const doorCount = (s: RoomShape) => Math.min(3, Math.max(1, Math.round(s.doors ?? 1)));
export const DOOR_PRICE_MAN = 150; // 문 하나: 유리문·문틀·도어클로저 (수빈 model.ts DOOR_PRICE, 가정)

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
// 문 중심들(벽 시작 모서리에서 m): 첫 문, 그다음 더 단 문. 수빈 규칙처럼 첫 문에서 먼 쪽 끝부터, 그다음 가운데.
// 문끼리 0.6m는 띄우고, ok(그 자리를 비울 수 있나)가 아니라고 하면 그 후보는 건너뛴다. 자리가 없으면 덜 단다
export function doorAlongs(shape: RoomShape, w: number, d: number, margin: number, dw = DOOR_W, ok: (along: number) => boolean = () => true): number[] {
  const len = wallLen(shape.door.wall, w, d), m = Math.min(margin, len / 2), main = doorAlong(shape, w, d, margin);
  const out = [main];
  const pref = [m, len - m, len / 2].sort((a, b) => Math.abs(b - main) - Math.abs(a - main));
  // 정한 자리가 막혔으면 벽을 따라 0.25m씩 훑어 첫 문에서 먼 빈자리를 찾는다 (카페는 엔진 배치가 문 앞을 막을 수 있다)
  const sweep = Array.from({ length: Math.max(0, Math.floor((len - 2 * m) / 0.25)) + 1 }, (_, i) => m + i * 0.25).sort((a, b) => Math.abs(b - main) - Math.abs(a - main));
  const cands = [...pref, ...sweep];
  for (const c of cands) {
    if (out.length >= doorCount(shape)) break;
    if (out.every((o) => Math.abs(o - c) >= dw + 0.6) && ok(c)) out.push(c);
  }
  return out;
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
export function windowSpans(len: number, door: [number, number] | [number, number][] | null): [number, number][] {
  const doors: [number, number][] = !door ? [] : typeof door[0] === "number" ? [door as [number, number]] : (door as [number, number][]);
  const n = Math.max(1, Math.floor((len - 0.8) / 2.6));
  const step = len / n;
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const c = step * (i + 0.5), a = c - WIN.w / 2, b = c + WIN.w / 2;
    if (a < 0.35 || b > len - 0.35) continue;
    if (doors.some((g) => b > g[0] - 0.25 && a < g[1] + 0.25)) continue;
    out.push([a, b]);
  }
  return out;
}
