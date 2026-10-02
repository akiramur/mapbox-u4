/**
 * Road widths that follow the map style. Mapbox road data are centre lines
 * with no width; the style draws them with a zoom-dependent `line-width` in
 * screen pixels (an `interpolate` expression, e.g. exponential base 1.5). We
 * read those expressions and use the same width, so roads grow with zoom and
 * line up with the base map in the Overlay view.
 */

/** Style layer whose line-width applies to each road class (Mapbox Streets styles). */
export const ROAD_WIDTH_LAYERS: Record<string, string> = {
  motorway: "road-motorway-trunk",
  trunk: "road-motorway-trunk",
  primary: "road-primary",
  secondary: "road-secondary-tertiary",
  tertiary: "road-secondary-tertiary",
  street: "road-street",
  street_limited: "road-street",
};

/** Fallback expressions, as read from mapbox://styles/mapbox/streets-v12 (2026-09). */
export const DEFAULT_WIDTH_EXPRESSIONS: Record<string, unknown> = {
  "road-motorway-trunk": ["interpolate", ["exponential", 1.5], ["zoom"], 3, 0.8, 18, 30, 22, 300],
  "road-primary": ["interpolate", ["exponential", 1.5], ["zoom"], 3, 0.8, 18, 28, 22, 280],
  "road-secondary-tertiary": ["interpolate", ["exponential", 1.5], ["zoom"], 3, 0, 18, 26, 22, 260],
  "road-street": ["interpolate", ["exponential", 1.5], ["zoom"], 12, 0.5, 18, 20, 22, 200],
};

/**
 * Evaluates a zoom-only `interpolate` expression (linear or exponential) or a
 * plain number at `zoom`, like Mapbox GL does. Returns null for anything else.
 */
export function evaluateZoomExpression(expr: unknown, zoom: number): number | null {
  if (typeof expr === "number") return expr;
  if (!Array.isArray(expr) || expr[0] !== "interpolate") return null;
  const [, type, input, ...rest] = expr as [string, unknown[], unknown[], ...unknown[]];
  if (!Array.isArray(input) || input[0] !== "zoom" || !Array.isArray(type) || rest.length < 2 || rest.length % 2) return null;
  const base = type[0] === "exponential" ? Number(type[1]) : type[0] === "linear" ? 1 : NaN;
  if (!Number.isFinite(base)) return null;
  const stops: [number, number][] = [];
  for (let i = 0; i < rest.length; i += 2) {
    const z = rest[i];
    const v = rest[i + 1];
    if (typeof z !== "number" || typeof v !== "number") return null; // nested expressions are not supported
    stops.push([z, v]);
  }
  if (zoom <= stops[0][0]) return stops[0][1];
  const last = stops[stops.length - 1];
  if (zoom >= last[0]) return last[1];
  const k = stops.findIndex(([z]) => z > zoom);
  const [z0, v0] = stops[k - 1];
  const [z1, v1] = stops[k];
  const d = z1 - z0;
  const p = zoom - z0;
  const t = base === 1 ? p / d : (Math.pow(base, p) - 1) / (Math.pow(base, d) - 1);
  return v0 + t * (v1 - v0);
}

/** Road width in screen pixels per road class at `zoom`, from the style's expressions (or the fallbacks). */
export function roadWidthsPx(expressions: Record<string, unknown>, zoom: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [cls, layer] of Object.entries(ROAD_WIDTH_LAYERS)) {
    const w = evaluateZoomExpression(expressions[layer] ?? DEFAULT_WIDTH_EXPRESSIONS[layer], zoom) ?? evaluateZoomExpression(DEFAULT_WIDTH_EXPRESSIONS[layer], zoom);
    if (w !== null) out[cls] = w;
  }
  return out;
}

/** Half width, in cells, used to rasterize a road line: at least half a cell (one cell wide). */
export function roadHalfWidthCells(widthPx: number | undefined, cellPx: number): number {
  return Math.max(0.5, (widthPx ?? 0) / 2 / cellPx);
}
