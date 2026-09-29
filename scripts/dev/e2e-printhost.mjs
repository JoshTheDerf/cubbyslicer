// Browser end-to-end check for the physical printer / print host feature:
// slice a cube, configure a Moonraker and an OctoPrint host through the
// Physical printer dialog, Test, Upload & Print / Upload, and check what the
// (mock) printers received. Also checks the error path for a host without CORS.
//
// The mock hosts are tiny node http servers emulating the Moonraker and
// OctoPrint endpoints the drivers use, answering CORS (incl. preflight) for
// the app origin. The app is cross-origin isolated (COEP require-corp): CORS
// responses satisfy it, no Cross-Origin-Resource-Policy needed.
//
//   node scripts/dev/e2e-printhost.mjs [baseUrl] [out-dir]
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PW = process.env.PLAYWRIGHT ?? 'playwright';
const { chromium } = await import(PW);
const base = process.argv[2] ?? 'http://localhost:5393/slicer/';
const out = resolve(process.argv[3] ?? 'e2e-out/printhost');
mkdirSync(out, { recursive: true });

// ---- mock hosts ---------------------------------------------------------------------
const log = [];
function mock(name, handler, { cors = true } = {}) {
  const srv = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (cors) {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
        res.setHeader('Access-Control-Allow-Headers', 'X-Api-Key, Content-Type, Authorization');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
        res.setHeader('Vary', 'Origin');
      }
      if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
      const entry = { host: name, method: req.method, url: req.url, headers: req.headers, bytes: body.length, fields: {} };
      // Minimal multipart field scrape (enough to check form fields + file name).
      const text = body.toString('latin1');
      for (const m of text.matchAll(/name="([^"]+)"(?:; filename="([^"]+)")?\r\n(?:Content-Type: [^\r\n]+\r\n)?\r\n([\s\S]*?)\r\n--/g)) {
        entry.fields[m[1]] = m[2] ? { filename: m[2], size: m[3].length } : m[3];
      }
      if (req.headers['content-type']?.startsWith('application/json')) entry.json = JSON.parse(text);
      log.push(entry);
      const [status, payload] = handler(req, entry) ?? [404, { error: 'not found' }];
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload));
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, url: `http://127.0.0.1:${srv.address().port}` })));
}

const moon = await mock('moonraker', (req, e) => {
  if (req.url === '/server/info') return [200, { result: { klippy_state: 'ready', moonraker_version: 'v0.9.3-mock' } }];
  if (req.url === '/server/files/upload') return [201, { result: { item: { path: e.fields.file?.filename ?? 'x.gcode', root: 'gcodes' }, print_started: false } }];
  if (req.url === '/printer/print/start') return [200, { result: 'ok' }];
});
const octo = await mock('octoprint', (req, e) => {
  if (req.headers['x-api-key'] !== 'OCTOKEY') return [403, { error: 'Invalid API key' }];
  if (req.url === '/api/version') return [200, { api: '0.1', server: '1.10.2', text: 'OctoPrint 1.10.2' }];
  if (req.url === '/api/files/local') return [201, { done: true, files: { local: { name: e.fields.file?.filename, path: e.fields.file?.filename } } }];
});
const nocors = await mock('nocors', () => [200, { result: { klippy_state: 'ready' } }], { cors: false });
console.log(`mock moonraker ${moon.url} · octoprint ${octo.url} · no-cors ${nocors.url}`);

