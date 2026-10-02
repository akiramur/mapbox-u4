import type { GeoFeature } from "../map/featureExtractor";
import type { GameLOD } from "./gameLOD";
import { TerrainType } from "./TerrainType";

/**
 * All deterministic classification rules live in this module.
 *
 * Stage 1 (per feature): classifyFeature() maps a Mapbox feature to a terrain
 * and says how it is rasterized onto the grid (area coverage or line).
 * Stage 2 (per cell):   classifyCell() picks one terrain from the per-cell
 * coverage using TERRAIN_PRIORITY and COVERAGE_THRESHOLD.
 * Stage 3 (per grid):   postProcess() applies neighbourhood rules (road
 * thinning, deep water). Visual transition tiles live in transitions.ts.
 */

export interface ClassifyContext {
  zoom: number;
  /** Selects the LOD_RULES set. */
  lod: GameLOD;
  /**
   * Half width in cells per road class, from the map style's line-width at
   * this zoom (see roadWidths.ts). Missing classes use half a cell.
   */
  roadHalfWidths?: Record<string, number>;
}

export type FeatureRule =
  /**
   * narrow: polygons whose outer ring is long (bbox side ≥ minExtent cells)
   * and thin (area ≤ maxFill × bbox side²) are rasterized as narrow.terrain.
   */
  | { terrain: TerrainType; mode: "area"; narrow?: { terrain: TerrainType; maxFill: number; minExtent: number } }
  /** halfWidth: max distance (in cells) from a cell centre to the line. */
  | { terrain: TerrainType; mode: "line"; halfWidth: number }
  /** Marks only the cell containing the point. */
  | { terrain: TerrainType; mode: "point" }
  /** Contour polygon at or above `ele` metres; feeds the per-cell elevation grid (see reliefTerrain). */
  | { terrain?: undefined; mode: "elevation"; ele: number };

const LANDUSE: Record<string, TerrainType> = {
  wood: TerrainType.Forest,
  park: TerrainType.Park,
  pitch: TerrainType.Park,
  cemetery: TerrainType.Park,
  grass: TerrainType.Grass,
  scrub: TerrainType.Grass,
  agriculture: TerrainType.Grass,
};

/** landuse class=park whose original OSM `type` is woodland counts as Forest. */
const WOODED_PARK_TYPES = new Set(["wood", "forest"]);

const LANDUSE_OVERLAY: Record<string, TerrainType> = {
  national_park: TerrainType.Park,
  wetland: TerrainType.Grass,
  wetland_noveg: TerrainType.Grass,
};

const LANDCOVER: Record<string, TerrainType> = {
  wood: TerrainType.Forest,
  scrub: TerrainType.Grass,
  grass: TerrainType.Grass,
  crop: TerrainType.Grass,
};

/**
 * Road classes drawn as Road tiles, by minimum zoom. One table for every LOD
 * (except WORLD, which has no roads) so the network grows gradually with zoom
 * instead of jumping at LOD boundaries. At z12 one cell is ~250 m, and the
 * primary network (every 1–2 km on the Kanto plain) would fill the grid.
 */
const ROAD_MIN_ZOOM: Record<string, number> = {
  motorway: 8,
  trunk: 12,
  primary: 14,
  secondary: 15,
  tertiary: 15,
  street: 15,
  street_limited: 15,
};

/**
 * Minor street classes are drawn from z15, but below this zoom only where no
 * building is (MinorRoad ranks below Building). At z15 a cell is ~31 m and
 * city streets run every 30–60 m, so drawing them over buildings would chop
 * every block into wall fragments; this way the streets show in the gaps and
 * z15 → z16 does not jump.
 */
const MINOR_ROAD_BELOW_BUILDINGS_UNTIL: Record<string, number> = {
  street: 16,
  street_limited: 16,
};

/**
 * Road `type`s dropped below a zoom even when their class is drawn. Urban
 * expressways (e.g. Tokyo's Shuto) form a dense mesh inside cities.
 */
const ROAD_TYPE_MIN_ZOOM: Record<string, number> = {
  urban_expressway: 13,
};

