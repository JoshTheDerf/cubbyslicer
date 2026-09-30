// Mobile dialog audit: opens every modal / slide-over / popover-style dialog at
// phone sizes and checks that it fits the viewport with nothing overflowing.
//
//   node scripts/dev/e2e-mobile-dialogs.mjs [baseUrl] [out-dir]
//   ONLY=prefs,about  SIZES=360x640,844x390  DESKTOP=1 (also 1440x900, report only)
//
// Per dialog and size it asserts:
//   - document scrollWidth / scrollHeight ≤ viewport (the page behind never scrolls);
//   - no element inside the dialog overflows horizontally (scrollWidth > clientWidth
//     on a non-scrolling box without an ellipsis, a sideways scroll container, or a
//     bounding rect outside the viewport);
//   - the dialog rect fits the viewport and its header / footer buttons are in view;
//   - touch targets ≥ 40 px and text inputs ≥ 16 px font (no iOS zoom);
//   - no nested vertical scroll areas, and the dialog itself never scrolls.
// Every vertically scrolling element is reported (scrollHeight / clientHeight), and a
// screenshot is saved per dialog per size. Exit code 1 when anything failed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');
const base = process.argv[2] ?? 'http://localhost:5393/slicer/';
const out = resolve(process.argv[3] ?? 'e2e-out/mobile-dialogs'); mkdirSync(out, { recursive: true });
const only = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const PHONES = (process.env.SIZES ?? '360x640,390x844,375x667,844x390').split(',').map((s) => { const [w, h] = s.split('x').map(Number); return { w, h }; });
const SIZES = [...PHONES.map((s) => ({ ...s, phone: true })), ...(process.env.DESKTOP ? [{ w: 1440, h: 900, phone: false }] : [])];

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const pageErrors = [];

// ---- helpers ------------------------------------------------------------------------------
const mod = (page, path, fn, arg) => page.evaluate(async ([path, fn, arg]) => {
  // eslint-disable-next-line no-new-func
  const m = await import(`/slicer/src/${path}`); return new Function('m', 'arg', `return (${fn})(m, arg)`)(m, arg);
}, [path, fn.toString(), arg ?? null]);
const uiMod = (page, fn, arg) => page.evaluate(([fn, arg]) => new Function('m', 'arg', `return (${fn})(m, arg)`)(window.__cubbyUi, arg), [fn.toString(), arg ?? null]);
const act = (page, id) => page.evaluate((i) => { const A = window.__cubbyActions; const a = A.getAction(i); if (!a) throw new Error(`no action ${i}`); return A.runAction(a, A.getActionContext()); }, id);
/** Set a script-setup ref on the first mounted component named `name` (Vue dev build). */
const setComp = (page, name, key, value, pick) => page.evaluate(([name, key, value, pick]) => {
  const found = [];
  const walk = (v) => {
    if (!v || typeof v !== 'object') return;
    if (v.component) { const c = v.component; if (c.type.__name === name || c.type.name === name) found.push(c); walk(c.subTree); }
    if (v.suspense) walk(v.suspense.activeBranch);
    if (Array.isArray(v.children)) v.children.forEach(walk);
  };
  walk(document.querySelector('#app').__vue_app__._instance.subTree);
  const c = pick ? found.find((c) => c.props?.[pick[0]] === pick[1]) : found[0];
  if (!c) throw new Error(`component ${name} not mounted (${found.length} found)`);
  if (typeof value === 'string' && value.startsWith('call:')) return c.exposed?.[value.slice(5)]?.(...(key ?? []));
  c.setupState[key] = value;
  return true;
}, [name, key, value, pick ?? null]);

