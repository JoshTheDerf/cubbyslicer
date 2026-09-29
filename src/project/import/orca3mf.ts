/**
 * Orca / Bambu Studio project 3MF (BBS format, Orca's bbs_3mf.cpp): objects
 * with their volumes (parts, modifiers, negative parts, support blockers /
 * enforcers) and per-object / per-volume settings from
 * Metadata/model_settings.config, the plate list with each instance's plate,
 * painted facets, the project's settings (Metadata/project_settings.config)
 * and, for sliced files, each plate's G-code (Metadata/plate_N.gcode).
 */
import { unzipSync, strFromU8, type Unzipped } from 'fflate';
import { ImportError, checkTriangleBudget } from '../mesh';
import { mat4Identity, mat4Multiply, type Mat4 } from '../math';
import type { PaintLayers } from '../../engine/types';
import type { PartType } from '../types';
import { findEntry, normPath, parseModelPart, type ModelPart, type ObjDef } from './threemf';
import { attr, parseAttrs, scanXml } from './xml';

export interface OrcaVolume {
  name: string;
  type: PartType;
  /** Object-local positions (volume transform baked). */
  positions: Float32Array;
  indices: Uint32Array;
  paint: PaintLayers;
  config: Record<string, string>;
}

export interface OrcaInstance { transform: Mat4; printable: boolean; plate: number }

export interface OrcaObject {
  name: string;
  volumes: OrcaVolume[];
  config: Record<string, string>;
  instances: OrcaInstance[];
}

export interface OrcaPlate { name: string; locked: boolean; config: Record<string, string>; gcode?: Uint8Array }

export interface OrcaProject {
  objects: OrcaObject[];
  plates: OrcaPlate[];
  /** Metadata/project_settings.config (flat Orca config), when present. */
  settings: Record<string, unknown> | null;
  /** Printable area of the printer the project was made for (bed coordinates). */
  printableArea: Array<[number, number]> | null;
  producer: string;
  warnings: string[];
}

/** model_settings.config part subtypes → our part types. */
const SUBTYPES: Record<string, PartType> = {
  normal_part: 'part', negative_part: 'negative', modifier_part: 'modifier', support_blocker: 'support_blocker', support_enforcer: 'support_enforcer',
};
/** Metadata keys that describe the volume / object rather than being config overrides. */
const NOT_CONFIG = new Set(['name', 'matrix', 'source_file', 'source_object_id', 'source_volume_id', 'source_offset_x', 'source_offset_y',
  'source_offset_z', 'source_in_inches', 'source_in_meters', 'mesh_stat', 'volume_type', 'is_modifier', 'text_info', 'face_count',
  'backup_id', 'label_object_id', 'identify_id']);

interface CfgObject { name?: string; config: Record<string, string>; parts: Map<string, { name?: string; type: PartType; config: Record<string, string> }> }

function readModelSettings(bytes: Uint8Array): { objects: Map<string, CfgObject>; plates: Array<{ id: number; name: string; locked: boolean; config: Record<string, string>; gcode?: string; instances: Array<[string, number]> }> } {
  const objects = new Map<string, CfgObject>();
  const plates: Array<{ id: number; name: string; locked: boolean; config: Record<string, string>; gcode?: string; instances: Array<[string, number]> }> = [];
  let obj: CfgObject | null = null;
  let part: { name?: string; type: PartType; config: Record<string, string> } | null = null;
  let plate: (typeof plates)[number] | null = null;
  let inst: { object?: string; instance?: number } | null = null;
  scanXml(bytes, (t) => {
    switch (t.name) {
      case 'object':
        if (t.close) { obj = null; break; }
        obj = { config: {}, parts: new Map() };
        objects.set(parseAttrs(t.attrs).id ?? '', obj);
        if (t.selfClosing) obj = null;
        break;
      case 'part':
      case 'volume': {
        if (t.close) { part = null; break; }
        if (!obj) break;
        const a = parseAttrs(t.attrs);
        part = { type: SUBTYPES[a.subtype ?? 'normal_part'] ?? 'part', config: {} };
        obj.parts.set(a.id ?? String(obj.parts.size), part);
        if (t.selfClosing) part = null;
        break;
      }
      case 'plate':
        if (t.close) { if (plate) plates.push(plate); plate = null; break; }
        plate = { id: plates.length + 1, name: '', locked: false, config: {}, instances: [] };
        break;
      case 'model_instance':
        if (t.close) { if (plate && inst?.object !== undefined) plate.instances.push([inst.object, inst.instance ?? 0]); inst = null; break; }
        inst = {};
        break;
      case 'metadata': {
        if (t.close) break;
        const key = attr(t.attrs, 'key'), value = attr(t.attrs, 'value') ?? '';
        if (!key) break;
        if (inst) {
          if (key === 'object_id') inst.object = value;
          else if (key === 'instance_id') inst.instance = Number(value) || 0;
        } else if (plate) {
          if (key === 'plater_id') plate.id = Number(value) || plate.id;
          else if (key === 'plater_name') plate.name = value;
          else if (key === 'locked') plate.locked = value === 'true' || value === '1';
          else if (key === 'gcode_file') plate.gcode = value;
          else if (['bed_type', 'print_sequence', 'spiral_mode', 'first_layer_print_sequence', 'other_layers_print_sequence'].includes(key)) {
            plate.config[key === 'bed_type' ? 'curr_bed_type' : key] = key === 'spiral_mode' ? (value === 'true' || value === '1' ? '1' : '0') : value.replace(/ /g, ',');
          }
        } else if (part) {
          if (key === 'name') part.name = value; else if (!NOT_CONFIG.has(key)) part.config[key] = value;
        } else if (obj) {
          if (key === 'name') obj.name = value; else if (!NOT_CONFIG.has(key)) obj.config[key] = value;
        }
        break;
      }
    }
  });
  return { objects, plates };
}

