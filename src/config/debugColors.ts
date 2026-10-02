import { TerrainType } from "../world/TerrainType";

/** Flat colours used by the Phase 1 debug renderer (no sprites). */
export const DEBUG_COLORS: Record<TerrainType, string> = {
  [TerrainType.DeepWater]: "#1a2a8c",
  [TerrainType.Water]: "#3f6fe0",
  [TerrainType.ShallowWater]: "#7fb2f0",
  [TerrainType.NarrowWater]: "#3f6fe0", // never output; same as Water
  [TerrainType.Grass]: "#8fd14f",
  [TerrainType.Scrub]: "#b5c96a",
  [TerrainType.Forest]: "#1f6b2a",
  [TerrainType.Park]: "#4caf50",
  [TerrainType.Road]: "#c8a060",
  [TerrainType.MinorRoad]: "#c8a060", // never output; same as Road
  [TerrainType.Building]: "#b04a4a",
  [TerrainType.Urban]: "#d9a0a0",
  [TerrainType.Town]: "#e07b39",
  [TerrainType.Castle]: "#f0e040",
  [TerrainType.Wall]: "#e8e8e8",
  [TerrainType.Floor]: "#a07850",
  [TerrainType.Hill]: "#a08050",
  [TerrainType.Mountain]: "#806040",
  [TerrainType.Unknown]: "#555555",
};
