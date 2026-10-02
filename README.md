# Mapbox 8-bit RPG Tile Map POC

A proof-of-concept that turns real-world Mapbox vector data into a classic 8-bit RPG-style
overworld map made of 16×16 pixel tiles, using fixed deterministic rules.

> Can real-world Mapbox geography be deterministically transformed into a convincing 8-bit RPG tile world?

This is not a game. There is no player, NPCs, combat or pathfinding. The POC only
tests the conversion and rendering architecture.

## Setup

```sh
npm install
cp .env.example .env.local        # then set VITE_MAPBOX_ACCESS_TOKEN
npm run dev
```

### `VITE_MAPBOX_ACCESS_TOKEN`

1. Create or copy a **public** token (`pk.…`) at <https://account.mapbox.com/access-tokens/>.
   The default public scopes are enough.
2. Put it in `.env.local`, which is git-ignored:
   ```
   VITE_MAPBOX_ACCESS_TOKEN=pk.xxxxxxxx
   ```
   You can also pass it inline: `VITE_MAPBOX_ACCESS_TOKEN=pk.xxx npm run dev`.
3. Restart `npm run dev` after changing it. Vite reads env files only at startup.

If the token is missing, the app shows an error message and does not render a map.

### Other settings

The map position is kept in the URL hash (`#zoom/lat/lng`), so test locations can be shared:

- Imperial Palace, Tokyo (default): `#15/35.6852/139.7528`
- Tokyo Bay: `#15/35.615/139.785`
- Osaka Castle: `#15/34.6873/135.5262`
- Central Park, NYC: `#15/40.7736/-73.9712`

## Testing

```sh
npm test                  # unit tests (vitest), no network
npm run snapshot          # regression check against snapshots/baseline.json
npm run snapshot:update   # accept the current result as the new baseline
```

**Unit tests** (`src/**/*.test.ts`, helpers in `src/test/helpers.ts`) feed synthetic
features, written in cell coordinates, into the pipeline. No map is needed. They cover:

- projection and world-anchored cell indices;
- scanline rasterization: full and partial coverage, holes, duplicates across tiles;
- line and point rasterization;
- the narrow-water rule;
- road thinning;
- terrain priorities and per-LOD thresholds;
- per-zoom road, relief and settlement rules;
- transition tiles;
- town interiors;
- village spacing (distance, density and pan stability);
- area overrides.

**Snapshot check** (`scripts/snapshot.mjs`):

- **What it does**: starts a Vite dev server and opens each location in `snapshots/locations.json` in headless Chromium. That is 34 places from z0.6 to z17: Japan, New York, other regions, and two views across the antimeridian. For each one it waits until the map is idle and the grid stops changing, then reads the number of cells per terrain from `window.__tileStats`.
- **Pass/fail**: it compares those counts with `snapshots/baseline.json` and fails when any terrain moves by more than 40 cells, or when the LOD differs. The snapshot viewport is 1100×1100 px, about 4,800 cells.
- **Output**: screenshots are written to `snapshots/out/`, which is git-ignored. A full run takes about a minute.
- `--only=<text>` runs only the locations whose name contains `<text>`.
- **Requirements**: a Mapbox token (`VITE_MAPBOX_ACCESS_TOKEN` or `MAPBOX_ACCESS_TOKEN`) and a Chromium for Playwright. If none is installed, run `npx playwright-core install chromium`.
- **Why a tolerance**: Mapbox's data changes over time, so the baseline will drift. After an intentional rule change, or once the data has changed, check the screenshots and run `npm run snapshot:update`.
- **Token safety**: the script loads each location as a fresh page, turns off Vite's browser-console forwarding and redacts the token from page errors. Mapbox request URLs carry the token, so none of it is echoed.

## Architecture

The code is a one-way pipeline: Mapbox data → logical terrain grid → tile images. Each stage
has one job and only passes on what the next stage needs. Data sources, classification rules,
tile artwork and the renderer can therefore be replaced independently. The classifier never
sees tile images, and the renderer never sees Mapbox features.

```text
Mapbox GL JS            camera, pan/zoom, vector tile loading
  │   sources: composite (streets-v12), streets-z12 (maxzoom 12), streets-places-z9 (maxzoom 9)
  ▼
Feature extraction      src/map/featureExtractor.ts
  │   loaded features → normalized GeoFeature (layer, class, type, props, geometry)
  ▼
Logical grid            src/world/tileGrid.ts
  │   world-anchored cells covering the viewport; features rasterized per cell
  │   (3×3 sample coverage, lines, points, contour elevation → relief)
  │   rules: src/world/terrainClassifier.ts  (feature → terrain, per-zoom/LOD rules,
  │          priorities and thresholds, road thinning, deep water)
  ▼
Visual transforms       src/world/transitions.ts   coast / foothill / forest-edge transitions
                        src/world/interiors.ts     buildings → walls and floors (z15+)
  ▼
Tile resolver           src/world/tileResolver.ts  overrides, village spacing
  │                     src/world/urbanDensity.ts  denser villages near city centres
  │                     src/world/labels.ts        country / city name placement
  ▼  TileFrame = grid geometry + one resolved tile per cell + placed names
Tile sets               src/config/tileMappings.ts   TerrainType → tile id, per tile set
                        src/config/customTilesets.ts bring-your-own tile sets (tilesets/)
                        src/renderer/SpriteAtlas.ts  atlas image, tile rectangles, black tile
  ▼
Renderer                src/renderer/webgl/GlTileLayer.ts  WebGL Mapbox custom layer (default)
                        src/renderer/TileRenderer.ts       Canvas 2D overlay (fallback)
```

`src/App.tsx` orchestrates the pipeline. It decides when to rebuild the grid (on `idle`, and
at intervals while the camera moves), runs the stages in order, and hands the `TileFrame` to
the renderer. It also runs the debug panel and the inspector.

