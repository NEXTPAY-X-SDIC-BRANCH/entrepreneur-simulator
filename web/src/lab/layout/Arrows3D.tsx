// lab:layout — 손님 동선 on the floor: chevrons every 55 cm along each route (blue = coming in, orange = going out),
// each route shifted 12 cm to its own right so in and out read apart where they share an aisle, plus numbered stop
// tags (입구, 자리, 계산/주문). Flat meshes just above the floor; they draw over the floor but under furniture.
import { useMemo, type RefObject } from "react";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import type { Pt } from "./flow";

export const IN_COLOR = "#3d63ea", OUT_COLOR = "#e0742a";
const STEP = 0.55, Y = 0.03;

function offsetPath(p: Pt[], off: number): Pt[] {
  return p.map((q, i) => {
    const a = p[Math.max(0, i - 1)], b = p[Math.min(p.length - 1, i + 1)];
    const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1;
    return [q[0] - (dz / L) * off, q[1] + (dx / L) * off]; // right-hand side seen from above along the walk
  });
}
// points (x, z, heading) every STEP metres along a polyline
function samples(p: Pt[]): [number, number, number][] {
  const out: [number, number, number][] = [];
  let carry = STEP * 0.5;
  for (let i = 1; i < p.length; i++) {
    const [a, b] = [p[i - 1], p[i]], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1e-6) continue;
    const h = Math.atan2(b[0] - a[0], b[1] - a[1]);
    let s = carry;
    for (; s <= L; s += STEP) out.push([a[0] + ((b[0] - a[0]) * s) / L, a[1] + ((b[1] - a[1]) * s) / L, h]);
    carry = s - L;
  }
  return out;
}

function chevronGeo() {
  // a flat "V" pointing along +y of the shape, laid on the floor (+y of the shape = +z of the scene after the turn)
  const s = new THREE.Shape();
  s.moveTo(-0.16, -0.06); s.lineTo(0, 0.1); s.lineTo(0.16, -0.06); s.lineTo(0.16, -0.14); s.lineTo(0, 0.02); s.lineTo(-0.16, -0.14); s.closePath();
  const g = new THREE.ShapeGeometry(s);
  g.rotateX(Math.PI / 2); // shape +y -> scene +z, facing up
  return g;
}

function Route({ path, color, off }: { path: Pt[]; color: string; off: number }) {
  const geo = useMemo(chevronGeo, []);
  const mat = useMemo(() => new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.95, depthWrite: false }), [color]);
  const pts = useMemo(() => samples(offsetPath(path, off)), [path, off]);
  return <>{pts.map(([x, z, h], i) => <mesh key={i} geometry={geo} material={mat} position={[x, Y, z]} rotation={[0, h, 0]} renderOrder={2} />)}</>;
}

export type Stop = { label: string; x: number; z: number; tone?: "in" | "out" | "stop" };
export function FlowArrows({ inPath, outPath, stops, portal }: { inPath: Pt[]; outPath: Pt[]; stops: Stop[]; portal?: RefObject<HTMLElement | null> }) {
  return (
    <group>
      {inPath.length > 1 && <Route path={inPath} color={IN_COLOR} off={0.12} />}
      {outPath.length > 1 && <Route path={outPath} color={OUT_COLOR} off={0.12} />}
      {stops.map((s, i) => (
        <Html key={`${s.label}${i}`} portal={portal as RefObject<HTMLElement> | undefined} position={[s.x, 0.9, s.z]} center zIndexRange={[9, 0]}>
          <span className={`ly-stop is-${s.tone ?? "stop"}`}><b>{i + 1}</b>{s.label}</span>
        </Html>
      ))}
    </group>
  );
}
