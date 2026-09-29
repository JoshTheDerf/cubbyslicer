/**
 * Variable layer height + height range modifier state and (undoable)
 * mutations. Values live on the project objects (ProjectObject
 * .layerHeightProfile / .layerRanges); every change goes through the project
 * store's `mutate()` so it is undoable, persisted and marks the plate stale.
 */
import { computed, reactive, ref, shallowRef, toRaw, watch } from 'vue';
import { adaptiveLayerProfile, smoothLayerProfile } from '../engine/client';
import type { ConfigValue, FlatConfig } from '../engine/types';
import { resolvedConfig } from '../app/state';
import {
  getObject, getSliceObjects, mutate, objectInfo, objects, plateOf, selectedIds, uid,
} from '../project/store';
import type { LayerRange, ProjectObject } from '../project/types';
import {
  adaptiveProfile, adjustProfile, BAND_WIDTH_MAX, BAND_WIDTH_MIN, DEFAULT_BAND_WIDTH, facesFromMesh, fitProfileToHeight,
  profileFromRanges, slicingParams, smoothProfile, type HeightRange, type LayerEditAction, type SlicingParams,
} from './profile';

// ---- UI state (not undoable, not persisted) ---------------------------------------------

export const layersUi = reactive({
  /** Orca's layer editing mode (toolbar "Variable layer height"). */
  editing: false,
  /** Adaptive quality factor 0..1 (Orca m_adaptive_quality, default 0.5). */
  quality: 0.5,
  /** Smooth radius 1..10 (HeightProfileSmoothingParams, default 5). */
  radius: 5,
  keepMin: false,
  /** Brush band width (mm, Orca 1.5..10, default 2). */
  bandWidth: DEFAULT_BAND_WIDTH,
  /** Touch / mouse-less brush action. */
  touchAction: 'decrease' as LayerEditAction,
  busy: '' as '' | 'adaptive' | 'smooth',
  /** Draw the layer-height bands on the object in the 3D view. */
  showBands: true,
  /** Z (mm from the object's bottom) under the editor's cursor, or null. */
  cursorZ: null as number | null,
});

/** The profile being brushed (before it is committed on pointer up), for live 3D bands. */
export const liveProfile = shallowRef<{ id: string; profile: number[] } | null>(null);

/** A height range picked in the object list (its settings are edited). */
export const selectedRange = ref<{ objectId: string; rangeId: string } | null>(null);

/** The object the layer editor works on: the single selection. */
export const editObject = computed<ProjectObject | null>(() => {
  if (selectedIds.value.length !== 1) return null;
  return getObject(selectedIds.value[0]) ?? null;
});

export function setBandWidth(w: number): void {
  layersUi.bandWidth = Math.max(BAND_WIDTH_MIN, Math.min(BAND_WIDTH_MAX, w));
}

// ---- derived --------------------------------------------------------------------------

/** Printed height (mm) of an object: its world bbox (mesh + model parts). */
export function objectHeight(id: string): number {
  const i = objectInfo.value.get(id);
  return i ? Math.max(0, i.max[2] - i.min[2]) : 0;
}

/** Height ranges as the profile code sees them (with their layer_height override, if any). */
export function heightRanges(o: ProjectObject): HeightRange[] {
  return (o.layerRanges ?? []).map((r) => {
    const v = r.overrides.layer_height;
    const h = parseFloat(Array.isArray(v) ? v[0] : (v ?? ''));
    return { min: r.min, max: r.max, layerHeight: Number.isFinite(h) && h > 0 ? h : undefined };
  });
}

export function paramsFor(o: ProjectObject): SlicingParams {
  return slicingParams(resolvedConfig.value, toRaw(o.overrides), objectHeight(o.id));
}

/** The object's effective profile: its own (fitted to its height) or the one its ranges imply. */
export function profileOf(o: ProjectObject, p = paramsFor(o)): number[] {
  const own = o.layerHeightProfile;
  if (own && own.length >= 4) return fitProfileToHeight(toRaw(own), p.objectHeight);
  return profileFromRanges(p, heightRanges(o));
}

export function hasCustomProfile(o: ProjectObject | null | undefined): boolean {
  return !!o?.layerHeightProfile && o.layerHeightProfile.length >= 4;
}

