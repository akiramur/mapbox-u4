/**
 * Logical terrain types. The rest of the pipeline speaks only in these —
 * never in Mapbox classes or sprite coordinates.
 */
export enum TerrainType {
  DeepWater,
  Water,
  /** Transition tile between water and land (see transitions.ts). */
  ShallowWater,
  /**
   * Coverage-only: a long, thin water polygon (a river surface narrower than a
   * cell). Needs only one sample; classified cells come out as Water.
   */
  NarrowWater,
  Grass,
  /** Transition tile at forest edges (see transitions.ts). */
  Scrub,
  Forest,
  Park,
  Road,
  /** Coverage-only: a minor street drawn only where no building is (z15–16); classified as Road. */
  MinorRoad,
  Building,
  /** Built-up area from landuse polygons (not footprints); drawn as scattered villages by tileResolver. */
  Urban,
  Town,
  Castle,
  /** Town-interior terrains used at high zoom (see interiors.ts). */
  Wall,
  Floor,
  Hill,
  Mountain,
  Unknown,
}

export const TERRAIN_COUNT = TerrainType.Unknown + 1;

export function terrainName(t: TerrainType): string {
  return TerrainType[t];
}
