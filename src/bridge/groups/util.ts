/**
 * Shared helpers for the bridge tool groups: schema shorthands, argument
 * readers that resolve ids against the project (with errors that say where
 * to get valid ones), bed-coordinate conversion and object / part rows.
 *
 * Coordinates: the slicer is Z-up, mm. "Bed coordinates" are the printer's
 * own (what the G-code uses): each plate is a copy of the bed, so a position
 * is relative to the plate the object is on.
 */
import { argString, type JsonSchema } from '@cubby/shared/bridge';
import type { ConfigValue } from '../../engine/types';
import { resolvedConfig } from '../../app/state';
import { currentPresets, presetsSettled } from '../../presets/store';
import type { PresetInfo } from '../../presets/types';
import {
  bed, getMesh, getMeshPaint, getObject, instancesOf, objectInfo, objectIssues, objectLocalBBox, objectPlate, objects, plates,
} from '../../project/store';
import { eulerFromQuat, type Vec3 } from '../../project/math';
import { plateOffset } from '../../project/plates';
import type { ObjectPart, ProjectObject } from '../../project/types';
import { profileSummary } from '../logic';

export const obj = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ type: 'object', properties, required });
export const str = (description: string, extra: JsonSchema = {}): JsonSchema => ({ type: 'string', description, ...extra });
export const num = (description: string, extra: JsonSchema = {}): JsonSchema => ({ type: 'number', description, ...extra });
export const bool = (description: string): JsonSchema => ({ type: 'boolean', description });
export const vec3s = (description: string): JsonSchema => ({ type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description });
export const strList = (description: string): JsonSchema => ({ type: 'array', items: { type: 'string' }, description });
export const oneOfS = (values: readonly string[], description: string): JsonSchema => ({ type: 'string', enum: [...values], description });

export const round = (v: number, d = 2): number => { const f = 10 ** d; return Math.round(v * f) / f || 0; };
export const r3 = (v: readonly number[], d = 2): number[] => v.map((x) => round(x, d));
export const DEG = 180 / Math.PI;

export function fmtTime(sec: number): string {
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

export function sum(a: number[] | undefined): number { return (a ?? []).reduce((s, v) => s + v, 0); }

/** Wait for a preset change to settle into the resolved config. */
export async function settled(): Promise<void> {
  await presetsSettled();
  await new Promise((r) => setTimeout(r, 200));
  await presetsSettled();
}

// ---- ids --------------------------------------------------------------------------------------

/** The object named by `args[key]` (default "objectId"). */
export function objectArg(args: Record<string, unknown>, key = 'objectId'): ProjectObject {
  const id = argString(args, key);
  const o = getObject(id!);
  if (!o) throw new Error(`No object "${id}". Object ids: ${objects.value.map((x) => `${x.id} (${x.name})`).slice(0, 30).join(', ') || 'none (the project is empty)'}. Use list_objects.`);
  return o;
}

/** Object ids from `args[key]` (default "ids"), all existing; `all: true` = every object. */
export function idsArg(args: Record<string, unknown>, key = 'ids', opts: { allowAll?: boolean } = {}): string[] {
  if (opts.allowAll && args.all === true) return objects.value.map((o) => o.id);
  const v = args[key];
  if (!Array.isArray(v) || !v.length || !v.every((x) => typeof x === 'string')) {
    throw new Error(`Pass "${key}": a list of object ids from list_objects${opts.allowAll ? ', or all: true' : ''}.`);
  }
  const missing = v.filter((id) => !getObject(id as string));
  if (missing.length) throw new Error(`Unknown object id${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. Use list_objects.`);
  return [...new Set(v as string[])];
}

export function partArg(o: ProjectObject, partId: unknown): ObjectPart {
  const p = typeof partId === 'string' ? o.parts?.find((x) => x.id === partId) : undefined;
  if (!p) throw new Error(`Object ${o.id} has no part "${String(partId)}". Its parts: ${(o.parts ?? []).map((x) => `${x.id} (${x.name}, ${x.type})`).join(', ') || 'none'}.`);
  return p;
}

/** 1-based plate number → 0-based index. */
export function plateArg(args: Record<string, unknown>, key = 'plate'): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  const n = plates.value.length;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > n) throw new Error(`"${key}" must be a plate number from 1 to ${n}.`);
  return v - 1;
}

// ---- bed coordinates ---------------------------------------------------------------------------

/** World offset of plate `i` (objects on it sit at bed coordinates + this). */
export function plateOrigin(i: number): [number, number] {
  return i >= 0 ? plateOffset(i, plates.value.length, bed.value) : [0, 0];
}

/** Plate an object is on (0-based, -1 = off every plate). */
export function plateIndexOf(id: string): number { return objectPlate.value.get(id) ?? -1; }

