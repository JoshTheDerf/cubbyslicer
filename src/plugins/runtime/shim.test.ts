/**
 * Conformance of the `orca` shim, run in a real Pyodide (Python 3.12) in Node:
 *  - its API surface against OrcaSlicer 2.5.0's pybind11 bindings
 *    (python/orca-api.json, extracted by scripts/dev/extract-orca-plugin-api.mjs);
 *  - registration semantics and Orca's error messages;
 *  - the loader + psGCodePostProcess on the unmodified G-code Stamp sample.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import api from './python/orca-api.json';

// Pyodide in Node is slow, more so beside the rest of the suite.
vi.setConfig({ testTimeout: 120_000 });

/* eslint-disable @typescript-eslint/no-explicit-any */
let py: any;
const posts: Array<[string, unknown]> = [];
const logs: string[] = [];
/** UI callbacks waiting in the stand-in CallbackChannel (delivered by waitCallbacks). */
const pendingCallbacks: unknown[] = [];
/** A stand-in for cs_hook_query in tests that exercise the graph proxies. */
let fakeEngine: (req: { batch: Array<Record<string, unknown>> }, blob: Uint8Array) => { json: string; blob?: Uint8Array } = () => ({ json: '{"ok":false,"error":"no engine"}' });
const ROOT = join(__dirname, 'python');
const FIXTURES = join(__dirname, '../../../scripts/dev/fixtures/orca-plugins');

function pyFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? pyFiles(p) : n.endsWith('.py') ? [p] : [];
  });
}

beforeAll(async () => {
  const { loadPyodide } = await import('pyodide');
  py = await loadPyodide({ indexURL: join(__dirname, '../../../node_modules/pyodide') + '/' });
  for (const f of pyFiles(ROOT)) {
    const target = '/orca/runtime/' + relative(ROOT, f);
    py.FS.mkdirTree(target.slice(0, target.lastIndexOf('/')));
    py.FS.writeFile(target, readFileSync(f, 'utf8'));
  }
  py.registerJsModule('_cubby_host', {
    call: (method: string) => ({ error: { type: 'RuntimeError', message: `no host in tests (${method})` } }),
    post: (method: string, args: string) => { posts.push([method, JSON.parse(args)]); },
    log: (_l: string, text: string) => { logs.push(text); },
    permissionDenied: () => {},
    requestPermissions: async () => JSON.stringify({ granted: true, grants: null }),
    setTrusted: () => {},
    hookQuery: (json: string, blob: any) => fakeEngine(JSON.parse(json), blob ? new Uint8Array(blob.toJs ? blob.toJs() : blob) : new Uint8Array()),
    hookCancelled: () => false,
    waitCallbacks: () => (pendingCallbacks.length ? JSON.stringify(pendingCallbacks.splice(0)) : ''),
  });
  py.runPython("import sys; sys.path.insert(0, '/orca/runtime'); import orca, _cubby_runtime; _cubby_runtime.install()");
}, 180_000);

describe('orca shim API surface vs OrcaSlicer 2.5.0 bindings', () => {
  it('has every module, function, attribute, class member and enum value', () => {
    const missing: string[] = [];
    const check = py.runPython(`
import importlib, json
def check(path, spec):
    out = []
    try:
        m = importlib.import_module(path)
    except Exception as e:
        return [f"{path}: cannot import ({e})"]
    for name in spec["functions"] + spec["attributes"] + spec["submodules"]:
        if not hasattr(m, name):
            out.append(f"{path}.{name}")
    for cls, members in spec["classes"].items():
        c = getattr(m, cls, None)
        if c is None:
            out.append(f"{path}.{cls}"); continue
        for mem in members:
            if mem == "__init__":
                continue
            if not hasattr(c, mem):
                out.append(f"{path}.{cls}.{mem}")
    for en, spec_e in spec["enums"].items():
        e = getattr(m, en, None)
        if e is None:
            out.append(f"{path}.{en}"); continue
        for v in spec_e["values"]:
            if v not in e.__members__:
                out.append(f"{path}.{en}.{v}")
            elif spec_e["exported"] and getattr(m, v, None) is not e[v]:
                # pybind11 export_values() of two enums with the same member name: the last one wins.
                others = [o for n, o in spec["enums"].items() if n != en and o["exported"] and v in o["values"]]
                if not others:
                    out.append(f"{path}.{v} (export_values)")
        if not spec_e["exported"]:
            for v in spec_e["values"]:
                if getattr(m, v, None) is e.__members__.get(v):
                    out.append(f"{path}.{v} should not be exported")
    return out
check`);
    for (const [path, spec] of Object.entries((api as { modules: Record<string, unknown> }).modules)) {
      missing.push(...check(path, py.toPy(spec)).toJs());
    }
    expect(missing).toEqual([]);
  });

  it('keeps Orca\'s enum values and pybind-style str()', () => {
    expect(py.runPython('import orca; [int(orca.PluginResult.FatalError), str(orca.PluginType.Script), orca.Script is orca.PluginType.Script, int(orca.host.ui.ErrorNotificationLevel), orca.host.ui.PD_CAN_ABORT | orca.host.ui.PD_REMAINING_TIME, int(orca.slicing.psGCodePostProcess)]').toJs())
      .toEqual([3, 'PluginType.Script', true, 9, 0x41, 12]);
  });
});

