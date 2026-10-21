// The store's 3D pieces, shared by the builder and the simulation view. Colours, the Box helper and the sign textures
// come from the existing store scene (store3d/Building, store3d/textures); the hood-and-drop exhaust follows
// store3d/Building's Ceiling. Procedural only, no asset files.
import { useMemo, memo } from "react";
import * as THREE from "three";
import { Box, C } from "../store3d/Building";
import { bladeSign, cardSign, fasciaSign, grate } from "../store3d/textures";
import { Pendant, WALL_H } from "./Scene3D"; // lab:layout: walls and storefront now come from Shell3D
import { CELL, GRADES, ITEM, kitchenSpot, type Grade, type Placed } from "./model";
import { Shell } from "../lab/layout/Shell3D"; // lab:layout
import { BBQ_DOOR_MARGIN, BBQ_SHAPE, DOOR_W, doorPoint, type RoomShape } from "../lab/layout/shape"; // lab:layout
import { kitchenFlip } from "../lab/layout/plan"; // lab:layout

const WOOD = "#8a5a3c", DARK = "#2b2d30", LEAF = "#4d7a4a", PARTITION = "#e9e2d4";
const STEEL_DARK = "#5d6166", VINYL = "#b8372b", SOJU = "#2f8f5b", BEER = "#9a6a24", CREAM = "#f4f1ea";
const TRUNK_Y = WALL_H - 0.3; // exhaust trunk height, under the (undrawn) ceiling
const FONT = `"Pretendard Variable", Pretendard, "Apple SD Gothic Neo", "Malgun Gothic", "맑은 고딕", "Noto Sans KR", sans-serif`;

// stool positions around a table, unrotated (x along item.w, z along item.d)
export const SEATS: Record<string, [number, number][]> = {
  table4: [[-0.34, -0.72], [0.34, -0.72], [-0.34, 0.72], [0.34, 0.72]],
  table2: [[-0.5, 0], [0.5, 0]],
};
export function seatSpots(items: Placed[]): [number, number][] {
  return items.flatMap((it) => (SEATS[it.id] ?? []).map(([x, z]): [number, number] => (it.rot ? [it.x + z, it.z - x] : [it.x + x, it.z + z])));
}
// the same stools as seatSpots (same order) with the heading that faces the table centre (forward = (sin h, cos h))
export function seatPoses(items: Placed[]): [number, number, number][] {
  return items.flatMap((it) => (SEATS[it.id] ?? []).map(([x, z]): [number, number, number] => {
    const [px, pz] = it.rot ? [it.x + z, it.z - x] : [it.x + x, it.z + z];
    return [px, pz, Math.atan2(it.x - px, it.z - pz)];
  }));
}

export function Cyl({ p, r, h, color, metal = 0, r2, seg = 16, rough = 0.6 }: {
  p: [number, number, number]; r: number; h: number; color: string; metal?: number; r2?: number; seg?: number; rough?: number;
}) {
  return <mesh position={p} castShadow><cylinderGeometry args={[r, r2 ?? r, h, seg]} /><meshStandardMaterial color={color} metalness={metal} roughness={rough} /></mesh>;
}
function Glow({ p, s, color, glow, k = 1 }: { p: [number, number, number]; s: [number, number, number]; color: string; glow: string; k?: number }) {
  return <mesh position={p}><boxGeometry args={s} /><meshStandardMaterial color={color} emissive={glow} emissiveIntensity={k} roughness={0.4} /></mesh>;
}

// A text board drawn on a canvas: title line, then one row per item. Korean uses the page's Pretendard.
function boardTex(title: string, rows: string[], bg = "#2b2622", fg = "#f6ead2", w = 512, h = 384) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  g.strokeStyle = "#c9a46a";
  g.lineWidth = 6;
  g.strokeRect(10, 10, w - 20, h - 20);
  g.fillStyle = "#ffcf7a";
  g.textAlign = "center";
  g.font = `800 ${Math.round(h * 0.13)}px ${FONT}`;
  g.fillText(title, w / 2, h * 0.2);
  g.fillStyle = fg;
  g.font = `600 ${Math.round(h * 0.085)}px ${FONT}`;
  rows.forEach((r, i) => g.fillText(r, w / 2, h * 0.36 + i * h * (0.58 / Math.max(1, rows.length))));
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
function Board({ map, p, size, rot = [0, 0, 0], glow = 0.25, flipX = 1 }: { map: THREE.Texture; p: [number, number, number]; size: [number, number]; rot?: [number, number, number]; glow?: number; flipX?: number }) {
  return (
    <mesh position={p} rotation={rot} scale={[flipX, 1, 1]}>
      <planeGeometry args={size} />
      <meshStandardMaterial map={map} emissive="#ffffff" emissiveMap={map} emissiveIntensity={glow} roughness={0.7} />
    </mesh>
  );
}