/** World bbox of an object in bed coordinates of its plate. */
export function bedBox(id: string): { min: number[]; max: number[] } | null {
  const i = objectInfo.value.get(id);
  if (!i) return null;
  const [ox, oy] = plateOrigin(plateIndexOf(id));
  return { min: [i.min[0] - ox, i.min[1] - oy, i.min[2]], max: [i.max[0] - ox, i.max[1] - oy, i.max[2]] };
}

// ---- rows ---------------------------------------------------------------------------------------

export function presetRow(p: PresetInfo) {
  return { id: p.id, name: p.name, source: p.source, vendor: p.vendor, ...(p.filamentType ? { type: p.filamentType } : {}) };
}

export function filamentRows() {
  const p = currentPresets.value;
  return p.selection.filaments.map((_, i) => ({ filament: i + 1, ...presetRow(p.selectedInfo('filament', i)), colour: p.filamentColour(i), unsavedEdits: p.dirtyCount('filament', i) || undefined }));
}

function extruderOf(ov: Record<string, ConfigValue>): number | undefined {
  const v = ov.extruder;
  const n = parseInt(String(Array.isArray(v) ? v[0] : v ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function partRow(p: ObjectPart) {
  const m = getMesh(p.meshId);
  const size = m ? [0, 1, 2].map((k) => round((m.bbox.max[k] - m.bbox.min[k]) * Math.abs(p.scale[k]))) : null;
  return {
    id: p.id, name: p.name, type: p.type,
    position: r3(p.position), rotation: r3(eulerFromQuat(p.rotation).map((r) => r * DEG)), scale: r3(p.scale, 4),
    size, filament: extruderOf(p.overrides),
    overrides: Object.keys(p.overrides).length ? p.overrides : undefined,
    emboss: p.emboss ? (p.emboss.kind === 'text' ? { kind: 'text', text: p.emboss.text } : { kind: 'svg', name: p.emboss.name }) : undefined,
  };
}

/** A short row per object (get_state). */
export function objectBrief(id: string) {
  const o = getObject(id)!;
  const b = bedBox(id);
  return {
    id: o.id, name: o.name, plate: plateIndexOf(id) + 1,
    size: b ? b.max.map((v, i) => round(v - b.min[i])) : null,
    printable: o.printable, visible: o.visible,
    issues: objectIssues.value.get(id)?.length ? objectIssues.value.get(id) : undefined,
  };
}

/** Everything list_objects reports about one object. */
export function objectDetail(id: string) {
  const o = getObject(id)!;
  const b = bedBox(id);
  const mesh = getMesh(o.meshId);
  const local = objectLocalBBox(o);
  const paint = getMeshPaint(o.meshId);
  const insts = instancesOf(id);
  return {
    id: o.id, name: o.name, plate: plateIndexOf(id) + 1,
    // Footprint centre + bottom, like Orca's Position row (bed coordinates of its plate).
    position: b ? [round((b.min[0] + b.max[0]) / 2), round((b.min[1] + b.max[1]) / 2), round(b.min[2])] : null,
    bbox: b ? { min: r3(b.min), max: r3(b.max) } : null,
    size: local ? [0, 1, 2].map((k) => round((local.max[k] - local.min[k]) * Math.abs(o.scale[k]))) : null,
    rotation: r3(eulerFromQuat(o.rotation).map((r) => r * DEG)),
    scale: r3(o.scale, 4),
    visible: o.visible, printable: o.printable, color: o.color || undefined,
    filament: extruderOf(o.overrides) ?? 1,
    triangles: mesh?.triangleCount ?? 0,
    instances: insts.length > 1 ? insts.map((x) => x.id) : undefined,
    issues: objectIssues.value.get(id)?.length ? objectIssues.value.get(id) : undefined,
    overrides: Object.keys(o.overrides).length ? o.overrides : undefined,
    parts: o.parts?.length ? o.parts.map(partRow) : undefined,
    heightRanges: o.layerRanges?.length ? o.layerRanges.map((r) => ({ id: r.id, min: r.min, max: r.max, overrides: r.overrides })) : undefined,
    variableLayerHeight: o.layerHeightProfile?.length ? profileSummary(o.layerHeightProfile) : undefined,
    paint: Object.keys(paint).length ? Object.fromEntries(Object.entries(paint).map(([k, v]) => [k, `${v?.length ?? 0} triangles`])) : undefined,
    brimEars: o.brimPoints?.length || undefined,
    emboss: o.emboss ? (o.emboss.kind === 'text' ? { kind: 'text', text: o.emboss.text } : { kind: 'svg', name: o.emboss.name }) : undefined,
  };
}

/** A resolved config value as a plain number (first element of a vector). */
export function cfgNumber(key: string, fallback: number): number {
  const v = resolvedConfig.value[key];
  const n = parseFloat(String(Array.isArray(v) ? v[0] : v ?? ''));
  return Number.isFinite(n) ? n : fallback;
}

export type { Vec3 };
