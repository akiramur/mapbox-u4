// Generates the project's own tile set: public/assets/original/tiles.png.
//
// Every tile is drawn here from scratch (no pixels are taken from any other
// tile set), in the spirit of 16-colour (EGA) RPG overworld maps: 16×16 cells,
// a black ground, flat colours from a fixed EGA-style palette, and sparse dot
// and line patterns. Released under CC0 (see public/assets/original/LICENSE).
//
//   node scripts/make-original-atlas.mjs
//
// Layout: 16 columns of 16×16 tiles.
//   row 0: terrain tiles in TILE_ORDER below (index = column)
//   rows 1–2: letters A–Z (index 16 + letter)
//   from index 48: creatures, two frames each, in CREATURES order, then the fireball,
//   then the warp gate (3 rising stages + open), then the townsfolk (two
//   frames each, in TOWNSFOLK order)
// src/config/tileMappings.ts refers to these indices; keep them in sync.
//
// The renderers key out (near-)black pixels (r+g+b < 60) to draw letters and
// sprites over terrain, so black is the only colour below that.
import { mkdir, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";

const S = 16;
const COLUMNS = 16;

/** The colours every tile is drawn with (EGA-style; nothing else is allowed). */
const EGA = {
  black: [0, 0, 0],
  navy: [0, 0, 128],
  blue: [0, 0, 255],
  green: [0, 164, 0],
  lime: [0, 255, 0],
  teal: [0, 128, 128],
  cyan: [0, 255, 255],
  maroon: [128, 0, 0],
  red: [255, 64, 64],
  magenta: [255, 0, 255],
  orange: [230, 152, 6],
  yellow: [255, 255, 0],
  grey: [128, 128, 128],
  silver: [192, 192, 192],
  white: [255, 255, 255],
  violet: [128, 0, 128],
  brown: [170, 85, 0],
};
const PALETTE_COLOURS = new Set(Object.values(EGA).map((c) => c.join()));

/** Characters used in drawings. "." is transparent (black). */
const PALETTE = {
  W: EGA.white,
  w: EGA.silver,
  m: EGA.grey,
  k: EGA.navy,
  G: EGA.green,
  g: EGA.lime,
  B: EGA.blue,
  b: EGA.navy,
  L: EGA.cyan,
  T: EGA.teal,
  V: EGA.magenta,
  v: EGA.violet,
  O: EGA.orange,
  o: EGA.maroon,
  Y: EGA.yellow,
  R: EGA.red,
  r: EGA.orange,
  c: EGA.silver,
  s: EGA.orange,
};

/** Deterministic per-pixel noise in [0, 1). */
function hash(x, y, seed = 0) {
  let h = (Math.imul(x + 101, 374761393) + Math.imul(y + 7, 668265263) + Math.imul(seed + 13, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** A tile is a 16×16 grid of [r, g, b], or null for the black ground. */
const blank = () => Array.from({ length: S }, () => Array(S).fill(null));
const fill = (fn) => Array.from({ length: S }, (_, y) => Array.from({ length: S }, (_, x) => fn(x, y)));
const wrap = (v) => ((v % S) + S) % S;
const put = (grid, x, y, c) => {
  grid[wrap(y)][wrap(x)] = c;
};

/** Paints a character drawing (array of strings, "." or " " transparent) at x0, y0, wrapping around the tile. */
function paint(grid, rows, x0 = 0, y0 = 0) {
  rows.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      if (ch === "." || ch === " ") return;
      if (!PALETTE[ch]) throw new Error(`unknown colour '${ch}'`);
      put(grid, x0 + x, y0 + y, PALETTE[ch]);
    }),
  );
  return grid;
}

/** A sprite on the black ground. */
const sprite = (rows) => paint(blank(), rows);

// ---------------------------------------------------------------- terrain

/**
 * Sparse green dots on black, a share `bright` of them bright. The dots are spread evenly
 * (one per 4×4 cell before any cell gets a second, at a random spot in it), so
 * neither clumps nor gaps show up as a pattern when the tile repeats.
 * `density` is the share of pixels that get a dot.
 */
function grassDots(grid, seed, density = 0.09, bright = 0.2) {
  const cells = [];
  for (let cy = 0; cy < S / 4; cy++) for (let cx = 0; cx < S / 4; cx++) cells.push([cx, cy]);
  // Fill alternate cells first (a checkerboard), so a sparse tile still covers it all.
  cells.sort(([ax, ay], [bx, by]) => ((ax + ay) % 2) - ((bx + by) % 2) || hash(ax, ay, seed) - hash(bx, by, seed));
  const QUADRANTS = [[0, 0], [1, 1], [1, 0], [0, 1]];
  const count = Math.round(density * S * S);
  for (let i = 0; i < count; i++) {
    const [cx, cy] = cells[i % cells.length];
    const [qx, qy] = QUADRANTS[Math.floor(i / cells.length) % 4];
    const x = cx * 4 + qx * 2 + Math.floor(hash(i, 1, seed) * 2);
    const y = cy * 4 + qy * 2 + Math.floor(hash(i, 2, seed) * 2);
    grid[y][x] = hash(i, 3, seed) < bright ? EGA.lime : EGA.green;
  }
  return grid;
}

// Water: rows of wave strokes on black (a short run, then a step down),
// denser and lighter as it gets shallower. Row spacing divides 16 and the
// row count is even, so the tile wraps vertically without a seam (the WebGL
// renderer scrolls water tiles).
function water({ colour, crest, step, speckle, seed }) {
  const g = blank();
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (speckle && hash(x, y, seed) < 0.06) g[y][x] = speckle;
  const STROKE = [0, 0, 0, 1, 1]; // y offsets along an 8 px period; the rest is gap
  for (let y0 = 1, row = 0; y0 < S + 1; y0 += step, row++) {
    const shift = row % 2 ? 4 : 0;
    for (let x = 0; x < S; x++) {
      const p = (x + shift) % 8;
      if (p >= STROKE.length) continue;
      put(g, x, y0 + STROKE[p], crest && p === 0 ? crest : colour);
    }
  }
  return g;
}

const deepWater = water({ colour: EGA.blue, step: 8, speckle: EGA.navy, seed: 11 });
const midWater = water({ colour: EGA.blue, step: 4, seed: 12 });
const shallowWater = water({ colour: EGA.blue, crest: EGA.cyan, step: 4, speckle: EGA.teal, seed: 13 });

// No bright dots: plain grass fills large areas, and bright dots repeating
// at the same spot in every tile show up as a lattice.
const grass = grassDots(blank(), 21, 0.05, 0);

const scrub = (() => {
  const g = grassDots(blank(), 31, 0.06);
  for (const [x, y] of [[3, 2], [11, 5], [5, 10], [13, 12]]) paint(g, [" G ", "GgG", "G.G"], x, y);
  return g;
})();

/** A tree crown: a one-pixel green oval ring (or a solid oval), optionally with a bright glint at the upper left. */
function crown(grid, cx, cy, rx, ry = rx, solid = false, glint = true) {
  const inside = (x, y) => Math.hypot((x - cx) / rx, (y - cy) / ry) <= 1;
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      if (!inside(x, y)) continue;
      const rim = !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1);
      put(grid, x, y, rim || solid ? EGA.green : null);
    }
  if (glint) put(grid, Math.round(cx - rx / 2), Math.round(cy - ry / 2), EGA.lime);
}