// ---- mutations: profile ---------------------------------------------------------------

const round = (v: number) => Math.round(v * 1e5) / 1e5;

/** Replace (or clear with null / []) an object's layer height profile. Undoable. */
export function setLayerProfile(id: string, profile: number[] | null, label = 'Variable layer height', mergeKey?: string): void {
  mutate(label, () => {
    const o = getObject(id);
    if (!o) return;
    if (profile && profile.length >= 4) o.layerHeightProfile = profile.map(round);
    else delete o.layerHeightProfile;
  }, mergeKey ? { mergeKey } : {});
}

export function resetLayerProfile(id: string): void {
  setLayerProfile(id, null, 'Variable layer height - Reset');
}

/** One brush step on a working copy (no mutation). */
export function brush(o: ProjectObject, profile: number[], z: number, action: LayerEditAction, strength: number): number[] {
  return adjustProfile(paramsFor(o), profile, z, strength, layersUi.bandWidth, action, heightRanges(o));
}

function objectJob(id: string): { mesh: { positions: Float32Array; indices: Uint32Array }; transform: number[]; config: FlatConfig } | null {
  const plate = plateOf(id);
  const so = getSliceObjects(Math.max(0, plate)).find((x) => x.id === id);
  if (!so) return null;
  return { mesh: { positions: so.positions, indices: so.indices }, transform: so.transform, config: { ...resolvedConfig.value, ...(so.config ?? {}) } };
}

/** Orca "Adaptive": engine first, the TypeScript port when the engine can't. */
export async function runAdaptive(id: string, quality = layersUi.quality): Promise<void> {
  const o = getObject(id);
  if (!o || layersUi.busy) return;
  layersUi.busy = 'adaptive';
  try {
    const p = paramsFor(o);
    const job = objectJob(id);
    let profile: number[] | null = null;
    if (job) {
      try { profile = await adaptiveLayerProfile(job.mesh, job.transform, job.config, quality); } catch { profile = null; }
    }
    if (!profile || profile.length < 4) {
      const src = job?.mesh;
      if (!src) return;
      profile = adaptiveProfile(p, facesFromMesh(src.positions, src.indices, job!.transform), quality, heightRanges(o));
    }
    setLayerProfile(id, profile, 'Variable layer height - Adaptive');
  } finally {
    layersUi.busy = '';
  }
}

/** Orca "Smooth": engine first, the TypeScript port when the engine can't. */
export async function runSmooth(id: string, radius = layersUi.radius, keepMin = layersUi.keepMin): Promise<void> {
  const o = getObject(id);
  if (!o || layersUi.busy) return;
  layersUi.busy = 'smooth';
  try {
    const p = paramsFor(o);
    const cur = profileOf(o, p);
    const job = objectJob(id);
    let profile: number[] | null = null;
    if (job) {
      try { profile = await smoothLayerProfile(job.mesh, job.transform, job.config, cur, radius, keepMin); } catch { profile = null; }
    }
    if (!profile || profile.length < 4) profile = smoothProfile(cur, p, radius, keepMin);
    setLayerProfile(id, profile, 'Variable layer height - Smooth all');
  } finally {
    layersUi.busy = '';
  }
}

// ---- mutations: height range modifiers ---------------------------------------------------

/** Orca get_default_layer_config: layer_height (object's or process) + extruder 0 when present. */
function defaultRangeConfig(o: ProjectObject): Record<string, ConfigValue> {
  const ov = o.overrides.layer_height;
  const lh = ov !== undefined ? (Array.isArray(ov) ? ov[0] : ov) : resolvedConfig.value.layer_height;
  const h = Array.isArray(lh) ? lh[0] : lh;
  return { layer_height: h && parseFloat(h) > 0 ? h : '0.2' };
}

/**
 * Orca "Height range Modifier": the first range is 0–2 mm; later ones are
 * added after the last range (Orca add_layer_range_after_current). Returns the new range id.
 */
