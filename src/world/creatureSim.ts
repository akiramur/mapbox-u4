import type { CreatureMove, CreatureSet, GateDef } from "../config/tileMappings";
import type { TileId } from "../renderer/SpriteAtlas";
import { getGameLOD } from "./gameLOD";
import { cellAtLngLat, cellCenterLngLat } from "./tileGrid";
import type { TileFrame } from "./tileResolver";
import { TerrainType } from "./TerrainType";

/**
 * Wandering creatures, drawn over the tiles (a visual layer: no player, no
 * combat). Classic overworld rules, per "turn":
 *
 * - Spawning: for every 11×11-cell screenful of the grid, a creature appears
 *   with probability 1/32, while there is less than 1 per screenful and
 *   fewer than MAX_TOTAL in all (the classic cap is 4 around the player; over
 *   a whole map view that is too crowded, the more so on a large window). It
 *   appears on a random cell; the kind of terrain there picks the spawn table
 *   (deep water, shallow water or land) of the tile set.
 * - Movement: every creature tries one step in a random direction onto
 *   terrain it can use (sail / swim / walk / fly) and not onto another creature.
 * - Fire: fire-breathing creatures sometimes shoot a fireball that flies a
 *   few cells in a straight line.
 * - Creatures leaving the grid are removed, and every creature leaves after
 *   a random lifetime (1–2 minutes), so they come and go instead of piling up.
 * - Warp gate: one at a time, on a random open-land cell. It rises through
 *   its opening frames, stays open, sinks back and then appears elsewhere;
 *   one cycle lasts GATE_TICKS (12 s). Creatures avoid it.
 *
 * - High zoom (LOCAL, town interiors): the same rules, but townsfolk
 *   ("town" movers, from the tile set's "town" spawn table) walk on town
 *   ground instead, and there are no monsters and no gate. Zooming across
 *   z15 removes whoever does not belong.
 *
 * Positions are kept as lng/lat, so creatures stay put on the map while
 * panning and keep their place when the grid is rebuilt at another zoom.
 */

export const SCREEN_CELLS = 11 * 11;
export const MAX_PER_SCREEN = 1;
/** Cap for the whole grid, whatever the window size. */
export const MAX_TOTAL = 12;
export const SPAWN_CHANCE = 1 / 32;
export const FIRE_CHANCE = 1 / 4;
export const FIREBALL_RANGE = 3;
/** A creature lives LIFETIME_MIN_TURNS + random(LIFETIME_EXTRA_TURNS) turns (a turn is 1 s). */
export const LIFETIME_MIN_TURNS = 60;
export const LIFETIME_EXTRA_TURNS = 60;
/** Ticks (200 ms) per warp gate cycle: 12 s. */
export const GATE_TICKS = 60;

export interface Gate {
  lng: number;
  lat: number;
  age: number;
}

export interface Creature {
  uid: number;
  id: string;
  lng: number;
  lat: number;
  /** Offset into the animation frames, so creatures do not all move in step. */
  phase: number;
  /** Turns left before it leaves. */
  life: number;
}

export interface Fireball {
  lng: number;
  lat: number;
  dx: number;
  dy: number;
  left: number;
}

/** A sprite to draw: grid cell and tile id. */
export interface CreatureSprite {
  x: number;
  y: number;
  tile: TileId;
}

const WATER_SAIL = new Set([TerrainType.DeepWater, TerrainType.Water]);
const WATER_SWIM = new Set([TerrainType.DeepWater, TerrainType.Water, TerrainType.ShallowWater]);
const OPEN_LAND = new Set([TerrainType.Grass, TerrainType.Scrub, TerrainType.Forest, TerrainType.Park, TerrainType.Hill, TerrainType.Unknown]);
/** Where townsfolk walk at high zoom: floors inside buildings, streets and open ground (not walls or water). */
const TOWN_GROUND = new Set([
  TerrainType.Floor, TerrainType.Road, TerrainType.MinorRoad, TerrainType.Grass, TerrainType.Scrub, TerrainType.Park, TerrainType.Unknown,
]);

/** High zoom (town interiors): townsfolk instead of monsters. */
export function isTownFrame(frame: TileFrame): boolean {
  return getGameLOD(frame.spec.zoom) === "LOCAL";
}

export function canUse(moves: CreatureMove, t: TerrainType): boolean {
  switch (moves) {
    case "sail":
      return WATER_SAIL.has(t);
    case "swim":
      return WATER_SWIM.has(t);
    case "walk":
      return OPEN_LAND.has(t);
    case "fly":
      return OPEN_LAND.has(t) || WATER_SWIM.has(t) || t === TerrainType.Mountain;
    case "town":
      return TOWN_GROUND.has(t);
  }
}

