// Design tab e2e in a real browser against the real CAD kernel (public/wasm/cad/):
// opens an OrcaSlicer project 3MF whose Metadata/orca_cad.bin is Orca's own golden fixture
// (scripts/dev/fixtures/cad_recipe_v5.bin, a serialisation-coverage tree that does not rebuild,
// in desktop Orca either), shows the failing-feature state, repairs it by force-suppressing
// features 2, 3, 5, 6 and 29 together, checks the 6 bodies (one without faces), picks a face,
// edits a dimension (the mesh changes), commits to the plate (live link), slices the plate,
// edits again (the linked object follows), undoes / redoes across the edit (Ctrl+Z / Ctrl+Y),
// saves the project, reopens it (design, edit and link intact) and reopens the saved
// orca_cad.bin in the kernel under node.
//
// Every design edit replays the whole history: on the repaired fixture that is ~45 s in node
// (its internal thread ≈ 30 s), more in a browser on a busy machine. Allow ~15 minutes.
//
// Then the creation flow (e2e-design-create.mjs): a palette box → fillet picked edges → shell with
// a picked open face → hole on a picked face → circular pattern → boolean with a second body →
// commit as an assembly → slice → save → reopen → edit → STEP out and back in (Open in Design),
// the palette shapes exact / mesh against CubbyCAD's meshes, and Convert to Design body.
//
//   npx vite --port 5471 --strictPort --config <no-HMR config>   (see docs/DEVELOPMENT.md)
// Then the verification flow (verifyFlow, same file): cooperative Cancel of a long rebuild and its
// terminate fallback without cross-origin isolation, the Thread card (external / internal), the
// Extrude / Revolve / Sweep / Loft cards on the fixture's sketches, the icon-only body Pick, a
// design-only project opening on the Design tab, an STL as a mesh body.
//
//   node scripts/dev/e2e-design.mjs [baseUrl] [out-dir]          FLOWS=golden,create,verify,sketch (default all)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { strToU8, unzipSync, zipSync } from 'fflate';
const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const base = process.argv[2] ?? 'http://localhost:5471/slicer/';
const out = resolve(process.argv[3] ?? 'e2e-out/design'); mkdirSync(out, { recursive: true });
const REBUILD_MS = Number(process.env.REBUILD_TIMEOUT_MS ?? 600_000);
const FAILING = [2, 3, 5, 6, 29];
const FLOWS = new Set((process.env.FLOWS ?? 'golden,create,verify,sketch').split(',').map((x) => x.trim()));

let failures = 0;
const t0 = Date.now();
const lap = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s] ${m}`);
const check = (cond, what) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) failures++; return cond; };
const errs = [];
process.on('unhandledRejection', (e) => { console.log('FAILED:', e?.stack ?? e, '\nerrs:', JSON.stringify(errs, null, 1)); process.exit(1); });

// ---- the fixture project: an Orca project with one plate object and the golden design ----
function boxModel(s) {
  const v = [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], [0, 0, s], [s, 0, s], [s, s, s], [0, s, s]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return '<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">\n'
    + ' <metadata name="Application">OrcaSlicer-2.5.0</metadata>\n <metadata name="OrcaSlicer">2.5.0</metadata>\n <metadata name="BambuStudio:3mfVersion">1</metadata>\n'
    + ' <resources>\n  <object id="1" type="model">\n   <mesh>\n    <vertices>\n'
    + v.map((p) => `     <vertex x="${p[0]}" y="${p[1]}" z="${p[2]}"/>\n`).join('')
    + '    </vertices>\n    <triangles>\n' + f.map((t) => `     <triangle v1="${t[0]}" v2="${t[1]}" v3="${t[2]}"/>\n`).join('')
    + '    </triangles>\n   </mesh>\n  </object>\n </resources>\n <build>\n  <item objectid="1" transform="1 0 0 0 1 0 0 0 1 120 120 0" printable="1"/>\n </build>\n</model>\n';
}
const settings = '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  <object id="1">\n    <metadata key="name" value="Spacer"/>\n    <metadata key="extruder" value="1"/>\n'
  + '    <part id="1" subtype="normal_part">\n      <metadata key="name" value="Spacer"/>\n      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>\n    </part>\n  </object>\n'
  + '  <plate>\n    <metadata key="plater_id" value="1"/>\n    <model_instance>\n      <metadata key="object_id" value="1"/>\n      <metadata key="instance_id" value="0"/>\n    </model_instance>\n  </plate>\n</config>\n';
const recipe = readFileSync(resolve(here, 'fixtures', 'cad_recipe_v5.bin'));
const fixture = zipSync({
  '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'),
  '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'),
  '3D/3dmodel.model': strToU8(boxModel(20)),
  'Metadata/model_settings.config': strToU8(settings),
  'Metadata/orca_cad.bin': new Uint8Array(recipe),
});
const fixturePath = `${out}/golden-design.3mf`;
writeFileSync(fixturePath, fixture);

// ---- browser ----
const browser = await chromium.launch({ headless: !process.env.HEADED, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
await ctx.addInitScript(() => { delete window.showOpenFilePicker; delete window.showSaveFilePicker; });
await ctx.addInitScript(() => { try { localStorage.setItem('cubby.setup.done', 'true'); } catch {} });
const page = await ctx.newPage();
page.setDefaultTimeout(120_000);
page.on('pageerror', (e) => errs.push(`[pageerror] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errs.push(`[console] ${m.text()}`); });
await page.goto(`${base}?cubby-debug`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__cubbyProject && !!window.__cubbyDesign);
await page.evaluate(() => window.__cubbyProject.resetProject());
await page.waitForTimeout(500);