// Forest: wide, solid oval crowns, each at its own height so no row lines up across tiles, with a few dots between them.
// No bright glints or dots: repeated over a forest they show up as a lattice.
const forest = (() => {
  const g = grassDots(blank(), 41, 0.03, 0);
  for (const [cx, cy] of [[3, 2], [11, 5], [6, 10], [14, 13]]) crown(g, cx, cy, 3.2, 2.2, true, false);
  return g;
})();

// Park: two fruit trees and flowers on grass.
const park = (() => {
  const g = grassDots(blank(), 51, 0.06);
  for (const [x, y] of [[3, 2], [10, 8]]) {
    paint(g, ["  o  ", "  o  ", " ooo "], x, y + 5);
    crown(g, x + 2, y + 2, 2.4, 2.4, true);
    paint(g, ["R   ", "   R"], x + 1, y + 1);
  }
  for (const [x, y, c] of [[12, 2, "Y"], [3, 12, "V"], [14, 14, "Y"], [7, 6, "V"]]) paint(g, [`.${c}.`, `${c}.${c}`, ".G."], x, y);
  return g;
})();

// Road: a sparse maroon dither with orange pebbles, readable in any direction.
const road = (() => {
  const g = fill((x, y) => ((x + y) % 2 === 0 && (x * 3 + y) % 4 !== 1 ? EGA.maroon : null));
  for (const [x, y] of [[2, 1], [9, 3], [13, 6], [5, 6], [1, 10], [11, 10], [7, 13], [14, 14], [3, 14]]) paint(g, ["OO"], x, y);
  return g;
})();

