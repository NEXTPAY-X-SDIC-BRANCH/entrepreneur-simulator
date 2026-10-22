// 카페 3D: 엔진(/cafe/preview)이 준 배치(layout, roster)를 카페 모양으로 그린다. 고깃집 장면과 같은 단순한 면 스타일이고,
// 모든 모양은 코드로 만든다(에셋 파일 없음). 공간이 모자라 못 놓은 것(fits=false)은 방 오른쪽 밖에 빨간 반투명으로 남는다.
// 엔진 좌표계: 원점은 방 모서리, +x는 앞벽(창·문)을 따라, +z는 방 안쪽, rot_deg는 위에서 본 시계 방향(0 = 앞면이 +z).
// 엔진 좌표는 Unity처럼 왼손 좌표라 화면에서는 z를 뒤집어 그린다: 장면 z = 깊이/2 - 엔진 z, 회전 = 180° - rot_deg.
// 그래서 앞벽(유리)이 카메라 쪽, 문과 카운터가 오른쪽에 보여 엔진 설명(카운터는 오른쪽 안쪽)과 같다.
import { createContext, useContext, useMemo } from "react";
import { Canvas } from "@react-three/fiber";
import * as THREE from "three";
import { GLGuard } from "../shared/GLGuard";
import { Box, C } from "../store3d/Building";
import { hash } from "../store3d/Figures";
import { FitControls, FrontFade, Pendant, People, StoreLights, Storefront, ViewBar, WALL_H, Wall, gfxDpr, gfxFrameloop, gfxShadows, useGfx, type Person } from "./Scene3D";

export type LayoutItem = { id: string; type: string; x: number; z: number; rot_deg: number; fits: boolean; w: number; d: number; unassigned?: boolean };
export type RosterItem = { id: string; role: string; label_ko: string; x: number; z: number; fits: boolean };
export type Room3D = { width_m: number; depth_m: number; door: { x: number; w: number } };

const OAK = "#b98c5f", MILK = "#f7f4ee", INK = "#2b2d30", STONE = "#e8e4dc", BLUE = "#3d63ea";
const ROOM = { floor: "#dcc9ab", plank: "#b49a76", wall: "#f3eee6", wainscot: "#c8b08f" };
const GHOST = "#d64545";
const TOP = 0.9; // 카운터 높이
const BAR_TOP = 1.05; // 창가 바 높이
const STOOL = 0.76; // 바 의자 좌판 높이
const PICKUP = 0.5; // 앞 카운터 왼쪽 끝 픽업 자리 폭 (엔진 layout.item_w.pickup과 같은 값)
const FRONT_LINE = new Set(["pos", "espresso", "grinder", "showcase"]);
const ON_COUNTER = new Set(["pos", "espresso", "grinder", "showcase", "oven", "sink"]);
const ROLE_APRON: Record<string, string> = { barista: "#35614a", cashier: "#d4a032" };

// fits=false 조각은 모든 면을 빨간 반투명으로 그린다
const Ghost = createContext(false);
function B({ p, s, color, metal, rough, opacity = 1, cast = true, glow }: {
  p: [number, number, number]; s: [number, number, number]; color: string; metal?: number; rough?: number; opacity?: number; cast?: boolean; glow?: string;
}) {
  const ghost = useContext(Ghost);
  if (ghost) return <Box p={p} s={s} color={GHOST} opacity={0.42} />;
  if (glow) return <mesh position={p}><boxGeometry args={s} /><meshStandardMaterial color={color} emissive={glow} emissiveIntensity={0.55} roughness={0.4} /></mesh>;
  return <Box p={p} s={s} color={color} metal={metal} rough={rough} opacity={opacity} cast={cast && opacity >= 1} receive />;
}
function Cy({ p, r, r2, h, color, metal = 0, opacity = 1, seg = 16 }: {
  p: [number, number, number]; r: number; r2?: number; h: number; color: string; metal?: number; opacity?: number; seg?: number;
}) {
  const ghost = useContext(Ghost);
  const op = ghost ? 0.42 : opacity;
  return (
    <mesh position={p} castShadow={!ghost && op >= 1}>
      <cylinderGeometry args={[r, r2 ?? r, h, seg]} />
      <meshStandardMaterial color={ghost ? GHOST : color} metalness={metal} roughness={0.55} transparent={op < 1} opacity={op} depthWrite={op >= 1} />
    </mesh>
  );
}

