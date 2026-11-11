/**
 * Text and SVG outlines for a sketch (Orca's Text / SVG sketch tools, SketchImport): rigid
 * regions — outer loop + holes, millimetres, centred on their bounding box like Orca's
 * `text_to_regions` / `svg_to_regions` — written to the Sketch feature's `imported_regions` with
 * `import_offset` placing them. The kernel has no FreeType / nanosvg (contract: the host
 * vectorises), so text comes from the app's fonts (opentype, the Text tool's outlines) and SVG
 * from the browser's own geometry (every shape element sampled along its length, transforms
 * applied, 96 dpi → mm, y up). The solver never sees them.
 */
import { regionsFromContours, type Contour } from '../../tools/geom/extrude';
import { familyOf, loadFont, styleFile } from '../../tools/text/fonts';
import { textContours } from '../../tools/text/textMesh';
import type { V2 } from './model';

export type Regions = V2[][][];

function toRegions(contours: Contour[]): Regions {
  const regs = regionsFromContours(contours);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of regs) for (const [x, y] of r.outer) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const shift = (c: Contour): V2[] => c.map(([x, y]) => [+(x - cx).toFixed(4), +(y - cy).toFixed(4)] as V2);
  return regs.map((r) => [shift(r.outer), ...r.holes.map(shift)]);
}

export async function textRegions(text: string, size: number, fontId = 'noto-sans', bold = false): Promise<Regions> {
  const fam = familyOf(fontId);
  const font = await loadFont(styleFile(fam, bold, false).file);
  return toRegions(textContours(font, { text, size, letterSpacing: 0, lineSpacing: 0, align: 'center' }));
}

const PX_MM = 25.4 / 96;

/** SVG source → regions (fills; strokes are not outlines). `scale` multiplies the 96-dpi size. */
export function svgRegions(svg: string, scale = 1, tolMm = 0.3): Regions {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = doc.documentElement;
  if (root.nodeName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) throw new Error('That isn’t an SVG file');
  // Mount off-screen so the browser computes lengths and transforms.
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-10000px;top:0;width:0;height:0;overflow:hidden;visibility:hidden';
  const live = document.importNode(root, true) as unknown as SVGSVGElement;
  host.appendChild(live);
  document.body.appendChild(host);
  try {
    // A viewBox maps user units to the width / height; mm / in / cm units on the root are honoured.
    const unit = (v: string | null) => { const m = /^([\d.]+)\s*(mm|cm|in|pt|px)?$/.exec(v ?? ''); if (!m) return null; const n = Number(m[1]); return m[2] === 'mm' ? n : m[2] === 'cm' ? n * 10 : m[2] === 'in' ? n * 25.4 : m[2] === 'pt' ? (n * 25.4) / 72 : n * PX_MM; };
    const vb = live.viewBox?.baseVal;
    const wmm = unit(live.getAttribute('width'));
    const userMm = vb && vb.width && wmm ? wmm / vb.width : PX_MM;
    const k = userMm * scale;
    const contours: Contour[] = [];
    const rootInv = live.getCTM()?.inverse();
    for (const el of Array.from(live.querySelectorAll('path, rect, circle, ellipse, polygon, polyline'))) {
      const g = el as SVGGeometryElement;
      if (g.closest('defs, clipPath, mask')) continue;
      const fill = getComputedStyle(g).fill;
      if (fill === 'none' && el.nodeName !== 'path') continue;
      const m = rootInv && g.getCTM() ? rootInv.multiply(g.getCTM()!) : null;
      const pieces = el.nodeName === 'path' ? subpaths(g as SVGPathElement) : [g];
      for (const p of pieces) {
        const L = p.getTotalLength();
        if (!(L > 0)) continue;
        const n = Math.max(8, Math.min(4000, Math.ceil((L * k) / tolMm)));
        const c: Contour = [];
        for (let i = 0; i < n; i++) {
          let q = p.getPointAtLength((L * i) / n);
          if (m) q = q.matrixTransform(m);
          c.push([q.x * k, -q.y * k]);
        }
        if (c.length > 2) contours.push(c);
        if (p !== g) p.remove();
      }
    }
    if (!contours.length) throw new Error('No filled shapes in that SVG');
    return toRegions(contours);
  } finally {
    host.remove();
  }
}

/** A path's subpaths as separate (temporary) path elements: each starts where the browser says it does. */
function subpaths(path: SVGPathElement): SVGPathElement[] {
  const d = path.getAttribute('d') ?? '';
  const parts = d.split(/(?=[Mm])/).map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 1) return [path];
  const out: SVGPathElement[] = [];
  let prefix = '';
  for (const part of parts) {
    let start = { x: 0, y: 0 };
    if (prefix) {
      const probe = path.cloneNode() as SVGPathElement;
      probe.setAttribute('d', prefix);
      path.parentNode!.appendChild(probe);
      const L = probe.getTotalLength();
      start = probe.getPointAtLength(L);
      probe.remove();
    }
    // A relative move is relative to the previous subpath's end: make it absolute.
    const nums = /^[Mm]\s*(-?[\d.]+(?:e-?\d+)?)[\s,]*(-?[\d.]+(?:e-?\d+)?)/.exec(part);
    let own = part;
    if (nums && part[0] === 'm') own = `M${start.x + Number(nums[1])} ${start.y + Number(nums[2])}${part.slice(nums[0].length).replace(/^\s*(?=-?\d)/, 'l')}`;
    else if (nums) own = `M${nums[1]} ${nums[2]}${part.slice(nums[0].length).replace(/^\s*(?=-?\d)/, 'L')}`;
    const el = path.cloneNode() as SVGPathElement;
    el.setAttribute('d', own);
    path.parentNode!.appendChild(el);
    out.push(el);
    prefix += part;
  }
  return out;
}