Each stage:

- **Mapbox GL JS** owns geographic coordinates, the camera, interaction and tile loading. Two extra sources, capped at z12 and z9, keep data that higher-zoom tiles drop:
  - the generalized urban polygons;
  - one fixed point per city.
- **`featureExtractor`** reads features with `querySourceFeatures`, independent of the style's appearance.
- **`tileGrid`** builds the grid for the viewport and rasterizes every feature onto it. Its steps:
  - It uses the rules in **`terrainClassifier`** to know what each feature means, and to pick one terrain per cell.
  - It then applies the post-processing steps, the transitions and (at LOCAL) the interiors.
  - The grid is anchored to world coordinates, so panning never moves cell boundaries. Features are placed in every world copy on the grid.
- **`gameLOD`** maps zoom to WORLD / REGION / TOWN / LOCAL. `LOD_RULES` in `terrainClassifier` switches rules per LOD.
- **`tileResolver`** applies location rules and returns the `TileFrame`:
  - point overrides such as a castle or a town;
  - Urban cells turned into scattered villages;
  - place names from `labels`.
- **Tile sets** map logical terrains to atlas tiles. The built-in CC0 set is generated by `scripts/make-original-atlas.mjs`. Local sets are read from `tilesets/<folder>/tileset.json`; `examples/tilesets/` holds a ready-made one.
- **Renderers** draw a `TileFrame`. The WebGL layer is drawn inside Mapbox's frame, so tiles follow the map during pan and zoom. It also handles the view modes, scrolling water, name bands, grid lines and pixel snapping.

Files:

| File | Role |
|---|---|
| `src/main.tsx`, `src/App.tsx`, `src/styles.css` | Entry point, orchestration, debug panel |
| `src/map/MapboxMap.tsx` | Map setup (Mercator; rotation and pitch disabled) |
| `src/map/featureExtractor.ts` | Sources, source layers, feature extraction |
| `src/world/TerrainType.ts` | Logical terrain enum |
| `src/world/gameLOD.ts` | `getGameLOD(zoom)` |
| `src/world/tileGrid.ts` | Grid geometry, projection, world copies, rasterization, elevation |
| `src/world/terrainClassifier.ts` | Classification rules, `LOD_RULES`, priorities, thresholds, post-processing |
| `src/world/transitions.ts` | Transition rules |
| `src/world/interiors.ts` | Town interiors |
| `src/world/tileResolver.ts` | Overrides, village spacing, `TileFrame` |
| `src/world/urbanDensity.ts` | Village density by distance to city centres |
| `src/world/labels.ts` | Place-name text and placement |
| `src/world/hash.ts` | Deterministic cell hash |
| `src/world/roadWidths.ts` | Road widths from the style's zoom-dependent `line-width` |
| `src/world/creatureSim.ts` | Wandering creatures (spawning, movement, fireballs), townsfolk and warp gates |
| `src/config/tileMappings.ts` | Built-in tile set, `TILESETS`, `SCROLLING_TERRAINS` |
| `src/config/customTilesets.ts` | `tileset.json` parser and loader |
| `src/config/overrides.ts` | Point overrides |
| `src/config/debugColors.ts` | Flat colours for debug rendering and the placeholder atlas |
| `src/renderer/SpriteAtlas.ts` | Atlas image, keyed (transparent-black) copy, black tile |
| `src/renderer/webgl/GlTileLayer.ts` | WebGL custom layer and shaders |
| `src/renderer/webgl/instances.ts` | GL-free helpers: instance buffers, UVs, matrices, pixel snapping |
| `src/renderer/TileRenderer.ts` | Canvas 2D renderers |
| `src/debug/Inspector.tsx` | Per-cell inspector |
| `src/test/helpers.ts`, `src/**/*.test.ts` | Unit tests |
| `scripts/make-original-atlas.mjs` | Generates the CC0 tile set |
| `scripts/snapshot.mjs`, `snapshots/` | Snapshot regression check |

### How Mapbox features are obtained

The style is `mapbox://styles/mapbox/streets-v12`. Its `composite` source contains
**Mapbox Streets v8**, **Mapbox Terrain v2** and **Mapbox Bathymetry v2**.

Features are read with `map.querySourceFeatures("composite", { sourceLayer })`. This
returns every feature in the currently loaded vector tiles, whether or not the style
draws it. The POC does not use `queryRenderedFeatures`: it depends on the style and
would need one call per cell.

A second vector source, `streets-z12`, is Mapbox Streets v8 with `maxzoom: 12`. An
invisible fill layer makes its tiles load. Above z12, Mapbox GL overzooms its z12 tiles. The
generalized urban polygons, which only exist up to z12, therefore stay available at z13–14.
Without it, villages would drop from about 19% to 4% at the z13 tile switch, because z13–14
tiles have almost no landuse or buildings in city centres.

A third source, `streets-places-z9`, is Mapbox Streets v8 with `maxzoom: 9`, used only for
settlement labels. It exists because of how Mapbox places those labels:

- From z11, big-city labels are repeated. Yokohama has four points at z12.
- Labels move between zooms. Yokohama's point moves about 2 km between z9 and z12.
- Above z12, labels are only present in tiles on screen.

At z9 each city has one point. Overzooming z9 tiles therefore gives every zoom the same
single Town cell per city, so a town does not jump, multiply or disappear as you zoom in.

The Mapbox Standard style is not used, because its imported basemap is harder to
query this way.

Source layers used:

