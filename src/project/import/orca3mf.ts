/**
 * Orca / Bambu Studio project 3MF (BBS format, Orca 2.5.0 Format/bbs_3mf.cpp;
 * 2.4.x and Bambu Studio projects read too): objects with their volumes
 * (parts, modifiers, negative parts, support blockers / enforcers, precise
 * seams) and per-object / per-volume settings from
 * Metadata/model_settings.config, the plate list with each instance's plate
 * and per-plate settings, painted facets, variable layer heights, height
 * ranges, brim ears, the slider's custom G-code, the project's settings
 * (Metadata/project_settings.config or a published file's payload) and, for
 * sliced files, each plate's G-code.
 *
 * What CubbySlicer doesn't model is returned for passthrough (`keep`, the
 * kept archive entries and model metadata) so a save writes it back.
 */
import type { CustomGcodeItem, PaintLayers } from '../../engine/types';
import { ImportError, checkTriangleBudget } from '../mesh';
import { mat4Identity, type Mat4 } from '../math';
import type { BrimPoint, PartType, PreciseSeamType } from '../types';
import { entryBytes, findEntry, normPath, unzipArchive, type Archive } from './archive';
import {
  BRIM_EARS_FILE, CAD_RECIPE_FILE, CUSTOM_GCODE_FILE, CUT_INFO_FILE, GCODE_TYPE_NAME, LAYER_HEIGHTS_FILE, LAYER_RANGES_FILE,
  LEGACY_CAD_RECIPE_FILE, MAX_CAD_RECIPE_BYTES, MODEL_FILE, MODEL_SETTINGS_FILE, OBJECT_KEY_DROP, OWN_MODEL_METADATA, PART_TYPE_OF,
  PLATE_KEYS, PLATE_KEY_ALIASES, PLATE_META_DROP, PRECISE_SEAM_CONFIG_PREFIX, PRECISE_SEAM_TYPE_KEY, PROJECT_SETTINGS_FILE,
  PUBLISHED_METADATA, SLICE_INFO_FILE, VOLUME_ELEMENT_DROP, VOLUME_KEY_DROP, VOLUME_KEY_MESH, isKeptEntry, isPreciseSeamType,
} from './orcaFormat';
import { parseModelPart, type ModelPart, type ObjDef, type TriangleAttrs } from './threemf';
import { attr, attrList, decodeEntities, parseAttrs, readModelMetadata, scanXml, tagXml } from './xml';
import { readPublished, type OrcaPublished } from './published';

export type { OrcaPublished } from './published';

type Pairs = Array<[string, string]>;

/** What an element carried that CubbySlicer doesn't model (becomes ElementPassthrough). */
export interface OrcaKeep { metadata: Pairs; attrs: Pairs; elements: string[] }
export interface OrcaVolumeKeep extends OrcaKeep { meshMetadata: Pairs; subtype?: string }

export interface OrcaVolume {
  name: string;
  type: PartType;
  /** A precise seam volume (then `type` is 'modifier'); `config` holds its dormant settings. */
  preciseSeam?: { type: PreciseSeamType; config: Record<string, string> };
  /** Object-local positions (volume transform baked). */
  positions: Float32Array;
  indices: Uint32Array;
  paint: PaintLayers;
  triangleAttrs?: TriangleAttrs;
  /** Setting candidates, serialized (the engine's schema decides which are overrides). */
  config: Record<string, string>;
  keep: OrcaVolumeKeep;
}

/**
 * An instance's assemble state (model_settings.config `<assemble_item>`,
 * ModelInstance assemble transformation + offset_to_assembly): the 3MF
 * matrix (12 numbers, column by column) and the offset, as Orca parses them.
 */
export interface OrcaAssemble { matrix: number[]; offset: [number, number, number] }

export interface OrcaInstance {
  transform: Mat4; printable: boolean; plate: number;
  /** From the file's `<assemble>` section; absent when the file has no item for this instance. */
  assemble?: OrcaAssemble;
}

export interface OrcaLayerRange { min: number; max: number; config: Record<string, string> }

export interface OrcaObject {
  name: string;
  volumes: OrcaVolume[];
  config: Record<string, string>;
  keep: OrcaKeep;
  instances: OrcaInstance[];
  layerHeightProfile?: number[];
  layerRanges?: OrcaLayerRange[];
  /** Mesh-local (the object's own volume frame), Orca BrimPoint. */
  brimPoints?: BrimPoint[];
  /** Inner XML of this object's Metadata/cut_information.xml entry. */
  cutInfo?: string;
}

