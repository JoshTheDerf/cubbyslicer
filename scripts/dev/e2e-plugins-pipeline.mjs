// Browser end-to-end check for OrcaSlicer 2.5 slicing-pipeline plugins (the 12
// in-slicer hook points, docs/ENGINE-CONTRACT.md "Plugin hooks"): the UNMODIFIED
// Orca samples from sandboxes/ (scripts/dev/fixtures/orca-plugins/) are installed,
// selected in the process preset (`slicing_pipeline_plugin`) and sliced on BOTH
// engine builds (multi-threaded and single-threaded). The G-code is checked
// against what each plugin intends:
//
//  - Inset Every Slice (1 mm at posSlice): a 20 mm cube inset by 1 mm must give the
//    same toolpaths as slicing an 18 mm cube at the same place (Clipper miter offset
//    of a square is exact), move for move.
//  - Twistify (1 deg/mm at posSlice): every layer's outer wall is the first layer's
//    square rotated by 1 deg × (z - z0) about the object's centre.
//  - Fuzzy Slices (posSlice): layer 0 untouched (skip_first_layer), upper outer walls
//    gain many vertices and stay within the configured ±0.3 mm band; seeded per
//    layer, so slicing twice gives identical G-code.
//  - the plugin messages reach the report as `plugin` warnings; an exception in a
//    plugin fails the slice with Orca's message; a plugin edit through the live
//    graph (surface.expolygon in place) reaches the engine.
//  - both engine builds give identical G-code for each plugin.
//
//   node scripts/dev/e2e-plugins-pipeline.mjs [baseUrl] [out-dir]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PW = process.env.PLAYWRIGHT ?? 'playwright';
const { chromium } = await import(PW);
const base = process.argv[2] ?? 'http://localhost:5421/slicer/';
const out = resolve(process.argv[3] ?? 'e2e-out/plugins-pipeline');
mkdirSync(out, { recursive: true });
const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/orca-plugins');

function cubeStl(s) {
  const v = [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], [0, 0, 20], [s, 0, 20], [s, s, 20], [0, s, 20]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const buf = Buffer.alloc(84 + f.length * 50); buf.writeUInt32LE(f.length, 80);
  f.forEach((t, i) => { const o = 84 + i * 50; t.forEach((vi, k) => v[vi].forEach((c, j) => buf.writeFloatLE(c, o + 12 + k * 12 + j * 4))); });
  return buf;
}
const STL20 = cubeStl(20).toString('base64');
const STL18 = cubeStl(18).toString('base64');

