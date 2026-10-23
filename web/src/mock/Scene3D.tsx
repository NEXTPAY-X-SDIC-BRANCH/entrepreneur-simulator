// Shared pieces for the ChangeUp store scenes (고깃집 and 카페): walls that hide on the camera side, a storefront of
// glass with the door gap, pendant lamps, low-poly people (store3d/Figures) seated or standing, and orbit controls
// that frame the room for any canvas size. Scene frame: room centred on the origin, front (street) wall at +z.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Environment, Lightformer, OrbitControls, SoftShadows } from "@react-three/drei";
import { N8AOPass } from "n8ao";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { SMAAPass } from "three/examples/jsm/postprocessing/SMAAPass.js";
import * as THREE from "three";
import "./scene3d.css";
import { Box, C } from "../store3d/Building";
import { Figures, hash, type FigPose } from "../store3d/Figures";

export const WALL_H = 2.6;

// A wall that hides when the camera is above the roofline on its outer side, so the default view looks in over it.
// A low skirting stays so the room keeps its outline.
export function Wall({ p, s, color, outside, children }: {
  p: [number, number, number]; s: [number, number, number]; color: string; outside: (c: THREE.Vector3) => boolean; children?: React.ReactNode;
}) {
  const ref = useRef<THREE.Group>(null);
  useFrame(({ camera }) => {
    if (ref.current) ref.current.visible = !(camera.position.y > WALL_H + 0.6 && outside(camera.position));
  });
  return (
    <>
      <group ref={ref}>
        <Box p={p} s={s} color={color} receive />
        {children}
      </group>
      <Box p={[p[0], 0.06, p[2]]} s={[s[0], 0.12, s[2]]} color={color} />
    </>
  );
}

// 줌인하면 손님 쪽 앞벽(유리 전면과 간판)이 희미해졌다가 사라지고, 줌아웃하면 돌아온다. 가게 안 배치를 가까이서 볼 수 있게 한다.
// 거리 비율 = 카메라와 목표 사이 거리 ÷ 처음 맞춘 거리(FitControls가 적는 fitInfo.dist). FADE_START보다 가까우면 흐려지기 시작해 FADE_END에서 사라진다.
// 앞쪽(z > 앞벽)에서 볼 때만 적용한다. 장면이 '바뀐 것이 있을 때만 그리기'라서 카메라가 움직여 다시 그릴 때만 계산된다.
export const fitInfo = { dist: 0 };
const FADE_START = 0.95, FADE_END = 0.72;
export function FrontFade({ z, children }: { z: number; children: React.ReactNode }) {
  const ref = useRef<THREE.Group>(null);
  const controls = useThree((s) => s.controls) as { target: THREE.Vector3 } | null;
  useFrame(({ camera }) => {
    const g = ref.current;
    if (!g || !controls || !fitInfo.dist) return;
    const ratio = camera.position.distanceTo(controls.target) / fitInfo.dist;
    const t = camera.position.z > z ? THREE.MathUtils.clamp((FADE_START - ratio) / (FADE_START - FADE_END), 0, 1) : 0;
    const f = 1 - t;
    g.visible = f > 0.04;
    if (!g.visible) return;
    g.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (!m) return;
      for (const x of Array.isArray(m) ? m : [m]) {
        const d = (x.userData.fade ??= { op: x.opacity, tr: x.transparent, dw: x.depthWrite });
        x.opacity = d.op * f; x.transparent = f < 1 || d.tr; x.depthWrite = f < 1 ? false : d.dw;
      }
    });
  });
  return <group ref={ref}>{children}</group>;
}

