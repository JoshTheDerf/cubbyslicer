/**
 * Open an Orca / Bambu project 3MF as a project (Orca's "Open project"):
 * plates with their settings, objects with their parts, per-object / per-part
 * settings, painting, variable layer heights, height ranges, brim ears, each
 * instance back on its own plate, the project's printer / process / filament
 * presets (by name) plus the settings it changed (or, for a published 3MF,
 * only the author's published keys over the user's own presets), the
 * slider's custom G-code and any sliced G-code shown in the preview.
 *
 * What the file carries that CubbySlicer doesn't model is kept (the
 * `passthrough` fields and persistence/passthrough.ts) and written back on save.
 */
import { engineCaps, type ConfigSchema, type ConfigValue, type PaintLayers } from '../engine/types';
import { activeEngine } from '../app/state';
import { loadPlateGcode } from '../app/slice';
import { nextTick } from 'vue';
import { currentPresets, presetsSettled } from '../presets/store';
import { tabOfScope } from '../presets/resolve';
import { parseFilamentColour } from '../lib/colour';
import { asList, SCALAR, valueAt } from '../lib/configValue';
import { isVectorType, normalizeValue, valuesEqual } from '../presets/values';
import type { PresetInfo, PresetKind } from '../presets/types';
import { variantKey } from '../presets/variants';
import { clampModelFilamentRefs, remapPaintString } from '../presets/filamentRefs';
import { filamentSlotCount } from '../presets/filamentSlots';
import { MIXED_SLOT_KEYS, parseComponents, readMixedSlots, slotValues, splitProjectSlots, type MixedDef } from '../mixed/model';
import { slotBlock } from '../dialogs/flush/flushCalc';
import { decomposeTRS, type Mat4, type Quat, type Vec3 } from './math';
import { computeBBox } from './mesh';
import { MAX_PLATES, newPlate, plateOffset, resetPlateBedTypes, type PlateMeta } from './plates';
import { printerMayOverrideBedType } from '../app/plateBedTypes';
import { bed, loadProjectData, objects as liveObjects, projectName, uid, type ProjectData } from './store';
import type {
  ElementPassthrough, LayerRange, MeshData, ObjectPart, ObjectPassthrough, ProjectObject, VolumePassthrough,
} from './types';
import type { CadNode } from '../cad/api';
import { keptEntries, parseOrca3mf, unzipProject, type OrcaInstance, type OrcaKeep, type OrcaProject, type OrcaPublished, type OrcaVolume } from './import/orca3mf';
import { findEntry, type Archive } from './import/archive';
import { parseModelPart, type TriangleAttrs } from './import/threemf';
import { readModelMetadata } from './import/xml';
import { readOrcaIni } from './import/ini';
import {
  PUBLISH_MIXED_KEYS, PUBLISH_PRINTER_KEYS, PUBLISH_PROJECT_KEYS, PUBLISH_SLOT_LIMIT, PUBLISH_STRUCTURAL, candidateScore, isMixedDefinition,
  materialLabel, normalizeFilamentType, planPublishedSlots, publishBaseKey, publishKeyIndex, publishMaterialBaseName, relocateMixedCells,
  resolvePublishedExtruderSlot, type FilamentCandidate, type PlannedMaterial,
} from './import/published';
import { MODEL_FILE, OWN_MODEL_METADATA, PLATE_KEYS, PRECISE_SEAM_CONFIG_PREFIX, PUBLISHED_METADATA } from './import/orcaFormat';
import { CUBBY_META } from './persistence/orca3mfWriter';
import { CUBBY_CAD_META, PROJECT_FORMAT, PROJECT_VERSION, meshFromArrays, sanitizeObjects, sanitizePaint, sanitizePlates, type CadTreesJson, type ProjectJson } from './persistence/format';
import { setProjectPassthrough, type ProjectPassthrough } from './persistence/passthrough';
import { loadSections } from './persistence/sections';
import type { BedShape } from '../app/state';

export interface OrcaOpenResult {
  name: string; objects: number; plates: number; sliced: number; warnings: string[];
  /** Saved by CubbySlicer (restored exactly, including its settings). */
  own?: boolean;
  /** A published 3MF: only the author's chosen settings were applied, over the user's presets. */
  published?: boolean;
}

type Pairs = Array<[string, string]>;

/** Split serialized settings into the ones this engine knows (native shape) and the rest (kept verbatim). */
function splitConfig(src: Record<string, string>, schema: ConfigSchema | null): { config: Record<string, ConfigValue>; unknown: Pairs } {
  const config: Record<string, ConfigValue> = {};
  const unknown: Pairs = [];
  for (const [k, v] of Object.entries(src)) {
    const def = schema?.options[k];
    if (def) config[k] = normalizeValue(def, v); else unknown.push([k, v]);
  }
  return { config, unknown };
}

function bedFromArea(area: Array<[number, number]> | null): BedShape | null {
  if (!area) return null;
  const xs = area.map((p) => p[0]), ys = area.map((p) => p[1]);
  return { polygon: area, min: [Math.min(...xs), Math.min(...ys)], max: [Math.max(...xs), Math.max(...ys)], maxHeight: 0, excludeAreas: [] };
}

function meshData(id: string, positions: Float32Array, indices: Uint32Array): MeshData {
  return { id, positions, indices, bbox: computeBBox(positions), vertexCount: positions.length / 3, triangleCount: indices.length / 3 };
}

const nonEmpty = <T extends object>(o: T): T | undefined => (Object.values(o).some((v) => v !== undefined && (!Array.isArray(v) || v.length)) ? o : undefined);

function elementPassthrough(keep: Pick<OrcaKeep, 'metadata'> & Partial<OrcaKeep>, extra: Pairs = []): ElementPassthrough | undefined {
  const metadata = [...keep.metadata, ...extra];
  const out: ElementPassthrough = {
    ...(metadata.length ? { metadata } : {}), ...(keep.attrs?.length ? { attrs: keep.attrs } : {}), ...(keep.elements?.length ? { elements: keep.elements } : {}),
  };
  return Object.keys(out).length ? Object.freeze(out) : undefined;
}

function volumePassthrough(v: OrcaVolume, meshId: string, unknown: Pairs): VolumePassthrough | undefined {
  const base = elementPassthrough(v.keep, unknown) ?? {};
  const out: VolumePassthrough = {
    ...base, meshId,
    ...(v.keep.meshMetadata.length ? { meshMetadata: v.keep.meshMetadata } : {}), ...(v.keep.subtype ? { subtype: v.keep.subtype } : {}),
  };
  return Object.keys(out).length > 1 ? Object.freeze(out) : undefined;
}

/** Column-major Mat4 → the 3MF matrix layout (12 numbers, column by column). */
const matrix3mf = (m: Mat4): number[] => [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10], m[12], m[13], m[14]];
const mat4Of = (a: readonly number[]): Mat4 => [a[0], a[1], a[2], 0, a[3], a[4], a[5], 0, a[6], a[7], a[8], 0, a[9], a[10], a[11], 1] as Mat4;

