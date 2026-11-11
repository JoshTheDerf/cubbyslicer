// Design tab, slice 2 (creating things without the sketcher) against the real CAD kernel, in a
// page opened by e2e-design.mjs: CubbyCAD palette shapes as bodies (exact vs mesh, checked against
// CubbyCAD's own meshes), feature cards with pick-driven references (fillet edges clicked in the
// view, the offer menu, Shell / Hole prefilled from picks, a reference re-picked on the rolled-back
// input), circular pattern, boolean, body colour / name, commit as an assembly, slice, save, reopen,
// edit, STEP export → import and File ▸ Import ▸ Open in Design.
import { readFileSync, writeFileSync } from 'node:fs';

export async function createFlow({ page, D, check, shot, settled, run, lap, out }) {
  const screen = (p) => D((p) => window.__cubbyDesign.designViewport().screenPoint(p), p);
  const topo = (body) => D(async (body) => { const W = window.__cubbyDesign; return W.readDesign(async (c, doc) => (await c.call('query_topology', { doc, body })).result); }, body);
  shot = ((orig) => (n) => orig(`c${n}`))(shot);
  console.log('create: cards and picks');
  await page.getByRole('tab', { name: /Design/ }).click();
  await page.waitForSelector('[data-testid="design-view"]');
  await settled((d) => d.phase === 'open', 'design tab open');
  await D(async () => { const W = window.__cubbyDesign; await W.runEdit('Add box', async (c, doc) => (await c.call('extrude', { doc, width: 40, height: 30, distance: 20, name: 'Box' })).result); });
  await settled((d) => d.bodies.length === 1, 'box');
  await D(() => window.__cubbyDesign.designViewport().fitAll());
  await page.waitForTimeout(600);
  await analysisChecks({ page, D, check, shot, settled, run, screen, topo });
  // ---- fillet card from the toolbar menu
  await page.click('[data-testid="design-add-feature"]');
  await page.waitForTimeout(300);
  await shot('01-feature-menu');
  await page.getByRole('menuitem', { name: /^Fillet \/ Chamfer/ }).click();
  await page.waitForSelector('[data-testid="design-card"][data-tool="fillet"]');
  let t = await topo(0);
  // The vertical (lateral) edges, front ones first: the kernel can't shell a box open at a face
  // whose own edges are filleted (it returns the body unchanged; the card refuses that).
  const topEdges = t.edges.filter((e) => Math.abs(e.p0[2] - e.p1[2]) > 19.9 && e.kind === 'line').sort((a, b) => a.p0[1] - b.p0[1]);
  check(topEdges.length === 4, `4 vertical edges (${topEdges.length})`);
  for (const e of topEdges.slice(0, 2)) {
    const mid = [0, 1, 2].map((k) => (e.p0[k] + e.p1[k]) / 2);
    const [x, y] = await screen(mid);
    await page.mouse.click(x, y);
    await page.waitForTimeout(400);
  }
  let c = await D(() => JSON.parse(JSON.stringify(window.__cubbyDesign.card.draft)));
  check(c.edges?.ids?.length === 2, `two edges fed to the card by clicking (${JSON.stringify(c.edges?.ids)}; wanted ${topEdges.slice(0, 2).map((e) => e.id)})`);
  await page.waitForFunction(() => ['ok', 'invalid'].includes(window.__cubbyDesign.card.preview.state), null, { timeout: 120000 });
  const pv = await D(() => ({ ...window.__cubbyDesign.card.preview }));
  check(pv.state === 'ok', `preview: ${pv.text}`);
  await page.fill('[data-field="dressup_size"] input', '3');
  await page.waitForTimeout(1500);
  await shot('02-fillet-card');
  await page.click('[data-testid="design-card-ok"]');
  await settled((d) => d.features.some((f) => f.type === 'Fillet'), 'fillet added');
  check(await D(() => window.__cubbyProject.historyState.value.undo) === 'Add Fillet 3', `undo label: ${await D(() => window.__cubbyProject.historyState.value.undo)}`);
  check(!(await D(() => !!window.__cubbyDesign.card.tool)), 'card closed');
  await shot('03-filleted');
  // ---- offer menu on the top face → Shell
  t = await topo(0);
  const top = t.faces.filter((f) => f.normal[2] > 0.99).sort((a, b) => b.centroid[2] - a.centroid[2])[0];
  const [tx, ty] = await screen(top.centroid);
  await page.mouse.click(tx, ty); await page.waitForTimeout(200);
  await page.mouse.click(tx, ty); await page.waitForTimeout(400); // body → face
  check((await D(() => window.__cubbyDesign.designUi.pick?.kind)) === 'face', 'top face picked');
  await page.mouse.click(tx, ty, { button: 'right' });
  await page.waitForSelector('[role="menu"]');
  await page.waitForTimeout(300);
  await shot('04-offer-face');
  const menuText = await page.locator('[role="menu"]').innerText();
  check(/Flat face/.test(menuText), `offer header: ${menuText.split('\n')[0]}`);
  await page.getByRole('menuitem', { name: /^Remove/ }).hover();
  await page.waitForTimeout(400);
  await page.getByRole('menuitem', { name: /^Shell/ }).click();
  await page.waitForSelector('[data-testid="design-card"][data-tool="shell"]');
  c = await D(() => JSON.parse(JSON.stringify(window.__cubbyDesign.card.draft)));
  check(c.face?.ids?.[0] === top.id, `shell open face prefilled (${JSON.stringify(c.face)})`);
  await page.fill('[data-field="shell_thickness"] input', '1.5');
  await page.waitForFunction(() => ['ok', 'invalid'].includes(window.__cubbyDesign.card.preview.state), null, { timeout: 120000 });
  await page.waitForTimeout(800);
  await shot('05-shell-card');
  await page.click('[data-testid="design-card-ok"]');
  await settled((d) => d.features.some((f) => f.type === 'Shell'), 'shell added');
  // ---- hole on a side face (front, -Y) via Shift+H with the face picked
  t = await topo(0);
  const front = t.faces.filter((f) => f.normal[1] < -0.99).sort((a, b) => a.centroid[1] - b.centroid[1])[0];
  const [fx, fy] = await screen(front.centroid);
  await page.mouse.click(fx + 1, fy); await page.waitForTimeout(200);
  await page.mouse.click(fx + 1, fy); await page.waitForTimeout(400);
  await page.keyboard.press('Shift+H');
  await page.waitForSelector('[data-testid="design-card"][data-tool="hole"]');
  await page.waitForFunction(() => !window.__cubbyDesign.card.resolving);
  c = await D(() => JSON.parse(JSON.stringify(window.__cubbyDesign.card.draft)));
  check(c.face?.ids?.[0] === front.id, `hole face prefilled from the pick (${c.face?.ids})`);
  // Pick: click a spot on the face, off centre
  await page.click('[data-testid="design-card"] [data-pick="card:face"] [data-testid="ref-pick"]');
  const spot = [front.centroid[0] + 8, front.centroid[1], front.centroid[2] - 2];
  const [sx, sy] = await screen(spot);
  await page.mouse.click(sx, sy); await page.waitForTimeout(800);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !window.__cubbyDesign.card.resolving);
  c = await D(() => JSON.parse(JSON.stringify(window.__cubbyDesign.card.draft)));
  check(Math.abs(Math.hypot(c.hole_x, c.hole_y) - Math.hypot(8, 2)) < 1.5, `hole position from the click: (${c.hole_x}, ${c.hole_y})`);
  await page.fill('[data-field="hole_diameter"] input', '5');
  await page.waitForTimeout(300);
  await shot('06-hole-card');
  await page.click('[data-testid="design-card-ok"]');
  await settled((d) => d.features.some((f) => f.type === 'Hole'), 'hole added');
  await shot('07-hole');
  // ---- editor: re-pick the fillet's edges on the rolled-back input
  const fi = await D(() => window.__cubbyDesign.design.features.find((f) => f.type === 'Fillet').index);
  await page.click(`[data-feature="${fi}"]`);
  await page.waitForSelector('[data-testid="design-feature-editor"] [data-pick]');
  await page.click('[data-testid="design-feature-editor"] [data-field="dressup_edges"] [data-testid="ref-pick"]');
  await page.waitForFunction(() => !!window.__cubbyDesign.picking.rollback, null, { timeout: 120000 });
  check(await D(() => window.__cubbyDesign.picking.rollback.bodies[0].face_count) === 6, 'rolled back: the box before the fillet (6 faces)');
  await page.waitForTimeout(600);
  const third = topEdges[2];
  const [ex, ey] = await screen([0, 1, 2].map((k) => (third.p0[k] + third.p1[k]) / 2));
  await page.mouse.click(ex, ey); await page.waitForTimeout(500);
  await shot('08-editor-rollback-pick');
  const pv2 = await D(() => window.__cubbyDesign.picking.value?.ids.slice());
  check(pv2?.length === 3, `third edge added on the input geometry (${pv2})`);
  await page.keyboard.press('Enter');
  await page.click('[data-testid="design-apply"]');
  await settled((d) => !window.__cubbyDesign.picking.spec, 'fillet re-applied');
  const f = await D(async (i) => (await window.__cubbyDesign.getFeature(i)).dressup_edges, fi);
  check(f.length === 3, `fillet now has 3 edges (${f})`);
  check(await D(() => window.__cubbyDesign.design.ok), 'design rebuilds');
  await shot('09-three-edges');
  {
  // start again for the part flow
  await D(() => window.__cubbyProject.resetProject());
  await settled((d) => d.phase === 'open' && !d.features.length, 'empty design');
  console.log('create: palette, part, assembly, files');
  await page.waitForTimeout(500);
  // ---- palette: a box as an exact body
  await page.waitForSelector('[data-testid="design-start-shape"]');
  await page.click('[data-testid="design-start-shape"]');
  await page.waitForSelector('[data-testid="design-view"] .spp');
  await page.waitForTimeout(300);
  await shot('02-palette');
  await page.locator('[data-testid="design-view"] .spp').getByRole('button', { name: /^Box$/ }).click();
  await settled((d) => d.bodies.length === 1, 'box body');
  let s2 = await D(() => ({ f: window.__cubbyDesign.design.features.map((f) => f.type), b: JSON.parse(JSON.stringify(window.__cubbyDesign.design.bodies)) }));
  check(s2.f.join() === 'Import', `the box is exact, one kernel primitive (Import feature): ${s2.f}`);
  const bb = s2.b[0].bbox; const size = [0, 1, 2].map((k) => +(bb.max[k] - bb.min[k]).toFixed(2));
  check(size.join() === '20,20,20', `20 mm box (${size})`);
  // ---- shapes: exact vs mesh, each checked against CubbyCAD's own mesh bbox
  const shapes = ['cylinder', 'sphere', 'cone', 'torus', 'tube', 'capsule', 'halfSphere', 'halfCylinder', 'polygon', 'wedge', 'roof', 'extrudeStar', 'fillet', 'pyramid', 'heart'];
  const rep = await D(async (shapes) => {
    const W = window.__cubbyDesign;
    const { createPrimitiveNode } = await import('/slicer/node_modules/@cubby/shared/src/cad/index.ts');
    const { warmCadMesh, ensureCadWasm } = await import('/slicer/src/cad/build.ts');
    await ensureCadWasm();
    const out = [];
    for (const [k, id] of shapes.entries()) {
      const at = [300 + k * 40, 0, 0];
      const r = await W.addPrimitiveBody(id, { position: at });
      const b = W.design.bodies[r.body];
      const { transform: _t, ...root } = createPrimitiveNode(id, {});
      const m = await warmCadMesh(root);
      const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < m.positions.length; i += 3) for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], m.positions[i + a] + at[a]); mx[a] = Math.max(mx[a], m.positions[i + a] + at[a]); }
      const err = b?.bbox ? Math.max(...[0, 1, 2].flatMap((a) => [Math.abs(b.bbox.min[a] - mn[a]), Math.abs(b.bbox.max[a] - mx[a])])) : null;
      out.push({ id, ok: r.ok, exact: r.exact, err: err === null ? null : +err.toFixed(3), how: r.shapes[0]?.how ?? r.reason, error: r.error });
    }
    return out;
  }, shapes);
  for (const r of rep) check(r.ok && r.err !== null && r.err < (r.exact ? 0.6 : 0.6), `${r.id}: ${r.exact ? 'exact' : 'mesh'} (${r.how}); bbox vs CubbyCAD mesh within ${r.err} mm${r.error ? ' ' + r.error : ''}`);
  writeFileSync(`${out}/shapes.json`, JSON.stringify(rep, null, 1));
  await D(() => window.__cubbyDesign.designViewport().fitAll()); await page.waitForTimeout(800);
  await shot('03-shapes');
  // keep only the box: undo the 15 shape bodies (one undo step each)
  for (let i = 0; i < shapes.length; i++) { await run('edit.undo'); await page.waitForTimeout(150); }
  await settled((d) => d.bodies.length === 1, 'undid the shapes');
  // ---- fillet the lateral edges (group, no picks), shell open top, hole, pattern, boolean
  await page.keyboard.press('Shift+F');
  await page.waitForSelector('[data-testid="design-card"][data-tool="fillet"]');
  await D(async () => { const W = window.__cubbyDesign; await W.setCardValue('face_group', 'Lateral'); await W.setCardValue('dressup_size', 3); });
  await page.click('[data-testid="design-card-ok"]');
  await settled((d) => d.features.some((f) => f.type === 'Fillet'), 'fillet lateral');
  t = await topo(0);
  const top = t.faces.filter((f) => f.normal[2] > 0.99).sort((a, b) => b.centroid[2] - a.centroid[2])[0];
  await D((top) => { const W = window.__cubbyDesign; W.designUi.pick = { kind: 'face', body: 0, face: top.id, generation: W.design.generation }; }, top);
  await page.keyboard.press('Shift+K');
  await page.waitForSelector('[data-testid="design-card"][data-tool="shell"]');
  await D(() => window.__cubbyDesign.setCardValue('shell_thickness', 1.5));
  await page.click('[data-testid="design-card-ok"]');
  await settled((d) => d.features.some((f) => f.type === 'Shell'), 'shell');
  const vol = () => D(async () => { const W = window.__cubbyDesign; return W.readDesign(async (c, doc) => (await c.call('mass_properties', { doc, body: 0 })).result.volume); });
  const v1 = await vol();
  check(v1 < 4000, `hollow: volume ${v1.toFixed(0)} mm³ (a 20 mm box is 8000)`);
  // a cylinder off-centre, patterned circularly about the box's axis, subtracted
  const o = await D(() => window.__cubbyDesign.design.modelingOrigin.slice());
  await D(async (o) => { await window.__cubbyDesign.addPrimitiveBody('cylinder', { position: [o[0] + 6, o[1], -1], params: { radius: 1.5, height: 30 } }); }, o);
  await settled((d) => d.bodies.length === 2, 'peg body');
  await D(() => { window.__cubbyDesign.designUi.pick = { kind: 'body', body: 1 }; });
  await page.keyboard.press('Shift+N');
  await page.waitForSelector('[data-testid="design-card"][data-tool="pattern"]');
  await D(async () => { const W = window.__cubbyDesign; await W.setCardValue('pattern_circular', 1); await W.setCardValue('pattern_count', 4); });
  await page.waitForFunction(() => ['ok', 'invalid'].includes(window.__cubbyDesign.card.preview.state), null, { timeout: 120000 });
  await page.waitForTimeout(600);
  await shot('04-pattern-card');
  await page.click('[data-testid="design-card-ok"]');
  await settled((d) => d.features.some((f) => f.type === 'Pattern'), 'circular pattern');
  await D(() => { window.__cubbyDesign.designUi.pick = { kind: 'body', body: 0 }; });
  await page.keyboard.press('Shift+B');
  await page.waitForSelector('[data-testid="design-card"][data-tool="boolean"]');
  await D(async () => { const W = window.__cubbyDesign; await W.setCardValue('mode', 'Cut'); await W.setCardValue('target_body', 0); await W.setCardValue('bool_tool_body', 1); });
  await page.waitForTimeout(1500);
  await shot('05-boolean-card');
  await page.click('[data-testid="design-card-ok"]');
  await settled((d) => d.features.some((f) => f.type === 'Boolean'), 'boolean subtract');
  const v2 = await vol();
  check(v2 < v1 - 1, `the pattern cut the walls: ${v1.toFixed(0)} → ${v2.toFixed(0)} mm³`);
  const nb1 = await D(() => window.__cubbyDesign.design.bodies.length);
  check(nb1 === 1, `one body after the cut (${nb1})`);
  // a second body kept separate (assembly), body colour, rename
  await D(async (o) => { await window.__cubbyDesign.addPrimitiveBody('sphere', { position: [o[0] + 30, o[1], 0], params: { radius: 6 } }); }, o);
  await settled((d) => d.bodies.length === 2, 'sphere body');
  await D(async () => { const C = window.__cubbyDesign; await C.setBodyColor(1, '#e05a2b'); await C.renameBody(1, 'Knob'); });
  await settled((d) => d.bodies[1].has_color && d.bodies[1].name === 'Knob', 'colour + name');
  await D(() => window.__cubbyDesign.designViewport().fitAll()); await page.waitForTimeout(800);
  await shot('06-part');
  // ---- commit as one assembly
  await page.click('[data-testid="design-commit-mode"]');
  await page.waitForTimeout(300);
  await shot('06b-commit-modes');
  await page.getByRole('menuitem', { name: /As one assembly object/ }).click();
  check(await D(async () => (await import('/slicer/src/app/preferences.ts')).preferences.designCommitMode) === 'assembly', 'commit mode: one assembly object');
  await page.click('[data-testid="design-commit"]');
  await page.waitForFunction(() => window.__cubbyProject.objects.value.length === 1);
  let objs = await D(() => window.__cubbyProject.objects.value.map((o) => ({ name: o.name, design: !!o.design, parts: (o.parts ?? []).map((p) => ({ name: p.name, design: !!p.design })) })));
  check(objs.length === 1 && objs[0].name.startsWith('Design Assembly') && objs[0].parts.length === 1 && objs[0].design && objs[0].parts[0].design, `one assembly object with a linked part per body: ${JSON.stringify(objs)}`);
  await page.waitForTimeout(800);
  await shot('07-committed');
  // ---- slice
  await page.getByRole('button', { name: /Slice plate|Re-slice/ }).click();
  await page.waitForFunction(() => { const b = document.querySelector('.slicebar'); return b && (b.classList.contains('done') || b.classList.contains('error')); }, null, { timeout: 900_000, polling: 1000 });
  const sl = await page.evaluate(async () => { const r = (await import('/slicer/src/app/state.ts')).lastSlice.value; return r ? { bytes: r.gcode.byteLength, layers: r.report?.stats?.layers ?? null } : null; });
  check(sl?.bytes > 10_000, `sliced: ${JSON.stringify(sl)}`);
  // ---- save, reopen, edit
  const [dl] = await Promise.all([page.waitForEvent('download'), run('file.save')]);
  const saved = `${out}/saved.3mf`; await dl.saveAs(saved);
  await D(() => window.__cubbyProject.resetProject()); await page.waitForTimeout(500);
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), run('file.open')]);
  await fc.setFiles(saved);
  await page.waitForFunction(() => window.__cubbyProject.objects.value.length === 1, null, { timeout: 120000 });
  objs = await D(() => window.__cubbyProject.objects.value.map((o) => ({ design: o.design ? { ...o.design } : null, parts: (o.parts ?? []).map((p) => (p.design ? { ...p.design } : null)), meshes: [o.meshId, ...(o.parts ?? []).map((p) => p.meshId)] })));
  check(!!objs[0].design && !!objs[0].parts[0], 'links survive save / reopen (object + part)');
  await page.getByRole('tab', { name: /Design/ }).click();
  await settled((d) => d.phase === 'open' && d.bodies.length === 2, 'reopened design');
  const hole = await D(() => window.__cubbyDesign.design.features.findIndex((f) => f.type === 'Shell'));
  await D(async (i) => { await window.__cubbyDesign.setFeatureParams(i, { shell_thickness: 2.5 }); }, hole);
  await settled((d) => d.ok, 'edit after reopen');
  const after = await D(() => window.__cubbyProject.objects.value.map((o) => [o.meshId, ...(o.parts ?? []).map((p) => p.meshId)]));
  check(after[0][0] !== objs[0].meshes[0] && after[0][1] === objs[0].meshes[1], `the edited body's mesh follows; the other part keeps its mesh (${JSON.stringify(objs[0].meshes)} → ${JSON.stringify(after[0])})`);
  // ---- STEP out and back in
  const step = await D(async () => { const r = await window.__cubbyDesign.exportStepBytes(); return { n: r.bytes.length, head: new TextDecoder().decode(r.bytes.slice(0, 20)), bytes: Array.from(r.bytes) }; });
  check(step.n > 1000 && /ISO-10303-21/.test(step.head), `STEP export: ${step.n} bytes`);
  writeFileSync(`${out}/design.step`, Buffer.from(step.bytes));
  const before = await D(() => window.__cubbyDesign.design.bodies.length);
  const r = await D(async (b) => { const x = await window.__cubbyDesign.importStepToDesign('roundtrip.step', new Uint8Array(b)); return { ok: x.ok, error: x.error, features: x.features }; }, step.bytes);
  await settled((d) => d.features.filter((f) => f.type === 'Import').length >= 2, 'STEP imported');
  check(r.ok && r.features.length === 2, `STEP import: ${r.features.length} exact bodies (${r.error ?? ''})`);
  const imp = await D(() => window.__cubbyDesign.design.features.slice(-2).map((f) => `${f.type}:${f.name}`));
  check(imp.every((x) => x.startsWith('Import:roundtrip')), `named after the file: ${imp}`);
  // ---- File → Import a STEP file → "Open in Design"
  const [fc2] = await Promise.all([page.waitForEvent('filechooser'), run('file.import')]);
  await fc2.setFiles(`${out}/design.step`);
  await page.waitForSelector('[data-testid="step-open-in-design"]', { timeout: 60000 });
  await shot('08-step-dialog');
  const nb = await D(() => window.__cubbyDesign.design.bodies.length);
  await page.click('[data-testid="step-open-in-design"]');
  await settled((d) => d.features.filter((f) => f.type === 'Import').length >= 4, 'Open in Design');
  check(await D(() => window.__cubbyProject.objects.value.length) === 1, 'nothing added to the plate');
  await D(() => window.__cubbyDesign.designViewport().fitAll()); await page.waitForTimeout(800);
  await shot('09-imported');
  // ---- Prepare: a CubbyCAD group with a hole → Convert to Design body (exact booleans)
  await run('view.prepare');
  const gid = await D(async () => {
    const C = await import('/slicer/src/cad/commands.ts');
    const a = await C.addShape('box', { params: { width: 30, depth: 30, height: 10 }, position: [60, 60, 0] });
    const b = await C.addShape('cylinder', { params: { radius: 5, height: 20 }, hole: true, position: [60, 60, -5] });
    return C.groupObjectsAsync([a, b], 'Plate with hole');
  });
  await D((id) => window.__cubbyProject.select([id]), gid);
  const nf = await D(() => window.__cubbyDesign.design.features.length);
  await run('object.to-design');
  await settled((d) => d.bodies.some((b) => b.name === 'Plate with hole'), 'Convert to Design body');
  check(await D(() => window.__cubbyDesign.design.features.length) > nf, 'features were added');
  const conv = await D(() => { const W = window.__cubbyDesign; const b = W.design.bodies.find((x) => x.name === 'Plate with hole'); return { types: W.design.features.slice(-5).map((f) => f.type), bbox: b?.bbox, faces: b?.face_count }; });
  check(conv.types.includes('Boolean') && !conv.types.includes('Import'), `the group converts exactly (box − cylinder as a kernel boolean): ${conv.types}`);
  const csize = conv.bbox ? [0, 1, 2].map((k) => +(conv.bbox.max[k] - conv.bbox.min[k]).toFixed(1)) : null;
  check(csize?.join() === '30,30,10' && conv.faces === 7, `where it sat, with its hole: ${csize}, ${conv.faces} faces`);
  await page.waitForTimeout(600);
  await shot('10-converted');
  }
  await assemblySurfaceFlow({ page, D, check, shot, settled });
  lap('coordinate systems, mate, surfaces checked');
  await regionExtrudeFlow({ page, D, check, shot, settled });
  lap('region extrude checked');
}