/** Which spawn table a cell's terrain uses, if any (`town`: at high zoom). */
export function spawnTableFor(t: TerrainType, town = false): "deep" | "shallow" | "land" | "town" | null {
  if (town) return TOWN_GROUND.has(t) ? "town" : null;
  if (WATER_SAIL.has(t)) return "deep";
  if (t === TerrainType.ShallowWater) return "shallow";
  if (OPEN_LAND.has(t)) return "land";
  return null;
}

export function pickWeighted(table: [string, number][], rng: () => number): string | null {
  const total = table.reduce((a, [, w]) => a + w, 0);
  if (total <= 0) return null;
  let r = rng() * total;
  for (const [id, w] of table) {
    r -= w;
    if (r < 0) return id;
  }
  return table[table.length - 1][0];
}

const DIRS: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

export class CreatureSim {
  creatures: Creature[] = [];
  fireballs: Fireball[] = [];
  gate: Gate | null = null;
  private nextUid = 1;

  constructor(private readonly rng: () => number = Math.random) {}

  clear(): void {
    this.creatures = [];
    this.fireballs = [];
    this.gate = null;
  }

  /** Advances the warp gate one tick: place a new one if none, age it, remove it at the end of its cycle. */
  stepGate(frame: TileFrame): void {
    if (isTownFrame(frame)) {
      this.gate = null;
      return;
    }
    if (this.gate && this.gate.age + 1 >= GATE_TICKS) {
      this.gate = null;
      return;
    }
    if (this.gate) {
      this.gate.age += 1;
      return;
    }
    const { cols, rows } = frame.spec;
    const taken = new Set(this.creatures.map((c) => this.key(frame, c.lng, c.lat)));
    // Not under a name label (the text band, with a cell of margin, is drawn on top).
    for (const l of frame.labels) for (let x = l.x - 1; x <= l.x + l.text.length; x++) taken.add(l.y * cols + x);
    for (let tries = 0; tries < 30; tries++) {
      const i = Math.floor(this.rng() * cols * rows);
      if (taken.has(i) || !OPEN_LAND.has(frame.tiles[i].terrain)) continue;
      const [lng, lat] = cellCenterLngLat(frame.spec, i % cols, Math.floor(i / cols));
      this.gate = { lng, lat, age: 0 };
      return;
    }
  }

  /** Gate tile for its age: rising frames, then open, then the rising frames in reverse. */
  static gateFrame(gate: GateDef, age: number): number {
    const n = gate.frames.length;
    const rise = n - 1;
    if (age < rise) return gate.frames[age];
    if (age >= GATE_TICKS - rise) return gate.frames[Math.max(0, GATE_TICKS - 1 - age)];
    return gate.frames[n - 1];
  }

  /** Removes creatures that are off the grid, on terrain they can no longer use, or on the wrong side of z15. */
  sync(frame: TileFrame, set: CreatureSet | undefined): void {
    const town = isTownFrame(frame);
    this.creatures = this.creatures.filter((c) => {
      const t = this.terrainAt(frame, c.lng, c.lat);
      const def = set?.defs[c.id];
      return t !== null && !!def && (def.moves === "town") === town && canUse(def.moves, t);
    });
    this.fireballs = this.fireballs.filter((f) => this.terrainAt(frame, f.lng, f.lat) !== null);
    if (this.gate) {
      const t = this.terrainAt(frame, this.gate.lng, this.gate.lat);
      if (t === null || !OPEN_LAND.has(t)) this.gate = null;
    }
  }

