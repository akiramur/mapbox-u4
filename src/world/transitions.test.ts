import { describe, expect, it } from "vitest";
import { applyTransitions } from "./transitions";
import { TerrainType } from "./TerrainType";

const T = TerrainType;

/** Grid from rows of single-letter codes. */
const CODES: Record<string, TerrainType> = { D: T.DeepWater, W: T.Water, G: T.Grass, F: T.Forest, M: T.Mountain, R: T.Road, U: T.Unknown };
const grid = (rows: string[]) => ({ cols: rows[0].length, rows: rows.length, terrain: rows.join("").split("").map((c) => CODES[c]) });

describe("transition tiles", () => {
  it("makes a coast gradient: land → shallow → water → deep", () => {
    const g = grid(["GWDDD"]);
    const { terrain } = applyTransitions(g.terrain, g.cols, g.rows, "LOCAL");
    expect(terrain).toEqual([T.Grass, T.ShallowWater, T.Water, T.DeepWater, T.DeepWater]);
  });

  it("does not treat roads (bridges) as shore", () => {
    const g = grid(["WRW"]);
    const { terrain } = applyTransitions(g.terrain, g.cols, g.rows, "LOCAL");
    expect(terrain).toEqual([T.Water, T.Road, T.Water]);
  });

  it("adds foothills and forest edges only at WORLD/REGION", () => {
    const g = grid(["GMG", "GGG", "FGG"]);
    const region = applyTransitions(g.terrain, g.cols, g.rows, "REGION");
    expect(region.terrain[0]).toBe(T.Hill); // next to the mountain
    expect(region.rule[0]).toBe("foothills");
    expect(region.terrain[7]).toBe(T.Scrub); // edge-adjacent to the forest
    expect(region.terrain[8]).toBe(T.Grass); // adjacent to neither
    const g2 = grid(["GF", "GG"]);
    expect(applyTransitions(g2.terrain, 2, 2, "REGION").terrain[0]).toBe(T.Scrub);
    const local = applyTransitions(g.terrain, g.cols, g.rows, "LOCAL");
    expect(local.terrain).toEqual(g.terrain);
  });
});
