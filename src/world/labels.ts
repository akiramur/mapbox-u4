import type { GeoFeature } from "../map/featureExtractor";
import type { GameLOD } from "./gameLOD";
import { classifyFeature } from "./terrainClassifier";
import { cellsAtLngLat, type TileGrid } from "./tileGrid";
import { TerrainType } from "./TerrainType";

/**
 * Place names drawn with tile-sized letters over the terrain, one letter per
 * cell. Letters are logical characters (A–Z); config/tileMappings maps them to
 * atlas tiles, so replacing the atlas does not touch this module.
 *
 * - Settlements are labelled exactly where their Town tile is (same features,
 *   same rules), on the row above it, or below if that does not fit.
 * - Countries are labelled at WORLD, centred on their label point.
 * - Each name appears once. Mapbox repeats labels of big countries; the copy
 *   nearest the grid centre is kept.
 * - Labels never overlap each other or a Town tile, and keep a one-cell
 *   margin from other labels. Higher-priority labels are placed first
 *   (countries, then settlements by symbolrank); the rest are dropped.
 */

/** A placed name: its letters occupy cells x .. x + text.length - 1 on row y. */
export interface PlacedLabel {
  x: number;
  y: number;
  /** A–Z and spaces (word gaps). */
  text: string;
}

/** Where names are drawn. LOCAL shows town interiors and has no Town tiles, so no labels. */
const LABEL_LODS: GameLOD[] = ["WORLD", "REGION", "TOWN"];
const COUNTRY_LODS: GameLOD[] = ["WORLD"];

/** Upper-case A–Z only: diacritics are stripped and anything else becomes a word gap. */
export function labelText(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z]+/g, " ")
    .trim();
}

interface Candidate {
  text: string;
  /** World copy the label is in (several when zoomed out below ~z1). */
  copy: number;
  cx: number;
  cy: number;
  /** Lower is placed first. */
  priority: number;
  /** Rows to try, relative to the anchor cell. */
  rows: number[];
}

export function placeLabels(grid: TileGrid): PlacedLabel[] {
  const { spec, ctx } = grid;
  if (!LABEL_LODS.includes(ctx.lod)) return [];

  // One candidate per name and world copy: of Mapbox's repeated labels, the one nearest the grid centre.
  const byText = new Map<string, Candidate>();
  const dist = (c: Candidate) => Math.hypot(c.cx - spec.cols / 2, c.cy - spec.rows / 2);
  for (const f of grid.features) {
    if (f.sourceLayer !== "place_label_z9") continue;
    for (const c of candidatesFor(f, grid)) {
      const key = `${c.text}@${c.copy}`;
      const prev = byText.get(key);
      if (!prev || dist(c) < dist(prev)) byText.set(key, c);
    }
  }
  const candidates = [...byText.values()].sort((a, b) => a.priority - b.priority || a.text.localeCompare(b.text));

  const { cols, rows } = spec;
  // Cells a label may not use: other labels (with a one-cell gap) and Town tiles.
  const blocked = new Uint8Array(cols * rows);
  grid.terrain.forEach((t, i) => {
    if (t === TerrainType.Town) blocked[i] = 1;
  });

  const placed: PlacedLabel[] = [];
  for (const c of candidates) {
    const x0 = c.cx - Math.floor((c.text.length - 1) / 2);
    const x1 = x0 + c.text.length - 1;
    if (x0 < 0 || x1 >= cols) continue;
    const row = c.rows.map((dy) => c.cy + dy).find((y) => y >= 0 && y < rows && isFree(blocked, cols, x0, x1, y));
    if (row === undefined) continue;
    // Keep a one-cell margin around the label so neighbouring names stay readable.
    for (let y = row - 1; y <= row + 1; y++) {
      if (y < 0 || y >= rows) continue;
      for (let x = x0 - 1; x <= x1 + 1; x++) if (x >= 0 && x < cols) blocked[y * cols + x] = 1;
    }
    placed.push({ x: x0, y: row, text: c.text });
  }
  return placed;
}

function candidatesFor(f: GeoFeature, grid: TileGrid): Candidate[] {
  const { spec, ctx } = grid;
  if (f.geometry.type !== "Point") return [];
  const text = labelText(f.props.name ?? "");
  if (!text) return [];
  const rank = f.props.symbolrank ?? 99;
  let priority: number;
  let rows: number[];
  if (f.cls === "country") {
    if (!COUNTRY_LODS.includes(ctx.lod)) return [];
    priority = rank;
    rows = [0, -1, 1];
  } else {
    // A settlement is labelled only if it is drawn as a Town tile.
    if (classifyFeature(f, ctx)?.terrain !== TerrainType.Town) return [];
    priority = 100 + rank;
    rows = [-1, 1];
  }
  const [lng, lat] = f.geometry.coordinates;
  return cellsAtLngLat(spec, lng, lat).map((cell) => ({ text, copy: cell.copy, cx: cell.x, cy: cell.y, priority, rows }));
}

function isFree(blocked: Uint8Array, cols: number, x0: number, x1: number, y: number): boolean {
  for (let x = x0; x <= x1; x++) if (blocked[y * cols + x]) return false;
  return true;
}
