/**
 * Bridge tools: projects and files. New / open / save go through the shell
 * and file commands the File menu uses, so the same prompts appear: starting
 * over or opening a project over a plate with objects asks the user, and
 * writing over an existing CubbyCAD file asks before replacing it.
 * Local files go through cubby-mcp paths (open_project, export_3mf).
 */
import { argString, base64ToBytes, type BridgeTool } from '@cubby/shared/bridge';
import { importBuffer, newProject } from '../../app/shell/actions';
import { confirmAction } from '../../app/shell/uiState';
import { objects, projectLoads, projectName, projectRevision } from '../../project/store';
import { cloud, filesIn, isCloudDirty, refreshUser, refreshWorkspaces } from '../../cloud/store';
import { cloudLink, exportPayload, exportTo, isOpenableCloudFile, openCloudFile, saveProjectTo, saveToCloudLocation, suggestedProjectName } from '../../cloud/commands';
import { isSafePath } from '../../cloud/api';
import { isLocalDirty, local } from '../../localfs/store';
import { saveLocal } from '../../localfs/commands';
import { oneOf } from '../logic';
import { obj, objectBrief, oneOfS, str } from './util';

async function signedIn(): Promise<void> {
  const u = cloud.checked && cloud.user ? cloud.user : await refreshUser();
  if (!u) throw new Error('Not signed in to CubbyCAD in this browser. Ask the user to sign in (File → Open from CubbyCAD…), then retry.');
  if (!cloud.workspaces.length) await refreshWorkspaces();
}

function workspace(id: unknown): { id: string; name: string; writable: boolean } {
  const w = cloud.workspaces.find((x) => x.id === id);
  if (!w) throw new Error(`No workspace "${String(id)}". Workspaces: ${cloud.workspaces.map((x) => `${x.id} (${x.name})`).join(', ') || 'none'}.`);
  return w;
}

function pathArg(args: Record<string, unknown>, ext?: string): string {
  const p = argString(args, 'path')!.replace(/^\/+/, '');
  if (!isSafePath(p)) throw new Error('path must be a relative path inside the workspace, e.g. "prints/bracket.3mf".');
  if (ext && !p.toLowerCase().endsWith(ext)) throw new Error(`path must end in ${ext}.`);
  return p;
}

/** The CubbyCAD dialog's replace prompt: only when writing over another existing file. */
async function confirmReplace(workspaceId: string, path: string, ownLocation: boolean): Promise<boolean> {
  const exists = (await filesIn(workspaceId)).some((f) => f.path === path);
  if (!exists || ownLocation) return true;
  return confirmAction({ title: `Replace ${path.split('/').pop()}?`, message: 'A file with this name already exists in this folder. Saving replaces it.', confirmLabel: 'Replace', danger: true });
}

function projectState() {
  return {
    name: projectName.value, objects: objects.value.length,
    location: cloud.location ? { cloud: cloud.location.workspaceName, workspaceId: cloud.location.workspaceId, path: cloud.location.path, link: cloudLink() } : local.location ? { local: local.location.name, folder: local.location.folder } : null,
    unsaved: cloud.location ? isCloudDirty() : local.location ? isLocalDirty() : projectRevision.value > 0,
  };
}

