/**
 * OrcaSlicer vendor-tree catalog.
 *
 *   profiles/_index.json               ["BBL", "Creality", ...]      (vendor ids = file basenames)
 *   profiles/<Vendor>.json             { name, machine_model_list, machine_list, process_list, filament_list }
 *   profiles/<Vendor>/<sub_path>       one preset JSON ({type, name, inherits, instantiation, ...settings})
 *
 * Resolution mirrors PresetBundle::load_vendor_configs_from_json: `inherits`
 * names a preset of the same vendor and collection; filaments that don't find
 * their parent in the vendor fall back to the OrcaFilamentLibrary vendor
 * (PresetBundle::ORCA_FILAMENT_LIBRARY, loaded first as the base bundle).
 * Orca 2.5 `include` templates (variant tables of BBL filaments, BBL printers'
 * start / end / change-filament G-code) are layered between the parent and the
 * preset's own keys (see resolveRaw).
 * Preset files are fetched lazily and cached per URL.
 */
import type { EngineId } from '../../engine/types';
import { includesOf, infoMetaFrom, isTemplate, toPresetValues, type RawPreset } from '../inherit';
import type { BedAssets, MachineModel, PresetCatalog, PresetInfo, PresetKind, PresetValues, VendorInfo } from '../types';
import { encodePath, fetchJson, isRecord, mapLimit, profileBase, str, type JsonFetcher } from '../util';
import { unescapeStrings } from '../values';
import { normalizeVariantLengths } from '../variants';

/** Orca's shared filament library vendor (PresetBundle::ORCA_FILAMENT_LIBRARY). */
export const ORCA_FILAMENT_LIBRARY = 'OrcaFilamentLibrary';

type ListKey = 'machine_list' | 'process_list' | 'filament_list';
const LIST_OF: Record<PresetKind, ListKey> = { printer: 'machine_list', process: 'process_list', filament: 'filament_list' };

interface VendorIndexEntry { name: string; sub_path: string }
/** A resolved system preset: padded to its variant columns (`values`), as included (`unpadded`). */
interface ResolvedRaw { values: PresetValues; unpadded: PresetValues; leaf: RawPreset; filamentId?: string }
interface VendorIndex {
  id: string;
  name: string;
  description?: string;
  machine_model_list: VendorIndexEntry[];
  machine_list: VendorIndexEntry[];
  process_list: VendorIndexEntry[];
  filament_list: VendorIndexEntry[];
  /** name → sub_path per list. */
  byName: Record<ListKey, Map<string, string>>;
}

export interface OrcaCatalogOptions {
  engine?: EngineId;
  /** URL prefix of the profile tree (default `<BASE_URL>wasm/orca/profiles`). */
  base?: string;
  fetcher?: JsonFetcher;
  /** Max parallel preset fetches. */
  concurrency?: number;
  /** Shared library vendor used as inheritance fallback for filaments. */
  libraryVendor?: string;
  /** Try `_bundles/<Vendor>.json` before per-file fetches (default true). */
  bundles?: boolean;
}

export function sysId(vendor: string, name: string): string { return `sys:${vendor}/${name}`; }
function parseSysId(id: string): { vendor: string; name: string } | null {
  if (!id.startsWith('sys:')) return null;
  const rest = id.slice(4);
  const slash = rest.indexOf('/');
  if (slash < 0) return null;
  return { vendor: rest.slice(0, slash), name: rest.slice(slash + 1) };
}

function entries(v: unknown): VendorIndexEntry[] {
  if (!Array.isArray(v)) return [];
  return v.filter((e): e is VendorIndexEntry => isRecord(e) && typeof e.name === 'string' && typeof e.sub_path === 'string');
}

export class OrcaCatalog implements PresetCatalog {
  readonly engine: EngineId;
  private readonly base: string;
  private readonly fetcher: JsonFetcher;
  private readonly concurrency: number;
  private readonly library: string;
  private vendorIds: Promise<string[]> | null = null;
  private readonly vendorCache = new Map<string, Promise<VendorIndex | null>>();
  private readonly fileCache = new Map<string, Promise<RawPreset | null>>();
  private readonly bundleCache = new Map<string, Promise<Map<string, RawPreset> | null>>();
  private readonly useBundles: boolean;
  private readonly resolvedCache = new Map<string, Promise<ResolvedRaw | null>>();
  private readonly infoCache = new Map<string, Promise<PresetInfo | null>>();
  private readonly renameCache = new Map<string, Promise<Map<string, string>>>();

