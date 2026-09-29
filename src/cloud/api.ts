/**
 * CubbyCAD workspace storage client (the editor's RemoteFsBackend contract:
 * cad-project/docs/workspace-backend/http-contract.md), trimmed to what the
 * slicer needs: sign-in state, workspaces, and the workspace's asset files
 * (models, project 3MFs, exported G-code).
 *
 * Same origin as the slicer (cubbycad.com/cubby): Directus keeps the session
 * in httpOnly cookies, so every call is `credentials: 'include'` and the
 * editor's sign-in is shared. Writes go the editor's way — upload the bytes to
 * Directus `/files` (storage "cubbycad"), then register them at a workspace
 * path with `POST /workspaces/:id/assets/file/finalize` (re-finalizing a path
 * overwrites it in place).
 */

export interface CloudUser { id: string; email: string | null; name: string; avatar: string | null }
export interface CloudProvider { name: string; label: string }
export interface CloudWorkspace { id: string; name: string; writable: boolean; teamId?: string | null; modifiedAt?: string }
export interface CloudFile { path: string; name: string; size?: number; modifiedAt?: string }

export class CloudAuthError extends Error {
  constructor(message = 'Sign in to use your CubbyCAD files.') { super(message); this.name = 'CloudAuthError'; }
}
export class CloudError extends Error {
  constructor(message: string, readonly status = 0, readonly code?: string) { super(message); this.name = 'CloudError'; }
}

const DEFAULT_ENDPOINT = '/cubby';
let endpointP: Promise<string> | null = null;

/** The workspace host base (the editor's config.json `endpoint`), same-origin fallback. */
export function cloudEndpoint(): Promise<string> {
  endpointP ??= (async () => {
    try {
      const rsp = await fetch('/editor/config.json', { credentials: 'same-origin' });
      if (rsp.ok) {
        const cfg = await rsp.json() as { endpoint?: unknown };
        if (typeof cfg.endpoint === 'string' && cfg.endpoint) {
          const u = new URL(cfg.endpoint, location.href);
          // Only talk to our own origin: the session cookie lives there and COEP forbids surprises.
          if (u.origin === location.origin) return u.pathname.replace(/\/$/, '');
        }
      }
    } catch { /* offline / no editor config: use the default */ }
    return DEFAULT_ENDPOINT;
  })();
  return endpointP;
}

/** Directus API root = the endpoint's parent (`/cubby` → `/`). */
async function rootUrl(suffix: string): Promise<string> {
  const base = await cloudEndpoint();
  const root = base.replace(/\/[^/]*$/, '');
  return `${root}${suffix.startsWith('/') ? suffix : `/${suffix}`}`;
}

async function apiUrl(suffix: string): Promise<string> { return `${await cloudEndpoint()}${suffix}`; }

