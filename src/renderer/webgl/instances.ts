import { SCROLLING_TERRAINS, tileIdFor, type FlagRects, type GlyphMapping, type TileMapping } from "../../config/tileMappings";
import { BLANK_TILE } from "../SpriteAtlas";
import type { GridSpec } from "../../world/tileGrid";
import type { TileFrame } from "../../world/tileResolver";
import type { AtlasLayout } from "../SpriteAtlas";

/**
 * Pure helpers for the WebGL tile layer: per-instance vertex data and the
 * grid → clip-space matrix. Kept free of GL calls so they can be unit-tested.
 *
 * Instances are in *cell units* (cell x, y as small numbers); the matrix maps
 * them to Mercator and then to clip space. Building that matrix in JS doubles
 * keeps high zooms (z17+, where a cell is ~2e-7 of the world) free of float32
 * jitter.
 */

/**
 * Floats per tile/glyph instance: cell x, cell y, u0, v0, u1, v1, scroll
 * (1 = scrolling water), then the flag rectangle in tile-local 0…1 coords
 * (x0, y0, x1, y1; all 0 = no flag).
 */
export const SPRITE_STRIDE = 11;
/** Floats per solid-rectangle instance: x, y, width, height (cell units). */
export const RECT_STRIDE = 4;

/** Texture-space rectangle [u0, v0, u1, v1] of a tile, inset by half a texel so NEAREST never picks a neighbour. */
export function tileUV(layout: AtlasLayout, imageWidth: number, imageHeight: number, id: number): [number, number, number, number] {
  const sx = layout.offsetX + (id % layout.columns) * layout.tileWidth;
  const sy = layout.offsetY + Math.floor(id / layout.columns) * layout.tileHeight;
  return [(sx + 0.5) / imageWidth, (sy + 0.5) / imageHeight, (sx + layout.tileWidth - 0.5) / imageWidth, (sy + layout.tileHeight - 0.5) / imageHeight];
}

export interface AtlasInfo {
  layout: AtlasLayout;
  /** Tile id that BLANK_TILE maps to in this atlas. */
  blankTileId: number;
  width: number;
  height: number;
  mapping: TileMapping;
  glyphs: GlyphMapping;
  flags?: FlagRects;
}

/** True if any cell uses a scrolling (animated) tile. */
/** True if any cell uses a scrolling (water) or fluttering (flag) tile. */
export function hasAnimatedTiles(frame: TileFrame, flags: FlagRects = {}): boolean {
  return frame.tiles.some((t) => SCROLLING_TERRAINS.has(t.terrain) || flags[t.terrain] !== undefined);
}

/** A flag rectangle in tile-local 0…1 coordinates, or zeros. */
export function flagRectLocal(atlas: Pick<AtlasInfo, "layout" | "flags">, terrain: number): [number, number, number, number] {
  const r = atlas.flags?.[terrain as keyof FlagRects];
  if (!r) return [0, 0, 0, 0];
  const { tileWidth: w, tileHeight: h } = atlas.layout;
  return [r[0] / w, r[1] / h, (r[0] + r[2]) / w, (r[1] + r[3]) / h];
}

/** One instance per grid cell. */
export function tileInstances(frame: TileFrame, atlas: AtlasInfo): Float32Array {
  const { cols } = frame.spec;
  const out = new Float32Array(frame.tiles.length * SPRITE_STRIDE);
  const uvCache = new Map<number, [number, number, number, number]>();
  frame.tiles.forEach((tile, i) => {
    const mapped = tileIdFor(atlas.mapping, tile.terrain, tile.variant);
    const id = mapped === BLANK_TILE ? atlas.blankTileId : mapped;
    let uv = uvCache.get(id);
    if (!uv) uvCache.set(id, (uv = tileUV(atlas.layout, atlas.width, atlas.height, id)));
    out.set([i % cols, Math.floor(i / cols), ...uv, SCROLLING_TERRAINS.has(tile.terrain) ? 1 : 0, ...flagRectLocal(atlas, tile.terrain)], i * SPRITE_STRIDE);
  });
  return out;
}

/** One instance per creature or fireball sprite (cell x, y and tile id). */
export function creatureInstances(sprites: { x: number; y: number; tile: number }[], atlas: AtlasInfo): Float32Array {
  const out = new Float32Array(sprites.length * SPRITE_STRIDE);
  sprites.forEach((s, i) => out.set([s.x, s.y, ...tileUV(atlas.layout, atlas.width, atlas.height, s.tile), 0, 0, 0, 0, 0], i * SPRITE_STRIDE));
  return out;
}

/** One instance per letter of every placed name (spaces skipped). */
export function glyphInstances(frame: TileFrame, atlas: AtlasInfo): Float32Array {
  const values: number[] = [];
  for (const label of frame.labels) {
    [...label.text].forEach((char, k) => {
      const id = atlas.glyphs[char];
      if (id === undefined) return;
      values.push(label.x + k, label.y, ...tileUV(atlas.layout, atlas.width, atlas.height, id), 0, 0, 0, 0, 0);
    });
  }
  return new Float32Array(values);
}

/** Translucent band behind each name, padded by `padCells` on the left and right. */
export function labelBandInstances(frame: TileFrame, atlas: AtlasInfo, padCells: number): Float32Array {
  const values: number[] = [];
  for (const label of frame.labels) {
    if (![...label.text].some((c) => atlas.glyphs[c] !== undefined)) continue;
    values.push(label.x - padCells, label.y, label.text.length + 2 * padCells, 1);
  }
  return new Float32Array(values);
}

/** Column-major 4×4 multiply (a × b), in doubles. */
export function multiply(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const out = new Array<number>(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  }
  return out;
}

/**
 * Cell units → clip space: Mapbox's Mercator matrix × translate(grid origin) ×
 * scale(one cell in Mercator units). Mercator x/y are world pixels / worldSize.
 */
export function gridMatrix(mercatorMatrix: ArrayLike<number>, spec: GridSpec): Float32Array {
  const s = spec.cellPx / spec.worldSize;
  const tx = spec.originX / spec.worldSize;
  const ty = spec.originY / spec.worldSize;
  // prettier-ignore
  const model = [
    s, 0, 0, 0,
    0, s, 0, 0,
    0, 0, 1, 0,
    tx, ty, 0, 1,
  ];
  return new Float32Array(multiply(mercatorMatrix, model));
}

/**
 * Shifts a cell → clip matrix so the grid origin lands exactly on a device
 * pixel. Otherwise, with nearest-neighbour sampling, texel edges fall
 * between pixels and rows shift unevenly (visible as shimmer on moving water).
 * The shift is the same for every point on the (unpitched) map plane.
 */
export function snapToPixels(m: Float32Array, widthPx: number, heightPx: number): Float32Array {
  const w = m[15];
  if (!w) return m;
  const px = ((m[12] / w + 1) / 2) * widthPx;
  const py = ((m[13] / w + 1) / 2) * heightPx;
  const dx = ((Math.round(px) - px) / widthPx) * 2;
  const dy = ((Math.round(py) - py) / heightPx) * 2;
  const out = new Float32Array(m);
  // Add d·w to clip x/y, i.e. d to NDC, for every point.
  out[0] += dx * m[3];
  out[4] += dx * m[7];
  out[12] += dx * m[15];
  out[1] += dy * m[3];
  out[5] += dy * m[7];
  out[13] += dy * m[15];
  return out;
}