const WATERWAY_CLASSES = new Set(["river", "canal"]);

/**
 * What counts as a narrow (river-like) water polygon. Rivers fill a small part
 * of their bounding box; lakes and sea do not.
 */
const NARROW_WATER = { maxFill: 0.25, minExtent: 6 };

/** landuse classes treated as built-up area (Urban) when LodRules.urbanAreas is on. */
const URBAN_LANDUSE = new Set(["residential", "commercial_area", "industrial"]);

/** Bathymetry bands at least this deep (metres) count as DeepWater. */
const DEEP_WATER_MIN_DEPTH = 200;

/**
 * Relief. Contour polygons (terrain-v2, z9+) give real elevation: each polygon
 * is the area at or above its `ele`. tileGrid turns them into one elevation
 * per cell, and reliefTerrain() classifies by *local relief* (height above the
 * lowest ground within RELIEF_RADIUS_M), not absolute height, so high flat
 * plateaus (Grand Canyon rim, Tibet, Mexico City) are not all mountains.
 * Below CONTOUR_MIN_ZOOM only hillshade (slope) is available.
 */
const CONTOUR_MIN_ZOOM = 9;
const MOUNTAIN_MIN_RELIEF = 600;
const HILL_MIN_RELIEF = 200;
const RELIEF_RADIUS_M = 4000;

/**
 * Mountain/Hill per cell from a per-cell elevation grid (metres; 0 where no
 * contour covers the cell). cellMeters is the ground size of one cell.
 */
export function reliefTerrain(
  elevation: Float32Array,
  cols: number,
  rows: number,
  cellMeters: number,
): { terrain: (TerrainType | null)[]; relief: Float32Array } {
  const r = Math.max(1, Math.ceil(RELIEF_RADIUS_M / cellMeters));
  // Separable square min filter: rows, then columns.
  const rowMin = new Float32Array(elevation.length);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let m = Infinity;
      for (let dx = Math.max(0, x - r); dx <= Math.min(cols - 1, x + r); dx++) m = Math.min(m, elevation[y * cols + dx]);
      rowMin[y * cols + x] = m;
    }
  }
  const relief = new Float32Array(elevation.length);
  const terrain: (TerrainType | null)[] = new Array(elevation.length).fill(null);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let m = Infinity;
      for (let dy = Math.max(0, y - r); dy <= Math.min(rows - 1, y + r); dy++) m = Math.min(m, rowMin[dy * cols + x]);
      const i = y * cols + x;
      relief[i] = elevation[i] - m;
      terrain[i] = relief[i] >= MOUNTAIN_MIN_RELIEF ? TerrainType.Mountain : relief[i] >= HILL_MIN_RELIEF ? TerrainType.Hill : null;
    }
  }
  return { terrain, relief };
}

/**
 * Hillshade bands (terrain-v2) that count as Mountain; every other shadow or
 * highlight band counts as Hill. Lower shadow levels are darker (steeper).
 */
function isSteepRelief(cls: string, level: number | undefined): boolean {
  return (cls === "shadow" && (level ?? 100) <= 78) || (cls === "highlight" && (level ?? 0) >= 94);
}

/** Per-LOD switches. LOCAL/TOWN keep the street-level rules; REGION/WORLD generalize. */
export interface LodRules {
  /** Draw roads at all (per ROAD_MIN_ZOOM / ROAD_TYPE_MIN_ZOOM). */
  roads: boolean;
  /** Thin road cells to 1-cell-wide lines (dual carriageways, parallel roads). */
  thinRoads: boolean;
  /**
   * Draw waterway lines (rivers/canals). Off from TOWN down: a cell is 250 m or
   * more there, and every ditch and stream would become a line of water.
   * Rivers still appear through their `water` polygons (see narrowWater).
   */
  waterwayLines: boolean;
  /**
   * Long, thin water polygons (river surfaces narrower than a cell) count as
   * Water with a single covered sample, so big rivers stay continuous.
   */
  narrowWater: boolean;
  /** Classify residential/commercial/industrial landuse as Urban. */
  urbanAreas: boolean;
  /**
   * Samples (of 9) Urban needs. REGION polygons are generalized and cover
   * almost everything, so 7; from z13 they come split by streets, so TOWN
   * uses 5 to avoid villages vanishing at z13.
   */
  urbanThreshold: number;
  /**
   * Also take urban landuse from the z12-capped source (landuse_z12). The
   * generalized urban polygons end at z12, and z13–14 tiles have almost no
   * landuse in city centres, so villages would vanish at the z13 tile switch.
   */
  urbanFromZ12: boolean;
  /** Settlement labels with symbolrank ≤ this become a single Town tile; null = off. */
  settlementMaxRank: number | null;
  /** Hill/Mountain from contour elevation (z9+) or hillshade (below). */
  relief: boolean;
  /** From this zoom, buildings are drawn as town interiors (walls, floors, doors); null = never. */
  interiorMinZoom: number | null;
}