// 고깃집 storage stool: steel drum body with bands, red vinyl cushion lid, dark foot ring
function Stool({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0, z]}>
      <Cyl p={[0, 0.02, 0]} r={0.16} h={0.04} color={DARK} />
      <Cyl p={[0, 0.2, 0]} r={0.15} r2={0.155} h={0.34} color={STEEL_DARK} metal={0.5} rough={0.4} seg={14} />
      {[0.1, 0.3].map((y) => <Cyl key={y} p={[0, y, 0]} r={0.158} h={0.02} color="#8d9298" metal={0.6} seg={14} />)}
      <Cyl p={[0, 0.405, 0]} r={0.17} h={0.07} color={VINYL} rough={0.45} seg={16} />
      <Cyl p={[0, 0.443, 0]} r={0.13} h={0.006} color="#cf4a3c" rough={0.35} seg={16} />
    </group>
  );
}

// Grill table: steel top with a wooden skirt, a round charcoal grill set in the middle (rim, dark grate, bars),
// the hood over it and its drop pipe up to the exhaust trunk (store3d/Building's telescopic drop).
function GrillTable({ id }: { id: "table4" | "table2" }) {
  const top: [number, number] = id === "table4" ? [1.1, 0.8] : [0.6, 0.7];
  const r = id === "table4" ? 0.22 : 0.19;
  const duct = { color: C.duct, metal: 0.55 };
  return (
    <group>
      <Box p={[0, 0.725, 0]} s={[top[0], 0.04, top[1]]} color={C.steel} metal={0.55} rough={0.35} cast receive />
      <Box p={[0, 0.66, 0]} s={[top[0] - 0.08, 0.1, top[1] - 0.08]} color={WOOD} />
      <Box p={[0, 0.33, 0]} s={[0.12, 0.62, 0.12]} color={DARK} cast />
      <Box p={[0, 0.02, 0]} s={[top[0] * 0.6, 0.04, top[1] * 0.6]} color={DARK} />
      <Cyl p={[0, 0.76, 0]} r={r + 0.03} h={0.04} color="#3a3c3f" metal={0.6} rough={0.35} seg={20} />
      <Cyl p={[0, 0.765, 0]} r={r} h={0.035} color="#1c1a19" rough={0.8} seg={20} />
      {[-2, -1, 0, 1, 2].map((k) => <Box key={k} p={[k * r * 0.36, 0.785, 0]} s={[0.012, 0.008, r * 2 * Math.sqrt(1 - (k * 0.36) ** 2) - 0.02]} color="#6b6f74" metal={0.7} />)}
      {/* napkin box and cutlery tin at the table end */}
      <Box p={[top[0] / 2 - 0.1, 0.78, top[1] / 2 - 0.08]} s={[0.12, 0.07, 0.08]} color={CREAM} />
      <Cyl p={[-top[0] / 2 + 0.08, 0.8, top[1] / 2 - 0.08]} r={0.035} h={0.11} color="#c9ced2" metal={0.6} seg={10} />
      {/* hood + telescopic drop up to the trunk */}
      <mesh position={[0, 1.56, 0]}>
        <cylinderGeometry args={[0.12, 0.3, 0.22, 16, 1, true]} />
        <meshStandardMaterial color={duct.color} metalness={duct.metal} roughness={0.35} flatShading side={THREE.DoubleSide} />
      </mesh>
      <Cyl p={[0, 1.67, 0]} r={0.12} h={0.02} color={duct.color} metal={duct.metal} seg={16} />
      <Cyl p={[0, 1.98, 0]} r={0.09} h={0.62} color={duct.color} metal={duct.metal} seg={12} />
      <Cyl p={[0, (2.29 + TRUNK_Y) / 2, 0]} r={0.105} h={TRUNK_Y - 2.29 + 0.02} color={duct.color} metal={duct.metal} seg={12} />
      {SEATS[id].map(([x, z], i) => <Stool key={i} x={x} z={z} />)}
    </group>
  );
}