/**
 * An instance's Orca assemble state: the file's `<assemble_item>`, else its
 * placement as read (Plater::priv::load_model_objects initialises every
 * instance without one). The Assembly view pose (`assembly`) only when the
 * assembled pose differs from the placement (e.g. cut pieces), moved from the
 * file's bed to ours.
 */
function assembleOf(inst: OrcaInstance, fileBed: BedShape, ourBed: BedShape): Pick<ProjectObject, 'assemble' | 'assembly'> {
  if (!inst.assemble) return { assemble: Object.freeze({ matrix: Object.freeze(matrix3mf(inst.transform as Mat4)), offset: [0, 0, 0] as Vec3 }) };
  const { matrix, offset } = inst.assemble;
  const out: Pick<ProjectObject, 'assemble' | 'assembly'> = { assemble: Object.freeze({ matrix: Object.freeze([...matrix]), offset: [...offset] as Vec3 }) };
  const placed = matrix3mf(inst.transform as Mat4);
  if (matrix.every((v, i) => Math.abs(v - placed[i]) <= 1e-4) && offset.every((v) => v === 0)) return out;
  const d = decomposeTRS(mat4Of(matrix));
  out.assembly = {
    position: [d.position[0] - fileBed.min[0] + ourBed.min[0], d.position[1] - fileBed.min[1] + ourBed.min[1], d.position[2]],
    rotation: d.rotation as Quat, scale: d.scale as Vec3,
  };
  return out;
}

export interface OrcaProjectConversion {
  data: ProjectData;
  passthrough: Partial<ProjectPassthrough>;
  warnings: string[];
}

/**
 * Turn a parsed Orca project into CubbySlicer's project data (pure apart from
 * id generation): settings split by `schema`, instances moved from the file's
 * plate grid onto ours.
 */
export function orcaProjectData(proj: OrcaProject, opts: { name: string; schema: ConfigSchema | null; bed: BedShape }): OrcaProjectConversion {
  const warnings: string[] = [];
  const ourBed = opts.bed;
  const fileBed = bedFromArea(proj.printableArea) ?? ourBed;
  const n = Math.min(MAX_PLATES, proj.plates.length);

  const meshes: MeshData[] = [];
  const paint: Record<string, PaintLayers> = {};
  const triangleAttrs: Record<string, TriangleAttrs> = {};
  const objects: ProjectObject[] = [];
  for (const o of proj.objects) {
    const ids = o.volumes.map((v) => {
      const id = uid('m');
      meshes.push(meshData(id, v.positions, v.indices));
      if (Object.keys(v.paint).length) paint[id] = v.paint;
      if (v.triangleAttrs) triangleAttrs[id] = v.triangleAttrs;
      return id;
    });
    const parts: ObjectPart[] = o.volumes.slice(1).map((v, i) => {
      const { config, unknown } = splitConfig(v.config, opts.schema);
      const seamCfg = v.preciseSeam ? splitConfig(v.preciseSeam.config, opts.schema) : null;
      const seam = v.preciseSeam ? Object.freeze({ type: v.preciseSeam.type, config: Object.freeze(seamCfg!.config) }) : undefined;
      // Seam settings this engine doesn't know stay dormant, under their prefixed key.
      const seamUnknown = (seamCfg?.unknown ?? []).map(([k, val]) => [PRECISE_SEAM_CONFIG_PREFIX + k, val] as [string, string]);
      const passthrough = volumePassthrough(v, ids[i + 1], [...unknown, ...seamUnknown]);
      return {
        id: uid('p'), name: v.name, meshId: ids[i + 1], type: v.type,
        position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], overrides: config,
        ...(seam ? { preciseSeam: seam } : {}), ...(passthrough ? { passthrough } : {}),
      };
    });
    // Orca keeps the main volume's own settings (e.g. its extruder) on the volume, where they
    // beat the object's; ours live on the object.
    const objCfg = splitConfig(o.config, opts.schema), mainCfg = splitConfig(o.volumes[0].config, opts.schema);
    const overrides = { ...objCfg.config, ...mainCfg.config };
    // The object's own volume has no name of its own here: keep it when it differs.
    if (o.volumes[0].name !== o.name) mainCfg.unknown.unshift(['name', o.volumes[0].name]);
    const passthrough: ObjectPassthrough | undefined = nonEmpty({
      object: elementPassthrough(o.keep, objCfg.unknown), volume: volumePassthrough(o.volumes[0], ids[0], mainCfg.unknown), cutInfo: o.cutInfo,
    });
    // Range settings this engine doesn't know stay with the range (never sliced) and are written back.
    const layerRanges: LayerRange[] = (o.layerRanges ?? []).map((r) => {
      if (!opts.schema) return { id: uid('lr'), min: r.min, max: r.max, overrides: { ...r.config } };
      const { config, unknown } = splitConfig(r.config, opts.schema);
      return { id: uid('lr'), min: r.min, max: r.max, overrides: config, ...(unknown.length ? { passthrough: Object.freeze(unknown) } : {}) };
    });
    for (const inst of o.instances) {
      const plate = Math.min(inst.plate, n - 1);
      const d = decomposeTRS(inst.transform as Mat4);
      if (!d.exact) warnings.push(`${o.name}: a skewed placement was approximated.`);
      // From the file's plate grid (and bed) to ours, keeping the spot on the plate.
      const [fx, fy] = plateOffset(plate, n, fileBed);
      const [ox, oy] = plateOffset(plate, n, ourBed);
      const position: Vec3 = [
        d.position[0] - fx - fileBed.min[0] + ourBed.min[0] + ox,
        d.position[1] - fy - fileBed.min[1] + ourBed.min[1] + oy,
        d.position[2],
      ];
      objects.push({
        id: uid(), name: o.name, meshId: ids[0], position, rotation: d.rotation as Quat, scale: d.scale as Vec3,
        visible: true, printable: inst.printable, overrides: { ...overrides }, color: '',
        ...(parts.length ? { parts: parts.map((p) => ({ ...p, id: uid('p'), overrides: { ...p.overrides } })) } : {}),
        ...(o.layerHeightProfile ? { layerHeightProfile: [...o.layerHeightProfile] } : {}),
        ...(layerRanges.length ? { layerRanges: layerRanges.map((r) => ({ ...r, overrides: { ...r.overrides } })) } : {}),
        ...(o.brimPoints ? { brimPoints: o.brimPoints.map((b) => ({ pos: [...b.pos] as Vec3, radius: b.radius })) } : {}),
        ...(passthrough ? { passthrough: Object.freeze(passthrough) } : {}),
        ...assembleOf(inst, fileBed, ourBed),
      });
    }
  }
  if (proj.plates.length > MAX_PLATES) warnings.push(`Only the first ${MAX_PLATES} plates were opened.`);

  const plates: PlateMeta[] = proj.plates.slice(0, n).map((p) => {
    const meta = newPlate();
    meta.name = p.name;
    meta.locked = p.locked;
    const { config, unknown } = splitConfig(p.config, opts.schema);
    if (Object.keys(config).length) meta.config = config;
    // Plate settings the engine doesn't know go back out as they were written.
    const unknownMeta = unknown.flatMap(([k, v]): Pairs => {
      const pk = PLATE_KEYS.find((x) => x.key === k);
      const out = pk ? pk.write(v) : v;
      return out === null ? [] : [[pk?.meta ?? k, out]];
    });
    const passthrough = elementPassthrough(p.keep, unknownMeta);
    if (passthrough) meta.passthrough = passthrough;
    if (p.customGcodes.length) meta.customGcodes = p.customGcodes.map((g) => ({ ...g }));
    return meta;
  });

  return {
    data: { name: opts.name, objects, meshes, plates, paint },
    passthrough: { files: proj.keptFiles, modelMetadata: proj.modelMetadata, triangleAttrs },
    warnings,
  };
}