  constructor(opts: OrcaCatalogOptions = {}) {
    this.engine = opts.engine ?? 'orca';
    this.base = (opts.base ?? profileBase(this.engine)).replace(/\/$/, '');
    this.fetcher = opts.fetcher ?? fetchJson;
    this.concurrency = opts.concurrency ?? 12;
    this.library = opts.libraryVendor ?? ORCA_FILAMENT_LIBRARY;
    this.useBundles = opts.bundles ?? true;
  }

  // ---- vendor indexes ------------------------------------------------------

  private listVendorIds(): Promise<string[]> {
    this.vendorIds ??= (async () => {
      const raw = await this.fetcher(`${this.base}/_index.json`);
      if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string');
      if (isRecord(raw) && Array.isArray(raw.vendors)) return (raw.vendors as unknown[]).map((v) => (isRecord(v) ? str(v.id ?? v.name) : str(v))).filter(Boolean);
      return [];
    })();
    return this.vendorIds;
  }

  vendor(id: string): Promise<VendorIndex | null> {
    let p = this.vendorCache.get(id);
    if (!p) {
      p = (async () => {
        const raw = await this.fetcher(`${this.base}/${encodePath(id)}.json`);
        if (!isRecord(raw)) return null;
        const v: VendorIndex = {
          id,
          name: str(raw.name) || id,
          description: str(raw.description) || undefined,
          machine_model_list: entries(raw.machine_model_list),
          machine_list: entries(raw.machine_list),
          process_list: entries(raw.process_list),
          filament_list: entries(raw.filament_list),
          byName: { machine_list: new Map(), process_list: new Map(), filament_list: new Map() },
        };
        for (const k of ['machine_list', 'process_list', 'filament_list'] as const) {
          for (const e of v[k]) if (!v.byName[k].has(e.name)) v.byName[k].set(e.name, e.sub_path);
        }
        return v;
      })();
      this.vendorCache.set(id, p);
    }
    return p;
  }

  /**
   * Optional per-vendor bundle `profiles/_bundles/<Vendor>.json` ({ sub_path: preset JSON }),
   * written by scripts/dev/build-profile-bundles.mjs at staging time: one request per vendor
   * instead of hundreds. Missing bundle → per-file fetches.
   */
  private bundle(vendor: string): Promise<Map<string, RawPreset> | null> {
    let p = this.bundleCache.get(vendor);
    if (!p) {
      p = this.fetcher(`${this.base}/_bundles/${encodePath(vendor)}.json`).then((raw) => {
        if (!isRecord(raw)) return null;
        const m = new Map<string, RawPreset>();
        for (const [k, v] of Object.entries(raw)) if (isRecord(v)) m.set(k, v);
        return m;
      });
      this.bundleCache.set(vendor, p);
    }
    return p;
  }

  private async file(vendor: string, subPath: string): Promise<RawPreset | null> {
    if (this.useBundles) {
      const b = await this.bundle(vendor);
      const hit = b?.get(subPath);
      if (hit) return hit;
    }
    const url = `${this.base}/${encodePath(vendor)}/${encodePath(subPath)}`;
    let p = this.fileCache.get(url);
    if (!p) {
      p = this.fetcher(url).then((r) => (isRecord(r) ? r : null));
      this.fileCache.set(url, p);
    }
    return p;
  }

  private async raw(vendor: string, kind: PresetKind, name: string): Promise<RawPreset | null> {
    const v = await this.vendor(vendor);
    const sub = v?.byName[LIST_OF[kind]].get(name);
    return sub ? this.file(vendor, sub) : null;
  }

  /**
   * Old name → current name of a vendor's presets (PresetCollection::update_map_system_profile_renamed):
   * each preset's `renamed_from` list, or — a preset with an '@' in its name and no explicit
   * list — its name with the '@' dropped (PresetBundle: "Generic PLA @BBL X1C" was "Generic PLA BBL X1C").
   */
  private renames(vendor: string, kind: PresetKind): Promise<Map<string, string>> {
    const key = `${vendor}|${kind}`;
    let p = this.renameCache.get(key);
    if (!p) {
      p = (async () => {
        const map = new Map<string, string>();
        const v = await this.vendor(vendor);
        if (!v) return map;
        const leaves = await mapLimit(v[LIST_OF[kind]], this.concurrency, async (e) => ({ name: e.name, raw: await this.file(vendor, e.sub_path) }));
        for (const { name, raw } of leaves) {
          for (const old of renamedFrom(name, raw)) if (old !== name && !map.has(old)) map.set(old, name);
        }
        return map;
      })();
      this.renameCache.set(key, p);
    }
    return p;
  }

