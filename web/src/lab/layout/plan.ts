// lab:layout — 고깃집 floor plan with a room shape: room size from 평수 and 가로:세로, the door's clearance, where the
// walled kitchen goes (the corner away from the door, back corners first), automatic re-layout when the door or the
// ratio changes, and the customer route (입구 → 자리 → 계산 → 출구) with its length and congestion hints.
// The Store type stays model.ts's; the shape rides along as an extra `shape` field (absent = the old room).
// Tables and seats stay plain items, so storeStats → engine inputs (tables, seats) pick up every change.
import { ITEM, footprint, snap, storeStats, type Placed, type Store } from "../../mock/model";
import { AISLE_OK, field, lenWhere, makeGrid, narrowLen, nearestWalk, overlaps, polyLen, reachRect, rectOf, simplify, trace, trimPath, type Field, type Grid, type Pt, type Rect } from "./flow";
import { BBQ_DOOR_MARGIN, BBQ_SHAPE, DOOR_W, WALL_KO, doorPoint, type RoomShape } from "./shape";

// want: the table counts asked for before a re-layout dropped some (a4/a2 = what that re-layout placed). While the
// store still has exactly a4/a2 tables, the next re-layout asks for n4/n2 again, so stepping the ratio or the door
// through a tight shape and back does not lose tables for good. Any manual change of the tables ends it.
export type LabStore = Store & { shape?: RoomShape; want?: { n4: number; n2: number; a4: number; a2: number } };
export const shapeOf = (s: Store): RoomShape => (s as LabStore).shape ?? BBQ_SHAPE;
export const withShape = (s: Store, shape: RoomShape): Store => ({ ...s, shape }) as LabStore;

// model.roomSize generalised: same 0.5 m rounding, ratio 1.45 gives the old room exactly
const GRID = 0.5;
export function bbqDims(pyeong: number, ratio: number): { w: number; d: number } {
  const area = pyeong * 3.3;
  const w = Math.round(Math.sqrt(area * ratio) / GRID) * GRID;
  return { w, d: Math.round(area / w / GRID) * GRID };
}
export const roomDims = (s: Store) => bbqDims(s.pyeong, shapeOf(s).ratio);
// the walled kitchen is 4 m × 2.5 m: a side under 5 m leaves no room for a table row beside or in front of it
export const MIN_SIDE = 5;
export const ratioOk = (pyeong: number, ratio: number) => { const { w, d } = bbqDims(pyeong, ratio); return w >= MIN_SIDE && d >= MIN_SIDE; };

// ---- door ----------------------------------------------------------------------------------------------------
export function doorInfo(s: Store) {
  const { w, d } = roomDims(s);
  const p = doorPoint(shapeOf(s), w, d, BBQ_DOOR_MARGIN);
  const side = p.nx === 0; // door on the front or back wall: the gap runs along x
  const half = DOOR_W / 2 + 0.2, deep = 1.2; // 문 앞 비워 둘 곳: 문 폭 + 양옆 20cm, 안쪽 1.2m (가정)
  const a: Pt = [p.x - (side ? half : 0), p.z - (side ? 0 : half)], b: Pt = [p.x + (side ? half : 0) + p.nx * deep, p.z + (side ? 0 : half) + p.nz * deep];
  const zone: Rect = { x0: Math.min(a[0], b[0]), z0: Math.min(a[1], b[1]), x1: Math.max(a[0], b[0]), z1: Math.max(a[1], b[1]) };
  return { ...p, w, d, zone, step: [p.x + p.nx * 0.35, p.z + p.nz * 0.35] as Pt };
}

