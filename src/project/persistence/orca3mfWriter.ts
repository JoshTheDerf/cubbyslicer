/**
 * Save the project as an OrcaSlicer 2.5 project 3MF (Format/bbs_3mf.cpp
 * layout), which desktop OrcaSlicer / Bambu Studio open as a project: objects
 * with their parts (incl. precise seams), per-object / per-part settings,
 * painting, instances, plates with their settings, the project settings
 * (resolved config + preset names + changed keys), variable layer heights,
 * height ranges, brim ears and the slider's custom G-code. What an opened
 * project carried that CubbySlicer doesn't model (passthrough.ts, the
 * `passthrough` fields) is written back as it was read.
 *
 * Everything CubbySlicer needs to reopen the project exactly (part
 * transforms, emboss, UI sections, …) rides along in
 * Metadata/cubby_slicer.json, which Orca ignores.
 */
import { strToU8, zipSync, type Zippable } from 'fflate';
import type { ConfigValue } from '../../engine/types';
import { activeEngine, resolvedConfig } from '../../app/state';
import { isOrcaConfig } from '../../engine/capabilities';
import { currentPresets } from '../../presets/store';
import { isHoleObject } from '../../cad/build';
import { joinValue } from '../../lib/configValue';
import { composeTRS, type Quat, type Vec3 } from '../math';
import {
  liveMeshes, plateOf, projectName, serializeObjects, serializePaint, serializePlates,
} from '../store';
import type { ObjectPart, ProjectObject, VolumePassthrough } from '../types';
import { escapeAttr, escapeXml } from '../import/xml';
import {
  BBS_COMPAT_VERSION, BRIM_EARS_FILE, CUSTOM_GCODE_FILE, CUT_INFO_FILE, GCODE_TYPE_ID, LAYER_HEIGHTS_FILE, LAYER_RANGES_FILE, MODEL_FILE,
  MODEL_SETTINGS_FILE, ORCA_FORMAT_VERSION, PAINT_ATTR, PLATE_KEYS, PLATE_KEYS_NEED_MAP_MODE, PRECISE_SEAM_CONFIG_PREFIX, PRECISE_SEAM_TYPE_KEY,
  PROJECT_SETTINGS_FILE, SLICE_INFO_FILE, SUBTYPE_OF,
} from '../import/orcaFormat';
import { ChunkWriter, MODEL_REL_TYPE, PRODUCTION_NS, CORE_NS, contentTypesXml, num, relsXml, transform3mf, writeMesh } from '../export/xml3mf';
import { CUBBY_CAD_META, PROJECT_FORMAT, PROJECT_VERSION, type CadTreesJson, type ProjectJson } from './format';
import { saveSections } from './sections';
import { passthroughFor } from './passthrough';
import { renderPlateImages, type PlateImages } from '../thumbnails';

export const CUBBY_META = 'Metadata/cubby_slicer.json';
/** Projects save as OrcaSlicer-compatible 3MF. */
export const SAVE_EXT = '.3mf';

/** The bytes to write for a project file (with Orca's plate thumbnails). */
export function projectBytesFor(_fileName: string): Promise<Uint8Array> {
  return buildOrca3mfWithThumbnails();
}

/** identify_id of each object instance, as buildOrca3mf numbers them (pick_N.png colours). */
function identifyIds(): Map<string, number> {
  const ids = new Map<string, number>();
  groupObjects(serializeObjects(), new Set(liveMeshes().map((m) => m.id))).forEach((g, gi) => {
    g.members.forEach((m, k) => ids.set(m.id, (gi + 1 + 100000) * 100 + k));
  });
  return ids;
}

/** The project 3MF including Metadata/plate_N.png & co. (rendered now; without them if WebGL is unavailable). */
export async function buildOrca3mfWithThumbnails(): Promise<Uint8Array> {
  let thumbnails: PlateImages[] = [];
  try {
    const ids = identifyIds();
    thumbnails = await renderPlateImages((id) => ids.get(id) ?? 0);
  } catch (e) {
    console.warn('Project thumbnails failed', e);
  }
  return buildOrca3mf({ thumbnails });
}