// Glass front along z, from x0 to x1, with the door gap (door.x = gap centre). Thin frame so it barely hides the room.
// more: 두 번째·세 번째 출입문 (그 자리도 유리벽을 비우고 문을 단다)
export function Storefront({ x0, x1, z, door, more = [], frame = "#4f555c", mat = true }: { x0: number; x1: number; z: number; door: { x: number; w: number }; more?: { x: number; w: number }[]; frame?: string; mat?: boolean }) {
  const H = WALL_H;
  const gaps = [door, ...more].map((d) => [Math.max(x0, d.x - d.w / 2), Math.min(x1, d.x + d.w / 2)] as [number, number]).sort((a, b) => a[0] - b[0]);
  const cuts = [x0, ...gaps.flat(), x1];
  const segs = Array.from({ length: gaps.length + 1 }, (_, i) => [cuts[i * 2], cuts[i * 2 + 1]] as [number, number]).filter(([a, b]) => b - a > 0.05);
  return (
    <group>
      {segs.map(([a, b]) => {
        const n = Math.max(1, Math.round((b - a) / 2.2)), pw = (b - a) / n, m = (a + b) / 2;
        return (
          <group key={a}>
            <Box p={[m, 0.09, z]} s={[b - a, 0.18, 0.09]} color={frame} />
            <Box p={[m, H - 0.04, z]} s={[b - a, 0.08, 0.09]} color={frame} />
            <Box p={[m, H / 2 + 0.05, z]} s={[b - a, H - 0.26, 0.02]} color={C.glass} opacity={0.16} />
            {Array.from({ length: n + 1 }, (_, i) => <Box key={i} p={[a + pw * i, H / 2, z]} s={[0.05, H, 0.08]} color={frame} />)}
          </group>
        );
      })}
      {/* door: header and transom over the gap, a leaf standing open to the street (inside stays clear), a mat */}
      {gaps.map(([dl, dr]) => (
        <group key={dl}>
          <Box p={[(dl + dr) / 2, 2.12, z]} s={[dr - dl, 0.07, 0.09]} color={frame} />
          <Box p={[(dl + dr) / 2, (2.15 + H) / 2, z]} s={[dr - dl, H - 2.2, 0.02]} color={C.glass} opacity={0.16} />
          <group position={[dr - 0.02, 0, z + 0.04]} rotation={[0, 1.2, 0]}>
            <Box p={[-(dr - dl) * 0.45, 1.06, 0]} s={[(dr - dl) * 0.9, 2.04, 0.02]} color={C.glass} opacity={0.22} />
            <Box p={[-(dr - dl) * 0.9, 1.06, 0]} s={[0.04, 2.04, 0.05]} color={frame} />
            <Box p={[-(dr - dl) * 0.75, 1.0, 0.04]} s={[0.025, 0.5, 0.025]} color={C.steel} metal={0.6} />
          </group>
          {mat && <Box p={[(dl + dr) / 2, 0.006, z - 0.45]} s={[dr - dl, 0.012, 0.7]} color="#4a4f55" />}
        </group>
      ))}
    </group>
  );
}

// A pendant lamp hanging from the (undrawn) ceiling: cord, shade, warm bulb.
export function Pendant({ x, z, y = 1.8, color = "#2f3337" }: { x: number; z: number; y?: number; color?: string }) {
  const top = WALL_H + 0.25;
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, (top + y) / 2, 0]}><cylinderGeometry args={[0.008, 0.008, top - y, 4]} /><meshStandardMaterial color="#1d1f22" /></mesh>
      <mesh position={[0, y - 0.09, 0]} castShadow>
        <coneGeometry args={[0.17, 0.2, 18, 1, true]} />
        <meshStandardMaterial color={color} roughness={0.5} metalness={0.2} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[0, y - 0.17, 0]}><sphereGeometry args={[0.05, 10, 8]} /><meshStandardMaterial color="#fff3d6" emissive="#ffd38a" emissiveIntensity={1.4} /></mesh>
    </group>
  );
}

