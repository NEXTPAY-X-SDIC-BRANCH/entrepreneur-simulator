// lab:layout — 카페 손님 동선 from the engine's floor plan (/cafe/preview). Works in the engine's DOOR FRAME
// (sim/cafe/layout.py): x along the door wall, z into the room from it, the door at (room.door.x, 0). Route in:
// 입구 → 주문 (POS front) → 픽업 (end of the front counter) → 가장 먼 자리; route out: 자리 → 출구.
// Also how the real room relates to the door frame (rotation for the 3D group) and the shape the engine echoes back.
import { field, lenWhere, makeGrid, narrowLen, nearestWalk, polyLen, reachRect, simplify, trace, trimPath, AISLE_OK, type Pt, type Rect } from "./flow";
import { CAFE_SHAPE, type RoomShape, type Wall } from "./shape";

export type CafeRoom = {
  width_m: number; depth_m: number; door: { x: number; w: number; wall?: Wall; pos?: number | null };
  counter_zone?: { x: number; z: number; w: number; d: number };
  frame?: { wall: Wall; mirror: boolean; real_width_m: number; real_depth_m: number; windows?: Wall[] | null };
};
export type CafeItem = { id: string; type: string; x: number; z: number; rot_deg: number; fits: boolean; w: number; d: number; unassigned?: boolean };

// door frame (centred scene coords) -> real scene: rotate about y. front 0, back π, left −π/2, right π/2
export const FRAME_ROT: Record<Wall, number> = { front: 0, back: Math.PI, left: -Math.PI / 2, right: Math.PI / 2 };
export function realDims(room: CafeRoom): { w: number; d: number } {
  return room.frame ? { w: room.frame.real_width_m, d: room.frame.real_depth_m } : { w: room.width_m, d: room.depth_m };
}
// the shape the engine solved (the old engine without frame = the default room)
export function shapeFromRoom(room: CafeRoom, windows?: Wall[]): RoomShape {
  const { w, d } = realDims(room);
  const wall = room.frame?.wall ?? "front";
  const pos = room.door.pos ?? CAFE_SHAPE.door.pos;
  return { ratio: w / d, door: { wall, pos }, windows: windows ?? room.frame?.windows ?? CAFE_SHAPE.windows };
}
// rotate a centred door-frame point into the real scene
export function toReal(wall: Wall, x: number, z: number): [number, number] {
  const t = FRAME_ROT[wall], c = Math.cos(t), s = Math.sin(t);
  return [x * c + z * s, -x * s + z * c];
}

function footRect(it: CafeItem): Rect {
  const turned = Math.round(it.rot_deg) % 180 === 90;
  const w = (turned ? it.d : it.w) || 0.45, d = (turned ? it.w : it.d) || 0.45;
  return { x0: it.x - w / 2, z0: it.z - d / 2, x1: it.x + w / 2, z1: it.z + d / 2 };
}

export type CafeFlow = {
  inPath: Pt[]; outPath: Pt[]; inLen: number; outLen: number; total: number; tables: number; unreachable: number;
  stops: { label: string; x: number; z: number }[]; hints: { level: "ok" | "warn" | "weak"; text: string }[];
};
const m1 = (v: number) => `${v.toFixed(1).replace(/\.0$/, "")}m`;
const QUEUE_D = 1.2; // research/cafe/params.yaml layout.queue_d (가정)