export interface OrcaPlate {
  name: string;
  locked: boolean;
  /** Per-plate settings by config key, serialized. */
  config: Record<string, string>;
  keep: Pick<OrcaKeep, 'metadata'>;
  customGcodes: CustomGcodeItem[];
  gcode?: Uint8Array;
}

export interface OrcaProject {
  objects: OrcaObject[];
  plates: OrcaPlate[];
  /** Metadata/project_settings.config (flat Orca config), when present. */
  settings: Record<string, unknown> | null;
  /** Set for a published 3MF (it has no project_settings.config). */
  published: OrcaPublished | null;
  /** Printable area of the printer the project was made for (bed coordinates). */
  printableArea: Array<[number, number]> | null;
  producer: string;
  /** The model's "OrcaSlicer" and "Application" tags. */
  version: { orca?: string; application?: string };
  /** Model `<metadata name>` items the writer doesn't set itself (designer, licence, MakerLab, …), in file order. */
  modelMetadata: Pairs;
  /** Archive entries kept verbatim (Design tab recipe, texture layers, SVG shapes, Auxiliaries, embedded presets). */
  keptFiles: Record<string, Uint8Array>;
  warnings: string[];
}

const emptyKeep = (): OrcaKeep => ({ metadata: [], attrs: [], elements: [] });

interface CfgPart {
  name?: string;
  type: PartType;
  seamType?: string;
  config: Record<string, string>;
  seamConfig: Pairs;
  keep: OrcaVolumeKeep;
}
interface CfgObject { name?: string; config: Record<string, string>; keep: OrcaKeep; hasAutoDrop: boolean; parts: Map<string, CfgPart> }
interface CfgPlate {
  id: number; name: string; locked: boolean; config: Record<string, string>; metadata: Pairs; gcode?: string; instances: Array<[string, number]>;
}

function partTypeOf(subtype: string, part: CfgPart): void {
  const t = PART_TYPE_OF[subtype];
  if (t) { part.type = t; delete part.keep.subtype; return; }
  part.type = 'modifier';
  // Pre-release 2.5 files wrote the seam type as the subtype itself.
  if (isPreciseSeamType(subtype)) { part.seamType = subtype; delete part.keep.subtype; } else part.keep.subtype = subtype;
}

/** atof over a whitespace-free token (0 when it isn't a number), as bbs_3mf.cpp reads matrices. */
const atof = (t: string) => { const v = parseFloat(t); return Number.isNaN(v) ? 0 : v; };

