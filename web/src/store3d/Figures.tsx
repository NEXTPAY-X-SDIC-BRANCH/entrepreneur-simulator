// Low-poly people drawn with instanced parts (torso, head, hair, four leg segments, two arms, apron, umbrella),
// so a busy night of 200+ figures stays one draw call per part. Proportions in meters: a standing adult is
// 1.70 m, hips at 0.86; seated on a 0.45 m stool the shoulders sit about 0.3 m above the 0.72 m table top.
import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

export type FigPose = {
  visible: boolean;
  x: number;
  z: number;
  heading: number; // radians; forward = (sin h, 0, cos h)
  seated: boolean;
  walk: number; // gait phase in radians, NaN when standing still
  scale: number;
  shirt: THREE.Color;
  pants: THREE.Color;
  skin: THREE.Color;
  hair: THREE.Color;
  apron: THREE.Color | null;
  umbrella: THREE.Color | null;
  armsUp: number; // 0..1, forearms toward the table (eating, grilling)
};

export function blankPose(): FigPose {
  return { visible: false, x: 0, z: 0, heading: 0, seated: false, walk: NaN, scale: 1, shirt: new THREE.Color(), pants: new THREE.Color(),
    skin: new THREE.Color(), hair: new THREE.Color(), apron: null, umbrella: null, armsUp: 0 };
}

const limbGeo = (() => {
  const g = new THREE.CylinderGeometry(1, 0.85, 1, 6);
  g.translate(0, -0.5, 0);
  return g;
})();
const torsoGeo = (() => {
  const g = new THREE.CylinderGeometry(0.5, 0.42, 1, 6);
  g.rotateY(Math.PI / 6);
  return g;
})();
const headGeo = new THREE.IcosahedronGeometry(1, 1);
const hairGeo = new THREE.SphereGeometry(1, 8, 5, 0, Math.PI * 2, 0, Math.PI * 0.55);
const apronGeo = new THREE.BoxGeometry(1, 1, 1);
const umbrellaGeo = (() => {
  const g = new THREE.ConeGeometry(1, 0.32, 8, 1, true);
  return g;
})();

const m4 = new THREE.Matrix4();
const q = new THREE.Quaternion();
const e = new THREE.Euler(0, 0, 0, "YXZ");
const v = new THREE.Vector3();
const s = new THREE.Vector3();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

function place(mesh: THREE.InstancedMesh, i: number, x: number, y: number, z: number, heading: number, pitch: number, sx: number, sy: number, sz: number) {
  e.set(pitch, heading, 0);
  q.setFromEuler(e);
  m4.compose(v.set(x, y, z), q, s.set(sx, sy, sz));
  mesh.setMatrixAt(i, m4);
}

// world position of a body-local offset (ox right, oz forward)
function at(p: FigPose, ox: number, oz: number): [number, number] {
  const c = Math.cos(p.heading), sn = Math.sin(p.heading);
  return [p.x + ox * c + oz * sn, p.z - ox * sn + oz * c];
}

