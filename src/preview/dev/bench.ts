/**
 * Dev-only GPU bench: builds the preview for a fixture (optionally repeated /
 * synthetic stress), then times synchronous frames. Results on window.__bench.
 * Query: ?fixture=orca&repeat=N | ?stress=M, &variant=fragflat|vhide
 */
import '../../ui/theme.css';
import * as THREE from 'three';
import { PreviewRenderer } from '../render/PreviewRenderer';
import { parseGcode } from '../parser/parse';
import orca from '../__fixtures__/orca-2.3.gcode?raw';

const q = new URLSearchParams(location.search);
const out: Record<string, unknown> = new Proxy({} as Record<string, unknown>, {
  set(o, k, v) { o[k as string] = v; console.log(`[bench] ${String(k)} = ${JSON.stringify(v)}`); return true; },
});
(window as unknown as { __bench: unknown }).__bench = out;

function stress(millions: number): string {
  const target = millions * 1e6;
  const lines: string[] = ['M83', 'M204 S5000'];
  let n = 0, layer = 0;
  while (n < target) {
    const z = 0.2 + layer * 0.2;
    lines.push(';LAYER_CHANGE', `;Z:${z.toFixed(2)}`, ';HEIGHT:0.2', `G1 Z${z.toFixed(2)} F600`, ';TYPE:External perimeter', ';WIDTH:0.45');
    for (let k = 0; k <= 400; k++) { const a = (k / 400) * Math.PI * 2; lines.push(`G1 X${(110 + 60 * Math.cos(a)).toFixed(3)} Y${(110 + 60 * Math.sin(a)).toFixed(3)} E0.02 F1800`); n++; }
    lines.push(';TYPE:Internal infill');
    for (let k = 0; k < 2400 && n < target; k++) { lines.push(`G1 X${k % 2 ? 150 : 70} Y${(60 + (k % 240) * 0.42).toFixed(2)} E0.3 F6000`); n++; }
    layer++;
  }
  return lines.join('\n');
}

async function main() {
  let text = orca;
  if (q.get('stress')) text = stress(Number(q.get('stress')));
  const rep = Number(q.get('repeat') ?? 1);
  const bytesIn = new TextEncoder().encode(text);
  let bytes = bytesIn;
  if (rep > 1) { bytes = new Uint8Array(bytesIn.length * rep); for (let i = 0; i < rep; i++) bytes.set(bytesIn, i * bytesIn.length); }
  let t = performance.now();
  const p = parseGcode(bytes);
  out.parseMs = performance.now() - t;
  out.segments = p.segmentCount;
  out.mb = bytes.length / 1e6;
  const r = new PreviewRenderer(document.getElementById('host')!);
  r.setBed({ polygon: [[0, 0], [220, 0], [220, 220], [0, 220]], min: [0, 0], max: [220, 220], maxHeight: 250, excludeAreas: [] });
  r.setRange(0, -1);
  t = performance.now();
  await r.setData(p);
  out.buildMs = performance.now() - t;
  out.memory = r.memoryStats();
  const v = q.get('variant');
  r.scene.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
    if (!m || !o.name.startsWith('gcode-chunk')) return;
    if (v === 'fragflat') { m.fragmentShader = 'layout(location = 0) out highp vec4 outColor;\nflat in vec3 vColor;\nvoid main(){ outColor = vec4(vColor, 1.0); }'; m.needsUpdate = true; }
    if (v === 'vhide') { m.vertexShader = m.vertexShader.replace('int idx = uBase + gl_InstanceID;', 'hide(); return;\n  int idx = uBase + gl_InstanceID;'); m.needsUpdate = true; }
  });
  out.bedFrame = [r.benchFrame(), r.benchFrame()];
  if (v === 'baseline') {
    const im = new THREE.InstancedMesh(new THREE.BoxGeometry(0.4, 0.4, 0.2), new THREE.MeshBasicMaterial({ color: 0xff8800 }), p.segmentCount);
    const mtx = new THREE.Matrix4();
    for (let i = 0; i < p.segmentCount; i++) { mtx.makeTranslation(p.points[i * 3], p.points[i * 3 + 1], p.points[i * 3 + 2]); im.setMatrixAt(i, mtx); }
    r.scene.add(im);
    r.view('iso');
    const fr: number[] = [];
    for (let i = 0; i < 2; i++) { fr.push(r.benchFrame()); console.log(`[bench] baseline frame ${fr[i].toFixed(0)} ms`); }
    out.done = true;
    return;
  }
  r.setRange(0, p.segmentCount - 1, p.layerStart[p.layerCount - 1]);
  r.view('iso');
  const frames: number[] = [];
  for (let i = 0; i < Number(q.get('frames') ?? 4); i++) { frames.push(r.benchFrame()); console.log(`[bench] frame ${frames[i].toFixed(0)} ms`); }
  out.frames = frames.map((x) => Math.round(x));
  out.done = true;
}
main().catch((e) => { out.error = String(e); });
