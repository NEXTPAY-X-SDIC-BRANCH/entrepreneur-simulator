// The static world: the store shell (walls that hide on the camera side, a ceiling with hanging exhaust ducts),
// counter, fridge, menu board, storefront with the fascia and blade signs, neighbours, the street, and the
// shop across the street that becomes the competitor when that event is active. Procedural only.
import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { COUNTER, ROOM, type TableSpot } from "../replay/layout";
import type { Plan, Weather } from "../v2/types";
import { bladeSign, cardSign, fasciaSign, menuBoard, pricePoster, shopSign } from "./textures";

export type Glow = { mat: THREE.MeshStandardMaterial; day: number; night: number };
export type Env = { night: number; glows: Glow[] };

export const C = {
  floor: "#cbb9a0",
  tile: "#bfac92",
  wall: "#efe6d6",
  wainscot: "#8a5a3c",
  ceiling: "#3a3533",
  sidewalk: "#c9c6c0",
  street: "#5d6268",
  curb: "#b4b1ab",
  steel: "#b9bfc4",
  duct: "#c9ced2",
  counter: "#6e4a33",
  glass: "#bcd6e0",
  sign: "#7d1f16",
};

export function Box({ p, s, color, metal = 0, rough = 0.8, cast = false, receive = false, opacity = 1, mat }: {
  p: [number, number, number]; s: [number, number, number]; color?: string; metal?: number; rough?: number;
  cast?: boolean; receive?: boolean; opacity?: number; mat?: THREE.Material;
}) {
  return (
    <mesh position={p} castShadow={cast} receiveShadow={receive} material={mat}>
      <boxGeometry args={s} />
      {!mat && <meshStandardMaterial color={color} metalness={metal} roughness={rough} transparent={opacity < 1} opacity={opacity} depthWrite={opacity >= 1} />}
    </mesh>
  );
}

function useGlow(env: React.RefObject<Env>, mat: THREE.MeshStandardMaterial | null, day: number, night: number) {
  useEffect(() => {
    if (!mat || !env.current) return;
    const g = { mat, day, night };
    env.current.glows.push(g);
    return () => {
      if (env.current) env.current.glows = env.current.glows.filter((x) => x !== g);
    };
  }, [env, mat, day, night]);
}

// An emissive plane whose glow follows the dusk-to-night factor.
export function GlowPlane({ env, map, emissive, p, size, rot = [0, 0, 0], day = 0.15, night = 1.6, color = "#ffffff" }: {
  env: React.RefObject<Env>; map: THREE.Texture; emissive?: THREE.Texture; p: [number, number, number]; size: [number, number];
  rot?: [number, number, number]; day?: number; night?: number; color?: string;
}) {
  const mat = useMemo(() => new THREE.MeshStandardMaterial({ map, emissiveMap: emissive ?? map, emissive: new THREE.Color(color), emissiveIntensity: day, roughness: 0.6 }), [map, emissive, color, day]);
  useGlow(env, mat, day, night);
  return (
    <mesh position={p} rotation={rot} material={mat}>
      <planeGeometry args={size} />
    </mesh>
  );
}

// Walls hide when the camera is above the roofline on their outer side (diorama view); from inside or the
// street every wall is drawn. The ceiling hides whenever the camera is above it.
function useCutaway(ref: React.RefObject<THREE.Object3D | null>, outside: (c: THREE.Vector3) => boolean) {
  useFrame(({ camera }) => {
    if (ref.current) ref.current.visible = !(camera.position.y > ROOM.wallH + 0.6 && outside(camera.position));
  });
}

function Wall({ outside, children }: { outside: (c: THREE.Vector3) => boolean; children: React.ReactNode }) {
  const ref = useRef<THREE.Group>(null);
  useCutaway(ref, outside);
  return <group ref={ref}>{children}</group>;
}

