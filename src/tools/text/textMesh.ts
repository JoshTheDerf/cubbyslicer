/**
 * Text → extruded mesh (Orca GLGizmoEmboss / libslic3r Emboss: letter shapes
 * from the font, polygonised, extruded to the emboss depth).
 *
 * Output is mesh-local mm: the text lies in the XY plane reading along +X,
 * +Y up, centred on its XY bbox, extruded from z = 0 to z = depth.
 */
import type { TextEmboss } from '../../project/types';
import { centerXY, extrudeRegions, flattenCubic, flattenQuad, regionsFromContours, type Contour, type MeshArrays } from '../geom/extrude';
import { familyOf, loadFont, styleFile } from './fonts';
import type { Font, PathCommand } from 'opentype.js';

export const DEFAULT_TEXT: TextEmboss = {
  kind: 'text', text: 'Text', font: 'noto-sans', bold: false, italic: false,
  size: 10, depth: 1.5, letterSpacing: 0, lineSpacing: 0, align: 'center',
};

/** Synthetic italic slant (Orca "skew" ≈ 0.2). */
const SYNTH_SKEW = 0.2;

/** Glyph path commands (y down, opentype convention) → closed contours (y up). */
export function commandsToContours(cmds: PathCommand[], tol: number): Contour[] {
  const out: Contour[] = [];
  let cur: Contour | null = null;
  let last: [number, number] = [0, 0];
  const P = (x = 0, y = 0): [number, number] => [x, -y];
  for (const c of cmds) {
    if (c.type === 'M') {
      if (cur && cur.length > 2) out.push(cur);
      last = P(c.x, c.y);
      cur = [last];
    } else if (c.type === 'L') {
      last = P(c.x, c.y);
      cur?.push(last);
    } else if (c.type === 'Q') {
      if (!cur) continue;
      const p1 = P(c.x, c.y);
      flattenQuad(cur, last, P(c.x1, c.y1), p1, tol);
      last = p1;
    } else if (c.type === 'C') {
      if (!cur) continue;
      const p1 = P(c.x, c.y);
      flattenCubic(cur, last, P(c.x1, c.y1), P(c.x2, c.y2), p1, tol);
      last = p1;
    } else if (c.type === 'Z') {
      if (cur && cur.length > 2) out.push(cur);
      cur = null;
    }
  }
  if (cur && cur.length > 2) out.push(cur);
  return out;
}

/** Lay out and outline text with an already loaded font. */
export function textContours(font: Font, p: Pick<TextEmboss, 'text' | 'size' | 'letterSpacing' | 'lineSpacing' | 'align'>): Contour[] {
  const size = Math.max(0.1, p.size);
  const tol = Math.max(0.005, size / 400);
  const lines = p.text.replace(/\r\n?/g, '\n').split('\n');
  const lineHeight = ((font.ascender - font.descender) / font.unitsPerEm) * size + p.lineSpacing;
  const opts = { kerning: true, letterSpacing: p.letterSpacing / size };
  const perLine: Array<{ contours: Contour[]; width: number }> = lines.map((line, li) => {
    const contours: Contour[] = [];
    const y = li * lineHeight; // opentype y grows downwards
    const width = font.forEachGlyph(line, 0, y, size, opts, (g, gx, gy, fs) => {
      contours.push(...commandsToContours(g.getPath(gx, gy, fs, undefined, font).commands, tol));
    });
    return { contours, width };
  });
  const maxW = Math.max(0, ...perLine.map((l) => l.width));
  const out: Contour[] = [];
  for (const l of perLine) {
    const dx = p.align === 'left' ? 0 : p.align === 'right' ? maxW - l.width : (maxW - l.width) / 2;
    for (const c of l.contours) out.push(dx ? c.map(([x, y]) => [x + dx, y] as [number, number]) : c);
  }
  return out;
}

/** Build the emboss mesh for text parameters (loads the font on first use). */
export async function buildTextMesh(p: TextEmboss): Promise<MeshArrays | null> {
  const fam = familyOf(p.font);
  const { file, synthItalic } = styleFile(fam, p.bold, p.italic);
  const font = await loadFont(file);
  return textMeshFromFont(font, p, synthItalic ? SYNTH_SKEW : 0);
}

export function textMeshFromFont(font: Font, p: TextEmboss, skew = 0): MeshArrays | null {
  if (!p.text.trim()) return null;
  const regions = regionsFromContours(textContours(font, p));
  if (!regions.length) return null;
  const m = extrudeRegions(regions, 0, Math.max(0.05, p.depth), skew);
  centerXY(m);
  return m;
}

/** A short object / part name for text (Orca names text volumes after their content). */
export function textName(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t ? (t.length > 24 ? `${t.slice(0, 24)}…` : t) : 'Text';
}
