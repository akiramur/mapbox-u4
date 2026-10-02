import { DEBUG_COLORS } from "../config/debugColors";
import { tileIdFor, type GlyphMapping, type TileMapping } from "../config/tileMappings";
import type { SpriteAtlas } from "./SpriteAtlas";
import type { TileFrame } from "../world/tileResolver";

/**
 * Minimal renderer abstraction. Implementations draw a TileFrame into their own
 * canvas; placement on screen is the caller's job. Swap this for a WebGL
 * instanced renderer or a Mapbox CustomLayer later without touching the
 * classification pipeline.
 */
export interface TileRenderer {
  readonly canvas: HTMLCanvasElement;
  render(frame: TileFrame): void;
}

export interface RenderOptions {
  showGridLines: boolean;
}

/** Phase 1 renderer: one flat colour per logical terrain. */
export class DebugColorRenderer implements TileRenderer {
  readonly canvas = document.createElement("canvas");
  options: RenderOptions = { showGridLines: false };

  render(frame: TileFrame): void {
    const { cols, rows, cellPx } = frame.spec;
    this.canvas.width = cols * cellPx;
    this.canvas.height = rows * cellPx;
    const ctx = this.canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        ctx.fillStyle = DEBUG_COLORS[frame.tiles[y * cols + x].terrain];
        ctx.fillRect(x * cellPx, y * cellPx, cellPx, cellPx);
      }
    }
    if (this.options.showGridLines) drawGridLines(ctx, cols, rows, cellPx);
  }
}

export function drawGridLines(ctx: CanvasRenderingContext2D, cols: number, rows: number, cellPx: number) {
  ctx.strokeStyle = "rgba(0,0,0,0.25)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= cols; x++) {
    ctx.moveTo(x * cellPx + 0.5, 0);
    ctx.lineTo(x * cellPx + 0.5, rows * cellPx);
  }
  for (let y = 0; y <= rows; y++) {
    ctx.moveTo(0, y * cellPx + 0.5);
    ctx.lineTo(cols * cellPx, y * cellPx + 0.5);
  }
  ctx.stroke();
}

/** Band behind place names: dark but translucent, so the terrain stays visible. */
const LABEL_BACKGROUND = "rgba(0, 0, 0, 0.6)";
const LABEL_PADDING_PX = 3;

/** Draws each cell with one sprite from the atlas, nearest-neighbour scaled to cellPx. */
export class SpriteTileRenderer implements TileRenderer {
  readonly canvas = document.createElement("canvas");
  options: RenderOptions = { showGridLines: false };

  constructor(
    readonly atlas: SpriteAtlas,
    readonly mapping: TileMapping,
    readonly glyphs: GlyphMapping = {},
  ) {}

  render(frame: TileFrame): void {
    const { cols, rows, cellPx } = frame.spec;
    this.canvas.width = cols * cellPx;
    this.canvas.height = rows * cellPx;
    const ctx = this.canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const tile = frame.tiles[y * cols + x];
        const [sx, sy, sw, sh] = this.atlas.sourceRect(tileIdFor(this.mapping, tile.terrain, tile.variant));
        ctx.drawImage(this.atlas.image, sx, sy, sw, sh, x * cellPx, y * cellPx, cellPx, cellPx);
      }
    }
    // Place names: a translucent dark band behind each name, then letter tiles
    // with black keyed out, so the terrain still shows through.
    for (const label of frame.labels) {
      if (![...label.text].some((c) => this.glyphs[c] !== undefined)) continue;
      ctx.fillStyle = LABEL_BACKGROUND;
      ctx.fillRect(label.x * cellPx - LABEL_PADDING_PX, label.y * cellPx, label.text.length * cellPx + 2 * LABEL_PADDING_PX, cellPx);
      [...label.text].forEach((char, k) => {
        const id = this.glyphs[char];
        if (id === undefined) return;
        const [sx, sy, sw, sh] = this.atlas.sourceRect(id);
        ctx.drawImage(this.atlas.keyedImage, sx, sy, sw, sh, (label.x + k) * cellPx, label.y * cellPx, cellPx, cellPx);
      });
    }
    if (this.options.showGridLines) drawGridLines(ctx, cols, rows, cellPx);
  }
}