// paths come back in door-frame engine coords (x, z)
export function cafeFlow(room: CafeRoom, layout: CafeItem[]): CafeFlow {
  const W = room.width_m, D = room.depth_m, cz = room.counter_zone;
  const fit = layout.filter((i) => i.fits && !i.unassigned);
  const obstacles = fit.map(footRect);
  if (cz) obstacles.push({ x0: cz.x, z0: cz.z, x1: cz.x + cz.w, z1: cz.z + cz.d });
  const g = makeGrid({ x0: 0, z0: 0, x1: W, z1: D }, obstacles);
  const start = nearestWalk(g, room.door.x, 0.35, 1.0);
  const fD = field(g, start);
  const tables = fit.filter((i) => i.type === "table");
  const reach = tables.map((t) => ({ t, c: reachRect(g, fD, footRect(t)) })).filter((r) => r.c >= 0);
  const out: CafeFlow = { inPath: [], outPath: [], inLen: 0, outLen: 0, total: 0, tables: tables.length, unreachable: tables.length - reach.length, stops: [{ label: "입구·출구", x: room.door.x, z: 0.2 }], hints: [] };
  const front = fit.filter((i) => ["pos", "espresso", "grinder", "showcase"].includes(i.type));
  const pos = fit.find((i) => i.type === "pos");
  const qz = cz ? cz.z - 0.45 : D / 2;
  const order: Pt | null = pos ? [pos.x, qz] : null;
  let pickup: Pt | null = null;
  if (front.length) {
    const lo = Math.min(...front.map((i) => i.x - i.w / 2)), hi = Math.max(...front.map((i) => i.x + i.w / 2));
    pickup = [room.frame?.mirror ? Math.min(W - 0.3, hi + 0.25) : Math.max(0.3, lo - 0.25), qz];
  }
  if (!reach.length || !order) {
    out.hints.push(tables.length ? { level: "weak", text: "문에서 갈 수 있는 테이블이 없어요." } : { level: "warn", text: "테이블을 놓으면 손님 동선이 보여요." });
    return out;
  }
  const far = reach.reduce((a, b) => (fD.dist[b.c] > fD.dist[a.c] ? b : a));
  const oc = nearestWalk(g, order[0], order[1], 0.8), pc = pickup ? nearestWalk(g, pickup[0], pickup[1], 0.8) : oc;
  if (oc < 0 || fD.dist[oc] === Infinity) { out.hints.push({ level: "weak", text: "문에서 계산대까지 길이 막혀 있어요." }); return out; }
  const legs: Pt[] = [...trace(g, fD, oc)];
  const fO = field(g, oc);
  if (pc >= 0 && pc !== oc) legs.push(...trace(g, fO, pc).slice(1));
  const fP = pc >= 0 ? field(g, pc) : fO;
  const toSeat = trace(g, fP, reachRect(g, fP, footRect(far.t)));
  legs.push(...toSeat.slice(1));
  out.inPath = simplify(legs);
  out.outPath = simplify(trace(g, fD, far.c).reverse());
  out.inLen = polyLen(out.inPath); out.outLen = polyLen(out.outPath); out.total = out.inLen + out.outLen;
  out.stops.push({ label: "주문", x: order[0], z: order[1] });
  if (pickup && pc !== oc) out.stops.push({ label: "픽업", x: pickup[0], z: pickup[1] });
  out.stops.push({ label: "가장 먼 자리", x: far.t.x, z: far.t.z });
  // congestion: leaving guests walking through the order queue in front of the counter, narrow aisles, cut-off tables
  const queue = cz ? { x0: cz.x, x1: cz.x + cz.w, z0: cz.z - QUEUE_D, z1: cz.z } : null;
  const inQ = (x: number, z: number) => !!queue && x >= queue.x0 && x <= queue.x1 && z >= queue.z0 && z <= queue.z1;
  const qLen = lenWhere(trimPath(out.outPath, 0.6, 0), inQ);
  const narrow = narrowLen(g, trimPath(out.inPath, 0.6, 0.6)) + narrowLen(g, trimPath(out.outPath, 0.6, 0.6));
  if (out.unreachable) out.hints.push({ level: "weak", text: `문에서 갈 수 없는 테이블이 ${out.unreachable}개 있어요.` });
  if (qLen > 0.5) out.hints.push({ level: "warn", text: `나가는 손님이 주문 줄 앞을 ${m1(qLen)} 가로질러요. 붐비는 시간에는 줄과 부딪혀요.` });
  if (narrow > 0.5) out.hints.push({ level: "warn", text: `통로 폭이 ${AISLE_OK * 100}cm보다 좁은 곳을 ${m1(narrow)} 지나가요. 권장 간격은 90~120cm예요.` });
  if (!out.hints.length) out.hints.push({ level: "ok", text: "문에서 주문, 픽업, 자리까지 막히는 곳 없이 이어져요." });
  return out;
}

// the engine request fields for a shape (absent = the old default room)
export const cafeShapeBody = (shape?: RoomShape) => (shape ? { aspect: Math.round(shape.ratio * 1000) / 1000, door_wall: shape.door.wall, door_pos: shape.door.pos, windows: shape.windows } : {});
export const CAFE_MIN_SIDE = 4.0;
export const cafeRatioOk = (pyeong: number, ratio: number) => { const a = pyeong * 3.3058, w = Math.sqrt(a * ratio); return w >= CAFE_MIN_SIDE && a / w >= CAFE_MIN_SIDE; };
