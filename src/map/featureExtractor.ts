import type { Map as MapboxGLMap } from "mapbox-gl";

/**
 * Source id of the vector tiles inside streets-v12: Mapbox Streets v8 plus
 * Mapbox Terrain v2 (hillshade, contour) and Bathymetry v2 (depth).
 */
export const SOURCE_ID = "composite";

/** Mapbox Streets v8 source layers consumed by the classifier. */
export const SOURCE_LAYERS = [
  "water",
  "waterway",
  "landuse",
  "landuse_overlay",
  "landcover",
  "building",
  "road",
  "hillshade", // terrain-v2: relief bands, Hill/Mountain fallback below contour zooms
  "contour", // terrain-v2: elevation polygons (area at or above `ele`), z9+
  "depth", // bathymetry-v2: ocean depth bands, used for DeepWater
] as const;

/**
 * A second copy of Mapbox Streets v8 capped at z12. Above z12 Mapbox GL
 * overzooms its z12 tiles, so the generalized urban landuse polygons (which
 * only exist up to z12) stay available at z13–14, where the detailed data has
 * almost no landuse or buildings in city centres.
 */
export const LOW_ZOOM_SOURCE_ID = "streets-z12";
const LOW_ZOOM_MAXZOOM = 12;

/**
 * Settlement labels from Mapbox Streets v8 capped at z9. From z11 Mapbox
 * repeats big-city labels (Yokohama has four points at z12) and moves them
 * between zooms, and above z12 the labels are missing for off-screen tiles.
 * At z9 each city has one point, so overzooming z9 tiles gives every zoom the
 * same, single Town per city.
 */
export const PLACES_SOURCE_ID = "streets-places-z9";
const PLACES_MAXZOOM = 9;

export type SourceLayer = Exclude<(typeof SOURCE_LAYERS)[number], "place_label"> | "landuse_z12" | "place_label_z9";

/** Adds the z12-capped source plus an invisible layer so its tiles load. Call once the style is loaded. */
export function addLowZoomSource(map: MapboxGLMap): void {
  if (!map.getSource(PLACES_SOURCE_ID)) {
    map.addSource(PLACES_SOURCE_ID, { type: "vector", url: "mapbox://mapbox.mapbox-streets-v8", maxzoom: PLACES_MAXZOOM });
    map.addLayer({
      id: `${PLACES_SOURCE_ID}-place`,
      type: "circle",
      source: PLACES_SOURCE_ID,
      "source-layer": "place_label",
      paint: { "circle-opacity": 0, "circle-radius": 0 },
    });
  }
  if (map.getSource(LOW_ZOOM_SOURCE_ID)) return;
  map.addSource(LOW_ZOOM_SOURCE_ID, { type: "vector", url: "mapbox://mapbox.mapbox-streets-v8", maxzoom: LOW_ZOOM_MAXZOOM });
  map.addLayer({
    id: `${LOW_ZOOM_SOURCE_ID}-landuse`,
    type: "fill",
    source: LOW_ZOOM_SOURCE_ID,
    "source-layer": "landuse",
    paint: { "fill-opacity": 0 },
  });
}

/** A Mapbox feature normalized to what the rest of the pipeline needs. */
export interface GeoFeature {
  /** Stable key used to de-duplicate features repeated across vector tiles. */
  key: string;
  sourceLayer: SourceLayer;
  cls: string | undefined;
  type: string | undefined;
  /** Layer-specific attributes the classifier uses (e.g. hillshade level, depth). */
  props: FeatureProps;
  geometry: GeoJSON.Geometry;
}

export interface FeatureProps {
  name?: string;
  symbolrank?: number;
  level?: number;
  minDepth?: number;
  ele?: number;
}

/**
 * Pull every feature of the relevant source layers from the vector tiles the
 * map currently has loaded. Uses querySourceFeatures so the result does not
 * depend on how (or whether) the style draws those layers.
 */
export function extractFeatures(map: MapboxGLMap): GeoFeature[] {
  const out: GeoFeature[] = [];
  const collect = (sourceId: string, sourceLayer: string, as: SourceLayer) => {
    const features = map.querySourceFeatures(sourceId, { sourceLayer });
    features.forEach((f, i) => {
      const props = f.properties ?? {};
      out.push({
        key: `${as}:${f.id ?? `anon${i}`}`,
        sourceLayer: as,
        cls: props.class as string | undefined,
        type: props.type as string | undefined,
        props: {
          name: (props.name_en ?? props.name) as string | undefined,
          symbolrank: props.symbolrank as number | undefined,
          level: props.level as number | undefined,
          minDepth: props.min_depth as number | undefined,
          ele: props.ele as number | undefined,
        },
        geometry: f.geometry,
      });
    });
  };
  for (const sourceLayer of SOURCE_LAYERS) collect(SOURCE_ID, sourceLayer, sourceLayer);
  if (map.getSource(LOW_ZOOM_SOURCE_ID)) collect(LOW_ZOOM_SOURCE_ID, "landuse", "landuse_z12");
  if (map.getSource(PLACES_SOURCE_ID)) collect(PLACES_SOURCE_ID, "place_label", "place_label_z9");
  return out;
}
