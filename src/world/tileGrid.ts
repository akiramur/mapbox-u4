import type { GeoFeature } from "../map/featureExtractor";
import { TERRAIN_COUNT, TerrainType } from "./TerrainType";
import { classifyCell, classifyFeature, LOD_RULES, postProcess, reliefTerrain, type ClassifyContext } from "./terrainClassifier";
import { applyInteriors } from "./interiors";
import { applyTransitions } from "./transitions";

const TILE_SIZE = 512; // Mapbox GL world size at zoom 0
const MAX_LAT = 85.051129;

/**
 * Grid geometry. The grid is anchored to the global Web Mercator pixel space
 * at the current zoom (origin snapped to a multiple of cellPx), so panning
 * does not shift cell boundaries relative to the ground.
 */
export interface GridSpec {
  cols: number;
  rows: number;
  cellPx: number;
  zoom: number;
  worldSize: number;
  /** Top-left corner in global mercator pixels. */
  originX: number;
  originY: number;
}

export interface TileGrid {
  spec: GridSpec;
  ctx: ClassifyContext;
  /** Terrain after classification and postProcess, before transitions. */
  classified: TerrainType[];
  /** Final logical terrain (after transition rules). */
  terrain: TerrainType[];
  /** Id of the transition/interior rule that changed each cell, if any. */
  transition: (string | undefined)[];
  /** Tile variant per cell (index into a multi-tile TileMapping entry). */
  variant: number[];
  /** Per-cell elevation and local relief (metres) from contours, when available. */
  elevation: Float32Array | null;
  relief: Float32Array | null;
  /** coverage[cell * TERRAIN_COUNT + terrain] = covered samples (0..9). */
  coverage: Uint8Array;
  /** Indices into `features` that hit each cell (de-duplicated by key). */
  cellFeatures: number[][];
  features: GeoFeature[];
}

