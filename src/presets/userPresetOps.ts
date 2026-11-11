/**
 * User preset operations of an engine's presets: save / save as / rename /
 * delete, export as Orca JSON and import preset files and bundles.
 */
import { toRaw } from 'vue';
import { engineCaps } from '../engine/capabilities';
import { BED_ASSET_SLOTS, readPresetFile, type BedAssetFile, type ImportedRaw } from './bundleImport';
import { flattenInheritsSync, toPresetValues, type RawPreset } from './inherit';
import { orcaToPreflight } from './preflight/convert';
import { tabOfScope } from './resolve';
import { NON_ENGINE_KEYS, type PresetInfo, type PresetKind, type PresetValues } from './types';
import { toOrcaJson, type UserPreset } from './userPresets';
import { cloneValue, isVectorType, valuesEqual } from './values';
import { withVariantLayout } from './variants';
import type { EnginePresets } from './enginePresets';

export interface ImportReport { imported: UserPreset[]; warnings: string[] }

/** Values of the current tab (preset + overrides), restricted to the tab's keys. */
function currentTabValues(s: EnginePresets, kind: PresetKind, index = 0): PresetValues {
  const b = s.bases.value;
  const base = kind === 'filament' ? b.filaments[index] ?? {} : b[kind];
  const out: PresetValues = {};
  for (const [k, v] of Object.entries(base)) out[k] = cloneValue(v);
  for (const [k, v] of Object.entries(toRaw(s.overrideBag(kind, index)))) out[k] = cloneValue(v);
  return out;
}

/** System parent for saving: the system preset itself, or a user preset's parent. */
async function parentFor(s: EnginePresets, kind: PresetKind, index = 0): Promise<{ id?: string; name?: string; values: PresetValues }> {
  const info = s.selectedInfo(kind, index);
  const parentId = info.source === 'system' ? info.id : info.source === 'user' ? info.parentId : undefined;
  if (!parentId) return { values: {} };
  const r = await s.resolvePreset(kind, parentId);
  return { id: parentId, name: r?.info.name, values: r?.values ?? {} };
}

/** The tab's own values against its parent (the variant layout comes along with per-variant values). */
function diffAgainst(s: EnginePresets, kind: PresetKind, values: PresetValues, parent: PresetValues, hasParent: boolean): PresetValues {
  if (!hasParent) return values;
  const out: PresetValues = {};
  for (const [k, v] of Object.entries(values)) if (!valuesEqual(v, parent[k])) out[k] = v;
  return withVariantLayout(out, values, s.schema.value, kind);
}

export async function save(s: EnginePresets, kind: PresetKind, index = 0): Promise<boolean> {
  const info = s.selectedInfo(kind, index);
  if (info.source !== 'user') return false;
  const parent = await parentFor(s, kind, index);
  const values = diffAgainst(s, kind, currentTabValues(s, kind, index), parent.values, !!parent.id);
  s.users.update(info.id, { values });
  s.revertAll(kind, index);
  await s.refresh({ keepSelection: true });
  return true;
}

export async function saveAs(s: EnginePresets, kind: PresetKind, name: string, index = 0): Promise<UserPreset> {
  const parent = await parentFor(s, kind, index);
  const values = diffAgainst(s, kind, currentTabValues(s, kind, index), parent.values, !!parent.id);
  const p = s.users.create({ kind, name, parentId: parent.id, inherits: parent.name, values });
  s.revertAll(kind, index);
  if (kind === 'printer') s.selection.printer = p.id;
  else if (kind === 'process') s.selection.process = p.id;
  else { const sel = s.selection.filaments.slice(); sel[index] = p.id; s.selection.filaments = sel; }
  await s.refreshPrinterList();
  await s.refresh({ keepSelection: true });
  return p;
}

export async function renamePreset(s: EnginePresets, id: string, name: string): Promise<UserPreset> {
  const p = s.users.rename(id, name);
  await s.refreshPrinterList();
  await s.refresh();
  return p;
}

export async function deletePreset(s: EnginePresets, id: string, fallbackDefault: string): Promise<void> {
  const p = s.users.get(id);
  if (!p) return;
  s.users.remove(id);
  const fallback = p.parentId ?? fallbackDefault;
  if (s.selection.printer === id) s.selection.printer = fallback;
  if (s.selection.process === id) s.selection.process = fallback;
  s.selection.filaments = s.selection.filaments.map((f) => (f === id ? fallback : f));
  await s.refreshPrinterList();
  await s.refresh({ keepSelection: true });
}