export const LOD_RULES: Record<GameLOD, LodRules> = {
  LOCAL: { roads: true, thinRoads: false, waterwayLines: true, narrowWater: false, urbanAreas: false, urbanThreshold: 7, urbanFromZ12: false, settlementMaxRank: null, relief: false, interiorMinZoom: 15 },
  // Building footprints are sparse at z12–14, so urban landuse fills the gaps.
  TOWN: { roads: true, thinRoads: true, waterwayLines: false, narrowWater: true, urbanAreas: true, urbanThreshold: 5, urbanFromZ12: true, settlementMaxRank: 10, relief: false, interiorMinZoom: null },
  REGION: {
    roads: true,
    thinRoads: true,
    waterwayLines: false,
    narrowWater: true,
    urbanAreas: true,
    urbanThreshold: 7,
    urbanFromZ12: false,
    settlementMaxRank: 10,
    relief: true,
    interiorMinZoom: null,
  },
  // Classic overworld maps have no roads.
  WORLD: { roads: false, thinRoads: false, waterwayLines: false, narrowWater: true, urbanAreas: false, urbanThreshold: 7, urbanFromZ12: false, settlementMaxRank: 8, relief: true, interiorMinZoom: null },
};

export function classifyFeature(f: GeoFeature, ctx: ClassifyContext): FeatureRule | null {
  const cls = f.cls ?? "";
  const rules = LOD_RULES[ctx.lod];
  switch (f.sourceLayer) {
    case "water":
      return rules.narrowWater
        ? { terrain: TerrainType.Water, mode: "area", narrow: { terrain: TerrainType.NarrowWater, ...NARROW_WATER } }
        : { terrain: TerrainType.Water, mode: "area" };
    case "waterway":
      return rules.waterwayLines && WATERWAY_CLASSES.has(cls) ? { terrain: TerrainType.Water, mode: "line", halfWidth: 0.5 } : null;
    case "depth":
      return (f.props.minDepth ?? 0) >= DEEP_WATER_MIN_DEPTH ? { terrain: TerrainType.DeepWater, mode: "area" } : null;
    case "landuse":
      if (cls === "park" && WOODED_PARK_TYPES.has(f.type ?? "")) return { terrain: TerrainType.Forest, mode: "area" };
      if (rules.urbanAreas && URBAN_LANDUSE.has(cls)) return { terrain: TerrainType.Urban, mode: "area" };
      return cls in LANDUSE ? { terrain: LANDUSE[cls], mode: "area" } : null;
    case "landuse_z12":
      return rules.urbanFromZ12 && URBAN_LANDUSE.has(cls) ? { terrain: TerrainType.Urban, mode: "area" } : null;
    case "landuse_overlay":
      return cls in LANDUSE_OVERLAY ? { terrain: LANDUSE_OVERLAY[cls], mode: "area" } : null;
    case "landcover":
      return cls in LANDCOVER ? { terrain: LANDCOVER[cls], mode: "area" } : null;
    case "hillshade":
      if (!rules.relief || ctx.zoom >= CONTOUR_MIN_ZOOM) return null;
      return { terrain: isSteepRelief(cls, f.props.level) ? TerrainType.Mountain : TerrainType.Hill, mode: "area" };
    case "contour": {
      if (!rules.relief || ctx.zoom < CONTOUR_MIN_ZOOM) return null;
      const ele = f.props.ele;
      return ele === undefined || ele <= 0 ? null : { mode: "elevation", ele };
    }
    case "building":
      return { terrain: TerrainType.Building, mode: "area" };
    case "road": {
      const minZoom = ROAD_MIN_ZOOM[cls];
      const typeMinZoom = ROAD_TYPE_MIN_ZOOM[f.type ?? ""] ?? 0;
      if (!rules.roads || minZoom === undefined || ctx.zoom < Math.max(minZoom, typeMinZoom)) return null;
      const minor = ctx.zoom < (MINOR_ROAD_BELOW_BUILDINGS_UNTIL[cls] ?? -Infinity);
      const halfWidth = Math.max(0.5, ctx.roadHalfWidths?.[cls] ?? 0.5);
      return { terrain: minor ? TerrainType.MinorRoad : TerrainType.Road, mode: "line", halfWidth };
    }
    case "place_label_z9": {
      // From the z9-capped places source: one fixed point per city at every zoom.
      // The rank limit never shrinks as you zoom in up to TOWN (WORLD 8,
      // REGION min(10, floor(zoom)), TOWN 10), so a town shown at one zoom stays
      // on screen until z15. LOCAL draws town interiors instead, without Town tiles.
      const maxRank =
        rules.settlementMaxRank === null || ctx.lod !== "REGION" ? rules.settlementMaxRank : Math.min(rules.settlementMaxRank, Math.floor(ctx.zoom));
      if (maxRank === null || cls !== "settlement" || (f.props.symbolrank ?? Infinity) > maxRank) return null;
      return { terrain: TerrainType.Town, mode: "point" };
    }
  }
}

