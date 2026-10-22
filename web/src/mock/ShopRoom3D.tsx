// 치킨집·분식집·옷가게 3D. 엔진이 배치를 주지 않는 업종이라, 평수로 방 크기를 정하고 업종마다 정해 둔 규칙으로 놓는다.
// 고깃집·카페 장면과 같은 면 스타일, 같은 벽·유리 전면·조명·사람·카메라(Scene3D)를 쓴다. 모든 모양은 코드로 만든다.
// 장면 좌표: 방 가운데가 원점, 앞(거리 쪽) 벽이 +z. 문은 앞벽 오른쪽.
import { useMemo } from "react";
import { Canvas } from "@react-three/fiber";
import { GLGuard } from "../shared/GLGuard";
import { Box } from "../store3d/Building";
import { hash } from "../store3d/Figures";
import { FitControls, FrontFade, Pendant, People, StoreLights, Storefront, ViewBar, WALL_H, Wall, gfxDpr, gfxFrameloop, gfxShadows, useGfx, type Person } from "./Scene3D";
import "./cafe-sim.css";

export type ShopKind = "chicken" | "bunsik" | "apparel";
// 사장님이 고르는 배치. 비어 있으면 평수에 맞춰 가능한 만큼 놓는다.
// pos: 계산대(포스) 자리. door 입구 옆, window 창가 왼쪽, back 안쪽 (음식점은 주방 옆 오른쪽 벽, 옷가게는 뒷벽 가운데)
export type PosSpot = "door" | "window" | "back";
// door: 앞벽의 출입문 자리, shape: 가게 모양 (가로로 긴 / 정사각 / 세로로 긴). 문이 왼쪽이면 장면 전체를 좌우로 뒤집어 그린다
export type DoorSpot = "left" | "center" | "right";
export type RoomShape = "wide" | "square" | "deep";
export type ShopLayout = { pos?: PosSpot; tables?: number; bar?: boolean; racks?: number; rackDir?: "row" | "col"; door?: DoorSpot; shape?: RoomShape };
export const POS_LABEL: Record<PosSpot, string> = { door: "입구 옆", window: "창가", back: "안쪽" };
export const DOOR_LABEL: Record<DoorSpot, string> = { left: "왼쪽", center: "가운데", right: "오른쪽" };
export const SHAPE_LABEL: Record<RoomShape, string> = { wide: "가로로 긴", square: "정사각", deep: "세로로 긴" };
type V3 = [number, number, number];

const PAL: Record<ShopKind, { floor: string; wall: string; trim: string; sign: string; signText: string; accent: string }> = {
  chicken: { floor: "#d9cfc0", wall: "#f6efe4", trim: "#c9a46a", sign: "#d8462f", signText: "#ffe9a8", accent: "#f2b233" },
  bunsik: { floor: "#e2d8c8", wall: "#fbf3e6", trim: "#e48a5c", sign: "#f06b3f", signText: "#fff4dc", accent: "#e0402b" },
  apparel: { floor: "#e8e4de", wall: "#f7f6f3", trim: "#cfc8bd", sign: "#2b2d30", signText: "#f2efe8", accent: "#3d63ea" },
};
const STEEL = "#b9bec4", DARK = "#2f3337", WOOD = "#b98c5f", CREAM = "#f4f1ea";
const CLOTH = ["#3f6fb5", "#e9c46a", "#e0735a", "#6a8f5b", "#2f3a4a", "#f2f0ea", "#9b6fb0", "#d98aa0", "#8a5a33", "#4f9aa3"];
const pick = (a: string[], s: number) => a[Math.floor(hash(s) * a.length)];

function Cy({ p, r, r2, h, color, metal = 0 }: { p: V3; r: number; r2?: number; h: number; color: string; metal?: number }) {
  return <mesh position={p} castShadow><cylinderGeometry args={[r, r2 ?? r, h, 16]} /><meshStandardMaterial color={color} metalness={metal} roughness={0.55} /></mesh>;
}
const B = ({ p, s, color, metal, cast = true }: { p: V3; s: V3; color: string; metal?: number; cast?: boolean }) =>
  <Box p={p} s={s} color={color} metal={metal} cast={cast} receive />;