describe('registration (finalize_plugin_capture)', () => {
  it('raises Orca\'s errors outside discovery and for bad arguments', () => {
    const errs = py.runPython(`
import orca
from orca import _core
out = []
def err(f):
    try: f(); return "no error"
    except Exception as e: return f"{type(e).__name__}: {e}"
out.append(err(lambda: orca.register_capability(object)))
out.append(err(lambda: orca.request_permissions()))
out.append(err(lambda: orca.plugin(object)))
_core._begin_capture("k")
out.append(err(lambda: orca.plugin(1)))
out.append(err(lambda: orca.plugin(object)))
out.append(err(lambda: orca.register_capability(object)))
out.append(err(lambda: orca.request_permissions(fs_read=[""])))
out.append(err(lambda: orca.request_permissions(network=["ftp://x"])))
class P(orca.base): pass
class Q(orca.base): pass
orca.plugin(P)
out.append(err(lambda: orca.plugin(Q)))
orca.request_permissions(network=["HTTPS://Example.com:99/x", "https://example.com/y"], threading=True)
out.append(json.dumps(_core._pending_permissions["k"]["network_http"]) if (json := __import__("json")) else "")
_core._cancel_capture("k")
out`).toJs();
    expect(errs).toEqual([
      'ValueError: register_capability() called outside plugin discovery context',
      'ValueError: request_permissions() called outside plugin discovery context',
      'ValueError: @orca.plugin used outside plugin discovery context',
      'ValueError: @orca.plugin must decorate a class',
      'ValueError: @orca.plugin must decorate a subclass of orca.base',
      'ValueError: Registered class must inherit from a PluginCapability base',
      'ValueError: request_permissions(fs_read=...) does not accept empty values',
      'ValueError: request_permissions(network=...) requires an http:// or https:// URL with a host',
      'ValueError: multiple @orca.plugin classes registered; exactly one is allowed per plugin',
      '["https://example.com"]',
    ]);
  });

  it('ExecutionResult matches the binding', () => {
    expect(py.runPython(`
import orca
r = orca.ExecutionResult.failure(orca.PluginResult.RecoverableError, "bad")
s = orca.ExecutionResult()
[r.status.name, r.message, r.data, s.status.name, orca.ExecutionResult.skipped("x").status.name]`).toJs())
      .toEqual(['RecoverableError', 'bad', '', 'Success', 'Skipped']);
  });

  it('get_config() needs a host-loaded capability', () => {
    expect(py.runPython(`
import orca
class C(orca.script.ScriptPluginCapabilityBase):
    def get_name(self): return "c"
try:
    C().get_config(); r = "no error"
except RuntimeError as e:
    r = str(e)
r`)).toBe('get_config() is only available on a capability loaded by the plugin host');
  });
});

async function loadFixture(file: string, extra: Record<string, unknown> = {}): Promise<any> {
  const src = readFileSync(join(FIXTURES, file), 'utf8');
  const root = `/orca/data/orca_plugins/${file}`;
  py.FS.mkdirTree(root);
  py.FS.writeFile(`${root}/${file}`, src);
  const desc = { pluginKey: file.replace(/\.py$/, ''), root: file, entryFile: file, kind: 'py', dependencies: [], ...extra };
  return JSON.parse(await py.globals.get('_cubby_runtime').safe_load(JSON.stringify(desc), '[]', '{}', true));
}