const shot = (n) => page.screenshot({ path: `${out}/${n}.png` });
const D = (fn, arg) => page.evaluate(fn, arg);
const run = (id) => page.evaluate((id) => { const A = window.__cubbyActions; const a = A.getAction(id); if (a) void A.runAction(a, A.getActionContext()); }, id);
const state = () => D(() => {
  const d = window.__cubbyDesign.design, k = window.__cubbyDesign.designKernel().status;
  return {
    phase: d.phase, ok: d.ok, error: d.error, failing: d.failing ? { ...d.failing } : null, generation: d.generation, busy: k.busy?.label ?? null, kphase: k.phase,
    features: d.features.map((f) => ({ ...f })), bodies: d.bodies.map((b) => JSON.parse(JSON.stringify(b))), status: d.status?.text ?? '',
  };
});
/** Wait until the kernel is idle and the design open (and `pred` holds, when given). */
async function settled(pred, what, timeout = REBUILD_MS) {
  const t = Date.now();
  await page.waitForFunction((src) => {
    const W = window.__cubbyDesign, d = W.design, k = W.designKernel().status;
    if (k.busy || k.queued || k.phase === 'starting' || d.phase === 'opening' || d.phase === 'idle') return false;
    return src ? Function('d', `return (${src})(d)`)(d) : true;
  }, pred ? pred.toString() : '', { timeout, polling: 500 }).catch(async (e) => {
    // Say what it was waiting on: the kernel / design state at the timeout.
    const st = await page.evaluate(() => {
      const W = window.__cubbyDesign, d = W.design, k = W.designKernel().status;
      return { kphase: k.phase, busy: k.busy?.label ?? null, queued: k.queued ?? null, phase: d.phase, ok: d.ok, error: d.error, failing: d.failing, features: d.features.map((f) => f.name ?? f.type), status: d.status?.text ?? '' };
    }).catch((x) => `state unavailable: ${x.message}`);
    console.log(`  timed out waiting for "${what}": ${JSON.stringify(st).slice(0, 1500)}`);
    throw e;
  });
  lap(`${what} (${((Date.now() - t) / 1000).toFixed(0)} s)`);
}
const objs = () => D(() => window.__cubbyProject.objects.value.map((o) => ({
  id: o.id, name: o.name, meshId: o.meshId, design: o.design ? { ...o.design } : null,
  tris: window.__cubbyProject.getMesh(o.meshId)?.triangleCount ?? 0,
  size: (() => { const m = window.__cubbyProject.getMesh(o.meshId); return m ? [0, 1, 2].map((k) => m.bbox.max[k] - m.bbox.min[k]) : null; })(),
})));
const ySize = (b) => b.bbox.max[1] - b.bbox.min[1];

