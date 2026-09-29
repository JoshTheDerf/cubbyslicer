// Capture the README / docs screenshots from a running build.
//
//   npm run build && npx vite preview --port 5399      (or any deployed URL)
//   node scripts/dev/screenshots.mjs http://localhost:5399/slicer/ [outDir=docs/screenshots]
//
// Uses ?cubby-debug hooks (window.__cubbyProject / __cubbyActions / __cubbyPresets)
// to set up scenes; software WebGL is fine (a few minutes per slice).
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PW = process.env.PLAYWRIGHT ?? 'playwright';
const { chromium } = await import(PW);
const base = process.argv[2] ?? 'http://localhost:5399/slicer/';
const out = resolve(process.argv[3] ?? 'docs/screenshots');
mkdirSync(out, { recursive: true });

function stl(tris) {
  const buf = Buffer.alloc(84 + tris.length * 50); buf.writeUInt32LE(tris.length, 80);
  tris.forEach((t, i) => { const o = 84 + i * 50; t.forEach((v, k) => v.forEach((c, j) => buf.writeFloatLE(c, o + 12 + k * 12 + j * 4))); });
  return buf;
}
const box = (x0, y0, z0, x1, y1, z1) => {
  const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  return [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]].map((t) => t.map((i) => v[i]));
};
const cube = resolve(out, '.cube.stl');
writeFileSync(cube, stl(box(0, 0, 0, 40, 40, 40)));

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
async function session(viewport = { width: 1440, height: 900 }, engine = 'orca') {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => { delete window.showOpenFilePicker; delete window.showSaveFilePicker; }); // <input type=file> path (Playwright file chooser)
  await ctx.addInitScript((e) => {
    try { localStorage.setItem('cubby.setup.done', 'true'); localStorage.setItem('cubby.presets.v1.activeEngine', JSON.stringify(e)); } catch { /* */ }
  }, engine);
  const page = await ctx.newPage();
  page.setDefaultTimeout(600000);
  await page.goto(`${base}?cubby-debug`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__cubbyProject && !!window.__cubbyPresets);
  await page.evaluate(() => window.__cubbyProject.resetProject?.());
  await page.waitForTimeout(2500);
  return { ctx, page };
}
const act = (page, id) => page.evaluate((i) => { const A = window.__cubbyActions; return A.runAction(A.getAction(i), A.getActionContext()); }, id);
const blur = (page) => page.evaluate(() => document.activeElement?.blur?.());
async function handy(page, id, n = 1) {
  await act(page, `handy.${id}`);
  await page.waitForFunction((k) => window.__cubbyProject.objects.value.length >= k, n);
  await page.waitForTimeout(1500);
}
async function colours(page, list) {
  await page.evaluate(async (cs) => {
    const p = window.__cubbyPresets.currentPresets.value;
    if (p.selection.filaments.length < cs.length) await p.setFilamentCount(cs.length);
    cs.forEach((c, i) => p.setFilamentColour(i, c));
  }, list);
  await page.waitForTimeout(1200);
}
async function slice(page) {
  await page.getByRole('button', { name: /^(Slice plate|Re-slice)/ }).first().click();
  await page.waitForFunction(() => { const b = document.querySelector('button[aria-label="Export G-code"]'); return b && !b.disabled; }, null, { timeout: 900000 });
  await page.waitForTimeout(4000);
}
const shot = async (page, name) => { await page.screenshot({ path: resolve(out, `${name}.png`) }); console.log('wrote', name); };

// 1. Prepare: Benchy on the default printer.
{
  const { ctx, page } = await session();
  await handy(page, 'benchy');
  await act(page, 'view.fit-selection');
  await page.waitForTimeout(1500);
  await shot(page, 'prepare');
  // 2. Preview after slicing.
  await slice(page);
  await shot(page, 'preview');
  await ctx.close();
}