// The kitchen: a walled room in the back-left corner. Pass window to the front (shelf with dishes, heat lamps, the
// POS at its right end, menu board over it), doorway with a 노렌 on the right, range + hood, prep table, shelves.
// lab:layout: flip = [sx, sz] mirrors the room so its pass faces into the store and its doorway the middle; the menu
// board is mirrored back so its text reads
function Kitchen({ flip = [1, 1] }: { flip?: [number, number] }) {
  const { w, d } = ITEM.kitchen;
  const menu = useMemo(() => boardTex("메뉴", ["생삼겹살 · 목살 · 항정살", "된장찌개 · 물냉면 · 공기밥", "소주 · 맥주 · 음료"], "#2b2622", "#f6ead2", 768, 256), []);
  return (
    <group>
      <Box p={[0, 0.011, 0]} s={[w, 0.02, d]} color={C.tile} />
      {/* pass: low wall, steel shelf, header with the menu board */}
      <Box p={[0, 0.5, d / 2 - 0.05]} s={[w, 1, 0.1]} color={PARTITION} cast />
      <Box p={[0, 1.02, d / 2 - 0.05]} s={[w, 0.05, 0.34]} color={C.steel} metal={0.5} />
      <Box p={[0, 2.35, d / 2 - 0.05]} s={[w, 0.5, 0.1]} color={PARTITION} />
      <Board map={menu} p={[-0.1, 2.35, d / 2 + 0.003]} size={[3.0, 0.44]} glow={0.35} flipX={flip[0] * flip[1]} />
      <Box p={[-w / 2 + 0.05, 1.55, d / 2 - 0.05]} s={[0.1, 1.1, 0.1]} color={PARTITION} />
      {[-1.1, 0.1].map((x) => <Glow key={x} p={[x, 2.06, d / 2 - 0.08]} s={[0.5, 0.04, 0.12]} color="#fff2d6" glow="#ffb35c" k={1.4} />)}
      {/* plates on the pass: a 반찬 tray and a stack of plates */}
      <Box p={[-1.0, 1.06, d / 2 - 0.05]} s={[0.5, 0.02, 0.26]} color="#8a5a3c" />
      {["#c8402e", "#4f8a3a", "#e8d38a"].map((c, i) => <Cyl key={c} p={[-1.15 + i * 0.15, 1.08, d / 2 - 0.05]} r={0.055} r2={0.045} h={0.03} color={c} seg={10} />)}
      <Cyl p={[-0.35, 1.1, d / 2 - 0.05]} r={0.1} h={0.1} color={CREAM} seg={16} />
      {/* POS at the right end of the pass, screen to the dining room */}
      <Box p={[1.45, 1.07, d / 2 - 0.06]} s={[0.3, 0.06, 0.22]} color={DARK} />
      <group position={[1.45, 1.22, d / 2 - 0.08]} rotation={[-0.2, 0, 0]}>
        <Box p={[0, 0, 0]} s={[0.3, 0.2, 0.025]} color={DARK} />
        <Glow p={[0, 0, 0.014]} s={[0.26, 0.16, 0.004]} color={DARK} glow="#2c5bd0" k={0.6} />
      </group>
      <Box p={[1.15, 1.08, d / 2 - 0.02]} s={[0.08, 0.06, 0.14]} color="#3a3f45" />
      {/* right side: wall at the back, doorway with a 노렌, posts */}
      <Box p={[w / 2 - 0.05, 1.3, -d / 2 + 0.7]} s={[0.1, 2.6, 1.4]} color={PARTITION} cast />
      <Box p={[w / 2 - 0.05, 2.35, 0.7]} s={[0.1, 0.5, 1.1]} color={PARTITION} />
      <Box p={[w / 2 - 0.05, 1.3, d / 2 - 0.05]} s={[0.1, 2.6, 0.1]} color={PARTITION} />
      {[0.42, 0.98].map((z) => <Box key={z} p={[w / 2 - 0.02, 1.82, z]} s={[0.02, 0.56, 0.5]} color="#7d1f16" />)}
      {/* range along the back wall: burners, pots, stock pot, hood */}
      <Box p={[-0.3, 0.45, -d / 2 + 0.4]} s={[w - 1, 0.9, 0.7]} color={C.steel} metal={0.6} rough={0.35} cast />
      <Box p={[-1, 0.93, -d / 2 + 0.4]} s={[0.9, 0.06, 0.6]} color={DARK} />
      {[-1.2, -0.8].map((x) => <Cyl key={x} p={[x, 1.03, -d / 2 + 0.4]} r={0.11} h={0.14} color="#9aa0a6" metal={0.7} rough={0.3} seg={14} />)}
      <Cyl p={[0.2, 1.08, -d / 2 + 0.4]} r={0.16} h={0.26} color="#b9bfc4" metal={0.7} rough={0.3} seg={16} />
      <Box p={[0.9, 0.92, -d / 2 + 0.4]} s={[0.5, 0.04, 0.4]} color="#e8e2d6" />
      {[0.78, 0.95].map((x) => <Box key={x} p={[x, 0.96, -d / 2 + 0.4]} s={[0.14, 0.03, 0.22]} color="#e9a19a" />)}
      <Box p={[-1, 1.95, -d / 2 + 0.45]} s={[1.3, 0.3, 0.8]} color={C.duct} metal={0.6} />
      <Cyl p={[-1, 2.4, -d / 2 + 0.45]} r={0.12} h={0.6} color={C.duct} metal={0.6} seg={12} />
      {/* shelf on the left wall with containers, prep table under it */}
      <Box p={[-w / 2 + 0.25, 1.6, 0.05]} s={[0.4, 0.03, 1.2]} color={C.steel} metal={0.5} />
      {[-0.4, -0.15, 0.1, 0.35].map((z, i) => <Box key={z} p={[-w / 2 + 0.25, 1.7, z]} s={[0.22, 0.17, 0.18]} color={["#f1ece2", "#c8402e", "#e8d38a", "#f1ece2"][i]} />)}
      <Box p={[-w / 2 + 0.35, 0.45, 0.05]} s={[0.6, 0.9, 1.0]} color={C.steel} metal={0.6} rough={0.35} cast />
      <Box p={[-w / 2 + 0.35, 0.915, 0.05]} s={[0.4, 0.03, 0.3]} color="#d9c7a3" />
    </group>
  );
}