  /** The current name of a preset that may have been renamed (follows chains, Preset.cpp find_preset); null when unknown. */
  async currentName(vendor: string, kind: PresetKind, name: string): Promise<string | null> {
    const v = await this.vendor(vendor);
    if (!v) return null;
    const names = v.byName[LIST_OF[kind]];
    let cur = name;
    for (let i = 0; i < 8; i++) {
      if (names.has(cur)) return cur;
      const next = (await this.renames(vendor, kind)).get(cur);
      if (!next) return null;
      cur = next;
    }
    return null;
  }

  /** Locate an inherits parent: same vendor/collection, then the filament library. */
  private async parent(vendor: string, kind: PresetKind, ref: string): Promise<{ vendor: string; name: string } | null> {
    if (await this.raw(vendor, kind, ref)) return { vendor, name: ref };
    if (kind === 'filament' && vendor !== this.library && (await this.raw(this.library, kind, ref))) return { vendor: this.library, name: ref };
    // Preset::normalize_inherits / find_preset2: a parent that was renamed since.
    for (const vid of kind === 'filament' && vendor !== this.library ? [vendor, this.library] : [vendor]) {
      const name = await this.currentName(vid, kind, ref);
      if (name && name !== ref && (await this.raw(vid, kind, name))) return { vendor: vid, name };
    }
    return null;
  }

  /**
   * PresetBundle::resolve_vendor_preset: the resolved `inherits` parent (same vendor, then the
   * filament library), then each preset named in `include` — looked up in the preset's own vendor
   * and collection only (`install.include_maps`), contributing its resolved values as they were
   * before padding — then the preset's own keys. The result is then sized to the preset's variant
   * columns (extend_default_config_length), which is also what a child inherits.
   *
   * Desktop layers an include's diff against the collection default; every template Orca 2.5
   * ships states only non-default values, so its resolved keys are that diff.
   */
  private resolveRaw(id: string, kind: PresetKind, path: readonly string[] = []): Promise<ResolvedRaw | null> {
    const key = `${kind}|${id}`;
    // A cycle (malformed profile) resolves the repeated preset as missing instead of awaiting itself.
    if (path.includes(key)) return Promise.resolve(null);
    let p = this.resolvedCache.get(key);
    if (!p) {
      p = (async () => {
        const sid = parseSysId(id);
        if (!sid) return null;
        const leaf = await this.raw(sid.vendor, kind, sid.name);
        if (!leaf) return null;
        const next = [...path, key];
        let merged: PresetValues = {};
        // filament_id: the preset's own, else its parent's (install.filament_id_maps).
        let filamentId = str(leaf.filament_id) || undefined;
        const ref = typeof leaf.inherits === 'string' ? leaf.inherits.trim() : '';
        if (ref) {
          const found = await this.parent(sid.vendor, kind, ref);
          const r = found ? await this.resolveRaw(sysId(found.vendor, found.name), kind, next) : null;
          if (r) { merged = { ...r.values }; filamentId ??= r.filamentId; }
        }
        for (const name of includesOf(leaf)) {
          const r = await this.resolveRaw(sysId(sid.vendor, name), kind, next);
          if (r) Object.assign(merged, r.unpadded);
        }
        Object.assign(merged, toPresetValues(leaf));
        return { values: normalizeVariantLengths(merged, null), unpadded: merged, leaf, filamentId };
      })();
      this.resolvedCache.set(key, p);
    }
    return p;
  }

  // ---- PresetCatalog -------------------------------------------------------

