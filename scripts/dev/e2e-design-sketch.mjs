// The Design tab's sketcher against the real kernel (scripts/dev/e2e-design.mjs, FLOWS=sketch):
// 1. an L-bracket drawn with the polyline (origin snap, H / V inference, closed on the first point),
//    dimensioned with the Dimension tool to fully constrained; an over-constraining dimension refused
//    with what it conflicts with, kept (red), undone with Ctrl+Z inside the session; Finish → Extrude
//    from the offer (volume checked); a circle sketched on the top face (Shift+S, click the face) and
//    cut through; the first sketch's dimension edited and the solid following; save → reopen → re-edit.
// 2. on XZ: fillet a rectangle corner, offset the loop, trim, extend, tangent arc, slot, polygon, spline,
//    ellipse, point, a drag; the bridge's design_sketch_* tools (add, constrain + conflict, the guard
//    against a radius on a line, plan, angle in degrees, commit), a text sketch extruded, an SVG.
function sketchHelpers(page, D) {
  const plane = () => D(() => window.__cubbyDesign.sketch.sk.plane);
  const P = async (x, y) => { const p = await plane(); return D(([p, x, y]) => window.__cubbyDesign.designViewport().screenPoint([p.origin[0] + x * p.x_axis[0] + y * p.y_axis[0], p.origin[1] + x * p.x_axis[1] + y * p.y_axis[1], p.origin[2] + x * p.x_axis[2] + y * p.y_axis[2]]), [p, x, y]); };
  const idle = () => page.waitForFunction(() => { const k = window.__cubbyDesign.designKernel().status; return !k.busy && !k.queued && window.__cubbyDesign.designKernel().idle; }, null, { timeout: 120000, polling: 100 });
  const click = async (x, y, o = {}) => { const [sx, sy] = await P(x, y); await page.mouse.move(sx, sy, { steps: 3 }); await page.waitForTimeout(60); if (o.shift) await page.keyboard.down('Shift'); await page.mouse.down(); await page.mouse.up(); if (o.shift) await page.keyboard.up('Shift'); await page.waitForTimeout(120); await idle(); };
  const dragP = async (a, b) => { const [ax, ay] = await P(...a); const [bx, by] = await P(...b); await page.mouse.move(ax, ay); await page.mouse.down(); await page.mouse.move((ax + bx) / 2, (ay + by) / 2, { steps: 6 }); await page.mouse.move(bx, by, { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(200); await idle(); };
  const hover = async (x, y) => { const [sx, sy] = await P(x, y); await page.mouse.move(sx, sy, { steps: 4 }); await page.waitForTimeout(150); };
  const state = () => D(() => { const k = window.__cubbyDesign.sketch.sk; return { open: k.open, e: k.entities.length, c: k.constraints.length, dof: k.dof, ok: k.solveOk, bad: k.bad.slice(), value: k.value?.label ?? null, conflict: k.conflict?.message ?? null, tool: k.tool, undo: k.undo.length, loops: k.loops?.closed_loops?.length ?? 0, open_ends: k.loops?.open_ends?.length ?? 0, types: k.constraints.map((c) => c.type), ents: k.entities.map((e) => `${e.type}${e.construction ? '*' : ''}`) }; });
  const typeValue = async (v) => { await page.waitForSelector('[data-testid="sketch-value"] input'); await page.fill('[data-testid="sketch-value"] input', String(v)); await page.keyboard.press('Enter'); await page.waitForTimeout(150); await idle(); };
  const key = async (k) => { await page.keyboard.press(k); await page.waitForTimeout(120); await idle(); };
  return { plane, P, click, dragP, hover, state, typeValue, key, idle };
}

export async function sketchFlow({ page, D, check, shot, settled, run, lap, out }) {
  const h = sketchHelpers(page, D);
  let ln;
  const t = { errs: [] };
  const tool = (name, args = {}) => D(async ([name, args]) => { const m = await import('/slicer/src/bridge/groups/design.ts'); const tl = m.designTools().find((x) => x.name === name); try { return (await tl.run(args)).data; } catch (e) { return { thrown: String(e.message ?? e) }; } }, [name, args]);
  console.log('sketch: L-bracket, hole, edit, save / reopen');
  await run('view.design');
  await settled(null, 'design open');
  await page.keyboard.press('Shift+S');
  await page.waitForSelector('[data-testid="sketch-choose"]');
  await page.click('[data-testid="sketch-plane-xy"]');
  await page.waitForSelector('[data-testid="sketch-toolbar"]');
  await page.waitForTimeout(700);
  // ---- L-bracket with the polyline: origin snap, H / V inference, close on the first point.
  await run('design.sketch.tool.polyline');
  const pts = [[0, 0], [40, 0.6], [40.4, 8], [8, 8.3], [8.2, 30], [0.3, 30]];
  for (const p of pts) await h.click(...p);
  await h.hover(0.5, 15);
  await shot('01-polyline-rubber');
  await h.click(0, 0); // close (snaps to the first point)
  let s = await h.state();
  lap(JSON.stringify(s));
  check(s.e === 6, 'six lines');
  check(s.types.filter((x) => x === 'horizontal').length === 3 && s.types.filter((x) => x === 'vertical').length === 3, 'H / V inferred on every segment');
  check(s.types.filter((x) => x === 'coincident').length === 7, '6 joins + the origin');
  check(s.loops === 1 && s.open_ends === 0, 'closed profile');
  check(s.dof === 4, `4 DOF before dimensions (${s.dof})`);
  await shot('02-L-drawn');
  // ---- dimensions with the Dimension tool: click a line → length.
  await h.key('d');
  const dimLine = async (x, y, v) => { await h.click(x, y); await h.typeValue(v); };
  await dimLine(20, 0, 40);
  await dimLine(0, 15, 30);
  await dimLine(40, 4, 8);
  s = await h.state();
  check(s.dof === 1, `1 DOF left (${s.dof})`);
  await shot('03-three-dims');
  await dimLine(4, 30, 8);
  s = await h.state();
  check(s.dof === 0 && s.ok, `fully constrained (${s.dof})`);
  const dofText = await page.textContent('[data-testid="sketch-dof"]');
  check(/Fully constrained/.test(dofText ?? ''), `readout: ${dofText}`);
  await shot('04-fully-constrained');
  // ---- over-constrained: a 5th dimension on the inner horizontal edge conflicts.
  await dimLine(24, 8, 25);
  s = await h.state();
  check(!!s.conflict && /conflicts with/.test(s.conflict), `conflict named: ${s.conflict}`);
  await page.waitForSelector('[data-testid="sketch-conflict"]');
  await shot('05-conflict');
  // Keep both → over-constrained red state
  await page.click('[data-testid="sketch-conflict-keep"]'); await h.idle();
  s = await h.state();
  check(!s.ok && s.bad.length > 0, `kept: over-constrained, bad ${JSON.stringify(s.bad)}`);
  await shot('06-overconstrained');
  // Ctrl+Z inside the session: sketch undo (the forced dimension goes)
  const undoBefore = s.undo;
  await page.keyboard.press('Control+z'); await page.waitForTimeout(200); await h.idle();
  s = await h.state();
  check(s.ok && s.dof === 0 && s.c === 17 && s.undo === undoBefore - 1, `Ctrl+Z = sketch undo (${s.c} constraints, ok ${s.ok})`);
  // drag: fully constrained → nothing moves; check vertex drag on under-constrained later
  await h.key('Escape'); await h.key('Escape');
  const featBefore = await D(() => window.__cubbyDesign.design.features.length);
  await page.click('[data-testid="sketch-finish"]');
  await settled((d) => d.features.length === 1, 'sketch committed');
  check(featBefore === 0, 'no feature before Finish');
  await page.waitForSelector('[data-testid="sketch-finished"]');
  await page.click('[data-testid="sketch-offer-extrude"]');
  await page.waitForFunction(() => window.__cubbyDesign.card.tool?.id === 'extrude');
  await page.waitForFunction(() => !window.__cubbyDesign.card.resolving && !!window.__cubbyDesign.card.ctx);
  await page.waitForTimeout(300);
  const sref = await D(() => window.__cubbyDesign.card.draft.sketch_ref);
  check(sref === 0, `Extrude card prefilled with the sketch (${sref})`);
  await D(() => window.__cubbyDesign.setCardValue('distance', 12));
  await D(() => window.__cubbyDesign.confirmCard());
  await settled((d) => d.bodies.length === 1, 'extruded');
  const vol = await D(async () => { const W = window.__cubbyDesign; return W.readDesign(async (c, doc) => (await c.call('mass_properties', { doc, body: 0 })).result.volume); });
  check(Math.abs(vol - 12 * (40 * 8 + 8 * 22)) < 0.5, `L-bracket volume ${vol.toFixed(1)} (expect ${12 * (40 * 8 + 8 * 22)})`);
  await shot('07-extruded');
  // ---- 2. a hole: sketch a circle on the top face (Shift+S, click the face), cut-extrude through.
  const vol0 = vol;
  await page.keyboard.press('Shift+S');
  await page.waitForSelector('[data-testid="sketch-choose"]');
  const org = await D(() => window.__cubbyDesign.design.modelingOrigin);
  const top = await D((o) => window.__cubbyDesign.designViewport().screenPoint([o[0] + 4, o[1] + 20, 12]), org);
  await page.mouse.click(top[0], top[1]);
  await page.waitForSelector('[data-testid="sketch-toolbar"]');
  await page.waitForTimeout(700);
  const fp = await h.plane();
  lap(`face plane ${JSON.stringify(fp)}`);
  check(Math.abs(fp.origin[2] - 12) < 1e-6 && Math.abs(Math.abs(fp.normal[2]) - 1) < 1e-9, 'sketch plane = the top face');
  // centre of the hole in plane coords: world (o+4, o+20, 12)
  const toPl = (w) => [(w[0] - fp.origin[0]) * fp.x_axis[0] + (w[1] - fp.origin[1]) * fp.x_axis[1] + (w[2] - fp.origin[2]) * fp.x_axis[2], (w[0] - fp.origin[0]) * fp.y_axis[0] + (w[1] - fp.origin[1]) * fp.y_axis[1] + (w[2] - fp.origin[2]) * fp.y_axis[2]];
  const c0 = toPl([org[0] + 4, org[1] + 20, 12]);
  await h.key('c');
  await h.click(c0[0], c0[1]);
  await h.hover(c0[0] + 2, c0[1]);
  await shot('08-circle-rubber');
  await h.click(c0[0] + 2.6, c0[1]);
  await h.typeValue(5);
  s = await h.state();
  check(s.e === 1 && s.types.includes('diameter') && s.loops === 1, 'circle with a 5 mm diameter');
  await shot('09-circle-on-face');
  await page.click('[data-testid="sketch-finish"]');
  await settled((d) => d.features.length === 3, 'hole sketch committed');
  await page.click('[data-testid="sketch-offer-extrude"]');
  await page.waitForFunction(() => window.__cubbyDesign.card.tool?.id === 'extrude' && !window.__cubbyDesign.card.resolving);
  await page.waitForTimeout(300);
  await D(async () => { const W = window.__cubbyDesign; await W.setCardValue('mode', 'Cut'); await W.setCardValue('extrude_end', 'ThroughAll'); await W.setCardValue('target_body', 0); });
  await page.waitForTimeout(300);
  const cr = await D(() => window.__cubbyDesign.confirmCard());
  lap(`cut: ${JSON.stringify(cr)}`);
  await settled((d) => d.features.length === 4, 'hole cut');
  const volume = () => D(async () => { const W = window.__cubbyDesign; return W.readDesign(async (c, doc) => (await c.call('mass_properties', { doc, body: 0 })).result.volume); });
  const vol1 = await volume();
  check(Math.abs(vol0 - vol1 - Math.PI * 2.5 * 2.5 * 12) < 0.5, `hole removed π·2.5²·12 (${(vol0 - vol1).toFixed(2)})`);
  await shot('10-hole');
  // ---- 3. edit a dimension of the first sketch: the solid follows.
  await page.locator('li.ft__row[data-feature="0"]').click();
  await page.waitForSelector('[data-testid="design-edit-sketch"]');
  await page.click('[data-testid="design-edit-sketch"]');
  await page.waitForSelector('[data-testid="sketch-toolbar"]');
  await page.waitForTimeout(700);
  s = await h.state();
  check(s.e === 6 && s.c === 17 && s.dof === 0, `re-edit: the saved sketch is back (${s.e} entities, ${s.c} constraints, dof ${s.dof})`);
  await shot('11-reedit');
  const lbl = page.locator('[data-testid="sketch-dimension"]', { hasText: /^40$/ });
  await lbl.click();
  await h.typeValue(50);
  s = await h.state();
  check(s.dof === 0 && s.ok, 'still fully constrained at 50');
  await page.click('[data-testid="sketch-finish"]');
  await settled((d) => !d.status || /updated/.test(d.status.text), 'sketch edit committed');
  await page.waitForTimeout(500);
  const vol2 = await volume();
  check(Math.abs(vol2 - vol1 - 10 * 8 * 12) < 0.5, `the solid grew by 10×8×12 (${(vol2 - vol1).toFixed(2)})`);
  await shot('12-edited');
  // ---- 4. save, reopen, re-edit.
  const [dl] = await Promise.all([page.waitForEvent('download'), run('file.save')]);
  const savedPath = `${out}/sketch.3mf`;
  await dl.saveAs(savedPath);
  await page.evaluate(() => window.__cubbyProject.resetProject());
  await page.waitForTimeout(500);
  await run('view.prepare');
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), run('file.open')]);
  await fc.setFiles(savedPath);
  await page.waitForTimeout(2000);
  await run('view.design');
  await settled((d) => d.phase === 'open' && d.features.length === 4 && d.bodies.length === 1, 'reopened');
  check(Math.abs((await volume()) - vol2) < 0.01, 'reopened: same volume');
  await D(() => window.__cubbyDesign.sketch.beginSketch({ feature: 0 }));
  await page.waitForSelector('[data-testid="sketch-toolbar"]');
  s = await h.state();
  check(s.e === 6 && s.c === 17 && s.dof === 0, `reopened sketch re-edits (${s.e}/${s.c}/dof ${s.dof})`);
  const dimTexts = await page.locator('[data-testid="sketch-dimension"]').allTextContents();
  check(dimTexts.includes('50') && dimTexts.includes('30'), `dimensions shown: ${dimTexts.join(', ')}`);
  await page.click('[data-testid="sketch-cancel"]');
  await page.waitForTimeout(500);
  // App undo after reopen is unaffected by the cancelled session

  console.log('sketch: edit operations, tools, bridge');
  await page.evaluate(() => window.__cubbyProject.resetProject());
  await page.waitForTimeout(500);
  await run('view.design');
  await settled((d) => d.phase === 'open' && d.features.length === 0, 'empty design');
  await page.keyboard.press('Shift+S'); await page.waitForSelector('[data-testid="sketch-choose"]');
  await page.click('[data-testid="sketch-plane-xz"]'); await page.waitForSelector('[data-testid="sketch-toolbar"]'); await page.waitForTimeout(600);
  // ---- fillet a rectangle corner (F, click the corner, type the radius)
  await h.key('r'); await h.click(0, 0); await h.click(30, 20); await h.key('Escape'); await h.key('Escape');
  s = await h.state();
  check(s.e === 4, 'rectangle drawn on XZ');
  await h.key('f'); await h.click(30, 20); await h.typeValue(4);
  s = await h.state();
  const arcs = await D(() => window.__cubbyDesign.sketch.sk.entities.filter((e) => e.type === 'arc').map((e) => ({ c: e.center.map((v) => +v.toFixed(3)), r: +e.radius.toFixed(3) })));
  lap(`fillet: ${JSON.stringify(arcs)} ${JSON.stringify(s.types)}`);
  check(arcs.length === 1 && Math.abs(arcs[0].r - 4) < 1e-6 && Math.abs(arcs[0].c[0] - 26) < 1e-6 && Math.abs(arcs[0].c[1] - 16) < 1e-6, 'fillet r4 at the corner (centre 26,16)');
  check(s.loops === 1 && s.open_ends === 0, 'still one closed profile');
  await shot('01-fillet');
  // ---- offset the loop inwards (O, click an edge, −2)
  await h.key('o'); await h.click(15, 0); await h.typeValue(-2);
  s = await h.state();
  check(s.e === 10, `offset added the 5-curve loop (${s.e} entities)`);
  check(s.loops === 2, `two closed loops (${s.loops})`);
  await shot('02-offset');
  // ---- trim: a line across the rectangle, trim the part outside
  await h.key('Escape'); await h.key('l'); await h.click(10, -6); await h.click(10, 26, { shift: true }); await h.key('Escape'); await h.key('Escape');
  const lineIdx = (await h.state()).e - 1;
  await h.key('t'); await h.hover(10, 24);
  await h.click(10, 24);
  lap(`trim status ${JSON.stringify(await D(() => window.__cubbyDesign.design.status))}`);
  ln = await D((i) => window.__cubbyDesign.sketch.sk.entities[i], lineIdx);
  lap(`trimmed line ${JSON.stringify([ln.p0, ln.p1])}`);
  check([20, 22, 18].some((y) => Math.abs(Math.max(ln.p0[1], ln.p1[1]) - y) < 1e-3), 'trim cut the line at the profile');
  // ---- extend: a short line towards a vertical one
  await h.key('Escape'); await h.key('l'); await h.click(40, 5, { shift: true }); await h.click(44, 5, { shift: true }); await h.key('Escape');
  await h.key('l'); await h.click(55, -5, { shift: true }); await h.click(55, 15, { shift: true }); await h.key('Escape'); await h.key('Escape');
  const shortIdx = (await h.state()).e - 2;
  await h.key('x'); await h.click(43.5, 5);
  ln = await D((i) => window.__cubbyDesign.sketch.sk.entities[i], shortIdx);
  lap(`extended line ${JSON.stringify([ln.p0, ln.p1])}`);
  check(Math.abs(Math.max(ln.p0[0], ln.p1[0]) - 55) < 1e-3, 'extend reached the vertical line at x=55');
  await shot('03-trim-extend');
  // ---- more tools: tangent arc from the short line's end, slot, polygon, spline, ellipse, point
  await h.key('Escape');
  await run('design.sketch.tool.arc-tangent'); await h.click(55, 5); await h.click(60, 12);
  s = await h.state();
  check(s.types.includes('tangent') && s.ents.includes('arc'), 'tangent arc: arc + Tangent');
  await h.key('s'); await h.click(0, 40, { shift: true }); await h.click(20, 40, { shift: true }); await h.click(10, 44, { shift: true }); await h.key('Escape');
  await h.key('g'); await h.click(45, 40, { shift: true }); await h.click(52, 40, { shift: true }); await h.key('Escape');
  await h.key('b'); for (const p of [[70, 0], [75, 8], [80, 0], [85, 8]]) await h.click(...p, { shift: true }); await h.key('Enter');
  await h.key('e'); await h.click(75, 30, { shift: true }); await h.click(82, 30, { shift: true }); await h.click(75, 33, { shift: true });
  await h.key('p'); await h.click(90, 30, { shift: true });
  s = await h.state();
  lap(JSON.stringify(s.ents));
  check(['spline', 'ellipse', 'point'].every((x) => s.ents.includes(x)), 'spline, ellipse, point drawn');
  await h.key('Escape'); await h.key('Escape');
  await shot('04-tools');
  // ---- arc slot (Orca's click sequence: centre, start, end, width), then its Radius / Width fields
  const nBefore = (await h.state()).e;
  await run('design.sketch.tool.arc-slot');
  await h.click(-40, 60); await h.click(-25, 60, { shift: true }); await h.click(-40, 75);
  await h.hover(-22, 60);
  const rub = await D(() => window.__cubbyDesign.sketchLive?.preview?.length ?? null);
  await shot('04b-arc-slot-rubber');
  await h.click(-22, 60);
  s = await h.state();
  check(s.e === nBefore + 4 && s.ents.slice(-4).every((x) => x === 'arc'), `arc slot: four arcs (${s.ents.slice(-4)})`);
  check(s.value === 'Radius', `arc slot: the Radius field opens (${s.value})`);
  await h.typeValue(20);
  s = await h.state();
  check(s.value === 'Width', `then Width (${s.value})`);
  await h.typeValue(8);
  const sl = await D((n) => window.__cubbyDesign.sketch.sk.entities.slice(n).map((e) => +e.radius.toFixed(4)), nBefore);
  const slc = await D((n) => window.__cubbyDesign.sketch.sk.constraints.filter((c) => c.ea >= n).map((c) => c.type), nBefore);
  lap(`arc slot radii ${JSON.stringify(sl)} constraints ${JSON.stringify(slc)} rubber ${rub}`);
  check(JSON.stringify(sl) === JSON.stringify([24, 4, 16, 4]), 'arc slot follows Radius 20 / Width 8 (outer 24, inner 16, caps 4)');
  check(slc.filter((x) => x === 'tangent').length === 4 && slc.includes('distance') && slc.includes('diameter'), 'arc slot: tangent joints + its two dimensions');
  check((await h.state()).ok, 'arc slot solves');
  await shot('04c-arc-slot');
  await h.key('Escape'); await h.key('Escape');
  // ---- a constraint badge: Shift+click selects it, a plain click deletes it (Orca), Ctrl+Z brings it back
  const badge = await D(() => { const k = window.__cubbyDesign.sketch.sk; for (const el of document.querySelectorAll('[data-testid="sketch-badge"]')) { const i = Number(el.getAttribute('data-constraint')); const r = el.getBoundingClientRect(); if (['horizontal', 'vertical'].includes(k.constraints[i]?.type) && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el) return { i, type: k.constraints[i].type }; } return null; });
  check(!!badge, `an H / V badge is shown, uncovered (${JSON.stringify(badge)})`);
  if (badge) {
    const sel = `[data-testid="sketch-badge"][data-constraint="${badge.i}"]`;
    const c0 = (await h.state()).c;
    await page.click(sel, { modifiers: ['Shift'] }); await h.idle();
    check((await D(() => window.__cubbyDesign.sketch.sk.selCons.slice())).join() === String(badge.i) && (await h.state()).c === c0, 'Shift+click on a badge selects its constraint');
    await page.keyboard.press('Escape'); await page.waitForTimeout(100);
    await shot('04d-badge-before');
    await page.click(sel); await page.waitForTimeout(150); await h.idle();
    s = await h.state();
    const status = await D(() => window.__cubbyDesign.design.status?.text ?? '');
    check(s.c === c0 - 1, `a click on the badge deleted the constraint (${c0} → ${s.c}; ${status})`);
    check(/Deleted/.test(status), 'status says what was deleted');
    await shot('04e-badge-deleted');
    await page.keyboard.press('Control+z'); await page.waitForTimeout(200); await h.idle();
    s = await h.state();
    check(s.c === c0 && s.types[badge.i] === badge.type, 'Ctrl+Z restores it');
  }
  // ---- drag an under-constrained point (the polygon's centre circle moves the polygon)
  const before = s.dof;
  await h.dragP([90, 30], [92, 34]);
  const pnt = await D(() => window.__cubbyDesign.sketch.sk.entities.find((e) => e.type === 'point').p0);
  check(Math.abs(pnt[0] - 92) < 0.6 && Math.abs(pnt[1] - 34) < 0.6, `dragged the point to (${pnt.map((v) => v.toFixed(2))})`);
  check((await h.state()).undo > 0, 'drag is undoable');
  // ---- constraint button: select two lines → Perpendicular via the planner
  // ---- MCP tools on the open sketch
  const d0 = await tool('design_sketch_describe');
  check(d0.open && d0.entities.length === s.e, 'design_sketch_describe sees the session');
  const add = await tool('design_sketch_add', { tool: 'circle', points: [[100, 0], [103, 0]] });
  check(add.first_index === s.e && add.constraints.length > d0.constraints.length - 1, 'design_sketch_add (tool circle)');
  const dia = await tool('design_sketch_constrain', { constraint: { type: 'diameter', ea: add.first_index, ra: 'center', value: 8 } });
  check(dia.ok, 'design_sketch_constrain diameter');
  const bad = await tool('design_sketch_constrain', { constraint: { type: 'diameter', ea: add.first_index, ra: 'center', value: 9 } });
  check(!bad.ok && bad.conflicts_with?.length === 1 && /Diameter 8/.test(bad.conflicts_with[0].text), `conflict reported: ${JSON.stringify(bad.conflicts_with)}`);
  const trap = await tool('design_sketch_constrain', { constraint: { type: 'radius', ea: 0, value: 3 } });
  check(!trap.ok && /arc or a circle/.test(trap.error ?? ''), 'radius on a line refused before the kernel (it traps)');
  const plan = await tool('design_sketch_plan', { type: 'radius', entities: [add.first_index] });
  check(plan.kind === 'ask_value' && Math.abs(plan.prefill - 4) < 1e-6, 'design_sketch_plan radius → ask 4');
  const ang = await tool('design_sketch_add', { entities: [{ type: 'line', p0: [110, 0], p1: [120, 0] }, { type: 'line', p0: [110, 0], p1: [117, 7] }], constraints: [{ type: 'horizontal', ea: add.first_index + 1, ra: 'p0', eb: add.first_index + 1, rb: 'p1' }, { type: 'coincident', ea: add.first_index + 1, ra: 'p0', eb: add.first_index + 2, rb: 'p0' }] });
  const ac = await tool('design_sketch_constrain', { constraint: { type: 'angle', ea: add.first_index + 1, eb: add.first_index + 2, value: 30 } });
  const l2 = ac.entities[add.first_index + 2];
  const deg = Math.atan2(l2.p1[1] - l2.p0[1], l2.p1[0] - l2.p0[0]) * 180 / Math.PI;
  check(ac.ok && Math.abs(Math.abs(deg) - 30) < 1e-3, `angle 30° in degrees (line at ${deg.toFixed(3)}°)`);
  const txt = await tool('design_sketch_text', { text: 'Hi' });
  check(/sketch of its own/.test(txt.thrown ?? ''), 'text refused in a sketch with geometry');
  await shot('05-mcp');
  const cm = await tool('design_sketch_commit');
  check(cm.ok && cm.sketch_index === 0, 'design_sketch_commit');
  await settled((d) => d.features.length === 1, 'committed');
  // ---- text sketch through the tools → extrude
  const b2 = await tool('design_sketch_begin', { plane: 'XY' });
  check(b2.open, 'design_sketch_begin XY');
  const tx = await tool('design_sketch_text', { text: 'CS', size: 12, offset: [0, -40] });
  check(tx.regions?.count >= 2, `text regions (${tx.regions?.count})`);
  await page.waitForTimeout(400);
  await shot('06-text');
  const cm2 = await tool('design_sketch_commit');
  check(cm2.ok && cm2.sketch_index === 1, 'text sketch committed');
  const ex = await D(async () => { const W = window.__cubbyDesign; return W.runEdit('Extrude', async (c, doc) => (await c.call('extrude', { doc, sketch: 1, distance: 2 })).result); });
  await settled((d) => d.bodies.length === 1, 'text extruded');
  const tb = await D(() => window.__cubbyDesign.design.bodies[0]);
  check(tb && tb.face_count > 10, `text body (${tb?.face_count} faces)`);
  // SVG via the tool, in its own sketch
  await tool('design_sketch_begin', { plane: 'XY' });
  const svg = await tool('design_sketch_svg', { svg: '<svg xmlns="http://www.w3.org/2000/svg" width="20mm" height="20mm" viewBox="0 0 20 20"><path d="M0 0H20V20H0Z M5 5V15H15V5Z" fill="black"/><circle cx="10" cy="10" r="2"/></svg>' });
  check(svg.regions?.count === 2, `svg: square with a hole + a dot (${svg.regions?.count} regions)`);
  // ---- drag the outlines into place (Orca's TransformArt): the centre handle moves, a corner scales
  await page.waitForSelector('[data-testid="sketch-outline-move"]');
  const dragEl = async (selector, to) => {
    const bb = await page.locator(selector).boundingBox();
    const [tx, ty] = await h.P(...to);
    await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2); await page.mouse.down();
    await page.mouse.move((bb.x + bb.width / 2 + tx) / 2, (bb.y + bb.height / 2 + ty) / 2, { steps: 5 }); await page.mouse.move(tx, ty, { steps: 5 }); await page.mouse.up();
    await page.waitForTimeout(150);
  };
  await dragEl('[data-testid="sketch-outline-move"]', [30, 10]);
  let rg = await D(() => window.__cubbyDesign.sketch.sk.regions);
  check(Math.abs(rg.offset[0] - 30) < 0.6 && Math.abs(rg.offset[1] - 10) < 0.6 && rg.scale[0] === 1, `centre handle moved the outline to (${rg.offset.map((v) => v.toFixed(2))})`);
  await shot('07-outline-moved');
  await dragEl('[data-testid="sketch-outline-corner-2"]', [rg.offset[0] + 20, rg.offset[1] + 20]);
  rg = await D(() => window.__cubbyDesign.sketch.sk.regions);
  check(Math.abs(rg.scale[0] - 1.5) < 0.05 && Math.abs(rg.scale[1] - 1.5) < 0.05, `corner handle scaled it about the opposite corner (${rg.scale.map((v) => v.toFixed(3))})`);
  await shot('08-outline-scaled');
  const cm3 = await tool('design_sketch_commit');
  check(cm3.ok, 'SVG sketch committed');
  const fsv = await D(async (i) => { const W = window.__cubbyDesign; return W.designKernel().run('read', async (c) => (await c.call('get_feature', { doc: W.currentDoc(), index: i })).result.feature, { quiet: true }); }, cm3.sketch_index);
  check(Math.abs(fsv.import_scale_x - rg.scale[0]) < 1e-9 && Math.abs(fsv.import_offset[0] - rg.offset[0]) < 1e-9, `the placement is written to the sketch (scale ${fsv.import_scale_x?.toFixed?.(3)}, offset ${JSON.stringify(fsv.import_offset)})`);
  void t;
}
