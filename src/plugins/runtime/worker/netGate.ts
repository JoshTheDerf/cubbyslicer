/**
 * The plugin runtime's network gate: `fetch` and `XMLHttpRequest` are replaced
 * before plugin code runs, so `pyodide.http.pyfetch`, `import js; js.fetch` and
 * pyodide-http all go through it. A request is allowed when it is
 *  - for the staged Pyodide runtime (static files, harmless),
 *  - for PyPI while the runtime installs declared dependencies, or
 *  - to an origin the calling plugin was granted (network / network_http, or
 *    full access).
 * Otherwise it fails like a blocked request, and the host is told so it can
 * ask the user (Orca's off-main-thread rule: deny now, remember a "yes" for
 * the next attempt). Browser CORS rules still apply on top.
 */
import { networkAllowed, normalizeNetworkUrl } from '../../manager/permissions';
import type { PluginPermissions } from '../../types';

export interface GateContext {
  base: string;
  currentPlugin(): { key: string; capability: string } | null;
  grants(key: string): PluginPermissions | undefined;
  trusted(): boolean;
  denied(key: string, capability: string, url: string): void;
}

const PYPI = new Set(['pypi.org', 'files.pythonhosted.org']);

export function checkUrl(ctx: GateContext, raw: string): { ok: true } | { ok: false; message: string } {
  let url: URL;
  try { url = new URL(raw, ctx.base); } catch { return { ok: false, message: `Invalid URL: ${raw}` }; }
  if (url.href.startsWith(ctx.base)) return { ok: true };
  if (url.protocol === 'data:' || url.protocol === 'blob:') return { ok: true };
  if (ctx.trusted() && PYPI.has(url.hostname)) return { ok: true };
  const cur = ctx.currentPlugin();
  if (!cur) {
    if (ctx.trusted()) return { ok: true };
    return { ok: false, message: `Network access to ${url.origin} is not allowed outside a plugin call` };
  }
  const g = ctx.grants(cur.key);
  if (g && (g.full_access || networkAllowed(g.network_http, url.href))) return { ok: true };
  ctx.denied(cur.key, cur.capability, normalizeNetworkUrl(url.href) || url.origin);
  return { ok: false, message: `Plugin "${cur.key}" has no permission to access ${url.origin}. Allow it in the Plugins dialog (Permissions) and try again.` };
}

export function installNetGate(scope: typeof globalThis, ctx: GateContext): void {
  const realFetch = scope.fetch.bind(scope);
  const gatedFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const v = checkUrl(ctx, href);
    if (!v.ok) return Promise.reject(new TypeError(v.message));
    // Never send the app's cookies along with a plugin request.
    return realFetch(input, href.startsWith(ctx.base) ? init : { ...init, credentials: 'omit' });
  };
  Object.defineProperty(scope, 'fetch', { value: gatedFetch, writable: false, configurable: false });

  const RealXHR = scope.XMLHttpRequest;
  if (RealXHR) {
    class GatedXHR extends RealXHR {
      open(method: string, url: string | URL, async = true, user?: string | null, password?: string | null): void {
        const v = checkUrl(ctx, String(url));
        if (!v.ok) throw new TypeError(v.message);
        super.open(method, url, async, user ?? null, password ?? null);
        this.withCredentials = false;
      }
    }
    Object.defineProperty(scope, 'XMLHttpRequest', { value: GatedXHR, writable: false, configurable: false });
  }
}