/** Is this 3MF an Orca / Bambu project (vs a plain mesh 3MF)? */
export function isOrcaProject(files: Unzipped): boolean {
  return !!findEntry(files, 'Metadata/model_settings.config') || Object.keys(files).some((k) => /^Metadata\/plate_\d+\.gcode$/i.test(k));
}

function unzip(buffer: ArrayBuffer): Unzipped {
  try {
    return unzipSync(new Uint8Array(buffer), { filter: (f) => /\.model$|\.rels$|\.config$|^Metadata\/plate_\d+\.gcode$/i.test(f.name) });
  } catch (e) {
    throw new ImportError(`Not a valid 3MF (zip) file: ${(e as Error).message}`);
  }
}

/** Quick check without keeping the archive (G-code can be big). */
export function sniffOrcaProject(buffer: ArrayBuffer): boolean {
  try {
    const files = unzipSync(new Uint8Array(buffer), { filter: (f) => /^Metadata\/(model_settings\.config|plate_\d+\.gcode)$/i.test(f.name) && f.originalSize < 256 * 1024 * 1024 });
    return isOrcaProject(files);
  } catch { return false; }
}

export function parseOrca3mf(buffer: ArrayBuffer): OrcaProject {
  const files = unzip(buffer);
  const warnings: string[] = [];
  const cfgKey = findEntry(files, 'Metadata/model_settings.config');
  const settingsCfg = cfgKey ? readModelSettings(files[cfgKey]) : { objects: new Map(), plates: [] };

  let settings: Record<string, unknown> | null = null;
  const psKey = findEntry(files, 'Metadata/project_settings.config');
  if (psKey) {
    try { settings = JSON.parse(strFromU8(files[psKey])); } catch { warnings.push("The project's settings couldn't be read."); }
  }
  const printableArea = parseArea(settings?.printable_area);

  let producer = 'OrcaSlicer';
  const sliceKey = findEntry(files, 'Metadata/slice_info.config');
  if (sliceKey) {
    const txt = strFromU8(files[sliceKey]);
    if (/BambuStudio/i.test(txt)) producer = 'Bambu Studio';
  }

  // ---- geometry ----
  const parts = new Map<string, ModelPart>();
  const loadPart = (path: string): ModelPart | null => {
    const key = findEntry(files, path);
    if (!key) return null;
    const norm = normPath(key);
    let p = parts.get(norm);
    if (!p) { p = parseModelPart(files[key], norm, warnings); parts.set(norm, p); }
    return p;
  };
  const rootKey = findEntry(files, '3D/3dmodel.model') ?? Object.keys(files).find((k) => /\.model$/i.test(k));
  const root = rootKey ? loadPart(rootKey) : null;
  const resolve = (key: string): { def: ObjDef; unit: number } | null => {
    const hash = key.lastIndexOf('#');
    const part = loadPart(key.slice(0, hash));
    const def = part?.objects.get(key.slice(hash + 1));
    return def && part ? { def, unit: part.unit } : null;
  };

  const objects: OrcaObject[] = [];
  const byId = new Map<string, OrcaObject>();
  let totalTris = 0;
  const bake = (def: ObjDef, m: Mat4, unit: number): { positions: Float32Array; indices: Uint32Array } => {
    const p = def.positions!, out = new Float32Array(p.length);
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i] * unit, y = p[i + 1] * unit, z = p[i + 2] * unit;
      out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
      out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
      out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    }
    totalTris += def.indices!.length / 3;
    checkTriangleBudget(totalTris);
    return { positions: out, indices: def.indices! };
  };

  const itemCount = new Map<string, number>();
  for (const item of root?.build ?? []) {
    const id = item.key.slice(item.key.lastIndexOf('#') + 1);
    const n = itemCount.get(id) ?? 0;
    itemCount.set(id, n + 1);
    let o = byId.get(id);
    if (!o) {
      const r = resolve(item.key);
      if (!r) { warnings.push(`3MF references missing object ${id}.`); continue; }
      const cfg = settingsCfg.objects.get(id);
      const volumes: OrcaVolume[] = [];
      const addVolume = (def: ObjDef, m: Mat4, unit: number, partId: string) => {
        if (!def.positions || !def.indices || !def.indices.length) return;
        if (def.type === 'support' || def.type === 'solidsupport') return;
        const pc = cfg?.parts.get(partId);
        volumes.push({
          name: pc?.name || def.name || `Part ${volumes.length + 1}`,
          type: pc?.type ?? 'part',
          ...bake(def, m, unit),
          paint: def.paint ?? {},
          config: pc?.config ?? {},
        });
      };
      if (r.def.components.length) {
        for (const c of r.def.components) {
          const cr = resolve(c.key);
          if (!cr) { warnings.push(`3MF references missing part ${c.key}.`); continue; }
          const t = r.unit === 1 ? c.transform : [...c.transform.slice(0, 12), c.transform[12] * r.unit, c.transform[13] * r.unit, c.transform[14] * r.unit, 1];
          addVolume(cr.def, t, cr.unit, c.key.slice(c.key.lastIndexOf('#') + 1));
        }
      } else addVolume(r.def, mat4Identity(), r.unit, id);
      if (!volumes.length) continue;
      // The object's own mesh has to be a model part.
      const first = volumes.findIndex((v) => v.type === 'part');
      if (first < 0) { warnings.push(`${cfg?.name ?? r.def.name ?? id} has no model part; skipped.`); continue; }
      if (first > 0) volumes.unshift(volumes.splice(first, 1)[0]);
      o = { name: cfg?.name || r.def.name || `Object ${objects.length + 1}`, volumes, config: cfg?.config ?? {}, instances: [] };
      byId.set(id, o);
      objects.push(o);
    }
    const u = root!.unit;
    const tr = u === 1 ? item.transform : [...item.transform.slice(0, 12), item.transform[12] * u, item.transform[13] * u, item.transform[14] * u, 1];
    o.instances.push({ transform: mat4Multiply(tr, mat4Identity()), printable: item.printable, plate: plateOf(settingsCfg.plates, id, n) });
  }

  // ---- plates (+ sliced G-code) ----
  const plateCount = Math.max(1, settingsCfg.plates.length, ...objects.flatMap((o) => o.instances.map((i) => i.plate + 1)),
    ...Object.keys(files).map((k) => /^Metadata\/plate_(\d+)\.gcode$/i.exec(k)?.[1]).filter(Boolean).map(Number));
  const plates: OrcaPlate[] = Array.from({ length: plateCount }, (_, i) => {
    const p = settingsCfg.plates.find((x) => x.id === i + 1);
    const gk = findEntry(files, p?.gcode || `Metadata/plate_${i + 1}.gcode`);
    return { name: p?.name ?? '', locked: p?.locked ?? false, config: p?.config ?? {}, gcode: gk ? files[gk] : undefined };
  });
  if (!objects.length && !plates.some((p) => p.gcode)) throw new ImportError('This 3MF has no models and no sliced G-code.');
  return { objects, plates, settings, printableArea, producer, warnings };
}

/** Plate index (0-based) of the n-th build item of object `id`; 0 when the file has no plate list. */
function plateOf(plates: Array<{ id: number; instances: Array<[string, number]> }>, id: string, n: number): number {
  for (const p of plates) if (p.instances.some(([o, i]) => o === id && i === n)) return p.id - 1;
  return 0;
}

function parseArea(v: unknown): Array<[number, number]> | null {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : null;
  if (!list) return null;
  const pts = list.map((s) => String(s).split('x').map(Number)).filter((p) => p.length === 2 && p.every(Number.isFinite)) as Array<[number, number]>;
  return pts.length >= 3 ? pts : null;
}