/** Highest priority first. The first terrain whose coverage passes its threshold wins. */
export const TERRAIN_PRIORITY: TerrainType[] = [
  TerrainType.Town,
  TerrainType.Road,
  TerrainType.DeepWater,
  TerrainType.Water,
  TerrainType.NarrowWater,
  TerrainType.Building,
  TerrainType.MinorRoad,
  TerrainType.Mountain,
  TerrainType.Forest,
  TerrainType.Hill,
  TerrainType.Park,
  // Below vegetation so parks and green belts inside cities survive.
  TerrainType.Urban,
  TerrainType.Grass,
];

/** Minimum number of the 9 sample points (3×3 per cell) that must be covered. */
export const COVERAGE_THRESHOLD: Partial<Record<TerrainType, number>> = {
  [TerrainType.Town]: 1, // point hits always cover all 9 samples
  [TerrainType.Road]: 1, // line hits always cover all 9 samples
  [TerrainType.DeepWater]: 5,
  [TerrainType.Water]: 5,
  [TerrainType.NarrowWater]: 1,
  [TerrainType.Building]: 3,
  [TerrainType.MinorRoad]: 1, // line hits always cover all 9 samples
  [TerrainType.Mountain]: 5,
  [TerrainType.Forest]: 5,
  [TerrainType.Hill]: 5,
  [TerrainType.Park]: 5,
  [TerrainType.Grass]: 5,
};

/**
 * A terrain only wins if this other terrain also passes its threshold.
 * Bathymetry bands are generalized and can spill onto land at low zoom.
 */
const REQUIRES: Partial<Record<TerrainType, TerrainType>> = {
  [TerrainType.DeepWater]: TerrainType.Water,
};

/** Coverage-only terrains and the terrain they are classified as. */
const OUTPUT_AS: Partial<Record<TerrainType, TerrainType>> = {
  [TerrainType.NarrowWater]: TerrainType.Water,
  [TerrainType.MinorRoad]: TerrainType.Road,
};

/** The terrain that coverage of `t` is classified as (NarrowWater → Water). */
export function classifiedAs(t: TerrainType): TerrainType {
  return OUTPUT_AS[t] ?? t;
}

function thresholdFor(t: TerrainType, ctx: ClassifyContext): number {
  if (t === TerrainType.Urban) return LOD_RULES[ctx.lod].urbanThreshold;
  return COVERAGE_THRESHOLD[t] ?? 1;
}

