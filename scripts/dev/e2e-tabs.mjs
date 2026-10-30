/**
 * Several tabs e2e: each tab keeps its own plate and printer selection across
 * reloads, a new tab picks up a closed tab's plate, a duplicated tab copies
 * its source, and physical printers (two of one model) are shared by all tabs
 * while each tab sends to its own.
 *
 *   npx vite --port 5397 --strictPort
 *   node scripts/dev/e2e-tabs.mjs [http://localhost:5397/slicer/]
 *
 * HEADED=1 shows the browser.
 */
const { chromium } = await import('playwright');

const SLICER_URL = process.argv[2] ?? process.env.SLICER_URL ?? 'http://localhost:5397/slicer/';
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`, ...a);
let failures = 0;
const check = (cond, what) => { if (cond) log(`  ok   ${what}`); else { failures++; log(`  FAIL ${what}`); } };

const browser = await chromium.launch({ headless: !process.env.HEADED });
const ctx = await browser.newContext();
const errors = [];

async function openTab(init, arg) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  if (init) await page.addInitScript(init, arg);
  await page.goto(SLICER_URL);
  await ready(page);
  return page;
}

async function ready(page) {
  await page.waitForFunction(() => window.__cubbyProject && window.__cubbyPresets && window.__cubbyUi, null, { timeout: 60000 });
  await page.waitForFunction(() => window.__cubbyPresets.currentPresets.value.loading.value === 0 && window.__cubbyPresets.currentPresets.value.printerInfos.value.length > 1, null, { timeout: 120000 });
  await page.waitForTimeout(1500);
}

/** Add a named box and select printer preset #`printerIndex` of the printer list. */
async function setUp(page, name, printerIndex) {
  return page.evaluate(async ([name, i]) => {
    const p = window.__cubbyProject;
    const s = 10;
    const pos = new Float32Array([0, 0, 0, s, 0, 0, s, s, 0, 0, s, 0, 0, 0, s, s, 0, s, s, s, s, 0, s, s]);
    const idx = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]);
    p.addParsedObjects([{ name, positions: pos, indices: idx, transform: null }]);
    const pr = window.__cubbyPresets.currentPresets.value;
    // First run lists the default printer and Orca's generic Klipper printer.
    const id = pr.printerInfos.value[i].id;
    await pr.selectPrinter(id);
    return id;
  }, [name, printerIndex]);
}

const state = (page) => page.evaluate(() => ({
  objects: window.__cubbyProject.objects.value.map((o) => o.name),
  printer: window.__cubbyPresets.currentPresets.value.selection.printer,
}));
const settle = (page) => page.waitForTimeout(2500); // autosave debounce (1.5 s) + presets (0.3 s)

log('two tabs, different plates and printers');
const a = await openTab();
const b = await openTab();
const printerA = await setUp(a, 'Cube A', 1);
const printerB = await setUp(b, 'Cube B', 0);
await settle(a); await settle(b);
check(printerA !== printerB, `different printers (${printerA} / ${printerB})`);

log('reloading each tab keeps its own plate and printer');
await a.reload(); await ready(a);
await b.reload(); await ready(b);
let sa = await state(a), sb = await state(b);
check(JSON.stringify(sa.objects) === '["Cube A"]', `tab A: ${JSON.stringify(sa.objects)}`);
check(JSON.stringify(sb.objects) === '["Cube B"]', `tab B: ${JSON.stringify(sb.objects)}`);
check(sa.printer === printerA, `tab A printer ${sa.printer}`);
check(sb.printer === printerB, `tab B printer ${sb.printer}`);

log('a duplicated tab copies its source');
const aId = await a.evaluate(() => sessionStorage.getItem('cubby.tab.id'));
const dup = await openTab((id) => { if (!sessionStorage.getItem('cubby.tab.id')) sessionStorage.setItem('cubby.tab.id', id); }, aId);
const sd = await state(dup);
const dupId = await dup.evaluate(() => sessionStorage.getItem('cubby.tab.id'));
check(JSON.stringify(sd.objects) === '["Cube A"]' && sd.printer === printerA, `copy of A (${JSON.stringify(sd.objects)}, ${sd.printer})`);
check(dupId !== aId, 'took a new tab id');
await dup.close();

log('a new tab picks up the closed tab’s plate, once');
await b.close();
await a.waitForTimeout(300);
const c = await openTab();
const sc = await state(c);
check(JSON.stringify(sc.objects) === '["Cube B"]' && sc.printer === printerB, `tab C adopted B (${JSON.stringify(sc.objects)}, ${sc.printer})`);
const d = await openTab();
const sdd = await state(d);
check(!sdd.objects.includes('Cube B'), `tab D did not take B’s plate too (${JSON.stringify(sdd.objects)})`);
await d.close();

log('two physical printers of one model, one per tab');
await a.evaluate(() => window.__cubbyPresets.currentPresets.value.selectPrinter(window.__cubbyPresets.currentPresets.value.printerInfos.value[1].id));
await c.evaluate(() => window.__cubbyPresets.currentPresets.value.selectPrinter(window.__cubbyPresets.currentPresets.value.printerInfos.value[1].id));
await a.waitForTimeout(500);
const cfg = (host) => ({ type: 'moonraker', host, apiKey: '', user: '', password: '', authType: 'key', printer: '', webUi: '', serial: '', variant: '', wsUrl: '' });
const ids = await a.evaluate(([c1, c2]) => {
  const m = window.__cubbyUi;
  const x = m.savePhysicalPrinter(c1, { id: null, name: 'Left' });
  const y = m.savePhysicalPrinter(c2, { id: null, name: 'Right' });
  return [x.id, y.id];
}, [cfg('http://left.local'), cfg('http://right.local')]);
await c.waitForFunction(() => window.__cubbyUi.printerChoices.value.length === 2, null, { timeout: 5000 }).catch(() => {});
const choicesC = await c.evaluate(() => window.__cubbyUi.printerChoices.value.map((x) => x.name));
check(JSON.stringify(choicesC) === '["Left","Right"]', `tab C sees both (${JSON.stringify(choicesC)})`);
await c.evaluate((id) => window.__cubbyUi.selectDevice(id), ids[0]);
const activeA = await a.evaluate(() => window.__cubbyUi.physicalPrinter.value?.name);
const activeC = await c.evaluate(() => window.__cubbyUi.physicalPrinter.value?.name);
check(activeA === 'Right' && activeC === 'Left', `A sends to ${activeA}, C to ${activeC}`);
await a.reload(); await ready(a);
check(await a.evaluate(() => window.__cubbyUi.physicalPrinter.value?.name) === 'Right', 'tab A still sends to Right after reload');

check(!errors.length, `no page errors ${errors.join('; ')}`);
await browser.close();
log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
