// Tools e2e: measure, text, SVG, simplify, boolean, brim ears, STEP import, OBJ colours.
//   node scripts/dev/e2e-tools.mjs [baseUrl] [out-dir]
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');
const base = process.argv[2] ?? 'http://localhost:5393/slicer/';
const out = resolve(process.argv[3] ?? 'e2e-out/tools'); mkdirSync(out, { recursive: true });
const only = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const want = (k) => !only || only.has(k);

process.on('uncaughtException', (e) => { console.log('FAILED:', e.message, '\nerrs:', JSON.stringify(errs, null, 1)); process.exit(1); });
process.on('unhandledRejection', (e) => { console.log('FAILED:', e?.message, '\nerrs:', JSON.stringify(errs, null, 1)); process.exit(1); });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const results = {};
const errs = [];

async function newPage(viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport, hasTouch: viewport.width < 700 });
  await ctx.addInitScript(() => { delete window.showOpenFilePicker; delete window.showSaveFilePicker; }); // <input type=file> path (Playwright file chooser)
  await ctx.addInitScript(() => { try { localStorage.setItem('cubby.setup.done', 'true'); } catch {} });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);
  page.on('pageerror', (e) => errs.push(`[pageerror] ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errs.push(`[console] ${m.text()}`); });
  await page.goto(`${base}?cubby-debug`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.__cubbyProject && !!window.__cubbyTools);
  await page.evaluate(() => window.__cubbyProject.resetProject());
  await page.waitForTimeout(500);
  return page;
}

/** Add a box (w×d×h, mm) as an object via the store; returns its id. */
async function addBox(page, w, d, h, name = 'Box') {
  return page.evaluate(([w, d, h, name]) => {
    const x = w / 2, y = d / 2, z = h / 2;
    const positions = new Float32Array([-x, -y, -z, x, -y, -z, x, y, -z, -x, y, -z, -x, -y, z, x, -y, z, x, y, z, -x, y, z]);
    const indices = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]);
    return window.__cubbyProject.addParsedObjects([{ name, positions, indices, transform: null }])[0];
  }, [w, d, h, name]);
}

async function screenPoint(page, id, local) {
  return page.evaluate(([id, local]) => {
    const o = window.__cubbyProject.getObject(id);
    const [x, y, z] = [o.position[0] + local[0] * o.scale[0], o.position[1] + local[1] * o.scale[1], o.position[2] + local[2] * o.scale[2]];
    return window.__cubbyTools.project(x, y, z);
  }, [id, local]);
}

async function fit(page) {
  await page.evaluate(() => { const A = window.__cubbyActions; const a = A.getAction('view.fit-selection'); if (a) return A.runAction(a, A.getActionContext()); });
  await page.waitForTimeout(500);
}

async function focusCanvas(page) {
  // Keyboard shortcuts dispatch when focus is idle (body / canvas).
  await page.evaluate(() => { document.activeElement?.blur?.(); });
}

// ---------------------------------------------------------------------------------
if (want('measure')) {
  const page = await newPage();
  const id = await addBox(page, 30, 20, 10, 'Block');
  await page.evaluate((id) => window.__cubbyProject.select([id]), id);
  await fit(page);
  await focusCanvas(page);
  await page.keyboard.press('u');
  await page.getByRole('region', { name: 'Measure' }).waitFor();
  const top = await screenPoint(page, id, [3, 2, 5]);
  const front = await screenPoint(page, id, [4, -10, 1]);
  await page.mouse.move(top[0], top[1]); await page.waitForTimeout(200);
  await page.mouse.click(top[0], top[1]); await page.waitForTimeout(200);
  await page.mouse.move(front[0], front[1]); await page.waitForTimeout(200);
  await page.mouse.click(front[0], front[1]); await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/measure-planes.png` });
  const panel = (await page.getByRole('region', { name: 'Measure' }).innerText()).replace(/\s+/g, ' ');
  // Restart and measure two top edges' endpoints (point-point): corners of the top face.
  await page.getByRole('button', { name: 'Restart selection' }).click();
  await page.screenshot({ path: `${out}/measure-restart.png` });
  const c1 = await screenPoint(page, id, [-15, -10, 5]);
  const c2 = await screenPoint(page, id, [15, -10, 5]);
  await page.mouse.click(c1[0], c1[1]); await page.waitForTimeout(150);
  await page.mouse.click(c2[0], c2[1]); await page.waitForTimeout(300);
  const panel2 = (await page.getByRole('region', { name: 'Measure' }).innerText()).replace(/\s+/g, ' ');
  await page.screenshot({ path: `${out}/measure-points.png` });
  // Scale to 60 mm (the 30 mm edge) → object scale ×2.
  const scaleInput = page.getByRole('spinbutton', { name: 'Target distance in mm' });
  let scale = null;
  if (await scaleInput.count()) {
    await scaleInput.fill('60'); await scaleInput.press('Enter'); await page.waitForTimeout(300);
    scale = await page.evaluate((id) => window.__cubbyProject.getObject(id).scale, id);
  }
  results.measure = { panel, panel2, scale, ok: /Angle 90/.test(panel) && /Distance 30/.test(panel2) && scale && Math.abs(scale[0] - 2) < 0.05 };
  await focusCanvas(page);
  await page.keyboard.press('Escape');
  results.measure.closedByEsc = await page.evaluate(() => window.__cubbyTools.toolState.active === null);
  await page.context().close();
}