async function golden() {
// ---- 1. open the project, open the Design tab ----------------------------------------------
console.log('open');
const [fc] = await Promise.all([page.waitForEvent('filechooser'), run('file.open')]);
await fc.setFiles(fixturePath);
await page.waitForFunction(() => window.__cubbyProject.objects.value.length === 1);
check(await D(() => window.__cubbyDesign.design.phase) === 'idle', 'opening a project with a design loads nothing CAD-related yet');
await page.getByRole('tab', { name: /Design/ }).click();
await page.waitForSelector('[data-testid="design-view"]');
await settled((d) => d.phase === 'open' && (d.ok || !!d.failing), 'design opened and diagnosed');
let s = await state();
check(s.features.length === 34, `34 features (${s.features.length})`);
check(!s.ok && /fillet radius too large/.test(s.error), `the golden tree doesn't rebuild: "${s.error}"`);
check(s.failing?.index === 2, `the first failing feature is found: #${s.failing?.index} ${s.features[s.failing?.index]?.name}`);
check(s.bodies.length === 0, 'no bodies while it fails');
await page.waitForSelector('[data-testid="design-failing"]');
check(await page.locator(`[data-feature="2"].ft__row--err`).count() === 1, 'the failing feature row is marked');
await shot('01-failing');

// ---- 2. repair: select the failing features in the tree, suppress them together ---------------
console.log('repair');
await page.click('[data-feature="2"]');
for (const i of FAILING.slice(1)) { await page.locator(`[data-feature="${i}"]`).scrollIntoViewIfNeeded(); await page.click(`[data-feature="${i}"]`, { modifiers: ['Control'] }); }
check(JSON.stringify(await D(() => [...window.__cubbyDesign.designUi.selected].sort((a, b) => a - b))) === JSON.stringify(FAILING), 'Ctrl+click builds the multi-selection');
await shot('02-selected');
await page.click('[data-testid="design-suppress-selected"]');
await page.waitForSelector('[data-testid="design-busy"]', { timeout: 30_000 }).catch(() => {});
await page.waitForTimeout(1500);
await shot('03-rebuilding');
await settled((d) => d.ok, 'repaired');
s = await state();
check(s.ok && s.bodies.length === 6, `6 bodies after suppressing ${FAILING.join(', ')} (${s.bodies.length})`);
check(FAILING.every((i) => !s.features[i].enabled), 'those features are suppressed');
const empty = s.bodies.filter((b) => b.face_count === 0).map((b) => b.index);
check(empty.length === 1, `one body has no faces (body ${empty})`);
check(await D(() => window.__cubbyProject.historyState.value.undo) === 'Suppress 5 features', 'one undo step for the repair');
await page.waitForTimeout(800);
await shot('04-repaired');

// ---- 3. pick a face: click a body twice (Orca: body → face → edge) ----------------------------
console.log('pick');
const target = s.bodies.find((b) => b.name === 'Mirror_XZ') ?? s.bodies.find((b) => b.face_count > 10);
await D((b) => window.__cubbyDesign.designViewport().fitAll(), null);
await page.waitForTimeout(800);
let picked = null;
for (const t of [0.5, 0.35, 0.65, 0.25, 0.75]) {
  const c = target.bbox.min.map((v, k) => v + (target.bbox.max[k] - v) * (k === 2 ? 1 : t));
  const xy = await D((p) => window.__cubbyDesign.designViewport().screenPoint(p), c);
  if (!xy) continue;
  await page.mouse.click(xy[0], xy[1]);
  await page.waitForTimeout(300);
  const p1 = await D(() => window.__cubbyDesign.designUi.pick && { ...window.__cubbyDesign.designUi.pick });
  if (p1?.kind !== 'body') continue;
  await page.mouse.click(xy[0], xy[1]);
  await page.waitForTimeout(600);
  picked = await D(() => window.__cubbyDesign.designUi.pick && { ...window.__cubbyDesign.designUi.pick });
  if (picked?.kind === 'face') break;
}
check(picked?.kind === 'face' && picked.generation === s.generation, `second click picks a face: ${JSON.stringify(picked)}`);
await page.waitForTimeout(800);
check(/Face \d+ of Body/.test((await state()).status), `status line names it: "${(await state()).status}"`);
await shot('05-face');

// ---- 4. edit a dimension: Extrude_Sym distance → the mesh changes --------------------------------
console.log('edit');
const ex = s.features.find((f) => f.name === 'Extrude_Sym');
const exBody = s.bodies.find((b) => b.source_feature === ex.index);
const y0 = ySize(exBody);
const tris0 = await D((b) => window.__cubbyDesign.displayBodies.value.find((m) => m.body === b).positions.length, exBody.index);
await page.locator(`[data-feature="${ex.index}"]`).scrollIntoViewIfNeeded();
await page.click(`[data-feature="${ex.index}"]`);
await page.waitForSelector('[data-testid="design-feature-editor"] [data-field="distance"] input');
const dist0 = Number(await page.inputValue('[data-field="distance"] input'));
await page.fill('[data-field="distance"] input', String(dist0 + 15));
await shot('06-editor');
await page.click('[data-testid="design-apply"]');
await page.waitForTimeout(1000);
await settled((d) => d.bodies.length === 6, 'edited');
s = await state();
const exBody1 = s.bodies.find((b) => b.source_feature === ex.index);
check(Math.abs(ySize(exBody1) - (y0 + 15)) < 0.01, `Extrude_Sym ${dist0} → ${dist0 + 15} mm: body ${y0.toFixed(2)} → ${ySize(exBody1).toFixed(2)} mm along Y`);
const pos1 = await D((b) => Array.from(window.__cubbyDesign.displayBodies.value.find((m) => m.body === b).positions.slice(0, 600)), exBody1.index);
check(tris0 > 0 && pos1.length > 0, 'the display mesh was replaced');
check(/^Edit Extrude_Sym$/.test(await D(() => window.__cubbyProject.historyState.value.undo)), 'one undo step "Edit Extrude_Sym"');
await page.waitForTimeout(600);
await shot('07-edited');

// ---- 5. commit to plate (live link) -------------------------------------------------------------
console.log('commit');
// Separate bodies (the commit split button's menu); the create flow commits as an assembly.
await page.click('[data-testid="design-commit-mode"]');
await page.getByRole('menuitem', { name: /As separate bodies/ }).click();
await page.waitForTimeout(300);
await page.click('[data-testid="design-commit"]');
await page.waitForFunction(() => window.__cubbyProject.objects.value.filter((o) => o.design).length >= 5, null, { timeout: 120_000 });
let list = await objs();
const linked = list.filter((o) => o.design);
check(linked.length === 5, `5 linked objects (6 bodies, one without faces): ${linked.map((o) => o.name).join(', ')}`);
check(await page.evaluate(async () => (await import('/slicer/src/app/state.ts')).activeView.value) === 'prepare', 'Commit switches to Prepare');
const exObj = linked.find((o) => o.design.sourceFeature === ex.index);
check(!!exObj && Math.abs(exObj.size[1] - (y0 + 15)) < 0.05, `the Extrude_Sym object has the edited size (${exObj?.size?.map((v) => v.toFixed(2))})`);
await page.evaluate((id) => window.__cubbyProject.select([id]), exObj.id);
await page.waitForSelector('[data-testid="design-linked-card"]');
await page.waitForTimeout(600);
await shot('08-prepare-linked');

// ---- 6. slice the plate --------------------------------------------------------------------------
console.log('slice');
await page.getByRole('button', { name: /Slice plate|Re-slice/ }).click();
await page.waitForFunction(() => { const b = document.querySelector('.slicebar'); return b && (b.classList.contains('done') || b.classList.contains('error')); }, null, { timeout: 900_000, polling: 1000 });
const slice = await page.evaluate(async () => { const r = (await import('/slicer/src/app/state.ts')).lastSlice.value; return r ? { bytes: r.gcode.byteLength, layers: r.report?.stats?.layers ?? null, warnings: r.report?.warnings?.length ?? 0 } : null; });
check(slice?.bytes > 10_000, `sliced: ${JSON.stringify(slice)}`);
await page.waitForTimeout(2500);
await shot('09-preview');

// ---- 7. edit again in Design: the linked object follows; undo / redo across it -------------------
console.log('linked edit + undo/redo');
await page.getByRole('tab', { name: /Design/ }).click();
await page.waitForTimeout(500);
await page.locator(`[data-feature="${ex.index}"]`).scrollIntoViewIfNeeded();
await page.click(`[data-feature="${ex.index}"]`);
await page.waitForSelector('[data-field="distance"] input');
await page.fill('[data-field="distance"] input', String(dist0 + 5));
await page.press('[data-field="distance"] input', 'Enter');
await page.waitForTimeout(1000);
await settled(null, 'second edit');
list = await objs();
const exObj2 = list.find((o) => o.id === exObj.id);
check(exObj2.meshId !== exObj.meshId && Math.abs(exObj2.size[1] - (y0 + 5)) < 0.05, `the linked plate object followed (${exObj.size[1].toFixed(2)} → ${exObj2.size[1].toFixed(2)} mm)`);
const others = list.filter((o) => o.design && o.id !== exObj.id);
check(others.every((o) => linked.find((l) => l.id === o.id).meshId === o.meshId), 'unchanged bodies kept their meshes (and paint)');
await shot('10-second-edit');
await page.locator('[data-testid="design-viewport"] canvas').first().click({ position: { x: 30, y: 30 } }); // focus idle (empty space)
await page.keyboard.press('Control+z');
await page.waitForTimeout(500);
check((await objs()).find((o) => o.id === exObj.id).meshId === exObj.meshId, 'Ctrl+Z in Design restores the linked object’s mesh at once');
await settled((d) => d.ok, 'undo reopened the design');
s = await state();
check(Math.abs(ySize(s.bodies.find((b) => b.source_feature === ex.index)) - (y0 + 15)) < 0.01, 'undo: the design is back to the first edit');
await page.keyboard.press('Control+y');
await page.waitForTimeout(500);
await settled((d) => d.ok, 'redo reopened the design');
s = await state();
check(Math.abs(ySize(s.bodies.find((b) => b.source_feature === ex.index)) - (y0 + 5)) < 0.01, 'redo: the second edit is back');
check((await objs()).find((o) => o.id === exObj.id).meshId === exObj2.meshId, 'and so is the linked mesh');
await shot('11-redo');

// ---- 8. save, reopen: design, edit and link intact --------------------------------------------------
console.log('save + reopen');
const [dl] = await Promise.all([page.waitForEvent('download'), run('file.save')]);
const savedPath = `${out}/saved.3mf`;
await dl.saveAs(savedPath);
const saved = unzipSync(new Uint8Array(readFileSync(savedPath)));
const savedRecipe = saved['Metadata/orca_cad.bin'];
check(!!savedRecipe && savedRecipe.length > 1000 && new DataView(savedRecipe.buffer, savedRecipe.byteOffset).getUint32(0, true) === 6, `the save has Metadata/orca_cad.bin (v6, ${savedRecipe?.length} B)`);
await page.evaluate(() => window.__cubbyProject.resetProject());
await page.waitForTimeout(500);
await run('view.prepare');
const [fc2] = await Promise.all([page.waitForEvent('filechooser'), run('file.open')]);
await fc2.setFiles(savedPath);
await page.waitForFunction(() => window.__cubbyProject.objects.value.length >= 6, null, { timeout: 120_000 });
list = await objs();
check(list.filter((o) => o.design).length === 5, 'the reopened project has the 5 linked objects');
await page.getByRole('tab', { name: /Design/ }).click();
await settled((d) => d.phase === 'open' && d.ok, 'reopened design');
s = await state();
check(s.features.length === 34 && FAILING.every((i) => !s.features[i].enabled), 'the reopened design keeps the suppressions');
check(Math.abs(ySize(s.bodies.find((b) => b.source_feature === ex.index)) - (y0 + 5)) < 0.01, 'and the edit');
const reExObj = list.find((o) => o.design?.sourceFeature === ex.index);
check(!!reExObj && Math.abs(reExObj.size[1] - (y0 + 5)) < 0.05, 'the link of the Extrude_Sym object survived the file');
await run('view.prepare');
await page.evaluate((id) => window.__cubbyProject.select([id]), reExObj.id);
await page.waitForSelector('[data-testid="design-linked-card"]');
await page.click('[data-testid="design-linked-card"] button:has-text("Edit in Design")');
await page.waitForTimeout(500);
const pk = await D(() => ({ pick: window.__cubbyDesign.designUi.pick && { ...window.__cubbyDesign.designUi.pick }, sel: [...window.__cubbyDesign.designUi.selected] }));
check(pk.sel[0] === ex.index && pk.pick?.kind === 'body', `Edit in Design selects its feature and body (${JSON.stringify(pk)})`);
await page.waitForTimeout(800);
await shot('12-reopened');
return { savedRecipe, ex, y0 };
}
const gold = FLOWS.has('golden') ? await golden() : null;