/** bbs_get_transform_from_3mf_specs_string: 12 space-separated numbers, else identity. */
export function assembleMatrixOf(s: string | undefined): number[] {
  const parts = s ? s.split(/ +/) : [];
  return parts.length === 12 ? parts.map(atof) : [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
}
/** bbs_get_offset_from_3mf_specs_string: 3 space-separated numbers, else zero. */
export function assembleOffsetOf(s: string | undefined): [number, number, number] {
  const parts = s ? s.split(/ +/) : [];
  return parts.length === 3 ? [atof(parts[0]), atof(parts[1]), atof(parts[2])] : [0, 0, 0];
}

function readModelSettings(bytes: Uint8Array): { objects: Map<string, CfgObject>; plates: CfgPlate[]; assemble: Map<string, OrcaAssemble> } {
  const objects = new Map<string, CfgObject>();
  const plates: CfgPlate[] = [];
  // `<assemble_item>` by "objectId:instanceIndex" (_handle_start_assemble_item).
  const assemble = new Map<string, OrcaAssemble>();
  let obj: CfgObject | null = null;
  let part: CfgPart | null = null;
  let plate: CfgPlate | null = null;
  let inst: { object?: string; instance?: number } | null = null;
  // An element we don't model, captured as XML until it closes.
  let capture: { into: string[]; buf: string[]; depth: number } | null = null;
  scanXml(bytes, (t) => {
    if (capture) {
      capture.buf.push(tagXml(t));
      if (t.close) capture.depth--; else if (!t.selfClosing) capture.depth++;
      if (capture.depth === 0) { capture.into.push(capture.buf.join('')); capture = null; }
      return;
    }
    switch (t.name) {
      case 'config':
        return;
      case 'object': {
        if (plate) return;
        if (t.close) { obj = null; return; }
        const a = attrList(t.attrs);
        obj = { config: {}, keep: emptyKeep(), hasAutoDrop: false, parts: new Map() };
        for (const [k, v] of a) {
          if (k === 'id') continue;
          if (k === 'auto_drop') obj.hasAutoDrop = true;
          obj.keep.attrs.push([k, v]);
        }
        objects.set(a.find(([k]) => k === 'id')?.[1] ?? '', obj);
        if (t.selfClosing) obj = null;
        return;
      }
      case 'part':
      case 'volume': {
        if (t.close) { part = null; return; }
        if (!obj) return;
        const a = parseAttrs(t.attrs);
        part = { type: 'part', config: {}, seamConfig: [], keep: { ...emptyKeep(), meshMetadata: [] } };
        partTypeOf(a.subtype ?? 'normal_part', part);
        for (const [k, v] of Object.entries(a)) if (k !== 'id' && k !== 'subtype') part.keep.attrs.push([k, v]);
        obj.parts.set(a.id ?? String(obj.parts.size), part);
        if (t.selfClosing) part = null;
        return;
      }
      case 'plate':
        if (t.close) { if (plate) plates.push(plate); plate = null; return; }
        plate = { id: plates.length + 1, name: '', locked: false, config: {}, metadata: [], instances: [] };
        return;
      case 'assemble':
        return;
      case 'assemble_item': {
        if (t.close || plate || obj) return;
        const a = parseAttrs(t.attrs);
        const atoi = (v: string | undefined) => Math.trunc(Number.parseInt(v ?? '', 10) || 0);
        assemble.set(`${atoi(a.object_id)}:${atoi(a.instance_id)}`, { matrix: assembleMatrixOf(a.transform), offset: assembleOffsetOf(a.offset) });
        return;
      }
      case 'model_instance':
        if (t.close) { if (plate && inst?.object !== undefined) plate.instances.push([inst.object, inst.instance ?? 0]); inst = null; return; }
        inst = {};
        return;
      case 'metadata': {
        if (t.close) return;
        const key = attr(t.attrs, 'key');
        if (!key) return; // e.g. BBS's bare <metadata face_count="…"/>
        const value = decodeEntities(attr(t.attrs, 'value') ?? '');
        if (inst) {
          if (key === 'object_id') inst.object = value;
          else if (key === 'instance_id') inst.instance = Number(value) || 0;
        } else if (plate) readPlateKey(plate, key, value);
        else if (part) readVolumeKey(part, key, value);
        else if (obj) {
          if (key === 'name') obj.name = value;
          else if (!OBJECT_KEY_DROP.has(key)) obj.config[key] = value;
        }
        return;
      }
      default: {
        // Children we don't model: kept on the volume (text / SVG shape, …) or object; mesh_stat is rebuilt.
        if (t.close || plate) return;
        const into = part ? (VOLUME_ELEMENT_DROP.has(t.name) ? null : part.keep.elements) : obj ? obj.keep.elements : null;
        if (!into) return;
        if (t.selfClosing) into.push(tagXml(t));
        else capture = { into, buf: [tagXml(t)], depth: 1 };
      }
    }
  });
  // Precise seams: the seam type applies to modifiers only; its settings stay dormant otherwise.
  for (const o of objects.values()) {
    for (const p of o.parts.values()) {
      if (p.keep.subtype) {
        // Unknown volume type: keep everything inert and verbatim.
        p.keep.metadata.unshift(...Object.entries(p.config));
        p.config = {};
      }
      const seam = p.type === 'modifier' && !p.keep.subtype && p.seamType && isPreciseSeamType(p.seamType) ? p.seamType : null;
      if (!seam) {
        if (p.seamType) p.keep.metadata.push([PRECISE_SEAM_TYPE_KEY, p.seamType]);
        p.keep.metadata.push(...p.seamConfig);
      }
    }
  }
  return { objects, plates, assemble };
}

function readVolumeKey(part: CfgPart, key: string, value: string): void {
  if (key === 'name') part.name = value;
  else if (key === 'volume_type' || key === 'part_type') partTypeOf(value, part);
  else if (key === PRECISE_SEAM_TYPE_KEY) part.seamType = value;
  else if (key.startsWith(PRECISE_SEAM_CONFIG_PREFIX)) part.seamConfig.push([key, value]);
  else if (VOLUME_KEY_DROP.has(key)) return;
  else if (VOLUME_KEY_MESH.has(key)) part.keep.meshMetadata.push([key, value]);
  else part.config[key] = value;
}

function readPlateKey(plate: CfgPlate, rawKey: string, value: string): void {
  const key = PLATE_KEY_ALIASES[rawKey] ?? rawKey;
  if (key === 'plater_id') plate.id = Number(value) || plate.id;
  else if (key === 'plater_name') plate.name = value;
  else if (key === 'locked') plate.locked = value === 'true' || value === '1';
  else if (key === 'gcode_file') plate.gcode = value;
  else if (PLATE_META_DROP.has(key)) return;
  else {
    const pk = PLATE_KEYS.find((k) => k.meta === key);
    if (!pk) { plate.metadata.push([rawKey, value]); return; }
    const v = pk.read(value);
    if (v !== null) plate.config[pk.key] = v;
  }
}

/** The seam volume a parsed part describes, if any. */
function seamOf(p: CfgPart): OrcaVolume['preciseSeam'] {
  if (p.type !== 'modifier' || p.keep.subtype || !p.seamType || !isPreciseSeamType(p.seamType)) return undefined;
  const config: Record<string, string> = {};
  for (const [k, v] of p.seamConfig) if (k.length > PRECISE_SEAM_CONFIG_PREFIX.length) config[k.slice(PRECISE_SEAM_CONFIG_PREFIX.length)] = v;
  return { type: p.seamType, config };
}

/** Is this 3MF an Orca / Bambu project (vs a plain mesh 3MF)? */
export function isOrcaProject(files: Archive): boolean {
  return !!findEntry(files, MODEL_SETTINGS_FILE) || Object.keys(files).some((k) => /^Metadata\/plate_\d+\.gcode$/i.test(k));
}

/** Quick check without keeping the archive (G-code can be big). */
export function sniffOrcaProject(buffer: ArrayBuffer): boolean {
  try {
    const files = unzipArchive(buffer, (f) => /^Metadata\/(model_settings\.config|plate_\d+\.gcode)$/i.test(f.name) && f.originalSize < 256 * 1024 * 1024);
    return isOrcaProject(files);
  } catch { return false; }
}

/**
 * Unzip a project 3MF once (everything: kept entries, G-code, model parts).
 * A Design-tab recipe over 1 GiB isn't inflated (Orca's cap).
 */
export function unzipProject(buffer: ArrayBuffer | Uint8Array, warnings?: string[]): Archive {
  return unzipArchive(buffer, (f) => {
    if (!isCadRecipe(f.name) || f.originalSize <= MAX_CAD_RECIPE_BYTES) return true;
    warnings?.push('The design (Metadata/orca_cad.bin) is larger than 1 GiB and wasn’t kept.');
    return false;
  });
}

const isCadRecipe = (name: string) => {
  const l = name.toLowerCase();
  return l === CAD_RECIPE_FILE.toLowerCase() || l === LEGACY_CAD_RECIPE_FILE.toLowerCase();
};

/**
 * Archive entries a save keeps. The legacy Design-tab recipe name is read when
 * the current one is missing and written back under the current name.
 */
export function keptEntries(files: Archive): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  for (const [name, bytes] of Object.entries(files)) {
    if (isKeptEntry(name) && !isCadRecipe(name)) out[name] = bytes;
  }
  const recipe = entryBytes(files, CAD_RECIPE_FILE) ?? entryBytes(files, LEGACY_CAD_RECIPE_FILE);
  if (recipe?.length) out[CAD_RECIPE_FILE] = recipe;
  return out;
}

