// Multi-object slice: records progress/status transitions and worker slice requests.
//   node scripts/dev/e2e-multi.mjs [baseUrl] [count]
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const PW = process.env.PLAYWRIGHT ?? 'playwright';
const { chromium } = await import(PW);
const base = process.argv[2] ?? 'http://localhost:5393/slicer/';
const count = Number(process.argv[3] ?? 4);
const out = resolve(process.env.OUT ?? 'e2e-out');
mkdirSync(out, { recursive: true });
function cubeStl(s = 20) {
  const v = [[0,0,0],[s,0,0],[s,s,0],[0,s,0],[0,0,s],[s,0,s],[s,s,s],[0,s,s]];
  const f = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
  const buf = Buffer.alloc(84 + f.length * 50); buf.writeUInt32LE(f.length, 80);
  f.forEach((t, i) => { const o = 84 + i * 50; t.forEach((vi, k) => v[vi].forEach((c, j) => buf.writeFloatLE(c, o + 12 + k * 12 + j * 4))); });
  return buf;
}
const files = [];
for (let i = 0; i < count; i++) { const p = `${out}/cube${i}.stl`; writeFileSync(p, cubeStl(15 + i * 3)); files.push(p); }
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => { delete window.showOpenFilePicker; delete window.showSaveFilePicker; }); // <input type=file> path (Playwright file chooser)
await context.addInitScript(() => {
  try { localStorage.setItem('cubby.setup.done', 'true'); } catch {}
  window.__log = [];
  const t0 = performance.now();
  const P = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (m, t) {
    if (m && typeof m === 'object' && m.type) window.__log.push(`${((performance.now() - t0) / 1000).toFixed(2)} ->worker ${m.type}${m.id != null ? '#' + m.id : ''}`);
    return P.call(this, m, t);
  };
});
const page = await context.newPage();
page.setDefaultTimeout(600000);
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text()); });
await page.goto(`${base}?cubby-debug`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__cubbyProject);
await page.evaluate(() => window.__cubbyProject.resetProject?.());
const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: /Import model/ }).first().click()]);
await fc.setFiles(files);
await page.waitForFunction((n) => window.__cubbyProject.objects.value.length === n, count);
await page.keyboard.press('a');
await page.waitForTimeout(1500);
await page.evaluate(() => {
  const t0 = performance.now(); let last = '';
  const tick = () => {
    const b = document.querySelector('.slicebar');
    const s = b ? `${b.className} | ${b.innerText.replace(/\s+/g, ' ')}` : 'no-bar';
    if (s !== last) { window.__log.push(`${((performance.now() - t0) / 1000).toFixed(2)} UI ${s}`); last = s; }
    window.__tick = requestAnimationFrame(tick);
  };
  tick();
});
const t0 = Date.now();
await page.getByRole('button', { name: /Slice plate|Re-slice/ }).click();
await page.waitForTimeout(500);
await page.waitForFunction(() => { const b = document.querySelector('.slicebar'); return b && !b.classList.contains('slicing'); }, null, { timeout: 600000 });
console.log(`slice took ${((Date.now() - t0) / 1000).toFixed(1)}s`);
await page.waitForTimeout(3000);
const extra = await page.evaluate(async () => {
  try {
    const st = await import('/slicer/src/app/state.ts');
    return { report: st.lastSlice.value?.report, config: st.resolvedConfig.value };
  } catch { return null; }
});
if (extra) {
  writeFileSync(`${out}/multi-config.json`, JSON.stringify(extra.config));
  console.log('timings', JSON.stringify(extra.report?.timings), 'stats', JSON.stringify(extra.report?.stats));
}
const log = await page.evaluate(() => window.__log);
console.log(log.join('\n'));
await browser.close();
