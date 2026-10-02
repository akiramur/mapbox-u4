import { describe, expect, it } from "vitest";
import { coverageOf, ctx, feature, makeSpec } from "../test/helpers";
import { getGameLOD } from "./gameLOD";
import { classifyCell, classifyFeature } from "./terrainClassifier";
import { TerrainType } from "./TerrainType";

const T = TerrainType;
const LOCAL = ctx("LOCAL", 15.5);
const TOWN = ctx("TOWN", 13);
const REGION = ctx("REGION", 10);

describe("getGameLOD", () => {
  it.each([
    [0, "WORLD"],
    [7.99, "WORLD"],
    [8, "REGION"],
    [11.99, "REGION"],
    [12, "TOWN"],
    [14.99, "TOWN"],
    [15, "LOCAL"],
    [20, "LOCAL"],
  ])("zoom %f → %s", (zoom, lod) => expect(getGameLOD(zoom)).toBe(lod));
});

describe("classifyCell: priority and thresholds", () => {
  it("needs 5 of 9 samples for water", () => {
    expect(classifyCell(coverageOf([[T.Water, 5]]), LOCAL)).toBe(T.Water);
    expect(classifyCell(coverageOf([[T.Water, 4]]), LOCAL)).toBe(T.Unknown);
  });

  it("lets road win over water (bridges stay road)", () => {
    expect(classifyCell(coverageOf([[T.Water, 9], [T.Road, 9]]), LOCAL)).toBe(T.Road);
  });

  it("lets buildings win over vegetation with only 3 samples", () => {
    expect(classifyCell(coverageOf([[T.Park, 9], [T.Building, 3]]), LOCAL)).toBe(T.Building);
    expect(classifyCell(coverageOf([[T.Park, 9], [T.Building, 2]]), LOCAL)).toBe(T.Park);
  });

  it("puts Urban below vegetation, with a per-LOD threshold", () => {
    expect(classifyCell(coverageOf([[T.Urban, 9], [T.Park, 5]]), REGION)).toBe(T.Park);
    expect(classifyCell(coverageOf([[T.Urban, 6]]), REGION)).toBe(T.Unknown); // REGION needs 7
    expect(classifyCell(coverageOf([[T.Urban, 6]]), TOWN)).toBe(T.Urban); // TOWN needs 5
  });

  it("only accepts DeepWater where there is also water", () => {
    expect(classifyCell(coverageOf([[T.DeepWater, 9], [T.Water, 9]]), REGION)).toBe(T.DeepWater);
    expect(classifyCell(coverageOf([[T.DeepWater, 9], [T.Grass, 9]]), REGION)).toBe(T.Grass);
  });

  it("draws minor streets as Road only where no building wins", () => {
    expect(classifyCell(coverageOf([[T.MinorRoad, 9], [T.Grass, 9]]), LOCAL)).toBe(T.Road);
    expect(classifyCell(coverageOf([[T.MinorRoad, 9], [T.Building, 3]]), LOCAL)).toBe(T.Building);
    expect(classifyCell(coverageOf([[T.MinorRoad, 9], [T.Park, 9]]), LOCAL)).toBe(T.Road);
  });

  it("classifies one NarrowWater sample as Water", () => {
    expect(classifyCell(coverageOf([[T.NarrowWater, 1], [T.Grass, 9]]), TOWN)).toBe(T.Water);
  });

  it("ranks Mountain above Forest above Hill", () => {
    expect(classifyCell(coverageOf([[T.Mountain, 5], [T.Forest, 9], [T.Hill, 9]]), REGION)).toBe(T.Mountain);
    expect(classifyCell(coverageOf([[T.Forest, 9], [T.Hill, 9]]), REGION)).toBe(T.Forest);
  });

  it("can exclude a terrain (used by road thinning)", () => {
    expect(classifyCell(coverageOf([[T.Road, 9], [T.Grass, 9]]), TOWN, T.Road)).toBe(T.Grass);
  });
});