/** Model metadata of the root model file: version tags, passthrough items, published payload. */
function readRootMetadata(bytes: Uint8Array | undefined): { version: OrcaProject['version']; keep: Pairs; published: OrcaPublished | null; warnings: string[] } {
  const items = bytes ? readModelMetadata(bytes) : [];
  const get = (k: string) => items.find(([n]) => n === k)?.[1];
  const keep = items.filter(([n]) => !OWN_MODEL_METADATA.has(n) && !PUBLISHED_METADATA.has(n));
  const version = { orca: get('OrcaSlicer'), application: get('Application') };
  const warnings: string[] = [];
  const published = readPublished(get, warnings);
  return { version, keep, published, warnings };
}

export function parseOrca3mf(input: ArrayBuffer | Archive): OrcaProject {
  const warnings: string[] = [];
  const files = input instanceof ArrayBuffer ? unzipProject(input, warnings) : input;
  const cfgBytes = entryBytes(files, MODEL_SETTINGS_FILE);
  const settingsCfg = cfgBytes ? readModelSettings(cfgBytes) : { objects: new Map<string, CfgObject>(), plates: [] as CfgPlate[], assemble: new Map<string, OrcaAssemble>() };

  let settings: Record<string, unknown> | null = null;
  const ps = entryBytes(files, PROJECT_SETTINGS_FILE);
  if (ps) {
    try {
      const v = JSON.parse(new TextDecoder().decode(ps)) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) settings = v as Record<string, unknown>;
    } catch { warnings.push("The project's settings couldn't be read."); }
  }

  let producer = 'OrcaSlicer';
  const sliceInfo = entryBytes(files, SLICE_INFO_FILE);
  if (sliceInfo && /BambuStudio/i.test(new TextDecoder().decode(sliceInfo))) producer = 'Bambu Studio';

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
  const rootKey = findEntry(files, MODEL_FILE) ?? Object.keys(files).find((k) => /\.model$/i.test(k));
  const rootMeta = readRootMetadata(rootKey ? files[rootKey] : undefined);
  warnings.push(...rootMeta.warnings);
  const root = rootKey ? loadPart(rootKey) : null;
  // Orca tells its own projects by the "OrcaSlicer" tag; without it the file is Bambu Studio's.
  if (/^BambuStudio-/.test(rootMeta.version.application ?? '') && !rootMeta.version.orca) producer = 'Bambu Studio';
  const resolve = (key: string): { def: ObjDef; unit: number } | null => {
    const hash = key.lastIndexOf('#');
    const part = loadPart(key.slice(0, hash));
    const def = part?.objects.get(key.slice(hash + 1));
    return def && part ? { def, unit: part.unit } : null;
  };

  const perObject = readPerObjectFiles(files, warnings);
  const objects: OrcaObject[] = [];
  const byId = new Map<string, OrcaObject | null>();
  let orcaIndex = 0;
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
  const autoDropOff = new Set<string>();
  for (const item of root?.build ?? []) {
    const id = item.key.slice(item.key.lastIndexOf('#') + 1);
    const n = itemCount.get(id) ?? 0;
    itemCount.set(id, n + 1);
    if (item.autoDrop === false) autoDropOff.add(id); // 2.4.x layout: on build items, any "off" wins
    let o = byId.get(id);
    if (o === undefined) {
      const r = resolve(item.key);
      if (!r) { warnings.push(`3MF references missing object ${id}.`); byId.set(id, null); continue; }
      const index = ++orcaIndex;
      const built = buildObject(id, r, settingsCfg.objects.get(id), resolve, bake, warnings);
      o = null;
      if (built) {
        const { reordered, ...obj } = built;
        const extra = { ...perObject.get(index) };
        // Cut connectors name volumes by index: stale once the model part moved to the front.
        if (reordered) delete extra.cutInfo;
        o = Object.assign(obj, extra);
        objects.push(o);
      }
      byId.set(id, o);
    }
    if (!o) continue;
    const u = root!.unit;
    const tr = u === 1 ? item.transform : [...item.transform.slice(0, 12), item.transform[12] * u, item.transform[13] * u, item.transform[14] * u, 1];
    const asm = settingsCfg.assemble.get(`${Math.trunc(Number.parseInt(id, 10) || 0)}:${n}`);
    o.instances.push({ transform: tr, printable: item.printable, plate: plateOf(settingsCfg.plates, id, n), ...(asm ? { assemble: asm } : {}) });
  }
  // 2.4.x stored auto_drop on build items; 2.5 on the object.
  for (const [id, o] of byId) {
    if (o && autoDropOff.has(id) && !settingsCfg.objects.get(id)?.hasAutoDrop) o.keep.attrs.push(['auto_drop', '0']);
  }

  // ---- plates (+ custom G-code, sliced G-code) ----
  const customGcodes = readCustomGcodes(entryBytes(files, CUSTOM_GCODE_FILE));
  const plateCount = Math.max(1, settingsCfg.plates.length, ...objects.flatMap((o) => o.instances.map((i) => i.plate + 1)),
    ...Object.keys(files).map((k) => /^Metadata\/plate_(\d+)\.gcode$/i.exec(k)?.[1]).filter(Boolean).map(Number));
  const plates: OrcaPlate[] = Array.from({ length: plateCount }, (_, i) => {
    const p = settingsCfg.plates.find((x) => x.id === i + 1);
    const gcode = entryBytes(files, p?.gcode || `Metadata/plate_${i + 1}.gcode`);
    return {
      name: p?.name ?? '', locked: p?.locked ?? false, config: p?.config ?? {}, keep: { metadata: p?.metadata ?? [] },
      customGcodes: customGcodes.get(i + 1) ?? [], ...(gcode ? { gcode } : {}),
    };
  });
  if (!objects.length && !plates.some((p) => p.gcode)) throw new ImportError('This 3MF has no models and no sliced G-code.');
  const source = settings ?? (rootMeta.published ? rootMeta.published.config : null);
  return {
    objects, plates, settings, published: rootMeta.published, printableArea: parseArea(source?.printable_area), producer,
    version: rootMeta.version, modelMetadata: rootMeta.keep, keptFiles: keptEntries(files), warnings,
  };
}