describe('loader + post-process with the unmodified G-code Stamp sample', () => {
  it('loads it, stamps the G-code in place and reads its config', async () => {
    const r = await loadFixture('orca_gcode_stamp_plugin_any.py');
    expect(r).toEqual({ ok: true, caps: [{ pluginKey: 'orca_gcode_stamp_plugin_any', type: 'slicing-pipeline', name: 'G-code Stamp', enabled: true, hasConfigUi: false, supported: true }] });
    const rt = py.globals.get('_cubby_runtime');
    const caps = JSON.stringify([{ id: { pluginKey: 'orca_gcode_stamp_plugin_any', type: 'slicing-pipeline', name: 'G-code Stamp' }, config: { stamp_text: 'hello from CubbySlicer' }, configVersion: '0.01' }]);
    const res = rt.safe_post_process(caps, new TextEncoder().encode('; HEADER_BLOCK_START\nG28\n'), 'OctoPrint', 'part.gcode', '{}').toJs({ depth: 1 });
    expect(res[1]).toBe('');
    const out = new TextDecoder().decode(res[0].toJs());
    expect(out).toBe('; HEADER_BLOCK_START\n; hello from CubbySlicer (host=OctoPrint)\nG28\n');
    // default config when nothing is saved
    const res2 = rt.safe_post_process(caps.replace('{"stamp_text":"hello from CubbySlicer"}', '{}'), new TextEncoder().encode('G28\n'), 'File', 'p.gcode', '{}').toJs({ depth: 1 });
    expect(new TextDecoder().decode(res2[0].toJs())).toBe('G28\n; processed by the OrcaSlicer G-code Stamp plugin (host=File)\n');
    expect(JSON.parse(rt.default_config('orca_gcode_stamp_plugin_any', 'slicing-pipeline', 'G-code Stamp'))).toEqual({ stamp_text: 'processed by the OrcaSlicer G-code Stamp plugin' });
  });

  it('reports a failing plugin with Orca\'s post-process message', async () => {
    py.FS.mkdirTree('/orca/data/orca_plugins/bad.py');
    py.FS.writeFile('/orca/data/orca_plugins/bad.py/bad.py', `
import orca
class Bad(orca.slicing.SlicingPipelineCapabilityBase):
    def get_name(self): return "Bad"
    def execute(self, ctx):
        if ctx.host == "fail": return orca.ExecutionResult.failure(orca.PluginResult.FatalError, "nope")
        raise KeyError("boom")
@orca.plugin
class P(orca.base):
    def register_capabilities(self): orca.register_capability(Bad)
`);
    const r = JSON.parse(await py.globals.get('_cubby_runtime').safe_load(JSON.stringify({ pluginKey: 'bad', root: 'bad.py', entryFile: 'bad.py', kind: 'py', dependencies: [] }), '[]', '{}', true));
    expect(r.ok).toBe(true);
    const rt = py.globals.get('_cubby_runtime');
    const caps = JSON.stringify([{ id: { pluginKey: 'bad', type: 'slicing-pipeline', name: 'Bad' }, config: {}, configVersion: '' }]);
    expect(rt.safe_post_process(caps, new Uint8Array([71]), 'fail', 'x.gcode', '{}').toJs({ depth: 1 })[1]).toBe('Post-processing plugin Bad failed.\nError: nope');
    expect(rt.safe_post_process(caps, new Uint8Array([71]), 'File', 'x.gcode', '{}').toJs({ depth: 1 })[1]).toBe("Post-processing plugin Bad raised an exception.\nError: KeyError: 'boom'");
  });

  it('fails a plugin without @orca.plugin like Orca', async () => {
    py.FS.mkdirTree('/orca/data/orca_plugins/none.py');
    py.FS.writeFile('/orca/data/orca_plugins/none.py/none.py', 'import orca\n');
    const r = JSON.parse(await py.globals.get('_cubby_runtime').safe_load(JSON.stringify({ pluginKey: 'none', root: 'none.py', entryFile: 'none.py', kind: 'py', dependencies: [] }), '[]', '{}', true));
    expect(r).toMatchObject({ ok: false, error: 'Plugin registration failed: RuntimeError: Plugin did not register a package class; decorate it with @orca.plugin' });
  });
});

