import { describe, expect, it } from "vitest";
import { TerrainType } from "../../world/TerrainType";
import { computeGridSpec, worldToLngLat } from "../../world/tileGrid";
import type { TileFrame } from "../../world/tileResolver";
import { ORIGINAL_ATLAS_LAYOUT, ORIGINAL_FLAGS, ORIGINAL_GLYPHS, ORIGINAL_TILE_MAPPING } from "../../config/tileMappings";
import { glyphInstances, gridMatrix, labelBandInstances, multiply, snapToPixels, SPRITE_STRIDE, tileInstances, tileUV, type AtlasInfo } from "./instances";

// The original sheet is 256×48; the atlas appends a row, so the black tile is id 48.
const atlas: AtlasInfo = { layout: ORIGINAL_ATLAS_LAYOUT, blankTileId: 48, width: 256, height: 64, mapping: ORIGINAL_TILE_MAPPING, glyphs: ORIGINAL_GLYPHS, flags: ORIGINAL_FLAGS };

describe("tileUV", () => {
  it("returns the tile rectangle inset by half a texel", () => {
    // Tile 17 is column 1, row 1 of a 16-column 16×16 atlas.
    const [u0, v0, u1, v1] = tileUV(ORIGINAL_ATLAS_LAYOUT, 256, 48, 17);
    expect(u0).toBeCloseTo(16.5 / 256);
    expect(v0).toBeCloseTo(16.5 / 48);
    expect(u1).toBeCloseTo(31.5 / 256);
    expect(v1).toBeCloseTo(31.5 / 48);
  });
});

describe("instances", () => {
  const spec = computeGridSpec({ lng: 139.75, lat: 35.68 }, 13, 3, 2, 16);
  const frame: TileFrame = {
    spec,
    tiles: [TerrainType.Water, TerrainType.Road, TerrainType.Grass, TerrainType.Forest, TerrainType.Town, TerrainType.Water].map((terrain) => ({ terrain })),
    labels: [{ x: 0, y: 1, text: "AB C" }],
  };

  it("places one tile instance per cell at its cell coordinates", () => {
    const data = tileInstances(frame, atlas);
    expect(data.length).toBe(6 * SPRITE_STRIDE);
    const at = (i: number) => Array.from(data.slice(i * SPRITE_STRIDE, i * SPRITE_STRIDE + 2));
    expect(at(0)).toEqual([0, 0]);
    expect(at(4)).toEqual([1, 1]);
    // Cell 1 is a road, drawn with the appended black tile.
    expect(Array.from(data.slice(SPRITE_STRIDE + 2, SPRITE_STRIDE + 6))).toEqual(Array.from(new Float32Array(tileUV(atlas.layout, 256, 64, 48))));
    // Water cells scroll (value at offset 6), others do not.
    expect(data[6]).toBe(1);
    expect(data[SPRITE_STRIDE + 6]).toBe(0);
    // Cell 4 is a town: its flag rectangle (3×2 px at 7,1 in a 16×16 tile) in 0…1 tile coordinates.
    expect(Array.from(data.slice(4 * SPRITE_STRIDE + 7, 4 * SPRITE_STRIDE + 11))).toEqual(Array.from(new Float32Array([7 / 16, 1 / 16, 10 / 16, 3 / 16])));
    expect(Array.from(data.slice(7, 11))).toEqual([0, 0, 0, 0]);
    // Cell 0 is water.
    expect(Array.from(data.slice(2, 6))).toEqual(Array.from(new Float32Array(tileUV(atlas.layout, 256, 64, ORIGINAL_TILE_MAPPING[TerrainType.Water] as number))));
  });

  it("makes one glyph per letter (skipping spaces) and one band per name", () => {
    const glyphs = glyphInstances(frame, atlas);
    expect(glyphs.length / SPRITE_STRIDE).toBe(3);
    expect([glyphs[0], glyphs[SPRITE_STRIDE], glyphs[2 * SPRITE_STRIDE]]).toEqual([0, 1, 3]); // A, B, C (x = 2 is the space)
    expect(Array.from(labelBandInstances(frame, atlas, 0.25))).toEqual([-0.25, 1, 4.5, 1]);
  });
});

describe("gridMatrix", () => {
  it("maps cell coordinates to the same place as the Mercator matrix maps their world position", () => {
    const spec = computeGridSpec({ lng: 139.75, lat: 35.68 }, 17, 4, 4, 16);
    // An arbitrary Mercator → clip matrix (column-major).
    const merc = [3e5, 0, 0, 0, 0, -3e5, 0, 0, 0, 0, 1, 0, -2.66e5, 1.21e5, 0, 1];
    const m = gridMatrix(merc, spec);
    const apply = (mat: ArrayLike<number>, x: number, y: number) => [mat[0] * x + mat[4] * y + mat[12], mat[1] * x + mat[5] * y + mat[13]];
    const [cx, cy] = [2.5, 1.5];
    const mercX = (spec.originX + cx * spec.cellPx) / spec.worldSize;
    const mercY = (spec.originY + cy * spec.cellPx) / spec.worldSize;
    const expected = apply(merc, mercX, mercY);
    const actual = apply(m, cx, cy);
    expect(actual[0]).toBeCloseTo(expected[0], 3);
    expect(actual[1]).toBeCloseTo(expected[1], 3);
    expect(worldToLngLat(spec.originX, spec.originY, spec.worldSize)[0]).toBeLessThan(139.75); // sanity: grid starts west of centre
  });

  it("multiplies column-major 4×4 matrices", () => {
    const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const T = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 7, 0, 1];
    expect(multiply(I, T)).toEqual(T);
    expect(multiply(T, T).slice(12, 14)).toEqual([10, 14]);
  });
});

describe("snapToPixels", () => {
  it("moves the grid origin onto a whole device pixel, keeping the scale", () => {
    // Origin at NDC (0.0013, -0.0021) on a 1000×800 buffer: pixel (500.65, 399.16).
    const m = new Float32Array([0.032, 0, 0, 0, 0, -0.04, 0, 0, 0, 0, 1, 0, 0.0013, -0.0021, 0, 1]);
    const s = snapToPixels(m, 1000, 800);
    const px = ((s[12] / s[15] + 1) / 2) * 1000;
    const py = ((s[13] / s[15] + 1) / 2) * 800;
    expect(px).toBeCloseTo(Math.round(px), 3);
    expect(py).toBeCloseTo(Math.round(py), 3);
    expect(Math.abs(px - 500.65)).toBeLessThanOrEqual(0.5);
    expect(s[0]).toBeCloseTo(m[0]);
    expect(s[5]).toBeCloseTo(m[5]);
  });
});