if (want('text')) {
  const page = await newPage();
  const id = await addBox(page, 40, 20, 20, 'Plaque');
  await page.evaluate((id) => window.__cubbyProject.select([id]), id);
  await fit(page);
  await focusCanvas(page);
  await page.keyboard.press('t');
  const panel = page.getByRole('region', { name: 'Add text' });
  await panel.waitFor();
  await panel.getByRole('textbox', { name: 'Text' }).fill('Cubby');
  await page.waitForTimeout(600);
  const front = await screenPoint(page, id, [0, -10, 0]);
  await page.mouse.move(front[0], front[1]); await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/text-hover.png` });
  await page.mouse.click(front[0], front[1]);
  await page.waitForFunction((id) => (window.__cubbyProject.getObject(id).parts ?? []).length === 1, id, { timeout: 20000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/text-placed.png` });
  const part = await page.evaluate((id) => { const p = window.__cubbyProject.getObject(id).parts[0]; return { name: p.name, type: p.type, emboss: p.emboss, meshId: p.meshId }; }, id);
  // Edit: change height → mesh replaced, emboss updated.
  const edit = page.getByRole('region', { name: 'Edit text' });
  await edit.waitFor();
  await edit.getByRole('spinbutton', { name: 'Text height (mm)' }).fill('6');
  await edit.getByRole('spinbutton', { name: 'Text height (mm)' }).press('Tab');
  await page.waitForFunction((id) => window.__cubbyProject.getObject(id).parts[0].emboss.size === 6, id, { timeout: 10000 });
  const after = await page.evaluate((id) => window.__cubbyProject.getObject(id).parts[0].meshId, id);
  await page.screenshot({ path: `${out}/text-edited.png` });
  // Undo twice → part gone.
  await page.evaluate(() => { window.__cubbyProject.undo(); window.__cubbyProject.undo(); });
  const partsAfterUndo = await page.evaluate((id) => (window.__cubbyProject.getObject(id).parts ?? []).length, id);
  // New text object on the plate.
  await page.evaluate(() => { window.__cubbyTools.closeTool(); window.__cubbyProject.clearSelection(); window.__cubbyTools.openTool('text', { newObject: true }); });
  await page.getByRole('region', { name: 'Add text' }).getByRole('button', { name: 'Add', exact: true }).click();
  await page.waitForFunction(() => window.__cubbyProject.objects.value.length === 2, null, { timeout: 20000 });
  const textObj = await page.evaluate(() => { const o = window.__cubbyProject.objects.value[1]; return { name: o.name, kind: o.emboss?.kind }; });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/text-object.png` });
  results.text = { part, meshChanged: after !== part.meshId, partsAfterUndo, textObj, ok: part.type === 'part' && part.emboss?.text === 'Cubby' && after !== part.meshId && partsAfterUndo === 0 && textObj.kind === 'text' };
  await page.context().close();
}

if (want('svg')) {
  const page = await newPage();
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><path d="M10 10 H90 V90 H10 Z M30 30 V70 H70 V30 Z" fill="#000" fill-rule="evenodd"/><circle cx="50" cy="50" r="8" fill="#000"/><path d="M0 95 L100 95" stroke="#000" stroke-width="4"/></svg>';
  await page.evaluate((svg) => window.__cubbyTools.openTool('svg', { newObject: true, svgFile: { name: 'logo.svg', text: svg } }), svg);
  const panel = page.getByRole('region', { name: 'Add SVG' });
  await panel.waitFor();
  await page.waitForTimeout(500);
  await panel.getByRole('button', { name: 'Add', exact: true }).click();
  await page.waitForFunction(() => window.__cubbyProject.objects.value.length === 1, null, { timeout: 20000 });
  await fit(page);
  await page.screenshot({ path: `${out}/svg-object.png` });
  const o = await page.evaluate(() => { const o = window.__cubbyProject.objects.value[0]; const m = window.__cubbyProject.getMesh(o.meshId); return { name: o.name, kind: o.emboss?.kind, width: o.emboss?.width, tris: m.triangleCount, bbox: m.bbox }; });
  results.svg = { ...o, ok: o.kind === 'svg' && o.tris > 50 && Math.abs(o.bbox.max[0] - o.bbox.min[0] - o.width) < 0.5 };
  await page.context().close();
}

if (want('simplify')) {
  const page = await newPage();
  const id = await page.evaluate(() => {
    const rings = 60, segs = 120, r = 15, pos = [0, 0, -r], idx = [];
    for (let j = 1; j < rings; j++) { const phi = -Math.PI / 2 + (j / rings) * Math.PI; for (let i = 0; i < segs; i++) { const th = (i / segs) * Math.PI * 2; pos.push(Math.cos(phi) * Math.cos(th) * r, Math.cos(phi) * Math.sin(th) * r, Math.sin(phi) * r); } }
    pos.push(0, 0, r); const top = pos.length / 3 - 1; const ring = (j, i) => 1 + (j - 1) * segs + (i % segs);
    for (let i = 0; i < segs; i++) idx.push(0, ring(1, i + 1), ring(1, i));
    for (let j = 1; j < rings - 1; j++) for (let i = 0; i < segs; i++) { const a = ring(j, i), b = ring(j, i + 1), c = ring(j + 1, i + 1), d = ring(j + 1, i); idx.push(a, b, c, a, c, d); }
    for (let i = 0; i < segs; i++) idx.push(top, ring(rings - 1, i), ring(rings - 1, i + 1));
    return window.__cubbyProject.addParsedObjects([{ name: 'Sphere', positions: new Float32Array(pos), indices: new Uint32Array(idx), transform: null }])[0];
  });
  const before = await page.evaluate((id) => window.__cubbyProject.getMesh(window.__cubbyProject.getObject(id).meshId).triangleCount, id);
  await page.evaluate((id) => window.__cubbyProject.select([id]), id); await fit(page);
  await page.waitForTimeout(400);
  await page.evaluate(() => window.__cubbyTools.openTool('simplify'));
  const panel = page.getByRole('region', { name: 'Simplify model' });
  await panel.waitFor();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/simplify-wait.png` });
  await page.waitForFunction(() => !document.querySelector('[aria-label="Simplify model"] .animate-spin') && /Result\s*[\d,]+/.test(document.querySelector('[aria-label="Simplify model"]')?.textContent ?? ''), null, { timeout: 30000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/simplify-preview.png` });
  await panel.getByRole('button', { name: 'Apply' }).click();
  await page.waitForTimeout(400);
  const after = await page.evaluate((id) => window.__cubbyProject.getMesh(window.__cubbyProject.getObject(id).meshId).triangleCount, id);
  results.simplify = { before, after, ok: after < before * 0.3 && after > before * 0.1 };
  await page.context().close();
}

if (want('boolean')) {
  const page = await newPage();
  const a = await addBox(page, 30, 30, 20, 'A');
  const b = await addBox(page, 10, 10, 40, 'B');
  // Put B through the middle of A.
  await page.evaluate(([a, b]) => { const A = window.__cubbyProject.getObject(a); window.__cubbyProject.setTransforms([{ id: b, position: [A.position[0], A.position[1], 0] }], 'Move', { drop: false }); window.__cubbyProject.select([a, b]); }, [a, b]);
  await focusCanvas(page);
  await page.keyboard.press('b');
  const panel = page.getByRole('region', { name: 'Mesh boolean' });
  await panel.waitFor();
  await page.screenshot({ path: `${out}/boolean-panel.png` });
  await panel.getByRole('button', { name: 'Difference' }).last().click();
  await page.waitForFunction(() => window.__cubbyProject.objects.value.length === 1, null, { timeout: 30000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/boolean-result.png` });
  const r = await page.evaluate(() => { const o = window.__cubbyProject.objects.value[0]; const m = window.__cubbyProject.getMesh(o.meshId); return { name: o.name, tris: m.triangleCount }; });
  results.boolean = { ...r, ok: r.name === 'A' && r.tris > 12 };
  await page.context().close();
}

