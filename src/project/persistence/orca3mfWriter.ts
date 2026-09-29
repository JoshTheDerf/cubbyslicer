/**
 * Save the project as an OrcaSlicer project 3MF (bbs_3mf.cpp layout), which
 * desktop OrcaSlicer / Bambu Studio open as a project: objects with their
 * parts, per-object / per-part settings, painting, instances, plates, the
 * project settings (resolved config + preset names + changed keys), variable
 * layer heights, height ranges and the slider's custom G-code.
 *
 * Everything Cubby Slicer needs to reopen the project exactly (part
 * transforms, emboss, brim ears, UI sections, …) rides along in
 * Metadata/cubby_slicer.json, which Orca ignores.
 */
import { strToU8, zipSync, type Zippable } from 'fflate';
import type { ConfigValue, PaintLayers } from '../../engine/types';
import { activeEngine, resolvedConfig } from '../../app/state';
import { isOrcaFamily } from '../../engine/types';
import { currentPresets } from '../../presets/store';
import { composeTRS, type Mat4, type Quat, type Vec3 } from '../math';
import {
  liveMeshes, plateOf, projectName, serializeObjects, serializePaint, serializePlates,
} from '../store';
import type { MeshData, ObjectPart, ProjectObject } from '../types';
import { PROJECT_FORMAT, PROJECT_VERSION, type ProjectJson } from './format';
import { saveSections } from './sections';
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
/**
 * Header metadata exactly as OrcaSlicer 2.4.2 writes it: Application carries
 * the Bambu Studio compatibility version (SLIC3R_VERSION) and the separate
 * "OrcaSlicer" tag the Orca version. Without that tag desktop Orca classifies
 * the file as a Bambu Studio project and warns "Some settings may differ".
 */
const ORCA_VERSION = '2.4.2';
const BBS_COMPAT_VERSION = '02.06.00.51';

const SUBTYPE: Record<string, string> = {
  part: 'normal_part', negative: 'negative_part', modifier: 'modifier_part', support_blocker: 'support_blocker', support_enforcer: 'support_enforcer',
};
const GCODE_TYPE: Record<string, number> = { color_change: 0, pause: 1, tool_change: 2, template: 3, custom: 4 };
const PAINT_ATTR: Record<string, string> = { support: 'paint_supports', seam: 'paint_seam', color: 'paint_color', fuzzy: 'paint_fuzzy_skin' };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (v: number) => (Number.isInteger(v) ? String(v) : String(+v.toPrecision(9)));
/** Column-major 4x4 → 3MF's "m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32". */
const tf = (m: Mat4) => [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10], m[12], m[13], m[14]].map(num).join(' ');
const scalar = (v: ConfigValue) => (Array.isArray(v) ? v.join(',') : v);

function meshXml(id: number, m: MeshData, paint: PaintLayers | undefined): string {
  const out: string[] = [`  <object id="${id}" type="model">\n   <mesh>\n    <vertices>\n`];
  const p = m.positions;
  for (let i = 0; i < p.length; i += 3) out.push(`     <vertex x="${num(p[i])}" y="${num(p[i + 1])}" z="${num(p[i + 2])}"/>\n`);
  out.push('    </vertices>\n    <triangles>\n');
  // Painted triangles: index → attribute string.
  const extra = new Map<number, string>();
  for (const [layer, map] of Object.entries(paint ?? {})) {
    const a = PAINT_ATTR[layer];
    if (!a || !map) continue;
    for (const [t, s] of map) extra.set(t, `${extra.get(t) ?? ''} ${a}="${esc(s)}"`);
  }
  const ix = m.indices;
  for (let t = 0; t < ix.length / 3; t++) {
    out.push(`     <triangle v1="${ix[t * 3]}" v2="${ix[t * 3 + 1]}" v3="${ix[t * 3 + 2]}"${extra.get(t) ?? ''}/>\n`);
  }
  out.push('    </triangles>\n   </mesh>\n  </object>\n');
  return out.join('');
}

/**
 * Objects that only differ by placement become one Orca object with several
 * instances. Copies get " (2)", " (3)"… names here, so the suffix doesn't count.
 */
