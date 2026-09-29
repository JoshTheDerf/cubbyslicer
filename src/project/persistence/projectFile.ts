/**
 * `.cubbyslice` project files: a zip of `project.json` + `meshes/<id>.bin`.
 */
import { unzipSync, zipSync, strFromU8, strToU8, type Zippable } from 'fflate';
import { ImportError } from '../mesh';
import {
  liveMeshes, loadProjectData, projectName, serializeObjects, serializePaint, serializePlates,
} from '../store';
import {
  PROJECT_FORMAT, PROJECT_VERSION, meshFromArrays, packMesh, sanitizeObjects, unpackMesh,
  sanitizePaint, sanitizePlates, type MeshRef, type ProjectJson,
} from './format';
import { loadSections, saveSections } from './sections';

export const PROJECT_EXT = '.cubbyslice';

export function buildProjectFile(): Uint8Array {
  const ms = liveMeshes();
  const json: ProjectJson = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    name: projectName.value,
    savedAt: new Date().toISOString(),
    objects: serializeObjects(),
    meshes: ms.map((m) => ({ id: m.id, vertexCount: m.vertexCount, triangleCount: m.triangleCount })),
    plates: serializePlates(),
    paint: serializePaint(),
    sections: saveSections(),
  };
  const files: Zippable = { 'project.json': strToU8(JSON.stringify(json, null, 1)) };
  for (const m of ms) files[`meshes/${m.id}.bin`] = [packMesh(m), { level: 1 }];
  return zipSync(files, { level: 6 });
}

export interface OpenResult { name: string; objects: number; warnings: string[] }

export function openProjectFile(buffer: ArrayBuffer): OpenResult {
  let files: Record<string, Uint8Array>;
  try { files = unzipSync(new Uint8Array(buffer)); } catch { throw new ImportError('Not a Cubby Slicer project file.'); }
  const pj = files['project.json'];
  if (!pj) throw new ImportError('Project file has no project.json.');
  let json: ProjectJson;
  try { json = JSON.parse(strFromU8(pj)); } catch { throw new ImportError('project.json is not valid JSON.'); }
  if (json?.format !== PROJECT_FORMAT) throw new ImportError('Not a Cubby Slicer project file.');
  if (typeof json.version !== 'number' || json.version > PROJECT_VERSION) {
    throw new ImportError('This project was saved by a newer version of Cubby Slicer.');
  }
  const warnings: string[] = [];
  const meshes = [];
  for (const ref of (Array.isArray(json.meshes) ? json.meshes : []) as MeshRef[]) {
    const id = String(ref?.id ?? '');
    if (!/^[\w-]{1,64}$/.test(id)) { warnings.push('Skipped a mesh with an invalid id.'); continue; }
    const bin = files[`meshes/${id}.bin`];
    if (!bin) { warnings.push(`Mesh ${id} is missing from the file.`); continue; }
    try {
      const { positions, indices } = unpackMesh({ id, vertexCount: ref.vertexCount, triangleCount: ref.triangleCount }, bin);
      meshes.push(meshFromArrays(id, positions, indices));
    } catch (e) { warnings.push((e as Error).message); }
  }
  const objects = sanitizeObjects(json.objects, new Set(meshes.map((m) => m.id)));
  loadProjectData({ name: typeof json.name === 'string' ? json.name : 'Project', objects, meshes, plates: sanitizePlates(json.plates),
    paint: sanitizePaint((json as { paint?: unknown }).paint, new Set(meshes.map((m) => m.id))) });
  const failed = loadSections(json.sections);
  if (failed.length) warnings.push(`Couldn't restore: ${failed.join(', ')}.`);
  return { name: projectName.value, objects: objects.length, warnings };
}