// 2인 테이블과 의자 두 개. 의자 자리(앉는 사람 위치)를 돌려준다
function Table2({ x, z, rot = 0, color = WOOD }: { x: number; z: number; rot?: number; color?: string }) {
  return (
    <group position={[x, 0, z]} rotation={[0, rot, 0]}>
      <B p={[0, 0.72, 0]} s={[0.7, 0.04, 0.6]} color={color} />
      <Cy p={[0, 0.36, 0]} r={0.04} h={0.7} color={DARK} metal={0.4} />
      <B p={[0, 0.01, 0]} s={[0.4, 0.02, 0.4]} color={DARK} />
      {[-0.55, 0.55].map((dz) => (
        <group key={dz} position={[0, 0, dz]}>
          <B p={[0, 0.44, 0]} s={[0.4, 0.04, 0.4]} color={DARK} />
          <B p={[0, 0.7, dz > 0 ? 0.19 : -0.19]} s={[0.4, 0.5, 0.03]} color={DARK} />
          <Cy p={[0, 0.22, 0]} r={0.025} h={0.44} color={STEEL} metal={0.5} />
        </group>
      ))}
    </group>
  );
}
function Stool({ x, z }: { x: number; z: number }) {
  return <group position={[x, 0, z]}><Cy p={[0, 0.74, 0]} r={0.17} h={0.05} color="#d24f3a" /><Cy p={[0, 0.37, 0]} r={0.03} h={0.72} color={STEEL} metal={0.6} /><Cy p={[0, 0.02, 0]} r={0.16} h={0.03} color={STEEL} metal={0.6} /></group>;
}
function Counter({ x0, x1, z, d = 0.65, top = STEEL, body = CREAM }: { x0: number; x1: number; z: number; d?: number; top?: string; body?: string }) {
  const w = x1 - x0, m = (x0 + x1) / 2;
  return <group><B p={[m, 0.44, z]} s={[w, 0.88, d]} color={body} /><B p={[m, 0.9, z]} s={[w + 0.02, 0.04, d + 0.02]} color={top} metal={top === STEEL ? 0.5 : 0} /></group>;
}
function Fryer({ x, z }: { x: number; z: number }) {
  return <group position={[x, 0, z]}><B p={[0, 0.45, 0]} s={[0.45, 0.9, 0.6]} color={STEEL} metal={0.6} /><B p={[0, 0.91, 0.02]} s={[0.36, 0.02, 0.42]} color="#c98a1d" /><B p={[0, 1.15, -0.24]} s={[0.45, 0.4, 0.08]} color={DARK} /></group>;
}
function Scooter({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0, z]} rotation={[0, Math.PI / 2, 0]}>
      {[-0.55, 0.55].map((dx) => <mesh key={dx} position={[dx, 0.22, 0]} rotation={[Math.PI / 2, 0, 0]} castShadow><cylinderGeometry args={[0.22, 0.22, 0.1, 18]} /><meshStandardMaterial color={DARK} /></mesh>)}
      <B p={[0, 0.45, 0]} s={[1.0, 0.25, 0.32]} color="#e9ecef" />
      <B p={[-0.35, 0.85, 0]} s={[0.45, 0.4, 0.42]} color="#d8462f" />
      <B p={[0.5, 0.9, 0]} s={[0.06, 0.6, 0.06]} color={DARK} />
    </group>
  );
}
function Rack({ x, z, len, seed, rot = 0 }: { x: number; z: number; len: number; seed: number; rot?: number }) {
  const n = Math.max(4, Math.floor(len / 0.11));
  return (
    <group position={[x, 0, z]} rotation={[0, rot, 0]}>
      {[-len / 2, len / 2].map((dx) => <Cy key={dx} p={[dx, 0.75, 0]} r={0.02} h={1.5} color={STEEL} metal={0.7} />)}
      <mesh position={[0, 1.5, 0]} rotation={[0, 0, Math.PI / 2]}><cylinderGeometry args={[0.015, 0.015, len, 8]} /><meshStandardMaterial color={STEEL} metalness={0.7} /></mesh>
      {Array.from({ length: n }, (_, i) => {
        const h = 0.6 + 0.35 * hash(seed + i * 3);
        return <B key={i} p={[-len / 2 + 0.08 + i * ((len - 0.16) / (n - 1)), 1.48 - h / 2, 0]} s={[0.05, h, 0.42]} color={pick(CLOTH, seed * 13 + i)} />;
      })}
    </group>
  );
}
function Shelf({ x0, x1, z, seed }: { x0: number; x1: number; z: number; seed: number }) {
  const w = x1 - x0, m = (x0 + x1) / 2, n = Math.floor(w / 0.32);
  return (
    <group>
      {[0.5, 1.0, 1.5].map((y, r) => (
        <group key={y}>
          <B p={[m, y, z]} s={[w, 0.03, 0.38]} color={WOOD} cast={false} />
          {Array.from({ length: n }, (_, i) => <B key={i} p={[x0 + 0.18 + i * 0.32, y + 0.08, z]} s={[0.26, 0.13, 0.3]} color={pick(CLOTH, seed + r * 31 + i)} />)}
        </group>
      ))}
    </group>
  );
}
function Mannequin({ x, z, seed }: { x: number; z: number; seed: number }) {
  return (
    <group position={[x, 0, z]}>
      <Cy p={[0, 0.03, 0]} r={0.18} h={0.04} color={DARK} />
      <Cy p={[0, 0.5, 0]} r={0.02} h={0.95} color={STEEL} metal={0.7} />
      <Cy p={[0, 1.25, 0]} r={0.17} r2={0.13} h={0.6} color={pick(CLOTH, seed)} />
      <mesh position={[0, 1.68, 0]} castShadow><sphereGeometry args={[0.1, 14, 12]} /><meshStandardMaterial color="#ece6dc" /></mesh>
    </group>
  );
}