/**
 * A 3MF saved by CubbySlicer carries its own project JSON: reopen it exactly
 * (meshes come from the 3MF's object file). Returns null for other 3MFs.
 */
function openCubby3mf(files: Archive): OrcaOpenResult | null {
  if (!files[CUBBY_META]) return null;
  let json: (ProjectJson & { meshSource?: Record<string, string> }) | null = null;
  try { json = JSON.parse(new TextDecoder().decode(files[CUBBY_META])); } catch { return null; }
  if (json?.format !== PROJECT_FORMAT || typeof json.version !== 'number' || json.version > PROJECT_VERSION) return null;
  const warnings: string[] = [];
  const parts = new Map<string, ReturnType<typeof parseModelPart>>();
  const meshList: MeshData[] = [];
  const triangleAttrs: Record<string, TriangleAttrs> = {};
  for (const [id, src] of Object.entries(json.meshSource ?? {})) {
    if (!/^[\w-]{1,64}$/.test(id)) continue;
    const hash = src.lastIndexOf('#');
    const path = src.slice(0, hash), sub = src.slice(hash + 1);
    let part = parts.get(path);
    if (!part && files[path]) { part = parseModelPart(files[path], path, warnings); parts.set(path, part); }
    const def = part?.objects.get(sub);
    if (!def?.positions || !def.indices) { warnings.push(`Mesh ${id} is missing from the file.`); continue; }
    meshList.push(meshFromArrays(id, def.positions, def.indices));
    if (def.triangleAttrs) triangleAttrs[id] = def.triangleAttrs;
  }
  const ids = new Set(meshList.map((m) => m.id));
  // CubbyCAD trees (Metadata/cubby_cad.json) rejoin their objects.
  if (files[CUBBY_CAD_META] && Array.isArray(json.objects)) {
    try {
      const trees = JSON.parse(new TextDecoder().decode(files[CUBBY_CAD_META])) as CadTreesJson;
      if (trees?.format === 'cubbycad-trees' && trees.objects && typeof trees.objects === 'object') {
        for (const o of json.objects as Array<ProjectObject & { cad?: unknown }>) {
          const node = trees.objects[o?.id];
          if (node) o.cad = { node: node as CadNode };
        }
      }
    } catch { warnings.push('The CubbyCAD shapes couldn’t be read; they open as plain meshes.'); }
  }
  const objs = sanitizeObjects(json.objects, ids);
  loadProjectData({ name: typeof json.name === 'string' ? json.name : 'Project', objects: objs, meshes: meshList,
    plates: sanitizePlates(json.plates), paint: sanitizePaint(json.paint, ids) });
  const root = findEntry(files, MODEL_FILE);
  setProjectPassthrough({
    files: keptEntries(files),
    modelMetadata: root ? readModelMetadata(files[root]).filter(([k]) => !OWN_MODEL_METADATA.has(k) && !PUBLISHED_METADATA.has(k)) : [],
    triangleAttrs,
  });
  const failed = loadSections(json.sections);
  if (failed.length) warnings.push(`Couldn't restore: ${failed.join(', ')}.`);
  return { name: projectName.value, objects: objs.length, plates: Math.max(1, json.plates?.length ?? 1), sliced: 0, warnings, own: true };
}

/** Parse + load. `name` is the file name (the project is named after it). */
export async function openOrcaProject(name: string, buffer: ArrayBuffer): Promise<OrcaOpenResult> {
  const unzipWarnings: string[] = [];
  const files = unzipProject(buffer, unzipWarnings);
  const own = openCubby3mf(files);
  if (own) return { ...own, warnings: [...unzipWarnings, ...own.warnings] };
  const proj = parseOrca3mf(files);
  const warnings = [...unzipWarnings, ...proj.warnings];

  // Presets first: the bed (and so the plate grid) comes from the printer.
  let relocations: ReadonlyMap<number, number> = new Map();
  if (proj.published) {
    const r = await applyPublished(proj.published);
    warnings.push(...r.notes);
    relocations = r.relocations;
  } else if (proj.settings) warnings.push(...(await applyProjectSettings(proj)));
  await presetsSettled(); // bed.value follows the selected printer

  const conv = orcaProjectData(proj, { name: name.replace(/\.(gcode\.)?3mf$/i, ''), schema: currentPresets.value.schema.value, bed: bed.value });
  warnings.push(...conv.warnings);
  // Mixed filaments a published file's slots moved: the model's references follow.
  remapModelFilamentSlots(conv.data, relocations);
  // References past the last filament slot go back to filament 1 / unpainted, as desktop does on load.
  clampModelFilamentRefs(conv.data, filamentSlotCount(currentPresets.value));
  // Per-plate bed types only on printers with several (Orca resets them otherwise).
  if (conv.data.plates && !printerMayOverrideBedType()) {
    const r = resetPlateBedTypes(conv.data.plates);
    if (r.reset) { conv.data.plates = r.plates; warnings.push('The selected printer does not support multiple bed types. Bed type overrides were reset to the global bed type.'); }
  }

  loadProjectData(conv.data);
  setProjectPassthrough(conv.passthrough);

  // Sliced 3MF: show each plate's G-code (marked outdated, since it wasn't sliced here).
  // After the plate watchers have reacted to the new plate list (they drop old results).
  await nextTick();
  let sliced = 0;
  const n = conv.data.plates?.length ?? 1;
  proj.plates.slice(0, n).forEach((pl, i) => { if (pl.gcode) { loadPlateGcode(i, pl.gcode); sliced++; } });
  return { name, objects: liveObjects.value.length, plates: n, sliced, warnings, ...(proj.published ? { published: true } : {}) };
}

/**
 * Select the project's presets by name (printer, process, filaments), set the
 * filament count and colours and the plate type, then apply the values the
 * project changed (Orca's `different_settings_to_system`: process,
 * filaments…, printer).
 */