export function addLayerRange(id: string): string | null {
  const o = getObject(id);
  if (!o) return null;
  const h = objectHeight(id);
  const list = (o.layerRanges ?? []).slice().sort((a, b) => a.min - b.min);
  const last = list.at(-1);
  let min = 0, max = Math.min(2, h || 2);
  if (last) { min = last.max; max = last.max + 2; }
  if (h > 0 && min >= h - 1e-3) return null;
  if (h > 0) max = Math.min(max, h);
  const rid = uid('lr');
  mutate('Add height range', () => {
    const t = getObject(id);
    if (!t) return;
    const range: LayerRange = { id: rid, min: round(min), max: round(max), overrides: defaultRangeConfig(t) };
    t.layerRanges = [...(t.layerRanges ?? []), range];
  });
  return rid;
}

export function removeLayerRange(id: string, rangeId: string): void {
  mutate('Delete height range', () => {
    const o = getObject(id);
    if (!o?.layerRanges) return;
    const next = o.layerRanges.filter((r) => r.id !== rangeId);
    if (next.length) o.layerRanges = next; else delete o.layerRanges;
  });
  if (selectedRange.value?.rangeId === rangeId) selectedRange.value = null;
}

export function removeAllLayerRanges(id: string): void {
  mutate('Delete height ranges', () => { const o = getObject(id); if (o) delete o.layerRanges; });
  if (selectedRange.value?.objectId === id) selectedRange.value = null;
}

/** Validation for a range's bounds (Orca: min < max, both ≥ 0, no overlap with neighbours). */
export function rangeBoundsError(o: ProjectObject, rangeId: string, min: number, max: number): string | null {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return 'Enter a number.';
  if (min < 0) return 'The bottom must be at least 0 mm.';
  if (max <= min) return 'The top must be above the bottom.';
  for (const r of o.layerRanges ?? []) {
    if (r.id === rangeId) continue;
    if (min < r.max - 1e-6 && max > r.min + 1e-6) return `Overlaps the ${r.min}–${r.max} mm range.`;
  }
  return null;
}

export function setLayerRangeBounds(id: string, rangeId: string, min: number, max: number): boolean {
  const o = getObject(id);
  if (!o || rangeBoundsError(o, rangeId, min, max)) return false;
  mutate('Edit height range', () => {
    const t = getObject(id);
    if (!t?.layerRanges) return;
    t.layerRanges = t.layerRanges.map((r) => (r.id === rangeId ? { ...r, min: round(min), max: round(max) } : r));
  });
  return true;
}

export function getRange(id: string, rangeId: string): LayerRange | undefined {
  return getObject(id)?.layerRanges?.find((r) => r.id === rangeId);
}

const EMPTY: Readonly<Record<string, ConfigValue>> = Object.freeze({});
export function getRangeOverrides(id: string, rangeId: string): Readonly<Record<string, ConfigValue>> {
  return getRange(id, rangeId)?.overrides ?? EMPTY;
}

export function setRangeOverride(id: string, rangeId: string, key: string, value: ConfigValue | undefined): void {
  mutate(value === undefined ? 'Reset height range setting' : 'Change height range setting', () => {
    const o = getObject(id);
    if (!o?.layerRanges) return;
    o.layerRanges = o.layerRanges.map((r) => {
      if (r.id !== rangeId) return r;
      const ov = { ...r.overrides };
      if (value === undefined) delete ov[key]; else ov[key] = Array.isArray(value) ? [...value] : value;
      return { ...r, overrides: ov };
    });
  }, { mergeKey: `lr:${id}:${rangeId}:${key}` });
}

/** Total layer-related customisations on an object (for badges). */
export function layerCustomCount(o: ProjectObject): number {
  return (o.layerRanges?.length ?? 0) + (hasCustomProfile(o) ? 1 : 0);
}

/** Objects that carry a variable layer height profile (object list info rows). */
export const objectsWithProfile = computed(() => new Set(objects.value.filter(hasCustomProfile).map((o) => o.id)));

// A picked range only stays picked while its object is the single selection and the range exists.
watch([selectedIds, objects], () => {
  const r = selectedRange.value;
  if (!r) return;
  const o = selectedIds.value.length === 1 && selectedIds.value[0] === r.objectId ? getObject(r.objectId) : undefined;
  if (!o?.layerRanges?.some((x) => x.id === r.rangeId)) selectedRange.value = null;
});