describe('Script capability and UI handles (Dock Panel Demo sample)', () => {
  it('runs execute(), opens a panel through the host and dispatches its callbacks', async () => {
    const r = await loadFixture('orca_dock_panel_plugin_any.py');
    expect(r.ok).toBe(true);
    posts.length = 0;
    const rt = py.globals.get('_cubby_runtime');
    const done = JSON.parse(await rt.run_script(1, 'orca_dock_panel_plugin_any', 'Dock Panel Demo'));
    expect(done).toEqual({ cancelled: false, result: { status: 'Success', message: 'Dock Panel Demo opened.', data: '' } });
    const create = posts.find(([m]) => m === 'ui.createDock')!;
    expect(create[1]).toMatchObject({ title: 'Dock Panel Demo', width: 320, height: 480, dock: 'right' });
    const handle = (create[1] as { handle: number }).handle;
    // the page asks to refresh → the plugin calls orca.host.model(), which fails without a host here, and posts the error
    rt.ui_event(handle, 'message', JSON.stringify({ command: 'refresh' }));
    const post = posts.find(([m]) => m === 'ui.post')!;
    expect((post[1] as { data: { error: string } }).data.error).toMatch(/no host in tests \(model.snapshot\)/);
    rt.ui_event(handle, 'message', JSON.stringify({ command: 'hide' }));
    expect(posts.some(([m, a]) => m === 'ui.show' && (a as { visible: boolean }).visible === false)).toBe(true);
    // second run while open shows it again
    const again = JSON.parse(await rt.run_script(2, 'orca_dock_panel_plugin_any', 'Dock Panel Demo'));
    expect(again.result.message).toBe('Dock Panel Demo is already open.');
    rt.ui_event(handle, 'close', '');
    const third = JSON.parse(await rt.run_script(3, 'orca_dock_panel_plugin_any', 'Dock Panel Demo'));
    expect(third.result.message).toBe('Dock Panel Demo opened.');
  });

  it('blocks threads and processes through the audit hook, attributed to the capability', () => {
    const out = py.runPython(`
import orca, _cubby_runtime, threading, os
res = []
with _cubby_runtime._scope("orca_dock_panel_plugin_any", "script", "Dock Panel Demo"):
    for f in (lambda: threading.Thread(target=lambda: None).start(), lambda: os.system("ls"), lambda: open("/etc/passwd").read()):
        try:
            f(); res.append("allowed")
        except Exception as e:
            res.append(f"{type(e).__name__}: {e}")
    with open(orca.host.plugin.storage() + "/x.txt", "w") as fh:
        fh.write("ok")
    res.append(open(orca.host.plugin.storage() + "/x.txt").read())
res`).toJs();
    expect(out).toEqual([
      "RuntimeError: Threads are not available in CubbySlicer's browser Python runtime; use async def execute",
      'PermissionError: Plugin attempted audited operation "os.system" without permission: starting programs is not possible in the browser',
      'PermissionError: Plugin attempted audited operation "open" without permission: /etc/passwd',
      'ok',
    ]);
  });
});

describe('blocking waits run pending UI callbacks (CallbackChannel)', () => {
  it('queue.Queue.get / Event.wait / time.sleep deliver window callbacks while they wait', () => {
    const out = py.runPython(`
import queue, threading, time, orca
q = queue.Queue()
ev = threading.Event()
seen = []
w = orca.host.ui.create_window("<p>x</p>", on_message=lambda d: q.put(d), on_close=lambda: ev.set())
w2 = orca.host.ui.create_window("<p>y</p>", on_message=lambda d: seen.append(d))
w.id, w2.id`).toJs();
    const [h1, h2] = out;
    pendingCallbacks.push({ t: 'uiEvent', handle: String(h1), kind: 'message', data: { command: 'apply', v: 1 } });
    expect(py.runPython('q.get(timeout=5)').toJs({ dict_converter: Object.fromEntries })).toEqual({ command: 'apply', v: 1 });
    pendingCallbacks.push({ t: 'uiEvent', handle: String(h1), kind: 'close' });
    expect(py.runPython('ev.wait(5)')).toBe(true);
    pendingCallbacks.push({ t: 'uiEvent', handle: String(h2), kind: 'message', data: 7 });
    expect(py.runPython('t = time.monotonic(); time.sleep(0.2); (time.monotonic() - t >= 0.19, seen)').toJs()).toEqual([true, [7]]);
    // a timeout with nothing delivered still times out
    expect(py.runPython('import queue as _q\ntry:\n    q.get(timeout=0.15); r = "got"\nexcept _q.Empty:\n    r = "empty"\nr')).toBe('empty');
 
  });

  it('without cross-origin isolation a wait without a timeout fails clearly instead of hanging', () => {
    const out = py.runPython(`
import queue, _cubby_wait
_cubby_wait._isolated = False
try:
    try:
        queue.Queue().get()
        r = "returned"
    except RuntimeError as e:
        r = str(e)
    try:
        queue.Queue().get(timeout=0.05)
    except queue.Empty:
        r += " | timed wait still times out"
finally:
    _cubby_wait._isolated = True
r`);
    expect(out).toMatch(/needs CubbySlicer to run cross-origin isolated .* \| timed wait still times out$/);
  });
});

