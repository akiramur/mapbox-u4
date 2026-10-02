import { describe, expect, it } from "vitest";
import { ctx, feature, makeSpec, rect } from "../test/helpers";
import { alignToCenter, buildTileGrid, cellAtLngLat, cellsAtLngLat, computeGridSpec, gridWorldCell, lngLatToWorld, worldToLngLat } from "./tileGrid";
import { TERRAIN_COUNT, TerrainType } from "./TerrainType";

// Assertions use grid.classified (before transitions and interiors).
const LOCAL = ctx("LOCAL", 15.5);

describe("projection", () => {
  it("round-trips lng/lat through world pixels", () => {
    const ws = 512 * 2 ** 15;
    const [x, y] = lngLatToWorld(139.75, 35.68, ws);
    const [lng, lat] = worldToLngLat(x, y, ws);
    expect(lng).toBeCloseTo(139.75, 9);
    expect(lat).toBeCloseTo(35.68, 9);
  });

  it("finds the cell containing a point and a stable world cell index", () => {
    const spec = makeSpec();
    const i = 3 * spec.cols + 5;
    const [gx, gy] = gridWorldCell(spec, i);
    expect(gx).toBe(spec.originX / spec.cellPx + 5);
    expect(gy).toBe(spec.originY / spec.cellPx + 3);
    const [lng, lat] = worldToLngLat(spec.originX + 5.5 * 16, spec.originY + 3.5 * 16, spec.worldSize);
    expect(cellAtLngLat(spec, lng, lat)).toEqual({ x: 5, y: 3 });
  });
});

describe("polygon rasterization (scanline, 3×3 samples)", () => {
  const coverage = (grid: ReturnType<typeof buildTileGrid>, x: number, y: number, t: TerrainType) =>
    grid.coverage[(y * grid.spec.cols + x) * TERRAIN_COUNT + t];

  it("covers exactly the cells inside a rectangle", () => {
    const spec = makeSpec();
    const grid = buildTileGrid(spec, [feature(spec, "water", { type: "Polygon", rings: [rect(2, 2, 4, 4)] })], LOCAL);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const inside = x >= 2 && x < 4 && y >= 2 && y < 4;
        expect(coverage(grid, x, y, TerrainType.Water)).toBe(inside ? 9 : 0);
      }
    }
    expect(grid.classified[2 * 8 + 2]).toBe(TerrainType.Water);
  });

  it("counts partial coverage by sample column", () => {
    const spec = makeSpec();
    // Covers x in [2, 2.4): only the sample column at x = 2 + 1/6.
    const grid = buildTileGrid(spec, [feature(spec, "water", { type: "Polygon", rings: [rect(2, 2, 2.4, 3)] })], LOCAL);
    expect(coverage(grid, 2, 2, TerrainType.Water)).toBe(3);
    expect(grid.classified[2 * 8 + 2]).toBe(TerrainType.Unknown); // 3/9 < 5/9
  });

  it("leaves holes empty (even–odd)", () => {
    const spec = makeSpec();
    const grid = buildTileGrid(spec, [feature(spec, "water", { type: "Polygon", rings: [rect(0, 0, 6, 6), rect(2, 2, 4, 4)] })], LOCAL);
    expect(coverage(grid, 1, 1, TerrainType.Water)).toBe(9);
    expect(coverage(grid, 2, 2, TerrainType.Water)).toBe(0);
    expect(coverage(grid, 3, 3, TerrainType.Water)).toBe(0);
  });

  it("does not double count a feature repeated across vector tiles", () => {
    const spec = makeSpec();
    // Cell 1 is covered by one sample column (3 samples); a duplicate must not add 3 more.
    const f = feature(spec, "water", { type: "Polygon", rings: [rect(0, 0, 1.5, 1)] });
    const grid = buildTileGrid(spec, [f, { ...f }], LOCAL);
    expect(coverage(grid, 1, 0, TerrainType.Water)).toBe(3);
    expect(grid.cellFeatures[1]).toHaveLength(1);
  });
});

describe("line and point rasterization", () => {
  it("marks cells whose centre is within half a cell of a road", () => {
    const spec = makeSpec();
    const road = feature(spec, "road", { type: "LineString", points: [[0, 3.5], [8, 3.5]] }, { cls: "motorway" });
    const grid = buildTileGrid(spec, [road], ctx("LOCAL", 15.5));
    for (let x = 0; x < 8; x++) {
      expect(grid.classified[3 * 8 + x]).toBe(TerrainType.Road);
      expect(grid.classified[2 * 8 + x]).toBe(TerrainType.Unknown);
    }
  });

  it("marks only the cell containing a settlement point", () => {
    const spec = makeSpec(8, 8, 9);
    const town = feature(spec, "place_label_z9", { type: "Point", point: [4.2, 5.7] }, { cls: "settlement", props: { symbolrank: 6 } });
    const grid = buildTileGrid(spec, [town], ctx("REGION", 9));
    expect(grid.classified[5 * 8 + 4]).toBe(TerrainType.Town);
    expect(grid.classified.filter((t) => t === TerrainType.Town)).toHaveLength(1);
  });
});

