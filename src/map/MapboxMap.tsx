import { useEffect, useRef } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { addLowZoomSource } from "./featureExtractor";

export const DEFAULT_CENTER: [number, number] = [139.7528, 35.6852]; // Tokyo, Imperial Palace
export const DEFAULT_ZOOM = 15;

interface Props {
  accessToken: string;
  onMapReady: (map: mapboxgl.Map) => void;
}

/**
 * Owns the Mapbox GL map: camera, interaction and vector tile loading.
 * Rotation and pitch are disabled so the logical grid stays axis-aligned.
 */
export function MapboxMap({ accessToken, onMapReady }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    mapboxgl.accessToken = accessToken;
    const map = new mapboxgl.Map({
      container: containerRef.current!,
      style: "mapbox://styles/mapbox/streets-v12",
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      dragRotate: false,
      pitchWithRotate: false,
      maxPitch: 0,
      // The grid is computed in Web Mercator; the default globe view at low
      // zoom would not line up with it.
      projection: "mercator",
      hash: true, // #zoom/lat/lng in the URL, handy for sharing test locations
    });
    map.touchZoomRotate.disableRotation();
    map.on("load", () => {
      addLowZoomSource(map);
      onMapReady(map);
    });
    (window as unknown as { __map: mapboxgl.Map }).__map = map; // debugging aid
    return () => map.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  return <div ref={containerRef} className="map" />;
}
