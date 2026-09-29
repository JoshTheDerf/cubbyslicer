// preFlight + converted Orca vendor printers: pick each printer, slice a cube, report.
//   [ENGINE=orca] node scripts/dev/e2e-preflight-vendors.mjs [baseUrl] [printerId...]
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const PW = process.env.PLAYWRIGHT ?? 'playwright';
const { chromium } = await import(PW);
const base = process.argv[2] ?? 'http://localhost:5393/slicer/';
const printers = process.argv.length > 3 ? process.argv.slice(3) : [
  'sys:Elegoo/Elegoo Centauri Carbon 0.4 nozzle', 'sys:BBL/Bambu Lab P1S 0.4 nozzle',
  'sys:Anycubic/Anycubic Kobra 2 0.4 nozzle', 'sys:Creality/Creality K1C 0.4 nozzle',
];
const out = resolve(process.env.OUT ?? 'e2e-out');
mkdirSync(out, { recursive: true });
function cubeStl(s = 20) {
  const v = [[0,0,0],[s,0,0],[s,s,0],[0,s,0],[0,0,s],[s,0,s],[s,s,s],[0,s,s]];
  const f = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
  const buf = Buffer.alloc(84 + f.length * 50); buf.writeUInt32LE(f.length, 80);
  f.forEach((t, i) => { const o = 84 + i * 50; t.forEach((vi, k) => v[vi].forEach((c, j) => buf.writeFloatLE(c, o + 12 + k * 12 + j * 4))); });
  return buf;
}
writeFileSync(`${out}/cube.stl`, cubeStl());
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => { delete window.showOpenFilePicker; delete window.showSaveFilePicker; }); // <input type=file> path (Playwright file chooser)
await context.addInitScript(() => { try { localStorage.setItem('cubby.setup.done', 'true'); } catch {} });
const page = await context.newPage();
page.setDefaultTimeout(600000);
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text()); });
await page.goto(`${base}?cubby-debug`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__cubbyProject);
await page.evaluate(() => window.__cubbyProject.resetProject?.());
const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: /Import model/ }).first().click()]);
await fc.setFiles(`${out}/cube.stl`);
await page.waitForFunction(() => window.__cubbyProject.objects.value.length === 1);
let failed = 0;
for (const id of printers) {
  const picked = await page.evaluate(async ({ id, ENGINE, DUMP }) => {
    const P = await import('/slicer/src/presets/index.ts');
    P.setActiveEngine(ENGINE);
    const s = P.presetsFor(ENGINE);
    await s.ready;
    await s.installPrinter(id); await s.selectPrinter(id);
    await new Promise((r) => setTimeout(r, 2000));
    const st = await import('/slicer/src/app/state.ts');
    const c = st.resolvedConfig.value;
    if (DUMP) (window.__cfgs ??= {})[id] = c;
    return { printer: s.selectedInfo('printer').name, process: s.selectedInfo('process').name, filament: s.selectedInfo('filament').name,
             bed: c.bed_shape, h: c.max_print_height, nozzle: c.nozzle_diameter, fil: s.compatible.value.filament.length, proc: s.compatible.value.process.length };
  }, { id, ENGINE: process.env.ENGINE ?? 'preflight', DUMP: !!process.env.DUMPCFG });
  console.log(`\n== ${id}\n   ${JSON.stringify(picked)}`);
  await page.keyboard.press('a');
  await page.waitForTimeout(800);
  const r = await page.evaluate(async () => {
    const { useSliceController } = await import('/slicer/src/app/slice.ts');
    const st = await import('/slicer/src/app/state.ts');
    const c = useSliceController();
    const ok = await c.slice();
    const res = st.lastSlice.value;
    const g = ok && res ? new TextDecoder().decode(res.gcode.subarray(0, 400000)) : '';
    window.__lastGcode = ok && res ? new TextDecoder().decode(res.gcode) : '';
    const lines = g.split('\n');
    const firstMoves = lines.filter((l) => /^(M104|M109|M140|M190|PRINT_START|START_PRINT)/.test(l)).slice(0, 8);
    return { ok, error: c.error.value, warnings: res?.report.warnings?.map((w) => w.message).slice(0, 5), stats: ok ? res.report.stats : null, firstMoves, bytes: res?.gcode.byteLength };
  });
  console.log(`   ok=${r.ok} error=${r.error}\n   stats=${JSON.stringify(r.stats)}\n   warnings=${JSON.stringify(r.warnings)}\n   start=${JSON.stringify(r.firstMoves)}`);
  if (!r.ok) failed++;
  if (process.env.DUMPCFG && r.ok) writeFileSync(`${process.env.DUMPCFG}.${id.replace(/[^\w]+/g, '_')}.gcode`, await page.evaluate(() => window.__lastGcode));
}
if (process.env.DUMPCFG) writeFileSync(process.env.DUMPCFG, JSON.stringify(await page.evaluate(() => window.__cfgs)));
await browser.close();
console.log(failed ? `FAIL (${failed})` : 'PREFLIGHT VENDORS PASS');
process.exit(failed ? 1 : 0);