export function lngLatToWorld(lng: number, lat: number, worldSize: number): [number, number] {
  const phi = (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180;
  const x = ((lng + 180) / 360) * worldSize;
  const y = ((1 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / Math.PI) / 2) * worldSize;
  return [x, y];
}

export function worldToLngLat(x: number, y: number, worldSize: number): [number, number] {
  const lng = (x / worldSize) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / worldSize;
  const lat = (180 / Math.PI) * Math.atan(Math.sinh(n));
  return [lng, lat];
}

/**
 * Grid that exactly covers a viewport of widthPx × heightPx screen pixels
 * centred on `center`: from the cell containing the top-left pixel to the cell
 * containing the bottom-right one, on the same world-anchored lattice.
 */
export function computeViewportGridSpec(center: { lng: number; lat: number }, zoom: number, widthPx: number, heightPx: number, cellPx: number): GridSpec {
  const worldSize = TILE_SIZE * Math.pow(2, zoom);
  const [cx, cy] = lngLatToWorld(center.lng, center.lat, worldSize);
  const left = cx - widthPx / 2;
  const top = cy - heightPx / 2;
  const originX = Math.floor(left / cellPx) * cellPx;
  const originY = Math.floor(top / cellPx) * cellPx;
  const cols = Math.max(1, Math.ceil((left + widthPx - originX) / cellPx));
  const rows = Math.max(1, Math.ceil((top + heightPx - originY) / cellPx));
  return { cols, rows, cellPx, zoom, worldSize, originX, originY };
}

/** Grid of a fixed size (cols × rows cells) centred on `center`. */
export function computeGridSpec(center: { lng: number; lat: number }, zoom: number, cols: number, rows: number, cellPx: number): GridSpec {
  const worldSize = TILE_SIZE * Math.pow(2, zoom);
  const [cx, cy] = lngLatToWorld(center.lng, center.lat, worldSize);
  const originX = Math.floor((cx - (cols * cellPx) / 2) / cellPx) * cellPx;
  const originY = Math.floor((cy - (rows * cellPx) / 2) / cellPx) * cellPx;
  return { cols, rows, cellPx, zoom, worldSize, originX, originY };
}

/**
 * The grid moved by whole world widths to the world copy nearest `center`.
 * Mapbox wraps the camera centre into −180…180° while panning, so crossing
 * the antimeridian moves the camera by one world width; until the grid is
 * rebuilt for the new centre, the last grid must follow it there, or it is
 * drawn off screen. Cell indices are unchanged.
 */
export function alignToCenter(spec: GridSpec, center: { lng: number; lat: number }): GridSpec {
  const [cx] = lngLatToWorld(center.lng, center.lat, spec.worldSize);
  const shift = shiftToward(spec, cx);
  return shift ? { ...spec, originX: spec.originX - shift } : spec;
}

/** Geographic bounds of a cell: [west, south, east, north]. */
export function cellBounds(spec: GridSpec, x: number, y: number): [number, number, number, number] {
  const [w, n] = worldToLngLat(spec.originX + x * spec.cellPx, spec.originY + y * spec.cellPx, spec.worldSize);
  const [e, s] = worldToLngLat(spec.originX + (x + 1) * spec.cellPx, spec.originY + (y + 1) * spec.cellPx, spec.worldSize);
  return [w, s, e, n];
}

export function cellCenterLngLat(spec: GridSpec, x: number, y: number): [number, number] {
  return worldToLngLat(spec.originX + (x + 0.5) * spec.cellPx, spec.originY + (y + 0.5) * spec.cellPx, spec.worldSize);
}

/** Top-left corner of the grid as lng/lat (used to place the overlay on screen). */
export function gridOriginLngLat(spec: GridSpec): [number, number] {
  return worldToLngLat(spec.originX, spec.originY, spec.worldSize);
}

type Ring = [number, number][];

/** Samples per cell side (3×3 sample lattice per cell). */
const S = 3;
const FULL_MASK = 0x1ff;

export function buildTileGrid(spec: GridSpec, features: GeoFeature[], ctx: ClassifyContext): TileGrid {
  const { cols, rows } = spec;
  const cellCount = cols * rows;
  // Per terrain, per cell: bitmask of covered sample points. Masks (not counts)
  // make duplicated features across vector tiles harmless.
  const masks = new Uint16Array(cellCount * TERRAIN_COUNT);
  const cellFeatures: number[][] = Array.from({ length: cellCount }, () => []);
  const seen: Set<string>[] = Array.from({ length: cellCount }, () => new Set());

  // Project lng/lat to grid-local cell units.
  // World-copy shift (in world pixels) of the feature being projected; see worldCopyShifts().
  let shift = 0;
  const toCell = ([lng, lat]: GeoJSON.Position): [number, number] => {
    const [wx, wy] = lngLatToWorld(lng, lat, spec.worldSize);
    return [(wx + shift - spec.originX) / spec.cellPx, (wy - spec.originY) / spec.cellPx];
  };

  const note = (cell: number, fi: number) => {
    const key = features[fi].key;
    if (!seen[cell].has(key)) {
      seen[cell].add(key);
      cellFeatures[cell].push(fi);
    }
  };
  const hit = (cell: number, terrain: TerrainType, mask: number, fi: number) => {
    masks[cell * TERRAIN_COUNT + terrain] |= mask;
    note(cell, fi);
  };

  // Contour coverage per cell: elevation → sample mask.
  const eleMasks = new Map<number, Map<number, number>>();
  features.forEach((f, fi) => {
    const rule = classifyFeature(f, ctx);
    if (!rule) return;
    // Every world copy the feature appears in on this grid (more than one when zoomed out below ~z1).
    for (const s of worldCopyShifts(spec, f.geometry)) {
      shift = s;
      if (rule.mode === "elevation") {
        for (const poly of polygonsOf(f.geometry)) {
          rasterizePolygon(poly.map((ring) => ring.map(toCell)), cols, rows, (cell, mask) => {
            let byEle = eleMasks.get(cell);
            if (!byEle) eleMasks.set(cell, (byEle = new Map()));
            byEle.set(rule.ele, (byEle.get(rule.ele) ?? 0) | mask);
            note(cell, fi);
          });
        }
      } else if (rule.mode === "area") {
        for (const poly of polygonsOf(f.geometry)) {
          const rings = poly.map((ring) => ring.map(toCell));
          const terrain = rule.narrow && isNarrow(rings[0], rule.narrow) ? rule.narrow.terrain : rule.terrain;
          rasterizePolygon(rings, cols, rows, (cell, mask) => hit(cell, terrain, mask, fi));
        }
      } else if (rule.mode === "point") {
        for (const pt of pointsOf(f.geometry)) {
          const [cx, cy] = toCell(pt);
          const x = Math.floor(cx);
          const y = Math.floor(cy);
          if (x >= 0 && y >= 0 && x < cols && y < rows) hit(y * cols + x, rule.terrain, FULL_MASK, fi);
        }
      } else {
        for (const line of linesOf(f.geometry)) {
          rasterizeLine(line.map(toCell), rule.halfWidth, cols, rows, (cell) => hit(cell, rule.terrain, FULL_MASK, fi));
        }
      }
    }
  });

  const coverage = new Uint8Array(cellCount * TERRAIN_COUNT);
  for (let i = 0; i < masks.length; i++) coverage[i] = popcount9(masks[i]);

  // Elevation per cell: the highest contour covering most of the cell (0 if none).
  let elevation: Float32Array | null = null;
  let relief: Float32Array | null = null;
  if (eleMasks.size) {
    elevation = new Float32Array(cellCount);
    for (const [cell, byEle] of eleMasks) {
      for (const [ele, mask] of byEle) if (popcount9(mask) >= 5 && ele > elevation[cell]) elevation[cell] = ele;
    }
    const r = reliefTerrain(elevation, cols, rows, cellMeters(spec));
    relief = r.relief;
    r.terrain.forEach((t, c) => {
      if (t !== null) coverage[c * TERRAIN_COUNT + t] = 9;
    });
  }

  const raw: TerrainType[] = new Array(cellCount);
  for (let c = 0; c < cellCount; c++) {
    raw[c] = classifyCell(coverage.subarray(c * TERRAIN_COUNT, (c + 1) * TERRAIN_COUNT), ctx);
  }

  const coverageOf = (c: number) => coverage.subarray(c * TERRAIN_COUNT, (c + 1) * TERRAIN_COUNT);
  const classified = postProcess(raw, coverageOf, cols, rows, ctx);
  const transitioned = applyTransitions(classified, cols, rows, ctx.lod);
  let terrain = transitioned.terrain;
  const transition = transitioned.rule;
  // No pipeline step picks variants today; TileMapping still supports them.
  const variant = new Array<number>(cellCount).fill(0);
  const interiorMinZoom = LOD_RULES[ctx.lod].interiorMinZoom;
  if (interiorMinZoom !== null && ctx.zoom >= interiorMinZoom) {
    const interiors = applyInteriors(terrain, cols, rows);
    terrain = interiors.terrain;
    interiors.rule.forEach((r, i) => r && (transition[i] = r));
  }
  return { spec, ctx, classified, terrain, transition, variant, elevation, relief, coverage, cellFeatures, features };
}

function polygonsOf(g: GeoJSON.Geometry): GeoJSON.Position[][][] {
  if (g.type === "Polygon") return [g.coordinates];
  if (g.type === "MultiPolygon") return g.coordinates;
  return [];
}

/** Long and thin: bbox side ≥ minExtent cells and area ≤ maxFill × side². */
function isNarrow(ring: Ring | undefined, { maxFill, minExtent }: { maxFill: number; minExtent: number }): boolean {
  if (!ring || ring.length < 3) return false;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let twiceArea = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x, y] = ring[i];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    twiceArea += (ring[j][0] + x) * (ring[j][1] - y);
  }
  const side = Math.max(maxX - minX, maxY - minY);
  return side >= minExtent && Math.abs(twiceArea) / 2 <= maxFill * side * side;
}

