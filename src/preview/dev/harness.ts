/**
 * Dev-only harness: mounts <PreviewView /> standalone and feeds it a fixture
 * (or a synthetic stress print). Open /slicer/src/preview/dev/index.html
 * under `npm run dev`. Query: ?fixture=orca|prusa|orca24|generic, ?gcode=<url>, ?repeat=N
 * (concatenate N copies stacked in Z), ?stress=<millions of segments>.
 */
import { createApp, h } from 'vue';
import ui from '@nuxt/ui/vue-plugin';
import UApp from '@nuxt/ui/components/App.vue';
import '../../ui/theme.css';
import '../../style.css';
import PreviewView from '../PreviewView.vue';
import { activeView, lastSlice, resolvedConfig } from '../../app/state';
import orca from '../__fixtures__/orca-2.3.gcode?raw';
import prusa from '../__fixtures__/prusa-style.gcode?raw';
import orca24 from '../__fixtures__/orca-2.4-style.gcode?raw';
import generic from '../__fixtures__/generic-marlin.gcode?raw';

const q = new URLSearchParams(location.search);
const fixtures: Record<string, string> = { orca, prusa, orca24, generic };

function stress(millions: number): string {
  // Concentric-ish squares with infill, ~N M segments.
  const target = millions * 1e6;
  const out: string[] = ['M83', 'M204 S5000', 'G28'];
  let n = 0, layer = 0;
  while (n < target) {
    const z = 0.2 + layer * 0.2;
    out.push(';LAYER_CHANGE', `;Z:${z.toFixed(2)}`, ';HEIGHT:0.2', `G1 Z${z.toFixed(2)} F600`);
    out.push(';TYPE:External perimeter', ';WIDTH:0.45', 'G1 X20 Y20 F9000');
    for (let k = 0; k <= 400; k++) {
      const a = (k / 400) * Math.PI * 2;
      out.push(`G1 X${(110 + 60 * Math.cos(a)).toFixed(3)} Y${(110 + 60 * Math.sin(a)).toFixed(3)} E0.02 F1800`);
      n++;
    }
    out.push(';TYPE:Internal infill');
    for (let k = 0; k < 2400 && n < target; k++) {
      const y = 60 + (k % 240) * 0.42;
      out.push(`G1 X${k % 2 ? 150 : 70} Y${y.toFixed(2)} E0.3 F6000`);
      n++;
    }
    layer++;
  }
  return out.join('\n');
}

let text = fixtures[q.get('fixture') ?? 'orca'] ?? orca;
// ?gcode=<url> loads any file the dev server can reach (e.g. /slicer/@fs/abs/path.gcode).
if (q.get('gcode')) text = await (await fetch(q.get('gcode')!)).text();
if (q.get('stress')) text = stress(Number(q.get('stress')));
const repeat = Number(q.get('repeat') ?? 1);
if (repeat > 1) {
  const parts: string[] = [];
  for (let i = 0; i < repeat; i++) parts.push(`G92 Z${0}\n` + text.replace(/Z([\d.]+)/g, (_, z) => `Z${(Number(z) + i * 25).toFixed(3)}`).replace(/;Z:([\d.]+)/g, (_, z) => `;Z:${(Number(z) + i * 25).toFixed(3)}`));
  text = parts.join('\n');
}

resolvedConfig.value = { printable_area: '0x0,220x0,220x220,0x220', printable_height: '250', filament_colour: ['#FF8800', '#3399FF'] };
activeView.value = 'preview';
const gcode = new TextEncoder().encode(text);
const t0 = performance.now();
if (!q.has('empty')) lastSlice.value = {
  engine: 'orca',
  gcode,
  report: {
    ok: true, error: null,
    warnings: q.has('warn')
      ? Array.from({ length: Number(q.get('warn')) || 1 }, (_, i) => ({ code: 'test', message: i ? `Warning ${i + 1}: thin wall skipped on object ${i}.` : 'Detected floating regions; support may be needed.' }))
      : [],
    stats: q.has('stats') ? { printTimeSec: 3723, filamentMm: [5230, 1200], filamentCm3: [12.6, 2.9], filamentG: [15.6, 3.6], filamentCost: [0.39, 0.09], layers: 0, maxZ: 0 } : null,
  },
};
(window as unknown as { __t0: number }).__t0 = t0;
document.documentElement.classList.add('dark');
createApp({ render: () => h(UApp, null, { default: () => h(PreviewView) }) }).use(ui).mount('#app');

// Minimal stand-in for the shell's keyboard dispatcher (the harness has no shell).
import { previewActions } from '../actions';
import type { AppContext } from '../../app/actions/context';
const CTX = {} as AppContext;
window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement | null;
  if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.getAttribute('role') === 'slider')) return;
  const key = e.key.toLowerCase();
  const a = previewActions.find((x) => x.binding && x.binding.key === key && !!x.binding.shift === e.shiftKey
    && !!x.binding.ctrlOrMeta === (e.ctrlKey || e.metaKey) && !!x.binding.alt === e.altKey && (x.when?.(CTX) ?? true));
  if (a) { e.preventDefault(); void a.run(CTX); }
});