// Drinks fridge (store3d/Building's Fridge, scaled to the 1 m catalog footprint): open shell behind glass, soju and
// beer shelves, a lit green header.
function DrinksFridge() {
  const bottles = useMemo(() => {
    const out: { p: [number, number, number]; beer: boolean }[] = [];
    for (let shelf = 0; shelf < 3; shelf++) for (let i = 0; i < 5; i++) out.push({ p: [-0.32 + i * 0.16, 0.42 + shelf * 0.42, 0.06], beer: shelf === 2 && i % 2 === 1 });
    return out;
  }, []);
  return (
    <group>
      <Box p={[0, 0.98, -0.36]} s={[0.9, 1.96, 0.04]} color="#f2f5f6" />
      {[-0.43, 0.43].map((x) => <Box key={x} p={[x, 0.98, 0]} s={[0.04, 1.96, 0.76]} color="#e6eaec" metal={0.2} rough={0.4} cast />)}
      <Box p={[0, 1.94, 0]} s={[0.9, 0.04, 0.76]} color="#e6eaec" metal={0.2} rough={0.4} />
      <Box p={[0, 0.1, 0]} s={[0.9, 0.2, 0.76]} color="#d5dadd" metal={0.2} rough={0.4} />
      {[0, 1, 2, 3].map((k) => <Box key={k} p={[0, 0.29 + k * 0.42, 0]} s={[0.82, 0.02, 0.6]} color="#cfd6da" metal={0.3} rough={0.3} />)}
      {bottles.map((b, i) => <Cyl key={i} p={b.p} r={0.04} r2={0.045} h={0.24} color={b.beer ? BEER : SOJU} rough={0.3} seg={7} />)}
      <Glow p={[0, 1.84, 0.37]} s={[0.84, 0.15, 0.02]} color={SOJU} glow="#3fb070" k={0.6} />
      <Box p={[0, 0.98, 0.37]} s={[0.84, 1.76, 0.02]} color={C.glass} opacity={0.18} />
      <Box p={[0.36, 1.0, 0.39]} s={[0.03, 0.4, 0.03]} color="#c9ced2" metal={0.6} />
    </group>
  );
}

// Pieces are drawn unrotated (item.w along x, item.d along z); the parent group turns them.
export function Piece({ id, flip }: { id: string; flip?: [number, number] }) {
  const it = ITEM[id];
  if (id === "table4" || id === "table2") return <GrillTable id={id} />;
  if (id === "kitchen") return <group scale={[flip?.[0] ?? 1, 1, flip?.[1] ?? 1]}><Kitchen flip={flip} /></group>; // lab:layout
  if (id === "counter") return ( // front (+z) to the customers, POS screen to the staff side (-z)
    <group>
      <Box p={[0, 0.5, 0]} s={[it.w - 0.1, 1, it.d - 0.3]} color={C.counter} cast />
      <Box p={[0, 1.02, 0]} s={[it.w, 0.05, it.d - 0.2]} color="#e4ddd2" />
      <Box p={[0, 0.5, (it.d - 0.3) / 2 + 0.005]} s={[it.w - 0.2, 0.7, 0.01]} color="#5a3a28" />
      <Box p={[0.3, 1.07, -0.1]} s={[0.3, 0.05, 0.22]} color={DARK} />
      <group position={[0.3, 1.22, -0.14]} rotation={[0.2, 0, 0]}>
        <Box p={[0, 0, 0]} s={[0.34, 0.24, 0.025]} color={DARK} />
        <Glow p={[0, 0, -0.014]} s={[0.3, 0.2, 0.004]} color={DARK} glow="#2c5bd0" k={0.6} />
      </group>
      <Box p={[-0.05, 1.09, 0.12]} s={[0.08, 0.08, 0.14]} color="#3a3f45" />
      <Box p={[-0.45, 1.1, -0.05]} s={[0.22, 0.12, 0.2]} color="#e9ecee" />
      <Cyl p={[0.6, 1.08, 0.12]} r={0.07} h={0.07} color={C.glass} seg={12} />
    </group>
  );
  if (id === "kiosk") return (
    <group>
      <Box p={[0, 0.02, 0]} s={[0.4, 0.04, 0.34]} color={DARK} />
      <Box p={[0, 0.6, -0.03]} s={[0.12, 1.16, 0.1]} color={CREAM} cast />
      <group position={[0, 1.28, 0]} rotation={[-0.12, 0, 0]}>
        <Box p={[0, 0, 0]} s={[0.42, 0.62, 0.06]} color={CREAM} />
        <Glow p={[0, 0.02, 0.032]} s={[0.36, 0.52, 0.004]} color={DARK} glow="#3d63ea" k={0.55} />
      </group>
    </group>
  );
  if (id === "fridge") return <DrinksFridge />;
  if (id === "bench") return (
    <group>
      <Box p={[0, 0.43, 0]} s={[1.4, 0.05, 0.4]} color={WOOD} cast />
      {[-0.6, 0.6].map((x) => <Box key={x} p={[x, 0.21, 0]} s={[0.06, 0.42, 0.34]} color={DARK} />)}
      <Box p={[0, 0.75, -0.17]} s={[1.4, 0.3, 0.04]} color={WOOD} />
    </group>
  );
  if (id === "plant") return (
    <group>
      <Cyl p={[0, 0.18, 0]} r={0.16} r2={0.13} h={0.36} color="#b9836a" />
      <mesh position={[0, 0.66, 0]} castShadow><icosahedronGeometry args={[0.3, 0]} /><meshStandardMaterial color={LEAF} flatShading roughness={0.9} /></mesh>
      <mesh position={[0.06, 0.92, 0.02]} castShadow><icosahedronGeometry args={[0.18, 0]} /><meshStandardMaterial color="#5c8b52" flatShading roughness={0.9} /></mesh>
    </group>
  );
  return ( // lamp
    <group>
      <Cyl p={[0, 0.02, 0]} r={0.14} h={0.04} color={DARK} />
      <Cyl p={[0, 0.7, 0]} r={0.025} h={1.4} color={DARK} />
      <mesh position={[0, 1.48, 0]}><coneGeometry args={[0.2, 0.26, 16, 1, true]} /><meshStandardMaterial color="#ffe9b0" emissive="#ffcf70" emissiveIntensity={0.7} side={THREE.DoubleSide} /></mesh>
    </group>
  );
}

