import type { GameLOD } from "./gameLOD";
import { TerrainType } from "./TerrainType";

/**
 * Visual transition rules, applied to the classified grid before tile
 * resolution. The tile sets have no edge/corner variants, so boundaries are
 * softened the way classic 8-bit RPG world maps do it: by inserting intermediate
 * terrains (land → shallow water → water → deep water, forest → scrub,
 * mountains → hills).
 *
 * Rules run in order; each sees the result of the previous one. A rule turns
 * a cell `from` one of its terrains `to` another when any neighbour matches.
 */
export interface TransitionRule {
  id: string;
  from: TerrainType[];
  to: TerrainType;
  /** Neighbour terrains that trigger the rule. */
  near: TerrainType[];
  /** 4 = edge neighbours only, 8 = include diagonals. */
  neighbourhood: 4 | 8;
  lods: GameLOD[];
}

/** Terrains that count as shore. Roads are excluded so bridges do not create shallows. */
const LAND = [
  TerrainType.Grass,
  TerrainType.Scrub,
  TerrainType.Forest,
  TerrainType.Park,
  TerrainType.Building,
  TerrainType.Urban,
  TerrainType.Town,
  TerrainType.Castle,
  TerrainType.Hill,
  TerrainType.Mountain,
  TerrainType.Unknown,
];
const LOWLAND = [TerrainType.Grass, TerrainType.Unknown];
const ALL_LODS: GameLOD[] = ["WORLD", "REGION", "TOWN", "LOCAL"];

export const TRANSITION_RULES: TransitionRule[] = [
  { id: "coast", from: [TerrainType.Water, TerrainType.DeepWater], to: TerrainType.ShallowWater, near: LAND, neighbourhood: 8, lods: ALL_LODS },
  { id: "coast-gradient", from: [TerrainType.DeepWater], to: TerrainType.Water, near: [TerrainType.ShallowWater], neighbourhood: 8, lods: ALL_LODS },
  { id: "foothills", from: LOWLAND, to: TerrainType.Hill, near: [TerrainType.Mountain], neighbourhood: 8, lods: ["WORLD", "REGION"] },
  { id: "forest-edge", from: LOWLAND, to: TerrainType.Scrub, near: [TerrainType.Forest], neighbourhood: 4, lods: ["WORLD", "REGION"] },
];

const N4 = [[0, -1], [1, 0], [0, 1], [-1, 0]];
const N8 = [...N4, [1, -1], [1, 1], [-1, 1], [-1, -1]];

/** Returns the transformed terrain and, per cell, the id of the rule that last changed it. */
export function applyTransitions(
  terrain: TerrainType[],
  cols: number,
  rows: number,
  lod: GameLOD,
): { terrain: TerrainType[]; rule: (string | undefined)[] } {
  let current = terrain;
  const rule: (string | undefined)[] = new Array(terrain.length);
  for (const r of TRANSITION_RULES) {
    if (!r.lods.includes(lod)) continue;
    const from = new Set(r.from);
    const near = new Set(r.near);
    const offsets = r.neighbourhood === 4 ? N4 : N8;
    const next = current.slice();
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x;
        if (!from.has(current[i])) continue;
        const hit = offsets.some(([dx, dy]) => {
          const nx = x + dx;
          const ny = y + dy;
          return nx >= 0 && ny >= 0 && nx < cols && ny < rows && near.has(current[ny * cols + nx]);
        });
        if (hit) {
          next[i] = r.to;
          rule[i] = r.id;
        }
      }
    }
    current = next;
  }
  return { terrain: current, rule };
}
