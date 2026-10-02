import { useCallback, useEffect, useRef, useState } from "react";
import type { Map as MapboxGLMap, MapMouseEvent, MapSourceDataEvent } from "mapbox-gl";
import { MapboxMap } from "./map/MapboxMap";
import { extractFeatures } from "./map/featureExtractor";
import { alignToCenter, buildTileGrid, cellAtLngLat, cellBounds, computeViewportGridSpec, gridOriginLngLat, type TileGrid } from "./world/tileGrid";
import { resolveGrid, type TileFrame } from "./world/tileResolver";
import { TERRAIN_COUNT, terrainName } from "./world/TerrainType";
import { getGameLOD, type GameLOD } from "./world/gameLOD";
import { ROAD_WIDTH_LAYERS, roadHalfWidthCells, roadWidthsPx } from "./world/roadWidths";
import { DebugColorRenderer, SpriteTileRenderer, type TileRenderer } from "./renderer/TileRenderer";
import { SpriteAtlas, createPlaceholderAtlas } from "./renderer/SpriteAtlas";
import { DEBUG_COLORS } from "./config/debugColors";
import { PLACEHOLDER_TILE_MAPPING, TILESETS, type TilesetConfig } from "./config/tileMappings";
import { Inspector } from "./debug/Inspector";
import { GlTileLayer } from "./renderer/webgl/GlTileLayer";
import { CreatureSim } from "./world/creatureSim";

/** Screen pixels per logical cell. The grid covers the whole map viewport. */
const CELL_PX = 16;
/** Creature simulation: fireballs move every tick, creatures take a turn every TURN_TICKS, frames change every FRAME_TICKS. */
const CREATURE_TICK_MS = 200;
const TURN_TICKS = 5;
const FRAME_TICKS = 2;
/**
 * While the camera moves, the grid is also rebuilt so newly revealed areas
 * fill in. Rebuilds are spaced by at least this, and by 3× the last build
 * time, so slow builds (large windows, low zoom) do not make dragging stutter.
 */
const MOVE_REBUILD_MIN_MS = 300;

const accessToken = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN as string | undefined;

type RenderStyle = "sprites" | "colors";
/** WebGL draws inside the map (smooth pan/zoom); Canvas 2D is the original overlay, kept as a fallback. */
type RendererKind = "webgl" | "canvas";
type ViewMode = "tiles" | "overlay" | "split" | "mapbox";

interface Stats {
  zoom: number;
  lod: GameLOD;
  features: number;
  ms: number;
  counts: number[];
}

interface Cell {
  x: number;
  y: number;
}

const TILESET_STORAGE_KEY = "tileset";
const WATER_ANIMATION_STORAGE_KEY = "animateWater";