// Exhaust trunks: one per row of grill tables, hung by straps under the ceiling line. A trunk runs from its right-most
// table to the left wall and exits through it; a row level with the kitchen stops at the kitchen and rises through
// the ceiling instead. Every table's drop pipe (in GrillTable) ends inside its row's trunk.
function DuctsImpl({ items, w, pyeong }: { items: Placed[]; w: number; pyeong: number }) {
  const rows = useMemo(() => {
    const m = new Map<number, number[]>();
    for (const it of items) if (it.id === "table4" || it.id === "table2") {
      const k = Math.round(it.z * 4) / 4;
      m.set(k, [...(m.get(k) ?? []), it.x]);
    }
    const kit = items.find((i) => i.id === "kitchen"); // lab:layout: the placed kitchen, not the default corner
    const hasK = !!kit;
    const k = kit ?? kitchenSpot(pyeong), kw = ITEM.kitchen.w, kd = ITEM.kitchen.d;
    const right = k.x > 1e-6; // kitchen on the right: trunks run to the right wall instead (mirror of the rule above)
    return [...m.entries()].map(([z, xs0]) => {
      const xs = right ? xs0.map((x) => -x) : xs0, kx = right ? -k.x : k.x;
      const blocked = hasK && Math.abs(z - k.z) < kd / 2 + 0.3;
      const x1 = Math.max(...xs) + 0.25;
      const x0 = blocked ? Math.min(Math.min(...xs) - 0.25, kx + kw / 2 + 0.35) : -w / 2;
      return right ? { z, x0: -x1, x1: -x0, riser: blocked, rx: -x0 } : { z, x0, x1, riser: blocked, rx: x0 };
    });
  }, [items, w, pyeong]);
  const mat = useMemo(() => new THREE.MeshStandardMaterial({ color: "#aeb4b9", metalness: 0.55, roughness: 0.4, flatShading: true }), []);
  return (
    <group>
      {rows.map((r) => (
        <group key={r.z}>
          <mesh position={[(r.x0 + r.x1) / 2, TRUNK_Y, r.z]} rotation={[0, 0, Math.PI / 2]} material={mat}>
            <cylinderGeometry args={[0.11, 0.11, r.x1 - r.x0, 12]} />
          </mesh>
          <mesh position={[r.rx === r.x0 ? r.x1 : r.x0, TRUNK_Y, r.z]} rotation={[0, 0, Math.PI / 2]} material={mat}><cylinderGeometry args={[0.12, 0.12, 0.03, 12]} /></mesh>
          {r.riser && <mesh position={[r.rx, (TRUNK_Y + WALL_H + 0.45) / 2, r.z]} material={mat}><cylinderGeometry args={[0.11, 0.11, WALL_H + 0.45 - TRUNK_Y, 12]} /></mesh>}
          {Array.from({ length: Math.max(1, Math.floor((r.x1 - r.x0) / 1.6)) }, (_, i) => (
            <Box key={i} p={[r.x0 + 0.8 + i * 1.6, TRUNK_Y + 0.18, r.z]} s={[0.03, 0.22, 0.26]} color="#55504c" />
          ))}
        </group>
      ))}
    </group>
  );
}
// the store shell and furniture do not change between simulation ticks: skip their re-render unless props change
export const Ducts = memo(DuctsImpl);