// ---- kitchen ---------------------------------------------------------------------------------------------------
const KW = ITEM.kitchen.w, KD = ITEM.kitchen.d;
// the kitchen piece faces +z with its doorway on +x; flipped so the pass faces the room and the doorway the middle
export const kitchenFlip = (k: { x: number; z: number }): [number, number] => [k.x > 1e-6 ? -1 : 1, k.z > 1e-6 ? -1 : 1];
export function kitchenSpotFor(s: Store): { x: number; z: number } {
  const { w, d } = roomDims(s), door = doorInfo(s);
  const zone = { x0: door.zone.x0 - 0.3, z0: door.zone.z0 - 0.3, x1: door.zone.x1 + 0.3, z1: door.zone.z1 + 0.3 };
  const cands = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz]) => ({ x: sx * (w / 2 - KW / 2), z: sz * (d / 2 - KD / 2) }));
  const ok = cands.filter((c) => !overlaps(rectOf(c.x, c.z, KW, KD), zone));
  const score = (c: { x: number; z: number }) => (c.z > 0 ? 100 : 0) - Math.hypot(c.x - door.x, c.z - door.z);
  return (ok.length ? ok : cands).sort((a, b) => score(a) - score(b))[0];
}
export function kitchenZones(k: { x: number; z: number }) {
  const [sx, sz] = kitchenFlip(k);
  const face = k.z + (sz * KD) / 2;
  return {
    pass: { x0: k.x - KW / 2, x1: k.x + KW / 2, z0: Math.min(face, face + sz * 1.0), z1: Math.max(face, face + sz * 1.0) } as Rect, // 배식구 앞 1m
    doorway: rectOf(k.x + sx * (KW / 2 + 0.4), k.z + sz * 0.7, 0.8, 0.9),                                                    // 주방 출입구 옆
    pos: [k.x + sx * 1.45, k.z + sz * (KD / 2 + 0.45)] as Pt,                                                                 // 배식구 오른쪽 끝 POS 앞
  };
}

// ---- placement checks ------------------------------------------------------------------------------------------
type Cand = { id: string; x: number; z: number; rot: 0 | 1 };
export const itemRect = (c: Cand, pad = 0) => { const f = footprint(c); return rectOf(c.x, c.z, f.w, f.d, pad); };
// model.fits with this room's size, plus: nothing may stand in the door's clearance
export function fitsIn(s: Store, cand: Cand, ignore?: number): boolean {
  const { w, d } = roomDims(s);
  const r = itemRect(cand);
  if (r.x0 < -w / 2 - 1e-6 || r.x1 > w / 2 + 1e-6 || r.z0 < -d / 2 - 1e-6 || r.z1 > d / 2 + 1e-6) return false;
  if (cand.id !== "kitchen" && overlaps(r, doorInfo(s).zone)) return false;
  return s.items.every((o) => o.uid === ignore || !overlaps(itemRect(o), r));
}
// lattice of item centres (edges on the 0.5 m grid like model.snap) ordered by distance to a point
function spotsNear(s: Store, id: string, rot: 0 | 1, x: number, z: number): Cand[] {
  const { w, d } = roomDims(s), f = footprint({ id, rot }), out: Cand[] = [];
  for (let cx = snap(-w / 2 + f.w / 2, f.w); cx <= w / 2 - f.w / 2 + 1e-6; cx += GRID) for (let cz = snap(-d / 2 + f.d / 2, f.d); cz <= d / 2 - f.d / 2 + 1e-6; cz += GRID) out.push({ id, rot, x: cx, z: cz });
  return out.sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z));
}

// ---- routes ----------------------------------------------------------------------------------------------------
function gridOf(s: Store): Grid {
  const { w, d } = roomDims(s);
  return makeGrid({ x0: -w / 2, z0: -d / 2, x1: w / 2, z1: d / 2 }, s.items.map((i) => itemRect(i)));
}
const isTable = (i: Placed) => ITEM[i.id].cat === "seat";
function payPoint(s: Store): { at: "counter" | "kitchen"; p: Pt } | null {
  const c = s.items.find((i) => i.id === "counter");
  if (c) { // the counter's customer side: +z unturned, +x turned (Parts3D Piece "counter")
    const n = c.rot ? [1, 0] : [0, 1], half = c.rot ? footprint(c).w / 2 : footprint(c).d / 2;
    const [x, z] = [c.x + n[0] * (half + 0.4), c.z + n[1] * (half + 0.4)];
    const alt: Pt = [c.x - n[0] * (half + 0.4), c.z - n[1] * (half + 0.4)];
    return { at: "counter", p: Math.abs(x) <= roomDims(s).w / 2 - 0.2 && Math.abs(z) <= roomDims(s).d / 2 - 0.2 ? [x, z] : alt };
  }
  const k = s.items.find((i) => i.id === "kitchen");
  return k ? { at: "kitchen", p: kitchenZones(k).pos } : null;
}