/** File name → project name. */
export function projectStem(fileName: string): string {
  return fileName.replace(/\.(gcode\.3mf|3mf)$/i, '');
}
const OBJECTS_FILE = '3D/Objects/object_1.model';

const meta = (indent: string, key: string, value: string) => `${indent}<metadata key="${escapeAttr(key)}" value="${escapeAttr(value)}"/>\n`;

/** A volume's passthrough as it applies to its current mesh (mesh-bound parts dropped once the mesh changed). */
function liveVolumeKeep(p: VolumePassthrough | undefined, meshId: string): VolumePassthrough | undefined {
  if (!p || p.meshId === meshId) return p;
  const { meshMetadata: _m, elements: _e, subtype: _s, ...rest } = p;
  return rest;
}

/** A stand-alone CubbyCAD hole: shown and kept, but desktop Orca must not print it as a solid. */
const isHole = (o: ProjectObject) => isHoleObject(o.cad?.node);

/**
 * Objects that only differ by placement become one Orca object with several
 * instances. Copies get " (2)", " (3)"… names here, so the suffix doesn't count.
 */
function groupKey(o: ProjectObject): string {
  return JSON.stringify([o.name.replace(/ \(\d+\)$/, ''), o.meshId, o.overrides,
    (o.parts ?? []).map((p) => [p.meshId, p.type, p.position, p.rotation, p.scale, p.overrides, p.preciseSeam ?? null, p.passthrough ?? null]),
    o.layerHeightProfile ?? null, o.layerRanges ?? null, o.brimPoints ?? null, o.passthrough ?? null, isHole(o)]);
}

/** Group into Orca objects: objects that only differ by placement become instances of one. */
function groupObjects(objects: ProjectObject[], meshIds: { has(id: string): boolean }): Array<{ first: ProjectObject; members: ProjectObject[] }> {
  const groups: Array<{ first: ProjectObject; members: ProjectObject[] }> = [];
  const byKey = new Map<string, (typeof groups)[number]>();
  for (const o of objects) {
    if (!meshIds.has(o.meshId)) continue;
    const k = groupKey(o);
    const g = byKey.get(k);
    if (g) g.members.push(o); else { const n = { first: o, members: [o] }; byKey.set(k, n); groups.push(n); }
  }
  return groups;
}

/** Passthrough `<metadata>` not already written (a setting the engine now knows wins). */
function keptMetadata(indent: string, list: Array<[string, string]> | undefined, written: Set<string>): string {
  let out = '';
  for (const [k, v] of list ?? []) {
    if (written.has(k)) continue;
    written.add(k);
    out += meta(indent, k, v);
  }
  return out;
}

/**
 * `thumbnails[i]`: plate i's images (Orca's Metadata/plate_N.png,
 * plate_N_small.png, plate_no_light_N.png, top_N.png, pick_N.png), referenced
 * from model_settings.config and, for plate 1, the package rels.
 */
