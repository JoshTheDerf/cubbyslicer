/**
 * MCP bridge e2e: a real MCP client spawns cubby-mcp over stdio, a
 * Playwright Cubby Slicer tab pairs with it, and the test drives a path
 * through every tool group (engines, presets, objects / parts, plates,
 * painting, layers, tools, slicing, preview screenshots, export, commands).
 *
 *   npx vite --port 5393 --strictPort                   # the slicer dev server
 *   (cd ../cubby-mcp && npm run build)
 *   node scripts/dev/e2e-bridge.mjs [http://localhost:5393/slicer/]
 *
 * CUBBY_MCP = the cubby-mcp checkout (default ../cubby-mcp). Output (screenshots,
 * G-code, 3MF) goes to e2e-out/bridge. HEADED=1 shows the browser.
 */
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const MCP = resolve(process.env.CUBBY_MCP ?? join(ROOT, '../cubby-mcp'));
const SLICER_URL = process.argv[2] ?? process.env.SLICER_URL ?? 'http://localhost:5393/slicer/';
const OUT = join(ROOT, 'e2e-out/bridge');
const PORT = Number(process.env.E2E_BRIDGE_PORT ?? 18793);
const sdk = (p) => import(pathToFileURL(join(MCP, 'node_modules/@modelcontextprotocol/sdk/dist/esm', p)).href);
const { Client } = await sdk('client/index.js');
const { StdioClientTransport } = await sdk('client/stdio.js');
const { chromium } = await import('playwright');

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`, ...a);
let failures = 0;
function check(cond, what) {
  if (cond) log(`  ok   ${what}`);
  else { failures++; log(`  FAIL ${what}`); }
}

const transport = new StdioClientTransport({
  command: process.execPath, args: [join(MCP, 'dist/cli.js'), '--port', String(PORT), '--no-persist'], stderr: 'pipe', env: { ...process.env, CUBBY_MCP_OUT: OUT },
});
transport.stderr?.on('data', (d) => process.stdout.write(`    ${String(d).trimEnd().replace(/\n/g, '\n    ')}\n`));
const client = new Client({ name: 'cubby-slicer-e2e', version: '0' });
await client.connect(transport);

async function call(name, args = {}, { quiet = false, expectError = false } = {}) {
  const r = await client.callTool({ name: `slicer_${name}`, arguments: args }, undefined, { timeout: 20 * 60_000, resetTimeoutOnProgress: true });
  const texts = r.content.filter((c) => c.type === 'text').map((c) => c.text);
  const images = r.content.filter((c) => c.type === 'image');
  let data;
  try { data = JSON.parse(texts[0]); } catch { data = texts[0]; }
  if (!quiet) log(`→ ${name} ${JSON.stringify(args).slice(0, 180)}\n    ${r.isError ? 'ERROR ' : ''}${(typeof data === 'string' ? data : JSON.stringify(data)).slice(0, 500)}${images.length ? ` (+${images.length} image)` : ''}`);
  if (r.isError && !expectError) throw new Error(`${name} failed: ${texts[0]}`);
  return { data, images, isError: !!r.isError };
}
async function waitFor(fn, what, ms = 180_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}
const near = (a, b, eps = 0.05) => Math.abs(a - b) <= eps;

const browser = await chromium.launch({ headless: !process.env.HEADED, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => { try { localStorage.setItem('cubby.setup.done', 'true'); } catch { /* */ } });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

/** Answer the app's own confirm dialog (not the bridge's). */
async function answerAppConfirm(label) {
  const b = page.locator('[role="dialog"][data-state="open"]').getByRole('button', { name: label, exact: true }).last();
  await b.waitFor({ timeout: 120_000 });
  await b.click();
}

try {
  const status = await client.callTool({ name: 'cubby_status', arguments: {} });
  const code = JSON.parse(status.content[0].text).pairingCode;
  await page.goto(`${SLICER_URL}?mcp=${encodeURIComponent(code)}&cubby-debug`, { waitUntil: 'commit', timeout: 180_000 });
  await page.getByTestId('bridge-connect').waitFor({ timeout: 120_000 });
  await waitFor(async () => { await page.getByTestId('bridge-connect').click({ timeout: 2000 }); return true; }, 'the Connect button', 60_000);
  await page.getByText(/Connected as slicer-1\. Your agent can use this tab/).waitFor({ timeout: 30_000 });
  await page.keyboard.press('Escape');
  const tools = await waitFor(async () => { const n = (await client.listTools()).tools.map((t) => t.name); return n.includes('slicer_capture_viewport') ? n : null; }, 'tools/list');
  log(`${tools.filter((t) => t.startsWith('slicer_')).length} slicer tools`);
  check(tools.filter((t) => t.startsWith('slicer_')).length >= 80, 'the tab registered every tool group');

  // ---- engines + presets ---------------------------------------------------------------------
  let st = (await call('get_state')).data;
  check(st.engines.length === 3 && st.plates.length === 1, 'get_state lists engines and plates');
  const pf = (await call('set_engine', { engine: 'preflight' })).data;
  check(pf.engine === 'preflight', `switched to preFlight (${pf.printer.name})`);
  check((await call('set_engine', { engine: 'bogus' }, { expectError: true })).data.includes('"orca", "preflight", "fullspectrum"'), 'bad engine names the valid ones');
  check((await call('set_engine', { engine: 'orca' })).data.engine === 'orca', 'back to OrcaSlicer');
  const lib = (await call('list_presets', { kind: 'printer', query: 'Prusa MK4 0.4', limit: 3 })).data;
  const pick = lib.installed.find((x) => /MK4/.test(x.name)) ?? lib.library[0];
  if (pick) check((await call('select_preset', { kind: 'printer', id: pick.id, unsaved: 'discard' })).data.printer.id === pick.id, `selected printer ${pick.name}`);
  const fil = (await call('set_filaments', { count: 2, colors: ['#2255ff', '#ff3322'] })).data;
  check(fil.filaments.length === 2 && fil.filaments[1].colour.toLowerCase() === '#ff3322', 'two filament slots with colours');
  const set1 = (await call('set_settings', { values: { layer_height: 0.2, sparse_infill_density: '12%', wall_loops: 'x' } })).data;
  check(set1.applied.layer_height === '0.2' && set1.rejected?.wall_loops, 'set_settings applies and rejects with a reason');
  const cmp = (await call('compare_presets', { kind: 'process' })).data;
  check(cmp.unsaved.some((u) => u.key === 'sparse_infill_density'), 'compare_presets shows the unsaved edit');
  const saved = (await call('save_preset', { kind: 'process', name: 'Agent e2e process' })).data;
  check(saved.saved.id.startsWith('user:') && saved.process.name === 'Agent e2e process', 'saved a user process preset');
  check((await call('rename_preset', { id: saved.saved.id, name: 'Agent e2e renamed' })).data.name === 'Agent e2e renamed', 'renamed it');
  const cmp2 = (await call('compare_presets', { kind: 'process' })).data;
  check(cmp2.vsSystem?.some((v) => v.key === 'sparse_infill_density'), 'compare_presets diffs the user preset against its system parent');

  // ---- objects + parts -----------------------------------------------------------------------------
  const cube = join(ROOT, 'public/calib/handy/OrcaCube_v2.stl');
  const imp = (await call('import_model', { path: cube })).data;
  const A = imp.imported[0];
  check(!!A && A.size.every((s) => s > 10), `imported ${A?.name} (${A?.size?.join(' x ')} mm)`);
  const tr = (await call('transform_objects', { items: [{ id: A.id, position: [120, 110], rotation: [0, 0, 30] }] })).data.objects[0];
  check(near(tr.position[0], 120, 0.5) && near(tr.position[1], 110, 0.5) && near(tr.position[2], 0, 0.01) && near(tr.rotation[2], 30, 0.1), 'moved to (120, 110) and rotated 30° on the bed');
  const part = (await call('add_part', { objectId: A.id, type: 'modifier', shape: 'box', size: [30, 30, 8], position: [0, 0, 0] })).data;
  check(!!part.partId && part.object.parts.some((p) => p.type === 'modifier'), 'added a modifier box');
  const po = (await call('set_settings', { objectId: A.id, partId: part.partId, values: { sparse_infill_density: '80%', layer_height: 0.1, enable_support: true } })).data;
  check(po.applied.sparse_infill_density === '80%' && po.applied.enable_support === '1', 'modifier overrides set');
  check((await call('set_settings', { objectId: A.id, values: { nozzle_diameter: 0.6 } }, { expectError: true })).data.rejected?.nozzle_diameter?.includes('per object'), 'printer settings are refused per object');
  const up = (await call('update_objects', { ids: [A.id], name: 'Cube A', color: '#44aa44' })).data.objects[0];
  check(up.name === 'Cube A', 'renamed and recoloured');
  const imp2 = (await call('import_model', { path: join(ROOT, 'public/calib/handy/Voron_Design_Cube_v7.stl') })).data;
  const B = imp2.imported[0];
  check(!!B, `imported ${B?.name}`);
  const acts = (await call('list_actions', { query: 'mirror' })).data;
  check(acts.actions.some((a) => a.id === 'object.mirror.x'), 'list_actions finds the mirror commands');
  await call('select_objects', { ids: [B.id] });
  const mir = (await call('run_action', { id: 'object.mirror.x' })).data;
  check(mir.ok && /Mirror/.test(mir.undo), 'run_action mirrored the selection (undoable)');
  check((await call('undo')).data.undone[0].startsWith('Mirror'), 'undo reverted it');
  check((await call('run_action', { id: 'file.open' }, { expectError: true })).data.includes('open_project'), 'commands needing a native picker point to the tool');

  // ---- plates ------------------------------------------------------------------------------------------
  const ap = (await call('add_plate', { name: 'Second' })).data;
  check(ap.plate === 2 && ap.plates.length === 2, 'added plate 2');
  const mv = (await call('move_to_plate', { ids: [B.id], plate: 2 })).data;
  check(mv.objects[0].plate === 2, 'moved the Voron cube to plate 2');
  const upl = (await call('update_plate', { plate: 2, settings: { print_sequence: 'by object', bogus: 1 } }, { expectError: true })).data;
  check(upl.ok === false && upl.rejected?.bogus, 'plate settings reject unknown keys');
  check((await call('update_plate', { plate: 2, settings: { print_sequence: 'by layer', spiral_mode: false }, locked: true })).data.settings.print_sequence === 'by layer', 'plate 2 settings + lock');
  check((await call('update_plate', { plate: 1, active: true })).data.plate.active, 'plate 1 active again');

  // ---- painting ------------------------------------------------------------------------------------------
  const p1 = (await call('paint', { objectId: A.id, layer: 'color', mode: 'facing', direction: [0, 0, 1], angle: 10, filament: 2 })).data;
  check(p1.paintedTriangles > 0, `colour-painted the top faces (${p1.paintedTriangles} triangles)`);
  const p2 = (await call('paint', { objectId: A.id, layer: 'support', mode: 'height', zMin: 0, zMax: 3 })).data;
  check(p2.paintedTriangles > 0, 'support enforcers painted on a height band');
  const p3 = (await call('paint', { objectId: A.id, layer: 'seam', mode: 'sphere', point: [tr.bbox.max[0], tr.position[1], 10], radius: 6 })).data;
  check(p3.paintedTriangles > 0, `seam painted around a point (${p3.paintedTriangles} triangles${p3.note ? `; ${p3.note}` : ''})`);
  check((await call('paint', { objectId: A.id, layer: 'seam', mode: 'bucket', point: [0, 0, 0] }, { expectError: true })).isError, 'bucket is refused outside the color layer');

  // ---- layers ------------------------------------------------------------------------------------------------
  const vl = (await call('set_layer_heights', { objectId: A.id, mode: 'bands', bands: [{ min: 5, max: 12, height: 0.08 }] })).data;
  check(vl.custom && vl.summary.minHeight <= 0.1 && vl.layers > 0, `variable layer height: ${vl.layers} layers, ${vl.summary.minHeight}-${vl.summary.maxHeight} mm`);
  const hr = (await call('height_range', { objectId: A.id, op: 'add', min: 14, max: 18, settings: { sparse_infill_density: '5%' } })).data;
  check(hr.ranges.length === 1 && hr.ranges[0].overrides.sparse_infill_density === '5%', 'height range modifier with a setting');
  const cc = await call('custom_gcode', { op: 'add', z: 10, type: 'color_change' }, { expectError: true });
  check(cc.isError && /tool_change/.test(cc.data), 'Orca colour change points to tool_change');
  const tc = (await call('custom_gcode', { op: 'add', z: 10, type: 'tool_change', filament: 2 })).data;
  check(tc.items.length === 1 && tc.items[0].type === 'tool_change', 'filament change at z 10 on plate 1');
  await call('custom_gcode', { op: 'add', z: 15, type: 'pause', message: 'Insert nut' });

  // ---- tools --------------------------------------------------------------------------------------------------------
  await call('update_plate', { plate: 2, locked: false });
  const cut = (await call('cut', { objectId: B.id, height: 10, connectors: [{ u: 9, v: -9 }], connectorType: 'dowel', connectorSize: 5, connectorDepth: 4 })).data;
  check(cut.created.length >= 2, `cut the Voron cube into ${cut.created.length} objects`);
  const onP2 = (await call('list_objects', { plate: 2 })).data;
  check(onP2.count >= 2, `the cut pieces stay on plate 2 (${onP2.count})`);
  const txt = (await call('add_text', { text: 'CUBBY', objectId: A.id, place: 'part', face: 'front', size: 5, depth: 1 })).data;
  check(!!txt.partId, 'embossed text on the front face');
  const ms = (await call('measure', { ids: [A.id, cut.created[0].id] })).data;
  check(ms.objects.length === 2 && typeof ms.between.centreDistance === 'number', 'measure between objects');
  const ears = (await call('brim_ears', { objectId: A.id, op: 'auto', setPainted: true })).data;
  check(ears.ok && ears.brimType === 'painted', `brim ears: ${ears.ears}`);

  // ---- CubbyCAD modelling (same tool names / arguments as CubbyCAD's) ---------------------------------------
  const shapes = (await call('list_shapes', {}, { quiet: true })).data.shapes;
  check(shapes.length >= 20 && shapes.find((x) => x.id === 'box')?.params?.width?.unit === 'mm', `list_shapes: ${shapes.length} CubbyCAD shapes with their schemas`);
  const bx = (await call('add_primitive', { shape: 'box', params: { width: 30, depth: 20, height: 10 }, name: 'Drill plate' })).data;
  check(bx.object.cad?.kind === 'box' && near(bx.object.size[0], 30) && near(bx.object.size[1], 20) && near(bx.object.size[2], 10), 'add_primitive: a 30 × 20 × 10 box (width → X, depth → Y, height → Z)');
  const hl = (await call('add_primitive', { shape: 'cylinder', params: { radius: 3, height: 30 }, hole: true, position: bx.object.position.slice(0, 2) })).data;
  check(hl.hole && hl.object.cad?.hole, 'add_primitive hole: true');
  const gr = (await call('group', { ids: [bx.object.id, hl.object.id], name: 'Drilled' })).data;
  check(gr.tree.children.length === 2 && gr.tree.children[1].hole && gr.object.name === 'Drilled', 'group: box + hole in one manifold group object');
  const tree = (await call('get_cad_tree', { objectId: gr.object.id })).data.objects[0].tree;
  const holeId = tree.children[1].id;
  const nd = (await call('get_node', { id: holeId })).data;
  check(nd.hole && nd.geometry.type === 'cylinder' && nd.geometry.schema?.radius?.unit === 'mm', 'get_node: the hole with its schema');
  const sp = (await call('set_params', { id: holeId, params: { radius: 5 } })).data;
  check(sp.params.radius === 5, 'set_params widens the hole');
  const tn = (await call('transform_node', { id: holeId, mode: 'offset', position: [6, 0, 0] })).data;
  check(near(tn.transform.position[0] - (nd.transform?.position?.[0] ?? 0), 6, 1e-6), 'transform_node moves the hole in its CAD frame');
  check((await call('set_params', { id: holeId, params: { nope: 1 } }, { expectError: true })).data.includes('Unknown cylinder parameter'), 'unknown params are refused');
  await call('set_node', { id: holeId, locked: true });
  check((await call('set_params', { id: holeId, params: { radius: 2 } }, { expectError: true })).data.includes('locked'), 'a locked node refuses edits');
  const sn = (await call('set_node', { id: holeId, locked: false, name: 'Bore', color: '#ff8800' })).data;
  check(sn.changed && sn.node.name === 'Bore' && !sn.node.locked, 'set_node unlocks, renames and recolours in one step');
  const ug = (await call('ungroup', { id: gr.object.id })).data;
  const bore = ug.objects.find((o) => o.name === 'Bore'), plateObj = ug.objects.find((o) => o.name === 'Drill plate');
  check(ug.objects.length === 2 && near(bore.position[0] - plateObj.position[0], 6, 0.01) && near(bore.size[0], 10, 0.01),
    'ungroup gives the box and the hole back, with the hole moved 6 mm and widened to r = 5');
  check((await call('undo')).data.undone[0].startsWith('Ungroup'), 'undo regroups');
  const ic = (await call('import_cad', {
    name: 'From CubbyCAD', unit: 'mm',
    nodes: [{ id: 'e2e-root', type: 'group', name: 'Assembly', children: [
      { id: 'e2e-a', type: 'primitive', name: 'Block', geometry: { type: 'box', params: { width: 16, height: 8, depth: 16 } }, material: { color: '#3366cc' } },
      { id: 'e2e-h', type: 'primitive', name: 'Slot', contribution: 'subtract', geometry: { type: 'box', params: { width: 4, height: 20, depth: 20 } } },
      { id: 'e2e-sdf', type: 'group', csgMode: 'sdf', name: 'Blob', children: [{ id: 'e2e-s', type: 'primitive', geometry: { type: 'sphere', params: { radius: 4 } } }] },
    ] }],
  })).data;
  const icObj = ic.objects[0];
  check(icObj?.name === 'From CubbyCAD' && icObj.cad?.rootNodeId === 'e2e-root', 'import_cad: one editable object per top-level node');
  const icTree = (await call('get_cad_tree', { objectId: icObj.id })).data.objects[0].tree;
  const blob = icTree.children.find((c) => c.id === 'e2e-sdf');
  check(blob?.editable === false && /CubbyCAD/.test(blob.reason ?? ''), 'CubbyCAD-only content is listed read-only with the reason');
  check((await call('set_node', { id: 'e2e-sdf', hidden: true }, { expectError: true })).data.includes('can’t be edited'), 'and refuses edits');
  check((await call('delete_nodes', { ids: ['e2e-h'] })).data.deleted === 1, 'delete_nodes removes the slot');

  // ---- slice + results --------------------------------------------------------------------------------------------------------
  const sl = (await call('slice', { all: true })).data;
  check(sl.ok && sl.plates.length === 2 && sl.plates.every((p) => p.sliced && p.stats.layers > 0), `sliced both plates (${sl.plates?.map((p) => `${p.stats?.printTime}, ${p.stats?.layers} layers`).join(' / ')})`);
  const res = (await call('get_slice_results', {})).data;
  check(res.plates[0].breakdown?.features?.length > 2, `per-feature breakdown (${res.plates[0].breakdown?.features?.map((f) => f.feature).join(', ')})`);
  check(res.plates[0].stats.perFilament.length === 2, 'filament 2 is used (colour painting / filament change)');
  const gtext = (await call('read_gcode', { search: 'M601' }, { quiet: true })).data;
  log(`    pause markers found: ${gtext.hits.length}`);

  // ---- preview + screenshots --------------------------------------------------------------------------------------------------
  const pv = (await call('set_preview', { plate: 1, layers: [1, Math.round(sl.plates[0].stats.layers * 0.6)], colorScheme: 'feature', options: { travel: false } })).data;
  check(pv.view === 'preview' && pv.layers === sl.plates[0].stats.layers && pv.shown[1] > 1, `preview shows layers ${pv.shown?.join('-')}`);
  const shot = await call('capture_viewport', { plate: 1, view: 'preview', preset: 'iso', fit: 'print', width: 1024, height: 768 });
  check(shot.images.length === 1 && shot.images[0].data.length > 5000, 'preview screenshot');
  writeFileSync(join(OUT, 'preview-iso.png'), Buffer.from(shot.images[0].data, 'base64'));
  const shot2 = await call('capture_viewport', { view: 'prepare', preset: 'iso', fit: 'objects', width: 1024, height: 768 });
  writeFileSync(join(OUT, 'prepare-iso.png'), Buffer.from(shot2.images[0].data, 'base64'));
  const shot3 = await call('capture_viewport', { view: 'prepare', preset: 'top', fit: 'plate', width: 800, height: 800 });
  writeFileSync(join(OUT, 'prepare-top.png'), Buffer.from(shot3.images[0].data, 'base64'));
  check(shot2.images.length === 1 && shot3.images.length === 1, 'prepare screenshots (iso, top)');
  await call('set_preview', { layers: [1, sl.plates[0].stats.layers] });

  // ---- export ---------------------------------------------------------------------------------------------------------------------
  const gz = (await call('export_gcode', { plate: 'all', savePath: join(OUT, 'all-plates.zip') })).data;
  check(gz.files.length === 2 && readFileSync(gz.savedTo).subarray(0, 2).toString() === 'PK', `exported both plates as a zip (${gz.files.join(', ')})`);
  const g1 = (await call('export_gcode', { plate: 1, savePath: OUT + '/' })).data;
  check(statSync(g1.savedTo).size > 1000, `plate 1 G-code saved (${g1.name})`);
  const p3mf = (await call('export_3mf', { kind: 'project', savePath: join(OUT, 'project.3mf') })).data;
  check(readFileSync(p3mf.savedTo).subarray(0, 2).toString() === 'PK', '3MF project saved');

  // ---- confirms -------------------------------------------------------------------------------------------------------------------
  const del = call('delete_preset', { id: saved.saved.id });
  await page.getByTestId('bridge-confirm-ok').click({ timeout: 120_000 });
  check((await del).data.ok, 'deleted the user preset after the user confirmed');
  const dp = call('delete_plate', { plate: 2 }, { expectError: true });
  await answerAppConfirm('Cancel');
  check((await dp).data.ok === false, 'deleting a plate with objects waits for the app’s own confirm (declined)');

  st = (await call('get_state')).data;
  check(st.plates.length === 2 && !st.waitingForUser, 'state is consistent afterwards');

  // ---- phase 2: the rest of the tool surface ------------------------------------------------------
  if (!process.env.QUICK) {
    // objects
    const dup = (await call('duplicate_objects', { ids: [A.id], count: 1 })).data;
    check(dup.created.length === 1, 'duplicated an instance');
    const inst = (await call('set_instances', { ids: [A.id], count: 1 })).data;
    check(inst.groups[0].instances.length === 1, 'set_instances back to 1');
    const lay = (await call('object_op', { op: 'lay_on_face', ids: [A.id] })).data;
    check(lay.ok && lay.normal.length === 3, 'lay_on_face on the largest face');
    for (const op of ['drop_to_bed', 'center', 'mirror_y', 'scale_to_fit']) check((await call('object_op', { op, ids: [A.id] }, { quiet: true })).data.ok, `object_op ${op}`);
    await call('undo', { steps: 4 });
    const so = (await call('transform_objects', { items: [{ id: A.id, size: [20, null, null], uniform: true }] })).data.objects[0];
    check(near(so.size[0], 20, 0.1) && so.scale.every((v) => near(v, so.scale[0], 1e-4)), `uniform resize: X = 20 mm (${so.size.join(' x ')})`);
    const upd = (await call('update_part', { objectId: A.id, partId: part.partId, name: 'Dense core', position: [0, 0, 2], type: 'support_blocker' })).data;
    check(upd.object.parts.some((p) => p.name === 'Dense core' && p.type === 'support_blocker'), 'update_part renamed, moved and retyped');
    const cyl = (await call('add_part', { objectId: A.id, type: 'negative', shape: 'cylinder', size: [4, 4, 40] })).data;
    check((await call('remove_part', { objectId: A.id, partId: cyl.partId })).data.object.parts.every((p) => p.id !== cyl.partId), 'added and removed a negative cylinder');
    const fp = (await call('add_part', { objectId: A.id, type: 'modifier', shape: 'file', path: join(ROOT, 'public/calib/handy/OrcaPlug_v2.stl') })).data;
    check(!!fp.partId, 'modifier from a model file');
    await call('remove_part', { objectId: A.id, partId: fp.partId }, { quiet: true });
    const stl = (await call('export_stl', { ids: [A.id], savePath: join(OUT, 'cube.stl') })).data;
    check(statSync(stl.savedTo).size > 1000, 'export_stl');
    const bunny = (await call('add_test_model', { id: 'bunny' })).data.added[0];
    check(!!bunny, 'handy model: Stanford bunny');
    const simp = (await call('simplify', { objectId: bunny.id, level: 'low' })).data;
    check(simp.ok && simp.after < simp.before, `simplified ${simp.before} → ${simp.after} triangles`);
    const orient = (await call('object_op', { op: 'auto_orient', ids: [bunny.id] })).data;
    check(orient.ok, `auto orient (changed: ${orient.changed?.length ?? 0})`);
    const sp = await call('object_op', { op: 'split_to_objects', ids: [bunny.id] }, { expectError: true });
    check(sp.isError && /single connected piece/.test(sp.data), 'split refuses a one-piece mesh');
    const svg = (await call('add_svg', { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/></svg>', width: 20, depth: 1.5 })).data;
    check(!!svg.objectId, 'SVG emboss as a new object');
    const tx = (await call('add_text', { text: 'Hi', size: 8 })).data;
    const ed = (await call('edit_emboss', { objectId: tx.objectId, text: 'Hello', bold: true })).data;
    check(ed.object.emboss.text === 'Hello', 'edited the text object');
    const bo = (await call('mesh_boolean', { op: 'difference', source: { objectId: tx.objectId }, tools: [{ objectId: svg.objectId }], deleteInput: false })).data;
    check(bo.ok, 'mesh boolean difference');
    await call('undo');
    const asm = (await call('assembly_view', { on: true, explosion: 1.5 })).data;
    check(asm.on && asm.explosion === 1.5, 'assembly view on');
    await call('assembly_view', { on: false });
    const ear2 = (await call('brim_ears', { objectId: bunny.id, op: 'add', points: [[bunny.position?.[0] ?? 125, bunny.position?.[1] ?? 105]], diameter: 8 })).data;
    check(ear2.ears >= 1, 'brim ear added at a point');
    await call('brim_ears', { objectId: bunny.id, op: 'clear' });
    const am = (await call('arrange', { scope: 'all' })).data;
    check(am.ok, `arrange all (${am.plates} plates)`);
    // painting
    const pf = (await call('paint', { objectId: A.id, layer: 'fuzzy', mode: 'fill' })).data;
    check(pf.paintedTriangles > 0, 'fuzzy skin on the whole object');
    check((await call('paint', { objectId: A.id, layer: 'fuzzy', mode: 'clear' })).data.paintedTriangles === 0, 'fuzzy skin cleared');
    const top = (await call('list_objects', { ids: [A.id] })).data.objects[0];
    const sf = (await call('paint', { objectId: A.id, layer: 'color', mode: 'smart_fill', point: [top.position[0], top.position[1], top.bbox.max[2]], filament: 1, angle: 20 })).data;
    check(sf.ok, `smart fill (${sf.paintedTriangles} painted)`);
    const bk = (await call('paint', { objectId: A.id, layer: 'color', mode: 'bucket', point: [top.position[0], top.position[1], top.bbox.max[2]], filament: 2 })).data;
    check(bk.ok, 'bucket fill');
    const ov = (await call('paint', { objectId: A.id, layer: 'support', mode: 'facing', direction: [0, 0, -1], angle: 45, state: 'block' })).data;
    check(ov.ok && ov.note, `support blockers on overhangs (${ov.note})`);
    // layers
    const ad = (await call('set_layer_heights', { objectId: A.id, mode: 'adaptive', quality: 0.3 })).data;
    check(ad.custom, `adaptive layer heights (${ad.layers} layers)`);
    check((await call('set_layer_heights', { objectId: A.id, mode: 'smooth', radius: 3 })).data.custom, 'smoothed');
    check(!(await call('set_layer_heights', { objectId: A.id, mode: 'reset' })).data.custom, 'reset');
    check((await call('get_layer_heights', { objectId: A.id })).data.layers > 0, 'get_layer_heights');
    const rid = (await call('list_objects', { ids: [A.id] })).data.objects[0].heightRanges[0].id;
    const hu = (await call('height_range', { objectId: A.id, op: 'update', rangeId: rid, max: 20, settings: { wall_loops: 4 } })).data;
    check(hu.ranges[0].max === 20 && hu.ranges[0].overrides.wall_loops === '4', 'height range updated');
    check((await call('set_settings', { objectId: A.id, rangeId: rid, values: { wall_loops: null } })).data.ok, 'height range setting reset through set_settings');
    check((await call('height_range', { objectId: A.id, op: 'remove', rangeId: rid })).data.ranges.length === 0, 'height range removed');
    const lst = (await call('custom_gcode', { op: 'list', plate: 1 })).data;
    check(lst.items.length === 2, 'custom G-codes listed');
    check((await call('custom_gcode', { op: 'remove', plate: 1, z: 15 })).data.items.length === 1, 'pause removed');
    // presets
    const dirty = (await call('set_settings', { values: { wall_loops: 7 } })).data;
    check(dirty.ok, 'an unsaved process edit');
    const procs = (await call('list_presets', { kind: 'process' }, { quiet: true })).data;
    const other = procs.presets.find((x) => x.id !== procs.selected && x.source === 'system');
    const sel = await call('select_preset', { kind: 'process', id: other.id }, { expectError: true });
    check(sel.isError && /unsaved/.test(sel.data), 'select_preset asks what to do with unsaved edits');
    check((await call('discard_preset_changes', { kind: 'process' })).data.discarded >= 1, 'discarded the edit');
    const exp = (await call('export_preset', { kind: 'filament', filament: 2, savePath: join(OUT, 'filament.json') })).data;
    check(JSON.parse(readFileSync(exp.savedTo, 'utf8')).name, 'exported a filament preset');
    const impP = (await call('import_presets', { path: exp.savedTo })).data;
    check(impP.imported.length >= 1 || impP.warnings, `imported presets (${impP.imported.length})`);
    for (const u of impP.imported) {
      const d = call('delete_preset', { id: u.id });
      await page.getByTestId('bridge-confirm-ok').click({ timeout: 120_000 });
      await d;
    }
    await call('run_action', { id: 'settings.setup' });
    await waitFor(async () => (await call('get_state', {}, { quiet: true })).data.setupWizardOpen, 'the setup wizard', 30_000);
    const su = (await call('setup', { engine: 'orca', filaments: ['Prusa Generic PETG @MK4', 'Prusa Generic PETG @MK4'] })).data;
    check(su.ok && su.filaments.every((f) => /PETG/.test(f.name)), 'setup picked the filaments');
    await new Promise((r) => setTimeout(r, 800));
    check(!(await call('get_state', {}, { quiet: true })).data.setupWizardOpen, 'setup closed the wizard');
    // app
    check((await call('set_preferences', { values: { autoArrangeImport: true } })).data.preferences.autoArrangeImport === true, 'preferences');
    await call('set_preferences', { values: { autoArrangeImport: false } }, { quiet: true });
    check((await call('set_preferences', { values: { nope: 1 } }, { expectError: true })).isError, 'unknown preference refused');
    const fl = (await call('get_flushing_volumes')).data;
    check(fl.filaments === 2 && fl.auto.length >= 1, 'flushing volumes read');
    check((await call('set_flushing_volumes', { auto: true })).data.ok, 'flushing volumes auto');
    check((await call('get_project')).data.name, 'get_project');
    check((await call('save_project', {}, { expectError: true })).isError, 'save_project without a location points to save_to_cloud / export_3mf');
    const cl = await call('list_cloud_files', {}, { expectError: true });
    log(`    cloud: ${String(cl.data).slice(0, 120)}`);
    // mixed filaments (Full Spectrum)
    const fs = (await call('set_engine', { engine: 'fullspectrum' })).data;
    check(fs.engine === 'fullspectrum', `Full Spectrum (${fs.printer.name})`);
    await call('set_filaments', { count: 2, colors: ['#ffff00', '#0000ff'] });
    const mx = (await call('list_mixed_filaments')).data;
    check(Array.isArray(mx.mixed), `mixed filaments listed (${mx.mixed.length})`);
    const mxa = (await call('edit_mixed_filaments', { edits: [{ op: 'add', a: 1, b: 2, percent: 30 }] })).data;
    check(mxa.mixed.length >= mx.mixed.length, 'added a mix');
    await call('set_engine', { engine: 'orca' });
    // print host (mock OctoPrint)
    const { startMockOctoprint } = await import(pathToFileURL(join(MCP, 'scripts/mockOctoprint.mjs')).href);
    const printer = await startMockOctoprint();
    const sh = call('set_print_host', { type: 'octoprint', host: `http://127.0.0.1:${printer.port}`, apiKey: printer.apiKey });
    await page.getByTestId('bridge-confirm-ok').click({ timeout: 120_000 });
    check((await sh).data.ok, 'print host saved');
    check((await call('test_print_host')).data.ok, 'print host answers');
    check((await call('list_host_printers', {}, { expectError: true })).isError, 'single-printer host has no printer list');
    await call('update_plate', { plate: 1, active: true });
    const sl1 = (await call('slice', { plate: 1 })).data;
    check(sl1.ok, 'plate 1 sliced again');
    const cancelled = call('send_to_printer', { print: false }, { expectError: true });
    await page.getByTestId('bridge-confirm-cancel').click({ timeout: 120_000 });
    check((await cancelled).data.ok === false && printer.uploads.length === 0, 'upload declined: nothing sent');
    const sent = call('send_to_printer', { print: true, filename: 'bridge.gcode' });
    await page.getByTestId('bridge-confirm-ok').click({ timeout: 120_000 });
    check((await sent).data.ok && printer.uploads[0]?.filename === 'bridge.gcode', 'uploaded to the mock printer');
    const rm = call('remove_print_host');
    await page.getByTestId('bridge-confirm-ok').click({ timeout: 120_000 });
    check((await rm).data.ok, 'print host removed');
    await printer.close();
    const rg = (await call('read_gcode', { layer: 2, count: 5 })).data;
    check(rg.text.length > 0, 'read_gcode by layer');
    // plates
    const dp2 = call('delete_plate', { plate: 2 });
    await answerAppConfirm('Delete plate');
    check((await dp2).data.ok, 'deleted plate 2 after the app’s confirm');
    // calibration (starts a new project: the app asks first)
    const cal = call('calibrate', { test: 'temp', start: 220, end: 200 });
    await answerAppConfirm('Start calibration');
    const calr = (await cal).data;
    check(calr.ok && calr.calibration?.mode === 'temp_tower', 'temperature tower set up');
    const np = call('new_project', { name: 'Fresh' });
    await answerAppConfirm('Clear plate');
    check((await np).data.ok && (await call('get_project')).data.name === 'Fresh', 'new project after the confirm');
    const op = (await call('open_project', { path: p3mf.savedTo })).data;
    check(op.ok && op.openedAsProject && op.objects.length > 0, `reopened the saved 3MF (${op.objects.length} objects)`);
  }
  await page.screenshot({ path: join(OUT, 'slicer.png') }).catch(() => {});
} catch (e) {
  failures++;
  log(`ERROR ${e?.stack ?? e}`);
  await page.screenshot({ path: join(OUT, 'failure.png') }).catch(() => {});
} finally {
  if (pageErrors.length) log(`page errors:\n  ${pageErrors.slice(0, 10).join('\n  ')}`);
  await browser.close().catch(() => {});
  await client.close().catch(() => {});
}
log(failures ? `E2E FAILED (${failures})` : 'E2E PASSED');
process.exit(failures ? 1 : 0);