// 3. Colour painting (two filaments) + 4. cut tool with a connector.
{
  const { ctx, page } = await session();
  await colours(page, ['#E8E8E8', '#E4572E']);
  await handy(page, 'calicat');
  await act(page, 'view.fit-selection'); await page.waitForTimeout(800);
  await blur(page); await page.keyboard.press('n');
  await page.waitForSelector('.pp'); await page.waitForTimeout(2500);
  await page.locator('.pp__swatch').nth(1).click();
  await page.getByRole('radio', { name: 'Height range' }).click();
  const hs = page.locator('.pp__field [role="slider"]').first();
  await hs.focus(); for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowRight');
  const b = await page.locator('canvas').first().boundingBox();
  for (const dy of [-90, 40]) {
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2 + dy); await page.mouse.down(); await page.mouse.up();
    await page.waitForTimeout(1500);
  }
  await page.waitForTimeout(1500);
  await shot(page, 'paint-color');
  await page.keyboard.press('Escape');
  await ctx.close();
}
{
  const { ctx, page } = await session();
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: /Import model/ }).first().click()]);
  await fc.setFiles([cube]);
  await page.waitForFunction(() => window.__cubbyProject.objects.value.length === 1);
  await act(page, 'view.fit-selection'); await page.waitForTimeout(800);
  await blur(page); await page.keyboard.press('c');
  await page.waitForSelector('section[aria-label="Cut"]');
  await page.getByRole('tab', { name: 'Connectors' }).click();
  const o = await page.evaluate(() => window.__cubbyProject.objects.value[0].position);
  for (const [dx, dy] of [[-8, -8], [8, 8]]) {
    const q = await page.evaluate(([x, y]) => window.__cubbyTools.project(x, y, 20), [o[0] + dx, o[1] + dy]);
    await page.mouse.move(q[0], q[1]); await page.mouse.click(q[0], q[1]); await page.waitForTimeout(400);
  }
  await page.getByRole('tab', { name: 'Cut' }).click();
  await page.waitForTimeout(800);
  await shot(page, 'cut');
  await ctx.close();
}

// 5. Calibration menu, 6. preFlight (orange) with the settings.
{
  const { ctx, page } = await session();
  await page.locator('[data-menu="calibration"]').click();
  await page.waitForTimeout(800);
  await shot(page, 'calibration-menu');
  await ctx.close();
}
{
  const { ctx, page } = await session(undefined, 'preflight');
  await handy(page, 'voron-cube');
  await act(page, 'view.fit-selection'); await page.waitForTimeout(1500);
  await shot(page, 'preflight');
  await ctx.close();
}

// 7. Full Spectrum: four colours, mixed filaments + the gradient editor, and a sliced gradient.
{
  const { ctx, page } = await session(undefined, 'fullspectrum');
  await page.waitForSelector('.mf', { timeout: 120000 });
  await colours(page, ['#E63946', '#F1C453', '#1D6FD8', '#F4F1EA']);
  await page.waitForTimeout(3000);
  await page.getByRole('button', { name: 'Add mixed filament' }).click();
  await page.getByRole('radio', { name: 'Gradient' }).click();
  await page.getByRole('button', { name: 'Filament', exact: true }).click();
  await page.waitForTimeout(800);
  await shot(page, 'mixed-gradient-editor');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.waitForTimeout(3000);
  await handy(page, 'calicat');
  const id = await page.evaluate(() => Number([...document.querySelectorAll('.mf__row')].pop()?.querySelector('.mf__no')?.textContent));
  await page.evaluate((i) => { const P = window.__cubbyProject; P.setObjectOverride(P.objects.value[0].id, 'extruder', String(i)); }, id);
  await act(page, 'view.fit-selection'); await page.waitForTimeout(1200);
  await shot(page, 'mixed-filaments');
  await slice(page);
  await shot(page, 'mixed-preview');
  await ctx.close();
}

// 8. Phone layout.
{
  const { ctx, page } = await session({ width: 390, height: 844 });
  await handy(page, 'benchy');
  await page.waitForTimeout(1500);
  await shot(page, 'mobile');
  await ctx.close();
}

await browser.close();