// A 20 mm cube as binary STL.
function cubeStl(s = 20) {
  const v = [[0,0,0],[s,0,0],[s,s,0],[0,s,0],[0,0,s],[s,0,s],[s,s,s],[0,s,s]];
  const f = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
  const buf = Buffer.alloc(84 + f.length * 50); buf.writeUInt32LE(f.length, 80);
  f.forEach((t, i) => { const o = 84 + i * 50; t.forEach((vi, k) => v[vi].forEach((c, j) => buf.writeFloatLE(c, o + 12 + k * 12 + j * 4))); });
  return buf;
}
writeFileSync(`${out}/cube.stl`, cubeStl());

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => { delete window.showOpenFilePicker; delete window.showSaveFilePicker; }); // <input type=file> path (Playwright file chooser)
await context.addInitScript(() => { try { localStorage.setItem('cubby.setup.done', 'true'); } catch { /* ignore */ } });
const page = await context.newPage();
page.setDefaultTimeout(60000);
const problems = [];
page.on('pageerror', (e) => { problems.push(`pageerror: ${e.message}`); console.log('[pageerror]', e.message); });
page.on('console', (m) => { if (m.type() === 'error' && !/127\.0\.0\.1|CORS|Access-Control|ERR_FAILED|status of 403/.test(m.text())) { problems.push(m.text()); console.log('[console.error]', m.text()); } });