async function waitDialog(page, name) {
  const sel = name ? page.getByRole('dialog', { name }) : page.locator('[role=dialog],[role=alertdialog]').last();
  await sel.first().waitFor({ state: 'visible', timeout: 20000 });
  await page.waitForTimeout(250);
  // Open animations (scale / slide-in) finish before measuring; a busy page (just sliced) runs them late.
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming?.().iterations === Infinity), null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(100);
}
async function noDialogs(page) {
  await page.waitForFunction(() => ![...document.querySelectorAll('[role=dialog],[role=alertdialog]')].some((d) => d.getBoundingClientRect().width > 0), null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(150);
}

/** Measure the topmost open dialog (or `selector`). Runs in the page. */
function measure({ selector, phone }) {
  const vw = window.innerWidth, vh = window.innerHeight;
  const out = { fails: [], warns: [], scrolls: [], dialog: null };
  const desc = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.dataset?.slot) s += `[slot=${el.dataset.slot}]`;
    if (el.getAttribute?.('aria-label')) s += `[aria=${el.getAttribute('aria-label').slice(0, 30)}]`;
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter((c) => !/^(data-|\[)/.test(c)).slice(0, 4).join('.') : '';
    if (cls) s += `.${cls}`;
    const t = (el.innerText ?? el.value ?? '').trim().replace(/\s+/g, ' ').slice(0, 28);
    if (t) s += ` "${t}"`;
    return s;
  };
  const de = document.documentElement;
  if (de.scrollWidth > vw + 1) out.fails.push(`document scrollWidth ${de.scrollWidth} > ${vw}`);
  if (de.scrollHeight > vh + 1) out.fails.push(`document scrollHeight ${de.scrollHeight} > ${vh}`);
  if ((document.scrollingElement?.scrollTop ?? 0) > 0 || (document.scrollingElement?.scrollLeft ?? 0) > 0) out.fails.push('page behind is scrolled');

  const all = [...document.querySelectorAll(selector ?? '[role=dialog],[role=alertdialog]')].filter((d) => { const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  const dlg = all[all.length - 1];
  if (!dlg) { out.fails.push('no visible dialog'); return out; }
  const dr = dlg.getBoundingClientRect();
  out.dialog = { x: Math.round(dr.x), y: Math.round(dr.y), w: Math.round(dr.width), h: Math.round(dr.height), title: dlg.querySelector('[data-slot=title], h2, h3')?.textContent?.trim().slice(0, 60) ?? '' };
  if (dr.left < -1 || dr.top < -1 || dr.right > vw + 1 || dr.bottom > vh + 1) out.fails.push(`dialog rect ${JSON.stringify(out.dialog)} outside ${vw}x${vh}`);

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false;
    if (cs.position === 'absolute' && cs.clip !== 'auto' && cs.clip !== '') return false; // sr-only
    if (el.closest('.sr-only')) return false;
    return true;
  };
  const scrollY = (cs) => cs.overflowY === 'auto' || cs.overflowY === 'scroll';
  const scrollX = (cs) => cs.overflowX === 'auto' || cs.overflowX === 'scroll';
  /** Visible rect after clipping by overflow-hidden / scrolling ancestors inside the dialog. */
  const clipped = (el) => {
    let r = el.getBoundingClientRect(); let L = r.left, R = r.right, T = r.top, B = r.bottom;
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') { const q = a.getBoundingClientRect(); L = Math.max(L, q.left); R = Math.min(R, q.right); T = Math.max(T, q.top); B = Math.min(B, q.bottom); }
      if (a === dlg) break;
    }
    return { L, R, T, B, empty: R - L < 1 || B - T < 1 };
  };

  const els = [dlg, ...dlg.querySelectorAll('*')];
  const scrollers = [];
  for (const el of els) {
    if (el instanceof SVGElement && el.tagName.toLowerCase() !== 'svg') continue;
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    // Horizontal overflow.
    if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && !['input', 'textarea', 'select'].includes(el.tagName.toLowerCase())) {
      const ellipsis = cs.textOverflow === 'ellipsis' || el.querySelector?.(':scope > .truncate');
      if (scrollX(cs)) out.fails.push(`sideways scroll ${desc(el)} (${el.scrollWidth}/${el.clientWidth})`);
      else if (cs.overflowX === 'visible' && !(el instanceof SVGElement)) { /* the overflowing child is caught by its rect below */ }
      else if (!ellipsis && el.scrollWidth - el.clientWidth > 2) out.warns.push(`clipped horizontally ${desc(el)} (${el.scrollWidth}/${el.clientWidth})`);
    }
    const c = clipped(el);
    if (!c.empty && (c.L < -1 || c.R > vw + 1)) out.fails.push(`outside viewport x ${desc(el)} [${Math.round(c.L)}..${Math.round(c.R)}]`);
    // Vertical scrollers.
    if (scrollY(cs) && el.scrollHeight > el.clientHeight + 1) {
      scrollers.push(el);
      out.scrolls.push({ el: desc(el), scrollHeight: el.scrollHeight, clientHeight: el.clientHeight });
    }
    // Touch targets and input font size (phones only).
    if (phone && !c.empty) {
      const tag = el.tagName.toLowerCase();
      const interactive = tag === 'button' || tag === 'a' || tag === 'select' || (tag === 'input' && !['hidden'].includes(el.type)) || tag === 'textarea'
        || ['button', 'checkbox', 'switch', 'radio', 'tab', 'option', 'menuitem', 'combobox', 'slider'].includes(el.getAttribute('role') ?? '');
      const inlineLink = tag === 'a' && cs.display === 'inline'; // links in running text (WCAG 2.5.8 inline exception)
      if (interactive && !inlineLink && !el.disabled && !el.closest('[data-audit-skip]')) {
        const inputLike = (tag === 'input' && !['checkbox', 'radio', 'range', 'color'].includes(el.type)) || tag === 'textarea' || tag === 'select';
        // Hit area: the element, or for a checkbox / switch / radio the row whose label forwards the tap.
        let hw = r.width, hh = r.height;
        const role = el.getAttribute('role');
        if (role === 'checkbox' || role === 'switch' || role === 'radio' || (tag === 'input' && ['checkbox', 'radio'].includes(el.type))) {
          const row = el.closest('label, [data-slot=root], [data-slot=item]');
          const lab = row?.querySelector('label') ?? row;
          if (row && lab) { const q = row.getBoundingClientRect(), l = lab.getBoundingClientRect(); hw = Math.max(hw, q.width); hh = Math.max(hh, Math.min(q.height, l.height)); }
        }
        if (role === 'checkbox' || role === 'switch' || role === 'radio') { // ::after hit-area expansion (style.css)
          const pa = getComputedStyle(el, '::after');
          if (pa.content !== 'none' && pa.position === 'absolute') { hw = Math.max(hw, parseFloat(pa.width) || 0); hh = Math.max(hh, parseFloat(pa.height) || 0); }
        }
        const ab = el.closest('label');
        if (ab && ab !== el) { const q = ab.getBoundingClientRect(); hw = Math.max(hw, q.width); hh = Math.max(hh, q.height); }
        if (inputLike && (tag !== 'input' || !el.readOnly)) {
          const fs = parseFloat(cs.fontSize);
          if (fs < 16) out.fails.push(`input font ${fs}px < 16 ${desc(el)}`);
        }
        if (!inputLike && el.getAttribute('role') !== 'slider' && (hh < 39.5 || hw < 39.5)) out.fails.push(`touch target ${Math.round(hw)}x${Math.round(hh)} ${desc(el)}`);
        if (inputLike && hh < 39.5 && tag !== 'textarea') out.fails.push(`input height ${Math.round(hh)} ${desc(el)}`);
      }
    }
  }
  // Nested scrollers / the whole dialog scrolling.
  for (const s of scrollers) {
    if (s === dlg || s.contains(dlg)) out.fails.push(`the dialog itself scrolls (${s.scrollHeight}/${s.clientHeight})`);
    for (const t of scrollers) if (t !== s && t.contains(s)) out.fails.push(`nested scroll: ${desc(s)} inside ${desc(t)}`);
  }
  // Header / footer / close in view.
  for (const slot of ['header', 'footer']) {
    const h = dlg.querySelector(`[data-slot=${slot}]`);
    if (!h) continue;
    for (const b of [h, ...h.querySelectorAll('button')]) {
      if (!visible(b)) continue;
      const q = b.getBoundingClientRect();
      if (q.top < -1 || q.bottom > vh + 1 || q.left < -1 || q.right > vw + 1) out.fails.push(`${slot} ${b === h ? '' : 'button '}not in view ${desc(b)} [${Math.round(q.top)}..${Math.round(q.bottom)}]`);
    }
  }
  out.fails = [...new Set(out.fails)]; out.warns = [...new Set(out.warns)];
  return out;
}