function pointsOf(g: GeoJSON.Geometry): GeoJSON.Position[] {
  if (g.type === "Point") return [g.coordinates];
  if (g.type === "MultiPoint") return g.coordinates;
  return [];
}

function linesOf(g: GeoJSON.Geometry): GeoJSON.Position[][] {
  if (g.type === "LineString") return [g.coordinates];
  if (g.type === "MultiLineString") return g.coordinates;
  return [];
}

/**
 * Scanline rasterization of one polygon (outer ring + holes, even–odd rule)
 * onto the 3×3 sample lattice. Each sample row is intersected with the ring
 * edges once, so cost scales with edges × sample rows rather than with
 * edges × samples — large water/landcover polygons at low zoom stay cheap.
 */
function rasterizePolygon(rings: Ring[], cols: number, rows: number, onHit: (cell: number, mask: number) => void) {
  const outer = rings[0];
  if (!outer || outer.length < 3) return;
  let minY = Infinity, maxY = -Infinity;
  for (const [, y] of outer) {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  // Sample row r sits at y = (r + 0.5) / S; sample column c at x = (c + 0.5) / S.
  const r0 = Math.max(0, Math.ceil(S * minY - 0.5));
  const r1 = Math.min(S * rows - 1, Math.ceil(S * maxY - 0.5) - 1);
  const maxCol = S * cols - 1;
  const xs: number[] = [];
  for (let r = r0; r <= r1; r++) {
    const py = (r + 0.5) / S;
    xs.length = 0;
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi > py !== yj > py) xs.push(xi + ((py - yi) * (xj - xi)) / (yj - yi));
      }
    }
    xs.sort((a, b) => a - b);
    const cy = Math.floor(r / S);
    const bitRow = (r % S) * S;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil(S * xs[k] - 0.5));
      const c1 = Math.min(maxCol, Math.ceil(S * xs[k + 1] - 0.5) - 1);
      for (let c = c0; c <= c1; c++) onHit(cy * cols + Math.floor(c / S), 1 << (bitRow + (c % S)));
    }
  }
}

/** Marks cells whose centre lies within halfWidth (cells) of any segment. */
function rasterizeLine(pts: [number, number][], halfWidth: number, cols: number, rows: number, onHit: (cell: number) => void) {
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - halfWidth));
    const x1 = Math.min(cols - 1, Math.floor(Math.max(ax, bx) + halfWidth));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - halfWidth));
    const y1 = Math.min(rows - 1, Math.floor(Math.max(ay, by) + halfWidth));
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        if (distToSegment(cx + 0.5, cy + 0.5, ax, ay, bx, by) <= halfWidth) onHit(cy * cols + cx);
      }
    }
  }
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function popcount9(m: number): number {
  let c = 0;
  for (; m; m &= m - 1) c++;
  return c;
}