function groupKey(o: ProjectObject): string {
  return JSON.stringify([o.name.replace(/ \(\d+\)$/, ''), o.meshId, o.overrides, (o.parts ?? []).map((p) => [p.meshId, p.type, p.position, p.rotation, p.scale, p.overrides]),
    o.layerHeightProfile ?? null, o.layerRanges ?? null]);
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
  const orcaEngine = isOrcaFamily(activeEngine.value);
  const thumbs = opts.thumbnails ?? [];

  // ---- group into Orca objects + sub-object (volume) ids ----
  const groups = groupObjects(objects, meshes);
  let subId = 0;
  const subOf = new Map<string, number>(); // meshId → sub-object id (shared meshes written once)
  const subXml: string[] = [];
  const sub = (meshId: string): number => {
    let id = subOf.get(meshId);
    if (id === undefined) {
      id = ++subId;
      subOf.set(meshId, id);
      subXml.push(meshXml(id, meshes.get(meshId)!, paint[meshId]));
    }
    return id;
  };

  const rootXml: string[] = [];
  const buildXml: string[] = [];
  const settingsXml: string[] = [];
  const plateInstances: string[][] = plates.map(() => []);
  const profiles: string[] = [];
  const rangesXml: string[] = [];
  let rootId = 0;
  groups.forEach((g, gi) => {
    const o = g.first;
    const id = ++rootId + 100000; // root ids live apart from the sub-object ids
    const volumes: Array<{ sub: number; part: ObjectPart | null }> = [
      { sub: sub(o.meshId), part: null },
      ...(o.parts ?? []).filter((p) => meshes.has(p.meshId)).map((p) => ({ sub: sub(p.meshId), part: p })),
    ];
    rootXml.push(`  <object id="${id}" type="model">\n   <components>\n`);
    for (const v of volumes) {
      const m = v.part ? composeTRS(v.part.position as Vec3, v.part.rotation as Quat, v.part.scale as Vec3) : composeTRS([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
      rootXml.push(`    <component p:path="/${OBJECTS_FILE}" objectid="${v.sub}" transform="${tf(m)}"/>\n`);
    }
    rootXml.push('   </components>\n  </object>\n');

    settingsXml.push(`  <object id="${id}">\n    <metadata key="name" value="${esc(o.name)}"/>\n`);
    const ov = orcaEngine ? o.overrides : pick(o.overrides, ['extruder']);
    if (!('extruder' in ov)) settingsXml.push('    <metadata key="extruder" value="1"/>\n');
    for (const [k, v] of Object.entries(ov)) settingsXml.push(`    <metadata key="${esc(k)}" value="${esc(scalar(v))}"/>\n`);
    for (const v of volumes) {
      const name = v.part?.name ?? o.name;
      settingsXml.push(`    <part id="${v.sub}" subtype="${SUBTYPE[v.part?.type ?? 'part']}">\n      <metadata key="name" value="${esc(name)}"/>\n`);
      const pov = v.part ? (orcaEngine ? v.part.overrides : pick(v.part.overrides, ['extruder'])) : {};
      for (const [k, val] of Object.entries(pov)) settingsXml.push(`      <metadata key="${esc(k)}" value="${esc(scalar(val))}"/>\n`);
      settingsXml.push('    </part>\n');
    }
    settingsXml.push('  </object>\n');

    g.members.forEach((m, k) => {
      const t = composeTRS(m.position as Vec3, m.rotation as Quat, m.scale as Vec3);
      buildXml.push(`  <item objectid="${id}" transform="${tf(t)}" printable="${m.printable ? 1 : 0}"/>\n`);
      const p = Math.max(0, plateOf(m.id));
      (plateInstances[p] ??= []).push(`    <model_instance>\n      <metadata key="object_id" value="${id}"/>\n      <metadata key="instance_id" value="${k}"/>\n      <metadata key="identify_id" value="${id * 100 + k}"/>\n    </model_instance>\n`);
    });

    if (o.layerHeightProfile && o.layerHeightProfile.length >= 4) profiles.push(`object_id=${gi + 1}|${o.layerHeightProfile.map((v) => v.toFixed(6)).join(';')}`);
    if (o.layerRanges?.length) {
      rangesXml.push(` <object id="${gi + 1}">\n`);
      for (const r of o.layerRanges) {
        rangesXml.push(`  <range min_z="${num(r.min)}" max_z="${num(r.max)}">\n`);
        const cfg = orcaEngine ? r.overrides : pick(r.overrides, ['layer_height']);
        for (const [k, v] of Object.entries(cfg)) rangesXml.push(`   <option opt_key="${esc(k)}">${esc(scalar(v))}</option>\n`);
        rangesXml.push('  </range>\n');
      }
      rangesXml.push(' </object>\n');
    }
  });

  plates.forEach((p, i) => {
    settingsXml.push(`  <plate>\n    <metadata key="plater_id" value="${i + 1}"/>\n    <metadata key="plater_name" value="${esc(p.name)}"/>\n    <metadata key="locked" value="${p.locked}"/>\n`);
    const cfg = p.config ?? {};
    if (cfg.curr_bed_type) settingsXml.push(`    <metadata key="bed_type" value="${esc(scalar(cfg.curr_bed_type))}"/>\n`);
    if (cfg.print_sequence) settingsXml.push(`    <metadata key="print_sequence" value="${esc(scalar(cfg.print_sequence))}"/>\n`);
    if (cfg.spiral_mode !== undefined) settingsXml.push(`    <metadata key="spiral_mode" value="${scalar(cfg.spiral_mode) === '1' ? 'true' : 'false'}"/>\n`);
    for (const k of ['first_layer_print_sequence', 'other_layers_print_sequence'] as const) {
      if (cfg[k]) settingsXml.push(`    <metadata key="${k}" value="${esc(scalar(cfg[k]!).replace(/,/g, ' '))}"/>\n`);
    }
    if (thumbs[i]) {
      // bbs_3mf.cpp order: thumbnail_file, thumbnail_no_light_file, top_file, pick_file.
      settingsXml.push(`    <metadata key="thumbnail_file" value="Metadata/plate_${i + 1}.png"/>\n`,
        `    <metadata key="thumbnail_no_light_file" value="Metadata/plate_no_light_${i + 1}.png"/>\n`,
        `    <metadata key="top_file" value="Metadata/top_${i + 1}.png"/>\n`,
        `    <metadata key="pick_file" value="Metadata/pick_${i + 1}.png"/>\n`);
    }
    settingsXml.push(...(plateInstances[i] ?? []), '  </plate>\n');
  });

  const P = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';
  const header = (extra = '') => `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="${P}" requiredextensions="p"${extra}>\n`;
  const rootModel = header()
    + ` <metadata name="Application">BambuStudio-${BBS_COMPAT_VERSION}</metadata>\n <metadata name="OrcaSlicer">${ORCA_VERSION}</metadata>\n`
    + ' <metadata name="BambuStudio:3mfVersion">1</metadata>\n'
    + ` <metadata name="Title">${esc(projectName.value)}</metadata>\n <metadata name="CreationDate">${new Date().toISOString().slice(0, 10)}</metadata>\n`
    + ` <resources>\n${rootXml.join('')} </resources>\n <build>\n${buildXml.join('')} </build>\n</model>\n`;
  const objectsModel = header() + ` <resources>\n${subXml.join('')} </resources>\n <build/>\n</model>\n`;

  const files: Zippable = {
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n'
      + ' <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n'
      + ' <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n'
      + ' <Default Extension="png" ContentType="image/png"/>\n <Default Extension="gcode" ContentType="text/x.gcode"/>\n</Types>\n'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'
      + ' <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n'
      // Orca (whole project): the package thumbnail and Bambu's cover images are plate 1's.
      + (thumbs[0] ? ' <Relationship Target="/Metadata/plate_1.png" Id="rel-2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail"/>\n'
        + ' <Relationship Target="/Metadata/plate_1.png" Id="rel-4" Type="http://schemas.bambulab.com/package/2021/cover-thumbnail-middle"/>\n'
        + ' <Relationship Target="/Metadata/plate_1_small.png" Id="rel-5" Type="http://schemas.bambulab.com/package/2021/cover-thumbnail-small"/>\n' : '')
      + '</Relationships>\n'),
    '3D/_rels/3dmodel.model.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'
      + ` <Relationship Target="/${OBJECTS_FILE}" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n</Relationships>\n`),
    '3D/3dmodel.model': [strToU8(rootModel), { level: 6 }],
    [OBJECTS_FILE]: [strToU8(objectsModel), { level: 6 }],
    'Metadata/model_settings.config': strToU8(`<?xml version="1.0" encoding="UTF-8"?>\n<config>\n${settingsXml.join('')}</config>\n`),
    'Metadata/slice_info.config': strToU8(`<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  <header>\n    <header_item key="X-BBL-Client-Type" value="slicer"/>\n    <header_item key="X-BBL-Client-Version" value="${BBS_COMPAT_VERSION}"/>\n    <header_item key="OrcaSlicer-Version" value="${ORCA_VERSION}"/>\n  </header>\n</config>\n`),
  };
  thumbs.forEach((t, i) => {
    // Stored uncompressed, as Orca does (PNG is already deflated).
    files[`Metadata/plate_${i + 1}.png`] = [t.plate, { level: 0 }];
    files[`Metadata/plate_${i + 1}_small.png`] = [t.small, { level: 0 }];
    files[`Metadata/plate_no_light_${i + 1}.png`] = [t.noLight, { level: 0 }];
    files[`Metadata/top_${i + 1}.png`] = [t.top, { level: 0 }];
    files[`Metadata/pick_${i + 1}.png`] = [t.pick, { level: 0 }];
  });
  if (orcaEngine) files['Metadata/project_settings.config'] = strToU8(JSON.stringify(projectSettings(), null, 4));
  if (profiles.length) files['Metadata/layer_heights_profile.txt'] = strToU8(`${profiles.join('\n')}\n`);
  if (rangesXml.length) files['Metadata/layer_config_ranges.xml'] = strToU8(`<?xml version="1.0" encoding="utf-8"?>\n<objects>\n${rangesXml.join('')}</objects>\n`);
  const gcodes = customGcodeXml(plates);
  if (gcodes) files['Metadata/custom_gcode_per_layer.xml'] = strToU8(gcodes);

  // Exact round-trip for Cubby Slicer: the project JSON, with meshes pointing into the model file.
  const json: ProjectJson & { meshSource: Record<string, string> } = {
    format: PROJECT_FORMAT, version: PROJECT_VERSION, name: projectName.value, savedAt: new Date().toISOString(),
    objects, meshes: [...subOf.keys()].map((id) => ({ id, vertexCount: meshes.get(id)!.vertexCount, triangleCount: meshes.get(id)!.triangleCount })),
    plates, paint, sections: saveSections(),
    meshSource: Object.fromEntries([...subOf].map(([mesh, sid]) => [mesh, `${OBJECTS_FILE}#${sid}`])),
  };
  files[CUBBY_META] = strToU8(JSON.stringify(json));
  return zipSync(files, { level: 6 });
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
  cfg.different_settings_to_system = [keys(p.overrides.process), ...p.selection.filaments.map((_, i) => keys(p.overrides.filaments[i])), keys(p.overrides.printer)];
  cfg.name = 'project_settings';
  cfg.from = 'project';
  cfg.version = '2.4.2.0';
  return cfg;
}