export function fileTools(): BridgeTool[] {
  return [
    {
      name: 'get_project',
      description: 'The project: name, object count, where it is saved (a CubbyCAD workspace file or a local file) and whether it has unsaved changes.',
      inputSchema: obj({}),
      run() { return { data: projectState() }; },
    },

    {
      name: 'new_project',
      description: 'Start a new, empty project (File → New project). With objects on the plate the user confirms in the browser first.',
      timeoutMs: 10 * 60_000,
      inputSchema: obj({ name: str('Project name.') }),
      async run(args) {
        const before = projectLoads.value;
        const had = objects.value.length;
        await newProject();
        if (had && projectLoads.value === before) return { data: { ok: false, error: 'The user declined.' } };
        const name = argString(args, 'name', { optional: true })?.trim();
        if (name) projectName.value = name.slice(0, 120);
        return { data: { ok: true, ...projectState() } };
      },
    },

    {
      name: 'rename_project',
      description: 'Rename the project (used for file names on save and export).',
      inputSchema: obj({ name: str('New name.') }, ['name']),
      run(args) {
        const n = argString(args, 'name')!.trim();
        if (!n) throw new Error('name must not be empty.');
        projectName.value = n.slice(0, 120);
        return { data: { ok: true, ...projectState() } };
      },
    },

    {
      name: 'open_project',
      description: 'Open a 3MF project (OrcaSlicer / Bambu Studio / Cubby Slicer): plates, parts, paint and settings replace the current project. Give a local path or URL (through cubby-mcp), or name + dataBase64. With objects on the plate the user chooses in the browser (open as project, or import only its models).',
      fileInput: true,
      timeoutMs: 10 * 60_000,
      inputSchema: obj({ name: str('File name, e.g. "part.3mf".'), dataBase64: str('File bytes, base64.') }, ['name', 'dataBase64']),
      async run(args) {
        const name = argString(args, 'name')!;
        if (!/\.3mf$/i.test(name)) throw new Error('open_project takes a .3mf file; use import_model for STL / OBJ / STEP.');
        const bytes = base64ToBytes(argString(args, 'dataBase64')!);
        const before = projectLoads.value;
        const ids = await importBuffer(name, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
        const opened = projectLoads.value !== before;
        if (!ids.length && !opened) return { data: { ok: false, error: 'Not opened: the user cancelled, or the file could not be read (see the app’s notification).' } };
        return { data: { ok: true, openedAsProject: opened, ...projectState(), objects: objects.value.map((o) => objectBrief(o.id)) } };
      },
    },

    {
      name: 'save_project',
      description: 'Save the project back to where it came from (File → Save): its CubbyCAD workspace file or the local file it was opened from. For a project with no location use save_to_cloud, or export_3mf (writes a file through cubby-mcp).',
      timeoutMs: 5 * 60_000,
      inputSchema: obj({}),
      async run() {
        if (cloud.location) {
          await saveToCloudLocation();
          if (isCloudDirty()) return { data: { ok: false, error: 'Saving to CubbyCAD failed (see the app’s notification).' } };
          return { data: { ok: true, ...projectState() } };
        }
        if (local.location) {
          await saveLocal();
          if (isLocalDirty()) return { data: { ok: false, error: 'Saving the local file failed (see the app’s notification).' } };
          return { data: { ok: true, ...projectState() } };
        }
        throw new Error('The project has no save location yet: use save_to_cloud (a CubbyCAD workspace) or export_3mf (a file on this computer).');
      },
    },

    {
      name: 'list_cloud_files',
      description: 'CubbyCAD workspaces of the signed-in user, or (with workspaceId) the files in one. Files the slicer can open: 3MF projects and STL / OBJ / STEP models.',
      inputSchema: obj({ workspaceId: str('Workspace id.') }),
      async run(args) {
        await signedIn();
        if (args.workspaceId === undefined) {
          await refreshWorkspaces();
          return { data: { user: cloud.user?.name, workspaces: cloud.workspaces.map((w) => ({ id: w.id, name: w.name, writable: w.writable })) } };
        }
        const w = workspace(args.workspaceId);
        const files = await filesIn(w.id);
        return { data: { workspace: w.name, files: files.map((f) => ({ path: f.path, size: f.size, modifiedAt: f.modifiedAt, openable: isOpenableCloudFile(f.path) || undefined })) } };
      },
    },

    {
      name: 'open_cloud_file',
      description: 'Open a CubbyCAD workspace file: a 3MF project replaces the project (the user is asked first when the plate has objects) and becomes the save location; a model is added to the active plate.',
      timeoutMs: 10 * 60_000,
      inputSchema: obj({ workspaceId: str('Workspace id.'), path: str('File path from list_cloud_files.') }, ['workspaceId', 'path']),
      async run(args) {
        await signedIn();
        const w = workspace(args.workspaceId);
        const path = pathArg(args);
        if (!isOpenableCloudFile(path)) throw new Error('Only 3MF projects and STL / OBJ / STEP models can be opened.');
        const ok = await openCloudFile(w.id, path, w.name);
        return { data: { ok, ...projectState(), objects: objects.value.map((o) => objectBrief(o.id)) } };
      },
    },

    {
      name: 'save_to_cloud',
      description: 'Save the project as a 3MF into a CubbyCAD workspace (File → Save to CubbyCAD as…); it becomes the project’s save location. Replacing another existing file asks the user first, like the dialog.',
      timeoutMs: 10 * 60_000,
      inputSchema: obj({ workspaceId: str('Workspace id.'), path: str(`File path, e.g. "${suggestedProjectName()}".`) }, ['workspaceId', 'path']),
      async run(args) {
        await signedIn();
        const w = workspace(args.workspaceId);
        if (!w.writable) throw new Error(`Workspace "${w.name}" is read-only.`);
        const path = pathArg(args, '.3mf');
        const own = cloud.location?.workspaceId === w.id && cloud.location.path === path;
        if (!(await confirmReplace(w.id, path, own))) return { data: { ok: false, error: 'The user declined to replace the file.' } };
        const ok = await saveProjectTo(w.id, path, w.name);
        return { data: { ok, ...projectState() } };
      },
    },

    {
      name: 'export_to_cloud',
      description: 'Export into a CubbyCAD workspace: kind "gcode" (the active plate’s sliced G-code) or "3mf" (the active plate’s meshes). Replacing an existing file asks the user first.',
      timeoutMs: 10 * 60_000,
      inputSchema: obj({ kind: oneOfS(['gcode', '3mf'], 'What to export.'), workspaceId: str('Workspace id.'), path: str('File path (default: the suggested name).') }, ['kind', 'workspaceId']),
      async run(args) {
        const kind = oneOf(args.kind, ['gcode', '3mf'] as const, 'kind');
        await signedIn();
        const w = workspace(args.workspaceId);
        if (!w.writable) throw new Error(`Workspace "${w.name}" is read-only.`);
        const payload = exportPayload(kind);
        if (!payload) throw new Error(kind === 'gcode' ? 'Slice the plate first.' : 'The plate is empty.');
        const path = args.path === undefined ? payload.name : pathArg(args, kind === 'gcode' ? '.gcode' : '.3mf');
        if (!(await confirmReplace(w.id, path, false))) return { data: { ok: false, error: 'The user declined to replace the file.' } };
        const ok = await exportTo(kind, w.id, path);
        return { data: { ok, workspace: w.name, path } };
      },
    },
  ];
}
