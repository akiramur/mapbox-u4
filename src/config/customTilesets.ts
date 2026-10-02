import { BLANK_TILE, type AtlasLayout, type TileId } from "../renderer/SpriteAtlas";
import { TERRAIN_COUNT, TerrainType, terrainName } from "../world/TerrainType";
import type { CreatureSet, FlagRects, GateDef, GlyphMapping, TileMapping, TilesetConfig } from "./tileMappings";

/**
 * Bring-your-own tile sets. Put a sprite sheet and a `tileset.json` in
 * `tilesets/<folder>/` at the repository root (the folder is git-ignored);
 * they are picked up at build time and appear in the tile set selector.
 *
 * tileset.json:
 * {
 *   "id": "mytiles",                  // unique; not "original"
 *   "name": "My tiles",               // shown in the selector
 *   "image": "sheet.png",             // file next to tileset.json
 *   "layout": { "tileWidth": 16, "tileHeight": 16, "offsetX": 0, "offsetY": 0, "columns": 16 },
 *   "tiles": { "Water": 1, "Grass": 4, "Road": "blank", "Floor": [62, 63], ... },
 *   "letters": 96,                    // index of "A" (A–Z consecutive), or { "A": 96, ... }; optional
 *   "flags": { "Town": [9, 5, 6, 6] }, // flag rectangles [x, y, w, h] in tile pixels that flutter; optional
 *   "creatures": {                    // wandering creatures; optional
 *     "defs": { "orc": { "frames": [192, 193], "moves": "walk" }, "dragon": { "frames": [248], "moves": "fly", "fire": true } },
 *     "spawn": { "deep": [], "shallow": [], "land": [["orc", 9], ["dragon", 1]], "town": [["villager", 3]] },
 *     "fireTile": 79
 *   },
 *   "gate": { "frames": [64, 65, 66, 67] } // warp gate: rising stages, then open (last); optional
 * }
 *
 * Tile ids count row-major from the top-left tile. Keys of "tiles" are
 * TerrainType names; "blank" is a plain black tile. Terrains left out use the
 * "Unknown" entry, which is required.
 */

export interface CustomTilesetJson {
  id: string;
  name: string;
  image: string;
  layout: AtlasLayout;
  tiles: Record<string, number | number[] | "blank">;
  letters?: number | Record<string, number>;
  /** Optional flag rectangles that flutter: { "Town": [x, y, w, h], ... } in tile pixels. */
  flags?: Record<string, [number, number, number, number]>;
  /** Optional wandering creatures (see CreatureSet). */
  creatures?: CreatureSet;
  /** Optional warp gate (see GateDef). */
  gate?: GateDef;
}

const TERRAIN_BY_NAME = new Map<string, TerrainType>(Array.from({ length: TERRAIN_COUNT }, (_, t) => [terrainName(t), t as TerrainType]));

