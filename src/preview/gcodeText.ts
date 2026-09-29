/**
 * Read G-code text straight from the byte buffer by offset — never decodes
 * the whole file. Used by the move strip and the virtualized text viewer.
 */

const NL = 10;
const MAX_LINE = 512;
const dec = new TextDecoder();

/** Start offset of the line containing `off`. */
export function lineStartAt(b: Uint8Array, off: number): number {
  let i = Math.min(Math.max(off, 0), b.length);
  const stop = Math.max(0, i - 65536);
  while (i > stop && b[i - 1] !== NL) i--;
  return i;
}

/** End offset (exclusive, before '\n' / '\r\n') of the line starting at `start`. */
export function lineEndFrom(b: Uint8Array, start: number): number {
  let e = b.indexOf(NL, start);
  if (e < 0) e = b.length;
  if (e > start && b[e - 1] === 13) e--;
  return e;
}

export function lineText(b: Uint8Array, start: number): string {
  const e = lineEndFrom(b, start);
  const t = dec.decode(b.subarray(start, Math.min(e, start + MAX_LINE)));
  return e - start > MAX_LINE ? `${t}…` : t;
}

/** Start of the next line, or -1 at EOF. */
export function nextLineStart(b: Uint8Array, start: number): number {
  const e = b.indexOf(NL, start);
  return e < 0 || e + 1 >= b.length ? -1 : e + 1;
}

/** Start of the previous line, or -1 at the beginning. */
export function prevLineStart(b: Uint8Array, start: number): number {
  if (start <= 0) return -1;
  return lineStartAt(b, start - 1);
}

export interface TextLine { lineNo: number; offset: number; text: string }

/**
 * Lines around an anchor line: `before` lines above, `after` below.
 * `anchorLineNo` is the anchor's 0-based line number (for display).
 */
export function linesAround(b: Uint8Array, anchorOffset: number, anchorLineNo: number, before: number, after: number): TextLine[] {
  const start = lineStartAt(b, anchorOffset);
  const up: TextLine[] = [];
  let off = start, no = anchorLineNo;
  for (let k = 0; k < before; k++) {
    const p = prevLineStart(b, off);
    if (p < 0) break;
    off = p; no--;
    up.push({ lineNo: no, offset: off, text: lineText(b, off) });
  }
  up.reverse();
  const out = up;
  out.push({ lineNo: anchorLineNo, offset: start, text: lineText(b, start) });
  off = start; no = anchorLineNo;
  for (let k = 0; k < after; k++) {
    const nx = nextLineStart(b, off);
    if (nx < 0) break;
    off = nx; no++;
    out.push({ lineNo: no, offset: off, text: lineText(b, off) });
  }
  return out;
}

export type TokenKind = 'cmd' | 'axis' | 'num' | 'comment' | 'text';
export interface Token { kind: TokenKind; text: string }

/** Tiny G-code syntax tokenizer for colouring one line. */
export function tokenize(line: string): Token[] {
  const out: Token[] = [];
  const semi = line.indexOf(';');
  const code = semi >= 0 ? line.slice(0, semi) : line;
  const re = /([GMTgmt]\d+(?:\.\d+)?)|([A-Za-z])([-+]?\d*\.?\d+)?|(\s+)|([^\sA-Za-z]+)/g;
  let m: RegExpExecArray | null;
  let first = true;
  while ((m = re.exec(code))) {
    if (m[1] && first) out.push({ kind: 'cmd', text: m[1] });
    else if (m[2] && m[3] !== undefined && !first) { out.push({ kind: 'axis', text: m[2] }); out.push({ kind: 'num', text: m[3] }); }
    else if (m[4]) { out.push({ kind: 'text', text: m[4] }); continue; }
    else out.push({ kind: first ? 'cmd' : 'text', text: m[0] });
    first = false;
  }
  if (semi >= 0) out.push({ kind: 'comment', text: line.slice(semi) });
  return out;
}