const RAW = "#e9a19a", COOKED = "#9a5530";
const DISH = ["#c8402e", "#4f8a3a", "#e8d38a", "#f1ece2", "#8a5a33", "#6aa04a"];
// Busy tables in the simulation: glowing grate, meat strips, 반찬 dishes, soju and a glass per guest (store3d/Store3D's
// TableLife props, placed statically). `seated` = indexes into seatPoses(items) that hold a guest.
export function TableLife({ items, seated }: { items: Placed[]; seated: number[] }) {
  const grateTex = useMemo(grate, []);
  const tables = useMemo(() => {
    const out: { it: Placed; guests: number[] }[] = [];
    let n = 0;
    const set = new Set(seated);
    for (const it of items) {
      const seats = SEATS[it.id];
      if (!seats) continue;
      const guests = seats.map((_, k) => n + k).filter((i) => set.has(i)).map((i) => i - n);
      n += seats.length;
      if (guests.length) out.push({ it, guests });
    }
    return out;
  }, [items, seated]);
  return (
    <group>
      {tables.map(({ it, guests }, ti) => {
        const four = it.id === "table4";
        const r = four ? 0.2 : 0.17;
        const dishes: [number, number][] = four
          ? [[-0.42, -0.24], [-0.42, 0], [-0.42, 0.24], [0.42, -0.24], [0.42, 0], [0.42, 0.24]]
          : [[-0.17, -0.27], [0, -0.27], [0.17, -0.27], [-0.17, 0.27], [0.17, 0.27]];
        const bottles: [number, number][] = four ? [[0.47, -0.32], [0.47, 0.32]] : [[0.24, 0.27]];
        const cup = (k: number): [number, number] => {
          const [sx, sz] = SEATS[it.id][k];
          return four ? [sx + (sx > 0 ? 0.12 : -0.12), sz > 0 ? 0.3 : -0.3] : [sx > 0 ? 0.22 : -0.22, -0.12];
        };
        const cooked = (ti * 37) % 10 / 10;
        return (
          <group key={it.uid} position={[it.x, 0, it.z]} rotation={[0, it.rot ? Math.PI / 2 : 0, 0]}>
            <mesh position={[0, 0.784, 0]}>
              <cylinderGeometry args={[r, r, 0.006, 20]} />
              <meshStandardMaterial color="#ffffff" map={grateTex} emissive="#ffffff" emissiveMap={grateTex} emissiveIntensity={0.85} />
            </mesh>
            {Array.from({ length: Math.min(6, guests.length + 2) }, (_, k) => (
              <mesh key={k} position={[((k % 3) - 1) * 0.12, 0.795, (Math.floor(k / 3) - 0.5) * 0.15]} rotation={[0, 0.2 + (k % 2) * 0.15, 0]}>
                <boxGeometry args={[0.09, 0.022, 0.17]} />
                <meshStandardMaterial color={new THREE.Color(RAW).lerp(new THREE.Color(COOKED), Math.min(1, cooked + k * 0.12))} roughness={0.6} />
              </mesh>
            ))}
            {dishes.map(([x, z], k) => <Cyl key={k} p={[x, 0.762, z]} r={0.06} r2={0.048} h={0.03} color={DISH[(k + ti) % DISH.length]} seg={10} />)}
            {bottles.slice(0, Math.max(1, Math.ceil(guests.length / 2))).map(([x, z], k) => (
              <group key={k} position={[x, 0, z]}>
                <Cyl p={[0, 0.85, 0]} r={0.035} r2={0.04} h={0.2} color={SOJU} rough={0.25} seg={8} />
                <Cyl p={[0, 0.97, 0]} r={0.014} h={0.05} color={SOJU} seg={6} />
              </group>
            ))}
            {guests.map((k) => {
              const [x, z] = cup(k);
              return <Cyl key={k} p={[x, 0.77, z]} r={0.022} r2={0.018} h={0.045} color="#e8f2ee" rough={0.2} seg={8} />;
            })}
          </group>
        );
      })}
    </group>
  );
}