// 카운터 몸통 (x0~x1 구간, 깊이 d). customer: 손님 쪽(+z)에 나무 앞판을 붙인다
function Cabinet({ x0, x1, z, d, customer = false }: { x0: number; x1: number; z: number; d: number; customer?: boolean }) {
  const w = x1 - x0, m = (x0 + x1) / 2;
  return (
    <group>
      <B p={[m, TOP / 2 - 0.02, z]} s={[w, TOP - 0.04, d - 0.04]} color={customer ? OAK : MILK} />
      <B p={[m, TOP - 0.02, z]} s={[w + 0.02, 0.04, d]} color={STONE} rough={0.45} />
      {customer && <B p={[m, 0.05, z + d / 2 - 0.01]} s={[w, 0.1, 0.012]} color={INK} cast={false} />}
    </group>
  );
}

// 조각은 회전 전 모양으로 그린다: 폭 w는 x, 깊이 d는 z, 앞면은 +z. 앞 카운터 줄(rot 180)의 앞면은 손님 쪽이고
// 바리스타는 뒤(-z)에 선다. 뒤 줄(rot 180)의 앞면은 작업 통로 쪽이다.
function Piece({ it }: { it: LayoutItem }) {
  const { w, d } = it;
  switch (it.type) {
    case "table":
      return (
        <group>
          <B p={[0, 0.74, 0]} s={[w, 0.035, d]} color={MILK} rough={0.4} />
          <Cy p={[0, 0.37, 0]} r={0.035} h={0.72} color={INK} metal={0.4} />
          <B p={[0, 0.015, 0]} s={[0.46, 0.03, 0.06]} color={INK} cast={false} />
          <B p={[0, 0.015, 0]} s={[0.06, 0.03, 0.46]} color={INK} cast={false} />
        </group>
      );
    case "chair": // 앞(+z)이 테이블 쪽, 등받이는 뒤(-z)
      return (
        <group>
          <B p={[0, 0.45, 0]} s={[0.42, 0.04, 0.4]} color={OAK} />
          {[[-0.18, -0.16], [0.18, -0.16], [-0.18, 0.16], [0.18, 0.16]].map(([x, z]) => <Cy key={`${x}${z}`} p={[x, 0.22, z]} r={0.016} h={0.44} color={INK} seg={6} />)}
          <Cy p={[-0.18, 0.66, -0.18]} r={0.016} h={0.42} color={INK} seg={6} />
          <Cy p={[0.18, 0.66, -0.18]} r={0.016} h={0.42} color={INK} seg={6} />
          <B p={[0, 0.8, -0.185]} s={[0.42, 0.12, 0.025]} color={OAK} />
        </group>
      );
    case "bar_counter": // 창가 바: 앞(+z)이 방 안쪽, 뒤(-z)는 유리창
      return (
        <group>
          <B p={[0, BAR_TOP, 0]} s={[w, 0.04, d]} color={OAK} rough={0.5} />
          <B p={[0, BAR_TOP / 2, -d / 2 + 0.06]} s={[w, BAR_TOP - 0.02, 0.04]} color={MILK} />
          <B p={[0, 0.26, d / 2 - 0.12]} s={[w - 0.1, 0.03, 0.03]} color={C.steel} metal={0.6} cast={false} />
        </group>
      );
    case "bar_seat":
      return (
        <group>
          <Cy p={[0, STOOL - 0.025, 0]} r={0.17} h={0.05} color={OAK} />
          <Cy p={[0, STOOL / 2, 0]} r={0.025} h={STOOL - 0.05} color={INK} metal={0.4} />
          <Cy p={[0, 0.3, 0]} r={0.14} h={0.02} color={INK} metal={0.4} />
          <Cy p={[0, 0.01, 0]} r={0.18} h={0.02} color={INK} metal={0.4} />
        </group>
      );
    case "espresso": { // 그룹 수는 폭에서 (1그룹 0.55, 2그룹 0.8, 3그룹 1.05). 그룹헤드는 바리스타 쪽(-z)
      const g = Math.max(1, Math.round((w - 0.3) / 0.25)), bw = w - 0.08;
      return (
        <group>
          <B p={[0, TOP + 0.22, 0.04]} s={[bw, 0.4, 0.42]} color={C.steel} metal={0.6} rough={0.3} />
          <B p={[0, TOP + 0.3, 0.255]} s={[bw - 0.06, 0.18, 0.01]} color="#b5432f" cast={false} />
          <B p={[0, TOP + 0.43, 0.04]} s={[bw, 0.02, 0.42]} color={INK} cast={false} />
          <B p={[0, TOP + 0.03, -0.24]} s={[bw - 0.04, 0.03, 0.14]} color={INK} cast={false} />
          {Array.from({ length: g }, (_, i) => {
            const x = -bw / 2 + (bw / g) * (i + 0.5);
            return (
              <group key={i}>
                <Cy p={[x, TOP + 0.17, -0.2]} r={0.045} h={0.07} color={INK} metal={0.5} />
                <B p={[x, TOP + 0.15, -0.3]} s={[0.025, 0.025, 0.14]} color={INK} cast={false} />
              </group>
            );
          })}
          {[-0.12, 0, 0.12].map((x) => <Cy key={x} p={[x, TOP + 0.48, 0.04]} r={0.035} r2={0.028} h={0.07} color={MILK} />)}
        </group>
      );
    }
    case "grinder":
      return (
        <group>
          <B p={[0, TOP + 0.08, 0]} s={[0.2, 0.16, 0.26]} color={INK} />
          <Cy p={[0, TOP + 0.3, 0]} r={0.075} h={0.28} color={INK} metal={0.3} />
          <Cy p={[0, TOP + 0.52, 0]} r={0.1} r2={0.05} h={0.18} color={C.glass} opacity={0.55} />
          <Cy p={[0, TOP + 0.48, 0]} r={0.065} r2={0.05} h={0.08} color="#5b3a22" />
        </group>
      );
    case "pos": // 직원용 화면은 뒤(-z)를 보고, 손님용 작은 화면은 앞(+z)을 본다
      return (
        <group>
          <B p={[0, TOP + 0.03, 0]} s={[0.36, 0.06, 0.3]} color={INK} />
          <B p={[0, TOP + 0.1, 0]} s={[0.04, 0.12, 0.04]} color={INK} cast={false} />
          <group position={[0, TOP + 0.22, -0.02]} rotation={[0.25, 0, 0]}>
            <B p={[0, 0, 0]} s={[0.34, 0.24, 0.025]} color={INK} />
            <B p={[0, 0, -0.014]} s={[0.3, 0.2, 0.004]} color={INK} glow="#2c5bd0" cast={false} />
          </group>
          <B p={[0.12, TOP + 0.13, 0.12]} s={[0.12, 0.09, 0.015]} color={INK} glow="#2c5bd0" cast={false} />
        </group>
      );
    case "showcase": // 케이크 쇼케이스: 카운터 위 유리 상자, 앞(+z)이 손님 쪽
      return (
        <group>
          <B p={[0, TOP + 0.02, 0]} s={[w - 0.06, 0.04, d - 0.08]} color={INK} cast={false} />
          <B p={[0, TOP + 0.24, 0]} s={[w - 0.08, 0.42, d - 0.12]} color={C.glass} opacity={0.32} />
          <B p={[0, TOP + 0.47, 0]} s={[w - 0.06, 0.03, d - 0.08]} color={INK} cast={false} />
          <B p={[0, TOP + 0.25, 0]} s={[w - 0.12, 0.015, d - 0.16]} color={MILK} cast={false} />
          {[-0.33, -0.11, 0.11, 0.33].map((x, i) => (
            <group key={x}>
              <Cy p={[x * ((w - 0.1) / 0.9), TOP + 0.09, 0.02]} r={0.07} h={0.09} color={["#e8b4a0", "#7a4a2e", "#f2d6a2", "#c97b8a"][i]} seg={12} />
              <B p={[x * ((w - 0.1) / 0.9), TOP + 0.31, 0.02]} s={[0.11, 0.08, 0.11]} color={["#f2d6a2", "#e8b4a0", "#9c6b48", "#f7f4ee"][i]} cast={false} />
            </group>
          ))}
        </group>
      );
    case "oven": // 카운터 위 오븐, 유리문은 앞(+z, 통로 쪽)
      return (
        <group>
          <B p={[0, TOP + 0.26, 0]} s={[w - 0.1, 0.5, d - 0.15]} color={C.steel} metal={0.5} rough={0.35} />
          <B p={[-0.06, TOP + 0.26, (d - 0.15) / 2 + 0.005]} s={[w - 0.3, 0.36, 0.01]} color="#262a2e" glow="#7a3a12" cast={false} />
          <B p={[(w - 0.1) / 2 - 0.07, TOP + 0.26, (d - 0.15) / 2 + 0.005]} s={[0.08, 0.3, 0.01]} color={INK} cast={false} />
        </group>
      );
    case "sink": // 개수대: 상판에 파인 통, 수전은 벽 쪽(-z)
      return (
        <group>
          <B p={[0, TOP + 0.003, 0.04]} s={[w - 0.16, 0.012, d - 0.3]} color="#7d858c" metal={0.6} cast={false} />
          <Cy p={[0, TOP + 0.15, -0.22]} r={0.015} h={0.3} color={C.steel} metal={0.7} />
          <B p={[0, TOP + 0.29, -0.13]} s={[0.025, 0.025, 0.2]} color={C.steel} metal={0.7} cast={false} />
        </group>
      );
    case "ice_maker": // 바닥에 서는 제빙기, 카운터 높이
      return (
        <group>
          <B p={[0, TOP / 2, 0]} s={[w - 0.03, TOP, d - 0.04]} color="#e3e7ea" metal={0.3} rough={0.4} />
          <B p={[0, TOP * 0.62, (d - 0.04) / 2 + 0.005]} s={[w - 0.12, 0.32, 0.01]} color={C.steel} metal={0.5} cast={false} />
          <B p={[0, 0.12, (d - 0.04) / 2 + 0.005]} s={[w - 0.12, 0.1, 0.01]} color={INK} cast={false} />
        </group>
      );
    case "fridge": // 유리문 냉장고, 문은 앞(+z)
      return (
        <group>
          <B p={[0, 0.95, 0]} s={[w - 0.04, 1.9, d - 0.04]} color="#e9ecee" metal={0.3} />
          <B p={[0, 1.02, (d - 0.04) / 2 + 0.006]} s={[w - 0.14, 1.55, 0.012]} color={C.glass} opacity={0.6} cast={false} />
          {[0.55, 0.95, 1.35].map((y, row) => (
            <group key={y}>
              {[-0.18, -0.06, 0.06, 0.18].map((x, i) => <Cy key={x} p={[x * ((w - 0.1) / 0.6), y + 0.1, 0.12]} r={0.035} h={0.2} color={["#f2f0ea", "#e0735a", "#6a8f5b", "#e9c46a"][(i + row) % 4]} seg={8} />)}
            </group>
          ))}
        </group>
      );
    case "kiosk": // 키오스크: 화면이 앞(+z, 방 안쪽)
      return (
        <group>
          <B p={[0, 0.02, 0]} s={[0.46, 0.04, 0.36]} color={INK} />
          <B p={[0, 0.55, -0.04]} s={[0.12, 1.06, 0.1]} color={MILK} />
          <group position={[0, 1.3, -0.01]} rotation={[-0.12, 0, 0]}>
            <B p={[0, 0, 0]} s={[0.46, 0.78, 0.07]} color={MILK} />
            <B p={[0, 0.02, 0.037]} s={[0.4, 0.66, 0.005]} color={INK} glow={BLUE} cast={false} />
          </group>
        </group>
      );
    default:
      return <B p={[0, 0.25, 0]} s={[w || 0.5, 0.5, d || 0.5]} color="#999" />;
  }
}