const SHAPE_R: Record<RoomShape, number> = { wide: 1.6, square: 1.0, deep: 0.65 }; // 가로 ÷ 세로. 고르지 않으면 가로로 긴 가게
export const roomOf = (pyeong: number, shape?: RoomShape) => {
  const area = pyeong * 3.3058;
  const W = Math.min(13, Math.max(shape === "deep" ? 3.6 : 4.2, Math.sqrt(area * SHAPE_R[shape ?? "wide"]))), D = Math.max(3.4, area / W);
  return { W, D };
};
// 문 자리 (오른쪽 기준 좌표). 왼쪽 문은 오른쪽 문을 좌우로 뒤집은 것이라 같은 값
const doorX = (W: number, door?: DoorSpot) => (door === "center" ? 0 : W / 2 - 0.9);
type Rect = [number, number, number, number]; // x0 z0 x1 z1
const inside = (x: number, z: number, r: Rect, pad = 0) => x > r[0] - pad && x < r[2] + pad && z > r[1] - pad && z < r[3] + pad;

// 배치 계산 (화면 밖에서도 씀: 고를 수 있는 테이블·행거 최대 수, 좌석 수)
export function shopPlan(kind: ShopKind, pyeong: number, lay: ShopLayout = {}) {
  const { W, D } = roomOf(pyeong, lay.shape);
  const pos: PosSpot = lay.pos ?? "door";
  const dx = doorX(W, lay.door), center = lay.door === "center";
  // 문에서 안쪽으로 들어오는 통로 (테이블·행거를 놓지 않는다)
  const aisle: Rect = [dx - 0.85, D / 2 - 2.3, dx + 0.85, D / 2 + 1];
  const seats: [number, number, number][] = [], spots: [number, number, number][] = [], staff: [number, number][] = [];
  const tables: { x: number; z: number }[] = [], stools: { x: number; z: number }[] = [];
  const racks: { x: number; z: number; rot: number }[] = [];
  const kitchenZ = -D / 2 + 0.38;
  let posBox: Rect, posRot = false, posStaff: [number, number];
  if (kind !== "apparel") {
    if (pos === "window") { posBox = [-W / 2 + 0.6, D / 2 - 1.68, -W / 2 + 2.0, D / 2 - 1.12]; posStaff = [-W / 2 + 1.3, D / 2 - 2.05]; }
    else if (pos === "back") { posBox = [W / 2 - 0.9, -D / 2 + 1.3, W / 2 - 0.35, -D / 2 + 2.7]; posRot = true; posStaff = [W / 2 - 1.25, -D / 2 + 2.0]; }
    else if (center) { posBox = [0.95, D / 2 - 1.68, 2.35, D / 2 - 1.12]; posStaff = [1.65, D / 2 - 1.75]; }
    else { posBox = [W / 2 - 2.0, D / 2 - 1.68, W / 2 - 0.6, D / 2 - 1.12]; posStaff = [W / 2 - 1.3, D / 2 - 1.75]; }
    staff.push([-W / 4, kitchenZ + 0.7], posStaff);
    const x0 = -W / 2 + 0.8, x1 = W / 2 - 0.8, z0 = -D / 2 + 1.9, z1 = D / 2 - 1.0;
    const bar = kind === "bunsik" && lay.bar !== false;
    if (bar) {
      const zEnd = pos === "window" ? D / 2 - 2.0 : z1 - 0.1;
      for (let z = z0 - 0.4; z < zEnd; z += 0.55) { stools.push({ x: -W / 2 + 0.55, z }); seats.push([-W / 2 + 0.55, z, -Math.PI / 2]); }
    }
    const tx0 = bar ? x0 + 0.8 : x0;
    const cand: { x: number; z: number }[] = [];
    for (let x = tx0; x <= x1; x += 1.3) for (let z = z0; z <= z1 - 0.3; z += 1.7) if (!inside(x, z, posBox, 0.75) && !inside(x, z, aisle, 0.35)) cand.push({ x, z });
    const n = Math.min(cand.length, lay.tables ?? cand.length);
    // 고른 수만큼 앞(창가)에서부터 채운다
    cand.sort((p, q) => q.z - p.z || p.x - q.x).slice(0, n).forEach((t) => { tables.push(t); seats.push([t.x, t.z - 0.55, 0], [t.x, t.z + 0.55, Math.PI]); });
    const mid = tables.length ? [tables.reduce((a, t) => a + t.x, 0) / tables.length, tables.reduce((a, t) => a + t.z, 0) / tables.length] as [number, number] : [0, 0] as [number, number];
    const flow: [number, number][] = [[dx, D / 2 + 0.6], [dx, D / 2 - 1.2], [posStaff[0], posStaff[1] - 0.3], mid];
    return { W, D, dx, seats, spots, staff, tables, stools, racks, kitchenZ, posBox, posRot, maxTables: cand.length, maxRacks: 0, bar, flow };
  }
  // 옷가게
  if (pos === "window") { posBox = [-W / 2 + 0.6, D / 2 - 1.38, -W / 2 + 2.0, D / 2 - 0.82]; posStaff = [-W / 2 + 1.3, D / 2 - 1.75]; }
  else if (pos === "back") { posBox = [-0.75, -D / 2 + 0.85, 0.75, -D / 2 + 1.4]; posStaff = [0, -D / 2 + 1.75]; }
  else if (center) { posBox = [0.95, D / 2 - 1.38, 2.35, D / 2 - 0.82]; posStaff = [1.65, D / 2 - 1.5]; }
  else { posBox = [W / 2 - 1.9, D / 2 - 1.38, W / 2 - 0.5, D / 2 - 0.82]; posStaff = [W / 2 - 1.2, D / 2 - 1.5]; }
  staff.push(posStaff);
  const col = lay.rackDir === "col";
  const cand: { x: number; z: number; rot: number }[] = [];
  const zA = -D / 2 + 1.6 + (pos === "back" ? 0.8 : 0), zB = D / 2 - 1.4;
  const free = (x: number, z: number) => !inside(x, z, posBox, 0.9) && !inside(x, z, aisle, 0.5) && !(x > W / 2 - 1.3 && z < -D / 2 + 1.4);
  if (!col) { for (let z = zA; z < zB; z += 1.25) for (let x = -W / 2 + 1.75; x < W / 2 - 1.0; x += 1.8) if (free(x, z)) cand.push({ x, z, rot: 0 }); }
  else { for (let x = -W / 2 + 1.6; x < W / 2 - 1.0; x += 1.25) for (let z = zA + 0.2; z < zB; z += 1.8) if (free(x, z)) cand.push({ x, z, rot: Math.PI / 2 }); }
  const n = Math.min(cand.length, lay.racks ?? cand.length);
  cand.slice(0, n).forEach((r) => {
    racks.push(r);
    if (r.rot) spots.push([r.x + 0.45, r.z, -Math.PI / 2], [r.x - 0.45, r.z + 0.3, Math.PI / 2]);
    else spots.push([r.x, r.z + 0.45, Math.PI], [r.x + 0.3, r.z - 0.45, 0]);
  });
  for (let z = -D / 2 + 1.4; z < D / 2 - 0.8; z += 1.1) if (!inside(-W / 2 + 0.75, z, posBox, 0.3)) spots.push([-W / 2 + 0.75, z, -Math.PI / 2]);
  const flow: [number, number][] = [[dx, D / 2 + 0.6], [dx, D / 2 - 1.6], [-W / 4, 0], [W / 2 - 0.65, -D / 2 + 1.5], [posStaff[0], posStaff[1] - 0.3]];
  return { W, D, dx, seats, spots, staff, tables, stools, racks, kitchenZ, posBox, posRot, maxTables: 0, maxRacks: cand.length, bar: false, flow };
}