const t0 = Date.now();
const lap = (s) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s  ${s}`);
const checks = [];
const check = (name, ok, extra = '') => { checks.push([name, !!ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); };

await page.goto(`${base}?cubby-debug`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__cubbyProject);
await page.evaluate(() => window.__cubbyProject.resetProject?.());
// Start clean: no saved physical printers.
await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('cubby.printhost.')) localStorage.removeItem(k); });
lap('app loaded');

check('no Print button before a host is configured', (await page.getByRole('button', { name: /^Print$/ }).count()) === 0);

// ---- slice ----
const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: /Import model/ }).first().click()]);
await fc.setFiles(`${out}/cube.stl`);
await page.waitForFunction(() => window.__cubbyProject.objects.value.length >= 1);
await page.keyboard.press('a');
await page.getByRole('button', { name: /Slice plate|Re-slice/ }).first().click();
await page.waitForFunction(() => { const b = document.querySelector('.slicebar'); return b && (b.classList.contains('done') || b.classList.contains('error')); }, null, { timeout: 600000 });
const gcodeBytes = await page.evaluate(async () => (await import('/slicer/src/app/state.ts')).lastSlice.value?.gcode.byteLength ?? 0);
check('sliced', gcodeBytes > 1000, `${gcodeBytes} bytes`);
lap('sliced');

// ---- configure Moonraker via the sidebar printer menu ----
async function openSetup() {
  await page.getByRole('button', { name: 'Printer menu' }).click();
  await page.getByRole('menuitem', { name: /Physical printer/ }).click();
  await page.getByRole('dialog', { name: /Physical printer/ }).waitFor();
}
async function pickType(label) {
  await page.getByRole('combobox', { name: 'Host type' }).click();
  await page.getByRole('option', { name: label, exact: true }).click();
}
const dlg = () => page.getByRole('dialog', { name: /Physical printer/ });

await openSetup();
await pickType('Moonraker (Klipper)');
await dlg().getByRole('textbox', { name: 'Hostname, IP or URL' }).fill(moon.url);
await page.screenshot({ path: `${out}/1-setup-moonraker.png` });
await dlg().getByRole('button', { name: 'Test' }).click();
await dlg().getByText('Connection to Moonraker is working correctly.').waitFor({ timeout: 15000 });
check('Moonraker test passes', true);
check('Moonraker hint shows cors_domains with the origin', await dlg().getByText(`cors_domains:\n    ${new URL(base).origin}`, { exact: false }).count() > 0 || (await dlg().locator('pre').first().innerText()).includes(new URL(base).origin));
await page.screenshot({ path: `${out}/2-test-ok.png` });
await dlg().getByRole('button', { name: 'Save' }).click();
await dlg().waitFor({ state: 'hidden' });

// ---- Print button → send dialog → Upload & Print ----
const printBtn = page.getByRole('button', { name: /^Print$/ });
await printBtn.waitFor();
check('Print button appears next to Export G-code', true);
await printBtn.click();
const send = page.getByRole('dialog', { name: /Print plate/ });
await send.waitFor();
const fname = await send.getByRole('textbox', { name: 'Upload file name' }).inputValue();
check('send dialog pre-fills the G-code file name', /\.gcode$/.test(fname), fname);
await send.getByRole('textbox', { name: 'Upload file name' }).fill('e2e_cube.gcode');
await page.screenshot({ path: `${out}/3-send-dialog.png` });
await send.getByRole('button', { name: 'Upload & Print' }).click();
await page.getByText('Uploaded to Moonraker and started printing.').first().waitFor({ timeout: 30000 });
await page.screenshot({ path: `${out}/4-sent.png` });
const up = log.find((e) => e.host === 'moonraker' && e.url === '/server/files/upload');
const start = log.find((e) => e.host === 'moonraker' && e.url === '/printer/print/start');
check('Moonraker received the file', up && up.fields.file?.filename === 'e2e_cube.gcode' && up.fields.root === 'gcodes' && up.bytes > gcodeBytes, up && `${up.bytes} bytes`);
check('Moonraker got print/start for the uploaded path', start?.json?.filename === 'e2e_cube.gcode');

// ---- OctoPrint: wrong key → auth error; right key → Upload via Ctrl+Shift+G ----
await openSetup();
await pickType('OctoPrint');
await dlg().getByRole('textbox', { name: 'Hostname, IP or URL' }).fill(octo.url);
const key = dlg().locator('input[type="password"]').first();
await key.fill('WRONG');
await dlg().getByRole('button', { name: 'Test' }).click();
await dlg().getByText(/HTTP 403/).waitFor({ timeout: 15000 });
check('OctoPrint wrong key → HTTP 403 auth error', true);
await key.fill('OCTOKEY');
await dlg().getByRole('button', { name: 'Test' }).click();
await dlg().getByText('Connection to OctoPrint is working correctly.').waitFor({ timeout: 15000 });
check('OctoPrint test passes with the key', true);
await dlg().getByRole('button', { name: 'Save' }).click();
await dlg().waitFor({ state: 'hidden' });
await page.waitForTimeout(400); // let the closing dialog hand focus back
await page.keyboard.press('Control+Shift+G');
await send.waitFor();
await send.getByRole('button', { name: 'Upload', exact: true }).click();
await page.getByText('Uploaded to OctoPrint.').first().waitFor({ timeout: 30000 });
const oup = log.find((e) => e.host === 'octoprint' && e.url === '/api/files/local');
check('OctoPrint received the file with print=false and the API key', oup && oup.fields.print === 'false' && oup.headers['x-api-key'] === 'OCTOKEY' && /\.gcode$/.test(oup.fields.file?.filename ?? ''));

// ---- host without CORS → actionable error ----
await openSetup();
await pickType('Moonraker (Klipper)');
await dlg().getByRole('textbox', { name: 'Hostname, IP or URL' }).fill(nocors.url);
await dlg().getByRole('button', { name: 'Test' }).click();
await dlg().getByText(/Couldn’t reach 127\.0\.0\.1/).waitFor({ timeout: 20000 });
check('no-CORS host → network error with CORS guidance', (await dlg().getByText(/allow requests from .* \(CORS\)/).count()) > 0);
await page.screenshot({ path: `${out}/5-nocors.png` });
await dlg().getByRole('button', { name: 'Cancel' }).click();

// ---- palette + menu ----
await page.keyboard.press('Control+k');
await page.keyboard.type('physical printer');
const hasPalette = await page.getByRole('option', { name: /Physical printer/ }).count();
check('palette lists Physical printer…', hasPalette > 0);
await page.keyboard.press('Escape');

await browser.close();
for (const s of [moon, octo, nocors]) s.srv.close();
const failed = checks.filter(([, ok]) => !ok);
const ok = failed.length === 0 && problems.length === 0;
console.log(ok ? 'E2E PASS' : `E2E FAIL (${failed.length} checks, ${problems.length} console errors)`);
process.exit(ok ? 0 : 1);