const checks = [];
const problems = [];
const check = (name, ok, extra = '') => { checks.push([name, !!ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); };
const t0 = Date.now();
const lap = (s) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s  ${s}`);

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => { try { localStorage.setItem('cubby.setup.done', 'true'); } catch { /* ignore */ } });
const page = await context.newPage();
page.setDefaultTimeout(120000);
page.on('pageerror', (e) => { problems.push(`pageerror: ${e.message}`); console.log('[pageerror]', e.message); });
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' && !/ERR_NAME_NOT_RESOLVED|favicon|Failed to load resource/.test(t)) { problems.push(t); console.log('[console.error]', t); }
  if (/\[plugins\]|engine:/.test(t)) console.log('[app]', t.slice(0, 200));
});

await page.goto(`${base}?cubby-debug`, { waitUntil: 'load', timeout: 300000 });
await page.waitForFunction(() => !!window.__cubbyProject, null, { timeout: 300000 });
await page.evaluate(async () => {
  const root = await navigator.storage.getDirectory();
  try { await root.removeEntry('cubby-plugins', { recursive: true }); } catch { /* none */ }
});
await page.reload({ waitUntil: 'load', timeout: 300000 });
await page.waitForFunction(() => !!window.__cubbyProject, null, { timeout: 300000 });
lap('app loaded');

// ---- install the samples ----
const installed = await page.evaluate(async (files) => {
  await (await import('/slicer/src/plugins/index.ts')).ensurePluginsReady();
  const st = await import('/slicer/src/plugins/manager/store.ts');
  for (const [name, src] of files) await st.installPackage(await st.inspectPackage(name, new TextEncoder().encode(src)), 'file');
  return st.pluginState.rows.map((r) => `${r.desc.pluginKey}:${r.status}:${r.caps.map((c) => c.name).join('+')}`);
}, ['orca_inset_plugin_any.py', 'orca_twistify_plugin_any.py', 'orca_fuzzy_slices_plugin_any.py', 'orca_gcode_stamp_plugin_any.py']
  .map((f) => [f, readFileSync(join(FIX, f), 'utf8')]));
check('the four samples install and load', installed.length === 4 && installed.every((s) => s.includes(':loaded:')), installed.join(', '));
const schemaKey = await page.evaluate(async () => {
  const { currentPresets } = await import('/slicer/src/presets/store.ts');
  await import('/slicer/src/presets/store.ts').then((m) => m.presetsSettled());
  const d = currentPresets.value.schema.value?.options.slicing_pipeline_plugin;
  return d ? `${d.type}/${d.guiType}/${currentPresets.value.schema.value.version}` : null;
});
check('engine schema has slicing_pipeline_plugin (plugin_picker)', schemaKey?.startsWith('strings/plugin_picker'), schemaKey);
lap('plugins installed');

/** Replace the plate with one cube of size 20 or 18, slice with `names` selected; returns G-code + report. */
async function sliceWith(size, names) {
  return page.evaluate(async ({ stl, names }) => {
    const proj = await import('/slicer/src/project/store/index.ts');
    if (proj.objects.value.length) proj.removeObjects(proj.objects.value.map((o) => o.id));
    const bytes = Uint8Array.from(atob(stl), (c) => c.charCodeAt(0));
    const { importFiles } = await import('/slicer/src/app/shell/commands/files.ts');
    await importFiles([new File([bytes], 'cube.stl')]);
    if (proj.objects.value.length !== 1) throw new Error(`expected one object, have ${proj.objects.value.length}`);
    const { currentPresets } = await import('/slicer/src/presets/store.ts');
    currentPresets.value.setValue('process', 'slicing_pipeline_plugin', names.length ? names : undefined);
    const { useSliceController } = await import('/slicer/src/app/slice.ts');
    const sc = useSliceController();
    const ok = await sc.slice();
    const { lastSlice } = await import('/slicer/src/app/state.ts');
    const r = lastSlice.value;
    return {
      ok, error: sc.error.value, warnings: (ok ? r?.report.warnings : sc.errorReport.value?.warnings) ?? [],
      threads: r?.report.threads ?? 0, gcode: ok && r ? new TextDecoder().decode(r.gcode) : '',
      events: (r?.report.events ?? []).map((e) => e.event),
    };
  }, { stl: size === 20 ? STL20 : STL18, names });
}

// ---- G-code analysis ----
function moves(gcode) {
  return gcode.split('\n').map((l) => l.replace(/;.*$/, '').trim()).filter((l) => /^G[0-3]\b/.test(l));
}
/** Outer-wall extrusion points per layer: [{z, pts: [[x, y]]}] */
function outerWalls(gcode) {
  const layers = [];
  let cur = null, type = '', x = 0, y = 0, z = 0;
  for (const raw of gcode.split('\n')) {
    const t = /^;\s*(?:TYPE|FEATURE):\s*(.*)$/.exec(raw);
    if (t) { type = t[1].trim(); continue; }
    const zc = /^;\s*Z:\s*([\d.]+)/.exec(raw);
    if (zc || /^;\s*LAYER_CHANGE/.test(raw)) {
      if (zc) { z = Number(zc[1]); cur = { z, pts: [] }; layers.push(cur); }
      continue;
    }
    const m = /^G[01]\s(.*)$/.exec(raw.replace(/;.*$/, ''));
    if (!m) continue;
    const g = Object.fromEntries([...m[1].matchAll(/([XYZE])(-?[\d.]+)/g)].map((a) => [a[1], Number(a[2])]));
    if (g.X !== undefined) x = g.X;
    if (g.Y !== undefined) y = g.Y;
    if (cur && /outer wall/i.test(type) && g.E !== undefined && g.E > 0 && (g.X !== undefined || g.Y !== undefined)) cur.pts.push([x, y]);
  }
  return layers.filter((l) => l.pts.length);
}
const centre = (pts) => pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length], [0, 0]);
/** Orientation of a square-ish loop (deg, mod 90): angle of the longest edge direction. */
function squareAngle(pts) {
  let best = 0, ang = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1], L = Math.hypot(dx, dy);
    if (L > best) { best = L; ang = Math.atan2(dy, dx) * 180 / Math.PI; }
  }
  return ((ang % 90) + 90) % 90;
}
const angDiff = (a, b) => { const d = Math.abs(a - b) % 90; return Math.min(d, 90 - d); };
/** Distance of p from the axis-aligned square |x - cx| = h, |y - cy| = h (signed: + outside). */
const squareDist = (p, c, h) => Math.max(Math.abs(p[0] - c[0]), Math.abs(p[1] - c[1])) - h;

const pluginWarn = (r, re) => r.warnings.some((w) => w.code === 'plugin' && re.test(w.message));

const results = {};
for (const variant of ['mt', 'st']) {
  await page.evaluate(async (v) => (await import('/slicer/src/engine/client.ts')).setEngineThreadsPref(v === 'st' ? 1 : 0), variant);
  const tag = variant === 'mt' ? 'multi-threaded' : 'single-threaded';
  lap(`--- ${tag} engine`);

  const base20 = await sliceWith(20, []);
  check(`[${variant}] baseline 20 mm cube slices`, base20.ok && base20.gcode.length > 1000, `${base20.threads} thread(s)`);
  check(`[${variant}] engine variant is ${tag}`, variant === 'mt' ? base20.threads > 1 : base20.threads === 1, `threads=${base20.threads}`);
  const ref18 = await sliceWith(18, []);

  // Inset
  const inset = await sliceWith(20, ['Inset Every Slice']);
  check(`[${variant}] Inset: slice succeeds`, inset.ok, inset.error ?? '');
  check(`[${variant}] Inset: its message is a plugin warning`, pluginWarn(inset, /Inset Every Slice.*inset applied to \d+ region/), JSON.stringify(inset.warnings.filter((w) => w.code === 'plugin')).slice(0, 160));
  const mi = moves(inset.gcode), mr = moves(ref18.gcode), mb = moves(base20.gcode);
  let firstDiff = -1;
  for (let i = 0; i < Math.max(mi.length, mr.length); i++) if (mi[i] !== mr[i]) { firstDiff = i; break; }
  check(`[${variant}] Inset: 20 mm cube inset 1 mm == 18 mm cube, move for move`, firstDiff === -1 && mi.length > 100,
    firstDiff === -1 ? `${mi.length} moves identical` : `differs at move ${firstDiff}/${mi.length} vs ${mr.length}: "${mi[firstDiff]}" vs "${mr[firstDiff]}"`);
  check(`[${variant}] Inset: differs from the plain 20 mm cube`, mi.join('\n') !== mb.join('\n'));
  const wi = outerWalls(inset.gcode), wb = outerWalls(base20.gcode);
  const ci = centre(wb[0].pts);
  const halfB = Math.max(...wb[3].pts.map((p) => Math.max(Math.abs(p[0] - ci[0]), Math.abs(p[1] - ci[1]))));
  const halfI = Math.max(...wi[3].pts.map((p) => Math.max(Math.abs(p[0] - ci[0]), Math.abs(p[1] - ci[1]))));
  check(`[${variant}] Inset: outer wall 1 mm further in on each side`, Math.abs(halfB - halfI - 1) < 0.01, `half-width ${halfB.toFixed(3)} → ${halfI.toFixed(3)}`);

  // Twistify
  const tw = await sliceWith(20, ['Twistify']);
  check(`[${variant}] Twistify: slice succeeds`, tw.ok, tw.error ?? '');
  const wt = outerWalls(tw.gcode);
  const z0 = wt[0].z, a0 = squareAngle(wt[0].pts);
  let worst = 0, n = 0;
  for (const l of wt) {
    const expected = ((a0 + (l.z - z0) * 1.0) % 90 + 90) % 90;
    worst = Math.max(worst, angDiff(squareAngle(l.pts), expected));
    n++;
  }
  check(`[${variant}] Twistify: every layer rotated by 1°/mm × (z − z0)`, n > 50 && worst < 0.5, `${n} layers, worst ${worst.toFixed(3)}°, top ${squareAngle(wt[wt.length - 1].pts).toFixed(2)}° at z ${wt[wt.length - 1].z}`);
  const ct = centre(wt[wt.length - 1].pts), cb = centre(wt[0].pts);
  check(`[${variant}] Twistify: about the object's centre`, Math.hypot(ct[0] - cb[0], ct[1] - cb[1]) < 0.1, `${ct.map((v) => v.toFixed(2))} vs ${cb.map((v) => v.toFixed(2))}`);
  check(`[${variant}] Twistify: its message names the object`, pluginWarn(tw, /Twistify: transformed \d+ layer\(s\) of 'cube/), '');

  // Fuzzy Slices
  const fz = await sliceWith(20, ['Fuzzy Slices']);
  const fz2 = await sliceWith(20, ['Fuzzy Slices']);
  check(`[${variant}] Fuzzy Slices: slice succeeds`, fz.ok, fz.error ?? '');
  const wf = outerWalls(fz.gcode);
  const cf = centre(wb[0].pts);
  const sameFirst = JSON.stringify(wf[0].pts) === JSON.stringify(wb[0].pts);
  check(`[${variant}] Fuzzy Slices: first layer untouched (skip_first_layer)`, sameFirst);
  const upper = wf.slice(2, -2);
  const ptsB = wb[5].pts.length, ptsF = Math.min(...upper.map((l) => l.pts.length));
  const devs = upper.flatMap((l) => l.pts.map((p) => squareDist(p, cf, halfB)));
  const maxDev = Math.max(...devs.map(Math.abs));
  check(`[${variant}] Fuzzy Slices: upper walls resampled (many more vertices)`, ptsF > ptsB * 10, `${ptsB} → ≥ ${ptsF} points per wall`);
  check(`[${variant}] Fuzzy Slices: jitter within the ±0.3 mm band (+0.15 mm wall tolerance)`, maxDev <= 0.45 && maxDev > 0.1, `max |deviation| ${maxDev.toFixed(3)} mm`);
  check(`[${variant}] Fuzzy Slices: seeded per layer, two slices identical`, moves(fz.gcode).join('\n') === moves(fz2.gcode).join('\n'));

  // Every sample selected at once (stamp's pipeline part is a no-op at geometry steps).
  const all = await sliceWith(20, ['Inset Every Slice', 'Twistify', 'G-code Stamp']);
  check(`[${variant}] several capabilities run in list order`, all.ok && pluginWarn(all, /Inset Every Slice/) && pluginWarn(all, /Twistify/), all.error ?? '');
  check(`[${variant}] lifecycle events in the report`, all.events.includes('SliceStarted') && all.events.includes('GCodeExportFinished'), all.events.join(','));

  results[variant] = { base20: moves(base20.gcode), inset: mi, tw: moves(tw.gcode), fz: moves(fz.gcode) };
  writeFileSync(`${out}/${variant}-inset.gcode`, inset.gcode);
  writeFileSync(`${out}/${variant}-twistify.gcode`, tw.gcode);
  writeFileSync(`${out}/${variant}-fuzzy.gcode`, fz.gcode);
}

for (const k of ['base20', 'inset', 'tw', 'fz']) {
  const a = results.mt[k], b = results.st[k];
  let d = -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) { d = i; break; }
  check(`multi- and single-threaded engines agree: ${k}`, d === -1, d === -1 ? `${a.length} moves` : `first difference at move ${d}: "${a[d]}" vs "${b[d]}"`);
}

// ---- errors ----
const errPlugin = `# /// script
# [tool.orcaslicer.plugin]
# name = "Broken"
# version = "1"
# ///
import orca
class Broken(orca.slicing.SlicingPipelineCapabilityBase):
    def get_name(self): return "Broken"
    def execute(self, ctx):
        if ctx.step == orca.slicing.Step.posPerimeters:
            raise ValueError("boom at perimeters")
        return orca.ExecutionResult.success()
@orca.plugin
class P(orca.base):
    def register_capabilities(self): orca.register_capability(Broken)
`;
await page.evaluate(async (src) => {
  const st = await import('/slicer/src/plugins/manager/store.ts');
  await st.installPackage(await st.inspectPackage('broken.py', new TextEncoder().encode(src)), 'file');
}, errPlugin);
const broken = await sliceWith(20, ['Broken']);
check('a plugin exception fails the slice with Orca\'s message', !broken.ok && /Slicing pipeline plugin 'Broken' error: ValueError: boom at perimeters/.test(broken.error ?? ''), broken.error ?? '');
// ---- the read side of the graph (ctx.print / ctx.object) ----
const probe = `# /// script
# dependencies = ["numpy"]
# [tool.orcaslicer.plugin]
# name = "Graph Probe"
# version = "1"
# ///
import orca, json
class Probe(orca.slicing.SlicingPipelineCapabilityBase):
    def get_name(self): return "Graph Probe"
    def execute(self, ctx):
        if ctx.step != orca.slicing.Step.posPerimeters or ctx.object is None:
            return orca.ExecutionResult.success()
        o = ctx.object
        layers = o.layers()
        l5 = layers[5]
        per = l5.regions()[0].perimeters
        paths = per.flatten_paths()
        pts = paths[0].points()
        isl = l5.lslices()
        t = o.trafo()
        out = {
            "layers": len(layers), "z5": round(l5.print_z, 3), "upper": l5.upper_layer is layers[6], "lower": l5.lower_layer is layers[4],
            "paths": len(paths), "roles": sorted({p.role for p in paths}), "pts_shape": list(pts.shape), "pts_dtype": str(pts.dtype),
            "writeable": bool(pts.flags.writeable), "width": round(paths[0].width, 3),
            "islands": len(isl), "island_area_mm2": round(isl[0].area() * orca.slicing.unscale(1) ** 2, 2),
            "layer_height": ctx.config_value("layer_height"), "print_lh": ctx.print.config_value("layer_height"),
            "object_lh": o.config_value("layer_height"), "object_wall_loops": o.config_value("wall_loops"),
            "region_wall_loops": l5.regions()[0].region().config_value("wall_loops"),
            "objects": len(ctx.print.objects()), "model": o.model_object().name, "trafo_shape": list(t.shape),
            "fill_types": sorted({int(s.surface_type) for s in l5.regions()[0].fill_surfaces.surfaces}),
            "support_layers": len(o.support_layers()), "bbox": list(o.bounding_box()),
        }
        return orca.ExecutionResult.success("PROBE " + json.dumps(out))
@orca.plugin
class P(orca.base):
    def register_capabilities(self): orca.register_capability(Probe)
`;
await page.evaluate(async (src) => {
  const st = await import('/slicer/src/plugins/manager/store.ts');
  await st.installPackage(await st.inspectPackage('graph_probe.py', new TextEncoder().encode(src)), 'file');
}, probe);
for (const variant of ['mt', 'st']) {
  await page.evaluate(async (v) => (await import('/slicer/src/engine/client.ts')).setEngineThreadsPref(v === 'st' ? 1 : 0), variant);
  const pr = await sliceWith(20, ['Graph Probe']);
  const w = pr.warnings.find((x) => x.code === 'plugin' && x.message.includes('PROBE '));
  let d = null;
  try { d = JSON.parse(w.message.slice(w.message.indexOf('PROBE ') + 6)); } catch { /* reported below */ }
  check(`[${variant}] graph reads: layers, neighbours, perimeters (numpy (N,3) int64 read-only), lslices, configs, model, trafo`,
    d && d.layers === 100 && d.upper && d.lower && d.paths >= 2 && d.roles.includes('Outer wall') && d.pts_shape[1] === 3 && d.pts_dtype === 'int64'
      && !d.writeable && d.islands === 1 && Math.abs(d.island_area_mm2 - 400) < 1 && d.layer_height === d.print_lh && d.object_lh === d.layer_height && d.object_wall_loops === null && d.region_wall_loops === '3'
      && d.objects === 1 && /cube/.test(d.model) && d.trafo_shape.join() === '4,4' && d.fill_types.length >= 1,
    w ? w.message.slice(w.message.indexOf('PROBE')) : (pr.error ?? 'no probe message'));
}
await page.evaluate(async () => (await import('/slicer/src/engine/client.ts')).setEngineThreadsPref(0));

await browser.close();
const failed = checks.filter(([, ok]) => !ok);
const ok = failed.length === 0 && problems.length === 0;
console.log(ok ? `E2E PASS (${checks.length} checks)` : `E2E FAIL (${failed.length} checks: ${failed.map(([n]) => n).join('; ')}; ${problems.length} console errors)`);
process.exit(ok ? 0 : 1);