// 손님 동선: 바닥에 0.55m마다 작은 화살표(납작한 삼각형)
export function FlowPath({ pts }: { pts: [number, number][] }) {
  const marks: { x: number; z: number; a: number }[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, z0] = pts[i], [x1, z1] = pts[i + 1], len = Math.hypot(x1 - x0, z1 - z0);
    const a = Math.atan2(x1 - x0, z1 - z0);
    for (let t = 0.3; t < len; t += 0.55) marks.push({ x: x0 + ((x1 - x0) * t) / len, z: z0 + ((z1 - z0) * t) / len, a });
  }
  return (
    <group>
      {marks.map((m, i) => (
        <mesh key={i} position={[m.x, 0.02, m.z]} rotation={[-Math.PI / 2, 0, -m.a + Math.PI]}>
          <circleGeometry args={[0.13, 3]} />
          <meshBasicMaterial color="#3d63ea" transparent opacity={0.85} />
        </mesh>
      ))}
    </group>
  );
}

// 계산대(포스): 상자 + 포스 단말
function PosCounter({ box, rot, top = WOOD, body = CREAM }: { box: Rect; rot: boolean; top?: string; body?: string }) {
  const [x0, z0, x1, z1] = box, mx = (x0 + x1) / 2, mz = (z0 + z1) / 2, w = x1 - x0, d = z1 - z0;
  return (
    <group>
      <B p={[mx, 0.44, mz]} s={[w, 0.88, d]} color={body} />
      <B p={[mx, 0.9, mz]} s={[w + 0.02, 0.04, d + 0.02]} color={top} />
      <group position={[rot ? mx - 0.05 : mx + w * 0.2, 0, rot ? mz : mz - 0.05]} rotation={[0, rot ? -Math.PI / 2 : 0, 0]}>
        <B p={[0, 0.96, 0]} s={[0.22, 0.06, 0.18]} color={DARK} />
        <B p={[0, 1.12, -0.04]} s={[0.26, 0.2, 0.03]} color="#1c2a3a" />
        <B p={[0, 1.12, -0.024]} s={[0.22, 0.16, 0.005]} color="#5f8de0" />
      </group>
    </group>
  );
}