async function applyProjectSettings(proj: OrcaProject): Promise<string[]> {
  const s = proj.settings!;
  const p = currentPresets.value;
  const notes: string[] = [];
  const str = (v: unknown) => valueAt(v as ConfigValue | undefined, SCALAR) ?? '';
  await p.ready;
  notes.push(...(await importEmbeddedPresets(proj)));

  const printerName = str(s.printer_settings_id);
  if (printerName) {
    const info = await findPresetByName('printer', printerName);
    if (info) await p.selectPrinter(info.id);
    else notes.push(`The project's printer “${printerName}” isn't in this engine's library; kept ${p.infos.value.printer.name}.`);
  }
  const colours = asList(s.filament_colour as ConfigValue).map(String);
  const filamentNames = asList(s.filament_settings_id as ConfigValue).map(String);
  // Orca 2.5 mixed filaments are slots too (at the tail): presets, colours and edits apply to the physical ones.
  const fslots = splitProjectSlots(s as Record<string, ConfigValue>, Math.max(colours.length, filamentNames.length));
  const slotOf = (i: number) => fslots.physical.indexOf(i); // config index → physical slot (-1 = a mix)
  const count = fslots.physical.length;
  if (count > 0 && count !== p.selection.filaments.length) await p.setFilamentCount(count);
  const processName = str(s.print_settings_id);
  if (processName) {
    const info = await findPresetByName('process', processName);
    if (info) await p.selectProcess(info.id);
    else notes.push(`The project's process “${processName}” wasn't found.`);
  }
  for (let i = 0; i < filamentNames.length; i++) {
    const info = filamentNames[i] && slotOf(i) >= 0 ? await findPresetByName('filament', filamentNames[i]) : null;
    if (info) await p.selectFilament(slotOf(i), info.id);
  }
  // Each slot's colours as desktop stored them: opacity (#RRGGBBAA) and multi-colour / gradient filaments
  // (filament_multi_colour / filament_colour_type, PlaterPresetComboBox::sync_colour_config).
  const multi = asList(s.filament_multi_colour as ConfigValue).map(String);
  const types = asList(s.filament_colour_type as ConfigValue).map(String);
  colours.forEach((c, i) => {
    if (slotOf(i) < 0 || !/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(c)) return;
    const fc = parseFilamentColour(c, multi[i], types[i], c);
    p.setFilamentColourSpec(slotOf(i), fc);
  });
  if (fslots.mixed.length) {
    if (p.mixedSupported()) p.setMixed(fslots.mixed);
    else notes.push(`The project's ${fslots.mixed.length} mixed filament${fslots.mixed.length === 1 ? '' : 's'} need an OrcaSlicer 2.5 engine; objects using them print with filament 1.`);
  }
  // The project's plate type (a project option, not a preset value).
  const bedType = str(s.curr_bed_type);
  if (bedType && p.bedTypeDef()?.enumValues?.includes(bedType)) p.setBedType(bedType);

  // Changed settings: [process, filament 1…n, printer], each "key;key;…".
  const diffs = asList(s.different_settings_to_system as ConfigValue).map(String);
  const schema = p.schema.value;
  const selfIndex = asList(s.filament_self_index as ConfigValue | undefined);
  if (schema && diffs.length) {
    const slots: Array<{ kind: PresetKind; slot: number; keys: string[] }> = diffs.map((d, i) => ({
      kind: i === 0 ? 'process' : i === diffs.length - 1 ? 'printer' : 'filament',
      slot: i === 0 || i === diffs.length - 1 ? 0 : slotOf(i - 1),
      keys: d.split(';').map((k) => k.trim()).filter(Boolean),
    }));
    let applied = 0;
    for (const { kind, slot, keys } of slots) {
      if (slot < 0) continue; // a mixed slot: its preset is a copy of its first component's
      for (const k of keys) {
        const def = schema.options[k];
        if (!def || !(k in s) || tabOfScope(def.scope) !== kind) continue;
        const raw = s[k] as ConfigValue;
        // Filament vectors in the project are per filament: take this slot's value
        // (a per-variant key: this filament's columns, by filament_self_index).
        const at = kind === 'filament' ? fslots.physical[slot] ?? slot : slot;
        let v: ConfigValue;
        if (kind === 'filament' && Array.isArray(raw) && variantKey(schema, k)?.family === 'filament' && selfIndex.length === raw.length) {
          const cols = raw.filter((_, j) => selfIndex[j] === String(at + 1));
          if (!cols.length || cols.length !== asList(p.value(kind, k, slot)).length) continue; // another variant layout than the local preset
          v = normalizeValue(def, cols);
        } else v = kind === 'filament' && Array.isArray(raw) ? normalizeValue(def, [raw[at] ?? raw[0]]) : normalizeValue(def, raw);
        if (valuesEqual(v, p.value(kind, k, slot) ?? '')) continue;
        p.setValue(kind, k, v, slot);
        applied++;
      }
    }
    if (applied) notes.push(`Applied ${applied} changed setting${applied === 1 ? '' : 's'} from the project.`);
  }
  // Values Orca keeps in the project config, not in a preset. nozzle_volume_type is read back
  // through nozzleVolumeTypes(), which falls back to what the printer offers.
  for (const k of PROJECT_CONFIG_KEYS) {
    const def = schema?.options[k];
    if (def && s[k] !== undefined) p.project[k] = normalizeValue(def, s[k] as ConfigValue);
  }
  // Flushing volumes: desktop keeps the project's matrix and multiplier as saved (auto-calculation only
  // reacts to later filament edits). The app's project holds the physical slots' block; the auto-flush
  // watcher leaves a matrix that changes together with the colours alone.
  const flush = engineCaps(activeEngine.value).flush;
  if (flush.matrix === 'flush_volumes_matrix' && s.flush_volumes_matrix !== undefined && count > 0) {
    const nozzles = Math.max(1, asList(s.nozzle_diameter as ConfigValue | undefined).length);
    const block = slotBlock(asList(s.flush_volumes_matrix as ConfigValue).map(Number), fslots.physical, nozzles);
    if (block && block.every(Number.isFinite)) {
      p.project.flush_volumes_matrix = block.map((v) => String(v));
      if (flush.multiplier && s[flush.multiplier] !== undefined) p.project[flush.multiplier] = asList(s[flush.multiplier] as ConfigValue).map(String);
    }
  }
  if (engineCaps(activeEngine.value).orcaCompat) notes.push('Orca project settings were mapped onto preFlight where the options exist.');
  return notes;
}

/** A preset by name: the user's own (incl. presets the project embedded) first, then the library's. */
async function findPresetByName(kind: PresetKind, name: string): Promise<{ id: string } | null> {
  const p = currentPresets.value;
  return p.users.findByName(kind, name) ?? (await p.catalog.findByName(kind, name).catch(() => null));
}

/** Project-config keys restored from project_settings.config (Orca 2.5: nozzle flow types, filament grouping, purge mode). */
const PROJECT_CONFIG_KEYS = ['nozzle_volume_type', 'extruder_nozzle_stats', 'filament_volume_map', 'filament_nozzle_map', 'filament_map', 'filament_map_mode', 'prime_volume_mode', 'flush_multiplier_fast'] as const;

