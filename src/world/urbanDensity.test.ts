import { describe, expect, it } from "vitest";
import { ctx, feature, makeSpec } from "../test/helpers";
import { buildTileGrid, cellMeters } from "./tileGrid";
import { resolveGrid } from "./tileResolver";
import { TerrainType } from "./TerrainType";
import { DEFAULT_VILLAGE_SPACING, spacingForDistance, urbanRadiusMeters, villageSpacingGrid } from "./urbanDensity";

describe("spacingForDistance", () => {
  it("is densest in the core, medium inside the urban radius, default outside", () => {
    expect(spacingForDistance(1000, 15000)).toBe(1);
    expect(spacingForDistance(10000, 15000)).toBe(2);
    expect(spacingForDistance(20000, 15000)).toBe(DEFAULT_VILLAGE_SPACING);
    expect(spacingForDistance(0, 0)).toBe(DEFAULT_VILLAGE_SPACING);
  });

  it("gives bigger cities bigger urban radii", () => {
    expect(urbanRadiusMeters(6)).toBeGreaterThan(urbanRadiusMeters(8));
    expect(urbanRadiusMeters(8)).toBeGreaterThan(urbanRadiusMeters(10));
    expect(urbanRadiusMeters(11)).toBe(0);
  });
});

describe("villageSpacingGrid", () => {
  // A 60×20 block of urban landuse with a big city at its left end.
  const spec = makeSpec(60, 20, 11);
  const urban = feature(spec, "landuse", { type: "Polygon", rings: [[[0, 0], [60, 0], [60, 20], [0, 20], [0, 0]]] }, { cls: "residential" });
  const city = feature(spec, "place_label_z9", { type: "Point", point: [2.5, 10.5] }, { cls: "settlement", props: { name: "Metropolis", symbolrank: 6 } });

  it("is denser near the city than far from it", () => {
    const grid = buildTileGrid(spec, [urban, city], ctx("REGION", 11));
    const spacing = villageSpacingGrid(grid);
    const at = (x: number, y: number) => spacing[y * spec.cols + x];
    const metresPerCell = cellMeters(spec);
    expect(at(3, 10)).toBe(1);
    // Beyond 15 km from the city the default applies.
    const farX = Math.ceil(2.5 + 15000 / metresPerCell) + 1;
    if (farX < spec.cols) expect(at(farX, 10)).toBe(DEFAULT_VILLAGE_SPACING);
  });

  it("puts more villages near the city", () => {
    const grid = buildTileGrid(spec, [urban, city], ctx("REGION", 11));
    const tiles = resolveGrid(grid).tiles;
    const villagesIn = (x0: number, x1: number) => {
      let n = 0;
      for (let y = 0; y < spec.rows; y++) for (let x = x0; x < x1; x++) if (tiles[y * spec.cols + x].terrain === TerrainType.Building) n++;
      return n;
    };
    expect(villagesIn(0, 10)).toBeGreaterThan(villagesIn(50, 60));
  });
});
