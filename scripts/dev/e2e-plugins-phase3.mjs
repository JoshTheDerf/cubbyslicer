// Browser end-to-end check for the rest of the Orca plugin surface (src/plugins/):
//
//  - preset writes: Orca's UNMODIFIED "Preset Transaction Demo" (sandboxes/) stages
//    layer_height + wall_loops on the active process preset and commits; the preset
//    becomes dirty with those values; a bad key / value / duplicate is refused whole;
//  - Pages: a page tab appears beside Prepare / Preview, its HTML comes from get_ui(),
//    window.orca.postMessage → on_message → post_message → window.orca.onMessage, and
//    a palette entry opens it;
//  - plater().export_3mf_copy(): a project 3MF lands at the plugin's path;
//  - settings: the slicing_pipeline_plugin picker lists loaded capabilities and keeps
//    the `plugins` manifest; a selected capability that is not installed blocks
//    slicing (the missing-plugin gate) until removed; "Configure…" in the Plugin
//    Configuration group edits the process preset's override;
//  - a .whl plugin (built here) installs and runs; plugin.storage() survives a page
//    reload; lifecycle events reach on_lifecycle_event; a progress dialog's Cancel
//    makes update() return False;
//  - blocking waits: Orca's UNMODIFIED "Preset Update Demo" parks execute() in
//    queue.Queue.get() while its window's on_message / on_close callbacks feed it
//    (CallbackChannel): browse, apply a change, close;
//  - a page's get_icon() SVG shows on its tab and its palette entry.
//
//   node scripts/dev/e2e-plugins-phase3.mjs [baseUrl] [out-dir]
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';

const PW = process.env.PLAYWRIGHT ?? 'playwright';
const { chromium } = await import(PW);
const base = process.argv[2] ?? 'http://localhost:5421/slicer/';
const out = resolve(process.argv[3] ?? 'e2e-out/plugins-phase3');
mkdirSync(out, { recursive: true });
const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/orca-plugins');

