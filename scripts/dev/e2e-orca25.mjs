// Browser end-to-end checks of the OrcaSlicer 2.5 features on the real engine
// (public/wasm/orca, version 2.5.x): every check builds a project through the
// app's own stores, slices it in the engine worker and reads the G-code.
//
//   node scripts/dev/e2e-orca25.mjs [baseUrl] [check,...]
//   THREADS=1 node scripts/dev/e2e-orca25.mjs …   # single-threaded engine (default: multi-threaded when isolated)
//   OUT=e2e-out/orca25                           # where G-code / reports are written
//
// Checks: plain, variants, mixed, paint32, seam, tower, purge-fast, hybrid, imex, iqex, belt, belt-purge, calib, 3mf, flush-roundtrip
// (3mf saves projects with each 2.5 feature and runs OrcaSlicer's own loader on them: cs_tool inspect_3mf,
// whose texture-displacement / design-recipe / auto_drop fields check those through the loader
// on the staged engine, in node).
// Run against a dev server (`npx vite --port 5461`); the stores are imported from /slicer/src/.
// Other agents editing the tree make Vite reload the page: serve without HMR then
// (`server: { hmr: false, watch: { ignored: ['**/*'] } }`).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PW = process.env.PLAYWRIGHT ?? 'playwright';
const { chromium } = await import(PW);
const base = process.argv[2] ?? 'http://localhost:5461/slicer/';
const ALL = ['plain', 'variants', 'mixed', 'paint32', 'seam', 'tower', 'purge-fast', 'hybrid', 'imex', 'iqex', 'belt', 'belt-purge', 'calib', '3mf', 'flush-roundtrip'];
const only = process.argv[3] ? process.argv[3].split(',') : ALL;
const out = resolve(process.env.OUT ?? 'e2e-out/orca25');
mkdirSync(out, { recursive: true });
const threads = process.env.THREADS ?? '';

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.addInitScript((t) => {
  try { localStorage.setItem('cubby.setup.done', 'true'); if (t) localStorage.setItem('cubby-slicer:engine-threads', t); } catch { /* ignore */ }
}, threads);
const page = await context.newPage();
page.setDefaultTimeout(1_200_000);
const problems = [];
page.on('pageerror', (e) => { problems.push(`pageerror: ${e.message}`); console.log('[pageerror]', e.message); });
page.on('console', (m) => { if (m.type() === 'error' && !/ERR_NAME_NOT_RESOLVED|favicon/.test(m.text())) { problems.push(m.text()); console.log('[console.error]', m.text().slice(0, 300)); } });
page.on('framenavigated', (f) => { if (f === page.mainFrame() && loaded) console.log('[warn] page navigated (Vite reload?)'); });

const t0 = Date.now();
const lap = (s) => console.log(`${((Date.now() - t0) / 1000).toFixed(0).padStart(5)}s  ${s}`);
let loaded = false;
await page.goto(`${base}?cubby-debug`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__cubbyProject);
loaded = true;
const engine = await page.evaluate(async () => (await (await fetch('/slicer/wasm/orca/version.json')).json()));
lap(`app loaded, engine ${JSON.stringify(engine)}, threads pref ${threads || 'auto'}`);

