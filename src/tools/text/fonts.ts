/**
 * Bundled OFL fonts for the text tool (public/fonts, see public/fonts/OFL.txt).
 * Fonts and opentype.js are fetched lazily the first time text is built.
 */
import type { Font } from 'opentype.js';

export interface FontFamily {
  id: string;
  label: string;
  files: { regular: string; bold?: string; italic?: string; boldItalic?: string };
}

export const FONT_FAMILIES: FontFamily[] = [
  { id: 'noto-sans', label: 'Noto Sans', files: { regular: 'NotoSans-Regular.ttf', bold: 'NotoSans-Bold.ttf', italic: 'NotoSans-Italic.ttf', boldItalic: 'NotoSans-BoldItalic.ttf' } },
  { id: 'noto-serif', label: 'Noto Serif', files: { regular: 'NotoSerif-Regular.ttf', bold: 'NotoSerif-Bold.ttf', italic: 'NotoSerif-Italic.ttf', boldItalic: 'NotoSerif-BoldItalic.ttf' } },
  { id: 'noto-sans-mono', label: 'Noto Sans Mono', files: { regular: 'NotoSansMono-Regular.ttf', bold: 'NotoSansMono-Bold.ttf' } },
];

export function familyOf(id: string): FontFamily {
  return FONT_FAMILIES.find((f) => f.id === id) ?? FONT_FAMILIES[0];
}

/** Which style file to use; missing italic/bold variants fall back (italic is then synthesised by skewing). */
export function styleFile(fam: FontFamily, bold: boolean, italic: boolean): { file: string; synthItalic: boolean } {
  const f = fam.files;
  if (bold && italic && f.boldItalic) return { file: f.boldItalic, synthItalic: false };
  if (italic && !bold && f.italic) return { file: f.italic, synthItalic: false };
  const base = bold && f.bold ? f.bold : f.regular;
  return { file: base, synthItalic: italic };
}

const cache = new Map<string, Promise<Font>>();

/** Custom font loader (tests inject a filesystem reader). */
let fetchBytes: (file: string) => Promise<ArrayBuffer> = async (file) => {
  const rsp = await fetch(`${import.meta.env.BASE_URL}fonts/${file}`);
  if (!rsp.ok) throw new Error(`Couldn't load font ${file} (${rsp.status}).`);
  return rsp.arrayBuffer();
};
export function _setFontFetcher(f: (file: string) => Promise<ArrayBuffer>): void { fetchBytes = f; cache.clear(); }

export function loadFont(file: string): Promise<Font> {
  let p = cache.get(file);
  if (!p) {
    p = (async () => {
      const [{ parse }, bytes] = await Promise.all([import('opentype.js'), fetchBytes(file)]);
      return parse(bytes);
    })();
    p.catch(() => cache.delete(file));
    cache.set(file, p);
  }
  return p;
}
