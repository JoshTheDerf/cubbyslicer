/**
 * Open an Orca / Bambu project 3MF as a project (Orca's "Open project"):
 * plates, objects with their parts, per-object / per-part settings, painting,
 * each instance back on its own plate, the project's printer / process /
 * filament presets (by name) plus the settings it changed, and any sliced
 * G-code shown in the preview.
 */
import type { ConfigValue, PaintLayers } from '../engine/types';
import { activeEngine } from '../app/state';
import { loadPlateGcode } from '../app/slice';
import { nextTick } from 'vue';
import { currentPresets, presetsSettled } from '../presets/store';
import { tabOfScope } from '../presets/resolve';
import { asArray, normalizeValue, valuesEqual } from '../presets/values';
import type { PresetKind } from '../presets/types';
import { decomposeTRS, type Mat4, type Quat, type Vec3 } from './math';
import { computeBBox } from './mesh';
import { MAX_PLATES, newPlate, plateOffset, type PlateMeta } from './plates';
import { bed, loadProjectData, objects as liveObjects, projectName, uid } from './store';
import type { MeshData, ObjectPart, ProjectObject } from './types';
import { parseOrca3mf, type OrcaProject } from './import/orca3mf';
import { parseModelPart } from './import/threemf';
import { unzipSync, strFromU8 } from 'fflate';
import { CUBBY_META } from './persistence/orca3mfWriter';
import { PROJECT_FORMAT, PROJECT_VERSION, meshFromArrays, sanitizeObjects, sanitizePaint, sanitizePlates, type ProjectJson } from './persistence/format';
import { loadSections } from './persistence/sections';
import type { BedShape } from '../app/state';

export interface OrcaOpenResult {
  name: string; objects: number; plates: number; sliced: number; warnings: string[];
  /** Saved by Cubby Slicer (restored exactly, including its settings). */
  own?: boolean;
}

/** Keep only settings this engine knows, in its native shape. */
function engineConfig(src: Record<string, string>): Record<string, ConfigValue> {
  const schema = currentPresets.value.schema.value;
  const out: Record<string, ConfigValue> = {};
  for (const [k, v] of Object.entries(src)) {
    const def = schema?.options[k];
    if (!def) continue;
    out[k] = normalizeValue(def, v);
  }
  return out;
}

function bedFromArea(area: Array<[number, number]> | null): BedShape | null {
  if (!area) return null;
  const xs = area.map((p) => p[0]), ys = area.map((p) => p[1]);
  return { polygon: area, min: [Math.min(...xs), Math.min(...ys)], max: [Math.max(...xs), Math.max(...ys)], maxHeight: 0, excludeAreas: [] };
}

function meshData(id: string, positions: Float32Array, indices: Uint32Array): MeshData {
  return { id, positions, indices, bbox: computeBBox(positions), vertexCount: positions.length / 3, triangleCount: indices.length / 3 };
}

/**
 * A 3MF saved by Cubby Slicer carries its own project JSON: reopen it exactly
 * (meshes come from the 3MF's object file). Returns null for other 3MFs.
 */
function openCubby3mf(buffer: ArrayBuffer): OrcaOpenResult | null {
  let files: Record<string, Uint8Array>;
  try { files = unzipSync(new Uint8Array(buffer), { filter: (f) => f.name === CUBBY_META || /\.model$/i.test(f.name) }); } catch { return null; }
  if (!files[CUBBY_META]) return null;
  let json: (ProjectJson & { meshSource?: Record<string, string> }) | null = null;
  try { json = JSON.parse(strFromU8(files[CUBBY_META])); } catch { return null; }
  if (json?.format !== PROJECT_FORMAT || typeof json.version !== 'number' || json.version > PROJECT_VERSION) return null;
  const warnings: string[] = [];
  const parts = new Map<string, ReturnType<typeof parseModelPart>>();
  const meshList: MeshData[] = [];
  for (const [id, src] of Object.entries(json.meshSource ?? {})) {
    if (!/^[\w-]{1,64}$/.test(id)) continue;
    const hash = src.lastIndexOf('#');
    const path = src.slice(0, hash), sub = src.slice(hash + 1);
    let part = parts.get(path);
    if (!part && files[path]) { part = parseModelPart(files[path], path, warnings); parts.set(path, part); }
    const def = part?.objects.get(sub);
    if (!def?.positions || !def.indices) { warnings.push(`Mesh ${id} is missing from the file.`); continue; }
    meshList.push(meshFromArrays(id, def.positions, def.indices));
  }
  const ids = new Set(meshList.map((m) => m.id));
  const objs = sanitizeObjects(json.objects, ids);
  loadProjectData({ name: typeof json.name === 'string' ? json.name : 'Project', objects: objs, meshes: meshList,
    plates: sanitizePlates(json.plates), paint: sanitizePaint(json.paint, ids) });
  const failed = loadSections(json.sections);
  if (failed.length) warnings.push(`Couldn't restore: ${failed.join(', ')}.`);
  return { name: projectName.value, objects: objs.length, plates: Math.max(1, json.plates?.length ?? 1), sliced: 0, warnings, own: true };
}

