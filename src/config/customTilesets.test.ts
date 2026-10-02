import { describe, expect, it } from "vitest";
import { BLANK_TILE } from "../renderer/SpriteAtlas";
import { TerrainType } from "../world/TerrainType";
import { parseCustomTileset, type CustomTilesetJson } from "./customTilesets";
import { tileIdFor } from "./tileMappings";
import classic256 from "../../examples/tilesets/classic256/tileset.json";

const base: CustomTilesetJson = {
  id: "mine",
  name: "My tiles",
  image: "sheet.png",
  layout: { tileWidth: 16, tileHeight: 16, offsetX: 0, offsetY: 0, columns: 8 },
  tiles: { Water: 1, Grass: 4, Road: "blank", Floor: [9, 10], Unknown: 4 },
  letters: 32,
};

describe("parseCustomTileset", () => {
  it("builds a tile set with every terrain mapped", () => {
    const t = parseCustomTileset(base, "/tilesets/mine/sheet.png", "test");
    expect(t).toMatchObject({ id: "mine", name: "My tiles", url: "/tilesets/mine/sheet.png" });
    expect(tileIdFor(t.mapping, TerrainType.Water)).toBe(1);
    expect(tileIdFor(t.mapping, TerrainType.Road)).toBe(BLANK_TILE);
    expect(tileIdFor(t.mapping, TerrainType.Floor, 1)).toBe(10);
    // Terrains left out fall back to Unknown.
    expect(tileIdFor(t.mapping, TerrainType.Mountain)).toBe(4);
  });

  it("maps letters from the index of A, or from an explicit table", () => {
    expect(parseCustomTileset(base, "u", "test").glyphs).toMatchObject({ A: 32, Z: 57 });
    expect(parseCustomTileset({ ...base, letters: { A: 3, B: 5 } }, "u", "test").glyphs).toEqual({ A: 3, B: 5 });
    expect(parseCustomTileset({ ...base, letters: undefined }, "u", "test").glyphs).toEqual({});
  });

  it("reads flag rectangles", () => {
    const t = parseCustomTileset({ ...base, flags: { Town: [9, 5, 6, 6] } }, "u", "test");
    expect(t.flags?.[TerrainType.Town]).toEqual([9, 5, 6, 6]);
  });

  it("reads creatures and rejects bad ones", () => {
    const creatures = { defs: { orc: { frames: [3, 4], moves: "walk" }, dragon: { frames: [5], moves: "fly", fire: true } }, spawn: { deep: [], shallow: [], land: [["orc", 9], ["dragon", 1]] }, fireTile: 7 };
    const t = parseCustomTileset({ ...base, creatures } as unknown as CustomTilesetJson, "u", "test");
    expect(t.creatures?.defs.dragon).toEqual({ frames: [5], moves: "fly", fire: true });
    expect(t.creatures?.spawn.land).toEqual([["orc", 9], ["dragon", 1]]);
    const bad = (c: object) => () => parseCustomTileset({ ...base, creatures: c } as unknown as CustomTilesetJson, "u", "test");
    expect(bad({ ...creatures, defs: { orc: { frames: [], moves: "walk" } } })).toThrow(/frames/);
    expect(bad({ ...creatures, defs: { orc: { frames: [1], moves: "hop" } } })).toThrow(/moves/);
    expect(bad({ ...creatures, spawn: { land: [["ghost", 1]] } })).toThrow(/invalid entry/);
  });

  it("reads a warp gate and rejects a bad one", () => {
    expect(parseCustomTileset({ ...base, gate: { frames: [1, 2, 3] } }, "u", "test").gate).toEqual({ frames: [1, 2, 3] });
    expect(() => parseCustomTileset({ ...base, gate: { frames: [] } }, "u", "test")).toThrow(/gate.frames/);
  });

  it("rejects invalid files with a readable message", () => {
    const bad = (patch: object) => () => parseCustomTileset({ ...base, ...patch } as CustomTilesetJson, "u", "tilesets/x/tileset.json");
    expect(bad({ id: "original" })).toThrow(/"id"/);
    expect(bad({ tiles: { Water: 1 } })).toThrow(/"tiles.Unknown" is required/);
    expect(bad({ tiles: { Unknown: 4, Lava: 3 } })).toThrow(/unknown terrain "Lava"/);
    expect(bad({ tiles: { Unknown: -1 } })).toThrow(/"tiles.Unknown"/);
    expect(bad({ layout: { ...base.layout, columns: 0 } })).toThrow(/"layout.columns"/);
    expect(bad({ letters: { a: 1 } })).toThrow(/"letters.a"/);
    expect(bad({ flags: { Town: [10, 0, 8, 2] } })).toThrow(/"flags.Town"/); // runs past the 16 px tile
    expect(bad({ flags: { Lava: [0, 0, 1, 1] } })).toThrow(/unknown terrain "Lava" in "flags"/);
    expect(bad({ id: "original" })).toThrow(/^tilesets\/x\/tileset.json:/);
  });

  it("parses the example tile set, with every id inside its 16×16 sheet", () => {
    const t = parseCustomTileset(classic256 as unknown as CustomTilesetJson, "u", "examples/tilesets/classic256/tileset.json");
    const ids = [
      ...Object.values(t.mapping).flat(),
      ...Object.values(t.glyphs),
      ...Object.values(t.creatures!.defs).flatMap((d) => d.frames),
      t.creatures!.fireTile!,
      ...t.gate!.frames,
    ].filter((id) => id !== BLANK_TILE);
    expect(Math.max(...ids)).toBeLessThan(256);
  });
});