function buildObject(
  id: string, r: { def: ObjDef; unit: number }, cfg: CfgObject | undefined,
  resolve: (key: string) => { def: ObjDef; unit: number } | null,
  bake: (def: ObjDef, m: Mat4, unit: number) => { positions: Float32Array; indices: Uint32Array },
  warnings: string[],
): (OrcaObject & { reordered?: boolean }) | null {
  const volumes: OrcaVolume[] = [];
  const addVolume = (def: ObjDef, m: Mat4, unit: number, partId: string) => {
    if (!def.positions || !def.indices || !def.indices.length) return;
    if (def.type === 'support' || def.type === 'solidsupport') return;
    const pc = cfg?.parts.get(partId);
    const seam = pc && seamOf(pc);
    volumes.push({
      name: pc?.name || def.name || `Part ${volumes.length + 1}`,
      type: pc?.type ?? 'part',
      ...(seam ? { preciseSeam: seam } : {}),
      ...bake(def, m, unit),
      paint: def.paint ?? {},
      ...(def.triangleAttrs ? { triangleAttrs: def.triangleAttrs } : {}),
      config: pc?.config ?? {},
      keep: pc?.keep ?? { ...emptyKeep(), meshMetadata: [] },
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
  if (!volumes.length) return null;
  // The object's own mesh has to be a model part.
  const first = volumes.findIndex((v) => v.type === 'part' && !v.keep.subtype);
  if (first < 0) { warnings.push(`${cfg?.name ?? r.def.name ?? id} has no model part; skipped.`); return null; }
  if (first > 0) volumes.unshift(volumes.splice(first, 1)[0]);
  return {
    name: cfg?.name || r.def.name || `Object ${id}`, volumes, config: cfg?.config ?? {}, keep: cfg?.keep ?? emptyKeep(), instances: [],
    ...(first > 0 ? { reordered: true } : {}),
  };
}

type PerObject = Pick<OrcaObject, 'layerHeightProfile' | 'layerRanges' | 'brimPoints' | 'cutInfo'>;

/** Metadata files keyed by Orca's 1-based object index: layer heights, height ranges, brim ears, cut info. */
function readPerObjectFiles(files: Archive, warnings: string[]): Map<number, PerObject> {
  const out = new Map<number, PerObject>();
  const at = (i: number) => { let e = out.get(i); if (!e) { e = {}; out.set(i, e); } return e; };
  const text = (path: string) => { const b = entryBytes(files, path); return b ? new TextDecoder().decode(b) : null; };

  const heights = text(LAYER_HEIGHTS_FILE);
  for (const line of heights?.split('\n') ?? []) {
    const m = /^object_id=(\d+)\|(.*)$/.exec(line.trim());
    if (!m) continue;
    const v = m[2].split(';').map(Number);
    if (v.length > 4 && v.length % 2 === 0 && v.every(Number.isFinite)) at(Number(m[1])).layerHeightProfile = v;
  }

  const brims = text(BRIM_EARS_FILE);
  for (const line of brims?.split('\n') ?? []) {
    const m = /^object_id=(\d+)\|(.*)$/.exec(line.trim());
    if (!m) continue;
    const v = m[2].trim().split(/\s+/).map(Number);
    const pts: BrimPoint[] = [];
    for (let i = 0; i + 3 < v.length; i += 4) if (v.slice(i, i + 4).every(Number.isFinite)) pts.push({ pos: [v[i], v[i + 1], v[i + 2]], radius: v[i + 3] });
    if (pts.length) at(Number(m[1])).brimPoints = pts;
  }

  const ranges = text(LAYER_RANGES_FILE);
  if (ranges) {
    try {
      for (const om of ranges.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
        const id = Number(parseAttrs(om[1]).id);
        if (!(id > 0)) continue;
        const list: OrcaLayerRange[] = [];
        for (const rm of om[2].matchAll(/<range\b([^>]*)>([\s\S]*?)<\/range>/g)) {
          const a = parseAttrs(rm[1]);
          const config: Record<string, string> = {};
          for (const opt of rm[2].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)) {
            const k = parseAttrs(opt[1]).opt_key;
            if (k) config[k] = decodeEntities(opt[2]);
          }
          const min = Number(a.min_z), max = Number(a.max_z);
          if (Number.isFinite(min) && Number.isFinite(max) && max > min) list.push({ min, max, config });
        }
        if (list.length) at(id).layerRanges = list;
      }
    } catch { warnings.push('The height range modifiers couldn’t be read.'); }
  }

  const cut = text(CUT_INFO_FILE);
  for (const om of cut?.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g) ?? []) {
    const id = Number(parseAttrs(om[1]).id);
    if (id > 0 && om[2].trim()) at(id).cutInfo = om[2].trim();
  }
  return out;
}

/** Metadata/custom_gcode_per_layer.xml: items per 1-based plate id. */
function readCustomGcodes(bytes: Uint8Array | undefined): Map<number, CustomGcodeItem[]> {
  const out = new Map<number, CustomGcodeItem[]>();
  if (!bytes) return out;
  let plate = 1;
  let list: CustomGcodeItem[] = [];
  scanXml(bytes, (t) => {
    if (t.name === 'plate') {
      if (t.close) { if (list.length) out.set(plate, list); list = []; } else { plate = 1; list = []; }
    } else if (t.name === 'plate_info' && !t.close) plate = Number(attr(t.attrs, 'id')) || 1;
    else if (t.name === 'layer' && !t.close) {
      const a = parseAttrs(t.attrs);
      const z = Number(a.top_z);
      if (!Number.isFinite(z)) return;
      let type: CustomGcodeItem['type'];
      let extra = a.extra ?? '';
      if (a.type === undefined) {
        // PrusaSlicer ≤ 2.2 layout: the G-code tells the type.
        const g = a.gcode ?? '';
        type = g === 'M600' ? 'color_change' : g === 'M601' ? 'pause' : g === 'tool_change' ? 'tool_change' : 'custom';
        extra = type === 'pause' ? a.color ?? '' : type === 'custom' ? g : '';
      } else type = GCODE_TYPE_NAME[Number(a.type)] ?? 'custom';
      const item: CustomGcodeItem = { z, type };
      const e = Number(a.extruder);
      if (Number.isInteger(e) && e >= 0) item.extruder = e;
      if (a.color && /^#[0-9a-f]{6}$/i.test(a.color)) item.color = a.color;
      if (extra) item.extra = extra;
      list.push(item);
    }
  });
  // Files without <plate> sections (single plate).
  if (list.length) out.set(plate, list);
  return out;
}

/** Plate index (0-based) of the n-th build item of object `id`; 0 when the file has no plate list. */
function plateOf(plates: CfgPlate[], id: string, n: number): number {
  for (const p of plates) if (p.instances.some(([o, i]) => o === id && i === n)) return p.id - 1;
  return 0;
}

function parseArea(v: unknown): Array<[number, number]> | null {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : null;
  if (!list) return null;
  const pts = list.map((s) => String(s).split('x').map(Number)).filter((p) => p.length === 2 && p.every(Number.isFinite)) as Array<[number, number]>;
  return pts.length >= 3 ? pts : null;
}