/**
 * On-screen keyboard: shrink the visual viewport the way iOS / Android do (the
 * --vvh / --vvb variables src/ui/mobileDialog.ts publishes) and check that the
 * dialog's header and footer buttons stay above the keyboard. Runs in the page.
 */
function measureKeyboard({ selector }) {
  const all = [...document.querySelectorAll(selector ?? '[role=dialog],[role=alertdialog]')].filter((d) => d.getBoundingClientRect().width > 0);
  const dlg = all[all.length - 1];
  if (!dlg || !dlg.querySelector('input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([readonly]), textarea')) return null;
  const h = window.innerHeight, kb = Math.round(h * 0.42);
  const root = document.documentElement.style;
  root.setProperty('--vvh', `${h - kb}px`); root.setProperty('--vvb', `${kb}px`); root.setProperty('--vvt', '0px');
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
    const fails = [];
    for (const slot of ['header', 'footer']) {
      for (const b of dlg.querySelectorAll(`[data-slot=${slot}] button`)) {
        const q = b.getBoundingClientRect();
        if (q.width && (q.bottom > h - kb + 1 || q.top < -1)) fails.push(`keyboard hides ${slot} button "${(b.innerText || b.getAttribute('aria-label') || '').trim().slice(0, 24)}" [${Math.round(q.top)}..${Math.round(q.bottom)}] > ${h - kb}`);
      }
    }
    window.dispatchEvent(new Event('resize')); // restore the real values
    resolve(fails);
  })));
}

