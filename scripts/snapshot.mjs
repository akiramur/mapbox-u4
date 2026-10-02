// Regression check: renders fixed locations in headless Chromium and compares
// the number of cells per terrain with snapshots/baseline.json.
//
//   npm run snapshot           compare with the baseline (exit 1 on regressions)
//   npm run snapshot:update    overwrite the baseline with the current result
//
// Needs a Mapbox token (VITE_MAPBOX_ACCESS_TOKEN or MAPBOX_ACCESS_TOKEN) and a
// Chromium for Playwright (`npx playwright-core install chromium` if missing).
// Screenshots go to snapshots/out/ (git-ignored).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const root = new URL("..", import.meta.url);
const locationsFile = new URL("snapshots/locations.json", root);
const baselineFile = new URL("snapshots/baseline.json", root);
const outDir = new URL("snapshots/out/", root);

const update = process.argv.includes("--update");
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
/** A terrain count may drift by this many cells (of 4096) before it counts as a change. */
const TOLERANCE_CELLS = 40;

const token = process.env.VITE_MAPBOX_ACCESS_TOKEN || process.env.MAPBOX_ACCESS_TOKEN;
if (!token) {
  console.error("Set VITE_MAPBOX_ACCESS_TOKEN (or MAPBOX_ACCESS_TOKEN).");
  process.exit(2);
}
process.env.VITE_MAPBOX_ACCESS_TOKEN = token;

const locations = JSON.parse(await readFile(locationsFile, "utf8")).filter((l) => !only || l.name.includes(only));
// forwardConsole off: browser console messages can contain request URLs with the token.
const server = await createServer({ root: root.pathname, server: { port: 0, forwardConsole: false }, logLevel: "error" });
await server.listen();
const baseUrl = server.resolvedUrls.local[0];

const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1100, height: 1100 } });
// Never echo URLs: Mapbox request URLs carry the access token.
const redact = (s) => s.replaceAll(token, "<token>");
page.on("pageerror", (e) => console.error("page error:", redact(e.message.split("\n")[0])));
await mkdir(outDir, { recursive: true });

const results = {};
try {
  for (const [i, { name, hash }] of locations.entries()) {
    // A new query string makes each location a fresh page load. (A hash-only
    // change would not restart the app, and reload() aborts in-flight requests,
    // which Mapbox logs with the token in the URL.)
    await page.goto(`${baseUrl}?snapshot=${i}#${hash}`);
    await page.waitForFunction(() => window.__map && window.__tileStats, null, { timeout: 60000 });
    // Wait until the map is idle and the grid has stopped changing (late tiles trigger a rebuild).
    let last = "";
    for (let i = 0; i < 20; i++) {
      await page.waitForFunction(() => !window.__map.isMoving() && window.__map.areTilesLoaded(), null, { timeout: 60000 });
      await page.waitForTimeout(1000);
      const now = await page.evaluate(() => JSON.stringify(window.__tileStats));
      if (now === last) break;
      last = now;
    }
    results[name] = { hash, ...JSON.parse(last) };
    await page.screenshot({ path: new URL(`${name}.png`, outDir).pathname });
    process.stdout.write(".");
  }
} finally {
  process.stdout.write("\n");
  await browser.close();
  await server.close();
}

if (update) {
  const previous = only ? JSON.parse(await readFile(baselineFile, "utf8").catch(() => "{}")) : {};
  await writeFile(baselineFile, JSON.stringify({ ...previous, ...results }, null, 2) + "\n");
  console.log(`Baseline written for ${Object.keys(results).length} locations.`);
  process.exit(0);
}

const baseline = JSON.parse(await readFile(baselineFile, "utf8").catch(() => "{}"));
let failures = 0;
for (const [name, cur] of Object.entries(results)) {
  const base = baseline[name];
  if (!base) {
    console.log(`? ${name}: no baseline (run npm run snapshot:update)`);
    failures++;
    continue;
  }
  const terrains = new Set([...Object.keys(base.counts), ...Object.keys(cur.counts)]);
  const diffs = [...terrains]
    .map((t) => [t, base.counts[t] ?? 0, cur.counts[t] ?? 0])
    .filter(([, a, b]) => Math.abs(a - b) > TOLERANCE_CELLS);
  if (base.lod !== cur.lod) diffs.unshift(["LOD", base.lod, cur.lod]);
  if (diffs.length) {
    failures++;
    console.log(`✗ ${name} (#${cur.hash})`);
    for (const [t, a, b] of diffs) console.log(`    ${t.padEnd(12)} ${String(a).padStart(5)} → ${String(b).padStart(5)}`);
  } else {
    console.log(`✓ ${name}`);
  }
}
console.log(failures ? `\n${failures} location(s) changed beyond ±${TOLERANCE_CELLS} cells. Screenshots: snapshots/out/` : "\nNo changes.");
process.exit(failures ? 1 : 0);