export type Flow = {
  inPath: Pt[]; outPath: Pt[]; inLen: number; outLen: number; total: number; avgIn: number;
  stops: { key: "door" | "seat" | "pay"; label: string; x: number; z: number }[];
  payAt: "counter" | "kitchen" | null; passLen: number; narrow: number; unreachable: number; tables: number;
  hints: { level: "ok" | "warn" | "weak"; text: string }[];
};
const m1 = (v: number) => `${v.toFixed(1).replace(/\.0$/, "")}m`;
export function bbqFlow(s: Store): Flow {
  const g = gridOf(s), door = doorInfo(s);
  const startCell = nearestWalk(g, door.step[0], door.step[1], 1.0);
  const fD = field(g, startCell);
  const tables = s.items.filter(isTable);
  const reach = tables.map((t) => ({ t, c: reachRect(g, fD, itemRect(t)) }));
  const ok = reach.filter((r) => r.c >= 0);
  const pay = payPoint(s);
  const empty: Flow = { inPath: [], outPath: [], inLen: 0, outLen: 0, total: 0, avgIn: 0, stops: [{ key: "door", label: "입구·출구", x: door.x, z: door.z }], payAt: pay?.at ?? null, passLen: 0, narrow: 0, unreachable: tables.length - ok.length, tables: tables.length, hints: [] };
  if (!ok.length) {
    empty.hints.push(tables.length ? { level: "weak", text: `문에서 갈 수 있는 테이블이 없어요. 문 앞과 통로를 비워 주세요.` } : { level: "warn", text: "테이블을 놓으면 손님 동선이 보여요." });
    return empty;
  }
  const far = ok.reduce((a, b) => (fD.dist[b.c] > fD.dist[a.c] ? b : a));
  const inPath = simplify(trace(g, fD, far.c));
  let outPath: Pt[] = [];
  let payCell = -1;
  let fP: Field | null = null;
  if (pay) {
    payCell = nearestWalk(g, pay.p[0], pay.p[1], 0.8);
    if (payCell >= 0 && fD.dist[payCell] < Infinity) {
      fP = field(g, payCell);
      const toPay = trace(g, fP, far.c).reverse();           // table -> pay
      const toDoor = trace(g, fD, payCell).reverse();        // pay -> door
      outPath = simplify([...toPay, ...toDoor.slice(1)]);
    }
  }
  if (!outPath.length) outPath = [...inPath].reverse();
  const inLen = polyLen(inPath), outLen = polyLen(outPath);
  const k = s.items.find((i) => i.id === "kitchen");
  const pass = k ? kitchenZones(k).pass : null;
  const inPass = (x: number, z: number) => !!pass && x >= pass.x0 && x <= pass.x1 && z >= pass.z0 && z <= pass.z1;
  const passLen = pass ? lenWhere(inPath, inPass) + lenWhere(outPath, inPass) : 0;
  const narrow = narrowLen(g, trimPath(inPath, 0.6, 0.6)) + narrowLen(g, trimPath(outPath, 0.6, 0.6));
  const avgIn = ok.reduce((n, r) => n + fD.dist[r.c], 0) / ok.length;
  const unreachable = tables.length - ok.length;
  const hints: Flow["hints"] = [];
  if (unreachable) hints.push({ level: "weak", text: `문에서 갈 수 없는 테이블이 ${unreachable}개 있어요. 테이블 사이를 띄워 길을 내 주세요.` });
  if (pay?.at === "kitchen" && passLen > 0.3) hints.push({ level: "warn", text: `계산대가 없어서 주방 배식구 앞에서 계산해요. 나가는 손님이 배식 통로를 ${m1(passLen)} 지나가요. 계산대를 문 옆에 두면 줄어요.` });
  else if (passLen > 0.5) hints.push({ level: "warn", text: `손님 동선이 주방 앞 배식 통로를 ${m1(passLen)} 지나가요. 서빙하는 직원과 부딪히기 쉬워요.` });
  if (narrow > 0.5) hints.push({ level: "warn", text: `통로 폭이 ${AISLE_OK * 100}cm보다 좁은 곳을 ${m1(narrow)} 지나가요. 테이블 사이 권장 간격은 90~120cm예요.` });
  if (!hints.length) hints.push({ level: "ok", text: "문에서 자리, 계산, 출구까지 막히는 곳 없이 이어져요." });
  const stops: Flow["stops"] = [{ key: "door", label: `입구·출구 (${WALL_KO[shapeOf(s).door.wall]})`, x: door.x, z: door.z }, { key: "seat", label: "가장 먼 자리", x: far.t.x, z: far.t.z }];
  if (pay && payCell >= 0) stops.push({ key: "pay", label: pay.at === "counter" ? "계산대" : "계산 (주방 POS)", x: pay.p[0], z: pay.p[1] });
  return { inPath, outPath, inLen, outLen, total: inLen + outLen, avgIn, stops, payAt: pay?.at ?? null, passLen, narrow, unreachable, tables: tables.length, hints };
}

