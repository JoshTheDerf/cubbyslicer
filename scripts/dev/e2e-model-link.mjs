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

/** Binary STL of an axis-aligned w × d × h box (corner at the origin). */
function boxStl(w, d = w, h = w) {
  const v = [[0,0,0],[w,0,0],[w,d,0],[0,d,0],[0,0,h],[w,0,h],[w,d,h],[0,d,h]];
  const f = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
  const b = Buffer.alloc(84 + f.length * 50);
  b.writeUInt32LE(f.length, 80);
  f.forEach((t, i) => t.forEach((vi, k) => v[vi].forEach((c, j) => b.writeFloatLE(c, 84 + i * 50 + 12 + k * 12 + j * 4))));
  return b;
}
const CUBE = boxStl(20);
let BAR = null; // sized to the printer's bed once the page tells us

const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Disposition' };
  if (u.pathname === '/files/bar.stl' && BAR) return res.writeHead(200, { ...cors, 'Content-Type': 'model/stl' }).end(BAR);
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
async function open(query, n, prefs, { arrangeSettings, then, arranged = /arrange=(all|plate|1)/.test(query) } = {}) {
  const ctx = await browser.newContext(); // fresh per case: each loads the engine (MT: a large shared heap)
  const page = await ctx.newPage();
  if (prefs) await page.addInitScript((p) => localStorage.setItem('cubby-slicer:preferences', JSON.stringify(p)), prefs);
  if (arrangeSettings) await page.addInitScript((a) => localStorage.setItem('cubby-slicer:arrange', JSON.stringify(a)), arrangeSettings);
  const errors = [], logs = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' || /arrange|engine|model/i.test(m.text())) logs.push(`${m.type()}: ${m.text().slice(0, 200)}`); });
  await page.goto(`${SLICER_URL}${SLICER_URL.includes("?") ? "&" : "?"}${query}`);
  try {
    await page.waitForFunction((n) => (window.__cubbyProject?.objects.value.length ?? 0) >= n, n, { timeout: 120000 });
  } catch (e) {
    const info = await page.evaluate(() => ({ n: window.__cubbyProject?.objects.value.length, url: location.href, toasts: [...document.querySelectorAll('[data-slot="title"], [data-slot="description"]')].map((x) => x.textContent) })).catch(() => null);
    console.log('LOAD TIMEOUT', JSON.stringify(info), errors, logs.slice(-15));
    throw e;
  }
  await page.waitForTimeout(500);
  if (then) await page.evaluate(then);
  // Orca's arrange runs on the engine after loading: wait for its undo step.
  if (arranged || then) await page.waitForFunction(() => window.__cubbyProject.historyState.value.undo === 'Arrange', null, { timeout: 120000 });
  await page.waitForTimeout(300);
  const state = await page.evaluate(() => {
    const p = window.__cubbyProject;
    return {
      search: location.search.replace(/[?&]cubby-debug=?(?=&|$)/, ''), // the debug flag stays by design
      objects: p.objects.value.map((o) => {
        const i = p.objectInfo.value.get(o.id);
        return { name: o.name, x: o.position[0], y: o.position[1], plate: p.plateOf(o.id), issues: p.objectIssues.value.get(o.id) ?? [],
          min: i ? [i.min[0], i.min[1]] : null, max: i ? [i.max[0], i.max[1]] : null, rot: [...o.rotation] };
      }),
      bed: { min: p.bed.value.min, max: p.bed.value.max },
      plates: p.plates.value.length,
      project: p.projectName.value,
    };
  });
  await ctx.close();
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

/** Smallest axis-aligned gap between two objects' footprints (for unrotated boxes). */
const gapOf = (a, b) => Math.max(b.min[0] - a.max[0], a.min[0] - b.max[0], b.min[1] - a.max[1], a.min[1] - b.max[1]);

log('Orca arrange spacing from links');
s = await open(`${twoCubes}&arrange=plate`, 2);
check(Math.abs(gapOf(s.objects[0], s.objects[1]) - 2) < 0.1, `auto spacing → ${gapOf(s.objects[0], s.objects[1]).toFixed(2)} mm (Orca: brim 1 mm each)`);
s = await open(`${twoCubes}&arrange=plate&spacing=20`, 2);
check(Math.abs(gapOf(s.objects[0], s.objects[1]) - 20) < 0.1, `spacing=20 → ${gapOf(s.objects[0], s.objects[1]).toFixed(2)} mm`);

log('auto rotate: on by default for links');
const probe = await open(`model=${enc(`${FILES}/files/cube.stl`)}&arrange=0`, 1);
const bw = probe.bed.max[0] - probe.bed.min[0], bd = probe.bed.max[1] - probe.bed.min[1];
BAR = boxStl(Math.min(bw, bd) + 30, 15, 5); // only fits diagonally
const bar = `model=${enc(`${FILES}/files/bar.stl`)}`;
s = await open(`${bar}&arrange=plate`, 1);
check(s.objects[0].plate === 0 && !s.objects[0].issues.length && Math.abs(s.objects[0].rot[2]) > 0.01,
  `bar ${(Math.min(bw, bd) + 30).toFixed(0)} mm on a ${bw}×${bd} bed fits rotated (issues ${JSON.stringify(s.objects[0].issues)}, q=${s.objects[0].rot.map((v) => v.toFixed(3))})`);
s = await open(`${bar}&arrange=plate&rotate=0`, 1);
check(s.objects[0].plate !== 0 || s.objects[0].issues.length > 0, `rotate=0 → bar not placed on the plate (plate ${s.objects[0].plate}, issues ${JSON.stringify(s.objects[0].issues)})`);

log('saved Arrange options drive Shift+A');
s = await open(`${twoCubes}&arrange=0`, 2, null, {
  arrangeSettings: { fff: { distance: 15, enableRotation: false }, seqPrint: { distance: 0, enableRotation: false }, allowMultiMaterials: true, avoidCaliRegion: true, alignToYAxis: false },
  then: () => { const A = window.__cubbyActions; return A.runAction(A.getAction('arrange.plate'), A.getActionContext()); },
});
check(Math.abs(gapOf(s.objects[0], s.objects[1]) - 15) < 0.1, `saved spacing 15 → ${gapOf(s.objects[0], s.objects[1]).toFixed(2)} mm`);

await browser.close();
server.close();
log(failures ? `${failures} failure(s)` : 'all passed');
process.exit(failures ? 1 : 0);