describe("classifyFeature: per-zoom and per-LOD rules", () => {
  const spec = makeSpec();
  const road = (cls: string, type?: string) => feature(spec, "road", { type: "LineString", points: [[0, 0], [1, 1]] }, { cls, type });
  const terrainOf = (f: ReturnType<typeof road>, c: ReturnType<typeof ctx>) => classifyFeature(f, c)?.terrain ?? null;

  it("adds road classes gradually with zoom", () => {
    expect(terrainOf(road("motorway"), ctx("REGION", 8))).toBe(T.Road);
    expect(terrainOf(road("trunk"), ctx("REGION", 11.9))).toBeNull();
    expect(terrainOf(road("trunk"), ctx("TOWN", 12))).toBe(T.Road);
    expect(terrainOf(road("primary"), ctx("TOWN", 13.9))).toBeNull();
    expect(terrainOf(road("primary"), ctx("TOWN", 14))).toBe(T.Road);
    expect(terrainOf(road("street"), ctx("TOWN", 14.9))).toBeNull();
    // z15–16: minor streets only where no building is.
    expect(terrainOf(road("street"), ctx("LOCAL", 15.5))).toBe(T.MinorRoad);
    expect(terrainOf(road("street"), ctx("LOCAL", 16))).toBe(T.Road);
  });

  it("drops urban expressways below z13", () => {
    expect(terrainOf(road("motorway", "urban_expressway"), ctx("TOWN", 12.9))).toBeNull();
    expect(terrainOf(road("motorway", "urban_expressway"), ctx("TOWN", 13))).toBe(T.Road);
  });

  it("draws no roads at WORLD", () => {
    expect(terrainOf(road("motorway"), ctx("WORLD", 7))).toBeNull();
  });

  it("uses waterway lines only at LOCAL", () => {
    const river = feature(spec, "waterway", { type: "LineString", points: [[0, 0], [1, 1]] }, { cls: "river" });
    expect(terrainOf(river, LOCAL)).toBe(T.Water);
    expect(terrainOf(river, TOWN)).toBeNull();
  });

  it("maps urban landuse to Urban only where urbanAreas is on", () => {
    const res = feature(spec, "landuse", { type: "Polygon", rings: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, { cls: "residential" });
    expect(terrainOf(res, REGION)).toBe(T.Urban);
    expect(terrainOf(res, LOCAL)).toBeNull();
    const z12 = { ...res, sourceLayer: "landuse_z12" as const };
    expect(terrainOf(z12, TOWN)).toBe(T.Urban);
    expect(terrainOf(z12, REGION)).toBeNull();
  });

  it("treats wooded parks as Forest", () => {
    const park = (type: string) => feature(spec, "landuse", { type: "Polygon", rings: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, { cls: "park", type });
    expect(terrainOf(park("wood"), LOCAL)).toBe(T.Forest);
    expect(terrainOf(park("garden"), LOCAL)).toBe(T.Park);
  });

  it("takes relief from contours from z9 and from hillshade below", () => {
    const contour = (ele: number) => feature(spec, "contour", { type: "Polygon", rings: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, { props: { ele } });
    const shade = (level: number) => feature(spec, "hillshade", { type: "Polygon", rings: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, { cls: "shadow", props: { level } });
    // Contours feed the elevation grid; Mountain/Hill come from local relief (see tileGrid tests).
    expect(classifyFeature(contour(1000), ctx("REGION", 9))).toEqual({ mode: "elevation", ele: 1000 });
    expect(classifyFeature(contour(1000), ctx("REGION", 8.9))).toBeNull();
    expect(terrainOf(shade(78), ctx("REGION", 8.9))).toBe(T.Mountain);
    expect(terrainOf(shade(89), ctx("REGION", 8.9))).toBe(T.Hill);
    expect(terrainOf(shade(78), ctx("REGION", 9))).toBeNull();
    expect(terrainOf(contour(1000), LOCAL)).toBeNull();
  });

  const town = (symbolrank: number) => feature(spec, "place_label_z9", { type: "Point", point: [0, 0] }, { cls: "settlement", props: { symbolrank } });

  it("never shrinks the settlement rank limit when zooming in, up to TOWN", () => {
    for (const rank of [6, 8, 9, 10]) {
      let shown = false;
      for (let z = 4; z < 15; z += 0.5) {
        const now = terrainOf(town(rank), ctx(getGameLOD(z), z)) === T.Town;
        if (shown) expect(now, `rank ${rank} at z${z}`).toBe(true);
        shown ||= now;
      }
      expect(shown).toBe(true);
    }
  });

  it("grades the settlement rank limit with zoom at REGION, keeps it at TOWN, drops it at LOCAL", () => {
    expect(terrainOf(town(8), ctx("REGION", 8))).toBe(T.Town);
    expect(terrainOf(town(9), ctx("REGION", 8))).toBeNull();
    expect(terrainOf(town(10), ctx("REGION", 10))).toBe(T.Town);
    expect(terrainOf(town(11), ctx("REGION", 11))).toBeNull();
    expect(terrainOf(town(10), TOWN)).toBe(T.Town);
    expect(terrainOf(town(6), ctx("TOWN", 14.99))).toBe(T.Town);
    expect(terrainOf(town(6), LOCAL)).toBeNull(); // LOCAL: town interiors, no Town tiles
  });
});