// ---- verification flow (FLOWS=verify): what the creation slice could not check ------------------
// Cooperative Cancel of a long rebuild (shared-memory flag → cadProgress → rollback, the document
// stays open) and its fallback (terminate) on a page that isn't cross-origin isolated; the Thread
// card against the real kernel (external on a cylinder, internal in a bore, standard snapped);
// Extrude / Revolve / Sweep / Loft cards on the sketches of Orca's golden fixture; the icon-only
// body Pick button of a card; a design-only project opening on the Design tab; an STL as a mesh body.
export async function verifyFlow({ page, D, check, shot, settled, run, lap, out, fixturePath, failing, browser, base }) {
  const screen = (p) => D((p) => window.__cubbyDesign.designViewport().screenPoint(p), p);
  const topo = (body) => D(async (body) => { const W = window.__cubbyDesign; return W.readDesign(async (c, doc) => (await c.call('query_topology', { doc, body })).result); }, body);
  const vol = (body) => D(async (body) => { const W = window.__cubbyDesign; return W.readDesign(async (c, doc) => (await c.call('mass_properties', { doc, body })).result.volume); }, body);
  shot = ((orig) => (n) => orig(`v${n}`))(shot);
  const reset = async () => {
    await D(() => window.__cubbyProject.resetProject());
    await settled((d) => d.phase === 'open' && !d.features.length, 'empty design');
  };
  const clickFace = async (centroid) => {
    const [x, y] = await screen(centroid);
    await page.mouse.click(x, y); await page.waitForTimeout(250);
    if ((await D(() => window.__cubbyDesign.designUi.pick?.kind)) !== 'face') { await page.mouse.click(x, y); await page.waitForTimeout(400); }
    return D(() => JSON.parse(JSON.stringify(window.__cubbyDesign.designUi.pick)));
  };
  const fit = async () => { await D(() => window.__cubbyDesign.designViewport().fitAll()); await page.waitForTimeout(700); };
  const confirm = async (what, pred) => {
    await page.click('[data-testid="design-card-ok"]');
    await settled(pred, what);
    return D(() => ({ cardOpen: !!window.__cubbyDesign.card.tool, cardError: window.__cubbyDesign.card.error, ok: window.__cubbyDesign.design.ok, error: window.__cubbyDesign.design.error }));
  };
  await page.getByRole('tab', { name: /Design/ }).click();
  await page.waitForSelector('[data-testid="design-view"]');
  await reset();
  const origin = await D(() => window.__cubbyDesign.design.modelingOrigin.slice());

  // ---- 1. cooperative Cancel of a long rebuild ----------------------------------------------
  console.log('verify: cancel');
  check(await D(() => self.crossOriginIsolated === true), 'the page is cross-origin isolated (shared-memory cancel flag)');
  const holes = 64;
  const built = await D(async (n) => {
    const W = window.__cubbyDesign;
    return W.runEdit('Plate with holes', async (c, doc) => {
      let r = (await c.call('extrude', { doc, width: 120, height: 120, distance: 6, name: 'Plate' })).result;
      for (let i = 0; i < n && r.ok; i++) r = (await c.call('hole', { doc, diameter: 3, through: true, x: -52.5 + (i % 8) * 15, y: -52.5 + Math.floor(i / 8) * 15, plane: 'XY', name: `H${i + 1}` })).result;
      return r;
    });
  }, holes);
  check(built.ok, `a plate with ${holes} holes (${built.error || 'ok'})`);
  await settled((d) => d.features.length === 66, 'plate with holes'); // 2 + holes (the predicate runs in the page)
  const s0 = await D(() => { const W = window.__cubbyDesign; return { gen: W.design.generation, n: W.design.features.length, resets: W.designKernel().status.resets }; });
  await D(() => { window.__e2eEdit = window.__cubbyDesign.setFeatureParams(1, { distance: 9 }); });
  // the busy pill's Cancel button, clicked as soon as the kernel reports a few replayed features
  const cancelBtn = page.locator('[data-testid="design-cancel"]');
  await cancelBtn.waitFor({ state: 'visible', timeout: 120_000 });
  await page.waitForFunction(() => { const r = window.__cubbyDesign.designKernel().status.rebuild; return !!r && r.index >= 3 && r.index < r.count; }, null, { timeout: 300_000, polling: 20 });
  const prog = await D(() => ({ ...window.__cubbyDesign.designKernel().status.rebuild, shown: document.querySelector('[data-testid="design-rebuild-progress"]')?.textContent ?? '' }));
  await cancelBtn.click({ timeout: 10_000 });
  const tCancel = Date.now();
  check(prog.count === 2 + holes && /H\d+/.test(prog.name) && /Feature \d+ of \d+/.test(prog.shown), `rebuild progress from the kernel: feature ${prog.index + 1} of ${prog.count} — ${prog.name}; the pill shows "${prog.shown}"`);
  const co = await D(() => window.__e2eEdit.then((r) => ({ ok: r.ok, error: r.error, cancelled: !!r.result?.cancelled, kerr: r.result?.error })));
  const s1 = await D(async () => { const W = window.__cubbyDesign; return { gen: W.design.generation, n: W.design.features.length, resets: W.designKernel().status.resets, phase: W.design.phase, status: W.design.status?.text ?? '', dist: (await W.getFeature(1)).distance }; });
  check(co.error === 'cancelled' && co.cancelled && co.kerr === 'rebuild cancelled', `cancel answered by the kernel in ${Date.now() - tCancel} ms: ${JSON.stringify(co)}`);
  check(s1.resets === s0.resets, `clean cancel: the kernel instance was not terminated (resets ${s0.resets} → ${s1.resets})`);
  check(s1.phase === 'open' && s1.n === s0.n && s1.gen === s0.gen && s1.dist === 6, `rolled back, the document stays open (gen ${s0.gen} → ${s1.gen}, distance ${s1.dist})`);
  check(/Cancelled/.test(s1.status), `status: ${s1.status}`);
  await shot('01-cancelled');
  const after = await D(() => window.__cubbyDesign.setFeatureParams(1, { distance: 7 }));
  check(after.ok, 'the next edit works on the same instance');
  // fallback: a page without cross-origin isolation can only terminate the worker
  {
    const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx2.addInitScript(() => { try { localStorage.setItem('cubby.setup.done', 'true'); } catch {} });
    await ctx2.route('**/*', async (route) => {
      if (route.request().resourceType() !== 'document') return route.continue();
      const resp = await route.fetch();
      const headers = { ...resp.headers() };
      delete headers['cross-origin-opener-policy']; delete headers['cross-origin-embedder-policy'];
      await route.fulfill({ response: resp, headers });
    });
    const p2 = await ctx2.newPage();
    p2.setDefaultTimeout(180_000);
    await p2.goto(`${base}?cubby-debug`, { waitUntil: 'networkidle' });
    await p2.waitForFunction(() => !!window.__cubbyProject && !!window.__cubbyDesign);
    check(await p2.evaluate(() => self.crossOriginIsolated === false), 'second page: not cross-origin isolated');
    await p2.evaluate(() => window.__cubbyProject.resetProject());
    await p2.getByRole('tab', { name: /Design/ }).click();
    const idle = (pred) => p2.waitForFunction((src) => { const W = window.__cubbyDesign, k = W.designKernel().status; if (k.busy || k.queued || k.phase === 'starting' || W.design.phase !== 'open') return false; return Function('d', `return (${src})(d)`)(W.design); }, pred.toString(), { timeout: 600_000, polling: 500 });
    await idle(() => true);
    await p2.evaluate(async () => { const W = window.__cubbyDesign; await W.runEdit('Plate', async (c, doc) => { let r = (await c.call('extrude', { doc, width: 60, height: 60, distance: 6 })).result; for (let i = 0; i < 64 && r.ok; i++) r = (await c.call('hole', { doc, diameter: 2, through: true, x: -26.25 + (i % 8) * 7.5, y: -26.25 + Math.floor(i / 8) * 7.5, plane: 'XY' })).result; return r; }); });
    await idle((d) => d.features.length === 66);
    const r0 = await p2.evaluate(() => window.__cubbyDesign.designKernel().status.resets);
    await p2.evaluate(() => { window.__e2eEdit = window.__cubbyDesign.setFeatureParams(1, { distance: 9 }); });
    await p2.locator('[data-testid="design-cancel"]').waitFor({ state: 'visible', timeout: 120_000 });
    await p2.waitForFunction(() => { const r = window.__cubbyDesign.designKernel().status.rebuild; return !!r && r.index >= 3 && r.index < r.count; }, null, { timeout: 300_000, polling: 20 });
    await p2.click('[data-testid="design-cancel"]', { timeout: 10_000 });
    const co2 = await p2.evaluate(() => window.__e2eEdit.then((r) => ({ ok: r.ok, error: r.error }), (e) => ({ ok: false, threw: String(e?.message ?? e) })));
    await idle((d) => d.features.length === 66);
    const r1 = await p2.evaluate(async () => ({ resets: window.__cubbyDesign.designKernel().status.resets, dist: (await window.__cubbyDesign.getFeature(1)).distance, bodies: window.__cubbyDesign.design.bodies.length }));
    check(!co2.ok && r1.resets === r0 + 1, `not isolated: Cancel terminates the worker (resets ${r0} → ${r1.resets}; ${JSON.stringify(co2)})`);
    check(r1.dist === 6 && r1.bodies === 1, `…and the design reopens from its saved bytes (distance ${r1.dist}, ${r1.bodies} body)`);
    await p2.screenshot({ path: `${out}/v02-cancel-terminated.png` });
    await ctx2.close();
  }
  lap('cancel checked');

  // ---- 2. the icon-only body Pick button in a card -------------------------------------------
  console.log('verify: body pick');
  await D(async (o) => { await window.__cubbyDesign.addPrimitiveBody('cylinder', { position: [o[0] + 90, o[1], 0], params: { radius: 6, height: 12 } }); }, origin);
  await settled((d) => d.bodies.length === 2, 'a second body');
  await fit();
  await D(() => { window.__cubbyDesign.designUi.pick = { kind: 'body', body: 0 }; });
  await page.keyboard.press('Shift+B');
  await page.waitForSelector('[data-testid="design-card"][data-tool="boolean"]');
  await D(() => window.__cubbyDesign.setCardValue('bool_tool_body', 0));
  const btn = page.locator('[data-testid="design-card"] [data-pick="card:bool_tool_body"] [data-testid="ref-pick"]');
  const bi = await btn.evaluate((b) => ({ text: b.textContent.trim(), label: b.getAttribute('aria-label'), w: b.getBoundingClientRect().width, icon: !!b.querySelector('[class*="i-lucide"], svg, span[class*="iconify"]') }));
  check(bi.text === '' && /Pick Tool/.test(bi.label) && bi.w < 40, `body Pick is icon-only (${JSON.stringify(bi)})`);
  await btn.click();
  check(await D(() => window.__cubbyDesign.picking.spec?.key) === 'card:bool_tool_body', 'it makes the Tool row the picking field');
  const b1 = await D(() => window.__cubbyDesign.design.bodies[1].bbox);
  const [cx, cy] = await screen([0, 1, 2].map((k) => (b1.min[k] + b1.max[k]) / 2));
  await page.mouse.click(cx, cy); await page.waitForTimeout(600);
  await shot('03-body-pick');
  const dr = await D(() => ({ tool: window.__cubbyDesign.card.draft.bool_tool_body, spec: window.__cubbyDesign.picking.spec?.key ?? null }));
  if (dr.spec) await page.keyboard.press('Enter');
  check(dr.tool === 1, `clicking body 1 in the view sets the Tool (${JSON.stringify(dr)})`);
  await D(() => window.__cubbyDesign.cancelCard());

  // ---- 3. the Thread card against the real kernel --------------------------------------------
  console.log('verify: thread');
  await reset();
  await D(async (o) => { await window.__cubbyDesign.addPrimitiveBody('cylinder', { position: [o[0], o[1], 0], params: { radius: 4, height: 16 } }); }, origin);
  await settled((d) => d.bodies.length === 1, 'a Ø8 cylinder');
  await fit();
  let t = await topo(0);
  const lat = t.faces.find((f) => f.kind === 'cylindrical');
  // a point on the side wall facing the camera: try the four sides until the click lands on it
  let pk = null, spotOn = null;
  for (const [dx, dy] of [[0, -4], [-4, 0], [4, 0], [0, 4]]) {
    await D(() => { window.__cubbyDesign.designUi.pick = null; });
    const p = [origin[0] + dx, origin[1] + dy, 8];   // the Ø8 rod stands on the origin
    pk = await clickFace(p);
    if (pk?.kind === 'face' && pk.face === lat.id) { spotOn = p; break; }
  }
  check(!!spotOn, `cylinder side face picked in the view (${JSON.stringify(pk)})`);
  await page.mouse.click(...(await screen(spotOn ?? lat.centroid)), { button: 'right' });
  await page.waitForSelector('[role="menu"]');
  await page.waitForTimeout(300);
  await shot('04-offer-cylinder');
  await page.getByRole('menuitem', { name: /^Remove/ }).hover();
  await page.waitForTimeout(400);
  await page.getByRole('menuitem', { name: /^Thread/ }).click();
  await page.waitForSelector('[data-testid="design-card"][data-tool="thread"]');
  await page.waitForFunction(() => !window.__cubbyDesign.card.resolving);
  let c = await D(() => JSON.parse(JSON.stringify(window.__cubbyDesign.card.draft)));
  check(c.standard === 'M8' && c.thread_internal === false && Math.abs(c.thread_pitch - 1.25) < 1e-9 && Math.abs(c.thread_height - 16) < 0.01, `external: snapped to ${c.standard} pitch ${c.thread_pitch}, length ${c.thread_height}, internal ${c.thread_internal}`);
  await shot('05-thread-card');
  const v0 = await vol(0);
  let rr = await confirm('external thread', (d) => d.features.some((f) => f.type === 'Thread') || !!window.__cubbyDesign.card.error);
  const v1 = await vol(0);
  t = await topo(0);
  check(rr.ok && !rr.cardOpen && t.face_count > 3 && Math.abs(v1 - v0) > 1, `M8 external thread built: ${t.face_count} faces, volume ${v0.toFixed(0)} → ${v1.toFixed(0)} (${rr.error || rr.cardError || 'ok'})`);
  await fit(); await shot('06-thread-external');
  // internal: a block with a Ø6.8 bore (the M8 tap drill). The card snaps a bore by its minor
  // diameter over every series, so this is 5/16-24 UNF (minor 6.9), not M8 (6.65). A bore of exactly
  // M8's minor diameter is not used: Orca's internal-thread boolean then removes nothing at some
  // placements ("thread removed no material"; reproduced with add_feature in node, kernel side).
  await reset();
  await D(async () => {
    const W = window.__cubbyDesign;
    await W.runEdit('Block with bore', async (c, doc) => {
      const r = (await c.call('box', { doc, width: 20, depth: 20, height: 12, name: 'Block' })).result;
      return r.ok ? (await c.call('hole', { doc, diameter: 6.8, through: true, x: 0, y: 0, plane: 'XY' })).result : r;
    });
  });
  await settled((d) => d.features.length === 2 && d.bodies.length === 1, 'block with a bore');
  await fit();
  t = await topo(0);
  const bore = t.faces.find((f) => f.kind === 'cylindrical');
  await D((p) => { const W = window.__cubbyDesign; W.designUi.pick = { kind: 'face', body: 0, face: p, generation: W.design.generation }; }, bore.id);
  await D(() => window.__cubbyDesign.openCard('thread', { pick: window.__cubbyDesign.designUi.pick }));
  await page.waitForSelector('[data-testid="design-card"][data-tool="thread"]');
  await page.waitForFunction(() => !window.__cubbyDesign.card.resolving);
  c = await D(() => JSON.parse(JSON.stringify(window.__cubbyDesign.card.draft)));
  check(/^(M8|5\/16)/.test(c.standard) && c.thread_internal === true && Math.abs(c.thread_height - 12) < 0.01, `internal: snapped to ${c.standard}, internal ${c.thread_internal}, length ${c.thread_height}`);
  const vb0 = await vol(0);
  rr = await confirm('internal thread', (d) => d.features.some((f) => f.type === 'Thread') || !!window.__cubbyDesign.card.error);
  const vb1 = await vol(0);
  check(rr.ok && !rr.cardOpen && vb1 < vb0 - 1, `internal thread cut into the bore: volume ${vb0.toFixed(0)} → ${vb1.toFixed(0)} (${rr.error || rr.cardError || 'ok'})`);
  await shot('07-thread-internal');
  lap('thread checked');

  // ---- 4. a design-only project opens on the Design tab --------------------------------------
  console.log('verify: design-only project');
  await reset();
  await D(async (o) => { await window.__cubbyDesign.addPrimitiveBody('box', { position: [o[0], o[1], 0] }); }, origin);
  await settled((d) => d.bodies.length === 1, 'box');
  check(await D(() => window.__cubbyProject.objects.value.length) === 0, 'nothing on the plate');
  const [dl] = await Promise.all([page.waitForEvent('download'), run('file.save')]);
  const savedPath = `${out}/design-only.3mf`; await dl.saveAs(savedPath);
  await D(() => window.__cubbyProject.resetProject());
  await run('view.prepare');
  await page.waitForTimeout(500);
  check(await D(async () => (await import('/slicer/src/app/state.ts')).activeView.value) === 'prepare', 'on Prepare before opening');
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), run('file.open')]);
  await fc.setFiles(savedPath);
  await page.waitForFunction(async () => (await import('/slicer/src/app/state.ts')).activeView.value === 'design', null, { timeout: 120_000, polling: 300 });
  await settled((d) => d.phase === 'open' && d.bodies.length === 1, 'design-only project opened');
  check(await D(() => window.__cubbyProject.objects.value.length) === 0, 'opened on the Design tab, its body there, nothing on the plate');
  await shot('08-design-only');

  // ---- 5. an STL as a mesh body ----------------------------------------------------------------
  console.log('verify: STL');
  const [fc3] = await Promise.all([page.waitForEvent('filechooser'), run('design.import-mesh')]);
  await fc3.setFiles(`${process.cwd()}/public/calib/handy/OrcaCube_v2.stl`);
  await settled((d) => d.bodies.length === 2, 'STL imported');
  const stl = await D(() => { const W = window.__cubbyDesign; const f = W.design.features.at(-1), b = W.design.bodies[1]; return { type: f.type, name: f.name, faces: b.face_count, solid: b.is_solid, size: b.bbox ? [0, 1, 2].map((k) => +(b.bbox.max[k] - b.bbox.min[k]).toFixed(1)) : null, status: W.design.status?.text ?? '' }; });
  check(stl.type === 'Import' && /OrcaCube/.test(stl.name) && stl.faces > 6 && stl.size?.every((s) => s > 25 && s < 40), `STL → mesh body: ${JSON.stringify(stl)}`);
  await fit(); await shot('09-stl');

  // ---- 6. Extrude / Revolve / Sweep / Loft on the golden fixture's sketches -------------------
  console.log('verify: sketch cards on the fixture');
  await D(() => window.__cubbyProject.resetProject());
  const [fc4] = await Promise.all([page.waitForEvent('filechooser'), run('file.open')]);
  await fc4.setFiles(fixturePath);
  await page.getByRole('tab', { name: /Design/ }).click();
  await settled((d) => d.phase === 'open' && d.features.length === 34, 'fixture open');
  await D(async (F) => { await window.__cubbyDesign.setSuppressed(F, true, { force: true }); }, failing);
  await settled((d) => d.ok && d.bodies.length === 6, 'fixture repaired');
  const cards = [
    ['extrude', { sketch_ref: 20, mode: 'New', distance: 4 }, 'Extrude', 20],
    ['revolve', { sketch_ref: 11, mode: 'New', axis: 'y', revolve_angle: 180 }, 'Revolve', 11],
    ['sweep', { sketch_ref: 13, sweep_path_ref: 14, mode: 'New' }, 'Sweep', 13],
    ['loft', { loft_profile_refs: [16, 17], mode: 'New', loft_ruled: true }, 'Loft', 16],
  ];
  for (const [id, vals, type, sk] of cards) {
    const n0 = await D(() => window.__cubbyDesign.design.features.length);
    const err = await D((id) => window.__cubbyDesign.openCard(id), id);
    if (err) { check(false, `${id} card: ${err}`); continue; }
    await page.waitForSelector(`[data-testid="design-card"][data-tool="${id}"]`);
    for (const [k, v] of Object.entries(vals)) await D(([k, v]) => window.__cubbyDesign.setCardValue(k, v), [k, v]);
    await page.waitForFunction(() => !window.__cubbyDesign.card.resolving);
    await shot(`10-${id}-card`);
    await D((n) => { window.__e2eN0 = n; }, n0);   // settled() predicates run in the page: no closures
    rr = await confirm(`${id} on sketch ${sk}`, (d) => d.features.length > window.__e2eN0 || !!window.__cubbyDesign.card.error);
    const f = await D(() => { const W = window.__cubbyDesign; const f = W.design.features.at(-1); return { type: f.type, n: W.design.features.length, bodies: W.design.bodies.length }; });
    const full = f.type === type ? await D(async (i) => window.__cubbyDesign.getFeature(i), f.n - 1) : null;
    const refOk = full && (type === 'Loft' ? JSON.stringify(full.loft_profile_refs) === '[16,17]' : full.sketch_ref === sk) && (type !== 'Sweep' || full.sweep_path_ref === 14);
    check(rr.ok && f.n === n0 + 1 && refOk, `${type} card on the fixture's sketch ${sk}: ${f.n - n0} feature added, ${f.bodies} bodies (${rr.error || rr.cardError || 'ok'})`);
  }
  await fit(); await shot('11-fixture-sketch-features');
  lap('sketch cards checked');
}

