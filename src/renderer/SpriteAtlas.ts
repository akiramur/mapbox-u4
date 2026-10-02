import { DEBUG_COLORS } from "../config/debugColors";
import { TERRAIN_COUNT, TerrainType } from "../world/TerrainType";

/** Where tiles live inside an atlas image. Tile IDs are row-major from the top-left. */
export interface AtlasLayout {
  /** Size of one tile inside the image (source pixels). */
  tileWidth: number;
  tileHeight: number;
  /** Offset of tile 0 from the image's top-left corner. */
  offsetX: number;
  offsetY: number;
  columns: number;
}

export type TileId = number;

/**
 * A plain black tile. Neither tile set has a fully black tile, so every atlas
 * gets one appended (see SpriteAtlas.withBlankTile) and mappings refer to it
 * with this id.
 */
export const BLANK_TILE: TileId = -1;

/**
 * A sprite sheet plus the layout needed to cut tiles out of it. Knows nothing
 * about terrain — the TerrainType → TileId mapping lives in config/tileMappings.
 */
export class SpriteAtlas {
  readonly image: HTMLCanvasElement;
  /** Id of the black tile appended below the sheet. */
  readonly blankTileId: TileId;

  /** `image` is copied with one extra row of tiles below it; the first tile of that row is black. */
  constructor(
    readonly name: string,
    image: HTMLImageElement | HTMLCanvasElement,
    readonly layout: AtlasLayout,
  ) {
    const rowsInSheet = Math.floor((image.height - layout.offsetY) / layout.tileHeight);
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = layout.offsetY + (rowsInSheet + 1) * layout.tileHeight;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0);
    ctx.fillRect(0, layout.offsetY + rowsInSheet * layout.tileHeight, canvas.width, layout.tileHeight);
    this.image = canvas;
    this.blankTileId = rowsInSheet * layout.columns;
  }

  static async load(name: string, url: string, layout: AtlasLayout): Promise<SpriteAtlas> {
    const img = new Image();
    img.src = url;
    await img.decode();
    return new SpriteAtlas(name, img, layout);
  }

  /** Maps BLANK_TILE to this atlas's black tile. */
  resolve(id: TileId): TileId {
    return id === BLANK_TILE ? this.blankTileId : id;
  }

  private keyed: HTMLCanvasElement | null = null;

  /**
   * The atlas with (near-)black pixels made transparent, for drawing letters
   * over terrain so only the strokes show. Built once, on first use.
   */
  get keyedImage(): CanvasImageSource {
    if (!this.keyed) {
      const img = this.image;
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const px = data.data;
      for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] < 60) px[i + 3] = 0;
      ctx.putImageData(data, 0, 0);
      this.keyed = canvas;
    }
    return this.keyed;
  }

  /** Source rectangle [sx, sy, sw, sh] of a tile in the atlas image. */
  sourceRect(id: TileId): [number, number, number, number] {
    id = this.resolve(id);
    const { tileWidth, tileHeight, offsetX, offsetY, columns } = this.layout;
    return [offsetX + (id % columns) * tileWidth, offsetY + Math.floor(id / columns) * tileHeight, tileWidth, tileHeight];
  }
}

/**
 * Procedurally generated 16×16 atlas used when the real atlas is unavailable.
 * Tile ID n corresponds to TerrainType n (see PLACEHOLDER_TILE_MAPPING).
 */
export function createPlaceholderAtlas(options: { dither?: boolean; name?: string } = {}): SpriteAtlas {
  const { dither = true, name = "placeholder" } = options;
  const size = 16;
  const canvas = document.createElement("canvas");
  canvas.width = size * TERRAIN_COUNT;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  for (let t = 0; t < TERRAIN_COUNT; t++) {
    const x0 = t * size;
    ctx.fillStyle = DEBUG_COLORS[t as TerrainType];
    ctx.fillRect(x0, 0, size, size);
    if (!dither) continue;
    // A simple 2-pixel dither so tiles read as "texture" rather than flat fill.
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    for (let y = 0; y < size; y += 4) {
      for (let x = (y / 4) % 2 ? 2 : 0; x < size; x += 4) ctx.fillRect(x0 + x, y, 2, 2);
    }
  }
  return new SpriteAtlas(name, canvas, { tileWidth: size, tileHeight: size, offsetX: 0, offsetY: 0, columns: TERRAIN_COUNT });
}