function Ceiling({ spots }: { spots: TableSpot[] }) {
  const { x0, x1, z0, z1, wallH } = ROOM;
  const slab = useRef<THREE.Group>(null);
  useFrame(({ camera }) => {
    if (slab.current) slab.current.visible = camera.position.y < wallH;
  });
  const indoor = spots.filter((s) => !s.terrace);
  const rows = [...new Set(indoor.map((s) => s.z))];
  const ductMat = useMemo(() => new THREE.MeshStandardMaterial({ color: C.duct, metalness: 0.55, roughness: 0.35, flatShading: true, side: THREE.DoubleSide }), []);
  return (
    <group>
      <group ref={slab}>
        <Box p={[0, wallH + 0.04, (z0 + z1) / 2]} s={[x1 - x0, 0.08, z1 - z0]} color={C.ceiling} rough={0.95} />
        {[-3.5, 0, 3.5].map((x) => (
          <mesh key={x} position={[x, wallH - 0.03, -0.25]}>
            <boxGeometry args={[0.16, 0.04, 6.5]} />
            <meshStandardMaterial color="#fff6e2" emissive="#ffe7bd" emissiveIntensity={1.2} />
          </mesh>
        ))}
      </group>
      {/* soffit band: the ceiling edge stays visible in the cutaway so the ducts read as hanging from it */}
      {[[0, z0 + 0.2, x1 - x0, 0.4], [0, z1 - 0.15, x1 - x0, 0.3]].map(([x, z, w, d], i) => (
        <Box key={i} p={[x, wallH - 0.06, z]} s={[w, 0.12, d]} color={C.ceiling} />
      ))}
      {[x0 + 0.2, x1 - 0.2].map((x) => <Box key={x} p={[x, wallH - 0.06, (z0 + z1) / 2]} s={[0.4, 0.12, z1 - z0]} color={C.ceiling} />)}
      {/* trunk ducts along each table row, hung by straps, exiting through the left wall */}
      {rows.map((z) => (
        <group key={z}>
          <mesh position={[(x0 + 5.7) / 2, wallH - 0.32, z]} rotation={[0, 0, Math.PI / 2]} material={ductMat}>
            <cylinderGeometry args={[0.15, 0.15, 5.7 - x0, 12]} />
          </mesh>
          {[-5.5, -2.5, 0.5, 3.5].map((x) => <Box key={x} p={[x, wallH - 0.12, z]} s={[0.03, 0.24, 0.34]} color="#55504c" />)}
        </group>
      ))}
      {indoor.map((s) => (
        <group key={s.id}>
          {/* telescopic drop: hood at 1.5 m over the grill, pipe up into the trunk */}
          <mesh position={[s.x, 1.56, s.z]} material={ductMat}>
            <cylinderGeometry args={[0.12, 0.3, 0.22, 14, 1, true]} />
          </mesh>
          <mesh position={[s.x, 1.67, s.z]} material={ductMat}>
            <cylinderGeometry args={[0.12, 0.12, 0.02, 14]} />
          </mesh>
          <mesh position={[s.x, 1.98, s.z]} material={ductMat}>
            <cylinderGeometry args={[0.09, 0.09, 0.62, 10]} />
          </mesh>
          <mesh position={[s.x, 2.34, s.z]} material={ductMat}>
            <cylinderGeometry args={[0.105, 0.105, 0.14, 10]} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

// The drinks fridge behind the counter: an open shell behind glass, so the soju shelves and the top shelf of 원육
// trays read from the floor (the welcome tour's 냉장고 stop frames it).
function Fridge() {
  const z = ROOM.z0;
  const bottles = useMemo(() => {
    const out: [number, number, number][] = [];
    for (let shelf = 0; shelf < 3; shelf++) for (let i = 0; i < 7; i++) out.push([4.45 + i * 0.18, 0.42 + shelf * 0.42, z + 0.42]);
    return out;
  }, [z]);
  return (
    <group>
      <Box p={[5.0, 0.98, z + 0.07]} s={[1.6, 1.96, 0.04]} color="#f2f5f6" />
      {[4.22, 5.78].map((x) => <Box key={x} p={[x, 0.98, z + 0.36]} s={[0.04, 1.96, 0.62]} color="#e6eaec" metal={0.2} rough={0.4} />)}
      <Box p={[5.0, 1.94, z + 0.36]} s={[1.6, 0.04, 0.62]} color="#e6eaec" metal={0.2} rough={0.4} />
      <Box p={[5.0, 0.1, z + 0.36]} s={[1.6, 0.2, 0.62]} color="#d5dadd" metal={0.2} rough={0.4} />
      {[0, 1, 2, 3].map((k) => <Box key={k} p={[5.0, 0.29 + k * 0.42, z + 0.38]} s={[1.52, 0.02, 0.5]} color="#cfd6da" metal={0.3} rough={0.3} />)}
      <pointLight position={[5.0, 1.75, z + 0.45]} intensity={1.6} distance={1.6} decay={2} color="#eaf4ff" />
      <Box p={[5.0, 1.84, z + 0.68]} s={[1.5, 0.16, 0.02]} color="#2f8f5b" />
      {bottles.map((b, i) => (
        <mesh key={i} position={b}>
          <cylinderGeometry args={[0.04, 0.045, 0.24, 7]} />
          <meshStandardMaterial color={i % 7 === 6 ? "#b78a2a" : "#2f8f5b"} roughness={0.3} />
        </mesh>
      ))}
      {[0, 1, 2, 3].map((i) => (
        <group key={i} position={[4.5 + i * 0.33, 1.575, z + 0.4]}>
          <Box p={[0, 0, 0]} s={[0.28, 0.03, 0.3]} color="#f4f1ea" />
          <Box p={[0, 0.04, 0]} s={[0.24, 0.05, 0.25]} color={i === 3 ? "#d98c84" : "#e9a19a"} rough={0.6} />
        </group>
      ))}
      <Box p={[5.0, 0.98, z + 0.68]} s={[1.5, 1.8, 0.02]} color={C.glass} opacity={0.16} />
    </group>
  );
}

function Neighbour({ env, x0, x1, h, sign, signBg, signFg, depth = 8, front = ROOM.z1, color, facing = 1, cut = false }: {
  env: React.RefObject<Env>; x0: number; x1: number; h: number; sign: string; signBg: string; signFg: string; depth?: number; front?: number;
  color: string; facing?: 1 | -1; cut?: boolean;
}) {
  // buildings on our side are sectioned at the first floor in the diorama view so they never hide the store
  const full = useRef<THREE.Group>(null);
  const low = useRef<THREE.Group>(null);
  useFrame(({ camera }) => {
    const sectioned = cut && camera.position.y > 7;
    if (full.current) full.current.visible = !sectioned;
    if (low.current) low.current.visible = sectioned;
  });
  const w = x1 - x0;
  const cx = (x0 + x1) / 2;
  const back = front - facing * depth;
  const cz = (front + back) / 2;
  const tex = useMemo(() => shopSign(sign, signBg, signFg), [sign, signBg, signFg]);
  const winMat = useMemo(() => new THREE.MeshStandardMaterial({ color: "#2d3646", emissive: "#ffd79a", emissiveIntensity: 0.05, roughness: 0.3 }), []);
  useGlow(env, winMat, 0.03, 0.9);
  const floors = Math.max(0, Math.floor((h - 3.4) / 3));
  return (
    <group>
      <group ref={full}>
        <Box p={[cx, h / 2, cz]} s={[w, h, depth]} color={color} rough={0.9} />
        {Array.from({ length: floors }, (_, f) => Array.from({ length: Math.max(1, Math.floor(w / 2.2)) }, (_, k) => (
          <Box key={`${f}-${k}`} p={[x0 + 1.1 + k * 2.2, 5 + f * 3, front + facing * 0.02]} s={[1.3, 1.4, 0.04]} mat={winMat} />
        )))}
      </group>
      {cut && (
        <group ref={low} visible={false}>
          <Box p={[cx, 1.8, cz]} s={[w, 3.6, depth]} color={color} rough={0.9} />
          <Box p={[cx, 3.61, cz]} s={[w - 0.3, 0.02, depth - 0.3]} color="#8f877b" />
        </group>
      )}
      <Box p={[cx, 1.35, front + facing * 0.01]} s={[w - 0.6, 2.3, 0.04]} mat={winMat} />
      <GlowPlane env={env} map={tex} p={[cx, 3.05, front + facing * 0.06]} size={[Math.min(w - 0.6, 6), 1.1]} rot={[0, facing === 1 ? 0 : Math.PI, 0]} />
    </group>
  );
}

// The shop across the street: "임대 문의" paper when vacant; a new 고깃집 with a balloon arch and an opening
// banner when the competitor event is active.
function AcrossShop({ env, competitor }: { env: React.RefObject<Env>; competitor: boolean }) {
  const front = 16.6;
  const signTex = useMemo(() => competitor ? shopSign("화로상회 숯불구이", "#1d2a44", "#ffd36b", 900, 170, 88) : shopSign("임대 문의", "#f4f1ea", "#3a3a3a", 600, 160, 80), [competitor]);
  const banner = useMemo(() => shopSign("개업 기념 삼겹살 30% 할인", "#ffe14d", "#b0201a", 1024, 140, 70), []);
  const balloons = useMemo(() => {
    const out: { p: [number, number, number]; c: string }[] = [];
    const cols = ["#e8423b", "#ffd23f", "#2f80ed", "#ffffff"];
    for (let i = 0; i <= 18; i++) {
      const a = (i / 18) * Math.PI;
      out.push({ p: [6.4 - Math.cos(a) * 1.25, 0.25 + Math.sin(a) * 2.0, front - 1.1], c: cols[i % 4] });
    }
    return out;
  }, []);
  const inside = useMemo(() => new THREE.MeshStandardMaterial({ color: competitor ? "#3a2a1c" : "#b9b4aa", emissive: "#ffcf8a", emissiveIntensity: 0, roughness: 0.4 }), [competitor]);
  useGlow(env, inside, competitor ? 0.2 : 0, competitor ? 1.4 : 0);
  return (
    <group>
      <Box p={[8.5, 5, front + 4]} s={[8.6, 10, 8]} color={competitor ? "#55606f" : "#a9a39a"} rough={0.9} />
      <Box p={[8.5, 1.35, front - 0.02]} s={[7.8, 2.3, 0.04]} mat={inside} />
      <GlowPlane env={env} map={signTex} p={[8.5, 3.15, front - 0.07]} size={[7.4, 1.4]} rot={[0, Math.PI, 0]} day={competitor ? 0.3 : 0.05} night={competitor ? 2.2 : 0.2} />
      {!competitor && <Box p={[8.5, 1.4, front - 0.06]} s={[2.4, 1.2, 0.02]} color="#f7f3ea" />}
      {competitor && (
        <group>
          <GlowPlane env={env} map={banner} p={[8.5, 2.35, front - 0.1]} size={[6.6, 0.9]} rot={[0, Math.PI, 0]} day={0.3} night={1.4} />
          {balloons.map((b, i) => (
            <mesh key={i} position={b.p}>
              <sphereGeometry args={[0.22, 10, 8]} />
              <meshStandardMaterial color={b.c} roughness={0.35} />
            </mesh>
          ))}
          {/* tube dancer */}
          <mesh position={[11.8, 1.6, front - 1.2]} rotation={[0, 0, 0.18]}>
            <cylinderGeometry args={[0.2, 0.26, 3.2, 8]} />
            <meshStandardMaterial color="#ff5a1f" roughness={0.5} />
          </mesh>
        </group>
      )}
    </group>
  );
}

function StreetLamp({ env, x, z, facing }: { env: React.RefObject<Env>; x: number; z: number; facing: 1 | -1 }) {
  const head = useMemo(() => new THREE.MeshStandardMaterial({ color: "#f3efe4", emissive: "#ffd9a0", emissiveIntensity: 0 }), []);
  useGlow(env, head, 0, 3);
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, 2.6, 0]}>
        <cylinderGeometry args={[0.06, 0.08, 5.2, 8]} />
        <meshStandardMaterial color="#4a4f55" metalness={0.5} roughness={0.5} />
      </mesh>
      <Box p={[0, 5.15, facing * 0.5]} s={[0.12, 0.1, 1.0]} color="#4a4f55" />
      <mesh position={[0, 5.05, facing * 0.95]} material={head}>
        <boxGeometry args={[0.36, 0.1, 0.5]} />
      </mesh>
    </group>
  );
}

function XBanner({ env, amount }: { env: React.RefObject<Env>; amount: number }) {
  const tex = useMemo(() => bladeSign("SNS인증", "#e8423b", "#ffffff"), []);
  const h = 1.5 + Math.min(1, amount / 3_000_000) * 0.5;
  return (
    <group position={[-1.6, 0, ROOM.z1 + 1.3]} rotation={[0, 0.5, 0]}>
      <GlowPlane env={env} map={tex} p={[0, h / 2 + 0.1, 0]} size={[0.5, h]} day={0.25} night={1.2} />
      <Box p={[0, 0.05, 0]} s={[0.6, 0.1, 0.35]} color="#3a3a3a" />
    </group>
  );
}

export function Building({ env, spots, plan, competitor, weather, storeName = "대학로 삼겹살" }: {
  env: React.RefObject<Env>; spots: TableSpot[]; plan: Plan; competitor: boolean; weather: Weather; storeName?: string;
}) {
  const { x0, x1, z0, z1, wallH } = ROOM;
  const w = x1 - x0;
  const fascia = useMemo(() => fasciaSign(storeName, "생삼겹살 전문  목살  소주"), [storeName]);
  const blade = useMemo(() => bladeSign("삼겹살", "#f6efe2", "#7d1f16"), []);
  const menu = useMemo(() => menuBoard(plan), [plan]);
  const poster = useMemo(() => pricePoster(plan), [plan]);
  const lunchTex = useMemo(() => cardSign("점심 특선 9,000원", "#1f6b4e", "#ffffff", 360, 180, 44), []);
  const wet = weather === "rain";
  const streetMat = useMemo(() => new THREE.MeshStandardMaterial({ color: wet ? "#3f454c" : C.street, roughness: wet ? 0.18 : 0.92, metalness: wet ? 0.35 : 0 }), [wet]);
  const walkMat = useMemo(() => new THREE.MeshStandardMaterial({ color: wet ? "#9a9894" : weather === "snow" ? "#eef0f2" : C.sidewalk, roughness: wet ? 0.3 : 0.95, metalness: wet ? 0.15 : 0 }), [wet, weather]);
  const neonMat = useMemo(() => new THREE.MeshStandardMaterial({ color: "#ff5a4a", emissive: "#ff3b2f", emissiveIntensity: 0.2 }), []);
  useGlow(env, neonMat, 0.3, 3.2);
  useEffect(() => () => { menu.dispose(); poster.dispose(); }, [menu, poster]);

  return (
    <group>
      {/* ground */}
      {/* floor tone follows the 청결 lever: greasy and stained at 기본, bright at 철저 */}
      <Box p={[0, -0.02, (z0 + z1) / 2]} s={[w, 0.04, z1 - z0]} color={plan.hygiene === "basic" ? "#a99579" : plan.hygiene === "high" ? "#ddd0bb" : C.floor} receive rough={0.85} />
      {plan.hygiene === "basic" && [[-4.6, -0.3], [-1.2, 0.4], [2.3, -0.6], [4.8, 0.2], [0.6, 2.5], [-3, 2.8]].map(([x, z], i) => (
        <mesh key={i} position={[x, 0.004, z]} rotation={[-Math.PI / 2, 0, 0]}>
          <circleGeometry args={[0.28 + (i % 3) * 0.12, 12]} />
          <meshStandardMaterial color="#7d6a52" transparent opacity={0.55} depthWrite={false} />
        </mesh>
      ))}
      {plan.marketing_budget > 0 && <XBanner env={env} amount={plan.marketing_budget} />}
      {plan.lunch && (
        <mesh position={[-2.3, 1.45, z1 + 0.03]}>
          <planeGeometry args={[0.9, 0.45]} />
          <meshStandardMaterial map={lunchTex} emissive="#ffffff" emissiveMap={lunchTex} emissiveIntensity={0.3} />
        </mesh>
      )}
      {Array.from({ length: 7 }, (_, i) => <Box key={i} p={[x0 + 1 + i * 2, 0.002, (z0 + z1) / 2]} s={[0.02, 0.002, z1 - z0]} color={C.tile} />)}
      <mesh position={[0, -0.03, 5.6]} receiveShadow material={walkMat}><boxGeometry args={[48, 0.04, 4.4]} /></mesh>
      <Box p={[0, 0.04, 7.85]} s={[48, 0.12, 0.18]} color={C.curb} />
      <mesh position={[0, -0.06, 11.0]} receiveShadow material={streetMat}><boxGeometry args={[48, 0.04, 6.2]} /></mesh>
      {Array.from({ length: 8 }, (_, i) => <Box key={i} p={[-2.6 + i * 0.75, -0.035, 11]} s={[0.42, 0.01, 5.2]} color="#e9e7e1" />)}
      {[-20, -14, 6, 12, 18].map((x) => <Box key={x} p={[x, -0.035, 11]} s={[2.4, 0.01, 0.12]} color="#e0c25a" />)}
      <Box p={[0, 0.04, 14.15]} s={[48, 0.12, 0.18]} color={C.curb} />
      <mesh position={[0, -0.03, 15.4]} receiveShadow material={walkMat}><boxGeometry args={[48, 0.04, 2.6]} /></mesh>
      <Box p={[0, -0.06, -10]} s={[48, 0.04, 10.8]} color="#cfc8bc" receive />

      {/* walls */}
      <Wall outside={(c) => c.z < z0}>
        <Box p={[0, wallH / 2, z0]} s={[w, wallH, 0.14]} color={C.wall} receive />
        <Box p={[0, 0.5, z0 + 0.08]} s={[w, 1.0, 0.03]} color={C.wainscot} />
        <Box p={[COUNTER[0] - 2.2, 1.65, z0 + 0.09]} s={[1.6, 0.7, 0.04]} color="#f7f3ea" />
      </Wall>
      <Wall outside={(c) => c.x < x0}>
        <Box p={[x0, wallH / 2, (z0 + z1) / 2]} s={[0.14, wallH, z1 - z0]} color={C.wall} receive />
        <Box p={[x0 + 0.08, 0.5, (z0 + z1) / 2]} s={[0.03, 1.0, z1 - z0]} color={C.wainscot} />
        <mesh position={[x0 + 0.1, 1.72, -0.2]} rotation={[0, Math.PI / 2, 0]}>
          <planeGeometry args={[1.25, 1.48]} />
          <meshStandardMaterial map={menu} roughness={0.7} emissive="#ffffff" emissiveMap={menu} emissiveIntensity={0.25} />
        </mesh>
      </Wall>
      <Wall outside={(c) => c.x > x1}>
        <Box p={[x1, wallH / 2, (z0 + z1) / 2]} s={[0.14, wallH, z1 - z0]} color={C.wall} receive />
        <Box p={[x1 - 0.08, 0.5, (z0 + z1) / 2]} s={[0.03, 1.0, z1 - z0]} color={C.wainscot} />
      </Wall>
      {/* storefront: glass with a door gap at x = 0, fascia sign, blade sign, price poster */}
      <group>
        {[-1, 1].map((sgn) => (
          <group key={sgn}>
            <Box p={[sgn * (0.8 + (x1 - 0.8) / 2), 0.3, z1]} s={[x1 - 0.8, 0.6, 0.16]} color={C.wainscot} />
            <Box p={[sgn * (0.8 + (x1 - 0.8) / 2), 1.45, z1]} s={[x1 - 0.8, 1.7, 0.03]} color={C.glass} opacity={0.18} />
            <Box p={[sgn * 0.8, 1.15, z1]} s={[0.08, 2.3, 0.12]} color="#5b5248" metal={0.4} />
            <Box p={[sgn * (x1 - 0.04), 1.4, z1]} s={[0.1, 2.8, 0.16]} color="#5b5248" />
          </group>
        ))}
        <Box p={[0, 2.32, z1]} s={[w, 0.06, 0.14]} color="#5b5248" />
        <Box p={[0, 2.95, z1 + 0.02]} s={[w + 0.1, 0.9, 0.2]} color="#4a2a20" />
        <GlowPlane env={env} map={fascia.map} emissive={fascia.emissive} p={[0, 2.95, z1 + 0.13]} size={[5.4, 1.0]} day={0.25} night={2.4} />
        <mesh position={[0, 2.43, z1 + 0.14]} material={neonMat}>
          <boxGeometry args={[5.6, 0.04, 0.04]} />
        </mesh>
        <group position={[-x1 + 0.6, 2.3, z1 + 0.7]}>
          <Box p={[0, 0, 0]} s={[0.12, 1.8, 1.0]} color="#e9dfcc" />
          <GlowPlane env={env} map={blade} p={[0.07, 0, 0]} size={[0.8, 1.6]} rot={[0, Math.PI / 2, 0]} day={0.2} night={1.6} />
          <GlowPlane env={env} map={blade} p={[-0.07, 0, 0]} size={[0.8, 1.6]} rot={[0, -Math.PI / 2, 0]} day={0.2} night={1.6} />
          <Box p={[0, 0.1, -0.55]} s={[0.06, 0.06, 0.2]} color="#5b5248" />
        </group>
        <mesh position={[2.3, 1.45, z1 + 0.03]}>
          <planeGeometry args={[0.8, 1.04]} />
          <meshStandardMaterial map={poster} roughness={0.7} emissive="#ffffff" emissiveMap={poster} emissiveIntensity={0.3} />
        </mesh>
      </group>
      <Ceiling spots={spots} />
      {/* counter, kitchen pass, fridge, POS */}
      <Box p={[COUNTER[0], 0.5, COUNTER[1]]} s={[3.6, 1.0, 0.7]} color={C.counter} cast />
      <Box p={[COUNTER[0], 1.03, COUNTER[1]]} s={[3.7, 0.06, 0.8]} color="#e4ddd2" />
      <Box p={[COUNTER[0] + 1.3, 1.16, COUNTER[1] + 0.1]} s={[0.36, 0.22, 0.26]} color="#2c2f33" />
      <Box p={[COUNTER[0] - 0.8, 1.12, COUNTER[1]]} s={[1.2, 0.12, 0.5]} color="#9aa0a6" metal={0.6} rough={0.3} />
      <Fridge />
      {/* a few stacked crates of empties by the back door */}
      {[0, 1, 2].map((i) => <Box key={i} p={[6.4, 0.15 + i * 0.3, -3.9]} s={[0.5, 0.28, 0.35]} color="#2f7a52" />)}

      {/* neighbours on our side, then across the street */}
      <Neighbour env={env} x0={-17} x1={-7.15} h={7.4} sign="소극장 커피" signBg="#2f4a3a" signFg="#f2ead8" color="#d9d2c4" cut />
      <Neighbour env={env} x0={7.15} x1={17} h={10.2} sign="공연 티켓 할인" signBg="#f2c94c" signFg="#262626" color="#c8c3bb" cut />
      <Neighbour env={env} x0={-18} x1={-6} h={9} sign="코인 노래연습장" signBg="#3a2f6b" signFg="#ffe9a8" front={16.6} facing={-1} color="#bdb6aa" />
      <Neighbour env={env} x0={-6} x1={4} h={6.5} sign="마로니에 약국" signBg="#ffffff" signFg="#1d6b4e" front={16.6} facing={-1} color="#d6d0c6" />
      <AcrossShop env={env} competitor={competitor} />
      <Neighbour env={env} x0={13} x1={22} h={8} sign="분식" signBg="#e65b2a" signFg="#fff6e5" front={16.6} facing={-1} color="#cfc9be" />
      {[-10.5, 9.5].map((x) => <StreetLamp key={x} env={env} x={x} z={7.55} facing={1} />)}
      {[-16, -5.5, 5.5, 16].map((x) => (
        <group key={x} position={[x, 0, 14.9]}>
          <mesh position={[0, 0.9, 0]}><cylinderGeometry args={[0.08, 0.1, 1.8, 6]} /><meshStandardMaterial color="#6b5440" /></mesh>
          <mesh position={[0, 2.6, 0]}><icosahedronGeometry args={[1.1, 0]} /><meshStandardMaterial color={weather === "snow" ? "#e9ecef" : "#c9a34a"} flatShading roughness={0.9} /></mesh>
        </group>
      ))}
    </group>
  );
}
