import { describe, expect, it } from "vitest";
import { resolveTile, VILLAGE_SPACING, type ResolveInput } from "./tileResolver";
import { TerrainType } from "./TerrainType";

const T = TerrainType;
// Far from any override.
const base: Omit<ResolveInput, "terrain" | "worldCell"> = { longitude: 0, latitude: 0, bounds: [0, 0, 0, 0], zoom: 11, lod: "REGION" };
const resolveAt = (gx: number, gy: number, terrain = T.Urban) => resolveTile({ ...base, terrain, worldCell: [gx, gy] });

describe("village spacing", () => {
  const N = 150;
  const villages: [number, number][] = [];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (resolveAt(x, y).terrain === T.Building) villages.push([x, y]);

  it("keeps villages more than VILLAGE_SPACING cells apart", () => {
    const set = new Set(villages.map(([x, y]) => `${x},${y}`));
    for (const [x, y] of villages) {
      for (let dy = -VILLAGE_SPACING; dy <= VILLAGE_SPACING; dy++) {
        for (let dx = -VILLAGE_SPACING; dx <= VILLAGE_SPACING; dx++) {
          if (dx || dy) expect(set.has(`${x + dx},${y + dy}`)).toBe(false);
        }
      }
    }
  });

  it("has roughly 1 / (2r+1)² density", () => {
    const expected = (N * N) / (2 * VILLAGE_SPACING + 1) ** 2;
    expect(villages.length).toBeGreaterThan(expected * 0.6);
    expect(villages.length).toBeLessThan(expected * 1.6);
  });

  it("depends only on the world cell, so panning does not change it", () => {
    for (const [x, y] of villages.slice(0, 20)) {
      expect(resolveTile({ ...base, longitude: 12, latitude: 34, zoom: 11.7, terrain: T.Urban, worldCell: [x, y] }).terrain).toBe(T.Building);
    }
  });

  it("turns non-village Urban cells into grassland and leaves other terrain alone", () => {
    const non = [...Array(50).keys()].map((i) => resolveAt(i, 7)).find((r) => r.terrain !== T.Building)!;
    expect(non.terrain).toBe(T.Grass);
    expect(non.rule).toBe("village-spacing");
    expect(resolveAt(3, 3, T.Forest).terrain).toBe(T.Forest);
    expect(resolveTile({ ...base, lod: "LOCAL", terrain: T.Building, worldCell: [3, 3] }).terrain).toBe(T.Building);
  });
});

describe("area overrides", () => {
  it("turns the Imperial Palace into a castle and Tokyo Station into a town, at TOWN only", () => {
    const station = { longitude: 139.7671, latitude: 35.6812, bounds: [139.766, 35.68, 139.768, 35.682] as [number, number, number, number], worldCell: [0, 0] as [number, number], terrain: T.Building };
    expect(resolveTile({ ...station, lod: "TOWN", zoom: 13 }).terrain).toBe(T.Town);
    expect(resolveTile({ ...station, lod: "LOCAL", zoom: 15 }).terrain).toBe(T.Building);
    const palace = { longitude: 139.7528, latitude: 35.6852, bounds: [139.75, 35.68, 139.76, 35.69] as [number, number, number, number], worldCell: [0, 0] as [number, number], terrain: T.Park, zoom: 15 };
    expect(resolveTile({ ...palace, lod: "TOWN", zoom: 13 })).toMatchObject({ terrain: T.Castle, overrideId: "tokyo-imperial-palace" });
    expect(resolveTile({ ...palace, lod: "LOCAL" }).terrain).toBe(T.Park); // LOCAL draws the palace grounds instead
    expect(resolveTile({ ...palace, lod: "REGION", zoom: 10 }).terrain).toBe(T.Park);
  });
});
