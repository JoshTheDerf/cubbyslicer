/** Sanitisers for the tools' per-object / per-part metadata (text / SVG emboss source, brim ears). */
import type { BrimPoint, EmbossMeta } from '../types';

const MAX_SVG_CHARS = 1024 * 1024;
const fin = (v: unknown, d: number, lo: number, hi: number) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
};

export function sanitizeEmboss(raw: unknown): EmbossMeta | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (o.kind === 'text' && typeof o.text === 'string') {
    return {
      kind: 'text', text: o.text.slice(0, 2000),
      font: typeof o.font === 'string' ? o.font.slice(0, 64) : 'noto-sans',
      bold: o.bold === true, italic: o.italic === true,
      size: fin(o.size, 10, 0.5, 1000), depth: fin(o.depth, 1.5, 0.05, 500),
      letterSpacing: fin(o.letterSpacing, 0, -100, 100), lineSpacing: fin(o.lineSpacing, 0, -100, 100),
      align: o.align === 'left' || o.align === 'right' ? o.align : 'center',
    };
  }
  if (o.kind === 'svg' && typeof o.svg === 'string' && o.svg.length <= MAX_SVG_CHARS) {
    return {
      kind: 'svg', svg: o.svg, name: typeof o.name === 'string' ? o.name.slice(0, 200) : 'SVG',
      width: fin(o.width, 30, 0.5, 5000), depth: fin(o.depth, 2, 0.05, 500),
    };
  }
  return undefined;
}

export function sanitizeBrimPoints(raw: unknown): BrimPoint[] {
  if (!Array.isArray(raw)) return [];
  const out: BrimPoint[] = [];
  for (const r of raw.slice(0, 4096)) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const pos = Array.isArray(o.pos) && o.pos.length === 3 ? o.pos.map(Number) : null;
    const radius = Number(o.radius);
    if (!pos || !pos.every(Number.isFinite) || !(radius > 0 && radius < 1000)) continue;
    out.push({ pos: [pos[0], pos[1], pos[2]], radius });
  }
  return out;
}