// ---- test plugins -------------------------------------------------------------------------
const WHEEL_SRC = `import os
import orca

def _path(name):
    return os.path.join(orca.host.plugin.storage(), name)

class WheelDemo(orca.script.ScriptPluginCapabilityBase):
    def get_name(self):
        return "Wheel Demo"
    def execute(self):
        p = _path("count.txt")
        n = int(open(p).read()) + 1 if os.path.exists(p) else 1
        with open(p, "w") as f:
            f.write(str(n))
        ev = open(_path("events.txt")).read().split() if os.path.exists(_path("events.txt")) else []
        return orca.ExecutionResult.success("run %d; events: %s" % (n, ",".join(sorted(set(ev)))))
    def on_lifecycle_event(self, event, ctx):
        with open(_path("events.txt"), "a") as f:
            f.write(event.name + "\\n")

class ProgressDemo(orca.script.ScriptPluginCapabilityBase):
    def get_name(self):
        return "Progress Demo"
    def execute(self):
        import time
        style = orca.host.ui.PD_APP_MODAL | orca.host.ui.PD_CAN_ABORT | orca.host.ui.PD_ELAPSED_TIME
        with orca.host.ui.create_progress_dialog("Progress Demo", "Working", maximum=200, style=style) as pd:
            for i in range(1, 201):
                time.sleep(0.1)
                if not pd.update(i, "Step %d" % i):
                    return orca.ExecutionResult.success("cancelled at step %d" % i)
        return orca.ExecutionResult.success("completed")

@orca.plugin
class Package(orca.base):
    def register_capabilities(self):
        orca.register_capability(WheelDemo)
        orca.register_capability(ProgressDemo)
`;
function wheel() {
  const d = 'cubby_whl_demo-1.0.dist-info';
  return zipSync({
    'cubby_whl_demo/__init__.py': strToU8(WHEEL_SRC),
    [`${d}/METADATA`]: strToU8('Metadata-Version: 2.1\nName: cubby-whl-demo\nVersion: 1.0\nSummary: A wheel plugin for the CubbySlicer e2e\nAuthor: e2e\n'),
    [`${d}/WHEEL`]: strToU8('Wheel-Version: 1.0\nGenerator: e2e\nRoot-Is-Purelib: true\nTag: py3-none-any\n'),
    [`${d}/RECORD`]: strToU8('cubby_whl_demo/__init__.py,,\n'),
  });
}
const PAGE_SRC = `# /// script
# [tool.orcaslicer.plugin]
# name = "Hello Page"
# version = "1.0"
# ///
import orca

PAGE = """<h2>Hello page</h2>
<button id="ping" onclick="orca.postMessage({cmd: 'ping', n: 1})">Ping</button>
<p id="out">waiting</p>
<script>
orca.onMessage(function (m) { document.getElementById('out').textContent = 'pong ' + m.n + ' from ' + m.who; });
</script>"""

ICON = """<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="#009688"/></svg>"""

class HelloPage(orca.pages.PagesPluginCapabilityBase):
    def get_name(self):
        return "Hello Page"
    def get_ui(self):
        return PAGE
    def get_icon(self):
        # Orca strips ".svg" / ".png" and tries the SVG first: the ".png" name finds hello.svg.
        path = orca.host.plugin.storage() + "/hello.svg"
        with open(path, "w") as fh:
            fh.write(ICON)
        return path[:-4] + ".png"
    def on_message(self, data):
        self.post_message({"n": data["n"] + 1, "who": orca.host.app_info()["build"]})

class Copy3mf(orca.script.ScriptPluginCapabilityBase):
    def get_name(self):
        return "Export 3MF Copy"
    def execute(self):
        path = orca.host.plugin.storage() + "/copy.3mf"
        orca.host.plater().export_3mf_copy(path)
        data = open(path, "rb").read()
        return orca.ExecutionResult.success("%d bytes, starts %s" % (len(data), data[:2].decode()))

class BadTransaction(orca.script.ScriptPluginCapabilityBase):
    def get_name(self):
        return "Bad Transaction"
    def execute(self):
        out = []
        for updates in ((("layer_height", "0.3"), ("no_such_key", "1")), (("layer_height", "-5"),), (("wall_loops", "x"),)):
            tx = orca.host.preset.process.begin_update()
            try:
                for k, v in updates:
                    tx.set(k, v)
                tx.commit()
                out.append("applied")
            except Exception as e:
                out.append("%s: %s" % (type(e).__name__, e))
        tx = orca.host.preset.process.begin_update()
        tx.set("layer_height", "0.3")
        try:
            tx.set("layer_height", "0.3")
        except ValueError as e:
            out.append("dup: %s" % e)
        return orca.ExecutionResult.success(" | ".join(out))

@orca.plugin
class Package(orca.base):
    def register_capabilities(self):
        orca.register_capability(HelloPage)
        orca.register_capability(Copy3mf)
        orca.register_capability(BadTransaction)
`;

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
// The palette asks "Run “X”?" before a plugin's command (desktop's Speed Dial): confirm it.
const confirmPluginRun = async () => {
  const ask = page.getByRole('dialog').filter({ hasText: /Run “/ });
  await ask.getByRole('button', { name: /^OK$/ }).click({ timeout: 15000 });
  await ask.waitFor({ state: 'hidden' });
};
page.on('pageerror', (e) => { problems.push(`pageerror: ${e.message}`); console.log('[pageerror]', e.message); });
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' && !/ERR_NAME_NOT_RESOLVED|favicon|Failed to load resource/.test(t)) { problems.push(t); console.log('[console.error]', t); }
});
const shot = async (n) => { try { await page.screenshot({ path: `${out}/${n}.png`, timeout: 15000 }); } catch { /* slow renderer */ } };

async function boot() {
  await page.goto(`${base}?cubby-debug`, { waitUntil: 'load', timeout: 300000 });
  await page.waitForFunction(() => !!window.__cubbyProject, null, { timeout: 300000 });
}
await boot();
await page.evaluate(async () => {
  const root = await navigator.storage.getDirectory();
  try { await root.removeEntry('cubby-plugins', { recursive: true }); } catch { /* none */ }
});
await boot();
lap('app loaded');