| Source layer | Used for |
|---|---|
| `water` | Water (polygons; Streets v8 does not distinguish ocean from lake). Long, thin polygons (river surfaces) need only 1 of 9 samples below LOCAL |
| `waterway` | Water, `class` river/canal only (lines; LOCAL only) |
| `landuse` | `wood` → Forest; `park` with `type` wood/forest → Forest; `park`/`pitch`/`cemetery` → Park; `grass`/`scrub`/`agriculture` → Grass; `residential`/`commercial_area`/`industrial` → Urban (TOWN/REGION) |
| `landuse_overlay` | `national_park` → Park; `wetland` → Grass |
| `landcover` | `wood` → Forest; `grass`/`scrub`/`crop` → Grass (mostly low zoom) |
| `building` | Building (only present at z13+) |
| `road` | Road, filtered by `class`, `type`, zoom and LOD (see below) |
| `place_label` from a second source capped at z9 (`streets-places-z9`) | `class=settlement` with `symbolrank` ≤ the zoom's limit → one Town cell, WORLD to TOWN (see below) |
| `contour` (Terrain v2) | Elevation polygons (area at or above `ele`), turned into a per-cell elevation grid. Local relief ≥ 600 m → Mountain, ≥ 200 m → Hill (REGION/WORLD, z9+) |
| `hillshade` (Terrain v2) | Slope bands → Hill/Mountain, only below z9 where contours are not available (WORLD, low REGION) |
| `depth` (Bathymetry v2) | `min_depth` ≥ 200 m → DeepWater |
| `landuse` from a second source capped at z12 (`streets-z12`) | `residential`/`commercial_area`/`industrial` → Urban at TOWN (see below) |

### Logical grid

- **Size**: cells are 16×16 screen pixels, and the grid covers the whole map viewport. It runs from the cell containing the top-left pixel to the cell containing the bottom-right one (`computeViewportGridSpec`), so a 1600×900 window gets 101×58 cells. At z15 in Tokyo one cell is about 31 m. The grid is rebuilt when the window is resized.
- **Anchored to the world**: the grid origin snaps to multiples of 16 px in global Web Mercator pixel space at the current zoom. Panning therefore does not move cell boundaries relative to the ground.
- **Antimeridian**: when you pan across the dateline, Mapbox lets the centre run past ±180° (for example, a view of −362…−37°). Most geometry still comes back in canonical −180…180° longitudes, while overzoomed label tiles come back already wrapped. `worldCopyShifts()` therefore moves each feature, as a whole, by the numbers of world widths that put it on the grid. Usually that is one copy; when zoomed out far enough that the world is visible more than once (below about z1), the feature is drawn in every copy, and names are placed once per copy. `cellAtLngLat()` takes a point as given if it is on the grid (e.g. the mouse over a far copy), otherwise the copy nearest the grid. Overrides are matched in the cell's world copy.
- **Coverage**: each feature is projected into cell units. For each cell, 3×3 sample points record whether each terrain covers them.
  - Polygon fill uses the even–odd rule, so holes are supported.
  - Polygons are rasterized with scanlines: each sample row is intersected with the polygon edges once.
  - Lines mark every cell whose centre is within 0.5 cells of a segment.
  - Points mark the single cell that contains them.
  - Coverage is stored as a bitmask, so a feature repeated across vector tiles is not counted twice.
- **Terrain choice**: `classifyCell()` picks one terrain per cell from its coverage.
- **Grid post-processing**: `postProcess()` runs over the whole grid afterwards (road thinning, deep water).
- **Transitions**: `applyTransitions()` (`src/world/transitions.ts`) then inserts intermediate terrains at boundaries (see below).
- **Town interiors**: at LOCAL (z15+), `applyInteriors()` (`src/world/interiors.ts`) turns buildings into walls and floors (see below).

### Terrain priority rules (`src/world/terrainClassifier.ts`)

All rules are in this one module. For each cell, the first terrain in this order whose
coverage reaches its threshold wins:

```text
Town > Road > DeepWater > Water > NarrowWater > Building > MinorRoad > Mountain > Forest > Hill > Park > Urban > Grass > Unknown
```

| Terrain | Samples required (of 9) |
|---|---|
| Town | point inside the cell |
| Road | line within 0.5 cells of the cell centre |
| DeepWater | 5, and Water must also pass its threshold (bathymetry bands are generalized and can spill onto land) |
| Water | 5 |
| Building | 3 |
| Mountain / Forest / Hill / Park / Grass | 5 |
| Urban | REGION 7 (generalized urban polygons cover almost all of a metro area, so their fringes fall back to other terrain); TOWN 5 (from z13 the polygons come split by streets) |
| NarrowWater | 1, classified as Water (see below) |
| MinorRoad | line within 0.5 cells, classified as Road (minor streets at z15–16, see below) |

Other rules:

- **Road above Water** keeps bridges as road.
- **Urban below vegetation**: Urban comes from generalized landuse polygons, not building footprints. It sits below Park, Forest and Hill so parks and green belts inside cities survive.
- **Road classes by minimum zoom**: one table for every LOD except WORLD, so the network grows gradually with zoom instead of jumping at LOD boundaries. At z12 one cell is about 250 m, and the Kanto plain's primary network (a road every 1–2 km) would otherwise fill a quarter of the grid.

  | Class | Shown from |
  |---|---|
  | motorway | z8 |
  | trunk | z12 |
  | primary | z14 |
  | secondary, tertiary | z15 |
  | street, street_limited | z15 (below z16 only where no building is) |

  `type=urban_expressway` roads (e.g. Tokyo's Shuto) are dropped below z13, because they form a dense mesh inside cities.

- **Road width follows the map style**: Mapbox road data are centre lines with no width. The style draws them with a zoom-dependent `line-width` in screen pixels, for example `["interpolate", ["exponential", 1.5], ["zoom"], 3, 0.8, 18, 28, 22, 280]` for primary roads.
  - `src/world/roadWidths.ts` reads those expressions from the style layers `road-motorway-trunk`, `road-primary`, `road-secondary-tertiary` and `road-street`, and evaluates them at the current zoom. Built-in copies are used if the style lacks them.
  - Each line is rasterized with half that width (in cells), and never narrower than one cell.
  - Up to about z16 this is one cell, as before. From z17 roads widen with the zoom and line up with the base map in the Overlay view; for example, primary roads are about 1.2 cells wide at z17 and 1.75 at z18.

  At z15 a cell is about 31 m and city streets run every 30–60 m, so drawing minor streets over buildings would chop every block into wall fragments. Between z15 and z16, `street` and `street_limited` are therefore `MinorRoad`: it ranks just below Building, is drawn as Road, and only shows where no building is. The streets appear in the gaps between buildings, and nothing jumps between z15 and z16.

- **Mountain vs Hill**:
  - From z9, contour polygons give real elevation. Each polygon is the area at or above its `ele`. A cell's elevation is the highest contour that covers at least 5 of its 9 samples.
  - Mountain and Hill come from **local relief**, not absolute height. Relief is the cell's elevation minus the lowest elevation within 4 km. ≥ 600 m is Mountain, ≥ 200 m is Hill.
  - High flat plateaus are therefore not mountains, and canyon walls are. Examples of such plateaus are the Grand Canyon rim at 2000 m, Tibet and Mexico City.
  - The inspector shows each cell's elevation and relief.
  - Below z9, where contours are not in the tiles, hillshade is the fallback. `shadow` level ≤ 78 and `highlight` level ≥ 94 count as Mountain, and other bands count as Hill. Lower shadow levels are darker, meaning steeper slopes.
- **Road thinning** (TOWN/REGION): Zhang–Suen thinning shrinks the Road mask to 1-cell-wide lines that stay connected. This collapses dual carriageways and parallel roads. A removed road cell falls back to the next terrain its coverage supports.
- **DeepWater** comes from two sources:
  - bathymetry (`depth` ≥ 200 m);
  - where bathymetry has no data (inland water, high zoom), a Water cell whose neighbours within 2 cells are all water.
- **Rivers below LOCAL (narrow water)**:
  - From TOWN down, a cell is 250 m or more. Drawing every `waterway` line would turn each ditch and stream into a line of water, so waterway lines are off.
  - Rivers instead come from their `water` polygons. A polygon whose outer ring is long (bounding-box side ≥ 6 cells) and thin (area ≤ 25% of that side squared) is treated as a river surface. It is rasterized as `NarrowWater`, which needs only 1 of 9 samples and is classified as Water.
  - This keeps rivers narrower than a cell continuous, such as the upper Arakawa inside its wide floodplain, which is a thin polygon with no waterway line at z12. Lakes and the sea are compact and keep the normal threshold. Streams with no polygon at that zoom disappear.
- **Unknown**: cells where nothing reached a threshold. They are drawn as grassland.

### Zoom → GameLOD (`src/world/gameLOD.ts`)

| Zoom | GameLOD |
|---|---|
| 0 – <8 | WORLD |
| 8 – <12 | REGION |
| 12 – <15 | TOWN |
| ≥ 15 | LOCAL |

The LOD is passed into the classifier (`ClassifyContext.lod`) and the resolver
(`resolveTile({ …, lod })`). `LOD_RULES` in `terrainClassifier.ts` turns rules on or off
per LOD. The renderer does not know about LODs.

| LOD | Roads | Rivers | Urban areas | Settlements → Town | Relief (Hill/Mountain) |
|---|---|---|---|---|---|
| LOCAL | zoom table above | waterway lines + polygons | buildings only | off (town interiors instead) | off |
| TOWN | zoom table above, thinned | polygons, narrow-water rule | buildings, plus residential/commercial/industrial landuse (current tiles and `streets-z12`) → Urban | `symbolrank` ≤ 10 | off |
| REGION | zoom table above (motorways only below z12), thinned | polygons, narrow-water rule | residential/commercial/industrial landuse → Urban | `symbolrank` ≤ min(10, floor(zoom)): z8 ≤ 8 (Tokyo, Yokohama), z9 ≤ 9, z10+ ≤ 10 (adds Kawasaki, Chiba, …) | contour (z9+), hillshade below |
| WORLD | none (classic overworld maps have no roads) | polygons, narrow-water rule | off (cities appear as single Town tiles) | `symbolrank` ≤ 8 (e.g. Tokyo, Osaka, Nagoya, Seoul) | hillshade |

The settlement rank limit never shrinks as you zoom in up to TOWN: 8 at WORLD,
min(10, floor(zoom)) at REGION, and 10 at TOWN. A town shown at one zoom therefore stays on
screen, at the same cell, until z15. At LOCAL (z15+) there are no Town tiles, because the
buildings themselves are drawn as a town interior.


### Transition tiles (`src/world/transitions.ts`)

The tile sets have no edge or corner variants. Boundaries are softened the way classic 8-bit
RPG world maps do it: by inserting intermediate terrains. The rules run in order, and each
sees the result of the previous one:

| Rule | Change | Trigger | LODs |
|---|---|---|---|
| `coast` | Water/DeepWater → ShallowWater | any 8-neighbour is land (roads do not count, so bridges do not create shallows) | all |
| `coast-gradient` | DeepWater → Water | any 8-neighbour is ShallowWater | all |
| `foothills` | Grass/Unknown → Hill | any 8-neighbour is Mountain | WORLD, REGION |
| `forest-edge` | Grass/Unknown → Scrub | any 4-neighbour is Forest | WORLD, REGION |

The result is land → shallow water → water → deep water along coasts, hills around mountain
ranges, and scrub along forest edges. The inspector shows the classified terrain and the
transition rule that changed it.

### Town interiors at high zoom (`src/world/interiors.ts`)

From z15, which is all of LOCAL (`LodRules.interiorMinZoom`), buildings are drawn like the
inside of an 8-bit RPG town instead of as village tiles. There are no village tiles at these
zooms. One cell is about 31 m at z15, 16 m at z16 and 8 m at z17, so rooms get larger and
floors appear as you zoom in:

- **Walls and floors**: a Building cell with any 8-neighbour that is not Building becomes Wall (a brick wall tile). The other cells become Floor. Cells off the grid edge count as Building, so buildings cut by the edge stay open.
- **Small buildings**: a building with no inner cell, such as a detached house, becomes solid wall.
- **No doors**: walls are uniform all the way round.
- **Floor**: always brick (62). The wood floor (63) was dropped because its white stripes look like the white brick wall.
- **Variants in the mapping**: `TileMapping` entries may list several tiles. The pipeline can pass a variant index through `ResolvedTile.variant`, and `tileIdFor()` picks the tile. Nothing uses this today.

Real edge and corner autotiles would need a tileset that has them. They can be added as a
further step after the tile resolver once the atlas is replaced.

Ideas not implemented yet: large parks as Forest at REGION, and railways at TOWN.

### Tile resolver and area overrides

```ts
resolveTile({ terrain, longitude, latitude, bounds, zoom, lod }) → { terrain, overrideId? }
```

`src/config/overrides.ts` holds point overrides. Each one replaces the terrain of the
single cell that contains its point, and can be limited to certain LODs. There are two
demo entries, both limited to TOWN (z12–14). At WORLD/REGION, Tokyo is shown as a
settlement Town instead. At LOCAL (z15+) the real map is drawn, with town interiors
and the palace grounds, so there are no single-tile Castle or Town icons:

| Override | Result | Where to see it |
|---|---|---|
| Imperial Palace | Castle (TOWN only) | Zoom out below z15 from the default location |
| Tokyo Station | Town (TOWN only; at LOCAL it is drawn as town interior) | Zoom out below z15 from the default location |

This is only an extension point. It is not a POI database.

The resolver also holds one generic rule, `village-spacing`. It applies to Urban cells, and
to Building cells below LOCAL. Such a cell is drawn as a village (Building) only if the hash
of its world-anchored cell index is the smallest within `spacing` cells; otherwise it becomes
grassland. Villages therefore never touch, and appear on about 1 in (2·spacing+1)² of those
cells. The pattern does not change while panning.

**Density by city** (`src/world/urbanDensity.ts`): the spacing is smaller near city centres,
so downtowns are busier than suburbs.

- **Centres**: settlement points from `streets-places-z9` with `symbolrank` ≤ 10, including cities just off the grid.
- **Urban radius**: 15 km for rank ≤ 6 (e.g. Tokyo), 8 km for ≤ 8 (Yokohama, Osaka), 6 km for 9, and 4 km for 10.

| Distance from the nearest centre | Spacing | Villages |
|---|---|---|
| < radius / 2 | 1 | about 1 in 9 |
| < radius | 2 | about 1 in 25 |
| otherwise | 3 (`VILLAGE_SPACING`) | about 1 in 49 |

Distances are in metres, so the dense core stays in the same place at every zoom.

### Place names (`src/world/labels.ts`)

Country and city names are written with the tile set's letter tiles (A–Z), one letter per
cell, over the terrain:

- **Text**: the English name (`name_en`), upper case, with diacritics removed (Tōkyō → TOKYO). Anything that is not A–Z becomes a word gap, because the sheet has no digits or punctuation. Names without Latin letters are not shown.
- **What is labelled**:
  - At WORLD, REGION and TOWN (below z15): every settlement drawn as a Town tile, using the same `streets-places-z9` points, so a name follows its Town tile at every zoom.
  - Countries (`class=country`) at WORLD only.
  - Nothing at LOCAL.
- **Placement**:
  - City names go on the row above the Town tile, centred; if that does not fit, on the row below. Country names are centred on their point.
  - Each name appears once. For names Mapbox repeats, the copy nearest the grid centre is kept.
  - Labels keep a one-cell margin from each other and never cover a Town tile. More important places are placed first (countries, then settlements by `symbolrank`); names that do not fit are dropped.
- **Drawing**:
  - After the terrain, the sprite renderer draws a translucent dark band behind each name: black at 60% opacity, padded 3 px on each side. It then draws the letters on top from `SpriteAtlas.keyedImage`, the atlas with near-black pixels made transparent. The terrain stays visible but darker behind the text.
  - Each tile set maps letters to tiles with a `GlyphMapping` (e.g. `ORIGINAL_GLYPHS` in `src/config/tileMappings.ts`). An atlas with no letters shows no names.
  - The debug-colour renderer does not draw names.
- **Renderer input**: labels travel with the frame as `TileFrame.labels`, one entry per name (position and text). They do not change terrain counts, so they do not affect the snapshot check.

### Wandering creatures (`src/world/creatureSim.ts`)

Creatures wander over the map as a visual layer. There is no player and no combat. They
appear only when the **animation** switch is on, with the WebGL renderer, below z15, and
only if the tile set defines creatures. The built-in set has 23 creatures with two frames
each, plus a fireball.

Rules, applied every turn (1 s):

- **Spawning**: for every 11×11-cell screenful of the grid, a creature appears with probability 1/32, while there is less than 1 per screenful and fewer than 12 in all, whatever the window size. It appears on a random cell, and the terrain there picks the tile set's spawn table:
  - **deep** (deep and medium water): ships, water sprites, krakens, sea serpents, seahorses, whirlpools, twisters, all equally likely;
  - **shallow**: the same without ships and twisters;
  - **land** (grass, scrub, forest, park, hills): 16 creatures, weighted from 81 (orcs) down to 1 (the rarest).
- **Movement**: each creature tries one step in a random direction onto terrain it can use, and never onto another creature.
  - `sail`: deep and medium water.
  - `swim`: any water.
  - `walk`: open land.
  - `fly`: land, water and mountains.
- **Fire**: creatures marked `fire` (sea serpents, fire lizards, hydras, dragons) shoot a fireball one turn in four. It flies 3 cells in a straight line, one cell every 200 ms.
- **Removal**: creatures that end up off the grid are removed. Every creature also leaves after a random lifetime of 1–2 minutes, so they come and go instead of staying put.
- **Animation**: frames change every 400 ms, with a random offset per creature.
- **Positions**: they are kept as lng/lat, so creatures stay in place while panning and keep their place when the grid is rebuilt.

The creatures, their frames, how they move and the spawn tables come from the tile set:
`ORIGINAL_CREATURES` in `src/config/tileMappings.ts`, or `creatures` in a `tileset.json`.
The Canvas 2D fallback does not draw creatures.

**Townsfolk**: from z15 (LOCAL, town interiors) there are no monsters. Instead, people and
animals from the tile set walk around towns, under the same rules (spawn chance, caps,
lifetime, movement):

- They come from the `town` spawn table and move as `town`: on floors inside buildings, streets, grass, scrub and parks, never through walls or water. Someone who appears inside a building stays in that room.
- The built-in set has 12, two frames each: villager and woman (the most common), child, bard, jester, fighter, mage, king (the rarest), beggar, horse, cow and dog.
- Zooming across z15 sends away whoever does not belong: townsfolk below z15, monsters from z15. There are no warp gates from z15.

**Warp gates** follow the same rules for when they show (animation on, WebGL, below z15),
if the tile set defines a gate. One gate is open at a time:

- It appears on a random open-land cell (grass, scrub, forest, park, hills) that has no creature and no place name over it.
- It rises through its opening frames, one every 200 ms, stays open, then sinks back the same way. The whole cycle takes 12 s.
- Then the next gate appears somewhere else.
- Creatures do not step onto the gate or spawn there. A gate whose cell leaves the grid, or stops being open land, closes at once.

The frames come from `ORIGINAL_GATE` (a blue arch rising from the ground, 3 stages and open) or `gate` in a `tileset.json`.

### Rendering

Choose the renderer with **renderer** in the panel. Both take the same `TileFrame`.

**WebGL (default)** — `GlTileLayer` (`src/renderer/webgl/`) is a Mapbox custom layer, drawn inside Mapbox's own WebGL frame:

- **Smooth pan and zoom**: tiles move and scale with the map on every frame. There is no CSS-transformed canvas catching up on `idle`.
- **Instancing**: each grid cell is one instanced quad (`drawArraysInstanced`) that samples the atlas texture with `NEAREST` filtering, so pixels stay crisp at any zoom. UVs are inset by half a texel so a tile never bleeds into its neighbour.
- **Pixel snapping**: the grid matrix is shifted so the grid origin lands on a whole device pixel (`snapToPixels`). Without it, texel edges fell between pixels (for example at 0.52 px) and nearest-neighbour rows shifted unevenly, which showed as shimmer on moving water.
- **Precision**: instances are in cell units, and the matrix is built in JS doubles: Mapbox's Mercator matrix × grid origin × one cell. This avoids float32 jitter at high zoom (checked at z19).
- **Place names**: a translucent black band per name, then letters from the black-keyed atlas.
- **Scrolling water**: as in classic 8-bit RPGs, water tiles scroll instead of switching frames. Every 200 ms the fragment shader shifts the rows of DeepWater, Water and ShallowWater tiles down by 1/16 of the tile (one display pixel) and wraps them inside the tile, so all water moves together. The **animation** checkbox in the panel turns scrolling on or off. A choice made there is remembered in `localStorage`. Until one is made, animation is off for people whose OS asks for reduced motion (`prefers-reduced-motion`) and on otherwise. When it is off no repaint timer runs. The step time (200 ms) was chosen by eye and is a constant in `GlTileLayer.ts`. The terrains are listed in `SCROLLING_TERRAINS`, and water tiles must wrap vertically without a seam. The layer asks Mapbox to repaint on a timer only while water is on screen. The Canvas 2D fallback does not animate.
- **Fluttering flags**: tile sets can mark flag rectangles on tiles (the built-in set: the flags on Town and Castle; custom sets: `flags` in `tileset.json`). Every 400 ms, every other display row of a flag is pulled one pixel toward its free end, alternating each frame, so the edge of the flag ripples. The pole and building do not move. The same repaint timer and the same **animation** switch serve water and flags.
- **View modes**: handled in the layer.
  - Tiles: a full-screen black quad under the tiles hides the base map.
  - Overlay: the opacity uniform.
  - Split: a scissor over the right half of the screen, with the same black quad under the tiles, so the tile half never shows the map where tiles are not generated yet.
  - Mapbox: nothing is drawn.
- **Grid lines**: one screen pixel at the cell edges (`fwidth`), in the fragment shader.
- **Debug colours**: use a flat-colour atlas.
- **Inspector highlight**: a DOM box re-projected on every map `render` event.
- **Tests**: the GL-free parts (`instances.ts`: UVs, instance buffers, matrix) are unit-tested.

**Canvas 2D (fallback)** — `SpriteTileRenderer` / `DebugColorRenderer`:

- They draw into a 2D canvas overlaid on the map, with `imageSmoothingEnabled = false` and CSS `image-rendering: pixelated`.
- While the map moves, the canvas is translated and scaled to follow it.
- In the Tiles view the Mapbox canvas is made transparent to hide the base map. In Split, a black backdrop covers the right half, and the tile overlay is clipped to that half in screen space.

**Common to both**:

- **Regeneration**:
  - A final rebuild happens on the map's `idle` event (camera settled and tiles loaded), and only if the camera changed or new tiles arrived since the last run.
  - While the camera moves, the grid is also rebuilt, so newly revealed areas fill in during a drag or zoom. These rebuilds are spaced by at least 300 ms and by 3× the last build time, so slow builds (large windows, low zoom) do not make dragging stutter.
- **Revealed areas**: between rebuilds, and where Mapbox has not loaded tiles yet, revealed areas are black in the Tiles view. The Mapbox logo and attribution stay visible.

## Debug tools

**Panel (top left)**

| Control | Options / content |
|---|---|
| view | **Tiles** (tiles only, on black), **Overlay** (tiles over the visible map, adjustable opacity), **Split** (map on the left half of the screen, tiles on black on the right), **Mapbox** (map only) |
| tiles | Sprites from the selected tile set, or debug colours per terrain |
| grid lines | Draws the logical grid |
| animation | Scrolling water, fluttering flags, wandering creatures, townsfolk and warp gates on/off (WebGL renderer only; remembered; off by default with reduced motion) |
| stats | Zoom, GameLOD, feature count, generation time, cell count per terrain |

**Inspector (top right)**

Hover a cell to inspect it; click to pin or unpin it. It shows:

- grid x/y
- cell centre (lng/lat) and bounds
- classified terrain
- resolved terrain, including any override
- sprite atlas and tile ID, with a preview
- coverage per terrain
- the Mapbox features that hit the cell (source layer, class, type, and the terrain each maps to); features of the winning terrain are highlighted

`window.__map` exposes the Mapbox map in the browser console for debugging.

## Tile sets

Two tile sets can be chosen with **tileset** in the panel. The choice is remembered in
`localStorage`. Both share the same logical pipeline; only the entries in `TILESETS`
(`src/config/tileMappings.ts`) differ.

| Tile set | File | Licence | In git |
|---|---|---|---|
| **Original (CC0)** (default) | `public/assets/original/tiles.png` | CC0 1.0 — drawn for this project | yes |

You can also bring your own tile set: a sprite sheet and a `tileset.json` in `tilesets/<folder>/` (see "Bring your own tile set").

If a tile set's image cannot be loaded, the app falls back to a flat-colour placeholder atlas
and logs a warning. The panel then shows `atlas: placeholder`.

### Original tile set (CC0)

`npm run make-atlas` (`scripts/make-original-atlas.mjs`) draws every tile in code and writes
`public/assets/original/tiles.png`. The PNG is committed.

- **Style**: modelled on 16-colour (EGA) RPG overworld maps:
  - 16×16 cells on a black ground;
  - flat colours from a fixed EGA-style palette (`EGA` in the script; the script rejects any other colour);
  - sparse dot and line patterns, no shading or outlines.
- **Original work**: no pixels are copied or traced from any other tile set, and it is released under CC0 (`public/assets/original/LICENSE`).
- **Tiles**: blue wave strokes on deep, medium and shallow water (cyan crests on the shallows); grass dots spread evenly over the tile (one per 4×4 cell, at a random spot), so repeated tiles show no pattern; scrub; a forest of wide, solid green oval crowns, each at its own height; a park with fruit trees and flowers; a maroon dither road with pebbles (currently unused); a village of thatched huts; a town of white buildings behind a grey wall; a dithered grey castle with orange-roofed towers and a flag; grey brick walls with black gaps; thin brown floor planks (1 px tall) with 1 px black gaps; grey hill ridges; white-outlined, snow-capped mountains.
- **Letters**: A–Z in a 5×7 pixel font drawn at 2×, in white.
- **Creatures**: 23 wandering creatures (a ship, sea creatures, orcs, skeletons, giants, a sorcerer, a lich, a dragon and more). Each has two frames; the second is a one-pixel bob, or a mirror for spinning ones.
- **Warp gate**: a blue arch with white sparkles, in 3 rising stages and open.
- **Townsfolk**: 12 people and animals for towns at high zoom. People's second frame is a mirror (arms and props swap sides, like a step); animals bob.
- **Layout**: 256×128, 16 tiles per row. Row 0 holds the terrain tiles, in the order of `TILE_ORDER` in the script. Rows 1–2 hold the letters A–Z, from index 16. From index 48 come the creatures, two frames each, the fireball, the 4 gate tiles and the townsfolk (two frames each). `ORIGINAL_TILE_MAPPING` and `ORIGINAL_GLYPHS` refer to these indices, and a unit test checks they stay inside the atlas.
- **Roads**: roads are drawn plain black (`BLANK_TILE`). The drawn road tile (maroon dither) is still in the atlas at index 7.
- **Black tile**: sheets need not have a fully black tile: `SpriteAtlas` appends a row below the sheet whose first tile is black, and maps `BLANK_TILE` (−1) to it in both renderers.

### Bring your own tile set

Put a sprite sheet and a `tileset.json` in a folder under `tilesets/` at the repository root,
for example `tilesets/mytiles/`. The folder is git-ignored, so the tile set stays on your
machine. It is picked up at build time (restart `npm run dev` after adding one) and
appears in the **tileset** selector. Use only images you are allowed to use.

```json
{
  "id": "mytiles",
  "name": "My tiles",
  "image": "sheet.png",
  "layout": { "tileWidth": 16, "tileHeight": 16, "offsetX": 0, "offsetY": 0, "columns": 16 },
  "tiles": { "DeepWater": 0, "Water": 1, "ShallowWater": 2, "Grass": 3, "Road": "blank", "Unknown": 3 },
  "letters": 96,
  "flags": { "Town": [9, 5, 6, 6] }
}
```

- **Tile ids**: they count row-major from the top-left tile, after `offsetX`/`offsetY`.
- **`tiles`**: keys are `TerrainType` names: DeepWater, Water, ShallowWater, Grass, Scrub, Forest, Park, Road, Building, Urban, Town, Castle, Wall, Floor, Hill, Mountain, Unknown.
  - A value is a tile id, a list of ids (variants), or `"blank"` for plain black.
  - Terrains left out use `Unknown`, which is required.
- **`letters`** (optional): the id of "A", with A–Z consecutive, or an explicit `{ "A": 96, … }` table. Without letters, place names are not drawn.
- **`flags`** (optional): flag rectangles `[x, y, width, height]` in tile pixels, per terrain. The pixels inside them flutter (see Rendering).
- **`creatures`** (optional): wandering creatures (see "Wandering creatures").
  - `defs`: `{ "<id>": { "frames": [tile ids], "moves": "sail" | "swim" | "walk" | "fly" | "town", "fire": true } }`.
  - `spawn`: `{ "deep": [["<id>", weight], …], "shallow": […], "land": […], "town": […] }`. `town` is used from z15, for townsfolk (`"moves": "town"`); the others below z15.
  - `fireTile`: the fireball tile.
- **`gate`** (optional): a warp gate, `{ "frames": [tile ids] }`: the rising stages, then the open gate last (see "Wandering creatures").
- **Errors**: an invalid file is skipped with a message in the browser console that names the problem.
- **Parser**: `src/config/customTilesets.ts`, with unit tests.
- **Built-in sets**: to add one to the repository instead, add a `TilesetConfig` to `TILESETS` in `src/config/tileMappings.ts`.

#### Example: a 256-tile sheet

`examples/tilesets/classic256/tileset.json` is a ready-made `tileset.json` for a classic
256-tile overworld sheet. No image is included: bring a sheet you are allowed to use.

1. Copy the folder: `cp -r examples/tilesets/classic256 tilesets/`.
2. Save your sheet as `tilesets/classic256/sheet.png`.
3. Restart `npm run dev` and pick "Classic 256-tile sheet" in the **tileset** selector.

The sheet must match this layout:

- **Size**: 560×512 px, PNG.
- **Grid**: 16 columns × 16 rows, 256 tiles, numbered row-major from the top-left.
- **Tile**: 28×32 px. The first column starts 14 px from the left edge; the image is read from x = 14 to x = 462, and the rest of the width is ignored.
- **Tiles used** (decimal ids):

| Ids | Content |
|---|---|
| 0, 1, 2 | deep, medium and shallow water |
| 4, 5, 6 | grass, scrub (also parks), forest |
| 7, 8 | hills, mountains |
| 10, 11, 12 | town, castle, village (buildings below z15) |
| 62, 127 | floor and wall (buildings from z15) |
| 20 | horse (townsfolk) |
| 32–47 | 8 townsfolk, 2 frames each |
| 64–67 | warp gate: 3 rising stages, then open |
| 79 | fireball |
| 80–95 | 8 more townsfolk, 2 frames each |
| 96–121 | letters A–Z |
| 128 | ship |
| 132–143 | 6 sea creatures, 2 frames each |
| 192–255 | 16 land creatures, 4 frames each |

Other ids are not used. Roads are plain black. For a different layout, change `layout` and
the ids in the copied `tileset.json`.

A tile set image in `tilesets/` is bundled into `npm run build` output. Do not publish builds
that contain images you may not redistribute.

No code in `src/map/` or `src/world/` changes.

## Known limitations

- **Loaded tiles only**: classification only sees vector tiles Mapbox has loaded, which cover the viewport. The grid matches the viewport, so this is not visible, except for a partial cell at each edge.
- **Grid size grows with the window**: a 4K window has about 32,000 cells. Generation time grows with it.
- **Zoom-dependent data**:
  - `building` exists only at z13 and above.
  - At low zoom, small polygons and minor roads are generalized away.
  - Rules are tuned for about z15.
- **Urban expressway filter is data-specific**: `type=urban_expressway` appears in Mapbox's Japan data. Other countries' city motorways are not filtered by type; road thinning still applies.
- **Urban at z13–14 is z12 data**: the urban extent at z13–14 comes from overzoomed z12 polygons, so it is as coarse as at z12.
- **Relief below z9 is hillshade**: it marks slopes, not elevation. At WORLD zooms, steep low hills may become Mountain. Contours are coarse at low zoom (500 m steps at z9–10), so relief is quantized.
- **Relief window at the grid edge**: the 4 km window is cut at the grid edge. A slope that continues off-grid can be under-counted near the border.
- **City density is by distance only**: villages get denser towards settlement label points, not by actual building density. A dense district far from any labelled city looks like a suburb.
- **Interiors and building size**: a block needs at least one inner cell to have a floor. At z15, and in low-rise areas such as Yanaka even at z16, most buildings are only 1–2 cells and become solid wall blocks. Adjacent footprints in dense districts merge into one walled block.
- **Place names**: letters are one cell each, so a long name such as UNITED KINGDOM takes 14 cells (224 px). Dense regions (e.g. Europe at z3) drop many names. Only A–Z can be shown.
- **Transitions are one cell wide**: narrow water such as moats and city rivers becomes almost entirely ShallowWater.
- **Rivers without polygons disappear below LOCAL**: a river that Mapbox only has as a line at that zoom is not drawn. The narrow-water thresholds (fill ≤ 25%, side ≥ 6 cells) were tuned on the Kanto plain.
- **Performance**: grid generation takes about 50–300 ms at every zoom tested (z5–z15), dominated by feature extraction. It runs only when the camera stops.
- **No real ocean class in Streets**: Streets v8 `water` does not tell ocean from lake. DeepWater uses bathymetry, and falls back to the neighbourhood rule.
- **Park vs Forest**: most `landuse=park` in Tokyo is tagged `type=wood`, so large parks render as Forest and the Park (scrub) tile is rare.
- **Dense low-rise areas**: many cells stay Unknown when building coverage is under 3/9.
- **No rotation, pitch or globe**: the grid assumes a flat Web Mercator view with bearing 0 and pitch 0. Rotation and pitch are disabled, and the projection is fixed to `mercator`; the style default, globe at low zoom, would not line up with the grid.
- **Newly revealed areas can be black for a moment**: during a move the grid is rebuilt at most every 300 ms (longer when builds are slow), and only from tiles Mapbox has already loaded.
- **Overrides**: they are single-cell point rules. There is no multi-tile structure yet, such as a castle three tiles wide.
