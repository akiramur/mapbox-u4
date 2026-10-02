import { TerrainType } from "./TerrainType";

/**
 * Town-interior rendering for high zoom. Building cells touching anything
 * that is not Building (8-neighbourhood) become Wall, the rest brick Floor,
 * so each building reads as a walled room. Buildings too small to have an
 * inner cell (e.g. detached houses) become solid wall.
 *
 * Adjacent footprints in dense cities merge into one room; that is accepted.
 */
export interface InteriorResult {
  terrain: TerrainType[];
  /** Id of the rule that changed each cell, if any. */
  rule: (string | undefined)[];
}

const N8 = [[0, -1], [1, 0], [0, 1], [-1, 0], [1, -1], [1, 1], [-1, 1], [-1, -1]];

export function applyInteriors(terrain: TerrainType[], cols: number, rows: number): InteriorResult {
  const out = terrain.slice();
  const rule: (string | undefined)[] = new Array(terrain.length);
  const isBuilding = (x: number, y: number) =>
    // Off-grid counts as building so buildings cut by the grid edge stay open.
    x < 0 || y < 0 || x >= cols || y >= rows || terrain[y * cols + x] === TerrainType.Building;

  for (let i = 0; i < terrain.length; i++) {
    if (terrain[i] !== TerrainType.Building) continue;
    const x = i % cols;
    const y = Math.floor(i / cols);
    const edge = N8.some(([dx, dy]) => !isBuilding(x + dx, y + dy));
    out[i] = edge ? TerrainType.Wall : TerrainType.Floor;
    rule[i] = edge ? "interior-wall" : "interior-floor";
  }
  return { terrain: out, rule };
}
