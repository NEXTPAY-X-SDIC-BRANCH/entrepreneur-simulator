// Store geometry in meters. x: left/right, z: toward the street (front), y: up.
// Counts come from hero.json (sto_tables, sto_terrace); everything else is a drawing choice.
import type { Hero } from "../data";

export type V2 = [number, number];
export type TableSpot = { id: string; x: number; z: number; terrace: boolean; seats: V2[]; serve: V2 };

export const ROOM = { x0: -7, x1: 7, z0: -4.6, z1: 3.4, wallH: 2.8 };
export const DOOR_IN: V2 = [0, 2.8];
export const DOOR_OUT: V2 = [0, 4.3];
export const STREET_IN: V2 = [-12, 6.9];
export const STREET_OUT: V2 = [12, 6.9];
export const AISLE_Z = -0.2;
export const COUNTER: V2 = [-3.8, -3.6];

const SEAT_OFFSETS: V2[] = [[-0.34, -0.72], [0.34, -0.72], [-0.34, 0.72], [0.34, 0.72]];

export function buildTables(hero: Hero): TableSpot[] {
  const n = hero.tables;
  const cols = Math.ceil(n / 2);
  const out: TableSpot[] = [];
  for (let i = 0; i < n; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = (col - (cols - 1) / 2) * 2.55;
    const z = row === 0 ? -1.9 : 1.35;
    out.push({
      id: `T${String(i + 1).padStart(2, "0")}`, x, z, terrace: false,
      seats: SEAT_OFFSETS.slice(0, hero.seats_per_table).map(([dx, dz]) => [x + dx, z + dz]),
      serve: [x + 0.95, z],
    });
  }
  for (let i = 0; i < hero.terrace_tables; i++) {
    const x = 3.3 + i * 2.5;
    const z = 5.25;
    out.push({
      id: `Y${String(i + 1).padStart(2, "0")}`, x, z, terrace: true,
      seats: SEAT_OFFSETS.slice(0, hero.seats_per_table).map(([dx, dz]) => [x + dx, z + dz]),
      serve: [x - 0.95, z],
    });
  }
  return out;
}

// Waiting line along the front wall, left of the door.
// One spot per waiting party, 1.15 m apart so a party of four (2 x 2 at 0.45 m) does not overlap the next one.
export function queueSpot(i: number): V2 {
  return [-1.5 - (i % 5) * 1.15, 4.2 + Math.floor(i / 5) * 1.0];
}

export function staffHome(k: number): V2 {
  return [-2.4 + k * 1.1, -3.25];
}