// the floor, walls, storefront and the street-side life: fascia sign, blade sign, posters, menu board, warm lights,
// planters, an A-frame board and beer crates. `items` draws the exhaust trunks over the tables.
function RoomImpl({ w, d, grade, pyeong, items = [], shape = BBQ_SHAPE }: { w: number; d: number; grade: Grade; pyeong?: number; items?: Placed[]; shape?: RoomShape }) { // lab:layout shape
  const g = GRADES[grade];
  const lines = useMemo(() => {
    const pts: number[] = [];
    for (let x = -w / 2; x <= w / 2 + 1e-6; x += CELL) pts.push(x, 0.012, -d / 2, x, 0.012, d / 2);
    for (let z = -d / 2; z <= d / 2 + 1e-6; z += CELL) pts.push(-w / 2, 0.012, z, w / 2, 0.012, z);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    return geo;
  }, [w, d]);
  const fascia = useMemo(() => fasciaSign("삼겹살", "생삼겹살 전문  목살  소주"), []);
  const blade = useMemo(() => bladeSign("삼겹살", "#f6efe2", "#7d1f16"), []);
  const posterA = useMemo(() => cardSign("생삼겹살", "#7d1f16", "#fff3dd", 384, 512, 58), []);
  const posterB = useMemo(() => cardSign("소주 · 맥주", "#1f6b4e", "#ffffff", 384, 512, 64), []);
  const wallMenu = useMemo(() => boardTex("오늘의 고기", ["생삼겹살 180g", "목살 180g", "항정살 150g", "껍데기 200g"], "#3a2a20"), []);
  const aframe = useMemo(() => boardTex("오늘 추천", ["생삼겹살", "목살"], "#26302a", "#f2f0e6", 256, 320), []);
  // lab:layout: walls, door and windows come from the room shape (Shell3D); wall decor dodges the kitchen, door and windows
  const dp = doorPoint(shape, w, d, BBQ_DOOR_MARGIN);
  const tx = dp.nx === 0 ? 1 : 0, tz = dp.nx === 0 ? 0 : -1; // along the door wall
  const kit = items.find((i) => i.id === "kitchen");
  const kd = ITEM.kitchen.d, kw = ITEM.kitchen.w;
  const free = (lo: number, hi: number, blocked: [number, number][]) => { // largest open span of [lo, hi]
    let best: [number, number] = [lo, lo], cur = lo;
    for (const [a, b] of [...blocked].sort((p, q) => p[0] - q[0])) { if (a - cur > best[1] - best[0]) best = [cur, a]; cur = Math.max(cur, b); }
    if (hi - cur > best[1] - best[0]) best = [cur, hi];
    return best;
  };
  const backBlock: [number, number][] = [];
  if (kit && kit.z < 0) backBlock.push([kit.x - kw / 2, kit.x + kw / 2]);
  if (shape.door.wall === "back") backBlock.push([dp.x - DOOR_W, dp.x + DOOR_W]);
  const back = shape.windows.includes("back") ? null : free(-w / 2, w / 2, backBlock);
  const leftBlock: [number, number][] = [];
  if (kit && kit.x < 0) leftBlock.push([kit.z - kd / 2, kit.z + kd / 2]);
  if (shape.door.wall === "left") leftBlock.push([dp.z - DOOR_W, dp.z + DOOR_W]);
  const left = shape.windows.includes("left") ? null : free(-d / 2, d / 2, leftBlock);
  const [, ksz] = kit ? kitchenFlip(kit) : [1, 1];
  const fw = Math.min(w - 0.6, 2.8); // fasciaSign canvas is 1024x192
  const inside = (x: number, z: number): [number, number] => [Math.max(-w / 2 + 0.4, Math.min(w / 2 - 0.4, x)), Math.max(-d / 2 + 0.4, Math.min(d / 2 - 0.4, z))];
  const lampAtDoor = inside(dp.x + dp.nx * 0.6 - tx * 1.1, dp.z + dp.nz * 0.6 - tz * 1.1);
  const aframeX = shape.door.wall === "front" ? dp.x - 1.7 : w / 2 - 1.5;
  return (
    <group>
      <Box p={[0, -0.05, 0]} s={[w, 0.1, d]} color={g.floor} receive />
      <lineSegments geometry={lines}><lineBasicMaterial color="#191f28" transparent opacity={0.12} /></lineSegments>
      <Shell w={w} d={d} shape={shape} margin={BBQ_DOOR_MARGIN} color={g.wall} wainscot={C.wainscot} decor={{
        back: back && back[1] - back[0] > 2.2 ? (
          <group>
            <Box p={[(back[0] + back[1]) / 2, 1.7, -d / 2 + 0.02]} s={[1.5, 1.02, 0.03]} color="#5b4436" />
            <Board map={wallMenu} p={[(back[0] + back[1]) / 2, 1.7, -d / 2 + 0.04]} size={[1.4, 0.94]} />
            {[back[0] + 0.6, back[1] - 0.6].map((x) => <Glow key={x} p={[x, 2.1, -d / 2 + 0.04]} s={[0.22, 0.12, 0.06]} color="#fff3d6" glow="#ffc070" k={1.6} />)}
          </group>
        ) : undefined,
        left: left && left[1] - left[0] > 1.3 ? (
          <group>
            {[[posterA, left[0] + 0.9], [posterB, left[0] + 1.8]].filter(([, z]) => (z as number) < left[1] - 0.4).map(([map, z], i) => (
              <Board key={i} map={map as THREE.Texture} p={[-w / 2 + 0.02, 1.6, z as number]} size={[0.6, 0.8]} rot={[0, Math.PI / 2, 0]} glow={0.2} />
            ))}
            {left[1] - left[0] > 3 && <Glow p={[-w / 2 + 0.04, 2.1, left[1] - 0.6]} s={[0.06, 0.12, 0.22]} color="#fff3d6" glow="#ffc070" k={1.6} />}
          </group>
        ) : undefined,
        front: (
          <group>
            {/* fascia sign over the storefront, neon line under it, blade sign at the left corner */}
            <Box p={[0, WALL_H + 0.27, d / 2 + 0.1]} s={[fw + 0.24, fw * (192 / 1024) + 0.1, 0.12]} color="#4a2a20" />
            <mesh position={[0, WALL_H + 0.27, d / 2 + 0.165]}>
              <planeGeometry args={[fw, fw * (192 / 1024)]} />
              <meshStandardMaterial map={fascia.map} emissive="#ffffff" emissiveMap={fascia.emissive} emissiveIntensity={0.35} roughness={0.6} />
            </mesh>
            <Glow p={[0, WALL_H - 0.02, d / 2 + 0.2]} s={[w - 0.2, 0.03, 0.03]} color="#ff5a4a" glow="#ff3b2f" k={1.2} />
            <group position={[-w / 2 + 0.25, 2.05, d / 2 + 0.55]}>
              <Box p={[0, 0, 0]} s={[0.1, 1.3, 0.7]} color="#e9dfcc" />
              <Board map={blade} p={[0.055, 0, 0]} size={[0.6, 1.2]} rot={[0, Math.PI / 2, 0]} glow={0.3} />
              <Board map={blade} p={[-0.055, 0, 0]} size={[0.6, 1.2]} rot={[0, -Math.PI / 2, 0]} glow={0.3} />
              <Box p={[0, 0.1, -0.42]} s={[0.05, 0.05, 0.16]} color="#5b5248" />
            </group>
          </group>
        ),
      }} />
      {/* warm pendants by the door and over the pass */}
      <Pendant x={lampAtDoor[0]} z={lampAtDoor[1]} y={1.95} color="#7d1f16" />
      {kit && [kit.x - 0.8, kit.x + 0.8].map((x) => <Pendant key={x} x={x} z={kit.z + ksz * (kd / 2 + 0.35)} y={2.0} color="#7d1f16" />)}
      <pointLight position={[0, WALL_H - 0.2, 0]} intensity={0.8} distance={Math.max(w, d) * 1.2} decay={1} color="#ffcf9a" />
      {/* outside the door: two planters; on the street: an A-frame board and a stack of beer crates */}
      {[-1, 1].map((k) => (
        <group key={k} position={[dp.x - dp.nx * 0.4 + tx * k * (DOOR_W / 2 + 0.35), 0, dp.z - dp.nz * 0.4 + tz * k * (DOOR_W / 2 + 0.35)]}>
          <Cyl p={[0, 0.2, 0]} r={0.17} r2={0.14} h={0.4} color="#b9836a" />
          <mesh position={[0, 0.66, 0]} castShadow><icosahedronGeometry args={[0.3, 0]} /><meshStandardMaterial color={LEAF} flatShading roughness={0.9} /></mesh>
        </group>
      ))}
      <group position={[aframeX, 0, d / 2 + 1.0]} rotation={[0, 0.35, 0]}>
        <group rotation={[-0.16, 0, 0]} position={[0, 0.5, 0.08]}>
          <Box p={[0, 0, 0]} s={[0.56, 1.0, 0.04]} color="#5b4436" cast />
          <Board map={aframe} p={[0, 0.02, 0.022]} size={[0.48, 0.6]} glow={0.2} />
        </group>
        <group rotation={[0.16, 0, 0]} position={[0, 0.5, -0.08]}><Box p={[0, 0, 0]} s={[0.56, 1.0, 0.04]} color="#5b4436" /></group>
      </group>
      {[0, 1, 2].map((i) => <Box key={i} p={[-w / 2 + 0.75, 0.15 + i * 0.3, d / 2 + 0.45]} s={[0.5, 0.28, 0.36]} color="#2f7a52" cast />)}
      <Box p={[0, -0.12, 0]} s={[w + 6, 0.02, d + 6]} color="#e6eaf2" receive />
      <Box p={[0, -0.1, d / 2 + 1.1]} s={[w + 6, 0.02, 2]} color="#d6d3cc" receive />
      {items.length > 0 && <Ducts items={items} w={w} pyeong={pyeong ?? 20} />}
    </group>
  );
}
// the store shell and furniture do not change between simulation ticks: skip their re-render unless props change
export const Room = memo(RoomImpl);

function ItemsImpl({ items, hide }: { items: Placed[]; hide?: number }) {
  return <>{items.filter((it) => it.uid !== hide).map((it) => (
    <group key={it.uid} position={[it.x, 0, it.z]} rotation={[0, it.rot ? Math.PI / 2 : 0, 0]}><Piece id={it.id} flip={it.id === "kitchen" ? kitchenFlip(it) : undefined} /></group>
  ))}</>;
}
// the store shell and furniture do not change between simulation ticks: skip their re-render unless props change
export const Items = memo(ItemsImpl);