describe("narrow water (rivers narrower than a cell)", () => {
  // A 20-cell-long river only 0.3 cells wide: one sample row per cell.
  const river = (spec: ReturnType<typeof makeSpec>) => feature(spec, "water", { type: "Polygon", rings: [rect(0, 3.4, 20, 3.7)] });

  it("keeps a thin river continuous below LOCAL", () => {
    const spec = makeSpec(24, 8, 12);
    const grid = buildTileGrid(spec, [river(spec)], ctx("TOWN", 12.5));
    for (let x = 0; x < 20; x++) expect(grid.classified[3 * 24 + x]).toBe(TerrainType.Water);
  });

  it("does not apply at LOCAL, where the normal threshold is used", () => {
    const spec = makeSpec(24, 8, 15);
    const grid = buildTileGrid(spec, [river(spec)], ctx("LOCAL", 15.5));
    expect(grid.classified[3 * 24 + 5]).toBe(TerrainType.Unknown);
  });

  it("does not lower the threshold for compact water such as lakes", () => {
    const spec = makeSpec(24, 24, 12);
    // A 12×12 lake whose edge only clips a neighbouring cell by 0.3.
    const lake = feature(spec, "water", { type: "Polygon", rings: [rect(2, 2, 14.3, 14)] });
    const grid = buildTileGrid(spec, [lake], ctx("TOWN", 12.5));
    expect(grid.classified[5 * 24 + 14]).toBe(TerrainType.Unknown);
  });
});

describe("road thinning", () => {
  const twoLanes = (spec: ReturnType<typeof makeSpec>) => [
    feature(spec, "road", { type: "LineString", points: [[0, 3.5], [12, 3.5]] }, { cls: "motorway" }),
    feature(spec, "road", { type: "LineString", points: [[0, 4.5], [12, 4.5]] }, { cls: "motorway" }),
  ];
  const roadCellsInColumn = (grid: ReturnType<typeof buildTileGrid>, x: number) =>
    [...Array(grid.spec.rows).keys()].filter((y) => grid.classified[y * grid.spec.cols + x] === TerrainType.Road).length;

  it("collapses a dual carriageway to one cell wide at TOWN", () => {
    const spec = makeSpec(12, 8, 13);
    const grid = buildTileGrid(spec, twoLanes(spec), ctx("TOWN", 13.5));
    for (let x = 2; x < 10; x++) expect(roadCellsInColumn(grid, x)).toBe(1);
  });

  it("keeps both carriageways at LOCAL", () => {
    const spec = makeSpec(12, 8, 15);
    const grid = buildTileGrid(spec, twoLanes(spec), ctx("LOCAL", 15.5));
    for (let x = 2; x < 10; x++) expect(roadCellsInColumn(grid, x)).toBe(2);
  });
});

describe("relief from contours (local relief, not absolute height)", () => {
  // At z10 a cell is ~1 km here, so the 4 km relief window is ~4–5 cells.
  const contour = (spec: ReturnType<typeof makeSpec>, ele: number, rings: [number, number][][]) =>
    feature(spec, "contour", { type: "Polygon", rings }, { props: { ele } });

  it("keeps a high flat plateau flat", () => {
    const spec = makeSpec(32, 8, 10);
    const grid = buildTileGrid(spec, [contour(spec, 2000, [rect(0, 0, 32, 8)])], ctx("REGION", 10));
    expect(grid.classified.filter((t) => t === TerrainType.Mountain || t === TerrainType.Hill)).toHaveLength(0);
    expect(grid.elevation?.[0]).toBe(2000);
  });

  it("marks a canyon's surroundings as mountains, but not the far plateau", () => {
    const spec = makeSpec(32, 8, 10);
    // Plateau at 2000 m everywhere except a canyon at x ∈ [4, 6) that is only ≥ 800 m.
    const features = [
      contour(spec, 800, [rect(0, 0, 32, 8)]),
      contour(spec, 2000, [rect(0, 0, 4, 8)]),
      contour(spec, 2000, [rect(6, 0, 32, 8)]),
    ];
    const grid = buildTileGrid(spec, features, ctx("REGION", 10));
    expect(grid.elevation?.[4]).toBe(800);
    expect(grid.classified[3 * 32 + 7]).toBe(TerrainType.Mountain); // rim next to the canyon
    expect(grid.classified[3 * 32 + 30]).not.toBe(TerrainType.Mountain); // far out on the plateau
  });

  it("uses Hill for moderate relief", () => {
    const spec = makeSpec(16, 8, 10);
    const grid = buildTileGrid(spec, [contour(spec, 300, [rect(8, 0, 16, 8)])], ctx("REGION", 10));
    expect(grid.classified[3 * 16 + 9]).toBe(TerrainType.Hill); // 300 m above the 0 m plain next to it
  });
});