// ---- project-embedded presets -------------------------------------------------------------------

/** bbs_3mf.cpp PROJECT_EMBEDDED_*_PRESETS_FILE: JSON process / filament / printer presets. */
const EMBEDDED_PRESET = /^metadata\/(process|filament|machine)_settings_\d+\.config$/i;
/** PROJECT_EMBEDDED_PRINT_PRESETS_FILE: older projects' process presets, in INI ("key = value"). */
const LEGACY_PRINT_PRESET = /^metadata\/print_setting_\d+\.config$/i;
/** The config key that names an embedded preset (_extract_project_embedded_presets_from_archive). */
const PRESET_NAME_KEY: Record<PresetKind, string> = { process: 'print_settings_id', filament: 'filament_settings_id', printer: 'printer_settings_id' };

/** An embedded preset file → its kind, name and raw values (null: desktop skips the file). */
export function readEmbeddedPreset(path: string, data: Uint8Array, schema: ConfigSchema | null): { kind: PresetKind; name: string; raw: Record<string, unknown> } | null {
  const text = new TextDecoder().decode(data);
  let kind: PresetKind;
  let raw: Record<string, unknown>;
  const m = EMBEDDED_PRESET.exec(path);
  if (m) {
    const dir = m[1].toLowerCase();
    kind = dir === 'machine' ? 'printer' : dir as PresetKind;
    try {
      const j: unknown = JSON.parse(text);
      if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
      raw = { ...(j as Record<string, unknown>) };
    } catch { return null; }
  } else if (LEGACY_PRINT_PRESET.test(path)) {
    kind = 'process';
    const ini = readOrcaIni(text);
    if (!ini) return null;
    raw = {};
    // Values in the engine's shape (INI vectors are serialized: "0.4,0.4", "\"a\";\"b\"").
    for (const [k, v] of Object.entries(ini)) raw[k] = schema?.options[k] ? normalizeValue(schema.options[k], v) : v;
  } else return null;
  // Named by its *_settings_id (a filament by the first one); JSON presets fall back to their "name".
  const id = raw[PRESET_NAME_KEY[kind]];
  const name = Array.isArray(id) ? String(id[0] ?? '') : typeof id === 'string' ? id : typeof raw.name === 'string' ? raw.name : '';
  if (!name) return null;
  return { kind, name, raw: { ...raw, name, type: kind === 'printer' ? 'machine' : kind } };
}

/**
 * PresetBundle::load_project_embedded_presets (Format/bbs_3mf.cpp
 * _extract_project_embedded_presets_from_archive): presets saved inside the
 * project — Metadata/{process,filament,machine}_settings_N.config (JSON) and
 * older projects' Metadata/print_setting_N.config (INI, process) — are added
 * when this browser has no preset of that name, so the project's printer /
 * process / filaments can be selected by name. Like desktop, a preset whose
 * parent (`inherits`) isn't found is not loaded, except a parentless filament
 * that carries its own variant layout (a Full Publish copy). Here they become
 * user presets (desktop keeps them inside the project).
 */
async function importEmbeddedPresets(proj: OrcaProject): Promise<string[]> {
  const p = currentPresets.value;
  const files: Array<{ name: string; data: Uint8Array }> = [];
  const names: string[] = [];
  const dropped: string[] = [];
  const exists = async (kind: PresetKind, name: string) => !!(await findPresetByName(kind, name));
  for (const [path, data] of Object.entries(proj.keptFiles)) {
    const e = readEmbeddedPreset(path, data, p.schema.value);
    if (!e || (await exists(e.kind, e.name))) continue;
    const inherits = typeof e.raw.inherits === 'string' ? e.raw.inherits : '';
    const parentless = !inherits && e.kind === 'filament' && 'filament_extruder_variant' in e.raw;
    if (!parentless && !(inherits && (await exists(e.kind, inherits)))) { dropped.push(e.name); continue; }
    // The folder tells the importer the preset type.
    const dir = e.kind === 'printer' ? 'machine' : e.kind;
    files.push({ name: `${dir}/${path.split('/').pop()!.replace(/\.config$/i, '.json')}`, data: new TextEncoder().encode(JSON.stringify(e.raw)) });
    names.push(e.name);
  }
  const notes = dropped.length ? [`Not loaded (their parent preset isn’t available): ${dropped.join(', ')}.`] : [];
  if (!files.length) return notes;
  const r = await p.importFiles(files);
  const n = r.imported.length;
  return [...(n ? [`Imported ${n} preset${n === 1 ? '' : 's'} saved in the project: ${names.join(', ')}.`] : []), ...notes, ...r.warnings];
}

// ---- published 3MFs -----------------------------------------------------------------------------

const listOf = (v: ConfigValue | undefined): string[] => (v === undefined ? [] : asList(v).map(String));
const intsOf = (v: ConfigValue | undefined): number[] => listOf(v).map((s) => Number.parseInt(s, 10)).filter(Number.isFinite);

interface PublishedOutcome {
  notes: string[];
  /** Author slot → slot (0-based): the opened model's filament references follow (remap_model_filament_slots). */
  relocations: Map<number, number>;
}

type FilamentPick = FilamentCandidate & { id: string };
const pickOf = (i: PresetInfo): FilamentPick => ({ id: i.id, name: i.name, alias: i.alias, filamentId: i.filamentId, filamentType: i.filamentType, filamentVendor: i.filamentVendor });

/**
 * A published 3MF (PresetBundle::load_config_file_config, published mode):
 * the user's printer, process and filaments stay selected and only the
 * author's published values are laid over them —
 * - process keys, and of the printer only the Retraction / Z-hop keys; "#N"
 *   per-extruder keys go to the receiver's extruder with the author's number
 *   when the file carries the extruder layout (printer keys always, process
 *   keys on a multi-extruder printer), else collapse onto a single extruder;
 * - the wipe tower position (the only project options that cross over);
 * - per filament slot (the material pass): slots grow only as far as the
 *   published ones, surplus materials past the printer's filament capacity
 *   become empty mixed filaments, mixed filaments move to the tail (the
 *   opened model's references follow), a slot sharing its preset with
 *   another is re-pointed to the best matching distinct filament, a type
 *   requirement swaps the slot's filament for the best match (exact name,
 *   alias, filament id, vendor + type, type), then the colour and the keys
 *   land on the slot; a Full entry lands as the whole published filament.
 * What couldn't be applied is reported.
 */