// ---- MCP design tools through the bridge (called by e2e-bridge.mjs with its client) -------------
// Every design_* tool once against the real kernel: a fresh design (primitive, verbs, reads,
// edits, history, bodies, files), each result checked for the shape the tool documents.
export async function bridgeDesignFlow({ call, check, log, out }) {
  const D = async (name, args = {}, opts) => (await call(`design_${name}`, args, opts)).data;
  log('---- design tools');
  let sc = await D('describe_scene', { show: true });
  check(typeof sc.generation === 'number' && Array.isArray(sc.features), 'design_describe_scene opens the design');
  const p0 = await D('add_primitive', { shape: 'box', params: { width: 40, depth: 30, height: 20 }, position: [100, 100, 0], name: 'Base' });
  check(p0.ok && p0.exact && p0.body === sc.bodies.length, `design_add_primitive box: body ${p0.body}, ${p0.shapes?.[0]?.how}`);
  sc = await D('describe_scene');
  const b0 = sc.bodies.length - 1;
  let tp = await D('query_topology', { body: b0 });
  check(tp.face_count === 6 && tp.edges.length === 12, `design_query_topology: ${tp.face_count} faces, ${tp.edges.length} edges`);
  const top = tp.faces.find((f) => f.normal[2] > 0.99), side = tp.faces.find((f) => f.normal[0] > 0.99);
  const fi = await D('face_info', { body: b0, face: top.id, generation: tp.generation });
  check(fi.surface === 'plane' && fi.edges.length === 4, `design_face_info: ${fi.surface}, ${fi.edges.length} edges`);
  const ei = await D('edge_info', { body: b0, edge: fi.edges[0], generation: tp.generation });
  check(ei.curve === 'line' && ei.faces.length === 2 && ei.polyline === undefined, `design_edge_info: ${ei.curve}, faces ${ei.faces}`);
  const pf = await D('plane_of_face', { body: b0, face: top.id, generation: tp.generation });
  check(pf.ok && Math.abs(pf.plane.normal[2]) > 0.99, 'design_plane_of_face');
  const dt = await D('datums');
  check(dt.base_planes.length === 3, 'design_datums');
  const mp = await D('mass_properties', { body: b0 });
  check(Math.abs(mp.volume - 24000) < 1e-6, `design_mass_properties: ${mp.volume}`);
  const arr = (x) => (Array.isArray(x) ? x : x?.result ?? []);   // the MCP result wraps arrays as {result}
  const ts = arr(await D('thread_standards')), hs = arr(await D('hole_standards'));
  check(ts.some((t) => t.name === 'M8') && hs.some((h) => h.designation === 'M6'), `design_thread_standards (${ts.length}) / design_hole_standards (${hs.length})`);
  // verbs (strict: must build; loose: the tool answers with a result — geometry not judged)
  const chk = async (verb, args, key, strict = true) => {
    const r = await D(verb, args, strict ? undefined : { expectError: true });   // a refusal is an MCP error result
    if (strict) check(r.ok && (!key || typeof r[key] === 'number'), `design_${verb}: ${r.ok ? (key ? `${key} ${r[key]}` : 'ok') : r.error}`);
    else check(typeof r.ok === 'boolean' && typeof r.generation === 'number', `design_${verb} answers: ${r.ok ? 'ok' : `ok:false ${r.error}`}`);
    return r;
  };
  const shNoop = await D('shell', { thickness: 1, face: -1, body: b0 }, { expectError: true });
  check(!shNoop.ok && /closed hollow|sheet/.test(shNoop.error ?? ''), `design_shell closed hollow refused: ${shNoop.error}`);
  await chk('shell', { thickness: 1.5, face: top.id, body: b0, generation: tp.generation }, 'shell_index');
  tp = await D('query_topology', { body: b0 });
  const sideNow = tp.faces.filter((f) => f.normal[0] > 0.99 && f.surface === 'plane').sort((a, b) => b.centroid[0] - a.centroid[0])[0];
  const sp = await D('plane_of_face', { body: b0, face: sideNow.id, generation: tp.generation });
  const inward = { ...sp.plane, normal: sp.plane.normal.map((v) => -v) };
  await chk('hole', { diameter: 4, through: true, x: 0, y: 0, plane: inward, body: b0 }, 'hole_index');
  await chk('hole_styled', { style: 1, diameter: 3, cbore_diameter: 6, cbore_depth: 1, through: true, x: 6, y: 6, plane: inward, body: b0 }, 'hole_index');
  await chk('hole_standard', { designation: 'M3', style: 0, through: true, x: -6, y: -6, plane: inward }, 'hole_index');
  // a solid block for the dress-ups
  await D('add_primitive', { shape: 'box', params: { width: 30, depth: 30, height: 15 }, position: [100, 160, 0], name: 'Block' });
  sc = await D('describe_scene');
  const b1 = sc.bodies.length - 1;
  tp = await D('query_topology', { body: b1 });
  const vert = tp.edges.filter((e) => e.kind === 'line' && Math.abs(e.p0[2] - e.p1[2]) > 14).map((e) => e.id);
  await chk('fillet', { edge: vert.slice(0, 2), radius: 2, body: b1, generation: tp.generation }, 'fillet_index');
  await chk('chamfer', { face_group: 'Top', distance: 0.5, body: b1 }, 'chamfer_index');
  tp = await D('query_topology', { body: b1 });
  const flat = tp.faces.find((f) => f.normal[1] < -0.99 && f.surface === 'plane');
  await chk('draft', { face: flat.id, angle: 2, body: b1, generation: tp.generation }, 'draft_index', false);
  const cyl = await D('add_primitive', { shape: 'cylinder', params: { radius: 4, height: 12 }, position: [180, 100, 0], name: 'Rod' });
  sc = await D('describe_scene');
  const rod = sc.bodies.length - 1;
  check(cyl.ok && sc.bodies[rod]?.name === 'Rod', 'a rod body');
  await chk('pattern', { count: 2, spacing: 20, dir: 1, body: rod }, 'pattern_index');
  await chk('mirror', { plane: 'YZ', mode: 'new', body: rod }, 'mirror_index');
  sc = await D('describe_scene');
  const last = sc.bodies.length - 1;
  await chk('transform', { body: last, dx: 0, dy: 60 }, 'transform_index');
  await chk('cut', { plane: { origin: [0, 0, 8], normal: [0, 0, 1], x_axis: [1, 0, 0], y_axis: [0, 1, 0] }, keep_upper: false, keep_lower: true, body: last }, 'cut_index', false);
  sc = await D('describe_scene');
  await chk('boolean', { op: 'union', target: rod, tool: sc.bodies.length - 1 }, 'boolean_index', false);
  tp = await D('query_topology', { body: b1 });
  const bot = tp.faces.find((f) => f.normal[2] < -0.99 && f.surface === 'plane');
  await chk('thicken', { body: b1, face: bot.id, thickness: 1, generation: tp.generation }, 'thicken_index', false);
  sc = await D('describe_scene');
  tp = await D('query_topology', { body: b0 });
  const cut0 = tp.faces.find((f) => f.normal[2] > 0.99 && f.surface === 'plane');
  await chk('split', { body: b1, face_body: b0, face: cut0.id, keep_upper: true, keep_lower: true, generation: tp.generation }, null, false);
  tp = await D('query_topology', { body: b0 });
  const hw = tp.faces.find((f) => f.kind === 'cylindrical');
  await chk('delete_face', { body: b0, faces: [hw.id], generation: tp.generation }, 'feature_index', false);
  await chk('plane_datum', { base: 0, offset: 30 }, 'plane_index');
  await chk('axis', { type: 'two_points', p1: [0, 0, 0], p2: [0, 0, 10] }, 'axis_index');
  const hx = await chk('helix', { radius: 5, pitch: 3, height: 9 }, 'helix_index');
  // sketches for extrude / revolve / sweep / loft (add_feature Sketch)
  const sk = async (name, plane, entities) => { const r = await D('add_feature', { type: 'Sketch', name, fields: { plane, entities } }); check(r.ok && r.index >= 0, `design_add_feature Sketch ${name}: #${r.index}`); return r.index; };
  const XY = (z) => ({ origin: [250, 100, z], normal: [0, 0, 1], x_axis: [1, 0, 0], y_axis: [0, 1, 0] });
  const sq = (r) => [{ type: 'line', p0: [-r, -r], p1: [r, -r] }, { type: 'line', p0: [r, -r], p1: [r, r] }, { type: 'line', p0: [r, r], p1: [-r, r] }, { type: 'line', p0: [-r, r], p1: [-r, -r] }];
  const s1 = await sk('Sq', XY(0), sq(5));
  await chk('extrude', { sketch: s1, distance: 5 }, 'extrude_index');
  const s2 = await sk('Rev', { origin: [300, 100, 0], normal: [0, 1, 0], x_axis: [1, 0, 0], y_axis: [0, 0, 1] }, [{ type: 'circle', center: [10, 5], radius: 2 }]);
  await chk('revolve', { sketch: s2, axis: 1, angle: 360 }, 'revolve_index');
  const s3 = await sk('Prof', { origin: [355, 100, 0], normal: [0, 0, 1], x_axis: [1, 0, 0], y_axis: [0, 1, 0] }, [{ type: 'circle', center: [0, 0], radius: 1 }]);
  const s4 = await sk('Path', { origin: [355, 100, 0], normal: [0, 1, 0], x_axis: [1, 0, 0], y_axis: [0, 0, 1] }, [{ type: 'line', p0: [0, 0], p1: [0, 20] }]);
  await chk('sweep', { profile: s3, sweep_path: s4 }, 'sweep_index');
  const s5 = await sk('L0', XY(20), sq(4)), s6 = await sk('L1', XY(30), sq(2));
  await chk('loft', { profiles: [s5, s6], ruled: true }, 'loft_index');
  void hx;
  // a thread last (every later rebuild re-tessellates its body)
  await D('add_primitive', { shape: 'cylinder', params: { radius: 4, height: 12 }, position: [180, 160, 0], name: 'Bolt' });
  sc = await D('describe_scene');
  await chk('thread', { designation: 'M8', height: 10, plane: { origin: [180, 160, 0], normal: [0, 0, 1], x_axis: [1, 0, 0], y_axis: [0, 1, 0] }, body: sc.bodies.length - 1 }, 'thread_index');
  // generic edits
  const pv = await D('feature_preview', { type: 'Chamfer', fields: { dressup_size: 0.3, face_group: 'Bottom', target_body: rod } }, { expectError: true });
  check(typeof pv.ok === 'boolean' && (!pv.ok || pv.triangles > 0), `design_feature_preview: ${pv.ok ? `${pv.triangles} triangles` : pv.error}`);
  sc = await D('describe_scene');
  const ext = sc.features.findLast((f) => f.type === 'Extrude').index;
  const gf = await D('get_feature', { index: ext });
  check(gf.feature.distance === 5, 'design_get_feature');
  const gen = () => D('describe_scene').then((x) => x.generation);
  const g0 = await gen();
  const st = await D('set_feature', { index: ext, fields: { distance: 6 } });
  check(st.ok && st.generation > g0, 'design_set_feature');
  const stale = await call('design_add_feature', { type: 'Fillet', fields: { dressup_edges: [0], dressup_size: 0.2, target_body: b0 }, generation: g0 }, { expectError: true });
  check(stale.isError && /stale/.test(JSON.stringify(stale.data)), `design_add_feature with stale ids is refused: ${String(JSON.stringify(stale.data)).slice(0, 120)}`);
  check((await D('set_variable', { name: 'w', expr: '7' })).ok, 'design_set_variable');
  check((await D('set_feature_expr', { feature: ext, field: 'distance', expr: 'w' })).ok, 'design_set_feature_expr');
  check((await D('rename_feature', { index: ext, name: 'Square post' })).ok, 'design_rename_feature');
  check((await D('suppress_feature', { index: ext, suppressed: true })).ok, 'design_suppress_feature');
  check((await D('suppress_feature', { index: ext, suppressed: false })).ok, 'design_suppress_feature (back)');
  sc = await D('describe_scene');
  const mv = await D('move_feature', { index: sc.features.length - 1, delta: -1 }, { expectError: true });
  check(typeof mv.ok === 'boolean', `design_move_feature: ${mv.ok ? 'moved' : mv.error}`);
  // bodies
  check((await D('set_body', { body: b0, name: 'Case', color: '#3366cc' })).ok, 'design_set_body');
  sc = await D('describe_scene');
  const nb = sc.bodies.length;
  // the last body is the threaded bolt: delete the one before it (the Thread depends on the bolt)
  const db = await D('delete_body', { body: nb - 2 }, { expectError: true });
  check(db.ok ? (await D('describe_scene')).bodies.length < nb : /works on|deleted/.test(db.error ?? ''), `design_delete_body: ${db.ok ? 'deleted' : db.error}`);
  sc = await D('describe_scene');
  const nf = sc.features.length;
  const del = await D('delete_feature', { index: nf - 1 });
  check(del.ok && Array.isArray(del.removed), `design_delete_feature removed ${del.removed}`);
  // files
  const ex = await call('design_export_step', { bodies: [b0], name: 'case.step', savePath: `${out}/case.step` });
  const stepPath = ex.data?.savedTo ?? null;
  check(ex.data?.bytes > 1000 && !!stepPath, `design_export_step: ${ex.data?.bytes} bytes → ${stepPath}`);
  const stepBytes = stepPath ? readFileSync(stepPath) : null;
  if (stepBytes && /ISO-10303-21/.test(stepBytes.subarray(0, 64).toString())) {
    const is = await D('import_step', { name: 'case.step', dataBase64: Buffer.from(stepBytes).toString('base64') });
    check(is.ok && is.features?.length === 1, `design_import_step: ${is.features}`);
  } else check(false, 'design_export_step file not found for the import');
  const im = await D('import_mesh', { name: 'Tet', positions: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10].map((v, i) => v + [400, 100, 0][i % 3]), indices: [0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2] });
  check(im.ok && im.watertight, `design_import_mesh (positions): faces ${im.faces}`);
  const cm = await D('commit', { mode: 'bodies' });
  check(cm.ok && cm.objects.length >= 1, `design_commit: ${cm.objects.length} objects`);
  const conv = await D('convert_object', { objectId: cm.objects[0].id }, { expectError: true });
  check(conv.ok === true || conv.ok === false, `design_convert_object (a plain mesh object → mesh body): ${conv.ok ? 'ok' : conv.error}`);
  const cn = await D('cancel');
  check(cn.cancelled === false, 'design_cancel with nothing running');
}