/** Parse + load. `name` is the file name (the project is named after it). */
export async function openOrcaProject(name: string, buffer: ArrayBuffer): Promise<OrcaOpenResult> {
  const own = openCubby3mf(buffer);
  if (own) return own;
  const proj = parseOrca3mf(buffer);
  const warnings = [...proj.warnings];

  // Presets first: the bed (and so the plate grid) comes from the printer.
  if (proj.settings) warnings.push(...(await applyProjectSettings(proj)));
  await presetsSettled(); // bed.value follows the selected printer

  const ourBed = bed.value;
  const fileBed = bedFromArea(proj.printableArea) ?? ourBed;
  const n = Math.min(MAX_PLATES, proj.plates.length);

  const meshes: MeshData[] = [];
  const paint: Record<string, PaintLayers> = {};
  const objects: ProjectObject[] = [];
  for (const o of proj.objects) {
    const ids = o.volumes.map((v) => {
      const id = uid('m');
      meshes.push(meshData(id, v.positions, v.indices));
      if (Object.keys(v.paint).length) paint[id] = v.paint;
      return id;
    });
    const parts: ObjectPart[] = o.volumes.slice(1).map((v, i) => ({
      id: uid('p'), name: v.name, meshId: ids[i + 1], type: v.type,
      position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], overrides: engineConfig(v.config),
    }));
    // Orca keeps the main volume's own settings (e.g. its extruder) on the volume, where they
    // beat the object's; ours live on the object.
    const overrides = { ...engineConfig(o.config), ...engineConfig(o.volumes[0].config) };
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
      });
    }
  }
  if (proj.plates.length > MAX_PLATES) warnings.push(`Only the first ${MAX_PLATES} plates were opened.`);

  const plates: PlateMeta[] = proj.plates.slice(0, n).map((p) => {
    const meta = newPlate();
    meta.name = p.name;
    meta.locked = p.locked;
    const cfg = engineConfig(p.config);
    if (Object.keys(cfg).length) meta.config = cfg;
    return meta;
  });

  loadProjectData({ name: name.replace(/\.(gcode\.)?3mf$/i, ''), objects, meshes, plates, paint });

  // Sliced 3MF: show each plate's G-code (marked outdated, since it wasn't sliced here).
  // After the plate watchers have reacted to the new plate list (they drop old results).
  await nextTick();
  let sliced = 0;
  proj.plates.slice(0, n).forEach((p, i) => { if (p.gcode) { loadPlateGcode(i, p.gcode); sliced++; } });
  return { name, objects: liveObjects.value.length, plates: n, sliced, warnings };
}

/**
 * Select the project's presets by name (printer, process, filaments), set the
 * filament count and colours, then apply the values the project changed
 * (Orca's `different_settings_to_system`: process, filaments…, printer).
 */
async function applyProjectSettings(proj: OrcaProject): Promise<string[]> {
  const s = proj.settings!;
  const p = currentPresets.value;
  const notes: string[] = [];
  const str = (v: unknown) => String(Array.isArray(v) ? v[0] ?? '' : v ?? '');
  await p.ready;

  const printerName = str(s.printer_settings_id);
  if (printerName) {
    const info = await p.catalog.findByName('printer', printerName).catch(() => null);
    if (info) await p.selectPrinter(info.id);
    else notes.push(`The project's printer “${printerName}” isn't in this engine's library; kept ${p.infos.value.printer.name}.`);
  }
  const colours = asArray(s.filament_colour as ConfigValue).map(String);
  const filamentNames = asArray(s.filament_settings_id as ConfigValue).map(String);
  const count = Math.max(colours.length, filamentNames.length);
  if (count > 0 && count !== p.selection.filaments.length) await p.setFilamentCount(count);
  const processName = str(s.print_settings_id);
  if (processName) {
    const info = await p.catalog.findByName('process', processName).catch(() => null);
    if (info) await p.selectProcess(info.id);
    else notes.push(`The project's process “${processName}” wasn't found.`);
  }
  for (let i = 0; i < filamentNames.length; i++) {
    const info = filamentNames[i] ? await p.catalog.findByName('filament', filamentNames[i]).catch(() => null) : null;
    if (info) await p.selectFilament(i, info.id);
  }
  colours.forEach((c, i) => { if (/^#[0-9a-f]{6}/i.test(c)) p.setFilamentColour(i, c.slice(0, 7)); });

  // Changed settings: [process, filament 1…n, printer], each "key;key;…".
  const diffs = asArray(s.different_settings_to_system as ConfigValue).map(String);
  const schema = p.schema.value;
  if (schema && diffs.length) {
    const slots: Array<{ kind: PresetKind; slot: number; keys: string[] }> = diffs.map((d, i) => ({
      kind: i === 0 ? 'process' : i === diffs.length - 1 ? 'printer' : 'filament',
      slot: i === 0 || i === diffs.length - 1 ? 0 : i - 1,
      keys: d.split(';').map((k) => k.trim()).filter(Boolean),
    }));
    let applied = 0;
    for (const { kind, slot, keys } of slots) {
      for (const k of keys) {
        const def = schema.options[k];
        if (!def || !(k in s) || tabOfScope(def.scope as never) !== kind) continue;
        const raw = s[k] as ConfigValue;
        // Filament vectors in the project are per filament: take this slot's value.
        const v = kind === 'filament' && Array.isArray(raw) ? normalizeValue(def, [raw[slot] ?? raw[0]]) : normalizeValue(def, raw);
        if (valuesEqual(v, p.value(kind, k, slot) ?? '')) continue;
        p.setValue(kind, k, v, slot);
        applied++;
      }
    }
    if (applied) notes.push(`Applied ${applied} changed setting${applied === 1 ? '' : 's'} from the project.`);
  }
  if (activeEngine.value === 'preflight') notes.push('Orca project settings were mapped onto preFlight where the options exist.');
  return notes;
}