export function buildOrca3mf(opts: { thumbnails?: PlateImages[] } = {}): Uint8Array {
  const objects = serializeObjects();
  const meshes = new Map(liveMeshes().map((m) => [m.id, m]));
  const paint = serializePaint();
  const plates = serializePlates();
  const orcaEngine = isOrcaConfig(activeEngine.value);
  const thumbs = opts.thumbnails ?? [];
  const keep = passthroughFor(new Set(meshes.keys()));

  // ---- group into Orca objects + sub-object (volume) ids ----
  const groups = groupObjects(objects, meshes);
  let subId = 0;
  const subOf = new Map<string, number>(); // meshId → sub-object id (shared meshes written once)
  const header = `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="${CORE_NS}" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="${PRODUCTION_NS}" requiredextensions="p">\n`;
  const sub = new ChunkWriter(); // the objects file
  sub.write(`${header} <resources>\n`);
  const subObject = (meshId: string): number => {
    let id = subOf.get(meshId);
    if (id === undefined) {
      id = ++subId;
      subOf.set(meshId, id);
      // Painted triangles and the per-triangle data we keep (texture masks): index → attributes.
      const extra = new Map<number, string>();
      const add = (name: string, map: Array<[number, string]> | undefined) => {
        for (const [t, s] of map ?? []) extra.set(t, `${extra.get(t) ?? ''} ${name}="${escapeAttr(s)}"`);
      };
      for (const [layer, map] of Object.entries(paint[meshId] ?? {})) add(PAINT_ATTR[layer as keyof typeof PAINT_ATTR], map);
      for (const [name, map] of Object.entries(keep.triangleAttrs[meshId] ?? {})) add(name, map);
      sub.write(`  <object id="${id}" type="model">\n`);
      writeMesh(sub, meshes.get(meshId)!, '   ', extra.size ? (t) => extra.get(t) ?? '' : undefined);
      sub.write('  </object>\n');
    }
    return id;
  };

  const rootXml: string[] = [];
  const buildXml: string[] = [];
  const settingsXml: string[] = [];
  const plateInstances: string[][] = plates.map(() => []);
  const profiles: string[] = [];
  const rangesXml: string[] = [];
  const brims: string[] = [];
  const cuts: string[] = [];
  const assembleXml: string[] = [];
  let rootId = 0;
  groups.forEach((g, gi) => {
    const o = g.first;
    const index = gi + 1; // Orca's 1-based object index (per-object metadata files)
    const id = ++rootId + 100000; // root ids live apart from the sub-object ids
    const volumes: Array<{ sub: number; part: ObjectPart | null; keep?: VolumePassthrough }> = [
      { sub: subObject(o.meshId), part: null, keep: liveVolumeKeep(o.passthrough?.volume, o.meshId) },
      ...(o.parts ?? []).filter((p) => meshes.has(p.meshId)).map((p) => ({ sub: subObject(p.meshId), part: p, keep: liveVolumeKeep(p.passthrough, p.meshId) })),
    ];
    rootXml.push(`  <object id="${id}" type="model">\n   <components>\n`);
    for (const v of volumes) {
      const m = v.part ? composeTRS(v.part.position as Vec3, v.part.rotation as Quat, v.part.scale as Vec3) : composeTRS([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
      rootXml.push(`    <component p:path="/${OBJECTS_FILE}" objectid="${v.sub}" transform="${transform3mf(m)}"/>\n`);
    }
    rootXml.push('   </components>\n  </object>\n');

    settingsXml.push(objectXml(id, o, orcaEngine));
    for (const v of volumes) settingsXml.push(volumeXml(v.sub, v.part, o.name, v.keep, orcaEngine));
    settingsXml.push('  </object>\n');

    g.members.forEach((m, k) => {
      const t = composeTRS(m.position as Vec3, m.rotation as Quat, m.scale as Vec3);
      buildXml.push(`  <item objectid="${id}" transform="${transform3mf(t)}" printable="${m.printable && !isHole(m) ? 1 : 0}"/>\n`);
      const p = Math.max(0, plateOf(m.id));
      (plateInstances[p] ??= []).push(`    <model_instance>\n${meta('      ', 'object_id', String(id))}${meta('      ', 'instance_id', String(k))}${meta('      ', 'identify_id', String(id * 100 + k))}    </model_instance>\n`);
      assembleXml.push(assembleItemXml(id, k, m, t));
    });

    if (o.layerHeightProfile && o.layerHeightProfile.length >= 4) profiles.push(`object_id=${index}|${o.layerHeightProfile.map((v) => v.toFixed(6)).join(';')}`);
    if (o.layerRanges?.length) {
      rangesXml.push(` <object id="${index}">\n`);
      for (const r of o.layerRanges) {
        rangesXml.push(`  <range min_z="${num(r.min)}" max_z="${num(r.max)}">\n`);
        const cfg = orcaEngine ? r.overrides : pick(r.overrides, ['layer_height']);
        for (const [k, v] of Object.entries(cfg)) rangesXml.push(`   <option opt_key="${escapeAttr(k)}">${escapeXml(joinValue(v))}</option>\n`);
        // Settings this engine doesn't know, as they were read (a key the engine now knows wins).
        for (const [k, v] of r.passthrough ?? []) if (!(k in r.overrides)) rangesXml.push(`   <option opt_key="${escapeAttr(k)}">${escapeXml(v)}</option>\n`);
        rangesXml.push('  </range>\n');
      }
      rangesXml.push(' </object>\n');
    }
    if (o.brimPoints?.length) {
      brims.push(`object_id=${index}|${o.brimPoints.map((b) => [...b.pos, b.radius].map((v) => v.toFixed(6)).join(' ')).join(' ')}`);
    }
    if (o.passthrough?.cutInfo) cuts.push(` <object id="${index}">\n  ${o.passthrough.cutInfo}\n </object>\n`);
  });

  plates.forEach((p, i) => {
    settingsXml.push(`  <plate>\n${meta('    ', 'plater_id', String(i + 1))}${meta('    ', 'plater_name', p.name)}${meta('    ', 'locked', String(p.locked))}`);
    const cfg = p.config ?? {};
    const written = new Set<string>();
    for (const k of PLATE_KEYS) {
      const v = cfg[k.key];
      if (v === undefined || (PLATE_KEYS_NEED_MAP_MODE.has(k.key) && cfg.filament_map_mode === undefined)) continue;
      const out = k.write(String(joinValue(v)));
      if (out !== null) settingsXml.push(meta('    ', k.meta, out));
      written.add(k.meta);
    }
    if (thumbs[i]) {
      // bbs_3mf.cpp order: thumbnail_file, thumbnail_no_light_file, top_file, pick_file.
      settingsXml.push(meta('    ', 'thumbnail_file', `Metadata/plate_${i + 1}.png`), meta('    ', 'thumbnail_no_light_file', `Metadata/plate_no_light_${i + 1}.png`),
        meta('    ', 'top_file', `Metadata/top_${i + 1}.png`), meta('    ', 'pick_file', `Metadata/pick_${i + 1}.png`));
    }
    settingsXml.push(keptMetadata('    ', p.passthrough?.metadata, written), ...(plateInstances[i] ?? []), '  </plate>\n');
  });
  // Every instance's assemble state, after the plates (_add_model_config_file_to_archive).
  settingsXml.push('  <assemble>\n', ...assembleXml, '  </assemble>\n');

  const rootModel = header + modelMetadataXml(keep.modelMetadata) + ` <resources>\n${rootXml.join('')} </resources>\n <build>\n${buildXml.join('')} </build>\n</model>\n`;
  sub.write(' </resources>\n <build/>\n</model>\n');

  const files: Zippable = {
    '[Content_Types].xml': strToU8(contentTypesXml([['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['json', 'application/json'], ['gcode', 'text/x.gcode']])),
    '_rels/.rels': strToU8(relsXml([
      [`/${MODEL_FILE}`, 'rel-1', MODEL_REL_TYPE],
      // Orca (whole project): the package thumbnail and Bambu's cover images are plate 1's.
      ...(thumbs[0] ? [
        ['/Metadata/plate_1.png', 'rel-2', 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail'],
        ['/Metadata/plate_1.png', 'rel-4', 'http://schemas.bambulab.com/package/2021/cover-thumbnail-middle'],
        ['/Metadata/plate_1_small.png', 'rel-5', 'http://schemas.bambulab.com/package/2021/cover-thumbnail-small'],
      ] as Array<[string, string, string]> : []),
    ])),
    '3D/_rels/3dmodel.model.rels': strToU8(relsXml([[`/${OBJECTS_FILE}`, 'rel-1', MODEL_REL_TYPE]])),
    [MODEL_FILE]: [strToU8(rootModel), { level: 6 }],
    [OBJECTS_FILE]: [sub.bytes(), { level: 6 }],
    [MODEL_SETTINGS_FILE]: strToU8(`<?xml version="1.0" encoding="UTF-8"?>\n<config>\n${settingsXml.join('')}</config>\n`),
    [SLICE_INFO_FILE]: strToU8(`<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  <header>\n    <header_item key="X-BBL-Client-Type" value="slicer"/>\n    <header_item key="X-BBL-Client-Version" value="${BBS_COMPAT_VERSION}"/>\n    <header_item key="OrcaSlicer-Version" value="${ORCA_FORMAT_VERSION}"/>\n  </header>\n</config>\n`),
  };
  thumbs.forEach((t, i) => {
    // Stored uncompressed, as Orca does (PNG is already deflated).
    files[`Metadata/plate_${i + 1}.png`] = [t.plate, { level: 0 }];
    files[`Metadata/plate_${i + 1}_small.png`] = [t.small, { level: 0 }];
    files[`Metadata/plate_no_light_${i + 1}.png`] = [t.noLight, { level: 0 }];
    files[`Metadata/top_${i + 1}.png`] = [t.top, { level: 0 }];
    files[`Metadata/pick_${i + 1}.png`] = [t.pick, { level: 0 }];
  });
  if (orcaEngine) files[PROJECT_SETTINGS_FILE] = strToU8(JSON.stringify(projectSettings(), null, 4));
  if (profiles.length) files[LAYER_HEIGHTS_FILE] = strToU8(`${profiles.join('\n')}\n`);
  if (rangesXml.length) files[LAYER_RANGES_FILE] = strToU8(`<?xml version="1.0" encoding="utf-8"?>\n<objects>\n${rangesXml.join('')}</objects>\n`);
  if (brims.length) files[BRIM_EARS_FILE] = strToU8(`brim_points_format_version=0\n${brims.join('\n')}\n`);
  if (cuts.length) files[CUT_INFO_FILE] = strToU8(`<?xml version="1.0" encoding="utf-8"?>\n<objects>\n${cuts.join('')}</objects>\n`);
  const gcodes = customGcodeXml(plates);
  if (gcodes) files[CUSTOM_GCODE_FILE] = strToU8(gcodes);
  // Kept archive entries (Design tab recipe, texture layers, SVG shapes, Auxiliaries, embedded presets).
  for (const [path, bytes] of Object.entries(keep.files)) if (!(path in files)) files[path] = [bytes, { level: /\.(png|jpe?g)$/i.test(path) ? 0 : 6 }];

  // Exact round-trip for CubbySlicer: the project JSON, with meshes pointing into the model file.
  // CubbyCAD trees go to their own file (stock Orca ignores both; it just sees the meshes).
  const trees: CadTreesJson = { format: 'cubbycad-trees', version: 1, objects: {} };
  const plain = objects.map((o) => {
    if (!o.cad) return o;
    trees.objects[o.id] = o.cad.node;
    const { cad: _cad, ...rest } = o;
    return rest;
  });
  if (Object.keys(trees.objects).length) files[CUBBY_CAD_META] = [strToU8(JSON.stringify(trees)), { level: 6 }];
  const json: ProjectJson & { meshSource: Record<string, string> } = {
    format: PROJECT_FORMAT, version: PROJECT_VERSION, name: projectName.value, savedAt: new Date().toISOString(),
    objects: plain, meshes: [...subOf.keys()].map((id) => ({ id, vertexCount: meshes.get(id)!.vertexCount, triangleCount: meshes.get(id)!.triangleCount })),
    plates, paint, sections: saveSections(),
    meshSource: Object.fromEntries([...subOf].map(([mesh, sid]) => [mesh, `${OBJECTS_FILE}#${sid}`])),
  };
  files[CUBBY_META] = strToU8(JSON.stringify(json));
  return zipSync(files, { level: 6 });
}

/**
 * A double as Orca's model_settings.config stream writes it
 * (std::setprecision(max_digits10) = printf "%.17g").
 */
export function formatG17(x: number): string {
  if (x === 0) return Object.is(x, -0) ? '-0' : '0';
  if (!Number.isFinite(x)) return Number.isNaN(x) ? 'nan' : x > 0 ? 'inf' : '-inf';
  const [mant, ex] = x.toExponential(16).split('e');
  const e = Number(ex);
  if (e < -4 || e >= 17) {
    const m = mant.includes('.') ? mant.replace(/0+$/, '').replace(/\.$/, '') : mant;
    return `${m}e${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
  }
  const f = x.toFixed(16 - e);
  return f.includes('.') ? f.replace(/0+$/, '').replace(/\.$/, '') : f;
}

/**
 * One `<assemble_item>`: the instance's assemble state as read (an opened 3MF
 * keeps its own), else its Assembly view pose, else its placement (desktop
 * initialises the assemble transform from the placement when objects load).
 */
function assembleItemXml(id: number, k: number, o: ProjectObject, placement: number[]): string {
  let matrix: readonly number[];
  if (o.assemble) matrix = o.assemble.matrix;
  else {
    const m = o.assembly ? composeTRS(o.assembly.position as Vec3, o.assembly.rotation as Quat, o.assembly.scale as Vec3) : placement;
    matrix = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10], m[12], m[13], m[14]];
  }
  const offset = o.assemble?.offset ?? [0, 0, 0];
  return `   <assemble_item object_id="${id}" instance_id="${k}" transform="${matrix.map(formatG17).join(' ')}" offset="${offset.map(formatG17).join(' ')}" />\n`;
}

/** `<object>` header + its metadata (name, settings, kept items). */
function objectXml(id: number, o: ProjectObject, orcaEngine: boolean): string {
  const keep = o.passthrough?.object;
  const attrs = keep?.attrs ?? [];
  // Orca 2.5 writes auto_drop on every object (2.4.x read it from the build items).
  const attrText = (attrs.some(([k]) => k === 'auto_drop') ? attrs : [...attrs, ['auto_drop', '1'] as [string, string]])
    .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join('');
  let out = `  <object id="${id}"${attrText}>\n${meta('    ', 'name', o.name)}`;
  const ov = orcaEngine ? o.overrides : pick(o.overrides, ['extruder']);
  const written = new Set(['name']);
  if (!('extruder' in ov) && !keep?.metadata?.some(([k]) => k === 'extruder')) { out += meta('    ', 'extruder', '1'); written.add('extruder'); }
  for (const [k, v] of Object.entries(ov)) { out += meta('    ', k, String(joinValue(v))); written.add(k); }
  out += keptMetadata('    ', keep?.metadata, written);
  for (const e of keep?.elements ?? []) out += `    ${e}\n`;
  return out;
}

/** One `<part>` of an object (the object's own volume when `part` is null). */
function volumeXml(sub: number, part: ObjectPart | null, objectName: string, keep: VolumePassthrough | undefined, orcaEngine: boolean): string {
  const seam = part?.preciseSeam;
  // An unknown subtype read from the file is written back while the part is still the inert modifier it opened as.
  const subtype = keep?.subtype && part?.type === 'modifier' && !seam ? keep.subtype : SUBTYPE_OF[part?.type ?? 'part'];
  const attrs = (keep?.attrs ?? []).map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join('');
  let out = `    <part id="${sub}" subtype="${seam ? SUBTYPE_OF.modifier : subtype}"${attrs}>\n`;
  // Older readers must see a plain modifier: the seam type and its settings go in their own keys.
  if (seam) out += meta('      ', PRECISE_SEAM_TYPE_KEY, seam.type);
  out += meta('      ', 'name', part?.name ?? keep?.metadata?.find(([k]) => k === 'name')?.[1] ?? objectName);
  const written = new Set(['name', PRECISE_SEAM_TYPE_KEY]);
  const ov = part ? (orcaEngine ? part.overrides : pick(part.overrides, ['extruder'])) : {};
  for (const [k, v] of Object.entries(ov)) { out += meta('      ', k, String(joinValue(v))); written.add(k); }
  for (const [k, v] of Object.entries(seam?.config ?? {})) { out += meta('      ', PRECISE_SEAM_CONFIG_PREFIX + k, String(joinValue(v))); written.add(PRECISE_SEAM_CONFIG_PREFIX + k); }
  out += keptMetadata('      ', keep?.meshMetadata, written);
  out += keptMetadata('      ', keep?.metadata, written);
  for (const e of keep?.elements ?? []) out += `      ${e}\n`;
  return `${out}    </part>\n`;
}

/**
 * Model `<metadata name>` items as Orca 2.5 writes them: the file's own items
 * (designer, licence, …) plus ours, sorted by name (a std::map), the
 * "OrcaSlicer" tag right after "Application", dates blank (Orca's privacy rule).
 */
function modelMetadataXml(kept: ReadonlyArray<readonly [string, string]>): string {
  const items = new Map<string, string>();
  for (const k of ['Copyright', 'Description', 'Designer', 'DesignerCover', 'DesignerUserId', 'License', 'Origin']) items.set(k, '');
  for (const [k, v] of kept) items.set(k, v);
  items.set('DesignerUserId', ''); // Orca: never stores the Bambu user id
  items.set('Title', projectName.value);
  items.set('CreationDate', '');
  items.set('ModificationDate', '');
  items.set('Application', `BambuStudio-${BBS_COMPAT_VERSION}`);
  items.set('BambuStudio:3mfVersion', '1');
  let out = '';
  for (const k of [...items.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    out += ` <metadata name="${escapeAttr(k)}">${escapeXml(items.get(k)!)}</metadata>\n`;
    if (k === 'Application') out += ` <metadata name="OrcaSlicer">${ORCA_FORMAT_VERSION}</metadata>\n`;
  }
  return out;
}

function pick(o: Record<string, ConfigValue>, keys: string[]): Record<string, ConfigValue> {
  const out: Record<string, ConfigValue> = {};
  for (const k of keys) if (k in o) out[k] = o[k];
  return out;
}

/** Orca's project_settings.config: the resolved config, preset names and the keys each preset changed. */
function projectSettings(): Record<string, unknown> {
  const p = currentPresets.value;
  const cfg: Record<string, unknown> = { ...resolvedConfig.value };
  const keys = (o: Record<string, unknown> | undefined) => Object.keys(o ?? {}).sort().join(';');
  // One entry per filament slot, mixed ones included (their preset is a copy of the first component's).
  const slots = Array.from({ length: p.filamentSlotCount() }, (_, i) => keys(p.overrides.filaments[i]));
  cfg.different_settings_to_system = [keys(p.overrides.process), ...slots, keys(p.overrides.printer)];
  cfg.name = 'project_settings';
  cfg.from = 'project';
  cfg.version = BBS_COMPAT_VERSION; // config.save_to_json(…, SLIC3R_VERSION)
  return cfg;
}

function customGcodeXml(plates: ReturnType<typeof serializePlates>): string | null {
  // CustomGCode::Mode, as the engine bridge slices it (cs_bridge.cpp: several filaments → MultiAsSingle).
  const fd = resolvedConfig.value.filament_diameter;
  const filaments = Array.isArray(fd) ? fd.length : String(fd ?? '').split(/[,;]/).filter(Boolean).length;
  const mode = filaments > 1 ? 'MultiAsSingle' : 'SingleExtruder';
  const blocks = plates.map((p, i) => {
    if (!p.customGcodes?.length) return '';
    const layers = p.customGcodes.map((g) => `  <layer top_z="${num(g.z)}" type="${GCODE_TYPE_ID[g.type] ?? 4}" extruder="${g.extruder ?? 1}" color="${escapeAttr(g.color ?? '')}" extra="${escapeAttr(g.extra ?? '')}" gcode="${escapeAttr(g.type === 'custom' ? g.extra ?? '' : '')}"/>\n`).join('');
    return ` <plate>\n  <plate_info id="${i + 1}"/>\n${layers}  <mode value="${mode}"/>\n </plate>\n`;
  }).join('');
  return blocks ? `<?xml version="1.0" encoding="utf-8"?>\n<custom_gcodes_per_layer>\n${blocks}</custom_gcodes_per_layer>\n` : null;
}
