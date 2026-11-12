// Browser end-to-end check for OrcaSlicer Python plugins (src/plugins/):
// install the UNMODIFIED Orca 2.5.0 sample plugins (scripts/dev/fixtures/orca-plugins/,
// copied verbatim from OrcaSlicer's sandboxes/) through the Plugins dialog and
// check their visible effect:
//
//  - G-code Stamp (slicing pipeline, psGCodePostProcess): selected for export,
//    configured through the Config tab; the exported file and the file uploaded
//    to a (mock) Moonraker carry the stamp line after the first line, with the
//    right host, while the preview's G-code stays untouched.
//  - Orca Inspector (Script, numpy): run from the command palette; its window
//    reads orca.host.plater()/model()/preset_bundle() and a mesh through numpy;
//    ui.message() shows CubbySlicer's message box and returns the click; the
//    threading demo fails with the documented error.
//  - Dock Panel Demo (Script): run from the dialog's Run button; the panel docks right and lists
//    the plate's objects; hide / run again / close work.
//  - enable / disable, reload, persistence across a page reload (auto-load),
//    delete; and the page without cross-origin isolation (post-process still
//    works, host reads say why they don't).
//
// Measures Pyodide boot time and what was downloaded for it.
//
//   node scripts/dev/e2e-plugins.mjs [baseUrl] [out-dir]
// The dev server must send COOP/COEP (vite.config.ts does) and Pyodide must be
// staged (node scripts/stage-pyodide.mjs).
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PW = process.env.PLAYWRIGHT ?? 'playwright';
const { chromium } = await import(PW);
const base = process.argv[2] ?? 'http://localhost:5421/slicer/';
const out = resolve(process.argv[3] ?? 'e2e-out/plugins');
mkdirSync(out, { recursive: true });
const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/orca-plugins');
const STAMP = join(FIX, 'orca_gcode_stamp_plugin_any.py');
const INSPECTOR = join(FIX, 'orca_inspector_plugin_any.py');
const DOCK = join(FIX, 'orca_dock_panel_plugin_any.py');