const install = (name, bytes) => page.evaluate(async ([n, b]) => {
  await (await import('/slicer/src/plugins/index.ts')).ensurePluginsReady();
  const st = await import('/slicer/src/plugins/manager/store.ts');
  await st.installPackage(await st.inspectPackage(n, new Uint8Array(b)), 'file');
  const row = st.pluginState.rows.find((r) => r.desc.entryFile === n);
  return `${row?.status}:${row?.caps.map((c) => `${c.type}/${c.name}`).join('+')}${row?.error ? ` ${row.error}` : ''}`;
}, [name, [...bytes]]);
const runScript = (pluginKey, name) => page.evaluate(async ([k, n]) => {
  const st = await import('/slicer/src/plugins/manager/store.ts');
  const c = await st.runScriptCapability({ pluginKey: k, type: 'script', name: n });
  return c.error ? `ERROR ${c.error}` : `${c.result?.status}: ${c.result?.message}`;
}, [pluginKey, name]);

// ---- .whl ----
const whlStatus = await install('cubby_whl_demo-1.0-py3-none-any.whl', wheel());
check('a .whl plugin installs and loads', whlStatus.startsWith('loaded:script/Wheel Demo+script/Progress Demo'), whlStatus);
const WK = 'cubby_whl_demo-1.0-py3-none-any';
const r1 = await runScript(WK, 'Wheel Demo');
check('the wheel plugin runs (storage() count 1)', /^Success: run 1;/.test(r1), r1);

// lifecycle: add an object, select a plate, rename it
const STL = (() => {
  const s = 10, v = [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], [0, 0, s], [s, 0, s], [s, s, s], [0, s, s]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const buf = Buffer.alloc(84 + f.length * 50); buf.writeUInt32LE(f.length, 80);
  f.forEach((t, i) => { const o = 84 + i * 50; t.forEach((vi, k) => v[vi].forEach((c, j) => buf.writeFloatLE(c, o + 12 + k * 12 + j * 4))); });
  return [...buf];
})();
await page.evaluate(async (stl) => {
  const { importFiles } = await import('/slicer/src/app/shell/commands/files.ts');
  await importFiles([new File([new Uint8Array(stl)], 'cube.stl')]);
  const proj = await import('/slicer/src/project/store/index.ts');
  proj.addPlate?.();
}, STL);
// Separate turns: a watcher only sees the value it settles on.
await page.waitForTimeout(300);
await page.evaluate(async () => (await import('/slicer/src/project/store/index.ts')).setActivePlate(0));
await page.waitForTimeout(300);
await page.evaluate(async () => (await import('/slicer/src/project/store/index.ts')).setActivePlate(1));
await page.waitForTimeout(1500);
const r2 = await runScript(WK, 'Wheel Demo');
check('lifecycle events reach on_lifecycle_event', /ObjectAdded/.test(r2) && /PlateCreated/.test(r2) && /PlateSelected/.test(r2), r2);

// storage() survives a reload (auto-load, then run again)
await boot();
await page.evaluate(async () => {
  const m = await import('/slicer/src/plugins/manager/store.ts');
  for (let i = 0; i < 300 && !m.pluginState.rows.some((r) => r.status === 'loaded'); i++) await new Promise((r) => setTimeout(r, 1000));
});
const r3 = await runScript(WK, 'Wheel Demo');
check('plugin.storage() survives a page reload', /^Success: run 3;/.test(r3), r3);