function customGcodeXml(plates: ReturnType<typeof serializePlates>): string | null {
  // CustomGCode::Mode, as the engine bridge slices it (cs_bridge.cpp: several filaments → MultiAsSingle).
  const fd = resolvedConfig.value.filament_diameter;
  const filaments = Array.isArray(fd) ? fd.length : String(fd ?? '').split(/[,;]/).filter(Boolean).length;
  const mode = filaments > 1 ? 'MultiAsSingle' : 'SingleExtruder';
  const blocks = plates.map((p, i) => {
    if (!p.customGcodes?.length) return '';
    const layers = p.customGcodes.map((g) => `  <layer top_z="${num(g.z)}" type="${GCODE_TYPE[g.type] ?? 4}" extruder="${g.extruder ?? 1}" color="${esc(g.color ?? '')}" extra="${esc(g.extra ?? '')}" gcode="${esc(g.type === 'custom' ? g.extra ?? '' : '')}"/>\n`).join('');
    return ` <plate>\n  <plate_info id="${i + 1}"/>\n${layers}  <mode value="${mode}"/>\n </plate>\n`;
  }).join('');
  return blocks ? `<?xml version="1.0" encoding="utf-8"?>\n<custom_gcodes_per_layer>\n${blocks}</custom_gcodes_per_layer>\n` : null;
}