  /** One game turn: spawn, move, breathe fire. */
  turn(frame: TileFrame, set: CreatureSet): void {
    const { cols, rows } = frame.spec;
    const screens = (cols * rows) / SCREEN_CELLS;
    const cap = Math.min(MAX_TOTAL, Math.round(MAX_PER_SCREEN * screens));

    // Spawning: one 1/32 chance per screenful.
    let chances = screens;
    while (chances > 0 && this.creatures.length < cap) {
      const p = Math.min(1, chances) * SPAWN_CHANCE;
      chances -= 1;
      if (this.rng() >= p) continue;
      this.spawnOne(frame, set);
    }

    // Movement and fire.
    const occupied = new Set(this.creatures.map((c) => this.key(frame, c.lng, c.lat)));
    if (this.gate) occupied.add(this.key(frame, this.gate.lng, this.gate.lat));
    for (const c of this.creatures) {
      const def = set.defs[c.id];
      if (!def) continue;
      const cell = cellAtLngLat(frame.spec, c.lng, c.lat);
      if (!cell) continue;
      const [dx, dy] = DIRS[Math.floor(this.rng() * DIRS.length)];
      const nx = cell.x + dx;
      const ny = cell.y + dy;
      if (nx >= 0 && ny >= 0 && nx < cols && ny < rows) {
        const t = frame.tiles[ny * cols + nx].terrain;
        const k = ny * cols + nx;
        if (canUse(def.moves, t) && !occupied.has(k)) {
          occupied.delete(cell.y * cols + cell.x);
          occupied.add(k);
          [c.lng, c.lat] = cellCenterLngLat(frame.spec, nx, ny);
        }
      }
      if (def.fire && set.fireTile !== undefined && this.rng() < FIRE_CHANCE) {
        const [fx, fy] = DIRS[Math.floor(this.rng() * DIRS.length)];
        this.fireballs.push({ lng: c.lng, lat: c.lat, dx: fx, dy: fy, left: FIREBALL_RANGE });
      }
    }
    // Off-grid creatures are gone (the grid moved away from them), and so are ones whose time is up.
    for (const c of this.creatures) c.life -= 1;
    this.creatures = this.creatures.filter((c) => c.life > 0 && cellAtLngLat(frame.spec, c.lng, c.lat) !== null);
  }

  /** Moves every fireball one cell; they vanish after FIREBALL_RANGE cells or off the grid. */
  stepFireballs(frame: TileFrame): void {
    const next: Fireball[] = [];
    for (const f of this.fireballs) {
      const cell = cellAtLngLat(frame.spec, f.lng, f.lat);
      if (!cell || f.left <= 0) continue;
      const nx = cell.x + f.dx;
      const ny = cell.y + f.dy;
      if (nx < 0 || ny < 0 || nx >= frame.spec.cols || ny >= frame.spec.rows) continue;
      [f.lng, f.lat] = cellCenterLngLat(frame.spec, nx, ny);
      f.left -= 1;
      next.push(f);
    }
    this.fireballs = next;
  }

  /** Sprites to draw at animation tick `tick` (the gate first, under creatures and fireballs). */
  sprites(frame: TileFrame, set: CreatureSet | undefined, tick: number, gate?: GateDef): CreatureSprite[] {
    const out: CreatureSprite[] = [];
    if (this.gate && gate?.frames.length) {
      const cell = cellAtLngLat(frame.spec, this.gate.lng, this.gate.lat);
      if (cell) out.push({ ...cell, tile: CreatureSim.gateFrame(gate, this.gate.age) });
    }
    if (!set) return out;
    for (const c of this.creatures) {
      const def = set.defs[c.id];
      const cell = cellAtLngLat(frame.spec, c.lng, c.lat);
      if (!def || !cell || !def.frames.length) continue;
      out.push({ ...cell, tile: def.frames[(tick + c.phase) % def.frames.length] });
    }
    if (set.fireTile !== undefined) {
      for (const f of this.fireballs) {
        const cell = cellAtLngLat(frame.spec, f.lng, f.lat);
        if (cell) out.push({ ...cell, tile: set.fireTile });
      }
    }
    return out;
  }

  private spawnOne(frame: TileFrame, set: CreatureSet): void {
    const { cols, rows } = frame.spec;
    const i = Math.floor(this.rng() * cols * rows);
    const t = frame.tiles[i].terrain;
    const table = spawnTableFor(t, isTownFrame(frame));
    if (!table) return;
    const id = pickWeighted(set.spawn[table] ?? [], this.rng);
    const def = id ? set.defs[id] : undefined;
    if (!id || !def || !canUse(def.moves, t)) return;
    const x = i % cols;
    const y = Math.floor(i / cols);
    if (this.creatures.some((c) => this.key(frame, c.lng, c.lat) === i)) return;
    if (this.gate && this.key(frame, this.gate.lng, this.gate.lat) === i) return;
    const [lng, lat] = cellCenterLngLat(frame.spec, x, y);
    const life = LIFETIME_MIN_TURNS + Math.floor(this.rng() * LIFETIME_EXTRA_TURNS);
    this.creatures.push({ uid: this.nextUid++, id, lng, lat, phase: Math.floor(this.rng() * 4), life });
  }

  private terrainAt(frame: TileFrame, lng: number, lat: number): TerrainType | null {
    const cell = cellAtLngLat(frame.spec, lng, lat);
    return cell ? frame.tiles[cell.y * frame.spec.cols + cell.x].terrain : null;
  }

  private key(frame: TileFrame, lng: number, lat: number): number {
    const cell = cellAtLngLat(frame.spec, lng, lat);
    return cell ? cell.y * frame.spec.cols + cell.x : -1;
  }
}
