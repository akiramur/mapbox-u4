import { cellCenterLngLat, cellMeters, lngLatToWorld, type TileGrid } from "./tileGrid";
import { TerrainType } from "./TerrainType";

/**
 * Village spacing per cell, denser towards city centres. Settlement labels
 * (the z9 places source, symbolrank ≤ 10, on or off the grid) act as centres;
 * each has an urban radius by importance. Distances are in metres, so the
 * dense core stays in the same place at every zoom.
 *
 *   distance < radius / 2 → spacing 1 (about 1 village in 9 cells)
 *   distance < radius     → spacing 2 (about 1 in 25)
 *   otherwise             → spacing 3 (about 1 in 49), the default
 */

export const DEFAULT_VILLAGE_SPACING = 3;

/** Urban radius (metres) by settlement symbolrank; lower rank = more important. */
export function urbanRadiusMeters(symbolrank: number): number {
  if (symbolrank <= 6) return 15000; // e.g. Tokyo, Seoul
  if (symbolrank <= 8) return 8000; // e.g. Yokohama, Osaka, Nagoya
  if (symbolrank <= 9) return 6000; // e.g. Kawasaki, Chiba
  if (symbolrank <= 10) return 4000;
  return 0;
}

export function spacingForDistance(distanceM: number, radiusM: number): number {
  if (radiusM <= 0) return DEFAULT_VILLAGE_SPACING;
  if (distanceM < radiusM / 2) return 1;
  if (distanceM < radiusM) return 2;
  return DEFAULT_VILLAGE_SPACING;
}

/** Spacing for every cell (only computed where villages can appear). */
export function villageSpacingGrid(grid: TileGrid): number[] {
  const { spec, terrain } = grid;
  const out = new Array<number>(terrain.length).fill(DEFAULT_VILLAGE_SPACING);
  const needs = (t: TerrainType) => t === TerrainType.Urban || (t === TerrainType.Building && grid.ctx.lod !== "LOCAL");
  if (!terrain.some(needs)) return out;

  // City centres in world pixels, de-duplicated (labels repeat across tiles).
  const metresPerPx = cellMeters(spec) / spec.cellPx;
  const centres = new Map<string, { x: number; y: number; radiusPx: number }>();
  for (const f of grid.features) {
    if (f.sourceLayer !== "place_label_z9" || f.cls !== "settlement" || f.geometry.type !== "Point") continue;
    const radius = urbanRadiusMeters(f.props.symbolrank ?? 99);
    if (!radius) continue;
    const [lng, lat] = f.geometry.coordinates;
    const [x, y] = lngLatToWorld(lng, lat, spec.worldSize);
    centres.set(`${Math.round(x)},${Math.round(y)}`, { x, y, radiusPx: radius / metresPerPx });
  }
  if (!centres.size) return out;

  const ws = spec.worldSize;
  terrain.forEach((t, i) => {
    if (!needs(t)) return;
    const [lng, lat] = cellCenterLngLat(spec, i % spec.cols, Math.floor(i / spec.cols));
    const [cx, cy] = lngLatToWorld(lng, lat, ws);
    let best = DEFAULT_VILLAGE_SPACING;
    for (const c of centres.values()) {
      // Horizontal distance across the antimeridian / world copies.
      const dx = ((((cx - c.x) % ws) + ws * 1.5) % ws) - ws / 2;
      const d = Math.hypot(dx, cy - c.y);
      best = Math.min(best, spacingForDistance(d * metresPerPx, c.radiusPx * metresPerPx));
      if (best === 1) break;
    }
    out[i] = best;
  });
  return out;
}