// The light rig shared by both stores: soft (PCSS) shadows from one warm sun at the front-left sized to the room
// (r = half the span to cover), a small studio environment of Lightformers for soft reflections (no HDR download),
// low sky and fill, ambient occlusion and SMAA. dim < 1 darkens it (a closed day).
// Ambient occlusion (n8ao) as the render pass, then tone mapping/colour space (OutputPass) and SMAA, since hardware
// antialiasing does not apply once the scene renders through a composer. Takes over R3F's render (priority 1).
function AO() {
  const gl = useThree((s) => s.gl), scene = useThree((s) => s.scene), camera = useThree((s) => s.camera), size = useThree((s) => s.size);
  const composer = useMemo(() => {
    try {
      const c = new EffectComposer(gl);
      const n8 = new N8AOPass(scene, camera, size.width, size.height);
      n8.configuration.aoRadius = 0.9;
      n8.configuration.distanceFalloff = 0.6;
      n8.configuration.intensity = 3;
      n8.configuration.gammaCorrection = false;
      n8.configuration.halfRes = true; // a quarter of the AO pixels: keeps laptop integrated GPUs (Windows Intel/AMD) smooth
      c.addPass(n8);
      c.addPass(new OutputPass());
      c.addPass(new SMAAPass());
      return c;
    } catch (e) {
      console.warn("ambient occlusion unavailable, plain render:", e);
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, scene, camera]);
  useLayoutEffect(() => composer?.setSize(size.width, size.height), [composer, size]);
  // a GPU/driver that fails inside the composer falls back to the plain render for good (errors here skip React's boundary)
  const broken = useRef(false);
  useFrame(() => {
    if (composer && !broken.current) {
      try {
        composer.render();
        return;
      } catch (e) {
        broken.current = true;
        console.warn("ambient occlusion failed, plain render:", e);
      }
    }
    gl.render(scene, camera);
  }, 1);
  return null;
}
// ---------------------------------------------------------------- viewer settings shared by every 3D canvas
// Camera angle preset (no drag-rotate: the camera only moves when one of these is picked) and graphics quality.
// Quality starts from a GPU check (software GL or an Intel HD/UHD laptop chip -> lite), drops to lite on its own if
// its typical frame runs under 20 fps, and a choice made with the toggle wins and is remembered in this browser.
export type View = "front" | "top" | "side";
export type Gfx = "lite" | "hi";
const GFX_KEY = "changeup.gfx";
let curView: View = "front";
let curGfx: Gfx | null = null;
let gfxAuto = true;
const subs = new Set<() => void>();
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));
function detectGfx(): Gfx {
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) return "lite";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const r = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return /swiftshader|llvmpipe|software|basic render|intel\(r\) u?hd graphics/i.test(r) ? "lite" : "hi";
  } catch {
    return "lite";
  }
}
function readGfx(): Gfx {
  if (curGfx) return curGfx;
  try {
    const v = localStorage.getItem(GFX_KEY);
    if (v === "lite" || v === "hi") { gfxAuto = false; return (curGfx = v); }
  } catch { /* storage blocked: fall back to the GPU check */ }
  return (curGfx = detectGfx());
}
export function setGfx(g: Gfx, byUser: boolean) {
  curGfx = g;
  if (byUser) {
    gfxAuto = false;
    try { localStorage.setItem(GFX_KEY, g); } catch { /* not remembered, still applied */ }
  }
  subs.forEach((f) => f());
}
export function setView(v: View) {
  curView = v;
  subs.forEach((f) => f());
}
export const useGfx = () => useSyncExternalStore(subscribe, readGfx);
export const useView = () => useSyncExternalStore(subscribe, () => curView);
// canvas props per quality; the canvases key on the quality so a switch rebuilds shaders cleanly
export const gfxDpr = (g: Gfx): number | [number, number] => (g === "hi" ? [1, 2] : 1);
export const gfxShadows = (g: Gfx) => g === "hi";
// Both qualities render on demand: a frame is drawn only when something changed (a React update in the scene, a zoom,
// a resize, a camera preset), so an idle screen costs nothing. People do not animate between engine ticks, so no
// steady ticker is needed. After mount the canvas runs back-to-back for a short warm-up (shader compiles, the
// environment map, and the fps check below), then goes quiet.
export const gfxFrameloop = (_g: Gfx): "always" | "demand" => "demand";
function Warmup({ seconds }: { seconds: number }) {
  useFrame(({ clock, invalidate }) => {
    if (clock.getElapsedTime() < seconds) invalidate();
  });
  return null;
}
// one frame after every React render of the scene (people seated, items placed, plan changed); the instanced figures
// change only inside useFrame, which R3F cannot see as a prop change
function RenderOnUpdate() {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => { invalidate(); });
  return null;
}

// auto quality only: if the typical frame after warm-up is slow (median frame time over 3 s, after 2 s for shader
// compiles, above 50 ms = under 20 fps) the canvas switches to lite. The median ignores one-off compile stalls.
function FpsWatch() {
  const t = useRef({ start: -1, last: -1, dts: [] as number[], done: false });
  useFrame(({ clock }) => {
    const s = t.current;
    if (s.done || !gfxAuto || curGfx !== "hi") return;
    const now = clock.getElapsedTime();
    if (now < 2) return;
    if (s.start < 0) { s.start = s.last = now; return; }
    s.dts.push(now - s.last);
    s.last = now;
    if (now - s.start >= 3) {
      s.done = true;
      const sorted = [...s.dts].sort((x, y) => x - y);
      if (sorted[Math.floor(sorted.length / 2)] > 0.05) setGfx("lite", false);
    }
  });
  return null;
}

