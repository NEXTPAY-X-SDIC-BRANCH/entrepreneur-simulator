// lab:layout — the four walls of a store with its door and windows, for both 3D stores (고깃집 Room, 카페 CafeRoom3D).
// Scene frame: room centred on the origin, front (street) wall at +z. Each wall is built in its own strip frame
// (x along the wall from its start corner: front/back from the left, left/right from the front) and placed by a group.
// A real gap is cut for the door (frame, an open glass leaf, a mat and a small "출입문" tag that reads in every view),
// windows are glass panes in the wall (sill 0.9 m). The front wall with a window is the glass storefront (Scene3D's
// Storefront when the door is in it). Back, left and right walls hide on the camera side like Scene3D's Wall.
import { useRef, type ReactNode, type RefObject } from "react";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import { Box, C } from "../../store3d/Building";
import { FrontFade, Storefront, WALL_H } from "../../mock/Scene3D";
import { DOOR_W, WIN, doorAlong, wallLen, windowSpans, type RoomShape, type Wall } from "./shape";
import "./layout.css";

const T = 0.12; // wall thickness
const FRAME = "#4f555c";
type Open = { a: number; b: number; y0: number; y1: number; kind: "door" | "window" };

// hide when the camera is above the roofline on the wall's outer side (Scene3D Wall's rule)
function Hide({ outside, children }: { outside: (c: THREE.Vector3) => boolean; children: ReactNode }) {
  const ref = useRef<THREE.Group>(null);
  useFrame(({ camera }) => {
    if (ref.current) ref.current.visible = !(camera.position.y > WALL_H + 0.6 && outside(camera.position));
  });
  return <group ref={ref}>{children}</group>;
}

// a solid wall strip from 0 to len (strip frame) with openings; `inward` = +1/-1 side of the strip facing the room
function Strip({ len, opens, color, wainscot, inward }: { len: number; opens: Open[]; color: string; wainscot?: string; inward: 1 | -1 }) {
  const cuts = [...opens].sort((p, q) => p.a - q.a);
  const solid: [number, number][] = [];
  let cur = 0;
  for (const o of cuts) { if (o.a - cur > 0.01) solid.push([cur, o.a]); cur = Math.max(cur, o.b); }
  if (len - cur > 0.01) solid.push([cur, len]);
  const X = (u: number) => u - len / 2;
  const wz = inward * (T / 2 + 0.006);
  return (
    <group>
      {solid.map(([a, b]) => <Box key={`s${a}`} p={[X((a + b) / 2), WALL_H / 2, 0]} s={[b - a, WALL_H, T]} color={color} receive />)}
      {cuts.map((o) => (
        <group key={`o${o.a}`}>
          {o.y0 > 0.01 && <Box p={[X((o.a + o.b) / 2), o.y0 / 2, 0]} s={[o.b - o.a, o.y0, T]} color={color} receive />}
          <Box p={[X((o.a + o.b) / 2), (o.y1 + WALL_H) / 2, 0]} s={[o.b - o.a, WALL_H - o.y1, T]} color={color} receive />
          {o.kind === "window" && (
            <group>
              <Box p={[X((o.a + o.b) / 2), (o.y0 + o.y1) / 2, 0]} s={[o.b - o.a, o.y1 - o.y0, 0.02]} color={C.glass} opacity={0.28} />
              <Box p={[X((o.a + o.b) / 2), o.y0 + 0.02, 0]} s={[o.b - o.a + 0.06, 0.05, T + 0.06]} color={FRAME} />
              <Box p={[X((o.a + o.b) / 2), o.y1 - 0.02, 0]} s={[o.b - o.a + 0.06, 0.05, T + 0.02]} color={FRAME} />
              {[o.a, (o.a + o.b) / 2, o.b].map((u) => <Box key={u} p={[X(u), (o.y0 + o.y1) / 2, 0]} s={[0.05, o.y1 - o.y0, T + 0.02]} color={FRAME} />)}
            </group>
          )}
        </group>
      ))}
      {wainscot && solid.map(([a, b]) => <Box key={`w${a}`} p={[X((a + b) / 2), 0.45, wz]} s={[b - a, 0.9, 0.012]} color={wainscot} />)}
    </group>
  );
}

// the door in a strip: posts, header, a glass leaf standing open to the outside, a mat inside, the tag
function DoorPiece({ at, len, inward, portal, label }: { at: number; len: number; inward: 1 | -1; portal?: RefObject<HTMLElement | null>; label: string }) {
  const x = at - len / 2, hw = DOOR_W / 2;
  return (
    <group>
      {[-1, 1].map((s) => <Box key={s} p={[x + s * (hw + 0.03), 1.05, 0]} s={[0.06, 2.1, T + 0.04]} color={FRAME} />)}
      <Box p={[x, 2.13, 0]} s={[DOOR_W + 0.12, 0.07, T + 0.04]} color={FRAME} />
      <group position={[x + hw, 0, -inward * (T / 2 + 0.02)]} rotation={[0, -inward * 1.15, 0]}>
        <Box p={[-hw * 0.95, 1.04, 0]} s={[DOOR_W * 0.9, 2.02, 0.03]} color={C.glass} opacity={0.3} />
        <Box p={[-DOOR_W * 0.92, 1.04, 0]} s={[0.04, 2.04, 0.05]} color={FRAME} />
        <Box p={[-DOOR_W * 0.78, 1.0, -inward * 0.04]} s={[0.025, 0.45, 0.025]} color={C.steel} metal={0.6} />
      </group>
      <Box p={[x, 0.008, inward * 0.5]} s={[DOOR_W, 0.014, 0.8]} color="#3d4a63" />
      <Html portal={portal as RefObject<HTMLElement> | undefined} position={[x, 2.5, -inward * 0.25]} center zIndexRange={[8, 0]}>
        <span className="ly-door-tag">{label}</span>
      </Html>
    </group>
  );
}

