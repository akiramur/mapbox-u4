import type { GeoFeature, SourceLayer } from "../map/featureExtractor";
import type { GameLOD } from "../world/gameLOD";
import { worldToLngLat, type GridSpec } from "../world/tileGrid";
import { TERRAIN_COUNT, type TerrainType } from "../world/TerrainType";
import type { ClassifyContext } from "../world/terrainClassifier";

/** A small grid anchored at a fixed world position; features are written in cell units. */
export function makeSpec(cols = 8, rows = 8, zoom = 15): GridSpec {
  const cellPx = 16;
  const worldSize = 512 * Math.pow(2, zoom);
  // Somewhere in Tokyo, snapped to the cell lattice like computeGridSpec does.
  const originX = Math.floor((0.888 * worldSize) / cellPx) * cellPx;
  const originY = Math.floor((0.394 * worldSize) / cellPx) * cellPx;
  return { cols, rows, cellPx, zoom, worldSize, originX, originY };
}

/** Cell coordinates (x right, y down) → [lng, lat]. */
export function cellToLngLat(spec: GridSpec, x: number, y: number): [number, number] {
  return worldToLngLat(spec.originX + x * spec.cellPx, spec.originY + y * spec.cellPx, spec.worldSize);
}

let nextId = 0;

export function feature(
  spec: GridSpec,
  sourceLayer: SourceLayer,
  geometry: { type: "Polygon"; rings: [number, number][][] } | { type: "LineString"; points: [number, number][] } | { type: "Point"; point: [number, number] },
  opts: { cls?: string; type?: string; props?: GeoFeature["props"] } = {},
): GeoFeature {
  const ll = ([x, y]: [number, number]) => cellToLngLat(spec, x, y);
  const geom: GeoJSON.Geometry =
    geometry.type === "Polygon"
      ? { type: "Polygon", coordinates: geometry.rings.map((r) => r.map(ll)) }
      : geometry.type === "LineString"
        ? { type: "LineString", coordinates: geometry.points.map(ll) }
        : { type: "Point", coordinates: ll(geometry.point) };
  return { key: `${sourceLayer}:t${nextId++}`, sourceLayer, cls: opts.cls, type: opts.type, props: opts.props ?? {}, geometry: geom };
}

/** Axis-aligned rectangle ring in cell units. */
export function rect(x0: number, y0: number, x1: number, y1: number): [number, number][] {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [x0, y0],
  ];
}

export function ctx(lod: GameLOD, zoom: number): ClassifyContext {
  return { lod, zoom };
}

/** Coverage array with the given terrains set (samples out of 9). */
export function coverageOf(entries: [TerrainType, number][]): Uint8Array {
  const c = new Uint8Array(TERRAIN_COUNT);
  for (const [t, n] of entries) c[t] = n;
  return c;
}