const VIEWS: [View, string][] = [["front", "정면"], ["top", "위에서"], ["side", "측면"]];
const GFXS: [Gfx, string][] = [["lite", "가볍게"], ["hi", "선명하게"]];
// small toolbar laid over the bottom-right corner of the canvas container (outside the <Canvas>)
export function ViewBar() {
  const v = useView(), g = useGfx();
  return (
    <div className="v3-bar" role="toolbar" aria-label="3D 보기 설정">
      <div className="v3-group" role="group" aria-label="보는 각도">
        {VIEWS.map(([k, l]) => <button key={k} type="button" aria-pressed={v === k} onClick={() => setView(k)}>{l}</button>)}
      </div>
      <div className="v3-group" role="group" aria-label="그래픽">
        <span className="v3-lbl">그래픽</span>
        {GFXS.map(([k, l]) => <button key={k} type="button" aria-pressed={g === k} onClick={() => setGfx(k, true)}>{l}</button>)}
      </div>
    </div>
  );
}

export function StoreLights({ w, d, r, dim = 1 }: { w: number; d: number; r: number; dim?: number }) {
  const hi = useGfx() === "hi";
  const map = hi ? 2048 : 1024;
  return (
    <>
      <color attach="background" args={["#e9eef6"]} />
      {hi && <SoftShadows size={22} samples={14} focus={0.4} />}
      {hi && <Environment resolution={128} frames={1} environmentIntensity={dim}>
        <Lightformer intensity={1.1} position={[0, 8, 0]} rotation-x={Math.PI / 2} scale={[14, 14, 1]} color="#fff4e4" />
        <Lightformer intensity={0.7} position={[-8, 3, 6]} rotation-y={Math.PI / 4} scale={[8, 3, 1]} color="#ffe2c0" />
        <Lightformer intensity={0.45} position={[8, 3, -6]} rotation-y={-Math.PI / 3} scale={[8, 3, 1]} color="#dfe8ff" />
      </Environment>}
      {/* lite: no environment map and no shadows, so the hemisphere and ambient carry the fill the environment gave */}
      <hemisphereLight args={["#fff7ea", "#c9c2b6", (hi ? 0.35 : 1.05) * dim]} />
      <ambientLight intensity={(hi ? 0.12 : 0.45) * dim} />
      <directionalLight position={[-w * 0.4, 12, d * 0.6 + 4]} intensity={1.9 * dim} color="#fff0dc" castShadow={hi} shadow-mapSize={[map, map]} shadow-bias={-0.0004}
        shadow-camera-left={-r} shadow-camera-right={r} shadow-camera-top={r} shadow-camera-bottom={-r} shadow-camera-far={40} />
      {hi && <AO />}
      {hi ? <><FpsWatch /><Warmup seconds={5.5} /></> : <Warmup seconds={1} />}
      <RenderOnUpdate />
    </>
  );
}

// ---- people
export type Person = {
  x: number; z: number; heading: number; // forward = (sin h, 0, cos h)
  seated: boolean; seed: number; lift?: number; // lift raises a seated person onto a tall stool
  shirt?: string; apron?: string | null; armsUp?: number;
};
const SHIRTS = ["#e0735a", "#3f6fb5", "#e9c46a", "#6a8f5b", "#9b6fb0", "#f2f0ea", "#2f3a4a", "#d98aa0", "#4f9aa3", "#b5654a"];
const PANTS = ["#2f3a4a", "#3b3f45", "#5a4a3c", "#2c4a6b", "#6b6f75"];
const SKIN = ["#f1d3b8", "#e8c19c", "#d9a97f", "#f5dcc6"];
const HAIR = ["#1f1a17", "#3a2a20", "#5b4030", "#2a2522", "#7a5a3a"];
const pick = (a: string[], seed: number, k: number) => a[Math.floor(hash(seed * 7 + k) * a.length)];