/** Orca preset JSON of the selected preset of a tab (+ unsaved edits). `flatten`: full values instead of the diff against the system parent. */
export async function exportPreset(s: EnginePresets, kind: PresetKind, index = 0, flatten = false): Promise<{ filename: string; json: Record<string, unknown> }> {
  const info = s.selectedInfo(kind, index);
  const parent = await parentFor(s, kind, index);
  const current = currentTabValues(s, kind, index);
  let values: PresetValues;
  if (flatten || !parent.id) {
    values = {};
    const cfg = s.tabConfig(kind, index);
    for (const [k, v] of Object.entries(cfg)) if (!NON_ENGINE_KEYS.has(k) || k.startsWith('compatible_')) values[k] = v;
    for (const [k, v] of Object.entries(current)) values[k] = v;
  } else {
    values = diffAgainst(s, kind, current, parent.values, true);
  }
  const name = info.source === 'default' ? `My ${kind}` : info.name;
  const json = toOrcaJson(kind, name, values, flatten ? undefined : parent.name);
  return { filename: `${name.replace(/[^\w.@ -]+/g, '_')}.json`, json };
}

/** Stores a bed file from a bundle; returns the option value referencing it. */
export type BedAssetStorer = (file: BedAssetFile) => Promise<string>;

/** Bed files go where the Bed shape dialog keeps picked ones (IndexedDB, `cubby-asset:<id>/<name>`). */
const storeBundleBedAsset: BedAssetStorer = async ({ name, data }) => {
  const { storeBedAsset } = await import('../dialogs/bed/customBed');
  return storeBedAsset(new File([data as BlobPart], name));
};

/**
 * A printer's raw preset with its bundled bed texture / model stored and its
 * bed_custom_texture / bed_custom_model pointing at the stored copies (Orca
 * import_json_presets sets them to the installed bed/<n>/<file> path).
 */
export async function withStoredBedAssets(r: Pick<ImportedRaw, 'raw' | 'bedAssets'>, store: BedAssetStorer): Promise<RawPreset> {
  if (!r.bedAssets) return r.raw;
  const raw: RawPreset = { ...r.raw };
  for (const { option } of BED_ASSET_SLOTS) {
    const f = r.bedAssets[option];
    if (f) raw[option] = await store(f);
  }
  return raw;
}

/** Import preset files (JSON / zip bundles) as user presets. */
export async function importFiles(s: EnginePresets, files: Array<{ name: string; data: Uint8Array }>, storeBedAsset: BedAssetStorer = storeBundleBedAsset): Promise<ImportReport> {
  const warnings: string[] = [];
  const raws: Array<{ kind: PresetKind; name: string; raw: RawPreset; bedAssets?: ImportedRaw['bedAssets'] }> = [];
  for (const f of files) {
    const r = await readPresetFile(f.name, f.data);
    warnings.push(...r.warnings);
    raws.push(...r.presets);
  }
  const imported: UserPreset[] = [];
  const byName = new Map(raws.map((r) => [`${r.kind}|${r.name}`, r.raw]));
  for (const r of raws) {
    if (r.raw.instantiation === 'false') continue; // templates only serve as parents
    try {
      // Flatten against other presets from the same import first.
      const own0 = r.kind === 'printer' ? await withStoredBedAssets(r, storeBedAsset).catch((e) => {
        warnings.push(`${r.name}: couldn’t store the bundled bed texture / model (${(e as Error).message})`);
        return r.raw;
      }) : r.raw;
      const flat = flattenInheritsSync(own0, (ref) => byName.get(`${r.kind}|${ref}`), r.name);
      const lastRef = flat.missing;
      let parent: PresetInfo | null = null;
      if (lastRef) parent = await s.catalog.findByName(r.kind, lastRef);
      if (lastRef && !parent) warnings.push(`${r.name}: parent "${lastRef}" not found — imported as a standalone preset`);
      let values = toPresetValues(flat.values);
      if (engineCaps(s.engine).orcaCompat) {
        const schema = s.schema.value;
        values = orcaToPreflight(r.kind, values, (k) => !schema || k in schema.options,
          (k) => { const d = schema?.options[k]; return !!d && isVectorType(d.type); });
      }
      let own = s.shape(values);
      if (!parent) {
        // Standalone: keep only keys that belong to this tab.
        const schema = s.schema.value;
        if (schema) own = Object.fromEntries(Object.entries(own).filter(([k]) => tabOfScope(schema.options[k]?.scope) === r.kind || k.startsWith('compatible_')));
      }
      const name = s.users.uniqueName(r.kind, r.name);
      imported.push(s.users.create({ kind: r.kind, name, parentId: parent?.id, inherits: parent?.name, values: own }));
    } catch (e) {
      warnings.push(`${r.name}: ${(e as Error).message}`);
    }
  }
  await s.refreshPrinterList();
  await s.refresh({ keepSelection: true });
  return { imported, warnings };
}
