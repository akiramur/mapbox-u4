import { describe, expect, it } from "vitest";
import { ORIGINAL_CREATURES, ORIGINAL_GATE } from "../config/tileMappings";
import { makeSpec } from "../test/helpers";
import { CreatureSim, canUse, pickWeighted, spawnTableFor, SCREEN_CELLS, MAX_PER_SCREEN, GATE_TICKS, MAX_TOTAL, LIFETIME_MIN_TURNS, LIFETIME_EXTRA_TURNS } from "./creatureSim";
import { cellAtLngLat, cellCenterLngLat } from "./tileGrid";
import type { TileFrame } from "./tileResolver";
import { TerrainType } from "./TerrainType";

const T = TerrainType;

/** Seeded pseudo-random numbers (mulberry32), so tests are repeatable. */
function rng(seed = 1) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A frame whose left half is deep water and right half grassland, with a mountain column. */
function frame(cols = 44, rows = 22): TileFrame {
  const spec = makeSpec(cols, rows, 10);
  const tiles = Array.from({ length: cols * rows }, (_, i) => {
    const x = i % cols;
    return { terrain: x === 30 ? T.Mountain : x < cols / 2 ? T.DeepWater : T.Grass };
  });
  return { spec, tiles, labels: [] };
}

describe("terrain rules", () => {
  it("lets each kind of creature use only its terrain", () => {
    expect(canUse("sail", T.DeepWater)).toBe(true);
    expect(canUse("sail", T.ShallowWater)).toBe(false);
    expect(canUse("swim", T.ShallowWater)).toBe(true);
    expect(canUse("walk", T.Grass)).toBe(true);
    expect(canUse("walk", T.Mountain)).toBe(false);
    expect(canUse("walk", T.Building)).toBe(false);
    expect(canUse("fly", T.Mountain)).toBe(true);
    expect(canUse("fly", T.Road)).toBe(false);
    expect(spawnTableFor(T.Water)).toBe("deep");
    expect(spawnTableFor(T.ShallowWater)).toBe("shallow");
    expect(spawnTableFor(T.Forest)).toBe("land");
    expect(spawnTableFor(T.Road)).toBeNull();
  });

  it("picks by weight", () => {
    const r = rng(7);
    const counts: Record<string, number> = { common: 0, rare: 0 };
    for (let i = 0; i < 20000; i++) counts[pickWeighted([["common", 81], ["rare", 1]], r)!]++;
    expect(counts.common / counts.rare).toBeGreaterThan(50);
    expect(counts.rare).toBeGreaterThan(0);
  });
});

