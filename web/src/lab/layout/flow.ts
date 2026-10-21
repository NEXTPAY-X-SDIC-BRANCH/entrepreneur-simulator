// lab:layout — customer routes on a 25 cm floor grid. Pure geometry, no React, so the node test can run it.
// A person needs a cell whose centre is at least INFLATE clear of furniture (a 0.5 m gap between tables still passes,
// sideways). The route prefers wide aisles: a step where the aisle is under AISLE_OK costs extra, so arrows follow
// the main walkway when there is one. Aisle width at a cell ≈ 2 × distance to the nearest blocked cell.
// AISLE_OK 0.9 m: research/cafe/params.yaml layout.aisle (AJD 인테리어 가이드 테이블 간격 90~120cm, grade L).

export type Rect = { x0: number; z0: number; x1: number; z1: number };
export type Pt = [number, number];
export const CELL = 0.25, INFLATE = 0.1, AISLE_OK = 0.9;

export const rectOf = (x: number, z: number, w: number, d: number, pad = 0): Rect => ({ x0: x - w / 2 - pad, z0: z - d / 2 - pad, x1: x + w / 2 + pad, z1: z + d / 2 + pad });
export const overlaps = (a: Rect, b: Rect, eps = 1e-6) => a.x0 < b.x1 - eps && b.x0 < a.x1 - eps && a.z0 < b.z1 - eps && b.z0 < a.z1 - eps;
export const inside = (r: Rect, x: number, z: number) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1;

export type Grid = { b: Rect; nx: number; nz: number; walk: Uint8Array; width: Float32Array; raw: Uint8Array };
const cx = (g: Grid, i: number) => g.b.x0 + (i % g.nx + 0.5) * CELL;
const cz = (g: Grid, i: number) => g.b.z0 + (Math.floor(i / g.nx) + 0.5) * CELL;
export const cellPt = (g: Grid, i: number): Pt => [cx(g, i), cz(g, i)];

export function makeGrid(bounds: Rect, obstacles: Rect[]): Grid {
  const nx = Math.max(1, Math.round((bounds.x1 - bounds.x0) / CELL)), nz = Math.max(1, Math.round((bounds.z1 - bounds.z0) / CELL));
  const raw = new Uint8Array(nx * nz); // furniture without the body margin, for aisle width
  const g: Grid = { b: bounds, nx, nz, walk: new Uint8Array(nx * nz), width: new Float32Array(nx * nz), raw };
  for (let i = 0; i < nx * nz; i++) {
    const x = cx(g, i), z = cz(g, i);
    let w = 1, r = 0;
    for (const o of obstacles) {
      if (x > o.x0 - INFLATE && x < o.x1 + INFLATE && z > o.z0 - INFLATE && z < o.z1 + INFLATE) w = 0;
      if (x > o.x0 && x < o.x1 && z > o.z0 && z < o.z1) r = 1;
    }
    if (x < bounds.x0 + INFLATE || x > bounds.x1 - INFLATE || z < bounds.z0 + INFLATE || z > bounds.z1 - INFLATE) w = 0;
    g.walk[i] = w;
    raw[i] = r;
  }
  // distance to the nearest furniture cell or wall (chamfer 1 / √2 passes), width = 2 × distance
  const INF = 1e9, dist = new Float32Array(nx * nz);
  for (let i = 0; i < nx * nz; i++) {
    const ix = i % nx, iz = Math.floor(i / nx);
    const wall = Math.min(ix + 0.5, nx - ix - 0.5, iz + 0.5, nz - iz - 0.5) * CELL;
    dist[i] = raw[i] ? 0 : Math.min(INF, wall);
  }
  const D = CELL, Q = CELL * Math.SQRT2;
  for (let pass = 0; pass < 2; pass++) {
    const order = pass === 0 ? [...Array(nx * nz).keys()] : [...Array(nx * nz).keys()].reverse();
    const nb: [number, number, number][] = pass === 0 ? [[-1, 0, D], [0, -1, D], [-1, -1, Q], [1, -1, Q]] : [[1, 0, D], [0, 1, D], [1, 1, Q], [-1, 1, Q]];
    for (const i of order) {
      const ix = i % nx, iz = Math.floor(i / nx);
      for (const [dx, dz, c] of nb) {
        const jx = ix + dx, jz = iz + dz;
        if (jx < 0 || jz < 0 || jx >= nx || jz >= nz) continue;
        const v = dist[jz * nx + jx] + c;
        if (v < dist[i]) dist[i] = v;
      }
    }
  }
  for (let i = 0; i < nx * nz; i++) g.width[i] = 2 * dist[i];
  return g;
}

export function cellAt(g: Grid, x: number, z: number): number {
  const ix = Math.min(g.nx - 1, Math.max(0, Math.floor((x - g.b.x0) / CELL)));
  const iz = Math.min(g.nz - 1, Math.max(0, Math.floor((z - g.b.z0) / CELL)));
  return iz * g.nx + ix;
}
// the walkable cell nearest a point (the door step, a POS front) within `reach` metres
export function nearestWalk(g: Grid, x: number, z: number, reach = 1.2): number {
  let best = -1, bd = Infinity;
  for (let i = 0; i < g.nx * g.nz; i++) {
    if (!g.walk[i]) continue;
    const d = Math.hypot(cx(g, i) - x, cz(g, i) - z);
    if (d < bd && d <= reach) { bd = d; best = i; }
  }
  return best;
}