if (FLOWS.has('create')) {
  const { createFlow } = await import('./e2e-design-create.mjs');
  await page.evaluate(() => window.__cubbyProject.resetProject());
  await createFlow({ page, D, check, shot, settled, run, lap, out });
}
if (FLOWS.has('verify')) {
  const { verifyFlow } = await import('./e2e-design-create.mjs');
  await page.evaluate(() => window.__cubbyProject.resetProject());
  await verifyFlow({ page, D, check, shot, settled, run, lap, out, fixturePath, failing: FAILING, browser, base });
}

if (FLOWS.has('sketch')) {
  const { sketchFlow } = await import('./e2e-design-sketch.mjs');
  // a fresh page: the sketch flow clicks at screen points of the default camera, which the earlier
  // flows have moved (fit to the fixture, …)
  if (FLOWS.size > 1) {
    await page.reload({ waitUntil: 'networkidle' }); await page.waitForFunction(() => !!window.__cubbyProject && !!window.__cubbyDesign);
    // The reload restores the last session (the earlier flows' design) after the hooks appear: let it, then start clean.
    await page.evaluate(async () => { window.__autosave = await import('/slicer/src/project/persistence/autosave.ts'); });
    await page.waitForFunction(() => window.__autosave.autosaveEnabled(), null, { timeout: 120000, polling: 200 });
  }
  await page.evaluate(() => window.__cubbyProject.resetProject());
  await sketchFlow({ page, D, check, shot, settled, run, lap, out });
}