async function applyPublished(pub: OrcaPublished): Promise<PublishedOutcome> {
  const p = currentPresets.value;
  await p.ready;
  const schema = p.schema.value;
  const relocations = new Map<number, number>();
  if (!schema) return { notes: [], relocations };
  const cfg = pub.config;
  let applied = 0;
  const skipped: string[] = [];
  const replacements: string[] = [];
  const set = (kind: PresetKind, key: string, v: ConfigValue, slot = 0) => {
    if (valuesEqual(v, p.value(kind, key, slot) ?? '')) return;
    p.setValue(kind, key, v, slot);
    applied++;
  };

  // ---- process, then printer ----
  const appliedKeys = new Set<string>();
  const excluded = new Set<string>();
  const receiver = {
    nozzleCount: listOf(p.value('printer', 'nozzle_diameter')).length,
    extruderTypes: listOf(p.value('printer', 'extruder_type')),
    volumeTypes: p.nozzleVolumeTypes(),
  };
  for (const pass of ['process', 'printer'] as const) {
    const layout = pass === 'printer' ? pub.printerLayout : pub.printLayout;
    const byIdentity = !!layout?.extruderIds.length && (pass === 'printer' || Math.max(1, receiver.nozzleCount) >= 2);
    const collapsed = new Set<string>();
    for (const key of pub.keys) {
      if (appliedKeys.has(key)) continue;
      const base = publishBaseKey(key);
      if (PUBLISH_STRUCTURAL.has(base)) continue;
      const def = schema.options[base];
      if (!def || tabOfScope(def.scope) !== pass) continue;
      if (pass === 'printer' && !PUBLISH_PRINTER_KEYS.has(base)) { excluded.add(base); continue; }
      const raw = cfg[base];
      if (raw === undefined) continue;
      const v = normalizeValue(def, raw);
      const cur = p.value(pass, base);
      if (Array.isArray(v)) {
        if (!Array.isArray(cur)) continue;
        if (key.length > base.length) {
          const idx = publishKeyIndex(key);
          if (idx < 0 || idx >= v.length) continue;
          let slot: number;
          if (byIdentity) {
            const target = pass === 'printer'
              ? { ids: intsOf(p.value('printer', 'printer_extruder_id')), variants: listOf(p.value('printer', 'printer_extruder_variant')) }
              : { ids: intsOf(p.value('process', 'print_extruder_id')), variants: listOf(p.value('process', 'print_extruder_variant')) };
            slot = resolvePublishedExtruderSlot(layout!, idx, receiver, target);
            if (slot < 0 || slot >= cur.length) continue;
          } else if (cur.length === 1) {
            // A single-extruder receiver takes the first published extruder of a key.
            if (collapsed.has(base)) continue;
            collapsed.add(base);
            slot = 0;
          } else {
            if (idx >= cur.length) continue;
            slot = idx;
          }
          const next = [...cur];
          next[slot] = v[idx];
          set(pass, base, next);
        } else {
          if (v.length !== cur.length) continue;
          set(pass, base, v);
        }
      } else {
        if (key.includes('#') || cur === undefined || Array.isArray(cur)) continue;
        set(pass, base, v);
      }
      appliedKeys.add(key);
    }
  }
  // Plate geometry: the only project options a published file brings (s_project_options_published).
  for (const k of PUBLISH_PROJECT_KEYS) {
    const def = schema.options[k];
    if (def && cfg[k] !== undefined) p.project[k] = normalizeValue(def, cfg[k]);
  }

  // ---- filament slots ----
  if (pub.materials.length) await applyPublishedMaterials(pub, { set, skipped, replacements, relocations });

  for (const key of pub.keys) {
    const base = publishBaseKey(key);
    if (!appliedKeys.has(key) && !PUBLISH_STRUCTURAL.has(base) && !excluded.has(base)) skipped.push(key);
  }
  const notes = ['Published project: kept your printer, process and filaments and applied the author’s published settings.'];
  if (applied) notes.push(`Applied ${applied} published setting${applied === 1 ? '' : 's'}.`);
  if (replacements.length) notes.push(`Filament slots: ${replacements.join('; ')}.`);
  const uniq = [...new Set(skipped)];
  if (uniq.length) notes.push(`Some published settings could not be applied: ${uniq.slice(0, 12).join(', ')}${uniq.length > 12 ? '…' : ''}.`);
  return { notes, relocations };
}

type MixedSlot = { kind: 'physical' } | { kind: 'mix'; def: MixedDef; receiver: boolean };
const PHYSICAL: MixedSlot = { kind: 'physical' };
const EMPTY_MIX: MixedDef = { components: [], ratios: [], gradient: false, direction: 'ab', curve: [], perPart: false };