export type Field = { dist: Float32Array; prev: Int32Array };
// Dijkstra from one cell over walkable cells, 8 neighbours (no corner cutting); a step through an aisle narrower than
// AISLE_OK costs 1.8×, so of two routes the one along the wider aisle wins unless it is much longer
export function field(g: Grid, start: number): Field {
  const n = g.nx * g.nz, dist = new Float32Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1);
  if (start < 0) return { dist, prev };
  const cost = new Float32Array(n).fill(Infinity); // weighted cost; `dist` keeps metres
  const heap: [number, number][] = [];
  const push = (c: number, i: number) => { heap.push([c, i]); let k = heap.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
  const pop = () => { const top = heap[0], last = heap.pop()!; if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top; };
  cost[start] = 0; dist[start] = 0; push(0, start);
  while (heap.length) {
    const [c, i] = pop();
    if (c > cost[i]) continue;
    const ix = i % g.nx, iz = Math.floor(i / g.nx);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dz) continue;
      const jx = ix + dx, jz = iz + dz;
      if (jx < 0 || jz < 0 || jx >= g.nx || jz >= g.nz) continue;
      const j = jz * g.nx + jx;
      if (!g.walk[j]) continue;
      if (dx && dz && (!g.walk[iz * g.nx + jx] || !g.walk[jz * g.nx + ix])) continue;
      const step = (dx && dz ? Math.SQRT2 : 1) * CELL;
      const w = step * (g.width[j] < AISLE_OK ? 1.8 : 1);
      if (c + w < cost[j]) { cost[j] = c + w; dist[j] = dist[i] + step; prev[j] = i; push(cost[j], j); }
    }
  }
  return { dist, prev };
}
// best reachable cell next to a rectangle (a table's edge, within `pad` metres)
export function reachRect(g: Grid, f: Field, r: Rect, pad = 0.45): number {
  let best = -1, bd = Infinity;
  for (let i = 0; i < g.nx * g.nz; i++) {
    if (!g.walk[i] || !(f.dist[i] < bd)) continue;
    const x = cx(g, i), z = cz(g, i);
    const dx = Math.max(r.x0 - x, 0, x - r.x1), dz = Math.max(r.z0 - z, 0, z - r.z1);
    if (Math.hypot(dx, dz) <= pad) { bd = f.dist[i]; best = i; }
  }
  return best;
}
export function trace(g: Grid, f: Field, end: number): Pt[] {
  const out: Pt[] = [];
  for (let i = end; i >= 0; i = f.prev[i]) out.push(cellPt(g, i));
  return out.reverse();
}
// drop points that sit on a straight line between their neighbours
export function simplify(p: Pt[]): Pt[] {
  if (p.length < 3) return p;
  const out: Pt[] = [p[0]];
  for (let i = 1; i < p.length - 1; i++) {
    const [a, b, c] = [out[out.length - 1], p[i], p[i + 1]];
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(cross) > 1e-6) out.push(b);
  }
  out.push(p[p.length - 1]);
  return out;
}
export const polyLen = (p: Pt[]) => p.reduce((n, q, i) => (i ? n + Math.hypot(q[0] - p[i - 1][0], q[1] - p[i - 1][1]) : 0), 0);
// metres of a path that run through a rectangle / through aisles narrower than AISLE_OK (sampled every 5 cm)
export function lenWhere(p: Pt[], test: (x: number, z: number) => boolean): number {
  let n = 0;
  for (let i = 1; i < p.length; i++) {
    const [a, b] = [p[i - 1], p[i]], L = Math.hypot(b[0] - a[0], b[1] - a[1]), k = Math.max(1, Math.ceil(L / 0.05));
    for (let s = 0; s < k; s++) {
      const t = (s + 0.5) / k;
      if (test(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)) n += L / k;
    }
  }
  return n;
}
// aisle width across the walking direction at a point: free floor to the left plus to the right (5 cm steps) until
// furniture or a wall, so walking along a wall in an open room is not "narrow"
function crossWidth(g: Grid, x: number, z: number, nx: number, nz: number): number {
  let w = 0;
  for (const s of [1, -1]) {
    for (let t = 0.05; t < 3; t += 0.05) {
      const px = x + s * nx * t, pz = z + s * nz * t;
      if (px <= g.b.x0 || px >= g.b.x1 || pz <= g.b.z0 || pz >= g.b.z1 || g.raw[cellAt(g, px, pz)]) { w += t; break; }
      if (t + 0.05 >= 3) w += 3;
    }
  }
  return w;
}
export function narrowLen(g: Grid, p: Pt[]): number {
  let n = 0;
  for (let i = 1; i < p.length; i++) {
    const [a, b] = [p[i - 1], p[i]], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1e-9) continue;
    const nx = -(b[1] - a[1]) / L, nz = (b[0] - a[0]) / L, k = Math.max(1, Math.ceil(L / 0.05));
    for (let s = 0; s < k; s++) {
      const t = (s + 0.5) / k;
      if (crossWidth(g, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, nx, nz) < AISLE_OK - 1e-6) n += L / k;
    }
  }
  return n;
}
// the part of a path more than `a` metres from its start and `b` from its end (door steps and seat approaches are
// tight by nature, so the aisle check skips them)
export function trimPath(p: Pt[], a: number, b: number): Pt[] {
  const L = polyLen(p);
  if (L <= a + b) return [];
  const at = (s: number): Pt => {
    let acc = 0;
    for (let i = 1; i < p.length; i++) {
      const l = Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
      if (acc + l >= s) { const t = (s - acc) / Math.max(1e-9, l); return [p[i - 1][0] + (p[i][0] - p[i - 1][0]) * t, p[i - 1][1] + (p[i][1] - p[i - 1][1]) * t]; }
      acc += l;
    }
    return p[p.length - 1];
  };
  const out: Pt[] = [at(a)];
  let acc = 0;
  for (let i = 1; i < p.length; i++) {
    acc += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
    if (acc > a && acc < L - b) out.push(p[i]);
  }
  out.push(at(L - b));
  return out;
}