export default function ShopRoom3D({ kind, pyeong, people = 0, riders = 0, height = 420, layout, flow = false }: { kind: ShopKind; pyeong: number; people?: number; riders?: number; height?: number | "fill"; layout?: ShopLayout; flow?: boolean }) {
  const { W, D } = roomOf(pyeong, layout?.shape);
  const flip = layout?.door === "left";
  const pal = PAL[kind];
  const door = { x: doorX(W, layout?.door), w: 1.0 };
  const R = Math.max(W, D) / 2 + 2.5;

  // 업종별 배치: seats = 앉는 자리, spots = 서서 둘러보는 자리, staff = 직원 자리
  const lk = JSON.stringify(layout ?? {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const plan = useMemo(() => shopPlan(kind, pyeong, layout), [kind, pyeong, lk]);

  const list = useMemo(() => {
    const out: Person[] = [];
    const places = kind === "apparel" ? plan.spots : plan.seats;
    const order = places.map((_, i) => i).sort((a, b) => hash(a * 17 + 3) - hash(b * 17 + 3));
    const n = Math.min(places.length, Math.max(0, Math.round(people)));
    for (const i of order.slice(0, n)) {
      const [x, z, h] = places[i];
      out.push(kind === "apparel"
        ? { x, z, heading: h, seated: false, seed: i * 7 + 1, armsUp: 0.2 }
        : { x, z, heading: h, seated: true, seed: i * 7 + 1, lift: kind === "bunsik" && i < plan.stools.length ? 0.3 : 0, armsUp: 0.35 });
    }
    plan.staff.forEach(([x, z], i) => out.push({ x, z, heading: i === 0 && kind !== "apparel" ? Math.PI : Math.PI, seated: false, seed: 900 + i, shirt: "#f2f0ea", apron: kind === "apparel" ? null : pal.sign }));
    for (let i = 0; i < Math.min(3, riders); i++) out.push({ x: door.x - 0.4 - i * 0.6, z: D / 2 + 0.9, heading: Math.PI, seated: false, seed: 700 + i, shirt: "#d8462f" });
    return out;
  }, [kind, plan, people, riders, pal.sign, door.x, D]);

  const staticScene = useMemo(() => (
    <>
      <Box p={[0, -0.12, 0]} s={[W + 8, 0.02, D + 8]} color="#e6eaf2" receive />
      <Box p={[0, -0.1, D / 2 + 1.3]} s={[W + 8, 0.02, 2.4]} color="#d6d3cc" receive />
      <Box p={[0, -0.05, 0]} s={[W, 0.1, D]} color={pal.floor} receive />
      <Wall p={[0, WALL_H / 2, -D / 2 - 0.06]} s={[W + 0.24, WALL_H, 0.12]} color={pal.wall} outside={(c) => c.z < -D / 2}>
        <Box p={[0, 0.5, -D / 2 + 0.005]} s={[W, 1.0, 0.02]} color={pal.trim} />
        {kind !== "apparel" && <>
          <Box p={[-W / 6, 1.95, -D / 2 + 0.03]} s={[Math.min(2.6, W * 0.45), 0.6, 0.03]} color="#2b2622" />
          {[0.14, 0.02, -0.1].map((dy) => <Box key={dy} p={[-W / 6, 1.95 + dy, -D / 2 + 0.05]} s={[Math.min(2.2, W * 0.38), 0.03, 0.005]} color="#f6ead2" />)}
        </>}
      </Wall>
      <Wall p={[-W / 2 - 0.06, WALL_H / 2, 0]} s={[0.12, WALL_H, D]} color={pal.wall} outside={(c) => (flip ? -c.x : c.x) < -W / 2}>
        <Box p={[-W / 2 + 0.005, 0.5, 0]} s={[0.02, 1.0, D]} color={pal.trim} />
      </Wall>
      <Wall p={[W / 2 + 0.06, WALL_H / 2, 0]} s={[0.12, WALL_H, D]} color={pal.wall} outside={(c) => (flip ? -c.x : c.x) > W / 2} />
      <FrontFade z={D / 2}>
        <Storefront x0={-W / 2} x1={W / 2} z={D / 2} door={door} />
        <Box p={[0, WALL_H + 0.25, D / 2 + 0.08]} s={[W, 0.5, 0.12]} color={pal.sign} />
        <Box p={[-W / 2 + 1.2, WALL_H + 0.25, D / 2 + 0.15]} s={[1.6, 0.22, 0.02]} color={pal.signText} />
      </FrontFade>

      {kind === "chicken" && <>
        <Counter x0={-W / 2 + 0.1} x1={W / 2 - 0.1} z={plan.kitchenZ} />
        {Array.from({ length: Math.min(4, Math.max(2, Math.floor(W / 2))) }, (_, i) => <Fryer key={i} x={-W / 2 + 0.6 + i * 0.55} z={plan.kitchenZ} />)}
        <B p={[W / 4, 1.0, plan.kitchenZ]} s={[0.9, 0.12, 0.5]} color="#e9c46a" />
        <PosCounter box={plan.posBox} rot={plan.posRot} />
        {[0, 1, 2].map((i) => <B key={i} p={[W / 2 - 0.35, 0.3 + i * 0.4, D / 2 - 1.9]} s={[0.4, 0.32, 0.4]} color={i % 2 ? pal.accent : pal.sign} />)}
      </>}
      {kind === "bunsik" && <>
        <Counter x0={-W / 2 + 0.1} x1={W / 2 - 0.1} z={plan.kitchenZ} />
        <Cy p={[-W / 4, 0.95, plan.kitchenZ]} r={0.42} h={0.06} color="#c63a26" metal={0.2} />
        <Cy p={[-W / 4 + 1.0, 1.02, plan.kitchenZ]} r={0.22} h={0.24} color={STEEL} metal={0.6} />
        <B p={[W / 6, 0.95, plan.kitchenZ]} s={[1.0, 0.06, 0.45]} color="#5a8a3a" />
        {plan.bar && plan.stools.length > 0 && (() => { const za = plan.stools[0].z - 0.3, zb = plan.stools[plan.stools.length - 1].z + 0.3;
          return <B p={[-W / 2 + 0.25, 1.0, (za + zb) / 2]} s={[0.4, 0.04, zb - za]} color={WOOD} />; })()}
        <PosCounter box={plan.posBox} rot={plan.posRot} />
      </>}
      {kind === "apparel" && <>
        <Shelf x0={-W / 2 + 0.3} x1={W / 2 - 1.6} z={-D / 2 + 0.25} seed={11} />
        <group position={[-W / 2 + 0.25, 0, 0]} rotation={[0, Math.PI / 2, 0]}><Shelf x0={-D / 2 + 1.2} x1={D / 2 - 0.9} z={0} seed={47} /></group>
        {plan.racks.map((r, i) => <Rack key={i} x={r.x} z={r.z} rot={r.rot} len={1.3} seed={i * 19 + 3} />)}
        <B p={[W / 2 - 0.65, 1.05, -D / 2 + 0.7]} s={[1.0, 2.1, 1.0]} color="#e2dccf" />
        <B p={[W / 2 - 0.65, 1.15, -D / 2 + 1.21]} s={[0.8, 1.9, 0.02]} color="#8a6e5a" />
        <PosCounter box={plan.posBox} rot={plan.posRot} body="#f2efe8" />
        {[-W / 2 + 0.7, -W / 2 + 1.4, -W / 2 + 2.1].filter((x) => x < door.x - 0.9 && !inside(x, D / 2 - 0.45, plan.posBox, 0.35)).map((x, i) => <Mannequin key={x} x={x} z={D / 2 - 0.45} seed={i * 5 + 2} />)}
      </>}
      {plan.tables.map((t, i) => <Table2 key={i} x={t.x} z={t.z} />)}
      {plan.stools.map((s, i) => <Stool key={i} x={s.x} z={s.z} />)}
      {kind !== "apparel" && riders > 0 && <Scooter x={door.x - 2.2} z={D / 2 + 1.4} />}
      {(kind === "apparel" ? [[-W / 4, 0], [W / 4, 0], [-W / 4, -D / 4], [W / 4, -D / 4]] : plan.tables.slice(0, 12).map((t) => [t.x, t.z])).map(([x, z], i) =>
        <Pendant key={i} x={x} z={z} y={kind === "apparel" ? 2.3 : 1.85} color={kind === "apparel" ? "#e8e4dc" : "#2f3337"} />)}
    </>
  ), [kind, W, D, pal, plan, riders, door, flip]);

  const gfx = useGfx();
  const label = kind === "apparel" ? "옷가게 3D 화면. 행거와 벽 선반의 옷, 피팅룸, 계산대, 창가 마네킹, 둘러보는 손님을 보여 줘요"
    : kind === "chicken" ? "치킨집 3D 화면. 뒤쪽 튀김기와 주방, 앞쪽 포장 계산대와 배달 가방, 테이블과 손님, 문 앞 배달 기사를 보여 줘요"
    : "분식집 3D 화면. 떡볶이 판과 어묵 통이 있는 주방, 벽쪽 바 자리와 테이블, 손님을 보여 줘요";
  return (
    <>
      <div className="cs-3d" style={{ height: height === "fill" ? "100%" : height, borderRadius: height === "fill" ? 0 : undefined }} role="img" aria-label={label}>
        <GLGuard>
          <Canvas key={gfx} frameloop={gfxFrameloop(gfx)} shadows={gfxShadows(gfx)} camera={{ position: [W * 0.55, Math.max(W, D) * 0.95, D * 1.25], fov: 40 }} dpr={gfxDpr(gfx)}>
            <StoreLights w={W} d={D} r={R} />
            <group scale={[flip ? -1 : 1, 1, 1]}>
              {staticScene}
              <People list={list} />
              {flow && <FlowPath pts={plan.flow} />}
            </group>
            <FitControls box={[-W / 2, -D / 2, W / 2, D / 2 + 1.6]} />
          </Canvas>
        </GLGuard>
      </div>
      <ViewBar />
    </>
  );
}