describe("CreatureSim", () => {
  it("spawns up to the per-screen cap, sea creatures at sea and land creatures on land", () => {
    const f = frame();
    const sim = new CreatureSim(rng(3));
    for (let i = 0; i < 3000; i++) sim.turn(f, ORIGINAL_CREATURES);
    const cap = Math.round((MAX_PER_SCREEN * f.spec.cols * f.spec.rows) / SCREEN_CELLS);
    expect(sim.creatures.length).toBeGreaterThan(0);
    expect(sim.creatures.length).toBeLessThanOrEqual(cap);
    for (const c of sim.creatures) {
      const cell = cellAtLngLat(f.spec, c.lng, c.lat)!;
      const t = f.tiles[cell.y * f.spec.cols + cell.x].terrain;
      expect(canUse(ORIGINAL_CREATURES.defs[c.id].moves, t)).toBe(true);
    }
    // Two creatures never share a cell.
    const keys = sim.creatures.map((c) => JSON.stringify(cellAtLngLat(f.spec, c.lng, c.lat)));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("spawns at roughly 1/32 per screenful per turn", () => {
    const f = frame(); // 968 cells = 8 screens → about 0.25 spawns per turn while under the cap of 8
    const sim = new CreatureSim(rng(11));
    for (let i = 0; i < 16; i++) sim.turn(f, ORIGINAL_CREATURES);
    expect(sim.creatures.length).toBeGreaterThan(0);
    expect(sim.creatures.length).toBeLessThan(10);
  });

  it("lets creatures leave after their lifetime, so they come and go", () => {
    const f = frame();
    const sim = new CreatureSim(rng(4));
    for (let i = 0; i < 60; i++) sim.turn(f, ORIGINAL_CREATURES);
    const first = new Set(sim.creatures.map((c) => c.uid));
    expect(first.size).toBeGreaterThan(0);
    for (let i = 0; i < LIFETIME_MIN_TURNS + LIFETIME_EXTRA_TURNS; i++) sim.turn(f, ORIGINAL_CREATURES);
    expect(sim.creatures.some((c) => first.has(c.uid))).toBe(false);
    expect(sim.creatures.length).toBeGreaterThan(0); // new ones came
  });

  it("caps the total on a large grid, whatever its size", () => {
    const f = frame(160, 90); // 119 screenfuls
    const sim = new CreatureSim(rng(6));
    for (let i = 0; i < 300; i++) {
      sim.turn(f, ORIGINAL_CREATURES);
      expect(sim.creatures.length).toBeLessThanOrEqual(MAX_TOTAL);
    }
    expect(sim.creatures.length).toBeGreaterThan(MAX_TOTAL / 2);
  });

  it("moves creatures and removes ones that end up off the grid", () => {
    const f = frame();
    const sim = new CreatureSim(rng(5));
    for (let i = 0; i < 400; i++) sim.turn(f, ORIGINAL_CREATURES);
    const before = sim.creatures.map((c) => [c.lng, c.lat].join());
    sim.turn(f, ORIGINAL_CREATURES);
    const moved = sim.creatures.filter((c, i) => before[i] !== undefined && before[i] !== [c.lng, c.lat].join()).length;
    expect(moved).toBeGreaterThan(0);
    // A grid somewhere else: every creature is gone after sync.
    const elsewhere = { ...f, spec: { ...f.spec, originX: f.spec.originX + 100000 } };
    sim.sync(elsewhere, ORIGINAL_CREATURES);
    expect(sim.creatures).toHaveLength(0);
  });

  it("lets fire breathers shoot fireballs that fly a few cells and vanish", () => {
    const f = frame();
    const sim = new CreatureSim(rng(2));
    // Place a dragon on land, and turn spawning off.
    const [lng, lat] = cellCenterLngLat(f.spec, 26, 10);
    sim.creatures.push({ uid: 1, id: "dragon", lng, lat, phase: 0, life: 100 });
    const noSpawn = { ...ORIGINAL_CREATURES, spawn: { deep: [], shallow: [], land: [] } };
    for (let i = 0; i < 40 && !sim.fireballs.length; i++) sim.turn(f, noSpawn);
    expect(sim.fireballs.length).toBeGreaterThan(0);
    for (let i = 0; i < 10; i++) sim.stepFireballs(f);
    expect(sim.fireballs).toHaveLength(0);
    const sprites = sim.sprites(f, ORIGINAL_CREATURES, 3);
    expect(sprites.some((s) => ORIGINAL_CREATURES.defs.dragon.frames.includes(s.tile))).toBe(true);
  });

  it("opens one warp gate on open land, rises, stays open, sinks and moves on", () => {
    const f = frame();
    const sim = new CreatureSim(rng(5));
    const [first, second, third, open] = ORIGINAL_GATE.frames;
    const seen: number[] = [];
    sim.stepGate(f);
    const gate = sim.gate!;
    expect(gate).not.toBeNull();
    const cell = cellAtLngLat(f.spec, gate.lng, gate.lat)!;
    expect(f.tiles[cell.y * f.spec.cols + cell.x].terrain).toBe(T.Grass);
    for (let i = 0; i < GATE_TICKS; i++) {
      const sprites = sim.sprites(f, undefined, 0, ORIGINAL_GATE);
      expect(sprites).toHaveLength(1);
      seen.push(sprites[0].tile);
      sim.stepGate(f);
    }
    expect(seen.slice(0, 4)).toEqual([first, second, third, open]);
    expect(seen.slice(-4)).toEqual([open, third, second, first]);
    expect(seen.filter((t) => t === open)).toHaveLength(GATE_TICKS - 6);
    expect(sim.gate).toBeNull(); // gone; the next tick places a new one
    sim.stepGate(f);
    expect(sim.gate).not.toBeNull();
  });

  it("does not open a gate under a name label", () => {
    const f = frame();
    const labels = Array.from({ length: f.spec.rows }, (_, y) => ({ x: 22, y, text: y === 5 ? "A" : "ABCDEFGHIJKLMNOPQRSTU" }));
    for (let seed = 1; seed < 40; seed++) {
      const sim = new CreatureSim(rng(seed));
      sim.stepGate({ ...f, labels });
      if (sim.gate) expect(cellAtLngLat(f.spec, sim.gate.lng, sim.gate.lat)!.y).toBe(5);
    }
  });

  it("keeps creatures off the gate and drops a gate whose cell is no longer open land", () => {
    const f = frame();
    const sim = new CreatureSim(rng(9));
    sim.stepGate(f);
    const g = cellAtLngLat(f.spec, sim.gate!.lng, sim.gate!.lat)!;
    for (let i = 0; i < 200; i++) {
      sim.turn(f, ORIGINAL_CREATURES);
      for (const c of sim.creatures) expect(cellAtLngLat(f.spec, c.lng, c.lat)).not.toEqual(g);
    }
    const tiles = f.tiles.map((t, i) => (i === g.y * f.spec.cols + g.x ? { ...t, terrain: T.Building } : t));
    sim.sync({ ...f, tiles }, ORIGINAL_CREATURES);
    expect(sim.gate).toBeNull();
  });

  it("at high zoom, has townsfolk on town ground instead of monsters, and no gate", () => {
    // Columns: 0–9 water, 10 wall, 11–20 floor, 21–31 road, 32–43 grass.
    const cols = 44;
    const rows = 22;
    const spec = makeSpec(cols, rows, 16);
    const terrainAt = (x: number) => (x < 10 ? T.Water : x === 10 ? T.Wall : x <= 20 ? T.Floor : x <= 31 ? T.Road : T.Grass);
    const f: TileFrame = { spec, tiles: Array.from({ length: cols * rows }, (_, i) => ({ terrain: terrainAt(i % cols) })), labels: [] };
    const sim = new CreatureSim(rng(8));
    for (let i = 0; i < 200; i++) {
      sim.turn(f, ORIGINAL_CREATURES);
      sim.stepGate(f);
    }
    expect(sim.gate).toBeNull();
    expect(sim.creatures.length).toBeGreaterThan(0);
    for (const c of sim.creatures) {
      expect(ORIGINAL_CREATURES.defs[c.id].moves).toBe("town");
      expect(cellAtLngLat(spec, c.lng, c.lat)!.x).toBeGreaterThan(10); // not in water or walls
    }
    // Zooming out below z15 sends the townsfolk away.
    const lower = { ...f, spec: { ...spec, zoom: 14.5 } };
    sim.sync(lower, ORIGINAL_CREATURES);
    expect(sim.creatures).toHaveLength(0);
  });

  it("below z15 never spawns townsfolk, and zooming in sends monsters away", () => {
    const f = frame();
    const sim = new CreatureSim(rng(12));
    for (let i = 0; i < 300; i++) sim.turn(f, ORIGINAL_CREATURES);
    expect(sim.creatures.length).toBeGreaterThan(0);
    for (const c of sim.creatures) expect(ORIGINAL_CREATURES.defs[c.id].moves).not.toBe("town");
    sim.sync({ ...f, spec: { ...f.spec, zoom: 15 } }, ORIGINAL_CREATURES);
    expect(sim.creatures).toHaveLength(0);
  });
});
