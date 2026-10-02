import type { CustomLayerInterface, Map as MapboxGLMap } from "mapbox-gl";
import type { TileFrame } from "../../world/tileResolver";
import { alignToCenter } from "../../world/tileGrid";
import type { SpriteAtlas } from "../SpriteAtlas";
import { creatureInstances, glyphInstances, gridMatrix, hasAnimatedTiles, labelBandInstances, RECT_STRIDE, snapToPixels, SPRITE_STRIDE, tileInstances, type AtlasInfo } from "./instances";

/**
 * Draws the tile frame inside Mapbox's own WebGL frame as a custom layer, so
 * tiles move and scale with the map on every frame (pan/zoom stay smooth and
 * aligned) instead of a CSS-transformed canvas that only catches up on idle.
 *
 * Each grid cell is one instanced quad sampling the atlas with NEAREST
 * filtering (crisp pixels at any zoom). Place names are drawn on top: a
 * translucent band per name, then letters from the black-keyed atlas.
 *
 * Water scrolls like in classic 8-bit RPGs: the tile's rows are shifted down one step
 * (1/16 of the tile, one display pixel) every WAVE_STEP_MS and wrap around
 * inside the tile, so every water cell (deep, medium and shallow) moves together.
 */

export type GlViewMode = "tiles" | "overlay" | "split" | "mapbox";

export interface GlTileLayerOptions {
  viewMode: GlViewMode;
  /** Tile opacity in the Overlay view. */
  overlayOpacity: number;
  showGridLines: boolean;
  /** Animate tiles: scrolling water and fluttering flags. */
  animate: boolean;
}

const LABEL_BAND_ALPHA = 0.6;
/** Milliseconds per one-row step of the water scroll (chosen by eye). */
const WAVE_STEP_MS = 200;
/** Milliseconds per flag flutter frame (a multiple of WAVE_STEP_MS, so one repaint timer serves both). */
const FLAG_STEP_MS = 400;
/** Rows per tile the scroll steps through (16 = one pixel of a 16 px cell). */
const WAVE_ROWS = 16;
/** Padding of the band on each side of a name, in cells (3 px of a 16 px cell). */
const LABEL_PAD_CELLS = 3 / 16;

const SPRITE_VS = `#version 300 es
in vec2 a_corner;
in vec2 a_cell;
in vec4 a_uv;
in float a_scroll;
in vec4 a_flag;
uniform mat4 u_matrix;
out vec2 v_local;
flat out vec4 v_rect;
flat out float v_scroll;
flat out vec4 v_flag;
void main() {
  v_local = a_corner;
  v_rect = a_uv;
  v_scroll = a_scroll;
  v_flag = a_flag;
  gl_Position = u_matrix * vec4(a_cell + a_corner, 0.0, 1.0);
}`;

const SPRITE_FS = `#version 300 es
precision mediump float;
in vec2 v_local;
flat in vec4 v_rect;
flat in float v_scroll;
flat in vec4 v_flag;
uniform sampler2D u_atlas;
uniform float u_flagFrame; // 0 or 1 while animating; -1 when off
uniform float u_wave; // scroll offset as a fraction of the tile height
uniform float u_opacity;
uniform float u_gridLines;
out vec4 fragColor;
void main() {
  vec2 local = v_local;
  // Scrolling tiles: shift the rows down and wrap inside the tile.
  if (v_scroll > 0.5) local.y = fract(local.y - u_wave);
  // Flags flutter: every other display row of the flag is pulled one pixel
  // toward its free end (right), alternating each frame, so the flag's edge
  // ripples. The column just past the flag is included so the edge can grow;
  // samples never leave the flag rectangle, so the pole and building stay put.
  float px = 1.0 / 16.0;
  if (u_flagFrame >= 0.0 && v_flag.z > v_flag.x &&
      local.x >= v_flag.x && local.x < v_flag.z + px && local.y >= v_flag.y && local.y < v_flag.w) {
    float row = floor(local.y * 16.0);
    if (mod(row + u_flagFrame, 2.0) < 1.0) local.x = clamp(local.x - px, v_flag.x, v_flag.z - 0.001);
  }
  vec4 c = texture(u_atlas, mix(v_rect.xy, v_rect.zw, local));
  if (u_gridLines > 0.5) {
    vec2 w = fwidth(v_local);
    // One screen pixel along the top/left edge of each cell, grey so it shows on black too.
    if (v_local.x < w.x || v_local.y < w.y) c.rgb = mix(c.rgb, vec3(0.5), 0.6);
  }
  // Mapbox blends premultiplied alpha.
  fragColor = vec4(c.rgb * c.a, c.a) * u_opacity;
}`;

