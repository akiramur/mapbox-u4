import { useEffect, useRef } from "react";
import type { GeoFeature } from "../map/featureExtractor";
import type { SpriteTileRenderer } from "../renderer/TileRenderer";
import { classifiedAs, classifyFeature } from "../world/terrainClassifier";
import { cellBounds, cellCenterLngLat, type TileGrid } from "../world/tileGrid";
import type { TileFrame } from "../world/tileResolver";
import { TERRAIN_COUNT, terrainName } from "../world/TerrainType";
import { AREA_OVERRIDES } from "../config/overrides";
import { tileIdFor } from "../config/tileMappings";

const MAX_FEATURES = 15;

interface Props {
  grid: TileGrid;
  frame: TileFrame;
  cell: { x: number; y: number };
  pinned: boolean;
  sprites: SpriteTileRenderer | null;
}

/** Explains how one logical cell was classified, resolved and drawn. */
export function Inspector({ grid, frame, cell, pinned, sprites }: Props) {
  const { spec } = grid;
  const i = cell.y * spec.cols + cell.x;
  const classified = grid.classified[i];
  const resolved = frame.tiles[i];
  const [lng, lat] = cellCenterLngLat(spec, cell.x, cell.y);
  const [w, s, e, n] = cellBounds(spec, cell.x, cell.y);
  const override = AREA_OVERRIDES.find((o) => o.id === resolved.overrideId);
  const tileId = sprites ? sprites.atlas.resolve(tileIdFor(sprites.mapping, resolved.terrain, resolved.variant)) : undefined;

  const coverage = [];
  for (let t = 0; t < TERRAIN_COUNT; t++) {
    const c = grid.coverage[i * TERRAIN_COUNT + t];
    if (c) coverage.push(`${terrainName(t)} ${c}/9`);
  }

  const features = grid.cellFeatures[i].map((fi) => {
    const f = grid.features[fi];
    const rule = classifyFeature(f, grid.ctx);
    return { f, terrain: rule?.terrain };
  });

  return (
    <div className="inspector">
      <div className="inspector-head">
        <TilePreview sprites={sprites} tileId={tileId} />
        <div>
          <b>
            cell {cell.x}, {cell.y}
          </b>{" "}
          {pinned ? "(pinned — click to release)" : "(hover — click to pin)"}
          <div>
            {lat.toFixed(6)}, {lng.toFixed(6)}
          </div>
        </div>
      </div>
      <Row k="bounds" v={`${w.toFixed(5)}, ${s.toFixed(5)} – ${e.toFixed(5)}, ${n.toFixed(5)}`} />
      <Row k="classified" v={terrainName(classified)} />
      {grid.transition[i] && <Row k="transition" v={`${terrainName(grid.terrain[i])} (rule: ${grid.transition[i]})`} />}
      <Row
        k="resolved"
        v={
          override
            ? `${terrainName(resolved.terrain)} (override: ${override.name})`
            : resolved.rule
              ? `${terrainName(resolved.terrain)} (rule: ${resolved.rule})`
              : terrainName(resolved.terrain)
        }
      />
      <Row k="tile" v={sprites ? `${sprites.atlas.name} #${tileId}` : "—"} />
      <Row k="coverage" v={coverage.join(", ") || "none"} />
      {grid.elevation && grid.relief && <Row k="elevation" v={`${grid.elevation[i]} m (relief ${Math.round(grid.relief[i])} m)`} />}
      <div className="inspector-features">
        features ({features.length}):
        {features.slice(0, MAX_FEATURES).map(({ f, terrain }) => (
          <div key={f.key} className={terrain !== undefined && classifiedAs(terrain) === classified ? "decisive" : undefined}>
            {f.sourceLayer}
            {f.cls ? ` class=${f.cls}` : ""}
            {f.type ? ` type=${f.type}` : ""}
            {formatProps(f.props)} → {terrain === undefined ? "ignored" : terrainName(terrain)}
          </div>
        ))}
        {features.length > MAX_FEATURES && <div>… {features.length - MAX_FEATURES} more</div>}
      </div>
    </div>
  );
}

function formatProps(p: GeoFeature["props"]): string {
  const parts = [];
  if (p.name) parts.push(`"${p.name}"`);
  if (p.symbolrank !== undefined) parts.push(`rank=${p.symbolrank}`);
  if (p.level !== undefined) parts.push(`level=${p.level}`);
  if (p.minDepth !== undefined) parts.push(`depth≥${p.minDepth}`);
  if (p.ele !== undefined) parts.push(`ele≥${p.ele}`);
  return parts.length ? " " + parts.join(" ") : "";
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="row">
      <span>{k}</span>
      <span>{v}</span>
    </div>
  );
}

function TilePreview({ sprites, tileId }: { sprites: SpriteTileRenderer | null; tileId: number | undefined }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, 16, 16);
    if (!sprites || tileId === undefined) return;
    ctx.imageSmoothingEnabled = false;
    const [sx, sy, sw, sh] = sprites.atlas.sourceRect(tileId);
    ctx.drawImage(sprites.atlas.image, sx, sy, sw, sh, 0, 0, 16, 16);
  }, [sprites, tileId]);
  return <canvas ref={ref} width={16} height={16} className="tile-preview" />;
}