// glass front without a door: base rail, head rail, glass, mullions every ~2.2 m (Storefront's look)
function GlassRun({ x0, x1, z }: { x0: number; x1: number; z: number }) {
  const n = Math.max(1, Math.round((x1 - x0) / 2.2)), pw = (x1 - x0) / n, m = (x0 + x1) / 2;
  return (
    <group>
      <Box p={[m, 0.09, z]} s={[x1 - x0, 0.18, 0.09]} color={FRAME} />
      <Box p={[m, WALL_H - 0.04, z]} s={[x1 - x0, 0.08, 0.09]} color={FRAME} />
      <Box p={[m, WALL_H / 2 + 0.05, z]} s={[x1 - x0, WALL_H - 0.26, 0.02]} color={C.glass} opacity={0.16} />
      {Array.from({ length: n + 1 }, (_, i) => <Box key={i} p={[x0 + pw * i, WALL_H / 2, z]} s={[0.05, WALL_H, 0.08]} color={FRAME} />)}
    </group>
  );
}

export function Shell({ w, d, shape, margin, color, wainscot, decor = {}, portal, storefrontMat = false }: {
  w: number; d: number; shape: RoomShape; margin: number; color: string; wainscot?: string;
  decor?: Partial<Record<Wall, ReactNode>>; portal?: RefObject<HTMLElement | null>; storefrontMat?: boolean;
}) {
  const dw = shape.door.wall, at = doorAlong(shape, w, d, margin);
  const doorSpan: [number, number] = [at - DOOR_W / 2, at + DOOR_W / 2];
  const label = "출입문";
  const strips: { wall: Wall; pos: [number, number, number]; rot: number; inward: 1 | -1; ext: number; outside: (c: THREE.Vector3) => boolean }[] = [
    { wall: "back", pos: [0, 0, -d / 2 - T / 2], rot: 0, inward: 1, ext: T, outside: (c) => c.z < -d / 2 },
    { wall: "left", pos: [-w / 2 - T / 2, 0, 0], rot: Math.PI / 2, inward: 1, ext: 0, outside: (c) => c.x < -w / 2 },
    { wall: "right", pos: [w / 2 + T / 2, 0, 0], rot: Math.PI / 2, inward: -1, ext: 0, outside: (c) => c.x > w / 2 },
  ];
  const frontGlass = shape.windows.includes("front");
  return (
    <group>
      {strips.map((s) => {
        const len = wallLen(s.wall, w, d) + 2 * s.ext;
        const door = dw === s.wall ? ([doorSpan[0] + s.ext, doorSpan[1] + s.ext] as [number, number]) : null;
        const opens: Open[] = [];
        if (door) opens.push({ a: door[0], b: door[1], y0: 0, y1: 2.1, kind: "door" });
        if (shape.windows.includes(s.wall)) for (const [a, b] of windowSpans(len, door)) opens.push({ a, b, y0: WIN.sill, y1: WIN.head, kind: "window" });
        // left wall strip runs front→back = scene -z, so the strip's local +x must point to -z: rotation +π/2 does that
        return (
          <group key={s.wall}>
            <group position={s.pos} rotation={[0, s.rot, 0]}>
              <Hide outside={s.outside}>
                <Strip len={len} opens={opens} color={color} wainscot={wainscot} inward={s.inward} />
              </Hide>
              {/* skirting stays when the wall hides, with the door gap kept */}
              {(door ? [[0, door[0]], [door[1], len]] : [[0, len]]).filter(([a, b]) => b - a > 0.02).map(([a, b]) => (
                <Box key={a} p={[(a + b) / 2 - len / 2, 0.06, 0]} s={[b - a, 0.12, T]} color={color} />
              ))}
              {door && <DoorPiece at={(door[0] + door[1]) / 2} len={len} inward={s.inward} portal={portal} label={label} />}
            </group>
            {decor[s.wall] && <Hide outside={s.outside}>{decor[s.wall]}</Hide>}
          </group>
        );
      })}
      {/* front (street side): glass storefront with or without the door, or a plain wall when it has no window */}
      <FrontFade z={d / 2 + 0.04}>
        {frontGlass && dw === "front" && <Storefront x0={-w / 2} x1={w / 2} z={d / 2 + 0.04} door={{ x: -w / 2 + at, w: DOOR_W }} mat={storefrontMat} />}
        {frontGlass && dw !== "front" && <GlassRun x0={-w / 2} x1={w / 2} z={d / 2 + 0.04} />}
        {!frontGlass && (
          <group position={[0, 0, d / 2 + T / 2]}>
            <Strip len={w} opens={dw === "front" ? [{ a: doorSpan[0], b: doorSpan[1], y0: 0, y1: 2.1, kind: "door" }] : []} color={color} wainscot={wainscot} inward={-1} />
          </group>
        )}
        {decor.front}
      </FrontFade>
      {dw === "front" && (
        <group position={[0, 0, d / 2 + T / 2]}>
          {!frontGlass && <DoorPiece at={at} len={w} inward={-1} portal={portal} label={label} />}
          {frontGlass && (
            <group>
              <Box p={[-w / 2 + at, 0.008, -0.5]} s={[DOOR_W, 0.014, 0.8]} color="#3d4a63" />
              <Html portal={portal as RefObject<HTMLElement> | undefined} position={[-w / 2 + at, 2.5, 0.3]} center zIndexRange={[8, 0]}>
                <span className="ly-door-tag">{label}</span>
              </Html>
            </group>
          )}
        </group>
      )}
    </group>
  );
}