// Orca's "View and analysis" on the 40 × 30 × 20 box (DesignPanel.cpp): Volume and area from the
// offer, Section View (X, F, PageUp, the toolbar buttons), the Shift / Ctrl+click edge set into
// Fillet / Chamfer, and Check interference from the feature tree's header.
async function analysisChecks({ page, D, check, shot, settled, run, screen, topo }) {
  const status = () => D(() => window.__cubbyDesign.design.status?.text ?? '');
  // Open an offer family's submenu by hovering it; it must still be open half a second later
  // (src/ui/submenuGuard.ts: Reka closed it on a second pointer move over its trigger).
  const submenu = async (family, item) => {
    await page.getByRole('menuitem', { name: family }).hover();
    await page.getByRole('menuitem', { name: item }).first().waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(500);
    check(await page.getByRole('menuitem', { name: item }).first().isVisible(), `offer: hovering ${family} opens its submenu and it stays open`);
  };
  const bb = await D(() => JSON.parse(JSON.stringify(window.__cubbyDesign.design.bodies[0].bbox)));
  const mid = [0, 1, 2].map((k) => (bb.min[k] + bb.max[k]) / 2);
  // ---- Volume and area (offer ▸ Reference), with Interference greyed for one body
  const [cx, cy] = await screen(mid);
  await page.mouse.click(cx, cy); await page.waitForTimeout(300);
  check((await D(() => window.__cubbyDesign.designUi.pick?.kind)) === 'body', 'box picked (whole body)');
  await page.mouse.click(cx, cy, { button: 'right' });
  await page.waitForSelector('[role="menu"]');
  await submenu(/^Reference/, /^Volume and area/);
  const refText = (await page.locator('[role="menu"]').allInnerTexts()).join('\n');
  check(/Interference needs at least two bodies/.test(refText), 'offer: Interference greyed with Orca’s reason (one body)');
  await page.getByRole('menuitem', { name: /^Volume and area/ }).click();
  await page.waitForFunction(() => /: volume /.test(window.__cubbyDesign.design.status?.text ?? ''));
  let s = await status();
  check(/: volume 24000\.00 mm³, area 5200\.00 mm²$/.test(s), `Volume and area: ${s}`);
  await page.waitForTimeout(300);
  await shot('00a-volume-area');
  await page.keyboard.press('Escape');
  // ---- Section view: X on at mid-height keeping the lower half; a click goes through the hidden half
  await page.keyboard.press('x');
  let sec = await D(() => window.__cubbyDesign.designUi.section && { ...window.__cubbyDesign.designUi.section });
  check(!!sec && Math.abs(sec.z - mid[2]) < 0.01 && !sec.upper, `X: section on at the model's mid-height ${JSON.stringify(sec)}`);
  check((await status()).startsWith('Section view on — hides half the model'), `status: ${await status()}`);
  await page.waitForTimeout(500);
  await shot('00b-section-lower');
  let t = await topo(0);
  const topFace = t.faces.filter((f) => f.normal[2] > 0.99).sort((a, b) => b.centroid[2] - a.centroid[2])[0];
  const [tx, ty] = await screen(topFace.centroid);
  await page.mouse.click(tx, ty); await page.waitForTimeout(200);
  await page.mouse.click(tx, ty); await page.waitForTimeout(300);
  const through = await D(() => { const p = window.__cubbyDesign.designUi.pick; return p && { ...p }; });
  check(through?.kind === 'face' && through.face !== topFace.id, `the hidden top face can't be picked; the click lands on face ${through?.face} below the cut`);
  await page.keyboard.press('Escape');
  await page.keyboard.press('f');
  check((await D(() => window.__cubbyDesign.designUi.section?.upper)) === true && (await status()) === 'Section view — showing the upper half', `F flips: ${await status()}`);
  await page.keyboard.press('PageUp');
  sec = await D(() => ({ ...window.__cubbyDesign.designUi.section }));
  check(Math.abs(sec.z - (mid[2] + 2)) < 0.01, `PageUp moves the plane 2 mm (${sec.z})`);
  await page.waitForTimeout(500);
  await shot('00c-section-upper');
  await page.click('[data-testid="design-section-flip"]');
  check((await status()) === 'Section view — showing the lower half', `Flip button: ${await status()}`);
  await page.click('[data-testid="design-section"]');
  check(!(await D(() => window.__cubbyDesign.designUi.section)) && (await status()) === 'Section view off', `Section View button turns it off: ${await status()}`);
  // ---- edge set: one top edge picked, Shift+click and Ctrl+click two more, Shift+click one off again
  t = await topo(0);
  const tops = t.edges.filter((e) => e.kind === 'line' && Math.abs(e.p0[2] - bb.max[2]) < 0.01 && Math.abs(e.p1[2] - bb.max[2]) < 0.01);
  check(tops.length === 4, `4 top edges (${tops.length})`);
  const at = async (e) => screen([0, 1, 2].map((k) => (e.p0[k] + e.p1[k]) / 2));
  await D((id) => { const W = window.__cubbyDesign; W.designUi.pick = { kind: 'edge', body: 0, edge: id, generation: W.design.generation }; }, tops[0].id);
  for (const [e, mod] of [[tops[1], 'Shift'], [tops[2], 'Control']]) {
    const [x, y] = await at(e);
    await page.keyboard.down(mod); await page.mouse.click(x, y); await page.keyboard.up(mod);
    await page.waitForTimeout(300);
  }
  const set = () => D(() => { const p = window.__cubbyDesign.designUi.pick; return p?.kind === 'edge' ? [...(p.more ?? []), p.edge] : []; });
  let ids = await set();
  check(ids.join() === [tops[0].id, tops[1].id, tops[2].id].join(), `Shift / Ctrl+click build the edge set (${ids})`);
  s = await status();
  check(/3 edges selected — Shift\+click adds or removes one, Fillet\/Chamfer dresses them all/.test(s), `status: ${s}`);
  await shot('00d-edge-set');
  { const [x, y] = await at(tops[1]); await page.keyboard.down('Shift'); await page.mouse.click(x, y); await page.keyboard.up('Shift'); await page.waitForTimeout(300); }
  ids = await set();
  check(ids.join() === [tops[0].id, tops[2].id].join(), `Shift+click on one in the set removes it (${ids})`);
  { const [x, y] = await at(tops[2]); await page.mouse.click(x, y, { button: 'right' }); }
  await page.waitForSelector('[role="menu"]');
  const head = (await page.locator('[role="menu"]').innerText()).split('\n')[0];
  check(/^2 edges of /.test(head), `offer header names the set: ${head}`);
  await submenu(/^Fillet \/ chamfer \/ draft/, /^Chamfer/);
  await page.getByRole('menuitem', { name: /^Fillet(?! \/)/ }).click();
  await page.waitForSelector('[data-testid="design-card"][data-tool="fillet"]');
  const c = await D(() => JSON.parse(JSON.stringify(window.__cubbyDesign.card.draft.edges)));
  check(c?.ids?.join() === [tops[0].id, tops[2].id].join(), `offer ▸ Fillet: the card takes the whole set (${c?.ids})`);
  await page.waitForTimeout(800);
  await shot('00e-fillet-from-set');
  await D(() => window.__cubbyDesign.cancelCard());
  await D(() => { window.__cubbyDesign.designUi.pick = null; });
  // ---- interference: a peg through the box, checked from the feature tree's header, then undone
  await D(async (mid) => { await window.__cubbyDesign.addPrimitiveBody('cylinder', { position: [mid[0], mid[1], -5], params: { radius: 5, height: 30 } }); }, mid);
  await settled((d) => d.bodies.length === 2, 'peg through the box');
  await page.click('[data-testid="design-interference"]');
  await page.waitForFunction(() => /overlapping pair|No interference/.test(window.__cubbyDesign.design.status?.text ?? ''));
  s = await status();
  const v = Number(/ ([\d.]+) mm³$/.exec(s)?.[1]);
  check(/^1 overlapping pair: .+ ↔ .+ [\d.]+ mm³$/.test(s) && v > 0 && v <= Math.PI * 25 * 20 + 1, `Check interference: ${s}`);
  await page.waitForTimeout(300);
  await shot('00f-interference');
  await run('edit.undo');
  await settled((d) => d.bodies.length === 1, 'peg undone');
  await page.click('[data-testid="design-interference"]');
  check((await status()) === 'Interference needs at least two bodies', `one body: ${await status()}`);
}

