/**
 * Project-level passthrough: what an opened OrcaSlicer / Bambu project
 * carries that CubbySlicer doesn't model, kept so a save writes it back.
 *
 * - Archive entries desktop Orca keeps (`files`): the Design tab document
 *   (Metadata/orca_cad.bin), texture displacement layers, embossed SVG shapes,
 *   Auxiliaries/ and project-embedded presets.
 * - Model `<metadata name>` items the writer doesn't set itself (designer,
 *   description, licence, MakerLab …).
 * - Per-triangle data we don't paint with (texture displacement masks, BBS
 *   face properties), keyed by mesh id. A mesh id never changes meaning, so
 *   these follow undo / redo; a tool that replaces a mesh makes a new id and
 *   the data is simply not written for it.
 *
 * Per-object / per-volume / per-plate data lives on those records
 * (`passthrough` fields, src/project/types.ts) and so rides in undo
 * snapshots, the clipboard and the autosave with them.
 *
 * Every whole-project load clears this; openers set it right after
 * `loadProjectData`. The value is immutable: replace it, never mutate it.
 */
import { markRaw, ref, shallowRef, watch } from 'vue';
import { projectLoads } from '../store';
import { CAD_RECIPE_FILE, isKeptEntry } from '../import/orcaFormat';
import type { TriangleAttrs } from '../import/threemf';

export interface ProjectPassthrough {
  /** Archive path → bytes. */
  files: Readonly<Record<string, Uint8Array>>;
  /** Model metadata items, in file order. */
  modelMetadata: ReadonlyArray<readonly [string, string]>;
  /** Mesh id → per-triangle attributes (attribute → [triangle, value]). */
  triangleAttrs: Readonly<Record<string, TriangleAttrs>>;
}

const EMPTY: ProjectPassthrough = Object.freeze({ files: Object.freeze({}), modelMetadata: Object.freeze([]), triangleAttrs: Object.freeze({}) });

/** The current project's passthrough. Read it; change it with setProjectPassthrough / setOrcaCadRecipe. */
export const projectPassthrough = shallowRef<ProjectPassthrough>(EMPTY);
/** Bumped on every change (the autosave writes the passthrough only when this moved). */
export const passthroughRevision = ref(0);

export function setProjectPassthrough(p: Partial<ProjectPassthrough> | null): void {
  projectPassthrough.value = p ? markRaw({ ...EMPTY, ...p }) : EMPTY;
  passthroughRevision.value++;
}

export function isEmptyPassthrough(p: ProjectPassthrough): boolean {
  return !Object.keys(p.files).length && !p.modelMetadata.length && !Object.keys(p.triangleAttrs).length;
}

// A new project (new / open / import / restore) starts without any; openers set theirs after loading.
watch(projectLoads, () => { if (projectPassthrough.value !== EMPTY) setProjectPassthrough(null); }, { flush: 'sync' });

// ---- the Design tab's document --------------------------------------------------

/**
 * OrcaSlicer's Design tab document (`Model::cad_recipe`, Metadata/orca_cad.bin)
 * of the open project, byte-exact as read; null when it has none.
 */
export function getOrcaCadRecipe(): Uint8Array | null {
  return projectPassthrough.value.files[CAD_RECIPE_FILE] ?? null;
}

/** Replace (or with null, remove) the Design tab document. Saved with the project; not an undo step. */
export function setOrcaCadRecipe(bytes: Uint8Array | null): void {
  const files = { ...projectPassthrough.value.files };
  if (bytes?.length) files[CAD_RECIPE_FILE] = bytes; else delete files[CAD_RECIPE_FILE];
  setProjectPassthrough({ ...projectPassthrough.value, files });
}

// ---- validation (autosave records) ------------------------------------------------

const pairsOf = (raw: unknown, max = 4096): Array<[string, string]> =>
  Array.isArray(raw) ? raw.slice(0, max).filter((e): e is [string, string] => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && typeof e[1] === 'string') : [];

/** Validate an untrusted stored passthrough (null when empty or unusable). */
export function sanitizeProjectPassthrough(raw: unknown, meshIds?: Set<string>): ProjectPassthrough | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const files: Record<string, Uint8Array> = {};
  if (o.files && typeof o.files === 'object') {
    for (const [k, v] of Object.entries(o.files as Record<string, unknown>)) if (v instanceof Uint8Array && isKeptEntry(k)) files[k] = v;
  }
  const triangleAttrs: Record<string, TriangleAttrs> = {};
  if (o.triangleAttrs && typeof o.triangleAttrs === 'object') {
    for (const [id, attrs] of Object.entries(o.triangleAttrs as Record<string, unknown>)) {
      if (meshIds && !meshIds.has(id)) continue;
      if (!attrs || typeof attrs !== 'object') continue;
      const clean: TriangleAttrs = {};
      for (const [name, list] of Object.entries(attrs as Record<string, unknown>)) {
        if (!/^(paint_texture_\d+|face_property)$/.test(name) || !Array.isArray(list)) continue;
        const pairs = list.filter((e): e is [number, string] => Array.isArray(e) && e.length === 2 && Number.isInteger(e[0]) && e[0] >= 0 && typeof e[1] === 'string');
        if (pairs.length) clean[name] = pairs;
      }
      if (Object.keys(clean).length) triangleAttrs[id] = clean;
    }
  }
  const p: ProjectPassthrough = { files, modelMetadata: pairsOf(o.modelMetadata), triangleAttrs };
  return isEmptyPassthrough(p) ? null : p;
}

/** The passthrough a save writes: triangle data only for meshes still in use. */
export function passthroughFor(meshIds: Set<string>): ProjectPassthrough {
  const p = projectPassthrough.value;
  const triangleAttrs: Record<string, TriangleAttrs> = {};
  for (const [id, a] of Object.entries(p.triangleAttrs)) if (meshIds.has(id)) triangleAttrs[id] = a;
  return { ...p, triangleAttrs };
}