/** Validates a tileset.json and turns it into a TilesetConfig. Throws with a readable message. */
export function parseCustomTileset(json: CustomTilesetJson, imageUrl: string, source: string): TilesetConfig {
  const fail = (msg: string): never => {
    throw new Error(`${source}: ${msg}`);
  };
  if (!json || typeof json !== "object") fail("not a JSON object");
  if (typeof json.id !== "string" || !json.id || json.id === "original") fail('"id" must be a non-empty string other than "original"');
  if (typeof json.name !== "string" || !json.name) fail('"name" must be a non-empty string');
  const l = json.layout;
  for (const k of ["tileWidth", "tileHeight", "offsetX", "offsetY", "columns"] as const) {
    if (!l || typeof l[k] !== "number" || l[k] < 0 || (k !== "offsetX" && k !== "offsetY" && l[k] <= 0)) fail(`"layout.${k}" must be a positive number`);
  }

  const toId = (v: unknown, key: string): TileId | TileId[] => {
    if (v === "blank") return BLANK_TILE;
    if (typeof v === "number" && Number.isInteger(v) && v >= 0) return v;
    if (Array.isArray(v) && v.length && v.every((n) => Number.isInteger(n) && n >= 0)) return v as number[];
    return fail(`"tiles.${key}" must be a tile id, a list of tile ids, or "blank"`);
  };
  const tiles = json.tiles ?? {};
  for (const key of Object.keys(tiles)) if (!TERRAIN_BY_NAME.has(key)) fail(`unknown terrain "${key}" in "tiles" (known: ${[...TERRAIN_BY_NAME.keys()].join(", ")})`);
  if (tiles.Unknown === undefined) fail('"tiles.Unknown" is required (it is used for terrains left out)');
  const fallback = toId(tiles.Unknown, "Unknown");
  const mapping = Object.fromEntries(
    Array.from({ length: TERRAIN_COUNT }, (_, t) => {
      const name = terrainName(t);
      return [t, tiles[name] === undefined ? fallback : toId(tiles[name], name)];
    }),
  ) as TileMapping;

  let glyphs: GlyphMapping = {};
  if (typeof json.letters === "number") {
    glyphs = Object.fromEntries(Array.from({ length: 26 }, (_, i) => [String.fromCharCode(65 + i), (json.letters as number) + i]));
  } else if (json.letters && typeof json.letters === "object") {
    for (const [ch, id] of Object.entries(json.letters)) {
      if (!/^[A-Z]$/.test(ch) || !Number.isInteger(id) || id < 0) fail(`"letters.${ch}" must map a capital letter A–Z to a tile id`);
    }
    glyphs = { ...json.letters };
  }

  const flags: FlagRects = {};
  for (const [key, rect] of Object.entries(json.flags ?? {})) {
    const t = TERRAIN_BY_NAME.get(key);
    if (t === undefined) fail(`unknown terrain "${key}" in "flags"`);
    const ok = Array.isArray(rect) && rect.length === 4 && rect.every((n) => Number.isInteger(n) && n >= 0);
    if (!ok || rect[2] <= 0 || rect[3] <= 0 || rect[0] + rect[2] > l.tileWidth || rect[1] + rect[3] > l.tileHeight) {
      fail(`"flags.${key}" must be [x, y, width, height] inside a ${l.tileWidth}×${l.tileHeight} tile`);
    }
    flags[t!] = [...rect] as [number, number, number, number];
  }

  let creatures: CreatureSet | undefined;
  if (json.creatures !== undefined) {
    const c = json.creatures;
    if (!c || typeof c !== "object" || !c.defs || !c.spawn) fail('"creatures" must have "defs" and "spawn"');
    const isId = (n: unknown) => Number.isInteger(n) && (n as number) >= 0;
    for (const [id, d] of Object.entries(c.defs)) {
      if (!d || !Array.isArray(d.frames) || !d.frames.length || !d.frames.every(isId)) fail(`"creatures.defs.${id}.frames" must be a non-empty list of tile ids`);
      if (!["sail", "swim", "walk", "fly", "town"].includes(d.moves)) fail(`"creatures.defs.${id}.moves" must be "sail", "swim", "walk", "fly" or "town"`);
    }
    for (const key of ["deep", "shallow", "land", "town"] as const) {
      const table = c.spawn[key] ?? [];
      if (!Array.isArray(table)) fail(`"creatures.spawn.${key}" must be a list of [creature, weight]`);
      for (const entry of table) {
        if (!Array.isArray(entry) || !(entry[0] in c.defs) || typeof entry[1] !== "number" || entry[1] < 0) {
          fail(`"creatures.spawn.${key}" has an invalid entry ${JSON.stringify(entry)} (unknown creature or bad weight)`);
        }
      }
    }
    if (c.fireTile !== undefined && !isId(c.fireTile)) fail('"creatures.fireTile" must be a tile id');
    creatures = {
      defs: Object.fromEntries(Object.entries(c.defs).map(([id, d]) => [id, { frames: [...d.frames], moves: d.moves, fire: !!d.fire }])),
      spawn: { deep: [...(c.spawn.deep ?? [])], shallow: [...(c.spawn.shallow ?? [])], land: [...(c.spawn.land ?? [])], town: [...(c.spawn.town ?? [])] },
      fireTile: c.fireTile,
    };
  }

  let gate: GateDef | undefined;
  if (json.gate !== undefined) {
    const f = json.gate?.frames;
    if (!Array.isArray(f) || !f.length || !f.every((n) => Number.isInteger(n) && n >= 0)) fail('"gate.frames" must be a non-empty list of tile ids (rising stages, then the open gate)');
    gate = { frames: [...f] };
  }

  return { id: json.id, name: json.name, url: imageUrl, layout: { ...l }, mapping, glyphs, flags, creatures, gate };
}

const configs = import.meta.glob<CustomTilesetJson>("/tilesets/*/tileset.json", { eager: true, import: "default" });
const images = import.meta.glob<string>("/tilesets/*/*.{png,gif,webp}", { eager: true, query: "?url", import: "default" });

function loadCustomTilesets(): TilesetConfig[] {
  const out: TilesetConfig[] = [];
  for (const [path, json] of Object.entries(configs)) {
    const dir = path.slice(0, path.lastIndexOf("/") + 1);
    try {
      const imageUrl = images[dir + json?.image];
      if (!imageUrl) throw new Error(`${path}: image "${json?.image}" not found next to tileset.json`);
      out.push(parseCustomTileset(json, imageUrl, path));
    } catch (e) {
      console.error(`Custom tile set skipped: ${(e as Error).message}`);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export const CUSTOM_TILESETS: TilesetConfig[] = loadCustomTilesets();