// ---- Orca's Coordinate system / Mate and Surface cards (FLOWS=create) ---------------------------
// Two boxes; a coordinate system on each top face (Shift+C with the face picked, then the card's
// own face pick); a Fastened mate from the offer, flipped, puts box B upside down on box A's top.
// A rectangle sketch: Surface Extrude (an open sheet, no volume), Surface Fill (a flat sheet) and
// Thicken Surface from the offer on that sheet (a solid of the sheet's area × thickness).
export async function assemblySurfaceFlow({ page, D, check, shot, settled }) {
  const screen = (p) => D((p) => window.__cubbyDesign.designViewport().screenPoint(p), p);
  const topo = (body) => D(async (body) => { const W = window.__cubbyDesign; return W.readDesign(async (c, doc) => (await c.call('query_topology', { doc, body })).result); }, body);
  const mass = (body) => D(async (body) => { const W = window.__cubbyDesign; return W.readDesign(async (c, doc) => (await c.call('mass_properties', { doc, body })).result); }, body);
  const bodies = () => D(() => JSON.parse(JSON.stringify(window.__cubbyDesign.design.bodies)));
  const fit = async () => { await D(() => window.__cubbyDesign.designViewport().fitAll()); await page.waitForTimeout(700); };
  const pickFace = async (centroid, kind = 'face') => {
    const [x, y] = await screen(centroid);
    for (let i = 0; i < 3 && (await D(() => window.__cubbyDesign.designUi.pick?.kind)) !== kind; i++) { await page.mouse.click(x, y); await page.waitForTimeout(350); }
    return D(() => JSON.parse(JSON.stringify(window.__cubbyDesign.designUi.pick)));
  };
  // Open an offer family's submenu by hovering it; it must still be open half a second later
  // (src/ui/submenuGuard.ts: Reka closed it on a second pointer move over its trigger).
  const submenu = async (family, item) => {
    await page.getByRole('menuitem', { name: family }).hover();
    await page.getByRole('menuitem', { name: item }).first().waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(500);
    check(await page.getByRole('menuitem', { name: item }).first().isVisible(), `offer: hovering ${family} opens its submenu and it stays open`);
  };
  const ok = async (what, pred) => { await page.click('[data-testid="design-card-ok"]'); await settled(pred, what); return D(() => ({ card: !!window.__cubbyDesign.card.tool, error: window.__cubbyDesign.card.error, ok: window.__cubbyDesign.design.ok })); };
  shot = ((orig) => (n) => orig(`m${n}`))(shot);
  console.log('create: coordinate systems, mate, surfaces');
  await D(() => window.__cubbyProject.resetProject());
  await settled((d) => d.phase === 'open' && !d.features.length, 'empty design');
  await D(async () => {
    const W = window.__cubbyDesign, o = W.design.modelingOrigin;
    await W.runEdit('Add boxes', async (c, doc) => {
      await c.call('extrude', { doc, width: 40, height: 30, distance: 20, name: 'Base' });
      return (await c.call('extrude', { doc, width: 20, height: 20, distance: 10, name: 'Cap', plane: { origin: [o[0] + 60, o[1], o[2]], normal: [0, 0, 1], x_axis: [1, 0, 0], y_axis: [0, 1, 0] } })).result;
    });
  });
  await settled((d) => d.bodies.length === 2, 'two boxes');
  await fit();
  // ---- Coordinate system on box A's top face: Shift+C with the face picked
  const topOf = async (b) => (await topo(b)).faces.filter((f) => f.normal[2] > 0.99).sort((a, b) => b.centroid[2] - a.centroid[2])[0];
  const topA = await topOf(0), topB = await topOf(1);
  let p = await pickFace(topA.centroid);
  check(p?.kind === 'face' && p.face === topA.id, `box A's top face picked (${JSON.stringify(p)})`);
  await page.keyboard.press('Shift+C');
  await page.waitForSelector('[data-testid="design-card"][data-tool="coordsys"]');
  let c = await D(() => JSON.parse(JSON.stringify(window.__cubbyDesign.card.draft)));
  check(c.coordsys_type === 'FaceAndDirection' && c.face?.ids?.[0] === topA.id, `Shift+C: face + direction on the picked face (${c.coordsys_type}, ${JSON.stringify(c.face)})`);
  await shot('01-coordsys-card');
  let r = await ok('coordinate system A', (d) => d.features.some((f) => f.type === 'CoordSys'));
  check(!r.card && r.ok, `coordinate system added (${r.error || 'ok'})`);
  // ---- the second one from the menu, its face picked with the card's own Pick button
  await page.mouse.click(5, 5);
  await D(() => { window.__cubbyDesign.designUi.pick = null; });
  await D(() => window.__cubbyDesign.openCard('coordsys', { pick: null }));
  await page.waitForSelector('[data-testid="design-card"][data-tool="coordsys"]');
  check((await D(() => window.__cubbyDesign.card.draft.coordsys_type)) === 'PointWorld', 'nothing picked: a world point (Orca’s default)');
  await page.click('[data-testid="design-card"] [data-pick="card:face"] [data-testid="ref-pick"]');
  const [bx, by] = await screen(topB.centroid);
  await page.mouse.click(bx, by); await page.waitForTimeout(800);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !window.__cubbyDesign.card.resolving);
  c = await D(() => JSON.parse(JSON.stringify(window.__cubbyDesign.card.draft)));
  check(c.coordsys_type === 'FaceAndDirection' && c.face?.body === 1 && c.face?.ids?.[0] === topB.id, `picking a face makes it face + direction (${c.coordsys_type}, ${JSON.stringify(c.face)})`);
  await shot('02-coordsys-picked');
  r = await ok('coordinate system B', (d) => d.features.filter((f) => f.type === 'CoordSys').length === 2);
  const ds = await D(async () => window.__cubbyDesign.readDesign(async (c, doc) => (await c.call('datums', { doc })).result.coordsys));
  check(ds.length === 2 && ds.every((x) => !x.error) && Math.abs(ds[0].origin[2] - topA.centroid[2]) < 1e-6 && Math.abs(ds[1].origin[2] - topB.centroid[2]) < 1e-6,
    `both coordinate systems resolve on the top faces (${ds.map((x) => `${x.name} z=${x.origin[2].toFixed(2)}${x.error ? ' ' + x.error : ''}`)})`);
  // ---- Mate from the offer on a flat face: B moves onto A, flipped (face to face)
  await pickFace(topA.centroid);
  const [ax, ay] = await screen(topA.centroid);
  await page.mouse.click(ax, ay, { button: 'right' });
  await page.waitForSelector('[role="menu"]');
  await submenu(/^Transform/, /^Mate$/);
  await shot('03-offer-mate');
  await page.getByRole('menuitem', { name: /^Mate$/ }).click();
  await page.waitForSelector('[data-testid="design-card"][data-tool="mate"]');
  const csIdx = await D(() => window.__cubbyDesign.design.features.filter((f) => f.type === 'CoordSys').map((f) => f.index));
  c = await D(() => JSON.parse(JSON.stringify(window.__cubbyDesign.card.draft)));
  check(c.mate_cs_a === csIdx[0] && c.mate_cs_b === csIdx[0] && /A and B must be different/.test(await page.locator('[data-testid="design-card-preview"]').innerText()),
    'Mate opens with the first coordinate system in both pickers and says A and B must differ (Orca)');
  await D((b) => window.__cubbyDesign.setCardValue('mate_cs_b', b), csIdx[1]);
  await page.locator('[data-testid="design-card"] [data-field="mate_flip"] button').click();
  await page.waitForFunction(() => ['ok', 'invalid'].includes(window.__cubbyDesign.card.preview.state), null, { timeout: 120000 });
  const pv = await D(() => ({ ...window.__cubbyDesign.card.preview }));
  check(pv.state === 'ok', `mate preview: ${pv.text}`);
  await page.waitForTimeout(600);
  await shot('04-mate-card');
  r = await ok('mate', (d) => d.features.some((f) => f.type === 'Mate'));
  let bs = await bodies();
  const bbB = bs[1].bbox;
  check(!r.card && r.ok && Math.abs(bbB.min[2] - 20) < 1e-3 && Math.abs(bbB.max[2] - 30) < 1e-3, `Fastened + flip: box B sits on box A's top, upside down (z ${bbB.min[2].toFixed(3)}..${bbB.max[2].toFixed(3)}; ${r.error || 'ok'})`);
  const mc = await D(() => window.__cubbyDesign.design.mateConflicts.length);
  check(mc === 0, `no mate conflicts (${mc})`);
  await fit(); await shot('05-mated');
  // ---- datums drawn as Orca draws them: the two connectors (B driven, joined by the mate), a datum plane; its base pick
  const cs = await page.$$eval('[data-testid="design-coordsys"]', (g) => g.map((x) => x.classList.contains('is-driven')));
  check(cs.length === 2 && cs.filter(Boolean).length === 1 && (await page.locator('[data-testid="design-mate-link"]').count()) === 1, `coordinate systems drawn: ${cs.length}, driven ${cs.filter(Boolean).length}, mate link`);
  await D(async () => { const W = window.__cubbyDesign; await W.runEdit('Add Plane', async (c, doc) => (await c.call('add_feature', { doc, type: 'Plane', fields: { plane_type: 'Offset', plane_base: 0, plane_offset: 45, plane_u_size: 70, plane_v_size: 50 } })).result); });
  await settled((d) => d.features.some((f) => f.type === 'Plane'), 'datum plane');
  await page.waitForSelector('[data-testid="design-datum-plane"]');
  await fit(); await page.waitForTimeout(400);
  check((await page.locator('[data-testid="design-datum-plane"]').count()) === 1, 'the datum plane is drawn');
  await shot('05b-datums');
  await D(() => window.__cubbyDesign.openCard('plane', { pick: null }));
  await page.waitForSelector('[data-testid="design-card"][data-tool="plane"]');
  const plFrame = await D(async () => { const W = window.__cubbyDesign; return W.readDesign(async (c, doc) => (await c.call('datums', { doc })).result.planes[0].plane); });
  let based = false;
  for (const [u, v] of [[30, 20], [-30, 20], [30, -20], [-30, -20], [0, 22], [32, 0]]) {
    const w = [0, 1, 2].map((k) => plFrame.origin[k] + plFrame.x_axis[k] * u + plFrame.y_axis[k] * v);
    const [x, y] = await screen(w);
    await page.mouse.click(x, y); await page.waitForTimeout(300);
    if ((await D(() => window.__cubbyDesign.card.draft.plane_base)) === 3) { based = true; break; }
  }
  check(based, 'a click on the datum plane (no body under it) makes it the Plane card’s base (Orca’s base pick)');
  await D(() => window.__cubbyDesign.cancelCard());
  await D(async () => { const W = window.__cubbyDesign; const i = W.design.features.find((f) => f.type === 'Plane').index; await W.runEdit('Delete Plane', async (c, doc) => (await c.call('delete_feature', { doc, index: i })).result); });
  await settled((d) => !d.features.some((f) => f.type === 'Plane'), 'datum plane removed');
  // ---- Surfaces on a rectangle sketch beside the boxes
  await D(async () => {
    const W = window.__cubbyDesign;
    await W.runEdit('Add sketch', async (c, doc) => {
      await c.call('sketch_begin', { doc, plane: 'XY' });
      await c.call('sketch_add', { doc, rect: [100, -10, 130, 10] });
      return (await c.call('sketch_commit', { doc, name: 'Rect' })).result;
    });
  });
  await settled((d) => d.features.some((f) => f.name === 'Rect'), 'rectangle sketch');
  await page.mouse.click(5, 5);
  await page.keyboard.press('Shift+G');
  await page.waitForSelector('[data-testid="design-card"][data-tool="surf_extrude"]');
  const rectIdx = await D(() => window.__cubbyDesign.design.features.find((f) => f.name === 'Rect').index);
  check((await D(() => window.__cubbyDesign.card.draft.sketch_ref)) === rectIdx, 'Shift+G: Surface Extrude of the last sketch');
  await page.fill('[data-field="distance"] input', '15');
  await page.waitForFunction(() => ['ok', 'invalid'].includes(window.__cubbyDesign.card.preview.state), null, { timeout: 120000 });
  await shot('06-surface-extrude-card');
  r = await ok('surface extrude', (d) => d.features.some((f) => f.type === 'SurfaceExtrude'));
  bs = await bodies();
  let m = await mass(bs.length - 1);
  check(!r.card && bs.length === 3 && !bs[2].is_solid && m.volume < 1e-6 && Math.abs(m.surface_area - 2 * (30 + 20) * 15) < 0.5,
    `Surface Extrude: an open sheet body (solid ${bs[2]?.is_solid}, volume ${m.volume}, area ${m.surface_area?.toFixed(2)}; ${r.error || 'ok'})`);
  await page.keyboard.press('Shift+Q');
  await page.waitForSelector('[data-testid="design-card"][data-tool="surf_fill"]');
  await D((i) => window.__cubbyDesign.setCardValue('sketch_ref', i), rectIdx);
  r = await ok('surface fill', (d) => d.features.some((f) => f.type === 'SurfaceFill'));
  bs = await bodies();
  m = await mass(3);
  check(!r.card && bs.length === 4 && !bs[3].is_solid && Math.abs(m.surface_area - 600) < 0.5, `Surface Fill: a flat sheet of 600 mm² (${m.surface_area?.toFixed(2)}; ${r.error || 'ok'})`);
  await fit(); await shot('07-sheets');
  // Thicken Surface from the offer on the flat sheet (a sheet body is picked whole).
  const fill = bs[3].bbox, fillMid = [0, 1, 2].map((k) => (fill.min[k] + fill.max[k]) / 2);
  const [qx, qy] = await screen([fillMid[0], fillMid[1] - 6, fillMid[2]]);
  // Hide the open sheet around it (view only), so the click lands on the flat one.
  await D(() => { window.__cubbyDesign.designUi.hiddenBodies = [2]; });
  await page.waitForTimeout(400);
  await page.mouse.click(5, 5);
  await page.mouse.click(qx, qy); await page.waitForTimeout(400);
  p = await D(() => JSON.parse(JSON.stringify(window.__cubbyDesign.designUi.pick)));
  check(p?.body === 3, `the flat sheet picked (${JSON.stringify(p)})`);
  if (p && p.kind !== 'body') { await D((b) => { window.__cubbyDesign.designUi.pick = { kind: 'body', body: b }; }, 3); }
  await page.mouse.click(qx, qy, { button: 'right' });
  await page.waitForSelector('[role="menu"]');
  await page.getByRole('menuitem', { name: /^Thicken Surface/ }).waitFor();   // a family of one sits at the top level
  const head = (await page.locator('[role="menu"]').innerText()).split('\n')[0];
  check(/sheet body/.test(head), `offer header names a sheet body (${head})`);
  await shot('08-offer-sheet');
  await page.getByRole('menuitem', { name: /^Thicken Surface/ }).click();
  await page.waitForSelector('[data-testid="design-card"][data-tool="thicken_surf"]');
  c = await D(() => JSON.parse(JSON.stringify(window.__cubbyDesign.card.draft)));
  check(c.target_body === 3 && c.thicken_thickness === 1, `Thicken Surface prefilled with the sheet (${c.target_body}, ${c.thicken_thickness} mm)`);
  await page.fill('[data-field="thicken_thickness"] input', '2');
  await page.waitForFunction(() => ['ok', 'invalid'].includes(window.__cubbyDesign.card.preview.state), null, { timeout: 120000 });
  await page.waitForTimeout(500);
  await shot('09-thicken-surface-card');
  r = await ok('thicken surface', (d) => d.features.some((f) => f.type === 'ThickenSurface'));
  await D(() => { window.__cubbyDesign.designUi.hiddenBodies = []; });
  bs = await bodies();
  const solid = bs.findIndex((b, i) => i >= 3 && b.is_solid);
  m = solid >= 0 ? await mass(solid) : { volume: 0 };
  check(!r.card && solid >= 0 && Math.abs(m.volume - 1200) < 0.5, `Thicken Surface: a 30 × 20 × 2 solid (volume ${m.volume?.toFixed(2)}; ${r.error || 'ok'})`);
  // Surface Offset on the open sheet (Shift+U), the distance in plane_offset.
  await page.mouse.click(5, 5);
  await D(() => { window.__cubbyDesign.designUi.pick = null; });
  await page.keyboard.press('Shift+U');
  await page.waitForSelector('[data-testid="design-card"][data-tool="surf_offset"]');
  await D(() => window.__cubbyDesign.setCardValue('target_body', 2));
  r = await ok('surface offset', (d) => d.features.some((f) => f.type === 'SurfaceOffset'));
  const so = await D(async () => { const W = window.__cubbyDesign; const f = W.design.features.find((x) => x.type === 'SurfaceOffset'); return (await W.getFeature(f.index)).plane_offset; });
  check(!r.card && r.ok && so === 1, `Surface Offset added, plane_offset ${so} (${r.error || 'ok'})`);
  await fit(); await shot('10-surfaces');
}

