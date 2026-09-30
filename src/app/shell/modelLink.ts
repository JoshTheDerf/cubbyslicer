/**
 * `?model=` link parsing (pure; the fetch/import lives in handoff.ts).
 *
 *   /slicer/?model=<url>[&model=<url>…][&name=<file>…][&arrange=all|plate|0]
 *
 * - `model`: absolute http(s) URL, repeatable; files load in order.
 * - `name`: the Nth `name` names the Nth `model`, for links whose path has no
 *   usable file name (`/download?id=42`, signed URLs).
 * - `arrange`: `all` (or `1`/`true`/empty) arranges every unlocked plate once
 *   everything has loaded; `plate` only the active plate; `0`/`false` skips
 *   the "auto arrange after import" preference for this load. Absent: the
 *   preference applies as for any import.
 */
import { MODEL_EXTENSIONS } from '../../project/import';

export type LinkArrange = 'all' | 'plate' | 'off' | 'default';

export interface ModelLink { url: string; name: string | null }

export interface ModelLinkParams { models: ModelLink[]; arrange: LinkArrange; invalid: string[] }

/** Query params this feature owns (cleared from the address bar after loading). */
export const MODEL_LINK_PARAMS = ['model', 'name', 'arrange'] as const;

export function parseArrange(v: string | null): LinkArrange {
  if (v === null) return 'default';
  const l = v.trim().toLowerCase();
  if (l === '' || l === '1' || l === 'true' || l === 'yes' || l === 'all') return 'all';
  if (l === 'plate') return 'plate';
  if (l === '0' || l === 'false' || l === 'no' || l === 'off') return 'off';
  return 'default';
}

export function parseModelLinkParams(q: URLSearchParams, base: string): ModelLinkParams {
  const names = q.getAll('name');
  const models: ModelLink[] = [];
  const invalid: string[] = [];
  q.getAll('model').forEach((raw, i) => {
    let u: URL;
    try { u = new URL(raw, base); } catch { invalid.push(raw); return; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') { invalid.push(raw); return; }
    const name = names[i]?.trim();
    models.push({ url: u.href, name: name ? baseName(name) : null });
  });
  return { models, arrange: parseArrange(q.get('arrange')), invalid };
}

function baseName(p: string): string {
  return p.split(/[/\\]/).pop() || p;
}

function hasModelExt(name: string): boolean {
  const l = name.toLowerCase();
  return MODEL_EXTENSIONS.some((e) => l.endsWith(e));
}

/** `filename*=UTF-8''…` or `filename="…"` from a Content-Disposition header. */
export function dispositionName(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:[\w-]+)?'[^']*'([^;]+)/i.exec(header);
  if (star) { try { return baseName(decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''))); } catch { /* fall through */ } }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header);
  const v = plain ? (plain[2] ?? plain[1]).trim() : '';
  return v ? baseName(v) : null;
}

function urlName(url: string): string | null {
  try {
    const last = new URL(url).pathname.split('/').pop();
    return last ? decodeURIComponent(last) : null;
  } catch { return null; }
}

/** Extension from the response type, or a zip signature (3MF is a zip). */
function sniffExt(contentType: string | null, bytes: Uint8Array): string | null {
  const t = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (t === 'model/3mf' || t === 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml') return '.3mf';
  if (t === 'model/stl' || t === 'application/sla' || t === 'model/x.stl-binary' || t === 'model/x.stl-ascii') return '.stl';
  if (t === 'model/obj') return '.obj';
  if (t === 'model/step' || t === 'application/step') return '.step';
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return '.3mf';
  return null;
}

/**
 * File name for a fetched link: `name` param, Content-Disposition, URL path,
 * in that order, taking the first with a model extension. Otherwise the best
 * of those gets an extension sniffed from Content-Type / the bytes (`.stl` last).
 */
export function resolveLinkName(
  link: ModelLink,
  headers: { disposition: string | null; contentType: string | null },
  bytes: Uint8Array,
): string {
  const candidates = [link.name, dispositionName(headers.disposition), urlName(link.url)].filter((n): n is string => !!n);
  const known = candidates.find(hasModelExt);
  if (known) return known;
  const stem = (candidates[0] ?? 'model').replace(/\.[^.]*$/, '') || 'model';
  return stem + (sniffExt(headers.contentType, bytes) ?? '.stl');
}