/** Saved choice if any; otherwise off for people who asked their OS for reduced motion. */
function initialAnimateWater(): boolean {
  try {
    const saved = localStorage.getItem(WATER_ANIMATION_STORAGE_KEY);
    if (saved === "on" || saved === "off") return saved === "on";
  } catch {
    // storage unavailable: fall through to the system preference
  }
  return !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

function initialTilesetId(): string {
  try {
    const saved = localStorage.getItem(TILESET_STORAGE_KEY);
    if (saved && TILESETS.some((t) => t.id === saved)) return saved;
  } catch {
    // storage unavailable: use the default
  }
  return TILESETS[0].id;
}

/** Loads a tile set's atlas, falling back to the generated placeholder. */
async function loadSpriteRenderer(tileset: TilesetConfig): Promise<SpriteTileRenderer> {
  try {
    const atlas = await SpriteAtlas.load(tileset.name, tileset.url, tileset.layout);
    return new SpriteTileRenderer(atlas, tileset.mapping, tileset.glyphs);
  } catch {
    console.warn(`Atlas not found at ${tileset.url}. Using placeholder atlas.`);
    return new SpriteTileRenderer(createPlaceholderAtlas(), PLACEHOLDER_TILE_MAPPING);
  }
}

export function App() {
  const overlayRef = useRef<HTMLDivElement>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const colorRendererRef = useRef(new DebugColorRenderer());
  const glLayerRef = useRef(new GlTileLayer());
  const simRef = useRef(new CreatureSim());
  const flatAtlasRef = useRef<SpriteAtlas | null>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const [rendererKind, setRendererKind] = useState<RendererKind>("webgl");
  const [spriteRenderer, setSpriteRenderer] = useState<SpriteTileRenderer | null>(null);
  const [tilesetId, setTilesetId] = useState(initialTilesetId);
  const gridRef = useRef<TileGrid | null>(null);
  const frameRef = useRef<TileFrame | null>(null);
  const [map, setMap] = useState<MapboxGLMap | null>(null);
  const [renderStyle, setRenderStyle] = useState<RenderStyle>("sprites");
  const [viewMode, setViewMode] = useState<ViewMode>("tiles");
  const [overlayOpacity, setOverlayOpacity] = useState(0.5);
  const [showGridLines, setShowGridLines] = useState(false);
  const [animateWater, setAnimateWater] = useState(initialAnimateWater);
  const [stats, setStats] = useState<Stats | null>(null);
  const [hoverCell, setHoverCell] = useState<Cell | null>(null);
  const [pinnedCell, setPinnedCell] = useState<Cell | null>(null);

  const renderer: TileRenderer & { options: { showGridLines: boolean } } =
    renderStyle === "sprites" && spriteRenderer ? spriteRenderer : colorRendererRef.current;
  const rendererRef = useRef(renderer);
  rendererRef.current = renderer;

  useEffect(() => {
    let cancelled = false;
    const tileset = TILESETS.find((t) => t.id === tilesetId) ?? TILESETS[0];
    loadSpriteRenderer(tileset).then((r) => {
      if (!cancelled) setSpriteRenderer(r);
    });
    try {
      localStorage.setItem(TILESET_STORAGE_KEY, tilesetId);
    } catch {
      // storage unavailable: the choice is not remembered
    }
    return () => {
      cancelled = true;
    };
  }, [tilesetId]);

  const rendererKindRef = useRef(rendererKind);
  rendererKindRef.current = rendererKind;

  const draw = useCallback(() => {
    if (frameRef.current) glLayerRef.current.setFrame(frameRef.current);
    if (rendererKindRef.current !== "canvas") return;
    const r = rendererRef.current;
    const host = canvasHostRef.current;
    if (!host) return;
    if (host.firstChild !== r.canvas) host.replaceChildren(r.canvas);
    if (frameRef.current) r.render(frameRef.current);
  }, []);

  const placeOverlay = useCallback((m: MapboxGLMap) => {
    const grid = gridRef.current;
    const el = overlayRef.current;
    if (!grid || !el || rendererKindRef.current !== "canvas") return;
    // While the camera moves, the last grid follows the map (translated and
    // scaled) until it is regenerated on the next "idle".
    const p = m.project(gridOriginLngLat(alignToCenter(grid.spec, m.getCenter())));
    const scale = Math.pow(2, m.getZoom() - grid.spec.zoom);
    el.style.transform =
      scale === 1 ? `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)` : `translate(${p.x}px, ${p.y}px) scale(${scale})`;
    el.style.visibility = "visible";
  }, []);

  const regenerate = useCallback(
    (m: MapboxGLMap, duringMove = false) => {
      const t0 = performance.now();
      const zoom = m.getZoom();
      const { clientWidth, clientHeight } = m.getContainer();
      const spec = computeViewportGridSpec(m.getCenter(), zoom, clientWidth, clientHeight, CELL_PX);
      const lod = getGameLOD(zoom);
      const features = extractFeatures(m);
      // Road widths follow the style's line-width at this zoom.
      const expressions = Object.fromEntries(
        [...new Set(Object.values(ROAD_WIDTH_LAYERS))].map((id) => [id, m.getLayer(id) ? m.getPaintProperty(id, "line-width") : undefined]),
      );
      const roadHalfWidths = Object.fromEntries(Object.entries(roadWidthsPx(expressions, zoom)).map(([cls, w]) => [cls, roadHalfWidthCells(w, CELL_PX)]));
      const grid = buildTileGrid(spec, features, { zoom, lod, roadHalfWidths });
      gridRef.current = grid;
      frameRef.current = resolveGrid(grid);
      draw();
      placeOverlay(m);
      if (!duringMove) {
        setHoverCell(null);
        setPinnedCell(null);
      }
      const counts = new Array(TERRAIN_COUNT).fill(0);
      for (const t of frameRef.current.tiles) counts[t.terrain]++;
      setStats({ zoom, lod, features: features.length, ms: Math.round(performance.now() - t0), counts });
      // Read by scripts/snapshot.mjs (regression check).
      (window as unknown as { __tileStats: unknown }).__tileStats = {
        zoom,
        lod,
        counts: Object.fromEntries(counts.map((n, t) => [terrainName(t), n]).filter(([, n]) => n)),
      };
    },
    [draw, placeOverlay],
  );

  // Regenerate once the camera has settled and tiles are loaded ("idle"),
  // but only when the camera changed or new tiles arrived since the last
  // generation (e.g. the z12 source added on load finishing after the first run).
  useEffect(() => {
    if (!map) return;
    let lastKey = "";
    let tilesChanged = false;
    const onIdle = () => {
      const c = map.getCenter();
      const { clientWidth, clientHeight } = map.getContainer();
      const key = `${c.lng.toFixed(6)},${c.lat.toFixed(6)},${map.getZoom().toFixed(3)},${clientWidth}x${clientHeight}`;
      if (key === lastKey && !tilesChanged) return;
      lastKey = key;
      tilesChanged = false;
      regenerate(map);
    };
    const onSourceData = (e: MapSourceDataEvent) => {
      if (e.tile) tilesChanged = true;
    };
    map.on("sourcedata", onSourceData);
    let lastMoveBuild = 0;
    let lastBuildMs = 0;
    const onMove = () => {
      placeOverlay(map);
      const now = performance.now();
      if (now - lastMoveBuild < Math.max(MOVE_REBUILD_MIN_MS, 3 * lastBuildMs)) return;
      lastMoveBuild = now;
      regenerate(map, true);
      lastBuildMs = performance.now() - now;
    };
    map.on("idle", onIdle);
    map.on("move", onMove);
    onIdle();
    return () => {
      map.off("idle", onIdle);
      map.off("move", onMove);
      map.off("sourcedata", onSourceData);
    };
  }, [map, regenerate, placeOverlay]);

  // Hover shows a cell in the inspector; click pins/unpins it.
  useEffect(() => {
    if (!map) return;
    const cellAt = (e: MapMouseEvent) => {
      const grid = gridRef.current;
      return grid ? cellAtLngLat(grid.spec, e.lngLat.lng, e.lngLat.lat) : null;
    };
    const onMouseMove = (e: MapMouseEvent) => setHoverCell(cellAt(e));
    const onClick = (e: MapMouseEvent) => {
      const c = cellAt(e);
      setPinnedCell((p) => (!c || (p && p.x === c.x && p.y === c.y) ? null : c));
    };
    map.on("mousemove", onMouseMove);
    map.on("click", onClick);
    return () => {
      map.off("mousemove", onMouseMove);
      map.off("click", onClick);
    };
  }, [map]);

  // Redraw the current grid when the renderer or its options change.
  useEffect(() => {
    renderer.options.showGridLines = showGridLines;
    draw();
    if (map) placeOverlay(map);
  }, [renderer, showGridLines, draw, rendererKind, map, placeOverlay]);

  // WebGL layer: add it to the map once, and keep its atlas and options in sync.
  useEffect(() => {
    if (!map) return;
    const layer = glLayerRef.current;
    if (!map.getLayer(layer.id)) map.addLayer(layer);
  }, [map]);

  useEffect(() => {
    const layer = glLayerRef.current;
    if (renderStyle === "sprites" && spriteRenderer) {
      const flags = TILESETS.find((t) => t.name === spriteRenderer.atlas.name)?.flags;
      layer.setAtlas(spriteRenderer.atlas, spriteRenderer.mapping, spriteRenderer.glyphs, flags);
    } else if (renderStyle === "colors") {
      flatAtlasRef.current ??= createPlaceholderAtlas({ dither: false, name: "debug colors" });
      layer.setAtlas(flatAtlasRef.current, PLACEHOLDER_TILE_MAPPING, {});
    }
  }, [renderStyle, spriteRenderer]);

  useEffect(() => {
    glLayerRef.current.setOptions({ viewMode: rendererKind === "webgl" ? viewMode : "mapbox", overlayOpacity, showGridLines, animate: animateWater });
  }, [rendererKind, viewMode, overlayOpacity, showGridLines, animateWater]);

  // Remember only a choice the user made, so the reduced-motion default keeps applying otherwise.
  const toggleAnimateWater = (on: boolean) => {
    setAnimateWater(on);
    try {
      localStorage.setItem(WATER_ANIMATION_STORAGE_KEY, on ? "on" : "off");
      localStorage.removeItem("waveStepMs"); // left over from the removed speed slider
    } catch {
      // storage unavailable: the choice is not remembered
    }
  };

  // Wandering creatures and warp gates below z15, townsfolk from z15 (WebGL, animation on, and only if the tile set has them).
  const activeTileset = renderStyle === "sprites" && spriteRenderer ? TILESETS.find((t) => t.name === spriteRenderer.atlas.name) : undefined;
  const creatureSet = activeTileset?.creatures;
  const gateDef = activeTileset?.gate;
  useEffect(() => {
    const layer = glLayerRef.current;
    const sim = simRef.current;
    sim.clear();
    layer.setCreatures([]);
    if (!map || !animateWater || rendererKind !== "webgl" || (!creatureSet && !gateDef)) return;
    let tick = 0;
    let lastFrame: TileFrame | null = null;
    const timer = setInterval(() => {
      const frame = frameRef.current;
      if (!frame) return;
      if (frame !== lastFrame) {
        sim.sync(frame, creatureSet);
        lastFrame = frame;
      }
      tick++;
      if (gateDef) sim.stepGate(frame);
      if (creatureSet && tick % TURN_TICKS === 0) sim.turn(frame, creatureSet);
      sim.stepFireballs(frame);
      layer.setCreatures(sim.sprites(frame, creatureSet, Math.floor(tick / FRAME_TICKS), gateDef));
    }, CREATURE_TICK_MS);
    return () => {
      clearInterval(timer);
      sim.clear();
      layer.setCreatures([]);
    };
  }, [map, animateWater, rendererKind, creatureSet, gateDef]);

  // WebGL renderer: the inspector highlight is a screen-space box that follows the cell every frame.
  const inspectedCell = pinnedCell ?? hoverCell;
  useEffect(() => {
    const el = highlightRef.current;
    if (!map || !el || rendererKind !== "webgl" || !inspectedCell) return;
    const place = () => {
      const grid = gridRef.current;
      if (!grid) return;
      const [w, s, e, n] = cellBounds(alignToCenter(grid.spec, map.getCenter()), inspectedCell.x, inspectedCell.y);
      const a = map.project([w, n]);
      const b = map.project([e, s]);
      Object.assign(el.style, { left: `${a.x}px`, top: `${a.y}px`, width: `${b.x - a.x}px`, height: `${b.y - a.y}px` });
    };
    place();
    map.on("render", place);
    return () => {
      map.off("render", place);
    };
  }, [map, rendererKind, inspectedCell]);

  if (!accessToken) {
    return <div className="error">VITE_MAPBOX_ACCESS_TOKEN is not set. Copy .env.example to .env.local and set your Mapbox token.</div>;
  }

  const inspected = pinnedCell ?? hoverCell;
  const overlayStyle: React.CSSProperties = {
    visibility: "hidden",
    display: viewMode === "mapbox" ? "none" : undefined,
    opacity: viewMode === "overlay" ? overlayOpacity : 1,
  };

  return (
    <div className={`app view-${viewMode} renderer-${rendererKind}`}>
      <MapboxMap accessToken={accessToken} onMapReady={setMap} />
      {/* Canvas 2D, Split: black under the tile half, so areas without tiles do not show the map. */}
      {rendererKind === "canvas" && viewMode === "split" && <div className="split-backdrop" />}
      {rendererKind === "webgl" && inspected && viewMode !== "mapbox" && (
        <div ref={highlightRef} className={pinnedCell ? "highlight screen pinned" : "highlight screen"} />
      )}
      {/* Split clips in screen space (the overlay itself moves with the map): map on the left half, tiles on the right. */}
      <div className="overlay-clip" style={{ clipPath: viewMode === "split" ? "inset(0 0 0 50%)" : undefined }}>
        <div ref={overlayRef} className="overlay" style={{ ...overlayStyle, display: rendererKind === "canvas" ? overlayStyle.display : "none" }}>
          <div ref={canvasHostRef} />
          {inspected && (
            <div
              className={pinnedCell ? "highlight pinned" : "highlight"}
              style={{ left: inspected.x * CELL_PX, top: inspected.y * CELL_PX, width: CELL_PX, height: CELL_PX }}
            />
          )}
        </div>
      </div>
      <div className="panel">
        <label>
          renderer
          <select value={rendererKind} onChange={(e) => setRendererKind(e.target.value as RendererKind)}>
            <option value="webgl">WebGL</option>
            <option value="canvas">Canvas 2D</option>
          </select>
        </label>
        <label>
          view
          <select value={viewMode} onChange={(e) => setViewMode(e.target.value as ViewMode)}>
            <option value="tiles">Tiles</option>
            <option value="overlay">Overlay</option>
            <option value="split">Split</option>
            <option value="mapbox">Mapbox</option>
          </select>
        </label>
        <label>
          tiles
          <select value={renderStyle} onChange={(e) => setRenderStyle(e.target.value as RenderStyle)}>
            <option value="sprites">sprites</option>
            <option value="colors">debug colors</option>
          </select>
        </label>
        {renderStyle === "sprites" && (
          <>
            <label>
              tileset
              <select value={tilesetId} onChange={(e) => setTilesetId(e.target.value)}>
                {TILESETS.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <div>atlas: {spriteRenderer?.atlas.name ?? "loading…"}</div>
          </>
        )}
        {viewMode === "overlay" && (
          <label>
            opacity
            <input type="range" min={0} max={1} step={0.05} value={overlayOpacity} onChange={(e) => setOverlayOpacity(Number(e.target.value))} />
          </label>
        )}
        <label>
          <input type="checkbox" checked={showGridLines} onChange={(e) => setShowGridLines(e.target.checked)} />
          grid lines
        </label>
        {rendererKind === "webgl" && (
          <label>
            <input type="checkbox" checked={animateWater} onChange={(e) => toggleAnimateWater(e.target.checked)} />
            animation
          </label>
        )}
        {stats && (
          <>
            <div>
              zoom {stats.zoom.toFixed(2)} / LOD {stats.lod}
            </div>
            <div>
              features: {stats.features} / {stats.ms} ms
            </div>
            <div className="legend">
              {stats.counts.map((n, t) => (
                <Legend key={t} t={t} n={n} />
              ))}
            </div>
          </>
        )}
      </div>
      {inspected && gridRef.current && frameRef.current && (
        <Inspector grid={gridRef.current} frame={frameRef.current} cell={inspected} pinned={!!pinnedCell} sprites={spriteRenderer} />
      )}
    </div>
  );
}

function Legend({ t, n }: { t: number; n: number }) {
  return (
    <>
      <span className="swatch" style={{ background: DEBUG_COLORS[t as keyof typeof DEBUG_COLORS] }} />
      <span>{terrainName(t)}</span>
      <span>{n}</span>
    </>
  );
}