  async vendors(): Promise<VendorInfo[]> {
    const ids = await this.listVendorIds();
    const all = await mapLimit(ids, this.concurrency, (id) => this.vendor(id));
    return all
      .filter((v): v is VendorIndex => !!v && v.machine_list.length > 0 && v.id !== this.library)
      .map((v) => ({ id: v.id, name: v.name, description: v.description }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async models(vendorId: string): Promise<MachineModel[]> {
    const v = await this.vendor(vendorId);
    if (!v) return [];
    const printers = await mapLimit(v.machine_list, this.concurrency, async (e) => {
      const leaf = await this.file(vendorId, e.sub_path);
      if (!leaf || isTemplate(leaf)) return null;
      return this.info(sysId(vendorId, e.name), 'printer');
    });
    const models = await mapLimit(v.machine_model_list, this.concurrency, async (e) => {
      const raw = await this.file(vendorId, e.sub_path);
      const name = str(raw?.name) || e.name;
      return {
        vendor: vendorId,
        name,
        nozzles: str(raw?.nozzle_diameter).split(';').map((s) => s.trim()).filter(Boolean),
        family: str(raw?.family) || undefined,
        coverUrl: `${this.base}/${encodePath(vendorId)}/${encodePath(`${name}_cover.png`)}`,
        variants: [],
      } as MachineModel;
    });
    const byModel = new Map(models.map((m) => [m.name, m]));
    for (const p of printers) {
      if (!p) continue;
      const modelName = p.printerModel ?? p.name;
      let m = byModel.get(modelName);
      if (!m) { m = { vendor: vendorId, name: modelName, nozzles: [], variants: [] }; byModel.set(modelName, m); models.push(m); }
      m.variants.push({ preset: p, variant: p.printerVariant ?? p.name });
    }
    for (const m of models) m.variants.sort((a, b) => Number(a.variant) - Number(b.variant) || a.variant.localeCompare(b.variant));
    return models.filter((m) => m.variants.length > 0).sort((a, b) => a.name.localeCompare(b.name));
  }

  async modelDefaultBedType(vendorId: string, model: string): Promise<string | null> {
    const v = await this.vendor(vendorId);
    const e = v?.machine_model_list.find((m) => m.name === model);
    if (!e) return null;
    const raw = await this.file(vendorId, e.sub_path);
    return str(raw?.default_bed_type) || null;
  }

  async modelId(vendorId: string, model: string): Promise<string | null> {
    const v = await this.vendor(vendorId);
    const e = v?.machine_model_list.find((m) => m.name === model);
    const raw = e ? await this.file(vendorId, e.sub_path) : null;
    return str(raw?.model_id) || null;
  }

  async modelBedAssets(vendorId: string, model: string): Promise<BedAssets | null> {
    const v = await this.vendor(vendorId);
    const e = v?.machine_model_list.find((m) => m.name === model);
    if (!e) return null;
    const raw = await this.file(vendorId, e.sub_path);
    const url = (f: string) => `${this.base}/${encodePath(vendorId)}/${encodePath(f)}`;
    const m = str(raw?.bed_model), t = str(raw?.bed_texture);
    const out: BedAssets = {};
    if (/\.stl$/i.test(m) && !/[\\/]/.test(m)) out.model = url(m);
    if (/\.(svg|png)$/i.test(t) && !/[\\/]/.test(t)) out.texture = url(t);
    return out.model || out.texture ? out : null;
  }

  info(id: string, kind: PresetKind): Promise<PresetInfo | null> {
    const key = `${kind}|${id}`;
    let p = this.infoCache.get(key);
    if (!p) {
      p = (async () => {
        const sid = parseSysId(id);
        if (!sid) return null;
        const r = await this.resolveRaw(id, kind);
        if (!r) {
          // A project / selection naming a preset that has been renamed since: the current preset.
          const name = await this.currentName(sid.vendor, kind, sid.name);
          return name && name !== sid.name ? this.info(sysId(sid.vendor, name), kind) : null;
        }
        return {
          id, kind, name: sid.name, source: 'system', vendor: sid.vendor,
          fromLibrary: sid.vendor === this.library,
          ...(kind === 'filament' && r.filamentId ? { filamentId: r.filamentId } : {}),
          ...infoMetaFrom(r.values, sid.name, r.leaf),
        } as PresetInfo;
      })();
      this.infoCache.set(key, p);
    }
    return p;
  }

  async candidates(kind: 'process' | 'filament', printer: PresetInfo | null): Promise<PresetInfo[]> {
    const vendorId = printer?.vendor;
    const load = async (vid: string): Promise<PresetInfo[]> => {
      const v = await this.vendor(vid);
      if (!v) return [];
      const infos = await mapLimit(v[LIST_OF[kind]], this.concurrency, async (e) => {
        const leaf = await this.file(vid, e.sub_path);
        if (!leaf || isTemplate(leaf)) return null;
        return this.info(sysId(vid, e.name), kind);
      });
      return infos.filter((x): x is PresetInfo => !!x);
    };
    const own = vendorId && vendorId !== this.library ? await load(vendorId) : [];
    if (kind !== 'filament') return own;
    const lib = await load(this.library);
    // PresetCollection::update_library_profile_excluded_from: a library preset with
    // empty compatible_printers is hidden for printers that a same-alias printer-specific
    // preset targets — in the vendor bundle or (Orca 2.5) in the library itself.
    const byAlias = new Map<string, Set<string>>();
    for (const p of [...own, ...lib]) {
      if (!p.alias || !p.compatiblePrinters?.length) continue;
      let s = byAlias.get(p.alias);
      if (!s) byAlias.set(p.alias, (s = new Set()));
      for (const n of p.compatiblePrinters) s.add(n);
    }
    const libOut = lib.map((p) => {
      const ex = p.alias && !p.compatiblePrinters?.length ? byAlias.get(p.alias) : undefined;
      return ex ? { ...p, excludedPrinters: [...ex] } : p;
    });
    return [...own, ...libOut];
  }

  async resolve(id: string, kind: PresetKind): Promise<PresetValues | null> {
    const r = await this.resolveRaw(id, kind);
    if (r) return r.values;
    const info = await this.info(id, kind);
    return info && info.id !== id ? this.resolve(info.id, kind) : null;
  }

  /**
   * PresetCollection::find_preset2: by name, then by an old name (`renamed_from`), then — for a
   * missing "… Generic <material> @…" — the library's "Generic <material> @System".
   */
  async findByName(kind: PresetKind, name: string, vendorHint?: string, autoMatch = true): Promise<PresetInfo | null> {
    const tryVendor = async (vid: string, renamed: boolean) => {
      const v = await this.vendor(vid);
      if (!v) return null;
      if (v.byName[LIST_OF[kind]].has(name)) return this.info(sysId(vid, name), kind);
      const cur = renamed ? await this.currentName(vid, kind, name) : null;
      return cur ? this.info(sysId(vid, cur), kind) : null;
    };
    const first = [...(vendorHint ? [vendorHint] : []), ...(kind === 'filament' ? [this.library] : [])];
    for (const vid of first) { const r = await tryVendor(vid, true); if (r) return r; }
    const ids = await this.listVendorIds();
    const idx = await mapLimit(ids, this.concurrency, (id) => this.vendor(id));
    for (const v of idx) if (v?.byName[LIST_OF[kind]].has(name)) return this.info(sysId(v.id, name), kind);
    if (autoMatch && kind === 'filament' && /Generic/.test(name)) {
      const alt = genericLibraryName(name);
      if (alt && alt !== name) return this.findByName(kind, alt, this.library, false);
    }
    return null;
  }

  /** Raw leaf JSON (unflattened) — for export "as system file". */
  async rawLeaf(id: string, kind: PresetKind): Promise<RawPreset | null> {
    const sid = parseSysId(id);
    return sid ? this.raw(sid.vendor, kind, sid.name) : null;
  }

}

/** A preset's old names (`renamed_from`, C-style string list; implicit: the name without its '@'). */
export function renamedFrom(name: string, raw: RawPreset | null): string[] {
  const r = raw?.renamed_from;
  const list = Array.isArray(r) ? r.filter((x): x is string => typeof x === 'string') : typeof r === 'string' && r ? unescapeStrings(r) : [];
  if (list.length) return list;
  const at = name.indexOf('@');
  if (at < 0 || (typeof raw?.alias === 'string' && raw.alias)) return [];
  return [name.slice(0, at) + name.slice(at + 1)];
}

/** find_preset2's fallback: "<prefix_>Generic <material> @<anything>" → "Generic <material> @System". */
export function genericLibraryName(name: string): string | null {
  const m = /^(?:.*?\b(?:\w+_)?)(Generic)\b\s+([^@]+?)\s*(?:@.*)?$/.exec(name);
  return m ? `Generic ${m[2]} @System` : null;
}