console.log(errs.length ? `page errors:\n${errs.join('\n')}` : 'no page errors');
if (errs.length) failures++;
await browser.close();

// ---- 9. the saved orca_cad.bin reopens in the kernel (node) ------------------------------------------
if (gold) {
const { savedRecipe, ex, y0 } = gold;
console.log('kernel (node)');
const cadDir = resolve(root, 'public', 'wasm', 'cad');
const { default: factory } = await import(pathToFileURL(resolve(cadDir, 'cad.mjs')).href);
const mod = await factory({ wasmBinary: readFileSync(resolve(cadDir, 'cad.wasm')), print: () => {}, printErr: () => {} });
const enc = new TextEncoder(), dec = new TextDecoder();
function call(method, params = {}, blob = null) {
  const w = (b) => { const p = mod._malloc(Math.max(1, b.byteLength)) >>> 0; mod.HEAPU8.set(b, p); return p; };
  const m = enc.encode(method), j = enc.encode(JSON.stringify(params)), b = blob ?? new Uint8Array(0);
  const mp = w(m), jp = w(j), bp = w(b), outs = mod._malloc(16) >>> 0;
  mod.HEAPU32.fill(0, outs >>> 2, (outs >>> 2) + 4);
  mod._cad_call(mp, m.byteLength, jp, j.byteLength, bp, b.byteLength, outs, outs + 4, outs + 8, outs + 12);
  const H = mod.HEAPU32, pj = H[outs >>> 2], lj = H[(outs + 4) >>> 2];
  const r = JSON.parse(dec.decode(mod.HEAPU8.slice(pj, pj + lj)));
  mod._cad_free(pj); mod._free(mp); mod._free(jp); mod._free(bp); mod._free(outs);
  return r;
}
const o = call('doc_open', {}, savedRecipe);
check(o.ok && o.result.ok && o.result.bodies === 6 && o.result.version === 6, `the saved recipe opens in the kernel: ok=${o.result?.ok}, ${o.result?.bodies} bodies, v${o.result?.version} (${o.result?.ms?.toFixed(0)} ms)`);
const sc = call('describe_scene', { doc: o.result.doc }).result;
const b2 = sc.bodies.find((b) => b.source_feature === ex.index);
check(b2 && Math.abs(b2.bbox.max[1] - b2.bbox.min[1] - (y0 + 5)) < 0.01, 'with the edited dimension');
}

lap(failures ? `${failures} FAILED` : 'DESIGN E2E PASS');
process.exit(failures ? 1 : 0);
