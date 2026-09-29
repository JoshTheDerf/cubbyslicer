/**
 * CubbyCAD file commands: open a workspace file (project or model), save the
 * project back in place (Ctrl+S once it has a cloud location), Save as, and
 * export G-code / 3MF into a workspace. The dialog (CloudDialog.vue) collects
 * the workspace + path; everything that touches the plate lives here.
 */
import { toast } from '../ui';
import { activeGcode } from '../app/slice';
import { importBuffer, openProjectBuffer } from '../app/shell/actions';
import { safeFileName } from '../app/shell/download';
import { activePlate, getMesh, objectsOnPlate, plates, projectName } from '../project/store';
import { build3mf } from '../project/export/threemf';
import { PROJECT_EXT, buildProjectFile } from '../project/persistence/projectFile';
import { isModelFileName } from '../project/import';
import { CloudAuthError, CloudError, isSafePath, readFile, slicerFileLink, writeFile } from './api';
import { cloud, cloudDialog, markCloudSaved, refreshUser, refreshWorkspaces, setCloudLocation, workspaceName } from './store';

/** Files the slicer can open from a workspace. */
export function isOpenableCloudFile(path: string): boolean {
  return path.toLowerCase().endsWith(PROJECT_EXT) || isModelFileName(path);
}

function reportError(what: string, e: unknown): void {
  if (e instanceof CloudAuthError) {
    cloud.user = null;
    toast.error(`${what}: you're signed out.`, { detail: 'Sign in to CubbyCAD and try again.' });
    cloudDialog.value = { mode: 'open' };
    return;
  }
  toast.error(`${what}.`, { detail: (e as Error)?.message ?? String(e) });
}

/** Open a workspace file: a .cubbyslice replaces the project, a model is added to the plate. */
export async function openCloudFile(workspaceId: string, path: string, wsName = workspaceName(workspaceId)): Promise<boolean> {
  if (!isSafePath(path)) { toast.error('That file path is not valid.'); return false; }
  const name = path.split('/').pop() || path;
  let buf: ArrayBuffer;
  try {
    buf = await readFile(workspaceId, path);
  } catch (e) { reportError(`Couldn't open ${name}`, e); return false; }
  if (name.toLowerCase().endsWith(PROJECT_EXT)) {
    const ok = await openProjectBuffer(name, buf);
    if (ok) setCloudLocation({ workspaceId, workspaceName: wsName, path });
    return ok;
  }
  return (await importBuffer(name, buf)).length > 0;
}

async function writeOrReport(workspaceId: string, path: string, data: Blob, what: string): Promise<boolean> {
  try {
    await writeFile(workspaceId, path, data);
    return true;
  } catch (e) { reportError(`Couldn't save ${what}`, e); return false; }
}

/** Save the project to `path` in the workspace and make that its location. */
export async function saveProjectTo(workspaceId: string, path: string, wsName = workspaceName(workspaceId)): Promise<boolean> {
  let bytes: Uint8Array;
  try { bytes = buildProjectFile(); } catch (e) { toast.error("Couldn't save the project.", { detail: (e as Error)?.message }); return false; }
  const ok = await writeOrReport(workspaceId, path, new Blob([bytes as BlobPart], { type: 'application/zip' }), path.split('/').pop() || path);
  if (!ok) return false;
  setCloudLocation({ workspaceId, workspaceName: wsName, path });
  markCloudSaved();
  toast.success(`Saved to ${wsName}.`, { detail: path, timeout: 2200 });
  return true;
}

/** Ctrl+S with a cloud location: write back in place. Returns false when there's nowhere to save. */
export async function saveToCloudLocation(): Promise<boolean> {
  const loc = cloud.location;
  if (!loc) return false;
  await saveProjectTo(loc.workspaceId, loc.path, loc.workspaceName);
  return true;
}

export function suggestedProjectName(): string {
  return `${safeFileName(projectName.value, 'project')}${PROJECT_EXT}`;
}

/** Files export can write, with their suggested names. */
export function exportPayload(kind: 'gcode' | '3mf'): { blob: Blob; name: string } | null {
  if (kind === 'gcode') {
    const g = activeGcode();
    return g ? { blob: new Blob([g.bytes as BlobPart], { type: 'text/x-gcode' }), name: g.name } : null;
  }
  const list = objectsOnPlate(activePlate.value);
  if (!list.length) return null;
  const suffix = plates.value.length > 1 ? `_plate${activePlate.value + 1}` : '';
  return { blob: new Blob([build3mf(list, getMesh) as BlobPart], { type: 'model/3mf' }), name: `${safeFileName(projectName.value)}${suffix}.3mf` };
}

export async function exportTo(kind: 'gcode' | '3mf', workspaceId: string, path: string): Promise<boolean> {
  let payload: ReturnType<typeof exportPayload>;
  try { payload = exportPayload(kind); } catch (e) { toast.error(`Couldn't export ${kind === 'gcode' ? 'G-code' : '3MF'}.`, { detail: (e as Error)?.message }); return false; }
  if (!payload) {
    toast.info(kind === 'gcode' ? 'Slice the plate before exporting G-code.' : 'The plate is empty. Import a model first.');
    return false;
  }
  const ok = await writeOrReport(workspaceId, path, payload.blob, path.split('/').pop() || path);
  if (ok) toast.success(`Exported to ${workspaceName(workspaceId)}.`, { detail: path, timeout: 2200 });
  return ok;
}

// ---- dialog entry points (actions) ----

export function cloudOpenDialog(): void { cloudDialog.value = { mode: 'open' }; }
export function cloudSaveAsDialog(): void { cloudDialog.value = { mode: 'save', suggestedName: cloud.location?.path ?? suggestedProjectName() }; }
export async function cloudSave(): Promise<void> { if (!(await saveToCloudLocation())) cloudSaveAsDialog(); }
export function cloudExportDialog(kind: 'gcode' | '3mf'): void {
  if (kind === 'gcode' && !activeGcode()) { toast.info('Slice the plate before exporting G-code.'); return; }
  const p = exportPayload(kind === 'gcode' ? 'gcode' : '3mf');
  if (!p) { toast.info('The plate is empty. Import a model first.'); return; }
  cloudDialog.value = { mode: 'export', exportKind: kind, suggestedName: p.name };
}

export function cloudLink(): string | null {
  return cloud.location ? slicerFileLink(cloud.location.workspaceId, cloud.location.path) : null;
}

/** `?workspace=<id>&path=<file>` on load: open that file (project or model). Returns true if it applied. */
export async function openCloudDeepLink(): Promise<boolean> {
  const q = new URLSearchParams(location.search);
  const ws = q.get('workspace'), path = q.get('path');
  if (!ws || !path) return false;
  const user = await refreshUser();
  if (!user) {
    toast.info('Sign in to CubbyCAD to open the linked file.', { detail: path });
    cloudDialog.value = { mode: 'open' };
    return false;
  }
  await refreshWorkspaces().catch(() => {});
  const ok = await openCloudFile(ws, path);
  // A model link was a one-off import; only a project link stays in the URL.
  if (!ok || !path.toLowerCase().endsWith(PROJECT_EXT)) {
    const u = new URL(location.href);
    u.searchParams.delete('workspace'); u.searchParams.delete('path');
    history.replaceState(history.state, '', u);
  }
  return ok;
}

export { CloudError };