/** The material pass of a published load (see applyPublished). */
async function applyPublishedMaterials(pub: OrcaPublished, ctx: {
  set: (kind: PresetKind, key: string, v: ConfigValue, slot?: number) => void;
  skipped: string[]; replacements: string[]; relocations: Map<number, number>;
}): Promise<void> {
  const p = currentPresets.value;
  const schema = p.schema.value!;
  const cfg = pub.config;
  const { set, skipped, replacements } = ctx;
  const vec = (k: string): string[] => (cfg[k] === undefined ? [] : asList(normalizeValue(schema.options[k], cfg[k])).map(String));
  const mixedOk = p.mixedSupported();
  const physical = p.selection.filaments.length;
  const receiverMixes = mixedOk ? p.mixedDefs() : [];
  const semm = String(valueAt(p.value('printer', 'single_extruder_multi_material'), SCALAR) ?? '') === '1';
  const nozzles = listOf(p.value('printer', 'nozzle_diameter')).length;
  const capacity = !semm && nozzles > 0 ? nozzles : PUBLISH_SLOT_LIMIT;
  const numFilaments = vec('filament_colour').length;
  const plan = planPublishedSlots(pub.materials, { physical, mixed: receiverMixes.length, capacity }, numFilaments);
  skipped.push(...plan.skipped);
  replacements.push(...plan.notes);

  // The payload's mixed cells at their destinations (apply_mixed_config_relocations).
  const cells = new Map<string, string[]>();
  for (const k of MIXED_SLOT_KEYS) cells.set(k, relocateMixedCells(vec(k), plan.payloadMoves, k === 'filament_is_mixed' || k === 'filament_mixed_gradient' || k === 'filament_mixed_gradient_per_part' ? '0' : ''));

  // ---- the final slot layout ----
  const size = physical + receiverMixes.length;
  const total = plan.targetSlots;
  const start: MixedSlot[] = Array.from({ length: total }, (_, s) => (s >= physical && s < size ? { kind: 'mix', def: receiverMixes[s - physical], receiver: true } : PHYSICAL));
  const slots = [...start];
  for (const [from, to] of plan.receiverMoves) slots[to] = start[from];
  for (const [from] of plan.receiverMoves) slots[from] = PHYSICAL;
  const label = (e: PlannedMaterial) => materialLabel(e);
  const placeholder = (s: number) => { slots[s] = { kind: 'mix', def: EMPTY_MIX, receiver: false }; };
  for (const e of plan.entries) if (e.placeholder && e.slot < total) placeholder(e.slot);
  const payloadMixes = plan.entries.filter((e) => e.slot >= 0 && e.slot < total && !e.placeholder && isMixedDefinition(e));
  // Every slot that holds a mixed filament once the load completes (components must not name one).
  const finalMixed = new Set<number>(slots.flatMap((x, s) => (x.kind === 'mix' ? [s] : [])));
  for (const e of payloadMixes) finalMixed.add(e.slot);
  for (const s of plan.gapSlots) finalMixed.add(s);
  for (const e of payloadMixes) {
    const own = slots[e.slot];
    const likeForLike = own.kind === 'mix' && own.receiver;
    if (!mixedOk) {
      skipped.push(`material:${label(e)} (mixed filament definition: needs an OrcaSlicer 2.5 engine)`);
      if (!likeForLike) placeholder(e.slot);
      continue;
    }
    const comps = cells.get('filament_mixed_components')!;
    let error = '';
    if (e.slot < comps.length) {
      const c = parseComponents(comps[e.slot]);
      if (c.length < 2) error = 'needs at least two components';
      else if (c.some((n) => n < 1 || n > total || finalMixed.has(n - 1))) error = 'components reference missing slots';
    }
    if (error) {
      skipped.push(`material:${label(e)} (mixed filament definition: ${error})`);
      if (!likeForLike) {
        placeholder(e.slot);
        replacements.push(`slot ${e.slot}: mixed filament definition could not be imported (${error})`);
      }
      continue;
    }
    // The published cells over the slot's own (a receiver mix keeps what isn't published).
    const base: Record<string, string> = likeForLike ? slotValues(own.def) : { filament_is_mixed: '1' };
    for (const key of e.keys) {
      const k = publishBaseKey(key);
      if (!PUBLISH_MIXED_KEYS.has(k)) continue;
      const src = cells.get(k);
      if (src && e.slot < src.length) base[k] = src[e.slot];
      else skipped.push(`material:${label(e)} (${key})`);
    }
    const read = readMixedSlots(Object.fromEntries(Object.entries(base).map(([k, v]) => [k, [v]])));
    slots[e.slot] = read.length ? { kind: 'mix', def: read[0].def, receiver: false } : PHYSICAL;
  }
  for (const s of plan.gapSlots) {
    if (slots[s].kind === 'mix') continue;
    placeholder(s);
    replacements.push(`slot ${s}: unassigned mixed filament (the printer's filament limit is ${capacity})`);
  }

  // Desktop keeps physical slots first; our slots are always laid out that way.
  const physSlots = slots.flatMap((x, s) => (x.kind === 'physical' ? [s] : []));
  const mixSlots = slots.flatMap((x, s) => (x.kind === 'mix' ? [s] : []));
  const ours = new Map<number, number>();
  physSlots.forEach((s, i) => ours.set(s, i));
  mixSlots.forEach((s, i) => ours.set(s, physSlots.length + i));
  for (const [from, to] of plan.relocations) ctx.relocations.set(from, ours.get(to) ?? to);
  const toOurs = (n: number) => (n >= 1 && ours.has(n - 1) ? ours.get(n - 1)! + 1 : n);

  if (physSlots.length !== physical) await p.setFilamentCount(physSlots.length);
  if (mixedOk && (mixSlots.length || receiverMixes.length)) {
    p.setMixed(mixSlots.map((s) => {
      const d = (slots[s] as Extract<MixedSlot, { kind: 'mix' }>).def;
      return { ...d, components: d.components.map(toOurs) };
    }));
  }

  // Grown slots show the published colour, else their preset's.
  const published = new Map<number, PlannedMaterial>();
  for (const e of plan.entries) if (e.slot >= 0 && !published.has(e.slot)) published.set(e.slot, e);
  const colourOf = (slot: number) => listOf(p.value('filament', 'filament_colour', slot))[0] ?? '';
  const setColour = (slot: number, c: string) => {
    if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(c)) p.setFilamentColourSpec(slot, parseFilamentColour(c, undefined, undefined, c));
  };
  for (let s = physical; s < physSlots.length; s++) {
    const e = published.get(physSlots[s]);
    setColour(s, e?.publishColor && e.color ? e.color : colourOf(s));
  }

  // ---- candidates (the type gate and de-aliasing) ----
  const compatible = p.compatible.value.filament.map(pickOf);
  let all = compatible;
  try {
    const more = await p.catalog.candidates('filament', p.selectedInfo('printer'));
    all = [...compatible, ...more.filter((i) => !compatible.some((c) => c.id === i.id)).map(pickOf)];
  } catch { /* the compatible list only */ }
  const resolvedNames = new Map<string, string>();
  const resolvedName = async (e: PlannedMaterial) => {
    const n = e.material.name;
    if (!n) return '';
    if (!resolvedNames.has(n)) resolvedNames.set(n, (await p.catalog.findByName('filament', n).catch(() => null))?.name ?? '');
    return resolvedNames.get(n)!;
  };
  const usedElsewhere = (id: string, except: number) => p.selection.filaments.some((x, i) => i !== except && x === id);
  const physicalOf = (e: PlannedMaterial) => ours.get(e.slot) ?? -1;
  const select = async (slot: number, pick: FilamentPick, note: (old: string) => string) => {
    const old = p.selectedInfo('filament', slot).name;
    await p.selectFilament(slot, pick.id);
    replacements.push(note(old));
  };

  // De-alias: a published slot (not the first) sharing its preset with another slot gets a distinct one.
  for (let slot = 1; slot < physSlots.length; slot++) {
    const e = published.get(physSlots[slot]);
    if (!e || e.placeholder || isMixedDefinition(e) || !usedElsewhere(p.selection.filaments[slot], slot)) continue;
    if (!e.keys.some((k) => !PUBLISH_MIXED_KEYS.has(publishBaseKey(k)))) continue;
    const rn = await resolvedName(e);
    const scan = (list: FilamentPick[]) => {
      let best = -1, pick: FilamentPick | null = null;
      for (const c of list) {
        if (usedElsewhere(c.id, -1)) continue;
        const score = candidateScore(c, e, rn);
        if (score > best) { best = score; pick = c; }
      }
      return pick;
    };
    let pick = scan(compatible) ?? scan(all);
    if (!pick) {
      const family = e.type || normalizeFilamentType(e.material.filamentType);
      pick = all.find((c) => !usedElsewhere(c.id, -1) && (!family || normalizeFilamentType(c.filamentType ?? '') === family)) ?? null;
    }
    if (pick) await select(slot, pick, (old) => `slot ${slot}: ${old} -> ${pick!.name}`);
  }

  // ---- each entry onto its slot ----
  const selfIndex = (() => {
    const v = intsOf(cfg.filament_self_index === undefined ? undefined : normalizeValue(schema.options.filament_self_index, cfg.filament_self_index));
    return v.length < numFilaments ? Array.from({ length: numFilaments }, (_, i) => i + 1) : v;
  })();
  const authorVariantList = (() => {
    const v = vec('filament_extruder_variant');
    while (v.length < numFilaments) v.push('Direct Drive Standard');
    return v;
  })();
  const isVariantKey = (k: string) => variantKey(schema, k)?.family === 'filament';
  const applyKeys = (slot: number, keys: readonly string[], authorSlot: number, name: string) => {
    for (const key of keys) {
      const base = publishBaseKey(key);
      if (PUBLISH_STRUCTURAL.has(base) || base === 'filament_extruder_variant' || base === 'filament_self_index') continue;
      const def = schema.options[base];
      const dst = listOf(p.value('filament', base, slot));
      if (!def || !isVectorType(def.type) || cfg[base] === undefined || !dst.length) { skipped.push(`material:${name} (${key})`); continue; }
      const src = vec(base);
      const col = publishKeyIndex(key);
      const next = [...dst];
      if (col >= 0 && !isVariantKey(base)) { skipped.push(`material:${name} (${key}, not a per-variant key on this build)`); continue; }
      if (col < 0) {
        // A per-slot value: the slot's own element of the file's vector.
        if (authorSlot < 0 || authorSlot >= src.length) { skipped.push(`material:${name} (${key})`); continue; }
        next[0] = src[authorSlot];
      } else {
        if (col >= selfIndex.length || col >= authorVariantList.length || selfIndex[col] - 1 !== authorSlot) {
          skipped.push(`material:${name} (${key}, file column ${col} does not belong to this slot)`);
          continue;
        }
        if (col >= src.length) { skipped.push(`material:${name} (${key}, file column ${col} is out of range)`); continue; }
        const variant = authorVariantList[col];
        const local = listOf(p.value('filament', 'filament_extruder_variant', slot)).indexOf(variant);
        if (local < 0) { skipped.push(`material:${name} (${key}, variant "${variant}" not in receiver preset)`); continue; }
        next[local] = src[col];
      }
      set('filament', base, next, slot);
    }
  };

  for (const e of plan.entries) {
    if (e.slot < 0 || e.slot >= total || e.placeholder || isMixedDefinition(e)) continue;
    const slot = physicalOf(e);
    if (slot < 0 || slot >= p.selection.filaments.length) continue;
    const name = label(e);
    if (e.full) {
      applyFull(e, slot, name);
      continue;
    }
    let applySlot = true;
    if (e.publishType && e.type && normalizeFilamentType(listOf(p.value('filament', 'filament_type', slot))[0] ?? '') !== e.type) {
      // Type mismatch: the best matching filament (compatible ones first; one no other slot uses wins a tie).
      const rn = await resolvedName(e);
      const best = (list: FilamentPick[]) => {
        const scan = (unused: boolean) => {
          let score = -1, pick: FilamentPick | null = null;
          for (const c of list) {
            const sc = candidateScore(c, e, rn);
            if (sc <= score || (unused && usedElsewhere(c.id, slot))) continue;
            score = sc; pick = c;
          }
          return { score, pick };
        };
        const strict = scan(true), relaxed = scan(false);
        return relaxed.score > strict.score ? relaxed : strict;
      };
      const c = best(compatible), a = best(all);
      const r = c.score >= 0 ? c : a;
      if (r.pick) {
        const substitute = r.score < 2 && !!(e.material.filamentId || e.material.filamentVendor);
        await select(slot, r.pick, (old) => `slot ${slot}: ${old} -> ${r.pick!.name}${substitute ? ' (substitute)' : ''}`);
      } else {
        for (const k of e.keys) skipped.push(`material:${name} (${k})`);
        applySlot = false;
      }
    }
    if (e.publishColor && e.color) {
      // A requirement, not an override: on the slot's filament and its colour.
      set('filament', 'filament_colour', [e.color], slot);
      setColour(slot, e.color);
    }
    if (applySlot) applyKeys(slot, e.keys, e.slot, name);
  }

  /**
   * Full Publish: desktop loads the author's whole filament as a new
   * project-only preset (named after it, "(Published)" on a clash) based on
   * the slot's filament. Here the published values land on the slot's
   * filament as unsaved changes (same resulting settings; the preset keeps
   * its name).
   */
  function applyFull(e: PlannedMaterial, slot: number, name: string): void {
    const columns = selfIndex.flatMap((v, c) => (v === e.slot + 1 ? [c] : []));
    const authorVariants = columns.filter((c) => c < authorVariantList.length).map((c) => authorVariantList[c]);
    const authorLayout = columns.length > 0 && authorVariants.length === columns.length;
    const receiverVariants = listOf(p.value('filament', 'filament_extruder_variant', slot));
    for (const key of e.fullKeys) {
      const base = publishBaseKey(key);
      if (PUBLISH_STRUCTURAL.has(base) || base === 'filament_extruder_variant' || base === 'filament_self_index') continue;
      const def = schema.options[base];
      if (cfg[base] === undefined || (def && !isVectorType(def.type))) continue;
      const dst = listOf(p.value('filament', base, slot));
      if (!def || !dst.length) { skipped.push(`material:${name} (${base})`); continue; }
      const src = vec(base);
      const next = [...dst];
      if (isVariantKey(base)) {
        if (!authorLayout || columns.some((c) => c >= src.length)) continue;
        if (dst.length <= 1) next[0] = src[columns[0]];
        else receiverVariants.forEach((v, j) => { const i = authorVariants.indexOf(v); if (i >= 0 && j < next.length) next[j] = src[columns[i]]; });
      } else {
        if (e.slot < 0 || e.slot >= src.length) continue;
        next[0] = src[e.slot];
      }
      set('filament', base, next, slot);
    }
    const old = p.selectedInfo('filament', slot).name;
    const copy = publishMaterialBaseName(e.material.name) || e.material.filamentId || e.type || e.material.filamentType || 'Published Filament';
    replacements.push(`slot ${slot}: ${old} -> ${copy} (applied as changes to ${old})`);
    if (e.publishColor && e.color) {
      set('filament', 'filament_colour', [e.color], slot);
      setColour(slot, e.color);
    } else setColour(slot, colourOf(slot));
  }
}

/**
 * remap_model_filament_slots: the opened model's object / part `extruder`
 * and colour paint follow relocated filament slots (`relocations` 0-based).
 */
export function remapModelFilamentSlots(data: ProjectData, relocations: ReadonlyMap<number, number>): void {
  if (!relocations.size) return;
  const oneBased = new Map([...relocations].map(([f, t]) => [f + 1, t + 1]));
  const ext = (ov: Record<string, ConfigValue>) => {
    const v = ov.extruder;
    if (v === undefined) return;
    const to = oneBased.get(Number(Array.isArray(v) ? v[0] : v));
    if (to !== undefined) ov.extruder = String(to);
  };
  for (const o of data.objects) {
    ext(o.overrides);
    for (const part of o.parts ?? []) ext(part.overrides);
  }
  const state = (s: number) => oneBased.get(s) ?? s;
  for (const layers of Object.values(data.paint ?? {})) {
    if (layers.color) layers.color = layers.color.map(([t, hex]) => [t, remapPaintString(hex, state)] as [number, string]).filter(([, hex]) => hex !== '0');
  }
}