describe("across the antimeridian", () => {
  // Grid centred at −200° (Mapbox lets the centre run past −180° when panning west).
  const spec = computeGridSpec({ lng: -200, lat: 0 }, 3, 8, 8, 16);
  const cellLngLat = (x: number, y: number) => worldToLngLat(spec.originX + x * 16, spec.originY + y * 16, spec.worldSize);
  const polygonAt = (x0: number, y0: number, x1: number, y1: number, lngShift: number) => ({
    key: `water:${lngShift}`,
    sourceLayer: "water" as const,
    cls: undefined,
    type: undefined,
    props: {},
    geometry: {
      type: "Polygon" as const,
      coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]].map(([x, y]) => {
        const [lng, lat] = cellLngLat(x, y);
        return [lng + lngShift, lat];
      })],
    },
  });

  it("places canonical (−180…180°) geometry on a grid that lies beyond −180°", () => {
    // The same polygon given in canonical longitudes (+360°) must land on the same cells.
    const grid = buildTileGrid(spec, [polygonAt(2, 2, 4, 4, 360)], ctx("WORLD", 3));
    expect(grid.classified[2 * 8 + 2]).toBe(TerrainType.Water);
    expect(grid.classified[3 * 8 + 3]).toBe(TerrainType.Water);
  });

  it("also accepts geometry that is already wrapped", () => {
    const grid = buildTileGrid(spec, [polygonAt(2, 2, 4, 4, 0)], ctx("WORLD", 3));
    expect(grid.classified[2 * 8 + 2]).toBe(TerrainType.Water);
  });

  it("finds cells for points in either longitude convention", () => {
    const [lng, lat] = cellLngLat(5.5, 3.5);
    expect(cellAtLngLat(spec, lng, lat)).toEqual({ x: 5, y: 3 });
    expect(cellAtLngLat(spec, lng + 360, lat)).toEqual({ x: 5, y: 3 });
  });

  it("moves the grid to the world copy the camera wrapped to", () => {
    // Built at −179°, then the camera crosses west and Mapbox wraps it to +179°.
    const built = computeGridSpec({ lng: -179, lat: 0 }, 3, 8, 8, 16);
    const aligned = alignToCenter(built, { lng: 179, lat: 0 });
    expect(aligned.originX).toBe(built.originX + built.worldSize);
    expect({ ...aligned, originX: built.originX }).toEqual(built);
    expect(alignToCenter(built, { lng: -178, lat: 0 })).toBe(built);
  });
});

describe("grid wider than the world (zoomed out below ~z1)", () => {
  // At z0 the world is 512 px = 32 cells wide; a 80-cell grid shows it 2.5 times.
  const spec = computeGridSpec({ lng: 0, lat: 0 }, 0, 80, 8, 16);
  const island = {
    key: "water:island",
    sourceLayer: "water" as const,
    cls: undefined,
    type: undefined,
    props: {},
    geometry: { type: "Polygon" as const, coordinates: [[[10, -10], [30, -10], [30, 10], [10, 10], [10, -10]]] },
  };

  it("draws a feature in every world copy on the grid", () => {
    const grid = buildTileGrid(spec, [island], ctx("WORLD", 0));
    const waterColumns = new Set<number>();
    grid.classified.forEach((t, i) => {
      if (t === TerrainType.Water) waterColumns.add(i % spec.cols);
    });
    // Columns 32 apart (one world width) repeat the same island.
    const cols = [...waterColumns].sort((a, b) => a - b);
    expect(cols.length).toBeGreaterThan(0);
    for (const c of cols) if (c + 32 < spec.cols) expect(waterColumns.has(c + 32)).toBe(true);
  });

  it("finds a point once per world copy", () => {
    const cells = cellsAtLngLat(spec, 20, 0);
    expect(cells.length).toBeGreaterThanOrEqual(2);
    expect(new Set(cells.map((c) => c.x % 32)).size).toBe(1);
    expect(new Set(cells.map((c) => c.copy)).size).toBe(cells.length);
  });
});
