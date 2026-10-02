import { describe, expect, it } from "vitest";
import { ctx, feature, makeSpec } from "../test/helpers";
import { DEFAULT_WIDTH_EXPRESSIONS, evaluateZoomExpression, roadHalfWidthCells, roadWidthsPx } from "./roadWidths";
import { buildTileGrid } from "./tileGrid";
import { TerrainType } from "./TerrainType";

const primary = DEFAULT_WIDTH_EXPRESSIONS["road-primary"];

describe("evaluateZoomExpression", () => {
  it("matches the stops and clamps outside them", () => {
    expect(evaluateZoomExpression(primary, 18)).toBeCloseTo(28);
    expect(evaluateZoomExpression(primary, 22)).toBeCloseTo(280);
    expect(evaluateZoomExpression(primary, 1)).toBeCloseTo(0.8);
    expect(evaluateZoomExpression(primary, 25)).toBeCloseTo(280);
  });

  it("interpolates exponentially like Mapbox GL (base 1.5)", () => {
    // t = (1.5^14 - 1) / (1.5^15 - 1) between z3 and z18.
    const t = (Math.pow(1.5, 14) - 1) / (Math.pow(1.5, 15) - 1);
    expect(evaluateZoomExpression(primary, 17)).toBeCloseTo(0.8 + t * 27.2, 6);
    expect(evaluateZoomExpression(["interpolate", ["linear"], ["zoom"], 10, 0, 20, 10], 15)).toBeCloseTo(5);
    expect(evaluateZoomExpression(7, 15)).toBe(7);
  });

  it("returns null for expressions it does not understand", () => {
    expect(evaluateZoomExpression(["step", ["zoom"], 1, 10, 2], 12)).toBeNull();
    expect(evaluateZoomExpression(["interpolate", ["exponential", 1.5], ["get", "w"], 0, 1, 10, 2], 12)).toBeNull();
    expect(evaluateZoomExpression(undefined, 12)).toBeNull();
  });
});

describe("road widths", () => {
  it("falls back to the default expressions when the style lacks a layer", () => {
    const w = roadWidthsPx({}, 18);
    expect(w.primary).toBeCloseTo(28);
    expect(w.motorway).toBeCloseTo(30);
    expect(w.street).toBeCloseTo(20);
  });

  it("keeps roads at least one cell wide", () => {
    expect(roadHalfWidthCells(3, 16)).toBe(0.5);
    expect(roadHalfWidthCells(28, 16)).toBeCloseTo(0.875);
  });

  it("draws wider roads at high zoom", () => {
    const spec = makeSpec(16, 16, 18);
    const road = feature(spec, "road", { type: "LineString", points: [[0, 8.5], [16, 8.5]] }, { cls: "primary" });
    const width = (halfWidth?: number) => {
      const grid = buildTileGrid(spec, [road], { ...ctx("LOCAL", 18.2), roadHalfWidths: halfWidth ? { primary: halfWidth } : undefined });
      return [...Array(16).keys()].filter((y) => grid.classified[y * 16 + 5] === TerrainType.Road).length;
    };
    expect(width()).toBe(1);
    expect(width(roadHalfWidthCells(roadWidthsPx({}, 18.2).primary, 16))).toBeGreaterThan(1);
  });
});
