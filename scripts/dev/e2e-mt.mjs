// Browser check of the multi-threaded engine: slice the same heavy model with
// the page cross-origin isolated (MT build) and with the COOP/COEP headers
// stripped (single-threaded fallback), and compare. Run against a build served
// with the COI headers (vite.config.ts sets them for dev + preview):
//   npx vite build --outDir dist-staging-mt && npx vite preview --outDir dist-staging-mt --port 5394
//   node scripts/dev/e2e-mt.mjs [baseUrl] [out-dir]
// Requires Playwright (devDependency; `npx playwright install chromium` once, or PLAYWRIGHT=path).
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PW = process.env.PLAYWRIGHT ?? 'playwright';
const { chromium } = await import(PW);
const base = process.argv[2] ?? 'http://localhost:5394/slicer/';
const out = resolve(process.argv[3] ?? 'e2e-out');
mkdirSync(out, { recursive: true });

// ~200k-triangle torus (same shape as orcaslicer-wasm/tests/cs-slice-test.mjs), binary STL.
function torusStl(R = 40, r = 12, nu = 500, nv = 200) {
  const P = (u, v) => {
    const a = (u / nu) * 2 * Math.PI, b = (v / nv) * 2 * Math.PI;
    return [(R + r * Math.cos(b)) * Math.cos(a), (R + r * Math.cos(b)) * Math.sin(a), r * Math.sin(b) + r];
  };
  const tris = [];
  for (let u = 0; u < nu; u++) for (let v = 0; v < nv; v++) {
    const a = P(u, v), b = P(u + 1, v), c = P(u + 1, v + 1), d = P(u, v + 1);
    tris.push([a, b, c], [a, c, d]);
  }
  const buf = Buffer.alloc(84 + tris.length * 50); buf.writeUInt32LE(tris.length, 80);
  tris.forEach((t, i) => { const o = 84 + i * 50; t.forEach((p, k) => p.forEach((c, j) => buf.writeFloatLE(c, o + 12 + k * 12 + j * 4))); });
  return buf;
}
writeFileSync(`${out}/torus200k.stl`, torusStl());

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

async function run(label, stripCoi) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => { delete window.showOpenFilePicker; delete window.showSaveFilePicker; }); // <input type=file> path (Playwright file chooser)
  await context.addInitScript(() => { try { localStorage.setItem('cubby.setup.done', 'true'); } catch { /* ignore */ } });
  if (stripCoi) {
    const origin = new URL(base).origin;
    await context.route((u) => u.origin === origin, async (route) => {
      try {
        const rsp = await route.fetch();
        const headers = { ...rsp.headers() };
        delete headers['cross-origin-opener-policy'];
        delete headers['cross-origin-embedder-policy'];
        await route.fulfill({ response: rsp, headers });
      } catch { /* context closing */ }
    });
  }
  const page = await context.newPage();
  page.setDefaultTimeout(600000);
  const problems = [], engineLog = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    const t = m.text();
    if (/\[orca\] (engine|slice|multi)/.test(t) && !engineLog.includes(t)) engineLog.push(t);
    if (m.type() === 'error') problems.push(t);
  });
  page.on('worker', (w) => w.on('console', (m) => {
    const t = m.text();
    if (/\[orca\] (engine|slice|multi)/.test(t) && !engineLog.includes(t)) engineLog.push(t);
  }));
  await page.goto(`${base}?cubby-debug`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.__cubbyProject);
  await page.evaluate(() => window.__cubbyProject.resetProject?.());
  const coi = await page.evaluate(() => globalThis.crossOriginIsolated === true);
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: /Import model/ }).first().click()]);
  await fc.setFiles(`${out}/torus200k.stl`);
  await page.waitForFunction(() => window.__cubbyProject.objects.value.length === 1);
  await page.keyboard.press('a');
  await page.waitForTimeout(500);

  const times = [];
  for (let i = 0; i < 2; i++) {
    const t = Date.now();
    await page.getByRole('button', { name: /Slice plate|Re-slice/ }).click();
    await page.waitForTimeout(300);
    await page.waitForFunction(() => {
      const bar = document.querySelector('.slicebar');
      return bar && !bar.classList.contains('slicing') && (bar.classList.contains('done') || bar.classList.contains('error'));
    }, null, { timeout: 600000 });
    times.push(Date.now() - t);
    if (i === 0) {
      await page.keyboard.press('Control+1'); // back to Prepare so "Slice plate" re-slices
      await page.waitForTimeout(300);
    }
  }
  const bar = await page.evaluate(() => ({ cls: document.querySelector('.slicebar').className, text: document.querySelector('.slicebar').innerText }));
  await page.screenshot({ path: `${out}/mt-${label}.png` });
  await context.unrouteAll({ behavior: 'ignoreErrors' });
  await context.close();
  return { label, coi, ok: bar.cls.includes('done'), bar: bar.text.replace(/\s+/g, ' ').slice(0, 160), wallMs: times, engineLog, problems };
}

const mt = await run('coi', false);
const st = await run('no-coi', true);
await browser.close();
for (const r of [mt, st]) console.log(JSON.stringify(r, null, 2));
const pass = mt.ok && st.ok && mt.coi && !st.coi
  && mt.engineLog.some((l) => /multi-threaded/.test(l)) && st.engineLog.some((l) => /single-threaded/.test(l))
  && mt.problems.length === 0 && st.problems.length === 0;
console.log(pass ? 'E2E-MT PASS' : 'E2E-MT FAIL');
process.exit(pass ? 0 : 1);
