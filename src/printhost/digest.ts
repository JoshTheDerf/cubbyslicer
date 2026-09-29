/**
 * HTTP Digest authentication (RFC 7616, MD5 / MD5-sess, qop=auth), as libcurl
 * does it for Orca's PrusaLink "HTTP digest" authorization type.
 *
 * Cross-origin caveat: the browser only lets us read the 401's
 * WWW-Authenticate header when the printer lists it in
 * Access-Control-Expose-Headers. When it doesn't, `parseChallenge` gets null
 * and the caller reports that digest auth isn't possible from a browser.
 */
import { md5Hex } from './md5';

export interface DigestChallenge {
  realm: string;
  nonce: string;
  qop?: string;
  opaque?: string;
  algorithm?: string;
}

export function parseChallenge(header: string | null): DigestChallenge | null {
  if (!header) return null;
  const m = header.match(/Digest\s+(.*)$/i);
  if (!m) return null;
  const params: Record<string, string> = {};
  const re = /([a-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]*))/gi;
  let r: RegExpExecArray | null;
  while ((r = re.exec(m[1]))) params[r[1].toLowerCase()] = (r[2] ?? r[3] ?? '').replace(/\\(.)/g, '$1');
  if (!params.nonce) return null;
  return { realm: params.realm ?? '', nonce: params.nonce, qop: params.qop, opaque: params.opaque, algorithm: params.algorithm };
}

function randomHex(n: number): string {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** Authorization header value for one request. `nc` is the nonce count (1, 2, ...). */
export function digestAuthorization(
  ch: DigestChallenge, user: string, password: string, method: string, url: string, nc = 1, cnonce = randomHex(8),
): string {
  const u = new URL(url);
  const uri = u.pathname + u.search;
  const alg = (ch.algorithm ?? 'MD5').toUpperCase();
  let ha1 = md5Hex(`${user}:${ch.realm}:${password}`);
  if (alg === 'MD5-SESS') ha1 = md5Hex(`${ha1}:${ch.nonce}:${cnonce}`);
  const ha2 = md5Hex(`${method}:${uri}`);
  const qop = ch.qop?.split(',').map((s) => s.trim()).find((q) => q === 'auth');
  const ncHex = nc.toString(16).padStart(8, '0');
  const response = qop ? md5Hex(`${ha1}:${ch.nonce}:${ncHex}:${cnonce}:${qop}:${ha2}`) : md5Hex(`${ha1}:${ch.nonce}:${ha2}`);
  const q = (s: string) => `"${s.replace(/(["\\])/g, '\\$1')}"`;
  const parts = [`username=${q(user)}`, `realm=${q(ch.realm)}`, `nonce=${q(ch.nonce)}`, `uri=${q(uri)}`, `response=${q(response)}`];
  if (ch.algorithm) parts.push(`algorithm=${ch.algorithm}`);
  if (qop) parts.push(`qop=${qop}`, `nc=${ncHex}`, `cnonce=${q(cnonce)}`);
  if (ch.opaque !== undefined) parts.push(`opaque=${q(ch.opaque)}`);
  return `Digest ${parts.join(', ')}`;
}