/** Ground size of one cell in metres, at the grid's centre latitude. */
export function cellMeters(spec: GridSpec): number {
  const [, lat] = worldToLngLat(spec.originX + (spec.cols * spec.cellPx) / 2, spec.originY + (spec.rows * spec.cellPx) / 2, spec.worldSize);
  return ((40075016.686 * Math.cos((lat * Math.PI) / 180)) / spec.worldSize) * spec.cellPx;
}

/** World-anchored cell index of grid cell i at this zoom; stable while panning. */
export function gridWorldCell(spec: GridSpec, i: number): [number, number] {
  return [Math.round(spec.originX / spec.cellPx) + (i % spec.cols), Math.round(spec.originY / spec.cellPx) + Math.floor(i / spec.cols)];
}

/**
 * Across the antimeridian the grid lies outside −180…180° (e.g. −362…−37°),
 * but Mapbox returns most geometry in canonical longitudes, while some
 * sources (overzoomed labels) return it already wrapped. worldCopyShifts()
 * picks, per feature, the whole numbers of world widths that put it on the
 * grid; a feature always moves as a whole, so it is never torn apart.
 */
function shiftToward(spec: GridSpec, wx: number): number {
  const centreX = spec.originX + (spec.cols * spec.cellPx) / 2;
  return Math.round((centreX - wx) / spec.worldSize) * spec.worldSize;
}

/**
 * World-pixel shifts (multiples of the world width) that put a feature on the
 * grid. Usually one; several when the grid is wider than the world (zoomed
 * out below ~z1), so every visible copy of the world is drawn.
 */
export function worldCopyShifts(spec: GridSpec, geometry: GeoJSON.Geometry): number[] {
  const range = lngRange(geometry);
  if (!range) return [0];
  const lo = lngLatToWorld(range[0], 0, spec.worldSize)[0];
  const hi = lngLatToWorld(range[1], 0, spec.worldSize)[0];
  const left = spec.originX;
  const right = spec.originX + spec.cols * spec.cellPx;
  const shifts: number[] = [];
  for (let n = Math.ceil((left - hi) / spec.worldSize); n <= Math.floor((right - lo) / spec.worldSize); n++) shifts.push(n * spec.worldSize);
  return shifts;
}

function lngRange(geometry: GeoJSON.Geometry): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  const walk = (c: unknown): void => {
    if (typeof (c as number[])[0] === "number") {
      const lng = (c as number[])[0];
      if (lng < lo) lo = lng;
      if (lng > hi) hi = lng;
    } else (c as unknown[]).forEach(walk);
  };
  if ("coordinates" in geometry) walk(geometry.coordinates);
  return lo === Infinity ? null : [lo, hi];
}

/** Grid cells containing a lng/lat, one per world copy on the grid (usually one). */
export function cellsAtLngLat(spec: GridSpec, lng: number, lat: number): { x: number; y: number; copy: number }[] {
  const shifts = worldCopyShifts(spec, { type: "Point", coordinates: [lng, lat] });
  const out: { x: number; y: number; copy: number }[] = [];
  const [rawX, wy] = lngLatToWorld(lng, lat, spec.worldSize);
  for (const s of shifts) {
    const x = Math.floor((rawX + s - spec.originX) / spec.cellPx);
    const y = Math.floor((wy - spec.originY) / spec.cellPx);
    if (x >= 0 && y >= 0 && x < spec.cols && y < spec.rows) out.push({ x, y, copy: Math.round(s / spec.worldSize) });
  }
  return out;
}

/**
 * Grid cell containing a lng/lat, or null when outside the grid. The point is
 * taken as given if it lies on the grid (e.g. the mouse over a far world copy),
 * otherwise in the world copy nearest the grid.
 */
export function cellAtLngLat(spec: GridSpec, lng: number, lat: number): { x: number; y: number } | null {
  const [rawX, wy] = lngLatToWorld(lng, lat, spec.worldSize);
  const direct = { x: Math.floor((rawX - spec.originX) / spec.cellPx), y: Math.floor((wy - spec.originY) / spec.cellPx) };
  if (direct.x >= 0 && direct.y >= 0 && direct.x < spec.cols && direct.y < spec.rows) return direct;
  const wx = rawX + shiftToward(spec, rawX);
  const x = Math.floor((wx - spec.originX) / spec.cellPx);
  const y = Math.floor((wy - spec.originY) / spec.cellPx);
  return x >= 0 && y >= 0 && x < spec.cols && y < spec.rows ? { x, y } : null;
}