// ---- dialogs --------------------------------------------------------------------------------
// open(page) opens it; close(page) resets it (default: Escape). `needs`: 'object' | 'sliced' | 'host'.
const closeUi = (fn) => async (page) => { await uiMod(page, fn); };
const DIALOGS = [
  { id: 'drawer', name: 'Settings', phoneOnly: true, open: (p) => uiMod(p, (m) => { m.drawerOpen.value = true; }), close: closeUi((m) => { m.drawerOpen.value = false; }) },
  { id: 'palette', name: 'Command palette', open: (p) => uiMod(p, (m) => { m.ui.paletteOpen = true; }) },
  { id: 'shortcuts', name: 'Keyboard shortcuts', open: (p) => uiMod(p, (m) => { m.ui.shortcutsOpen = true; }) },
  { id: 'about', name: 'Cubby Slicer source and licence', open: (p) => uiMod(p, (m) => { m.ui.aboutOpen = true; }) },
  { id: 'instances', name: 'Set number of instances', needs: 'object', open: (p) => uiMod(p, (m) => { m.ui.instancesOpen = true; }) },
  { id: 'confirm', open: (p) => uiMod(p, (m) => { void m.confirmAction({ title: 'Delete all objects?', message: 'This removes every object from every plate, including “An extremely long object name that goes on and on.stl”. You can undo it.', confirmLabel: 'Delete all', danger: true }); }),
    close: closeUi((m) => { m.confirmRequest.value?.resolve(false); m.confirmRequest.value = null; }) },
  { id: 'prefs', name: 'Preferences', open: (p) => act(p, 'app.preferences') },
  { id: 'flushing', name: 'Flushing volumes for filament change', needs: 'multi', open: (p) => uiMod(p, (m) => m.openDialog('flushing')) },
  { id: 'filamentMap', name: 'Filament grouping', needs: 'multi', open: (p) => uiMod(p, (m) => m.openDialog('filamentMap')) },
  { id: 'objectTable', name: 'Object table', needs: 'object', open: (p) => uiMod(p, (m) => m.openDialog('objectTable')) },
  { id: 'createPrinter', name: 'Create printer', open: (p) => uiMod(p, (m) => m.openDialog('createPrinter')) },
  { id: 'createFilament', name: 'Create filament', open: (p) => uiMod(p, (m) => m.openDialog('createFilament')) },
  { id: 'exportBundle', name: 'Export preset bundle', open: (p) => uiMod(p, (m) => m.openDialog('exportBundle')) },
  { id: 'bedShape', name: 'Bed shape', open: (p) => uiMod(p, (m) => m.openDialog('bedShape')) },
  ...['temp', 'flow', 'pa', 'retraction', 'volumetric', 'vfa', 'cornering', 'is_freq', 'is_damp'].map((c) => ({
    id: `calib-${c}`, open: (p) => uiMod(p, (m, c) => { m.calibUi.open = c; }, c), close: closeUi((m) => { m.calibUi.open = null; }),
  })),
  { id: 'plateSettings', open: (p) => uiMod(p, (m) => { m.plateUi.settingsFor = 0; }), close: closeUi((m) => { m.plateUi.settingsFor = null; }) },
  { id: 'hostSetup', name: 'Physical printer', open: (p) => uiMod(p, (m) => { m.printhostUi.setupOpen = true; }) },
  { id: 'hostSend', needs: 'sliced', open: async (p) => { await uiMod(p, (m) => { m.savePhysicalPrinter({ type: 'moonraker', host: 'http://printer-with-a-rather-long-hostname.local:7125', apiKey: '', user: '', password: '', authType: 'key', printer: '', webUi: '', serial: '', variant: '', wsUrl: '' }); m.printhostUi.sendMode = 'print'; m.printhostUi.sendOpen = true; }); },
    close: closeUi((m) => { m.printhostUi.sendOpen = false; m.removePhysicalPrinter(); }) },
  { id: 'bridge', name: 'Connect to Claude Code', open: (p) => uiMod(p, (m) => { m.bridgeUi.open = true; }) },
  { id: 'bridgeConfirm', open: (p) => uiMod(p, (m) => { m.bridgeUi.confirm = { title: 'Allow Claude Code to slice and send to the printer?', message: 'Claude Code wants to run “slicer_send_to_printer” on plate 1 with host printer-with-a-rather-long-hostname.local.', resolve: () => {} }; }),
    close: closeUi((m) => { m.bridgeUi.confirm = null; }) },
  { id: 'cloudSignIn', open: async (p) => { cloudMock = false; await uiMod(p, (m) => { m.cloudDialog.value = { mode: 'open' }; }); }, close: closeUi((m) => { m.cloudDialog.value = null; }) },
  { id: 'cloudOpen', open: async (p) => { cloudMock = true; await uiMod(p, (m) => { m.cloudDialog.value = { mode: 'open' }; }); await p.getByText('Projects', { exact: true }).first().waitFor(); },
    close: closeUi((m) => { m.cloudDialog.value = null; }) },
  { id: 'cloudSave', open: async (p) => { cloudMock = true; await uiMod(p, (m) => { m.cloudDialog.value = { mode: 'save', suggestedName: 'A very long project name for a benchy with supports' }; }); await p.getByText('Projects', { exact: true }).first().waitFor(); },
    close: async (p) => { await uiMod(p, (m) => { m.cloudDialog.value = null; }); cloudMock = false; } },
  { id: 'localOpen', open: (p) => uiMod(p, (m) => { m.folderDialog.value = { mode: 'open' }; }), close: closeUi((m) => { m.folderDialog.value = null; }) },
  { id: 'localSave', open: (p) => uiMod(p, (m) => { m.folderDialog.value = { mode: 'save', suggestedName: 'A very long project name for a benchy with supports' }; }), close: closeUi((m) => { m.folderDialog.value = null; }) },
  { id: 'localExport', open: (p) => uiMod(p, (m) => { m.folderDialog.value = { mode: 'export', exportKind: 'gcode', suggestedName: 'plate_1_benchy_0.2mm_PLA_2h13m' }; }), close: closeUi((m) => { m.folderDialog.value = null; }) },
  { id: 'step', name: 'STEP import', open: (p) => uiMod(p, (m) => { void m.askStepOptions('A_long_assembly_name_revision_42_final_final.step'); }) },
  { id: 'objColor', name: 'Import OBJ colours', needs: 'object', open: (p) => uiMod(p, (m) => {
    const id = window.__cubbyProject.objects.value[0].id;
    m.objColorRequest.value = { item: { objectId: id, name: 'A long coloured model name.obj', faceGroups: { tri: new Uint32Array(12), groups: [{ name: 'red', color: '#d22' }, { name: 'green', color: '#2d2' }, { name: 'blue', color: '#22d' }, { name: 'white', color: '#eee' }] } }, resolve: () => {} };
  }), close: closeUi((m) => { m.objColorRequest.value = null; }) },
  { id: 'shapePalette', selector: 'section[aria-label="Add shape"]', open: (p) => uiMod(p, (m) => { m.cadUi.paletteOpen = true; }), close: closeUi((m) => { m.cadUi.paletteOpen = false; }) },
  // Popovers.
  { id: 'plateRename', needs: 'object', open: (p) => setComp(p, 'PlateBar', 'renaming', 0), close: (p) => setComp(p, 'PlateBar', 'renaming', null) },
  { id: 'layerHelp', needs: 'object', open: async (p) => {
    await p.evaluate(() => window.__cubbyProject.select([window.__cubbyProject.objects.value[0].id]));
    await uiMod(p, (m) => { m.layersUi.editing = true; });
    await p.getByRole('button', { name: 'Mouse shortcuts' }).click();
  }, close: async (p) => { await p.keyboard.press('Escape'); await p.waitForTimeout(200); await uiMod(p, (m) => { m.layersUi.editing = false; }); } },
  { id: 'previewKeys', needs: 'sliced', preview: true, open: (p) => p.getByRole('button', { name: 'Keyboard shortcuts' }).first().click() },
  // Settings panel dialogs (inside the drawer on phones / tablets).
  { id: 'printerSettings', name: 'Printer settings', drawer: true, open: (p) => uiMod(p, (m) => m.openSettingsTab('printer')), close: closeUi((m) => { m.settingsUi.editor = null; }) },
  { id: 'filamentSettings', name: 'Filament settings', drawer: true, open: (p) => uiMod(p, (m) => m.openSettingsTab('filament')), close: closeUi((m) => { m.settingsUi.editor = null; }) },
  { id: 'settingsSearch', name: 'Search settings', drawer: true, open: (p) => uiMod(p, (m) => { m.panelRequest.focusSearch++; }) },
  { id: 'addPrinter', name: 'Add / remove printers', drawer: true, ready: '.pb .card', open: (p) => uiMod(p, (m) => { m.panelRequest.addPrinter++; }) },
  { id: 'setupWizard', name: /^Set up your printer/, drawer: true, ready: '.pb .card', open: (p) => uiMod(p, (m) => { m.panelRequest.setupWizard++; }), close: closeUi((m) => { m.panelRequest.closeSetupWizard++; }) },
  { id: 'saveAs', name: 'Save as new preset', drawer: true, open: (p) => uiMod(p, (m) => m.requestPreset('saveAs', 'process', 0)) },
  { id: 'gcodeEdit', drawer: true, open: async (p) => { await uiMod(p, (m) => m.jumpToSetting('machine_start_gcode')); await waitDialog(p, 'Printer settings'); await setComp(p, 'GcodeEditor', 'big', true); },
    close: async (p) => { await p.getByRole('button', { name: 'Cancel' }).last().click(); await p.waitForTimeout(300); await uiMod(p, (m) => { m.settingsUi.editor = null; }); } },
  { id: 'excludeArea', drawer: true, open: async (p) => { await uiMod(p, (m) => m.jumpToSetting('bed_exclude_area')); await waitDialog(p, 'Printer settings'); await setComp(p, 'SettingRow', 'bedDialog', true, ['optKey', 'bed_exclude_area']); },
    close: async (p) => { await p.keyboard.press('Escape'); await p.waitForTimeout(300); await uiMod(p, (m) => { m.settingsUi.editor = null; }); } },
  { id: 'mixedEditor', drawer: true, needs: 'fullspectrum', open: (p) => setComp(p, 'MixedFilamentsPanel', 'editing', 'new'),
    close: async (p) => { await p.keyboard.press('Escape'); await p.waitForTimeout(300); } },
  // Preview (needs a sliced plate).
  { id: 'cgText', needs: 'sliced', preview: true, open: (p) => setComp(p, 'CustomGcodeMenu', 'text', { open: true, kind: 'custom', z: 0.2, value: 'M117 A long custom G-code line that keeps going; G1 X10 Y10 F3000 ; comment', isNew: true }),
    close: (p) => setComp(p, 'CustomGcodeMenu', 'text', { open: false, kind: 'custom', z: 0, value: '', isNew: false }) },
  { id: 'cgColor', needs: 'sliced', preview: true, open: (p) => setComp(p, 'CustomGcodeMenu', 'color', { open: true, z: 0.2, value: '#0B2C7A' }), close: (p) => setComp(p, 'CustomGcodeMenu', 'color', { open: false, z: 0, value: '#0B2C7A' }) },
  { id: 'cgJump', needs: 'sliced', preview: true, open: (p) => setComp(p, 'CustomGcodeMenu', 'jump', { open: true, layer: 5 }), close: (p) => setComp(p, 'CustomGcodeMenu', 'jump', { open: false, layer: 1 }) },
];