// 바닥: 나무 마루 줄
function Floor({ W, D }: { W: number; D: number }) {
  const lines = useMemo(() => {
    const pts: number[] = [];
    for (let z = -D / 2 + 0.2; z < D / 2; z += 0.2) pts.push(-W / 2, 0.003, z, W / 2, 0.003, z);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    return geo;
  }, [W, D]);
  return (
    <group>
      <Box p={[0, -0.05, 0]} s={[W, 0.1, D]} color={ROOM.floor} receive />
      <lineSegments geometry={lines}><lineBasicMaterial color={ROOM.plank} transparent opacity={0.35} /></lineSegments>
    </group>
  );
}

// 뒷벽 위 컵 선반(뒤 카운터 구간마다)과 메뉴판(가장 긴 구간 위). 냉장고 위로는 걸치지 않는다
function BackWallDecor({ runs, z }: { runs: [number, number][]; z: number }) {
  const [x0, x1] = runs.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a));
  const w = x1 - x0, m = (x0 + x1) / 2;
  const bw = Math.min(w - 0.2, 2.4);
  if (bw < 0.6) return null;
  return (
    <group>
      {runs.filter(([a, b]) => b - a > 0.4).map(([a, b]) => (
        <group key={a}>
          <B p={[(a + b) / 2, 1.42, z + 0.13]} s={[b - a - 0.1, 0.03, 0.24]} color={OAK} cast={false} />
          {Array.from({ length: Math.floor((b - a - 0.2) / 0.16) }, (_, i) => (
            <Cy key={i} p={[a + 0.18 + i * 0.16, 1.48, z + 0.13]} r={0.04} r2={0.033} h={0.09} color={i % 3 === 2 ? "#3a3f45" : MILK} seg={10} />
          ))}
        </group>
      ))}
      <B p={[m, 2.02, z + 0.025]} s={[bw, 0.62, 0.03]} color="#2b2f33" cast={false} />
      {[0.15, 0.03, -0.09].map((dy, i) => <B key={dy} p={[m - bw * 0.18, 2.02 + dy, z + 0.045]} s={[bw * (0.5 - i * 0.08), 0.03, 0.005]} color="#e8e1d2" cast={false} />)}
      {[0.15, 0.03, -0.09].map((dy) => <B key={`p${dy}`} p={[m + bw * 0.34, 2.02 + dy, z + 0.045]} s={[bw * 0.12, 0.03, 0.005]} color="#e8e1d2" cast={false} />)}
    </group>
  );
}

