// lab:layout geometry tests (no browser). Run: sh web/src/lab/layout/test.sh (bundles with rolldown, runs on node).
// Door on every wall and several positions/ratios: the plan stays valid (inside the room, nothing overlapping,
// door clearance empty), seats ≥ 0, every table reachable from the door, and a route exists door → seat → pay → door.
// tiny assert (no @types/node in this project)
const assert = {
  ok(v: unknown, msg = "assertion failed") { if (!v) throw new Error(msg); },
  equal(a: unknown, b: unknown, msg = "") { if (a !== b) throw new Error(`${msg} expected ${String(b)}, got ${String(a)}`); },
  deepEqual(a: unknown, b: unknown, msg = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} ${JSON.stringify(a)} != ${JSON.stringify(b)}`); },
  notDeepEqual(a: unknown, b: unknown, msg = "") { if (JSON.stringify(a) === JSON.stringify(b)) throw new Error(`${msg} values are equal`); },
};
import { ITEM, starterStore, storeStats, type Store } from "../../mock/model";
import { overlaps } from "./flow";
import { BBQ_SHAPE, WALLS, ratioSteps, type RoomShape, type Wall } from "./shape";
import { bbqDims, bbqFlow, doorInfo, fitsIn, itemRect, kitchenFlip, packTables, ratioOk, relayout, roomDims, shapeOf, withShape } from "./plan";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };

function valid(s: Store, label: string) {
  const { w, d } = roomDims(s), zone = doorInfo(s).zone;
  for (const it of s.items) {
    const r = itemRect(it);
    assert.ok(r.x0 >= -w / 2 - 1e-6 && r.x1 <= w / 2 + 1e-6 && r.z0 >= -d / 2 - 1e-6 && r.z1 <= d / 2 + 1e-6, `${label}: ${it.id} outside`);
    if (it.id !== "kitchen") assert.ok(!overlaps(r, zone), `${label}: ${it.id} in the door clearance`);
    for (const o of s.items) if (o.uid < it.uid) assert.ok(!overlaps(itemRect(o), r), `${label}: ${it.id} overlaps ${o.id}`);
  }
  assert.equal(s.items.filter((i) => i.id === "kitchen").length, 1, `${label}: one kitchen`);
  const st = storeStats(s);
  assert.ok(st.seats >= 0 && st.tables >= 0, label);
}

t("ratio 1.45 reproduces model.roomSize", () => {
  for (let p = 12; p <= 40; p++) {
    const area = p * 3.3, w = Math.round(Math.sqrt(area * 1.45) / 0.5) * 0.5;
    assert.deepEqual(bbqDims(p, 1.45), { w, d: Math.round(area / w / 0.5) * 0.5 });
  }
});

t("old stores (no shape) keep the old room and door", () => {
  const s = starterStore(20, "basic", 0, 5);
  assert.deepEqual(shapeOf(s), BBQ_SHAPE);
  const { w } = roomDims(s), door = doorInfo(s);
  assert.ok(Math.abs(door.x - (w / 2 - 1.2)) < 1e-9); // the old door gap in Parts3D
});

const walls = WALLS as Wall[];
t("door on every wall, several positions and ratios: plan valid, seats ≥ 0, route exists", () => {
  for (const pyeong of [12, 20, 30]) for (const ratio of ratioSteps(1.45)) {
    if (!ratioOk(pyeong, ratio)) continue;
    for (const wall of walls) for (const pos of [0, 0.35, 0.5, 1]) {
      const shape: RoomShape = { ratio, door: { wall, pos }, windows: ["front", wall] };
      const start = starterStore(pyeong, "basic", 0, 6);
      start.items.push({ uid: 99, id: "counter", x: 0, z: 0, rot: 0 });
      const r = relayout(start, shape);
      const label = `${pyeong}평 ${ratio.toFixed(2)} ${wall} ${pos}`;
      valid(r.store, label);
      assert.equal(shapeOf(r.store).door.wall, wall);
      const f = bbqFlow(r.store);
      const st = storeStats(r.store);
      assert.ok(st.seats >= 0);
      if (st.tables > 0) {
        assert.equal(f.unreachable, 0, `${label}: unreachable tables`);
        assert.ok(f.inPath.length >= 2 && f.outPath.length >= 2, `${label}: no route`);
        assert.ok(f.inLen > 0 && f.outLen >= f.inLen * 0.5, `${label}: route lengths`);
      }
      // kitchen pass faces into the room
      const k = r.store.items.find((i) => i.id === "kitchen")!;
      const [sx, sz] = kitchenFlip(k);
      assert.ok(sx === (k.x > 0 ? -1 : 1) && sz === (k.z > 0 ? -1 : 1));
    }
  }
});

t("moving the door changes the plan and the table count flows into storeStats", () => {
  const s = withShape(starterStore(20, "basic", 0, 8), BBQ_SHAPE);
  const a = relayout(s, { ...BBQ_SHAPE, door: { wall: "front", pos: 0.5 } });
  const b = relayout(s, { ...BBQ_SHAPE, ratio: 0.5, door: { wall: "left", pos: 0.5 } });
  assert.notDeepEqual(a.store.items.map((i) => [i.x, i.z]), b.store.items.map((i) => [i.x, i.z]));
  assert.equal(storeStats(a.store).tables, a.tablesAfter);
  assert.equal(storeStats(b.store).seats, b.store.items.reduce((n, i) => n + (ITEM[i.id].seats ?? 0), 0));
});

t("manual placement may not block the door", () => {
  for (const wall of walls) {
    const s = relayout(starterStore(20, "basic", 0, 0), { ...BBQ_SHAPE, door: { wall, pos: 0.5 } }).store;
    const door = doorInfo(s);
    const at = { id: "plant", x: door.step[0], z: door.step[1], rot: 0 as const };
    assert.equal(fitsIn(s, at), false, `${wall}: plant in the doorway`);
  }
});

t("an unreachable table is reported", () => {
  // a row of tables wall to wall shuts the back half off from the door; one table sits behind it
  const base = withShape({ pyeong: 12, grade: "basic", loan: 0, items: [] } as Store, { ...BBQ_SHAPE, door: { wall: "front", pos: 0.5 } });
  const { w, d } = roomDims(base);
  assert.equal(w, 7.5);
  const items: Store["items"] = [];
  let uid = 1;
  for (let x = -w / 2 + 0.75; x + 0.75 <= w / 2 + 1e-6; x += 1.5) items.push({ uid: uid++, id: "table4", x, z: 0.5, rot: 0 });
  items.push({ uid: uid++, id: "table4", x: 2, z: -d / 2 + 1, rot: 0 });
  const f = bbqFlow({ ...base, items });
  assert.equal(f.unreachable, 1);
  assert.equal(f.hints[0].level, "weak");
});

t("packTables never exceeds the request and keeps tables reachable", () => {
  const s = withShape(starterStore(25, "basic", 0, 0), { ...BBQ_SHAPE, door: { wall: "right", pos: 0.3 } });
  const p = packTables(s, 4, 2);
  assert.ok(p.placed4 <= 4 && p.placed2 <= 2);
  assert.equal(bbqFlow(p.store).unreachable, 0);
});

console.log(`${n} passed`);