DIALOGS.sort((a, b) => (a.needs === 'fullspectrum') - (b.needs === 'fullspectrum'));

// ---- preconditions ----------------------------------------------------------------------------
async function addBox(page) {
  await page.evaluate(() => {
    const x = 10, y = 10, z = 10;
    const positions = new Float32Array([-x, -y, -z, x, -y, -z, x, y, -z, -x, y, -z, -x, -y, z, x, -y, z, x, y, z, -x, y, z]);
    const indices = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]);
    const [id] = window.__cubbyProject.addParsedObjects([{ name: 'A_really_long_object_file_name_for_testing_wrapping.stl', positions, indices, transform: null }]);
    window.__cubbyProject.select([id]);
  });
}
async function multi(page) {
  await page.evaluate(async () => { const p = window.__cubbyPresets.currentPresets.value; await p.ready; if (p.selection.filaments.length < 4) await p.setFilamentCount(4); });
  await page.waitForTimeout(1200);
}
async function slice(page) {
  await act(page, 'slice.run');
  await page.waitForFunction(() => { const b = document.querySelector('.slicebar'); return b && /done|error/.test(b.className); }, null, { timeout: 600000 });
}

// CubbyCAD storage mock (signed-in user, workspaces and files with long names) for the cloud dialog.
let cloudMock = false;
const CLOUD_FILES = [
  { path: 'Projects/benchy_with_a_really_long_file_name_v12_final.3mf', size: 1834221, modifiedAt: '2026-09-01T10:00:00Z' },
  { path: 'Projects/calibration-cube.stl', size: 68421, modifiedAt: '2026-08-12T10:00:00Z' },
  { path: 'A folder with a rather long name for testing/part.step', size: 902113, modifiedAt: '2026-07-02T10:00:00Z' },
  ...Array.from({ length: 14 }, (_, i) => ({ path: `model_${i + 1}_with_some_extra_words.stl`, size: 10000 * (i + 1), modifiedAt: '2026-06-01T10:00:00Z' })),
];
async function mockCloud(ctx) {
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await ctx.route(/\/users\/me(\?|$)/, (r) => (cloudMock ? json(r, { data: { id: 'u1', email: 'someone.with.a.long.address@example.com', first_name: 'Sam' } }) : json(r, { errors: [{ message: 'no' }] }, 401)));
  await ctx.route(/\/cubby\/workspaces$/, (r) => (cloudMock ? json(r, { items: [{ id: 'w1', name: 'My workshop workspace with a long name', writable: true }] }) : json(r, { items: [] })));
  await ctx.route(/\/cubby\/workspaces\/w1\/assets/, (r) => json(r, { items: CLOUD_FILES.map((f) => ({ ...f, name: f.path.split('/').pop() })) }));
  await ctx.route(/\/auth$/, (r) => json(r, { data: [{ name: 'google', label: 'google' }] }));
}