export function Figures({ count, poseAt, castShadow = true }: { count: number; poseAt: (i: number, out: FigPose, t: number) => void; castShadow?: boolean }) {
  const refs = useRef<Record<string, THREE.InstancedMesh | null>>({});
  const pose = useMemo(blankPose, []);
  const mats = useMemo(() => {
    const mk = (rough = 0.75) => new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: rough, flatShading: true });
    const umb = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.5, side: THREE.DoubleSide, flatShading: true });
    return { torso: mk(), head: mk(0.6), hair: mk(0.9), limb: mk(), apron: mk(0.85), umbrella: umb };
  }, []);
  const n = Math.max(1, count);

  useFrame((state) => {
    const r = refs.current;
    const torso = r.torso, head = r.head, hair = r.hair, limb = r.limb, apron = r.apron, umbrella = r.umbrella;
    if (!torso || !head || !hair || !limb || !apron || !umbrella) return;
    const clock = state.clock.elapsedTime;
    for (let i = 0; i < count; i++) {
      poseAt(i, pose, clock);
      const cam = state.camera.position;
      if (pose.visible && cam.y < 2.2 && Math.hypot(pose.x - cam.x, pose.z - cam.z) < 0.7) pose.visible = false;
      if (!pose.visible) {
        torso.setMatrixAt(i, ZERO);
        head.setMatrixAt(i, ZERO);
        hair.setMatrixAt(i, ZERO);
        apron.setMatrixAt(i, ZERO);
        umbrella.setMatrixAt(i, ZERO);
        for (let k = 0; k < 6; k++) limb.setMatrixAt(i * 6 + k, ZERO);
        continue;
      }
      const k = pose.scale;
      const h = pose.heading;
      const seated = pose.seated;
      const hipY = (seated ? 0.47 : 0.86) * (seated ? 1 : k);
      const torsoH = 0.58 * k;
      const torsoMid = hipY + torsoH / 2;
      const shoulderY = hipY + torsoH - 0.05 * k;
      const headY = hipY + torsoH + 0.14 * k;
      place(torso, i, pose.x, torsoMid, pose.z, h, 0, 0.42 * k, torsoH, 0.26 * k);
      torso.setColorAt(i, pose.shirt);
      const [hx, hz] = at(pose, 0, 0.01);
      place(head, i, hx, headY, hz, h, 0, 0.115 * k, 0.125 * k, 0.115 * k);
      head.setColorAt(i, pose.skin);
      const [hrx, hrz] = at(pose, 0, -0.018);
      place(hair, i, hrx, headY + 0.012 * k, hrz, h, -0.25, 0.124 * k, 0.13 * k, 0.124 * k);
      hair.setColorAt(i, pose.hair);
      if (pose.apron) {
        const [ax, az] = at(pose, 0, 0.12 * k);
        place(apron, i, ax, hipY + 0.12 * k, az, h, 0, 0.36 * k, 0.62 * k, 0.03);
        apron.setColorAt(i, pose.apron);
      } else apron.setMatrixAt(i, ZERO);
      if (pose.umbrella) {
        const [ux, uz] = at(pose, 0.12, 0.05);
        place(umbrella, i, ux, 2.02 * k, uz, h, 0, 0.55, 1, 0.55);
        umbrella.setColorAt(i, pose.umbrella);
      } else umbrella.setMatrixAt(i, ZERO);

      // legs: thigh + shin per side
      const gait = Number.isNaN(pose.walk) ? 0 : Math.sin(pose.walk) * 0.5;
      for (let side = 0; side < 2; side++) {
        const sx = (side ? 1 : -1) * 0.1 * k;
        const [lx, lz] = at(pose, sx, 0);
        const swing = side ? gait : -gait;
        if (seated) {
          place(limb, i * 6 + side * 2, lx, hipY, lz, h, -Math.PI / 2, 0.075, 0.42, 0.075);
          const [kx, kz] = at(pose, sx, 0.42);
          place(limb, i * 6 + side * 2 + 1, kx, hipY, kz, h, 0, 0.062, hipY - 0.03, 0.062);
        } else {
          const thigh = 0.43 * k;
          place(limb, i * 6 + side * 2, lx, hipY, lz, h, -swing, 0.078 * k, thigh, 0.078 * k);
          const kneeY = hipY - Math.cos(swing) * thigh;
          const [kx, kz] = at(pose, sx, Math.sin(swing) * thigh);
          place(limb, i * 6 + side * 2 + 1, kx, kneeY, kz, h, -swing * 0.4 + (swing < 0 ? 0.35 : 0), 0.064 * k, kneeY - 0.02, 0.064 * k);
        }
        limb.setColorAt(i * 6 + side * 2, pose.pants);
        limb.setColorAt(i * 6 + side * 2 + 1, pose.pants);
      }
      // arms
      for (let side = 0; side < 2; side++) {
        const sx = (side ? 1 : -1) * 0.25 * k;
        const [ax, az] = at(pose, sx, 0);
        const swing = Number.isNaN(pose.walk) ? 0 : (side ? -gait : gait) * 0.8;
        const lift = pose.umbrella && side === 1 ? -1.1 : -pose.armsUp * 1.05 + swing;
        place(limb, i * 6 + 4 + side, ax, shoulderY, az, h + (side ? -0.3 : 0.3) * pose.armsUp, lift, 0.055 * k, 0.56 * k, 0.055 * k);
        limb.setColorAt(i * 6 + 4 + side, pose.shirt);
      }
    }
    for (const m of [torso, head, hair, limb, apron, umbrella]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  });

  const set = (key: string) => (m: THREE.InstancedMesh | null) => {
    refs.current[key] = m;
    if (m) {
      for (let i = 0; i < m.count; i++) {
        m.setMatrixAt(i, ZERO);
        m.setColorAt(i, new THREE.Color("#ffffff"));
      }
      m.frustumCulled = false;
    }
  };
  return (
    <group>
      <instancedMesh ref={set("torso")} args={[torsoGeo, mats.torso, n]} castShadow={castShadow} />
      <instancedMesh ref={set("head")} args={[headGeo, mats.head, n]} castShadow={castShadow} />
      <instancedMesh ref={set("hair")} args={[hairGeo, mats.hair, n]} />
      <instancedMesh ref={set("limb")} args={[limbGeo, mats.limb, n * 6]} castShadow={castShadow} />
      <instancedMesh ref={set("apron")} args={[apronGeo, mats.apron, n]} />
      <instancedMesh ref={set("umbrella")} args={[umbrellaGeo, mats.umbrella, n]} castShadow={castShadow} />
    </group>
  );
}

// Deterministic per-person variety inside a segment's palette.
export function hash(n: number) {
  let x = (n * 2654435761) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 2246822519) >>> 0;
  x ^= x >>> 13;
  return (x >>> 0) / 4294967296;
}