if (want('brim')) {
  const page = await newPage();
  const id = await addBox(page, 30, 20, 10, 'Brimmed');
  await page.evaluate((id) => window.__cubbyProject.select([id]), id); await fit(page);
  await page.waitForTimeout(500);
  await focusCanvas(page);
  await page.keyboard.press('e');
  const panel = page.getByRole('region', { name: 'Brim ears' });
  await panel.waitFor();
  await panel.getByRole('button', { name: 'Auto-generate' }).click();
  await page.waitForTimeout(300);
  const side = await screenPoint(page, id, [0, -10, -3]);
  await page.mouse.click(side[0], side[1]);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/brim-ears.png` });
  const pts = await page.evaluate((id) => window.__cubbyProject.getObject(id).brimPoints ?? [], id);
  const slice = await page.evaluate(() => window.__cubbyProject.getSliceObjects()[0].brimPoints?.length ?? 0);
  const hasWarn = await panel.getByText('Brim type is not').count();
  if (hasWarn) { await panel.getByRole('button', { name: 'Set brim type to painted' }).click(); await page.waitForTimeout(200); }
  const brimType = await page.evaluate((id) => window.__cubbyProject.getObject(id).overrides.brim_type, id);
  results.brim = { points: pts.length, slice, brimType, ok: pts.length === 5 && slice === 5 && (!hasWarn || brimType === 'painted') };
  await page.context().close();
}

if (want('step')) {
  const page = await newPage();
  const stp = resolve('node_modules/occt-import-js/test/testfiles/simple-basic-cube/cube.stp');
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: /Import model/ }).first().click()]);
  await fc.setFiles(stp);
  const dlg = page.getByRole('dialog', { name: 'STEP import' });
  await dlg.waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/step-dialog.png` });
  await dlg.getByRole('button', { name: 'Import' }).click();
  await page.waitForFunction(() => window.__cubbyProject.objects.value.length === 1, null, { timeout: 60000 });
  const r = await page.evaluate(() => { const o = window.__cubbyProject.objects.value[0]; const m = window.__cubbyProject.getMesh(o.meshId); return { name: o.name, tris: m.triangleCount, size: [0, 1, 2].map((k) => m.bbox.max[k] - m.bbox.min[k]) }; });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/step-imported.png` });
  results.step = { ...r, ok: r.name === 'cube' && r.tris === 12 };
  await page.context().close();
}

if (want('objcolor')) {
  const page = await newPage();
  // Two-colour cube via vertex colours: bottom half red, top half blue (per-vertex).
  const v = [[0,0,0],[20,0,0],[20,20,0],[0,20,0],[0,0,20],[20,0,20],[20,20,20],[0,20,20]];
  const col = (z) => (z > 0 ? '0 0 1' : '1 0 0');
  const f = [[1,3,2],[1,4,3],[5,6,7],[5,7,8],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,4,8],[3,8,7],[4,1,5],[4,5,8]];
  const obj = v.map((p) => `v ${p.join(' ')} ${col(p[2])}`).join('\n') + '\n' + f.map((t) => `f ${t.join(' ')}`).join('\n') + '\n';
  writeFileSync(`${out}/colours.obj`, obj);
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: /Import model/ }).first().click()]);
  await fc.setFiles(`${out}/colours.obj`);
  const dlg = page.getByRole('dialog', { name: 'Import OBJ colours' });
  await dlg.waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/objcolor-dialog.png` });
  const text = (await dlg.innerText()).replace(/\s+/g, ' ');
  await dlg.getByRole('button', { name: 'Apply' }).click();
  await page.waitForTimeout(3000);
  const state = await page.evaluate(() => {
    const o = window.__cubbyProject.objects.value[0];
    const paint = window.__cubbyProject.getMeshPaint?.(o.meshId);
    return { extruder: o.overrides.extruder ?? null, paintColor: paint?.color?.length ?? null, dialogOpen: !!document.querySelector('[role="dialog"]') };
  });
  results.objcolor = { text: text.slice(0, 300), ...state, ok: /Number of colours/.test(text) && !state.dialogOpen };
  await page.context().close();
}

if (want('phone')) {
  const page = await newPage({ width: 390, height: 844 });
  const id = await addBox(page, 30, 20, 10, 'Phone');
  await page.evaluate((id) => { window.__cubbyProject.select([id]); window.__cubbyTools.openTool('text'); }, id);
  await page.getByRole('region', { name: 'Add text' }).waitFor();
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${out}/phone-text.png` });
  await page.evaluate(() => window.__cubbyTools.openTool('brim'));
  await page.getByRole('region', { name: 'Brim ears' }).waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/phone-brim.png` });
  const box = await page.getByRole('region', { name: 'Brim ears' }).boundingBox();
  results.phone = { box, ok: !!box && box.x >= 0 && box.x + box.width <= 390 + 1 };
  await page.context().close();
}

await browser.close();
console.log(JSON.stringify({ results, errs }, null, 1));
const ok = Object.values(results).every((r) => r.ok);
console.log(ok ? 'TOOLS E2E PASS' : 'TOOLS E2E FAIL');
process.exit(ok ? 0 : 1);