describe('geometry semantics (Orca tests/slic3rutils/test_slicing_pipeline_bindings.cpp)', () => {
  it('Point / Polygon / ExPolygon behave like the libslic3r bindings', () => {
    const out = py.runPython(`
import math
from orca import host
s = 10_000_000
res = {}
p = host.Point(3, 4); p.x = 7
q = p + host.Point(1, 2)
h = host.Point(10, 20) * 0.5
res["point"] = [p.x, q.x, q.y, h.x, h.y]
P = host.Polygon()
for x, y in ((0, 0), (s, 0), (s, s), (0, s)):
    P.append(host.Point(x, y))
res["poly"] = [P.size(), P.is_counter_clockwise(), P.area() == s * s]
pts = P.points; pts[0].x = 5; res["ref_edit"] = P.points[0].x; pts[0].x = 0
ex = host.ExPolygon(P)
res["ex"] = [ex.area() == s * s, ex.num_contours(), ex.contour.size()]
ex.rotate(1.5707963267948966, host.Point(s // 2, s // 2))
res["rot_area"] = abs(ex.area() - s * s) / (s * s) < 1e-6
ex2 = host.ExPolygon(P); ex2.scale(2.0); res["scale_area"] = ex2.area() == 4 * s * s
ex3 = host.ExPolygon(P); ex3.translate(1000.0, -500.0); res["tr"] = [ex3.area() == s * s, ex3.contour.points[0].x, ex3.contour.points[0].y]
# libslic3r rounding: translate truncates (coord_t), rotate uses C round (half away from zero)
t = host.Polygon(); [t.append(host.Point(*xy)) for xy in ((0, 0), (10, 0), (0, 10))]
t.translate(2.9, -2.9); res["trunc"] = [(pt.x, pt.y) for pt in t.points]
r = host.Polygon(); [r.append(host.Point(*xy)) for xy in ((-3, 0), (3, 0), (0, 5))]
r.rotate(math.pi, host.Point(0, 0)); res["round"] = [(pt.x, pt.y) for pt in r.points]
sc = host.Polygon(); [sc.append(host.Point(*xy)) for xy in ((-3, 0), (3, 0), (0, 5))]
host.ExPolygon(sc)
e4 = host.ExPolygon(sc); e4.scale(0.5); res["scale_trunc"] = [(pt.x, pt.y) for pt in e4.contour.points]
cw = host.Polygon(); [cw.append(host.Point(*xy)) for xy in ((0, 0), (0, s), (s, s), (s, 0))]
res["normalized"] = host.ExPolygon(cw).contour.is_counter_clockwise()
import json; json.dumps(res)`);
    expect(JSON.parse(out)).toEqual({
      point: [7, 8, 6, 5, 10],
      poly: [4, true, true],
      ref_edit: 5,
      ex: [true, 1, 4],
      rot_area: true,
      scale_area: true,
      tr: [true, 1000, -500],
      trunc: [[2, -2], [12, -2], [2, 8]],
      round: [[3, 0], [-3, 0], [0, -5]],
      scale_trunc: [[-1, 0], [1, 0], [0, 2]],
      normalized: true,
    });
  });
});

