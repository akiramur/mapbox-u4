import { describe, expect, it } from "vitest";
import { ctx, feature, makeSpec } from "../test/helpers";
import { labelText, placeLabels } from "./labels";
import { buildTileGrid } from "./tileGrid";

const place = (spec: ReturnType<typeof makeSpec>, name: string, at: [number, number], cls = "settlement", symbolrank = 6) =>
  feature(spec, "place_label_z9", { type: "Point", point: at }, { cls, props: { name, symbolrank } });

/** One entry per letter cell (spaces skipped), like the renderer draws them. */
const glyphsOf = (labels: ReturnType<typeof placeLabels>) =>
  labels.flatMap((l) => [...l.text].map((char, k) => ({ x: l.x + k, y: l.y, char })).filter((g) => g.char !== " "));

const textAtG = (glyphs: ReturnType<typeof glyphsOf>, y: number) =>
  glyphs
    .filter((g) => g.y === y)
    .sort((a, b) => a.x - b.x)
    .map((g) => g.char)
    .join("");

describe("labelText", () => {
  it("keeps A–Z only, upper case, without diacritics", () => {
    expect(labelText("Tōkyō")).toBe("TOKYO");
    expect(labelText("São Paulo")).toBe("SAO PAULO");
    expect(labelText("Saint-Denis")).toBe("SAINT DENIS");
    expect(labelText("横浜")).toBe("");
  });
});

describe("placeLabels", () => {
  it("writes a settlement's name on the row above its Town tile, centred", () => {
    const spec = makeSpec(20, 10, 10);
    const grid = buildTileGrid(spec, [place(spec, "Tokyo", [10.5, 5.5])], ctx("REGION", 10));
    const glyphs = glyphsOf(placeLabels(grid));
    expect(textAtG(glyphs, 4)).toBe("TOKYO");
    expect(Math.min(...glyphs.map((g) => g.x))).toBe(8); // TOKYO spans x 8–12 around x 10
    expect(glyphs.some((g) => g.y === 5)).toBe(false); // the Town row stays clear
  });

  it("falls back to the row below and drops labels that do not fit", () => {
    const spec = makeSpec(20, 10, 10);
    const grid = buildTileGrid(spec, [place(spec, "Tokyo", [10.5, 0.5]), place(spec, "Longcityname", [18.5, 5.5], "settlement", 8)], ctx("REGION", 10));
    const glyphs = glyphsOf(placeLabels(grid));
    expect(textAtG(glyphs, 1)).toBe("TOKYO"); // no room above row 0
    expect(glyphs.some((g) => g.char === "L")).toBe(false); // would run off the right edge
  });

  it("gives priority to more important places and avoids overlaps", () => {
    const spec = makeSpec(30, 10, 10);
    const grid = buildTileGrid(spec, [place(spec, "Kawasaki", [12.5, 5.5], "settlement", 9), place(spec, "Tokyo", [10.5, 5.5], "settlement", 6)], ctx("REGION", 10));
    const glyphs = glyphsOf(placeLabels(grid));
    expect(textAtG(glyphs, 4)).toBe("TOKYO");
    expect(textAtG(glyphs, 6)).toBe("KAWASAKI"); // pushed below
  });

  it("labels countries at WORLD once, and nothing at LOCAL", () => {
    const spec = makeSpec(30, 10, 5);
    const grid = buildTileGrid(spec, [place(spec, "Japan", [10.5, 5.5], "country", 2), place(spec, "Japan", [25.5, 8.5], "country", 2)], ctx("WORLD", 5));
    expect(placeLabels(grid).map((l) => l.text)).toEqual(["JAPAN"]);
    const local = makeSpec(20, 10, 16);
    expect(placeLabels(buildTileGrid(local, [place(local, "Tokyo", [10.5, 5.5])], ctx("LOCAL", 16)))).toEqual([]);
  });
});
