// CubbyCAD modelling e2e in a real browser: the shape palette, the params panel
// (a slider drag = one undo step), holes, Group / Ungroup, picking a child in the
// shape tree and moving it with the gizmo, .cubby import / export and the
// project 3MF round-trip (trees reopen editable).
//   npx vite --port 5393 --strictPort
//   node scripts/dev/e2e-cad.mjs [baseUrl] [out-dir]
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');
const base = process.argv[2] ?? 'http://localhost:5393/slicer/';
const out = resolve(process.argv[3] ?? 'e2e-out/cad'); mkdirSync(out, { recursive: true });

const errs = [];
let failures = 0;
const check = (cond, what) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) failures++; };
process.on('unhandledRejection', (e) => { console.log('FAILED:', e?.message, '\nerrs:', JSON.stringify(errs, null, 1)); process.exit(1); });

const browser = await chromium.launch({ headless: !process.env.HEADED, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
await ctx.addInitScript(() => { delete window.showOpenFilePicker; delete window.showSaveFilePicker; });
await ctx.addInitScript(() => { try { localStorage.setItem('cubby.setup.done', 'true'); } catch {} });
const page = await ctx.newPage();
page.setDefaultTimeout(60000);
page.on('pageerror', (e) => errs.push(`[pageerror] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errs.push(`[console] ${m.text()}`); });
await page.goto(`${base}?cubby-debug`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__cubbyProject && !!window.__cubbyCad && !!window.__cubbyTools);
await page.evaluate(() => window.__cubbyProject.resetProject());
await page.waitForTimeout(500);

const shot = (n) => page.screenshot({ path: `${out}/${n}.png` });
const objs = () => page.evaluate(() => window.__cubbyProject.objects.value.map((o) => ({
  id: o.id, name: o.name, cad: o.cad ? JSON.parse(JSON.stringify(o.cad.node)) : null, meshId: o.meshId, position: [...o.position],
  tris: window.__cubbyProject.getMesh(o.meshId)?.triangleCount ?? 0,
  info: (() => { const i = window.__cubbyProject.objectInfo.value.get(o.id); return i ? { min: [...i.min], max: [...i.max] } : null; })(),
})));
const undoLabel = () => page.evaluate(() => window.__cubbyProject.historyState.value.undo);
// Fire and forget: some commands wait for a file chooser the test answers afterwards.
const run = (id) => page.evaluate((id) => { const A = window.__cubbyActions; const a = A.getAction(id); if (a) void A.runAction(a, A.getActionContext()); }, id);

// ---- palette -----------------------------------------------------------------------
console.log('palette');
await page.click('button[data-action="cad.palette"]');
await page.waitForSelector('.spp [data-shape="box"]');
const tiles = await page.locator('.spp [data-shape]').count();
check(tiles >= 20, `palette lists CubbyCAD's built-in shapes (${tiles})`);
await shot('01-palette');
await page.click('.spp [data-shape="box"]');
await page.waitForFunction(() => window.__cubbyProject.objects.value.length === 1);
let list = await objs();
check(list[0].cad?.geometry?.type === 'box', 'the box is a CAD object');
check(Math.abs(list[0].info.min[2]) < 1e-3, 'it sits on the bed');
await page.waitForSelector('.cp');
await shot('02-box-panel');

// ---- params: a slider drag is one undo step --------------------------------------------
console.log('params');
const w0 = list[0].info.max[0] - list[0].info.min[0];
const slider = page.locator('.cp [role="slider"]').first();
const sb = await slider.boundingBox();
await page.mouse.move(sb.x + sb.width * 0.3, sb.y + sb.height / 2);
await page.mouse.down();
for (let i = 1; i <= 12; i++) { await page.mouse.move(sb.x + sb.width * (0.3 + i * 0.03), sb.y + sb.height / 2); await page.waitForTimeout(25); }
await page.mouse.up();
await page.waitForTimeout(400);
list = await objs();
const w1 = list[0].info.max[0] - list[0].info.min[0];
check(w1 > w0 + 1, `dragging Width grows the box (${w0.toFixed(1)} → ${w1.toFixed(1)} mm)`);
check(/shape/i.test(await undoLabel() ?? ''), `one undo entry for the drag ("${await undoLabel()}")`);
await page.evaluate(() => window.__cubbyProject.undo());
await page.waitForTimeout(300);
list = await objs();
check(Math.abs(list[0].info.max[0] - list[0].info.min[0] - w0) < 1e-3, 'one undo restores the width');
check(await undoLabel() === 'Add box', `undo stack is back to "Add box" (${await undoLabel()})`);

// ---- hole + group ------------------------------------------------------------------------
console.log('hole + group');
await page.evaluate(async () => {
  const C = window.__cubbyCad, P = window.__cubbyProject;
  const id = await C.addShape('cylinder', { params: { radius: 4, height: 40 }, hole: true });
  const box = P.objects.value[0];
  P.setTransforms([{ id, position: [box.position[0], box.position[1], 0] }]);
});
await page.waitForTimeout(300);
await shot('03-hole-ghost');
check((await page.evaluate(() => window.__cubbyProject.getSliceObjects().length)) === 1, 'a hole on its own is not sliced');
await page.evaluate(() => window.__cubbyProject.selectAll());
await run('object.group');
await page.waitForTimeout(500);
list = await objs();
check(list.length === 1 && list[0].cad?.type === 'group', 'Group makes one CAD group object');
check(list[0].cad.children.map((c) => c.contribution ?? 'add').join() === 'add,subtract', 'the group holds the box and the hole');
await page.evaluate(() => window.__cubbyActions.getAction && null);
await page.evaluate(() => { window.__cubbyProject.select([window.__cubbyProject.objects.value[0].id]); });
await page.evaluate(() => { const r = window.__cubbyActions; r.runAction(r.getAction('view.fit-selection'), r.getActionContext()); });
await page.waitForTimeout(600);
await shot('04-group');

// ---- child node + gizmo --------------------------------------------------------------------
console.log('child gizmo');
await page.locator('.cp__row').nth(2).click();
await page.waitForTimeout(400);
await page.evaluate(() => { const r = window.__cubbyActions; r.runAction(r.getAction('object.gizmo.move'), r.getActionContext()); });
await page.waitForTimeout(300);
await shot('05-child-picked');
const g = list[0];
const hole0 = g.cad.children[1].transform?.position ?? [0, 0, 0];
const cx = (g.info.min[0] + g.info.max[0]) / 2, cy = (g.info.min[1] + g.info.max[1]) / 2;
const p = await page.evaluate(([x, y]) => window.__cubbyTools.project(x, y, 0.05), [cx, cy]);
await page.mouse.move(p[0], p[1]);
await page.waitForTimeout(200);
await page.mouse.down();
for (let i = 1; i <= 10; i++) { await page.mouse.move(p[0] + i * 4, p[1] + i * 1); await page.waitForTimeout(30); }
await page.mouse.up();
await page.waitForTimeout(700);
list = await objs();
const hole1 = list[0].cad.children[1].transform?.position ?? [0, 0, 0];
check(Math.hypot(hole1[0] - hole0[0], hole1[2] - hole0[2]) > 0.5 && Math.abs(hole1[1] - hole0[1]) < 1e-6,
  `the gizmo moves the hole in its CAD frame (render XZ = bed XY): ${hole0.map((v) => v.toFixed(2))} → ${hole1.map((v) => v.toFixed(2))}`);
check(list[0].meshId !== g.meshId, 'the group mesh re-evaluated');
await shot('06-child-moved');

// ---- .cubby export / import ------------------------------------------------------------
console.log('.cubby');
const [dl] = await Promise.all([page.waitForEvent('download'), run('export.cubby')]);
const cubbyPath = `${out}/export.cubby`;
await dl.saveAs(cubbyPath);
const scene = JSON.parse(readFileSync(cubbyPath, 'utf8'));
check(scene.version === 1 && scene.unit === 'mm' && scene.children.length === 1, '.cubby export is a CubbyCAD scene');
await page.evaluate(() => window.__cubbyProject.resetProject());
const [fc] = await Promise.all([page.waitForEvent('filechooser'), run('file.import')]);
await fc.setFiles(cubbyPath);
await page.waitForFunction(() => window.__cubbyProject.objects.value.length === 1);
await page.waitForTimeout(300);
list = await objs();
check(list[0].cad?.type === 'group' && list[0].cad.children.length === 2, 'importing the .cubby gives the editable group back');
check(Math.abs((list[0].cad.children[1].transform?.position?.[0] ?? 0) - hole1[0]) < 1e-4, 'with the moved hole');

// ---- project 3MF round-trip --------------------------------------------------------------
console.log('project 3MF');
const [dl3] = await Promise.all([page.waitForEvent('download'), run('file.save')]);
await dl3.saveAs(`${out}/project.3mf`);
await page.evaluate(() => window.__cubbyProject.resetProject());
const [fc2] = await Promise.all([page.waitForEvent('filechooser'), run('file.import')]);
await fc2.setFiles(`${out}/project.3mf`);
await page.waitForFunction(() => window.__cubbyProject.objects.value.length === 1);
await page.waitForTimeout(300);
list = await objs();
check(list[0].cad?.type === 'group', 'the saved project reopens with its CAD tree');
await page.evaluate(() => { window.__cubbyProject.select([window.__cubbyProject.objects.value[0].id]); });
await page.waitForTimeout(300);
await page.evaluate(() => window.__cubbyCad.ungroupSelectionCmd());
await page.waitForTimeout(400);
list = await objs();
check(list.length === 2, 'Ungroup gives the box and the hole back');
await shot('07-ungrouped');

console.log(errs.length ? `page errors:\n${errs.join('\n')}` : 'no page errors');
if (errs.length) failures++;
await browser.close();
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