// Village: two huts with orange thatch.
const HUT = [
  "   r   ",
  "  rrr  ",
  " rrrrr ",
  "rrrrrrr",
  " wwwww ",
  " wo.ow ",
  " wo.ww ",
];
const village = (() => {
  const g = grassDots(blank(), 71, 0.05);
  paint(g, HUT, 0, 1);
  paint(g, HUT, 8, 8);
  return g;
})();

// Town: a white hall and towers behind a grey wall, with a red flag.
// The flag (3×2 px, right of the pole) flutters in the WebGL renderer; see ORIGINAL_FLAGS in tileMappings.ts.
const town = (() => {
  const g = grassDots(blank(), 81, 0.05);
  paint(g, [
    "......w.........",
    "......wRRR......",
    "......wRRR......",
    "..r...w.....r...",
    ".rrr.WWW...rrr..",
    ".www.W.W...www..",
    ".w.w.WWW...w.w..",
    ".www.WWWWW.www..",
    ".www.WW.WW.www..",
    "................",
    "w.w.w.w..w.w.w.w",
    "wmwmwmw..wmwmwmw",
    "mwmwmw....wmwmwm",
    "wmwmwm....mwmwmw",
  ], 0, 1);
  return g;
})();

// Castle: a dithered grey keep between two towers with orange roofs, and the flag on the keep.
const castle = (() => {
  const g = grassDots(blank(), 91, 0.04);
  const rows = [
    ".........wRRR...",
    ".........wRRR...",
    ".r.......w....r.",
    "rrr....W.w.W.rrr",
    "WmW....WWWWW.WmW",
    "mWm....WmWmW.mWm",
    "WmW....mW.Wm.WmW",
    "mWmWmWmWmWmWmWmW",
    "WmWmWmWmWmWmWmWm",
    "mWmWmWm...mWmWmW",
    "WmWmWm.....mWmWm",
    "mWmWmW.....WmWmW",
    "WmWmWm.....mWmWm",
  ];
  paint(g, rows, 0, 0);
  return g;
})();

// Wall: grey bricks lit silver along the top, with black gaps between them.
const wall = fill((x, y) => {
  const course = Math.floor(y / 4);
  const bx = (x + (course % 2) * 4) % 8;
  if (y % 4 === 3 || bx === 7) return EGA.black;
  return y % 4 === 0 || bx === 0 ? EGA.silver : EGA.grey;
});

// Floor: thin brown planks (8 wide, 1 tall) with 1-row black gaps, each course
// offset differently, and a few orange flecks.
const floor = fill((x, y) => {
  const course = Math.floor(y / 2);
  const bx = (x + [0, 4, 2, 6][course % 4]) % 8;
  if (y % 2 === 1 || bx === 7) return EGA.black;
  return hash(x, y, 111) < 0.08 ? EGA.orange : EGA.brown;
});

// Hills: grey arcs (a light ridge over a darker one) among grass dots.
const hills = (() => {
  const g = grassDots(blank(), 121, 0.05);
  const ARC = ["  wwww  ", " w    w ", "w      w", " mmmm   ", "m    m  "];
  paint(g, ARC, 1, 2);
  paint(g, ARC, 8, 9);
  return g;
})();

// Mountains: peaks outlined white on the sunlit left and silver on the right, with a snow cap and grey rock.
function peak(grid, ax, ay, height, seed) {
  for (let i = 0; i < height; i++) {
    const y = ay + i;
    const left = ax - i + (i > 2 && hash(i, ax, seed) < 0.4 ? 1 : 0);
    const right = ax + i;
    for (let x = left; x <= right; x++) put(grid, x, y, null);
    if (i < 2) for (let x = left; x <= right; x++) put(grid, x, y, EGA.white);
    else for (let x = left + 2; x < right - 1; x += 3) put(grid, x + (i % 2), y, EGA.grey);
    put(grid, left, y, EGA.white);
    put(grid, right, y, EGA.silver);
  }
}

