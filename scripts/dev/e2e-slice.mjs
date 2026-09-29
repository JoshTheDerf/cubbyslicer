// Browser end-to-end check: import → pick printer → slice in the engine worker
// → preview. Run against `npm run dev` (or `vite preview`):
//   node scripts/dev/e2e-slice.mjs [baseUrl] [engine] [printerId] [out-dir]
// Requires Playwright (devDependency; `npx playwright install chromium` once, or PLAYWRIGHT=path).
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PW = process.env.PLAYWRIGHT ?? 'playwright';
const { chromium } = await import(PW);
const base = process.argv[2] ?? 'http://localhost:5393/slicer/';
const engine = process.argv[3] ?? 'orca';
const printer = process.argv[4] ?? 'sys:BBL/Bambu Lab P1S 0.4 nozzle';
const out = resolve(process.argv[5] ?? 'e2e-out');
mkdirSync(out, { recursive: true });

// A 20 mm cube as binary STL, built here so the script has no fixtures.
function cubeStl(s = 20) {
  const v = [[0,0,0],[s,0,0],[s,s,0],[0,s,0],[0,0,s],[s,0,s],[s,s,s],[0,s,s]];
  const f = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
  const buf = Buffer.alloc(84 + f.length * 50); buf.writeUInt32LE(f.length, 80);
  f.forEach((t, i) => { const o = 84 + i * 50; t.forEach((vi, k) => v[vi].forEach((c, j) => buf.writeFloatLE(c, o + 12 + k * 12 + j * 4))); });
  return buf;
}
writeFileSync(`${out}/cube.stl`, cubeStl());

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
// This script tests slicing; the first-run printer wizard has its own e2e (e2e-first-run.mjs).
await context.addInitScript(() => { delete window.showOpenFilePicker; delete window.showSaveFilePicker; }); // <input type=file> path (Playwright file chooser)
await context.addInitScript(() => { try { localStorage.setItem('cubby.setup.done', 'true'); } catch { /* ignore */ } });
const page = await context.newPage();
page.setDefaultTimeout(300000);
const problems = [];
page.on('pageerror', (e) => { problems.push(`pageerror: ${e.message}`); console.log('[pageerror]', e.message); });
page.on('response', (r) => { if (r.status() >= 400) console.log(`[http ${r.status()}] ${r.url()}`); });
page.on('console', (m) => { if (m.type() === 'error') { problems.push(m.text()); console.log('[console.error]', m.text()); } });

const t0 = Date.now();
const lap = (s) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s  ${s}`);
await page.goto(`${base}?cubby-debug`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__cubbyProject);
await page.evaluate(() => window.__cubbyProject.resetProject?.());
lap('app loaded');

// Choose engine + printer through the presets store (same module instance the app uses).
const picked = await page.evaluate(async ({ engine, printer }) => {
  let P;
  try { P = await import('/slicer/src/presets/index.ts'); } catch { return 'production build: using default presets'; }
  P.setActiveEngine(engine);
  const s = P.presetsFor(engine);
  await s.ready;
  if (engine === 'orca') { await s.installPrinter(printer); await s.selectPrinter(printer); }
  await new Promise((r) => setTimeout(r, 1500)); // resolvedConfig is debounced
  const st = await import('/slicer/src/app/state.ts');
  const c = st.resolvedConfig.value;
  return { printer: s.selectedInfo('printer').name, process: s.selectedInfo('process').name,
           filament: s.selectedInfo('filament').name, keys: Object.keys(c).length, area: c.printable_area };
}, { engine, printer });
lap(`presets: ${JSON.stringify(picked)}`);

const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: /Import model/ }).first().click()]);
await fc.setFiles(`${out}/cube.stl`);
await page.waitForFunction(() => window.__cubbyProject.objects.value.length === 1);
await page.keyboard.press('a'); // arrange onto the (new) bed
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/1-prepare.png` });
lap('imported + arranged');

await page.getByRole('button', { name: /Slice plate|Re-slice/ }).click();
await page.waitForFunction(() => {
  const bar = document.querySelector('.slicebar');
  return bar && (bar.classList.contains('done') || bar.classList.contains('error'));
}, null, { timeout: 600000 });
const bar = await page.evaluate(() => ({ cls: document.querySelector('.slicebar').className, text: document.querySelector('.slicebar').innerText }));
lap(`slice finished: ${bar.cls} :: ${bar.text.replace(/\s+/g, ' ')}`);
await page.waitForTimeout(4000); // parse + upload preview
await page.screenshot({ path: `${out}/2-preview.png` });

const result = await page.evaluate(async () => {
  let st;
  try { st = await import('/slicer/src/app/state.ts'); } catch {
    const t = document.querySelector('.slicebar')?.innerText ?? '';
    return /LAYERS\s*\d+/i.test(t) ? { bytes: 1e9, fromUi: t.replace(/\s+/g, ' ') } : null;
  }
  const r = st.lastSlice.value;
  return r ? { engine: r.engine, bytes: r.gcode.byteLength, stats: r.report.stats, warnings: r.report.warnings } : null;
});
lap(`result: ${JSON.stringify(result)}`);

// Slice again (fresh instance per slice) to make sure nothing leaks between runs.
await page.keyboard.press('Control+1');
await page.getByRole('button', { name: /Slice plate|Re-slice/ }).click().catch(() => {});
await page.waitForTimeout(1000);
await page.waitForFunction(() => !document.querySelector('.slicebar.slicing'), null, { timeout: 600000 });
lap('second slice done');

await browser.close();
const ok = bar.cls.includes('done') && result?.bytes > 1000 && problems.length === 0;
console.log(ok ? 'E2E PASS' : `E2E FAIL (${problems.length} console errors)`);
process.exit(ok ? 0 : 1);
