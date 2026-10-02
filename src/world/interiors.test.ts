import { describe, expect, it } from "vitest";
import { applyInteriors } from "./interiors";
import { TerrainType } from "./TerrainType";

const T = TerrainType;
const CODES: Record<string, TerrainType> = { B: T.Building, R: T.Road, G: T.Grass };
const run = (rows: string[]) => {
  const cols = rows[0].length;
  const terrain = rows.join("").split("").map((c) => CODES[c]);
  return { cols, ...applyInteriors(terrain, cols, rows.length) };
};

describe("town interiors", () => {
  it("turns a building into walls around a floor, with no doors", () => {
    const r = run(["GGGGGGG", "GBBBBBG", "GBBBBBG", "GBBBBBG", "GBBBBBG", "GBBBBBG", "RRRRRRR"]);
    const at = (x: number, y: number) => r.terrain[y * r.cols + x];
    for (let y = 2; y <= 4; y++) for (let x = 2; x <= 4; x++) expect(at(x, y)).toBe(T.Floor);
    for (let x = 1; x <= 5; x++) expect(at(x, 5)).toBe(T.Wall); // road-facing side is plain wall
    expect(at(1, 1)).toBe(T.Wall);
    expect(at(0, 0)).toBe(T.Grass);
  });

  it("makes a block with no inner cell solid wall", () => {
    const r = run(["GGGG", "GBBG", "GBBG", "GGGG"]);
    expect(r.terrain.filter((t) => t === T.Floor)).toHaveLength(0);
    expect(r.terrain.filter((t) => t === T.Wall)).toHaveLength(4);
  });
});