// progress dialog Cancel
const prog = page.evaluate(async (k) => {
  const st = await import('/slicer/src/plugins/manager/store.ts');
  const c = await st.runScriptCapability({ pluginKey: k, type: 'script', name: 'Progress Demo' });
  return c.error ? `ERROR ${c.error}` : c.result?.message;
}, WK);
await page.getByTestId('plugin-progress-message').waitFor({ timeout: 60000 });
await page.waitForFunction(() => /Step \d+/.test(document.querySelector('[data-testid="plugin-progress-message"]')?.textContent ?? ''), null, { timeout: 60000 });
await shot('1-progress');
await page.getByTestId('plugin-progress-cancel').click();
const progOut = await prog;
check('progress dialog Cancel → update() returns False', /^cancelled at step \d+$/.test(progOut ?? ''), progOut);
check('the progress dialog closes', await page.getByTestId('plugin-progress-message').count() === 0);
lap('wheel / storage / lifecycle / progress done');

// ---- preset writes: Orca's Preset Transaction Demo, unmodified ----
const demo = readFileSync(join(FIX, 'orca_preset_transaction_demo.py'));
check('Preset Transaction Demo installs', (await install('orca_preset_transaction_demo.py', demo)).startsWith('loaded:script/Preset transaction demo'));
const before = await page.evaluate(async () => {
  const { currentPresets } = await import('/slicer/src/presets/store.ts');
  const p = currentPresets.value;
  p.revertAll('process');
  return { lh: p.value('process', 'layer_height'), wl: p.value('process', 'wall_loops'), dirty: p.dirtyCount('process'), name: p.selectedInfo('process').name };
});
const rd = await runScript('orca_preset_transaction_demo', 'Preset transaction demo');
const after = await page.evaluate(async () => {
  const { currentPresets } = await import('/slicer/src/presets/store.ts');
  const p = currentPresets.value;
  return { lh: p.value('process', 'layer_height'), wl: p.value('process', 'wall_loops'), dirty: p.dirtyCount('process') };
});
check('Preset Transaction Demo commits to the active process preset', /^Success: Committed 2 setting\(s\) to the process preset ".*"; it stays unsaved until you save it\.$/.test(rd), rd);
// (a value equal to the preset's is not an unsaved edit, so dirty counts only the keys that changed)
check('the preset now has layer_height 0.25 and wall_loops 3, unsaved', after.lh === '0.25' && after.wl === '3' && after.dirty === (before.lh === '0.25' ? 0 : 1) + (before.wl === '3' ? 0 : 1), `${JSON.stringify(before)} → ${JSON.stringify(after)}`);

// ---- Pages, export_3mf_copy, bad transactions ----
check('Pages / 3MF / transaction test plugin installs', (await install('hello_page.py', Buffer.from(PAGE_SRC))).startsWith('loaded:pages/Hello Page'));
const bad = await runScript('hello_page', 'Bad Transaction');
check('a transaction with an unknown key is refused whole', /ValueError: Unknown process preset setting "no_such_key"/.test(bad), bad);
check('an invalid value is refused', /ValueError: Invalid value for layer_height/.test(bad.split(' | ')[1] ?? ''), bad.split(' | ')[1]);
check('a duplicate set() is refused with Orca\'s message', /dup: Setting "layer_height" is already staged in this transaction; conflicting duplicate writes to one setting are rejected/.test(bad), '');
const lhAfterBad = await page.evaluate(async () => (await import('/slicer/src/presets/store.ts')).currentPresets.value.value('process', 'layer_height'));
check('nothing of a refused transaction was applied', lhAfterBad === '0.25', String(lhAfterBad));

const c3 = await runScript('hello_page', 'Export 3MF Copy');
check('plater().export_3mf_copy() writes a project 3MF', /^Success: \d{4,} bytes, starts PK$/.test(c3), c3);

