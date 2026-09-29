/**
 * G-code thumbnails: which ones the printer profile asks for, the comment
 * blocks OrcaSlicer / preFlight write for them, and where in the header they
 * go. Mirrors libslic3r/GCode/Thumbnails.{hpp,cpp} + GCode.cpp of each engine
 * (the WASM bridges export with a null thumbnail callback, so the blocks are
 * added here after the slice, at the exact spot the engine would have).
 */
import type { ConfigValue, EngineId, FlatConfig } from '../../engine/types';
import { isOrcaFamily } from '../../engine/types';

export type ThumbnailFormat = 'PNG' | 'JPG' | 'QOI' | 'BTT_TFT' | 'COLPIC';
const FORMATS: readonly ThumbnailFormat[] = ['PNG', 'JPG', 'QOI', 'BTT_TFT', 'COLPIC'];

export interface ThumbnailSpec { width: number; height: number; format: ThumbnailFormat }

export interface ThumbnailList { specs: ThumbnailSpec[]; errors: Array<'InvalidVal' | 'OutOfRange' | 'InvalidExt'> }

const scalar = (v: ConfigValue | undefined): string => (v === undefined ? '' : Array.isArray(v) ? v.join(',') : v);

/**
 * make_and_check_thumbnail_list(): "96x96/PNG, 300x300/PNG" → specs. An entry
 * without an extension uses the legacy `thumbnails_format` (as
 * handle_legacy_composite does when the preset loads), else PNG. Orca turns
 * an unknown extension into PNG; preFlight skips the entry.
 */
export function parseThumbnailList(thumbnails: string, defaultFormat = '', engine: EngineId = 'orca'): ThumbnailList {
  const specs: ThumbnailSpec[] = [];
  const errors: ThumbnailList['errors'] = [];
  const err = (e: ThumbnailList['errors'][number]) => { if (!errors.includes(e)) errors.push(e); };
  if (!thumbnails) return { specs, errors };
  for (const entry of thumbnails.split(',')) {
    // std::getline(iss, s, 'x') then (…, '/'); istream >> double skips leading blanks.
    const xi = entry.indexOf('x');
    const xs = xi < 0 ? entry : entry.slice(0, xi);
    if (!xs) { err('InvalidVal'); continue; }
    if (xi < 0) { err('InvalidVal'); continue; }
    const rest = entry.slice(xi + 1);
    const si = rest.indexOf('/');
    const ys = si < 0 ? rest : rest.slice(0, si);
    if (!ys) { err('InvalidVal'); continue; }
    const w = leadingNumber(xs), h = leadingNumber(ys);
    if (!(w > 0 && w < 1000 && h > 0 && h < 1000)) { err('OutOfRange'); continue; }
    let ext = si < 0 ? '' : rest.slice(si + 1).split('/')[0];
    if (!ext) ext = defaultFormat || 'PNG';
    ext = ext.toUpperCase();
    // Both engines key the enum "COLPIC" (Orca's label reads "ColPic"; upper-cased above).
    let format = FORMATS.find((f) => f === ext.trim());
    if (!format) {
      err('InvalidExt');
      if (!isOrcaFamily(engine)) continue;
      format = 'PNG';
    }
    specs.push({ width: Math.round(w), height: Math.round(h), format });
  }
  return { specs, errors };
}

/** istream >> double: leading whitespace, then the longest numeric prefix (0 if none). */
function leadingNumber(s: string): number {
  const m = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(s);
  return m ? Number(m[0]) : 0;
}

/** The thumbnails a resolved config asks for (none when `thumbnails` is empty or absent). */
export function thumbnailSpecs(config: FlatConfig, engine: EngineId): ThumbnailList {
  const fmt = scalar(config.thumbnails_format).trim();
  return parseThumbnailList(scalar(config.thumbnails).trim(), fmt, engine);
}

/**
 * Orca writes no G-code thumbnails for Bambu Lab printers (they travel in the
 * 3MF instead); the bridge flags those by printer_model, as does this.
 */
export function engineWritesGcodeThumbnails(config: FlatConfig, engine: EngineId): boolean {
  if (isOrcaFamily(engine) && scalar(config.printer_model).startsWith('Bambu Lab')) return false;
  // preFlight binary G-code carries thumbnails in its own blocks (not supported here).
  if (!isOrcaFamily(engine) && scalar(config.binary_gcode) === '1') return false;
  return true;
}

/** One encoded thumbnail ready to write: base64-able bytes, or text (BTT_TFT / ColPic). */
export interface EncodedThumbnail {
  spec: ThumbnailSpec;
  /** The rendered size (ColPic caps it at 512). */
  width: number;
  height: number;
  bytes?: Uint8Array;
  text?: string;
}

const TAG: Record<'PNG' | 'JPG' | 'QOI', string> = { PNG: 'thumbnail', JPG: 'thumbnail_JPG', QOI: 'thumbnail_QOI' };
const MAX_ROW = 78;