const passes = (coverage: ArrayLike<number>, t: TerrainType, ctx: ClassifyContext) => coverage[t] >= thresholdFor(t, ctx);

/**
 * coverage[t] = number of covered sample points (0..9) for terrain t.
 * `exclude` skips one terrain (used when road thinning removes a road cell).
 */
export function classifyCell(coverage: ArrayLike<number>, ctx: ClassifyContext, exclude?: TerrainType): TerrainType {
  for (const t of TERRAIN_PRIORITY) {
    if (exclude !== undefined && classifiedAs(t) === exclude) continue;
    const required = REQUIRES[t];
    if (passes(coverage, t, ctx) && (required === undefined || passes(coverage, required, ctx))) return classifiedAs(t);
  }
  return TerrainType.Unknown;
}

/** Water cells whose whole neighbourhood (radius, in cells) is water become DeepWater. */
const DEEP_WATER_RADIUS = 2;

/**
 * coverage: per-cell slices as produced by tileGrid (cell * TERRAIN_COUNT + t).
 */
export function postProcess(
  terrain: TerrainType[],
  coverageOf: (cell: number) => ArrayLike<number>,
  cols: number,
  rows: number,
  ctx: ClassifyContext,
): TerrainType[] {
  let out = terrain.slice();
  if (LOD_RULES[ctx.lod].thinRoads) out = thinRoads(out, coverageOf, cols, rows, ctx);
  return deepenWater(out, cols, rows);
}

/**
 * Zhang–Suen thinning of the Road mask. Parallel carriageways and adjacent
 * roads collapse to 1-cell-wide, still-connected lines. Removed cells fall
 * back to the next terrain their coverage supports.
 */
function thinRoads(
  terrain: TerrainType[],
  coverageOf: (cell: number) => ArrayLike<number>,
  cols: number,
  rows: number,
  ctx: ClassifyContext,
): TerrainType[] {
  const road = new Uint8Array(terrain.length);
  terrain.forEach((t, i) => (road[i] = t === TerrainType.Road ? 1 : 0));
  const P = (x: number, y: number) => (x < 0 || y < 0 || x >= cols || y >= rows ? 0 : road[y * cols + x]);
  let changed = true;
  while (changed) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      const remove: number[] = [];
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          if (!road[y * cols + x]) continue;
          // Neighbours p2..p9, clockwise from north.
          const n = [P(x, y - 1), P(x + 1, y - 1), P(x + 1, y), P(x + 1, y + 1), P(x, y + 1), P(x - 1, y + 1), P(x - 1, y), P(x - 1, y - 1)];
          const b = n.reduce((a, v) => a + v, 0);
          if (b < 2 || b > 6) continue;
          let a = 0;
          for (let k = 0; k < 8; k++) if (!n[k] && n[(k + 1) % 8]) a++;
          if (a !== 1) continue;
          const [p2, , p4, , p6, , p8] = n;
          if (step === 0 ? p2 * p4 * p6 || p4 * p6 * p8 : p2 * p4 * p8 || p2 * p6 * p8) continue;
          remove.push(y * cols + x);
        }
      }
      for (const i of remove) road[i] = 0;
      if (remove.length) changed = true;
    }
  }
  return terrain.map((t, i) => (t === TerrainType.Road && !road[i] ? classifyCell(coverageOf(i), ctx, TerrainType.Road) : t));
}

function deepenWater(terrain: TerrainType[], cols: number, rows: number): TerrainType[] {
  const isWater = (t: TerrainType) => t === TerrainType.Water || t === TerrainType.DeepWater;
  const out = terrain.slice();
  const r = DEEP_WATER_RADIUS;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (terrain[y * cols + x] !== TerrainType.Water) continue;
      let deep = true;
      for (let dy = -r; dy <= r && deep; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          if (!isWater(terrain[ny * cols + nx])) {
            deep = false;
            break;
          }
        }
      }
      if (deep) out[y * cols + x] = TerrainType.DeepWater;
    }
  }
  return out;
}