// ---- in-page helpers ------------------------------------------------------------------------
await page.evaluate(() => {
  const imp = (p) => import(`/slicer/src/${p}`);
  const box = (sx, sy, sz) => {
    const v = [0, 0, 0, sx, 0, 0, sx, sy, 0, 0, sy, 0, 0, 0, sz, sx, 0, sz, sx, sy, sz, 0, sy, sz];
    const f = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
    return { positions: new Float32Array(v), indices: new Uint32Array(f) };
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const TOUCHED = ['flush_volumes_matrix', 'flush_multiplier', 'extruder_nozzle_stats', 'wipe_tower_x', 'wipe_tower_y', 'prime_volume_mode', 'nozzle_volume_type', 'filament_map', 'filament_map_mode', 'filament_volume_map', 'filament_colour'];
  window.__o25 = {
    box,
    async presets() { const P = await imp('presets/index.ts'); P.setActiveEngine('orca'); const s = P.presetsFor('orca'); await s.ready; return s; },
    /** Clean slate: empty project, no calibration, printer selected with its presets unmodified. */
    async fresh(printer) {
      const store = await imp('project/store/index.ts');
      store.resetProject();
      const s = await this.presets();
      for (const k of TOUCHED) delete s.project[k];
      const mixed = await imp('mixed/store.ts'); mixed.removeAllMixedFilaments();
      if (s.selection.filaments.length > 1) await s.setFilamentCount(1);
      await s.installPrinter(printer); await s.selectPrinter(printer);
      for (const k of ['printer', 'process']) s.revertAll(k);
      s.selection.filaments.forEach((_, i) => s.revertAll('filament', i));
      await wait(1500);
      return { printer: s.selectedInfo('printer').name, process: s.selectedInfo('process').name, filaments: s.infos.value.filaments.map((f) => f.name) };
    },
    async addBox(size, at, name = 'box') {
      const store = await imp('project/store/index.ts');
      const m = box(...size);
      const [id] = store.addParsedObjects([{ name, positions: m.positions, indices: m.indices }]);
      const o = store.getObject(id);
      if (at) store.setTransforms([{ id, position: [at[0], at[1], o.position[2]], rotation: o.rotation, scale: o.scale }], 'Move');
      return id;
    },
    async override(id, key, value) { (await imp('project/store/index.ts')).setObjectOverride(id, key, value); },
    async settle() { await wait(1500); },
    /** Slice the active plate; G-code text + report + the config the job was built from. */
    async slice() {
      const SL = await imp('app/slice.ts');
      const st = await imp('app/state.ts');
      await wait(1500); // resolvedConfig is debounced
      const c = SL.useSliceController();
      const t = performance.now();
      await c.slice();
      const r = st.lastSlice.value;
      const fail = c.status.value !== 'done';
      return {
        status: c.status.value, error: c.error.value, ms: Math.round(performance.now() - t),
        report: fail ? c.errorReport.value : r?.report, text: fail || !r ? '' : new TextDecoder().decode(r.gcode),
        config: JSON.parse(JSON.stringify(st.resolvedConfig.value)),
      };
    },
    async resolveVariants(config) { return (await imp('engine/client.ts')).resolveVariants(config); },
    async parse(text) {
      const { parseGcode } = await imp('preview/parser/parse.ts');
      const { Feature } = await imp('preview/parser/features.ts');
      const p = parseGcode(new TextEncoder().encode(text));
      // Max speed (mm/s) and temperature per tool for outer walls.
      const outer = {};
      for (let i = 0; i < p.segmentCount; i++) {
        if (p.feature[i] !== Feature.OuterWall) continue;
        const t = p.tool[i]; const o = (outer[t] ??= { maxSpeed: 0, temps: new Set() });
        o.maxSpeed = Math.max(o.maxSpeed, p.speed[i]); o.temps.add(p.temp[i]);
      }
      for (const o of Object.values(outer)) o.temps = [...o.temps].sort((a, b) => a - b);
      return { layers: p.layerCount, toolsUsed: p.stats.toolsUsed, outer, mm: Array.from(p.stats.filamentMmPerTool ?? []), other: p.stats.featureCount[Feature.Other] };
    },
  };
});

// ---- G-code helpers (node side) ---------------------------------------------------------------
const cfgOf = (text) => Object.fromEntries([...text.matchAll(/^; (\w+) = (.*)$/gm)].map((m) => [m[1], m[2]]));
const list = (s) => (s ?? '').split(',').map((x) => x.trim());
const num = (s) => Number(s);
/** Extruded length per feature (relative E). */
function featureE(text) {
  const out = {}; let cur = '';
  for (const l of text.split('\n')) {
    const m = l.match(/^;\s*(?:TYPE|FEATURE):\s*(.*)$/); if (m) { cur = m[1].trim(); continue; }
    if (l.startsWith('G1 ') || l.startsWith('G2 ') || l.startsWith('G3 ')) { const e = l.match(/ E(-?[\d.]+)/); if (e && +e[1] > 0) out[cur] = (out[cur] ?? 0) + +e[1]; }
  }
  for (const k of Object.keys(out)) out[k] = +out[k].toFixed(1);
  return out;
}
/** Start points of outer-wall loops (the position where each outer wall block starts extruding). */
function seamPoints(text) {
  const pts = []; let x = 0, y = 0, z = 0, inOuter = false, started = false;
  for (const l of text.split('\n')) {
    const f = l.match(/^;\s*(?:TYPE|FEATURE):\s*(.*)$/);
    if (f) { inOuter = /^Outer wall/i.test(f[1].trim()); started = false; continue; }
    if (!/^G[0123] /.test(l)) continue;
    const e = l.match(/ E(-?[\d.]+)/);
    if (inOuter && !started && e && +e[1] > 0) { pts.push([x, y, z]); started = true; }
    const mx = l.match(/ X(-?[\d.]+)/), my = l.match(/ Y(-?[\d.]+)/), mz = l.match(/ Z(-?[\d.]+)/);
    if (mx) x = +mx[1]; if (my) y = +my[1]; if (mz) z = +mz[1];
  }
  return pts;
}

/** XY extents of outer-wall extrusions (the object's outline). */
function outerExtents(text) {
  let x = 0, y = 0, inOuter = false; const b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  for (const l of text.split('\n')) {
    const f = l.match(/^;\s*(?:TYPE|FEATURE):\s*(.*)$/);
    if (f) { inOuter = /^Outer wall/i.test(f[1].trim()); continue; }
    if (!/^G[0123] /.test(l)) continue;
    const mx = l.match(/ X(-?[\d.]+)/), my = l.match(/ Y(-?[\d.]+)/), e = l.match(/ E(-?[\d.]+)/);
    if (mx) x = +mx[1]; if (my) y = +my[1];
    if (inOuter && e && +e[1] > 0) { b.minX = Math.min(b.minX, x); b.maxX = Math.max(b.maxX, x); b.minY = Math.min(b.minY, y); b.maxY = Math.max(b.maxY, y); }
  }
  return b;
}

const results = [];
/** `known`: a failure already reported upstream (listed, doesn't fail the run). */
function record(check, ok, evidence, known = null) {
  results.push({ check, ok, evidence, ...(known && !ok ? { known } : {}) });
  lap(`${ok ? 'PASS' : known ? 'KNOWN' : 'FAIL'} ${check}: ${typeof evidence === 'string' ? evidence : JSON.stringify(evidence)}`);
}
const save = (name, text) => { if (text) writeFileSync(`${out}/${name}.gcode`, text); };
const ev = (fn, arg) => page.evaluate(fn, arg);

async function sliced(name) {
  const r = await ev(() => window.__o25.slice());
  save(name, r.text);
  if (r.status !== 'done') lap(`  ${name}: ${r.status} ${r.error}`);
  return r;
}
const warnCodes = (r) => (r.report?.warnings ?? []).map((w) => `${w.code}: ${w.message.slice(0, 80)}`);

// ---- checks --------------------------------------------------------------------------------------

const CHECKS = {
  // A plain single-extruder printer. Expectation from the 2.4.2 engine (same app flow, same cube,
  // MyKlipper 0.4 + its default process / filament): 100 layers, walls and solid infill identical,
  // total extrusion 1502.6 mm (2.5 extrudes 1503.2: sparse infill +0.6 mm).
  async plain() {
    lap(`presets ${JSON.stringify(await ev(() => window.__o25.fresh('sys:Custom/MyKlipper 0.4 nozzle')))}`);
    await ev(() => window.__o25.addBox([20, 20, 20], [128, 128]));
    const r = await sliced('plain-myklipper');
    const fe = featureE(r.text), total = Object.values(fe).reduce((a, b) => a + b, 0);
    const p = r.text ? await ev((t) => window.__o25.parse(t), r.text) : null;
    const ok = r.status === 'done' && p?.layers === 100 && Math.abs(total - 1502.6) < 15
      && Math.abs((fe['Outer wall'] ?? 0) - 308.5) < 1 && Math.abs((fe['Inner wall'] ?? 0) - 476.6) < 1 && p.other === 0;
    record('plain single extruder vs 2.4.2', ok, { layers: p?.layers, totalE: +total.toFixed(1), outer: fe['Outer wall'], inner: fe['Inner wall'],
      time: r.report?.stats?.printTimeSec, threads: r.report?.threads, events: r.report?.events?.map((e) => e.event), warnings: warnCodes(r) });
  },

  // H2D: left High Flow, right Standard; filament 1 → left, filament 2 → right, two filaments with
  // different numbers of variant columns.
  async variants() {
    lap(`presets ${JSON.stringify(await ev(() => window.__o25.fresh('sys:BBL/Bambu Lab H2D 0.4 nozzle')))}`);
    const pick = await ev(async () => {
      const s = await window.__o25.presets();
      await s.setFilamentCount(2);
      // Two compatible filaments of one type (small flush, so the tower fits) whose
      // filament_extruder_variant lengths differ; the second's temperatures differ per column.
      const cands = [];
      for (const info of s.compatible.value.filament) {
        if (info.id === 'default' || !info.id.startsWith('sys:')) continue;
        const v = await s.resolvePreset('filament', info.id).catch(() => null);
        const vars = [].concat(v?.values.filament_extruder_variant ?? []);
        const type = [].concat(v?.values.filament_type ?? [])[0] ?? '';
        if (!vars.length || !/^(PLA|PETG)$/.test(type)) continue;
        cands.push({ id: info.id, type, vars, temps: [].concat(v.values.nozzle_temperature ?? []) });
      }
      const bc = cands.find((c) => c.vars.length > 1 && new Set(c.temps).size > 1 && c.vars.includes('Direct Drive Standard'))
        ?? cands.find((c) => c.vars.length > 1);
      const ac = cands.find((c) => c.type === bc?.type && c.vars.length !== bc.vars.length) ?? cands.find((c) => c.vars.length !== bc?.vars.length);
      const a = ac?.id, b = bc?.id, cols = [ac?.vars.length, bc?.vars.length];
      // filament 2 runs on the right (Standard) extruder: its "Direct Drive Standard" column.
      const presetTemp2 = bc ? bc.temps[Math.max(0, bc.vars.indexOf('Direct Drive Standard'))] : null;
      const presetTemp1 = ac ? ac.temps[Math.max(0, ac.vars.indexOf('Direct Drive High Flow'))] : null;
      if (a) await s.selectFilament(0, a);
      if (b) await s.selectFilament(1, b);
      s.project.filament_map_mode = 'Manual';
      s.project.filament_map = ['1', '2'];
      s.setNozzleVolumeType(0, 'High Flow');
      s.setNozzleVolumeType(1, 'Standard');
      // The prime tower stays at its default position: the app moves it where both extruders reach (app/wipeTower.ts).
      return { cols, presetTemps: [presetTemp1, presetTemp2], b: bc && { vars: bc.vars, temps: bc.temps }, filaments: s.infos.value.filaments.map((f) => f.name), nozzles: s.nozzleVolumeTypes() };
    });
    lap(`  ${JSON.stringify(pick)}`);
    const a = await ev(() => window.__o25.addBox([20, 20, 10], [120, 250], 'left'));
    const b = await ev(() => window.__o25.addBox([20, 20, 10], [200, 250], 'right'));
    await ev(([a, b]) => Promise.all([window.__o25.override(a, 'extruder', '1'), window.__o25.override(b, 'extruder', '2')]), [a, b]);
    const r = await sliced('variants-h2d');
    const rv = await ev((c) => window.__o25.resolveVariants(c), r.config);
    const g = cfgOf(r.text);
    const p = r.text ? await ev((t) => window.__o25.parse(t), r.text) : null;
    const want = { outer: rv.print.outer_wall_speed, inner: rv.print.inner_wall_speed, temp: rv.filament.nozzle_temperature, tempL1: rv.filament.nozzle_temperature_initial_layer };
    const got = { outer: list(g.outer_wall_speed), inner: list(g.inner_wall_speed), temp: list(g.nozzle_temperature), tempL1: list(g.nozzle_temperature_initial_layer) };
    const same = (x, y) => x?.length === y?.length && x.every((v, i) => num(v) === num(y[i]));
    const speedsDiffer = num(want.outer[0]) !== num(want.outer[1]);
    // Moves: the fastest outer wall of each tool must not exceed its extruder's speed (and reach it on a 20 mm box).
    const t0 = p?.outer[0], t1 = p?.outer[1];
    const movesOk = !!t0 && !!t1 && t0.maxSpeed <= num(want.outer[0]) + 0.5 && t1.maxSpeed <= num(want.outer[1]) + 0.5;
    // Parser temperatures are in 0.1 °C.
    // Bambu's own change-filament G-code (its `include` template) hands each tool's print temperature to the
    // firmware's tool-change macro (`M620.10 A<extruder> … P<temp>`) instead of an M104 before the moves.
    const macroTemps = [...(r.text ?? '').matchAll(/^M620\.10 A(\d+)\b[^\n]*\bP(\d+)/gm)].map((m) => [+m[1], +m[2]]);
    const atTool = (e, t) => (e === 0 ? t0 : t1)?.temps.includes(t * 10) || macroTemps.some(([a, p]) => a === e && p === t);
    const tempOk = !!t0 && !!t1 && atTool(0, num(want.temp[0])) && atTool(1, num(want.temp[1]))
      && want.temp.every((v, i) => num(v) === num(pick.presetTemps[i]));
    record('H2D variants: G-code config = resolve_variants', r.status === 'done' && rv.resolvedBy === 'print_apply' && same(want.outer, got.outer) && same(want.inner, got.inner) && speedsDiffer,
      { resolvedBy: rv.resolvedBy, extruders: rv.extruderCount, outer: got.outer, wantOuter: want.outer, inner: got.inner, variants: g.print_extruder_variant, nozzle: g.nozzle_volume_type, error: r.error });
    record('H2D variants: per-extruder outer wall speed in moves', movesOk, { T0: t0, T1: t1 });
    record('H2D variants: filaments with different variant columns get their temperatures', same(want.temp, got.temp) && same(want.tempL1, got.tempL1) && tempOk,
      { cols: pick.cols, presetTemps: pick.presetTemps, second: pick.b, want: want.temp, got: got.temp, wantL1: want.tempL1, gotL1: got.tempL1, moveTemps: [t0?.temps, t1?.temps], macroTemps: [...new Set(macroTemps.map((x) => x.join(':')))] });
  },

  // Plain mix + gradient mix, sublayers on and off.
  async mixed() {
    for (const sub of ['1', '0']) {
      await ev(() => window.__o25.fresh('sys:BBL/Bambu Lab P1S 0.4 nozzle'));
      const info = await ev(async (sub) => {
        const s = await window.__o25.presets();
        await s.setFilamentCount(2);
        s.setFilamentColour(0, '#FF0000'); s.setFilamentColour(1, '#0000FF');
        const m = await import('/slicer/src/mixed/store.ts');
        m.addMixedFilament({ components: [1, 2], ratios: [50, 50], gradient: false, direction: 'ab', curve: [], perPart: false });
        m.addMixedFilament({ components: [1, 2], ratios: [50, 50], gradient: true, direction: 'ab', curve: [], perPart: false });
        s.setValue('process', 'enable_mixed_color_sublayer', sub);
        return { slots: s.filamentSlotCount(), colours: s.filamentColours() };
      }, sub);
      const a = await ev(() => window.__o25.addBox([20, 20, 10], [100, 128], 'plain-mix'));
      const b = await ev(() => window.__o25.addBox([20, 20, 10], [160, 128], 'gradient-mix'));
      await ev(([a, b]) => Promise.all([window.__o25.override(a, 'extruder', '3'), window.__o25.override(b, 'extruder', '4')]), [a, b]);
      const r = await sliced(`mixed-sublayer${sub}`);
      const g = cfgOf(r.text);
      const flush = list(g.flush_volumes_matrix);
      const p = r.text ? await ev((t) => window.__o25.parse(t), r.text) : null;
      const toolChanges = (r.text.match(/^T[01]\s*$/gm) ?? []).length + (r.text.match(/^M620 S[01]/gm) ?? []).length;
      record(`mixed (sublayer ${sub === '1' ? 'on' : 'off'}): plain + gradient mix slice, 4×4 flush matrix accepted`,
        r.status === 'done' && flush.length === 16 && g.filament_is_mixed?.replace(/\s/g, '') === '0,0,1,1' && p.toolsUsed.length === 2,
        { slots: info.slots, colours: info.colours, flush: flush.length, isMixed: g.filament_is_mixed, sublayer: g.enable_mixed_color_sublayer, tools: p?.toolsUsed, toolChanges, layers: p?.layers, error: r.error });
    }
  },

  // Colour paint with filament numbers above 16.
  async paint32() {
    await ev(() => window.__o25.fresh('sys:BBL/Bambu Lab P1S 0.4 nozzle'));
    await ev(async () => { const s = await window.__o25.presets(); await s.setFilamentCount(18); });
    const id = await ev(() => window.__o25.addBox([20, 20, 10], [128, 128], 'painted'));
    const painted = await ev(async (id) => {
      const store = await import('/slicer/src/project/store/index.ts');
      const client = await import('/slicer/src/engine/client.ts');
      const o = store.getObject(id); const m = store.getMesh(o.meshId);
      // Bottom (triangles 0, 1) filament 17, top (2, 3) and the four sides filament 18.
      const states = [[0, 17], [1, 17], ...Array.from({ length: 10 }, (_, k) => [k + 2, 18])];
      const map = await client.paintFromStates({ positions: m.positions, indices: m.indices }, states);
      store.setMeshPaint(o.meshId, 'color', map);
      return map.length;
    }, id);
    const r = await sliced('paint-17-18');
    const p = r.text ? await ev((t) => window.__o25.parse(t), r.text) : null;
    const g = cfgOf(r.text);
    record('colour paint, filaments 17 and 18', r.status === 'done' && p.toolsUsed.includes(16) && p.toolsUsed.includes(17),
      { painted, tools: p?.toolsUsed, flush: list(g.flush_volumes_matrix).length, error: r.error });
  },

  // A precise seam (center) on the +X face moves the seam there.
  async seam() {
    await ev(() => window.__o25.fresh('sys:Custom/MyKlipper 0.4 nozzle'));
    const id = await ev(() => window.__o25.addBox([20, 20, 10], [128, 128], 'seamed'));
    const base = await sliced('seam-without');
    await ev(async (id) => {
      const store = await import('/slicer/src/project/store/index.ts');
      const bb = store.objectLocalBBox(store.getObject(id));
      const m = window.__o25.box(4, 4, 14);
      // Centred on the +X face, mid Y; the box mesh's origin is its corner.
      store.addPart(id, 'modifier', 'Seam', m.positions, m.indices, [bb.max[0] - 2, (bb.min[1] + bb.max[1]) / 2 - 2, bb.min[2] - 2], 'precise_seam_center');
    }, id);
    const withSeam = await sliced('seam-with');
    const xs = (t) => seamPoints(t).filter((p) => p[2] > 1 && p[2] < 9);
    const a = xs(base.text), b = xs(withSeam.text);
    const ext = (pts, f) => pts.reduce((m, p) => f(m, p[0]), pts.length ? pts[0][0] : 0);
    // Expected: every outer-wall start within 3 mm of the +X face's middle (x = max X, y = centre).
    const bb = outerExtents(base.text);
    const target = [bb.maxX, (bb.minY + bb.maxY) / 2];
    const near = (pts) => pts.filter((p) => Math.hypot(p[0] - target[0], p[1] - target[1]) < 3).length;
    record('precise seam (center) moves the seam', withSeam.status === 'done' && b.length > 0 && near(b) === b.length && near(a) < a.length,
      { target: target.map((v) => +v.toFixed(2)), withoutNear: `${near(a)}/${a.length}`, withNear: `${near(b)}/${b.length}`, sampleWith: b.slice(0, 2), sampleWithout: a.slice(0, 2),
        xRange: [ext(b, Math.min), ext(b, Math.max)], error: withSeam.error, warnings: warnCodes(withSeam) });
  },

  // Fast purge mode (A2L, support_fast_purge_mode) changes the flush volumes.
  // Prime tower in Prepare (desktop's wipe tower volume): placed at desktop's default spot, dragged
  // (moveTower = the viewport's drop), sliced where it was dropped, re-placed off the objects when
  // saved far off the plate, and kept clear by Arrange.
  async tower() {
    await ev(() => window.__o25.fresh('sys:BBL/Bambu Lab P1S 0.4 nozzle'));
    await ev(async () => { const s = await window.__o25.presets(); await s.setFilamentCount(2); });
    const a = await ev(() => window.__o25.addBox([20, 20, 20], [60, 60]));
    const b = await ev(() => window.__o25.addBox([20, 20, 20], [120, 60]));
    await ev(([id]) => window.__o25.override(id, 'extruder', '2'), [b]);
    void a;
    const view = async () => ev(async () => {
      const TP = await import('/slicer/src/app/towerPreview.ts');
      // The first footprint call starts the engine instance (slow on a loaded machine).
      for (let i = 0; i < 600; i++) { if (TP.towerViews.value.length) break; await new Promise((r) => setTimeout(r, 500)); }
      await new Promise((r) => setTimeout(r, 1500));
      return JSON.parse(JSON.stringify(TP.towerViews.value[0] ?? { missing: true, debug: TP.towerDebug }));
    });
    const v0 = await view();
    record('prime tower drawn in Prepare at desktop\'s default spot (P1S: x 165, two filament slabs)', !!v0 && !v0.missing && Math.abs(v0.x - 165) < 0.01 && v0.colours.length === 2 && v0.depth > 0,
      v0?.missing ? v0 : v0 && { x: v0.x, y: v0.y, w: +v0.width.toFixed(2), d: +v0.depth.toFixed(2), h: v0.height, brim: +v0.brim.toFixed(2) });
    await ev(async () => { (await import('/slicer/src/app/towerPreview.ts')).moveTower(0, 30, 150); });
    const r = await sliced('tower-dragged');
    const cfg = cfgOf(r.text);
    // The tower's extrusions start at the dropped anchor (inside its brim).
    let x = 0, y = 0, cur = '', minX = Infinity, minY = Infinity;
    for (const l of r.text.split('\n')) {
      const f = l.match(/^;\s*(?:TYPE|FEATURE):\s*(.*)$/); if (f) { cur = f[1].trim(); continue; }
      if (!/^G[0123] /.test(l)) continue;
      const mx = l.match(/ X(-?[\d.]+)/), my = l.match(/ Y(-?[\d.]+)/), e = l.match(/ E(-?[\d.]+)/);
      if (mx) x = +mx[1]; if (my) y = +my[1];
      // Moves that extrude in place (the change-filament G-code's `G1 E…`) aren't tower lines.
      if (/^(Prime|Wipe) tower$/i.test(cur) && e && +e[1] > 0 && (mx || my)) { minX = Math.min(minX, x); minY = Math.min(minY, y); }
    }
    record('dragged prime tower slices where it was dropped', r.status === 'done' && num(list(cfg.wipe_tower_x)[0]) === 30 && num(list(cfg.wipe_tower_y)[0]) === 150
      // Its brim (and a Type2 cone base) reach a few mm past the anchor.
      && minX <= 30 && minX > 30 - 8 && minY <= 150 && minY > 150 - 8, { status: r.status, error: r.error, cfg: [cfg.wipe_tower_x, cfg.wipe_tower_y], towerMin: [minX, minY] });
    // Saved far past the plate's right edge: desktop re-places it with the comfort margin; with an object
    // there, it goes to the clear spot nearest the saved one, keeping off the object's outline grown by
    // its brim (auto: brim_width 5) and 1 mm (PartPlate::wipe_tower_obstacles).
    await ev(() => window.__o25.addBox([40, 60, 10], [195, 40], 'blocker'));
    const moved = await ev(async () => {
      const s = await window.__o25.presets();
      const TP = await import('/slicer/src/app/towerPreview.ts');
      s.project.wipe_tower_x = ['400']; s.project.wipe_tower_y = ['50'];
      for (let i = 0; i < 120 && s.project.wipe_tower_x?.[0] === '400'; i++) await new Promise((r) => setTimeout(r, 500));
      await new Promise((r) => setTimeout(r, 1500));
      const v = TP.towerViews.value[0];
      return { x: +s.project.wipe_tower_x[0], y: +s.project.wipe_tower_y[0], w: v?.width, d: v?.depth, brim: v?.brim };
    });
    // The blocker spans x 195..235, y 40..100 (mesh origin at its corner); grown by 6 mm.
    const clear = moved.y - moved.brim >= 106 - 0.01 || moved.y + moved.d + moved.brim <= 34 + 0.01 || moved.x + moved.w + moved.brim <= 189 + 0.01;
    record('a tower saved off the plate is re-placed in free space, off the objects (estimate_wipe_tower_polygon)', clear && Math.abs(moved.x - (256 - moved.w - 15 - moved.brim)) < 0.01, moved);
    // Arrange keeps the objects off the tower.
    const arranged = await ev(async () => {
      const A = await import('/slicer/src/app/shell/arrange.ts');
      const st = await import('/slicer/src/project/store/index.ts');
      const s = await window.__o25.presets();
      await A.runArrange('all');
      await new Promise((r) => setTimeout(r, 1500));
      const tx = +s.project.wipe_tower_x[0], ty = +s.project.wipe_tower_y[0];
      return { tower: [tx, ty], boxes: st.objects.value.map((o) => { const m = st.getMesh(o.meshId); let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (let i = 0; i < m.positions.length; i += 3) { x0 = Math.min(x0, m.positions[i]); x1 = Math.max(x1, m.positions[i]); y0 = Math.min(y0, m.positions[i + 1]); y1 = Math.max(y1, m.positions[i + 1]); }
        return [o.position[0] + x0 * o.scale[0], o.position[1] + y0 * o.scale[1], o.position[0] + x1 * o.scale[0], o.position[1] + y1 * o.scale[1]]; }) };
    });
    const [tx, ty] = arranged.tower, tw = moved.w + moved.brim, td = moved.d + moved.brim;
    const hits = arranged.boxes.filter(([x0, y0, x1, y1]) => x1 > tx - moved.brim && x0 < tx + tw && y1 > ty - moved.brim && y0 < ty + td);
    record('Arrange keeps the objects off the prime tower', hits.length === 0, arranged);
  },

  async 'purge-fast'() {
    const run = async (mode) => {
      await ev(() => window.__o25.fresh('sys:BBL/Bambu Lab A2L 0.4 nozzle'));
      const modes = await ev(async (mode) => {
        const s = await window.__o25.presets();
        await s.setFilamentCount(2);
        s.setFilamentColour(0, '#FFFFFF'); s.setFilamentColour(1, '#000000');
        if (mode) s.project.prime_volume_mode = mode;
        return { offered: s.purgeModes(), mode: s.purgeMode() };
      }, mode);
      const a = await ev(() => window.__o25.addBox([20, 20, 6], [100, 128], 'a'));
      const b = await ev(() => window.__o25.addBox([20, 20, 6], [160, 128], 'b'));
      await ev(([a, b]) => Promise.all([window.__o25.override(a, 'extruder', '1'), window.__o25.override(b, 'extruder', '2')]), [a, b]);
      const r = await sliced(`purge-${mode ?? 'default'}`);
      const g = cfgOf(r.text);
      // The G-code's config block leaves prime_volume_mode out (GCode.cpp): read the job's.
      const used = [].concat(r.config.prime_volume_mode ?? 'Default')[0];
      const fl = r.report?.stats?.filamentMm ?? [];
      return { modes, used, total: fl.reduce((x, y) => x + y, 0), status: r.status, error: r.error, flush: g.flush_volumes_matrix, fast: g.flush_multiplier_fast, fe: featureE(r.text) };
    };
    const d = await run(null), f = await run('Fast');
    record('purge mode Fast changes flush volumes', d.status === 'done' && f.status === 'done' && f.used === 'Fast' && Math.abs(f.total - d.total) > 1,
      { offered: f.modes.offered, default: { mode: d.used, mm: +d.total.toFixed(1), tower: d.fe['Prime tower'] ?? d.fe['Wipe tower'] }, fast: { mode: f.used, mm: +f.total.toFixed(1), tower: f.fe['Prime tower'] ?? f.fe['Wipe tower'], multiplier: f.fast }, error: d.error ?? f.error });
  },

  // H2C: Prime saving purge mode and a Hybrid right extruder with filament_volume_map.
  async hybrid() {
    const run = async (opts) => {
      await ev(() => window.__o25.fresh('sys:BBL/Bambu Lab H2C 0.4 nozzle'));
      const st = await ev(async (opts) => {
        const s = await window.__o25.presets();
        await s.setFilamentCount(3);
        s.project.filament_map_mode = 'Manual';
        s.project.filament_map = ['1', '2', '2'];
        if (opts.hybrid) { s.setNozzleVolumeType(1, 'Hybrid'); s.project.filament_volume_map = ['0', '0', '1']; }
        // The nozzle rack, set the way the sidebar's per-type counts set it (desktop: "Set the physical nozzle count").
        for (const [type, n] of Object.entries(opts.rack ?? {})) s.setNozzleCount(1, type, n);
        if (opts.mode) s.project.prime_volume_mode = opts.mode;
        return { offered: s.purgeModes(), mode: s.purgeMode(), nozzles: s.nozzleVolumeTypes(), stats: s.nozzleStats(), extruders: s.extruders().map((e) => ({ types: e.volumeTypes, multi: e.multiNozzle })) };
      }, opts);
      const ids = [];
      for (const [i, x] of [100, 150, 200].entries()) ids.push(await ev(([x, i]) => window.__o25.addBox([15, 15, 6], [x, 250], `f${i + 1}`), [x, i]));
      for (const [i, id] of ids.entries()) await ev(([id, n]) => window.__o25.override(id, 'extruder', String(n)), [id, i + 1]);
      const r = await sliced(`h2c-${opts.hybrid ? 'hybrid' : 'std'}-${opts.mode ?? 'default'}`);
      const rv = r.status === 'done' ? await ev((c) => window.__o25.resolveVariants(c), r.config) : null;
      const g = cfgOf(r.text);
      const fl = r.report?.stats?.filamentMm ?? [];
      return { st, status: r.status, error: r.error, total: fl.reduce((x, y) => x + y, 0), rv, g, mode: [].concat(r.config.prime_volume_mode ?? 'Default')[0], volumeMap: r.config.filament_volume_map, stats: r.config.extruder_nozzle_stats, warnings: warnCodes(r) };
    };
    const d = await run({}), s = await run({ mode: 'Saving' }), h = await run({ hybrid: true });
    const hs = await run({ hybrid: true, rack: { Standard: 3, 'High Flow': 3 } });
    record('purge mode Prime saving changes flush volumes (H2C)', d.status === 'done' && s.status === 'done' && s.mode === 'Saving' && Math.abs(s.total - d.total) > 1,
      { offered: s.st.offered, default: +d.total.toFixed(1), saving: +s.total.toFixed(1), error: d.error ?? s.error });
    // Desktop's example (ENGINE-CONTRACT "Nozzle racks"): Manual 1,2,2 / volumes 0,0,1 on a Standard#3|High Flow#3 rack.
    const variants3 = hs.g.filament_extruder_variant?.split(';').map((x) => x.replace(/"/g, '')) ?? [];
    record('Hybrid extruder: filament 3 on a High Flow sub-nozzle uses the High Flow variant (with a nozzle rack)',
      hs.status === 'done' && hs.g.filament_volume_map === '0,0,1' && hs.g.filament_nozzle_map === '0,1,4' && variants3[2] === 'Direct Drive High Flow' && variants3[1] === 'Direct Drive Standard',
      { stats: hs.stats, gcodeVolumeMap: hs.g.filament_volume_map, nozzleMap: hs.g.filament_nozzle_map, gcodeVariants: variants3,
        mvs: hs.g.filament_max_volumetric_speed, resolveVariants: hs.rv?.filament.filament_extruder_variant, error: hs.error, warnings: hs.warnings });
    // Without a split the rack is desktop's seed (all Standard): there is no High Flow nozzle, so filament 3 prints on a Standard one.
    const hv = h.g.filament_extruder_variant?.split(';').map((x) => x.replace(/"/g, '')) ?? [];
    record('Hybrid extruder without a nozzle split: desktop\'s all-Standard seed, every filament on Standard (H2C)',
      h.status === 'done' && JSON.stringify(h.stats) === JSON.stringify(['Standard#1', 'Standard#6']) && hv.length === 3 && hv.every((v) => v === 'Direct Drive Standard'),
      { stats: h.stats, nozzles: h.st.nozzles, volumeMap: h.volumeMap, gcodeVolumeMap: h.g.filament_volume_map, nozzleMap: h.g.filament_nozzle_map, gcodeVariants: hv, status: h.status, error: h.error });
  },

  // IDEX / IQEX parallel modes and a belt printer (the IDEX/belt track's checks, kept here).
  async imex() { await imexCheck('sys:Vivedino/Xplorer IDEX 0.4 nozzle', [['primary', 'PRIMARY'], ['copy', 'COPY'], ['mirror', 'MIRROR']], [90, 200]); },
  async iqex() { await imexCheck('sys:Vivedino/Xplorer IQEX 0.4 nozzle', [['iq-mirror', 'MIRROR0123']], [80, 300]); },
  async belt() {
    await ev(() => window.__o25.fresh('sys:Printcepts/BabyBelt Pro 0.4 nozzle'));
    await ev(() => window.__o25.addBox([20, 15, 12], [48, 250], 'belt'));
    const r = await sliced('belt-babybelt');
    const angle = r.text.match(/^; belt_slice_rotation_angle = (.*)$/m)?.[1];
    record('belt printer (BabyBelt Pro)', r.status === 'done' && /^45(\.0)?$/.test(angle ?? '') && cfgOf(r.text).belt_printer === '1',
      { angle, layers: r.report?.stats?.layers, warnings: warnCodes(r), error: r.error });
  },

  // Belt purge prism (desktop ensure_belt_purge_tower): two filaments on a belt plate add a
  // "Belt Purge Tower" object along the far lateral edge; it slices with the parts.
  async 'belt-purge'() {
    await ev(() => window.__o25.fresh('sys:Printcepts/BabyBelt Pro 0.4 nozzle'));
    await ev(async () => { const s = await window.__o25.presets(); await s.setFilamentCount(2); s.setValue('printer', 'enable_belt_purge_tower', '1'); });
    await ev(() => window.__o25.addBox([15, 15, 12], [10, 250], 'belt-a'));
    const b = await ev(() => window.__o25.addBox([15, 15, 12], [35, 250], 'belt-b'));
    await ev(([id]) => window.__o25.override(id, 'extruder', '2'), [b]);
    const prism = await ev(async () => {
      const st = await import('/slicer/src/project/store/index.ts');
      for (let i = 0; i < 40; i++) { if (st.objects.value.some((o) => o.overrides.belt_purge_tower_object === '1')) break; await new Promise((r) => setTimeout(r, 500)); }
      const o = st.objects.value.find((x) => x.overrides.belt_purge_tower_object === '1');
      const m = o && st.getMesh(o.meshId);
      return o ? { name: o.name, position: o.position, triangles: m?.triangleCount, overrides: o.overrides } : null;
    });
    const r = await sliced('belt-purge-babybelt');
    record('belt purge prism added for two filaments and sliced (BabyBelt Pro)', !!prism && prism.name === 'Belt Purge Tower' && prism.triangles === 12
      && r.status === 'done' && r.text.length > 0,
      { prism, status: r.status, error: r.error, warnings: warnCodes(r) });
    // Back to one filament: the prism goes away.
    const gone = await ev(async () => {
      const st = await import('/slicer/src/project/store/index.ts');
      const id = st.objects.value.find((o) => o.name === 'belt-b')?.id;
      if (id) st.setObjectOverride(id, 'extruder', '1');
      for (let i = 0; i < 40; i++) { if (!st.objects.value.some((o) => o.overrides.belt_purge_tower_object === '1')) return true; await new Promise((r) => setTimeout(r, 500)); }
      return false;
    });
    record('belt purge prism removed when the plate prints one filament', gone, { gone });
  },

  // Every calibration of the Calibration menu slices; spot checks of the numbers.
  async calib() {
    const runs = [
      ['temp tower', 'sys:Custom/MyKlipper 0.4 nozzle', "C.calibTemp({ mode: 'temp_tower', start: 230, end: 190, step: 5, nozzleBasedResize: true })"],
      ['flow pass 1', 'sys:Custom/MyKlipper 0.4 nozzle', "C.calibFlowRate({ linear: false, pass: 1, pattern: 'monotonic' })"],
      ['flow pass 2', 'sys:Custom/MyKlipper 0.4 nozzle', "C.calibFlowRate({ linear: false, pass: 2, pattern: 'monotonic' })"],
      ['flow YOLO', 'sys:Custom/MyKlipper 0.4 nozzle', "C.calibFlowRate({ linear: true, pass: 1, pattern: 'archimedeanchords' })"],
      ['flow YOLO perfectionist', 'sys:Custom/MyKlipper 0.4 nozzle', "C.calibFlowRate({ linear: true, pass: 2, pattern: 'archimedeanchords' })"],
      ['PA tower', 'sys:Custom/MyKlipper 0.4 nozzle', "C.calibPA({ mode: 'pa_tower', start: 0, end: 0.1, step: 0.002, printNumbers: false, accelerations: [], speeds: [] })"],
      ['PA line', 'sys:Custom/MyKlipper 0.4 nozzle', "C.calibPA({ mode: 'pa_line', start: 0, end: 0.1, step: 0.002, printNumbers: true, accelerations: [], speeds: [] })"],
      ['PA pattern', 'sys:Custom/MyKlipper 0.4 nozzle', "C.calibPA({ mode: 'pa_pattern', start: 0, end: 0.08, step: 0.005, printNumbers: true, accelerations: [], speeds: [] })"],
      ['retraction', 'sys:Custom/MyKlipper 0.4 nozzle', "C.calibRetraction({ mode: 'retraction_tower', start: 0, end: 2, step: 0.1 })"],
      ['max flowrate', 'sys:Custom/MyKlipper 0.4 nozzle', "C.calibMaxVolSpeed({ mode: 'vol_speed_tower', start: 5, end: 20, step: 0.5 })"],
      ['VFA 0.6 mm', 'sys:Custom/MyKlipper 0.6 nozzle', "C.calibVFA({ mode: 'vfa_tower', start: 40, end: 200, step: 10, nozzleBasedResize: true, vfaLayerHeight: 0 })"],
      ['input shaping freq', 'sys:Custom/MyKlipper 0.4 nozzle', "C.calibInputShapingFreq({ mode: 'input_shaping_freq', start: 0.15, end: 0, step: 0, freqStartX: 15, freqEndX: 110, freqStartY: 15, freqEndY: 110, shaperType: 'Default', testModel: 0 })"],
      ['input shaping damp', 'sys:Custom/MyKlipper 0.4 nozzle', "C.calibInputShapingDamp({ mode: 'input_shaping_damp', start: 0, end: 0.4, step: 0, freqStartX: 30, freqStartY: 30, shaperType: 'Default', testModel: 0 })"],
      ['cornering', 'sys:Custom/MyKlipper 0.4 nozzle', "C.calibCornering({ mode: 'cornering', start: 1, end: 15, step: 0, testModel: 0 })"],
      ['tolerance test', 'sys:Custom/MyKlipper 0.4 nozzle', "C.addToleranceTest()"],
    ];
    for (const [name, printer, call] of runs) {
      await ev((p) => window.__o25.fresh(p), printer);
      const setup = await ev(async (call) => {
        const C = await import('/slicer/src/calibration/run.ts');
        const before = JSON.parse(JSON.stringify((await import('/slicer/src/app/state.ts')).resolvedConfig.value));
        // eslint-disable-next-line no-new-func
        const ok = await new Function('C', `return ${call}`)(C);
        const store = await import('/slicer/src/project/store/index.ts');
        const cal = await import('/slicer/src/calibration/state.ts');
        const objs = store.getSliceObjects ? store.getSliceObjects(0) : [];
        return { ok: ok !== false, objects: store.objects.value.length, params: cal.calibJobOptions().calib ?? null,
          objectOverrides: objs.map((o) => o.config ?? null), before: { mvs: before.filament_max_volumetric_speed, flow: before.filament_flow_ratio, maxSpeedX: before.machine_max_speed_x, maxSpeedY: before.machine_max_speed_y, maxAccel: before.machine_max_acceleration_extruding } };
      }, call);
      const r = setup.ok && setup.objects ? await sliced(`calib-${name.replace(/\W+/g, '-')}`) : { status: 'not set up', text: '', error: 'setup failed' };
      const g = cfgOf(r.text);
      const evidence = { objects: setup.objects, mode: setup.params?.mode, layers: r.report?.stats?.layers, error: r.error };
      let ok = r.status === 'done';
      if (name === 'PA tower') {
        const pa = [...r.text.matchAll(/^SET_PRESSURE_ADVANCE ADVANCE=([\d.]+)/gm)].map((m) => +m[1]);
        evidence.outerWallSpeed = g.outer_wall_speed; evidence.innerWallSpeed = g.inner_wall_speed; evidence.pa = [pa[0], pa[pa.length - 1], pa.length];
        evidence.mvs = setup.before.mvs; evidence.lineWidth = g.outer_wall_line_width; evidence.layerHeight = g.layer_height;
        ok &&= pa.length > 10 && Math.abs(Math.max(...pa) - 0.1) < 0.003;
      }
      if (name === 'VFA 0.6 mm') {
        evidence.params = setup.params; evidence.layerHeight = g.layer_height; evidence.firstLayer = g.initial_layer_print_height; evidence.objectLayerHeight = setup.objectOverrides[0]?.layer_height;
        // Outer-wall extrusion speeds (mm/s): one step per block up to the filament's volumetric limit.
        const speeds = new Set(); let f = 0, outer = false;
        for (const l of r.text.split('\n')) {
          const t = l.match(/^;\s*(?:TYPE|FEATURE):\s*(.*)$/); if (t) { outer = /^Outer wall/i.test(t[1]); continue; }
          const mf = l.match(/^G1 .*F([\d.]+)/); if (mf) f = +mf[1];
          if (outer && /^G[123] .* E[\d.]+/.test(l)) speeds.add(Math.round(f / 60));
        }
        const sp = [...speeds].sort((a, b) => a - b);
        evidence.outerSpeeds = { min: sp[0], max: sp[sp.length - 1], distinct: sp.length };
        evidence.volumetricLimit = setup.before.mvs;
        ok &&= Math.abs(Number(setup.params?.vfaLayerHeight) - 0.3) < 1e-6 && Math.abs(Number(evidence.objectLayerHeight) - 0.3) < 1e-6;
      }
      if (name.startsWith('flow')) {
        const ratios = setup.objectOverrides.map((c) => c?.print_flow_ratio).filter((v) => v !== undefined);
        evidence.flowRatios = ratios; evidence.filamentFlow = setup.before.flow;
        ok &&= ratios.length === setup.objects && new Set(ratios.map(String)).size === ratios.length;
      }
      if (name.startsWith('input shaping') || name === 'cornering') {
        const want = Math.min(Number([].concat(setup.before.maxSpeedX)[0]), Number([].concat(setup.before.maxSpeedY)[0]));
        evidence.outerWallSpeed = g.outer_wall_speed; evidence.machineMaxSpeed = want; evidence.outerAccel = g.outer_wall_acceleration; evidence.machineMaxAccel = [].concat(setup.before.maxAccel)[0];
        ok &&= list(g.outer_wall_speed).every((v) => num(v) === want) && list(g.outer_wall_acceleration).every((v) => num(v) === num(evidence.machineMaxAccel));
      }
      record(`calibration: ${name}`, ok, evidence);
    }
  },
};

// OrcaSlicer's 3MF loader (cs_tool inspect_3mf) on the staged engine, in node.
let inspector = null;
async function inspect3mf(bytes) {
  if (!inspector) {
    const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../../public/wasm/orca');
    const { default: factory } = await import(pathToFileURL(join(dir, 'slicer.mjs')).href);
    inspector = await factory({ wasmBinary: readFileSync(join(dir, 'slicer.wasm')), locateFile: (f) => join(dir, f), print: () => {}, printErr: () => {}, csProgress: () => {} });
  }
  const mod = inspector;
  const json = new TextEncoder().encode(JSON.stringify({ op: 'inspect_3mf', args: {}, meshes: [] }));
  const w = (b) => { const p = mod._malloc(Math.max(1, b.byteLength)) >>> 0; mod.HEAPU8.set(b, p); return p; };
  const jp = w(json), bp = w(bytes), outs = mod._malloc(16) >>> 0; mod.HEAPU32.fill(0, outs >>> 2, (outs >>> 2) + 4);
  mod._cs_tool(jp, json.byteLength, bp, bytes.byteLength, outs, outs + 4, outs + 8, outs + 12);
  const H = mod.HEAPU32; const pj = H[outs >>> 2], lj = H[(outs + 4) >>> 2];
  const r = JSON.parse(new TextDecoder().decode(mod.HEAPU8.slice(pj, pj + lj)));
  if (pj) mod._cs_free(pj); mod._free(jp); mod._free(bp); mod._free(outs);
  return r;
}
/** Save the current project as the app does (Orca-compatible 3MF) and hand back its bytes and zip entry names. */
async function savedProject(name) {
  const b64 = await ev(async () => {
    const { buildOrca3mf } = await import('/slicer/src/project/persistence/orca3mfWriter.ts');
    const bytes = buildOrca3mf();
    let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  });
  const bytes = new Uint8Array(Buffer.from(b64, 'base64'));
  writeFileSync(`${out}/${name}.3mf`, bytes);
  const { unzipSync } = await import('fflate');
  const files = unzipSync(bytes);
  return { bytes, files };
}

CHECKS['3mf'] = async () => {
  // A: H2C with a precise seam (with settings), mixed filaments, a Hybrid extruder + filament_volume_map, auto_drop off.
  await ev(() => window.__o25.fresh('sys:BBL/Bambu Lab H2C 0.4 nozzle'));
  await ev(async () => {
    const s = await window.__o25.presets();
    await s.setFilamentCount(3);
    s.project.filament_map_mode = 'Manual'; s.project.filament_map = ['1', '2', '2'];
    s.setNozzleVolumeType(1, 'Hybrid'); s.project.filament_volume_map = ['0', '0', '1'];
    const m = await import('/slicer/src/mixed/store.ts');
    m.addMixedFilament({ components: [1, 2], ratios: [30, 70], gradient: false, direction: 'ab', curve: [], perPart: false });
    m.addMixedFilament({ components: [2, 3], ratios: [50, 50], gradient: true, direction: 'ba', curve: [], perPart: true });
  });
  const id = await ev(() => window.__o25.addBox([20, 20, 10], [160, 160], 'seamed'));
  await ev(async (id) => {
    const store = await import('/slicer/src/project/store/index.ts');
    const o = store.getObject(id); const bb = store.objectLocalBBox(o);
    const m = window.__o25.box(4, 4, 14);
    const pid = store.addPart(id, 'modifier', 'Seam', m.positions, m.indices, [bb.max[0] - 2, 8, -2], 'precise_seam_center');
    // Dormant seam settings (desktop keeps them when a modifier becomes a seam).
    store.mutate('seam settings', () => { const p = store.getObject(id).parts.find((x) => x.id === pid); p.preciseSeam = Object.freeze({ type: 'precise_seam_left', config: Object.freeze({ wall_loops: '4' }) }); });
  }, id);
  const a = await savedProject('features-h2c');
  const ra = await inspect3mf(a.bytes);
  const cfg = ra.result?.config ?? {};
  const vols = ra.result?.objects?.[0]?.volumes ?? [];
  const seam = vols.find((v) => v.type?.startsWith('precise_seam'));
  record('3MF: precise seam comes back as a seam with its settings', !!ra.ok && seam?.type === 'precise_seam_left' && seam?.config?.wall_loops === '4',
    { ok: ra.ok, error: ra.error, vols: vols.map((v) => [v.name, v.type, v.config]) });
  record('3MF: mixed filaments in project_settings', cfg.filament_is_mixed?.replace(/\s/g, '') === '0,0,0,1,1' && /1,2/.test(cfg.filament_mixed_components ?? ''),
    { is_mixed: cfg.filament_is_mixed, components: cfg.filament_mixed_components, ratios: cfg.filament_mixed_sublayer_ratios, gradient: cfg.filament_mixed_gradient, perPart: cfg.filament_mixed_gradient_per_part, colours: cfg.filament_colour });
  record('3MF: Hybrid nozzle + filament volume map', /Hybrid/.test(cfg.nozzle_volume_type ?? '') && (cfg.filament_volume_map ?? '').replace(/\s/g, '').startsWith('0,0,1'),
    { nozzle_volume_type: cfg.nozzle_volume_type, filament_volume_map: cfg.filament_volume_map, filament_map: cfg.filament_map, plates: ra.result?.plates?.map((p) => p.config) });
  const pv = cfg.print_extruder_variant ?? '', ov = (cfg.outer_wall_speed ?? '').split(',');
  const prv = cfg.printer_extruder_variant ?? '', mx = (cfg.machine_max_speed_x ?? '').split(',');
  const nPrint = pv.split(';').length, nPrinter = prv.split(';').length;
  record('3MF: per-variant vectors at full width', nPrint > 2 && ov.length === nPrint && mx.length === 2 * nPrinter,
    { print_extruder_variant: pv, outer_wall_speed: cfg.outer_wall_speed, printer_extruder_variant: prv, machine_max_speed_x: cfg.machine_max_speed_x, substitutions: ra.result?.substitutions });

  // B: IDEX plate mode.
  await ev(() => window.__o25.fresh('sys:Vivedino/Xplorer IDEX 0.4 nozzle'));
  const bid = await ev(() => window.__o25.addBox([30, 15, 12], [90, 200], 'idex'));
  await ev(async () => (await import('/slicer/src/plates/store.ts')).setPlateImexMode(0, 'mirror'), bid);
  const b = await savedProject('features-idex');
  const rb = await inspect3mf(b.bytes);
  record('3MF: plate IDEX mode', !!rb.ok && rb.result?.plates?.[0]?.config?.imex_parallel_mode === 'mirror', { ok: rb.ok, error: rb.error, plates: rb.result?.plates?.map((p) => p.config) });

  // C: a desktop 2.5 project (texture layers, Metadata/orca_cad.bin, auto_drop, …) opened and saved again.
  const fx = await ev(async () => {
    const { orca25Project3mf } = await import('/slicer/src/project/import/__fixtures__/orca25.ts');
    const { openOrcaProject } = await import('/slicer/src/project/orcaOpen.ts');
    const bytes = orca25Project3mf();
    const r = await openOrcaProject('orca25.3mf', bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    return { objects: r.objects, warnings: r.warnings };
  });
  const c = await savedProject('features-desktop-roundtrip');
  const rc = await inspect3mf(c.bytes);
  const names = Object.keys(c.files);
  const model = new TextDecoder().decode(c.files['Metadata/model_settings.config'] ?? new Uint8Array());
  const root = new TextDecoder().decode(Object.entries(c.files).find(([k]) => /3D\/3dmodel\.model$/.test(k))?.[1] ?? new Uint8Array());
  const objModel = new TextDecoder().decode(Object.entries(c.files).find(([k]) => /3D\/Objects\/.*\.model$/.test(k))?.[1] ?? new Uint8Array());
  record('3MF: desktop 2.5 project round trip loads in Orca', !!rc.ok, { ok: rc.ok, error: rc.error, opened: fx, objects: rc.result?.objects?.length, substitutions: rc.result?.substitutions });
  // Through Orca's own loader (inspect_3mf: volume textureDisplacement, cadRecipe, object autoDrop), file level as evidence.
  const objs = rc.result?.objects ?? [];
  const tex = objs.flatMap((o) => o.volumes).map((v) => v.textureDisplacement).filter(Boolean);
  const src = fx.objects; // what the desktop fixture holds
  record('3MF: Metadata/orca_cad.bin kept (Orca loader: cadRecipe)', rc.result?.cadRecipe?.present === true && rc.result.cadRecipe.bytes > 0 && names.includes('Metadata/orca_cad.bin'),
    { cadRecipe: rc.result?.cadRecipe, entries: names.filter((n) => n.startsWith('Metadata/')) });
  record('3MF: texture layers kept (Orca loader: textureDisplacement)', tex.length > 0 && tex.every((t) => t.layers && t.images?.length && t.images.every((i) => i.imageBytes > 0)) && tex.some((t) => t.images.some((i) => i.painted)),
    { volumes: tex.map((t) => ({ layers: typeof t.layers === 'string' ? t.layers.slice(0, 120) : t.layers, images: t.images })), files: names.filter((n) => n.includes('texture')), triangleAttr: /paint_texture_0/.test(objModel) });
  record('3MF: auto_drop kept (Orca loader: autoDrop)', objs.some((o) => o.autoDrop === false),
    { autoDrop: objs.map((o) => [o.name, o.autoDrop]), opened: src, inModelSettings: /auto_drop="0"/.test(model) });

  // D: a real desktop file's <assemble> section (Bambu Studio 2.0, cut / arranged: assembled ≠ placed) comes back byte for byte.
  const { unzipSync, zipSync, strToU8 } = await import('fflate');
  const fixtureBytes = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../src/project/import/__fixtures__/bambu-studio-2.0-pa-line-dual.3mf'));
  const openBytes = (bytes, name) => ev(async ([b64, name]) => {
    const { openOrcaProject } = await import('/slicer/src/project/orcaOpen.ts');
    const store = await import('/slicer/src/project/store/index.ts');
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const r = await openOrcaProject(name, bin.buffer);
    return { warnings: r.warnings, objects: store.objects.value.map((o) => ({ name: o.name, extruder: o.overrides.extruder, assembled: !!o.assembly, ranges: o.layerRanges?.map((x) => [x.overrides, x.passthrough]) })) };
  }, [Buffer.from(bytes).toString('base64'), name]);
  const ITEM = /<assemble_item object_id="(\d+)" instance_id="(\d+)" transform="([^"]*)" offset="([^"]*)" \/>/g;
  const asmItems = (files) => [...new TextDecoder().decode(files['Metadata/model_settings.config']).matchAll(ITEM)].map((m) => [m[3], m[4]]);
  const order = (files) => [...new TextDecoder().decode(files['3D/3dmodel.model']).matchAll(/<item objectid="(\d+)"/g)].map((m) => m[1]);
  const od = await openBytes(fixtureBytes, 'pa-line.3mf');
  const d = await savedProject('assemble-roundtrip');
  const rd = await inspect3mf(d.bytes);
  const srcFiles = unzipSync(new Uint8Array(fixtureBytes));
  const byId = (files) => { const ids = [...new TextDecoder().decode(files['Metadata/model_settings.config']).matchAll(ITEM)].map((m) => m[1]); const it = asmItems(files); return Object.fromEntries(ids.map((id, i) => [id, it[i]])); };
  const want = order(srcFiles).map((id) => byId(srcFiles)[id]), got = order(d.files).map((id) => byId(d.files)[id]);
  record('3MF: <assemble> of a desktop file written back byte for byte; Orca loads it', !!rd.ok && want.length === 8 && JSON.stringify(want) === JSON.stringify(got),
    { ok: rd.ok, error: rd.error, want: want.slice(0, 2), got: got.slice(0, 2), assembledInApp: od.objects.filter((o) => o.assembled).length, assembleFromLoader: rd.result?.objects?.[0]?.instances?.[0] });

  // E: a height range with a setting the engine doesn't know: kept (not sliced) and written back; Orca still loads the file.
  const { orca25Bytes } = await ev(async () => {
    const { orca25Project3mf } = await import('/slicer/src/project/import/__fixtures__/orca25.ts');
    const b = orca25Project3mf(); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return { orca25Bytes: btoa(s) };
  });
  const ez = unzipSync(new Uint8Array(Buffer.from(orca25Bytes, 'base64')));
  ez['Metadata/layer_config_ranges.xml'] = strToU8('<?xml version="1.0" encoding="utf-8"?>\n<objects>\n <object id="1">\n  <range min_z="2" max_z="6">\n'
    + '   <option opt_key="layer_height">0.1</option>\n   <option opt_key="future_range_key">7</option>\n  </range>\n </object>\n</objects>\n');
  const oe = await openBytes(zipSync(ez), 'ranges.3mf');
  const e = await savedProject('range-passthrough');
  const re = await inspect3mf(e.bytes);
  const rangesXml = new TextDecoder().decode(e.files['Metadata/layer_config_ranges.xml'] ?? new Uint8Array());
  const er = oe.objects.find((o) => o.ranges)?.ranges?.[0];
  record('3MF: height-range keys the engine doesn\'t know stay with the range and are written back', !!re.ok && /future_range_key">7</.test(rangesXml)
    && !!er && !('future_range_key' in er[0]) && JSON.stringify(er[1]) === '[["future_range_key","7"]]',
    { ok: re.ok, error: re.error, range: er, rangesXml });

  // F: a published 3MF onto a P1S with 2 filaments: PETG type requirement on slot 1, a mix authored on slot 2 → moved to slot 3, the model follows.
  await ev(() => window.__o25.fresh('sys:BBL/Bambu Lab P1S 0.4 nozzle'));
  await ev(async () => { const s = await window.__o25.presets(); await s.setFilamentCount(2); });
  const esc = (v) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const pubMeta = {
    orca_published: '1',
    orca_published_keys: JSON.stringify(['wall_loops']),
    orca_published_material_keys: JSON.stringify([
      { slot: 0, keys: ['nozzle_temperature'], publish_type: true, type: 'PETG', material: { filament_type: 'PETG', filament_vendor: 'Generic' } },
      { slot: 1, keys: ['filament_is_mixed', 'filament_mixed_components', 'filament_mixed_sublayer_ratios'] },
    ]),
    orca_published_config: 'wall_loops = 5\nfilament_colour = "#FF0000";"#00FF00";"#0000FF"\nnozzle_temperature = 245,250,250\nfilament_type = "PETG";"PLA";"PLA"\n'
      + 'filament_is_mixed = 0,1,0\nfilament_mixed_components = "";"1,2";""\nfilament_mixed_sublayer_ratios = "";"0.5000,0.5000";""\n',
  };
  const pz = unzipSync(new Uint8Array(fixtureBytes));
  const keep = {};
  for (const [k, v] of Object.entries(pz)) if (/^(3D\/|\[Content_Types\]|_rels\/)/.test(k)) keep[k] = v;
  let pubRoot = new TextDecoder().decode(keep['3D/3dmodel.model']).replace(/ <metadata name="(Application|BambuStudio:3mfVersion|OrcaSlicer)">[^<]*<\/metadata>\n/g, '');
  pubRoot = pubRoot.replace(/(<model[^>]*>\n)/, (m) => `${m}${Object.entries(pubMeta).map(([k, v]) => ` <metadata name="${k}">${esc(v)}</metadata>\n`).join('')}`);
  keep['3D/3dmodel.model'] = strToU8(pubRoot);
  // The file's objects on filament 2 (the author's mix slot) must end up on slot 3.
  keep['Metadata/model_settings.config'] = pz['Metadata/model_settings.config'];
  const op = await openBytes(zipSync(keep), 'published.3mf');
  const pub = await ev(async () => {
    const s = await window.__o25.presets();
    return { filaments: s.infos.value.filaments.map((f) => [f.name, f.filamentType]), mixed: s.mixedDefs(), temp: s.value('filament', 'nozzle_temperature', 0), wall: s.value('process', 'wall_loops') };
  });
  // The fixture's objects are pressure-advance lines 0.4 mm wide and 0.2 mm tall laid out for a larger dual-nozzle bed:
  // with the P1S's own line widths their first layer is empty (desktop refuses them too). Thicken them (×5 in Y / Z) and
  // arrange onto the P1S before slicing (geometry and placement aren't under test).
  await ev(async () => {
    const st = await import('/slicer/src/project/store/index.ts');
    st.setTransforms(st.objects.value.map((o) => ({ id: o.id, position: o.position, rotation: o.rotation, scale: [o.scale[0], o.scale[1] * 5, o.scale[2] * 5] })), 'Scale');
    const A = await import('/slicer/src/app/shell/arrange.ts'); await A.runArrange('all'); await new Promise((r) => setTimeout(r, 1500));
  });
  const pubSlice = await ev(() => window.__o25.slice());
  record('published 3MF: type gate picks a PETG, the mix lands at the tail, the model follows, it slices', /PETG/.test(pub.filaments[0]?.[1] ?? '')
    && JSON.stringify(pub.temp) === '["245"]' && pub.wall === '5' && pub.mixed.length === 1 && pub.mixed[0].components.join() === '1,2'
    && op.objects.some((o) => o.extruder === '3') && pubSlice.status === 'done',
    { pub, extruders: op.objects.map((o) => o.extruder), warnings: op.warnings, slice: pubSlice.status, error: pubSlice.error, report: pubSlice.status === 'done' ? undefined : pubSlice.report });
};

// A project's flushing volumes survive save → open (desktop keeps the saved matrix; no auto-recalculation on load).
CHECKS['flush-roundtrip'] = async () => {
  await ev(() => window.__o25.fresh('sys:BBL/Bambu Lab P1S 0.4 nozzle'));
  await ev(async () => {
    const s = await window.__o25.presets();
    await s.setFilamentCount(2);
    s.setFilamentColour(0, '#FFFFFF'); s.setFilamentColour(1, '#000000');
  });
  const a = await ev(() => window.__o25.addBox([20, 20, 6], [100, 128], 'white'));
  const b = await ev(() => window.__o25.addBox([20, 20, 6], [160, 128], 'black'));
  await ev(([a, b]) => Promise.all([window.__o25.override(a, 'extruder', '1'), window.__o25.override(b, 'extruder', '2')]), [a, b]);
  await ev(async () => { const s = await window.__o25.presets(); await new Promise((r) => setTimeout(r, 1500)); s.project.flush_volumes_matrix = ['0', '555', '111', '0']; s.project.flush_multiplier = ['1.5']; });
  const before = await sliced('flush-before-save');
  const saved = await savedProject('flush-roundtrip');
  await ev(() => window.__o25.fresh('sys:Custom/MyKlipper 0.4 nozzle'));
  const opened = await ev(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const { openOrcaProject } = await import('/slicer/src/project/orcaOpen.ts');
    const r = await openOrcaProject('flush-roundtrip.3mf', bytes.buffer);
    await new Promise((res) => setTimeout(res, 3000)); // let the auto-flush watcher run
    const s = await window.__o25.presets();
    return { objects: r.objects, warnings: r.warnings, printer: s.selectedInfo('printer').name, matrix: s.project.flush_volumes_matrix, multiplier: s.project.flush_multiplier };
  }, Buffer.from(saved.bytes).toString('base64'));
  const after = await sliced('flush-after-open');
  const tower = (t) => { const f = featureE(t); return f['Prime tower'] ?? f['Wipe tower'] ?? 0; };
  const gm = (t) => cfgOf(t).flush_volumes_matrix;
  record('flushing volumes survive save → open → slice', after.status === 'done' && [].concat(opened.matrix ?? []).join() === '0,555,111,0'
    && gm(after.text) === gm(before.text) && Math.abs(tower(after.text) - tower(before.text)) < 1,
    { opened, gcodeMatrix: [gm(before.text), gm(after.text)], towerE: [tower(before.text), tower(after.text)], used: [before.report?.stats?.filamentMm, after.report?.stats?.filamentMm], error: after.error });
};

async function imexCheck(printer, modes, t0At) {
  for (const [mode, marker] of modes) {
    await ev((p) => window.__o25.fresh(p), printer);
    const id = await ev(() => window.__o25.addBox([30, 15, 12], null, 'part'));
    await ev(async ([mode, id, at]) => {
      (await import('/slicer/src/plates/store.ts')).setPlateImexMode(0, mode);
      const store = await import('/slicer/src/project/store/index.ts');
      const o = store.getObject(id);
      store.setTransforms([{ id, position: [at[0], at[1], o.position[2]], rotation: o.rotation, scale: o.scale }], 'Move');
    }, [mode, id, t0At]);
    const r = await sliced(`imex-${mode}`);
    const got = r.text.match(/^SET_PRINT_MODE MODE=(\w+)/m)?.[1];
    // The job's flush matrix is filaments² × nozzles (copy / mirror once failed with none in the project).
    const nf = [].concat(r.config.filament_colour ?? []).length, nz = [].concat(r.config.nozzle_diameter ?? []).length;
    const flush = [].concat(r.config.flush_volumes_matrix ?? []).length;
    record(`${printer.split('/').pop()} ${mode}`, r.status === 'done' && got === marker && flush === nf * nf * nz,
      { marker: got, want: marker, flush, filaments: nf, nozzles: nz, error: r.error });
  }
}

for (const name of only) {
  if (!CHECKS[name]) { console.log(`unknown check ${name}`); continue; }
  lap(`---- ${name}`);
  try { await CHECKS[name](); } catch (e) { record(name, false, `threw: ${e.message.split('\n')[0]}`); }
}

writeFileSync(`${out}/results${threads === '1' ? '-st' : ''}.json`, JSON.stringify({ engine, threads: threads || 'auto', results, problems }, null, 1));
await browser.close();
const failed = results.filter((r) => !r.ok && !r.known);
const known = results.filter((r) => !r.ok && r.known);
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed${known.length ? `, ${known.length} known` : ''}${problems.length ? `, ${problems.length} console errors` : ''}`);
for (const f of failed) console.log(`  FAIL ${f.check}`);
for (const f of known) console.log(`  KNOWN ${f.check} (${f.known})`);
process.exit(failed.length || problems.length ? 1 : 0);