describe('slicing graph proxies: in-place edits are written back (fake engine)', () => {
  it('runs a pipeline capability, reads surfaces, writes edits back with surface.patch / surfaces.set / make_slices', async () => {
    py.FS.mkdirTree('/orca/data/orca_plugins/graph_demo.py');
    py.FS.writeFile('/orca/data/orca_plugins/graph_demo.py/graph_demo.py', `
import orca
class G(orca.slicing.SlicingPipelineCapabilityBase):
    def get_name(self): return "Graph Demo"
    def execute(self, ctx):
        if ctx.step != orca.slicing.Step.posSlice or ctx.object is None:
            return orca.ExecutionResult.success()
        layers = ctx.object.layers()
        l0 = layers[0]
        surf = l0.regions()[0].slices.surfaces[0]
        surf.expolygon.translate(1000.0, 0.0)          # Twistify's path: in place
        surf.surface_type = orca.host.SurfaceType.stTop
        l0.make_slices()                               # flushes the patch first
        r1 = layers[1].regions()[0]
        exs = [s.expolygon for s in r1.slices.surfaces]
        r1.slices.set(exs, orca.host.SurfaceType.stInternalSolid)  # Inset's path
        return orca.ExecutionResult.success(f"{len(layers)} layers, bbox {ctx.object.bounding_box()}")
@orca.plugin
class P(orca.base):
    def register_capabilities(self): orca.register_capability(G)
`);
    const rt = py.globals.get('_cubby_runtime');
    const r = JSON.parse(await rt.safe_load(JSON.stringify({ pluginKey: 'graph_demo', root: 'graph_demo.py', entryFile: 'graph_demo.py', kind: 'py', dependencies: [] }), '[]', '{}', true));
    expect(r.ok).toBe(true);
    const sq = (x0: number) => new BigInt64Array([x0, 0, x0 + 100, 0, x0 + 100, 100, x0, 100].map((v) => BigInt(v)));
    const ops: Array<Record<string, unknown>> = [];
    const blobs: BigInt64Array[] = [];
    fakeEngine = (req, blob) => {
      const results: unknown[] = [];
      let out = new Uint8Array();
      for (const op of req.batch) {
        ops.push(op);
        if (op.op === 'object.layers') results.push({ blobOffset: 0, layers: [{ print_z: 0.2, slice_z: 0.1, height: 0.2, regionCount: 1 }, { print_z: 0.4, slice_z: 0.3, height: 0.2, regionCount: 1 }] });
        else if (op.op === 'layer.surfaces') {
          out = new Uint8Array(sq(0).buffer);
          results.push({ blobOffset: 0, surfaces: [{ contourLen: 4, holeLens: [], type: 4, thickness: -1, thickness_layers: 1, bridge_angle: -1, extra_perimeters: 0 }] });
        } else if (op.op === 'object.info') results.push({ blobOffset: 0, id: 7, bbox: [0, 0, 100, 100], trafo: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], layerCount: 2, supportLayerCount: 0, modelObject: 1 });
        else {
          if (op.blobOffset !== undefined && blob.byteLength) blobs.push(new BigInt64Array(blob.slice().buffer, Number(op.blobOffset), 8));
          results.push({ blobOffset: 0 });
        }
      }
      return { json: JSON.stringify({ ok: true, error: null, results }), blob: out };
    };
    const res = JSON.parse(rt.safe_run_pipeline(JSON.stringify({ step: 'posSlice', stepIndex: 0, objectId: 7, objectIndex: 0, scalingFactor: 1e-6, orcaVersion: '2.5.0', capabilities: ['Graph Demo'], plugins: [] })));
    expect(res).toEqual({ status: 'Success', capability: 'Graph Demo', message: '2 layers, bbox (0, 0, 100, 100)' });
    const names = ops.map((o) => o.op);
    expect(names).toEqual(['object.layers', 'layer.surfaces', 'surface.patch', 'layer.make_slices', 'layer.surfaces', 'surfaces.set', 'object.info']);
    const patch = ops[2];
    expect(patch).toMatchObject({ objectId: 7, layer: 0, region: 0, which: 'slices', index: 0, type: 0, expolygon: { contourLen: 4, holeLens: [] } });
    expect([...blobs[0]].map(Number)).toEqual([1000, 0, 1100, 0, 1100, 100, 1000, 100]);
    expect(ops[5]).toMatchObject({ layer: 1, type: 5, expolygons: [{ contourLen: 4, holeLens: [] }] });
    // after the hook the proxies are dead, as Orca's references are
    expect(py.runPython('import orca.host._graph as g; g._HOOK is None')).toBe(true);
  });
});