/** export_thumbnails_to_file() of the engine's flavour: the text that goes into the G-code. */
export function formatThumbnailBlocks(list: EncodedThumbnail[], engine: EngineId, toBase64: (b: Uint8Array) => string): string {
  const orca = isOrcaFamily(engine);
  const out: string[] = [];
  let firstColPic = true;
  list.forEach((t, i) => {
    const last = i === list.length - 1;
    const f = t.spec.format;
    if (f === 'BTT_TFT') {
      if (!t.text) return;
      out.push(`;${t.width.toString(16).padStart(4, '0')}${t.height.toString(16).padStart(4, '0')}\r\n`, t.text);
      if (last) out.push('; bigtree thumbnail end\r\n\r\n');
      return;
    }
    if (f === 'COLPIC') {
      if (!t.text) return;
      out.push(`\n\n;${firstColPic ? 'gimage' : 'simage'}:${t.text}\n\n`);
      firstColPic = false;
      return;
    }
    if (!t.bytes?.length) return;
    const tag = TAG[f];
    let enc = toBase64(t.bytes);
    if (orca) out.push('; THUMBNAIL_BLOCK_START\n');
    out.push(`\n;\n; ${tag} begin ${t.width}x${t.height} ${enc.length}\n`);
    while (enc.length > MAX_ROW) { out.push(`; ${enc.slice(0, MAX_ROW)}\n`); enc = enc.slice(MAX_ROW); }
    if (enc.length) out.push(`; ${enc}\n`);
    out.push(orca ? `; ${tag} end\n; THUMBNAIL_BLOCK_END\n\n` : `; ${tag} end\n;\n`);
  });
  return out.join('');
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Byte offset in `gcode` where the engine writes its thumbnails:
 *  - Orca: straight after "; HEADER_BLOCK_END\n\n" (before the extrusion-width
 *    notes); with BTT_TFT in the list Orca drops the header block, so before
 *    the first "; external perimeters extrusion width" line instead.
 *  - preFlight: after the "; generated by …" line and the blank line after it.
 */
export function thumbnailInsertOffset(gcode: Uint8Array, engine: EngineId): number {
  // The header is at the very top; a few KB covers any file_start_gcode.
  const head = dec.decode(gcode.subarray(0, Math.min(gcode.length, 256 * 1024)));
  const at = (charIdx: number) => enc.encode(head.slice(0, charIdx)).length;
  if (isOrcaFamily(engine)) {
    const end = head.indexOf('; HEADER_BLOCK_END\n');
    if (end >= 0) {
      let i = end + '; HEADER_BLOCK_END\n'.length;
      if (head[i] === '\n') i++;
      return at(i);
    }
    const ext = lineStart(head, '; external perimeters extrusion width');
    if (ext >= 0) return at(ext);
    const exe = lineStart(head, '; EXECUTABLE_BLOCK_START');
    return exe >= 0 ? at(exe) : 0;
  }
  const gen = lineStart(head, '; generated by ');
  if (gen >= 0) {
    const nl = head.indexOf('\n', gen);
    if (nl >= 0) {
      let i = nl + 1;
      if (head[i] === '\n') i++;
      return at(i);
    }
  }
  return 0;
}

function lineStart(text: string, prefix: string): number {
  if (text.startsWith(prefix)) return 0;
  const i = text.indexOf(`\n${prefix}`);
  return i < 0 ? -1 : i + 1;
}

/** Whether the G-code already carries thumbnails (e.g. G-code that came in a sliced 3MF). */
export function hasGcodeThumbnails(gcode: Uint8Array): boolean {
  const head = dec.decode(gcode.subarray(0, Math.min(gcode.length, 64 * 1024)));
  return /^; (thumbnail(_JPG|_QOI)?) begin \d+x\d+ \d+$/m.test(head) || /^;(gimage|simage):/m.test(head) || head.includes('; bigtree thumbnail end');
}

/** The G-code with `blocks` inserted where the engine would have written them. */
export function spliceThumbnails(gcode: Uint8Array, blocks: string, engine: EngineId): Uint8Array {
  if (!blocks) return gcode;
  const at = thumbnailInsertOffset(gcode, engine);
  const add = enc.encode(blocks);
  const out = new Uint8Array(gcode.length + add.length);
  out.set(gcode.subarray(0, at), 0);
  out.set(add, at);
  out.set(gcode.subarray(at), at + add.length);
  return out;
}

/** Thumbnails read back out of G-code (tests / debugging). */
export function extractGcodeThumbnails(text: string): Array<{ tag: string; width: number; height: number; base64: string }> {
  const out: Array<{ tag: string; width: number; height: number; base64: string }> = [];
  const re = /^; (thumbnail(?:_JPG|_QOI)?) begin (\d+)x(\d+) (\d+)\n([\s\S]*?)^; \1 end$/gm;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const b64 = m[5].split('\n').map((l) => l.replace(/^; ?/, '')).join('');
    out.push({ tag: m[1], width: +m[2], height: +m[3], base64: b64 });
  }
  return out;
}
