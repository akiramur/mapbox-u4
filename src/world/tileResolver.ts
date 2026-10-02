import { AREA_OVERRIDES } from "../config/overrides";
import type { GameLOD } from "./gameLOD";
import { hash01 } from "./hash";
import { placeLabels, type PlacedLabel } from "./labels";
import { DEFAULT_VILLAGE_SPACING, villageSpacingGrid } from "./urbanDensity";
import { cellBounds, cellCenterLngLat, gridWorldCell, type GridSpec, type TileGrid } from "./tileGrid";
import { TerrainType } from "./TerrainType";

/**
 * Tile resolver: the step between the logical grid and the sprite atlas.
 * Takes a classified cell plus its location and returns the terrain to draw,
 * letting location-specific rules (castles, towns, shrines…) replace the
 * generic classification. Sprite selection happens later via tileMappings.
 */

export interface ResolveInput {
  terrain: TerrainType;
  longitude: number;
  latitude: number;
  /** Cell bounds [west, south, east, north]. */
  bounds: [number, number, number, number];
  /** World-anchored cell index at this zoom; stable while panning. */
  worldCell: [number, number];
  /** Village spacing for this cell (smaller = denser); default VILLAGE_SPACING. */
  villageSpacing?: number;
  zoom: number;
  lod: GameLOD;
}

export interface ResolvedTile {
  terrain: TerrainType;
  /** Id of the override that replaced the classified terrain, if any. */
  overrideId?: string;
  /** Id of the generic resolver rule that changed the terrain, if any. */
  rule?: string;
  /** Tile variant index (see TileMapping). */
  variant?: number;
}

/** What renderers need: grid geometry, one resolved tile per cell, and place names drawn on top. */
export interface TileFrame {
  spec: GridSpec;
  tiles: ResolvedTile[];
  labels: PlacedLabel[];
}

/**
 * Village spacing for Urban cells (and Building cells below LOCAL): a cell is
 * drawn as a village only if its hash is the smallest within `spacing` cells
 * on the world-anchored lattice; the rest become grassland. Villages then
 * never touch and appear at about 1 / (2·spacing+1)² of the cells. The
 * spacing is smaller near city centres (see urbanDensity.ts). Stable while panning.
 */
export const VILLAGE_SPACING = DEFAULT_VILLAGE_SPACING;

function isVillageSite(gx: number, gy: number, spacing: number): boolean {
  const h = hash01(gx, gy);
  for (let dy = -spacing; dy <= spacing; dy++) {
    for (let dx = -spacing; dx <= spacing; dx++) {
      if ((dx || dy) && hash01(gx + dx, gy + dy) <= h) return false;
    }
  }
  return true;
}

export function resolveTile(input: ResolveInput): ResolvedTile {
  const [w, s, e, n] = input.bounds;
  for (const o of AREA_OVERRIDES) {
    if (o.lods && !o.lods.includes(input.lod)) continue;
    // Bring the override into the same world copy as the cell (the grid may lie outside −180…180°).
    const lng = o.lngLat[0] + 360 * Math.round((input.longitude - o.lngLat[0]) / 360);
    const lat = o.lngLat[1];
    if (lng >= w && lng < e && lat >= s && lat < n) return { terrain: o.terrain, overrideId: o.id };
  }
  const townLike = input.terrain === TerrainType.Urban || (input.terrain === TerrainType.Building && input.lod !== "LOCAL");
  if (townLike) {
    const village = isVillageSite(input.worldCell[0], input.worldCell[1], input.villageSpacing ?? VILLAGE_SPACING);
    return { terrain: village ? TerrainType.Building : TerrainType.Grass, rule: "village-spacing" };
  }
  return { terrain: input.terrain };
}

/** Variant chosen upstream (e.g. floor type per building) passes through unchanged. */
function withVariant(tile: ResolvedTile, variant: number): ResolvedTile {
  return variant ? { ...tile, variant } : tile;
}

export function resolveGrid(grid: TileGrid): TileFrame {
  const { spec, ctx } = grid;
  const spacing = villageSpacingGrid(grid);
  const tiles: ResolvedTile[] = grid.terrain.map((terrain, i) => {
    const x = i % spec.cols;
    const y = Math.floor(i / spec.cols);
    const [longitude, latitude] = cellCenterLngLat(spec, x, y);
    const tile = resolveTile({
      terrain,
      longitude,
      latitude,
      bounds: cellBounds(spec, x, y),
      worldCell: gridWorldCell(spec, i),
      villageSpacing: spacing[i],
      zoom: ctx.zoom,
      lod: ctx.lod,
    });
    return withVariant(tile, grid.variant[i]);
  });
  return { spec, tiles, labels: placeLabels(grid) };
}
