import type { GameLOD } from "../world/gameLOD";
import { TerrainType } from "../world/TerrainType";

/**
 * Location-specific rules applied after classification. A point override
 * replaces the terrain of the single grid cell containing the point.
 * This is a demonstration of the extension point, not a POI database.
 */
export interface PointOverride {
  id: string;
  name: string;
  lngLat: [number, number];
  terrain: TerrainType;
  /** LODs the override applies to; all LODs when omitted. */
  lods?: GameLOD[];
}

export const AREA_OVERRIDES: PointOverride[] = [
  { id: "tokyo-imperial-palace", name: "Imperial Palace", lngLat: [139.7528, 35.6852], terrain: TerrainType.Castle, lods: ["TOWN"] },
  { id: "tokyo-station", name: "Tokyo Station", lngLat: [139.7671, 35.6812], terrain: TerrainType.Town, lods: ["TOWN"] },
];
