import { describe, expect, it } from "vitest";
import { TERRAIN_COUNT } from "../world/TerrainType";
import { BLANK_TILE } from "../renderer/SpriteAtlas";
import { ORIGINAL_ATLAS_LAYOUT, TILESETS, tileIdFor } from "./tileMappings";

describe("tile sets", () => {
  it("offers the original tile set first (the default)", () => {
    expect(TILESETS[0].id).toBe("original");
    expect(new Set(TILESETS.map((t) => t.id)).size).toBe(TILESETS.length);
  });

  it.each(TILESETS.map((t) => [t.id, t] as const))("%s maps every terrain and every letter", (_, t) => {
    for (let terrain = 0; terrain < TERRAIN_COUNT; terrain++) expect(tileIdFor(t.mapping, terrain)).toBeTypeOf("number");
    for (let i = 0; i < 26; i++) expect(t.glyphs[String.fromCharCode(65 + i)]).toBeTypeOf("number");
  });

  it("keeps original tile indices inside the generated 16×3 atlas", () => {
    const original = TILESETS[0];
    const ids = [...Array(TERRAIN_COUNT).keys()].map((t) => tileIdFor(original.mapping, t) as number).filter((id) => id !== BLANK_TILE).concat(Object.values(original.glyphs));
    expect(Math.max(...ids)).toBeLessThan(ORIGINAL_ATLAS_LAYOUT.columns * 3);
  });

  it("keeps creature, fireball, gate and townsfolk tiles inside tiles.png, without overlaps", () => {
    const tileCount = 16 * 8; // tiles.png is 256×128 (npm run make-atlas prints the size)
    const { creatures, gate } = TILESETS[0];
    const frames = Object.values(creatures!.defs).flatMap((d) => d.frames);
    const ids = [...frames, creatures!.fireTile!, ...gate!.frames];
    expect(new Set(ids).size).toBe(ids.length);
    expect(Math.min(...ids)).toBe(48);
    expect(Math.max(...ids)).toBeLessThan(tileCount);
    expect(creatures!.spawn.town!.length).toBeGreaterThan(0);
    for (const [id] of creatures!.spawn.town!) expect(creatures!.defs[id].moves).toBe("town");
  });
});
