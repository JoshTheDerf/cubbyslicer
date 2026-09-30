/**
 * `?model=` link e2e: a local CORS file server hands out a 3MF project and
 * STLs (some behind extension-less URLs) and the slicer opens them from links.
 *
 *   npx vite --port 5393 --strictPort
 *   node scripts/dev/e2e-model-link.mjs [http://localhost:5393/slicer/]
 *
 * HEADED=1 shows the browser.
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import('playwright');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SLICER_URL = process.argv[2] ?? process.env.SLICER_URL ?? 'http://localhost:5393/slicer/';
const PORT = Number(process.env.E2E_LINK_PORT ?? 18794);
const PROJECT = readFileSync(join(ROOT, 'public/calib/handy/OrcaSliced.3mf'));

/** Binary STL of an axis-aligned `s` mm cube. */
function cubeStl(s) {
  const v = [[0,0,0],[s,0,0],[s,s,0],[0,s,0],[0,0,s],[s,0,s],[s,s,s],[0,s,s]];
  const f = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
  const b = Buffer.alloc(84 + f.length * 50);
  b.writeUInt32LE(f.length, 80);
  f.forEach((t, i) => t.forEach((vi, k) => v[vi].forEach((c, j) => b.writeFloatLE(c, 84 + i * 50 + 12 + k * 12 + j * 4))));
  return b;
}
const CUBE = cubeStl(20);

const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Disposition' };
  if (u.pathname === '/files/cube.stl') return res.writeHead(200, { ...cors, 'Content-Type': 'model/stl' }).end(CUBE);
  // Extension-less: the slicer has to sniff it (zip → 3MF).
  if (u.pathname === '/dl' && u.searchParams.get('id') === 'project') return res.writeHead(200, { ...cors, 'Content-Type': 'application/octet-stream' }).end(PROJECT);
  if (u.pathname === '/dl' && u.searchParams.get('id') === 'disp') return res.writeHead(200, { ...cors, 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="Linked Project.3mf"' }).end(PROJECT);
  if (u.pathname === '/dl' && u.searchParams.get('id') === 'cube') return res.writeHead(200, { ...cors, 'Content-Type': 'application/octet-stream' }).end(CUBE);
  res.writeHead(404, cors).end();
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const FILES = `http://127.0.0.1:${PORT}`;

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`, ...a);
let failures = 0;
const check = (cond, what) => { if (cond) log(`  ok   ${what}`); else { failures++; log(`  FAIL ${what}`); } };

const browser = await chromium.launch({ headless: !process.env.HEADED });
const enc = encodeURIComponent;

/** Open the slicer with `query`, wait for `n` objects, return the page state. */
async function open(query, n, prefs) {
  const page = await browser.newPage();
  if (prefs) await page.addInitScript((p) => localStorage.setItem('cubby-slicer:preferences', JSON.stringify(p)), prefs);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${SLICER_URL}?${query}`);
  await page.waitForFunction((n) => (window.__cubbyProject?.objects.value.length ?? 0) >= n, n, { timeout: 120000 });
  await page.waitForTimeout(500);
  const state = await page.evaluate(() => {
    const p = window.__cubbyProject;
    return {
      search: location.search,
      objects: p.objects.value.map((o) => ({ name: o.name, x: o.position[0], y: o.position[1], plate: p.plateOf(o.id) })),
      plates: p.plates.value.length,
      project: p.projectName.value,
    };
  });
  await page.close();
  return { ...state, errors };
}

log('extension-less 3MF project (sniffed from zip bytes)');
let s = await open(`model=${enc(`${FILES}/dl?id=project`)}`, 1);
check(s.objects.length > 0, `project opened (${s.objects.length} objects, ${s.plates} plates)`);
check(s.search === '', `params cleared (search=${JSON.stringify(s.search)})`);
check(!s.errors.length, `no page errors ${s.errors.join('; ')}`);

log('3MF named by Content-Disposition, arrange=all');
s = await open(`model=${enc(`${FILES}/dl?id=disp`)}&arrange=all`, 1);
check(s.objects.length > 0, `project opened (${s.objects.length} objects)`);
check(/Linked Project/.test(s.project), `named from Content-Disposition (${s.project})`);

log('two STLs (one named by ?name=), arrange=plate');
s = await open(`model=${enc(`${FILES}/files/cube.stl`)}&model=${enc(`${FILES}/dl?id=cube`)}&name=cube.stl&name=second.stl&arrange=plate`, 2);
check(s.objects.length === 2, `two objects (${s.objects.map((o) => o.name).join(', ')})`);
check(s.objects.some((o) => /second/.test(o.name)), 'second object named from ?name=');
const [a, b] = s.objects;
check(a && b && (Math.abs(a.x - b.x) >= 20 || Math.abs(a.y - b.y) >= 20), `arranged apart (${a?.x.toFixed(1)},${a?.y.toFixed(1)} / ${b?.x.toFixed(1)},${b?.y.toFixed(1)})`);
check(s.objects.every((o) => o.plate === 0), 'both on the active plate');

log('arrange=0 overrides Preferences ▸ Auto arrange after import');
const twoCubes = `model=${enc(`${FILES}/files/cube.stl`)}&model=${enc(`${FILES}/files/cube.stl`)}`;
const layout = (st) => JSON.stringify(st.objects.map((o) => [o.x, o.y]));
const withPref = await open(twoCubes, 2, { autoArrangeImport: true });
s = await open(`${twoCubes}&arrange=0`, 2, { autoArrangeImport: true });
check(s.objects.length === 2, 'two objects');
check(s.search === '', 'params cleared');
check(layout(s) !== layout(withPref), `layout differs from the preference's arrange (${layout(s)} vs ${layout(withPref)})`);

await browser.close();
server.close();
log(failures ? `${failures} failure(s)` : 'all passed');
process.exit(failures ? 1 : 0);
