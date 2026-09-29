/**
 * Minimal streaming XML tag scanner. Works without DOMParser (not available
 * in workers) and without materialising the whole document as one string, so
 * multi-hundred-MB 3MF model parts are fine. It only reports tags + attributes
 * — text content is ignored — which is all the 3MF core spec needs.
 */
export interface XmlTag {
  /** Local name (namespace prefix stripped). */
  name: string;
  /** Raw qualified name. */
  qname: string;
  close: boolean;
  selfClosing: boolean;
  attrs: string;
}

const ATTR_RE = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

export function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(raw))) out[m[1]] = decodeEntities(m[2] ?? m[3] ?? '');
  return out;
}

/** Fast single-attribute lookup (no entity decoding — use for numbers). */
export function attr(raw: string, name: string): string | undefined {
  let i = raw.indexOf(name);
  while (i >= 0) {
    const before = i === 0 ? ' ' : raw[i - 1];
    let j = i + name.length;
    if (/\s/.test(before)) {
      while (j < raw.length && (raw[j] === ' ' || raw[j] === '\t' || raw[j] === '\n' || raw[j] === '\r')) j++;
      if (raw[j] === '=') {
        j++;
        while (j < raw.length && (raw[j] === ' ' || raw[j] === '\t' || raw[j] === '\n' || raw[j] === '\r')) j++;
        const q = raw[j];
        if (q === '"' || q === "'") {
          const end = raw.indexOf(q, j + 1);
          if (end < 0) return undefined;
          return raw.slice(j + 1, end);
        }
      }
    }
    i = raw.indexOf(name, i + 1);
  }
  return undefined;
}

export function decodeEntities(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    const l = e.toLowerCase();
    if (l === 'amp') return '&';
    if (l === 'lt') return '<';
    if (l === 'gt') return '>';
    if (l === 'quot') return '"';
    if (l === 'apos') return "'";
    const cp = l.startsWith('#x') ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10);
    try { return String.fromCodePoint(cp); } catch { return ''; }
  });
}

export function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]!));
}

const CHUNK = 4 * 1024 * 1024;

/** Scan all tags in `bytes`, calling `onTag` in document order. */
export function scanXml(bytes: Uint8Array, onTag: (t: XmlTag) => void): void {
  const dec = new TextDecoder();
  let buf = '';
  let off = 0;
  let pos = 0;
  const done = () => off >= bytes.length;
  const refill = (): boolean => {
    if (done()) return false;
    const end = Math.min(bytes.length, off + CHUNK);
    buf = buf.slice(pos) + dec.decode(bytes.subarray(off, end), { stream: end < bytes.length });
    pos = 0;
    off = end;
    return true;
  };
  refill();
  for (;;) {
    const lt = buf.indexOf('<', pos);
    if (lt < 0) {
      pos = buf.length;
      if (!refill()) return;
      continue;
    }
    pos = lt;
    if (lt > buf.length - 16 && !done()) { refill(); continue; }
    // Special constructs.
    if (buf.startsWith('<!--', lt) || buf.startsWith('<![CDATA[', lt) || buf.startsWith('<?', lt) || buf.startsWith('<!', lt)) {
      const term = buf.startsWith('<!--', lt) ? '-->' : buf.startsWith('<![CDATA[', lt) ? ']]>' : '>';
      let end = buf.indexOf(term, lt + 2);
      while (end < 0) {
        if (!refill()) return;
        end = buf.indexOf(term, 2);
      }
      pos = end + term.length;
      continue;
    }
    let gt = findTagEnd(buf, lt + 1);
    while (gt < 0) {
      if (!refill()) throw new Error('Malformed XML: unterminated tag');
      gt = findTagEnd(buf, 1);
    }
    const inner = buf.slice(pos + 1, gt);
    pos = gt + 1;
    const close = inner.charCodeAt(0) === 47; /* / */
    const selfClosing = !close && inner.charCodeAt(inner.length - 1) === 47;
    const body = close ? inner.slice(1) : selfClosing ? inner.slice(0, -1) : inner;
    let k = 0;
    while (k < body.length && !/\s/.test(body[k])) k++;
    const qname = body.slice(0, k);
    const colon = qname.indexOf(':');
    onTag({ name: colon >= 0 ? qname.slice(colon + 1) : qname, qname, close, selfClosing, attrs: body.slice(k) });
  }
}

/** Index of the `>` closing a tag, skipping quoted attribute values. -1 if not in buffer. */
function findTagEnd(s: string, from: number): number {
  let q = 0;
  for (let i = from; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (q) { if (c === q) q = 0; continue; }
    if (c === 34 || c === 39) q = c;
    else if (c === 62) return i;
  }
  return -1;
}