const RECT_VS = `#version 300 es
in vec2 a_corner;
in vec4 a_rect;
uniform mat4 u_matrix;
void main() {
  gl_Position = u_matrix * vec4(a_rect.xy + a_corner * a_rect.zw, 0.0, 1.0);
}`;

const RECT_FS = `#version 300 es
precision mediump float;
uniform vec4 u_color;
out vec4 fragColor;
void main() {
  fragColor = vec4(u_color.rgb * u_color.a, u_color.a);
}`;

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
/** A rectangle covering clip space, for the black background of the Tiles view. */
const FULLSCREEN = new Float32Array([-1, -1, 2, 2]);

interface Batch {
  vao: WebGLVertexArrayObject;
  buffer: WebGLBuffer;
  count: number;
}

export class GlTileLayer implements CustomLayerInterface {
  readonly id = "rpg-tiles";
  readonly type = "custom" as const;
  readonly renderingMode = "2d" as const;

  options: GlTileLayerOptions = { viewMode: "tiles", overlayOpacity: 0.5, showGridLines: false, animate: true };

  private map: MapboxGLMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private spriteProgram: WebGLProgram | null = null;
  private rectProgram: WebGLProgram | null = null;
  private corner: WebGLBuffer | null = null;
  private tiles: Batch | null = null;
  private glyphs: Batch | null = null;
  private creatures: Batch | null = null;
  private creatureSprites: { x: number; y: number; tile: number }[] = [];
  private creaturesDirty = false;
  private bands: Batch | null = null;
  private background: Batch | null = null;
  private atlasTexture: WebGLTexture | null = null;
  private keyedTexture: WebGLTexture | null = null;
  private atlas: AtlasInfo | null = null;
  private atlasSource: SpriteAtlas | null = null;
  private frame: TileFrame | null = null;
  private dirty = false;