async function newPage(size) {
  const ctx = await browser.newContext({ viewport: { width: size.w, height: size.h }, isMobile: size.phone, hasTouch: size.phone, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => { try { localStorage.setItem('cubby.setup.done', 'true'); } catch { /* */ } });
  await mockCloud(ctx);
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);
  page.on('pageerror', (e) => pageErrors.push(`${size.w}x${size.h} ${e.message}`));
  await page.goto(`${base}?cubby-debug`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.__cubbyProject && !!window.__cubbyUi && !!window.__cubbyPresets);
  await page.evaluate(async () => { window.__cubbyProject.resetProject(); await window.__cubbyPresets.currentPresets.value.ready; });
  await page.waitForTimeout(800);
  return page;
}

// ---- run --------------------------------------------------------------------------------------
const report = [];
const want = DIALOGS.filter((d) => !only || only.has(d.id));
for (const size of SIZES) {
  const tag = `${size.w}x${size.h}`;
  const page = await newPage(size);
  const have = new Set();
  const ensure = async (need) => {
    if (!need || have.has(need)) return;
    if (need === 'object' || need === 'sliced') { if (!have.has('object')) { await addBox(page); have.add('object'); } }
    if (need === 'multi') await multi(page);
    if (need === 'fullspectrum') {
      await page.evaluate(async () => { window.__cubbyPresets.setActiveEngine('fullspectrum'); await window.__cubbyPresets.currentPresets.value.ready; });
      await page.waitForTimeout(1500); await multi(page);
    }
    if (need === 'sliced') await slice(page);
    have.add(need);
  };
  const isCompact = await uiMod(page, (m) => m.compact.value);
  for (const d of want) {
    if (d.phoneOnly && !isCompact) continue;
    const row = { dialog: d.id, size: tag };
    try {
      await ensure(d.needs);
      if (d.preview) { await act(page, 'view.preview'); await page.waitForTimeout(800); }
      else await act(page, 'view.prepare').catch(() => {}); // slicing switches to the preview
      if (d.drawer && isCompact) { await uiMod(page, (m) => { m.drawerOpen.value = true; }); await page.waitForTimeout(500); }
      await d.open(page);
      if (d.selector) { await page.locator(d.selector).waitFor({ state: 'visible' }); await page.waitForTimeout(300); } else await waitDialog(page, d.name);
      if (d.ready) { await page.locator(d.ready).first().waitFor({ state: 'visible' }); await page.waitForTimeout(300); }
      const m = await page.evaluate(measure, { selector: d.selector ?? null, phone: size.phone });
      Object.assign(row, m);
      await page.screenshot({ path: `${out}/${d.id}-${tag}.png` });
      if (size.phone && !d.selector) {
        const kb = await page.evaluate(measureKeyboard, { selector: null });
        if (kb?.length) row.fails.push(...kb);
        if (kb) await page.waitForTimeout(100);
      }
    } catch (e) {
      row.fails = [`could not open: ${e.message.split('\n')[0]}`]; row.warns = []; row.scrolls = [];
      await page.screenshot({ path: `${out}/${d.id}-${tag}-error.png` }).catch(() => {});
    }
    try {
      if (d.close) await d.close(page); else await page.keyboard.press('Escape');
      await noDialogs(page);
      if (d.drawer && isCompact) { await uiMod(page, (m) => { m.drawerOpen.value = false; }); await noDialogs(page); }
      if (d.preview) { await act(page, 'view.prepare'); await page.waitForTimeout(300); }
    } catch (e) { console.log(`       (close failed: ${e.message.split('\n')[0]})`); }
    report.push(row);
    const flag = !size.phone ? 'info' : row.fails.length ? 'FAIL' : 'ok  ';
    console.log(`${flag} ${tag.padEnd(8)} ${d.id.padEnd(17)} ${row.dialog && row.dialog.w ? `${row.dialog.w}x${row.dialog.h}` : ''}`
      + `${row.scrolls?.length ? `  scrolls: ${row.scrolls.map((s) => `${s.el.slice(0, 50)} ${s.scrollHeight}/${s.clientHeight}`).join('; ')}` : ''}`);
    for (const f of row.fails ?? []) console.log(`       ✗ ${f}`);
    for (const w of row.warns ?? []) console.log(`       ~ ${w}`);
  }
  await page.context().close();
}
await browser.close();
writeFileSync(`${out}/report.json`, JSON.stringify({ report, pageErrors }, null, 1));
const failed = report.filter((r) => r.fails?.length && !r.size.startsWith('1440'));
console.log(`\n${report.length} checks, ${failed.length} failing (${new Set(failed.map((r) => r.dialog)).size} dialogs)${pageErrors.length ? `, ${pageErrors.length} page errors` : ''}`);
for (const e of pageErrors.slice(0, 10)) console.log(`  [pageerror] ${e}`);
console.log(failed.length ? 'MOBILE DIALOGS FAIL' : 'MOBILE DIALOGS PASS');
process.exit(failed.length ? 1 : 0);