// ---- automatic layout ------------------------------------------------------------------------------------------
// Re-place everything for a new shape: the kitchen to its corner, the drinks fridge beside it, the counter next to
// the door, other small items as near their old spot as fits, then the same number of tables (4인 first) packed
// front-first with 0.5 m between tables, walls and the kitchen (model.tableSlots' gaps), clear of the door, a 1 m
// walkway 1.8 m into the room, and every table still reachable from the door (route check after each one).
export function walkway(s: Store): Rect {
  const door = doorInfo(s), { w, d } = roomDims(s);
  const len = Math.min(1.8, (door.nx ? w : d) - 1.5); // 문에서 1.8m까지 1m 폭 통로 (가정)
  const a: Pt = [door.x - (door.nx ? 0 : 0.5), door.z - (door.nz ? 0 : 0.5)];
  const b: Pt = [door.x + (door.nx ? door.nx * len : 0.5), door.z + (door.nz ? door.nz * len : 0.5)];
  return { x0: Math.min(a[0], b[0]), z0: Math.min(a[1], b[1]), x1: Math.max(a[0], b[0]), z1: Math.max(a[1], b[1]) };
}
function keepOut(s: Store): Rect[] {
  const out = [doorInfo(s).zone, walkway(s)];
  const k = s.items.find((i) => i.id === "kitchen");
  if (k) out.push(itemRect(k, 0.5)); // model.tableSlots와 같은 주방 둘레 0.5m
  const c = s.items.find((i) => i.id === "counter");
  if (c) out.push(itemRect(c, 0.9)); // 계산 줄 자리
  return out;
}
function tablesReachable(s: Store): boolean {
  const g = gridOf(s), door = doorInfo(s);
  const f = field(g, nearestWalk(g, door.step[0], door.step[1], 1.0));
  if (!s.items.filter(isTable).every((t) => reachRect(g, f, itemRect(t)) >= 0)) return false;
  const pay = payPoint(s);
  if (!pay) return true;
  const c = nearestWalk(g, pay.p[0], pay.p[1], 0.8);
  return c >= 0 && f.dist[c] < Infinity;
}
export function packTables(s: Store, n4: number, n2: number): { store: Store; placed4: number; placed2: number } {
  const { w, d } = roomDims(s), gap = 0.5, ko = keepOut(s);
  let cur = s, uid = cur.items.reduce((m, i) => Math.max(m, i.uid), 0) + 1, p4 = 0, p2 = 0;
  for (const [id, want] of [["table4", n4], ["table2", n2]] as const) {
    if (want <= 0) continue;
    const f = footprint({ id, rot: 0 }), cands: Cand[] = [];
    for (let z = snap(d / 2 - gap - f.d / 2, f.d); z - f.d / 2 >= -d / 2 + gap - 1e-6; z -= GRID)
      for (let x = snap(-w / 2 + gap + f.w / 2, f.w); x + f.w / 2 <= w / 2 - gap + 1e-6; x += GRID) cands.push({ id, rot: 0, x, z });
    let n = 0;
    for (const c of cands) {
      if (n >= want) break;
      const r = itemRect(c);
      if (ko.some((k) => overlaps(r, k))) continue;
      if (!cur.items.every((o) => !overlaps(itemRect(o, gap), r))) continue;
      const next = { ...cur, items: [...cur.items, { uid, ...c }] };
      if (!tablesReachable(next)) continue;
      cur = next; uid++; n++;
    }
    if (id === "table4") p4 = n; else p2 = n;
  }
  return { store: cur, placed4: p4, placed2: p2 };
}