// 시드: 같은 배치면 같은 사람이 같은 자리에 앉게
const seedOf = (id: string) => Array.from(id).reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

// occupancy: 0~1, 의자(와 바 좌석) 가운데 손님이 앉은 비율. 앉는 자리 순서는 id 해시로 고정해 손님이 늘 때 앉아 있던 사람은 그대로 있다.
// moves: 사장님이 옮긴 자리 (엔진 조각 id → 장면 x, z). 테이블을 옮기면 둘레 의자도 같이 옮긴다. 엔진 계산(좌석 수)에는 영향이 없다
export type CafeEdit = { sel: string | null; pick: (id: string | null) => void; move: (id: string, x: number, z: number) => void };
const MOVABLE = new Set(["table", "kiosk"]);
export default function CafeRoom3D({ room, layout: layout0, roster = [], occupancy = 0, height = 420, doors = 1, moves, edit }: { doors?: number; moves?: Record<string, [number, number]>; edit?: CafeEdit; room: Room3D; layout: LayoutItem[]; roster?: RosterItem[]; occupancy?: number; height?: number | "fill" }) {
  const { width_m: W, depth_m: D } = room;
  // 엔진 좌표 -> 장면 좌표
  const sx = (x: number) => x - W / 2;
  const sz = (z: number) => D / 2 - z;
  // 옮긴 자리 반영: 엔진 좌표로 되돌려 같은 그림 코드를 쓴다. 의자는 가장 가까운 테이블(0.9m 안)을 따라간다
  const mk = JSON.stringify(moves ?? {});
  const layout = useMemo(() => {
    const mv = moves ?? {};
    const shift: Record<string, [number, number]> = {};
    for (const it of layout0) if (mv[it.id]) shift[it.id] = [mv[it.id][0] + W / 2 - it.x, D / 2 - mv[it.id][1] - it.z];
    const tables = layout0.filter((t) => t.type === "table" && shift[t.id]);
    return layout0.map((it) => {
      if (shift[it.id]) return { ...it, x: it.x + shift[it.id][0], z: it.z + shift[it.id][1] };
      if (it.type === "chair") {
        const t = tables.find((t) => Math.hypot(t.x - it.x, t.z - it.z) < 0.9);
        if (t) return { ...it, x: it.x + shift[t.id][0], z: it.z + shift[t.id][1] };
      }
      return it;
    });
  }, [layout0, mk, W, D]); // eslint-disable-line react-hooks/exhaustive-deps
  // 의자를 눌러도 그 의자가 붙은 테이블을 고른다
  const owner = useMemo(() => {
    const ts = layout.filter((t) => t.type === "table"), out: Record<string, string> = {};
    for (const c of layout) if (c.type === "chair") { const t = ts.find((t) => Math.hypot(t.x - c.x, t.z - c.z) < 0.9); if (t) out[c.id] = t.id; }
    return out;
  }, [layout]);
  const yaw = (rot: number) => Math.PI - (rot * Math.PI) / 180;

  const seats = useMemo(() => layout.filter((i) => (i.type === "chair" || i.type === "bar_seat") && i.fits && !i.unassigned)
    .sort((a, b) => hash(seedOf(a.id)) - hash(seedOf(b.id))), [layout]);
  const filled = Math.round(seats.length * Math.max(0, Math.min(1, occupancy)));

  // 카운터 몸통: 앞 줄은 맨 왼쪽 조각 왼쪽에 픽업 자리를 더해 오른쪽 벽까지, 뒤 줄은 바닥에 서는 냉장고·제빙기 자리를 뺀 구간
  const counters = useMemo(() => {
    const placed = layout.filter((i) => i.fits);
    const front = placed.filter((i) => FRONT_LINE.has(i.type));
    const back = placed.filter((i) => ["sink", "ice_maker", "fridge", "oven"].includes(i.type));
    const runs: { x0: number; x1: number; z: number; d: number; customer: boolean }[] = [];
    let left = Infinity;
    if (front.length) {
      left = Math.min(...front.map((i) => i.x - i.w / 2)) - PICKUP;
      runs.push({ x0: Math.max(0.05, left), x1: W, z: front[0].z, d: front[0].d, customer: true });
    }
    if (back.length) {
      const z = back[0].z, d = back[0].d;
      const solid = back.filter((i) => i.type === "ice_maker" || i.type === "fridge").map((i) => [i.x - i.w / 2, i.x + i.w / 2]).sort((a, b) => a[0] - b[0]);
      let cur = Math.max(0.05, Math.min(left, ...back.map((i) => i.x - i.w / 2)));
      for (const [a, b] of [...solid, [W, W]]) {
        if (a - cur > 0.05) runs.push({ x0: cur, x1: a, z, d, customer: false });
        cur = Math.max(cur, b);
      }
    }
    return runs;
  }, [layout, W]);
  const backRuns = counters.filter((r) => !r.customer).map((r): [number, number] => [sx(r.x0), sx(r.x1)]);

  // 손님과 직원
  const people = useMemo(() => {
    const out: Person[] = [];
    for (const s of seats.slice(0, filled)) {
      const h = yaw(s.rot_deg);
      const bar = s.type === "bar_seat";
      out.push({ x: sx(s.x) - Math.sin(h) * 0.04, z: sz(s.z) - Math.cos(h) * 0.04, heading: h, seated: true, seed: seedOf(s.id),
        lift: bar ? STOOL - 0.46 : 0, armsUp: 0.35 });
    }
    for (const r of roster) {
      out.push({ x: sx(r.x), z: sz(r.z), heading: 0, seated: false, seed: seedOf(r.id) + 11,
        shirt: r.fits ? (r.role === "cashier" ? "#2f3a4a" : "#f2f0ea") : GHOST, apron: r.fits ? ROLE_APRON[r.role] ?? "#43648a" : GHOST });
    }
    return out;
    // sx, sz, yaw depend only on W and D
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seats, filled, roster, W, D]);
  // 앉은 손님 앞 테이블(바) 위 컵
  const cups = seats.slice(0, filled).map((s) => {
    const h = yaw(s.rot_deg), bar = s.type === "bar_seat", k = bar ? 0.5 : 0.36;
    return { id: s.id, x: sx(s.x) + Math.sin(h) * k, z: sz(s.z) + Math.cos(h) * k, y: bar ? BAR_TOP + 0.02 : 0.76 };
  });

  // 펜던트: 놓인 테이블마다(최대 14개), 창가 바 위, 앞 카운터 위
  const lamps = useMemo(() => {
    const out: [number, number][] = [];
    for (const t of layout.filter((i) => i.type === "table" && i.fits).slice(0, 14)) out.push([t.x, t.z]);
    const bar = layout.find((i) => i.type === "bar_counter" && i.fits);
    if (bar) for (let x = bar.x - bar.w / 2 + 0.6; x < bar.x + bar.w / 2; x += 1.2) out.push([x, bar.z + 0.1]);
    const fr = counters.find((r) => r.customer);
    if (fr) for (let x = fr.x0 + 0.5; x < fr.x1 - 0.2; x += 1.1) out.push([x, fr.z]);
    return out;
  }, [layout, counters]);

  // 화면에 담을 범위: 방과 방 밖 유령 구역
  const ghosts = layout.filter((i) => !i.fits);
  const gx1 = ghosts.length ? Math.max(...ghosts.map((i) => i.x + 0.6)) : W;
  const gz1 = ghosts.length ? Math.max(...ghosts.map((i) => i.z + 0.6)) : 0;
  const box: [number, number, number, number] = [-W / 2, Math.min(-D / 2, sz(gz1)), sx(Math.max(W, gx1)), D / 2 + 0.6];
  const R = Math.max(W, D) / 2 + Math.max(0, gx1 - W) + 2;
  const door = { x: sx(room.door.x), w: room.door.w };

  // everything but the guests, cups and staff: built once per layout, so an occupancy tick re-renders only the people
  const staticScene = useMemo(() => (
    <>
          {/* 바깥 땅과 인도 */}
          <Box p={[0, -0.12, 0]} s={[W + 8 + Math.max(0, gx1 - W) * 2, 0.02, D + 8]} color="#e6eaf2" receive />
          <Box p={[0, -0.1, D / 2 + 1.1]} s={[W + 8 + Math.max(0, gx1 - W) * 2, 0.02, 2]} color="#d6d3cc" receive />
          <Floor W={W} D={D} />
          {edit && (
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.015, 0]} visible={false}
              onClick={(e) => { if (e.delta > 5 || !edit.sel) return; edit.move(edit.sel, Math.max(-W / 2 + 0.5, Math.min(W / 2 - 0.5, e.point.x)), Math.max(-D / 2 + 0.5, Math.min(D / 2 - 0.5, e.point.z))); }}>
              <planeGeometry args={[W, D]} />
            </mesh>
          )}

          {/* 벽: 뒤·왼쪽·오른쪽은 카메라 쪽에서 볼 때 숨고, 앞은 유리 */}
          <Wall p={[0, WALL_H / 2, -D / 2 - 0.06]} s={[W + 0.24, WALL_H, 0.12]} color={ROOM.wall} outside={(c) => c.z < -D / 2}>
            <Box p={[0, 0.45, -D / 2 + 0.005]} s={[W, 0.9, 0.02]} color={ROOM.wainscot} />
            {backRuns.length > 0 && <BackWallDecor runs={backRuns} z={-D / 2} />}
          </Wall>
          <Wall p={[-W / 2 - 0.06, WALL_H / 2, 0]} s={[0.12, WALL_H, D]} color={ROOM.wall} outside={(c) => c.x < -W / 2}>
            <Box p={[-W / 2 + 0.005, 0.45, 0]} s={[0.02, 0.9, D]} color={ROOM.wainscot} />
          </Wall>
          <Wall p={[W / 2 + 0.06, WALL_H / 2, 0]} s={[0.12, WALL_H, D]} color={ROOM.wall} outside={(c) => c.x > W / 2} />
          {/* 줌인하면 손님 쪽 앞벽(유리 전면)이 흐려져 안쪽 배치가 보인다 (고깃집과 같은 방식) */}
          <FrontFade z={D / 2}><Storefront x0={-W / 2} x1={W / 2} z={D / 2} door={door} more={[-door.x, 0].slice(0, Math.min(3, Math.max(1, doors)) - 1).map((x) => ({ x, w: door.w }))} /></FrontFade>
          {[door.x - door.w / 2 - 0.35, door.x + door.w / 2 + 0.35].filter((x) => x > -W / 2 && x < W / 2 + 1).map((x) => (
            <group key={x} position={[x, 0, D / 2 + 0.35]}>
              <Cy p={[0, 0.2, 0]} r={0.17} r2={0.14} h={0.4} color="#b9836a" />
              <mesh position={[0, 0.66, 0]} castShadow><icosahedronGeometry args={[0.3, 0]} /><meshStandardMaterial color="#4d7a4a" flatShading roughness={0.9} /></mesh>
            </group>
          ))}

          {/* 카운터 몸통과 조각 */}
          {counters.map((r) => <Cabinet key={`${r.x0}-${r.z}`} x0={sx(r.x0)} x1={sx(r.x1)} z={sz(r.z)} d={r.d} customer={r.customer} />)}
          {layout.map((it) => (
            <Ghost.Provider key={it.id} value={!it.fits}>
              <group position={[sx(it.x), 0, sz(it.z)]} rotation={[0, yaw(it.rot_deg), 0]}
                onClick={edit && (MOVABLE.has(it.type) || owner[it.id]) ? (e) => { if (e.delta > 5) return; e.stopPropagation(); const id = owner[it.id] ?? it.id; edit.pick(edit.sel === id ? null : id); } : undefined}>
                {edit?.sel === it.id && <mesh position={[0, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]}><circleGeometry args={[0.9, 28]} /><meshBasicMaterial color="#3d63ea" transparent opacity={0.4} /></mesh>}
                {!it.fits && ON_COUNTER.has(it.type) && <Cabinet x0={-it.w / 2} x1={it.w / 2} z={0} d={it.d} />}
                <Piece it={it} />
              </group>
            </Ghost.Provider>
          ))}
          {lamps.map(([x, z], i) => <Pendant key={i} x={sx(x)} z={sz(z)} y={1.85} />)}
    </>
    // sx, sz, yaw, door and backRuns follow from W, D, room, counters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [W, D, gx1, room, layout, counters, lamps, edit, owner]);
  const gfx = useGfx();
  return (
    <>
    <div className="cs-3d" style={{ height: height === "fill" ? "100%" : height, borderRadius: height === "fill" ? 0 : undefined }} role="img"
      aria-label="카페 3D 화면. 엔진이 정한 배치대로 창가 바, 테이블과 의자, 키오스크, 카운터의 에스프레소 머신·그라인더·쇼케이스, 뒤쪽 냉장고와 제빙기, 직원과 앉은 손님을 보여 줘요. 공간이 모자라 못 놓은 것은 가게 오른쪽 밖에 빨간 반투명으로 보여요">
      <GLGuard>
        <Canvas key={gfx} frameloop={gfxFrameloop(gfx)} shadows={gfxShadows(gfx)} camera={{ position: [W * 0.55, Math.max(W, D) * 0.95, D * 1.25], fov: 40 }} dpr={gfxDpr(gfx)}>
          <StoreLights w={W} d={D} r={R} />

          {staticScene}
          {cups.map((c) => (
            <group key={c.id} position={[c.x, c.y, c.z]}>
              <mesh position={[0, 0.005, 0]}><cylinderGeometry args={[0.06, 0.06, 0.01, 14]} /><meshStandardMaterial color={MILK} /></mesh>
              <mesh position={[0, 0.045, 0]} castShadow><cylinderGeometry args={[0.04, 0.032, 0.07, 12]} /><meshStandardMaterial color={MILK} /></mesh>
            </group>
          ))}
          <People list={people} />

          <FitControls box={box} />
        </Canvas>
      </GLGuard>
    </div>
    <ViewBar />
    </>
  );
}
