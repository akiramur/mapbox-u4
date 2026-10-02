/**
 * Game level of detail, derived from the map zoom. The classifier and tile
 * resolver receive the LOD so zoom-dependent world representations can be
 * added later (e.g. WORLD: a city becomes one Town tile; LOCAL: individual
 * buildings and POIs). For now every LOD uses the same rules.
 */
export type GameLOD = "WORLD" | "REGION" | "TOWN" | "LOCAL";

/** Lower zoom bound (inclusive) of each LOD, coarsest first. */
export const LOD_MIN_ZOOM: Record<GameLOD, number> = {
  WORLD: 0,
  REGION: 8,
  TOWN: 12,
  LOCAL: 15,
};

export function getGameLOD(zoom: number): GameLOD {
  if (zoom >= LOD_MIN_ZOOM.LOCAL) return "LOCAL";
  if (zoom >= LOD_MIN_ZOOM.TOWN) return "TOWN";
  if (zoom >= LOD_MIN_ZOOM.REGION) return "REGION";
  return "WORLD";
}