export type Relayout = { store: Store; dropped: string[]; tablesBefore: number; tablesAfter: number };
export function relayout(store: Store, shape: RoomShape): Relayout {
  const base = withShape({ ...store, items: [] }, shape);
  const old = store.items;
  const kitchen = old.find((i) => i.id === "kitchen");
  if (kitchen) base.items.push({ ...kitchen, rot: 0, ...kitchenSpotFor(base) });
  const dropped: string[] = [];
  const k = base.items[0];
  const put = (it: Placed, prefer: Pt) => {
    for (const rot of [it.rot, (it.rot ? 0 : 1) as 0 | 1]) {
      const spot = spotsNear(base, it.id, rot, prefer[0], prefer[1]).find((c) => fitsIn(base, c) && !keepOutHit(base, c));
      if (spot) { base.items.push({ ...it, ...spot }); return; }
    }
    dropped.push(ITEM[it.id].name);
  };
  const others = old.filter((i) => i.id !== "kitchen" && !isTable(i));
  // anchors: the first fridge beside the kitchen along its wall, the counter beside the door's clearance
  const [sx, sz] = k ? kitchenFlip(k) : [1, -1];
  const door = doorInfo(base);
  for (const it of others.sort((a, b) => rank(a) - rank(b))) {
    if (it.id === "fridge" && k && !base.items.some((i) => i.id === "fridge")) put(it, [k.x + sx * (KW / 2 + 0.5), k.z - sz * (KD / 2 - 0.5)]);
    else if (it.id === "counter") put(it, [door.x + (door.nz ? 1.6 : door.nx * 1.6), door.z + (door.nx ? 1.6 : door.nz * 1.6)]);
    else put(it, [it.x, it.z]);
  }
  const t = old.filter(isTable);
  const c4 = t.filter((i) => i.id === "table4").length, c2 = t.length - c4;
  const want = (store as LabStore).want;
  const [n4, n2] = want && want.a4 === c4 && want.a2 === c2 ? [Math.max(c4, want.n4), Math.max(c2, want.n2)] : [c4, c2];
  const packed = packTables(base, n4, n2);
  const out: LabStore = { ...packed.store };
  delete out.want;
  if (packed.placed4 < n4 || packed.placed2 < n2) out.want = { n4, n2, a4: packed.placed4, a2: packed.placed2 };
  return { store: out, dropped, tablesBefore: t.length, tablesAfter: packed.placed4 + packed.placed2 };
}
const rank = (i: Placed) => (i.id === "fridge" ? 0 : i.id === "counter" ? 1 : 2);
function keepOutHit(s: Store, c: Cand) {
  const r = itemRect(c), door = doorInfo(s);
  if (overlaps(r, walkway(s))) return true;
  const k = s.items.find((i) => i.id === "kitchen");
  return !!k && c.id !== "kitchen" && (overlaps(r, kitchenZones(k).pass) || overlaps(r, kitchenZones(k).doorway)) || overlaps(r, door.zone);
}

// the most 4인 tables this room holds with the kitchen, fridge and counter it has (for the 추천 배치 message)
export const tableRoom = (s: Store) => packTables({ ...s, items: s.items.filter((i) => !isTable(i)) }, 99, 0).placed4;

// one line saying what a change did: 테이블 5→4개, 20→16석, 동선 22m→15m
export function changeLine(before: Store, after: Store): string {
  const a = storeStats(before), b = storeStats(after);
  const fa = bbqFlow(before), fb = bbqFlow(after);
  const parts = [];
  parts.push(a.tables === b.tables ? `테이블 ${b.tables}개 그대로` : `테이블 ${a.tables}→${b.tables}개`);
  if (a.seats !== b.seats) parts.push(`${a.seats}→${b.seats}석`);
  if (fa.total > 0 || fb.total > 0) parts.push(`손님 동선 ${Math.round(fa.total)}m→${Math.round(fb.total)}m`);
  return parts.join(", ");
}