function Crowd({ list }: { list: Person[] }) {
  const cols = useMemo(() => list.map((p) => ({
    shirt: new THREE.Color(p.shirt ?? pick(SHIRTS, p.seed, 1)), pants: new THREE.Color(pick(PANTS, p.seed, 2)),
    skin: new THREE.Color(pick(SKIN, p.seed, 3)), hair: new THREE.Color(pick(HAIR, p.seed, 4)),
    apron: p.apron ? new THREE.Color(p.apron) : null, scale: 0.94 + 0.1 * hash(p.seed * 7 + 5),
  })), [list]);
  const poseAt = useCallback((i: number, out: FigPose) => {
    const p = list[i], c = cols[i];
    if (!p || !c) { out.visible = false; return; }
    out.visible = true; out.x = p.x; out.z = p.z; out.heading = p.heading; out.seated = p.seated; out.walk = NaN;
    out.scale = c.scale; out.shirt = c.shirt; out.pants = c.pants; out.skin = c.skin; out.hair = c.hair;
    out.apron = c.apron; out.umbrella = null; out.armsUp = p.armsUp ?? 0;
  }, [list, cols]);
  return <Figures count={list.length} poseAt={poseAt} />;
}

// Figures has no height offset, so people on tall stools go in their own lifted group.
export function People({ list }: { list: Person[] }) {
  const groups = useMemo(() => {
    const m = new Map<number, Person[]>();
    for (const p of list) {
      const k = p.lift ?? 0;
      m.set(k, [...(m.get(k) ?? []), p]);
    }
    return [...m.entries()];
  }, [list]);
  return <>{groups.map(([lift, ps]) => <group key={lift} position={[0, lift, 0]}><Crowd list={ps} /></group>)}</>;
}

// ---- camera
// Camera controls that frame a box [x0, z0, x1, z1] (plus WALL_H of height) from the front-right, for whatever size the
// canvas has, with room left for the panels laid over it. Re-frames when the box or the canvas size changes; between
// those the camera stays put: no drag-rotate or pan, only zoom (the 정면/위에서/측면 buttons change the angle).
export function FitControls({ box, dir = [0.55, 0.95, 1.25], pad = 1.25, lift = 0 }: {
  box: [number, number, number, number]; dir?: [number, number, number]; pad?: number; lift?: number;
}) {
  const view = useView();
  const front = dir;
  dir = view === "top" ? [0, 1, 0.06] : view === "side" ? [1.3, 0.75, 0.22] : front;
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);
  const invalidate = useThree((s) => s.invalidate);
  const ctl = useRef<React.ComponentRef<typeof OrbitControls>>(null);
  const [dist, setDist] = useState(12);
  const [x0, z0, x1, z1] = box;
  useLayoutEffect(() => {
    const target = new THREE.Vector3((x0 + x1) / 2, 0.5 + lift, (z0 + z1) / 2);
    const fwd = new THREE.Vector3(...dir).normalize().negate(); // camera -> target
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(right, fwd);
    const tv = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2), th = tv * (size.width / Math.max(1, size.height));
    let d = 0;
    const p = new THREE.Vector3();
    for (const x of [x0, x1]) for (const y of [0, WALL_H]) for (const z of [z0, z1]) {
      p.set(x, y, z).sub(target);
      const f = p.dot(fwd);
      d = Math.max(d, Math.abs(p.dot(right)) / th - f, Math.abs(p.dot(up)) / tv - f);
    }
    d *= pad;
    camera.position.copy(target).addScaledVector(fwd, -d);
    camera.near = 0.1;
    camera.far = d * 6 + 50;
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    if (ctl.current) {
      // limits first: update() clamps to them, and the props still hold the previous fit's distance on first mount
      ctl.current.minDistance = Math.min(4, d * 0.5);
      ctl.current.maxDistance = d * 1.8;
      ctl.current.target.copy(target);
      ctl.current.update();
    }
    setDist(d);
    fitInfo.dist = d;
    invalidate();
    // dir is a constant per caller; the box is compared by value
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x0, z0, x1, z1, lift, size.width, size.height, camera, pad, view, invalidate]);
  return <OrbitControls ref={ctl} makeDefault enableRotate={false} enablePan={false} minDistance={Math.min(4, dist * 0.5)} maxDistance={dist * 1.8} minPolarAngle={0} maxPolarAngle={Math.PI / 2} />;
}
