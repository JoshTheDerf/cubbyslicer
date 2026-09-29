/**
 * CubbyCAD file storage in the slicer: who's signed in, the workspaces, and
 * the project's cloud location (the file it was opened from / last saved to),
 * so Save writes back in place like Orca's Save project.
 */
import { reactive, ref } from 'vue';
import { projectName, projectRevision } from '../project/store';
import { local } from '../localfs/store';
import {
  CloudAuthError, currentUser, listFiles, listWorkspaces, readFile, writeFile,
  type CloudFile, type CloudUser, type CloudWorkspace,
} from './api';

export interface CloudLocation { workspaceId: string; workspaceName: string; path: string }

export const cloud = reactive({
  user: null as CloudUser | null,
  /** null = not checked yet. */
  checked: false,
  workspaces: [] as CloudWorkspace[],
  /** Where the current project lives in CubbyCAD (null = local / unsaved). */
  location: null as CloudLocation | null,
  /** projectRevision at the last cloud open/save (dirty tracking). */
  savedRevision: -1,
});

/** Open-dialog request from actions ('open' | 'save' | 'export-gcode' | 'export-3mf'). */
export const cloudDialog = ref<null | { mode: 'open' | 'save' | 'export'; exportKind?: 'gcode' | '3mf'; suggestedName?: string }>(null);

export function isCloudDirty(): boolean {
  return !!cloud.location && projectRevision.value !== cloud.savedRevision;
}

export async function refreshUser(): Promise<CloudUser | null> {
  try { cloud.user = await currentUser(); } catch { cloud.user = null; }
  cloud.checked = true;
  return cloud.user;
}

export async function refreshWorkspaces(): Promise<CloudWorkspace[]> {
  try {
    cloud.workspaces = await listWorkspaces();
  } catch (e) {
    if (e instanceof CloudAuthError) cloud.workspaces = [];
    else throw e;
  }
  return cloud.workspaces;
}

export function workspaceName(id: string): string {
  return cloud.workspaces.find((w) => w.id === id)?.name ?? 'Workspace';
}

export async function filesIn(workspaceId: string): Promise<CloudFile[]> { return listFiles(workspaceId); }
export { readFile, writeFile };

/** Record that the project now corresponds to this cloud file. */
export function setCloudLocation(loc: CloudLocation | null): void {
  cloud.location = loc;
  if (loc) local.location = null; // one save target at a time
  cloud.savedRevision = projectRevision.value;
  if (loc) {
    const stem = loc.path.split('/').pop()!.replace(/\.cubbyslice$/i, '');
    if (stem) projectName.value = stem;
  }
  syncCloudUrl();
}

/** Keep `?workspace=&path=` in the address bar so a reload / bookmark reopens the cloud project. */
export function syncCloudUrl(): void {
  if (typeof location === 'undefined') return;
  const loc = cloud.location;
  const u = new URL(location.href);
  if (loc) { u.searchParams.set('workspace', loc.workspaceId); u.searchParams.set('path', loc.path); }
  else { u.searchParams.delete('workspace'); u.searchParams.delete('path'); }
  if (u.href !== location.href) history.replaceState(history.state, '', u);
}

/** Mark the current state as saved (after writing it to the cloud). */
export function markCloudSaved(): void { cloud.savedRevision = projectRevision.value; }

// Warn before leaving with unsaved cloud changes (the local autosave still has them).
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (e) => {
    if (isCloudDirty()) { e.preventDefault(); e.returnValue = ''; }
  });
}