// ---- Orca's loop pick: one region of a sketch with several, extruded alone (FLOWS=create) --------
// A 40 × 30 plate outline with a Ø10 hole and a separate Ø8 circle in one sketch: a click inside
// the plate selects that region (shaded), Shift+E extrudes just it (with its hole); a click in the
// small circle then extrudes that one. Each Extrude carries its entities (sketch_ref -1).
export async function regionExtrudeFlow({ page, D, check, shot, settled }) {
  const screen = (p) => D((p) => window.__cubbyDesign.designViewport().screenPoint(p), p);
  const mass = (body) => D(async (body) => { const W = window.__cubbyDesign; return W.readDesign(async (c, doc) => (await c.call('mass_properties', { doc, body })).result); }, body);
  shot = ((orig) => (n) => orig(`r${n}`))(shot);
  console.log('create: extrude one region of a sketch');
  await D(() => window.__cubbyProject.resetProject());
  await settled((d) => d.phase === 'open' && !d.features.length, 'empty design');
  await D(async () => {
    const W = window.__cubbyDesign;
    await W.runEdit('Add sketch', async (c, doc) => {
      await c.call('sketch_begin', { doc, plane: 'XY' });
      await c.call('sketch_add', { doc, rect: [0, 0, 40, 30] });
      await c.call('sketch_add', { doc, entities: [{ type: 'circle', center: [20, 15], radius: 5 }, { type: 'circle', center: [60, 15], radius: 4 }] });
      return (await c.call('sketch_commit', { doc, name: 'Plate' })).result;
    });
  });
  await settled((d) => d.features.length === 1, 'plate sketch');
  const o = await D(() => window.__cubbyDesign.design.modelingOrigin.slice());
  await D((o) => window.__cubbyDesign.designViewport().setView?.('top'), o);
  await D(() => window.__cubbyDesign.designViewport().fitAll()); await page.waitForTimeout(800);
  const at = async (x, y) => screen([o[0] + x, o[1] + y, o[2]]);
  const extrude = async (what, n) => {
    await page.keyboard.press('Shift+E');
    await page.waitForSelector('[data-testid="design-card"][data-tool="extrude"]');
    const c = await D(() => JSON.parse(JSON.stringify(window.__cubbyDesign.card.draft)));
    await page.waitForFunction(() => ['ok', 'invalid'].includes(window.__cubbyDesign.card.preview.state), null, { timeout: 120000 });
    await shot(`${n}-card`);
    await D((n) => { window.__e2eN = n; }, n);   // settled() predicates run in the page: no closures
    await page.click('[data-testid="design-card-ok"]');
    await settled((d) => d.bodies.length === window.__e2eN, what);
    return c;
  };
  // Plate region: inside the outline, outside the hole.
  let [x, y] = await at(5, 5);
  await page.mouse.click(x, y); await page.waitForTimeout(500);
  let reg = await D(() => JSON.parse(JSON.stringify(window.__cubbyDesign.designUi.region)));
  const shaded = await page.locator('[data-testid="design-sketch-region"]').count();
  check(reg?.sketch === 0 && reg.region >= 0 && shaded === 1, `a click in the plate selects that region, shaded (${JSON.stringify(reg)}, ${shaded} shaded)`);
  await shot('01-region-picked');
  let c = await extrude('plate region extruded', 1);
  check(c.loopOnly === true && c.loop?.region === reg.region, `Shift+E: Extrude of only the picked region (${JSON.stringify(c.loop)})`);
  let f = await D(async () => { const W = window.__cubbyDesign; return W.getFeature(W.design.features.length - 1); });
  let m = await mass(0);
  const plate = (40 * 30 - Math.PI * 25) * 10;
  check(f.sketch_ref === -1 && f.entities.length === 5 && Math.abs(m.volume - plate) < 1, `the plate with its hole only: ${f.entities.length} entities, volume ${m.volume.toFixed(1)} (want ${plate.toFixed(1)})`);
  // The small circle, from the same sketch.
  await page.click('[data-feature="0"]');
  await page.waitForTimeout(400);
  [x, y] = await at(60, 15);
  await page.mouse.click(x, y); await page.waitForTimeout(500);
  reg = await D(() => JSON.parse(JSON.stringify(window.__cubbyDesign.designUi.region)));
  c = await extrude('circle region extruded', 2);
  m = await mass(1);
  check(c.loopOnly && Math.abs(m.volume - Math.PI * 16 * 10) < 1, `the Ø8 circle alone: volume ${m.volume.toFixed(1)} (want ${(Math.PI * 160).toFixed(1)})`);
  await D(() => window.__cubbyDesign.designViewport().fitAll()); await page.waitForTimeout(800);
  await shot('03-two-regions');
}