/** Client-side path check (the server is the authority): relative, no `.`/`..`, no backslash / control chars. */
export function isSafePath(p: string): boolean {
  if (!p || p.length > 512 || p.startsWith('/') || /[\\\u0000-\u001f]/.test(p) || /^[a-zA-Z]:/.test(p)) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

async function request(url: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'include', ...init, headers: { Accept: 'application/json', ...(init.headers ?? {}) } });
  } catch (e) {
    throw new CloudError(`Can’t reach CubbyCAD storage (${(e as Error)?.message ?? 'network error'}).`);
  }
  if (res.status === 401) throw new CloudAuthError();
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`, code: string | undefined;
    try {
      const b = await res.clone().json() as { error?: { code?: string; message?: string }; errors?: Array<{ message?: string }> };
      code = b.error?.code;
      msg = b.error?.message || b.errors?.[0]?.message || msg;
    } catch { /* not JSON */ }
    if (res.status === 403) throw new CloudError(code === 'read_only' ? 'This workspace is read-only.' : `Not allowed: ${msg}`, 403, code);
    throw new CloudError(msg, res.status, code);
  }
  return res;
}

// ---- auth ----------------------------------------------------------------------

export async function currentUser(): Promise<CloudUser | null> {
  try {
    const res = await request(await rootUrl('/users/me?fields=id,email,first_name,last_name,avatar'));
    const d = (await res.json() as { data?: Record<string, unknown> }).data ?? {};
    const name = [d.first_name, d.last_name].filter((x) => typeof x === 'string' && x).join(' ') || (typeof d.email === 'string' ? d.email : 'Signed in');
    return { id: String(d.id ?? ''), email: typeof d.email === 'string' ? d.email : null, name, avatar: typeof d.avatar === 'string' ? d.avatar : null };
  } catch (e) {
    if (e instanceof CloudAuthError || (e instanceof CloudError && e.status === 403)) return null;
    throw e;
  }
}

/** SSO providers enabled in Directus (`GET /auth`). */
export async function authProviders(): Promise<CloudProvider[]> {
  try {
    const res = await request(await rootUrl('/auth'));
    const data = (await res.json() as { data?: Array<{ name?: string; label?: string }> }).data ?? [];
    return data.filter((p) => typeof p.name === 'string' && p.name).map((p) => ({ name: p.name!, label: p.label || p.name! }));
  } catch { return []; }
}

/** Full-page SSO sign-in that comes back to `returnUrl` (Directus sets the session cookie). */
export async function providerLoginUrl(provider: string, returnUrl = location.href): Promise<string> {
  const abs = new URL(returnUrl, location.href).href;
  return `${await rootUrl(`/auth/login/${encodeURIComponent(provider)}`)}?redirect=${encodeURIComponent(abs)}`;
}

export async function loginWithPassword(email: string, password: string): Promise<void> {
  await request(await rootUrl('/auth/login'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, mode: 'session' }),
  }).catch((e) => { throw e instanceof CloudAuthError ? new CloudError('Incorrect email or password.', 401) : e; });
}

export async function logout(): Promise<void> {
  await request(await rootUrl('/auth/logout'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'session' }) }).catch(() => {});
}

// ---- workspaces + files -----------------------------------------------------------------

export async function listWorkspaces(): Promise<CloudWorkspace[]> {
  const res = await request(await apiUrl('/workspaces'));
  const items = (await res.json() as { items?: CloudWorkspace[] | null }).items ?? [];
  return items.filter((w) => w && typeof w.id === 'string').map((w) => ({ id: w.id, name: w.name || 'Workspace', writable: w.writable !== false, teamId: w.teamId ?? null, modifiedAt: w.modifiedAt }));
}

export async function listFiles(workspaceId: string): Promise<CloudFile[]> {
  const res = await request(await apiUrl(`/workspaces/${encodeURIComponent(workspaceId)}/assets`)).catch((e) => {
    if (e instanceof CloudError && e.status === 404) return null;
    throw e;
  });
  if (!res) return [];
  const items = (await res.json() as { items?: CloudFile[] | null }).items ?? [];
  return items.filter((f) => f && typeof f.path === 'string' && !f.path.startsWith('.thumbnails/'))
    .map((f) => ({ path: f.path, name: f.name || f.path.split('/').pop() || f.path, size: f.size, modifiedAt: f.modifiedAt }));
}

export async function readFile(workspaceId: string, path: string): Promise<ArrayBuffer> {
  if (!isSafePath(path)) throw new CloudError('Invalid file path.');
  const res = await request(await apiUrl(`/workspaces/${encodeURIComponent(workspaceId)}/assets/file?path=${encodeURIComponent(path)}`), { headers: { Accept: '*/*' } });
  return res.arrayBuffer();
}

/** Create or overwrite `path` in the workspace. */
export async function writeFile(workspaceId: string, path: string, data: Blob): Promise<void> {
  if (!isSafePath(path)) throw new CloudError('Invalid file path.');
  const form = new FormData();
  form.append('storage', 'cubbycad');
  form.append('title', path);
  form.append('filename_download', path.split('/').pop() || path);
  form.append('file', data, path.split('/').pop() || path);
  const up = await request(await rootUrl('/files'), { method: 'POST', body: form });
  const fileId = (await up.json() as { data?: { id?: string } }).data?.id;
  if (!fileId) throw new CloudError(`Upload of “${path}” returned no file id.`);
  await request(await apiUrl(`/workspaces/${encodeURIComponent(workspaceId)}/assets/file/finalize`), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, fileId }),
  });
}

export async function deleteFile(workspaceId: string, path: string): Promise<void> {
  if (!isSafePath(path)) throw new CloudError('Invalid file path.');
  await request(await apiUrl(`/workspaces/${encodeURIComponent(workspaceId)}/assets/file?path=${encodeURIComponent(path)}`), { method: 'DELETE' });
}

/** Link to the file in the editor-style deep link form (for sharing / reopening). */
export function slicerFileLink(workspaceId: string, path: string): string {
  const u = new URL(location.href);
  u.search = '';
  u.searchParams.set('workspace', workspaceId);
  u.searchParams.set('path', path);
  return u.href;
}