// ---- mock Moonraker -------------------------------------------------------------------
const uploads = [];
const moon = await new Promise((r) => {
  const srv = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
      res.setHeader('Access-Control-Allow-Headers', 'X-Api-Key, Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
      if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
      const body = Buffer.concat(chunks).toString('latin1');
      if (req.url === '/server/info') { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ result: { klippy_state: 'ready' } })); return; }
      if (req.url === '/server/files/upload') {
        uploads.push(body);
        res.writeHead(201, { 'Content-Type': 'application/json' }).end(JSON.stringify({ result: { item: { path: 'x.gcode', root: 'gcodes' }, print_started: false } }));
        return;
      }
      res.writeHead(404).end('{}');
    });
  });
  srv.listen(0, '127.0.0.1', () => r({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
});

function cubeStl(s = 20) {
  const v = [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], [0, 0, s], [s, 0, s], [s, s, s], [0, s, s]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const buf = Buffer.alloc(84 + f.length * 50); buf.writeUInt32LE(f.length, 80);
  f.forEach((t, i) => { const o = 84 + i * 50; t.forEach((vi, k) => v[vi].forEach((c, j) => buf.writeFloatLE(c, o + 12 + k * 12 + j * 4))); });
  return buf;
}
writeFileSync(`${out}/cube.stl`, cubeStl());

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const checks = [];
const problems = [];
const check = (name, ok, extra = '') => { checks.push([name, !!ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); };
const shot = async (o) => { try { await page.screenshot({ ...o, timeout: 15000 }); } catch (e) { console.log(`(screenshot skipped: ${e.message.split('\n')[0]})`); } };
const t0 = Date.now();
const lap = (s) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s  ${s}`);

// Wait inside the page (waitForFunction treats an async predicate's Promise as truthy).
async function waitPlugins(p, cond) {
  const ok = await p.evaluate(async (c) => {
    const m = await import('/slicer/src/plugins/manager/store.ts');
    const test = new Function('rows', `return ${c}`);
    for (let i = 0; i < 300; i++) { if (test(m.pluginState.rows)) return true; await new Promise((r) => setTimeout(r, 1000)); }
    return false;
  }, cond);
  if (!ok) throw new Error(`plugins never reached: ${cond}`);
}

async function newPage(opts = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await context.addInitScript(() => { delete window.showOpenFilePicker; delete window.showSaveFilePicker; delete window.showDirectoryPicker; });
  await context.addInitScript(() => { try { localStorage.setItem('cubby.setup.done', 'true'); } catch { /* ignore */ } });
  if (opts.noIsolation) {
    await context.route('**/*', async (route) => {
      const res = await route.fetch();
      const headers = { ...res.headers() };
      delete headers['cross-origin-opener-policy'];
      delete headers['cross-origin-embedder-policy'];
      await route.fulfill({ response: res, headers });
    });
  }
  const page = await context.newPage();
  page.setDefaultTimeout(90000);
  page.on('requestfailed', (r) => {
    const u = r.url();
    if (/slicer\.wasm|127\.0\.0\.1/.test(u)) return;
    console.log('[requestfailed]', r.failure()?.errorText, u.slice(0, 160));
    if (new URL(u).host === new URL(base).host && !/ERR_ABORTED/.test(r.failure()?.errorText ?? '')) problems.push(`request failed: ${u}`);
  });
  page.on('pageerror', (e) => { problems.push(`pageerror: ${e.message}`); console.log('[pageerror]', e.message); });
  page.on('console', (m) => {
    const t = m.text();
    // ERR_NAME_NOT_RESOLVED: third-party hosts (fonts, icon API) in an offline sandbox; the failing URL is logged below.
    if (m.type() === 'error' && !/127\.0\.0\.1|CORS|Access-Control|ERR_FAILED|ERR_NAME_NOT_RESOLVED|favicon/.test(t)) { problems.push(t); console.log('[console.error]', t); }
    if (/\[plugins\]/.test(t)) console.log('[app]', t);
  });
  return { context, page };
}

let { context, page } = await newPage();
// The palette asks "Run “X”?" before a plugin's command (desktop's Speed Dial): confirm it.
const confirmPluginRun = async () => {
  const ask = page.getByRole('dialog').filter({ hasText: /Run “/ });
  await ask.getByRole('button', { name: /^OK$/ }).click({ timeout: 15000 });
  await ask.waitFor({ state: 'hidden' });
};
const pyodideBytes = { total: 0, files: {} };
page.on('response', async (r) => {
  if (!r.url().includes('/pyodide/')) return;
  try { const b = await r.body(); pyodideBytes.files[r.url().split('/').pop()] = b.length; pyodideBytes.total += b.length; } catch { /* redirected */ }
});

await page.goto(`${base}?cubby-debug`, { waitUntil: 'load', timeout: 300000 });
await page.waitForFunction(() => !!window.__cubbyProject);
// Start clean: no installed plugins, no saved selection.
await page.evaluate(async () => {
  const root = await navigator.storage.getDirectory();
  try { await root.removeEntry('cubby-plugins', { recursive: true }); } catch { /* none */ }
  localStorage.removeItem('cubby-plugins:slicing-pipeline-plugin');
  for (const k of Object.keys(localStorage)) if (k.startsWith('cubby.printhost.')) localStorage.removeItem(k);
});
await page.reload({ waitUntil: 'load', timeout: 300000 });
await page.waitForFunction(() => !!window.__cubbyProject);
await page.evaluate(() => window.__cubbyProject.resetProject?.());
check('crossOriginIsolated', await page.evaluate(() => crossOriginIsolated));
check('nothing Pyodide-related loads at startup', Object.keys(pyodideBytes.files).length === 0);
lap('app loaded');

// ---- a sliced plate (engine) or fixture G-code ----
const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: /Import model/ }).first().click()]);
await fc.setFiles(`${out}/cube.stl`);
await page.waitForFunction(() => window.__cubbyProject.objects.value.length >= 1);
let sliced = false;
try {
  await page.getByRole('button', { name: /Slice plate|Re-slice/ }).first().click({ timeout: 10000 });
  await page.waitForFunction(() => { const b = document.querySelector('.slicebar'); return b && (b.classList.contains('done') || b.classList.contains('error')); }, null, { timeout: 300000 });
  sliced = await page.evaluate(async () => ((await import('/slicer/src/app/state.ts')).lastSlice.value?.gcode.byteLength ?? 0) > 1000);
} catch { sliced = false; }
if (!sliced) {
  console.log('NOTE  slicing unavailable; using fixture G-code for post-processing');
  await page.evaluate(async () => {
    const g = new TextEncoder().encode('; HEADER_BLOCK_START\n; generated by fixture\nG28\nG1 X10 Y10 F3000\n');
    (await import('/slicer/src/app/slice.ts')).loadPlateGcode(0, g);
  });
}
const engineVersion = await page.evaluate(async () => (await import('/slicer/src/presets/store.ts')).currentPresets.value.schema.value?.version ?? '?');
check(sliced ? `sliced with engine ${engineVersion}` : `fixture G-code loaded (engine ${engineVersion})`, true);
const previewBefore = await page.evaluate(async () => new TextDecoder().decode((await import('/slicer/src/app/state.ts')).lastSlice.value.gcode));
lap('plate ready');

// ---- Plugins dialog from File ▸ Plugins… ----
await page.locator('[data-menu="file"]').click();
await page.getByRole('menuitem', { name: /Plugins/ }).click();
const dlg = page.getByTestId('plugins-dialog');
await dlg.waitFor();
check('File ▸ Plugins… opens the Plugins dialog', true);
check('dialog shows the trust warning', (await dlg.getByTestId('plugins-trust').innerText()).includes('they are not a sandbox'));
await shot({ path: `${out}/1-dialog-empty.png` });

async function install(file) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), dlg.getByTestId('plugins-install').click()]);
  await chooser.setFiles(file);
  await page.getByTestId('plugin-install-sheet').waitFor();
  await page.getByTestId('plugin-install-confirm').click();
  await page.getByTestId('plugin-install-sheet').waitFor({ state: 'hidden', timeout: 300000 });
}
async function statusOf(key) { return (await page.getByTestId(`plugin-status-${key}`).innerText()).trim(); }
async function waitStatus(key, want, timeout = 300000) {
  await page.waitForFunction(([k, w]) => document.querySelector(`[data-testid="plugin-status-${k}"]`)?.textContent?.trim() === w, [key, want], { timeout });
}

// ---- G-code Stamp ----
const tBoot = Date.now();
await install(STAMP);
await waitStatus('orca_gcode_stamp_plugin_any', 'Activated');
const bootWall = Date.now() - tBoot;
const runtimeLine = await page.getByTestId('plugins-runtime').innerText();
check('G-code Stamp installs and loads', true, runtimeLine.trim());
check('Python 3.12 runtime (Pyodide 0.27.8)', /Python 3\.12\.\d+ \(Pyodide 0\.27\.8\)/.test(runtimeLine));
const bootMs = Number(/started in ([\d.]+) s/.exec(runtimeLine)?.[1] ?? 'NaN') * 1000;
await page.getByTestId('plugin-cap-G-code Stamp').waitFor();
await page.getByTestId('plugin-pipeline-G-code Stamp').click();
check('Stamp selected for post-processing', (await page.evaluate(async () => (await import('/slicer/src/plugins/host/postProcess.ts')).selectedPipelineNames())).includes('G-code Stamp'));
await dlg.getByRole('tab', { name: 'Config' }).click();
const json = page.getByTestId('plugin-config-json');
await json.fill('{ "stamp_text": "stamped by the CubbySlicer e2e" }');
await page.getByTestId('plugin-config-save').click();
await page.waitForTimeout(400);
const cfg = await page.evaluate(async () => {
  const root = await navigator.storage.getDirectory();
  const f = await (await (await root.getDirectoryHandle('cubby-plugins')).getDirectoryHandle('orca_plugins')).getFileHandle('config.json');
  return JSON.parse(await (await f.getFile()).text());
});
check('config.json written in Orca\'s format', cfg.config?.[0]?.capability === 'G-code Stamp' && cfg.config[0].capability_type === 'slicing-pipeline' && cfg.config[0].cap_config.stamp_text === 'stamped by the CubbySlicer e2e', JSON.stringify(cfg.config?.[0]));
const sidecar = await page.evaluate(async () => {
  const root = await navigator.storage.getDirectory();
  const d = await (await (await root.getDirectoryHandle('cubby-plugins')).getDirectoryHandle('orca_plugins')).getDirectoryHandle('orca_gcode_stamp_plugin_any.py');
  return JSON.parse(await (await (await d.getFileHandle('.install_state.json')).getFile()).text());
});
check('.install_state.json in Orca\'s format', sidecar.enabled === true && sidecar.installed_from === 'local' && JSON.stringify(sidecar.capabilities) === '[{"G-code Stamp":true}]', JSON.stringify(sidecar).slice(0, 120));
await shot({ path: `${out}/2-stamp-config.png` });
await page.keyboard.press('Escape');
await dlg.waitFor({ state: 'hidden' });

// Export (Ctrl+G): a download with the stamp.
async function exportGcode() {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.evaluate(async () => {
    const { useSliceController } = await import('/slicer/src/app/slice.ts');
    useSliceController().exportGcode();
  })]);
  return readFileSync(await dl.path(), 'utf8');
}
const exported = await exportGcode();
const lines = exported.split('\n');
check('exported G-code carries the stamp after the first line', lines[1] === '; stamped by the CubbySlicer e2e (host=File)', lines[1]);
check('exported G-code otherwise unchanged', lines.slice(0, 1).concat(lines.slice(2)).join('\n') === previewBefore);
const previewAfter = await page.evaluate(async () => new TextDecoder().decode((await import('/slicer/src/app/state.ts')).lastSlice.value.gcode));
check('preview G-code untouched by post-processing (as Orca)', previewAfter === previewBefore);
const again = await exportGcode();
check('post-process re-runs on every export (one stamp per file)', again.split('\n').filter((l) => l.startsWith('; stamped by')).length === 1);

// Send to a (mock) Moonraker.
await page.getByRole('button', { name: 'Printer menu' }).click();
await page.getByRole('menuitem', { name: /Physical printer/ }).click();
const pdlg = page.getByRole('dialog', { name: /Physical printer/ });
await pdlg.waitFor();
await pdlg.getByRole('combobox', { name: 'Host type' }).click();
await page.getByRole('option', { name: 'Moonraker (Klipper)', exact: true }).click();
await pdlg.getByRole('textbox', { name: 'Hostname, IP or URL' }).fill(moon.url);
await pdlg.getByRole('button', { name: 'Save' }).click();
await pdlg.waitFor({ state: 'hidden' });
await page.waitForTimeout(400);
await page.keyboard.press('Control+Shift+G');
const send = page.getByRole('dialog', { name: /Print plate/ });
await send.waitFor();
await send.getByRole('button', { name: 'Upload', exact: true }).click();
await page.getByText(/Uploaded to Moonraker/).first().waitFor({ timeout: 30000 });
const up = uploads[uploads.length - 1] ?? '';
const hostLine = /; stamped by the CubbySlicer e2e \(host=(.*)\)\r?\n/.exec(up);
check('uploaded G-code carries the stamp with the print host', !!hostLine && hostLine[1] !== 'File', hostLine?.[1]);
lap('stamp done');

// ---- Orca Inspector (numpy) from the command palette ----
await page.locator('[data-menu="file"]').click();
await page.getByRole('menuitem', { name: /Plugins/ }).click();
await dlg.waitFor();
const tInsp = Date.now();
await install(INSPECTOR);
await waitStatus('orca_inspector_plugin_any', 'Activated');
check('Orca Inspector loads (numpy from the staged distribution)', true, `${Date.now() - tInsp} ms`);
await page.keyboard.press('Escape');
await dlg.waitFor({ state: 'hidden' });
await page.keyboard.press('Control+k');
await page.keyboard.type('Orca Inspector');
await page.getByRole('option', { name: /Orca Inspector/ }).first().waitFor();
check('palette lists the Script capability', true);
await page.keyboard.press('Enter');
await confirmPluginRun();
const win = page.getByTestId('plugin-window').filter({ hasText: 'Orca Inspector' }).first();
await win.waitFor();
const frame = page.frameLocator('iframe[title="Orca Inspector"]');
await frame.locator('#content .card').first().waitFor({ timeout: 60000 });
const overview = await frame.locator('#content').innerText();
check('Inspector overview reads plater / model / presets', /plater/i.test(overview) && /orca\.host\.plater\(\)/i.test(overview) && /1 objects/i.test(overview.replace(/\s+/g, ' ')), overview.replace(/\s+/g, ' ').slice(0, 160));
await shot({ path: `${out}/3-inspector-overview.png` });
await frame.locator('#nav-model').click();
await frame.locator('#content').getByText('cube', { exact: false }).first().waitFor({ timeout: 30000 });
check('Inspector model section lists the cube', true);
await frame.locator('[data-act="mesh"]').first().evaluate((b) => b.click());
await frame.locator('#content').getByText(/shape=\(8, 3\) dtype=float32 writeable=False/).first().waitFor({ state: 'attached', timeout: 30000 });
check('Inspector mesh: numpy (8, 3) float32 vertices', true);
await shot({ path: `${out}/4-inspector-mesh.png` });
await frame.locator('#nav-config').click();
await frame.locator('#content').getByText('layer_height').first().waitFor({ state: 'attached', timeout: 30000 });
check('Inspector config: full_config_keys / full_config_value', true);
await frame.locator('#nav-uikit').click();
await frame.locator('[data-ui="message"]').click();
await page.getByTestId('plugin-message-text').waitFor();
check('ui.message() shows a message box', (await page.getByTestId('plugin-message-text').innerText()).includes('Shall we inspect some hosts?'));
await shot({ path: `${out}/5-message.png` });
await page.getByTestId('plugin-message-yes').click();
await frame.locator('#ui-log').getByText("user clicked 'yes'").waitFor({ timeout: 20000 });
check('ui.message() returns the clicked button', true);
await frame.locator('[data-ui="progress"]').click();
await frame.locator('#ui-log').getByText(/Threads are not available/).waitFor({ timeout: 20000 });
check('threading demo fails with the documented error', true);
await frame.locator('[data-ui="modal"]').click();
const modal = page.frameLocator('iframe[title="Orca Inspector — modal"]');
await modal.locator('button', { hasText: 'Submit' }).click();
await frame.locator('#ui-log').getByText(/modal submitted/).waitFor({ timeout: 20000 });
check('modal window: orca.submit() reaches on_submit', true);
await shot({ path: `${out}/6-inspector-uikit.png` });
await win.getByTestId('plugin-window-close').click();
await win.waitFor({ state: 'hidden' });
lap('inspector done');

// ---- Dock Panel Demo from the dialog's Run button ----
await page.locator('[data-menu="file"]').click();
await page.getByRole('menuitem', { name: /Plugins/ }).click();
await dlg.waitFor();
await install(DOCK);
await waitStatus('orca_dock_panel_plugin_any', 'Activated');
await page.getByTestId('plugin-run-Dock Panel Demo').click();
const dockFrame = page.frameLocator('iframe[title="Dock Panel Demo"]');
await dockFrame.locator('#rows tr').first().waitFor({ timeout: 30000 });
const rowsText = await dockFrame.locator('#rows').innerText();
check('Dock Panel lists the plate objects (name, parts, copies)', /cube/i.test(rowsText) && /\b1\b/.test(rowsText), rowsText.replace(/\s+/g, ' '));
check('Dock Panel docks on the right of the viewport (dock="right")', await page.evaluate(() => {
  const w = [...document.querySelectorAll('[data-testid="plugin-window"]')].find((e) => e.textContent.includes('Dock Panel Demo'));
  const d = document.querySelector('[data-testid="plugin-dock-right"]')?.getBoundingClientRect(), c = document.querySelector('.center')?.getBoundingClientRect();
  return w?.dataset.dock === 'right' && !!d && !!c && d.width === 320 && c.right <= d.left + 1;
}));
await shot({ path: `${out}/7-dock-panel.png` });
await dockFrame.locator('#hide').click();
// (checkVisibility: a panel is position: fixed, so its offsetParent is always null)
await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="plugin-window"]')].every((w) => !w.checkVisibility() || !w.textContent.includes('Dock Panel Demo')));
check('panel.hide() hides it', true);
// Interacting with the panel may have closed the (modal) Plugins dialog: reopen it.
async function ensureDialog() {
  if (await dlg.isVisible()) return;
  await page.locator('[data-menu="file"]').click();
  await page.getByRole('menuitem', { name: /Plugins/ }).click();
  await dlg.waitFor();
}
await ensureDialog();
await page.getByTestId('plugin-run-Dock Panel Demo').click();
await page.getByText('Dock Panel Demo is already open.').first().waitFor();
check('running again shows the open panel ("already open")', await page.getByTestId('plugin-window').filter({ hasText: 'Dock Panel Demo' }).isVisible());
await dockFrame.locator('#close').click();
await page.getByTestId('plugin-window').filter({ hasText: 'Dock Panel Demo' }).waitFor({ state: 'detached' });
check('orca.close() closes the panel', true);

// ---- disable / enable / reload ----
await ensureDialog();
await page.getByTestId('plugin-row-orca_dock_panel_plugin_any').click();
await page.getByTestId('plugin-toggle-orca_dock_panel_plugin_any').click();
await waitStatus('orca_dock_panel_plugin_any', 'Inactive');
check('deactivate unloads the plugin', true);
await page.getByTestId('plugin-toggle-orca_dock_panel_plugin_any').click();
await waitStatus('orca_dock_panel_plugin_any', 'Activated');
check('activate loads it again', true);
await shot({ path: `${out}/8-dialog-list.png` });
await page.keyboard.press('Escape');

// ---- persistence: reload the page, enabled plugins load on their own ----
await page.reload({ waitUntil: 'load', timeout: 300000 });
await page.waitForFunction(() => !!window.__cubbyProject);
await waitPlugins(page, 'rows.length === 3 && rows.every((r) => r.status === "loaded")');
check('after a reload, the 3 enabled plugins are installed and auto-loaded', true);
await page.evaluate(async () => {
  const g = new TextEncoder().encode('; HEADER_BLOCK_START\nG28\n');
  (await import('/slicer/src/app/slice.ts')).loadPlateGcode(0, g);
});
const persisted = await exportGcode();
check('the stamp selection and config survive the reload', persisted.split('\n')[1] === '; stamped by the CubbySlicer e2e (host=File)', persisted.split('\n')[1]);

// ---- delete ----
await page.locator('[data-menu="file"]').click();
await page.getByRole('menuitem', { name: /Plugins/ }).click();
await dlg.waitFor();
await page.getByTestId('plugin-row-orca_dock_panel_plugin_any').getByRole('button', { name: 'Plugin actions' }).click();
await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
await page.getByTestId('plugin-delete-ok').click();   // the app's shared confirm, on top of the Plugins dialog
try {
  await page.getByTestId('plugin-row-orca_dock_panel_plugin_any').waitFor({ state: 'detached', timeout: 60000 });
} catch (e) {
  console.log('DIAG', await page.evaluate(async () => { const m = await import('/slicer/src/plugins/manager/store.ts'); return JSON.stringify({ rows: m.pluginState.rows.map((r) => `${r.desc.pluginKey}:${r.status}`), logs: m.pluginState.logs.slice(-8).map((l) => l.text) }); }));
  console.log('DIAG sheet', await page.getByTestId('plugin-confirm-sheet').count());
  throw e;
}
check('delete removes the package', true);
await context.close();
lap('main page done');

// ---- without cross-origin isolation ----
({ context, page } = await newPage({ noIsolation: true }));
await page.goto(`${base}?cubby-debug`, { waitUntil: 'load', timeout: 300000 });
await page.waitForFunction(() => !!window.__cubbyProject);
check('second page is NOT cross-origin isolated', !(await page.evaluate(() => crossOriginIsolated)));
// A fresh browser context has its own (empty) OPFS: install the two samples through the manager API.
const installed = await page.evaluate(async (fix) => {
  await (await import('/slicer/src/plugins/index.ts')).ensurePluginsReady();
  const st = await import('/slicer/src/plugins/manager/store.ts');
  for (const f of ['orca_gcode_stamp_plugin_any.py', 'orca_inspector_plugin_any.py']) {
    const src = await (await fetch(`${new URL(document.baseURI).pathname}@fs${fix}/${f}`)).arrayBuffer();
    await st.installPackage(await st.inspectPackage(f, new Uint8Array(src)), 'file');
  }
  const id = { pluginKey: 'orca_gcode_stamp_plugin_any', type: 'slicing-pipeline', name: 'G-code Stamp' };
  await st.saveGlobalConfig(id, { stamp_text: 'stamped by the CubbySlicer e2e' });
  (await import('/slicer/src/plugins/host/postProcess.ts')).setPipelineSelected('G-code Stamp', true);
  return st.pluginState.rows.map((r) => `${r.desc.pluginKey}:${r.status}`).join(', ');
}, FIX);
check('without isolation: the samples install and load', !/error|disabled/.test(installed), installed);
await page.evaluate(async () => {
  const g = new TextEncoder().encode('; HEADER_BLOCK_START\nG28\n');
  (await import('/slicer/src/app/slice.ts')).loadPlateGcode(0, g);
});
const noIso = await exportGcode();
check('without isolation: post-processing still stamps the export', noIso.split('\n')[1] === '; stamped by the CubbySlicer e2e (host=File)', noIso.split('\n')[1]);
await page.keyboard.press('Control+k');
await page.keyboard.type('Orca Inspector');
await page.getByRole('option', { name: /Orca Inspector/ }).first().waitFor();
await page.keyboard.press('Enter');
await confirmPluginRun();
const f2 = page.frameLocator('iframe[title="Orca Inspector"]');
await f2.locator('#content').getByText(/cross-origin isolated/).first().waitFor({ timeout: 60000 });
check('without isolation: the Inspector opens and host reads say they need cross-origin isolation', true);
await shot({ path: `${out}/9-no-isolation.png` });
await context.close();

await browser.close();
moon.srv.close();

const sizes = Object.entries(pyodideBytes.files).sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f} ${(n / 1048576).toFixed(2)} MB`);
console.log(`Pyodide boot (worker, loadPyodide → ready): ${bootMs} ms; install → Activated: ${bootWall} ms`);
console.log(`Downloaded for plugins (decoded bytes): ${(pyodideBytes.total / 1048576).toFixed(2)} MB\n  ${sizes.join('\n  ')}`);
writeFileSync(`${out}/measurements.json`, JSON.stringify({ bootMs, bootWall, pyodideBytes, sliced, engineVersion }, null, 1));
const failed = checks.filter(([, ok]) => !ok);
const ok = failed.length === 0 && problems.length === 0;
console.log(ok ? 'E2E PASS' : `E2E FAIL (${failed.length} checks: ${failed.map(([n]) => n).join('; ')}; ${problems.length} console errors)`);
process.exit(ok ? 0 : 1);