const tab = page.getByRole('tab', { name: 'Hello Page' });
await tab.waitFor();
check('a Pages capability gets a tab beside Prepare / Preview', true);
const tabIcon = await tab.locator('img[data-testid="plugin-page-icon"]').getAttribute('src').catch(() => null);
check('the tab shows the page\'s get_icon() SVG', /^data:image\/svg\+xml;base64,/.test(tabIcon ?? '') && /circle/.test(Buffer.from((tabIcon ?? '').split(',')[1] ?? '', 'base64').toString()), (tabIcon ?? 'no icon').slice(0, 40));
await tab.click();
const pf = page.frameLocator('iframe[title="Hello Page"]');
await pf.locator('#ping').click();
await pf.locator('#out').getByText(/^pong 2 from CubbySlicer/).waitFor({ timeout: 30000 });
check('page ↔ plugin messages (postMessage → on_message → post_message → onMessage)', true);
await shot('2-page');
await page.getByRole('tab', { name: 'Prepare' }).click();
await page.keyboard.press('Control+k');
await page.keyboard.type('Hello Page');
await page.getByRole('option', { name: /Hello Page/ }).first().waitFor();
const paletteIcon = await page.getByRole('option', { name: /Hello Page/ }).first().locator('img').getAttribute('src').catch(() => null);
check('the palette entry shows the same icon', !!paletteIcon && paletteIcon === tabIcon);
await page.keyboard.press('Enter');
await confirmPluginRun();
await page.getByTestId('plugin-page-Hello Page').waitFor();
await page.waitForTimeout(500);
const shownPage = await page.evaluate(async () => (await import('/slicer/src/plugins/state.ts')).activePluginPage.value);
const tabSel = await page.getByRole('tab', { name: 'Hello Page' }).getAttribute('aria-selected');
check('the palette opens the page', /Hello Page$/.test(shownPage ?? '') && tabSel === 'true', `active=${JSON.stringify(shownPage)} tab aria-selected=${tabSel}`);
await page.getByRole('tab', { name: 'Prepare' }).click();
lap('pages / presets / 3mf done');

// ---- blocking waits: Orca's Preset Update Demo, unmodified (queue.Queue.get() fed by UI callbacks) ----
const upd = readFileSync(join(FIX, 'orca_preset_update_demo.py'));
check('Preset Update Demo installs', (await install('orca_preset_update_demo.py', upd)).startsWith('loaded:script/Preset editor demo'));
await page.evaluate(async () => (await import('/slicer/src/presets/store.ts')).currentPresets.value.revertAll('process'));
const updRun = page.evaluate(async () => {
  const st = await import('/slicer/src/plugins/manager/store.ts');
  const c = await st.runScriptCapability({ pluginKey: 'orca_preset_update_demo', type: 'script', name: 'Preset editor demo' });
  return c.error ? `ERROR ${c.error}` : `${c.result?.status}: ${c.result?.message}`;
});
const ed = page.frameLocator('iframe[title="Preset editor"]');
// on_message('state') runs while execute() waits in commands.get(): the list fills
await ed.locator('#rows [data-key="wall_loops"]').waitFor({ timeout: 60000 });
check('the editor window lists the process preset (on_message while execute() blocks in Queue.get)', true);
await ed.locator('#search').fill('wall_loops');
await ed.locator('#rows [data-key="wall_loops"]').click();
await ed.locator('#value').fill('5');
await ed.locator('#apply').click();
await ed.locator('#status').getByText(/^Set wall_loops on .+\. Changes remain unsaved\./).waitFor({ timeout: 60000 });
const wl = await page.evaluate(async () => (await import('/slicer/src/presets/store.ts')).currentPresets.value.value('process', 'wall_loops'));
const listed = await ed.locator('#rows [data-key="wall_loops"] .val').innerText();
check('Apply → the blocked execute() gets the command, commits through begin_update(), posts the result', wl === '5' && listed === '5', `wall_loops=${wl}, listed ${listed}`);
await shot('2b-preset-editor');
await ed.locator('#close').click();
const updOut = await Promise.race([updRun, new Promise((r) => setTimeout(() => r('(still running after 60 s)'), 60000))]);
check('Close → on_close enqueues "close" and execute() returns', updOut === 'Success: Preset editor closed.', updOut);
check('the editor window is gone', await page.locator('iframe[title="Preset editor"]').count() === 0);
await page.evaluate(async () => (await import('/slicer/src/presets/store.ts')).currentPresets.value.revertAll('process'));
lap('preset update demo done');