const mountains = (() => {
  const g = blank();
  peak(g, 10, 1, 9, 132);
  peak(g, 3, 3, 7, 133);
  peak(g, 6, 10, 6, 134);
  peak(g, 14, 11, 5, 135);
  return g;
})();

/** Row 0, in index order. */
const TILE_ORDER = [
  ["deepWater", deepWater],
  ["water", midWater],
  ["shallowWater", shallowWater],
  ["grass", grass],
  ["scrub", scrub],
  ["forest", forest],
  ["park", park],
  ["road", road],
  ["village", village],
  ["town", town],
  ["castle", castle],
  ["wall", wall],
  ["floor", floor],
  ["hills", hills],
  ["mountains", mountains],
];

// ---------------------------------------------------------------- letters

// 5×7 capitals, drawn at 2× (10×14).
const FONT = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  J: ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
};

// Flat white strokes.
function letter(ch) {
  const rows = FONT[ch].flatMap((row) => {
    const wide = [...row].map((b) => (b === "1" ? "WW" : "..")).join("");
    return [wide, wide];
  });
  return paint(blank(), rows, 3, 1);
}


// ---------------------------------------------------------------- creatures

// Creatures that wander the map (see ORIGINAL_CREATURES in tileMappings.ts).
// Each is drawn once; frame 2 is derived (a one-pixel bob, or a mirror for
// spinning ones). Order here = order in the atlas (two tiles per creature,
// starting at index 48), followed by the fireball.
const CREATURES = [
  ["ship", "bob", [
    "................",
    ".......W........",
    ".......WRR......",
    ".......WRR......",
    ".....WWWWWWW....",
    "....WWWWWWWWW...",
    ".......W........",
    ".......W........",
    "..oooooooooooo..",
    "..oOoOoOoOoOoo..",
    "...oooooooooo...",
    "....oooooooo....",
    "..BB..BB..BB..BB",
    ".BB..BB..BB..BB.",
    "................",
    "................"]],
  ["water-sprite", "bob", [
    "................",
    "......LLL.......",
    ".....LWLWL......",
    ".....LLLLL......",
    "......LLL.......",
    "...L.LLLLL.L....",
    "....LLLLLLL.....",
    "......LLL.......",
    ".....LLLLL......",
    "....LL...LL.....",
    "................",
    "..BB..BB..BB....",
    ".BB..BB..BB..BB.",
    "................",
    "................",
    "................"]],
  ["kraken", "bob", [
    "................",
    "......VVVV......",
    ".....VVVVVV.....",
    "....VVWVVWVV....",
    "....VVVVVVVV....",
    ".....VVVVVV.....",
    "....V.V..V.V....",
    "...V..V..V..V...",
    "...V.V....V.V...",
    "..V..V....V..V..",
    "..V...V..V...V..",
    "................",
    "..BB..BB..BB....",
    ".BB..BB..BB..BB.",
    "................",
    "................"]],
  ["sea-serpent", "bob", [
    "................",
    "..........GGG...",
    ".........GGWGG..",
    ".........GGGGGR.",
    "..........GG....",
    "..........GG....",
    "...GG....GG.....",
    "..GGGG..GGG.....",
    ".GG..GGGGG......",
    ".G....GGG.......",
    "................",
    "..BB..BB..BB....",
    ".BB..BB..BB..BB.",
    "................",
    "................",
    "................"]],
  ["seahorse", "bob", [
    "................",
    "......YYY.......",
    ".....YYWYY......",
    ".....YY.YYYY....",
    "......YY........",
    "......YYY.......",
    ".....YYYY.......",
    ".....YYYY.......",
    "......YYY.......",
    ".......YY.......",
    "......YY........",
    "......YYY.......",
    "..BB..BB..BB....",
    ".BB..BB..BB..BB.",
    "................",
    "................"]],
  ["whirlpool", "mirror", [
    "................",
    "................",
    ".....BBBBBB.....",
    "...BBLLLLLLBB...",
    "..BL.......LB...",
    "..BL.BBBBB..LB..",
    ".BL.BL...LB.LB..",
    ".BL.BL.L..LB.LB.",
    ".BL.BL..LLB..LB.",
    ".BL..BL.....LB..",
    "..BL..BBBBBB.B..",
    "..BLL.......LB..",
    "...BBLLLLLLBB...",
    ".....BBBBBB.....",
    "................",
    "................"]],
  ["twister", "mirror", [
    "................",
    "..wwwwwwwwwwww..",
    "...wwwwwwwwww...",
    "....wwwwwwwww...",
    ".....wwwwwww....",
    "......wwwwww....",
    "......wwwww.....",
    ".......wwww.....",
    ".......www......",
    "........ww......",
    "........ww......",
    ".......ww.......",
    "......ww........",
    "................",
    "................",
    "................"]],
  ["orc", "bob", [
    "................",
    "......GGG.......",
    ".....GRGRG......",
    ".....GGGGG......",
    "......GGG.......",
    "...o.GGGGG.G....",
    "...oGGoooGGG....",
    "...o..ooo..G....",
    "...o..GGG.......",
    ".....GG.GG......",
    ".....G...G......",
    "....GG...GG.....",
    "................",
    "................",
    "................",
    "................"]],
  ["skeleton", "bob", [
    "................",
    "......WWW.......",
    ".....W.W.W......",
    ".....WWWWW......",
    "......W.W.......",
    "....WWWWWWW.....",
    "...W..W.W..W....",
    "......WWW.......",
    "......W.W.......",
    ".....W...W......",
    ".....W...W......",
    "....WW...WW.....",
    "................",
    "................",
    "................",
    "................"]],
  ["bandit", "bob", [
    "................",
    "......vvv.......",
    ".....vvvvv......",
    ".....vWvWv......",
    "......vvv.......",
    "....vvvvvvv...w.",
    "...v.vvvvv.v.w..",
    "......vvv...w...",
    "......vvv.......",
    ".....vv.vv......",
    ".....v...v......",
    "....oo...oo.....",
    "................",
    "................",
    "................",
    "................"]],
  ["python", "bob", [
    "................",
    "................",
    "..........GGG...",
    ".........GYGYG..",
    ".........GGGGGR.",
    "..........GG....",
    "....GGG...GG....",
    "...GYGYG.GG.....",
    "..GG...GGGG.....",
    "..GG....GG......",
    "...GG...........",
    "....GGGGGGGG....",
    "................",
    "................",
    "................",
    "................"]],
  ["two-headed-giant", "bob", [
    "................",
    "...ooo...ooo....",
    "...oRo...oRo....",
    "...ooo...ooo....",
    "....ooooooo.....",
    "..ooooooooooo...",
    ".o..ooooooo..o..",
    ".o..ooooooo..o..",
    "....ooo.ooo.....",
    "....oo...oo.....",
    "....oo...oo.....",
    "...ooo...ooo....",
    "................",
    "................",
    "................",
    "................"]],
  ["headless", "bob", [
    "................",
    "................",
    "................",
    "....WWWWWWW.....",
    "...W.WWWWW.W....",
    "...W.WRWRW.W....",
    "...W.WWWWW.W....",
    ".....WWWWW......",
    "......W.W.......",
    ".....W...W......",
    ".....W...W......",
    "....WW...WW.....",
    "................",
    "................",
    "................",
    "................"]],
  ["cyclops", "bob", [
    "................",
    ".....ooooo......",
    "....oWWRWWo.....",
    "....ooooooo.....",
    ".....ooooo......",
    "..ooooooooooo...",
    ".o..ooooooo..o..",
    ".o..ooooooo..o..",
    "....ooooooo.....",
    "....ooo.ooo.....",
    "....oo...oo.....",
    "...ooo...ooo....",
    "................",
    "................",
    "................",
    "................"]],
  ["wisp", "bob", [
    "................",
    "................",
    "................",
    "......LLL.......",
    ".....LWWWL......",
    "....LWWWWWL.....",
    "....LWWWWWL.....",
    ".....LWWWL......",
    "......LLL.......",
    ".......L........",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................"]],
  ["sorcerer", "bob", [
    "................",
    ".......V........",
    "......VVV.......",
    ".....VVVVV......",
    "......WWW.......",
    "......WYW....Y..",
    ".....VVVVV..YYY.",
    "....VVVVVVV..w..",
    "...V.VVVVV.V.w..",
    ".....VVVVV...w..",
    "....VVVVVVV..w..",
    "................",
    "................",
    "................",
    "................",
    "................"]],
  ["lich", "bob", [
    "................",
    ".....WWWWW......",
    "....WW.W.WW.....",
    "....WWWWWWW.....",
    ".....W.W.W......",
    "....vvvvvvv.....",
    "...vvvvvvvvv....",
    "...v.vvvvv.v....",
    ".....vvvvv......",
    "....vvvvvvv.....",
    "...vvvvvvvvv....",
    "................",
    "................",
    "................",
    "................",
    "................"]],
  ["fire-lizard", "bob", [
    "................",
    "................",
    "................",
    ".........OOO....",
    "........OORO....",
    ".......OOOOOOR..",
    "..OO..OOOOO.....",
    ".O..OOOOOOO.....",
    ".....OOOOOO.....",
    ".....O.O..O.O...",
    "....O..O...O....",
    "................",
    "................",
    "................",
    "................",
    "................"]],
  ["void-beast", "bob", [
    "................",
    "....V.....V.....",
    "....VV...VV.....",
    ".....VVVVV......",
    "....VWVVVWV.....",
    "....VVVVVVV.....",
    "...VVVVVVVVV....",
    "..VV.VVVVV.VV...",
    "..V..VVVVV..V...",
    ".....VV.VV......",
    "....VV...VV.....",
    "................",
    "................",
    "................",
    "................",
    "................"]],
  ["demon", "bob", [
    "................",
    "...R.......R....",
    "..RR.RRRR.RR....",
    "..RRRYRRYRRR....",
    "...RRRRRRRR.....",
    "RR..RRRRRR..RR..",
    "RRRRRRRRRRRRRR..",
    "RR..RRRRRR..RR..",
    ".....RRRR.......",
    ".....RR.RR......",
    "....RR...RR.....",
    "................",
    "................",
    "................",
    "................",
    "................"]],
  ["hydra", "bob", [
    "................",
    "..GG...GG...GG..",
    ".GRG..GRG..GRG..",
    "..G.....G...G...",
    "..G.....G...G...",
    "...G....G..G....",
    "....G...G.G.....",
    ".....GGGGGG.....",
    "....GGGGGGGG....",
    "...GGGGGGGGGG...",
    "...G.G....G.G...",
    "................",
    "................",
    "................",
    "................",
    "................"]],
  ["dragon", "bob", [
    "................",
    ".R.........RR...",
    ".RR.......RRYR..",
    ".RRR.....RRRRRR.",
    ".RRRR...RRR.....",
    "..RRRRRRRRR.....",
    "...RRRRRRRR.....",
    "....RRRRRRRR....",
    "....RRRRR.RRR...",
    "....R..R....RR..",
    "...R...R.....R..",
    "................",
    "................",
    "................",
    "................",
    "................"]],
  ["dark-lord", "bob", [
    "................",
    "..R..RRRR..R....",
    "..RR.RYRY.RR....",
    "..RRRRRRRRRR....",
    "RRRRRRRRRRRRRRR.",
    "RR..RRRRRRR..RR.",
    "R...RRRRRRR...R.",
    "....RRRRRRR.....",
    "....RRR.RRR.....",
    "....RR...RR.....",
    "...RRR...RRR....",
    "................",
    "................",
    "................",
    "................",
    "................"]],
];

const FIREBALL = [
  "................",
  "................",
  "................",
  "................",
  "......RRRR......",
  ".....RYYYYR.....",
  "....RYWWWWYR....",
  "....RYWWWWYR....",
  "....RYWWWWYR....",
  "....RYWWWWYR....",
  ".....RYYYYR.....",
  "......RRRR......",
  "................",
  "................",
  "................",
  "................",
];

// Warp gate, fully open. It rises in three stages (the bottom quarter, half,
// three quarters of the gate), then stands open (see ORIGINAL_GATE).
const GATE = [
  "................",
  "....bbbbbbbb....",
  "...bLLLLLLLLb...",
  "..bLBBBBBBBBLb..",
  "..bLB.W..W.BLb..",
  "..bLB......BLb..",
  "..bLB..W...BLb..",
  "..bLB......BLb..",
  "..bLBW.....BLb..",
  "..bLB....W.BLb..",
  "..bLB......BLb..",
  "..bLB.W....BLb..",
  "..bLB......BLb..",
  "..bLB...W..BLb..",
  ".bbbbbbbbbbbbbb.",
  "................",
];

function gateStage(rows, quarters) {
  const top = 15 - Math.round((14 * quarters) / 4); // rows above this are empty
  return rows.map((r, y) => (y < top ? ".".repeat(16) : r));
}

// Townsfolk who walk around towns at high zoom (the "town" spawn table of
// ORIGINAL_CREATURES). Drawn as a block of rows (any width, padded right),
// centred and standing on row 14. Frame 2: people mirror (arms and props
// swap sides, like a step), animals bob.
const TOWNSFOLK = [
  ["villager", "mirror", [
    "...oooo...",
    "..oooooo..",
    "..osssso..",
    "..osssso..",
    "...ssss...",
    "..BBBBBB..",
    ".BBBBBBBB.",
    ".sBBBBBBs.",
    ".sBBBBBBs.",
    "..BBBBBB..",
    "..oo..oo..",
    "..oo..oo..",
    ".ooo..ooo."]],
  ["woman", "mirror", [
    "...YYYY...",
    "..YYYYYY..",
    "..YssssY..",
    "..YssssY..",
    "..Y.ss.Y..",
    "..RRRRRR..",
    ".RRRRRRRR.",
    ".sRRRRRRs.",
    "..RRRRRR..",
    "..RRRRRR..",
    ".RRRRRRRR.",
    ".RRRRRRRR.",
    "...s..s..."]],
  ["child", "mirror", [
    "..oooo..",
    ".osssso.",
    ".osssso.",
    "..ssss..",
    ".GGGGGG.",
    "sGGGGGGs",
    ".GGGGGG.",
    ".ss..ss.",
    ".oo..oo."]],
  ["bard", "mirror", [
    "....GGG.R.",
    "...GGGGGR.",
    "...ssss...",
    "...ssss...",
    "....ss....",
    "..VVVVVV.o",
    ".VVVVVVVo.",
    ".sVVVVoOo.",
    "..VVVoOOOo",
    "..VVVVooo.",
    "..vv..vv..",
    "..vv..vv..",
    ".ooo..ooo."]],
  ["jester", "mirror", [
    ".Y......Y.",
    ".RR....BB.",
    "..RRRBBB..",
    "...ssss...",
    "...ssss...",
    "....ss....",
    "..RRRBBB..",
    ".RRRRBBBB.",
    ".sRRRBBBs.",
    "..RRRBBB..",
    "..BB..RR..",
    "..BB..RR..",
    ".YYY..YYY."]],
  ["fighter", "mirror", [
    "...wwww...",
    "..wwwwww..",
    "..wssssw..",
    "...ssss.W.",
    "....ss..W.",
    "..wwwwwwW.",
    "RRwwwwwwW.",
    "RYRwwwwso.",
    "RRRwwww...",
    ".R.wwww...",
    "...ww.ww..",
    "...ww.ww..",
    "..mmm.mmm."]],
  ["mage", "mirror", [
    "....V.....",
    "...VVV..Y.",
    "..VVVVV.o.",
    "...ssss.o.",
    "...ssss.o.",
    "....ss..o.",
    "..VVVVVVo.",
    ".VVVVVVVs.",
    ".VVYVVVVo.",
    ".VVVVVVVo.",
    ".VVVVVVVo.",
    "VVVVVVVVVo",
    "VVVVVVVVVo"]],
  ["king", "mirror", [
    "..Y.Y.Y...",
    "..YYYYY...",
    "..sssss...",
    "..sssss.Y.",
    "...WWW..o.",
    ".RRRRRRRo.",
    "RRRRYRRRs.",
    "RRRRYRRRo.",
    "RRRRYRRRo.",
    "RRRRYRRRR.",
    "RRRRYRRRR.",
    "RRRRYRRRR.",
    "WWWWWWWWW."]],
  ["beggar", "mirror", [
    "...wwww...",
    "..wssssw..",
    "..wssss...",
    "...ss.....",
    "..mmmmm...",
    ".mmmmmmm..",
    ".smmmmmmo.",
    "..mmmmm.o.",
    "..mmmmm.o.",
    "..mm.mm.o.",
    "..ss.ss.o."]],
  ["horse", "bob", [
    "..........oo..",
    ".........oooo.",
    ".........ooWo.",
    "........oooooo",
    "oo.....oooo...",
    ".oooooooooo...",
    ".oooooooooo...",
    "..oooooooo....",
    "..o.o...o.o...",
    "..o.o...o.o...",
    "..w.w...w.w..."]],
  ["cow", "bob", [
    "..........w..w",
    "..........WWWW",
    ".WWWWmmWWWWWmW",
    "WWmmWWWWWWWWWW",
    ".WWWWWWWmmWWR.",
    ".WWmmWWWWWW...",
    "..W.W....W.W..",
    "..W.W....W.W..",
    "..m.m....m.m.."]],
  ["dog", "bob", [
    "........oo.",
    "o......ooWo",
    ".o.....oooo",
    ".oooooooo..",
    ".oooooooo..",
    ".o.o...o.o.",
    ".o.o...o.o."]],
];

/** Pads a block of rows to 16×16, centred horizontally, standing on row 14. */
function figure(block) {
  const w = Math.max(...block.map((r) => r.length));
  const left = Math.floor((S - w) / 2);
  const rows = block.map((r) => ".".repeat(left) + r.padEnd(w, ".") + ".".repeat(S - w - left));
  const top = 15 - rows.length;
  return [...Array(top).fill(".".repeat(S)), ...rows, ".".repeat(S)];
}

/** Second animation frame: shift up one pixel, or mirror horizontally. */
function secondFrame(rows, kind) {
  if (kind === "mirror") return rows.map((r) => [...r].reverse().join(""));
  return [...rows.slice(1), rows[0]];
}

// ---------------------------------------------------------------- output

/** Character rows (creatures, gate, townsfolk) → a sprite; RGB grids pass through. */
const toGrid = (tile) => (typeof tile[0] === "string" ? sprite(tile) : tile);

function validate(name, grid) {
  if (grid.length !== S || grid.some((r) => r.length !== S)) throw new Error(`${name}: not ${S}×${S}`);
  for (const r of grid) for (const c of r) if (c !== null && !PALETTE_COLOURS.has(c.join())) throw new Error(`${name}: ${c} is not in the palette`);
}

const tiles = TILE_ORDER.map(([name, grid]) => [name, grid]);
while (tiles.length < COLUMNS) tiles.push(["(empty)", blank()]);
for (const ch of Object.keys(FONT)) tiles.push([`letter ${ch}`, letter(ch)]);
while (tiles.length < 48) tiles.push(["(empty)", blank()]);
for (const [name, kind, rows] of CREATURES) {
  tiles.push([`${name} 1`, rows]);
  tiles.push([`${name} 2`, secondFrame(rows, kind)]);
}
tiles.push(["fireball", FIREBALL]);
for (const q of [1, 2, 3, 4]) tiles.push([`gate ${q}/4`, gateStage(GATE, q)]);
for (const [name, kind, block] of TOWNSFOLK) {
  const rows = figure(block);
  tiles.push([`${name} 1`, rows]);
  tiles.push([`${name} 2`, secondFrame(rows, kind)]);
}
while (tiles.length % COLUMNS) tiles.push(["(empty)", blank()]);
const grids = tiles.map(([name, tile]) => {
  const grid = toGrid(tile);
  validate(name, grid);
  return grid;
});

const rowsOfTiles = Math.ceil(grids.length / COLUMNS);
const width = COLUMNS * S;
const height = rowsOfTiles * S;
const rgba = Buffer.alloc(width * height * 4);
grids.forEach((grid, i) => {
  const tx = (i % COLUMNS) * S;
  const ty = Math.floor(i / COLUMNS) * S;
  grid.forEach((r, y) =>
    r.forEach((c, x) => {
      const o = ((ty + y) * width + tx + x) * 4;
      const [cr, cg, cb] = c ?? [0, 0, 0];
      rgba[o] = cr;
      rgba[o + 1] = cg;
      rgba[o + 2] = cb;
      rgba[o + 3] = 255;
    }),
  );
});

function png(w, h, data) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const tb = Buffer.concat([Buffer.from(type), body]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(tb));
    return Buffer.concat([len, tb, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    data.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const outDir = new URL("../public/assets/original/", import.meta.url);
await mkdir(outDir, { recursive: true });
await writeFile(new URL("tiles.png", outDir), png(width, height, rgba));
console.log(`Wrote public/assets/original/tiles.png (${width}×${height}, ${tiles.length} tiles)`);