  onAdd(map: MapboxGLMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    this.gl = gl;
    this.spriteProgram = program(gl, SPRITE_VS, SPRITE_FS);
    this.rectProgram = program(gl, RECT_VS, RECT_FS);
    this.corner = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.corner);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    this.tiles = this.batch(this.spriteProgram, "sprite");
    this.glyphs = this.batch(this.spriteProgram, "sprite");
    this.creatures = this.batch(this.spriteProgram, "sprite");
    this.bands = this.batch(this.rectProgram, "rect");
    this.background = this.batch(this.rectProgram, "rect");
    this.upload(this.background, FULLSCREEN, RECT_STRIDE);
    if (this.atlasSource) this.setAtlas(this.atlasSource, this.atlas!.mapping, this.atlas!.glyphs, this.atlas!.flags);
    this.dirty = true;
    this.updateAnimation();
  }

  onRemove(_map: MapboxGLMap, gl: WebGL2RenderingContext): void {
    if (this.waveTimer) clearInterval(this.waveTimer);
    this.waveTimer = null;
    for (const b of [this.tiles, this.glyphs, this.creatures, this.bands, this.background]) {
      if (!b) continue;
      gl.deleteVertexArray(b.vao);
      gl.deleteBuffer(b.buffer);
    }
    gl.deleteBuffer(this.corner);
    gl.deleteTexture(this.atlasTexture);
    gl.deleteTexture(this.keyedTexture);
    gl.deleteProgram(this.spriteProgram);
    gl.deleteProgram(this.rectProgram);
    this.gl = null;
    this.map = null;
  }

  /** Uses a (possibly different) atlas; can be called before the layer is added. */
  setAtlas(atlas: SpriteAtlas, mapping: AtlasInfo["mapping"], glyphs: AtlasInfo["glyphs"], flags?: AtlasInfo["flags"]): void {
    const img = atlas.image;
    this.atlasSource = atlas;
    this.atlas = { layout: atlas.layout, blankTileId: atlas.blankTileId, width: img.width, height: img.height, mapping, glyphs, flags };
    const gl = this.gl;
    if (gl) {
      gl.deleteTexture(this.atlasTexture);
      gl.deleteTexture(this.keyedTexture);
      this.atlasTexture = texture(gl, img);
      this.keyedTexture = texture(gl, atlas.keyedImage as HTMLCanvasElement);
    }
    this.dirty = true;
    this.map?.triggerRepaint();
  }

  setFrame(frame: TileFrame): void {
    this.frame = frame;
    this.dirty = true;
    this.updateAnimation();
    this.map?.triggerRepaint();
  }

  private waveTimer: ReturnType<typeof setInterval> | null = null;

  /** Repaints the map every WAVE_STEP_MS while water is on screen (Mapbox only redraws on demand). */
  private updateAnimation(): void {
    const animate = this.options.animate && !!this.map && !!this.frame && this.options.viewMode !== "mapbox" && hasAnimatedTiles(this.frame, this.atlas?.flags);
    if (animate && !this.waveTimer) this.waveTimer = setInterval(() => this.map?.triggerRepaint(), WAVE_STEP_MS);
    if (!animate && this.waveTimer) {
      clearInterval(this.waveTimer);
      this.waveTimer = null;
    }
  }

  /** Creatures and fireballs to draw over the tiles, in grid cells of the current frame. */
  setCreatures(sprites: { x: number; y: number; tile: number }[]): void {
    this.creatureSprites = sprites;
    this.creaturesDirty = true;
    this.map?.triggerRepaint();
  }

  setOptions(options: Partial<GlTileLayerOptions>): void {
    this.options = { ...this.options, ...options };
    this.updateAnimation();
    this.map?.triggerRepaint();
  }

  render(gl: WebGL2RenderingContext, matrix: number[]): void {
    const { viewMode, overlayOpacity, showGridLines } = this.options;
    if (viewMode === "mapbox" || !this.frame || !this.atlas || !this.atlasTexture) return;
    if (this.dirty) this.rebuild();
    if (this.creaturesDirty) {
      this.upload(this.creatures!, creatureInstances(this.creatureSprites, this.atlas), SPRITE_STRIDE);
      this.creaturesDirty = false;
    }

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.CULL_FACE);
    if (viewMode === "split") {
      // Right half of the screen shows tiles, the left half the map.
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(Math.floor(gl.drawingBufferWidth / 2), 0, Math.ceil(gl.drawingBufferWidth / 2), gl.drawingBufferHeight);
    }

    // Follow the camera into the world copy it wrapped to (antimeridian), until the next rebuild.
    const spec = this.map ? alignToCenter(this.frame.spec, this.map.getCenter()) : this.frame.spec;
    const m = snapToPixels(gridMatrix(matrix, spec), gl.drawingBufferWidth, gl.drawingBufferHeight);
    const opacity = viewMode === "overlay" ? overlayOpacity : 1;

    const rect = this.rectProgram!;
    gl.useProgram(rect);
    if (viewMode === "tiles" || viewMode === "split") {
      // Hide the base map, so areas revealed before the next rebuild are black
      // (in Split, the scissor limits this to the tile half of the screen).
      gl.uniformMatrix4fv(gl.getUniformLocation(rect, "u_matrix"), false, IDENTITY);
      gl.uniform4f(gl.getUniformLocation(rect, "u_color"), 0, 0, 0, 1);
      this.draw(this.background!);
    }

    const sprite = this.spriteProgram!;
    gl.useProgram(sprite);
    gl.uniformMatrix4fv(gl.getUniformLocation(sprite, "u_matrix"), false, m);
    gl.uniform1f(gl.getUniformLocation(sprite, "u_opacity"), opacity);
    gl.uniform1f(gl.getUniformLocation(sprite, "u_gridLines"), showGridLines ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(sprite, "u_atlas"), 0);
    const now = performance.now();
    const step = this.options.animate ? Math.floor(now / WAVE_STEP_MS) : 0;
    gl.uniform1f(gl.getUniformLocation(sprite, "u_wave"), (step % WAVE_ROWS) / WAVE_ROWS);
    gl.uniform1f(gl.getUniformLocation(sprite, "u_flagFrame"), this.options.animate ? Math.floor(now / FLAG_STEP_MS) % 2 : -1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTexture);
    this.draw(this.tiles!);

    // Creatures: black keyed out, so the terrain shows around them.
    if (this.creatures!.count) {
      gl.uniform1f(gl.getUniformLocation(sprite, "u_gridLines"), 0);
      gl.bindTexture(gl.TEXTURE_2D, this.keyedTexture);
      this.draw(this.creatures!);
      gl.bindTexture(gl.TEXTURE_2D, this.atlasTexture);
    }

    if (this.glyphs!.count) {
      gl.useProgram(rect);
      gl.uniformMatrix4fv(gl.getUniformLocation(rect, "u_matrix"), false, m);
      gl.uniform4f(gl.getUniformLocation(rect, "u_color"), 0, 0, 0, LABEL_BAND_ALPHA * opacity);
      this.draw(this.bands!);

      gl.useProgram(sprite);
      gl.uniform1f(gl.getUniformLocation(sprite, "u_gridLines"), 0);
      gl.bindTexture(gl.TEXTURE_2D, this.keyedTexture);
      this.draw(this.glyphs!);
    }

    gl.bindVertexArray(null);
    gl.disable(gl.SCISSOR_TEST);
  }

  private rebuild(): void {
    this.creaturesDirty = true;
    const frame = this.frame!;
    const atlas = this.atlas!;
    this.upload(this.tiles!, tileInstances(frame, atlas), SPRITE_STRIDE);
    this.upload(this.glyphs!, glyphInstances(frame, atlas), SPRITE_STRIDE);
    this.upload(this.bands!, labelBandInstances(frame, atlas, LABEL_PAD_CELLS), RECT_STRIDE);
    this.dirty = false;
  }

  private batch(prog: WebGLProgram, kind: "sprite" | "rect"): Batch {
    const gl = this.gl!;
    const vao = gl.createVertexArray()!;
    const buffer = gl.createBuffer()!;
    gl.bindVertexArray(vao);
    const corner = gl.getAttribLocation(prog, "a_corner");
    gl.bindBuffer(gl.ARRAY_BUFFER, this.corner);
    gl.enableVertexAttribArray(corner);
    gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    const attrib = (name: string, size: number, offset: number, stride: number) => {
      const loc = gl.getAttribLocation(prog, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride * 4, offset * 4);
      gl.vertexAttribDivisor(loc, 1);
    };
    if (kind === "sprite") {
      attrib("a_cell", 2, 0, SPRITE_STRIDE);
      attrib("a_uv", 4, 2, SPRITE_STRIDE);
      attrib("a_scroll", 1, 6, SPRITE_STRIDE);
      attrib("a_flag", 4, 7, SPRITE_STRIDE);
    } else {
      attrib("a_rect", 4, 0, RECT_STRIDE);
    }
    gl.bindVertexArray(null);
    return { vao, buffer, count: 0 };
  }

  private upload(b: Batch, data: Float32Array, stride: number): void {
    const gl = this.gl!;
    gl.bindBuffer(gl.ARRAY_BUFFER, b.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    b.count = data.length / stride;
  }

  private draw(b: Batch): void {
    if (!b.count) return;
    const gl = this.gl!;
    gl.bindVertexArray(b.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, b.count);
  }
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`Shader error: ${gl.getShaderInfoLog(s)}`);
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Program error: ${gl.getProgramInfoLog(p)}`);
  return p;
}

function texture(gl: WebGL2RenderingContext, image: TexImageSource): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  // Crisp pixel art at any zoom: nearest-neighbour, no mipmaps.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}
