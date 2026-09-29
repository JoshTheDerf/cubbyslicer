// First-run flow: fresh browser → setup wizard → pick printer + filament → slice.
//   node scripts/dev/e2e-first-run.mjs [baseUrl] [out-dir]
import { mkdirSync, writeFileSync } from 'node:fs';
const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');
const base = process.argv[2] ?? 'http://localhost:5393/slicer/';
const out = process.argv[3] ?? 'e2e-out'; mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => { delete window.showOpenFilePicker; delete window.showSaveFilePicker; }); // <input type=file> path (Playwright file chooser)
const page = await ctx.newPage();
page.setDefaultTimeout(120000);
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto(base, { waitUntil: 'networkidle' });
const dlg = page.getByRole('dialog', { name: 'Set up your printer' });
await dlg.waitFor();
await page.waitForTimeout(800); // open animation
await page.screenshot({ path: `${out}/w1-printer.png` });
await dlg.getByPlaceholder('Vendor…').fill('Prusa');
await dlg.getByRole('button', { name: 'Prusa', exact: true }).first().click();
await dlg.locator('.card', { has: page.locator('span', { hasText: /^\s*Prusa MK4\s*$/ }) }).first().click();
await dlg.locator('.variant', { hasText: '0.4 mm nozzle' }).getByRole('button', { name: 'Use' }).click();
await dlg.getByText('Filaments compatible with').waitFor();
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/w2-filament.png` });
await dlg.getByPlaceholder('Search filaments…').fill('PETG');
await dlg.locator('.fil').first().click();
const chosen = await dlg.locator('.fil.on').first().innerText();
await dlg.getByRole('button', { name: 'Next →' }).click();
await page.screenshot({ path: `${out}/w3-done.png` });
const summary = (await dlg.locator('dl').innerText()).replace(/\s+/g, ' ');
await dlg.getByRole('button', { name: 'Start slicing' }).click();
await dlg.waitFor({ state: 'detached' });
// import a cube and slice with the chosen presets
const s = 20, v = [[0,0,0],[s,0,0],[s,s,0],[0,s,0],[0,0,s],[s,0,s],[s,s,s],[0,s,s]];
const f = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
const buf = Buffer.alloc(84 + f.length * 50); buf.writeUInt32LE(f.length, 80);
f.forEach((t, i) => t.forEach((vi, k) => v[vi].forEach((c, j) => buf.writeFloatLE(c, 84 + i * 50 + 12 + k * 12 + j * 4))));
writeFileSync(`${out}/cube.stl`, buf);
const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: /Import model/ }).first().click()]);
await fc.setFiles(`${out}/cube.stl`);
await page.waitForTimeout(1500);
await page.getByRole('button', { name: /Slice plate/ }).click();
await page.waitForFunction(() => { const b = document.querySelector('.slicebar'); return b && /done|error/.test(b.className); }, null, { timeout: 600000 });
const bar = (await page.locator('.slicebar').innerText()).replace(/\s+/g, ' ');
// reload: wizard must NOT reappear, selection must persist
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
const reopened = await dlg.count();
// the saved printer is restored once the catalog has loaded
await page.waitForFunction(() => /MK4/.test(document.querySelector('.preset-row[data-kind="printer"]')?.textContent ?? ''), null, { timeout: 30000 }).catch(() => {});
const printerAfter = await page.locator('.preset-row[data-kind="printer"]').first().innerText().catch(() => '');
await browser.close();
console.log(JSON.stringify({ chosen, summary, bar, reopenedAfterReload: reopened, printerAfter: printerAfter.replace(/\s+/g, ' ').slice(0, 80), errs }, null, 1));
const ok = /Prusa MK4/.test(summary) && /PETG/i.test(summary) && /layers/i.test(bar) && reopened === 0 && /MK4/.test(printerAfter) && errs.length === 0;
console.log(ok ? 'FIRST-RUN E2E PASS' : 'FIRST-RUN E2E FAIL');
process.exit(ok ? 0 : 1);