// ---- settings: picker, manifest, missing-plugin gate, Configure ----
const inset = readFileSync(join(FIX, 'orca_inset_plugin_any.py'));
await install('orca_inset_plugin_any.py', inset);
await page.evaluate(async () => {
  const { jumpToSetting } = await import('/slicer/src/settings/useLayout.ts');
  jumpToSetting('slicing_pipeline_plugin');
});
const picker = page.getByTestId('plugin-picker');
await picker.waitFor({ timeout: 60000 });
check('slicing_pipeline_plugin is a settings row with the plugin picker', true);
await picker.getByLabel('Slicing pipeline plugins').click();
await page.getByRole('option', { name: 'Inset Every Slice' }).click();
await page.keyboard.press('Escape');
const sel = await page.evaluate(async () => {
  const { currentPresets } = await import('/slicer/src/presets/store.ts');
  const p = currentPresets.value;
  return { names: p.value('process', 'slicing_pipeline_plugin'), manifest: p.value('process', 'plugins') };
});
check('picking writes slicing_pipeline_plugin and the plugins manifest', JSON.stringify(sel.names) === '["Inset Every Slice"]' && JSON.stringify(sel.manifest) === '["orca_inset_plugin_any;;Inset Every Slice"]', JSON.stringify(sel));
await shot('3-picker');

await page.evaluate(async () => (await import('/slicer/src/plugins/host/pipelineSelection.ts')).setPipelineSelection(['Inset Every Slice', 'Not Installed']));
await page.waitForTimeout(500);
const gate = await page.evaluate(async () => (await import('/slicer/src/settings/validate.ts')).getConfigProblems().filter((p) => p.key === 'slicing_pipeline_plugin').map((p) => p.message));
check('a missing capability blocks slicing (missing-plugin gate)', gate.length === 1 && /“Not Installed” is not installed/.test(gate[0]), gate.join(' / '));
const sliceDisabled = await page.getByRole('button', { name: /Slice plate|Re-slice/ }).first().isDisabled();
check('the Slice button is disabled while it is missing', sliceDisabled);
await page.evaluate(async () => (await import('/slicer/src/settings/useLayout.ts')).jumpToSetting('slicing_pipeline_plugin'));
const rowMsg = await page.getByTestId('plugin-picker-Not Installed').innerText({ timeout: 30000 }).catch((e) => `(${e.message.split('\n')[0]})`);
check('the picker shows what is wrong with it', /is not installed/.test(rowMsg) && /Install…/.test(rowMsg), rowMsg.replace(/\s+/g, ' '));
await page.getByRole('button', { name: 'Remove Not Installed' }).click();
const gate2 = await page.evaluate(async () => (await import('/slicer/src/settings/validate.ts')).getConfigProblems().filter((p) => p.key === 'slicing_pipeline_plugin').length);
check('removing it lifts the gate', gate2 === 0);

await page.evaluate(async () => {
  const { jumpToSetting } = await import('/slicer/src/settings/useLayout.ts');
  jumpToSetting('print_plugin_config_overrides');
});
await page.getByTestId('plugin-configure-Inset Every Slice').click();
const json = page.getByTestId('plugin-config-json');
await json.fill('{ "inset_mm": 0.5 }');
await page.getByTestId('plugin-config-save').click();
await page.waitForTimeout(500);
const ov = await page.evaluate(async () => (await import('/slicer/src/presets/store.ts')).currentPresets.value.value('process', 'print_plugin_config_overrides'));
check('Configure… saves an override in the process preset', /"cap_config":\{"inset_mm":0.5\}/.test(String(ov)) && /"capability":"Inset Every Slice"/.test(String(ov)), String(ov).slice(0, 160));
await shot('4-configure');
await page.keyboard.press('Escape');

await browser.close();
const failed = checks.filter(([, ok]) => !ok);
const ok = failed.length === 0 && problems.length === 0;
console.log(ok ? `E2E PASS (${checks.length} checks)` : `E2E FAIL (${failed.length} checks: ${failed.map(([n]) => n).join('; ')}; ${problems.length} console errors)`);
process.exit(ok ? 0 : 1);
